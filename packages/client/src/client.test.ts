import type { DocumentParticipant } from '@e2e-col/protocol'
import { MemoryCollaborativeStorage } from '@e2e-col/storage'
import { DeterministicTransportNetwork } from '@e2e-col/transport'
import { describe, expect, it } from 'vitest'
import { CollaborativeClient } from './client'
import type { ClientIdentityAdapter } from './types'

const documentA = '11111111-1111-4111-8111-111111111111'
const documentB = '22222222-2222-4222-8222-222222222222'

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
    transportFactory: ({ documentId }) => network.createTransport(`${senderId}:${documentId}`)
  })
}

describe('CollaborativeClient and DocumentSession', () => {
  it('converges two real client sessions in auto and manual sync modes', async () => {
    const network = new DeterministicTransportNetwork()
    const storageAlice = new MemoryCollaborativeStorage()
    const storageBob = new MemoryCollaborativeStorage()
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
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
    const aliceSession = await alice.createDocument({ documentId: documentA })
    const aliceStored = await storageAlice.loadDocument(documentA)
    if (!aliceStored) throw new Error('alice document was not persisted')
    await storageBob.saveDocument(aliceStored)
    await storageBob.saveAccessControl(documentA, {
      selfRole: 'writer',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })
    const bobSession = await bob.openDocument(documentA)

    await aliceSession.editText('auto convergence')
    network.flush()
    await tick()
    expect(bobSession.getView().text).toBe('auto convergence')

    aliceSession.setSyncMode('manual')
    await aliceSession.editText('manual convergence')
    network.flush()
    await tick()
    expect(bobSession.getView().text).toBe('auto convergence')
    expect(aliceSession.getStatus().pendingOutbound).toBe(1)

    await aliceSession.flush()
    network.flush()
    await tick()
    expect(bobSession.getView().text).toBe('manual convergence')
    expect(aliceSession.getStatus().pendingOutbound).toBe(0)

    await alice.close()
    await bob.close()
  })

  it('converges signed removals and blocks the removed participant from future edits', async () => {
    const network = new DeterministicTransportNetwork()
    const storageAlice = new MemoryCollaborativeStorage()
    const storageBob = new MemoryCollaborativeStorage()
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
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
    const aliceSession = await alice.createDocument({ documentId: documentA })
    const aliceStored = await storageAlice.loadDocument(documentA)
    if (!aliceStored) throw new Error('alice document was not persisted')
    await storageBob.saveDocument(aliceStored)
    await storageBob.saveAccessControl(documentA, {
      selfRole: 'writer',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })
    const bobSession = await bob.openDocument(documentA)

    await aliceSession.removeParticipant('bob')
    network.flush()
    await tick()

    expect(bobSession.getAccessState().participants).toContainEqual(
      expect.objectContaining({ participantId: 'bob', active: false })
    )
    await expect(bobSession.editText('must not escape')).rejects.toMatchObject({
      code: 'authorization-denied'
    })

    await alice.close()
    await bob.close()
  })

  it('auto-syncs immediately and manual-sync batches until flush', async () => {
    const participants = [
      { participantId: 'alice', role: 'admin' as const, active: true },
      { participantId: 'bob', role: 'writer' as const, active: true }
    ]
    const client = createClient({ identity: identity(participants) })
    const session = await client.createDocument({ documentId: documentA })

    await session.editText('auto')
    expect(session.getStatus().pendingOutbound).toBe(0)

    session.setSyncMode('manual')
    await session.editText('manual')
    expect(session.getStatus().pendingOutbound).toBe(1)
    await session.flush()
    expect(session.getStatus().pendingOutbound).toBe(0)
    expect(session.getView().text).toBe('manual')
    await client.close()
  })

  it('keeps multiple document sessions independent and lists persisted metadata', async () => {
    const client = createClient({})
    const first = await client.createDocument({
      documentId: documentA,
      metadata: { title: 'Alpha' }
    })
    const second = await client.createDocument({
      documentId: documentB,
      metadata: { title: 'Beta' }
    })
    await first.editText('one')
    await second.editText('two')

    expect(first.getView().text).toBe('one')
    expect(second.getView().text).toBe('two')
    expect(await client.listDocuments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: documentA, title: 'Alpha', archived: false }),
        expect.objectContaining({ documentId: documentB, title: 'Beta', archived: false })
      ])
    )
    await client.close()
  })

  it('enforces reader access and admin invitations', async () => {
    const readerClient = createClient({
      identity: identity([
        { participantId: 'alice', role: 'reader' as const, active: true },
        { participantId: 'admin', role: 'admin' as const, active: true }
      ])
    })
    const readerSession = await readerClient.createDocument({ documentId: documentA })
    expect(readerSession.getAccessState().selfRole).toBe('reader')
    await expect(readerSession.editText('blocked')).rejects.toMatchObject({
      code: 'authorization-denied'
    })
    await readerClient.close()

    const adminClient = createClient({
      identity: identity([
        { participantId: 'alice', role: 'admin' as const, active: true },
        { participantId: 'bob', role: 'reader' as const, active: false }
      ])
    })
    const adminSession = await adminClient.createDocument({ documentId: documentB })
    await adminSession.inviteParticipant('+15550000002', 'writer')
    expect(adminSession.getAccessState().participants).toContainEqual(
      expect.objectContaining({ participantId: 'bob', role: 'writer', active: true })
    )
    await adminClient.close()
  })
})
