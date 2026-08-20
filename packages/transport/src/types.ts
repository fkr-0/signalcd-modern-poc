export type TransportConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'closed'

export type TransportUpdateListener = (update: Uint8Array) => void

export interface TransportStateChange {
  readonly previous: TransportConnectionState
  readonly current: TransportConnectionState
  readonly at: number
}

export type TransportStateListener = (event: TransportStateChange) => void

export interface TransportRecoveryRequired {
  readonly documentId: string
  readonly sourceId: string
  readonly targetId: string
  readonly sendSequence: number
  readonly reason: 'dropped-frame' | 'sidecar-history-risk'
}

export type TransportRecoveryListener = (event: TransportRecoveryRequired) => void

export interface TransportMetrics {
  readonly state: TransportConnectionState
  readonly connectAttempts: number
  readonly successfulConnections: number
  readonly reconnects: number
  readonly sent: number
  readonly delivered: number
  readonly received: number
  readonly dropped: number
  readonly duplicated: number
  readonly queuedOutbound: number
  readonly pendingOutbound: number
  readonly pendingInbound: number
  readonly recoverySignals: number
}

/**
 * Minimum browser-facing transport contract from docs/ARCHITECTURE.md.
 * Payloads stay opaque here; protocol validation belongs in packages/protocol.
 */
export interface CollaborativeTransport {
  connect(documentId: string): Promise<void>
  send(update: Uint8Array): Promise<void>
  subscribe(listener: TransportUpdateListener): () => void
  close(): Promise<void>
}

/**
 * Optional observability used by the editor and deterministic test harnesses.
 * Production adapters can implement this without changing the minimum contract.
 */
export interface ObservableCollaborativeTransport extends CollaborativeTransport {
  getState(): TransportConnectionState
  getMetrics(): TransportMetrics
  subscribeState(listener: TransportStateListener): () => void
  subscribeRecovery(listener: TransportRecoveryListener): () => void
}
