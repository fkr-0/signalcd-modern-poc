package dev.e2ecol.android.identity

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class RemoteIdentityEntityTest {
    @Test
    fun `remote identity entity stores all fields correctly`() {
        val entity = RemoteIdentityEntity(
            userId = "remote-1",
            phoneNumber = "+15559876543",
            identityKeyPublic = byteArrayOf(7, 8, 9),
            verified = true,
            fetchedAt = 1_700_000_000_000,
        )
        assertEquals("remote-1", entity.userId)
        assertEquals("+15559876543", entity.phoneNumber)
        assertTrue(entity.verified)
        assertEquals(1_700_000_000_000, entity.fetchedAt)
    }

    @Test
    fun `remote identity entity equality is based on content`() {
        val a = RemoteIdentityEntity("r1", "+1", byteArrayOf(1), false, 1)
        val b = RemoteIdentityEntity("r1", "+1", byteArrayOf(1), false, 1)
        assertEquals(a, b)
        assertEquals(a.hashCode(), b.hashCode())
    }

    @Test
    fun `remote identity entity inequality on different userId`() {
        val a = RemoteIdentityEntity("r1", "+1", byteArrayOf(1), false, 1)
        val b = RemoteIdentityEntity("r2", "+1", byteArrayOf(1), false, 1)
        assertNotEquals(a, b)
    }

    @Test
    fun `remote identity entity copy preserves unchanged fields`() {
        val original = RemoteIdentityEntity("r1", "+1", byteArrayOf(1), false, 1)
        val copied = original.copy(verified = true)
        assertEquals("r1", copied.userId)
        assertTrue(copied.verified)
        assertFalse(original.verified)
        assertEquals(original.phoneNumber, copied.phoneNumber)
    }
}
