import { createEnvelope, decodeEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { SidecarBridge } from '../../sidecar/src/bridge'
import { SignalCliHttpBackend } from '../../sidecar/src/signal-cli'
import { DEFAULT_TOY_ACCOUNT_A, DEFAULT_TOY_ACCOUNT_B, DEFAULT_TOY_GROUP_ID } from './contract'
import { ToySignalCliServer } from './server'

const documentId = '11111111-1111-4111-8111-111111111111'

describe('toy signal-cli + real sidecar HTTP/SSE contract', () => {
  const toys: ToySignalCliServer[] = []
  const bridges: SidecarBridge[] = []
  const sockets: WebSocket[] = []

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close()
    await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
    await Promise.all(toys.splice(0).map((toy) => toy.stop()))
  })

  it('carries a protocol envelope browser A -> sidecar A -> toy Signal -> sidecar B -> browser B', async () => {
    const harness = await createHarness()
    const wire = frame(new Uint8Array([1, 2, 3, 4]))
    const received = onceBytes(harness.socketB)
    harness.socketA.send(wire)
    expect([...(await received)]).toEqual([...wire])
    await noMessage(harness.socketA)
  })

  it('carries chunked frames through the same HTTP/SSE boundary and reassembles remotely', async () => {
    const harness = await createHarness(8)
    const wire = frame(Uint8Array.from({ length: 97 }, (_, index) => index))
    const received = onceBytes(harness.socketB)
    harness.socketA.send(wire)
    const result = await received
    expect(decodeEnvelope(result).payload).toEqual(decodeEnvelope(wire).payload)
    expect(result).toEqual(wire)
  })

  it('demonstrates sidecar retry against an injected toy JSON-RPC send failure', async () => {
    const harness = await createHarness()
    await fetch(`${harness.baseUrl}/__toy__/v1/faults`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ failNextRpcSends: 1 })
    })
    const received = onceBytes(harness.socketB)
    harness.socketA.send(frame(new Uint8Array([9, 8, 7])))
    expect(decodeEnvelope(await received).payload).toEqual(new Uint8Array([9, 8, 7]))
  })

  async function createHarness(chunkPayloadBytes = 24 * 1024) {
    const toy = new ToySignalCliServer({ port: 0 })
    toys.push(toy)
    const { baseUrl } = await toy.start()
    const bridgeA = new SidecarBridge({
      backend: new SignalCliHttpBackend({
        baseUrl,
        account: DEFAULT_TOY_ACCOUNT_A,
        reconnectDelayMs: 1,
        reconnectMaxDelayMs: 5
      }),
      documentGroups: { [documentId]: DEFAULT_TOY_GROUP_ID },
      port: 0,
      chunkPayloadBytes,
      retryDelayMs: 1
    })
    const bridgeB = new SidecarBridge({
      backend: new SignalCliHttpBackend({
        baseUrl,
        account: DEFAULT_TOY_ACCOUNT_B,
        reconnectDelayMs: 1,
        reconnectMaxDelayMs: 5
      }),
      documentGroups: { [documentId]: DEFAULT_TOY_GROUP_ID },
      port: 0,
      chunkPayloadBytes,
      retryDelayMs: 1
    })
    bridges.push(bridgeA, bridgeB)
    const [addressA, addressB] = await Promise.all([bridgeA.start(), bridgeB.start()])
    await waitFor(() => toy.network.view().sseClients >= 2)

    const socketA = await openSocket(
      `ws://${addressA.host}:${addressA.port}/?documentId=${documentId}`
    )
    const socketB = await openSocket(
      `ws://${addressB.host}:${addressB.port}/?documentId=${documentId}`
    )
    sockets.push(socketA, socketB)
    return { baseUrl, socketA, socketB }
  }
})

function frame(payload: Uint8Array): Uint8Array {
  return encodeEnvelope(
    createEnvelope({
      documentId,
      messageId: crypto.randomUUID(),
      senderId: 'toy-browser-a',
      kind: 'automerge-change',
      createdAt: Date.now(),
      payload
    })
  )
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

function onceBytes(socket: WebSocket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('timed out waiting for WebSocket bytes')),
      2_000
    )
    socket.once('message', (value) => {
      clearTimeout(timeout)
      resolve(new Uint8Array(value as Buffer))
    })
  })
}

async function noMessage(socket: WebSocket): Promise<void> {
  let received = false
  const listener = () => (received = true)
  socket.on('message', listener)
  await new Promise((resolve) => setTimeout(resolve, 40))
  socket.off('message', listener)
  expect(received).toBe(false)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('condition was not met')
}
