import type {
  ObservableCollaborativeTransport,
  TransportConnectionState,
  TransportMetrics,
  TransportStateListener,
  TransportUpdateListener
} from '@e2e-col/transport'
import { describe, expect, it } from 'vitest'
import { InspectorEventStore, instrumentTransportFactory } from './inspector-events'

describe('InspectorEventStore', () => {
  it('strips credential-shaped fields from expandable detail', () => {
    const store = new InspectorEventStore()
    store.append({
      direction: 'internal',
      operation: 'test',
      detail: {
        publicKey: 'safe',
        sessionToken: 'must-not-appear',
        nested: { privateKeyHex: 'must-not-appear', nonce: 'safe' }
      }
    })
    expect(JSON.stringify(store.events())).toContain('publicKey')
    expect(JSON.stringify(store.events())).toContain('nonce')
    expect(JSON.stringify(store.events())).not.toContain('must-not-appear')
    expect(JSON.stringify(store.events())).not.toContain('sessionToken')
    expect(JSON.stringify(store.events())).not.toContain('privateKeyHex')
  })

  it('observes real transport send/receive sizes and metrics without changing the wire bytes', async () => {
    const raw = new FakeTransport()
    const store = new InspectorEventStore()
    const factory = instrumentTransportFactory(() => raw, store)
    const transport = factory({ documentId: 'doc-1' })
    const received: number[][] = []
    transport.subscribe((bytes) => received.push([...bytes]))
    await transport.connect('doc-1')
    await transport.send(new Uint8Array([1, 2, 3]))
    raw.deliver(new Uint8Array([4, 5]))

    expect(raw.sent).toEqual([[1, 2, 3]])
    expect(received).toEqual([[4, 5]])
    expect(store.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: 'transport_send', inputSizeBytes: 3, result: 'ok' }),
        expect.objectContaining({ operation: 'transport_receive', inputSizeBytes: 2, result: 'ok' })
      ])
    )
    expect(store.getTransportMetrics()?.sent).toBe(1)
    expect(store.getTransportMetrics()?.received).toBe(1)
  })
})

class FakeTransport implements ObservableCollaborativeTransport {
  readonly sent: number[][] = []
  private readonly updates = new Set<TransportUpdateListener>()
  private readonly stateListeners = new Set<TransportStateListener>()
  private state: TransportConnectionState = 'disconnected'
  private sentCount = 0
  private receivedCount = 0

  async connect(): Promise<void> {
    const previous = this.state
    this.state = 'online'
    for (const listener of this.stateListeners)
      listener({ previous, current: 'online', at: Date.now() })
  }

  async send(update: Uint8Array): Promise<void> {
    this.sent.push([...update])
    this.sentCount += 1
  }

  deliver(update: Uint8Array): void {
    this.receivedCount += 1
    for (const listener of this.updates) listener(update)
  }

  subscribe(listener: TransportUpdateListener): () => void {
    this.updates.add(listener)
    return () => this.updates.delete(listener)
  }

  subscribeState(listener: TransportStateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  subscribeRecovery(): () => void {
    return () => undefined
  }

  getState(): TransportConnectionState {
    return this.state
  }

  getMetrics(): TransportMetrics {
    return {
      state: this.state,
      connectAttempts: 1,
      successfulConnections: this.state === 'online' ? 1 : 0,
      reconnects: 0,
      sent: this.sentCount,
      delivered: this.sentCount,
      received: this.receivedCount,
      dropped: 0,
      duplicated: 0,
      queuedOutbound: 0,
      pendingOutbound: 0,
      pendingInbound: 0,
      recoverySignals: 0
    }
  }

  async close(): Promise<void> {
    this.state = 'closed'
  }
}
