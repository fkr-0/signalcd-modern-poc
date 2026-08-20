import 'fake-indexeddb/auto'
import type { DocumentAccessState } from '@e2e-col/protocol'
import { describe, expect, it } from 'vitest'
import { IndexedDbCollaborativeStorage, MemoryCollaborativeStorage } from './index'
import { cloneAccessState } from './storage'

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

    it('returns undefined for a non-existent document access control', async () => {
      const store = create()
      expect(await store.loadAccessControl('does-not-exist')).toBeUndefined()
      await store.close()
    })

    it('save then load round-trips access control data', async () => {
      const store = create()
      const state: DocumentAccessState = {
        selfRole: 'writer',
        participants: [
          { participantId: 'alice', role: 'admin', displayName: 'Alice', active: true },
          { participantId: 'bob', role: 'writer', active: false }
        ],
        archived: true,
        deleted: false,
        revision: 7
      }
      await store.saveAccessControl('roundtrip', state)
      const loaded = await store.loadAccessControl('roundtrip')
      expect(loaded).toEqual(state)
      expect(loaded).not.toBe(state)
      await store.close()
    })

    it('overwrites previous access control on repeated save', async () => {
      const store = create()
      const first: DocumentAccessState = {
        selfRole: 'reader',
        participants: [{ participantId: 'alice', role: 'admin', active: true }],
        archived: false,
        deleted: false,
        revision: 1
      }
      const second: DocumentAccessState = {
        selfRole: 'admin',
        participants: [
          { participantId: 'alice', role: 'admin', active: true },
          { participantId: 'bob', role: 'reader', active: true }
        ],
        archived: true,
        deleted: false,
        revision: 5
      }
      await store.saveAccessControl('doc', first)
      await store.saveAccessControl('doc', second)
      const loaded = await store.loadAccessControl('doc')
      expect(loaded).toEqual(second)
      expect(loaded?.revision).toBe(5)
      await store.close()
    })
  })
}

describe('cloneAccessState', () => {
  it('produces an independent copy of participants array', () => {
    const original: DocumentAccessState = {
      selfRole: 'admin',
      participants: [
        { participantId: 'alice', role: 'admin', active: true },
        { participantId: 'bob', role: 'writer', active: true }
      ],
      archived: false,
      deleted: false,
      revision: 3
    }
    const cloned = cloneAccessState(original)

    expect(cloned).toEqual(original)
    expect(cloned).not.toBe(original)
    expect(cloned.participants).not.toBe(original.participants)
    expect(cloned.participants[0]).not.toBe(original.participants[0])
    expect(cloned.participants[1]).not.toBe(original.participants[1])
  })

  it('mutations to cloned state do not affect original', () => {
    const original: DocumentAccessState = {
      selfRole: 'admin',
      participants: [{ participantId: 'alice', role: 'admin', active: true }],
      archived: false,
      deleted: false,
      revision: 1
    }
    const cloned = cloneAccessState(original)
    const mutableParticipant = cloned.participants[0] as { role: string; active: boolean }
    mutableParticipant.role = 'reader'
    mutableParticipant.active = false

    expect(original.participants[0]!.role).toBe('admin')
    expect(original.participants[0]!.active).toBe(true)
  })
})
