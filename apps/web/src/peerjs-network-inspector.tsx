import type { PeerJsTransport } from '@e2e-col/transport'
import { type FormEvent, useState } from 'react'
import { parseRoomInput } from './peerjs-room-invitation'
import { freshObservedPeers, type ObservedPeer } from './peerjs-room-presence'

export type PeerHealth = NonNullable<ReturnType<PeerJsTransport['getLobbyHealth']>>
export type PeerMetrics = ReturnType<PeerJsTransport['getMetrics']>
export interface InspectorEntry {
  readonly seq: number
  readonly at: number
  readonly level: 'info' | 'warn' | 'error'
  readonly message: string
}

export interface PeerJsNetworkInspectorProps {
  readonly documentId: string
  readonly selfId: string
  readonly transportState: string
  readonly health: PeerHealth | undefined
  readonly metrics: PeerMetrics | undefined
  readonly peers: readonly ObservedPeer[]
  readonly log: readonly InspectorEntry[]
  readonly working: boolean
  readonly onRetry: () => Promise<void>
  readonly onBeforeJoin: () => Promise<void>
  readonly onResync: () => void
  readonly onClearLog: () => void
}

function counter(health: PeerHealth | undefined, key: keyof PeerHealth): string {
  return health ? String(health[key] ?? '—') : '—'
}

export function PeerJsNetworkInspector({
  documentId,
  selfId,
  transportState,
  health,
  metrics,
  peers,
  log,
  working,
  onRetry,
  onBeforeJoin,
  onResync,
  onClearLog
}: PeerJsNetworkInspectorProps) {
  const [joinLink, setJoinLink] = useState('')
  const [joinUuid, setJoinUuid] = useState('')
  const [joinSecret, setJoinSecret] = useState('')
  const [joinError, setJoinError] = useState<string>()
  const [joining, setJoining] = useState(false)
  const [copyStatus, setCopyStatus] = useState('')
  const [level, setLevel] = useState<'all' | InspectorEntry['level']>('all')
  const activePeers = freshObservedPeers(peers, Date.now())

  async function join(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (joining) return
    setJoining(true)
    try {
      const next = parseRoomInput(joinLink, joinUuid, joinSecret, window.location.href)
      // Finish pending encrypted IndexedDB writes before navigating away.
      await onBeforeJoin()
      window.location.assign(next)
    } catch (cause) {
      setJoinError(cause instanceof Error ? cause.message : 'Invalid invitation or save failed')
    } finally {
      setJoining(false)
    }
  }

  async function copyReport() {
    // No invitation URL, secret, document text or unencrypted traffic is exported.
    const report = {
      signalcd: 'peerjs-browser-diagnostics-v1',
      at: new Date().toISOString(),
      transportState,
      documentId,
      roomCode: health?.roomId.slice(0, 12),
      peer: { self: selfId.slice(0, 8), role: health?.role, onlineCount: activePeers.length },
      health: health && {
        state: health.state,
        role: health.role,
        connectedPeers: health.connectedPeers,
        lastSequence: health.lastSequence,
        queuedOutbound: health.queuedOutbound,
        pendingOutbound: health.pendingOutbound,
        sent: health.sent,
        received: health.received,
        replayed: health.replayed,
        dropped: health.dropped,
        reconnectAttempts: health.reconnectAttempts,
        backpressureSignals: health.backpressureSignals,
        staleDisconnects: health.staleDisconnects
      },
      metrics,
      events: log.map(({ at, level, message }) => ({ at, level, message }))
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
      setCopyStatus('Diagnostic report copied (no invitation secret or document text).')
    } catch {
      setCopyStatus('Clipboard unavailable. Please use the visible event log.')
    }
  }

  const visibleLog = log.filter((entry) => level === 'all' || entry.level === level)

  return (
    <details className="inspector" open>
      <summary>Network inspector · peers, events, connection tools</summary>
      <div className="inspector-body">
        <section aria-label="PeerJS metrics" className="inspector-card">
          <h2>Transport inspection</h2>
          <dl className="inspect-grid">
            <div>
              <dt>Document UUID</dt>
              <dd>
                <code>{documentId}</code>
              </dd>
            </div>
            <div>
              <dt>Transport state</dt>
              <dd>{transportState}</dd>
            </div>
            <div>
              <dt>PeerJS lobby</dt>
              <dd>{health?.state ?? 'unknown'}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{health?.role ?? 'unknown'}</dd>
            </div>
            <div>
              <dt>Local peer ID</dt>
              <dd>
                <code>{health?.peerId ?? 'pending'}</code>
              </dd>
            </div>
            <div>
              <dt>Lobby peer connections</dt>
              <dd>
                {health?.role === 'client' ? 'connected to hub' : (health?.connectedPeers ?? 0)}
              </dd>
            </div>
            <div>
              <dt>Hub epoch</dt>
              <dd>
                <code>{health?.epoch ?? '—'}</code>
              </dd>
            </div>
            <div>
              <dt>Last sequence</dt>
              <dd>{counter(health, 'lastSequence')}</dd>
            </div>
            <div>
              <dt>Sent / received</dt>
              <dd>
                {counter(health, 'sent')} / {counter(health, 'received')}
              </dd>
            </div>
            <div>
              <dt>Queued / pending</dt>
              <dd>
                {counter(health, 'queuedOutbound')} / {counter(health, 'pendingOutbound')}
              </dd>
            </div>
            <div>
              <dt>Replay / dropped</dt>
              <dd>
                {counter(health, 'replayed')} / {counter(health, 'dropped')}
              </dd>
            </div>
            <div>
              <dt>Reconnects</dt>
              <dd>
                {metrics?.reconnects ?? 0} (library attempts: {counter(health, 'reconnectAttempts')}
                )
              </dd>
            </div>
            <div>
              <dt>Backpressure</dt>
              <dd>{counter(health, 'backpressureSignals')}</dd>
            </div>
            <div>
              <dt>Stale disconnects</dt>
              <dd>{counter(health, 'staleDisconnects')}</dd>
            </div>
            <div>
              <dt>Last activity</dt>
              <dd>
                {health?.lastActivityAt
                  ? new Date(health.lastActivityAt).toLocaleTimeString()
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Last peer error</dt>
              <dd>{health?.lastError ?? 'none'}</dd>
            </div>
          </dl>
          <div className="inspect-actions">
            <button type="button" onClick={() => void onRetry()} disabled={working}>
              {working
                ? 'Reconnecting…'
                : transportState === 'online'
                  ? 'Reconnect'
                  : 'Retry connection'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={onResync}
              disabled={working || transportState !== 'online'}
            >
              Request snapshot sync
            </button>
            <button type="button" className="secondary-button" onClick={() => void copyReport()}>
              Copy diagnostic report
            </button>
          </div>
          {copyStatus && (
            <p role="status" className="inspector-note">
              {copyStatus}
            </p>
          )}
        </section>
        <section aria-label="Connected client list" className="inspector-card">
          <h2>
            Observed clients <small>({activePeers.length + 1} including this tab)</small>
          </h2>
          <ul className="inspect-client-list">
            <li>
              <span className="peer-dot online-dot" /> <code>{selfId.slice(0, 8)}</code>{' '}
              <strong>this tab</strong> — {transportState}
            </li>
            {activePeers.map((peer) => (
              <li key={peer.id}>
                <span className="peer-dot online-dot" />
                <code>{peer.id.slice(0, 8)}</code>
                <span>
                  anonymous peer · last seen{' '}
                  {Math.max(0, Math.floor((Date.now() - peer.seenAt) / 1000))}s ago
                </span>
              </li>
            ))}
          </ul>
          <p className="inspector-note">
            Best-effort encrypted heartbeat observations (45s timeout), not the PeerJS server's
            authoritative client list. These anonymous tab IDs are not authenticated identities. A
            hub may also report a different connection count while peers negotiate.
          </p>
        </section>
        <section aria-label="Join room" className="inspector-card">
          <h2>Join another room</h2>
          <form onSubmit={join} className="inspect-join-form">
            <label htmlFor="inspect-invite">Paste complete invitation (recommended)</label>
            <input
              id="inspect-invite"
              type="text"
              autoComplete="off"
              value={joinLink}
              onChange={(event) => {
                setJoinLink(event.target.value)
                setJoinError(undefined)
              }}
              placeholder="https://…/peerjs/?document=…#peerjs=…"
            />
            <p className="inspector-note">
              Or enter both the document UUID and its invitation secret:
            </p>
            <label htmlFor="inspect-uuid">Document UUID</label>
            <input
              id="inspect-uuid"
              type="text"
              autoComplete="off"
              value={joinUuid}
              onChange={(event) => {
                setJoinUuid(event.target.value)
                setJoinError(undefined)
              }}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            />
            <label htmlFor="inspect-secret">Invitation secret (required alongside UUID)</label>
            <input
              id="inspect-secret"
              type="password"
              autoComplete="off"
              value={joinSecret}
              onChange={(event) => {
                setJoinSecret(event.target.value)
                setJoinError(undefined)
              }}
              placeholder="64 hexadecimal characters"
            />
            <button type="submit" disabled={joining}>
              {joining ? 'Joining…' : 'Join room'}
            </button>
            {joinError && (
              <p className="demo-error" role="alert">
                {joinError}
              </p>
            )}
          </form>
        </section>
        <section aria-label="PeerJS event log" className="inspector-card">
          <div className="log-toolbar">
            <h2>
              Local event log <small>({log.length} buffered)</small>
            </h2>
            <label htmlFor="inspect-level">
              Filter
              <select
                id="inspect-level"
                value={level}
                onChange={(event) => setLevel(event.target.value as typeof level)}
              >
                <option value="all">All</option>
                <option value="info">Info</option>
                <option value="warn">Warnings</option>
                <option value="error">Errors</option>
              </select>
            </label>
            <button type="button" className="secondary-button" onClick={onClearLog}>
              Clear log
            </button>
          </div>
          <div className="inspect-log" role="log" aria-label="Local PeerJS event log">
            {visibleLog.length === 0 && <p>Waiting for transport events…</p>}
            {visibleLog.map((entry) => (
              <div key={entry.seq} className={`inspect-log-entry log-${entry.level}`}>
                <time dateTime={new Date(entry.at).toISOString()}>
                  {new Date(entry.at).toLocaleTimeString()}
                </time>
                <strong>{entry.level}</strong>
                <span>{entry.message}</span>
              </div>
            ))}
          </div>
          <p className="inspector-note">
            Local-only ring buffer (up to 200 events). No document contents, keys or complete
            invitations are logged. Browser developer tools can provide additional WebRTC errors.
          </p>
        </section>
      </div>
    </details>
  )
}
