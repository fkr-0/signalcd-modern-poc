package dev.e2ecol.android.storage

import androidx.room.Room
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class AccessControlDaoTest {
    private val db = Room.inMemoryDatabaseBuilder<E2ColDatabase>()
        .setDriver(BundledSQLiteDriver())
        .build()

    private val dao = db.accessControlDao()

    @Test
    fun `upsert and retrieve access control`() = runTest {
        val acl = AccessControlEntity(
            documentId = "doc-1",
            selfRole = "owner",
            participants = """[{"userId":"u1","role":"owner"}]""",
            archived = false,
            deleted = false,
            revision = 1,
        )
        dao.upsert(acl)
        val loaded = dao.getByDocumentId("doc-1")
        assertNotNull(loaded)
        assertEquals("owner", loaded.selfRole)
        assertEquals(1L, loaded.revision)
    }

    @Test
    fun `upsert replaces on conflict`() = runTest {
        dao.upsert(AccessControlEntity("doc-2", "editor", "[]", false, false, 1))
        dao.upsert(AccessControlEntity("doc-2", "owner", "[]", false, false, 2))
        val loaded = dao.getByDocumentId("doc-2")
        assertNotNull(loaded)
        assertEquals("owner", loaded.selfRole)
        assertEquals(2L, loaded.revision)
    }

    @Test
    fun `getActive excludes archived and deleted`() = runTest {
        dao.upsert(AccessControlEntity("a", "owner", "[]", false, false, 1))
        dao.upsert(AccessControlEntity("b", "owner", "[]", true, false, 1))
        dao.upsert(AccessControlEntity("c", "owner", "[]", false, true, 1))
        val active = dao.getActive()
        assertEquals(1, active.size)
        assertEquals("a", active[0].documentId)
    }

    @Test
    fun `archive sets archived flag`() = runTest {
        dao.upsert(AccessControlEntity("doc-3", "owner", "[]", false, false, 1))
        dao.archive("doc-3")
        val loaded = dao.getByDocumentId("doc-3")
        assertNotNull(loaded)
        assertTrue(loaded.archived)
    }

    @Test
    fun `markDeleted sets deleted flag`() = runTest {
        dao.upsert(AccessControlEntity("doc-4", "owner", "[]", false, false, 1))
        dao.markDeleted("doc-4")
        val loaded = dao.getByDocumentId("doc-4")
        assertNotNull(loaded)
        assertTrue(loaded.deleted)
    }

    @Test
    fun `deleteByDocumentId removes record`() = runTest {
        dao.upsert(AccessControlEntity("doc-5", "owner", "[]", false, false, 1))
        assertEquals(1, dao.deleteByDocumentId("doc-5"))
        assertEquals(null, dao.getByDocumentId("doc-5"))
    }
}
