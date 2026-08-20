package dev.e2ecol.android.storage

import androidx.room.ColumnInfo
import androidx.room.Entity

@Entity(
    tableName = "access_control",
    primaryKeys = ["documentId"],
)
data class AccessControlEntity(
    @ColumnInfo(name = "documentId")
    val documentId: String,
    @ColumnInfo(name = "selfRole")
    val selfRole: String,
    @ColumnInfo(name = "participants")
    val participants: String,
    @ColumnInfo(name = "archived")
    val archived: Boolean,
    @ColumnInfo(name = "deleted")
    val deleted: Boolean,
    @ColumnInfo(name = "revision")
    val revision: Long,
)
