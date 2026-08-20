import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import type { IdentityRegistrationRequest } from './identity-registry'
import { ToySignalCliServer } from './server'

const running: ToySignalCliServer[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe('encrypted collaboration groups and routing', () => {
  it('binds group membership to bearer identities and resets group state safely', async () => {
    const server = new ToySignalCliServer({ port: 0, now: () => 1_700_000_000_000 })
    running.push(server)
    const { baseUrl } = await server.start()
    const alice = await register(baseUrl, 'Alice')
    const bob = await register(baseUrl, 'Bob')
    const documentId = '11111111-1111-4111-8111-111111111111'

    const createdResponse = await fetch(`${baseUrl}/api/v1/groups`, {
      method: 'POST',
      headers: authJson(alice.token),
      body: JSON.stringify({ document_id: documentId, name: 'Encrypted draft' })
    })
    expect(createdResponse.status).toBe(201)
    const created = asRecord(await createdResponse.json())
    const groupId = String(created.group_id)
    expect(groupId).toMatch(/^[0-9a-f-]{36}$/)
    expect(asRecords(created.members)).toMatchObject([
      { user_id: alice.userId, phone_number: alice.phone, role: 'admin' }
    ])

    const addedResponse = await fetch(`${baseUrl}/api/v1/groups/${groupId}/members`, {
      method: 'POST',
      headers: authJson(alice.token),
      body: JSON.stringify({ phone_number: bob.phone, role: 'writer' })
    })
    expect(addedResponse.status).toBe(200)
    expect(asRecords(asRecord(await addedResponse.json()).members)).toHaveLength(2)

    const duplicateResponse = await fetch(`${baseUrl}/api/v1/groups/${groupId}/members`, {
      method: 'POST',
      headers: authJson(alice.token),
      body: JSON.stringify({ phone_number: bob.phone, role: 'writer' })
    })
    expect(duplicateResponse.status).toBe(409)

    const bobRead = await fetch(`${baseUrl}/api/v1/groups/${groupId}`, {
      headers: { authorization: `Bearer ${bob.token}` }
    })
    expect(bobRead.status).toBe(200)
    const bobMutation = await fetch(`${baseUrl}/api/v1/groups/${groupId}/members/${alice.phone}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${bob.token}` }
    })
    expect(bobMutation.status).toBe(403)

    const state = await stateOf(baseUrl)
    expect(JSON.stringify(state)).not.toContain(alice.token)
    expect(JSON.stringify(state)).not.toContain(bob.token)
    expect(asRecords(asRecord(state.collaboration).groups)).toHaveLength(1)

    const reset = await fetch(`${baseUrl}/__toy__/v1/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(reset.status).toBe(200)
    const resetState = asRecord(await reset.json())
    expect(asRecords(asRecord(resetState.collaboration).groups)).toEqual([])
  })

  it('fans recipient-specific opaque ciphertext out over authenticated WebSockets with duplicate/delay/offline tolerance', async () => {
    const server = new ToySignalCliServer({ port: 0 })
    running.push(server)
    const { baseUrl } = await server.start()
    const alice = await register(baseUrl, 'Alice')
    const bob = await register(baseUrl, 'Bob')
    const carol = await register(baseUrl, 'Carol')
    const documentId = '22222222-2222-4222-8222-222222222222'
    const group = asRecord(
      await (
        await fetch(`${baseUrl}/api/v1/groups`, {
          method: 'POST',
          headers: authJson(alice.token),
          body: JSON.stringify({ document_id: documentId })
        })
      ).json()
    )
    const groupId = String(group.group_id)
    for (const member of [bob, carol]) {
      const response = await fetch(`${baseUrl}/api/v1/groups/${groupId}/members`, {
        method: 'POST',
        headers: authJson(alice.token),
        body: JSON.stringify({ phone_number: member.phone, role: 'writer' })
      })
      expect(response.status).toBe(200)
    }

    const aliceSocket = await connect(baseUrl, alice.token, groupId, documentId)
    const bobSocket = await connect(baseUrl, bob.token, groupId, documentId)
    const carolSocket = await connect(baseUrl, carol.token, groupId, documentId)
    const bobCipher = new TextEncoder().encode('opaque-cipher-for-bob')
    const carolCipher = new TextEncoder().encode('opaque-cipher-for-carol')
    const bobDelivery = nextBinary(bobSocket)
    const carolDelivery = nextBinary(carolSocket)
    const ack = nextText(aliceSocket)
    aliceSocket.send(
      fanout('33333333-3333-4333-8333-333333333333', [
        [bob.phone, bobCipher],
        [carol.phone, carolCipher]
      ])
    )
    expect(await bobDelivery).toEqual(bobCipher)
    expect(await carolDelivery).toEqual(carolCipher)
    expect(asRecord(JSON.parse(await ack))).toMatchObject({
      type: 'ack',
      message_id: '33333333-3333-4333-8333-333333333333',
      recipients: 2
    })

    const firstState = await stateOf(baseUrl)
    const serialized = JSON.stringify(firstState)
    expect(serialized).not.toContain('opaque-cipher-for-bob')
    expect(serialized).not.toContain('opaque-cipher-for-carol')
    const messages = asRecords(asRecord(firstState.collaboration).messages)
    expect(messages).toHaveLength(1)
    expect(asRecords(messages[0]!.recipients)).toMatchObject([
      { phone_number: bob.phone, ciphertext_bytes: bobCipher.byteLength },
      { phone_number: carol.phone, ciphertext_bytes: carolCipher.byteLength }
    ])

    await fetch(`${baseUrl}/__toy__/v1/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ duplicateNextDeliveries: 1, deliveryDelayMs: 5 })
    })
    const duplicateA = nextBinary(bobSocket)
    const duplicateB = nextBinary(bobSocket)
    const delayedCarol = nextBinary(carolSocket)
    const duplicateAck = nextText(aliceSocket)
    aliceSocket.send(
      fanout('44444444-4444-4444-8444-444444444444', [
        [bob.phone, new Uint8Array([7, 8, 9])],
        [carol.phone, new Uint8Array([10, 11, 12])]
      ])
    )
    expect(await duplicateA).toEqual(new Uint8Array([7, 8, 9]))
    expect(await duplicateB).toEqual(new Uint8Array([7, 8, 9]))
    expect(await delayedCarol).toEqual(new Uint8Array([10, 11, 12]))
    await duplicateAck

    bobSocket.close()
    await onceClose(bobSocket)
    const offlineAck = nextText(aliceSocket)
    aliceSocket.send(
      fanout('55555555-5555-4555-8555-555555555555', [
        [bob.phone, new Uint8Array([21])],
        [carol.phone, new Uint8Array([22])]
      ])
    )
    await offlineAck
    const queuedState = await stateOf(baseUrl)
    expect(asRecord(queuedState.collaboration).pending_deliveries).toBe(1)

    const { delivery: queuedDelivery } = await reconnectWithPendingBinary(
      baseUrl,
      bob.token,
      groupId,
      documentId
    )
    expect(await queuedDelivery).toEqual(new Uint8Array([21]))
  })
})

interface Registered {
  token: string
  phone: string
  userId: string
}

async function register(baseUrl: string, name: string): Promise<Registered> {
  const response = await fetch(`${baseUrl}/api/v1/identity/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(await registration(name))
  })
  expect(response.status).toBe(201)
  const value = asRecord(await response.json())
  return {
    token: String(value.session_token),
    phone: String(value.phone_number),
    userId: String(value.user_id)
  }
}

async function registration(displayName: string): Promise<IdentityRegistrationRequest> {
  const identity = keyPair(
    await webcrypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  )
  const signed = keyPair(
    await webcrypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  )
  const signedPublic = new Uint8Array(await webcrypto.subtle.exportKey('raw', signed.publicKey))
  const signature = new Uint8Array(
    await webcrypto.subtle.sign({ name: 'Ed25519' }, identity.privateKey, signedPublic)
  )
  return {
    display_name: displayName,
    identity_key_public: base64(
      new Uint8Array(await webcrypto.subtle.exportKey('raw', identity.publicKey))
    ),
    signed_prekey_public: base64(signedPublic),
    signed_prekey_signature: base64(signature),
    one_time_prekeys: [await x25519Public(), await x25519Public()]
  }
}

async function x25519Public(): Promise<string> {
  const pair = keyPair(
    await webcrypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  )
  return base64(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)))
}

type NodeCryptoKey = Parameters<typeof webcrypto.subtle.exportKey>[1]

function keyPair(value: unknown): { publicKey: NodeCryptoKey; privateKey: NodeCryptoKey } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('publicKey' in value) ||
    !('privateKey' in value)
  )
    throw new Error('expected WebCrypto keypair')
  return value as { publicKey: NodeCryptoKey; privateKey: NodeCryptoKey }
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
}

function authJson(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
}

async function connect(
  baseUrl: string,
  token: string,
  groupId: string,
  documentId: string
): Promise<WebSocket> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/v1/messages`)
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const ready = nextText(socket)
  socket.send(
    JSON.stringify({ type: 'authenticate', token, group_id: groupId, document_id: documentId })
  )
  expect(asRecord(JSON.parse(await ready)).type).toBe('ready')
  return socket
}

async function reconnectWithPendingBinary(
  baseUrl: string,
  token: string,
  groupId: string,
  documentId: string
): Promise<{ socket: WebSocket; delivery: Promise<Uint8Array> }> {
  const socket = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/api/v1/messages`)
  sockets.push(socket)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  const ready = nextText(socket)
  const delivery = nextBinary(socket)
  socket.send(
    JSON.stringify({ type: 'authenticate', token, group_id: groupId, document_id: documentId })
  )
  expect(asRecord(JSON.parse(await ready)).type).toBe('ready')
  return { socket, delivery }
}

function fanout(messageId: string, recipients: readonly [string, Uint8Array][]): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: 'fanout',
      version: 1,
      message_id: messageId,
      recipients: recipients.map(([phone, payload]) => ({
        phone_number: phone,
        payload: base64(payload)
      }))
    })
  )
}

function nextText(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) return
      cleanup()
      resolve(data.toString())
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

function nextBinary(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData, isBinary: boolean) => {
      if (!isBinary) return
      cleanup()
      resolve(new Uint8Array(data as Buffer))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      socket.off('message', onMessage)
      socket.off('error', onError)
    }
    socket.on('message', onMessage)
    socket.on('error', onError)
  })
}

function onceClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
  return new Promise((resolve) => socket.once('close', () => resolve()))
}

async function stateOf(baseUrl: string): Promise<Record<string, unknown>> {
  return asRecord(await (await fetch(`${baseUrl}/__toy__/v1/state`)).json())
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('expected object')
  return value as Record<string, unknown>
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error('expected array')
  return value.map(asRecord)
}
