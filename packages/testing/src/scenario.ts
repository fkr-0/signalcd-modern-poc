import { CollaborativeDocument, type DocumentChange, type TextEdit } from '@e2e-col/core'
import {
  DeterministicTransportNetwork,
  type DeterministicNetworkOptions,
  type SimulatedTransport,
  type TransportMetrics,
  type TransportRecoveryRequired
} from '@e2e-col/transport'

export interface CollaborativeScenarioOptions {
  readonly documentId?: string
  readonly network?: DeterministicNetworkOptions
}

export interface ScenarioPeer {
  readonly id: string
  readonly document: CollaborativeDocument
  readonly transport: SimulatedTransport
  readonly recoveryEvents: readonly TransportRecoveryRequired[]
}

interface MutableScenarioPeer {
  id: string
  document: CollaborativeDocument
  transport: SimulatedTransport
  recoveryEvents: TransportRecoveryRequired[]
}

/**
 * Integration harness joining the real CRDT core to the deterministic transport.
 * It deliberately contains no protocol or UI behavior, making it suitable for
 * convergence, reconnect, duplicate, reorder, and recovery tests.
 */
export class CollaborativeScenario {
  readonly network: DeterministicTransportNetwork
  readonly documentId: string
  private readonly peers = new Map<string, MutableScenarioPeer>()

  constructor(options: CollaborativeScenarioOptions = {}) {
    this.documentId = options.documentId ?? 'test-document'
    this.network = new DeterministicTransportNetwork(options.network)
  }

  addPeer(id: string, initialState?: Uint8Array): ScenarioPeer {
    if (this.peers.has(id)) throw new Error(`peer already exists: ${id}`)

    const document = new CollaborativeDocument(initialState)
    const transport = this.network.createTransport(id)
    const recoveryEvents: TransportRecoveryRequired[] = []
    transport.subscribe((change) => document.applyChanges([change]))
    transport.subscribeRecovery((event) => recoveryEvents.push(event))

    const peer = { id, document, transport, recoveryEvents }
    this.peers.set(id, peer)
    return peer
  }

  peer(id: string): ScenarioPeer {
    const peer = this.peers.get(id)
    if (!peer) throw new Error(`unknown peer: ${id}`)
    return peer
  }

  async connect(...ids: string[]): Promise<void> {
    const selected = ids.length === 0 ? [...this.peers.keys()] : ids
    await Promise.all(selected.map((id) => this.mutablePeer(id).transport.connect(this.documentId)))
  }

  async disconnect(id: string): Promise<void> {
    await this.mutablePeer(id).transport.disconnect()
  }

  async reconnect(id: string): Promise<void> {
    await this.mutablePeer(id).transport.connect(this.documentId)
  }

  async editText(id: string, nextText: string): Promise<DocumentChange[]> {
    const peer = this.mutablePeer(id)
    const changes = peer.document.editText(nextText)
    await this.publish(peer, changes)
    return changes
  }

  async spliceText(id: string, edit: TextEdit): Promise<DocumentChange[]> {
    const peer = this.mutablePeer(id)
    const changes = peer.document.spliceText(edit)
    await this.publish(peer, changes)
    return changes
  }

  flush(): void {
    this.network.flush()
  }

  advanceBy(milliseconds: number): void {
    this.network.advanceBy(milliseconds)
  }

  releaseHeld(order: 'fifo' | 'lifo' = 'fifo'): void {
    this.network.releaseHeld({ order })
  }

  texts(): Readonly<Record<string, string>> {
    return Object.fromEntries([...this.peers].map(([id, peer]) => [id, peer.document.getText()]))
  }

  converged(): boolean {
    const states = [...this.peers.values()].map((peer) => ({
      text: peer.document.getText(),
      heads: [...peer.document.getHeads()].sort().join(',')
    }))
    if (states.length <= 1) return true
    const first = states[0]!
    return states.every((state) => state.text === first.text && state.heads === first.heads)
  }

  metrics(id: string): TransportMetrics {
    return this.mutablePeer(id).transport.getMetrics()
  }

  private mutablePeer(id: string): MutableScenarioPeer {
    const peer = this.peers.get(id)
    if (!peer) throw new Error(`unknown peer: ${id}`)
    return peer
  }

  private async publish(
    peer: MutableScenarioPeer,
    changes: readonly DocumentChange[]
  ): Promise<void> {
    for (const change of changes) await peer.transport.send(change)
  }
}
