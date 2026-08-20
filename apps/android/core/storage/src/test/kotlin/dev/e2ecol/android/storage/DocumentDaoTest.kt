package dev.e2ecol.android.storage

import androidx.room.Room
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class DocumentDaoTest {
    private val db = Room.inMemoryDatabaseBuilder<E2ColDatabase>()
        .setDriver(BundledSQLiteDriver())
        .build()

    private val dao = db.documentDao()

    @Test
    fun `upsert and retrieve document`() = runTest {
        val doc = DocumentEntity(
            documentId = "doc-1",
            snapshot = byteArrayOf(1, 2, 3),
            updatedAt = 1_700_000_000_000,
            title = "Test Doc",
            archived = false,
        )
        dao.upsert(doc)
        val loaded = dao.getByDocumentId("doc-1")
        assertNotNull(loaded)
        assertEquals("doc-1", loaded.documentId)
        assertEquals("Test Doc", loaded.title)
        assertFalse(loaded.archived)
    }

    @Test
    fun `upsert replaces on conflict`() = runTest {
        dao.upsert(DocumentEntity("doc-2", byteArrayOf(1), 100, "Old", false))
        dao.upsert(DocumentEntity("doc-2", byteArrayOf(2), 200, "New", false))
        val loaded = dao.getByDocumentId("doc-2")
        assertNotNull(loaded)
        assertEquals("New", loaded.title)
        assertEquals(200, loaded.updatedAt)
    }

    @Test
    fun `getActive excludes archived`() = runTest {
        dao.upsert(DocumentEntity("a", byteArrayOf(1), 1, "A", false))
        dao.upsert(DocumentEntity("b", byteArrayOf(2), 2, "B", true))
        val active = dao.getActive()
        assertEquals(1, active.size)
        assertEquals("a", active[0].documentId)
    }

    @Test
    fun `updateSnapshot changes snapshot and timestamp`() = runTest {
        dao.upsert(DocumentEntity("doc-3", byteArrayOf(1), 100, "Doc3", false))
        dao.updateSnapshot("doc-3", byteArrayOf(9, 8, 7), 200)
        val loaded = dao.getByDocumentId("doc-3")
        assertNotNull(loaded)
        assertEquals(200, loaded.updatedAt)
        assertTrue(loaded.snapshot.contentEquals(byteArrayOf(9, 8, 7)))
    }

    @Test
    fun `archive sets archived flag`() = runTest {
        dao.upsert(DocumentEntity("doc-4", byteArrayOf(1), 100, "Doc4", false))
        dao.archive("doc-4")
        val loaded = dao.getByDocumentId("doc-4")
        assertNotNull(loaded)
        assertTrue(loaded.archived)
    }

    @Test
    fun `deleteByDocumentId removes document`() = runTest {
        dao.upsert(DocumentEntity("doc-5", byteArrayOf(1), 100, "Doc5", false))
        assertEquals(1, dao.deleteByDocumentId("doc-5"))
        assertNull(dao.getByDocumentId("doc-5"))
    }
}
