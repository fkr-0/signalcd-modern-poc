import {
  type ChunkMetadata,
  ENVELOPE_KINDS,
  type EnvelopeKind,
  MAX_CHUNKS,
  MAX_PAYLOAD_BYTES,
  type NonChunkEnvelopeKind,
  PROTOCOL_VERSION,
  type ProtocolEnvelope,
  type ProtocolEnvelopeInput,
  type ProtocolVersion
} from './types'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KIND_SET = new Set<string>(ENVELOPE_KINDS)
const ENVELOPE_KEYS = new Set([
  'version',
  'documentId',
  'messageId',
  'senderId',
  'kind',
  'createdAt',
  'sequence',
  'chunk',
  'payload'
])
const CHUNK_KEYS = new Set(['index', 'total', 'originalMessageId', 'originalKind'])

export class ProtocolValidationError extends Error {
  readonly path: string

  constructor(path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'ProtocolValidationError'
    this.path = path
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError(path, 'must be an object')
  }
  return value as Record<string, unknown>
}

function assertKnownKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key))
      throw new ProtocolValidationError(`${path}.${key}`, 'is not a recognized field')
  }
}

function uuid(value: unknown, path: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ProtocolValidationError(path, 'must be a UUID string')
  }
  return value
}

function sender(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new ProtocolValidationError(path, 'must be a non-empty string of at most 512 characters')
  }
  return value
}

function safeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ProtocolValidationError(path, 'must be a non-negative safe integer')
  }
  return value
}

function kind(value: unknown, path: string): EnvelopeKind {
  if (typeof value !== 'string' || !KIND_SET.has(value)) {
    throw new ProtocolValidationError(path, 'contains an unsupported frame kind')
  }
  return value as EnvelopeKind
}

function nonChunkKind(value: unknown, path: string): NonChunkEnvelopeKind {
  const parsed = kind(value, path)
  if (parsed === 'chunk') {
    throw new ProtocolValidationError(path, 'chunk cannot be the original kind of another chunk')
  }
  return parsed
}

function payload(value: unknown, path: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new ProtocolValidationError(path, 'must be a Uint8Array')
  }
  if (value.byteLength > MAX_PAYLOAD_BYTES) {
    throw new ProtocolValidationError(path, `must not exceed ${MAX_PAYLOAD_BYTES} bytes`)
  }
  return new Uint8Array(value)
}

function chunkMetadata(value: unknown, path: string): ChunkMetadata {
  const input = record(value, path)
  assertKnownKeys(input, CHUNK_KEYS, path)
  const index = safeInteger(input.index, `${path}.index`)
  const total = safeInteger(input.total, `${path}.total`)
  if (total < 2 || total > MAX_CHUNKS) {
    throw new ProtocolValidationError(`${path}.total`, `must be between 2 and ${MAX_CHUNKS}`)
  }
  if (index >= total) {
    throw new ProtocolValidationError(`${path}.index`, 'must be lower than total')
  }
  return {
    index,
    total,
    originalMessageId: uuid(input.originalMessageId, `${path}.originalMessageId`),
    originalKind: nonChunkKind(input.originalKind, `${path}.originalKind`)
  }
}

export function isSupportedProtocolVersion(value: unknown): value is ProtocolVersion {
  return value === PROTOCOL_VERSION
}

export function assertSupportedProtocolVersion(value: unknown): asserts value is ProtocolVersion {
  if (!isSupportedProtocolVersion(value)) {
    throw new ProtocolValidationError('version', `unsupported protocol version ${String(value)}`)
  }
}

export function validateEnvelope(value: unknown): ProtocolEnvelope {
  const input = record(value, 'envelope')
  assertKnownKeys(input, ENVELOPE_KEYS, 'envelope')
  assertSupportedProtocolVersion(input.version)
  const parsedKind = kind(input.kind, 'kind')
  const parsedChunk = input.chunk === undefined ? undefined : chunkMetadata(input.chunk, 'chunk')

  if (parsedKind === 'chunk' && parsedChunk === undefined) {
    throw new ProtocolValidationError('chunk', 'is required for chunk frames')
  }
  if (parsedKind !== 'chunk' && parsedChunk !== undefined) {
    throw new ProtocolValidationError('chunk', 'is only allowed for chunk frames')
  }

  const result: ProtocolEnvelope = {
    version: PROTOCOL_VERSION,
    documentId: uuid(input.documentId, 'documentId'),
    messageId: uuid(input.messageId, 'messageId'),
    senderId: sender(input.senderId, 'senderId'),
    kind: parsedKind,
    createdAt: safeInteger(input.createdAt, 'createdAt'),
    payload: payload(input.payload, 'payload'),
    ...(input.sequence === undefined ? {} : { sequence: safeInteger(input.sequence, 'sequence') }),
    ...(parsedChunk === undefined ? {} : { chunk: parsedChunk })
  }
  return result
}

export function createEnvelope(input: ProtocolEnvelopeInput): ProtocolEnvelope {
  return validateEnvelope({ ...input, version: input.version ?? PROTOCOL_VERSION })
}

export function createProtocolId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required to create protocol identifiers')
  }
  return globalThis.crypto.randomUUID()
}
