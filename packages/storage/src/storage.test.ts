import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { IndexedDbCollaborativeStorage, MemoryCollaborativeStorage } from './index'

for (const [name, create] of [
  ['memory', () => new MemoryCollaborativeStorage()],
  ['indexeddb', () => new IndexedDbCollaborativeStorage({ name: `e2e-col-${crypto.randomUUID()}` })]
] as const) {
  describe(`${name} collaborative storage`, () => {
    it('persists snapshots defensively', async () => {
      const store = create()
      const snapshot = new Uint8Array([1, 2, 3])
      await store.saveDocument({ documentId: 'doc', snapshot, updatedAt: 2 })
      snapshot[0] = 9
      expect([...(await store.loadDocument('doc'))!.snapshot]).toEqual([1, 2, 3])
      await store.close()
    })

    it('updates local metadata without changing snapshot bytes or additive metadata', async () => {
      const store = create()
      await store.saveDocument({
        documentId: 'metadata-doc',
        snapshot: new Uint8Array([1, 3, 3, 7]),
        updatedAt: 10,
        createdAt: 4,
        schemaVersion: 1,
        metadata: { title: 'Old title', category: 'notes', pinned: true }
      })
      const before = await store.loadDocument('metadata-doc')

      const renamed = await store.updateDocumentMetadata(
        'metadata-doc',
        { title: 'Renamed locally' },
        20
      )
      expect(renamed).toMatchObject({
        documentId: 'metadata-doc',
        updatedAt: 20,
        createdAt: 4,
        schemaVersion: 1,
        metadata: { title: 'Renamed locally', category: 'notes', pinned: true }
      })
      expect(renamed.snapshot).toEqual(before?.snapshot)

      const cleared = await store.updateDocumentMetadata('metadata-doc', { title: null }, 30)
      expect(cleared.metadata).toEqual({ category: 'notes', pinned: true })
      expect(cleared.snapshot).toEqual(before?.snapshot)

      await store.updateDocumentMetadata('metadata-doc', { title: 'Durable local title' }, 40)
      await store.commitLocalChange({
        document: {
          documentId: 'metadata-doc',
          snapshot: new Uint8Array([2, 4, 6, 8]),
          updatedAt: 50,
          metadata: { title: 'stale cached title', category: 'stale' }
        },
        outbound: []
      })
      expect(await store.loadDocument('metadata-doc')).toMatchObject({
        snapshot: new Uint8Array([2, 4, 6, 8]),
        metadata: { title: 'Durable local title', category: 'notes', pinned: true }
      })

      await store.persistRemoteState({
        document: {
          documentId: 'metadata-doc',
          snapshot: new Uint8Array([8, 6, 4, 2]),
          updatedAt: 60,
          metadata: { title: 'stale remote title' }
        },
        seen: []
      })
      expect(await store.loadDocument('metadata-doc')).toMatchObject({
        snapshot: new Uint8Array([8, 6, 4, 2]),
        metadata: { title: 'Durable local title', category: 'notes', pinned: true }
      })
      await store.close()
    })

    it('rejects metadata updates for missing documents', async () => {
      const store = create()
      await expect(
        store.updateDocumentMetadata('missing-metadata-doc', { title: 'Nope' }, 1)
      ).rejects.toThrow('does not exist')
      expect(await store.listDocuments()).toEqual([])
      await store.close()
    })

    it('keeps and acknowledges durable outbound work', async () => {
      const store = create()
      await store.enqueue({
        id: 'a',
        documentId: 'doc',
        payload: new Uint8Array([4]),
        createdAt: 1
      })
      expect(await store.listOutbound('doc')).toHaveLength(1)
      await store.acknowledgeOutbound('a')
      expect(await store.listOutbound('doc')).toHaveLength(0)
      await store.close()
    })
  })
}
