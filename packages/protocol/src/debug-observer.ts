import { MAX_PAYLOAD_BYTES, PROTOCOL_VERSION, type ProtocolVersion } from './types'
import { ProtocolValidationError } from './validation'

const WIRE_MAGIC = new Uint8Array([0x45, 0x32, 0x4f, 0x57]) // E2OW
const AAD_MAGIC = new Uint8Array([0x45, 0x32, 0x4f, 0x41]) // E2OA
const KDF_MAGIC = new Uint8Array([0x45, 0x32, 0x4f, 0x4b]) // E2OK
const SIGNATURE_MAGIC = new Uint8Array([0x45, 0x32, 0x4f, 0x53]) // E2OS
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PHONE_RE = /^\+[1-9][0-9]{7,14}$/
const KEY_ID_RE = /^[0-9a-f]{64}$/
const MAX_OBSERVER_CIPHERTEXT_BYTES = MAX_PAYLOAD_BYTES + 64 * 1024

/**
 * Debug observer crypto is a deliberately separate domain from recipient encryption.
 * This string is hashed before use as HKDF salt by both browser and toy daemon.
 */
export const DEBUG_OBSERVER_HKDF_SALT_DOMAIN = 'e2e-col/debug-observer/hkdf-salt/v1'

export interface DebugObserverEnvelopeMetadata {
  readonly version: ProtocolVersion
  readonly observerKeyId: string
  readonly documentId: string
  readonly messageId: string
  readonly senderId: string
  readonly senderPhoneNumber: string
  readonly ephemeralPublic: Uint8Array
  readonly nonce: Uint8Array
}

export interface DebugObserverEnvelopeUnsigned extends DebugObserverEnvelopeMetadata {
  readonly ciphertext: Uint8Array
}

export interface DebugObserverEnvelope extends DebugObserverEnvelopeUnsigned {
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
      throw new ProtocolValidationError('debugObserverEnvelope', 'string exceeds 65535 bytes')
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
      throw new ProtocolValidationError(
        'debugObserverEnvelope',
        'truncated debug observer envelope'
      )
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
      throw new ProtocolValidationError('debugObserverEnvelope', 'invalid UTF-8 string')
    }
  }

  done(): boolean {
    return this.offset === this.bytes.byteLength
  }
}

export function validateDebugObserverEnvelope(value: DebugObserverEnvelope): DebugObserverEnvelope {
  const metadata = validateMetadata(value)
  const ciphertext = exactBytes(
    value.ciphertext,
    'ciphertext',
    undefined,
    MAX_OBSERVER_CIPHERTEXT_BYTES
  )
  if (ciphertext.byteLength < 16)
    throw new ProtocolValidationError('ciphertext', 'must contain an AES-GCM authentication tag')
  return {
    ...metadata,
    ciphertext,
    signature: exactBytes(value.signature, 'signature', 64)
  }
}

export function encodeDebugObserverEnvelope(value: DebugObserverEnvelope): Uint8Array {
  const envelope = validateDebugObserverEnvelope(value)
  const writer = new Writer()
  writeMetadata(writer, WIRE_MAGIC, envelope)
  writer.u32(envelope.ciphertext.byteLength)
  writer.raw(envelope.ciphertext)
  writer.raw(envelope.signature)
  return writer.finish()
}

export function decodeDebugObserverEnvelope(bytes: Uint8Array): DebugObserverEnvelope {
  if (!(bytes instanceof Uint8Array))
    throw new ProtocolValidationError('debugObserverEnvelope', 'encoded value must be a Uint8Array')
  const reader = new Reader(bytes)
  expectMagic(reader, WIRE_MAGIC)
  const metadata = readMetadata(reader)
  const ciphertextLength = reader.u32()
  if (ciphertextLength > MAX_OBSERVER_CIPHERTEXT_BYTES)
    throw new ProtocolValidationError(
      'ciphertext',
      `must not exceed ${MAX_OBSERVER_CIPHERTEXT_BYTES} bytes`
    )
  const value = validateDebugObserverEnvelope({
    ...metadata,
    ciphertext: reader.raw(ciphertextLength),
    signature: reader.raw(64)
  })
  if (!reader.done())
    throw new ProtocolValidationError(
      'debugObserverEnvelope',
      'trailing bytes after debug observer envelope'
    )
  return value
}

export function encodeDebugObserverEnvelopeAad(value: DebugObserverEnvelopeMetadata): Uint8Array {
  const metadata = validateMetadata(value)
  const writer = new Writer()
  writeMetadata(writer, AAD_MAGIC, metadata)
  return writer.finish()
}

export function encodeDebugObserverEnvelopeKdfInfo(
  value: DebugObserverEnvelopeMetadata
): Uint8Array {
  const metadata = validateMetadata(value)
  const writer = new Writer()
  writeMetadata(writer, KDF_MAGIC, metadata)
  return writer.finish()
}

export function encodeDebugObserverEnvelopeSignatureInput(
  value: DebugObserverEnvelopeUnsigned
): Uint8Array {
  const metadata = validateMetadata(value)
  const ciphertext = exactBytes(
    value.ciphertext,
    'ciphertext',
    undefined,
    MAX_OBSERVER_CIPHERTEXT_BYTES
  )
  const writer = new Writer()
  writeMetadata(writer, SIGNATURE_MAGIC, metadata)
  writer.u32(ciphertext.byteLength)
  writer.raw(ciphertext)
  return writer.finish()
}

function validateMetadata(value: DebugObserverEnvelopeMetadata): DebugObserverEnvelopeMetadata {
  if (value.version !== PROTOCOL_VERSION)
    throw new ProtocolValidationError(
      'version',
      `unsupported protocol version ${String(value.version)}`
    )
  if (!KEY_ID_RE.test(value.observerKeyId))
    throw new ProtocolValidationError('observerKeyId', 'must be a lowercase SHA-256 hex digest')
  if (!UUID_RE.test(value.documentId))
    throw new ProtocolValidationError('documentId', 'must be a UUID string')
  if (!UUID_RE.test(value.messageId))
    throw new ProtocolValidationError('messageId', 'must be a UUID string')
  if (!UUID_RE.test(value.senderId))
    throw new ProtocolValidationError('senderId', 'must be a UUID string')
  if (!PHONE_RE.test(value.senderPhoneNumber))
    throw new ProtocolValidationError('senderPhoneNumber', 'must be an E.164-style phone number')
  return {
    version: PROTOCOL_VERSION,
    observerKeyId: value.observerKeyId,
    documentId: value.documentId,
    messageId: value.messageId,
    senderId: value.senderId,
    senderPhoneNumber: value.senderPhoneNumber,
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

function writeMetadata(
  writer: Writer,
  magic: Uint8Array,
  value: DebugObserverEnvelopeMetadata
): void {
  writer.raw(magic)
  writer.u8(value.version)
  writer.string(value.observerKeyId)
  writer.string(value.documentId)
  writer.string(value.messageId)
  writer.string(value.senderId)
  writer.string(value.senderPhoneNumber)
  writer.raw(value.ephemeralPublic)
  writer.raw(value.nonce)
}

function readMetadata(reader: Reader): DebugObserverEnvelopeMetadata {
  const version = reader.u8()
  if (version !== PROTOCOL_VERSION)
    throw new ProtocolValidationError('version', `unsupported protocol version ${version}`)
  return validateMetadata({
    version,
    observerKeyId: reader.string(),
    documentId: reader.string(),
    messageId: reader.string(),
    senderId: reader.string(),
    senderPhoneNumber: reader.string(),
    ephemeralPublic: reader.raw(32),
    nonce: reader.raw(12)
  })
}

function expectMagic(reader: Reader, expected: Uint8Array): void {
  for (const byte of expected) {
    if (reader.u8() !== byte)
      throw new ProtocolValidationError(
        'debugObserverEnvelope',
        'invalid debug observer envelope magic'
      )
  }
}
