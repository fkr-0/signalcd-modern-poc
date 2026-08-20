package dev.e2ecol.android.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

@Dao
interface OutboundDao {
    @Insert
    suspend fun insert(entity: OutboundEntity): Long

    @Query("SELECT * FROM outbound WHERE documentId = :documentId ORDER BY createdAt ASC")
    suspend fun getByDocumentId(documentId: String): List<OutboundEntity>

    @Query("SELECT * FROM outbound WHERE state = 'PENDING' ORDER BY createdAt ASC")
    suspend fun getPending(): List<OutboundEntity>

    @Query("UPDATE outbound SET state = :state WHERE id = :id")
    suspend fun updateState(id: Long, state: OutboundState)

    @Query("UPDATE outbound SET state = :state, attempts = attempts + 1 WHERE id = :id")
    suspend fun incrementAttempt(id: Long, state: OutboundState)

    @Query("DELETE FROM outbound WHERE documentId = :documentId")
    suspend fun deleteByDocumentId(documentId: String): Int
}
