package dev.e2ecol.android.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

@Dao
interface AccessControlDao {
    @Query("SELECT * FROM access_control WHERE documentId = :documentId")
    suspend fun getByDocumentId(documentId: String): AccessControlEntity?

    @Query("SELECT * FROM access_control WHERE archived = 0 AND deleted = 0")
    suspend fun getActive(): List<AccessControlEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: AccessControlEntity)

    @Query("UPDATE access_control SET archived = 1 WHERE documentId = :documentId")
    suspend fun archive(documentId: String)

    @Query("UPDATE access_control SET deleted = 1 WHERE documentId = :documentId")
    suspend fun markDeleted(documentId: String)

    @Query("DELETE FROM access_control WHERE documentId = :documentId")
    suspend fun deleteByDocumentId(documentId: String): Int
}
