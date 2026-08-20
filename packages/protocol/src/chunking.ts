import {
  DEFAULT_CHUNK_PAYLOAD_BYTES,
  MAX_CHUNKS,
  MAX_PAYLOAD_BYTES,
  type ProtocolEnvelope
} from './types'
import { createProtocolId, ProtocolValidationError, validateEnvelope } from './validation'

export interface ChunkEnvelopeOptions {
  readonly maxPayloadBytes?: number
  readonly createMessageId?: () => string
}

export function chunkEnvelope(
  input: ProtocolEnvelope,
  options: ChunkEnvelopeOptions = {}
): ProtocolEnvelope[] {
  const envelope = validateEnvelope(input)
  if (envelope.kind === 'chunk') {
    throw new ProtocolValidationError('kind', 'cannot chunk an existing chunk frame')
  }

  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_CHUNK_PAYLOAD_BYTES
  if (!Number.isSafeInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    throw new ProtocolValidationError('maxPayloadBytes', 'must be a positive safe integer')
  }
  if (envelope.payload.byteLength <= maxPayloadBytes) return [envelope]

  const total = Math.ceil(envelope.payload.byteLength / maxPayloadBytes)
  if (total > MAX_CHUNKS) {
    throw new ProtocolValidationError(
      'payload',
      `requires ${total} chunks, exceeding the ${MAX_CHUNKS} chunk limit`
    )
  }

  const createMessageId = options.createMessageId ?? createProtocolId
  const chunks: ProtocolEnvelope[] = []
  const frameIds = new Set<string>()
  for (let index = 0; index < total; index += 1) {
    const start = index * maxPayloadBytes
    const end = Math.min(start + maxPayloadBytes, envelope.payload.byteLength)
    const messageId = createMessageId()
    if (frameIds.has(messageId)) {
      throw new ProtocolValidationError(
        'messageId',
        'chunk message ID factory returned a duplicate identifier'
      )
    }
    frameIds.add(messageId)
    chunks.push(
      validateEnvelope({
        version: envelope.version,
        documentId: envelope.documentId,
        messageId,
        senderId: envelope.senderId,
        kind: 'chunk',
        createdAt: envelope.createdAt,
        ...(envelope.sequence === undefined ? {} : { sequence: envelope.sequence }),
        chunk: {
          index,
          total,
          originalMessageId: envelope.messageId,
          originalKind: envelope.kind
        },
        payload: envelope.payload.slice(start, end)
      })
    )
  }
  return chunks
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

export function reassembleChunks(inputs: readonly ProtocolEnvelope[]): ProtocolEnvelope {
  if (inputs.length === 0)
    throw new ProtocolValidationError('chunks', 'at least one chunk is required')
  const chunks = inputs.map(validateEnvelope)
  const first = chunks[0]!
  if (first.kind !== 'chunk' || first.chunk === undefined) {
    throw new ProtocolValidationError('chunks[0]', 'must be a chunk frame')
  }

  const byIndex = new Map<number, ProtocolEnvelope>()
  for (const frame of chunks) {
    if (frame.kind !== 'chunk' || frame.chunk === undefined) {
      throw new ProtocolValidationError('chunks', 'all frames must be chunk frames')
    }
    if (
      frame.documentId !== first.documentId ||
      frame.senderId !== first.senderId ||
      frame.createdAt !== first.createdAt ||
      frame.sequence !== first.sequence ||
      frame.chunk.total !== first.chunk.total ||
      frame.chunk.originalMessageId !== first.chunk.originalMessageId ||
      frame.chunk.originalKind !== first.chunk.originalKind
    ) {
      throw new ProtocolValidationError(
        'chunks',
        'chunk metadata does not describe one logical message'
      )
    }

    const existing = byIndex.get(frame.chunk.index)
    if (existing !== undefined) {
      if (!bytesEqual(existing.payload, frame.payload)) {
        throw new ProtocolValidationError(
          'chunks',
          `conflicting duplicate chunk at index ${frame.chunk.index}`
        )
      }
      continue
    }
    byIndex.set(frame.chunk.index, frame)
  }

  if (byIndex.size !== first.chunk.total) {
    throw new ProtocolValidationError(
      'chunks',
      `incomplete chunk set: got ${byIndex.size} of ${first.chunk.total}`
    )
  }

  const ordered = Array.from({ length: first.chunk.total }, (_, index) => byIndex.get(index)!)
  let totalBytes = 0
  for (const frame of ordered) {
    totalBytes += frame.payload.byteLength
    if (totalBytes > MAX_PAYLOAD_BYTES) {
      throw new ProtocolValidationError(
        'chunks',
        `reassembled payload exceeds ${MAX_PAYLOAD_BYTES} bytes`
      )
    }
  }
  const payload = new Uint8Array(totalBytes)
  let offset = 0
  for (const frame of ordered) {
    payload.set(frame.payload, offset)
    offset += frame.payload.byteLength
  }

  return validateEnvelope({
    version: first.version,
    documentId: first.documentId,
    messageId: first.chunk.originalMessageId,
    senderId: first.senderId,
    kind: first.chunk.originalKind,
    createdAt: first.createdAt,
    ...(first.sequence === undefined ? {} : { sequence: first.sequence }),
    payload
  })
}
