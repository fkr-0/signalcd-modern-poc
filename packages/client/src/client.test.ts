import {
  archivePayloadSigningBytes,
  authorizationControlCommitment,
  authorizationGenesisPredecessor,
  createEnvelope,
  type DocumentParticipant,
  decodeAuthorizationCommitment,
  encodeArchivePayload,
  encodeAuthorizationCommitment,
  encodeEnvelope,
  encodeMembershipPayload,
  membershipPayloadSigningBytes
} from '@e2e-col/protocol'
import {
  type DurableCollaborativeStorage,
  IndexedDbCollaborativeStorage,
  MemoryCollaborativeStorage
} from '@e2e-col/storage'
import { DeterministicTransportNetwork } from '@e2e-col/transport'
import { indexedDB as fakeIndexedDb } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { CollaborativeClient } from './client'
import { type ClientIdentityAdapter, MAX_DOCUMENT_TITLE_LENGTH, type RecoveryPolicy } from './types'

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
  storage?: DurableCollaborativeStorage
  network?: DeterministicTransportNetwork
  identity?: ClientIdentityAdapter
  recovery?: RecoveryPolicy
  clock?: { now(): number }
}) {
  const senderId = options.senderId ?? 'alice'
  const network = options.network ?? new DeterministicTransportNetwork()
  return new CollaborativeClient({
    senderId,
    storage: options.storage ?? new MemoryCollaborativeStorage(),
    identity: options.identity ?? identity(),
    transportFactory: ({ documentId }) => network.createTransport(`${senderId}:${documentId}`),
    ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
    ...(options.clock === undefined ? {} : { clock: options.clock })
  })
}

async function signedArchiveWire(options: {
  actor: string
  action?: 'archive' | 'unarchive'
  revision: number
  predecessor: Uint8Array
  messageId: string
  participants: readonly DocumentParticipant[]
  timestamp?: number
}): Promise<{ wire: Uint8Array; controlId: string }> {
  const unsigned = {
    documentId: documentA,
    revision: options.revision,
    predecessor: options.predecessor,
    action: options.action ?? ('archive' as const),
    actorUserId: options.actor,
    timestamp: options.timestamp ?? options.revision
  }
  const signingBytes = archivePayloadSigningBytes(unsigned)
  const adapter = identity(options.participants)
  const payload = encodeArchivePayload({
    ...unsigned,
    signature: await adapter.signControl(signingBytes)
  })
  return {
    wire: encodeEnvelope(
      createEnvelope({
        documentId: documentA,
        messageId: options.messageId,
        senderId: options.actor,
        kind: 'archive',
        createdAt: options.timestamp ?? options.revision,
        payload
      })
    ),
    controlId: encodeAuthorizationCommitment(await authorizationControlCommitment(signingBytes))
  }
}

async function signedRoleChangeWire(options: {
  actor: string
  target: string
  role: 'reader' | 'writer' | 'admin'
  revision: number
  predecessor: Uint8Array
  messageId: string
  participants: readonly DocumentParticipant[]
}): Promise<{ wire: Uint8Array; controlId: string }> {
  const unsigned = {
    documentId: documentA,
    revision: options.revision,
    predecessor: options.predecessor,
    action: 'role_change' as const,
    targetUserId: options.target,
    role: options.role,
    actorUserId: options.actor,
    timestamp: options.revision
  }
  const signingBytes = membershipPayloadSigningBytes(unsigned)
  const adapter = identity(options.participants)
  const payload = encodeMembershipPayload({
    ...unsigned,
    signature: await adapter.signControl(signingBytes)
  })
  return {
    wire: encodeEnvelope(
      createEnvelope({
        documentId: documentA,
        messageId: options.messageId,
        senderId: options.actor,
        kind: 'membership',
        createdAt: options.revision,
        payload
      })
    ),
    controlId: encodeAuthorizationCommitment(await authorizationControlCommitment(signingBytes))
  }
}

async function sendWire(
  network: DeterministicTransportNetwork,
  documentId: string,
  transportId: string,
  wire: Uint8Array
): Promise<void> {
  const sender = network.createTransport(transportId)
  await sender.connect(documentId)
  await sender.send(wire)
  network.flush()
  await tick()
  await sender.close()
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
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

  it('does not reapply a durable duplicate control frame after IndexedDB restart', async () => {
    const network = new DeterministicTransportNetwork()
    const storageAlice = new MemoryCollaborativeStorage()
    const bobStorageName = `e2e-col-client-restart-dedup-${crypto.randomUUID()}`
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
    const firstBobStorage = new IndexedDbCollaborativeStorage({
      name: bobStorageName,
      indexedDB: fakeIndexedDb
    })
    const aliceSession = await alice.createDocument({ documentId: documentA })
    const aliceStored = await storageAlice.loadDocument(documentA)
    if (!aliceStored) throw new Error('alice document was not persisted')
    await firstBobStorage.saveDocument(aliceStored)

    await aliceSession.archive()
    const archiveRecord = (await storageAlice.listOutbound(documentA)).find(
      (record) => record.kind === 'archive'
    )
    if (!archiveRecord) throw new Error('archive record was not retained for replay')
    const duplicateWire = new Uint8Array(archiveRecord.payload)
    await firstBobStorage.commitAccessChange({
      documentId: documentA,
      access: {
        selfRole: 'writer',
        participants,
        archived: true,
        deleted: false,
        revision: 1
      },
      outbound: [],
      seen: [
        {
          documentId: documentA,
          messageId: archiveRecord.id,
          seenAt: Date.now()
        }
      ]
    })
    await firstBobStorage.close()

    const reopenedBobStorage = new IndexedDbCollaborativeStorage({
      name: bobStorageName,
      indexedDB: fakeIndexedDb
    })
    const reopenedBob = createClient({
      senderId: 'bob',
      network,
      storage: reopenedBobStorage,
      identity: identity(participants)
    })
    const reopenedBobSession = await reopenedBob.openDocument(documentA)
    expect(reopenedBobSession.getAccessState()).toMatchObject({ archived: true, revision: 1 })

    const replay = network.createTransport('duplicate-replay')
    await replay.connect(documentA)
    await replay.send(duplicateWire)
    network.flush()
    await tick()
    expect(reopenedBobSession.getAccessState()).toMatchObject({ archived: true, revision: 1 })

    await replay.close()
    await reopenedBob.close()
    await alice.close()
  })

  it('rejects old signed membership/archive/delete controls after durable seen TTL expiry', async () => {
    let now = 1_000
    const clock = { now: () => now }
    const network = new DeterministicTransportNetwork()
    const storageAlice = new MemoryCollaborativeStorage({ now: () => now, seenMessageTtlMs: 25 })
    const storageBob = new MemoryCollaborativeStorage({ now: () => now, seenMessageTtlMs: 25 })
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const alice = createClient({
      senderId: 'alice',
      network,
      storage: storageAlice,
      identity: identity(participants),
      clock
    })
    const bob = createClient({
      senderId: 'bob',
      network,
      storage: storageBob,
      identity: identity(participants),
      clock
    })
    const aliceSession = await alice.createDocument({ documentId: documentA })
    const stored = await storageAlice.loadDocument(documentA)
    if (!stored) throw new Error('alice document was not persisted')
    await storageBob.saveDocument(stored)
    await storageBob.saveAccessControl(documentA, {
      selfRole: 'writer',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })
    const bobSession = await bob.openDocument(documentA)

    await aliceSession.setParticipantRole('bob', 'reader')
    await aliceSession.removeParticipant('bob')
    await aliceSession.archive()
    await aliceSession.deleteForGroup()
    network.flush()
    await waitFor(() => bobSession.getAccessState().revision === 4)
    expect(bobSession.getAccessState()).toMatchObject({
      revision: 4,
      archived: true,
      deleted: true
    })
    const replayWires = (await storageAlice.listOutbound(documentA))
      .filter(
        (record) =>
          record.kind === 'membership' || record.kind === 'archive' || record.kind === 'delete'
      )
      .map((record) => new Uint8Array(record.payload))
    expect(replayWires).toHaveLength(4)

    now += 100
    expect(await storageBob.pruneSeenMessages()).toBeGreaterThan(0)
    for (const [index, wire] of replayWires.entries()) {
      await sendWire(network, documentA, `expired-replay-${index}`, wire)
    }
    expect(bobSession.getAccessState()).toMatchObject({
      revision: 4,
      archived: true,
      deleted: true,
      authorizationStatus: 'active'
    })
    expect((await storageBob.loadAuthorizationState(documentA))?.records).toHaveLength(4)

    await alice.close()
    await bob.close()
  })

  it('keeps the authorization head replay-safe across IndexedDB close/reopen after TTL expiry', async () => {
    let now = 2_000
    const clock = { now: () => now }
    const network = new DeterministicTransportNetwork()
    const storageAlice = new MemoryCollaborativeStorage({ now: () => now })
    const storageName = `e2e-col-auth-restart-${crypto.randomUUID()}`
    const firstBobStorage = new IndexedDbCollaborativeStorage({
      name: storageName,
      indexedDB: fakeIndexedDb,
      seenMessageTtlMs: 25,
      now: () => now
    })
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const alice = createClient({
      senderId: 'alice',
      network,
      storage: storageAlice,
      identity: identity(participants),
      clock
    })
    const bob = createClient({
      senderId: 'bob',
      network,
      storage: firstBobStorage,
      identity: identity(participants),
      clock
    })
    const aliceSession = await alice.createDocument({ documentId: documentA })
    const stored = await storageAlice.loadDocument(documentA)
    if (!stored) throw new Error('alice document was not persisted')
    await firstBobStorage.saveDocument(stored)
    await firstBobStorage.saveAccessControl(documentA, {
      selfRole: 'writer',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })
    const bobSession = await bob.openDocument(documentA)
    await aliceSession.archive()
    network.flush()
    await waitFor(() => bobSession.getAccessState().revision === 1)
    const archiveWire = new Uint8Array(
      (await storageAlice.listOutbound(documentA)).find((record) => record.kind === 'archive')!
        .payload
    )
    expect(bobSession.getAccessState().revision).toBe(1)
    const head = (await firstBobStorage.loadAuthorizationState(documentA))?.head
    expect(head).toBeDefined()
    await bob.close()

    now += 100
    const reopenedStorage = new IndexedDbCollaborativeStorage({
      name: storageName,
      indexedDB: fakeIndexedDb,
      seenMessageTtlMs: 25,
      now: () => now
    })
    expect(await reopenedStorage.pruneSeenMessages()).toBeGreaterThanOrEqual(1)
    const replayNetwork = new DeterministicTransportNetwork()
    const reopenedBob = createClient({
      senderId: 'bob',
      network: replayNetwork,
      storage: reopenedStorage,
      identity: identity(participants),
      clock
    })
    const reopenedSession = await reopenedBob.openDocument(documentA)
    expect(reopenedSession.getAccessState()).toMatchObject({ revision: 1, authorizationHead: head })
    await sendWire(replayNetwork, documentA, 'restart-expired-replay', archiveWire)
    expect(reopenedSession.getAccessState()).toMatchObject({
      revision: 1,
      archived: true,
      authorizationHead: head,
      authorizationStatus: 'active'
    })
    expect((await reopenedStorage.loadAuthorizationState(documentA))?.records).toHaveLength(1)
    await reopenedBob.close()
    await alice.close()
  })

  it('buffers a valid out-of-order control and applies it only after its predecessor arrives', async () => {
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const network = new DeterministicTransportNetwork()
    const storage = new MemoryCollaborativeStorage()
    const bob = createClient({
      senderId: 'bob',
      network,
      storage,
      identity: identity(participants)
    })
    const session = await bob.openDocument(documentA)
    const genesis = authorizationGenesisPredecessor()
    const first = await signedArchiveWire({
      actor: 'alice',
      action: 'archive',
      revision: 1,
      predecessor: genesis,
      messageId: '30000000-0000-4000-8000-000000000001',
      participants
    })
    const second = await signedArchiveWire({
      actor: 'alice',
      action: 'unarchive',
      revision: 2,
      predecessor: decodeAuthorizationCommitment(first.controlId),
      messageId: '30000000-0000-4000-8000-000000000002',
      participants
    })

    await sendWire(network, documentA, 'out-of-order-second', second.wire)
    await waitFor(async () =>
      Boolean(
        (await storage.loadAuthorizationState(documentA))?.pending.some(
          (candidate) => candidate.controlId === second.controlId
        )
      )
    )
    expect(session.getAccessState()).toMatchObject({ revision: 0, archived: false })
    expect((await storage.loadAuthorizationState(documentA))?.pending).toHaveLength(1)
    await sendWire(network, documentA, 'out-of-order-first', first.wire)
    await waitFor(() => session.getAccessState().revision === 2)
    expect(session.getAccessState()).toMatchObject({
      revision: 2,
      archived: false,
      authorizationHead: second.controlId,
      authorizationStatus: 'active'
    })
    expect((await storage.loadAuthorizationState(documentA))?.pending).toHaveLength(0)
    await bob.close()
  })

  it('rejects stale admin authority at the referenced causal state', async () => {
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'carol', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const network = new DeterministicTransportNetwork()
    const storage = new MemoryCollaborativeStorage()
    const bob = createClient({
      senderId: 'bob',
      network,
      storage,
      identity: identity(participants)
    })
    const session = await bob.openDocument(documentA)
    const demote = await signedRoleChangeWire({
      actor: 'alice',
      target: 'carol',
      role: 'reader',
      revision: 1,
      predecessor: authorizationGenesisPredecessor(),
      messageId: '40000000-0000-4000-8000-000000000001',
      participants
    })
    const staleAdmin = await signedArchiveWire({
      actor: 'carol',
      revision: 2,
      predecessor: decodeAuthorizationCommitment(demote.controlId),
      messageId: '40000000-0000-4000-8000-000000000002',
      participants
    })
    await sendWire(network, documentA, 'demote-carol', demote.wire)
    await waitFor(() => session.getAccessState().revision === 1)
    await sendWire(network, documentA, 'stale-carol-admin', staleAdmin.wire)
    expect(session.getAccessState()).toMatchObject({ revision: 1, archived: false })
    expect(session.getAccessState().participants).toContainEqual(
      expect.objectContaining({ participantId: 'carol', role: 'reader', active: true })
    )
    expect((await storage.loadAuthorizationState(documentA))?.records).toHaveLength(1)
    await bob.close()
  })

  it('converges concurrent same-predecessor admin controls to a deterministic frozen conflict', async () => {
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'carol', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const genesis = authorizationGenesisPredecessor()
    const aliceControl = await signedArchiveWire({
      actor: 'alice',
      action: 'archive',
      revision: 1,
      predecessor: genesis,
      messageId: '50000000-0000-4000-8000-000000000001',
      participants
    })
    const carolControl = await signedArchiveWire({
      actor: 'carol',
      action: 'unarchive',
      revision: 1,
      predecessor: genesis,
      messageId: '50000000-0000-4000-8000-000000000002',
      participants
    })

    async function deliver(order: readonly Uint8Array[]) {
      const network = new DeterministicTransportNetwork()
      const storage = new MemoryCollaborativeStorage()
      const bob = createClient({
        senderId: 'bob',
        network,
        storage,
        identity: identity(participants)
      })
      const session = await bob.openDocument(documentA)
      for (const [index, wire] of order.entries()) {
        await sendWire(network, documentA, `fork-${index}`, wire)
        if (index === 0) await waitFor(() => session.getAccessState().revision === 1)
      }
      await waitFor(() => session.getAccessState().authorizationStatus === 'conflict')
      const access = session.getAccessState()
      const auth = await storage.loadAuthorizationState(documentA)
      await bob.close()
      return { access, auth }
    }

    const forward = await deliver([aliceControl.wire, carolControl.wire])
    const reverse = await deliver([carolControl.wire, aliceControl.wire])
    expect(forward.access).toMatchObject({
      revision: 0,
      archived: false,
      authorizationStatus: 'conflict',
      authorizationHead: encodeAuthorizationCommitment(genesis)
    })
    expect(reverse.access).toEqual(forward.access)
    expect(reverse.auth?.conflict).toEqual(forward.auth?.conflict)
    expect(forward.auth?.conflict?.controlIds).toEqual(
      [aliceControl.controlId, carolControl.controlId].sort()
    )
  })

  it('keeps a fork conflict pinned when a descendant of one branch arrives later', async () => {
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'carol', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const genesis = authorizationGenesisPredecessor()
    const first = await signedArchiveWire({
      actor: 'alice',
      action: 'archive',
      revision: 1,
      predecessor: genesis,
      messageId: '51000000-0000-4000-8000-000000000001',
      participants
    })
    const sibling = await signedArchiveWire({
      actor: 'carol',
      action: 'unarchive',
      revision: 1,
      predecessor: genesis,
      messageId: '51000000-0000-4000-8000-000000000002',
      participants
    })
    const descendant = await signedArchiveWire({
      actor: 'alice',
      action: 'unarchive',
      revision: 2,
      predecessor: decodeAuthorizationCommitment(first.controlId),
      messageId: '51000000-0000-4000-8000-000000000003',
      participants
    })
    const network = new DeterministicTransportNetwork()
    const storage = new MemoryCollaborativeStorage()
    const bob = createClient({
      senderId: 'bob',
      network,
      storage,
      identity: identity(participants)
    })
    const session = await bob.openDocument(documentA)
    await sendWire(network, documentA, 'conflict-first', first.wire)
    await waitFor(() => session.getAccessState().revision === 1)
    await sendWire(network, documentA, 'conflict-sibling', sibling.wire)
    await waitFor(() => session.getAccessState().authorizationStatus === 'conflict')
    const frozen = session.getAccessState()
    await sendWire(network, documentA, 'conflict-descendant', descendant.wire)
    await waitFor(async () =>
      Boolean(
        (await storage.loadAuthorizationState(documentA))?.pending.some(
          (candidate) => candidate.controlId === descendant.controlId
        )
      )
    )
    expect(session.getAccessState()).toEqual(frozen)
    const auth = await storage.loadAuthorizationState(documentA)
    expect(auth?.head).toBe(encodeAuthorizationCommitment(genesis))
    expect(auth?.conflict?.controlIds).toEqual([first.controlId, sibling.controlId].sort())
    expect(auth?.pending.map((candidate) => candidate.controlId)).toContain(descendant.controlId)
    await bob.close()
  })

  it('rejects malformed signed revision evidence and keeps snapshots from resetting the authorization head', async () => {
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const network = new DeterministicTransportNetwork()
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
    const aliceSession = await alice.createDocument({ documentId: documentA })
    const stored = await storageAlice.loadDocument(documentA)
    if (!stored) throw new Error('alice document was not persisted')
    await storageBob.saveDocument(stored)
    await storageBob.saveAccessControl(documentA, {
      selfRole: 'writer',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })
    const bobSession = await bob.openDocument(documentA)

    const signedProof = {
      documentId: documentA,
      revision: 1,
      predecessor: authorizationGenesisPredecessor(),
      action: 'archive' as const,
      actorUserId: 'alice',
      timestamp: 1
    }
    const proofSignature = await identity(participants).signControl(
      archivePayloadSigningBytes(signedProof)
    )
    const forgedPayload = encodeArchivePayload({
      ...signedProof,
      predecessor: Uint8Array.from({ length: 32 }, () => 9),
      signature: proofSignature
    })
    const forgedWire = encodeEnvelope(
      createEnvelope({
        documentId: documentA,
        messageId: '60000000-0000-4000-8000-000000000000',
        senderId: 'alice',
        kind: 'archive',
        createdAt: 1,
        payload: forgedPayload
      })
    )
    await sendWire(network, documentA, 'forged-predecessor', forgedWire)
    expect(bobSession.getAccessState()).toMatchObject({ revision: 0, archived: false })

    const malformed = await signedArchiveWire({
      actor: 'alice',
      revision: 2,
      predecessor: authorizationGenesisPredecessor(),
      messageId: '60000000-0000-4000-8000-000000000001',
      participants
    })
    await sendWire(network, documentA, 'malformed-revision', malformed.wire)
    expect(bobSession.getAccessState()).toMatchObject({ revision: 0, archived: false })

    await aliceSession.archive()
    await aliceSession.unarchive()
    network.flush()
    await tick()
    const headBeforeSnapshot = bobSession.getAccessState().authorizationHead
    expect(bobSession.getAccessState().revision).toBe(2)
    await aliceSession.editText('snapshot must not carry ACL authority')
    await aliceSession.publishSnapshot()
    network.flush()
    await tick()
    expect(bobSession.getAccessState()).toMatchObject({
      revision: 2,
      authorizationHead: headBeforeSnapshot,
      authorizationStatus: 'active'
    })
    expect((await storageBob.loadAuthorizationState(documentA))?.head).toBe(headBeforeSnapshot)
    await alice.close()
    await bob.close()
  })

  it('keeps recovery required after unrelated send completion until a checkpoint repairs loss', async () => {
    const network = new DeterministicTransportNetwork({
      faults: [
        {
          send: 1,
          from: `alice:${documentA}`,
          to: `bob:${documentA}`,
          drop: true
        }
      ]
    })
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
      identity: identity(participants),
      recovery: { publishSnapshotOnRecoverySignal: false }
    })
    const bob = createClient({
      senderId: 'bob',
      network,
      storage: storageBob,
      identity: identity(participants),
      recovery: { publishSnapshotOnRecoverySignal: false }
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

    await aliceSession.editText('known lost increment')
    network.flush()
    await tick()

    expect(aliceSession.getStatus()).toMatchObject({ phase: 'recovering', recoveryRequired: true })
    expect(bobSession.getStatus()).toMatchObject({ phase: 'recovering', recoveryRequired: true })
    expect(bobSession.getView().text).toBe('')

    await aliceSession.publishSnapshot()
    network.flush()
    await tick()

    expect(bobSession.getView().text).toBe('known lost increment')
    expect(aliceSession.getStatus().recoveryRequired).toBe(false)
    expect(bobSession.getStatus().recoveryRequired).toBe(false)

    await alice.close()
    await bob.close()
  })

  it('repairs a dropped increment with a durable snapshot checkpoint', async () => {
    const network = new DeterministicTransportNetwork({
      faults: [
        {
          send: 1,
          from: `alice:${documentA}`,
          to: `bob:${documentA}`,
          drop: true
        }
      ]
    })
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

    await aliceSession.editText('recovered from a dropped increment')
    network.flush()
    await tick()
    await tick()

    expect(bobSession.getView().text).toBe('recovered from a dropped increment')
    expect(bobSession.getStatus().recoveryRequired).toBe(false)
    expect(await storageAlice.listOutbound(documentA)).toEqual([
      expect.objectContaining({ kind: 'snapshot', state: 'attempted' })
    ])

    await alice.close()
    await bob.close()
  })

  it('recovers a reader from a dropped edit without letting the reader publish a snapshot', async () => {
    const network = new DeterministicTransportNetwork({
      faults: [
        {
          send: 1,
          from: `alice:${documentA}`,
          to: `bob:${documentA}`,
          drop: true
        }
      ]
    })
    const storageAlice = new MemoryCollaborativeStorage()
    const storageBob = new MemoryCollaborativeStorage()
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'reader', active: true }
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
      selfRole: 'reader',
      participants,
      archived: false,
      deleted: false,
      revision: 0
    })
    const bobSession = await bob.openDocument(documentA)

    await aliceSession.editText('reader catches up from writer checkpoint')
    network.flush()
    await tick()
    await tick()

    expect(bobSession.getView().text).toBe('reader catches up from writer checkpoint')
    expect(bobSession.getStatus().recoveryRequired).toBe(false)
    await expect(bobSession.publishSnapshot()).rejects.toMatchObject({
      code: 'authorization-denied'
    })
    expect(await storageBob.listOutbound(documentA)).toHaveLength(0)
    await alice.close()
    await bob.close()
  })

  it('compacts only CRDT history when an explicit snapshot supersedes it', async () => {
    const storage = new MemoryCollaborativeStorage()
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const client = createClient({ storage, identity: identity(participants) })
    const session = await client.createDocument({ documentId: documentA })
    session.setSyncMode('manual')

    await session.editText('first')
    await session.archive()
    await session.unarchive()
    const before = await storage.listOutbound(documentA)
    expect(before.map((record) => record.kind)).toEqual(['automerge-change', 'archive', 'archive'])

    await session.publishSnapshot()
    const after = await storage.listOutbound(documentA)
    expect(after.some((record) => record.kind === 'automerge-change')).toBe(false)
    expect(after.filter((record) => record.kind === 'archive')).toHaveLength(2)
    expect(after.some((record) => record.kind === 'snapshot')).toBe(true)
    await client.close()
  })

  it('renames local metadata without changing document, authorization, or outbound state', async () => {
    const storage = new MemoryCollaborativeStorage()
    const client = createClient({ storage })
    const session = await client.createDocument({
      documentId: documentA,
      metadata: { title: '  Alpha  ', category: 'notes', pinned: true }
    })
    expect((await client.listDocuments())[0]?.title).toBe('Alpha')
    await session.editText('content is identity-bound to the UUID')
    await session.archive()
    await session.unarchive()

    const beforeDocument = await storage.loadDocument(documentA)
    const beforeAccess = await storage.loadAccessControl(documentA)
    const beforeAuthorization = await storage.loadAuthorizationState(documentA)
    const beforeOutbound = await storage.listOutbound(documentA)
    const summary = await client.updateDocumentMetadata(documentA, { title: '  Renamed locally  ' })

    expect(summary).toMatchObject({ documentId: documentA, title: 'Renamed locally' })
    expect(session.documentId).toBe(documentA)
    expect(session.getView().text).toBe('content is identity-bound to the UUID')
    const afterDocument = await storage.loadDocument(documentA)
    expect(afterDocument?.snapshot).toEqual(beforeDocument?.snapshot)
    expect(afterDocument?.metadata).toEqual({
      title: 'Renamed locally',
      category: 'notes',
      pinned: true
    })
    expect(await storage.loadAccessControl(documentA)).toEqual(beforeAccess)
    expect(await storage.loadAuthorizationState(documentA)).toEqual(beforeAuthorization)
    expect(await storage.listOutbound(documentA)).toEqual(beforeOutbound)

    // A later whole-document save must use the refreshed session metadata and
    // must not restore the stale pre-rename title.
    await session.editText('later content save')
    expect((await storage.loadDocument(documentA))?.metadata?.title).toBe('Renamed locally')
    await client.close()
    expect((await storage.loadDocument(documentA))?.metadata?.title).toBe('Renamed locally')
  })

  it('persists independent titles through IndexedDB client restart and clears to fallback', async () => {
    const storageName = `e2e-col-metadata-restart-${crypto.randomUUID()}`
    const firstStorage = new IndexedDbCollaborativeStorage({
      name: storageName,
      indexedDB: fakeIndexedDb
    })
    const first = createClient({ storage: firstStorage })
    const alpha = await first.createDocument({
      documentId: documentA,
      metadata: { title: 'Alpha', category: 'first' }
    })
    const beta = await first.createDocument({
      documentId: documentB,
      metadata: { title: 'Beta', category: 'second' }
    })
    await alpha.editText('alpha body')
    await beta.editText('beta body')
    await first.updateDocumentMetadata(documentA, { title: 'Alpha renamed' })
    await first.updateDocumentMetadata(documentB, { title: 'Beta renamed' })
    await first.close()

    const reopenedStorage = new IndexedDbCollaborativeStorage({
      name: storageName,
      indexedDB: fakeIndexedDb
    })
    const reopened = createClient({ storage: reopenedStorage })
    expect(await reopened.listDocuments()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentId: documentA, title: 'Alpha renamed' }),
        expect.objectContaining({ documentId: documentB, title: 'Beta renamed' })
      ])
    )
    expect((await reopened.openDocument(documentA)).getView().text).toBe('alpha body')
    expect((await reopened.openDocument(documentB)).getView().text).toBe('beta body')

    await reopened.updateDocumentMetadata(documentA, { title: '   ' })
    const cleared = (await reopened.listDocuments()).find(
      (document) => document.documentId === documentA
    )
    expect(cleared?.title).toBeUndefined()
    expect((await reopenedStorage.loadDocument(documentA))?.metadata).toEqual({ category: 'first' })
    expect((await reopenedStorage.loadDocument(documentB))?.metadata).toEqual({
      title: 'Beta renamed',
      category: 'second'
    })
    await reopened.close()
  })

  it('rejects invalid local titles without corrupting the prior durable or open-session value', async () => {
    class FailingMetadataStorage extends MemoryCollaborativeStorage {
      failMetadataUpdates = false

      override async updateDocumentMetadata(
        ...args: Parameters<MemoryCollaborativeStorage['updateDocumentMetadata']>
      ): ReturnType<MemoryCollaborativeStorage['updateDocumentMetadata']> {
        if (this.failMetadataUpdates) throw new Error('injected metadata transaction failure')
        return super.updateDocumentMetadata(...args)
      }
    }

    const storage = new FailingMetadataStorage()
    const client = createClient({ storage })
    const session = await client.createDocument({
      documentId: documentA,
      metadata: { title: 'Stable title', category: 'keep' }
    })

    await expect(
      client.updateDocumentMetadata(documentA, { title: 'line one\nline two' })
    ).rejects.toThrow('single line')
    await expect(
      client.updateDocumentMetadata(documentA, {
        title: 'x'.repeat(MAX_DOCUMENT_TITLE_LENGTH + 1)
      })
    ).rejects.toThrow(`at most ${MAX_DOCUMENT_TITLE_LENGTH}`)
    await expect(
      client.updateDocumentMetadata(documentA, { title: 42 } as unknown as { title: string })
    ).rejects.toThrow('string or null')
    await expect(
      client.createDocument({
        documentId: documentB,
        metadata: { title: 'x'.repeat(MAX_DOCUMENT_TITLE_LENGTH + 1) }
      })
    ).rejects.toThrow(`at most ${MAX_DOCUMENT_TITLE_LENGTH}`)
    expect(await storage.loadDocument(documentB)).toBeUndefined()

    storage.failMetadataUpdates = true
    await expect(
      client.updateDocumentMetadata(documentA, { title: 'Must not appear' })
    ).rejects.toThrow('injected metadata transaction failure')
    expect((await client.listDocuments())[0]).toMatchObject({ title: 'Stable title' })
    expect((await storage.loadDocument(documentA))?.metadata).toEqual({
      title: 'Stable title',
      category: 'keep'
    })

    // If the failed transaction had updated the session cache, this ordinary
    // content persistence would corrupt the durable title afterward.
    await session.editText('content after failed rename')
    expect((await storage.loadDocument(documentA))?.metadata?.title).toBe('Stable title')
    await client.close()
  })

  it('keeps local title authority separate from archived/deleted collaboration access', async () => {
    const storage = new MemoryCollaborativeStorage()
    const client = createClient({ storage })
    const session = await client.createDocument({
      documentId: documentA,
      metadata: { title: 'Live' }
    })

    await session.archive()
    const archivedAccess = session.getAccessState()
    const archivedOutbound = await storage.listOutbound(documentA)
    await client.updateDocumentMetadata(documentA, { title: 'Locally archived title' })
    expect(session.getAccessState()).toEqual(archivedAccess)
    expect(await storage.listOutbound(documentA)).toEqual(archivedOutbound)
    await expect(session.editText('must stay blocked while archived')).rejects.toMatchObject({
      code: 'authorization-denied'
    })

    await session.unarchive()
    await session.deleteForGroup()
    const deletedAccess = session.getAccessState()
    const deletedOutbound = await storage.listOutbound(documentA)
    await client.updateDocumentMetadata(documentA, { title: 'Locally deleted title' })
    expect(session.getAccessState()).toEqual(deletedAccess)
    expect(await storage.listOutbound(documentA)).toEqual(deletedOutbound)
    await expect(session.editText('must stay blocked after delete')).rejects.toMatchObject({
      code: 'authorization-denied'
    })
    await client.close()
  })

  it('rejects invalid snapshot checkpoint thresholds', () => {
    expect(
      () =>
        new CollaborativeClient({
          senderId: 'alice',
          storage: new MemoryCollaborativeStorage(),
          identity: identity(),
          transportFactory: () => new DeterministicTransportNetwork().createTransport('alice'),
          recovery: { snapshotThresholdOutboundEntries: 0 }
        })
    ).toThrow('positive safe integer')
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
    await waitFor(() =>
      bobSession
        .getAccessState()
        .participants.some(
          (participant) => participant.participantId === 'bob' && !participant.active
        )
    )

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

  it('listDocuments returns an empty array before any documents are created', async () => {
    const client = createClient({})
    expect(await client.listDocuments()).toEqual([])
    await client.close()
  })

  it('openDocument on a non-existent document creates a new blank session', async () => {
    const client = createClient({})
    const session = await client.openDocument(documentA)
    expect(session.getView().text).toBe('')
    expect(session.documentId).toBe(documentA)
    await client.close()
  })

  it('propagates errors when the transport factory throws', async () => {
    const factoryError = new Error('transport factory exploded')
    const client = new CollaborativeClient({
      senderId: 'alice',
      storage: new MemoryCollaborativeStorage(),
      identity: identity(),
      transportFactory: () => {
        throw factoryError
      }
    })
    await expect(client.createDocument({ documentId: documentA })).rejects.toThrow(
      'transport factory exploded'
    )
    await client.close()
  })

  it('rejects operations after the client is closed', async () => {
    const client = createClient({})
    await client.close()
    await expect(client.listDocuments()).rejects.toThrow('collaborative client is closed')
    await expect(client.createDocument({ documentId: documentA })).rejects.toThrow(
      'collaborative client is closed'
    )
    await expect(client.openDocument(documentA)).rejects.toThrow('collaborative client is closed')
  })
})
