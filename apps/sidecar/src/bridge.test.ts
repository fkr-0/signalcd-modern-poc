import { chunkEnvelope, createEnvelope, decodeEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { BroadcastRecoveryRequiredError, MemoryBroadcastBackend } from './backend'
import { SIDECAR_RECOVERY_CLOSE_CODE, SidecarBridge } from './bridge'

describe('BroadcastRecoveryRequiredError', () => {
  it('is an Error with the correct name and message', () => {
    const error = new BroadcastRecoveryRequiredError('test proof')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('BroadcastRecoveryRequiredError')
    expect(error.message).toBe('test proof')
  })
})

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

  it('keeps every prefixed base64 Signal body within the configured transport boundary', async () => {
    const backend = new MemoryBroadcastBackend()
    const signalBodyMaxBytes = 800
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0,
      chunkPayloadBytes: 1024,
      signalBodyMaxBytes
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/?documentId=${documentId}`)
    await new Promise<void>((resolve) => socket.once('open', resolve))

    socket.send(
      frame(
        '99999999-9999-4999-8999-999999999999',
        new Uint8Array(Array.from({ length: 700 }, (_, index) => index % 251))
      )
    )
    await viWait(() => backend.sent.length > 1)

    expect(
      backend.sent.every(({ message }) => Buffer.byteLength(message, 'utf8') <= signalBodyMaxBytes)
    ).toBe(true)
    const chunkFrames = backend.sent.map(({ message }) =>
      decodeEnvelope(new Uint8Array(Buffer.from(message.slice('e2e-col:v1:'.length), 'base64')))
    )
    expect(chunkFrames.every(({ kind }) => kind === 'chunk')).toBe(true)
    socket.close()
  })

  it('does not convert an ambiguous backend send failure into recovery evidence', async () => {
    class RejectingBackend extends MemoryBroadcastBackend {
      override async send(): Promise<void> {
        throw new Error('response lost after an ambiguous send attempt')
      }
    }

    const backend = new RejectingBackend()
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0,
      sendAttempts: 1
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/?documentId=${documentId}`)
    await new Promise<void>((resolve) => socket.once('open', resolve))

    const close = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    )
    const error = console.error
    console.error = () => undefined
    try {
      socket.send(frame('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
      expect(await close).toEqual({ code: 1011, reason: 'signal-cli send outcome unavailable' })
    } finally {
      console.error = error
    }
  })

  it('uses the recovery close code only for an explicit backend history-risk proof', async () => {
    class HistoryRiskBackend extends MemoryBroadcastBackend {
      override async send(): Promise<void> {
        throw new BroadcastRecoveryRequiredError('backend state reset proved missing history')
      }
    }

    const backend = new HistoryRiskBackend()
    const bridge = new SidecarBridge({
      backend,
      documentGroups: { [documentId]: groupId },
      port: 0,
      sendAttempts: 1
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = new WebSocket(`ws://${address.host}:${address.port}/?documentId=${documentId}`)
    await new Promise<void>((resolve) => socket.once('open', resolve))

    const close = new Promise<{ code: number; reason: string }>((resolve) =>
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    )
    const error = console.error
    console.error = () => undefined
    try {
      socket.send(frame('abababab-abab-4bab-8bab-abababababab'))
      expect(await close).toEqual({
        code: SIDECAR_RECOVERY_CLOSE_CODE,
        reason: 'backend proved transport history risk'
      })
    } finally {
      console.error = error
    }
  })

  it('rejects ambiguous duplicate group mappings before runtime routing starts', () => {
    expect(
      () =>
        new SidecarBridge({
          backend: new MemoryBroadcastBackend(),
          documentGroups: {
            [documentId]: groupId,
            'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb': groupId
          }
        })
    ).toThrow(/exactly one document/)
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

  it('rejects empty document-group mappings at construction time', () => {
    expect(
      () =>
        new SidecarBridge({
          backend: new MemoryBroadcastBackend(),
          documentGroups: {}
        })
    ).toThrow(/at least one document/)
  })

  it('rejects empty document or group IDs in mappings', () => {
    expect(
      () =>
        new SidecarBridge({
          backend: new MemoryBroadcastBackend(),
          documentGroups: { '': groupId }
        })
    ).toThrow(/non-empty/)
    expect(
      () =>
        new SidecarBridge({
          backend: new MemoryBroadcastBackend(),
          documentGroups: { [documentId]: '' }
        })
    ).toThrow(/non-empty/)
  })

  it('rejects non-positive chunkPayloadBytes', () => {
    expect(
      () =>
        new SidecarBridge({
          backend: new MemoryBroadcastBackend(),
          documentGroups: { [documentId]: groupId },
          chunkPayloadBytes: 0
        })
    ).toThrow(/positive safe integer/)
    expect(
      () =>
        new SidecarBridge({
          backend: new MemoryBroadcastBackend(),
          documentGroups: { [documentId]: groupId },
          chunkPayloadBytes: -1
        })
    ).toThrow(/positive safe integer/)
  })

  it('rejects non-positive signalBodyMaxBytes', () => {
    expect(
      () =>
        new SidecarBridge({
          backend: new MemoryBroadcastBackend(),
          documentGroups: { [documentId]: groupId },
          signalBodyMaxBytes: 0
        })
    ).toThrow(/positive safe integer/)
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
