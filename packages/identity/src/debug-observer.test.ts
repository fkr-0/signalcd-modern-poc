import {
  createEnvelope,
  decodeDebugObserverEnvelope,
  encodeDebugObserverEnvelope,
  encodeDebugObserverEnvelopeSignatureInput
} from '@e2e-col/protocol'
import { describe, expect, it } from 'vitest'
import { encryptProtocolEnvelopeForDebugObserver } from './debug-observer'
import { bytesToBase64 } from './encoding'
import type { UserIdentity } from './types'

const documentId = '11111111-1111-4111-8111-111111111111'
const senderId = '10000000-0000-4000-8000-000000000001'
const messageId = '22222222-2222-4222-8222-222222222222'

describe('toy debug observer encryption', () => {
  it('creates a domain-separated observer copy without exposing local private/session material', async () => {
    const identity = await createIdentity()
    const observer = asKeyPair(
      await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    )
    const observerPublic = new Uint8Array(await crypto.subtle.exportKey('raw', observer.publicKey))
    const keyId = await sha256Hex(observerPublic)
    const envelope = createEnvelope({
      documentId,
      messageId,
      senderId,
      kind: 'automerge-change',
      createdAt: 1_700_000_000_000,
      payload: new TextEncoder().encode('observer-plaintext-sentinel')
    })

    const encrypted = await encryptProtocolEnvelopeForDebugObserver(envelope, identity, {
      keyId,
      publicKey: bytesToBase64(observerPublic)
    })
    const encoded = encodeDebugObserverEnvelope(encrypted)
    expect(new TextDecoder().decode(encoded)).not.toContain('observer-plaintext-sentinel')
    expect(new TextDecoder().decode(encoded)).not.toContain(identity.sessionToken)
    expect(decodeDebugObserverEnvelope(encoded)).toEqual(encrypted)
    expect(encrypted.observerKeyId).toBe(keyId)
    expect(encrypted.ephemeralPublic).toHaveLength(32)
    expect(encrypted.nonce).toHaveLength(12)
    expect(encrypted.signature).toHaveLength(64)
    await expect(
      crypto.subtle.verify(
        { name: 'Ed25519' },
        identity.identityKeyPair.publicKey,
        toArrayBuffer(encrypted.signature),
        toArrayBuffer(encodeDebugObserverEnvelopeSignatureInput(encrypted))
      )
    ).resolves.toBe(true)
  })

  it('rejects an observer public key whose advertised id does not match', async () => {
    const identity = await createIdentity()
    const observer = asKeyPair(
      await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    )
    const observerPublic = new Uint8Array(await crypto.subtle.exportKey('raw', observer.publicKey))
    const envelope = createEnvelope({
      documentId,
      messageId,
      senderId,
      kind: 'automerge-change',
      createdAt: 1_700_000_000_000,
      payload: new Uint8Array([1, 2, 3])
    })
    await expect(
      encryptProtocolEnvelopeForDebugObserver(envelope, identity, {
        keyId: '0'.repeat(64),
        publicKey: bytesToBase64(observerPublic)
      })
    ).rejects.toThrow(/does not match advertised key id/)
  })
})

async function createIdentity(): Promise<UserIdentity> {
  const identityKeyPair = asKeyPair(
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  )
  const signedPrekeyPair = asKeyPair(
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  )
  return {
    userId: senderId,
    phoneNumber: '+15550000001',
    displayName: 'Observer sender',
    identityKeyPair,
    signedPrekeyPair,
    oneTimePrekeys: [],
    sessionToken: 'session-token-must-never-leak',
    createdAt: 1_700_000_000_000
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function asKeyPair(value: CryptoKeyPair): CryptoKeyPair {
  if (!value.publicKey || !value.privateKey) throw new Error('expected WebCrypto keypair')
  return value
}
