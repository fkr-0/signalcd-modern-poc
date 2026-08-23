import { CollaborativeDocument } from '@e2e-col/core'
import {
  authorizationGenesisPredecessor,
  type DocumentAccessState,
  encodeAuthorizationCommitment
} from '@e2e-col/protocol'
import type { DocumentMetadata, StoredAuthorizationState, StoredDocument } from '@e2e-col/storage'
import { DocumentSession } from './session'
import {
  type CollaborativeClientOptions,
  type CreateDocumentOptions,
  type DocumentSummary,
  MAX_DOCUMENT_TITLE_LENGTH,
  type UpdateDocumentMetadataOptions
} from './types'

export class CollaborativeClient {
  private readonly sessions = new Map<string, DocumentSession>()
  private readonly now: () => number
  private readonly createDocumentId: () => string
  private readonly createMessageId: () => string
  private closed = false

  constructor(private readonly options: CollaborativeClientOptions) {
    if (!options.senderId) throw new TypeError('senderId must be non-empty')
    const threshold = options.recovery?.snapshotThresholdOutboundEntries
    if (threshold !== undefined && (!Number.isSafeInteger(threshold) || threshold < 1))
      throw new RangeError('snapshotThresholdOutboundEntries must be a positive safe integer')
    this.now = options.clock?.now.bind(options.clock) ?? Date.now
    this.createDocumentId = options.ids?.createDocumentId.bind(options.ids) ?? createId
    this.createMessageId = options.ids?.createMessageId.bind(options.ids) ?? createId
  }

  private async summarizeDocument(document: StoredDocument): Promise<DocumentSummary> {
    const access = await this.options.storage.loadAccessControl(document.documentId)
    return {
      documentId: document.documentId,
      ...(document.metadata?.title === undefined ? {} : { title: document.metadata.title }),
      updatedAt: document.updatedAt,
      archived: access?.archived ?? document.metadata?.archived ?? false
    }
  }

  async createDocument(options: CreateDocumentOptions = {}): Promise<DocumentSession> {
    this.assertOpen()
    const documentId = options.documentId ?? this.createDocumentId()
    if (this.sessions.has(documentId)) throw new Error(`document ${documentId} is already open`)
    if (await this.options.storage.loadDocument(documentId))
      throw new Error(`document ${documentId} already exists`)

    const createdAt = this.now()
    const metadata = normalizeCreateMetadata(options.metadata)
    const access: DocumentAccessState = {
      selfRole: 'admin',
      participants: [{ participantId: this.options.senderId, role: 'admin', active: true }],
      archived: false,
      deleted: false,
      revision: 0,
      authorizationHead: encodeAuthorizationCommitment(authorizationGenesisPredecessor()),
      authorizationStatus: 'active'
    }
    const authorization: StoredAuthorizationState = {
      version: 2,
      anchorHead: access.authorizationHead!,
      anchorAccess: access,
      head: access.authorizationHead!,
      records: [],
      pending: []
    }
    const document = new CollaborativeDocument()
    const stored: StoredDocument = {
      documentId,
      snapshot: document.save(),
      updatedAt: createdAt,
      createdAt,
      schemaVersion: 1,
      ...(metadata === undefined ? {} : { metadata })
    }
    await this.options.storage.saveDocument(stored)
    await this.options.storage.commitAccessChange({
      documentId,
      access,
      authorization,
      outbound: []
    })

    const session = await this.openSession(documentId, true)
    if (options.initialText) await session.editText(options.initialText)
    return session
  }

  async openDocument(documentId: string): Promise<DocumentSession> {
    this.assertOpen()
    const current = this.sessions.get(documentId)
    if (current) return current
    return this.openSession(documentId, false)
  }

  async listDocuments(): Promise<readonly DocumentSummary[]> {
    this.assertOpen()
    const documents = await this.options.storage.listDocuments()
    return Promise.all(documents.map((document) => this.summarizeDocument(document)))
  }

  async updateDocumentMetadata(
    documentId: string,
    update: UpdateDocumentMetadataOptions
  ): Promise<DocumentSummary> {
    this.assertOpen()
    const title = normalizeDocumentTitle(update.title)
    const updatedAt = this.now()
    const document = await this.options.storage.updateDocumentMetadata(
      documentId,
      { title },
      updatedAt
    )
    this.sessions.get(documentId)?.applyDurableMetadata(document.metadata, updatedAt)
    return this.summarizeDocument(document)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close()))
    this.sessions.clear()
    await this.options.storage.close()
  }

  private async openSession(
    documentId: string,
    allowAuthorizationRootCreation: boolean
  ): Promise<DocumentSession> {
    const session = new DocumentSession({
      documentId,
      senderId: this.options.senderId,
      transport: this.options.transportFactory({ documentId }),
      storage: this.options.storage,
      now: this.now,
      createMessageId: this.createMessageId,
      allowAuthorizationRootCreation,
      ...(this.options.identity === undefined ? {} : { identity: this.options.identity }),
      replayAttemptedOnReconnect: this.options.recovery?.replayAttemptedOnReconnect ?? true,
      publishSnapshotOnRecoverySignal:
        this.options.recovery?.publishSnapshotOnRecoverySignal ?? true,
      ...(this.options.recovery?.snapshotThresholdOutboundEntries === undefined
        ? {}
        : {
            snapshotThresholdOutboundEntries: this.options.recovery.snapshotThresholdOutboundEntries
          }),
      onClosed: () => this.sessions.delete(documentId)
    })
    this.sessions.set(documentId, session)
    try {
      await session.open()
      return session
    } catch (error) {
      this.sessions.delete(documentId)
      await session.close()
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('collaborative client is closed')
  }
}

function normalizeCreateMetadata(
  metadata: DocumentMetadata | undefined
): DocumentMetadata | undefined {
  if (metadata === undefined) return undefined
  const next: Record<string, unknown> = { ...metadata }
  if (metadata.title !== undefined) {
    const title = normalizeDocumentTitle(metadata.title)
    if (title === null) delete next.title
    else next.title = title
  }
  return Object.keys(next).length === 0 ? undefined : (next as DocumentMetadata)
}

export function normalizeDocumentTitle(value: string | null): string | null {
  if (value === null) return null
  if (typeof value !== 'string') throw new TypeError('document title must be a string or null')
  const title = value.trim()
  if (title.length === 0) return null
  if (/\r|\n/u.test(title)) throw new TypeError('document title must be a single line')
  if (title.length > MAX_DOCUMENT_TITLE_LENGTH)
    throw new RangeError(`document title must be at most ${MAX_DOCUMENT_TITLE_LENGTH} characters`)
  return title
}

function createId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function')
    throw new Error('crypto.randomUUID is required')
  return globalThis.crypto.randomUUID()
}
