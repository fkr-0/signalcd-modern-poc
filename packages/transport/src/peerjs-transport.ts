import {
  DefaultPeerFactory,
  type DefaultPeerFactoryOptions,
  deriveRendezvousRoomId,
  type LobbyDeliveryEvent,
  type PeerFactory,
  PeerJsLobby,
  type PeerJsLobbyOptions
} from 'peerjslib'
import { decodeMockSignalFanoutFrame } from './mock-signal-transport'
import type {
  ObservableCollaborativeTransport,
  TransportConnectionState,
  TransportMetrics,
  TransportRecoveryListener,
  TransportStateListener,
  TransportUpdateListener
} from './types'

const PEERJS_TRANSPORT_MAGIC = new Uint8Array([0x45, 0x32, 0x43, 0x50]) // E2CP
const PEERJS_TRANSPORT_FRAME_VERSION = 1
const DATA_FRAME_KIND = 0
const CHECKPOINT_REQUEST_FRAME_KIND = 1
const DATA_HEADER_BYTES = 6
const MAX_CHECKPOINT_REQUEST_ID_BYTES = 192
const CHECKPOINT_REQUEST_HEADER_BYTES = 8
const DEFAULT_MAX_APPLICATION_BYTES = 256 * 1024
const SEEN_CHECKPOINT_REQUESTS = 256
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface PeerJsTransportOptions {
  /** Invitation-grade capability material; never the public document UUID itself. */
  readonly rendezvousSecret: Uint8Array | string
  /** Domain-separates this consumer before the document UUID is added. */
  readonly namespace?: string
  /**
   * Local Signal-style routing identity. When present, incoming e2e-col fan-out
   * frames are reduced to this recipient's encrypted envelope before delivery
   * to DocumentSession. peerjslib itself still sees only opaque bytes.
   */
  readonly recipientPhoneNumber?: string
  /** Test/custom PeerJS factory. Mutually exclusive with peerOptions. */
  readonly peerFactory?: PeerFactory
  /** Options for peerjslib's DefaultPeerFactory (PeerJS Cloud is used when omitted). */
  readonly peerOptions?: DefaultPeerFactoryOptions
  /**
   * peerjslib lobby tuning. maxMessageBytes is interpreted as the maximum
   * e2e-col application payload; transport framing overhead is added internally.
   */
  readonly lobby?: Omit<PeerJsLobbyOptions, 'peerFactory'>
}

interface MutableMetrics {
  connectAttempts: number
  successfulConnections: number
  reconnects: number
  sent: number
  delivered: number
  received: number
  dropped: number
  recoverySignals: number
}

type PeerJsTransportFrame =
  | { readonly type: 'data'; readonly payload: Uint8Array }
  | { readonly type: 'checkpoint-request'; readonly requestId: string }

/**
 * Browser-only PeerJS adapter for the normal opaque e2e-col transport contract.
 *
 * `send()` resolves after the elected peerjslib browser hub accepts the bytes.
 * That intentionally mirrors the Signal/demo transport hand-off boundary; it
 * does not mean every replica has merged the update.
 *
 * peerjslib's replay window is bounded. When it reports a replay gap, this
 * adapter marks the local receiver as needing recovery and sends a small
 * transport-internal checkpoint request through the lobby. Every other replica
 * that receives the request may ask its local DocumentSession to publish a
 * complete snapshot; DocumentSession itself decides whether that participant is
 * authorized to write. This deliberately avoids coupling recovery authority to
 * whichever browser happens to hold the PeerJS hub role.
 */
export class PeerJsTransport implements ObservableCollaborativeTransport {
  private readonly updates = new Set<TransportUpdateListener>()
  private readonly states = new Set<TransportStateListener>()
  private readonly recovery = new Set<TransportRecoveryListener>()
  private readonly factory: PeerFactory
  private readonly maxApplicationBytes: number
  private readonly seenCheckpointRequests = new Set<string>()
  private readonly seenCheckpointRequestOrder: string[] = []
  private lobby: PeerJsLobby | undefined
  private lobbyUnsubscribers: Array<() => void> = []
  private state: TransportConnectionState = 'disconnected'
  private documentId: string | undefined
  private hasConnected = false
  private recoverySequence = 0
  private checkpointRequestSequence = 0
  private metrics: MutableMetrics = {
    connectAttempts: 0,
    successfulConnections: 0,
    reconnects: 0,
    sent: 0,
    delivered: 0,
    received: 0,
    dropped: 0,
    recoverySignals: 0
  }

  constructor(private readonly options: PeerJsTransportOptions) {
    const secretBytes =
      typeof options.rendezvousSecret === 'string'
        ? encoder.encode(options.rendezvousSecret)
        : options.rendezvousSecret
    if (!(secretBytes instanceof Uint8Array) || secretBytes.byteLength < 16)
      throw new RangeError('PeerJsTransport rendezvousSecret must contain at least 16 bytes')
    if (options.peerFactory !== undefined && options.peerOptions !== undefined)
      throw new TypeError('PeerJsTransport peerFactory and peerOptions are mutually exclusive')

    this.factory = options.peerFactory ?? new DefaultPeerFactory(options.peerOptions)
    this.maxApplicationBytes = Math.max(
      1,
      options.lobby?.maxMessageBytes ?? DEFAULT_MAX_APPLICATION_BYTES
    )
  }

  async connect(documentId: string): Promise<void> {
    this.assertOpen()
    if (!documentId) throw new TypeError('documentId must be non-empty')
    if (this.documentId !== undefined && this.documentId !== documentId)
      throw new Error(`transport is already bound to document ${this.documentId}`)
    if (this.state === 'online') return
    if (this.state === 'connecting') throw new Error('transport is already connecting')

    this.documentId = documentId
    this.metrics.connectAttempts += 1
    const reconnecting = this.hasConnected
    this.transition('connecting')

    const baseNamespace = this.options.namespace ?? 'e2e-col'
    const namespace = `${baseNamespace}:${documentId}`
    if (namespace.length > 64)
      throw new RangeError(
        'PeerJsTransport namespace plus documentId must not exceed 64 characters'
      )
    const roomId = await deriveRendezvousRoomId(this.options.rendezvousSecret, { namespace })
    const configuredLobby = this.options.lobby ?? {}
    const lobbyOptions: PeerJsLobbyOptions = {
      ...configuredLobby,
      // Keep `maxMessageBytes` consumer-facing: callers size e2e-col bytes,
      // while this adapter owns and accounts for its private frame overhead.
      maxMessageBytes:
        this.maxApplicationBytes +
        Math.max(
          DATA_HEADER_BYTES,
          CHECKPOINT_REQUEST_HEADER_BYTES + MAX_CHECKPOINT_REQUEST_ID_BYTES
        ),
      peerFactory: this.factory
    }
    const lobby = new PeerJsLobby(roomId, lobbyOptions)
    this.lobby = lobby
    this.installLobby(lobby)

    try {
      await lobby.connect()
      this.metrics.successfulConnections += 1
      if (reconnecting) this.metrics.reconnects += 1
      this.hasConnected = true
      this.transition(mapLobbyState(lobby.getState()))
    } catch (error) {
      this.transition('offline')
      throw error
    }
  }

  async send(update: Uint8Array): Promise<void> {
    this.assertOpen()
    if (!(update instanceof Uint8Array)) throw new TypeError('update must be a Uint8Array')
    if (update.byteLength === 0) throw new RangeError('update must not be empty')
    if (update.byteLength > this.maxApplicationBytes)
      throw new RangeError(`update exceeds maxMessageBytes (${this.maxApplicationBytes})`)
    const lobby = this.lobby
    if (!lobby) throw new Error('PeerJsTransport must be connected before send')

    this.metrics.sent += 1
    await lobby.send(encodeDataFrame(update))
    this.metrics.delivered += 1
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
    const health = this.lobby?.getHealth()
    return {
      state: this.state,
      connectAttempts: this.metrics.connectAttempts,
      successfulConnections: this.metrics.successfulConnections,
      reconnects: this.metrics.reconnects,
      sent: this.metrics.sent,
      delivered: this.metrics.delivered,
      received: this.metrics.received,
      dropped: this.metrics.dropped + (health?.dropped ?? 0),
      duplicated: health?.duplicateConnections ?? 0,
      queuedOutbound: health?.queuedOutbound ?? 0,
      pendingOutbound: health?.pendingOutbound ?? 0,
      pendingInbound: 0,
      recoverySignals: this.metrics.recoverySignals
    }
  }

  /** Immutable peerjslib diagnostics for the demo/dashboard path. */
  getLobbyHealth() {
    return this.lobby?.getHealth()
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    for (const unsubscribe of this.lobbyUnsubscribers.splice(0)) unsubscribe()
    const lobby = this.lobby
    this.lobby = undefined
    if (lobby) await lobby.close()
    this.transition('closed')
  }

  private installLobby(lobby: PeerJsLobby): void {
    this.lobbyUnsubscribers.push(
      lobby.subscribe((bytes) => this.handleLobbyPayload(bytes)),
      lobby.subscribeState((event) => {
        const next = mapLobbyState(event.current)
        if (next === 'online' && this.state !== 'online' && this.hasConnected) {
          this.metrics.reconnects += 1
          this.metrics.successfulConnections += 1
        }
        this.transition(next)
      }),
      lobby.subscribeDelivery((event) => this.handleDelivery(lobby, event))
    )
  }

  private handleLobbyPayload(bytes: Uint8Array): void {
    const frame = decodeTransportFrame(bytes)
    if (!frame) {
      this.metrics.dropped += 1
      return
    }
    if (frame.type === 'data') {
      const payload = this.recipientPayload(frame.payload)
      if (!payload) return
      this.metrics.received += 1
      for (const listener of this.updates) listener(new Uint8Array(payload))
      return
    }

    // peerjslib suppresses sender echo, so the requesting receiver never sees
    // its own request. All other replicas may expose it to DocumentSession;
    // only locally authorized writers/admins will actually publish a snapshot.
    if (!this.documentId) return
    if (!this.rememberCheckpointRequest(frame.requestId)) return
    this.emitRecovery({
      documentId: this.documentId,
      sourceId: frame.requestId,
      targetId: 'peerjs-checkpoint-publisher',
      sendSequence: ++this.recoverySequence,
      reason: 'peerjs-checkpoint-request'
    })
  }

  private handleDelivery(lobby: PeerJsLobby, event: LobbyDeliveryEvent): void {
    if (event.type !== 'replay-gap' || !this.documentId) return

    this.emitRecovery({
      documentId: this.documentId,
      sourceId: 'peerjs-replay-window',
      targetId: 'local-history',
      sendSequence: Math.max(++this.recoverySequence, event.latestAvailable),
      reason: 'peerjs-replay-gap'
    })

    const health = lobby.getHealth()
    const requestId = `${health.peerId ?? 'peer'}:${++this.checkpointRequestSequence}`
    void lobby.send(encodeCheckpointRequestFrame(requestId)).catch(() => {
      // Recovery remains required locally. A failed request is observable as a
      // dropped transport-internal control and can be retried after reconnect.
      this.metrics.dropped += 1
    })
  }

  private recipientPayload(payload: Uint8Array): Uint8Array | undefined {
    const phoneNumber = this.options.recipientPhoneNumber
    if (phoneNumber === undefined) return payload
    try {
      const frame = decodeMockSignalFanoutFrame(payload)
      const recipient = frame.recipients.find((entry) => entry.phoneNumber === phoneNumber)
      if (!recipient) {
        // Broadcast delivery to a peer that is not an intended recipient is
        // normal in the P2P topology. Do not surface another participant's
        // ciphertext to the local identity decoder.
        return undefined
      }
      return new Uint8Array(recipient.payload)
    } catch {
      this.metrics.dropped += 1
      return undefined
    }
  }

  private emitRecovery(event: Parameters<TransportRecoveryListener>[0]): void {
    this.metrics.recoverySignals += 1
    for (const listener of this.recovery) listener(event)
  }

  private rememberCheckpointRequest(requestId: string): boolean {
    if (this.seenCheckpointRequests.has(requestId)) return false
    this.seenCheckpointRequests.add(requestId)
    this.seenCheckpointRequestOrder.push(requestId)
    while (this.seenCheckpointRequestOrder.length > SEEN_CHECKPOINT_REQUESTS) {
      const oldest = this.seenCheckpointRequestOrder.shift()
      if (oldest !== undefined) this.seenCheckpointRequests.delete(oldest)
    }
    return true
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

function encodeDataFrame(payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(DATA_HEADER_BYTES + payload.byteLength)
  frame.set(PEERJS_TRANSPORT_MAGIC, 0)
  frame[4] = PEERJS_TRANSPORT_FRAME_VERSION
  frame[5] = DATA_FRAME_KIND
  frame.set(payload, DATA_HEADER_BYTES)
  return frame
}

function encodeCheckpointRequestFrame(requestId: string): Uint8Array {
  const id = encoder.encode(requestId)
  if (id.byteLength === 0 || id.byteLength > MAX_CHECKPOINT_REQUEST_ID_BYTES)
    throw new RangeError('PeerJS checkpoint request id is out of bounds')
  const frame = new Uint8Array(CHECKPOINT_REQUEST_HEADER_BYTES + id.byteLength)
  frame.set(PEERJS_TRANSPORT_MAGIC, 0)
  frame[4] = PEERJS_TRANSPORT_FRAME_VERSION
  frame[5] = CHECKPOINT_REQUEST_FRAME_KIND
  new DataView(frame.buffer).setUint16(6, id.byteLength, false)
  frame.set(id, CHECKPOINT_REQUEST_HEADER_BYTES)
  return frame
}

function decodeTransportFrame(bytes: Uint8Array): PeerJsTransportFrame | null {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < DATA_HEADER_BYTES) return null
  for (let index = 0; index < PEERJS_TRANSPORT_MAGIC.byteLength; index += 1) {
    if (bytes[index] !== PEERJS_TRANSPORT_MAGIC[index]) return null
  }
  if (bytes[4] !== PEERJS_TRANSPORT_FRAME_VERSION) return null

  if (bytes[5] === DATA_FRAME_KIND) {
    if (bytes.byteLength <= DATA_HEADER_BYTES) return null
    return { type: 'data', payload: bytes.slice(DATA_HEADER_BYTES) }
  }

  if (
    bytes[5] !== CHECKPOINT_REQUEST_FRAME_KIND ||
    bytes.byteLength < CHECKPOINT_REQUEST_HEADER_BYTES
  )
    return null
  const idLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(
    6,
    false
  )
  if (
    idLength === 0 ||
    idLength > MAX_CHECKPOINT_REQUEST_ID_BYTES ||
    bytes.byteLength !== CHECKPOINT_REQUEST_HEADER_BYTES + idLength
  )
    return null
  try {
    const requestId = decoder.decode(bytes.subarray(CHECKPOINT_REQUEST_HEADER_BYTES))
    if (!requestId) return null
    return { type: 'checkpoint-request', requestId }
  } catch {
    return null
  }
}

function mapLobbyState(state: ReturnType<PeerJsLobby['getState']>): TransportConnectionState {
  if (state === 'online' || state === 'hosting') return 'online'
  if (state === 'connecting' || state === 'joining' || state === 'reconnecting') return 'connecting'
  if (state === 'offline') return 'offline'
  if (state === 'closed') return 'closed'
  return 'disconnected'
}
