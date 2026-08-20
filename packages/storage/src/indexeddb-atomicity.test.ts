import { indexedDB as baseIndexedDb } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { IndexedDbCollaborativeStorage } from './indexeddb'

type FailingStore = 'outbound' | 'seen_messages'

function createFailingIndexedDbFactory(failingStore: FailingStore): IDBFactory {
  const wrapStore = (store: IDBObjectStore): IDBObjectStore =>
    new Proxy(store, {
      get(target, property) {
        if (property === 'put' && target.name === failingStore) {
          return () => {
            throw new DOMException(`Injected ${failingStore} write failure`, 'AbortError')
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as IDBObjectStore

  const wrapTransaction = (transaction: IDBTransaction): IDBTransaction =>
    new Proxy(transaction, {
      get(target, property) {
        if (property === 'objectStore') {
          return (name: string) => wrapStore(target.objectStore(name))
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target)
      }
    }) as IDBTransaction

  const wrapDatabase = (database: IDBDatabase): IDBDatabase =>
    new Proxy(database, {
      get(target, property) {
        if (property === 'transaction') {
          return (storeNames: string | string[], mode?: IDBTransactionMode) =>
            wrapTransaction(target.transaction(storeNames, mode))
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as IDBDatabase

  const wrapOpenRequest = (openRequest: IDBOpenDBRequest): IDBOpenDBRequest =>
    new Proxy(openRequest, {
      get(target, property) {
        if (property === 'result') return wrapDatabase(target.result)
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
      set(target, property, value) {
        return Reflect.set(target, property, value, target)
      }
    }) as IDBOpenDBRequest

  return new Proxy(baseIndexedDb, {
    get(target, property) {
      if (property === 'open') {
        return (name: string, version?: number) =>
          wrapOpenRequest(version === undefined ? target.open(name) : target.open(name, version))
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }) as IDBFactory
}

async function settleAbortedTransaction(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('IndexedDbCollaborativeStorage atomicity', () => {
  it('does not persist a local snapshot when the outbound write fails', async () => {
    const store = new IndexedDbCollaborativeStorage({
      name: `e2e-col-local-atomicity-${crypto.randomUUID()}`,
      indexedDB: createFailingIndexedDbFactory('outbound')
    })

    await expect(
      store.commitLocalChange({
        document: {
          documentId: 'local-doc',
          snapshot: new Uint8Array([1, 2, 3]),
          updatedAt: 1
        },
        outbound: [
          {
            id: 'local-message',
            documentId: 'local-doc',
            payload: new Uint8Array([4, 5]),
            createdAt: 1,
            state: 'pending'
          }
        ]
      })
    ).rejects.toThrow('Injected outbound write failure')

    await settleAbortedTransaction()
    expect(await store.loadDocument('local-doc')).toBeUndefined()
    expect(await store.listOutbound('local-doc')).toEqual([])
    await store.close()
  })

  it('does not persist a remote snapshot when the seen-message write fails', async () => {
    const store = new IndexedDbCollaborativeStorage({
      name: `e2e-col-remote-atomicity-${crypto.randomUUID()}`,
      indexedDB: createFailingIndexedDbFactory('seen_messages')
    })

    await expect(
      store.persistRemoteState({
        document: {
          documentId: 'remote-doc',
          snapshot: new Uint8Array([7, 8, 9]),
          updatedAt: 2
        },
        seen: [{ documentId: 'remote-doc', messageId: 'remote-message', seenAt: 2 }]
      })
    ).rejects.toThrow('Injected seen_messages write failure')

    await settleAbortedTransaction()
    expect(await store.loadDocument('remote-doc')).toBeUndefined()
    expect(await store.hasSeen('remote-doc', 'remote-message')).toBe(false)
    await store.close()
  })
})
