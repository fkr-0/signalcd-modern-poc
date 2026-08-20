import { MAX_PAYLOAD_BYTES, PROTOCOL_VERSION, type ProtocolVersion } from './types'
import { ProtocolValidationError } from './validation'

const WIRE_MAGIC = new Uint8Array([0x45, 0x32, 0x45, 0x45]) // E2EE
const AAD_MAGIC = new Uint8Array([0x45, 0x32, 0x45, 0x41]) // E2EA
const KDF_MAGIC = new Uint8Array([0x45, 0x32, 0x45, 0x4b]) // E2EK
const SIGNATURE_MAGIC = new Uint8Array([0x45, 0x32, 0x45, 0x53]) // E2ES
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PHONE_RE = /^\+[1-9][0-9]{7,14}$/
const KEY_SELECTOR_RE = /^[0-9a-f]{64}$/
const MAX_ENCRYPTED_CIPHERTEXT_BYTES = MAX_PAYLOAD_BYTES + 64 * 1024

export type RecipientPrekeyKind = 'one-time' | 'signed'

export interface EncryptedEnvelopeMetadata {
  readonly version: ProtocolVersion
  readonly documentId: string
  readonly messageId: string
  readonly senderId: string
  readonly senderPhoneNumber: string
  readonly recipientId: string
  readonly recipientPhoneNumber: string
  readonly recipientPrekeyKind: RecipientPrekeyKind
  readonly recipientKeySelector: string
  readonly ephemeralPublic: Uint8Array
  readonly nonce: Uint8Array
}

export interface EncryptedEnvelopeUnsigned extends EncryptedEnvelopeMetadata {
  readonly ciphertext: Uint8Array
}

export interface EncryptedEnvelope extends EncryptedEnvelopeUnsigned {
  readonly signature: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

class Writer {
  private readonly chunks: Uint8Array[] = []
  private length = 0

  u8(value: number): void {
    this.raw(Uint8Array.of(value & 0xff))
  }

  u16(value: number): void {
    this.raw(Uint8Array.of((value >>> 8) & 0xff, value & 0xff))
  }

  u32(value: number): void {
    this.raw(
      Uint8Array.of(
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff
      )
    )
  }

  raw(value: Uint8Array): void {
    this.chunks.push(value)
    this.length += value.byteLength
  }

  string(value: string): void {
    const bytes = encoder.encode(value)
    if (bytes.byteLength > 0xffff)
      throw new ProtocolValidationError('encryptedEnvelope', 'string exceeds 65535 bytes')
    this.u16(bytes.byteLength)
    this.raw(bytes)
  }

  finish(): Uint8Array {
    const output = new Uint8Array(this.length)
    let offset = 0
    for (const chunk of this.chunks) {
      output.set(chunk, offset)
      offset += chunk.byteLength
    }
    return output
  }
}

class Reader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.byteLength)
      throw new ProtocolValidationError('encryptedEnvelope', 'truncated encrypted envelope')
    const value = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  u8(): number {
    return this.take(1)[0]!
  }

  u16(): number {
    const value = this.take(2)
    return value[0]! * 0x100 + value[1]!
  }

  u32(): number {
    const value = this.take(4)
    return value[0]! * 0x1000000 + value[1]! * 0x10000 + value[2]! * 0x100 + value[3]!
  }

  raw(length: number): Uint8Array {
    return new Uint8Array(this.take(length))
  }

  string(): string {
    try {
      return decoder.decode(this.take(this.u16()))
    } catch (error) {
      if (error instanceof ProtocolValidationError) throw error
      throw new ProtocolValidationError('encryptedEnvelope', 'invalid UTF-8 string')
    }
  }

  done(): boolean {
    return this.offset === this.bytes.byteLength
  }
}

export function validateEncryptedEnvelope(value: EncryptedEnvelope): EncryptedEnvelope {
  const metadata = validateMetadata(value)
  const ciphertext = exactBytes(
    value.ciphertext,
    'ciphertext',
    undefined,
    MAX_ENCRYPTED_CIPHERTEXT_BYTES
  )
  if (ciphertext.byteLength < 16)
    throw new ProtocolValidationError('ciphertext', 'must contain an AES-GCM authentication tag')
  return {
    ...metadata,
    ciphertext,
    signature: exactBytes(value.signature, 'signature', 64)
  }
}

export function encodeEncryptedEnvelope(value: EncryptedEnvelope): Uint8Array {
  const envelope = validateEncryptedEnvelope(value)
  const writer = new Writer()
  writeMetadata(writer, WIRE_MAGIC, envelope)
  writer.u32(envelope.ciphertext.byteLength)
  writer.raw(envelope.ciphertext)
  writer.raw(envelope.signature)
  return writer.finish()
}

export function decodeEncryptedEnvelope(bytes: Uint8Array): EncryptedEnvelope {
  if (!(bytes instanceof Uint8Array))
    throw new ProtocolValidationError('encryptedEnvelope', 'encoded value must be a Uint8Array')
  const reader = new Reader(bytes)
  expectMagic(reader, WIRE_MAGIC)
  const metadata = readMetadata(reader)
  const ciphertextLength = reader.u32()
  if (ciphertextLength > MAX_ENCRYPTED_CIPHERTEXT_BYTES)
    throw new ProtocolValidationError(
      'ciphertext',
      `must not exceed ${MAX_ENCRYPTED_CIPHERTEXT_BYTES} bytes`
    )
  const value = validateEncryptedEnvelope({
    ...metadata,
    ciphertext: reader.raw(ciphertextLength),
    signature: reader.raw(64)
  })
  if (!reader.done())
    throw new ProtocolValidationError(
      'encryptedEnvelope',
      'trailing bytes after encrypted envelope'
    )
  return value
}

/** Canonical AES-GCM authenticated metadata. */
export function encodeEncryptedEnvelopeAad(value: EncryptedEnvelopeMetadata): Uint8Array {
  const metadata = validateMetadata(value)
  const writer = new Writer()
  writeMetadata(writer, AAD_MAGIC, metadata)
  return writer.finish()
}

/** Domain-separated HKDF info. It explicitly binds both endpoint and message identities. */
export function encodeEncryptedEnvelopeKdfInfo(value: EncryptedEnvelopeMetadata): Uint8Array {
  const metadata = validateMetadata(value)
  const writer = new Writer()
  writeMetadata(writer, KDF_MAGIC, metadata)
  return writer.finish()
}

/** Canonical Ed25519 signature input: metadata plus the exact AES-GCM ciphertext. */
export function encodeEncryptedEnvelopeSignatureInput(
  value: EncryptedEnvelopeUnsigned
): Uint8Array {
  const metadata = validateMetadata(value)
  const ciphertext = exactBytes(
    value.ciphertext,
    'ciphertext',
    undefined,
    MAX_ENCRYPTED_CIPHERTEXT_BYTES
  )
  const writer = new Writer()
  writeMetadata(writer, SIGNATURE_MAGIC, metadata)
  writer.u32(ciphertext.byteLength)
  writer.raw(ciphertext)
  return writer.finish()
}

function validateMetadata(value: EncryptedEnvelopeMetadata): EncryptedEnvelopeMetadata {
  if (value.version !== PROTOCOL_VERSION)
    throw new ProtocolValidationError(
      'version',
      `unsupported protocol version ${String(value.version)}`
    )
  if (!UUID_RE.test(value.documentId))
    throw new ProtocolValidationError('documentId', 'must be a UUID string')
  if (!UUID_RE.test(value.messageId))
    throw new ProtocolValidationError('messageId', 'must be a UUID string')
  if (!UUID_RE.test(value.senderId))
    throw new ProtocolValidationError('senderId', 'must be a UUID string')
  if (!UUID_RE.test(value.recipientId))
    throw new ProtocolValidationError('recipientId', 'must be a UUID string')
  if (!PHONE_RE.test(value.senderPhoneNumber))
    throw new ProtocolValidationError('senderPhoneNumber', 'must be an E.164-style phone number')
  if (!PHONE_RE.test(value.recipientPhoneNumber))
    throw new ProtocolValidationError('recipientPhoneNumber', 'must be an E.164-style phone number')
  if (value.recipientPrekeyKind !== 'one-time' && value.recipientPrekeyKind !== 'signed')
    throw new ProtocolValidationError('recipientPrekeyKind', 'must be one-time or signed')
  if (!KEY_SELECTOR_RE.test(value.recipientKeySelector))
    throw new ProtocolValidationError(
      'recipientKeySelector',
      'must be a lowercase SHA-256 hex digest'
    )
  return {
    version: PROTOCOL_VERSION,
    documentId: value.documentId,
    messageId: value.messageId,
    senderId: value.senderId,
    senderPhoneNumber: value.senderPhoneNumber,
    recipientId: value.recipientId,
    recipientPhoneNumber: value.recipientPhoneNumber,
    recipientPrekeyKind: value.recipientPrekeyKind,
    recipientKeySelector: value.recipientKeySelector,
    ephemeralPublic: exactBytes(value.ephemeralPublic, 'ephemeralPublic', 32),
    nonce: exactBytes(value.nonce, 'nonce', 12)
  }
}

function exactBytes(
  value: Uint8Array,
  path: string,
  expectedLength?: number,
  maxLength?: number
): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new ProtocolValidationError(path, 'must be a Uint8Array')
  if (expectedLength !== undefined && value.byteLength !== expectedLength)
    throw new ProtocolValidationError(path, `must contain exactly ${expectedLength} bytes`)
  if (maxLength !== undefined && value.byteLength > maxLength)
    throw new ProtocolValidationError(path, `must not exceed ${maxLength} bytes`)
  return new Uint8Array(value)
}

function prekeyCode(value: RecipientPrekeyKind): number {
  return value === 'one-time' ? 1 : 2
}

function prekeyKind(value: number): RecipientPrekeyKind {
  if (value === 1) return 'one-time'
  if (value === 2) return 'signed'
  throw new ProtocolValidationError('recipientPrekeyKind', `unknown prekey kind code ${value}`)
}

function writeMetadata(writer: Writer, magic: Uint8Array, value: EncryptedEnvelopeMetadata): void {
  writer.raw(magic)
  writer.u8(value.version)
  writer.u8(prekeyCode(value.recipientPrekeyKind))
  writer.string(value.documentId)
  writer.string(value.messageId)
  writer.string(value.senderId)
  writer.string(value.senderPhoneNumber)
  writer.string(value.recipientId)
  writer.string(value.recipientPhoneNumber)
  writer.string(value.recipientKeySelector)
  writer.raw(value.ephemeralPublic)
  writer.raw(value.nonce)
}

function readMetadata(reader: Reader): EncryptedEnvelopeMetadata {
  const version = reader.u8()
  if (version !== PROTOCOL_VERSION)
    throw new ProtocolValidationError('version', `unsupported protocol version ${version}`)
  return validateMetadata({
    version,
    recipientPrekeyKind: prekeyKind(reader.u8()),
    documentId: reader.string(),
    messageId: reader.string(),
    senderId: reader.string(),
    senderPhoneNumber: reader.string(),
    recipientId: reader.string(),
    recipientPhoneNumber: reader.string(),
    recipientKeySelector: reader.string(),
    ephemeralPublic: reader.raw(32),
    nonce: reader.raw(12)
  })
}

function expectMagic(reader: Reader, expected: Uint8Array): void {
  for (const byte of expected) {
    if (reader.u8() !== byte)
      throw new ProtocolValidationError('encryptedEnvelope', 'invalid encrypted envelope magic')
  }
}
