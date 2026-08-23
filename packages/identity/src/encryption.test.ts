import { createEnvelope, encodeEncryptedEnvelope } from '@e2e-col/protocol'
import { describe, expect, it } from 'vitest'
import { IdentityClient } from './client'
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

const documentId = '11111111-1111-4111-8111-111111111111'

interface ProviderRecord extends RegisteredIdentityClaim {
  prekeys: string[]
}

class PairProvider implements IdentityProvider {
  private readonly byPhone = new Map<string, ProviderRecord>()
  private readonly byToken = new Map<string, ProviderRecord>()
  private sequence = 0
  rotationRequired = false

  async register(material: RegistrationPublicMaterial): Promise<RegisteredIdentityClaim> {
    this.sequence += 1
    const suffix = this.sequence.toString().padStart(12, '0')
    const record: ProviderRecord = {
      userId: `10000000-0000-4000-8000-${suffix}`,
      phoneNumber: `+1555000${this.sequence.toString().padStart(4, '0')}`,
      displayName: material.displayName,
      identityKeyPublic: material.identityKeyPublic,
      signedPrekeyPublic: material.signedPrekeyPublic,
      signedPrekeySignature: material.signedPrekeySignature,
      oneTimePrekeys: material.oneTimePrekeys,
      sessionToken: `token-${this.sequence}`,
      createdAt: 1_700_000_000_000 + this.sequence,
      prekeys: [...material.oneTimePrekeys]
    }
    this.byPhone.set(record.phoneNumber, record)
    this.byToken.set(record.sessionToken, record)
    return record
  }

  async verifySession(sessionToken: string): Promise<IdentitySessionClaim> {
    const record = this.byToken.get(sessionToken)
    if (!record) throw new Error('invalid session')
    return {
      userId: record.userId,
      phoneNumber: record.phoneNumber,
      displayName: record.displayName,
      signedPrekeyPublic: record.signedPrekeyPublic,
      signedPrekeyRotationRequired: this.rotationRequired,
      prekeyCount: record.prekeys.length,
      createdAt: record.createdAt
    }
  }

  async lookupKeys(phoneNumber: string): Promise<RemoteIdentityBundle> {
    const record = this.byPhone.get(phoneNumber)
    if (!record) throw new Error('unknown identity')
    return {
      userId: record.userId,
      phoneNumber: record.phoneNumber,
      displayName: record.displayName,
      identityKeyPublic: record.identityKeyPublic,
      signedPrekeyPublic: record.signedPrekeyPublic,
      signedPrekeySignature: record.signedPrekeySignature,
      ...(record.prekeys.length === 0 ? {} : { oneTimePrekey: record.prekeys.shift()! }),
      remainingPrekeys: record.prekeys.length
    }
  }

  async replenishPrekeys(sessionToken: string, oneTimePrekeys: readonly string[]): Promise<number> {
    const record = this.byToken.get(sessionToken)
    if (!record) throw new Error('invalid session')
    for (const prekey of oneTimePrekeys) {
      if (!record.prekeys.includes(prekey)) record.prekeys.push(prekey)
    }
    return record.prekeys.length
  }

  async rotateSignedPrekey(
    sessionToken: string,
    material: SignedPrekeyPublicMaterial
  ): Promise<SignedPrekeyRotationClaim> {
    const record = this.byToken.get(sessionToken)
    if (!record) throw new Error('invalid session')
    const next: ProviderRecord = {
      ...record,
      signedPrekeyPublic: material.signedPrekeyPublic,
      signedPrekeySignature: material.signedPrekeySignature
    }
    this.byToken.set(sessionToken, next)
    this.byPhone.set(next.phoneNumber, next)
    this.rotationRequired = false
    return { ...material, rotatedAt: 1_700_000_100_000 }
  }
}

async function pair() {
  const provider = new PairProvider()
  const aliceClient = new IdentityClient({ provider, storage: new MemoryIdentityStorage() })
  const bobClient = new IdentityClient({ provider, storage: new MemoryIdentityStorage() })
  const alice = await aliceClient.register('Alice')
  const bob = await bobClient.register('Bob')
  return { provider, aliceClient, bobClient, alice, bob }
}

function envelope(sender: UserIdentity, index = 1) {
  return createEnvelope({
    documentId,
    messageId: `22222222-2222-4222-8222-${index.toString().padStart(12, '0')}`,
    senderId: sender.userId,
    kind: 'automerge-change',
    createdAt: 1_700_000_000_000 + index,
    payload: new TextEncoder().encode(`secret-change-${index}`)
  })
}

describe('recipient-bound encrypted protocol envelopes', () => {
  it('round-trips X25519 + HKDF-SHA-256 + AES-256-GCM with an Ed25519 sender signature', async () => {
    const { aliceClient, bobClient, alice, bob } = await pair()
    const original = envelope(alice)
    const encrypted = await aliceClient.encryptEnvelopeForRecipient(original, bob, alice)

    expect(encrypted.recipientPrekeyKind).toBe('one-time')
    expect(encrypted.nonce).toHaveLength(12)
    expect(encrypted.ephemeralPublic).toHaveLength(32)
    expect(encrypted.signature).toHaveLength(64)
    expect(new TextDecoder().decode(encodeEncryptedEnvelope(encrypted))).not.toContain(
      'secret-change-1'
    )
    expect(await bobClient.decryptEnvelope(encodeEncryptedEnvelope(encrypted), bob)).toEqual(
      original
    )
  })

  it('rejects ciphertext, nonce, metadata, signature, sender and recipient tampering before decode', async () => {
    const { aliceClient, bobClient, alice, bob } = await pair()
    const encrypted = await aliceClient.encryptEnvelopeForRecipient(envelope(alice), bob, alice)

    const flip = (bytes: Uint8Array) => {
      const copy = new Uint8Array(bytes)
      copy[0] = copy[0]! ^ 0x01
      return copy
    }
    await expect(
      bobClient.decryptEnvelope({ ...encrypted, ciphertext: flip(encrypted.ciphertext) }, bob)
    ).rejects.toThrow(/signature/)
    await expect(
      bobClient.decryptEnvelope({ ...encrypted, nonce: flip(encrypted.nonce) }, bob)
    ).rejects.toThrow(/signature/)
    await expect(
      bobClient.decryptEnvelope(
        { ...encrypted, documentId: '99999999-9999-4999-8999-999999999999' },
        bob
      )
    ).rejects.toThrow(/signature/)
    await expect(
      bobClient.decryptEnvelope({ ...encrypted, signature: flip(encrypted.signature) }, bob)
    ).rejects.toThrow(/signature/)
    await expect(
      bobClient.decryptEnvelope(
        { ...encrypted, senderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        bob
      )
    ).rejects.toThrow(/sender identity/)
    await expect(
      bobClient.decryptEnvelope({ ...encrypted, recipientId: alice.userId }, bob)
    ).rejects.toThrow(/different recipient/)
  })

  it('carries a recoverable public-key selector and falls back cleanly to the signed prekey', async () => {
    const { aliceClient, bobClient, alice, bob } = await pair()
    let latest = await aliceClient.encryptEnvelopeForRecipient(envelope(alice, 1), bob, alice)
    expect(latest.recipientKeySelector).toMatch(/^[0-9a-f]{64}$/)
    expect(await bobClient.decryptEnvelope(latest, bob)).toEqual(envelope(alice, 1))

    for (let index = 2; index <= 11; index += 1)
      latest = await aliceClient.encryptEnvelopeForRecipient(envelope(alice, index), bob, alice)
    expect(latest.recipientPrekeyKind).toBe('signed')
    expect(await bobClient.decryptEnvelope(latest, bob)).toEqual(envelope(alice, 11))
  })

  it('decrypts delayed ciphertext addressed to the signed prekey retired by rotation', async () => {
    const { provider, aliceClient, bobClient, alice, bob } = await pair()
    for (let index = 1; index <= 10; index += 1)
      await aliceClient.encryptEnvelopeForRecipient(envelope(alice, index), bob, alice)
    const delayed = await aliceClient.encryptEnvelopeForRecipient(envelope(alice, 11), bob, alice)
    expect(delayed.recipientPrekeyKind).toBe('signed')

    provider.rotationRequired = true
    const rotatedBob = await bobClient.openSession()

    expect(rotatedBob?.retiredSignedPrekeys).toHaveLength(1)
    expect(await bobClient.decryptEnvelope(delayed, rotatedBob!)).toEqual(envelope(alice, 11))
  })
})
