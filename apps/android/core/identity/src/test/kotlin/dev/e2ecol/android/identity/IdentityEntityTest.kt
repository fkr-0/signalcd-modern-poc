package dev.e2ecol.android.identity

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals

class IdentityEntityTest {
    @Test
    fun `identity entity stores all fields correctly`() {
        val entity = IdentityEntity(
            userId = "user-1",
            phoneNumber = "+15551234567",
            displayName = "Alice",
            identityKeyPublic = byteArrayOf(1, 2, 3),
            signedPrekeyPublic = byteArrayOf(4, 5, 6),
            sessionToken = "tok-abc",
            createdAt = 1_700_000_000_000,
        )
        assertEquals("user-1", entity.userId)
        assertEquals("+15551234567", entity.phoneNumber)
        assertEquals("Alice", entity.displayName)
        assertEquals("tok-abc", entity.sessionToken)
        assertEquals(1_700_000_000_000, entity.createdAt)
    }

    @Test
    fun `identity entity equality is based on content`() {
        val a = IdentityEntity("u1", "+1", "A", byteArrayOf(1), byteArrayOf(2), "t", 1)
        val b = IdentityEntity("u1", "+1", "A", byteArrayOf(1), byteArrayOf(2), "t", 1)
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test
    fun `identity entity inequality on different fields`() {
        val a = IdentityEntity("u1", "+1", "A", byteArrayOf(1), byteArrayOf(2), "t", 1)
        val b = IdentityEntity("u2", "+1", "A", byteArrayOf(1), byteArrayOf(2), "t", 1)
        assertNotEquals(a, b)
    }

    @Test
    fun `identity entity copy preserves unchanged fields`() {
        val original = IdentityEntity("u1", "+1", "A", byteArrayOf(1), byteArrayOf(2), "t", 1)
        val copied = original.copy(displayName = "B")
        assertEquals("u1", copied.userId)
        assertEquals("B", copied.displayName)
        assertEquals(original.phoneNumber, copied.phoneNumber)
    }
}
