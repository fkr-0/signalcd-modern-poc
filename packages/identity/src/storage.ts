import type {
  IdentityKeyPair,
  IdentityStorage,
  OneTimePrekey,
  RemoteIdentity,
  SignedPrekey,
  UserIdentity
} from './types'

const SCHEMA_VERSION = 4
const IDENTITIES = 'identities_v2'
const KEYPAIRS = 'keypairs_v2'
const REMOTE_IDENTITIES = 'remote_identities_v2'
const SESSIONS = 'sessions_v2'
const WRAPPED_KEYPAIRS = 'wrapped_keypairs_v3'
const WRAPPING_KEYS = 'wrapping_keys_v3'
const SERIALIZED_REMOTE_IDENTITIES = 'remote_identities_v3'
const WRAPPING_KEY_ID = 'x25519-aes-gcm-v1'
const LEGACY_IDENTITIES = 'identities'
const LEGACY_KEYPAIRS = 'keypairs'
const LEGACY_REMOTE_IDENTITIES = 'remote_identities'
const LEGACY_SESSIONS = 'sessions'

interface StoredIdentityMetadata {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly createdAt: number
}

interface StoredRemoteIdentity {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName?: string
  readonly identityKeyRaw: Uint8Array<ArrayBuffer>
  readonly signedPrekeyRaw: Uint8Array<ArrayBuffer>
  readonly oneTimePrekeyRaw?: Uint8Array<ArrayBuffer>
  readonly verified: boolean
  readonly fetchedAt: number
}

async function serializeRemoteIdentity(identity: RemoteIdentity): Promise<StoredRemoteIdentity> {
  return {
    userId: identity.userId,
    phoneNumber: identity.phoneNumber,
    ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
    identityKeyRaw: new Uint8Array(
      await crypto.subtle.exportKey('raw', identity.identityKeyPublic)
    ),
    signedPrekeyRaw: new Uint8Array(
      await crypto.subtle.exportKey('raw', identity.signedPrekeyPublic)
    ),
    ...(identity.oneTimePrekey === undefined
      ? {}
      : {
          oneTimePrekeyRaw: new Uint8Array(
            await crypto.subtle.exportKey('raw', identity.oneTimePrekey)
          )
        }),
    verified: identity.verified,
    fetchedAt: identity.fetchedAt
  }
}

async function deserializeRemoteIdentity(identity: StoredRemoteIdentity): Promise<RemoteIdentity> {
  return {
    userId: identity.userId,
    phoneNumber: identity.phoneNumber,
    ...(identity.displayName === undefined ? {} : { displayName: identity.displayName }),
    identityKeyPublic: await crypto.subtle.importKey(
      'raw',
      identity.identityKeyRaw,
      { name: 'Ed25519' },
      true,
      ['verify']
    ),
    signedPrekeyPublic: await crypto.subtle.importKey(
      'raw',
      identity.signedPrekeyRaw,
      { name: 'X25519' },
      true,
      []
    ),
    ...(identity.oneTimePrekeyRaw === undefined
      ? {}
      : {
          oneTimePrekey: await crypto.subtle.importKey(
            'raw',
            identity.oneTimePrekeyRaw,
            { name: 'X25519' },
            true,
            []
          )
        }),
    verified: identity.verified,
    fetchedAt: identity.fetchedAt
  }
}

function asKeyPair(value: CryptoKeyPair): CryptoKeyPair {
  if (!value.publicKey || !value.privateKey) throw new Error('WebCrypto did not return a keypair')
  return value
}

type StoredX25519Type = Exclude<StoredKeyPair['type'], 'identity'>

interface WrappedX25519Material {
  readonly publicKeyRaw: Uint8Array<ArrayBuffer>
  readonly privateKeyCiphertext: Uint8Array<ArrayBuffer>
  readonly iv: Uint8Array<ArrayBuffer>
}

interface StoredWrappedKeyPair extends WrappedX25519Material {
  readonly keyId: string
  readonly userId: string
  readonly type: StoredX25519Type
  readonly createdAt: number
  readonly published?: boolean
  readonly publishedAt?: number
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
  private readonly wrappedX25519 = new WeakMap<CryptoKey, WrappedX25519Material>()
  private wrappingKeyPromise: Promise<CryptoKey> | undefined

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

    const rawKeypairs = await readAll<StoredKeyPair | null>(db, KEYPAIRS)
    const keypairs = rawKeypairs.filter(
      (record): record is StoredKeyPair => record !== null && record.userId === local.userId
    )
    const identity = keypairs.find((record) => record.type === 'identity')
    const wrapped = (await readAll<StoredWrappedKeyPair>(db, WRAPPED_KEYPAIRS)).filter(
      (record) => record.userId === local.userId
    )
    const x25519 =
      wrapped.length > 0
        ? await Promise.all(wrapped.map((record) => this.unwrapStoredX25519(record)))
        : keypairs.filter((record) => record.type !== 'identity')
    const signedPrekey = x25519.find((record) => record.type === 'signed_pre')
    const retiredSignedPrekeys = x25519.filter(
      (record): record is StoredKeyPair & { type: 'retired_signed_pre' } =>
        record.type === 'retired_signed_pre'
    )
    const pendingSignedPrekey = x25519.find((record) => record.type === 'pending_signed_pre')
    const oneTimePrekeys = x25519.filter(
      (record): record is StoredKeyPair & { type: 'one_time_pre' } => record.type === 'one_time_pre'
    )
    const session = await request<StoredSession | undefined>(
      db.transaction(SESSIONS).objectStore(SESSIONS).get(local.userId)
    )
    if (!identity || !signedPrekey || !session) {
      if (rawKeypairs.some((record) => record === null))
        throw new Error(
          'identity storage contains unreadable legacy X25519 keys; recreate the local identity in this WebKit profile'
        )
      throw new Error('identity storage is incomplete or corrupt')
    }

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
    const wrapped = this.wrappedRecords(identity)
    if (wrapped) {
      const tx = db.transaction([IDENTITIES, KEYPAIRS, WRAPPED_KEYPAIRS, SESSIONS], 'readwrite')
      tx.objectStore(IDENTITIES).clear()
      tx.objectStore(KEYPAIRS).clear()
      tx.objectStore(WRAPPED_KEYPAIRS).clear()
      tx.objectStore(SESSIONS).clear()
      tx.objectStore(IDENTITIES).put(
        {
          userId: identity.userId,
          phoneNumber: identity.phoneNumber,
          displayName: identity.displayName,
          createdAt: identity.createdAt
        } satisfies StoredIdentityMetadata,
        identity.userId
      )
      tx.objectStore(KEYPAIRS).put(
        {
          keyId: 'identity',
          userId: identity.userId,
          type: 'identity',
          publicKey: identity.identityKeyPair.publicKey,
          privateKey: identity.identityKeyPair.privateKey,
          createdAt: identity.createdAt
        } satisfies StoredKeyPair,
        'identity'
      )
      for (const record of wrapped) tx.objectStore(WRAPPED_KEYPAIRS).put(record, record.keyId)
      tx.objectStore(SESSIONS).put(
        {
          userId: identity.userId,
          sessionToken: identity.sessionToken
        } satisfies StoredSession,
        identity.userId
      )
      await complete(tx)
      return
    }

    const tx = db.transaction([IDENTITIES, KEYPAIRS, SESSIONS], 'readwrite')
    tx.objectStore(IDENTITIES).clear()
    tx.objectStore(KEYPAIRS).clear()
    tx.objectStore(SESSIONS).clear()
    tx.objectStore(IDENTITIES).put(
      {
        userId: identity.userId,
        phoneNumber: identity.phoneNumber,
        displayName: identity.displayName,
        createdAt: identity.createdAt
      } satisfies StoredIdentityMetadata,
      identity.userId
    )
    tx.objectStore(KEYPAIRS).put(
      {
        keyId: 'identity',
        userId: identity.userId,
        type: 'identity',
        publicKey: identity.identityKeyPair.publicKey,
        privateKey: identity.identityKeyPair.privateKey,
        createdAt: identity.createdAt
      } satisfies StoredKeyPair,
      'identity'
    )
    tx.objectStore(KEYPAIRS).put(
      {
        keyId: identity.signedPrekeyPair.keyId,
        userId: identity.userId,
        type: 'signed_pre',
        publicKey: identity.signedPrekeyPair.publicKey,
        privateKey: identity.signedPrekeyPair.privateKey,
        createdAt: identity.signedPrekeyPair.createdAt
      } satisfies StoredKeyPair,
      identity.signedPrekeyPair.keyId
    )
    for (const prekey of identity.retiredSignedPrekeys) {
      tx.objectStore(KEYPAIRS).put(
        {
          keyId: prekey.keyId,
          userId: identity.userId,
          type: 'retired_signed_pre',
          publicKey: prekey.publicKey,
          privateKey: prekey.privateKey,
          createdAt: prekey.createdAt
        } satisfies StoredKeyPair,
        prekey.keyId
      )
    }
    if (identity.pendingSignedPrekey) {
      tx.objectStore(KEYPAIRS).put(
        {
          keyId: identity.pendingSignedPrekey.keyId,
          userId: identity.userId,
          type: 'pending_signed_pre',
          publicKey: identity.pendingSignedPrekey.publicKey,
          privateKey: identity.pendingSignedPrekey.privateKey,
          createdAt: identity.pendingSignedPrekey.createdAt
        } satisfies StoredKeyPair,
        identity.pendingSignedPrekey.keyId
      )
    }
    for (const prekey of identity.oneTimePrekeys) {
      tx.objectStore(KEYPAIRS).put(
        {
          keyId: prekey.keyId,
          userId: identity.userId,
          type: 'one_time_pre',
          publicKey: prekey.publicKey,
          privateKey: prekey.privateKey,
          createdAt: prekey.createdAt,
          published: prekey.publishedAt !== undefined,
          ...(prekey.publishedAt === undefined ? {} : { publishedAt: prekey.publishedAt })
        } satisfies StoredKeyPair,
        prekey.keyId
      )
    }
    tx.objectStore(SESSIONS).put(
      {
        userId: identity.userId,
        sessionToken: identity.sessionToken
      } satisfies StoredSession,
      identity.userId
    )
    await complete(tx)
  }

  async deleteLocalIdentity(): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction(
      [IDENTITIES, KEYPAIRS, WRAPPED_KEYPAIRS, WRAPPING_KEYS, SESSIONS],
      'readwrite'
    )
    tx.objectStore(IDENTITIES).clear()
    tx.objectStore(KEYPAIRS).clear()
    tx.objectStore(WRAPPED_KEYPAIRS).clear()
    tx.objectStore(WRAPPING_KEYS).clear()
    tx.objectStore(SESSIONS).clear()
    await complete(tx)
    this.wrappingKeyPromise = undefined
  }

  async loadRemoteIdentity(userId: string): Promise<RemoteIdentity | undefined> {
    const db = await this.dbPromise
    const serialized = await request<StoredRemoteIdentity | undefined>(
      db
        .transaction(SERIALIZED_REMOTE_IDENTITIES)
        .objectStore(SERIALIZED_REMOTE_IDENTITIES)
        .get(userId)
    )
    if (serialized) return deserializeRemoteIdentity(serialized)
    const legacy = await request<RemoteIdentity | null | undefined>(
      db.transaction(REMOTE_IDENTITIES).objectStore(REMOTE_IDENTITIES).get(userId)
    )
    return legacy ?? undefined
  }

  async saveRemoteIdentity(identity: RemoteIdentity): Promise<void> {
    const db = await this.dbPromise
    // Export public material before creating the IndexedDB transaction. WebCrypto
    // promises may cross a task boundary, which can make an otherwise idle IDB
    // transaction inactive in WebKit before the put() call runs.
    const serialized = await serializeRemoteIdentity(identity)
    const tx = db.transaction([REMOTE_IDENTITIES, SERIALIZED_REMOTE_IDENTITIES], 'readwrite')
    tx.objectStore(REMOTE_IDENTITIES).delete(identity.userId)
    tx.objectStore(SERIALIZED_REMOTE_IDENTITIES).put(serialized, identity.userId)
    await complete(tx)
  }

  async createX25519KeyPair(): Promise<IdentityKeyPair> {
    const wrappingKey = await this.wrappingKey()
    const generated = asKeyPair(
      await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    )
    const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', generated.publicKey))
    const privatePkcs8 = new Uint8Array(
      await crypto.subtle.exportKey('pkcs8', generated.privateKey)
    )
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const privateKeyCiphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, privatePkcs8)
    )
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyRaw,
      { name: 'X25519' },
      true,
      []
    )
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privatePkcs8,
      { name: 'X25519' },
      false,
      ['deriveBits']
    )
    privatePkcs8.fill(0)
    this.wrappedX25519.set(privateKey, { publicKeyRaw, privateKeyCiphertext, iv })
    return { publicKey, privateKey }
  }

  async close(): Promise<void> {
    ;(await this.dbPromise).close()
  }

  private wrappedRecords(identity: UserIdentity): StoredWrappedKeyPair[] | undefined {
    const records: StoredWrappedKeyPair[] = []
    const push = (key: SignedPrekey | OneTimePrekey, type: StoredX25519Type): boolean => {
      const material = this.wrappedX25519.get(key.privateKey)
      if (!material) return false
      records.push({
        keyId: key.keyId,
        userId: identity.userId,
        type,
        createdAt: key.createdAt,
        ...material,
        ...(type === 'one_time_pre'
          ? {
              published: 'publishedAt' in key && key.publishedAt !== undefined,
              ...('publishedAt' in key && key.publishedAt !== undefined
                ? { publishedAt: key.publishedAt }
                : {})
            }
          : {})
      })
      return true
    }
    if (!push(identity.signedPrekeyPair, 'signed_pre')) return undefined
    for (const key of identity.retiredSignedPrekeys)
      if (!push(key, 'retired_signed_pre')) return undefined
    if (identity.pendingSignedPrekey && !push(identity.pendingSignedPrekey, 'pending_signed_pre'))
      return undefined
    for (const key of identity.oneTimePrekeys) if (!push(key, 'one_time_pre')) return undefined
    return records
  }

  private async unwrapStoredX25519(record: StoredWrappedKeyPair): Promise<StoredKeyPair> {
    const wrappingKey = await this.wrappingKey()
    const privatePkcs8 = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv },
        wrappingKey,
        record.privateKeyCiphertext
      )
    )
    const publicKey = await crypto.subtle.importKey(
      'raw',
      record.publicKeyRaw,
      { name: 'X25519' },
      true,
      []
    )
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privatePkcs8,
      { name: 'X25519' },
      false,
      ['deriveBits']
    )
    privatePkcs8.fill(0)
    this.wrappedX25519.set(privateKey, {
      publicKeyRaw: record.publicKeyRaw,
      privateKeyCiphertext: record.privateKeyCiphertext,
      iv: record.iv
    })
    return {
      keyId: record.keyId,
      userId: record.userId,
      type: record.type,
      publicKey,
      privateKey,
      createdAt: record.createdAt,
      ...(record.published === undefined ? {} : { published: record.published }),
      ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt })
    }
  }

  private wrappingKey(): Promise<CryptoKey> {
    this.wrappingKeyPromise ??= this.loadOrCreateWrappingKey()
    return this.wrappingKeyPromise
  }

  private async loadOrCreateWrappingKey(): Promise<CryptoKey> {
    const db = await this.dbPromise
    const existing = await request<CryptoKey | undefined>(
      db.transaction(WRAPPING_KEYS).objectStore(WRAPPING_KEYS).get(WRAPPING_KEY_ID)
    )
    if (existing) return existing
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt'
    ])
    const tx = db.transaction(WRAPPING_KEYS, 'readwrite')
    tx.objectStore(WRAPPING_KEYS).put(key, WRAPPING_KEY_ID)
    await complete(tx)
    return key
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
      const tx = value.transaction
      if (!tx) throw new Error('identity IndexedDB upgrade transaction is unavailable')
      migrateToOutOfLineStore(db, tx, LEGACY_IDENTITIES, IDENTITIES)
      migrateToOutOfLineStore(db, tx, LEGACY_KEYPAIRS, KEYPAIRS)
      migrateToOutOfLineStore(db, tx, LEGACY_REMOTE_IDENTITIES, REMOTE_IDENTITIES)
      migrateToOutOfLineStore(db, tx, LEGACY_SESSIONS, SESSIONS)
      if (!db.objectStoreNames.contains(WRAPPED_KEYPAIRS)) db.createObjectStore(WRAPPED_KEYPAIRS)
      if (!db.objectStoreNames.contains(WRAPPING_KEYS)) db.createObjectStore(WRAPPING_KEYS)
      if (!db.objectStoreNames.contains(SERIALIZED_REMOTE_IDENTITIES))
        db.createObjectStore(SERIALIZED_REMOTE_IDENTITIES)
    }
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error('identity IndexedDB open failed'))
  })
}

function migrateToOutOfLineStore(
  db: IDBDatabase,
  tx: IDBTransaction,
  legacyName: string,
  nextName: string
): void {
  if (db.objectStoreNames.contains(nextName)) return
  const next = db.createObjectStore(nextName)
  if (!db.objectStoreNames.contains(legacyName)) return

  const cursorRequest = tx.objectStore(legacyName).openCursor()
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result
    if (!cursor) return
    next.put(cursor.value, cursor.primaryKey)
    cursor.continue()
  }
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
