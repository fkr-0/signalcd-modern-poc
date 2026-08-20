import type { DocumentAccessState } from '@e2e-col/protocol'
import {
  type CheckpointPolicy,
  cloneAccessState,
  cloneDocument,
  cloneOutbound,
  type DurableCollaborativeStorage,
  type OutboundRecord,
  type SeenMessage,
  type StoredDocument
} from './storage'

const SCHEMA_VERSION = 2
const DOCUMENTS = 'documents'
const OUTBOUND = 'outbound'
const ACCESS_CONTROL = 'access_control'
const SEEN = 'seen_messages'

interface StoredAccessControl {
  readonly documentId: string
  readonly state: DocumentAccessState
}

interface StoredSeenMessage extends SeenMessage {
  readonly key: string
}

export interface IndexedDbStorageOptions {
  readonly name?: string
  readonly indexedDB?: IDBFactory
}

export class IndexedDbCollaborativeStorage implements DurableCollaborativeStorage {
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
    const tx = db.transaction([DOCUMENTS, ACCESS_CONTROL], 'readwrite')
    tx.objectStore(DOCUMENTS).delete(documentId)
    tx.objectStore(ACCESS_CONTROL).delete(documentId)
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

  async loadAccessControl(documentId: string): Promise<DocumentAccessState | undefined> {
    const value = await request<StoredAccessControl | undefined>(
      (await this.dbPromise).transaction(ACCESS_CONTROL).objectStore(ACCESS_CONTROL).get(documentId)
    )
    return value ? cloneAccessState(value.state) : undefined
  }

  async saveAccessControl(documentId: string, state: DocumentAccessState): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction(ACCESS_CONTROL, 'readwrite')
    tx.objectStore(ACCESS_CONTROL).put({ documentId, state: cloneAccessState(state) })
    await complete(tx)
  }

  async commitLocalChange(input: {
    document: StoredDocument
    outbound: readonly OutboundRecord[]
  }): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction([DOCUMENTS, OUTBOUND], 'readwrite')
    tx.objectStore(DOCUMENTS).put(cloneDocument(input.document))
    const outbound = tx.objectStore(OUTBOUND)
    for (const record of input.outbound) outbound.put(cloneOutbound(record))
    await complete(tx)
  }

  async persistRemoteState(input: {
    document: StoredDocument
    seen: readonly SeenMessage[]
  }): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction([DOCUMENTS, SEEN], 'readwrite')
    tx.objectStore(DOCUMENTS).put(cloneDocument(input.document))
    const seen = tx.objectStore(SEEN)
    for (const value of input.seen) {
      const stored: StoredSeenMessage = {
        ...value,
        key: seenKey(value.documentId, value.messageId)
      }
      seen.put(stored)
    }
    await complete(tx)
  }

  async commitAccessChange(input: {
    documentId: string
    access: DocumentAccessState
    outbound: readonly OutboundRecord[]
    seen?: readonly SeenMessage[]
  }): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction([ACCESS_CONTROL, OUTBOUND, SEEN], 'readwrite')
    tx.objectStore(ACCESS_CONTROL).put({
      documentId: input.documentId,
      state: cloneAccessState(input.access)
    })
    const outbound = tx.objectStore(OUTBOUND)
    for (const record of input.outbound) outbound.put(cloneOutbound(record))
    const seen = tx.objectStore(SEEN)
    for (const value of input.seen ?? []) {
      const stored: StoredSeenMessage = {
        ...value,
        key: seenKey(value.documentId, value.messageId)
      }
      seen.put(stored)
    }
    await complete(tx)
  }

  async markOutboundAttempt(recordIds: readonly string[], attemptedAt: number): Promise<void> {
    if (recordIds.length === 0) return
    const db = await this.dbPromise
    const tx = db.transaction(OUTBOUND, 'readwrite')
    const store = tx.objectStore(OUTBOUND)
    for (const id of recordIds) {
      const current = await request<OutboundRecord | undefined>(store.get(id))
      if (!current) continue
      store.put({
        ...cloneOutbound(current),
        state: 'attempted',
        attempts: (current.attempts ?? 0) + 1,
        lastAttemptAt: attemptedAt
      })
    }
    await complete(tx)
  }

  async compactOutbound(documentId: string, policy: CheckpointPolicy): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction(OUTBOUND, 'readwrite')
    const store = tx.objectStore(OUTBOUND)
    const records = (await request<OutboundRecord[]>(store.getAll()))
      .filter((record) => record.documentId === documentId)
      .sort((a, b) => a.createdAt - b.createdAt)
    const keep = new Set(
      records.slice(-Math.max(0, policy.retainAtLeast ?? 0)).map((record) => record.id)
    )
    const safe = new Set(policy.safeRecordIds)
    for (const record of records)
      if (safe.has(record.id) && !keep.has(record.id)) store.delete(record.id)
    await complete(tx)
  }

  async hasSeen(documentId: string, messageId: string): Promise<boolean> {
    const value = await request<StoredSeenMessage | undefined>(
      (await this.dbPromise).transaction(SEEN).objectStore(SEEN).get(seenKey(documentId, messageId))
    )
    return value !== undefined
  }

  async close(): Promise<void> {
    ;(await this.dbPromise).close()
  }
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const openRequest = factory.open(name, SCHEMA_VERSION)
    openRequest.onupgradeneeded = () => {
      const db = openRequest.result
      if (!db.objectStoreNames.contains(DOCUMENTS))
        db.createObjectStore(DOCUMENTS, { keyPath: 'documentId' })
      if (!db.objectStoreNames.contains(OUTBOUND)) db.createObjectStore(OUTBOUND, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(ACCESS_CONTROL))
        db.createObjectStore(ACCESS_CONTROL, { keyPath: 'documentId' })
      if (!db.objectStoreNames.contains(SEEN)) db.createObjectStore(SEEN, { keyPath: 'key' })
    }
    openRequest.onsuccess = () => resolve(openRequest.result)
    openRequest.onerror = () => reject(openRequest.error ?? new Error('IndexedDB open failed'))
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

function seenKey(documentId: string, messageId: string): string {
  return `${documentId}\u0000${messageId}`
}
