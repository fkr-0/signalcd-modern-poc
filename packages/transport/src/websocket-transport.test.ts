import { describe, expect, it } from 'vitest'
import {
  type WebSocketLike,
  WebSocketTransport,
  type WebSocketTransportOptions
} from './websocket-transport'

type EventKind = 'open' | 'close' | 'error' | 'message'

class FakeSocket implements WebSocketLike {
  readyState = 0
  binaryType: BinaryType = 'blob'
  readonly sent: unknown[] = []
  readonly listeners = new Map<EventKind, Array<(event?: MessageEvent) => void>>()

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
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

function harness(): {
  transport: WebSocketTransport
  sockets: FakeSocket[]
  urls: string[]
} {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const options: WebSocketTransportOptions = {
    url: 'ws://127.0.0.1:8765/updates',
    socketFactory: (url) => {
      urls.push(url)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    }
  }
  return { transport: new WebSocketTransport(options), sockets, urls }
}

describe('WebSocketTransport', () => {
  it('queues while disconnected, connects per document, and flushes binary frames', async () => {
    const { transport, sockets, urls } = harness()
    await transport.send(new Uint8Array([1, 2]))
    expect(transport.getMetrics().pendingOutbound).toBe(1)

    const connecting = transport.connect('doc alpha')
    expect(transport.getState()).toBe('connecting')
    sockets[0]!.open()
    await connecting

    expect(new URL(urls[0]!).searchParams.get('documentId')).toBe('doc alpha')
    expect(sockets[0]!.binaryType).toBe('arraybuffer')
    expect(sockets[0]!.sent).toHaveLength(1)
    expect([...((sockets[0]!.sent[0] as Uint8Array) ?? [])]).toEqual([1, 2])
    expect(transport.getMetrics()).toMatchObject({
      state: 'online',
      sent: 1,
      pendingOutbound: 0,
      queuedOutbound: 1
    })
  })

  it('receives binary frames and tracks an offline/reconnect cycle', async () => {
    const { transport, sockets } = harness()
    const states: string[] = []
    const received: number[][] = []
    transport.subscribeState(({ current }) => states.push(current))
    transport.subscribe((update) => received.push([...update]))

    const firstConnect = transport.connect('doc-1')
    sockets[0]!.open()
    await firstConnect
    sockets[0]!.message(new Uint8Array([7, 8]).buffer)
    await Promise.resolve()
    expect(received).toEqual([[7, 8]])

    sockets[0]!.close()
    expect(transport.getState()).toBe('offline')

    const reconnect = transport.connect('doc-1')
    sockets[1]!.open()
    await reconnect

    expect(states).toEqual(['connecting', 'online', 'offline', 'connecting', 'online'])
    expect(transport.getMetrics()).toMatchObject({
      successfulConnections: 2,
      reconnects: 1,
      received: 1
    })
  })

  it('rejects a close-before-open connection and remains recoverably offline', async () => {
    const { transport, sockets } = harness()
    const connecting = transport.connect('doc-1')
    sockets[0]!.close()

    await expect(connecting).rejects.toThrow('closed before connection opened')
    expect(transport.getState()).toBe('offline')
  })

  it('drops non-binary inbound messages without an unhandled rejection', async () => {
    const { transport, sockets } = harness()
    const connecting = transport.connect('doc-1')
    sockets[0]!.open()
    await connecting

    sockets[0]!.message('not-binary')
    await Promise.resolve()
    await Promise.resolve()

    expect(transport.getMetrics().dropped).toBe(1)
  })

  it('binds one WebSocket transport instance to one document', async () => {
    const { transport, sockets } = harness()
    const connecting = transport.connect('doc-1')
    sockets[0]!.open()
    await connecting
    sockets[0]!.close()

    await expect(transport.connect('doc-2')).rejects.toThrow('already bound')
  })
})
