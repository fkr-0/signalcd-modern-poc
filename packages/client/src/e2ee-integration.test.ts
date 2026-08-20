import type { DocumentParticipant } from '@e2e-col/protocol'
import { MemoryCollaborativeStorage } from '@e2e-col/storage'
import { DeterministicTransportNetwork } from '@e2e-col/transport'
import { describe, expect, it } from 'vitest'
import { CollaborativeClient } from './client'
import type { ClientIdentityAdapter } from './types'

// This suite keeps deterministic identity/transport seams for access-control coverage.
// The production-style encrypted path lives in tests/integration/e2ee-client.test.ts.
const documentId = '11111111-1111-4111-8111-111111111111'

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function identity(
  participants: readonly DocumentParticipant[] = [
    { participantId: 'alice', role: 'admin', active: true }
  ]
): ClientIdentityAdapter {
  return {
    async signControl(bytes) {
      const signature = new Uint8Array(64)
      signature.fill(bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0))
      return signature
    },
    async verifyControl(_actor, bytes, signature) {
      return signature[0] === bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0)
    },
    async resolveParticipant(phoneNumber) {
      if (phoneNumber !== '+15550000002') throw new Error('unknown participant')
      return { participantId: 'bob', displayName: 'Bob' }
    },
    async bootstrapAccess() {
      return participants
    }
  }
}

function createClient(options: {
  senderId?: string
  storage?: MemoryCollaborativeStorage
  network?: DeterministicTransportNetwork
  identity?: ClientIdentityAdapter
}) {
  const senderId = options.senderId ?? 'alice'
  const network = options.network ?? new DeterministicTransportNetwork()
  return new CollaborativeClient({
    senderId,
    storage: options.storage ?? new MemoryCollaborativeStorage(),
    identity: options.identity ?? identity(),
    transportFactory: ({ documentId: docId }) => network.createTransport(`${senderId}:${docId}`)
  })
}

describe('deterministic client integration: access and convergence', () => {
  it('converges through the deterministic client/storage/transport stack', async () => {
    const network = new DeterministicTransportNetwork()
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]

    const storageAlice = new MemoryCollaborativeStorage()
    const storageBob = new MemoryCollaborativeStorage()

    const alice = createClient({
      senderId: 'alice',
      network,
      storage: storageAlice,
      identity: identity(participants)
    })
    const bob = createClient({
      senderId: 'bob',
      network,
      storage: storageBob,
      identity: identity(participants)
    })

    // Alice creates the document
    const aliceSession = await alice.createDocument({
      documentId,
      metadata: { title: 'Shared Doc' }
    })

    // Share the initial state with Bob
    const aliceStored = await storageAlice.loadDocument(documentId)
    if (!aliceStored) throw new Error('alice document was not persisted')
    await storageBob.saveDocument(aliceStored)
    await storageBob.saveAccessControl(documentId, {
      selfRole: 'writer',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })

    // Bob opens the document
    const bobSession = await bob.openDocument(documentId)

    // Alice edits
    await aliceSession.editText('Hello from Alice')
    network.flush()
    await tick()

    // Bob receives and converges
    expect(bobSession.getView().text).toBe('Hello from Alice')

    // Bob edits
    await bobSession.editText('Hello from Alice and Bob')
    network.flush()
    await tick()

    // Alice receives and converges
    expect(aliceSession.getView().text).toBe('Hello from Alice and Bob')

    // Both have the same access state
    expect(aliceSession.getAccessState().participants).toHaveLength(2)
    expect(bobSession.getAccessState().participants).toHaveLength(2)

    // Cleanup
    await alice.close()
    await bob.close()
  })

  it('admin invites a new participant who then joins and converges', async () => {
    const network = new DeterministicTransportNetwork()
    const initialParticipants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true }
    ]

    const storageAlice = new MemoryCollaborativeStorage()
    const storageBob = new MemoryCollaborativeStorage()

    const alice = createClient({
      senderId: 'alice',
      network,
      storage: storageAlice,
      identity: identity(initialParticipants)
    })

    // Alice creates and edits
    const aliceSession = await alice.createDocument({ documentId })
    await aliceSession.editText('Initial content')

    // Alice invites Bob
    await aliceSession.inviteParticipant('+15550000002', 'writer')
    expect(aliceSession.getAccessState().participants).toHaveLength(2)
    expect(aliceSession.getAccessState().participants).toContainEqual(
      expect.objectContaining({ participantId: 'bob', role: 'writer', active: true })
    )

    // Share state with Bob
    const aliceStored = await storageAlice.loadDocument(documentId)
    if (!aliceStored) throw new Error('alice document was not persisted')
    await storageBob.saveDocument(aliceStored)
    await storageBob.saveAccessControl(documentId, {
      selfRole: 'writer',
      participants: aliceSession.getAccessState().participants,
      archived: false,
      deleted: false,
      revision: 1
    })

    const bob = createClient({
      senderId: 'bob',
      network,
      storage: storageBob,
      identity: identity(aliceSession.getAccessState().participants)
    })
    const bobSession = await bob.openDocument(documentId)

    // Bob sees the content
    expect(bobSession.getView().text).toBe('Initial content')

    // Bob can edit
    await bobSession.editText('Initial content edited by Bob')
    network.flush()
    await tick()
    expect(aliceSession.getView().text).toBe('Initial content edited by Bob')

    await alice.close()
    await bob.close()
  })

  it('admin removes a participant and their subsequent edits are rejected', async () => {
    const network = new DeterministicTransportNetwork()
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]

    const storageAlice = new MemoryCollaborativeStorage()
    const storageBob = new MemoryCollaborativeStorage()

    const alice = createClient({
      senderId: 'alice',
      network,
      storage: storageAlice,
      identity: identity(participants)
    })
    const bob = createClient({
      senderId: 'bob',
      network,
      storage: storageBob,
      identity: identity(participants)
    })

    const aliceSession = await alice.createDocument({ documentId })

    const aliceStored = await storageAlice.loadDocument(documentId)
    if (!aliceStored) throw new Error('alice document was not persisted')
    await storageBob.saveDocument(aliceStored)
    await storageBob.saveAccessControl(documentId, {
      selfRole: 'writer',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })

    const bobSession = await bob.openDocument(documentId)

    // Both can edit initially
    await aliceSession.editText('before removal')
    network.flush()
    await tick()
    expect(bobSession.getView().text).toBe('before removal')

    // Alice removes Bob
    await aliceSession.removeParticipant('bob')
    network.flush()
    await tick()

    // Bob's access state shows removal
    expect(bobSession.getAccessState().participants).toContainEqual(
      expect.objectContaining({ participantId: 'bob', active: false })
    )

    // Bob cannot edit
    await expect(bobSession.editText('blocked')).rejects.toMatchObject({
      code: 'authorization-denied'
    })

    await alice.close()
    await bob.close()
  })

  it('reader cannot edit a document they were invited to as reader', async () => {
    const network = new DeterministicTransportNetwork()
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'reader', active: true }
    ]

    const storageAlice = new MemoryCollaborativeStorage()
    const storageBob = new MemoryCollaborativeStorage()

    const alice = createClient({
      senderId: 'alice',
      network,
      storage: storageAlice,
      identity: identity(participants)
    })

    const aliceSession = await alice.createDocument({ documentId })
    await aliceSession.editText('content')

    // Share state with Bob
    const aliceStored = await storageAlice.loadDocument(documentId)
    if (!aliceStored) throw new Error('alice document was not persisted')
    await storageBob.saveDocument(aliceStored)
    await storageBob.saveAccessControl(documentId, {
      selfRole: 'reader',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })

    const bob = createClient({
      senderId: 'bob',
      network,
      storage: storageBob,
      identity: identity(participants)
    })
    const bobSession = await bob.openDocument(documentId)

    expect(bobSession.getAccessState().selfRole).toBe('reader')
    await expect(bobSession.editText('blocked')).rejects.toMatchObject({
      code: 'authorization-denied'
    })

    await alice.close()
    await bob.close()
  })

  it('outbound records include kind field for compaction-aware storage', async () => {
    const network = new DeterministicTransportNetwork()
    const storage = new MemoryCollaborativeStorage()
    const client = createClient({ storage, network })
    const session = await client.createDocument({ documentId })

    await session.editText('test content')

    // After edit, check the document was persisted
    const stored = await storage.loadDocument(documentId)
    expect(stored).toBeDefined()
    expect(stored!.snapshot.byteLength).toBeGreaterThan(0)

    // The outbound records (if any remain) should have kind field
    const outbound = await storage.listOutbound(documentId)
    for (const record of outbound) {
      expect(record.kind).toBeDefined()
      expect(['automerge-change', 'snapshot', 'membership']).toContain(record.kind)
    }

    await client.close()
  })
})
