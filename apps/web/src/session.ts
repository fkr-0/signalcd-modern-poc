import { CollaborativeDocument } from '@e2e-col/core'
import { createEnvelope, DedupCache, decodeEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { IndexedDbCollaborativeStorage } from '@e2e-col/storage'
import type { CollaborativeTransport } from '@e2e-col/transport'

type Subscriber = (text: string) => void

export class BrowserReplicaSession {
  private readonly dedup = new DedupCache()
  private readonly storage: IndexedDbCollaborativeStorage
  private sequence = 0
  private unsubscribeTransport?: () => void

  private constructor(
    private readonly document: CollaborativeDocument,
    private readonly transport: CollaborativeTransport,
    private readonly documentId: string,
    private readonly senderId: string,
    storageName: string
  ) {
    this.storage = new IndexedDbCollaborativeStorage({ name: storageName })
  }

  static async open(options: {
    documentId: string
    senderId: string
    transport: CollaborativeTransport
    storageName: string
  }): Promise<BrowserReplicaSession> {
    const bootstrapStorage = new IndexedDbCollaborativeStorage({ name: options.storageName })
    const stored = await bootstrapStorage.loadDocument(options.documentId)
    await bootstrapStorage.close()
    const session = new BrowserReplicaSession(
      new CollaborativeDocument(stored?.snapshot),
      options.transport,
      options.documentId,
      options.senderId,
      options.storageName
    )
    await session.connect()
    return session
  }

  getText(): string {
    return this.document.getText()
  }

  subscribe(listener: Subscriber): () => void {
    return this.document.subscribe(listener)
  }

  async editText(text: string): Promise<void> {
    const changes = this.document.editText(text)
    await this.persist()
    for (const change of changes) await this.sendChange(change)
  }

  async close(): Promise<void> {
    this.unsubscribeTransport?.()
    await this.persist()
    await this.transport.close()
    await this.storage.close()
  }

  private async connect(): Promise<void> {
    await this.transport.connect(this.documentId)
    this.unsubscribeTransport = this.transport.subscribe((wire) => {
      try {
        const envelope = decodeEnvelope(wire)
        if (envelope.documentId !== this.documentId || envelope.kind !== 'automerge-change') return
        if (this.dedup.hasOrAdd(envelope, envelope.createdAt)) return
        if (this.document.applyChanges([envelope.payload])) void this.persist()
      } catch {
        // Invalid transport input is deliberately ignored at this trust boundary.
      }
    })
    for (const record of await this.storage.listOutbound(this.documentId)) {
      try {
        await this.transport.send(record.payload)
        await this.storage.acknowledgeOutbound(record.id)
      } catch {
        break
      }
    }
  }

  private async sendChange(change: Uint8Array): Promise<void> {
    this.sequence += 1
    const messageId = crypto.randomUUID()
    const wire = encodeEnvelope(
      createEnvelope({
        documentId: this.documentId,
        messageId,
        senderId: this.senderId,
        kind: 'automerge-change',
        createdAt: Date.now(),
        sequence: this.sequence,
        payload: change
      })
    )
    await this.storage.enqueue({
      id: messageId,
      documentId: this.documentId,
      payload: wire,
      createdAt: Date.now()
    })
    await this.transport.send(wire)
    await this.storage.acknowledgeOutbound(messageId)
  }

  private async persist(): Promise<void> {
    await this.storage.saveDocument({
      documentId: this.documentId,
      snapshot: this.document.save(),
      updatedAt: Date.now()
    })
  }
}
