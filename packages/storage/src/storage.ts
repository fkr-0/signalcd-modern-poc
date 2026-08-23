import type { DocumentAccessState, NonChunkEnvelopeKind } from '@e2e-col/protocol'

export interface DocumentMetadata {
  readonly title?: string
  readonly archived?: boolean
  /** Application-owned additive fields are preserved by metadata updates. */
  readonly [key: string]: unknown
}

export function withDocumentMetadataUpdate(
  document: StoredDocument,
  update: DocumentMetadataUpdate,
  updatedAt: number
): StoredDocument {
  const { metadata: _currentMetadata, ...documentWithoutMetadata } = document
  const metadata: Record<string, unknown> = { ...(document.metadata ?? {}) }
  if (update.title === null) delete metadata.title
  else metadata.title = update.title
  const hasMetadata = Object.keys(metadata).length > 0
  return {
    ...documentWithoutMetadata,
    updatedAt,
    ...(hasMetadata ? { metadata: metadata as DocumentMetadata } : {})
  }
}

export interface DocumentMetadataUpdate {
  /** A normalized title, or null to remove the local title. */
  readonly title: string | null
}

export function cloneAuthorizationState(value: StoredAuthorizationState): StoredAuthorizationState {
  return {
    ...value,
    ...(value.rootProof === undefined ? {} : { rootProof: new Uint8Array(value.rootProof) }),
    anchorAccess: cloneAccessState(value.anchorAccess),
    records: value.records.map((record) => ({
      ...record,
      payload: new Uint8Array(record.payload),
      resultingAccess: cloneAccessState(record.resultingAccess)
    })),
    pending: value.pending.map((record) => ({
      ...record,
      payload: new Uint8Array(record.payload)
    })),
    ...(value.resolutions === undefined
      ? {}
      : {
          resolutions: value.resolutions.map((resolution) => ({
            ...resolution,
            competingControlIds: [...resolution.competingControlIds],
            payload: new Uint8Array(resolution.payload),
            resultingAccess: cloneAccessState(resolution.resultingAccess)
          }))
        }),
    ...(value.pendingResolutions === undefined
      ? {}
      : {
          pendingResolutions: value.pendingResolutions.map((resolution) => ({
            ...resolution,
            payload: new Uint8Array(resolution.payload)
          }))
        }),
    ...(value.conflict === undefined
      ? {}
      : {
          conflict: {
            ...value.conflict,
            controlIds: [...value.conflict.controlIds]
          }
        })
  }
}

export interface StoredDocument {
  readonly documentId: string
  readonly snapshot: Uint8Array
  readonly updatedAt: number
  readonly schemaVersion?: number
  readonly createdAt?: number
  readonly metadata?: DocumentMetadata
}

export interface OutboundRecord {
  readonly id: string
  readonly documentId: string
  readonly payload: Uint8Array
  readonly createdAt: number
  /**
   * Optional for schema compatibility with v0.0.2 records. New client records
   * set this so recovery can compact CRDT history without discarding access
   * control transitions that a document snapshot does not subsume.
   */
  readonly kind?: NonChunkEnvelopeKind
  readonly state?: 'pending' | 'attempted'
  readonly attempts?: number
  readonly lastAttemptAt?: number
}

export interface SeenMessage {
  readonly documentId: string
  readonly messageId: string
  readonly seenAt: number
}

export type AuthorizationControlKind = 'membership' | 'archive' | 'delete'

export interface StoredAuthorizationControl {
  readonly controlId: string
  readonly kind: AuthorizationControlKind
  readonly predecessor: string
  readonly revision: number
  readonly senderId: string
  readonly messageId: string
  readonly payload: Uint8Array
  readonly receivedAt: number
  readonly resultingAccess: DocumentAccessState
}

export interface PendingAuthorizationControl {
  readonly controlId: string
  readonly kind: AuthorizationControlKind
  readonly predecessor: string
  readonly revision: number
  readonly senderId: string
  readonly messageId: string
  readonly payload: Uint8Array
  readonly receivedAt: number
}

export interface AuthorizationConflict {
  readonly predecessor: string
  readonly revision: number
  readonly controlIds: readonly string[]
}

export type AuthorizationAnchorKind =
  | 'verified-root'
  | 'legacy-zero-genesis'
  | 'legacy-local-anchor'

export interface StoredAuthorizationResolution {
  readonly resolutionId: string
  readonly commonPredecessor: string
  readonly forkRevision: number
  readonly competingControlIds: readonly string[]
  readonly chosenControlId: string
  readonly revision: number
  readonly senderId: string
  readonly messageId: string
  readonly payload: Uint8Array
  readonly receivedAt: number
  readonly resultingAccess: DocumentAccessState
}

export interface PendingAuthorizationResolution {
  readonly resolutionId: string
  readonly senderId: string
  readonly messageId: string
  readonly payload: Uint8Array
  readonly receivedAt: number
}

export interface StoredAuthorizationState {
  readonly version: 2
  /** Missing on Phase-4 records; clients migrate it explicitly on open. */
  readonly anchorKind?: AuthorizationAnchorKind
  readonly anchorHead: string
  readonly anchorAccess: DocumentAccessState
  /** Encoded creator-signed root; present iff anchorKind is verified-root. */
  readonly rootProof?: Uint8Array
  readonly head: string
  readonly records: readonly StoredAuthorizationControl[]
  readonly pending: readonly PendingAuthorizationControl[]
  readonly resolutions?: readonly StoredAuthorizationResolution[]
  readonly pendingResolutions?: readonly PendingAuthorizationResolution[]
  readonly conflict?: AuthorizationConflict
}

export const DEFAULT_SEEN_MESSAGE_TTL_MS = 24 * 60 * 60 * 1000

export interface SeenMessageRetentionOptions {
  readonly seenMessageTtlMs?: number
  readonly now?: () => number
}

export interface CheckpointPolicy {
  readonly safeRecordIds: readonly string[]
  readonly retainAtLeast?: number
}

export interface CollaborativeStorage {
  loadDocument(documentId: string): Promise<StoredDocument | undefined>
  saveDocument(document: StoredDocument): Promise<void>
  updateDocumentMetadata(
    documentId: string,
    update: DocumentMetadataUpdate,
    updatedAt: number
  ): Promise<StoredDocument>
  deleteDocument(documentId: string): Promise<void>
  listDocuments(): Promise<readonly StoredDocument[]>
  enqueue(record: OutboundRecord): Promise<void>
  listOutbound(documentId?: string): Promise<readonly OutboundRecord[]>
  acknowledgeOutbound(id: string): Promise<void>
  close(): Promise<void>
}

export interface AccessControlStorage {
  loadAccessControl(documentId: string): Promise<DocumentAccessState | undefined>
  loadAuthorizationState(documentId: string): Promise<StoredAuthorizationState | undefined>
  saveAccessControl(documentId: string, state: DocumentAccessState): Promise<void>
}

export interface DurableCollaborativeStorage extends CollaborativeStorage, AccessControlStorage {
  commitLocalChange(input: {
    document: StoredDocument
    outbound: readonly OutboundRecord[]
  }): Promise<void>
  persistRemoteState(input: {
    document: StoredDocument
    seen: readonly SeenMessage[]
  }): Promise<void>
  commitAccessChange(input: {
    documentId: string
    access: DocumentAccessState
    authorization?: StoredAuthorizationState
    outbound: readonly OutboundRecord[]
    seen?: readonly SeenMessage[]
  }): Promise<void>
  markOutboundAttempt(recordIds: readonly string[], attemptedAt: number): Promise<void>
  compactOutbound(documentId: string, policy: CheckpointPolicy): Promise<void>
  hasSeen(documentId: string, messageId: string, now?: number): Promise<boolean>
  pruneSeenMessages(now?: number): Promise<number>
}

export class MemoryCollaborativeStorage implements DurableCollaborativeStorage {
  private readonly documents = new Map<string, StoredDocument>()
  private readonly outbound = new Map<string, OutboundRecord>()
  private readonly access = new Map<string, DocumentAccessState>()
  private readonly authorization = new Map<string, StoredAuthorizationState>()
  private readonly seen = new Map<string, SeenMessage>()
  private readonly seenMessageTtlMs: number
  private readonly now: () => number

  constructor(options: SeenMessageRetentionOptions = {}) {
    this.seenMessageTtlMs = normalizeSeenMessageTtlMs(options.seenMessageTtlMs)
    this.now = options.now ?? Date.now
  }

  async loadAuthorizationState(documentId: string): Promise<StoredAuthorizationState | undefined> {
    const value = this.authorization.get(documentId)
    return value ? cloneAuthorizationState(value) : undefined
  }

  async loadDocument(documentId: string): Promise<StoredDocument | undefined> {
    const value = this.documents.get(documentId)
    return value ? cloneDocument(value) : undefined
  }

  async saveDocument(document: StoredDocument): Promise<void> {
    this.documents.set(document.documentId, cloneDocument(document))
  }

  async updateDocumentMetadata(
    documentId: string,
    update: DocumentMetadataUpdate,
    updatedAt: number
  ): Promise<StoredDocument> {
    const current = this.documents.get(documentId)
    if (!current) throw new Error(`document ${documentId} does not exist`)
    const updated = withDocumentMetadataUpdate(current, update, updatedAt)
    this.documents.set(documentId, cloneDocument(updated))
    return cloneDocument(updated)
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.documents.delete(documentId)
    this.access.delete(documentId)
    this.authorization.delete(documentId)
  }

  async listDocuments(): Promise<readonly StoredDocument[]> {
    return [...this.documents.values()].map(cloneDocument).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async enqueue(record: OutboundRecord): Promise<void> {
    this.outbound.set(record.id, cloneOutbound(record))
  }

  async listOutbound(documentId?: string): Promise<readonly OutboundRecord[]> {
    return [...this.outbound.values()]
      .filter((record) => documentId === undefined || record.documentId === documentId)
      .map(cloneOutbound)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async acknowledgeOutbound(id: string): Promise<void> {
    this.outbound.delete(id)
  }

  async loadAccessControl(documentId: string): Promise<DocumentAccessState | undefined> {
    const value = this.access.get(documentId)
    return value ? cloneAccessState(value) : undefined
  }

  async saveAccessControl(documentId: string, state: DocumentAccessState): Promise<void> {
    this.access.set(documentId, cloneAccessState(state))
  }

  async commitLocalChange(input: {
    document: StoredDocument
    outbound: readonly OutboundRecord[]
  }): Promise<void> {
    this.documents.set(
      input.document.documentId,
      withPreservedDocumentMetadata(this.documents.get(input.document.documentId), input.document)
    )
    for (const record of input.outbound) this.outbound.set(record.id, cloneOutbound(record))
  }

  async persistRemoteState(input: {
    document: StoredDocument
    seen: readonly SeenMessage[]
  }): Promise<void> {
    this.documents.set(
      input.document.documentId,
      withPreservedDocumentMetadata(this.documents.get(input.document.documentId), input.document)
    )
    for (const value of input.seen)
      this.seen.set(seenKey(value.documentId, value.messageId), { ...value })
  }

  async commitAccessChange(input: {
    documentId: string
    access: DocumentAccessState
    authorization?: StoredAuthorizationState
    outbound: readonly OutboundRecord[]
    seen?: readonly SeenMessage[]
  }): Promise<void> {
    this.access.set(input.documentId, cloneAccessState(input.access))
    if (input.authorization !== undefined)
      this.authorization.set(input.documentId, cloneAuthorizationState(input.authorization))
    for (const record of input.outbound) this.outbound.set(record.id, cloneOutbound(record))
    for (const value of input.seen ?? [])
      this.seen.set(seenKey(value.documentId, value.messageId), { ...value })
  }

  async markOutboundAttempt(recordIds: readonly string[], attemptedAt: number): Promise<void> {
    for (const id of recordIds) {
      const current = this.outbound.get(id)
      if (!current) continue
      this.outbound.set(id, {
        ...cloneOutbound(current),
        state: 'attempted',
        attempts: (current.attempts ?? 0) + 1,
        lastAttemptAt: attemptedAt
      })
    }
  }

  async compactOutbound(documentId: string, policy: CheckpointPolicy): Promise<void> {
    const records = [...this.outbound.values()]
      .filter((record) => record.documentId === documentId)
      .sort((a, b) => a.createdAt - b.createdAt)
    const keep = new Set(
      records.slice(-Math.max(0, policy.retainAtLeast ?? 0)).map((record) => record.id)
    )
    const safe = new Set(policy.safeRecordIds)
    for (const record of records)
      if (safe.has(record.id) && !keep.has(record.id)) this.outbound.delete(record.id)
  }

  async hasSeen(documentId: string, messageId: string, now = this.now()): Promise<boolean> {
    const key = seenKey(documentId, messageId)
    const value = this.seen.get(key)
    if (!value) return false
    if (this.isSeenMessageExpired(value, now)) {
      this.seen.delete(key)
      return false
    }
    return true
  }

  async pruneSeenMessages(now = this.now()): Promise<number> {
    let removed = 0
    for (const [key, value] of this.seen) {
      if (!this.isSeenMessageExpired(value, now)) continue
      this.seen.delete(key)
      removed += 1
    }
    return removed
  }

  async close(): Promise<void> {}

  private isSeenMessageExpired(value: SeenMessage, now: number): boolean {
    return value.seenAt <= now - this.seenMessageTtlMs
  }
}

export function cloneDocument(value: StoredDocument): StoredDocument {
  return {
    ...value,
    snapshot: new Uint8Array(value.snapshot),
    ...(value.metadata === undefined ? {} : { metadata: { ...value.metadata } })
  }
}

/**
 * CRDT/content persistence must never make a session's cached metadata authoritative.
 * Existing device-local metadata wins even when it is intentionally absent.
 */
export function withPreservedDocumentMetadata(
  current: StoredDocument | undefined,
  next: StoredDocument
): StoredDocument {
  if (!current) return cloneDocument(next)
  const { metadata: _incomingMetadata, ...withoutMetadata } = next
  return cloneDocument({
    ...withoutMetadata,
    ...(current.metadata === undefined ? {} : { metadata: current.metadata })
  })
}

export function cloneOutbound(value: OutboundRecord): OutboundRecord {
  return { ...value, payload: new Uint8Array(value.payload) }
}

export function cloneAccessState(value: DocumentAccessState): DocumentAccessState {
  return {
    ...value,
    participants: value.participants.map((participant) => ({ ...participant }))
  }
}

function seenKey(documentId: string, messageId: string): string {
  return `${documentId}\u0000${messageId}`
}

export function normalizeSeenMessageTtlMs(value = DEFAULT_SEEN_MESSAGE_TTL_MS): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('seenMessageTtlMs must be a positive safe integer')
  return value
}
