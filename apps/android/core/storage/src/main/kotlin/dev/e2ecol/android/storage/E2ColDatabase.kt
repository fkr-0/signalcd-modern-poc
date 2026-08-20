package dev.e2ecol.android.storage

import androidx.room.Database
import androidx.room.RoomDatabase
import dev.e2ecol.android.identity.IdentityDao
import dev.e2ecol.android.identity.IdentityEntity
import dev.e2ecol.android.identity.RemoteIdentityDao
import dev.e2ecol.android.identity.RemoteIdentityEntity

@Database(
    entities = [
        DocumentEntity::class,
        OutboundEntity::class,
        AccessControlEntity::class,
        IdentityEntity::class,
        RemoteIdentityEntity::class,
    ],
    version = 1,
    exportSchema = false,
)
abstract class E2ColDatabase : RoomDatabase() {
    abstract fun documentDao(): DocumentDao
    abstract fun outboundDao(): OutboundDao
    abstract fun accessControlDao(): AccessControlDao
    abstract fun identityDao(): IdentityDao
    abstract fun remoteIdentityDao(): RemoteIdentityDao
    abstract fun storageTransactionDao(): StorageTransactionDao
}
