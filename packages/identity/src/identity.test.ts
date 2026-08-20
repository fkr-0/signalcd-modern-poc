import { describe, expect, it } from 'vitest'
import { createSafetyNumber, formatSafetyNumber, IdentityClient } from './client'
import { exportRawKey } from './encoding'
import { MemoryIdentityStorage } from './storage'
import type {
  IdentityProvider,
  IdentitySessionClaim,
  RegisteredIdentityClaim,
  RegistrationPublicMaterial,
  RemoteIdentityBundle
} from './types'

class RecordingProvider implements IdentityProvider {
  lastRegistration: RegistrationPublicMaterial | undefined

  async register(material: RegistrationPublicMaterial): Promise<RegisteredIdentityClaim> {
    this.lastRegistration = material
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
    return {
      userId: '10000000-0000-4000-8000-000000000099',
      phoneNumber: '+15550000099',
      displayName: 'Ada',
      createdAt: 1234
    }
  }

  async lookupKeys(): Promise<RemoteIdentityBundle> {
    throw new Error('not used')
  }

  async replenishPrekeys(): Promise<number> {
    return 10
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
    expect(identity.oneTimePrekeys.every((prekey) => !prekey.privateKey.extractable)).toBe(true)
    expect(provider.lastRegistration?.oneTimePrekeys).toHaveLength(10)
    expect(await exportRawKey(identity.identityKeyPair.publicKey)).toBe(
      provider.lastRegistration?.identityKeyPublic
    )
    expect((await client.openSession())?.userId).toBe(identity.userId)
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
