package dev.e2ecol.android.protocol

import java.util.HexFormat
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class ProtocolEnvelopeCodecTest {
    private val fixture = ProtocolEnvelope(
        documentId = "11111111-1111-4111-8111-111111111111",
        messageId = "22222222-2222-4222-8222-222222222222",
        senderId = "device-A",
        kind = EnvelopeKind.AUTOMERGE_CHANGE,
        createdAt = 1_787_159_200_000,
        sequence = 7,
        payload = byteArrayOf(1, 2, 3, 4),
    )

    private val authorizationResolutionFixture = ProtocolEnvelope(
        documentId = "11111111-1111-4111-8111-111111111111",
        messageId = "22222222-2222-4222-8222-222222222222",
        senderId = "device-A",
        kind = EnvelopeKind.AUTHORIZATION_RESOLUTION,
        createdAt = 1_787_159_200_000,
        sequence = 7,
        payload = byteArrayOf(9, 8, 7, 6),
    )

    @Test
    fun `matches the canonical TypeScript wire fixture byte-for-byte`() {
        val hex = HexFormat.of().formatHex(ProtocolEnvelopeCodec.encode(fixture))
        assertEquals(
            "45324543010101000001a01afd41000000000000000007002431313131313131312d313131312d343131312d383131312d313131313131313131313131002432323232323232322d323232322d343232322d383232322d32323232323232323232323200086465766963652d410000000401020304",
            hex,
        )
    }

    @Test
    fun `matches the canonical TypeScript authorization resolution fixture byte-for-byte`() {
        val encoded = ProtocolEnvelopeCodec.encode(authorizationResolutionFixture)
        assertEquals(
            "45324543010801000001a01afd41000000000000000007002431313131313131312d313131312d343131312d383131312d313131313131313131313131002432323232323232322d323232322d343232322d383232322d32323232323232323232323200086465766963652d410000000409080706",
            HexFormat.of().formatHex(encoded),
        )
        assertEquals(authorizationResolutionFixture, ProtocolEnvelopeCodec.decode(encoded))
    }

    @Test
    fun `matches TypeScript chunk metadata when original kind is authorization resolution`() {
        val chunk = ProtocolEnvelope(
            documentId = authorizationResolutionFixture.documentId,
            messageId = "33333333-3333-4333-8333-333333333333",
            senderId = authorizationResolutionFixture.senderId,
            kind = EnvelopeKind.CHUNK,
            createdAt = authorizationResolutionFixture.createdAt,
            sequence = authorizationResolutionFixture.sequence,
            chunk = ChunkMetadata(
                index = 0,
                total = 2,
                originalMessageId = authorizationResolutionFixture.messageId,
                originalKind = EnvelopeKind.AUTHORIZATION_RESOLUTION,
            ),
            payload = authorizationResolutionFixture.payload,
        )
        val encoded = ProtocolEnvelopeCodec.encode(chunk)
        assertEquals(
            "45324543010703000001a01afd41000000000000000007002431313131313131312d313131312d343131312d383131312d313131313131313131313131002433333333333333332d333333332d343333332d383333332d33333333333333333333333300086465766963652d410000000000000002002432323232323232322d323232322d343232322d383232322d323232323232323232323232080000000409080706",
            HexFormat.of().formatHex(encoded),
        )
        assertEquals(EnvelopeKind.AUTHORIZATION_RESOLUTION, ProtocolEnvelopeCodec.decode(encoded).chunk?.originalKind)
    }

    @Test
    fun `round trips canonical envelopes without payload aliasing`() {
        val decoded = ProtocolEnvelopeCodec.decode(ProtocolEnvelopeCodec.encode(fixture))
        assertEquals(fixture, decoded)
        assertContentEquals(fixture.payload, decoded.payload)
        decoded.payload[0] = 99
        assertEquals(1, fixture.payload[0])
    }

    @Test
    fun `rejects unsupported versions and trailing bytes`() {
        val encoded = ProtocolEnvelopeCodec.encode(fixture)
        encoded[4] = 2
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.decode(encoded) }

        val trailing = ProtocolEnvelopeCodec.encode(fixture) + byteArrayOf(0)
        assertFailsWith<ProtocolCodecException> { ProtocolEnvelopeCodec.decode(trailing) }
    }
}
