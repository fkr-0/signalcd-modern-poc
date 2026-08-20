import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { ToySignalCliServer } from '../../apps/toy-signal-cli/src/server'
import { type ClientIdentityAdapter, CollaborativeClient } from '../../packages/client/src/index'
import {
  HttpIdentityProvider,
  IdentityClient,
  MemoryIdentityStorage,
  type UserIdentity
} from '../../packages/identity/src/index'
import {
  type DocumentParticipant,
  type DocumentRole,
  decodeEncryptedEnvelope,
  encodeEncryptedEnvelope,
  type ProtocolEnvelope
} from '../../packages/protocol/src/index'
import { MemoryCollaborativeStorage } from '../../packages/storage/src/index'
import {
  encodeMockSignalFanoutFrame,
  MockSignalTransport,
  type WebSocketLike
} from '../../packages/transport/src/index'

const documentId = '11111111-1111-4111-8111-111111111111'
const servers: ToySignalCliServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

describe('production-style encrypted client integration', () => {
  it('registers/restores identities and converges through IdentityClient + MockSignalTransport + CollaborativeClient', async () => {
    const server = new ToySignalCliServer({ port: 0 })
    servers.push(server)
    const { baseUrl } = await server.start()
    const socketUrl = `${baseUrl.replace(/^http:/, 'ws:')}/api/v1/messages`
    const provider = new HttpIdentityProvider({ baseUrl })

    const aliceIdentityStorage = new MemoryIdentityStorage()
    const bobIdentityStorage = new MemoryIdentityStorage()
    const aliceRegistrationClient = new IdentityClient({ provider, storage: aliceIdentityStorage })
    const bobRegistrationClient = new IdentityClient({ provider, storage: bobIdentityStorage })
    const registeredAlice = await aliceRegistrationClient.register('Alice integration')
    const registeredBob = await bobRegistrationClient.register('Bob integration')

    // Restore through the same public IdentityClient session path that a browser restart uses.
    const aliceIdentityClient = new IdentityClient({ provider, storage: aliceIdentityStorage })
    const bobIdentityClient = new IdentityClient({ provider, storage: bobIdentityStorage })
    const aliceIdentity = await aliceIdentityClient.openSession()
    const bobIdentity = await bobIdentityClient.openSession()
    expect(aliceIdentity?.userId).toBe(registeredAlice.userId)
    expect(bobIdentity?.userId).toBe(registeredBob.userId)
    if (!aliceIdentity || !bobIdentity) throw new Error('registered identities did not restore')

    const groupId = await createGroup(baseUrl, aliceIdentity, bobIdentity.phoneNumber)
    const aliceStorage = new MemoryCollaborativeStorage()
    const bobStorage = new MemoryCollaborativeStorage()
    const alice = createEncryptedClient({
      identity: aliceIdentity,
      identityClient: aliceIdentityClient,
      storage: aliceStorage,
      socketUrl,
      groupId
    })
    const bob = createEncryptedClient({
      identity: bobIdentity,
      identityClient: bobIdentityClient,
      storage: bobStorage,
      socketUrl,
      groupId
    })

    try {
      const aliceSession = await alice.createDocument({ documentId })
      const initial = await aliceStorage.loadDocument(documentId)
      if (!initial) throw new Error('Alice document was not persisted')
      await bobStorage.saveDocument(initial)
      const bobSession = await bob.openDocument(documentId)

      const aliceText = 'encrypted through the real identity and mock Signal path'
      await aliceSession.editText(aliceText)
      await waitFor(() => bobSession.getView().text === aliceText)
      expect(bobSession.getView().text).toBe(aliceText)

      const converged = `${aliceText}\nBob applied and encrypted a CRDT change back.`
      await bobSession.editText(converged)
      await waitFor(() => aliceSession.getView().text === converged)
      expect(aliceSession.getView().text).toBe(converged)
      expect(bobSession.getView().text).toBe(converged)

      const stateText = await fetch(`${baseUrl}/__toy__/v1/state`).then((response) =>
        response.text()
      )
      expect(stateText).not.toContain(aliceText)
      expect(stateText).not.toContain('Bob applied and encrypted a CRDT change back.')
      const state = JSON.parse(stateText) as {
        collaboration: { messages: Array<{ group_id: string; recipients: unknown[] }> }
      }
      const groupMessages = state.collaboration.messages.filter(
        (entry) => entry.group_id === groupId
      )
      expect(groupMessages).toHaveLength(2)
      expect(groupMessages.every((entry) => entry.recipients.length === 1)).toBe(true)
    } finally {
      await Promise.all([alice.close(), bob.close()])
      await Promise.all([aliceIdentityClient.close(), bobIdentityClient.close()])
    }
  })
})

function createEncryptedClient(options: {
  readonly identity: UserIdentity
  readonly identityClient: IdentityClient
  readonly storage: MemoryCollaborativeStorage
  readonly socketUrl: string
  readonly groupId: string
}): CollaborativeClient {
  let transport: MockSignalTransport | undefined
  return new CollaborativeClient({
    senderId: options.identity.userId,
    storage: options.storage,
    transportFactory: () => {
      transport = new MockSignalTransport({
        url: options.socketUrl,
        authToken: options.identity.sessionToken,
        groupId: options.groupId,
        userId: options.identity.userId,
        phoneNumber: options.identity.phoneNumber,
        socketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike
      })
      return transport
    },
    identity: encryptedIdentityAdapter(options.identity, options.identityClient, () => transport)
  })
}

function encryptedIdentityAdapter(
  localIdentity: UserIdentity,
  identityClient: IdentityClient,
  transport: () => MockSignalTransport | undefined
): ClientIdentityAdapter {
  function currentTransport(): MockSignalTransport {
    const value = transport()
    if (!value) throw new Error('mock Signal transport is not initialized')
    return value
  }

  function participantFor(
    userId: string
  ): ReturnType<MockSignalTransport['getGroupMembers']>[number] {
    const value = currentTransport()
      .getGroupMembers()
      .find((member) => member.userId === userId)
    if (!value) throw new Error(`unknown group participant ${userId}`)
    return value
  }

  return {
    async signControl(bytes) {
      return new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          localIdentity.identityKeyPair.privateKey,
          Uint8Array.from(bytes).buffer
        )
      )
    },
    async verifyControl(actorUserId, bytes, signature) {
      const publicKey =
        actorUserId === localIdentity.userId
          ? localIdentity.identityKeyPair.publicKey
          : (
              await identityClient.fetchRemoteIdentity(
                participantFor(actorUserId).phoneNumber,
                localIdentity
              )
            ).identityKeyPublic
      return crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        Uint8Array.from(signature).buffer,
        Uint8Array.from(bytes).buffer
      )
    },
    async resolveParticipant(phoneNumber: string, _role: DocumentRole) {
      const remote = await identityClient.fetchRemoteIdentity(phoneNumber, localIdentity)
      return {
        participantId: remote.userId,
        ...(remote.displayName === undefined ? {} : { displayName: remote.displayName })
      }
    },
    async bootstrapAccess() {
      return currentTransport()
        .getGroupMembers()
        .map(
          (member): DocumentParticipant => ({
            participantId: member.userId,
            role: member.role,
            active: true
          })
        )
    },
    async encodeEnvelope(envelope: ProtocolEnvelope, context) {
      const active = new Set(
        context.participants
          .filter((participant) => participant.active)
          .map((participant) => participant.participantId)
      )
      const recipients = currentTransport()
        .getGroupMembers()
        .filter((member) => member.userId !== localIdentity.userId && active.has(member.userId))
      if (recipients.length === 0) throw new Error('no active encrypted recipients')
      const encrypted = await Promise.all(
        recipients.map(async (recipient) => ({
          phoneNumber: recipient.phoneNumber,
          payload: encodeEncryptedEnvelope(
            await identityClient.encryptEnvelopeForRecipient(
              envelope,
              { userId: recipient.userId, phoneNumber: recipient.phoneNumber },
              localIdentity
            )
          )
        }))
      )
      return encodeMockSignalFanoutFrame({
        version: 1,
        messageId: envelope.messageId,
        recipients: encrypted
      })
    },
    async decodeEnvelope(wire) {
      return identityClient.decryptEnvelope(decodeEncryptedEnvelope(wire), localIdentity)
    }
  }
}

async function createGroup(
  baseUrl: string,
  admin: UserIdentity,
  memberPhoneNumber: string
): Promise<string> {
  const created = await fetch(`${baseUrl}/api/v1/groups`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${admin.sessionToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ document_id: documentId, name: 'Encrypted integration' })
  })
  expect(created.status).toBe(201)
  const group = (await created.json()) as { group_id: string }
  const added = await fetch(`${baseUrl}/api/v1/groups/${group.group_id}/members`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${admin.sessionToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ phone_number: memberPhoneNumber, role: 'writer' })
  })
  expect(added.status).toBe(200)
  return group.group_id
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not met')
}
