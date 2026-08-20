package dev.e2ecol.android.storage

import androidx.room.Room
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class StorageTransactionDaoTest {
    private val db = Room.inMemoryDatabaseBuilder<E2ColDatabase>()
        .setDriver(BundledSQLiteDriver())
        .build()

    private val txDao = db.storageTransactionDao()
    private val docDao = db.documentDao()
    private val outDao = db.outboundDao()

    @Test
    fun `persistSnapshotAndEnqueue atomically writes document and outbound`() = runTest {
        val doc = DocumentEntity("tx-1", byteArrayOf(1, 2, 3), 1000, "Tx Doc", false)
        val out = OutboundEntity(
            documentId = "tx-1",
            payload = byteArrayOf(10, 20),
            createdAt = 1000,
            state = OutboundState.PENDING,
            attempts = 0,
            kind = "automerge-change",
        )
        val outId = txDao.persistSnapshotAndEnqueue(doc, out)
        assertTrue(outId > 0)

        val loadedDoc = docDao.getByDocumentId("tx-1")
        assertNotNull(loadedDoc)
        assertEquals("Tx Doc", loadedDoc.title)

        val pending = outDao.getByDocumentId("tx-1")
        assertEquals(1, pending.size)
        assertEquals(OutboundState.PENDING, pending[0].state)
    }

    @Test
    fun `applyInboundAndPersist updates snapshot`() = runTest {
        docDao.upsert(DocumentEntity("tx-2", byteArrayOf(1), 100, "Doc", false))
        txDao.applyInboundAndPersist("tx-2", byteArrayOf(9, 8, 7), 200)
        val loaded = docDao.getByDocumentId("tx-2")
        assertNotNull(loaded)
        assertEquals(200, loaded.updatedAt)
        assertTrue(loaded.snapshot.contentEquals(byteArrayOf(9, 8, 7)))
    }

    @Test
    fun `markOutboundSent transitions state`() = runTest {
        val doc = DocumentEntity("tx-3", byteArrayOf(1), 100, "Doc", false)
        val out = OutboundEntity(
            documentId = "tx-3",
            payload = byteArrayOf(10),
            createdAt = 100,
            state = OutboundState.PENDING,
            attempts = 0,
            kind = "snapshot",
        )
        val outId = txDao.persistSnapshotAndEnqueue(doc, out)
        txDao.markOutboundSent(outId)
        val items = outDao.getByDocumentId("tx-3")
        assertEquals(OutboundState.SENT, items[0].state)
    }
}
