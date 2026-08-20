package dev.e2ecol.android.storage

import androidx.room.Room
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import dev.e2ecol.android.identity.IdentityEntity
import dev.e2ecol.android.identity.RemoteIdentityEntity
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class IdentityThroughSharedDbTest {
    private val db = Room.inMemoryDatabaseBuilder<E2ColDatabase>()
        .setDriver(BundledSQLiteDriver())
        .build()

    private val identityDao = db.identityDao()
    private val remoteIdentityDao = db.remoteIdentityDao()

    @Test
    fun `identity CRUD through shared E2ColDatabase`() = runTest {
        val entity = IdentityEntity(
            userId = "shared-user-1",
            phoneNumber = "+15551234567",
            displayName = "Alice",
            identityKeyPublic = byteArrayOf(1, 2, 3),
            signedPrekeyPublic = byteArrayOf(4, 5, 6),
            sessionToken = "tok-shared",
            createdAt = 1_700_000_000_000,
        )
        identityDao.upsert(entity)
        val loaded = identityDao.getByUserId("shared-user-1")
        assertNotNull(loaded)
        assertEquals("Alice", loaded.displayName)
        assertTrue(loaded.identityKeyPublic.contentEquals(byteArrayOf(1, 2, 3)))

        identityDao.upsert(loaded.copy(displayName = "Alicia"))
        val updated = identityDao.getByUserId("shared-user-1")
        assertNotNull(updated)
        assertEquals("Alicia", updated.displayName)

        identityDao.deleteByUserId("shared-user-1")
        assertNull(identityDao.getByUserId("shared-user-1"))
    }

    @Test
    fun `remote identity CRUD through shared E2ColDatabase`() = runTest {
        val entity = RemoteIdentityEntity(
            userId = "shared-remote-1",
            phoneNumber = "+15559876543",
            identityKeyPublic = byteArrayOf(7, 8, 9),
            verified = false,
            fetchedAt = 1_700_000_000_000,
        )
        remoteIdentityDao.upsert(entity)
        val loaded = remoteIdentityDao.getByUserId("shared-remote-1")
        assertNotNull(loaded)
        assertFalse(loaded.verified)

        remoteIdentityDao.upsert(loaded.copy(verified = true))
        val updated = remoteIdentityDao.getByUserId("shared-remote-1")
        assertNotNull(updated)
        assertTrue(updated.verified)

        remoteIdentityDao.deleteByUserId("shared-remote-1")
        assertNull(remoteIdentityDao.getByUserId("shared-remote-1"))
    }

    @Test
    fun `identity and document coexist in same database`() = runTest {
        identityDao.upsert(IdentityEntity("coexist-1", "+1", "A", byteArrayOf(1), byteArrayOf(2), "t", 1))
        db.documentDao().upsert(DocumentEntity("coexist-doc", byteArrayOf(10), 1, "Doc", false))

        assertEquals(1, identityDao.getAll().size)
        assertNotNull(db.documentDao().getByDocumentId("coexist-doc"))
    }
}
