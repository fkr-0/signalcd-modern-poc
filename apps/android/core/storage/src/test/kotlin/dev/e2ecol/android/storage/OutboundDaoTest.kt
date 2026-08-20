package dev.e2ecol.android.storage

import androidx.room.Room
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class OutboundDaoTest {
    private val db = Room.inMemoryDatabaseBuilder<E2ColDatabase>()
        .setDriver(BundledSQLiteDriver())
        .build()

    private val dao = db.outboundDao()

    @Test
    fun `insert and retrieve outbound by documentId`() = runTest {
        val id = dao.insert(
            OutboundEntity(
                documentId = "doc-1",
                payload = byteArrayOf(10, 20),
                createdAt = 1_700_000_000_000,
                state = OutboundState.PENDING,
                attempts = 0,
                kind = "automerge-change",
            ),
        )
        assertTrue(id > 0)
        val items = dao.getByDocumentId("doc-1")
        assertEquals(1, items.size)
        assertEquals(OutboundState.PENDING, items[0].state)
        assertEquals("automerge-change", items[0].kind)
    }

    @Test
    fun `getPending returns only pending items`() = runTest {
        dao.insert(OutboundEntity(documentId = "d1", payload = byteArrayOf(1), createdAt = 1, state = OutboundState.PENDING, attempts = 0, kind = "k"))
        dao.insert(OutboundEntity(documentId = "d1", payload = byteArrayOf(2), createdAt = 2, state = OutboundState.SENT, attempts = 1, kind = "k"))
        dao.insert(OutboundEntity(documentId = "d1", payload = byteArrayOf(3), createdAt = 3, state = OutboundState.PENDING, attempts = 0, kind = "k"))
        val pending = dao.getPending()
        assertEquals(2, pending.size)
    }

    @Test
    fun `updateState changes outbound state`() = runTest {
        val id = dao.insert(OutboundEntity(documentId = "d2", payload = byteArrayOf(1), createdAt = 1, state = OutboundState.PENDING, attempts = 0, kind = "k"))
        dao.updateState(id, OutboundState.SENT)
        val items = dao.getByDocumentId("d2")
        assertEquals(OutboundState.SENT, items[0].state)
    }

    @Test
    fun `incrementAttempt bumps attempts and updates state`() = runTest {
        val id = dao.insert(OutboundEntity(documentId = "d3", payload = byteArrayOf(1), createdAt = 1, state = OutboundState.PENDING, attempts = 0, kind = "k"))
        dao.incrementAttempt(id, OutboundState.FAILED)
        val items = dao.getByDocumentId("d3")
        assertEquals(1, items[0].attempts)
        assertEquals(OutboundState.FAILED, items[0].state)
    }

    @Test
    fun `deleteByDocumentId removes all outbound for document`() = runTest {
        dao.insert(OutboundEntity(documentId = "d4", payload = byteArrayOf(1), createdAt = 1, state = OutboundState.PENDING, attempts = 0, kind = "k"))
        dao.insert(OutboundEntity(documentId = "d4", payload = byteArrayOf(2), createdAt = 2, state = OutboundState.SENT, attempts = 1, kind = "k"))
        assertEquals(2, dao.deleteByDocumentId("d4"))
        assertTrue(dao.getByDocumentId("d4").isEmpty())
    }
}
