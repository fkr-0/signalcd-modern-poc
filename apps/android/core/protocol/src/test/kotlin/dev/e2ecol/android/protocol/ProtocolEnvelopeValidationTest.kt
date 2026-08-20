package dev.e2ecol.android.protocol

import java.util.HexFormat
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ProtocolEnvelopeValidationTest {
    @Test
    fun `round trips envelope with sequence null`() {
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.SNAPSHOT,
            createdAt = 1_000_000,
            sequence = null,
            payload = byteArrayOf(10, 20, 30),
        )
        val decoded = ProtocolEnvelopeCodec.decode(ProtocolEnvelopeCodec.encode(env))
        assertNull(decoded.sequence)
        assertEquals(EnvelopeKind.SNAPSHOT, decoded.kind)
        assertContentEquals(byteArrayOf(10, 20, 30), decoded.payload)
    }

    @Test
    fun `round trips chunk envelope with metadata`() {
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.CHUNK,
            createdAt = 1_000_000,
            chunk = ChunkMetadata(
                index = 0,
                total = 3,
                originalMessageId = "33333333-3333-4333-8333-333333333333",
                originalKind = EnvelopeKind.AUTOMERGE_CHANGE,
            ),
            payload = byteArrayOf(5, 6, 7),
        )
        val decoded = ProtocolEnvelopeCodec.decode(ProtocolEnvelopeCodec.encode(env))
        val chunk = assertNotNull(decoded.chunk)
        assertEquals(0, chunk.index)
        assertEquals(3, chunk.total)
        assertEquals("33333333-3333-4333-8333-333333333333", chunk.originalMessageId)
        assertEquals(EnvelopeKind.AUTOMERGE_CHANGE, chunk.originalKind)
    }

    @Test
    fun `rejects chunk with index equal to total`() {
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.CHUNK,
            createdAt = 1_000_000,
            chunk = ChunkMetadata(
                index = 3,
                total = 3,
                originalMessageId = "33333333-3333-4333-8333-333333333333",
                originalKind = EnvelopeKind.SNAPSHOT,
            ),
            payload = byteArrayOf(1),
        )
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.encode(env) }
    }

    @Test
    fun `rejects non-chunk envelope with chunk metadata`() {
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.AUTOMERGE_CHANGE,
            createdAt = 1_000_000,
            chunk = ChunkMetadata(
                index = 0,
                total = 2,
                originalMessageId = "33333333-3333-4333-8333-333333333333",
                originalKind = EnvelopeKind.SNAPSHOT,
            ),
            payload = byteArrayOf(1),
        )
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.encode(env) }
    }

    @Test
    fun `rejects empty senderId`() {
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "",
            kind = EnvelopeKind.SNAPSHOT,
            createdAt = 1_000_000,
            payload = byteArrayOf(1),
        )
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.encode(env) }
    }

    @Test
    fun `rejects invalid documentId UUID`() {
        val env = ProtocolEnvelope(
            documentId = "not-a-uuid",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.SNAPSHOT,
            createdAt = 1_000_000,
            payload = byteArrayOf(1),
        )
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.encode(env) }
    }

    @Test
    fun `round trips envelope with max payload`() {
        val payload = ByteArray(1024) { it.toByte() }
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.AUTOMERGE_CHANGE,
            createdAt = 1_000_000,
            payload = payload,
        )
        val decoded = ProtocolEnvelopeCodec.decode(ProtocolEnvelopeCodec.encode(env))
        assertContentEquals(payload, decoded.payload)
    }

    @Test
    fun `rejects negative createdAt`() {
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.SNAPSHOT,
            createdAt = -1,
            payload = byteArrayOf(1),
        )
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.encode(env) }
    }

    @Test
    fun `rejects chunk total less than 2`() {
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.CHUNK,
            createdAt = 1_000_000,
            chunk = ChunkMetadata(
                index = 0,
                total = 1,
                originalMessageId = "33333333-3333-4333-8333-333333333333",
                originalKind = EnvelopeKind.SNAPSHOT,
            ),
            payload = byteArrayOf(1),
        )
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.encode(env) }
    }

    @Test
    fun `rejects chunk with original kind CHUNK`() {
        val env = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.CHUNK,
            createdAt = 1_000_000,
            chunk = ChunkMetadata(
                index = 0,
                total = 2,
                originalMessageId = "33333333-3333-4333-8333-333333333333",
                originalKind = EnvelopeKind.CHUNK,
            ),
            payload = byteArrayOf(1),
        )
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.encode(env) }
    }

    @Test
    fun `equality ignores payload reference identity`() {
        val a = ProtocolEnvelope(
            documentId = "11111111-1111-4111-8111-111111111111",
            messageId = "22222222-2222-4222-8222-222222222222",
            senderId = "device-A",
            kind = EnvelopeKind.SNAPSHOT,
            createdAt = 1_000_000,
            payload = byteArrayOf(1, 2, 3),
        )
        val b = a.copy(payload = byteArrayOf(1, 2, 3))
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }
}
