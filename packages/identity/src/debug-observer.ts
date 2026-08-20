import {
  DEBUG_OBSERVER_HKDF_SALT_DOMAIN,
  type DebugObserverEnvelope,
  encodeDebugObserverEnvelopeAad,
  encodeDebugObserverEnvelopeKdfInfo,
  encodeDebugObserverEnvelopeSignatureInput,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type ProtocolEnvelope,
  validateDebugObserverEnvelope
} from '@e2e-col/protocol'
import { base64ToBytes, importX25519Public } from './encoding'
import type { UserIdentity } from './types'

const KEY_ID_RE = /^[0-9a-f]{64}$/

export interface DebugObserverCapability {
  readonly keyId: string
  readonly publicKey: string
}

/**
 * Encrypt a second, toy-debug-only copy for the daemon observer public key.
 * Real recipient encryption is untouched; the observer private key is never present here.
 */
export async function encryptProtocolEnvelopeForDebugObserver(
  envelope: ProtocolEnvelope,
  localIdentity: UserIdentity,
  capability: DebugObserverCapability
): Promise<DebugObserverEnvelope> {
  if (envelope.senderId !== localIdentity.userId)
    throw new Error('protocol envelope sender does not match local identity')
  if (!KEY_ID_RE.test(capability.keyId)) throw new Error('debug observer key id is invalid')

  const observerPublicBytes = base64ToBytes(capability.publicKey)
  if (observerPublicBytes.byteLength !== 32)
    throw new Error('debug observer public key must contain 32 bytes')
  const observedKeyId = await sha256Hex(observerPublicBytes)
  if (observedKeyId !== capability.keyId)
    throw new Error('debug observer public key does not match advertised key id')
  const observerPublic = await importX25519Public(capability.publicKey)
  const ephemeral = asKeyPair(
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  )
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const metadata = {
    version: PROTOCOL_VERSION,
    observerKeyId: capability.keyId,
    documentId: envelope.documentId,
    messageId: envelope.messageId,
    senderId: envelope.senderId,
    senderPhoneNumber: localIdentity.phoneNumber,
    ephemeralPublic,
    nonce
  } as const
  const key = await deriveObserverAesKey(ephemeral.privateKey, observerPublic, metadata, [
    'encrypt'
  ])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(encodeDebugObserverEnvelopeAad(metadata)),
        tagLength: 128
      },
      key,
      toArrayBuffer(encodeEnvelope(envelope))
    )
  )
  const unsigned = { ...metadata, ciphertext }
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      localIdentity.identityKeyPair.privateKey,
      toArrayBuffer(encodeDebugObserverEnvelopeSignatureInput(unsigned))
    )
  )
  return validateDebugObserverEnvelope({ ...unsigned, signature })
}

async function deriveObserverAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  metadata: Parameters<typeof encodeDebugObserverEnvelopeKdfInfo>[0],
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256
  )
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  const salt = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      toArrayBuffer(new TextEncoder().encode(DEBUG_OBSERVER_HKDF_SALT_DOMAIN))
    )
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(encodeDebugObserverEnvelopeKdfInfo(metadata))
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  )
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function asKeyPair(value: CryptoKeyPair): CryptoKeyPair {
  if (!value.publicKey || !value.privateKey) throw new Error('WebCrypto did not return a keypair')
  return value
}
