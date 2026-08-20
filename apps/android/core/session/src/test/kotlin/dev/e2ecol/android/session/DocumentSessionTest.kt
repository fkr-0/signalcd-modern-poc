package dev.e2ecol.android.session

import androidx.room.Room
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import dev.e2ecol.android.model.SessionTransport
import dev.e2ecol.android.protocol.EnvelopeKind
import dev.e2ecol.android.protocol.ProtocolEnvelope
import dev.e2ecol.android.protocol.ProtocolEnvelopeCodec
import dev.e2ecol.android.storage.E2ColDatabase
import dev.e2ecol.android.storage.OutboundState
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.test.runTest
import org.automerge.AmValue
import org.automerge.Document
import org.automerge.ObjectId
import org.automerge.ObjectType

class DocumentSessionTest {
    private fun createDb(): E2ColDatabase =
        Room.inMemoryDatabaseBuilder<E2ColDatabase>()
            .setDriver(BundledSQLiteDriver())
            .build()

    private fun mockTransport(): MockTransport = MockTransport()

    @Test
    fun `editText persists snapshot and sends envelope`() = runTest {
        val db = createDb()
        val transport = mockTransport()
        val scope = CoroutineScope(SupervisorJob())
        val docId = UUID.randomUUID().toString()

        val session = DocumentSession(
            documentId = docId,
            senderId = "device-test",
            db = db,
            transport = transport,
            scope = scope,
        )

        val outId = session.editText(0, 0, "hello")
        assertTrue(outId > 0)

        // Verify outbound was created and marked SENT
        val outItems = db.outboundDao().getByDocumentId(docId)
        assertEquals(1, outItems.size)
        assertEquals(OutboundState.SENT, outItems[0].state)
        assertEquals("automerge-change", outItems[0].kind)

        // Verify transport received a frame
        assertEquals(1, transport.sentFrames.size)
        val decoded = ProtocolEnvelopeCodec.decode(transport.sentFrames[0])
        assertEquals(EnvelopeKind.AUTOMERGE_CHANGE, decoded.kind)
        assertEquals(docId, decoded.documentId)

        // Verify document snapshot was persisted
        val doc = db.documentDao().getByDocumentId(docId)
        assertNotNull(doc)
        assertTrue(doc.snapshot.isNotEmpty())

        session.close()
    }

    @Test
    fun `onInboundFrame applies changes and persists snapshot`() = runTest {
        val db = createDb()
        val transport = mockTransport()
        val scope = CoroutineScope(SupervisorJob())
        val docId = UUID.randomUUID().toString()

        val session = DocumentSession(
            documentId = docId,
            senderId = "device-test",
            db = db,
            transport = transport,
            scope = scope,
        )

        // First edit to create a base
        session.editText(0, 0, "base text")
        val snapshot1 = session.getSnapshot()

        // Create a second session with same snapshot to simulate remote edit
        val remoteDoc = Document.load(snapshot1)
        val remoteHeads = remoteDoc.getHeads()
        val textVal = remoteDoc.get(ObjectId.ROOT, "text")
        assertTrue(textVal.isPresent)
        val remoteTextId = (textVal.get() as AmValue.Text).id
        val remoteTx = remoteDoc.startTransaction()
        remoteTx.spliceText(remoteTextId, 9, 0, " added")
        remoteTx.commit()
        val remoteChanges = remoteDoc.encodeChangesSince(remoteHeads)

        // Encode as a protocol envelope
        val envelope = ProtocolEnvelope(
            documentId = docId,
            messageId = UUID.randomUUID().toString(),
            senderId = "remote-device",
            kind = EnvelopeKind.AUTOMERGE_CHANGE,
            createdAt = System.currentTimeMillis(),
            payload = remoteChanges,
        )
        val frameBytes = ProtocolEnvelopeCodec.encode(envelope)

        // Deliver inbound frame
        session.onInboundFrame(frameBytes)

        // Verify snapshot was updated
        val snapshot2 = session.getSnapshot()
        assertFalse(snapshot1.contentEquals(snapshot2))

        // Verify persisted snapshot was updated
        val doc = db.documentDao().getByDocumentId(docId)
        assertNotNull(doc)
        assertTrue(doc.snapshot.contentEquals(snapshot2))

        session.close()
    }

    @Test
    fun `close is idempotent and persists final state`() = runTest {
        val db = createDb()
        val transport = mockTransport()
        val scope = CoroutineScope(SupervisorJob())
        val docId = UUID.randomUUID().toString()

        val session = DocumentSession(
            documentId = docId,
            senderId = "device-test",
            db = db,
            transport = transport,
            scope = scope,
        )

        session.editText(0, 0, "some text")
        session.close()
        assertTrue(transport.closed)

        // Close again - should be idempotent
        session.close()
        assertTrue(transport.closed)

        // Verify final snapshot was persisted
        val doc = db.documentDao().getByDocumentId(docId)
        assertNotNull(doc)
        assertTrue(doc.snapshot.isNotEmpty())

        // Verify state is inactive
        assertFalse(session.state.value.active)
    }

    @Test
    fun `no send after close`() = runTest {
        val db = createDb()
        val transport = mockTransport()
        val scope = CoroutineScope(SupervisorJob())
        val docId = UUID.randomUUID().toString()

        val session = DocumentSession(
            documentId = docId,
            senderId = "device-test",
            db = db,
            transport = transport,
            scope = scope,
        )

        session.close()

        var threw = false
        try {
            session.editText(0, 0, "should fail")
        } catch (_: IllegalStateException) {
            threw = true
        }
        assertTrue(threw, "editText after close should throw IllegalStateException")
    }

    @Test
    fun `inbound frame for wrong document is ignored`() = runTest {
        val db = createDb()
        val transport = mockTransport()
        val scope = CoroutineScope(SupervisorJob())
        val docId = UUID.randomUUID().toString()

        val session = DocumentSession(
            documentId = docId,
            senderId = "device-test",
            db = db,
            transport = transport,
            scope = scope,
        )

        val snapshotBefore = session.getSnapshot()

        // Create envelope for different document
        val envelope = ProtocolEnvelope(
            documentId = UUID.randomUUID().toString(),
            messageId = UUID.randomUUID().toString(),
            senderId = "remote",
            kind = EnvelopeKind.AUTOMERGE_CHANGE,
            createdAt = System.currentTimeMillis(),
            payload = byteArrayOf(1, 2, 3),
        )
        session.onInboundFrame(ProtocolEnvelopeCodec.encode(envelope))

        // Snapshot should be unchanged
        assertTrue(session.getSnapshot().contentEquals(snapshotBefore))
        session.close()
    }
}

class MockTransport : SessionTransport {
    val sentFrames = mutableListOf<ByteArray>()
    var closed = false

    override fun send(frame: ByteArray): Boolean {
        check(!closed) { "transport is closed" }
        sentFrames.add(frame)
        return true
    }

    override fun close(): Boolean {
        closed = true
        return true
    }

    override val isConnected: Boolean get() = !closed
}
