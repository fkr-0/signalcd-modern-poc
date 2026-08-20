import type {
  ObservableCollaborativeTransport,
  TransportConnectionState,
  TransportMetrics,
  TransportRecoveryListener,
  TransportRecoveryRequired,
  TransportStateListener,
  TransportUpdateListener
} from './types'

export interface FaultDirective {
  /** 1-based global publish sequence to which the directive applies. */
  readonly send: number
  readonly from?: string
  readonly to?: string
  /** Remove the delivery and emit a recovery-required signal for the target. */
  readonly drop?: boolean
  /** Extra virtual-time delay added after the network's base latency. */
  readonly delayMs?: number
  /** Number of additional copies to schedule. */
  readonly duplicate?: number
  /** Hold this delivery until releaseHeld() is called. */
  readonly hold?: boolean
}

export interface DeterministicNetworkOptions {
  readonly latencyMs?: number
  readonly faults?: readonly FaultDirective[]
  /**
   * Keep deliveries for temporarily offline receivers. This models an
   * asynchronous broadcast substrate such as Signal retaining messages until a
   * linked client reconnects.
   */
  readonly retainOffline?: boolean
}

export interface ReleaseHeldOptions {
  readonly order?: 'fifo' | 'lifo'
}

interface ScheduledDelivery {
  readonly sourceId: string
  readonly targetId: string
  readonly documentId: string
  readonly sendSequence: number
  readonly copy: number
  readonly payload: Uint8Array
  dueAt: number
  order: number
}

interface MutableMetrics {
  connectAttempts: number
  successfulConnections: number
  reconnects: number
  sent: number
  delivered: number
  received: number
  dropped: number
  duplicated: number
  queuedOutbound: number
  recoverySignals: number
}

function copyBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value)
}

function subscribeTo<T>(
  listeners: Set<(value: T) => void>,
  listener: (value: T) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export class DeterministicTransportNetwork {
  private readonly latencyMs: number
  private readonly retainOffline: boolean
  private readonly faults: readonly FaultDirective[]
  private readonly transports = new Map<string, SimulatedTransport>()
  private readonly scheduled: ScheduledDelivery[] = []
  private readonly held: ScheduledDelivery[] = []
  private readonly offlineBacklog = new Map<string, ScheduledDelivery[]>()
  private nowMs = 0
  private sendSequence = 0
  private deliveryOrder = 0

  constructor(options: DeterministicNetworkOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0
    this.retainOffline = options.retainOffline ?? true
    this.faults = [...(options.faults ?? [])]

    if (!Number.isFinite(this.latencyMs) || this.latencyMs < 0) {
      throw new RangeError('latencyMs must be a finite value >= 0')
    }
    for (const fault of this.faults) {
      if (!Number.isInteger(fault.send) || fault.send < 1) {
        throw new RangeError('fault send must be a positive integer')
      }
      if (fault.delayMs !== undefined && (!Number.isFinite(fault.delayMs) || fault.delayMs < 0)) {
        throw new RangeError('fault delayMs must be a finite value >= 0')
      }
      if (
        fault.duplicate !== undefined &&
        (!Number.isInteger(fault.duplicate) || fault.duplicate < 0)
      ) {
        throw new RangeError('fault duplicate must be an integer >= 0')
      }
    }
  }

  get now(): number {
    return this.nowMs
  }

  createTransport(id: string): SimulatedTransport {
    if (!id) {
      throw new TypeError('transport id must be non-empty')
    }
    if (this.transports.has(id)) {
      throw new Error(`transport id already exists: ${id}`)
    }

    const transport = new SimulatedTransport(this, id)
    this.transports.set(id, transport)
    return transport
  }

  advanceBy(milliseconds: number): void {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new RangeError('milliseconds must be a finite value >= 0')
    }
    this.nowMs += milliseconds
    this.deliverDue()
  }

  /** Deliver everything currently scheduled, advancing virtual time as needed. */
  flush(): void {
    while (this.scheduled.length > 0) {
      const nextDue = Math.min(...this.scheduled.map((delivery) => delivery.dueAt))
      if (nextDue > this.nowMs) {
        this.nowMs = nextDue
      }
      this.deliverDue()
    }
  }

  /**
   * Release explicitly held deliveries. LIFO is a deterministic reorder tool;
   * FIFO simply resumes normal scheduling.
   */
  releaseHeld(options: ReleaseHeldOptions = {}): void {
    const order = options.order ?? 'fifo'
    const released = order === 'lifo' ? [...this.held].reverse() : [...this.held]
    this.held.length = 0

    released.forEach((delivery) => {
      delivery.dueAt = this.nowMs
      // Assign fresh scheduler order in the requested release order.
      delivery.order = ++this.deliveryOrder
      this.scheduled.push(delivery)
    })
    this.deliverDue()
  }

  pendingScheduled(): number {
    return this.scheduled.length
  }

  pendingHeld(): number {
    return this.held.length
  }

  pendingOffline(targetId?: string): number {
    if (targetId !== undefined) {
      return this.offlineBacklog.get(targetId)?.length ?? 0
    }
    let total = 0
    for (const backlog of this.offlineBacklog.values()) {
      total += backlog.length
    }
    return total
  }

  publish(source: SimulatedTransport, documentId: string, payload: Uint8Array): void {
    this.sendSequence += 1
    const sequence = this.sendSequence
    source.recordSent()

    for (const target of this.transports.values()) {
      if (target === source || target.documentId !== documentId || target.getState() === 'closed') {
        continue
      }

      const directive = this.matchFault(sequence, source.id, target.id)
      if (directive?.drop) {
        source.recordDropped()
        const recovery = {
          documentId,
          sourceId: source.id,
          targetId: target.id,
          sendSequence: sequence,
          reason: 'dropped-frame'
        } as const
        // The receiver needs to expose degraded/recovering state, while the
        // sender is the replica that can publish a checkpoint containing the
        // missing update. Notify both ends without interpreting protocol bytes.
        target.signalRecovery(recovery)
        source.signalRecovery(recovery)
        continue
      }

      const duplicateCount = Math.max(0, Math.trunc(directive?.duplicate ?? 0))
      source.recordDuplicated(duplicateCount)
      for (let copy = 0; copy <= duplicateCount; copy += 1) {
        const delivery: ScheduledDelivery = {
          sourceId: source.id,
          targetId: target.id,
          documentId,
          sendSequence: sequence,
          copy,
          payload: copyBytes(payload),
          dueAt: this.nowMs + this.latencyMs + Math.max(0, directive?.delayMs ?? 0),
          order: ++this.deliveryOrder
        }

        if (directive?.hold) {
          this.held.push(delivery)
        } else {
          this.scheduled.push(delivery)
        }
      }
    }

    this.deliverDue()
  }

  onTransportOnline(transport: SimulatedTransport): void {
    const backlog = this.offlineBacklog.get(transport.id)
    if (backlog && backlog.length > 0) {
      this.offlineBacklog.delete(transport.id)
      for (const delivery of backlog) {
        delivery.dueAt = this.nowMs
        this.scheduled.push(delivery)
      }
      this.deliverDue()
    }
  }

  removeTransport(id: string): void {
    this.transports.delete(id)
    this.offlineBacklog.delete(id)
  }

  private matchFault(sequence: number, from: string, to: string): FaultDirective | undefined {
    return this.faults.find(
      (fault) =>
        fault.send === sequence &&
        (fault.from === undefined || fault.from === from) &&
        (fault.to === undefined || fault.to === to)
    )
  }

  private deliverDue(): void {
    this.scheduled.sort(
      (left, right) =>
        left.dueAt - right.dueAt ||
        left.order - right.order ||
        left.targetId.localeCompare(right.targetId)
    )

    let index = 0
    while (index < this.scheduled.length && this.scheduled[index]!.dueAt <= this.nowMs) {
      const delivery = this.scheduled[index]!
      index += 1
      const target = this.transports.get(delivery.targetId)
      const source = this.transports.get(delivery.sourceId)

      if (!target || target.getState() === 'closed') {
        continue
      }

      if (target.getState() !== 'online') {
        if (this.retainOffline) {
          const backlog = this.offlineBacklog.get(target.id) ?? []
          backlog.push(delivery)
          this.offlineBacklog.set(target.id, backlog)
        } else {
          source?.recordDropped()
          const recovery = {
            documentId: delivery.documentId,
            sourceId: delivery.sourceId,
            targetId: target.id,
            sendSequence: delivery.sendSequence,
            reason: 'dropped-frame'
          } as const
          target.signalRecovery(recovery)
          source?.signalRecovery(recovery)
        }
        continue
      }

      target.receive(delivery.payload)
      source?.recordDelivered()
    }

    if (index > 0) {
      this.scheduled.splice(0, index)
    }
  }
}

export class SimulatedTransport implements ObservableCollaborativeTransport {
  readonly id: string
  documentId: string | undefined

  private state: TransportConnectionState = 'disconnected'
  private hasConnected = false
  private readonly updates = new Set<TransportUpdateListener>()
  private readonly stateListeners = new Set<TransportStateListener>()
  private readonly recoveryListeners = new Set<TransportRecoveryListener>()
  private readonly outboundQueue: Uint8Array[] = []
  private readonly metrics: MutableMetrics = {
    connectAttempts: 0,
    successfulConnections: 0,
    reconnects: 0,
    sent: 0,
    delivered: 0,
    received: 0,
    dropped: 0,
    duplicated: 0,
    queuedOutbound: 0,
    recoverySignals: 0
  }

  constructor(
    private readonly network: DeterministicTransportNetwork,
    id: string
  ) {
    this.id = id
  }

  async connect(documentId: string): Promise<void> {
    this.assertOpen()
    if (!documentId) {
      throw new TypeError('documentId must be non-empty')
    }
    if (this.documentId !== undefined && this.documentId !== documentId) {
      throw new Error(`transport ${this.id} is already bound to document ${this.documentId}`)
    }
    if (this.state === 'online') {
      return
    }

    this.metrics.connectAttempts += 1
    const reconnecting = this.hasConnected
    this.transition('connecting')
    this.documentId = documentId
    this.transition('online')
    this.metrics.successfulConnections += 1
    if (reconnecting) {
      this.metrics.reconnects += 1
    }
    this.hasConnected = true

    this.network.onTransportOnline(this)
    this.flushOutboundQueue()
  }

  async send(update: Uint8Array): Promise<void> {
    this.assertOpen()
    if (!(update instanceof Uint8Array)) {
      throw new TypeError('update must be a Uint8Array')
    }

    if (this.state !== 'online' || this.documentId === undefined) {
      this.outboundQueue.push(copyBytes(update))
      this.metrics.queuedOutbound += 1
      return
    }

    this.network.publish(this, this.documentId, copyBytes(update))
  }

  subscribe(listener: TransportUpdateListener): () => void {
    return subscribeTo(this.updates, listener)
  }

  subscribeState(listener: TransportStateListener): () => void {
    return subscribeTo(this.stateListeners, listener)
  }

  subscribeRecovery(listener: TransportRecoveryListener): () => void {
    return subscribeTo(this.recoveryListeners, listener)
  }

  /** Enter a recoverable offline state without discarding queued work. */
  async disconnect(): Promise<void> {
    this.assertOpen()
    if (this.state !== 'offline') {
      this.transition('offline')
    }
  }

  async close(): Promise<void> {
    if (this.state === 'closed') {
      return
    }
    this.transition('closed')
    this.network.removeTransport(this.id)
    this.updates.clear()
    this.stateListeners.clear()
    this.recoveryListeners.clear()
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
      duplicated: this.metrics.duplicated,
      queuedOutbound: this.metrics.queuedOutbound,
      pendingOutbound: this.outboundQueue.length,
      pendingInbound: this.network.pendingOffline(this.id),
      recoverySignals: this.metrics.recoverySignals
    }
  }

  receive(update: Uint8Array): void {
    if (this.state !== 'online') {
      return
    }
    this.metrics.received += 1
    const stable = copyBytes(update)
    for (const listener of this.updates) {
      listener(copyBytes(stable))
    }
  }

  signalRecovery(event: TransportRecoveryRequired): void {
    this.metrics.recoverySignals += 1
    for (const listener of this.recoveryListeners) {
      listener(event)
    }
  }

  recordSent(): void {
    this.metrics.sent += 1
  }

  recordDelivered(): void {
    this.metrics.delivered += 1
  }

  recordDropped(): void {
    this.metrics.dropped += 1
  }

  recordDuplicated(count: number): void {
    this.metrics.duplicated += count
  }

  private flushOutboundQueue(): void {
    if (this.documentId === undefined || this.state !== 'online') {
      return
    }

    const queued = this.outboundQueue.splice(0)
    for (const update of queued) {
      this.network.publish(this, this.documentId, update)
    }
  }

  private transition(next: TransportConnectionState): void {
    if (next === this.state) {
      return
    }
    const previous = this.state
    this.state = next
    const event = { previous, current: next, at: this.network.now } as const
    for (const listener of this.stateListeners) {
      listener(event)
    }
  }

  private assertOpen(): void {
    if (this.state === 'closed') {
      throw new Error('transport is closed')
    }
  }
}
