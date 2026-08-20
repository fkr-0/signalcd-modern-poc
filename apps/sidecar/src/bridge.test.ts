import { chunkEnvelope, createEnvelope, decodeEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { MemoryBroadcastBackend } from './backend'
import { SidecarBridge } from './bridge'

const documentId = '11111111-1111-4111-8111-111111111111'
const groupId = 'group-A=='

function frame(
  messageId = '22222222-2222-4222-8222-222222222222',
  payload = new Uint8Array([1, 2, 3])
): Uint8Array {
  return encodeEnvelope(
    createEnvelope({
      documentId,
      messageId,
      senderId: 'test-device',
      kind: 'automerge-change',
      createdAt: 1,
      payload
    })
  )
}

describe('SidecarBridge', () => {
  const bridges: SidecarBridge[] = []
  afterEach(async () => Promise.all(bridges.splice(0).map((bridge) => bridge.stop())))

  it('bridges validated binary frames to and from the broadcast backend', async () => {
    const backend = new MemoryBroadcastBackend()
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/?documentId=${documentId}`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })

    socket.send(frame())
    await viWait(() => backend.sent.length === 1)
    expect(backend.sent[0]!.groupId).toBe(groupId)

    let echoes = 0
    socket.on('message', () => (echoes += 1))
    backend.receive(backend.sent[0]!)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(echoes).toBe(0)

    const remote = frame('33333333-3333-4333-8333-333333333333')
    const received = new Promise<Uint8Array>((resolve) =>
      socket.once('message', (data) => resolve(new Uint8Array(data as Buffer)))
    )
    backend.receive({ groupId, message: signalBody(remote) })
    expect([...(await received)]).toEqual([...remote])
    socket.close()
  })

  it('drops malformed browser frames instead of forwarding them', async () => {
    const backend = new MemoryBroadcastBackend()
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/?documentId=${documentId}`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    socket.send(new Uint8Array([1, 2, 3]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(backend.sent).toHaveLength(0)
    socket.close()
  })

  it('deduplicates repeated Signal deliveries before browser forwarding', async () => {
    const backend = new MemoryBroadcastBackend()
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/?documentId=${documentId}`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    const remote = frame('44444444-4444-4444-8444-444444444444')
    let received = 0
    socket.on('message', () => (received += 1))
    backend.receive({ groupId, message: signalBody(remote) })
    backend.receive({ groupId, message: signalBody(remote) })
    await viWait(() => received === 1)
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(received).toBe(1)
    socket.close()
  })

  it('reassembles unique chunk indexes and ignores retransmitted indexes', async () => {
    const backend = new MemoryBroadcastBackend()
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0,
      chunkPayloadBytes: 2
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/?documentId=${documentId}`)
    await new Promise<void>((resolve) => socket.once('open', resolve))

    const original = decodeEnvelope(
      frame('55555555-5555-4555-8555-555555555555', new Uint8Array([1, 2, 3, 4, 5]))
    )
    let id = 0
    const chunks = chunkEnvelope(original, {
      maxPayloadBytes: 2,
      createMessageId: () => `66666666-6666-4666-8666-${(++id).toString().padStart(12, '0')}`
    })
    const retransmittedFirst = { ...chunks[0]!, messageId: '77777777-7777-4777-8777-777777777777' }
    const received = new Promise<Uint8Array>((resolve) =>
      socket.once('message', (data) => resolve(new Uint8Array(data as Buffer)))
    )
    backend.receive({ groupId, message: signalBody(encodeEnvelope(chunks[0]!)) })
    backend.receive({ groupId, message: signalBody(encodeEnvelope(retransmittedFirst)) })
    backend.receive({ groupId, message: signalBody(encodeEnvelope(chunks[2]!)) })
    backend.receive({ groupId, message: signalBody(encodeEnvelope(chunks[1]!)) })

    expect([...(await received)]).toEqual([...encodeEnvelope(original)])
    socket.close()
  })

  it('rejects non-loopback binding by default', () => {
    expect(
      () =>
        new SidecarBridge({
          backend: new MemoryBroadcastBackend(),
          documentGroups: { [documentId]: groupId },
          host: '0.0.0.0'
        })
    ).toThrow(/loopback/)
  })

  it('retries transient backend send failures with bounded attempts', async () => {
    class FlakyBackend extends MemoryBroadcastBackend {
      attempts = 0
      override async send(targetGroupId: string, message: string): Promise<void> {
        this.attempts += 1
        if (this.attempts < 3) throw new Error('transient')
        await super.send(targetGroupId, message)
      }
    }

    const backend = new FlakyBackend()
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0,
      retryDelayMs: 1,
      sendAttempts: 3
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/?documentId=${documentId}`)
    await new Promise<void>((resolve) => socket.once('open', resolve))
    socket.send(frame('88888888-8888-4888-8888-888888888888'))

    await viWait(() => backend.sent.length === 1)
    expect(backend.attempts).toBe(3)
    socket.close()
  })

  it('rejects browser WebSocket origins outside loopback by default', async () => {
    const backend = new MemoryBroadcastBackend()
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(
        `ws://${address.host}:${address.port}/?documentId=${documentId}`,
        {
          origin: 'https://evil.example'
        }
      )
      socket.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0))
      socket.once('error', reject)
    })
    expect(status).toBe(403)
  })
})

function signalBody(bytes: Uint8Array): string {
  return `e2e-col:v1:${Buffer.from(bytes).toString('base64')}`
}

async function viWait(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('condition was not met')
}
