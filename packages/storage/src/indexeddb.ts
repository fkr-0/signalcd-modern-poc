import type { DocumentAccessState } from '@e2e-col/protocol'
import {
  type CheckpointPolicy,
  cloneAccessState,
  cloneAuthorizationState,
  cloneDocument,
  cloneOutbound,
  type DocumentMetadataUpdate,
  type DurableCollaborativeStorage,
  normalizeSeenMessageTtlMs,
  type OutboundRecord,
  type SeenMessage,
  type SeenMessageRetentionOptions,
  type StoredAuthorizationState,
  type StoredDocument,
  withDocumentMetadataUpdate,
  withPreservedDocumentMetadata
} from './storage'

const SCHEMA_VERSION = 3
const DOCUMENTS = 'documents'
const OUTBOUND = 'outbound'
const ACCESS_CONTROL = 'access_control'
const SEEN = 'seen_messages'
const SEEN_BY_TIME = 'by_seen_at'

interface StoredAccessControl {
  readonly documentId: string
  readonly state: DocumentAccessState
  readonly authorization?: StoredAuthorizationState
}

interface StoredSeenMessage extends SeenMessage {
  readonly key: string
}

export interface IndexedDbStorageOptions extends SeenMessageRetentionOptions {
  readonly name?: string
  readonly indexedDB?: IDBFactory
}

export class IndexedDbCollaborativeStorage implements DurableCollaborativeStorage {
  private readonly dbPromise: Promise<IDBDatabase>
  private readonly seenMessageTtlMs: number
  private readonly now: () => number

  constructor(options: IndexedDbStorageOptions = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB
    if (!factory) throw new Error('IndexedDB is unavailable')
    this.seenMessageTtlMs = normalizeSeenMessageTtlMs(options.seenMessageTtlMs)
    this.now = options.now ?? Date.now
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

  async updateDocumentMetadata(
    documentId: string,
    update: DocumentMetadataUpdate,
    updatedAt: number
  ): Promise<StoredDocument> {
    const db = await this.dbPromise
    const tx = db.transaction(DOCUMENTS, 'readwrite')
    const done = complete(tx)
    try {
      const store = tx.objectStore(DOCUMENTS)
      const current = await request<StoredDocument | undefined>(store.get(documentId))
      if (!current) throw new Error(`document ${documentId} does not exist`)
      const updated = withDocumentMetadataUpdate(current, update, updatedAt)
      store.put(cloneDocument(updated))
      await done
      return cloneDocument(updated)
    } catch (error) {
      abortTransaction(tx)
      await done.catch(() => undefined)
      throw error
    }
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

  async loadAuthorizationState(documentId: string): Promise<StoredAuthorizationState | undefined> {
    const value = await request<StoredAccessControl | undefined>(
      (await this.dbPromise).transaction(ACCESS_CONTROL).objectStore(ACCESS_CONTROL).get(documentId)
    )
    return value?.authorization ? cloneAuthorizationState(value.authorization) : undefined
  }

  async saveAccessControl(documentId: string, state: DocumentAccessState): Promise<void> {
    const db = await this.dbPromise
    const existing = await request<StoredAccessControl | undefined>(
      db.transaction(ACCESS_CONTROL).objectStore(ACCESS_CONTROL).get(documentId)
    )
    const tx = db.transaction(ACCESS_CONTROL, 'readwrite')
    tx.objectStore(ACCESS_CONTROL).put({
      documentId,
      state: cloneAccessState(state),
      ...(existing?.authorization === undefined
        ? {}
        : { authorization: cloneAuthorizationState(existing.authorization) })
    })
    await complete(tx)
  }

  async commitLocalChange(input: {
    document: StoredDocument
    outbound: readonly OutboundRecord[]
  }): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction([DOCUMENTS, OUTBOUND], 'readwrite')
    const done = complete(tx)
    try {
      const documents = tx.objectStore(DOCUMENTS)
      const current = await request<StoredDocument | undefined>(
        documents.get(input.document.documentId)
      )
      documents.put(withPreservedDocumentMetadata(current, input.document))
      const outbound = tx.objectStore(OUTBOUND)
      for (const record of input.outbound) outbound.put(cloneOutbound(record))
    } catch (error) {
      abortTransaction(tx)
      await done.catch(() => undefined)
      throw error
    }
    await done
  }

  async persistRemoteState(input: {
    document: StoredDocument
    seen: readonly SeenMessage[]
  }): Promise<void> {
    const db = await this.dbPromise
    const tx = db.transaction([DOCUMENTS, SEEN], 'readwrite')
    const done = complete(tx)
    try {
      const documents = tx.objectStore(DOCUMENTS)
      const current = await request<StoredDocument | undefined>(
        documents.get(input.document.documentId)
      )
      documents.put(withPreservedDocumentMetadata(current, input.document))
      const seen = tx.objectStore(SEEN)
      for (const value of input.seen) {
        const stored: StoredSeenMessage = {
          ...value,
          key: seenKey(value.documentId, value.messageId)
        }
        seen.put(stored)
      }
    } catch (error) {
      abortTransaction(tx)
      await done.catch(() => undefined)
      throw error
    }
    await done
  }

  async commitAccessChange(input: {
    documentId: string
    access: DocumentAccessState
    authorization?: StoredAuthorizationState
    outbound: readonly OutboundRecord[]
    seen?: readonly SeenMessage[]
  }): Promise<void> {
    const db = await this.dbPromise
    const existing =
      input.authorization === undefined
        ? await request<StoredAccessControl | undefined>(
            db.transaction(ACCESS_CONTROL).objectStore(ACCESS_CONTROL).get(input.documentId)
          )
        : undefined
    const tx = db.transaction([ACCESS_CONTROL, OUTBOUND, SEEN], 'readwrite')
    const done = complete(tx)
    try {
      tx.objectStore(ACCESS_CONTROL).put({
        documentId: input.documentId,
        state: cloneAccessState(input.access),
        ...(input.authorization !== undefined
          ? { authorization: cloneAuthorizationState(input.authorization) }
          : existing?.authorization === undefined
            ? {}
            : { authorization: cloneAuthorizationState(existing.authorization) })
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
    } catch (error) {
      abortTransaction(tx)
      await done.catch(() => undefined)
      throw error
    }
    await done
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

  async hasSeen(documentId: string, messageId: string, now = this.now()): Promise<boolean> {
    const db = await this.dbPromise
    const tx = db.transaction(SEEN, 'readwrite')
    const done = complete(tx)
    const store = tx.objectStore(SEEN)
    const key = seenKey(documentId, messageId)
    const value = await request<StoredSeenMessage | undefined>(store.get(key))
    const expired = value !== undefined && this.isSeenMessageExpired(value, now)
    if (expired) store.delete(key)
    await done
    return value !== undefined && !expired
  }

  async pruneSeenMessages(now = this.now()): Promise<number> {
    const db = await this.dbPromise
    const tx = db.transaction(SEEN, 'readwrite')
    const done = complete(tx)
    const index = tx.objectStore(SEEN).index(SEEN_BY_TIME)
    const cutoff = now - this.seenMessageTtlMs
    let removed = 0
    const cursorDone = new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (!cursor) {
          resolve()
          return
        }
        if (Number(cursor.key) > cutoff) {
          resolve()
          return
        }
        cursor.delete()
        removed += 1
        cursor.continue()
      }
      cursorRequest.onerror = () =>
        reject(cursorRequest.error ?? new Error('IndexedDB seen-message pruning failed'))
    })
    await Promise.all([cursorDone, done])
    return removed
  }

  async close(): Promise<void> {
    ;(await this.dbPromise).close()
  }

  private isSeenMessageExpired(value: SeenMessage, now: number): boolean {
    return value.seenAt <= now - this.seenMessageTtlMs
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
      const seen = db.objectStoreNames.contains(SEEN)
        ? openRequest.transaction!.objectStore(SEEN)
        : db.createObjectStore(SEEN, { keyPath: 'key' })
      if (!seen.indexNames.contains(SEEN_BY_TIME)) seen.createIndex(SEEN_BY_TIME, 'seenAt')
    }
    openRequest.onsuccess = () => resolve(openRequest.result)
    openRequest.onerror = () => reject(openRequest.error ?? new Error('IndexedDB open failed'))
  })
}

function abortTransaction(tx: IDBTransaction): void {
  try {
    tx.abort()
  } catch (error) {
    // Preserve the original write/setup error if the transaction was already
    // made inactive by the IndexedDB implementation.
    if (!(error instanceof DOMException && error.name === 'InvalidStateError')) throw error
  }
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
