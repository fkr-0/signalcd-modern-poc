export interface StoredDocument {
  readonly documentId: string
  readonly snapshot: Uint8Array
  readonly updatedAt: number
}

export interface OutboundRecord {
  readonly id: string
  readonly documentId: string
  readonly payload: Uint8Array
  readonly createdAt: number
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

export class MemoryCollaborativeStorage implements CollaborativeStorage {
  private readonly documents = new Map<string, StoredDocument>()
  private readonly outbound = new Map<string, OutboundRecord>()

  async loadDocument(documentId: string): Promise<StoredDocument | undefined> {
    const value = this.documents.get(documentId)
    return value ? cloneDocument(value) : undefined
  }

  async saveDocument(document: StoredDocument): Promise<void> {
    this.documents.set(document.documentId, cloneDocument(document))
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.documents.delete(documentId)
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

  async close(): Promise<void> {}
}

export function cloneDocument(value: StoredDocument): StoredDocument {
  return { ...value, snapshot: new Uint8Array(value.snapshot) }
}

export function cloneOutbound(value: OutboundRecord): OutboundRecord {
  return { ...value, payload: new Uint8Array(value.payload) }
}
