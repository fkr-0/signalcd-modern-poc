import type { SessionStatus } from '@e2e-col/client'
import {
  IndexedDbIdentityStorage,
  publicKeyFingerprint,
  type SyncLogClient,
  type UserIdentity
} from '@e2e-col/identity'
import type { DocumentAccessState } from '@e2e-col/protocol'
import type {
  MockSignalGroupMember,
  ObservableCollaborativeTransport,
  TransportMetrics
} from '@e2e-col/transport'
import { useEffect, useMemo, useRef, useState } from 'react'
import { type CollaborationGroupView, getGroup } from './client-adapter'
import {
  appendSidecarSyncEvent,
  bytesToHex,
  INBOUND_PIPELINE,
  type InspectorDirection,
  type InspectorEvent,
  type InspectorEventStore,
  OUTBOUND_PIPELINE,
  type PipelineOperation
} from './inspector-events'
import './dashboard.css'

const GUIDED_MODE_KEY = 'e2e-col-guided-mode'
const SIGNAL_CD_PAPER_URL =
  'https://www.usenix.org/system/files/conference/usenixsecurity26/sec26_prepub_knabenhans.pdf'
const SIGNAL_SPEC_URL = 'https://signal.org/docs/'

interface DashboardProps {
  readonly identity: UserIdentity
  readonly identityServerUrl: string
  readonly groupId?: string
  readonly documentId: string
  readonly access?: DocumentAccessState
  readonly status?: SessionStatus
  readonly transportLabel: string
  readonly transport?: ObservableCollaborativeTransport
  readonly inspector: InspectorEventStore
  readonly syncLogClient: SyncLogClient
  readonly onShowWorkspace: () => void
}

const paperReferences: Record<
  PipelineOperation,
  { readonly label: string; readonly href: string }
> = {
  crdt_change: { label: 'Paper §2.2', href: `${SIGNAL_CD_PAPER_URL}#page=2` },
  envelope: { label: 'Paper §5.1', href: `${SIGNAL_CD_PAPER_URL}#page=7` },
  sign: { label: 'Paper §6.2', href: `${SIGNAL_CD_PAPER_URL}#page=9` },
  encrypt: { label: 'Paper §6.2', href: `${SIGNAL_CD_PAPER_URL}#page=9` },
  fanout_frame: { label: 'Paper §6.2', href: `${SIGNAL_CD_PAPER_URL}#page=9` },
  transport_send: { label: 'Paper §6.3', href: `${SIGNAL_CD_PAPER_URL}#page=10` },
  transport_receive: { label: 'Paper §6.3', href: `${SIGNAL_CD_PAPER_URL}#page=10` },
  fanout_decode: { label: 'Paper §6.3', href: `${SIGNAL_CD_PAPER_URL}#page=10` },
  decrypt: { label: 'Paper §6.2', href: `${SIGNAL_CD_PAPER_URL}#page=9` },
  verify_signature: { label: 'Paper §6.2', href: `${SIGNAL_CD_PAPER_URL}#page=9` },
  envelope_decode: { label: 'Paper §5.1', href: `${SIGNAL_CD_PAPER_URL}#page=7` },
  dedup: { label: 'Paper §5.1', href: `${SIGNAL_CD_PAPER_URL}#page=7` },
  crdt_apply: { label: 'Paper §2.2', href: `${SIGNAL_CD_PAPER_URL}#page=2` }
}

interface IdentityReadout {
  readonly identityFingerprint: string
  readonly identityPublicHex: string
  readonly signedPrekeyFingerprint: string
  readonly signedPrekeyPublicHex: string
}

interface PeerReadout {
  readonly userId: string
  readonly phoneNumber: string
  readonly fingerprint?: string
  readonly verified?: boolean
}

const annotations: Partial<Record<PipelineOperation, string>> = {
  crdt_change: 'The editor asks the local CRDT to produce a convergent change.',
  envelope: 'Protocol metadata binds the change to a document, sender, and message ID.',
  sign: 'Ed25519 proves which identity produced the encrypted message.',
  encrypt: 'Each current recipient receives independently encrypted ciphertext.',
  fanout_frame: 'Recipient ciphertexts are assembled into one transport fanout frame.',
  transport_send: 'The selected transport sends the exact bytes produced above.',
  transport_receive: 'Opaque bytes arrived from the currently selected transport.',
  fanout_decode: 'Recipient-bound encrypted metadata is decoded without exposing plaintext.',
  decrypt: 'Authenticated decryption recovers the protocol envelope for this recipient.',
  verify_signature: 'The sender signature is checked against distributed public identity material.',
  envelope_decode: 'Validated plaintext bytes become typed protocol-envelope metadata.',
  dedup: 'Seen-message state prevents a repeated delivery from applying twice.',
  crdt_apply: 'A validated, authorized change is merged into the local CRDT.'
}

const conceptHelp: Partial<Record<PipelineOperation, string>> = {
  sign: 'Ed25519 is a public-key signature scheme.',
  encrypt: 'X25519 performs key agreement; HKDF derives an AES-256-GCM content key.',
  crdt_change: 'A CRDT converges replicas without requiring a central plaintext document server.',
  dedup: 'At-least-once delivery can repeat messages, so message IDs are tracked locally.'
}

export function Dashboard(props: DashboardProps) {
  const [, setRevision] = useState(0)
  const [guided, setGuided] = useState(() => localStorage.getItem(GUIDED_MODE_KEY) === 'true')
  const [group, setGroup] = useState<CollaborationGroupView>()
  const [identityReadout, setIdentityReadout] = useState<IdentityReadout>()
  const [peers, setPeers] = useState<readonly PeerReadout[]>([])
  const [prekeyPoolCount, setPrekeyPoolCount] = useState<number>()
  const [sessionTokenStatus, setSessionTokenStatus] = useState<
    'valid' | 'expired' | 'missing' | 'unavailable'
  >(props.identity.sessionToken ? 'valid' : 'missing')

  useEffect(
    () => props.inspector.subscribe(() => setRevision((value) => value + 1)),
    [props.inspector]
  )

  useEffect(() => {
    const unsubscribe = props.syncLogClient.subscribe((entry) =>
      appendSidecarSyncEvent(props.inspector, entry)
    )
    props.syncLogClient.connect()
    return () => {
      unsubscribe()
      props.syncLogClient.disconnect()
    }
  }, [props.inspector, props.syncLogClient])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'g') {
        event.preventDefault()
        setGuided((value) => !value)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    localStorage.setItem(GUIDED_MODE_KEY, String(guided))
  }, [guided])

  useEffect(() => {
    let active = true
    void identityPublicReadout(props.identity).then((readout) => {
      if (active) setIdentityReadout(readout)
    })
    return () => {
      active = false
    }
  }, [props.identity])

  useEffect(() => {
    if (!props.groupId) {
      setGroup(undefined)
      return
    }
    let active = true
    const refresh = () => {
      void getGroup({
        baseUrl: props.identityServerUrl,
        groupId: props.groupId!,
        identity: props.identity
      })
        .then((next) => {
          if (active) setGroup(next)
        })
        .catch(() => undefined)
    }
    refresh()
    const timer = window.setInterval(refresh, 2_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [props.groupId, props.identity, props.identityServerUrl])

  useEffect(() => {
    let active = true
    const members =
      group?.members.filter((member) => member.user_id !== props.identity.userId) ?? []
    if (members.length === 0) {
      setPeers([])
      return
    }
    const storage = new IndexedDbIdentityStorage({ name: 'e2e-col-identity' })
    void Promise.all(
      members.map(async (member): Promise<PeerReadout> => {
        const cached = await storage.loadRemoteIdentity(member.user_id)
        if (!cached) return { userId: member.user_id, phoneNumber: member.phone_number }
        return {
          userId: member.user_id,
          phoneNumber: member.phone_number,
          fingerprint: await publicKeyFingerprint(cached.identityKeyPublic),
          verified: cached.verified
        }
      })
    )
      .then((next) => {
        if (active) setPeers(next)
      })
      .finally(() => void storage.close())
    return () => {
      active = false
      void storage.close()
    }
  }, [group, props.identity.userId])

  useEffect(() => {
    if (!props.identity.sessionToken) {
      setSessionTokenStatus('missing')
      return
    }
    let active = true
    void fetch(`${props.identityServerUrl}/api/v1/identity/session`, {
      headers: { authorization: `Bearer ${props.identity.sessionToken}` }
    })
      .then(async (response) => {
        if (!active) return
        setSessionTokenStatus(
          response.ok ? 'valid' : response.status === 401 ? 'expired' : 'unavailable'
        )
        if (response.ok) {
          const value = (await response.json()) as { prekey_count?: unknown }
          if (typeof value.prekey_count === 'number') setPrekeyPoolCount(value.prekey_count)
        }
      })
      .catch(() => {
        if (active) setSessionTokenStatus('unavailable')
      })
    return () => {
      active = false
    }
  }, [props.identity.sessionToken, props.identityServerUrl])

  const events = props.inspector.events()
  const metrics = props.transport?.getMetrics() ?? props.inspector.getTransportMetrics()
  const transportMembers = readMockSignalGroupMembers(props.transport)

  return (
    <main className="dashboard-shell">
      <header className="dashboard-header">
        <div>
          <span className="dashboard-kicker">e2e-col inspector</span>
          <strong>Sidecar dashboard</strong>
          <small>{props.transportLabel}</small>
        </div>
        <div className="dashboard-header-actions">
          <label className="guided-toggle" title="Toggle guided annotations (Ctrl+Shift+G)">
            <input
              type="checkbox"
              checked={guided}
              onChange={(event) => setGuided(event.target.checked)}
            />
            Guided
          </label>
          <button type="button" className="dashboard-button" onClick={props.onShowWorkspace}>
            Workspace
          </button>
        </div>
      </header>

      <div className="dashboard-layout">
        <aside className="dashboard-sidebar">
          <IdentityPanel
            identity={props.identity}
            readout={identityReadout}
            peers={peers}
            prekeyPoolCount={prekeyPoolCount}
            sessionTokenStatus={sessionTokenStatus}
            guided={guided}
          />
          <GroupPanel
            group={group}
            groupId={props.groupId}
            transportMembers={transportMembers}
            access={props.access}
            events={events}
            fallbackDocumentId={props.documentId}
          />
          <TransportPanel status={props.status} metrics={metrics} />
        </aside>

        <section className="dashboard-main">
          <Pipeline events={events} guided={guided} />
        </section>

        <section className="dashboard-traffic">
          <TrafficLog events={events} />
        </section>
      </div>
    </main>
  )
}

function IdentityPanel(props: {
  readonly identity: UserIdentity
  readonly readout?: IdentityReadout | undefined
  readonly peers: readonly PeerReadout[]
  readonly prekeyPoolCount?: number | undefined
  readonly sessionTokenStatus: string
  readonly guided: boolean
}) {
  return (
    <Panel title="Identity" subtitle="browser-owned">
      <Readout label="user_id" value={props.identity.userId} />
      <Readout label="phone_number" value={props.identity.phoneNumber} />
      <Readout label="display_name" value={props.identity.displayName} />
      <Readout label="created_at" value={new Date(props.identity.createdAt).toISOString()} />
      <FingerprintReadout
        label="identity_key_fingerprint"
        fingerprint={props.readout?.identityFingerprint}
        publicHex={props.readout?.identityPublicHex}
      />
      {props.guided ? (
        <details className="key-explainer">
          <summary>Why identity key?</summary>
          <p>
            Your long-term Ed25519 public identity verifies signatures. Private key bytes never
            enter this inspector.
          </p>
        </details>
      ) : null}
      <FingerprintReadout
        label="signed_prekey_fingerprint"
        fingerprint={props.readout?.signedPrekeyFingerprint}
        publicHex={props.readout?.signedPrekeyPublicHex}
      />
      {props.guided ? (
        <details className="key-explainer">
          <summary>Why signed prekey?</summary>
          <p>
            The X25519 signed prekey lets peers establish encrypted messages while you are offline.
          </p>
        </details>
      ) : null}
      <Readout
        label="one_time_prekey_pool"
        value={
          props.prekeyPoolCount === undefined
            ? `${props.identity.oneTimePrekeys.length} retained locally`
            : String(props.prekeyPoolCount)
        }
      />
      <Readout label="session_token_status" value={props.sessionTokenStatus} />
      <div className="dashboard-subsection">
        <span className="dashboard-label">known_peers</span>
        {props.peers.length === 0 ? <code>—</code> : null}
        {props.peers.map((peer) => (
          <details key={peer.userId} className="peer-row">
            <summary>{peer.phoneNumber}</summary>
            <Readout label="user_id" value={peer.userId} />
            <Readout label="fingerprint" value={peer.fingerprint ?? 'not cached'} />
            <Readout
              label="verified"
              value={peer.verified === undefined ? 'unknown' : String(peer.verified)}
            />
          </details>
        ))}
      </div>
    </Panel>
  )
}

function FingerprintReadout(props: {
  readonly label: string
  readonly fingerprint?: string | undefined
  readonly publicHex?: string | undefined
}) {
  const fingerprint = props.fingerprint ?? 'loading…'
  return (
    <details className="fingerprint-row">
      <summary>
        <span>{props.label}</span>
        <code>{props.fingerprint ? `${props.fingerprint.slice(0, 16)}…` : fingerprint}</code>
      </summary>
      <div className="hex-detail">
        <span>SHA-256</span>
        <code>{fingerprint}</code>
        <button
          type="button"
          disabled={!props.fingerprint}
          onClick={() => props.fingerprint && void navigator.clipboard.writeText(props.fingerprint)}
        >
          Copy fingerprint
        </button>
        <span>Public key raw hex</span>
        <code>{props.publicHex ?? 'loading…'}</code>
      </div>
    </details>
  )
}

function GroupPanel(props: {
  readonly group?: CollaborationGroupView | undefined
  readonly groupId?: string | undefined
  readonly transportMembers?: readonly MockSignalGroupMember[] | undefined
  readonly access?: DocumentAccessState | undefined
  readonly events: readonly InspectorEvent[]
  readonly fallbackDocumentId: string
}) {
  const group = props.group
  const members =
    props.transportMembers && props.transportMembers.length > 0
      ? props.transportMembers.map((member) => ({
          user_id: member.userId,
          phone_number: member.phoneNumber,
          role: member.role
        }))
      : (group?.members ?? [])
  return (
    <Panel
      title="Group"
      subtitle={members.length > 0 ? `${members.length} members` : 'unavailable'}
    >
      <Readout label="group_id" value={group?.group_id ?? props.groupId ?? '—'} />
      <Readout label="document_id" value={group?.document_id ?? props.fallbackDocumentId} />
      <Readout label="self_role" value={props.access?.selfRole ?? '—'} />
      <Readout
        label="member_count"
        value={String(members.length || props.access?.participants.length || 0)}
      />
      <div className="group-table-wrap">
        <table className="compact-table">
          <thead>
            <tr>
              <th>phone_number</th>
              <th>user_id</th>
              <th>role</th>
              <th>active</th>
              <th>last_seen</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const accessMember = props.access?.participants.find(
                (participant) => participant.participantId === member.user_id
              )
              const lastSeen = [...props.events]
                .reverse()
                .find((event) => event.sender === member.phone_number)?.timestamp
              return (
                <tr key={member.user_id}>
                  <td>{member.phone_number}</td>
                  <td title={member.user_id}>{short(member.user_id)}</td>
                  <td>{accessMember?.role ?? member.role}</td>
                  <td>{String(accessMember?.active ?? true)}</td>
                  <td>{lastSeen === undefined ? '—' : formatTime(lastSeen)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}

function TransportPanel(props: {
  readonly status?: SessionStatus | undefined
  readonly metrics?: TransportMetrics | undefined
}) {
  const metrics = props.metrics
  return (
    <Panel title="Transport" subtitle={props.status?.transport ?? metrics?.state ?? 'unknown'}>
      <Readout label="connection_state" value={props.status?.transport ?? metrics?.state ?? '—'} />
      <Readout
        label="pending_outbound"
        value={String(props.status?.pendingOutbound ?? metrics?.pendingOutbound ?? 0)}
      />
      <div className="metric-grid">
        {(['sent', 'delivered', 'received', 'dropped', 'duplicated'] as const).map((key) => (
          <Readout key={key} label={key} value={String(metrics?.[key] ?? 0)} />
        ))}
      </div>
      <Readout label="last_sent_at" value={formatOptionalTime(props.status?.lastSentAt)} />
      <Readout label="last_received_at" value={formatOptionalTime(props.status?.lastReceivedAt)} />
      <Readout label="reconnect_count" value={String(metrics?.reconnects ?? 0)} />
    </Panel>
  )
}

function Pipeline({
  events,
  guided
}: {
  readonly events: readonly InspectorEvent[]
  readonly guided: boolean
}) {
  const latestMessageId = [...events].reverse().find((event) => event.messageId)?.messageId
  return (
    <section className="pipeline-panel" aria-label="Data pipeline">
      <header className="panel-heading">
        <div>
          <span className="dashboard-kicker">live transformation chain</span>
          <strong>Data pipeline</strong>
        </div>
        <code>{latestMessageId ? `message ${short(latestMessageId)}` : 'no message observed'}</code>
      </header>
      <PipelineLane
        title="Outbound"
        operations={OUTBOUND_PIPELINE}
        events={events}
        latestMessageId={latestMessageId}
        guided={guided}
      />
      <PipelineLane
        title="Inbound"
        operations={INBOUND_PIPELINE}
        events={events}
        latestMessageId={latestMessageId}
        guided={guided}
      />
      <p className="pipeline-policy">
        `—` means this stage was not directly observed for the selected message. The inspector does
        not infer missing timings or bytes.
      </p>
    </section>
  )
}

function PipelineLane(props: {
  readonly title: string
  readonly operations: readonly PipelineOperation[]
  readonly events: readonly InspectorEvent[]
  readonly latestMessageId?: string | undefined
  readonly guided: boolean
}) {
  return (
    <div className="pipeline-lane">
      <h3>{props.title}</h3>
      <div className="pipeline-chain">
        {props.operations.map((operation, index) => {
          const event = [...props.events]
            .reverse()
            .find(
              (candidate) =>
                candidate.operation === operation &&
                (props.latestMessageId === undefined ||
                  candidate.messageId === props.latestMessageId)
            )
          const active = event?.messageId !== undefined && event.messageId === props.latestMessageId
          return (
            <div className="pipeline-node-wrap" key={operation}>
              <details
                className={`pipeline-node ${active ? 'latest' : ''} ${event?.result.startsWith('error') ? 'failed' : ''}`}
              >
                <summary title={conceptHelp[operation]}>
                  <strong>{operation}</strong>
                  <span>{event ? sizePair(event) : '—'}</span>
                  <span>
                    {event?.durationMs === undefined ? '—' : `${event.durationMs.toFixed(2)} ms`}
                  </span>
                  <span>{event?.result ?? 'not observed'}</span>
                </summary>
                <pre>
                  {event
                    ? JSON.stringify(event.detail ?? event, null, 2)
                    : 'No direct event for this stage.'}
                </pre>
                {props.guided ? (
                  <div className="pipeline-annotation">
                    <span>{annotations[operation]}</span>
                    <a
                      className="paper-ref-badge"
                      href={paperReferences[operation].href}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {paperReferences[operation].label}
                    </a>
                    {operation === 'encrypt' ? (
                      <a href={SIGNAL_SPEC_URL} target="_blank" rel="noreferrer">
                        Signal spec
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </details>
              {index < props.operations.length - 1 ? (
                <span className="pipeline-arrow">→</span>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function TrafficLog({ events }: { readonly events: readonly InspectorEvent[] }) {
  const [direction, setDirection] = useState<InspectorDirection | 'all'>('all')
  const [operations, setOperations] = useState<readonly string[]>([])
  const [participant, setParticipant] = useState('')
  const [documentId, setDocumentId] = useState('')
  const [text, setText] = useState('')
  const [expanded, setExpanded] = useState<string>()
  const [hovered, setHovered] = useState(false)
  const scroller = useRef<HTMLElement>(null)

  const operationOptions = useMemo(
    () => [...new Set(events.map((event) => event.operation))].sort(),
    [events]
  )
  const filtered = useMemo(() => {
    const participantQuery = participant.trim().toLowerCase()
    const documentQuery = documentId.trim().toLowerCase()
    const textQuery = text.trim().toLowerCase()
    return events.filter((event) => {
      if (direction !== 'all' && event.direction !== direction) return false
      if (operations.length > 0 && !operations.includes(event.operation)) return false
      if (
        participantQuery &&
        ![event.sender, ...(event.recipients ?? [])]
          .filter((value): value is string => value !== undefined)
          .some((value) => value.toLowerCase().includes(participantQuery))
      )
        return false
      if (documentQuery && !event.documentId?.toLowerCase().includes(documentQuery)) return false
      if (textQuery && !JSON.stringify(event).toLowerCase().includes(textQuery)) return false
      return true
    })
  }, [direction, documentId, events, operations, participant, text])

  useEffect(() => {
    if (!hovered && filtered.length > 0)
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [filtered.length, hovered])

  function exportJson(): void {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(filtered, null, 2)], { type: 'application/json' })
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `e2e-col-traffic-${new Date().toISOString().replaceAll(':', '-')}.json`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="traffic-panel">
      <header className="traffic-header">
        <div>
          <span className="dashboard-kicker">
            {filtered.length} / {events.length} events
          </span>
          <strong>Traffic log</strong>
        </div>
        <button type="button" className="dashboard-button" onClick={exportJson}>
          Export JSON
        </button>
      </header>
      <div className="traffic-filters">
        <label>
          Direction
          <select
            value={direction}
            onChange={(event) => setDirection(event.target.value as InspectorDirection | 'all')}
          >
            <option value="all">all</option>
            <option value="outbound">outbound</option>
            <option value="inbound">inbound</option>
            <option value="internal">internal</option>
          </select>
        </label>
        <label>
          Operations
          <select
            multiple
            value={[...operations]}
            onChange={(event) =>
              setOperations([...event.currentTarget.selectedOptions].map((option) => option.value))
            }
          >
            {operationOptions.map((operation) => (
              <option key={operation}>{operation}</option>
            ))}
          </select>
        </label>
        <label>
          Participant
          <input
            value={participant}
            onChange={(event) => setParticipant(event.target.value)}
            placeholder="phone / user"
          />
        </label>
        <label>
          Document
          <input
            value={documentId}
            onChange={(event) => setDocumentId(event.target.value)}
            placeholder="document_id"
          />
        </label>
        <label>
          Text
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="search all fields"
          />
        </label>
      </div>
      <section
        className="traffic-scroller"
        ref={scroller}
        aria-label="Traffic log rows"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <table className="traffic-table">
          <thead>
            <tr>
              <th>timestamp</th>
              <th>direction</th>
              <th>operation</th>
              <th>sender</th>
              <th>recipients</th>
              <th>document_id</th>
              <th>envelope_kind</th>
              <th>message_id</th>
              <th>size</th>
              <th>result</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((event) => (
              <TrafficRows
                key={event.id}
                event={event}
                expanded={expanded === event.id}
                onToggle={() => setExpanded((value) => (value === event.id ? undefined : event.id))}
              />
            ))}
          </tbody>
        </table>
      </section>
    </section>
  )
}

function TrafficRows(props: {
  readonly event: InspectorEvent
  readonly expanded: boolean
  readonly onToggle: () => void
}) {
  const event = props.event
  return (
    <>
      <tr
        className="traffic-row"
        tabIndex={0}
        onClick={props.onToggle}
        onKeyDown={(keyEvent) => {
          if (keyEvent.key === 'Enter' || keyEvent.key === ' ') props.onToggle()
        }}
      >
        <td>{formatTime(event.timestamp)}</td>
        <td>{event.direction}</td>
        <td>{event.operation}</td>
        <td title={event.sender}>{short(event.sender)}</td>
        <td>{event.recipients?.map(short).join(', ') ?? '—'}</td>
        <td title={event.documentId}>{short(event.documentId)}</td>
        <td>{event.envelopeKind ?? '—'}</td>
        <td title={event.messageId}>{short(event.messageId)}</td>
        <td>{sizePair(event)}</td>
        <td className={event.result.startsWith('error') ? 'result-error' : 'result-ok'}>
          {event.result}
        </td>
      </tr>
      {props.expanded ? (
        <tr className="traffic-detail-row">
          <td colSpan={10}>
            <pre>{JSON.stringify(event, null, 2)}</pre>
          </td>
        </tr>
      ) : null}
    </>
  )
}

function Panel(props: {
  readonly title: string
  readonly subtitle?: string
  readonly children: React.ReactNode
}) {
  return (
    <section className="dashboard-panel">
      <header className="panel-heading">
        <strong>{props.title}</strong>
        {props.subtitle ? <small>{props.subtitle}</small> : null}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  )
}

function Readout({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="readout-row">
      <span>{label}</span>
      <code title={value}>{value}</code>
    </div>
  )
}

async function identityPublicReadout(identity: UserIdentity): Promise<IdentityReadout> {
  const [identityFingerprint, signedPrekeyFingerprint, identityRaw, signedPrekeyRaw] =
    await Promise.all([
      publicKeyFingerprint(identity.identityKeyPair.publicKey),
      publicKeyFingerprint(identity.signedPrekeyPair.publicKey),
      crypto.subtle.exportKey('raw', identity.identityKeyPair.publicKey),
      crypto.subtle.exportKey('raw', identity.signedPrekeyPair.publicKey)
    ])
  return {
    identityFingerprint,
    signedPrekeyFingerprint,
    identityPublicHex: bytesToHex(new Uint8Array(identityRaw)),
    signedPrekeyPublicHex: bytesToHex(new Uint8Array(signedPrekeyRaw))
  }
}

function short(value: string | undefined): string {
  if (!value) return '—'
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function sizePair(event: InspectorEvent): string {
  if (event.inputSizeBytes === undefined && event.outputSizeBytes === undefined) return '—'
  if (event.inputSizeBytes === event.outputSizeBytes || event.outputSizeBytes === undefined)
    return `${event.inputSizeBytes ?? event.outputSizeBytes} B`
  if (event.inputSizeBytes === undefined) return `${event.outputSizeBytes} B`
  return `${event.inputSizeBytes}→${event.outputSizeBytes} B`
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 23)
}

function formatOptionalTime(timestamp: number | undefined): string {
  return timestamp === undefined ? '—' : new Date(timestamp).toISOString()
}

function readMockSignalGroupMembers(
  transport: ObservableCollaborativeTransport | undefined
): readonly MockSignalGroupMember[] | undefined {
  if (!transport || !('getGroupMembers' in transport)) return undefined
  const candidate = transport as ObservableCollaborativeTransport & {
    getGroupMembers?: () => readonly MockSignalGroupMember[]
  }
  return typeof candidate.getGroupMembers === 'function' ? candidate.getGroupMembers() : undefined
}
