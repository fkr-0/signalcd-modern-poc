package dev.e2ecol.android.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction

@Dao
abstract class StorageTransactionDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    protected abstract suspend fun upsertDocument(entity: DocumentEntity)

    @Insert
    protected abstract suspend fun insertOutbound(entity: OutboundEntity): Long

    @Transaction
    open suspend fun persistSnapshotAndEnqueue(
        document: DocumentEntity,
        outbound: OutboundEntity,
    ): Long {
        upsertDocument(document)
        return insertOutbound(outbound)
    }

    @Query("UPDATE outbound SET state = :state WHERE id = :id")
    protected abstract suspend fun updateOutboundState(id: Long, state: OutboundState)

    @Query("UPDATE document SET snapshot = :snapshot, updatedAt = :updatedAt WHERE documentId = :documentId")
    protected abstract suspend fun updateSnapshot(documentId: String, snapshot: ByteArray, updatedAt: Long)

    @Transaction
    open suspend fun applyInboundAndPersist(
        documentId: String,
        snapshot: ByteArray,
        updatedAt: Long,
    ) {
        updateSnapshot(documentId, snapshot, updatedAt)
    }

    @Transaction
    open suspend fun markOutboundSent(outboundId: Long) {
        updateOutboundState(outboundId, OutboundState.SENT)
    }
}
