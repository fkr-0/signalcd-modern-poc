package dev.e2ecol.android.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface DocumentDao {
    @Query("SELECT * FROM document WHERE documentId = :documentId")
    suspend fun getByDocumentId(documentId: String): DocumentEntity?

    @Query("SELECT * FROM document WHERE archived = 0")
    suspend fun getActive(): List<DocumentEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: DocumentEntity)

    @Query("UPDATE document SET snapshot = :snapshot, updatedAt = :updatedAt WHERE documentId = :documentId")
    suspend fun updateSnapshot(documentId: String, snapshot: ByteArray, updatedAt: Long)

    @Query("UPDATE document SET archived = 1 WHERE documentId = :documentId")
    suspend fun archive(documentId: String)

    @Query("DELETE FROM document WHERE documentId = :documentId")
    suspend fun deleteByDocumentId(documentId: String): Int
}
