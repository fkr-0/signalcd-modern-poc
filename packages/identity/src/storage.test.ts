import { indexedDB as fakeIndexedDb } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { exportRawKey } from './encoding'
import { IndexedDbIdentityStorage } from './storage'
import type { SignedPrekey, UserIdentity } from './types'

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
})

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
