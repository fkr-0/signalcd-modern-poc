package dev.e2ecol.android.storage

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

enum class OutboundState { PENDING, SENT, FAILED }

@Entity(tableName = "outbound")
data class OutboundEntity(
    @PrimaryKey(autoGenerate = true)
    @ColumnInfo(name = "id")
    val id: Long = 0,
    @ColumnInfo(name = "documentId")
    val documentId: String,
    @ColumnInfo(name = "payload", typeAffinity = ColumnInfo.BLOB)
    val payload: ByteArray,
    @ColumnInfo(name = "createdAt")
    val createdAt: Long,
    @ColumnInfo(name = "state")
    val state: OutboundState,
    @ColumnInfo(name = "attempts")
    val attempts: Int,
    @ColumnInfo(name = "kind")
    val kind: String,
) {
    override fun equals(other: Any?): Boolean =
        other is OutboundEntity &&
            id == other.id &&
            documentId == other.documentId &&
            payload.contentEquals(other.payload) &&
            createdAt == other.createdAt &&
            state == other.state &&
            attempts == other.attempts &&
            kind == other.kind

    override fun hashCode(): Int =
        listOf(id, documentId, createdAt, state, attempts, kind).hashCode() * 31 +
            payload.contentHashCode()
}
