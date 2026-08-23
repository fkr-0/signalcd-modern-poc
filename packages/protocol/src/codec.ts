import {
  type EnvelopeKind,
  MAX_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
  type ProtocolEnvelope
} from './types'
import { ProtocolValidationError, validateEnvelope } from './validation'

const MAGIC = new Uint8Array([0x45, 0x32, 0x45, 0x43]) // "E2EC"
const FLAG_SEQUENCE = 1 << 0
const FLAG_CHUNK = 1 << 1
const KNOWN_FLAGS = FLAG_SEQUENCE | FLAG_CHUNK

const KIND_TO_CODE: Readonly<Record<EnvelopeKind, number>> = {
  'automerge-change': 1,
  snapshot: 2,
  membership: 3,
  archive: 4,
  delete: 5,
  health: 6,
  chunk: 7,
  'authorization-resolution': 8
}

const CODE_TO_KIND = new Map<number, EnvelopeKind>(
  Object.entries(KIND_TO_CODE).map(([name, code]) => [code, name as EnvelopeKind])
)

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export class Writer {
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

  u64(value: number): void {
    const bigint = BigInt(value)
    const bytes = new Uint8Array(8)
    let index = 0
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      bytes[index++] = Number((bigint >> shift) & 0xffn)
    }
    this.raw(bytes)
  }

  raw(value: Uint8Array): void {
    this.chunks.push(value)
    this.length += value.byteLength
  }

  string(value: string): void {
    const bytes = encoder.encode(value)
    if (bytes.byteLength > 0xffff)
      throw new ProtocolValidationError('codec', 'string exceeds 65535 bytes')
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

export class Reader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.byteLength) {
      throw new ProtocolValidationError('codec', 'truncated envelope')
    }
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

  u64(): number {
    const value = this.take(8)
    let result = 0n
    for (const byte of value) result = (result << 8n) | BigInt(byte)
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProtocolValidationError('codec', 'integer exceeds JavaScript safe range')
    }
    return Number(result)
  }

  raw(length: number): Uint8Array {
    return new Uint8Array(this.take(length))
  }

  string(): string {
    try {
      return decoder.decode(this.take(this.u16()))
    } catch (error) {
      if (error instanceof ProtocolValidationError) throw error
      throw new ProtocolValidationError('codec', 'invalid UTF-8 string')
    }
  }

  done(): boolean {
    return this.offset === this.bytes.byteLength
  }
}

export function encodeEnvelope(value: ProtocolEnvelope): Uint8Array {
  const envelope = validateEnvelope(value)
  const writer = new Writer()
  writer.raw(MAGIC)
  writer.u8(envelope.version)
  writer.u8(KIND_TO_CODE[envelope.kind])
  writer.u8(
    (envelope.sequence === undefined ? 0 : FLAG_SEQUENCE) |
      (envelope.chunk === undefined ? 0 : FLAG_CHUNK)
  )
  writer.u64(envelope.createdAt)
  if (envelope.sequence !== undefined) writer.u64(envelope.sequence)
  writer.string(envelope.documentId)
  writer.string(envelope.messageId)
  writer.string(envelope.senderId)
  if (envelope.chunk !== undefined) {
    writer.u32(envelope.chunk.index)
    writer.u32(envelope.chunk.total)
    writer.string(envelope.chunk.originalMessageId)
    writer.u8(KIND_TO_CODE[envelope.chunk.originalKind])
  }
  writer.u32(envelope.payload.byteLength)
  writer.raw(envelope.payload)
  return writer.finish()
}

export function decodeEnvelope(bytes: Uint8Array): ProtocolEnvelope {
  if (!(bytes instanceof Uint8Array)) {
    throw new ProtocolValidationError('codec', 'encoded envelope must be a Uint8Array')
  }
  const reader = new Reader(bytes)
  for (const byte of MAGIC) {
    if (reader.u8() !== byte) throw new ProtocolValidationError('codec', 'invalid envelope magic')
  }

  const version = reader.u8()
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolValidationError('version', `unsupported protocol version ${version}`)
  }

  const kindCode = reader.u8()
  const parsedKind = CODE_TO_KIND.get(kindCode)
  if (parsedKind === undefined)
    throw new ProtocolValidationError('kind', `unknown frame kind code ${kindCode}`)

  const flags = reader.u8()
  if ((flags & ~KNOWN_FLAGS) !== 0)
    throw new ProtocolValidationError('codec', 'unknown envelope flags')
  const createdAt = reader.u64()
  const sequence = (flags & FLAG_SEQUENCE) !== 0 ? reader.u64() : undefined
  const documentId = reader.string()
  const messageId = reader.string()
  const senderId = reader.string()

  let chunk: ProtocolEnvelope['chunk']
  if ((flags & FLAG_CHUNK) !== 0) {
    const index = reader.u32()
    const total = reader.u32()
    const originalMessageId = reader.string()
    const originalKindCode = reader.u8()
    const originalKind = CODE_TO_KIND.get(originalKindCode)
    if (originalKind === undefined || originalKind === 'chunk') {
      throw new ProtocolValidationError(
        'chunk.originalKind',
        'contains an unsupported original frame kind'
      )
    }
    chunk = { index, total, originalMessageId, originalKind }
  }

  const payloadLength = reader.u32()
  if (payloadLength > MAX_PAYLOAD_BYTES) {
    throw new ProtocolValidationError('payload', `must not exceed ${MAX_PAYLOAD_BYTES} bytes`)
  }
  const payload = reader.raw(payloadLength)
  if (!reader.done()) throw new ProtocolValidationError('codec', 'trailing bytes after envelope')

  return validateEnvelope({
    version,
    documentId,
    messageId,
    senderId,
    kind: parsedKind,
    createdAt,
    ...(sequence === undefined ? {} : { sequence }),
    ...(chunk === undefined ? {} : { chunk }),
    payload
  })
}
