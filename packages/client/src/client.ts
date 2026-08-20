import { CollaborativeDocument } from '@e2e-col/core'
import type { DocumentAccessState } from '@e2e-col/protocol'
import type { StoredDocument } from '@e2e-col/storage'
import { DocumentSession } from './session'
import type { CollaborativeClientOptions, CreateDocumentOptions, DocumentSummary } from './types'

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

  async createDocument(options: CreateDocumentOptions = {}): Promise<DocumentSession> {
    this.assertOpen()
    const documentId = options.documentId ?? this.createDocumentId()
    if (this.sessions.has(documentId)) throw new Error(`document ${documentId} is already open`)
    if (await this.options.storage.loadDocument(documentId))
      throw new Error(`document ${documentId} already exists`)

    const createdAt = this.now()
    const access: DocumentAccessState = {
      selfRole: 'admin',
      participants: [{ participantId: this.options.senderId, role: 'admin', active: true }],
      archived: false,
      deleted: false,
      revision: 0
    }
    const document = new CollaborativeDocument()
    const stored: StoredDocument = {
      documentId,
      snapshot: document.save(),
      updatedAt: createdAt,
      createdAt,
      schemaVersion: 1,
      ...(options.metadata === undefined ? {} : { metadata: options.metadata })
    }
    await this.options.storage.saveDocument(stored)
    await this.options.storage.saveAccessControl(documentId, access)

    const session = await this.openSession(documentId)
    if (options.initialText) await session.editText(options.initialText)
    return session
  }

  async openDocument(documentId: string): Promise<DocumentSession> {
    this.assertOpen()
    const current = this.sessions.get(documentId)
    if (current) return current
    return this.openSession(documentId)
  }

  async listDocuments(): Promise<readonly DocumentSummary[]> {
    this.assertOpen()
    const documents = await this.options.storage.listDocuments()
    return Promise.all(
      documents.map(async (document) => {
        const access = await this.options.storage.loadAccessControl(document.documentId)
        return {
          documentId: document.documentId,
          ...(document.metadata?.title === undefined ? {} : { title: document.metadata.title }),
          updatedAt: document.updatedAt,
          archived: access?.archived ?? document.metadata?.archived ?? false
        }
      })
    )
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled([...this.sessions.values()].map((session) => session.close()))
    this.sessions.clear()
    await this.options.storage.close()
  }

  private async openSession(documentId: string): Promise<DocumentSession> {
    const session = new DocumentSession({
      documentId,
      senderId: this.options.senderId,
      transport: this.options.transportFactory({ documentId }),
      storage: this.options.storage,
      now: this.now,
      createMessageId: this.createMessageId,
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

function createId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function')
    throw new Error('crypto.randomUUID is required')
  return globalThis.crypto.randomUUID()
}
