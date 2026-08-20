import type { DocumentAccessState, NonChunkEnvelopeKind } from '@e2e-col/protocol'

export interface DocumentMetadata {
  readonly title?: string
  readonly archived?: boolean
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
  deleteDocument(documentId: string): Promise<void>
  listDocuments(): Promise<readonly StoredDocument[]>
  enqueue(record: OutboundRecord): Promise<void>
  listOutbound(documentId?: string): Promise<readonly OutboundRecord[]>
  acknowledgeOutbound(id: string): Promise<void>
  close(): Promise<void>
}

export interface AccessControlStorage {
  loadAccessControl(documentId: string): Promise<DocumentAccessState | undefined>
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
  private readonly seen = new Map<string, SeenMessage>()
  private readonly seenMessageTtlMs: number
  private readonly now: () => number

  constructor(options: SeenMessageRetentionOptions = {}) {
    this.seenMessageTtlMs = normalizeSeenMessageTtlMs(options.seenMessageTtlMs)
    this.now = options.now ?? Date.now
  }

  async loadDocument(documentId: string): Promise<StoredDocument | undefined> {
    const value = this.documents.get(documentId)
    return value ? cloneDocument(value) : undefined
  }

  async saveDocument(document: StoredDocument): Promise<void> {
    this.documents.set(document.documentId, cloneDocument(document))
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.documents.delete(documentId)
    this.access.delete(documentId)
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
    this.documents.set(input.document.documentId, cloneDocument(input.document))
    for (const record of input.outbound) this.outbound.set(record.id, cloneOutbound(record))
  }

  async persistRemoteState(input: {
    document: StoredDocument
    seen: readonly SeenMessage[]
  }): Promise<void> {
    this.documents.set(input.document.documentId, cloneDocument(input.document))
    for (const value of input.seen)
      this.seen.set(seenKey(value.documentId, value.messageId), { ...value })
  }

  async commitAccessChange(input: {
    documentId: string
    access: DocumentAccessState
    outbound: readonly OutboundRecord[]
    seen?: readonly SeenMessage[]
  }): Promise<void> {
    this.access.set(input.documentId, cloneAccessState(input.access))
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
