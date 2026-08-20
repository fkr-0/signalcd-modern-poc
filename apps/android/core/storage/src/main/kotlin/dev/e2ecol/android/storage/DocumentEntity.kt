package dev.e2ecol.android.storage

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "document")
data class DocumentEntity(
    @PrimaryKey
    @ColumnInfo(name = "documentId")
    val documentId: String,
    @ColumnInfo(name = "snapshot", typeAffinity = ColumnInfo.BLOB)
    val snapshot: ByteArray,
    @ColumnInfo(name = "updatedAt")
    val updatedAt: Long,
    @ColumnInfo(name = "title")
    val title: String,
    @ColumnInfo(name = "archived")
    val archived: Boolean,
) {
    override fun equals(other: Any?): Boolean =
        other is DocumentEntity &&
            documentId == other.documentId &&
            snapshot.contentEquals(other.snapshot) &&
            updatedAt == other.updatedAt &&
            title == other.title &&
            archived == other.archived

    override fun hashCode(): Int =
        listOf(documentId, updatedAt, title, archived).hashCode() * 31 +
            snapshot.contentHashCode()
}
