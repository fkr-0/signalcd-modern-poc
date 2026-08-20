import type {
  ObservableCollaborativeTransport,
  TransportConnectionState,
  TransportMetrics,
  TransportRecoveryListener,
  TransportStateListener,
  TransportUpdateListener
} from './types'
import type { WebSocketFactory, WebSocketLike } from './websocket-transport'

const FANOUT_VERSION = 1 as const
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PHONE_RE = /^\+[1-9][0-9]{7,14}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface MockSignalGroupMember {
  readonly userId: string
  readonly phoneNumber: string
  readonly role: 'reader' | 'writer' | 'admin'
}

interface QueuedOutbound {
  readonly update: Uint8Array
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

export interface MockSignalFanoutRecipient {
  readonly phoneNumber: string
  readonly payload: Uint8Array
}

export interface MockSignalFanoutFrame {
  readonly version: typeof FANOUT_VERSION
  readonly messageId: string
  readonly recipients: readonly MockSignalFanoutRecipient[]
}

export interface MockSignalTransportOptions {
  readonly url: string
  readonly authToken: string
  readonly groupId: string
  readonly userId: string
  readonly phoneNumber: string
  readonly socketFactory?: WebSocketFactory
  readonly ackTimeoutMs?: number
}

interface MutableMetrics {
  connectAttempts: number
  successfulConnections: number
  reconnects: number
  sent: number
  delivered: number
  received: number
  dropped: number
  queuedOutbound: number
}

interface PendingAck {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

function defaultSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url)
}

export function encodeMockSignalFanoutFrame(value: MockSignalFanoutFrame): Uint8Array {
  const frame = validateFanoutFrame(value)
  return encoder.encode(
    JSON.stringify({
      type: 'fanout',
      version: FANOUT_VERSION,
      message_id: frame.messageId,
      recipients: frame.recipients.map((recipient) => ({
        phone_number: recipient.phoneNumber,
        payload: bytesToBase64(recipient.payload)
      }))
    })
  )
}

export function decodeMockSignalFanoutFrame(bytes: Uint8Array): MockSignalFanoutFrame {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('mock Signal fanout frame must be bytes')
  let value: unknown
  try {
    value = JSON.parse(decoder.decode(bytes))
  } catch {
    throw new Error('mock Signal fanout frame must contain valid UTF-8 JSON')
  }
  const record = asRecord(value)
  if (record.type !== 'fanout' || record.version !== FANOUT_VERSION)
    throw new Error('mock Signal fanout frame has an unsupported type or version')
  if (!Array.isArray(record.recipients))
    throw new Error('mock Signal fanout recipients are required')
  return validateFanoutFrame({
    version: FANOUT_VERSION,
    messageId: requiredString(record.message_id, 'message_id'),
    recipients: record.recipients.map((entry) => {
      const recipient = asRecord(entry)
      return {
        phoneNumber: requiredString(recipient.phone_number, 'phone_number'),
        payload: base64ToBytes(requiredString(recipient.payload, 'payload'))
      }
    })
  })
}

/**
 * Authenticated browser adapter for the toy Signal encrypted group backbone.
 * The public CollaborativeTransport contract stays byte-only; outbound bytes are
 * transport-internal fanout frames and inbound bytes are one recipient's opaque
 * encrypted envelope. Cryptography remains owned by @e2e-col/identity.
 */
export class MockSignalTransport implements ObservableCollaborativeTransport {
  private readonly socketFactory: WebSocketFactory
  private readonly ackTimeoutMs: number
  private readonly updates = new Set<TransportUpdateListener>()
  private readonly states = new Set<TransportStateListener>()
  private readonly recovery = new Set<TransportRecoveryListener>()
  private readonly outboundQueue: QueuedOutbound[] = []
  private readonly pendingAcks = new Map<string, PendingAck>()
  private socket: WebSocketLike | undefined
  private state: TransportConnectionState = 'disconnected'
  private documentId: string | undefined
  private hasConnected = false
  private members: readonly MockSignalGroupMember[] = []
  private metrics: MutableMetrics = {
    connectAttempts: 0,
    successfulConnections: 0,
    reconnects: 0,
    sent: 0,
    delivered: 0,
    received: 0,
    dropped: 0,
    queuedOutbound: 0
  }

  constructor(private readonly options: MockSignalTransportOptions) {
    if (!options.authToken) throw new TypeError('MockSignalTransport authToken must be non-empty')
    if (!UUID_RE.test(options.groupId))
      throw new TypeError('MockSignalTransport groupId must be a UUID')
    if (!UUID_RE.test(options.userId))
      throw new TypeError('MockSignalTransport userId must be a UUID')
    if (!PHONE_RE.test(options.phoneNumber))
      throw new TypeError('MockSignalTransport phoneNumber must be E.164-style')
    this.socketFactory = options.socketFactory ?? defaultSocketFactory
    this.ackTimeoutMs = options.ackTimeoutMs ?? 10_000
  }

  async connect(documentId: string): Promise<void> {
    this.assertOpen()
    if (!UUID_RE.test(documentId)) throw new TypeError('documentId must be a UUID')
    if (this.documentId !== undefined && this.documentId !== documentId)
      throw new Error(`transport is already bound to document ${this.documentId}`)
    if (this.state === 'online') return
    if (this.state === 'connecting') throw new Error('transport is already connecting')

    this.documentId = documentId
    this.metrics.connectAttempts += 1
    const reconnecting = this.hasConnected
    this.transition('connecting')

    let socket: WebSocketLike
    try {
      // Authentication is deliberately not encoded in the URL.
      socket = this.socketFactory(this.options.url)
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

      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({
            type: 'authenticate',
            token: this.options.authToken,
            group_id: this.options.groupId,
            document_id: documentId
          })
        )
      })
      socket.addEventListener('message', (event) => {
        void this.handleMessage(event.data, (control) => {
          if (control.type === 'ready') {
            if (settled) return
            settled = true
            this.members = parseMembers(control.members)
            if (
              control.group_id !== this.options.groupId ||
              control.document_id !== documentId ||
              !this.members.some(
                (member) =>
                  member.userId === this.options.userId &&
                  member.phoneNumber === this.options.phoneNumber
              )
            ) {
              this.transition('offline')
              reject(new Error('mock Signal ready binding does not match requested identity/group'))
              return
            }
            this.metrics.successfulConnections += 1
            if (reconnecting) this.metrics.reconnects += 1
            this.hasConnected = true
            this.transition('online')
            this.flushOutbound()
            resolve()
          }
        })
      })
      socket.addEventListener('error', () =>
        rejectConnection('mock Signal WebSocket connection failed')
      )
      socket.addEventListener('close', () => {
        if (this.state !== 'closed') this.transition('offline')
        this.rejectPending('mock Signal connection closed before delivery confirmation')
        rejectConnection('mock Signal WebSocket closed before authenticated ready state')
      })
    })
  }

  async send(update: Uint8Array): Promise<void> {
    this.assertOpen()
    if (!(update instanceof Uint8Array)) throw new TypeError('update must be a Uint8Array')
    // Validate transport-internal routing before any network write.
    decodeMockSignalFanoutFrame(update)
    if (this.state !== 'online' || this.socket === undefined) {
      this.metrics.queuedOutbound += 1
      return new Promise<void>((resolve, reject) => {
        this.outboundQueue.push({ update: new Uint8Array(update), resolve, reject })
      })
    }
    await this.sendOnline(update)
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

  getGroupMembers(): readonly MockSignalGroupMember[] {
    return this.members.map((member) => ({ ...member }))
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
      delivered: this.metrics.delivered,
      received: this.metrics.received,
      dropped: this.metrics.dropped,
      duplicated: 0,
      queuedOutbound: this.metrics.queuedOutbound,
      pendingOutbound: this.outboundQueue.length + this.pendingAcks.size,
      pendingInbound: 0,
      recoverySignals: 0
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    this.transition('closed')
    this.rejectPending('mock Signal transport closed')
    this.rejectQueued('mock Signal transport closed before queued delivery')
    this.socket?.close(1000, 'transport closed')
    this.socket = undefined
    this.members = []
  }

  private async sendOnline(update: Uint8Array): Promise<void> {
    const socket = this.socket
    if (!socket || this.state !== 'online') throw new Error('mock Signal transport is offline')
    const frame = decodeMockSignalFanoutFrame(update)
    if (this.pendingAcks.has(frame.messageId))
      throw new Error(`mock Signal message ${frame.messageId} is already awaiting confirmation`)
    const confirmed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(frame.messageId)
        reject(new Error(`mock Signal delivery confirmation timed out for ${frame.messageId}`))
      }, this.ackTimeoutMs)
      this.pendingAcks.set(frame.messageId, { resolve, reject, timer })
    })
    socket.send(new Uint8Array(update))
    this.metrics.sent += 1
    await confirmed
  }

  private async handleMessage(
    data: unknown,
    onControl: (control: Record<string, unknown>) => void
  ): Promise<void> {
    if (typeof data === 'string') {
      let control: Record<string, unknown>
      try {
        control = asRecord(JSON.parse(data))
      } catch {
        this.metrics.dropped += 1
        return
      }
      onControl(control)
      if (control.type === 'ack' && typeof control.message_id === 'string') {
        const pending = this.pendingAcks.get(control.message_id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingAcks.delete(control.message_id)
          const recipients = Number(control.recipients ?? 0)
          if (Number.isSafeInteger(recipients) && recipients >= 0)
            this.metrics.delivered += recipients
          pending.resolve()
        }
      } else if (control.type === 'error' && typeof control.message_id === 'string') {
        const pending = this.pendingAcks.get(control.message_id)
        if (pending) {
          clearTimeout(pending.timer)
          this.pendingAcks.delete(control.message_id)
          pending.reject(
            new Error(
              typeof control.error === 'string' ? control.error : 'mock Signal delivery rejected'
            )
          )
        }
      }
      return
    }

    try {
      const bytes = await bytesFromMessage(data)
      this.metrics.received += 1
      for (const listener of this.updates) listener(new Uint8Array(bytes))
    } catch {
      this.metrics.dropped += 1
    }
  }

  private flushOutbound(): void {
    const pending = this.outboundQueue.splice(0)
    for (const queued of pending) {
      void this.sendOnline(queued.update).then(queued.resolve, (error: unknown) => {
        this.metrics.dropped += 1
        queued.reject(
          error instanceof Error ? error : new Error('mock Signal queued delivery failed')
        )
      })
    }
  }

  private rejectPending(message: string): void {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error(message))
    }
    this.pendingAcks.clear()
  }

  private rejectQueued(message: string): void {
    const queued = this.outboundQueue.splice(0)
    for (const entry of queued) entry.reject(new Error(message))
  }

  private transition(next: TransportConnectionState): void {
    if (next === this.state) return
    const previous = this.state
    this.state = next
    const event = { previous, current: next, at: Date.now() } as const
    for (const listener of this.states) listener(event)
  }

  private assertOpen(): void {
    if (this.state === 'closed') throw new Error('transport is closed')
  }
}

function validateFanoutFrame(value: MockSignalFanoutFrame): MockSignalFanoutFrame {
  if (value.version !== FANOUT_VERSION) throw new Error('unsupported mock Signal fanout version')
  if (!UUID_RE.test(value.messageId)) throw new Error('mock Signal fanout messageId must be a UUID')
  if (!Array.isArray(value.recipients) || value.recipients.length < 1)
    throw new Error('mock Signal fanout requires at least one recipient')
  const seen = new Set<string>()
  return {
    version: FANOUT_VERSION,
    messageId: value.messageId,
    recipients: value.recipients.map((recipient) => {
      if (!PHONE_RE.test(recipient.phoneNumber))
        throw new Error('mock Signal fanout recipient phone number is invalid')
      if (seen.has(recipient.phoneNumber))
        throw new Error(`mock Signal fanout contains duplicate recipient ${recipient.phoneNumber}`)
      seen.add(recipient.phoneNumber)
      if (!(recipient.payload instanceof Uint8Array) || recipient.payload.byteLength === 0)
        throw new Error('mock Signal fanout recipient payload must contain bytes')
      return { phoneNumber: recipient.phoneNumber, payload: new Uint8Array(recipient.payload) }
    })
  }
}

function parseMembers(value: unknown): readonly MockSignalGroupMember[] {
  if (!Array.isArray(value)) throw new Error('mock Signal ready frame is missing members')
  return value.map((entry) => {
    const member = asRecord(entry)
    const role = requiredString(member.role, 'role')
    if (role !== 'reader' && role !== 'writer' && role !== 'admin')
      throw new Error('mock Signal member role is invalid')
    return {
      userId: requiredString(member.user_id, 'user_id'),
      phoneNumber: requiredString(member.phone_number, 'phone_number'),
      role
    }
  })
}

async function bytesFromMessage(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  throw new TypeError('mock Signal transport accepts binary delivery messages only')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new Error('mock Signal fanout payload must be base64')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('mock Signal control value must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`mock Signal ${name} must be a non-empty string`)
  return value
}
