import type {
  ObservableCollaborativeTransport,
  TransportConnectionState,
  TransportMetrics,
  TransportRecoveryListener,
  TransportStateListener,
  TransportUpdateListener
} from './types'

export interface WebSocketLike {
  readonly readyState: number
  binaryType: BinaryType
  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export interface WebSocketTransportOptions {
  readonly url: string
  readonly socketFactory?: WebSocketFactory
}

interface MutableWebSocketMetrics {
  connectAttempts: number
  successfulConnections: number
  reconnects: number
  sent: number
  received: number
  dropped: number
  queuedOutbound: number
}

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url)
}

function bytesFromMessage(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return Promise.resolve(new Uint8Array(data))
  }
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  if (data instanceof Blob) {
    return data.arrayBuffer().then((buffer) => new Uint8Array(buffer))
  }
  return Promise.reject(new TypeError('WebSocket transport accepts binary messages only'))
}

/** Browser/sidecar adapter using a documentId query parameter and binary frames. */
export class WebSocketTransport implements ObservableCollaborativeTransport {
  private readonly baseUrl: string
  private readonly socketFactory: WebSocketFactory
  private readonly updates = new Set<TransportUpdateListener>()
  private readonly states = new Set<TransportStateListener>()
  private readonly recovery = new Set<TransportRecoveryListener>()
  private readonly outboundQueue: Uint8Array[] = []
  private socket: WebSocketLike | undefined
  private state: TransportConnectionState = 'disconnected'
  private documentId: string | undefined
  private hasConnected = false
  private metrics: MutableWebSocketMetrics = {
    connectAttempts: 0,
    successfulConnections: 0,
    reconnects: 0,
    sent: 0,
    received: 0,
    dropped: 0,
    queuedOutbound: 0
  }

  constructor(options: WebSocketTransportOptions) {
    this.baseUrl = options.url
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
  }

  async connect(documentId: string): Promise<void> {
    if (this.state === 'closed') {
      throw new Error('transport is closed')
    }
    if (!documentId) {
      throw new TypeError('documentId must be non-empty')
    }
    if (this.documentId !== undefined && this.documentId !== documentId) {
      throw new Error(`transport is already bound to document ${this.documentId}`)
    }
    if (this.state === 'online') {
      return
    }
    if (this.state === 'connecting') {
      throw new Error('transport is already connecting')
    }

    this.documentId = documentId
    this.metrics.connectAttempts += 1
    const reconnecting = this.hasConnected
    this.transition('connecting')

    const url = new URL(this.baseUrl)
    url.searchParams.set('documentId', documentId)

    let socket: WebSocketLike
    try {
      socket = this.socketFactory(url.toString())
    } catch (error) {
      this.transition('offline')
      throw error
    }
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      let settled = false

      const rejectConnection = (message: string) => {
        if (settled) return
        settled = true
        this.transition('offline')
        reject(new Error(message))
      }

      socket.addEventListener('close', () => {
        if (this.state !== 'closed') {
          this.transition('offline')
        }
        rejectConnection('WebSocket closed before connection opened')
      })
      socket.addEventListener('message', (event) => {
        void bytesFromMessage(event.data)
          .then((bytes) => {
            this.metrics.received += 1
            for (const listener of this.updates) {
              listener(new Uint8Array(bytes))
            }
          })
          .catch(() => {
            this.metrics.dropped += 1
          })
      })
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        this.metrics.successfulConnections += 1
        if (reconnecting) this.metrics.reconnects += 1
        this.hasConnected = true
        this.transition('online')
        this.flushOutbound()
        resolve()
      })
      socket.addEventListener('error', () => {
        rejectConnection('WebSocket connection failed')
      })
    })
  }

  async send(update: Uint8Array): Promise<void> {
    if (this.state === 'closed') {
      throw new Error('transport is closed')
    }
    if (!(update instanceof Uint8Array)) {
      throw new TypeError('update must be a Uint8Array')
    }
    if (this.state !== 'online' || this.socket === undefined) {
      this.outboundQueue.push(new Uint8Array(update))
      this.metrics.queuedOutbound += 1
      return
    }
    this.socket.send(new Uint8Array(update))
    this.metrics.sent += 1
  }

  subscribe(listener: TransportUpdateListener): () => void {
    this.updates.add(listener)
    return () => this.updates.delete(listener)
  }

  subscribeState(listener: TransportStateListener): () => void {
    this.states.add(listener)
    return () => this.states.delete(listener)
  }

  subscribeRecovery(listener: TransportRecoveryListener): () => void {
    this.recovery.add(listener)
    return () => this.recovery.delete(listener)
  }

  getState(): TransportConnectionState {
    return this.state
  }

  getMetrics(): TransportMetrics {
    return {
      state: this.state,
      connectAttempts: this.metrics.connectAttempts,
      successfulConnections: this.metrics.successfulConnections,
      reconnects: this.metrics.reconnects,
      sent: this.metrics.sent,
      delivered: 0,
      received: this.metrics.received,
      dropped: this.metrics.dropped,
      duplicated: 0,
      queuedOutbound: this.metrics.queuedOutbound,
      pendingOutbound: this.outboundQueue.length,
      pendingInbound: 0,
      recoverySignals: 0
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    this.transition('closed')
    this.socket?.close(1000, 'transport closed')
    this.socket = undefined
  }

  private flushOutbound(): void {
    if (this.socket === undefined || this.state !== 'online') return
    const pending = this.outboundQueue.splice(0)
    for (const update of pending) {
      this.socket.send(update)
      this.metrics.sent += 1
    }
  }

  private transition(next: TransportConnectionState): void {
    if (next === this.state) return
    const previous = this.state
    this.state = next
    const event = { previous, current: next, at: Date.now() } as const
    for (const listener of this.states) listener(event)
  }
}
