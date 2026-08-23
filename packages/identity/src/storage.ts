import type {
  IdentityStorage,
  OneTimePrekey,
  RemoteIdentity,
  SignedPrekey,
  UserIdentity
} from './types'

const SCHEMA_VERSION = 1
const IDENTITIES = 'identities'
const KEYPAIRS = 'keypairs'
const REMOTE_IDENTITIES = 'remote_identities'
const SESSIONS = 'sessions'

interface StoredIdentityMetadata {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly createdAt: number
}

interface StoredKeyPair {
  readonly keyId: string
  readonly userId: string
  readonly type:
    | 'identity'
    | 'signed_pre'
    | 'retired_signed_pre'
    | 'pending_signed_pre'
    | 'one_time_pre'
  readonly publicKey: CryptoKey
  readonly privateKey: CryptoKey
  readonly createdAt: number
  readonly published?: boolean
  readonly publishedAt?: number
}

interface StoredSession {
  readonly userId: string
  readonly sessionToken: string
}

export interface IndexedDbIdentityStorageOptions {
  readonly name?: string
  readonly indexedDB?: IDBFactory
}

export class MemoryIdentityStorage implements IdentityStorage {
  private localIdentity: UserIdentity | undefined
  private readonly remoteIdentities = new Map<string, RemoteIdentity>()

  async loadLocalIdentity(): Promise<UserIdentity | undefined> {
    return this.localIdentity
  }

  async saveLocalIdentity(identity: UserIdentity): Promise<void> {
    this.localIdentity = identity
  }

  async deleteLocalIdentity(): Promise<void> {
    this.localIdentity = undefined
  }

  async loadRemoteIdentity(userId: string): Promise<RemoteIdentity | undefined> {
    return this.remoteIdentities.get(userId)
  }

  async saveRemoteIdentity(identity: RemoteIdentity): Promise<void> {
    this.remoteIdentities.set(identity.userId, identity)
  }

  async close(): Promise<void> {}
}

export class IndexedDbIdentityStorage implements IdentityStorage {
  private readonly dbPromise: Promise<IDBDatabase>

  constructor(options: IndexedDbIdentityStorageOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB
    if (!factory) throw new Error('IndexedDB is unavailable')
    this.dbPromise = openDatabase(factory, options.name ?? 'e2e-col-identity')
  }

  async loadLocalIdentity(): Promise<UserIdentity | undefined> {
    const db = await this.dbPromise
    const metadata = await readAll<StoredIdentityMetadata>(db, IDENTITIES)
    if (metadata.length === 0) return undefined
    if (metadata.length !== 1)
      throw new Error('identity storage contains multiple local identities')
    const local = metadata[0]
    if (!local) return undefined

    const keypairs = (await readAll<StoredKeyPair>(db, KEYPAIRS)).filter(
      (record) => record.userId === local.userId
    )
    const identity = keypairs.find((record) => record.type === 'identity')
    const signedPrekey = keypairs.find((record) => record.type === 'signed_pre')
    const retiredSignedPrekeys = keypairs.filter(
      (record): record is StoredKeyPair & { type: 'retired_signed_pre' } =>
        record.type === 'retired_signed_pre'
    )
    const pendingSignedPrekey = keypairs.find((record) => record.type === 'pending_signed_pre')
    const oneTimePrekeys = keypairs.filter(
      (record): record is StoredKeyPair & { type: 'one_time_pre' } => record.type === 'one_time_pre'
    )
    const session = await request<StoredSession | undefined>(
      db.transaction(SESSIONS).objectStore(SESSIONS).get(local.userId)
    )
    if (!identity || !signedPrekey || !session)
      throw new Error('identity storage is incomplete or corrupt')

    return {
      userId: local.userId,
      phoneNumber: local.phoneNumber,
      displayName: local.displayName,
      identityKeyPair: { publicKey: identity.publicKey, privateKey: identity.privateKey },
      signedPrekeyPair: toSignedPrekey(signedPrekey),
      retiredSignedPrekeys: retiredSignedPrekeys.map(toSignedPrekey),
      ...(pendingSignedPrekey === undefined
        ? {}
        : { pendingSignedPrekey: toSignedPrekey(pendingSignedPrekey) }),
      oneTimePrekeys: oneTimePrekeys.map(toOneTimePrekey),
      sessionToken: session.sessionToken,
      createdAt: local.createdAt
    }
  }

  async saveLocalIdentity(identity: UserIdentity): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction([IDENTITIES, KEYPAIRS, SESSIONS], 'readwrite')
    tx.objectStore(IDENTITIES).clear()
    tx.objectStore(KEYPAIRS).clear()
    tx.objectStore(SESSIONS).clear()
    tx.objectStore(IDENTITIES).put({
      userId: identity.userId,
      phoneNumber: identity.phoneNumber,
      displayName: identity.displayName,
      createdAt: identity.createdAt
    } satisfies StoredIdentityMetadata)
    tx.objectStore(KEYPAIRS).put({
      keyId: 'identity',
      userId: identity.userId,
      type: 'identity',
      publicKey: identity.identityKeyPair.publicKey,
      privateKey: identity.identityKeyPair.privateKey,
      createdAt: identity.createdAt
    } satisfies StoredKeyPair)
    tx.objectStore(KEYPAIRS).put({
      keyId: identity.signedPrekeyPair.keyId,
      userId: identity.userId,
      type: 'signed_pre',
      publicKey: identity.signedPrekeyPair.publicKey,
      privateKey: identity.signedPrekeyPair.privateKey,
      createdAt: identity.signedPrekeyPair.createdAt
    } satisfies StoredKeyPair)
    for (const prekey of identity.retiredSignedPrekeys) {
      tx.objectStore(KEYPAIRS).put({
        keyId: prekey.keyId,
        userId: identity.userId,
        type: 'retired_signed_pre',
        publicKey: prekey.publicKey,
        privateKey: prekey.privateKey,
        createdAt: prekey.createdAt
      } satisfies StoredKeyPair)
    }
    if (identity.pendingSignedPrekey) {
      tx.objectStore(KEYPAIRS).put({
        keyId: identity.pendingSignedPrekey.keyId,
        userId: identity.userId,
        type: 'pending_signed_pre',
        publicKey: identity.pendingSignedPrekey.publicKey,
        privateKey: identity.pendingSignedPrekey.privateKey,
        createdAt: identity.pendingSignedPrekey.createdAt
      } satisfies StoredKeyPair)
    }
    for (const prekey of identity.oneTimePrekeys) {
      tx.objectStore(KEYPAIRS).put({
        keyId: prekey.keyId,
        userId: identity.userId,
        type: 'one_time_pre',
        publicKey: prekey.publicKey,
        privateKey: prekey.privateKey,
        createdAt: prekey.createdAt,
        published: prekey.publishedAt !== undefined,
        ...(prekey.publishedAt === undefined ? {} : { publishedAt: prekey.publishedAt })
      } satisfies StoredKeyPair)
    }
    tx.objectStore(SESSIONS).put({
      userId: identity.userId,
      sessionToken: identity.sessionToken
    } satisfies StoredSession)
    await complete(tx)
  }

  async deleteLocalIdentity(): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction([IDENTITIES, KEYPAIRS, SESSIONS], 'readwrite')
    tx.objectStore(IDENTITIES).clear()
    tx.objectStore(KEYPAIRS).clear()
    tx.objectStore(SESSIONS).clear()
    await complete(tx)
  }

  async loadRemoteIdentity(userId: string): Promise<RemoteIdentity | undefined> {
    return request<RemoteIdentity | undefined>(
      (await this.dbPromise)
        .transaction(REMOTE_IDENTITIES)
        .objectStore(REMOTE_IDENTITIES)
        .get(userId)
    )
  }

  async saveRemoteIdentity(identity: RemoteIdentity): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction(REMOTE_IDENTITIES, 'readwrite')
    tx.objectStore(REMOTE_IDENTITIES).put(identity)
    await complete(tx)
  }

  async close(): Promise<void> {
    ;(await this.dbPromise).close()
  }
}

function toOneTimePrekey(record: StoredKeyPair): OneTimePrekey {
  // Pre-rotation schema records had no publication marker; every such record
  // was created by successful registration and was therefore already public.
  const publishedAt =
    record.published === false ? undefined : (record.publishedAt ?? record.createdAt)
  return {
    keyId: record.keyId,
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    createdAt: record.createdAt,
    ...(publishedAt === undefined ? {} : { publishedAt })
  }
}

function toSignedPrekey(record: StoredKeyPair): SignedPrekey {
  return {
    keyId: record.keyId,
    publicKey: record.publicKey,
    privateKey: record.privateKey,
    createdAt: record.createdAt
  }
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const value = factory.open(name, SCHEMA_VERSION)
    value.onupgradeneeded = () => {
      const db = value.result
      if (!db.objectStoreNames.contains(IDENTITIES))
        db.createObjectStore(IDENTITIES, { keyPath: 'userId' })
      if (!db.objectStoreNames.contains(KEYPAIRS))
        db.createObjectStore(KEYPAIRS, { keyPath: 'keyId' })
      if (!db.objectStoreNames.contains(REMOTE_IDENTITIES))
        db.createObjectStore(REMOTE_IDENTITIES, { keyPath: 'userId' })
      if (!db.objectStoreNames.contains(SESSIONS))
        db.createObjectStore(SESSIONS, { keyPath: 'userId' })
    }
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error('identity IndexedDB open failed'))
  })
}

function readAll<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return request<T[]>(db.transaction(storeName).objectStore(storeName).getAll())
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error('identity IndexedDB request failed'))
  })
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('identity IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('identity IndexedDB transaction aborted'))
  })
}
