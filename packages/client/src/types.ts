import type { TextEdit } from '@e2e-col/core'
import type {
  DocumentAccessState,
  DocumentParticipant,
  DocumentRole,
  ForkResolutionApproval,
  ProtocolEnvelope
} from '@e2e-col/protocol'
import type {
  AuthorizationControlKind,
  DocumentMetadata,
  DurableCollaborativeStorage
} from '@e2e-col/storage'
import type { ObservableCollaborativeTransport, TransportConnectionState } from '@e2e-col/transport'

export interface TransportContext {
  readonly documentId: string
}

export interface AuthorizationBootstrapControlEvidence {
  readonly kind: AuthorizationControlKind
  readonly senderId: string
  readonly messageId: string
  readonly payload: Uint8Array
  readonly receivedAt: number
}

export interface AuthorizationBootstrapResolutionEvidence {
  readonly senderId: string
  readonly messageId: string
  readonly payload: Uint8Array
  readonly receivedAt: number
}

/**
 * Untrusted bootstrap evidence. The client verifies the selected root,
 * identity-key commitments, every control signature/predecessor and every
 * resolution proof before installing authority.
 */
export interface AuthorizationBootstrapMaterial {
  /**
   * Initial authority requested for an explicit local create operation. The
   * session only consumes this field while handling `createDocument()`; a
   * fresh `openDocument()` MUST NOT mint authority from bootstrap metadata.
   * Adapters MUST NOT populate this from plaintext server/group membership.
   */
  readonly initialParticipants?: readonly DocumentParticipant[]
  readonly expectedRoot?: string
  readonly expectedHead?: string
  readonly roots: readonly Uint8Array[]
  readonly controls: readonly AuthorizationBootstrapControlEvidence[]
  readonly resolutions: readonly AuthorizationBootstrapResolutionEvidence[]
}

export interface AuthorizationEvidencePublish {
  readonly rootCommitment: string
  readonly headCommitment: string
  readonly root?: Uint8Array
  readonly controls: readonly AuthorizationBootstrapControlEvidence[]
  readonly resolutions: readonly AuthorizationBootstrapResolutionEvidence[]
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
  /** SHA-256 commitment to an independently fetched/locally held Ed25519 identity key. */
  identityKeyCommitment?(participantId: string): Promise<Uint8Array>
  bootstrapAuthorization?(
    context: Omit<IdentityEnvelopeContext, 'participants'>
  ): Promise<AuthorizationBootstrapMaterial>
  publishAuthorizationEvidence?(
    context: Omit<IdentityEnvelopeContext, 'participants'>,
    evidence: AuthorizationEvidencePublish
  ): Promise<void>
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

/** Maximum normalized local display-title length. */
export const MAX_DOCUMENT_TITLE_LENGTH = 200

export interface UpdateDocumentMetadataOptions {
  /** null or an empty/whitespace-only string clears the local display title. */
  readonly title: string | null
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

export interface OutboundReplayProgress {
  /** Durable records in the reconnect/restart replay batch. */
  readonly total: number
  /** Records successfully handed to the local transport in this batch. */
  readonly completed: number
  /** True while the client is actively handing this batch to the transport. */
  readonly active: boolean
}

export interface SessionStatus {
  readonly phase: SessionPhase
  readonly transport: TransportConnectionState
  /** Durable records that have never yet been successfully handed to the transport. */
  readonly pendingOutbound: number
  /** Local replay progress only; completion is not remote acknowledgement. */
  readonly replay?: OutboundReplayProgress
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
  /** Sign the deterministic currently-frozen fork-resolution proposal. */
  approveForkResolution(chosenControlId: string): Promise<ForkResolutionApproval>
  /** Publish a resolution only when the complete pre-fork admin quorum approved it. */
  resolveFork(chosenControlId: string, approvals: readonly ForkResolutionApproval[]): Promise<void>
}
