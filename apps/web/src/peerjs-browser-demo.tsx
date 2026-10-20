import { CollaborativeDocument } from '@e2e-col/core'
import { PeerJsTransport } from '@e2e-col/transport'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { peerJsTransportOptions } from './peerjs-config'
import {
  type InspectorEntry,
  type PeerHealth,
  PeerJsNetworkInspector,
  type PeerMetrics
} from './peerjs-network-inspector'
import {
  decryptRoomPacket,
  encryptRoomPacket,
  newRoomInvitation,
  type RoomPacketKind
} from './peerjs-room-crypto'
import {
  decodePresence,
  encodePresence,
  freshObservedPeers,
  type ObservedPeer,
  PRESENCE_INTERVAL_MS,
  updateObservedPeers
} from './peerjs-room-presence'
import './peerjs-browser-demo.css'

const DB_NAME = 'signalcd-peerjs-browser-demo-v1'
const STORE_NAME = 'snapshots'
type Room = {
  document: CollaborativeDocument
  transport: PeerJsTransport
  key: CryptoKey
  save: () => Promise<void>
  requestSnapshot: () => void
}

interface Invitation {
  readonly documentId: string
  readonly secret: string
  readonly href: string
}

function currentInvitation(): Invitation {
  const params = new URLSearchParams(location.search)
  const fragment = new URLSearchParams(location.hash.slice(1))
  let documentId = params.get('document') ?? ''
  let secret = fragment.get('peerjs') ?? ''
  // A missing URL fragment is common when mobile browsers or link-opening apps
  // truncate invitations. NEVER silently generate a new room in that case.
  // Otherwise the user sees an apparently connected room with zero collaborators.
  const hasDocument = params.has('document')
  const hasSecret = fragment.has('peerjs')
  if (!hasDocument && !hasSecret) {
    const created = newRoomInvitation()
    documentId = created.documentId
    secret = created.secret
    const url = new URL(location.href)
    url.search = `?document=${encodeURIComponent(documentId)}`
    url.hash = `peerjs=${encodeURIComponent(secret)}`
    history.replaceState(null, '', url)
  } else if (
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(documentId) ||
    new TextEncoder().encode(secret).byteLength < 16
  ) {
    throw new Error(
      'Incomplete or invalid invitation. The full link must contain both ?document=<UUID> and #peerjs=<secret>. ' +
        'Some browsers or messaging applications strip the #peerjs= fragment; copy and paste the ENTIRE link.'
    )
  }
  return { documentId, secret, href: location.href }
}

function dbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
  })
}

async function snapshotRead(documentId: string): Promise<Uint8Array | undefined> {
  const db = await dbOpen()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(documentId)
      request.onsuccess = () =>
        resolve(request.result instanceof ArrayBuffer ? new Uint8Array(request.result) : undefined)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'))
    })
  } finally {
    db.close()
  }
}

async function snapshotWrite(documentId: string, frame: Uint8Array): Promise<void> {
  const db = await dbOpen()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(frame.buffer as ArrayBuffer, documentId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'))
    })
  } finally {
    db.close()
  }
}

function BrowserDemo() {
  const [parsed] = useState(() => {
    try {
      return { invitation: currentInvitation(), error: undefined }
    } catch (cause) {
      return {
        invitation: undefined,
        error: cause instanceof Error ? cause.message : 'Invalid invitation'
      }
    }
  })
  if (!parsed.invitation) {
    const fresh = new URL(window.location.href)
    fresh.search = ''
    fresh.hash = ''
    return (
      <main className="demo-shell">
        <h1>Cannot join this room</h1>
        <p className="demo-error" role="alert">
          {parsed.error}
        </p>
        <p>The invitation was not changed, so you can recover the correct URL from the sender.</p>
        <a href={fresh.href}>Create a different, new private document</a>
      </main>
    )
  }
  return <BrowserRoom invite={parsed.invitation} />
}

function BrowserRoom({ invite }: { readonly invite: Invitation }) {
  const [state, setState] = useState('Connecting…')
  const [text, setText] = useState('')
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [recovered, setRecovered] = useState(false)
  const [peerHealth, setPeerHealth] = useState<PeerHealth>()
  const [metrics, setMetrics] = useState<PeerMetrics>()
  const [observedPeers, setObservedPeers] = useState<ObservedPeer[]>([])
  const [events, setEvents] = useState<InspectorEntry[]>([])
  const [reconnectEpoch, setReconnectEpoch] = useState(0)
  const [reconnecting, setReconnecting] = useState(false)
  const anonymousClientId = useRef(crypto.randomUUID())
  const eventSequence = useRef(0)
  const lastPeerSnapshot = useRef('')
  const room = useRef<Room | undefined>(undefined)
  const sendQueue = useRef<Promise<void>>(Promise.resolve())

  // Never put plaintext, the capability fragment, or complete URLs in diagnostic logs.
  const record = useCallback(
    (level: InspectorEntry['level'], detail: string) => {
      const safe = detail
        .replace(/(?:#?peerjs=)[0-9a-f]+/giu, 'peerjs=<redacted>')
        .replaceAll(invite.secret, '<redacted>')
      setEvents((current) => [
        ...current.slice(-199),
        { seq: ++eventSequence.current, at: Date.now(), level, message: safe.slice(0, 260) }
      ])
    },
    [invite.secret]
  )

  useEffect(() => {
    const refresh = () => {
      const session = room.current
      const health = session?.transport.getLobbyHealth()
      if (health) {
        setPeerHealth(health)
        setMetrics(session?.transport.getMetrics())
        const key = [
          health.role,
          health.connectedPeers,
          health.queuedOutbound,
          health.pendingOutbound,
          health.dropped,
          health.lastError
        ].join('|')
        if (lastPeerSnapshot.current !== key) {
          if (lastPeerSnapshot.current) {
            if (health.lastError) record('warn', `PeerJS: ${health.lastError}`)
            else if (health.role === 'hub')
              record('info', `Hub has ${health.connectedPeers} active peer connections`)
          }
          lastPeerSnapshot.current = key
        }
      }
      setObservedPeers((current) => {
        const fresh = freshObservedPeers(current, Date.now())
        return fresh.length === current.length ? current : fresh
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 1500)
    return () => window.clearInterval(timer)
  }, [record])

  const retryConnection = useCallback(async () => {
    if (reconnecting) return
    setReconnecting(true)
    setError(undefined)
    record('info', 'Manual reconnect requested')
    const previous = room.current
    if (previous) {
      // Force a durable encrypted snapshot before disposing the old document.
      try {
        await previous.save()
      } catch (cause) {
        record('error', 'Reconnect aborted: failed to save the encrypted document locally')
        setError(cause instanceof Error ? cause.message : 'Unable to save before reconnect')
        setReconnecting(false)
        return
      }
      room.current = undefined
      try {
        await previous.transport.close()
      } catch {
        record('warn', 'Previous transport reported an error while closing')
      }
    }
    lastPeerSnapshot.current = ''
    setPeerHealth(undefined)
    setMetrics(undefined)
    setObservedPeers([])
    setRecovered(false)
    setReconnectEpoch((old) => old + 1)
    setReconnecting(false)
  }, [record, reconnecting])

  const requestSnapshot = useCallback(() => {
    const session = room.current
    if (session?.transport.getState() !== 'online') return
    session.requestSnapshot()
    record('info', 'Requested full encrypted document snapshot from connected peers')
  }, [record])

  const beforeRoomJoin = useCallback(async () => {
    const session = room.current
    if (session) await session.save()
    record('info', 'Stored encrypted document snapshot before switching rooms')
  }, [record])

  useEffect(() => {
    let active = true
    let transport: PeerJsTransport | undefined
    const unsubscribers: Array<() => void> = []
    let saveQueue = Promise.resolve()
    let presenceTimer: number | undefined
    const greeted = new Set<string>()
    record(
      'info',
      `Connecting to room ${invite.documentId.slice(0, 8)} (attempt ${reconnectEpoch + 1})`
    )
    setState('connecting')

    async function run() {
      const { documentId, secret } = invite
      if (!window.isSecureContext || !crypto?.subtle)
        throw new Error(
          'This browser needs HTTPS and WebCrypto SubtleCrypto for encrypted collaboration.'
        )
      if (typeof RTCPeerConnection === 'undefined')
        throw new Error('WebRTC is unavailable or blocked by this browser.')
      if (typeof indexedDB === 'undefined')
        throw new Error(
          'IndexedDB storage is disabled in this browser. Allow site storage to join.'
        )
      const key = await (async () => {
        const raw = await crypto.subtle.importKey(
          'raw',
          new TextEncoder().encode(secret),
          'HKDF',
          false,
          ['deriveKey']
        )
        return crypto.subtle.deriveKey(
          {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new TextEncoder().encode(`signalcd-room-salt-v1:${documentId}`),
            info: new TextEncoder().encode('signalcd-room-AES-GCM-v1')
          },
          raw,
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt']
        )
      })()
      const previous = await snapshotRead(documentId)
      let restored: Uint8Array | undefined
      if (previous) {
        let packet: Awaited<ReturnType<typeof decryptRoomPacket>>
        try {
          packet = await decryptRoomPacket(key, documentId, previous)
        } catch {
          throw new Error(
            'This browser already has an encrypted draft for the same document ID, but this link ' +
              'cannot decrypt it. Check that you pasted the COMPLETE original invitation, including #peerjs=. ' +
              'Your local data was left unchanged.'
          )
        }
        if (packet.kind !== 1) throw new Error('Stored snapshot has invalid format')
        restored = packet.payload
      }
      const document = new CollaborativeDocument(restored)
      if (!active) return

      const save = () => {
        const snapshot = document.save()
        saveQueue = saveQueue
          .catch(() => {})
          .then(async () => {
            const encrypted = await encryptRoomPacket(key, documentId, 1, snapshot)
            await snapshotWrite(documentId, encrypted)
          })
        return saveQueue
      }

      const options = peerJsTransportOptions(
        {
          VITE_E2E_COL_PEERJS_HOST: import.meta.env.VITE_E2E_COL_PEERJS_HOST,
          VITE_E2E_COL_PEERJS_PORT: import.meta.env.VITE_E2E_COL_PEERJS_PORT,
          VITE_E2E_COL_PEERJS_PATH: import.meta.env.VITE_E2E_COL_PEERJS_PATH,
          VITE_E2E_COL_PEERJS_KEY: import.meta.env.VITE_E2E_COL_PEERJS_KEY,
          VITE_E2E_COL_PEERJS_SECURE: import.meta.env.VITE_E2E_COL_PEERJS_SECURE
        },
        location.hash
      )
      transport = new PeerJsTransport({ ...options, namespace: 'scd-p2p' })
      setText(document.getText())
      record(
        'info',
        restored
          ? 'Recovered encrypted local Automerge snapshot'
          : 'Initialized an empty local document'
      )

      // Every frame is encrypted before reaching the PeerJS lobby.
      async function publish(kind: RoomPacketKind, payload: Uint8Array) {
        const ciphertext = await encryptRoomPacket(key, documentId, kind, payload)
        if (active) await transport!.send(ciphertext)
      }
      function queuePublish(kind: RoomPacketKind, payload: Uint8Array) {
        sendQueue.current = sendQueue.current.catch(() => {}).then(() => publish(kind, payload))
        void sendQueue.current.catch((cause: unknown) => {
          if (active) {
            record('error', `Outgoing ${kind === 4 ? 'presence' : 'document'} frame failed`)
            setError(cause instanceof Error ? cause.message : 'Send failed')
          }
        })
      }
      room.current = {
        document,
        transport,
        key,
        save,
        requestSnapshot: () => queuePublish(3, new Uint8Array())
      }

      presenceTimer = window.setInterval(() => {
        if (active && transport?.getState() === 'online')
          queuePublish(4, encodePresence(anonymousClientId.current))
      }, PRESENCE_INTERVAL_MS)

      unsubscribers.push(
        transport.subscribe((wire) => {
          void (async () => {
            const packet = await decryptRoomPacket(key, documentId, wire)
            if (!active) return
            if (packet.kind === 3) {
              record('info', 'A peer requested a complete document snapshot')
              queuePublish(1, document.save())
              return
            }
            if (packet.kind === 4) {
              const observedId = decodePresence(packet.payload)
              if (!observedId || observedId === anonymousClientId.current) return
              setObservedPeers((current) => updateObservedPeers(current, observedId, Date.now()))
              if (!greeted.has(observedId)) {
                greeted.add(observedId)
                record('info', `Observed anonymous peer ${observedId.slice(0, 8)}`)
                // Respond once so a late-joining client sees current participants
                // without needing to wait for the periodic heartbeat.
                queuePublish(4, encodePresence(anonymousClientId.current))
              }
              return
            }
            const changed =
              packet.kind === 1
                ? document.mergeSnapshot(packet.payload)
                : document.applyChanges([packet.payload])
            if (changed) {
              record(
                'info',
                packet.kind === 1
                  ? 'Merged remote encrypted snapshot'
                  : 'Applied remote encrypted edit'
              )
              setText(document.getText())
              await save()
            }
          })().catch((cause: unknown) => {
            if (active) {
              record('error', 'Rejected invalid or incompatible encrypted peer frame')
              setError(
                'Rejected invalid/incompatible peer message: ' +
                  (cause instanceof Error ? cause.message : 'unknown error')
              )
            }
          })
        })
      )
      unsubscribers.push(
        transport.subscribeState((event) => {
          if (!active) return
          setState(event.current)
          record(
            event.current === 'online' ? 'info' : 'warn',
            `Transport ${event.previous} → ${event.current}`
          )
          if (event.current === 'online') {
            queuePublish(4, encodePresence(anonymousClientId.current))
            queuePublish(1, document.save())
            queuePublish(3, new Uint8Array())
          }
        })
      )
      unsubscribers.push(
        transport.subscribeRecovery((event) => {
          if (!active) return
          setRecovered(true)
          record('warn', `Transport recovery: ${event.reason}`)
          if (event.reason === 'peerjs-checkpoint-request') queuePublish(1, document.save())
          else if (event.reason === 'peerjs-replay-gap') queuePublish(3, new Uint8Array())
        })
      )
      await transport.connect(documentId)
      if (active) record('info', 'PeerJS connected; waiting for application-level presence')
    }

    void run().catch((cause: unknown) => {
      if (active) {
        record('error', `Connection failed: ${cause instanceof Error ? cause.message : 'unknown'}`)
        setState('unavailable')
        setError(cause instanceof Error ? cause.message : 'Unable to start private room')
      }
    })
    return () => {
      active = false
      if (presenceTimer !== undefined) window.clearInterval(presenceTimer)
      room.current = undefined
      for (const unsubscribe of unsubscribers) unsubscribe()
      if (transport) void transport.close()
    }
  }, [invite, record, reconnectEpoch])

  function change(nextText: string) {
    const session = room.current
    if (!session) return
    try {
      const changes = session.document.editText(nextText)
      setText(session.document.getText())
      // Save the canonical CRDT state before sending; local edits survive reloads.
      void session
        .save()
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : 'Local save failed')
        )
      for (const change of changes) {
        sendQueue.current = sendQueue.current
          .catch(() => {})
          .then(async () => {
            const encrypted = await encryptRoomPacket(session.key, invite.documentId, 2, change)
            await session.transport.send(encrypted)
          })
      }
      void sendQueue.current.catch((cause: unknown) => {
        record('error', 'Failed to deliver an encrypted edit; local snapshot retained')
        setError(cause instanceof Error ? cause.message : 'Peer send failed; local draft retained')
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Edit failed')
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(invite.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2500)
    } catch {
      setError('Clipboard denied. Copy the full address bar URL, including #peerjs=.')
    }
  }

  return (
    <main className="demo-shell">
      <header className="demo-header">
        <div>
          <span className="demo-eyebrow">SignalCD / PeerJS browser prototype</span>
          <h1>Private collaborative draft</h1>
          <p>Automerge CRDT · AES-256-GCM · PeerJS/WebRTC · local-first</p>
        </div>
        <span className={`demo-status ${state === 'online' ? 'connected' : ''}`} role="status">
          PeerJS: {state}
        </span>
      </header>
      <section className="demo-diagnostics" aria-label="Connection diagnostics">
        <span>
          <strong>Room</strong> {peerHealth?.roomId.slice(0, 10) ?? 'connecting'}
        </span>
        <span>
          <strong>Role</strong> {peerHealth?.role ?? 'unknown'}
        </span>
        <span>
          <strong>Connected peers</strong>{' '}
          {peerHealth?.role === 'client' && state === 'online'
            ? 'connected to hub'
            : (peerHealth?.connectedPeers ?? 0)}
        </span>
        <span>
          <strong>Network</strong> {navigator.onLine ? 'browser online' : 'browser offline'}
        </span>
        {peerHealth?.lastError ? (
          <span className="demo-error" role="alert">
            PeerJS: {peerHealth.lastError}
          </span>
        ) : null}
        {state === 'online' && peerHealth?.role === 'hub' && peerHealth.connectedPeers === 0 ? (
          <p>
            Connected to PeerJS signaling, but no other browser is connected to this room yet. Every
            participant must open the same complete invitation link.
          </p>
        ) : null}
      </section>
      <section className="demo-invite">
        <div>
          <strong>Invitation link</strong>
          <p>
            Open in another browser or device to join this document. The secret after #peerjs= is
            the encryption key material: keep the complete link private.
          </p>
        </div>
        <button type="button" onClick={() => void copyInvite()}>
          {copied ? 'Copied!' : 'Copy invite link'}
        </button>
      </section>
      <label htmlFor="demo-editor">Shared document</label>
      <textarea
        id="demo-editor"
        aria-label="Shared document"
        value={text}
        onChange={(event) => change(event.target.value)}
        disabled={!room.current}
        placeholder="Start typing; changes sync end-to-end over WebRTC…"
        spellCheck={false}
      />
      <footer>
        <span>{text.length} characters</span>
        <span>{recovered ? 'Recovery exchange observed' : 'Encrypted local snapshot'}</span>
      </footer>
      {error ? (
        <p className="demo-error" role="alert">
          {error}
        </p>
      ) : null}
      <PeerJsNetworkInspector
        documentId={invite.documentId}
        selfId={anonymousClientId.current}
        transportState={state}
        health={peerHealth}
        metrics={metrics}
        peers={observedPeers}
        log={events}
        working={reconnecting}
        onRetry={retryConnection}
        onBeforeJoin={beforeRoomJoin}
        onResync={requestSnapshot}
        onClearLog={() => setEvents([])}
      />
      <aside className="demo-warning">
        <strong>Technical demonstration, not a production-secure editor.</strong>
        <p>
          Everyone with the invitation can read and edit. There are no authenticated participant
          identities, revocation, or role controls in this standalone room. PeerJS signalling may
          rely on a public service; WebRTC may need TURN for some network configurations. When every
          participant is offline, there is no third-party message mailbox. The full SignalCD PoC
          uses a separate identity and authorization service and is not the same security model.
        </p>
        <a href="/">SignalCD documentation</a>
      </aside>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<BrowserDemo />)
