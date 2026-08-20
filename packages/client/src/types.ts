import type { TextEdit } from '@e2e-col/core'
import type {
  DocumentAccessState,
  DocumentParticipant,
  DocumentRole,
  ProtocolEnvelope
} from '@e2e-col/protocol'
import type { DocumentMetadata, DurableCollaborativeStorage } from '@e2e-col/storage'
import type { ObservableCollaborativeTransport, TransportConnectionState } from '@e2e-col/transport'

export interface TransportContext {
  readonly documentId: string
}

export type TransportFactory = (context: TransportContext) => ObservableCollaborativeTransport

export interface ClientClock {
  now(): number
}

export interface ClientIdFactory {
  createMessageId(): string
  createDocumentId(): string
}

export interface RecoveryPolicy {
  readonly replayAttemptedOnReconnect?: boolean
  /** Publish a durable full snapshot when the transport reports ambiguous loss. */
  readonly publishSnapshotOnRecoverySignal?: boolean
  /**
   * Replace accumulated CRDT increment history with a retained snapshot after
   * this many CRDT outbound records. Access-control records are never covered
   * by this compaction threshold.
   */
  readonly snapshotThresholdOutboundEntries?: number
}

export interface IdentityEnvelopeContext {
  readonly documentId: string
  readonly transport: ObservableCollaborativeTransport
  readonly participants: readonly DocumentParticipant[]
}

export interface ResolvedParticipant {
  readonly participantId: string
  readonly displayName?: string
}

export interface ClientIdentityAdapter {
  signControl(bytes: Uint8Array): Promise<Uint8Array>
  verifyControl(actorUserId: string, bytes: Uint8Array, signature: Uint8Array): Promise<boolean>
  resolveParticipant(phoneNumber: string, role: DocumentRole): Promise<ResolvedParticipant>
  encodeEnvelope?(envelope: ProtocolEnvelope, context: IdentityEnvelopeContext): Promise<Uint8Array>
  decodeEnvelope?(wire: Uint8Array, context: IdentityEnvelopeContext): Promise<ProtocolEnvelope>
  bootstrapAccess?(
    context: Omit<IdentityEnvelopeContext, 'participants'>
  ): Promise<readonly DocumentParticipant[]>
}

export interface CreateDocumentOptions {
  readonly documentId?: string
  readonly initialText?: string
  readonly metadata?: DocumentMetadata
}

export interface CollaborativeClientOptions {
  readonly senderId: string
  readonly transportFactory: TransportFactory
  readonly storage: DurableCollaborativeStorage
  readonly identity?: ClientIdentityAdapter
  readonly clock?: ClientClock
  readonly ids?: ClientIdFactory
  readonly recovery?: RecoveryPolicy
}

export interface DocumentSummary {
  readonly documentId: string
  readonly title?: string
  readonly updatedAt: number
  readonly archived: boolean
}

export interface DocumentView {
  readonly text: string
  readonly heads: readonly string[]
}

export type SessionPhase =
  | 'opening'
  | 'ready'
  | 'syncing'
  | 'offline'
  | 'recovering'
  | 'error'
  | 'closed'

export type ClientErrorCode =
  | 'protocol-invalid'
  | 'storage-unavailable'
  | 'transport-unavailable'
  | 'transport-closed'
  | 'authorization-denied'
  | 'recovery-failed'
  | 'document-not-found'
  | 'internal'

export interface ClientError {
  readonly code: ClientErrorCode
  readonly message: string
  readonly recoverable: boolean
  readonly cause?: unknown
}

export interface SessionStatus {
  readonly phase: SessionPhase
  readonly transport: TransportConnectionState
  readonly pendingOutbound: number
  readonly recoveryRequired: boolean
  readonly lastReceivedAt?: number
  readonly lastSentAt?: number
  readonly lastPersistedAt?: number
  readonly error?: ClientError
}

export type DocumentSessionEvent =
  | { readonly type: 'document'; readonly view: DocumentView }
  | { readonly type: 'status'; readonly status: SessionStatus }
  | { readonly type: 'access'; readonly access: DocumentAccessState }
  | { readonly type: 'error'; readonly error: ClientError }

export type SyncMode = 'auto' | 'manual'

export interface DocumentSessionCommands {
  editText(nextText: string): Promise<void>
  spliceText(edit: TextEdit): Promise<void>
  /** Persist and attempt delivery of a complete mergeable CRDT checkpoint. */
  publishSnapshot(): Promise<void>
  inviteParticipant(phoneNumber: string, role: DocumentRole): Promise<void>
  setParticipantRole(participantId: string, role: DocumentRole): Promise<void>
  removeParticipant(participantId: string): Promise<void>
  archive(): Promise<void>
  unarchive(): Promise<void>
  deleteForGroup(): Promise<void>
}
