import { indexedDB as fakeIndexedDb } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { exportRawKey } from './encoding'
import { IndexedDbIdentityStorage } from './storage'
import type { RemoteIdentity, SignedPrekey, UserIdentity } from './types'

describe('IndexedDbIdentityStorage key lifecycle', () => {
  it('round-trips current, retired, staged signed prekeys and one-time publication state', async () => {
    const identityKeyPair = await ed25519()
    const current = await signedPrekey('current', 100)
    const retired = await signedPrekey('retired', 90)
    const pending = await signedPrekey('pending', 110)
    const published = await oneTimePrekey('published', 105, 106)
    const staged = await oneTimePrekey('staged', 111)
    const identity: UserIdentity = {
      userId: '10000000-0000-4000-8000-000000000123',
      phoneNumber: '+15550000123',
      displayName: 'Storage fixture',
      identityKeyPair,
      signedPrekeyPair: current,
      retiredSignedPrekeys: [retired],
      pendingSignedPrekey: pending,
      oneTimePrekeys: [published, staged],
      sessionToken: 'opaque-storage-token',
      createdAt: 80
    }
    const storage = new IndexedDbIdentityStorage({
      indexedDB: fakeIndexedDb,
      name: `identity-rotation-${crypto.randomUUID()}`
    })

    await storage.saveLocalIdentity(identity)
    const loaded = await storage.loadLocalIdentity()

    expect(await exportRawKey(loaded!.signedPrekeyPair.publicKey)).toBe(
      await exportRawKey(current.publicKey)
    )
    expect(await exportRawKey(loaded!.retiredSignedPrekeys[0]!.publicKey)).toBe(
      await exportRawKey(retired.publicKey)
    )
    expect(await exportRawKey(loaded!.pendingSignedPrekey!.publicKey)).toBe(
      await exportRawKey(pending.publicKey)
    )
    expect(loaded?.oneTimePrekeys.map((prekey) => prekey.publishedAt).sort()).toEqual([
      106,
      undefined
    ])
    await storage.close()
  })

  it('wraps storage-created X25519 keys and restores non-extractable runtime keys', async () => {
    const name = `identity-wrapped-x25519-${crypto.randomUUID()}`
    const storage = new IndexedDbIdentityStorage({ indexedDB: fakeIndexedDb, name })
    const signedPair = await storage.createX25519KeyPair()
    const oneTimePair = await storage.createX25519KeyPair()
    const identity: UserIdentity = {
      userId: '10000000-0000-4000-8000-000000000456',
      phoneNumber: '+15550000456',
      displayName: 'Wrapped fixture',
      identityKeyPair: await ed25519(),
      signedPrekeyPair: { ...signedPair, keyId: 'wrapped-signed', createdAt: 100 },
      retiredSignedPrekeys: [],
      oneTimePrekeys: [
        { ...oneTimePair, keyId: 'wrapped-one-time', createdAt: 101, publishedAt: 102 }
      ],
      sessionToken: 'wrapped-session-token',
      createdAt: 90
    }

    await storage.saveLocalIdentity(identity)
    await storage.close()

    const reopened = new IndexedDbIdentityStorage({ indexedDB: fakeIndexedDb, name })
    const loaded = await reopened.loadLocalIdentity()
    expect(await exportRawKey(loaded!.signedPrekeyPair.publicKey)).toBe(
      await exportRawKey(signedPair.publicKey)
    )
    expect(loaded!.signedPrekeyPair.privateKey.extractable).toBe(false)
    expect(await exportRawKey(loaded!.oneTimePrekeys[0]!.publicKey)).toBe(
      await exportRawKey(oneTimePair.publicKey)
    )
    expect(loaded!.oneTimePrekeys[0]!.privateKey.extractable).toBe(false)
    await reopened.close()

    const db = await openDatabase(name)
    expect(await requestAll(db, 'wrapped_keypairs_v3')).toHaveLength(2)
    expect(await requestAll(db, 'keypairs_v2')).toHaveLength(1)
    db.close()
  })

  it('serializes remote public keys instead of structured-cloning CryptoKeys', async () => {
    const name = `identity-remote-public-${crypto.randomUUID()}`
    const storage = new IndexedDbIdentityStorage({ indexedDB: fakeIndexedDb, name })
    const identityKey = await ed25519()
    const signed = await signedPrekey('remote-signed', 120)
    const oneTime = await signedPrekey('remote-one-time', 121)
    const remote: RemoteIdentity = {
      userId: '20000000-0000-4000-8000-000000000789',
      phoneNumber: '+15550000789',
      displayName: 'Remote fixture',
      identityKeyPublic: identityKey.publicKey,
      signedPrekeyPublic: signed.publicKey,
      oneTimePrekey: oneTime.publicKey,
      verified: true,
      fetchedAt: 122
    }

    await storage.saveRemoteIdentity(remote)
    await storage.close()

    const db = await openDatabase(name)
    const serialized = (await requestAll(db, 'remote_identities_v3')) as Array<{
      identityKeyRaw: Uint8Array
      signedPrekeyRaw: Uint8Array
      oneTimePrekeyRaw: Uint8Array
    }>
    expect(serialized).toHaveLength(1)
    expect(serialized[0]?.identityKeyRaw).toBeInstanceOf(Uint8Array)
    expect(serialized[0]?.signedPrekeyRaw).toBeInstanceOf(Uint8Array)
    expect(serialized[0]?.oneTimePrekeyRaw).toBeInstanceOf(Uint8Array)
    expect(await requestAll(db, 'remote_identities_v2')).toHaveLength(0)
    db.close()

    const reopened = new IndexedDbIdentityStorage({ indexedDB: fakeIndexedDb, name })
    const loaded = await reopened.loadRemoteIdentity(remote.userId)
    expect(loaded).toMatchObject({
      userId: remote.userId,
      phoneNumber: remote.phoneNumber,
      displayName: remote.displayName,
      verified: true,
      fetchedAt: 122
    })
    expect(await exportRawKey(loaded!.identityKeyPublic)).toBe(
      await exportRawKey(remote.identityKeyPublic)
    )
    expect(await exportRawKey(loaded!.signedPrekeyPublic)).toBe(
      await exportRawKey(remote.signedPrekeyPublic)
    )
    expect(await exportRawKey(loaded!.oneTimePrekey!)).toBe(
      await exportRawKey(remote.oneTimePrekey!)
    )
    await reopened.close()
  })

  it('upgrades an existing schema-v3 database with the serialized remote store', async () => {
    const name = `identity-v3-migration-${crypto.randomUUID()}`
    const db = await openSchemaV3Database(name)
    db.close()

    const storage = new IndexedDbIdentityStorage({ indexedDB: fakeIndexedDb, name })
    await storage.loadLocalIdentity()
    await storage.close()

    const upgraded = await openDatabase(name)
    expect(upgraded.version).toBe(4)
    expect(upgraded.objectStoreNames.contains('remote_identities_v3')).toBe(true)
    upgraded.close()
  })

  it('migrates v1 inline-key stores to out-of-line keys without losing private key material', async () => {
    const name = `identity-v1-migration-${crypto.randomUUID()}`
    const identityKeyPair = await ed25519()
    const signed = await signedPrekey('legacy-signed', 100)
    const legacy = await openLegacyDatabase(name)
    const tx = legacy.transaction(['identities', 'keypairs', 'sessions'], 'readwrite')
    tx.objectStore('identities').put({
      userId: '10000000-0000-4000-8000-000000000321',
      phoneNumber: '+15550000321',
      displayName: 'Legacy fixture',
      createdAt: 90
    })
    tx.objectStore('keypairs').put({
      keyId: 'identity',
      userId: '10000000-0000-4000-8000-000000000321',
      type: 'identity',
      publicKey: identityKeyPair.publicKey,
      privateKey: identityKeyPair.privateKey,
      createdAt: 90
    })
    tx.objectStore('keypairs').put({
      keyId: signed.keyId,
      userId: '10000000-0000-4000-8000-000000000321',
      type: 'signed_pre',
      publicKey: signed.publicKey,
      privateKey: signed.privateKey,
      createdAt: signed.createdAt
    })
    tx.objectStore('sessions').put({
      userId: '10000000-0000-4000-8000-000000000321',
      sessionToken: 'legacy-session-token'
    })
    await transactionComplete(tx)
    legacy.close()

    const storage = new IndexedDbIdentityStorage({ indexedDB: fakeIndexedDb, name })
    const loaded = await storage.loadLocalIdentity()
    expect(loaded).toMatchObject({
      userId: '10000000-0000-4000-8000-000000000321',
      phoneNumber: '+15550000321',
      displayName: 'Legacy fixture',
      sessionToken: 'legacy-session-token'
    })
    expect(await exportRawKey(loaded!.identityKeyPair.publicKey)).toBe(
      await exportRawKey(identityKeyPair.publicKey)
    )
    expect(await exportRawKey(loaded!.signedPrekeyPair.publicKey)).toBe(
      await exportRawKey(signed.publicKey)
    )
    await storage.close()

    const migrated = await openDatabase(name)
    expect(migrated.transaction('identities_v2').objectStore('identities_v2').keyPath).toBeNull()
    expect(migrated.transaction('keypairs_v2').objectStore('keypairs_v2').keyPath).toBeNull()
    expect(
      migrated.transaction('remote_identities_v2').objectStore('remote_identities_v2').keyPath
    ).toBeNull()
    expect(migrated.transaction('sessions_v2').objectStore('sessions_v2').keyPath).toBeNull()
    migrated.close()
  })
})

async function openLegacyDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDb.open(name, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('identities', { keyPath: 'userId' })
      db.createObjectStore('keypairs', { keyPath: 'keyId' })
      db.createObjectStore('remote_identities', { keyPath: 'userId' })
      db.createObjectStore('sessions', { keyPath: 'userId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function openSchemaV3Database(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDb.open(name, 3)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const store of [
        'identities_v2',
        'keypairs_v2',
        'remote_identities_v2',
        'sessions_v2',
        'wrapped_keypairs_v3',
        'wrapping_keys_v3'
      ])
        db.createObjectStore(store)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = fakeIndexedDb.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function requestAll(db: IDBDatabase, storeName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function transactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function ed25519(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
}

async function signedPrekey(keyId: string, createdAt: number): Promise<SignedPrekey> {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  return { ...pair, keyId, createdAt }
}

async function oneTimePrekey(keyId: string, createdAt: number, publishedAt?: number) {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  return { ...pair, keyId, createdAt, ...(publishedAt === undefined ? {} : { publishedAt }) }
}
