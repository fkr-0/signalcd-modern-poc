import { describe, expect, it } from 'vitest'
import { createSafetyNumber, formatSafetyNumber, IdentityClient } from './client'
import { exportRawKey } from './encoding'
import { MemoryIdentityStorage } from './storage'
import type {
  IdentityProvider,
  IdentitySessionClaim,
  RegisteredIdentityClaim,
  RegistrationPublicMaterial,
  RemoteIdentityBundle,
  SignedPrekeyPublicMaterial,
  SignedPrekeyRotationClaim,
  UserIdentity
} from './types'

class FaultingIdentityStorage extends MemoryIdentityStorage {
  saveCalls = 0
  failOnSaveCall: number | undefined

  override async saveLocalIdentity(identity: UserIdentity): Promise<void> {
    this.saveCalls += 1
    if (this.saveCalls === this.failOnSaveCall)
      throw new Error('simulated identity storage failure')
    await super.saveLocalIdentity(identity)
  }
}

class RecordingProvider implements IdentityProvider {
  lastRegistration: RegistrationPublicMaterial | undefined
  lastRotation: SignedPrekeyPublicMaterial | undefined
  lastReplenishment: readonly string[] = []
  rotationRequired = false
  prekeyCount = 10
  rotationCalls = 0
  failNextRotation = false
  private readonly replenishedPrekeys = new Set<string>()
  private signedPrekeyPublic: string | undefined
  private signedPrekeySignature: string | undefined

  async register(material: RegistrationPublicMaterial): Promise<RegisteredIdentityClaim> {
    this.lastRegistration = material
    this.signedPrekeyPublic = material.signedPrekeyPublic
    this.signedPrekeySignature = material.signedPrekeySignature
    return {
      userId: '10000000-0000-4000-8000-000000000099',
      phoneNumber: '+15550000099',
      displayName: material.displayName,
      identityKeyPublic: material.identityKeyPublic,
      signedPrekeyPublic: material.signedPrekeyPublic,
      signedPrekeySignature: material.signedPrekeySignature,
      oneTimePrekeys: material.oneTimePrekeys,
      sessionToken: 'opaque-test-token',
      createdAt: 1234
    }
  }

  async verifySession(): Promise<IdentitySessionClaim> {
    if (!this.signedPrekeyPublic) throw new Error('identity not registered')
    return {
      userId: '10000000-0000-4000-8000-000000000099',
      phoneNumber: '+15550000099',
      displayName: 'Ada',
      signedPrekeyPublic: this.signedPrekeyPublic,
      signedPrekeyRotationRequired: this.rotationRequired,
      prekeyCount: this.prekeyCount,
      createdAt: 1234
    }
  }

  async lookupKeys(): Promise<RemoteIdentityBundle> {
    throw new Error('not used')
  }

  async replenishPrekeys(
    _sessionToken: string,
    oneTimePrekeys: readonly string[]
  ): Promise<number> {
    this.lastReplenishment = oneTimePrekeys
    for (const prekey of oneTimePrekeys) {
      if (this.replenishedPrekeys.has(prekey)) continue
      this.replenishedPrekeys.add(prekey)
      this.prekeyCount += 1
    }
    return this.prekeyCount
  }

  async rotateSignedPrekey(
    _sessionToken: string,
    material: SignedPrekeyPublicMaterial
  ): Promise<SignedPrekeyRotationClaim> {
    this.rotationCalls += 1
    if (this.failNextRotation) {
      this.failNextRotation = false
      throw new Error('simulated signed-prekey publication failure')
    }
    this.lastRotation = material
    this.signedPrekeyPublic = material.signedPrekeyPublic
    this.signedPrekeySignature = material.signedPrekeySignature
    this.rotationRequired = false
    return { ...material, rotatedAt: 2345 }
  }
}

describe('IdentityClient', () => {
  it('creates browser-owned non-exportable private keys and persists one identity', async () => {
    const provider = new RecordingProvider()
    const storage = new MemoryIdentityStorage()
    const client = new IdentityClient({ provider, storage })

    const identity = await client.register('Ada')

    expect(identity.identityKeyPair.privateKey.extractable).toBe(false)
    expect(identity.signedPrekeyPair.privateKey.extractable).toBe(false)
    expect(identity.oneTimePrekeys).toHaveLength(10)
    expect(identity.oneTimePrekeys.every((prekey) => prekey.publishedAt !== undefined)).toBe(true)
    expect(identity.oneTimePrekeys.every((prekey) => !prekey.privateKey.extractable)).toBe(true)
    expect(provider.lastRegistration?.oneTimePrekeys).toHaveLength(10)
    expect(await exportRawKey(identity.identityKeyPair.publicKey)).toBe(
      provider.lastRegistration?.identityKeyPublic
    )
    expect((await client.openSession())?.userId).toBe(identity.userId)
  })

  it('replenishes a low one-time prekey pool without replacing the identity key', async () => {
    const provider = new RecordingProvider()
    const storage = new MemoryIdentityStorage()
    const client = new IdentityClient({ provider, storage, now: () => 2_000 })
    const identity = await client.register('Ada')
    const identityKey = await exportRawKey(identity.identityKeyPair.publicKey)
    provider.prekeyCount = 2

    const reopened = await client.openSession()

    expect(provider.lastReplenishment).toHaveLength(8)
    expect(provider.prekeyCount).toBe(10)
    expect(reopened?.oneTimePrekeys).toHaveLength(18)
    expect(reopened?.oneTimePrekeys.slice(-8).every((prekey) => prekey.publishedAt === 2_000)).toBe(
      true
    )
    expect(await exportRawKey(reopened!.identityKeyPair.publicKey)).toBe(identityKey)
  })

  it('recovers provider-accepted one-time prekeys after final local persistence fails', async () => {
    const provider = new RecordingProvider()
    const storage = new FaultingIdentityStorage()
    const client = new IdentityClient({ provider, storage, now: () => 2_500 })
    await client.register('Ada')
    provider.prekeyCount = 2
    storage.failOnSaveCall = 3

    await expect(client.openSession()).rejects.toThrow('simulated identity storage failure')
    const staged = await storage.loadLocalIdentity()
    expect(provider.prekeyCount).toBe(10)
    expect(
      staged?.oneTimePrekeys.filter((prekey) => prekey.publishedAt === undefined)
    ).toHaveLength(8)

    storage.failOnSaveCall = undefined
    const recovered = await client.openSession()

    expect(provider.prekeyCount).toBe(10)
    expect(recovered?.oneTimePrekeys).toHaveLength(18)
    expect(recovered?.oneTimePrekeys.every((prekey) => prekey.publishedAt !== undefined)).toBe(true)
  })

  it('rotates a provider-requested signed prekey under the unchanged identity key', async () => {
    const provider = new RecordingProvider()
    const storage = new MemoryIdentityStorage()
    const client = new IdentityClient({ provider, storage, now: () => 3_000 })
    const identity = await client.register('Ada')
    const identityKey = await exportRawKey(identity.identityKeyPair.publicKey)
    const originalSignedPrekey = await exportRawKey(identity.signedPrekeyPair.publicKey)
    provider.rotationRequired = true

    const reopened = await client.openSession()

    expect(provider.lastRotation).toBeDefined()
    expect(await exportRawKey(reopened!.identityKeyPair.publicKey)).toBe(identityKey)
    expect(await exportRawKey(reopened!.signedPrekeyPair.publicKey)).not.toBe(originalSignedPrekey)
    expect(reopened?.retiredSignedPrekeys).toHaveLength(1)
    expect(await exportRawKey(reopened!.retiredSignedPrekeys[0]!.publicKey)).toBe(
      originalSignedPrekey
    )
    expect(reopened?.pendingSignedPrekey).toBeUndefined()
    await expect(
      crypto.subtle.verify(
        { name: 'Ed25519' },
        reopened!.identityKeyPair.publicKey,
        base64Buffer(provider.lastRotation!.signedPrekeySignature),
        base64Buffer(provider.lastRotation!.signedPrekeyPublic)
      )
    ).resolves.toBe(true)
  })

  it('retries one staged signed prekey after provider publication fails without double rotation', async () => {
    const provider = new RecordingProvider()
    const storage = new MemoryIdentityStorage()
    const client = new IdentityClient({ provider, storage, now: () => 3_500 })
    const original = await client.register('Ada')
    const originalSignedPrekey = await exportRawKey(original.signedPrekeyPair.publicKey)
    provider.rotationRequired = true
    provider.failNextRotation = true

    await expect(client.openSession()).rejects.toThrow(
      'simulated signed-prekey publication failure'
    )
    const staged = await storage.loadLocalIdentity()
    const stagedPublic = await exportRawKey(staged!.pendingSignedPrekey!.publicKey)
    expect(await exportRawKey(staged!.signedPrekeyPair.publicKey)).toBe(originalSignedPrekey)
    expect(provider.rotationCalls).toBe(1)
    expect(provider.lastRotation).toBeUndefined()

    const recovered = await client.openSession()

    expect(provider.rotationCalls).toBe(2)
    expect(provider.lastRotation?.signedPrekeyPublic).toBe(stagedPublic)
    expect(await exportRawKey(recovered!.signedPrekeyPair.publicKey)).toBe(stagedPublic)
    expect(recovered?.retiredSignedPrekeys).toHaveLength(1)
    expect(await exportRawKey(recovered!.retiredSignedPrekeys[0]!.publicKey)).toBe(
      originalSignedPrekey
    )
    expect(recovered?.pendingSignedPrekey).toBeUndefined()
  })

  it('recovers a provider-accepted signed-prekey rotation after final local persistence fails', async () => {
    const provider = new RecordingProvider()
    const storage = new FaultingIdentityStorage()
    const client = new IdentityClient({ provider, storage, now: () => 4_000 })
    const original = await client.register('Ada')
    const originalSignedPrekey = await exportRawKey(original.signedPrekeyPair.publicKey)
    provider.rotationRequired = true
    storage.failOnSaveCall = 3

    await expect(client.openSession()).rejects.toThrow('simulated identity storage failure')
    const staged = await storage.loadLocalIdentity()
    expect(staged?.pendingSignedPrekey).toBeDefined()
    expect(await exportRawKey(staged!.signedPrekeyPair.publicKey)).toBe(originalSignedPrekey)
    expect(provider.lastRotation?.signedPrekeyPublic).toBe(
      await exportRawKey(staged!.pendingSignedPrekey!.publicKey)
    )

    storage.failOnSaveCall = undefined
    const recovered = await client.openSession()

    expect(recovered?.pendingSignedPrekey).toBeUndefined()
    expect(recovered?.retiredSignedPrekeys).toHaveLength(1)
    expect(await exportRawKey(recovered!.signedPrekeyPair.publicKey)).toBe(
      provider.lastRotation?.signedPrekeyPublic
    )
    expect(await exportRawKey(recovered!.retiredSignedPrekeys[0]!.publicKey)).toBe(
      originalSignedPrekey
    )
  })

  it('creates symmetric deterministic 60-digit safety numbers', async () => {
    const first = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
    const second = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
    const forward = await createSafetyNumber(first.publicKey, second.publicKey)
    const reverse = await createSafetyNumber(second.publicKey, first.publicKey)

    expect(forward).toBe(reverse)
    expect(forward).toMatch(/^\d{60}$/)
    expect(formatSafetyNumber(forward).split(' ')).toHaveLength(12)
  })
})

function base64Buffer(value: string): ArrayBuffer {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer
}
