package dev.e2ecol.android.session

import dev.e2ecol.android.model.SessionTransport
import dev.e2ecol.android.protocol.EnvelopeKind
import dev.e2ecol.android.protocol.ProtocolEnvelope
import dev.e2ecol.android.protocol.ProtocolEnvelopeCodec
import dev.e2ecol.android.storage.DocumentEntity
import dev.e2ecol.android.storage.E2ColDatabase
import dev.e2ecol.android.storage.OutboundEntity
import dev.e2ecol.android.storage.OutboundState
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.automerge.AmValue
import org.automerge.ChangeHash
import org.automerge.Document
import org.automerge.ObjectId
import org.automerge.ObjectType

data class SessionState(
    val active: Boolean = false,
    val lastError: String? = null,
)

class DocumentSession(
    private val documentId: String,
    private val senderId: String,
    private val db: E2ColDatabase,
    private val transport: SessionTransport,
    private val scope: CoroutineScope,
) {
    private val doc: Document
    private val textObjId: ObjectId
    private val _state = MutableStateFlow(SessionState())
    val state: StateFlow<SessionState> = _state.asStateFlow()
    private var closed = false
    private val _inboundChanges = MutableSharedFlow<Unit>()
    val inboundChanges: SharedFlow<Unit> = _inboundChanges.asSharedFlow()

    init {
        val existing = runBlocking { db.documentDao().getByDocumentId(documentId) }
        if (existing != null && existing.snapshot.isNotEmpty()) {
            doc = Document.load(existing.snapshot)
            val textVal = doc.get(ObjectId.ROOT, "text")
            textObjId = if (textVal.isPresent) {
                (textVal.get() as AmValue.Text).id
            } else {
                throw IllegalStateException("loaded document missing 'text' key")
            }
        } else {
            doc = Document()
            val tx = doc.startTransaction()
            textObjId = tx.set(ObjectId.ROOT, "text", ObjectType.TEXT)
            tx.commit()
        }
        _state.value = SessionState(active = true)
    }

    /**
     * Edit text at the given position. Captures old heads, performs a splice,
     * encodes changes since old heads, atomically persists snapshot + outbound
     * row, and sends the envelope over the transport.
     */
    fun editText(pos: Int, delete: Int, insert: String): Long {
        check(!closed) { "session is closed" }
        val oldHeads: Array<ChangeHash> = doc.getHeads()
        val tx = doc.startTransaction()
        tx.spliceText(textObjId, pos.toLong(), delete.toLong(), insert)
        tx.commit()
        val changes: ByteArray = doc.encodeChangesSince(oldHeads)
        if (changes.isEmpty()) return -1

        val envelope = ProtocolEnvelope(
            documentId = documentId,
            messageId = UUID.randomUUID().toString(),
            senderId = senderId,
            kind = EnvelopeKind.AUTOMERGE_CHANGE,
            createdAt = System.currentTimeMillis(),
            payload = changes,
        )
        val encoded = ProtocolEnvelopeCodec.encode(envelope)

        val now = System.currentTimeMillis()
        val snapshot = doc.save()
        val docEntity = DocumentEntity(
            documentId = documentId,
            snapshot = snapshot,
            updatedAt = now,
            title = "",
            archived = false,
        )
        val outEntity = OutboundEntity(
            documentId = documentId,
            payload = encoded,
            createdAt = now,
            state = OutboundState.PENDING,
            attempts = 0,
            kind = envelope.kind.wireName,
        )

        val txDao = db.storageTransactionDao()
        val outId = runBlocking { txDao.persistSnapshotAndEnqueue(docEntity, outEntity) }

        val sent = transport.send(encoded)
        if (sent) {
            runBlocking { txDao.markOutboundSent(outId) }
        } else {
            runBlocking { db.outboundDao().incrementAttempt(outId, OutboundState.FAILED) }
        }
        return outId
    }

    /**
     * Handle an incoming frame from the transport.
     * Decodes the envelope, applies encoded changes, persists snapshot, and
     * notifies listeners.
     */
    fun onInboundFrame(bytes: ByteArray) {
        if (closed) return
        val envelope = ProtocolEnvelopeCodec.decode(bytes)
        if (envelope.kind != EnvelopeKind.AUTOMERGE_CHANGE) return
        if (envelope.documentId != documentId) return

        doc.applyEncodedChanges(envelope.payload)
        val snapshot = doc.save()
        val now = System.currentTimeMillis()
        runBlocking {
            db.storageTransactionDao().applyInboundAndPersist(documentId, snapshot, now)
        }
        scope.launch { _inboundChanges.emit(Unit) }
    }

    /**
     * Close the session. Persists final state and closes transport.
     * Idempotent - safe to call multiple times.
     */
    fun close() {
        if (closed) return
        closed = true
        val snapshot = doc.save()
        val now = System.currentTimeMillis()
        runBlocking {
            db.documentDao().upsert(
                DocumentEntity(
                    documentId = documentId,
                    snapshot = snapshot,
                    updatedAt = now,
                    title = "",
                    archived = false,
                ),
            )
        }
        transport.close()
        _state.value = SessionState(active = false)
    }

    fun getSnapshot(): ByteArray = doc.save()
}
