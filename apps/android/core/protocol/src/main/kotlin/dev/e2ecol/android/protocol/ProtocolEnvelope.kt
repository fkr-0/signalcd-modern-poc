package dev.e2ecol.android.protocol

enum class EnvelopeKind(val wireName: String, val code: Int) {
    AUTOMERGE_CHANGE("automerge-change", 1),
    SNAPSHOT("snapshot", 2),
    MEMBERSHIP("membership", 3),
    ARCHIVE("archive", 4),
    DELETE("delete", 5),
    HEALTH("health", 6),
    CHUNK("chunk", 7);

    companion object {
        fun fromCode(code: Int): EnvelopeKind =
            entries.firstOrNull { it.code == code }
                ?: throw ProtocolCodecException("unknown frame kind code $code")
    }
}

data class ChunkMetadata(
    val index: Int,
    val total: Int,
    val originalMessageId: String,
    val originalKind: EnvelopeKind,
)

data class ProtocolEnvelope(
    val version: Int = ProtocolEnvelopeCodec.PROTOCOL_VERSION,
    val documentId: String,
    val messageId: String,
    val senderId: String,
    val kind: EnvelopeKind,
    val createdAt: Long,
    val sequence: Long? = null,
    val chunk: ChunkMetadata? = null,
    val payload: ByteArray,
) {
    override fun equals(other: Any?): Boolean =
        other is ProtocolEnvelope &&
            version == other.version &&
            documentId == other.documentId &&
            messageId == other.messageId &&
            senderId == other.senderId &&
            kind == other.kind &&
            createdAt == other.createdAt &&
            sequence == other.sequence &&
            chunk == other.chunk &&
            payload.contentEquals(other.payload)

    override fun hashCode(): Int =
        listOf(version, documentId, messageId, senderId, kind, createdAt, sequence, chunk).hashCode() * 31 +
            payload.contentHashCode()
}

class ProtocolCodecException(message: String) : IllegalArgumentException(message)
