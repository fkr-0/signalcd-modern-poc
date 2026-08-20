import { describe, expect, it } from 'vitest'
import {
  decodeMockSignalFanoutFrame,
  encodeMockSignalFanoutFrame,
  MockSignalTransport
} from './mock-signal-transport'
import type { WebSocketLike } from './websocket-transport'

type EventKind = 'open' | 'close' | 'error' | 'message'

class FakeSocket implements WebSocketLike {
  readyState = 0
  binaryType: BinaryType = 'blob'
  readonly sent: unknown[] = []
  private readonly listeners = new Map<EventKind, Array<(event?: MessageEvent) => void>>()

  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = 3
    this.emit('close')
  }

  addEventListener(type: 'open' | 'close' | 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  addEventListener(
    type: EventKind,
    listener: (() => void) | ((event: MessageEvent) => void)
  ): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener as (event?: MessageEvent) => void)
    this.listeners.set(type, listeners)
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  message(data: unknown): void {
    this.emit('message', { data } as MessageEvent)
  }

  private emit(type: EventKind, event?: MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const groupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const documentId = '11111111-1111-4111-8111-111111111111'
const aliceId = '10000000-0000-4000-8000-000000000001'
const bobId = '10000000-0000-4000-8000-000000000002'
const messageId = '22222222-2222-4222-8222-222222222222'

function setup() {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const transport = new MockSignalTransport({
    url: 'ws://127.0.0.1:18080/api/v1/messages',
    authToken: 'opaque-secret-token',
    groupId,
    userId: aliceId,
    phoneNumber: '+15550000001',
    ackTimeoutMs: 1000,
    socketFactory: (url) => {
      urls.push(url)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    }
  })

  return { transport, sockets, urls }
}

function ready(socket: FakeSocket) {
  socket.message(
    JSON.stringify({
      type: 'ready',
      group_id: groupId,
      document_id: documentId,
      members: [
        { user_id: aliceId, phone_number: '+15550000001', role: 'admin' },
        { user_id: bobId, phone_number: '+15550000002', role: 'writer' }
      ]
    })
  )
}

describe('MockSignalTransport', () => {
  it('round-trips a separate debug observer copy without changing recipient ciphertext', () => {
    const recipientPayload = new Uint8Array([7, 8, 9])
    const observerPayload = new Uint8Array([90, 91, 92, 93])
    const frame = encodeMockSignalFanoutFrame({
      version: 1,
      messageId,
      recipients: [{ phoneNumber: '+15550000002', payload: recipientPayload }],
      observer: { keyId: 'a'.repeat(64), payload: observerPayload }
    })
    const decoded = decodeMockSignalFanoutFrame(frame)
    expect(decoded.recipients).toEqual([{ phoneNumber: '+15550000002', payload: recipientPayload }])
    expect(decoded.observer).toEqual({ keyId: 'a'.repeat(64), payload: observerPayload })
    expect(decoded.recipients[0]!.payload).not.toEqual(observerPayload)
  })
  it('uses first-frame bearer authentication without putting credentials in the URL', async () => {
    const { transport, sockets, urls } = setup()
    const connecting = transport.connect(documentId)
    sockets[0]!.open()
    expect(urls[0]).toBe('ws://127.0.0.1:18080/api/v1/messages')
    expect(urls[0]).not.toContain('opaque-secret-token')
    expect(sockets[0]!.sent[0]).toEqual(
      JSON.stringify({
        type: 'authenticate',
        token: 'opaque-secret-token',
        group_id: groupId,
        document_id: documentId
      })
    )
    ready(sockets[0]!)
    await connecting
    expect(transport.getState()).toBe('online')
    expect(transport.getGroupMembers()).toHaveLength(2)
  })

  it('encodes per-recipient fanout, awaits sender confirmation, and emits only inbound ciphertext', async () => {
    const { transport, sockets } = setup()
    const connecting = transport.connect(documentId)
    sockets[0]!.open()
    ready(sockets[0]!)
    await connecting
    const frame = encodeMockSignalFanoutFrame({
      version: 1,
      messageId,
      recipients: [{ phoneNumber: '+15550000002', payload: new Uint8Array([7, 8, 9]) }]
    })
    expect(decodeMockSignalFanoutFrame(frame)).toEqual({
      version: 1,
      messageId,
      recipients: [{ phoneNumber: '+15550000002', payload: new Uint8Array([7, 8, 9]) }]
    })

    const received: number[][] = []
    transport.subscribe((value) => received.push([...value]))
    const sending = transport.send(frame)
    expect(transport.getMetrics().pendingOutbound).toBe(1)
    sockets[0]!.message(JSON.stringify({ type: 'ack', message_id: messageId, recipients: 1 }))
    await sending
    sockets[0]!.message(new Uint8Array([4, 5, 6]).buffer)
    await Promise.resolve()
    expect(received).toEqual([[4, 5, 6]])
    expect(transport.getMetrics()).toMatchObject({ sent: 1, delivered: 1, received: 1 })
  })

  it('queues while offline and reconnects to the same immutable document binding', async () => {
    const { transport, sockets } = setup()
    const first = transport.connect(documentId)
    sockets[0]!.open()
    ready(sockets[0]!)
    await first
    sockets[0]!.close()
    expect(transport.getState()).toBe('offline')

    const queued = encodeMockSignalFanoutFrame({
      version: 1,
      messageId,
      recipients: [{ phoneNumber: '+15550000002', payload: new Uint8Array([1]) }]
    })
    const queuedSend = transport.send(queued)
    expect(transport.getMetrics().pendingOutbound).toBe(1)
    await expect(transport.connect('99999999-9999-4999-8999-999999999999')).rejects.toThrow(
      /already bound/
    )

    const reconnecting = transport.connect(documentId)
    sockets[1]!.open()
    ready(sockets[1]!)
    await reconnecting
    sockets[1]!.message(JSON.stringify({ type: 'ack', message_id: messageId, recipients: 1 }))
    await queuedSend
    expect(transport.getMetrics()).toMatchObject({ reconnects: 1, queuedOutbound: 1 })
  })

  it('rejects malformed or duplicate recipient routing before network send', async () => {
    expect(() =>
      encodeMockSignalFanoutFrame({
        version: 1,
        messageId,
        recipients: [
          { phoneNumber: '+15550000002', payload: new Uint8Array([1]) },
          { phoneNumber: '+15550000002', payload: new Uint8Array([2]) }
        ]
      })
    ).toThrow(/duplicate recipient/)
    expect(() =>
      encodeMockSignalFanoutFrame({
        version: 1,
        messageId,
        recipients: [{ phoneNumber: '+15550000002', payload: new Uint8Array([1]) }],
        observer: { keyId: 'bad-key', payload: new Uint8Array([2]) }
      })
    ).toThrow(/debug observer keyId/)
  })
})
