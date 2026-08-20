package dev.e2ecol.android.identity

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

@Entity(tableName = "identity")
data class IdentityEntity(
    @PrimaryKey
    @ColumnInfo(name = "userId")
    val userId: String,
    @ColumnInfo(name = "phoneNumber")
    val phoneNumber: String,
    @ColumnInfo(name = "displayName")
    val displayName: String,
    @ColumnInfo(name = "identityKeyPublic")
    val identityKeyPublic: ByteArray,
    @ColumnInfo(name = "signedPrekeyPublic")
    val signedPrekeyPublic: ByteArray,
    @ColumnInfo(name = "sessionToken")
    val sessionToken: String,
    @ColumnInfo(name = "createdAt")
    val createdAt: Long,
) {
    override fun equals(other: Any?): Boolean =
        other is IdentityEntity &&
            userId == other.userId &&
            phoneNumber == other.phoneNumber &&
            displayName == other.displayName &&
            identityKeyPublic.contentEquals(other.identityKeyPublic) &&
            signedPrekeyPublic.contentEquals(other.signedPrekeyPublic) &&
            sessionToken == other.sessionToken &&
            createdAt == other.createdAt

    override fun hashCode(): Int =
        listOf(userId, phoneNumber, displayName, sessionToken, createdAt).hashCode() * 31 +
            identityKeyPublic.contentHashCode() * 17 +
            signedPrekeyPublic.contentHashCode()
}

@Dao
interface IdentityDao {
    @Query("SELECT * FROM identity WHERE userId = :userId")
    suspend fun getByUserId(userId: String): IdentityEntity?

    @Query("SELECT * FROM identity")
    suspend fun getAll(): List<IdentityEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(entity: IdentityEntity)

    @Query("DELETE FROM identity WHERE userId = :userId")
    suspend fun deleteByUserId(userId: String): Int
}
