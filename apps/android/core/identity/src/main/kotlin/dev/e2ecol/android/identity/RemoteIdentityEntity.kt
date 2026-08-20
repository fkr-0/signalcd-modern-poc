package dev.e2ecol.android.identity

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

@Entity(tableName = "remote_identity")
data class RemoteIdentityEntity(
    @PrimaryKey
    @ColumnInfo(name = "userId")
    val userId: String,
    @ColumnInfo(name = "phoneNumber")
    val phoneNumber: String,
    @ColumnInfo(name = "identityKeyPublic")
    val identityKeyPublic: ByteArray,
    @ColumnInfo(name = "verified")
    val verified: Boolean,
    @ColumnInfo(name = "fetchedAt")
    val fetchedAt: Long,
) {
    override fun equals(other: Any?): Boolean =
        other is RemoteIdentityEntity &&
            userId == other.userId &&
            phoneNumber == other.phoneNumber &&
            identityKeyPublic.contentEquals(other.identityKeyPublic) &&
            verified == other.verified &&
            fetchedAt == other.fetchedAt

    override fun hashCode(): Int =
        listOf(userId, phoneNumber, verified, fetchedAt).hashCode() * 31 +
            identityKeyPublic.contentHashCode()
}

@Dao
interface RemoteIdentityDao {
    @Query("SELECT * FROM remote_identity WHERE userId = :userId")
    suspend fun getByUserId(userId: String): RemoteIdentityEntity?

    @Query("SELECT * FROM remote_identity")
    suspend fun getAll(): List<RemoteIdentityEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: RemoteIdentityEntity)

    @Query("DELETE FROM remote_identity WHERE userId = :userId")
    suspend fun deleteByUserId(userId: String): Int
}
