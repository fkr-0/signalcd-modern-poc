import 'fake-indexeddb/auto'
import type { DocumentAccessState } from '@e2e-col/protocol'
import { describe, expect, it } from 'vitest'
import { IndexedDbCollaborativeStorage, MemoryCollaborativeStorage } from './index'

const access: DocumentAccessState = {
  selfRole: 'admin',
  participants: [
    { participantId: 'owner', role: 'admin', displayName: 'Owner', active: true },
    { participantId: 'reader', role: 'reader', active: true }
  ],
  archived: false,
  deleted: false,
  revision: 2
}

for (const [name, create] of [
  ['memory', () => new MemoryCollaborativeStorage()],
  [
    'indexeddb',
    () => new IndexedDbCollaborativeStorage({ name: `e2e-col-access-${crypto.randomUUID()}` })
  ]
] as const) {
  describe(`${name} durable access-control storage`, () => {
    it('stores access state defensively per document', async () => {
      const store = create()
      await store.saveAccessControl('doc', access)
      const loaded = await store.loadAccessControl('doc')
      expect(loaded).toEqual(access)
      expect(loaded?.participants).not.toBe(access.participants)
      await store.close()
    })

    it('commits document state with outbound work and records durable dedup state', async () => {
      const store = create()
      await store.commitLocalChange({
        document: { documentId: 'doc', snapshot: new Uint8Array([1, 2]), updatedAt: 10 },
        outbound: [
          {
            id: 'message',
            documentId: 'doc',
            payload: new Uint8Array([3]),
            createdAt: 10,
            state: 'pending'
          }
        ]
      })
      expect(await store.loadDocument('doc')).toBeDefined()
      expect(await store.listOutbound('doc')).toHaveLength(1)

      await store.markOutboundAttempt(['message'], 11)
      expect(await store.listOutbound('doc')).toMatchObject([
        { id: 'message', state: 'attempted', attempts: 1, lastAttemptAt: 11 }
      ])

      await store.persistRemoteState({
        document: { documentId: 'doc', snapshot: new Uint8Array([4]), updatedAt: 12 },
        seen: [{ documentId: 'doc', messageId: 'remote', seenAt: 12 }]
      })
      expect(await store.hasSeen('doc', 'remote')).toBe(true)
      await store.close()
    })

    it('atomically tracks access changes with their outbound control record', async () => {
      const store = create()
      await store.commitAccessChange({
        documentId: 'doc',
        access,
        outbound: [
          {
            id: 'membership',
            documentId: 'doc',
            payload: new Uint8Array([7]),
            createdAt: 15,
            state: 'pending'
          }
        ]
      })
      expect(await store.loadAccessControl('doc')).toEqual(access)
      expect(await store.listOutbound('doc')).toHaveLength(1)
      await store.close()
    })
  })
}
