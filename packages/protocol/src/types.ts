export const PROTOCOL_VERSION = 1 as const
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const

export const ENVELOPE_KINDS = [
  'automerge-change',
  'snapshot',
  'membership',
  'archive',
  'delete',
  'health',
  'chunk'
] as const

export type ProtocolVersion = typeof PROTOCOL_VERSION
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number]
export type NonChunkEnvelopeKind = Exclude<EnvelopeKind, 'chunk'>

export interface ChunkMetadata {
  readonly index: number
  readonly total: number
  readonly originalMessageId: string
  readonly originalKind: NonChunkEnvelopeKind
}

export interface ProtocolEnvelope {
  readonly version: ProtocolVersion
  readonly documentId: string
  readonly messageId: string
  readonly senderId: string
  readonly kind: EnvelopeKind
  readonly createdAt: number
  readonly sequence?: number
  readonly chunk?: ChunkMetadata
  readonly payload: Uint8Array
}

export type ProtocolEnvelopeInput = Omit<ProtocolEnvelope, 'version'> & {
  readonly version?: ProtocolVersion
}

export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
export const MAX_CHUNKS = 4096
export const DEFAULT_CHUNK_PAYLOAD_BYTES = 32 * 1024
