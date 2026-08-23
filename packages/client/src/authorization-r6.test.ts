import {
  type AuthorizationRootPayload,
  archivePayloadSigningBytes,
  authorizationControlCommitment,
  authorizationGenesisPredecessor,
  authorizationRootCommitment,
  authorizationRootSigningBytes,
  createEnvelope,
  type DocumentParticipant,
  decodeAuthorizationCommitment,
  decodeAuthorizationRootPayload,
  deletePayloadSigningBytes,
  encodeArchivePayload,
  encodeAuthorizationCommitment,
  encodeAuthorizationRootPayload,
  encodeDeletePayload,
  encodeEnvelope,
  type ForkResolutionApproval
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
import type {
  AuthorizationBootstrapMaterial,
  AuthorizationEvidencePublish,
  ClientIdentityAdapter
} from './types'

const documentId = '77777777-7777-4777-8777-777777777777'
const alicePhone = '+15550000001'
const bobPhone = '+15550000002'
const carolPhone = '+15550000003'

interface EvidenceCache {
  root?: Uint8Array
  controls: AuthorizationEvidencePublish['controls']
  resolutions: AuthorizationEvidencePublish['resolutions']
}

async function signedDeleteWire(options: {
  actor: string
  revision: number
  predecessor: Uint8Array
  messageId: string
}): Promise<{ wire: Uint8Array; controlId: string; payload: Uint8Array }> {
  const unsigned = {
    documentId,
    revision: options.revision,
    predecessor: options.predecessor,
    action: 'delete' as const,
    actorUserId: options.actor,
    timestamp: options.revision
  }
  const signingBytes = deletePayloadSigningBytes(unsigned)
  const payload = encodeDeletePayload({ ...unsigned, signature: await testSignature(signingBytes) })
  return {
    payload,
    wire: encodeEnvelope(
      createEnvelope({
        documentId,
        messageId: options.messageId,
        senderId: options.actor,
        kind: 'delete',
        createdAt: options.revision,
        payload
      })
    ),
    controlId: encodeAuthorizationCommitment(await authorizationControlCommitment(signingBytes))
  }
}

function createEvidenceCache(): EvidenceCache {
  return { controls: [], resolutions: [] }
}

async function testSignature(bytes: Uint8Array): Promise<Uint8Array> {
  const signature = new Uint8Array(64)
  signature.fill(bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0))
  return signature
}

async function identityCommitment(participantId: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`identity:${participantId}`))
  )
}

function authenticatedIdentity(
  userId: string,
  evidence: EvidenceCache,
  options: {
    initialParticipants?: readonly DocumentParticipant[]
    expectedRoot?: () => string | undefined
    expectedHead?: () => string | undefined
    identityCommitmentFor?: (participantId: string) => Promise<Uint8Array>
    mutateBootstrap?: (material: AuthorizationBootstrapMaterial) => AuthorizationBootstrapMaterial
  } = {}
): ClientIdentityAdapter {
  return {
    async signControl(bytes) {
      return testSignature(bytes)
    },
    async verifyControl(_actorUserId, bytes, signature) {
      const expected = await testSignature(bytes)
      return expected.every((byte, index) => byte === signature[index])
    },
    async resolveParticipant(phoneNumber) {
      if (phoneNumber === bobPhone) return { participantId: 'bob', displayName: 'Bob' }
      if (phoneNumber === carolPhone) return { participantId: 'carol', displayName: 'Carol' }
      if (phoneNumber === alicePhone) return { participantId: 'alice', displayName: 'Alice' }
      throw new Error(`unknown participant ${phoneNumber}`)
    },
    async identityKeyCommitment(participantId) {
      return options.identityCommitmentFor?.(participantId) ?? identityCommitment(participantId)
    },
    async bootstrapAuthorization() {
      const expectedRoot = options.expectedRoot?.()
      const expectedHead = options.expectedHead?.()
      const material: AuthorizationBootstrapMaterial = {
        initialParticipants: options.initialParticipants ?? [
          { participantId: userId, role: 'admin', active: true }
        ],
        ...(expectedRoot === undefined ? {} : { expectedRoot }),
        ...(expectedHead === undefined ? {} : { expectedHead }),
        roots: evidence.root ? [new Uint8Array(evidence.root)] : [],
        controls: evidence.controls.map((entry) => ({
          ...entry,
          payload: new Uint8Array(entry.payload)
        })),
        resolutions: evidence.resolutions.map((entry) => ({
          ...entry,
          payload: new Uint8Array(entry.payload)
        }))
      }
      return options.mutateBootstrap?.(material) ?? material
    },
    async publishAuthorizationEvidence(_context, next) {
      if (next.root) evidence.root = new Uint8Array(next.root)
      evidence.controls = next.controls.map((entry) => ({
        ...entry,
        payload: new Uint8Array(entry.payload)
      }))
      evidence.resolutions = next.resolutions.map((entry) => ({
        ...entry,
        payload: new Uint8Array(entry.payload)
      }))
    }
  }
}

function legacyIdentity(participants: readonly DocumentParticipant[]): ClientIdentityAdapter {
  return {
    async signControl(bytes) {
      return testSignature(bytes)
    },
    async verifyControl(_actorUserId, bytes, signature) {
      const expected = await testSignature(bytes)
      return expected.every((byte, index) => byte === signature[index])
    },
    async resolveParticipant(phoneNumber) {
      if (phoneNumber === bobPhone) return { participantId: 'bob', displayName: 'Bob' }
      if (phoneNumber === carolPhone) return { participantId: 'carol', displayName: 'Carol' }
      throw new Error('unknown participant')
    },
    async bootstrapAccess() {
      return participants
    }
  }
}

function createClient(options: {
  senderId: string
  identity: ClientIdentityAdapter
  storage?: DurableCollaborativeStorage
  network?: DeterministicTransportNetwork
  clock?: { now(): number }
}): CollaborativeClient {
  const network = options.network ?? new DeterministicTransportNetwork()
  return new CollaborativeClient({
    senderId: options.senderId,
    identity: options.identity,
    storage: options.storage ?? new MemoryCollaborativeStorage(),
    transportFactory: ({ documentId: id }) => network.createTransport(`${options.senderId}:${id}`),
    ...(options.clock === undefined ? {} : { clock: options.clock })
  })
}

async function rootCommitment(bytes: Uint8Array): Promise<string> {
  const root = decodeAuthorizationRootPayload(bytes)
  const { signature: _signature, ...unsigned } = root
  return encodeAuthorizationCommitment(await authorizationRootCommitment(unsigned))
}

async function signedArchiveWire(options: {
  actor: string
  action: 'archive' | 'unarchive'
  revision: number
  predecessor: Uint8Array
  messageId: string
}): Promise<{ wire: Uint8Array; controlId: string; payload: Uint8Array }> {
  const unsigned = {
    documentId,
    revision: options.revision,
    predecessor: options.predecessor,
    action: options.action,
    actorUserId: options.actor,
    timestamp: options.revision
  }
  const signingBytes = archivePayloadSigningBytes(unsigned)
  const payload = encodeArchivePayload({
    ...unsigned,
    signature: await testSignature(signingBytes)
  })
  return {
    payload,
    wire: encodeEnvelope(
      createEnvelope({
        documentId,
        messageId: options.messageId,
        senderId: options.actor,
        kind: 'archive',
        createdAt: options.revision,
        payload
      })
    ),
    controlId: encodeAuthorizationCommitment(await authorizationControlCommitment(signingBytes))
  }
}

async function sendWire(
  network: DeterministicTransportNetwork,
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

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
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

function twoAdminParticipants(): readonly DocumentParticipant[] {
  return [
    { participantId: 'alice', role: 'admin', active: true },
    { participantId: 'carol', role: 'admin', active: true },
    { participantId: 'bob', role: 'writer', active: true }
  ]
}

async function createForkReplica(options: {
  senderId: 'alice' | 'carol' | 'bob'
  storage?: DurableCollaborativeStorage
  network?: DeterministicTransportNetwork
  participants?: readonly DocumentParticipant[]
  secondActor?: 'carol' | 'bob'
}) {
  const network = options.network ?? new DeterministicTransportNetwork()
  const storage = options.storage ?? new MemoryCollaborativeStorage()
  const client = createClient({
    senderId: options.senderId,
    network,
    storage,
    identity: legacyIdentity(options.participants ?? twoAdminParticipants())
  })
  const session = await client.openDocument(documentId)
  const genesis = authorizationGenesisPredecessor()
  const first = await signedArchiveWire({
    actor: 'alice',
    action: 'archive',
    revision: 1,
    predecessor: genesis,
    messageId: '71000000-0000-4000-8000-000000000001'
  })
  const second = await signedArchiveWire({
    actor: options.secondActor ?? 'carol',
    action: 'unarchive',
    revision: 1,
    predecessor: genesis,
    messageId: '71000000-0000-4000-8000-000000000002'
  })
  await sendWire(network, `${options.senderId}-fork-a`, first.wire)
  await waitFor(() => session.getAccessState().revision === 1)
  await sendWire(network, `${options.senderId}-fork-b`, second.wire)
  await waitFor(() => session.getAccessState().authorizationStatus === 'conflict')
  const authorization = await storage.loadAuthorizationState(documentId)
  const chosen = authorization?.conflict?.controlIds[0]
  if (!chosen) throw new Error('fork did not produce a canonical choice')
  return { client, session, storage, network, first, second, chosen }
}

describe('R6 authenticated authorization bootstrap', () => {
  it('never mints a shared root from bootstrap metadata during a fresh open', async () => {
    const evidence = createEvidenceCache()
    const freshJoiner = createClient({
      senderId: 'bob',
      identity: authenticatedIdentity('bob', evidence)
    })

    await expect(freshJoiner.openDocument(documentId)).rejects.toMatchObject({
      code: 'authorization-denied'
    })
    expect(evidence.root).toBeUndefined()
    await freshJoiner.close()

    const explicitCreator = createClient({
      senderId: 'alice',
      identity: authenticatedIdentity('alice', evidence)
    })
    const created = await explicitCreator.createDocument({ documentId })
    expect(created.getAccessState()).toMatchObject({
      selfRole: 'admin',
      revision: 0,
      authorizationStatus: 'active'
    })
    expect(created.getAccessState().authorizationRoot).toMatch(/^[0-9a-f]{64}$/)
    expect(evidence.root).toBeDefined()
    await explicitCreator.close()
  })

  it('derives the same creator-signed root on two fresh replicas using independently computed identity-key commitments', async () => {
    const evidence = createEvidenceCache()
    const initialParticipants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const first = createClient({
      senderId: 'alice',
      identity: authenticatedIdentity('alice', evidence, {
        initialParticipants
      })
    })
    const firstSession = await first.createDocument({ documentId })
    const root = firstSession.getAccessState().authorizationRoot
    expect(root).toMatch(/^[0-9a-f]{64}$/)
    expect(evidence.root && (await rootCommitment(evidence.root))).toBe(root)

    const second = createClient({
      senderId: 'bob',
      identity: authenticatedIdentity('bob', evidence, { expectedRoot: () => root })
    })
    const secondSession = await second.openDocument(documentId)
    expect(secondSession.getAccessState()).toMatchObject({
      selfRole: 'writer',
      revision: 0,
      authorizationRoot: root,
      authorizationHead: root,
      authorizationStatus: 'active'
    })
    expect(secondSession.getAccessState().participants).toEqual(
      firstSession.getAccessState().participants
    )
    await first.close()
    await second.close()
  })

  it('rejects a role-tampered signed root before installing any shared authority', async () => {
    const evidence = createEvidenceCache()
    const originalUnsigned = {
      documentId,
      creatorUserId: 'alice',
      participants: [
        {
          participantId: 'alice',
          role: 'admin' as const,
          active: true,
          identityKeyCommitment: await identityCommitment('alice')
        },
        {
          participantId: 'bob',
          role: 'writer' as const,
          active: true,
          identityKeyCommitment: await identityCommitment('bob')
        }
      ]
    }
    const signature = await testSignature(authorizationRootSigningBytes(originalUnsigned))
    const tampered: AuthorizationRootPayload = {
      ...originalUnsigned,
      participants: originalUnsigned.participants.map((participant) =>
        participant.participantId === 'bob'
          ? { ...participant, role: 'admin' as const }
          : participant
      ),
      signature
    }
    evidence.root = encodeAuthorizationRootPayload(tampered)
    const pinned = await rootCommitment(evidence.root)
    const bob = createClient({
      senderId: 'bob',
      identity: authenticatedIdentity('bob', evidence, { expectedRoot: () => pinned })
    })
    await expect(bob.openDocument(documentId)).rejects.toMatchObject({
      code: 'authorization-denied'
    })
    await bob.close()
  })

  it('late joiner verifies the pinned root plus signed invite chain and reaches the same head', async () => {
    const evidence = createEvidenceCache()
    const alice = createClient({
      senderId: 'alice',
      identity: authenticatedIdentity('alice', evidence)
    })
    const aliceSession = await alice.createDocument({ documentId })
    const root = aliceSession.getAccessState().authorizationRoot!
    await aliceSession.inviteParticipant(bobPhone, 'writer')
    const head = aliceSession.getAccessState().authorizationHead!
    expect(head).not.toBe(root)
    expect(evidence.controls).toHaveLength(1)

    const bob = createClient({
      senderId: 'bob',
      identity: authenticatedIdentity('bob', evidence, {
        expectedRoot: () => root,
        expectedHead: () => head
      })
    })
    const bobSession = await bob.openDocument(documentId)
    expect(bobSession.getAccessState()).toMatchObject({
      selfRole: 'writer',
      revision: 1,
      authorizationRoot: root,
      authorizationHead: head,
      authorizationStatus: 'active'
    })
    expect(bobSession.getAccessState().participants).toContainEqual(
      expect.objectContaining({ participantId: 'bob', role: 'writer', active: true })
    )
    await alice.close()
    await bob.close()
  })

  it('a stale bootstrap response cannot reset an established durable head', async () => {
    const evidence = createEvidenceCache()
    const storage = new MemoryCollaborativeStorage()
    let expectedHead: string | undefined
    const adapter = authenticatedIdentity('alice', evidence, {
      expectedHead: () => expectedHead
    })
    const alice = createClient({ senderId: 'alice', identity: adapter, storage })
    const session = await alice.createDocument({ documentId })
    const root = session.getAccessState().authorizationRoot!
    await session.inviteParticipant(bobPhone, 'writer')
    const durableHead = session.getAccessState().authorizationHead!
    await session.close()

    expectedHead = root
    const reopened = createClient({
      senderId: 'alice',
      identity: authenticatedIdentity('alice', evidence, {
        expectedRoot: () => root,
        expectedHead: () => expectedHead
      }),
      storage
    })
    await expect(reopened.openDocument(documentId)).rejects.toThrow(
      /conflicts with the durable authorization head/
    )
    expect((await storage.loadAccessControl(documentId))?.authorizationHead).toBe(durableHead)
    await reopened.close()
    await alice.close()
  })

  it('keeps legacy revision-0 multi-member and revision>0 anchors explicitly unverified', async () => {
    for (const [revision, participants] of [
      [
        0,
        [
          { participantId: 'alice', role: 'admin' as const, active: true },
          { participantId: 'bob', role: 'writer' as const, active: true }
        ]
      ],
      [3, [{ participantId: 'alice', role: 'admin' as const, active: true }]]
    ] as const) {
      const evidence = createEvidenceCache()
      const storage = new MemoryCollaborativeStorage()
      await storage.saveAccessControl(documentId, {
        selfRole: 'admin',
        participants,
        archived: false,
        deleted: false,
        revision
      })
      const client = createClient({
        senderId: 'alice',
        storage,
        identity: authenticatedIdentity('alice', evidence)
      })
      await expect(client.openDocument(documentId)).rejects.toThrow(/explicit migration proof/)
      const authorization = await storage.loadAuthorizationState(documentId)
      expect(authorization?.anchorKind).toBe(
        revision === 0 ? 'legacy-zero-genesis' : 'legacy-local-anchor'
      )
      expect(authorization?.rootProof).toBeUndefined()
      expect((await storage.loadAccessControl(documentId))?.authorizationRoot).toBeUndefined()
      await client.close()
    }
  })

  it('CRDT edits and snapshots cannot reset a verified root or authorization head', async () => {
    const evidence = createEvidenceCache()
    const alice = createClient({
      senderId: 'alice',
      identity: authenticatedIdentity('alice', evidence)
    })
    const session = await alice.createDocument({ documentId })
    const root = session.getAccessState().authorizationRoot!
    await session.inviteParticipant(bobPhone, 'writer')
    const head = session.getAccessState().authorizationHead!
    await session.editText('CRDT bytes are not ACL authority')
    await session.publishSnapshot()
    expect(session.getAccessState()).toMatchObject({
      authorizationRoot: root,
      authorizationHead: head,
      revision: 1
    })
    await alice.close()
  })
})

describe('R6 signed fork reconciliation', () => {
  it('remains frozen until all pre-fork active admins approve, then converges to a durable resolution', async () => {
    const aliceReplica = await createForkReplica({ senderId: 'alice' })
    const carolReplica = await createForkReplica({ senderId: 'carol' })
    expect(aliceReplica.session.getAccessState().authorizationStatus).toBe('conflict')

    const aliceApproval = await aliceReplica.session.approveForkResolution(aliceReplica.chosen)
    await expect(
      aliceReplica.session.resolveFork(aliceReplica.chosen, [aliceApproval])
    ).rejects.toThrow(/unanimous signatures|at least two independent/)
    expect(aliceReplica.session.getAccessState().authorizationStatus).toBe('conflict')

    const carolApproval = await carolReplica.session.approveForkResolution(aliceReplica.chosen)
    await aliceReplica.session.resolveFork(aliceReplica.chosen, [carolApproval, aliceApproval])
    const resolved = aliceReplica.session.getAccessState()
    expect(resolved).toMatchObject({ revision: 2, authorizationStatus: 'active' })
    const authorization = await aliceReplica.storage.loadAuthorizationState(documentId)
    expect(authorization?.conflict).toBeUndefined()
    expect(authorization?.resolutions).toHaveLength(1)
    expect(authorization?.head).toBe(resolved.authorizationHead)

    await aliceReplica.client.close()
    await carolReplica.client.close()
  })

  it('rejects forged approval signatures and a non-canonical branch choice', async () => {
    const aliceReplica = await createForkReplica({ senderId: 'alice' })
    const carolReplica = await createForkReplica({ senderId: 'carol' })
    const aliceApproval = await aliceReplica.session.approveForkResolution(aliceReplica.chosen)
    const carolApproval = await carolReplica.session.approveForkResolution(aliceReplica.chosen)
    const forged: ForkResolutionApproval = {
      ...carolApproval,
      signature: new Uint8Array(64)
    }
    await expect(
      aliceReplica.session.resolveFork(aliceReplica.chosen, [aliceApproval, forged])
    ).rejects.toThrow(/approval is invalid/)
    const alternate = [aliceReplica.first.controlId, aliceReplica.second.controlId].find(
      (controlId) => controlId !== aliceReplica.chosen
    )!
    await expect(aliceReplica.session.approveForkResolution(alternate)).rejects.toThrow(
      /deterministic control/
    )
    expect(aliceReplica.session.getAccessState().authorizationStatus).toBe('conflict')
    await aliceReplica.client.close()
    await carolReplica.client.close()
  })

  it('binds verified-root fork approvals to the pre-fork identity-key commitments', async () => {
    const evidence = createEvidenceCache()
    const participants = twoAdminParticipants()
    let substituteCarolKey = false
    const substitutedCarolKey = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('identity:carol:substituted'))
    )
    const aliceNetwork = new DeterministicTransportNetwork()
    const aliceStorageName = `e2e-col-r6-verified-resolution-${crypto.randomUUID()}`
    const aliceStorage = new IndexedDbCollaborativeStorage({
      name: aliceStorageName,
      indexedDB: fakeIndexedDb
    })
    const alice = createClient({
      senderId: 'alice',
      network: aliceNetwork,
      storage: aliceStorage,
      identity: authenticatedIdentity('alice', evidence, {
        initialParticipants: participants,
        identityCommitmentFor: async (participantId) =>
          substituteCarolKey && participantId === 'carol'
            ? substitutedCarolKey
            : identityCommitment(participantId)
      })
    })
    const aliceSession = await alice.createDocument({ documentId })
    const root = aliceSession.getAccessState().authorizationRoot!

    const carolNetwork = new DeterministicTransportNetwork()
    const carolStorage = new MemoryCollaborativeStorage()
    const carol = createClient({
      senderId: 'carol',
      network: carolNetwork,
      storage: carolStorage,
      identity: authenticatedIdentity('carol', evidence, { expectedRoot: () => root })
    })
    const carolSession = await carol.openDocument(documentId)
    expect(carolSession.getAccessState()).toMatchObject({
      selfRole: 'admin',
      authorizationRoot: root,
      authorizationHead: root,
      authorizationStatus: 'active'
    })

    const predecessor = decodeAuthorizationCommitment(root)
    const first = await signedArchiveWire({
      actor: 'alice',
      action: 'archive',
      revision: 1,
      predecessor,
      messageId: '71200000-0000-4000-8000-000000000001'
    })
    const second = await signedArchiveWire({
      actor: 'carol',
      action: 'unarchive',
      revision: 1,
      predecessor,
      messageId: '71200000-0000-4000-8000-000000000002'
    })
    for (const [network, prefix] of [
      [aliceNetwork, 'alice-verified-fork'],
      [carolNetwork, 'carol-verified-fork']
    ] as const) {
      await sendWire(network, `${prefix}-a`, first.wire)
      await sendWire(network, `${prefix}-b`, second.wire)
    }
    await waitFor(() => aliceSession.getAccessState().authorizationStatus === 'conflict')
    await waitFor(() => carolSession.getAccessState().authorizationStatus === 'conflict')
    const chosen = (await aliceStorage.loadAuthorizationState(documentId))?.conflict?.controlIds[0]
    if (!chosen) throw new Error('verified-root fork did not produce a canonical choice')
    const approvals = [
      await aliceSession.approveForkResolution(chosen),
      await carolSession.approveForkResolution(chosen)
    ]

    substituteCarolKey = true
    await expect(aliceSession.resolveFork(chosen, approvals)).rejects.toThrow(
      /Identity-key binding mismatch for fork-resolution approver carol/
    )
    expect(aliceSession.getAccessState()).toMatchObject({
      authorizationRoot: root,
      authorizationStatus: 'conflict'
    })

    substituteCarolKey = false
    await aliceSession.resolveFork(chosen, approvals)
    const resolvedHead = aliceSession.getAccessState().authorizationHead!
    expect(aliceSession.getAccessState()).toMatchObject({
      revision: 2,
      authorizationRoot: root,
      authorizationHead: resolvedHead,
      authorizationStatus: 'active'
    })
    expect((await aliceStorage.loadAuthorizationState(documentId))?.anchorKind).toBe(
      'verified-root'
    )

    await alice.close()
    const reopenedStorage = new IndexedDbCollaborativeStorage({
      name: aliceStorageName,
      indexedDB: fakeIndexedDb
    })
    const reopened = createClient({
      senderId: 'alice',
      storage: reopenedStorage,
      identity: authenticatedIdentity('alice', evidence, { expectedRoot: () => root })
    })
    const reopenedSession = await reopened.openDocument(documentId)
    expect(reopenedSession.getAccessState()).toMatchObject({
      revision: 2,
      authorizationRoot: root,
      authorizationHead: resolvedHead,
      authorizationStatus: 'active'
    })
    expect((await reopenedStorage.loadAuthorizationState(documentId))?.anchorKind).toBe(
      'verified-root'
    )

    await reopened.close()
    await carol.close()
  })

  it('buffers a valid resolution delivered before its fork controls and converges after reverse-order delivery', async () => {
    const aliceReplica = await createForkReplica({ senderId: 'alice' })
    const carolReplica = await createForkReplica({ senderId: 'carol' })
    const approvals = [
      await aliceReplica.session.approveForkResolution(aliceReplica.chosen),
      await carolReplica.session.approveForkResolution(aliceReplica.chosen)
    ]
    await aliceReplica.session.resolveFork(aliceReplica.chosen, approvals)
    const resolutionWire = (await aliceReplica.storage.listOutbound(documentId)).find(
      (record) => record.kind === 'authorization-resolution'
    )?.payload
    if (!resolutionWire) throw new Error('resolution wire was not retained')

    const bobNetwork = new DeterministicTransportNetwork()
    const bobStorage = new MemoryCollaborativeStorage()
    const bob = createClient({
      senderId: 'bob',
      network: bobNetwork,
      storage: bobStorage,
      identity: legacyIdentity(twoAdminParticipants())
    })
    const bobSession = await bob.openDocument(documentId)
    await sendWire(bobNetwork, 'resolution-first', resolutionWire)
    await waitFor(
      async () =>
        (await bobStorage.loadAuthorizationState(documentId))?.pendingResolutions?.length === 1
    )
    await sendWire(bobNetwork, 'branch-second', aliceReplica.second.wire)
    await waitFor(() => bobSession.getAccessState().revision === 1)
    await sendWire(bobNetwork, 'branch-first', aliceReplica.first.wire)
    await waitFor(() => bobSession.getAccessState().revision === 2)
    const bobAccess = bobSession.getAccessState()
    const aliceAccess = aliceReplica.session.getAccessState()
    expect(bobAccess).toMatchObject({
      revision: aliceAccess.revision,
      archived: aliceAccess.archived,
      deleted: aliceAccess.deleted,
      authorizationHead: aliceAccess.authorizationHead,
      authorizationStatus: 'active'
    })
    expect(
      [...bobAccess.participants].sort((left, right) =>
        left.participantId.localeCompare(right.participantId)
      )
    ).toEqual(
      [...aliceAccess.participants].sort((left, right) =>
        left.participantId.localeCompare(right.participantId)
      )
    )
    expect((await bobStorage.loadAuthorizationState(documentId))?.pendingResolutions).toHaveLength(
      0
    )

    await bob.close()
    await aliceReplica.client.close()
    await carolReplica.client.close()
  })

  it('survives IndexedDB close/reopen and permanently supersedes old branch controls after seen-message TTL expiry', async () => {
    let now = 10_000
    const name = `e2e-col-r6-resolution-${crypto.randomUUID()}`
    const storage = new IndexedDbCollaborativeStorage({
      name,
      indexedDB: fakeIndexedDb,
      seenMessageTtlMs: 10,
      now: () => now
    })
    const aliceReplica = await createForkReplica({ senderId: 'alice', storage })
    const carolReplica = await createForkReplica({ senderId: 'carol' })
    const approvals = [
      await aliceReplica.session.approveForkResolution(aliceReplica.chosen),
      await carolReplica.session.approveForkResolution(aliceReplica.chosen)
    ]
    await aliceReplica.session.resolveFork(aliceReplica.chosen, approvals)
    const durableHead = aliceReplica.session.getAccessState().authorizationHead!
    await aliceReplica.client.close()

    now += 20
    const reopenedStorage = new IndexedDbCollaborativeStorage({
      name,
      indexedDB: fakeIndexedDb,
      seenMessageTtlMs: 10,
      now: () => now
    })
    const network = new DeterministicTransportNetwork()
    const reopened = createClient({
      senderId: 'alice',
      network,
      storage: reopenedStorage,
      identity: legacyIdentity(twoAdminParticipants()),
      clock: { now: () => now }
    })
    const session = await reopened.openDocument(documentId)
    expect(session.getAccessState()).toMatchObject({
      revision: 2,
      authorizationHead: durableHead,
      authorizationStatus: 'active'
    })
    await reopenedStorage.pruneSeenMessages(now)
    await sendWire(network, 'old-exact-branch-after-ttl', aliceReplica.first.wire)
    await tick()
    expect(session.getAccessState().authorizationHead).toBe(durableHead)

    const hiddenSibling = await signedArchiveWire({
      actor: 'alice',
      action: aliceReplica.first.controlId === aliceReplica.chosen ? 'unarchive' : 'archive',
      revision: 1,
      predecessor: authorizationGenesisPredecessor(),
      messageId: '71000000-0000-4000-8000-000000000099'
    })
    await sendWire(network, 'old-hidden-sibling-after-resolution', hiddenSibling.wire)
    await tick()
    expect(session.getAccessState()).toMatchObject({
      revision: 2,
      authorizationHead: durableHead,
      authorizationStatus: 'active'
    })
    expect((await reopenedStorage.loadAuthorizationState(documentId))?.conflict).toBeUndefined()
    await reopened.close()
    await carolReplica.client.close()
  })

  it('cannot reconcile a delete fork onto a live branch or later resurrect the deleted document', async () => {
    const participants = twoAdminParticipants()
    const genesis = authorizationGenesisPredecessor()
    const deleted = await signedDeleteWire({
      actor: 'alice',
      revision: 1,
      predecessor: genesis,
      messageId: '71500000-0000-4000-8000-000000000001'
    })
    const liveSibling = await signedArchiveWire({
      actor: 'carol',
      action: 'unarchive',
      revision: 1,
      predecessor: genesis,
      messageId: '71500000-0000-4000-8000-000000000002'
    })

    async function replica(senderId: 'alice' | 'carol') {
      const network = new DeterministicTransportNetwork()
      const storage = new MemoryCollaborativeStorage()
      const client = createClient({
        senderId,
        network,
        storage,
        identity: legacyIdentity(participants)
      })
      const session = await client.openDocument(documentId)
      await sendWire(network, `${senderId}-delete-branch`, deleted.wire)
      await waitFor(() => session.getAccessState().revision === 1)
      await sendWire(network, `${senderId}-live-branch`, liveSibling.wire)
      await waitFor(() => session.getAccessState().authorizationStatus === 'conflict')
      return { client, session, network, storage }
    }

    const aliceReplica = await replica('alice')
    const carolReplica = await replica('carol')
    await expect(aliceReplica.session.approveForkResolution(liveSibling.controlId)).rejects.toThrow(
      /deterministic control/
    )
    const approvals = [
      await aliceReplica.session.approveForkResolution(deleted.controlId),
      await carolReplica.session.approveForkResolution(deleted.controlId)
    ]
    await aliceReplica.session.resolveFork(deleted.controlId, approvals)
    const resolvedHead = aliceReplica.session.getAccessState().authorizationHead
    expect(aliceReplica.session.getAccessState()).toMatchObject({
      revision: 2,
      deleted: true,
      authorizationStatus: 'active'
    })
    await expect(aliceReplica.session.unarchive()).rejects.toThrow(/admin permission|deleted/i)
    await sendWire(
      aliceReplica.network,
      'stale-live-sibling-after-delete-resolution',
      liveSibling.wire
    )
    await tick()
    expect(aliceReplica.session.getAccessState()).toMatchObject({
      revision: 2,
      deleted: true,
      authorizationHead: resolvedHead,
      authorizationStatus: 'active'
    })
    await aliceReplica.client.close()
    await carolReplica.client.close()
  })

  it('does not count an admin removed before the common predecessor as resolution authority', async () => {
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'admin', active: true },
      { participantId: 'carol', role: 'admin', active: false }
    ]
    const aliceReplica = await createForkReplica({
      senderId: 'alice',
      participants,
      secondActor: 'bob'
    })
    const bobReplica = await createForkReplica({
      senderId: 'bob',
      participants,
      secondActor: 'bob'
    })
    const approvals = [
      await aliceReplica.session.approveForkResolution(aliceReplica.chosen),
      await bobReplica.session.approveForkResolution(aliceReplica.chosen)
    ]
    const removedAdminApproval: ForkResolutionApproval = {
      actorUserId: 'carol',
      signature: new Uint8Array(64)
    }
    await expect(
      aliceReplica.session.resolveFork(aliceReplica.chosen, [...approvals, removedAdminApproval])
    ).rejects.toThrow(/unanimous signatures from the pre-fork active-admin set/)
    await aliceReplica.session.resolveFork(aliceReplica.chosen, approvals)
    expect(aliceReplica.session.getAccessState()).toMatchObject({
      revision: 2,
      authorizationStatus: 'active'
    })
    await aliceReplica.client.close()
    await bobReplica.client.close()
  })

  it('keeps a single-admin fork fail-closed because no independent quorum exists', async () => {
    const participants: readonly DocumentParticipant[] = [
      { participantId: 'alice', role: 'admin', active: true },
      { participantId: 'bob', role: 'writer', active: true }
    ]
    const network = new DeterministicTransportNetwork()
    const storage = new MemoryCollaborativeStorage()
    const client = createClient({
      senderId: 'alice',
      network,
      storage,
      identity: legacyIdentity(participants)
    })
    const session = await client.openDocument(documentId)
    const first = await signedArchiveWire({
      actor: 'alice',
      action: 'archive',
      revision: 1,
      predecessor: authorizationGenesisPredecessor(),
      messageId: '72000000-0000-4000-8000-000000000001'
    })
    const second = await signedArchiveWire({
      actor: 'alice',
      action: 'unarchive',
      revision: 1,
      predecessor: authorizationGenesisPredecessor(),
      messageId: '72000000-0000-4000-8000-000000000002'
    })
    await sendWire(network, 'single-admin-a', first.wire)
    await waitFor(() => session.getAccessState().revision === 1)
    await sendWire(network, 'single-admin-b', second.wire)
    await waitFor(() => session.getAccessState().authorizationStatus === 'conflict')
    const chosen = (await storage.loadAuthorizationState(documentId))?.conflict?.controlIds[0]
    if (!chosen) throw new Error('single-admin fork did not produce a canonical choice')
    await expect(session.approveForkResolution(chosen)).rejects.toThrow(/at least two independent/)
    expect(session.getAccessState().authorizationStatus).toBe('conflict')
    await client.close()
  })
})
