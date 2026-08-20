import { webcrypto } from 'node:crypto'
import {
  DEBUG_OBSERVER_HKDF_SALT_DOMAIN,
  decodeDebugObserverEnvelope,
  decodeEnvelope,
  encodeDebugObserverEnvelopeAad,
  encodeDebugObserverEnvelopeKdfInfo,
  encodeDebugObserverEnvelopeSignatureInput,
  type ProtocolEnvelope
} from '@e2e-col/protocol'

type NodeCryptoKey = Parameters<typeof webcrypto.subtle.exportKey>[1]

export interface DebugObserverCapabilityView {
  readonly version: 1
  readonly key_id: string
  readonly public_key: string
  readonly algorithm: 'X25519+HKDF-SHA-256+AES-256-GCM+Ed25519'
}

export interface DebugObserverBinding {
  readonly observerKeyId: string
  readonly documentId: string
  readonly messageId: string
  readonly senderId: string
  readonly senderPhoneNumber: string
  readonly senderIdentityKeyPublic: string
}

export type DebugObserverErrorCode =
  | 'disabled'
  | 'stale-key'
  | 'binding-mismatch'
  | 'invalid-signature'
  | 'authentication-failed'
  | 'invalid-envelope'

export class DebugObserverError extends Error {
  constructor(
    readonly code: DebugObserverErrorCode,
    message: string
  ) {
    super(message)
  }
}

interface ObserverState {
  readonly generation: number
  readonly keyId: string
  readonly publicKey: string
  readonly privateKey: NodeCryptoKey
}

/** Server-owned toy observer. Private key material is non-exportable and never serialized. */
export class DebugObserverManager {
  private generation = 0
  private statePromise: Promise<ObserverState> | undefined

  constructor(private enabled = false) {}

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    this.rotate()
  }

  /** Reset always invalidates the previous observer generation, even if debug remains enabled. */
  reset(): void {
    this.rotate()
  }

  async capability(): Promise<DebugObserverCapabilityView | undefined> {
    if (!this.enabled) return undefined
    const state = await this.currentState()
    return {
      version: 1,
      key_id: state.keyId,
      public_key: state.publicKey,
      algorithm: 'X25519+HKDF-SHA-256+AES-256-GCM+Ed25519'
    }
  }

  async decrypt(payload: Uint8Array, binding: DebugObserverBinding): Promise<ProtocolEnvelope> {
    if (!this.enabled) throw new DebugObserverError('disabled', 'debug observer is disabled')
    let encrypted: ReturnType<typeof decodeDebugObserverEnvelope>
    try {
      encrypted = decodeDebugObserverEnvelope(payload)
    } catch {
      throw new DebugObserverError('invalid-envelope', 'debug observer envelope is malformed')
    }
    const state = await this.currentState()
    if (
      binding.observerKeyId !== state.keyId ||
      encrypted.observerKeyId !== state.keyId ||
      encrypted.observerKeyId !== binding.observerKeyId
    )
      throw new DebugObserverError('stale-key', 'debug observer key id is stale or unknown')
    if (
      encrypted.documentId !== binding.documentId ||
      encrypted.messageId !== binding.messageId ||
      encrypted.senderId !== binding.senderId ||
      encrypted.senderPhoneNumber !== binding.senderPhoneNumber
    )
      throw new DebugObserverError('binding-mismatch', 'debug observer metadata binding mismatch')

    const senderKey = await importEd25519(binding.senderIdentityKeyPublic)
    const signatureValid = await webcrypto.subtle.verify(
      { name: 'Ed25519' },
      senderKey,
      toArrayBuffer(encrypted.signature),
      toArrayBuffer(encodeDebugObserverEnvelopeSignatureInput(encrypted))
    )
    if (!signatureValid)
      throw new DebugObserverError(
        'invalid-signature',
        'debug observer sender signature is invalid'
      )

    const ephemeral = await webcrypto.subtle.importKey(
      'raw',
      toArrayBuffer(encrypted.ephemeralPublic),
      { name: 'X25519' },
      true,
      []
    )
    const key = await deriveObserverAesKey(state.privateKey, ephemeral, encrypted)
    let plaintext: Uint8Array
    try {
      plaintext = new Uint8Array(
        await webcrypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: toArrayBuffer(encrypted.nonce),
            additionalData: toArrayBuffer(encodeDebugObserverEnvelopeAad(encrypted)),
            tagLength: 128
          },
          key,
          toArrayBuffer(encrypted.ciphertext)
        )
      )
    } catch {
      throw new DebugObserverError(
        'authentication-failed',
        'debug observer ciphertext authentication failed'
      )
    }
    let envelope: ProtocolEnvelope
    try {
      envelope = decodeEnvelope(plaintext)
    } catch {
      throw new DebugObserverError(
        'invalid-envelope',
        'debug observer plaintext is not a protocol envelope'
      )
    }
    if (
      envelope.documentId !== encrypted.documentId ||
      envelope.messageId !== encrypted.messageId ||
      envelope.senderId !== encrypted.senderId
    )
      throw new DebugObserverError(
        'binding-mismatch',
        'debug observer plaintext metadata binding mismatch'
      )
    return envelope
  }

  private rotate(): void {
    this.generation += 1
    this.statePromise = undefined
  }

  private currentState(): Promise<ObserverState> {
    const generation = this.generation
    this.statePromise ??= createObserverState(generation)
    return this.statePromise
  }
}

async function createObserverState(generation: number): Promise<ObserverState> {
  const pair = asKeyPair(
    await webcrypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  )
  const publicBytes = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))
  return {
    generation,
    keyId: await sha256Hex(publicBytes),
    publicKey: Buffer.from(publicBytes).toString('base64'),
    privateKey: pair.privateKey
  }
}

async function deriveObserverAesKey(
  privateKey: NodeCryptoKey,
  publicKey: NodeCryptoKey,
  metadata: Parameters<typeof encodeDebugObserverEnvelopeKdfInfo>[0]
): Promise<NodeCryptoKey> {
  const sharedSecret = await webcrypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256
  )
  const hkdfKey = await webcrypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, [
    'deriveKey'
  ])
  const salt = new Uint8Array(
    await webcrypto.subtle.digest(
      'SHA-256',
      toArrayBuffer(new TextEncoder().encode(DEBUG_OBSERVER_HKDF_SALT_DOMAIN))
    )
  )
  return webcrypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(encodeDebugObserverEnvelopeKdfInfo(metadata))
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )
}

async function importEd25519(base64: string): Promise<NodeCryptoKey> {
  let bytes: Buffer
  try {
    bytes = Buffer.from(base64, 'base64')
  } catch {
    throw new DebugObserverError('invalid-signature', 'sender identity public key is invalid')
  }
  if (bytes.byteLength !== 32)
    throw new DebugObserverError('invalid-signature', 'sender identity public key is invalid')
  return webcrypto.subtle.importKey(
    'raw',
    toArrayBuffer(new Uint8Array(bytes)),
    { name: 'Ed25519' },
    false,
    ['verify']
  )
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await webcrypto.subtle.digest('SHA-256', toArrayBuffer(bytes)))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

function asKeyPair(value: unknown): { publicKey: NodeCryptoKey; privateKey: NodeCryptoKey } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('publicKey' in value) ||
    !('privateKey' in value)
  )
    throw new Error('WebCrypto did not return a keypair')
  return value as { publicKey: NodeCryptoKey; privateKey: NodeCryptoKey }
}
