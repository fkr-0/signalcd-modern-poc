import 'fake-indexeddb/auto'
import type { DocumentAccessState } from '@e2e-col/protocol'
import { describe, expect, it } from 'vitest'
import { IndexedDbCollaborativeStorage, MemoryCollaborativeStorage } from './index'
import {
  cloneAccessState,
  DEFAULT_SEEN_MESSAGE_TTL_MS,
  normalizeSeenMessageTtlMs,
  type OutboundRecord,
  type StoredAuthorizationState
} from './storage'

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

const authorization: StoredAuthorizationState = {
  version: 2,
  anchorHead: '00'.repeat(32),
  anchorAccess: { ...access, revision: 0 },
  head: '11'.repeat(32),
  records: [
    {
      controlId: '11'.repeat(32),
      kind: 'archive',
      predecessor: '00'.repeat(32),
      revision: 1,
      senderId: 'owner',
      messageId: 'control-message',
      payload: new Uint8Array([1, 2, 3]),
      receivedAt: 20,
      resultingAccess: { ...access, revision: 1, authorizationHead: '11'.repeat(32) }
    }
  ],
  pending: []
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

    it('preserves authorization history when ordinary access metadata is refreshed', async () => {
      const store = create()
      await store.commitAccessChange({
        documentId: 'auth-preserve',
        access,
        authorization,
        outbound: []
      })
      await store.saveAccessControl('auth-preserve', { ...access, archived: true })
      expect(await store.loadAuthorizationState('auth-preserve')).toEqual(authorization)
      await store.close()
    })

    it('persists replay-safe authorization history atomically with access state', async () => {
      const store = create()
      await store.commitAccessChange({
        documentId: 'auth-doc',
        access,
        authorization,
        outbound: []
      })
      const loaded = await store.loadAuthorizationState('auth-doc')
      expect(loaded).toEqual(authorization)
      expect(loaded?.records[0]?.payload).not.toBe(authorization.records[0]?.payload)
      expect(loaded?.records[0]?.resultingAccess.participants).not.toBe(
        authorization.records[0]?.resultingAccess.participants
      )
      await store.close()
    })

    it('expires durable dedup entries according to the configured TTL', async () => {
      let now = 1_000
      const store =
        name === 'memory'
          ? new MemoryCollaborativeStorage({ seenMessageTtlMs: 100, now: () => now })
          : new IndexedDbCollaborativeStorage({
              name: `e2e-col-seen-ttl-${crypto.randomUUID()}`,
              seenMessageTtlMs: 100,
              now: () => now
            })
      await store.persistRemoteState({
        document: { documentId: 'doc', snapshot: new Uint8Array([1]), updatedAt: now },
        seen: [{ documentId: 'doc', messageId: 'ttl-message', seenAt: now }]
      })
      expect(await store.hasSeen('doc', 'ttl-message')).toBe(true)

      now = 1_100
      expect(await store.pruneSeenMessages()).toBe(1)
      expect(await store.hasSeen('doc', 'ttl-message')).toBe(false)
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

      const seenAt = Date.now()
      await store.persistRemoteState({
        document: { documentId: 'doc', snapshot: new Uint8Array([4]), updatedAt: seenAt },
        seen: [{ documentId: 'doc', messageId: 'remote', seenAt }]
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

describe('IndexedDbCollaborativeStorage dedup retention', () => {
  it('keeps seen-message dedup durable across a database restart', async () => {
    const name = `e2e-col-seen-restart-${crypto.randomUUID()}`
    let now = 5_000
    const first = new IndexedDbCollaborativeStorage({
      name,
      seenMessageTtlMs: 1_000,
      now: () => now
    })
    await first.persistRemoteState({
      document: { documentId: 'doc', snapshot: new Uint8Array([1]), updatedAt: now },
      seen: [{ documentId: 'doc', messageId: 'duplicate-after-restart', seenAt: now }]
    })
    await first.close()

    now += 500
    const reopened = new IndexedDbCollaborativeStorage({
      name,
      seenMessageTtlMs: 1_000,
      now: () => now
    })
    expect(await reopened.pruneSeenMessages()).toBe(0)
    expect(await reopened.hasSeen('doc', 'duplicate-after-restart')).toBe(true)
    await reopened.close()
  })

  it('migrates an existing seen-message store by adding the TTL index', async () => {
    const name = `e2e-col-seen-migration-${crypto.randomUUID()}`
    const legacy = indexedDB.open(name, 2)
    await new Promise<void>((resolve, reject) => {
      legacy.onupgradeneeded = () => {
        const db = legacy.result
        db.createObjectStore('documents', { keyPath: 'documentId' })
        db.createObjectStore('outbound', { keyPath: 'id' })
        db.createObjectStore('access_control', { keyPath: 'documentId' })
        db.createObjectStore('seen_messages', { keyPath: 'key' })
      }
      legacy.onsuccess = () => {
        legacy.result.close()
        resolve()
      }
      legacy.onerror = () => reject(legacy.error)
    })

    const store = new IndexedDbCollaborativeStorage({ name })
    await expect(store.pruneSeenMessages()).resolves.toBe(0)
    await store.close()
  })
})

describe('normalizeSeenMessageTtlMs', () => {
  it('returns the 24-hour default when no value is provided', () => {
    expect(normalizeSeenMessageTtlMs()).toBe(DEFAULT_SEEN_MESSAGE_TTL_MS)
    expect(normalizeSeenMessageTtlMs()).toBe(86_400_000)
  })

  it('accepts a custom positive integer TTL', () => {
    expect(normalizeSeenMessageTtlMs(500)).toBe(500)
    expect(normalizeSeenMessageTtlMs(1)).toBe(1)
  })

  it('rejects zero, negative, fractional, and unsafe values', () => {
    expect(() => normalizeSeenMessageTtlMs(0)).toThrow(/positive safe integer/)
    expect(() => normalizeSeenMessageTtlMs(-1)).toThrow(/positive safe integer/)
    expect(() => normalizeSeenMessageTtlMs(1.5)).toThrow(/positive safe integer/)
    expect(() => normalizeSeenMessageTtlMs(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /positive safe integer/
    )
    expect(() => normalizeSeenMessageTtlMs(Number.NaN)).toThrow(/positive safe integer/)
    expect(() => normalizeSeenMessageTtlMs(Number.POSITIVE_INFINITY)).toThrow(
      /positive safe integer/
    )
  })
})

describe('MemoryCollaborativeStorage seen-message TTL', () => {
  it('uses the default 24-hour TTL when no options are provided', async () => {
    const store = new MemoryCollaborativeStorage()
    const now = Date.now()
    await store.persistRemoteState({
      document: { documentId: 'doc', snapshot: new Uint8Array([1]), updatedAt: now },
      seen: [{ documentId: 'doc', messageId: 'recent', seenAt: now }]
    })
    expect(await store.hasSeen('doc', 'recent')).toBe(true)

    const oldEnoughToExpire = now - DEFAULT_SEEN_MESSAGE_TTL_MS - 1
    await store.persistRemoteState({
      document: { documentId: 'doc', snapshot: new Uint8Array([1]), updatedAt: now },
      seen: [{ documentId: 'doc', messageId: 'old', seenAt: oldEnoughToExpire }]
    })
    expect(await store.hasSeen('doc', 'old')).toBe(false)
  })

  it('prunes multiple expired entries and returns the removal count', async () => {
    let now = 10_000
    const store = new MemoryCollaborativeStorage({ seenMessageTtlMs: 500, now: () => now })
    await store.persistRemoteState({
      document: { documentId: 'doc', snapshot: new Uint8Array([1]), updatedAt: now },
      seen: [
        { documentId: 'doc', messageId: 'a', seenAt: now - 600 },
        { documentId: 'doc', messageId: 'b', seenAt: now - 501 },
        { documentId: 'doc', messageId: 'c', seenAt: now - 100 }
      ]
    })
    expect(await store.hasSeen('doc', 'a')).toBe(false)
    expect(await store.hasSeen('doc', 'b')).toBe(false)
    expect(await store.hasSeen('doc', 'c')).toBe(true)

    now = 10_000
    await store.persistRemoteState({
      document: { documentId: 'doc', snapshot: new Uint8Array([1]), updatedAt: now },
      seen: [
        { documentId: 'doc', messageId: 'd', seenAt: now - 600 },
        { documentId: 'doc', messageId: 'e', seenAt: now - 501 }
      ]
    })
    expect(await store.pruneSeenMessages(now)).toBe(2)
    expect(await store.hasSeen('doc', 'c')).toBe(true)
  })
})

describe('IndexedDbCollaborativeStorage transaction boundaries', () => {
  it('rolls back the snapshot when an outbound write cannot be queued', async () => {
    const store = new IndexedDbCollaborativeStorage({
      name: `e2e-col-atomic-${crypto.randomUUID()}`
    })
    const malformed = {
      documentId: 'atomic-doc',
      payload: new Uint8Array([9]),
      createdAt: 1,
      state: 'pending'
    } as unknown as OutboundRecord

    await expect(
      store.commitLocalChange({
        document: {
          documentId: 'atomic-doc',
          snapshot: new Uint8Array([1, 2, 3]),
          updatedAt: 1
        },
        outbound: [malformed]
      })
    ).rejects.toBeDefined()

    // Let the aborted/failed transaction settle before observing another one.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(await store.loadDocument('atomic-doc')).toBeUndefined()
    await store.close()
  })
})
