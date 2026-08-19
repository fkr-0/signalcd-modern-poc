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
