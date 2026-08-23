import {
  createEnvelope,
  decodeDebugObserverEnvelope,
  encodeDebugObserverEnvelope
} from '@e2e-col/protocol'
import { describe, expect, it } from 'vitest'
import { encryptProtocolEnvelopeForDebugObserver } from '../../../packages/identity/src/debug-observer'
import type { UserIdentity } from '../../../packages/identity/src/types'
import { DebugObserverManager } from './debug-observer'

const documentId = '11111111-1111-4111-8111-111111111111'
const messageId = '22222222-2222-4222-8222-222222222222'

describe('DebugObserverManager', () => {
  it('decrypts a sender-signed observer copy and rejects signature tampering', async () => {
    const manager = new DebugObserverManager(true)
    const identity = await createIdentity()
    const capability = await manager.capability()
    expect(capability).toBeDefined()
    const envelope = createEnvelope({
      documentId,
      messageId,
      senderId: identity.userId,
      kind: 'automerge-change',
      createdAt: 1_700_000_000_000,
      payload: new TextEncoder().encode('manager-known-plaintext')
    })
    const observer = await encryptProtocolEnvelopeForDebugObserver(envelope, identity, {
      keyId: capability!.key_id,
      publicKey: capability!.public_key
    })
    const encoded = encodeDebugObserverEnvelope(observer)
    const binding = {
      observerKeyId: capability!.key_id,
      documentId,
      messageId,
      senderId: identity.userId,
      senderPhoneNumber: identity.phoneNumber,
      senderIdentityKeyPublic: await rawPublicBase64(identity.identityKeyPair.publicKey)
    }
    await expect(manager.decrypt(encoded, binding)).resolves.toEqual(envelope)
    await expect(
      manager.decrypt(encoded, {
        ...binding,
        messageId: '33333333-3333-4333-8333-333333333333'
      })
    ).rejects.toMatchObject({ code: 'binding-mismatch' })

    const tamperedCiphertext = decodeDebugObserverEnvelope(encoded)
    const ciphertext = new Uint8Array(tamperedCiphertext.ciphertext)
    ciphertext[0] = ciphertext[0]! ^ 0x01
    await expect(
      manager.decrypt(encodeDebugObserverEnvelope({ ...tamperedCiphertext, ciphertext }), binding)
    ).rejects.toMatchObject({ code: 'invalid-signature' })

    const tampered = decodeDebugObserverEnvelope(encoded)
    const signature = new Uint8Array(tampered.signature)
    signature[signature.length - 1] = signature[signature.length - 1]! ^ 0x01
    await expect(
      manager.decrypt(encodeDebugObserverEnvelope({ ...tampered, signature }), binding)
    ).rejects.toMatchObject({ code: 'invalid-signature' })
  })

  it('invalidates stale observer key ids on reset while keeping private material unobservable', async () => {
    const manager = new DebugObserverManager(true)
    const identity = await createIdentity()
    const before = (await manager.capability())!
    expect(Object.keys(before).sort()).toEqual(['algorithm', 'key_id', 'public_key', 'version'])
    expect(JSON.stringify(before)).not.toMatch(/private|session.?token|secret/i)
    const envelope = createEnvelope({
      documentId,
      messageId,
      senderId: identity.userId,
      kind: 'automerge-change',
      createdAt: 1_700_000_000_000,
      payload: new TextEncoder().encode('stale-known-plaintext')
    })
    const observer = await encryptProtocolEnvelopeForDebugObserver(envelope, identity, {
      keyId: before.key_id,
      publicKey: before.public_key
    })
    manager.reset()
    const after = (await manager.capability())!
    expect(after.key_id).not.toBe(before.key_id)
    await expect(
      manager.decrypt(encodeDebugObserverEnvelope(observer), {
        observerKeyId: before.key_id,
        documentId,
        messageId,
        senderId: identity.userId,
        senderPhoneNumber: identity.phoneNumber,
        senderIdentityKeyPublic: await rawPublicBase64(identity.identityKeyPair.publicKey)
      })
    ).rejects.toMatchObject({ code: 'stale-key' })
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
    userId: '10000000-0000-4000-8000-000000000001',
    phoneNumber: '+15550000001',
    displayName: 'Observer test sender',
    identityKeyPair,
    signedPrekeyPair: {
      ...signedPrekeyPair,
      keyId: 'signed-prekey-current',
      createdAt: 1_700_000_000_000
    },
    retiredSignedPrekeys: [],
    oneTimePrekeys: [],
    sessionToken: 'browser-session-token-must-not-leak',
    createdAt: 1_700_000_000_000
  }
}

async function rawPublicBase64(key: CryptoKey): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.exportKey('raw', key))
  return Buffer.from(bytes).toString('base64')
}

function asKeyPair(value: CryptoKeyPair): CryptoKeyPair {
  if (!value.publicKey || !value.privateKey) throw new Error('expected WebCrypto keypair')
  return value
}
