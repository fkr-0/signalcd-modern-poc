package dev.e2ecol.android.protocol

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class EnvelopeKindTest {
    @Test
    fun `fromCode maps all known codes`() {
        assertEquals(EnvelopeKind.AUTOMERGE_CHANGE, EnvelopeKind.fromCode(1))
        assertEquals(EnvelopeKind.SNAPSHOT, EnvelopeKind.fromCode(2))
        assertEquals(EnvelopeKind.MEMBERSHIP, EnvelopeKind.fromCode(3))
        assertEquals(EnvelopeKind.ARCHIVE, EnvelopeKind.fromCode(4))
        assertEquals(EnvelopeKind.DELETE, EnvelopeKind.fromCode(5))
        assertEquals(EnvelopeKind.HEALTH, EnvelopeKind.fromCode(6))
        assertEquals(EnvelopeKind.CHUNK, EnvelopeKind.fromCode(7))
    }

    @Test
    fun `fromCode rejects unknown codes`() {
        assertFailsWith<ProtocolCodecException> { EnvelopeKind.fromCode(0) }
        assertFailsWith<ProtocolCodecException> { EnvelopeKind.fromCode(8) }
        assertFailsWith<ProtocolCodecException> { EnvelopeKind.fromCode(255) }
    }

    @Test
    fun `wireName matches expected strings`() {
        assertEquals("automerge-change", EnvelopeKind.AUTOMERGE_CHANGE.wireName)
        assertEquals("snapshot", EnvelopeKind.SNAPSHOT.wireName)
        assertEquals("membership", EnvelopeKind.MEMBERSHIP.wireName)
        assertEquals("chunk", EnvelopeKind.CHUNK.wireName)
    }
}
