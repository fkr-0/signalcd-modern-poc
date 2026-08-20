package dev.e2ecol.android.protocol

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.nio.charset.StandardCharsets
import java.util.UUID

object ProtocolEnvelopeCodec {
    const val PROTOCOL_VERSION = 1
    const val MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
    const val MAX_CHUNKS = 4096
    const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    private val magic = byteArrayOf(0x45, 0x32, 0x45, 0x43)
    private val uuidPattern = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    private const val flagSequence = 1
    private const val flagChunk = 2
    private const val knownFlags = flagSequence or flagChunk

    fun encode(value: ProtocolEnvelope): ByteArray {
        validate(value)
        val output = ByteArrayOutputStream()
        DataOutputStream(output).use { writer ->
            writer.write(magic)
            writer.writeByte(value.version)
            writer.writeByte(value.kind.code)
            writer.writeByte(
                (if (value.sequence == null) 0 else flagSequence) or
                    (if (value.chunk == null) 0 else flagChunk),
            )
            writeSafeLong(writer, value.createdAt, "createdAt")
            value.sequence?.let { writeSafeLong(writer, it, "sequence") }
            writeString(writer, value.documentId)
            writeString(writer, value.messageId)
            writeString(writer, value.senderId)
            value.chunk?.let { chunk ->
                writer.writeInt(chunk.index)
                writer.writeInt(chunk.total)
                writeString(writer, chunk.originalMessageId)
                writer.writeByte(chunk.originalKind.code)
            }
            writer.writeInt(value.payload.size)
            writer.write(value.payload)
        }
        return output.toByteArray()
    }

    fun decode(bytes: ByteArray): ProtocolEnvelope {
        val input = ByteArrayInputStream(bytes)
        val reader = DataInputStream(input)
        magic.forEach { expected ->
            if (reader.readUnsignedByte() != expected.toInt()) {
                throw ProtocolCodecException("invalid envelope magic")
            }
        }
        val version = reader.readUnsignedByte()
        if (version != PROTOCOL_VERSION) {
            throw ProtocolCodecException("unsupported protocol version $version")
        }
        val kind = EnvelopeKind.fromCode(reader.readUnsignedByte())
        val flags = reader.readUnsignedByte()
        if (flags and knownFlags.inv() != 0) throw ProtocolCodecException("unknown envelope flags")
        val createdAt = readSafeLong(reader, "createdAt")
        val sequence = if (flags and flagSequence != 0) readSafeLong(reader, "sequence") else null
        val documentId = readString(reader)
        val messageId = readString(reader)
        val senderId = readString(reader)
        val chunk = if (flags and flagChunk != 0) {
            val index = reader.readInt()
            val total = reader.readInt()
            val originalMessageId = readString(reader)
            val originalKind = EnvelopeKind.fromCode(reader.readUnsignedByte())
            if (originalKind == EnvelopeKind.CHUNK) {
                throw ProtocolCodecException("chunk cannot be the original kind of another chunk")
            }
            ChunkMetadata(index, total, originalMessageId, originalKind)
        } else {
            null
        }
        val payloadLength = reader.readInt()
        if (payloadLength < 0 || payloadLength > MAX_PAYLOAD_BYTES) {
            throw ProtocolCodecException("payload must not exceed $MAX_PAYLOAD_BYTES bytes")
        }
        val payload = ByteArray(payloadLength)
        reader.readFully(payload)
        if (input.available() != 0) throw ProtocolCodecException("trailing bytes after envelope")
        return ProtocolEnvelope(
            version = version,
            documentId = documentId,
            messageId = messageId,
            senderId = senderId,
            kind = kind,
            createdAt = createdAt,
            sequence = sequence,
            chunk = chunk,
            payload = payload,
        ).also(::validate)
    }

    private fun validate(value: ProtocolEnvelope) {
        if (value.version != PROTOCOL_VERSION) {
            throw ProtocolCodecException("unsupported protocol version ${value.version}")
        }
        requireUuid(value.documentId, "documentId")
        requireUuid(value.messageId, "messageId")
        if (value.senderId.isEmpty() || value.senderId.length > 512) {
            throw ProtocolCodecException("senderId must be a non-empty string of at most 512 characters")
        }
        requireSafeInteger(value.createdAt, "createdAt")
        value.sequence?.let { requireSafeInteger(it, "sequence") }
        if (value.payload.size > MAX_PAYLOAD_BYTES) {
            throw ProtocolCodecException("payload must not exceed $MAX_PAYLOAD_BYTES bytes")
        }
        if (value.kind == EnvelopeKind.CHUNK && value.chunk == null) {
            throw ProtocolCodecException("chunk metadata is required for chunk frames")
        }
        if (value.kind != EnvelopeKind.CHUNK && value.chunk != null) {
            throw ProtocolCodecException("chunk metadata is only allowed for chunk frames")
        }
        value.chunk?.let { chunk ->
            if (chunk.total !in 2..MAX_CHUNKS) {
                throw ProtocolCodecException("chunk total must be between 2 and $MAX_CHUNKS")
            }
            if (chunk.index !in 0 until chunk.total) {
                throw ProtocolCodecException("chunk index must be lower than total")
            }
            requireUuid(chunk.originalMessageId, "chunk.originalMessageId")
            if (chunk.originalKind == EnvelopeKind.CHUNK) {
                throw ProtocolCodecException("chunk cannot be the original kind of another chunk")
            }
        }
    }

    private fun requireUuid(value: String, field: String) {
        if (!uuidPattern.matches(value)) throw ProtocolCodecException("$field must be a UUID string")
        try {
            UUID.fromString(value)
        } catch (_: IllegalArgumentException) {
            throw ProtocolCodecException("$field must be a UUID string")
        }
    }

    private fun requireSafeInteger(value: Long, field: String) {
        if (value < 0 || value > MAX_SAFE_INTEGER) {
            throw ProtocolCodecException("$field must be a non-negative safe integer")
        }
    }

    private fun writeSafeLong(writer: DataOutputStream, value: Long, field: String) {
        requireSafeInteger(value, field)
        writer.writeLong(value)
    }

    private fun readSafeLong(reader: DataInputStream, field: String): Long =
        reader.readLong().also { requireSafeInteger(it, field) }

    private fun writeString(writer: DataOutputStream, value: String) {
        val encoded = value.toByteArray(StandardCharsets.UTF_8)
        if (encoded.size > 0xffff) throw ProtocolCodecException("string exceeds 65535 bytes")
        writer.writeShort(encoded.size)
        writer.write(encoded)
    }

    private fun readString(reader: DataInputStream): String {
        val length = reader.readUnsignedShort()
        val encoded = ByteArray(length)
        reader.readFully(encoded)
        val decoded = encoded.toString(StandardCharsets.UTF_8)
        if (!decoded.toByteArray(StandardCharsets.UTF_8).contentEquals(encoded)) {
            throw ProtocolCodecException("invalid UTF-8 string")
        }
        return decoded
    }
}
