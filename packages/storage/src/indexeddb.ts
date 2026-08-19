import {
  cloneDocument,
  cloneOutbound,
  type CollaborativeStorage,
  type OutboundRecord,
  type StoredDocument
} from './storage'

const SCHEMA_VERSION = 1
const DOCUMENTS = 'documents'
const OUTBOUND = 'outbound'

export interface IndexedDbStorageOptions {
  readonly name?: string
  readonly indexedDB?: IDBFactory
}

export class IndexedDbCollaborativeStorage implements CollaborativeStorage {
  private readonly dbPromise: Promise<IDBDatabase>

  constructor(options: IndexedDbStorageOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB
    if (!factory) throw new Error('IndexedDB is unavailable')
    this.dbPromise = openDatabase(factory, options.name ?? 'e2e-col')
  }

  async loadDocument(documentId: string): Promise<StoredDocument | undefined> {
    const value = await request<StoredDocument | undefined>(
      (await this.dbPromise).transaction(DOCUMENTS).objectStore(DOCUMENTS).get(documentId)
    )
    return value ? cloneDocument(value) : undefined
  }

  async saveDocument(document: StoredDocument): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction(DOCUMENTS, 'readwrite')
    tx.objectStore(DOCUMENTS).put(cloneDocument(document))
    await complete(tx)
  }

  async deleteDocument(documentId: string): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction(DOCUMENTS, 'readwrite')
    tx.objectStore(DOCUMENTS).delete(documentId)
    await complete(tx)
  }

  async listDocuments(): Promise<readonly StoredDocument[]> {
    const values = await request<StoredDocument[]>(
      (await this.dbPromise).transaction(DOCUMENTS).objectStore(DOCUMENTS).getAll()
    )
    return values.map(cloneDocument).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async enqueue(record: OutboundRecord): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction(OUTBOUND, 'readwrite')
    tx.objectStore(OUTBOUND).put(cloneOutbound(record))
    await complete(tx)
  }

  async listOutbound(documentId?: string): Promise<readonly OutboundRecord[]> {
    const values = await request<OutboundRecord[]>(
      (await this.dbPromise).transaction(OUTBOUND).objectStore(OUTBOUND).getAll()
    )
    return values
      .filter((record) => documentId === undefined || record.documentId === documentId)
      .map(cloneOutbound)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  async acknowledgeOutbound(id: string): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction(OUTBOUND, 'readwrite')
    tx.objectStore(OUTBOUND).delete(id)
    await complete(tx)
  }

  async close(): Promise<void> {
    ;(await this.dbPromise).close()
  }
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, SCHEMA_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(DOCUMENTS))
        db.createObjectStore(DOCUMENTS, { keyPath: 'documentId' })
      if (!db.objectStoreNames.contains(OUTBOUND)) db.createObjectStore(OUTBOUND, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result)
    value.onerror = () => reject(value.error ?? new Error('IndexedDB request failed'))
  })
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
  })
}
