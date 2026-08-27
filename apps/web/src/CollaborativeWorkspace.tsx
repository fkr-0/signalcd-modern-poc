import {
  CollaborativeClient,
  type DocumentSession,
  type DocumentSessionEvent,
  type DocumentSummary,
  MAX_DOCUMENT_TITLE_LENGTH,
  type SessionStatus,
  type SyncMode
} from '@e2e-col/client'
import {
  HttpIdentityProvider,
  IdentityClient,
  IndexedDbIdentityStorage,
  SyncLogClient,
  type UserIdentity
} from '@e2e-col/identity'
import type { DocumentAccessState, DocumentRole } from '@e2e-col/protocol'
import { IndexedDbCollaborativeStorage } from '@e2e-col/storage'
import {
  createTransportFactory,
  type ObservableCollaborativeTransport,
  type TransportFactory
} from '@e2e-col/transport'
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addGroupMember, createBrowserIdentityAdapter } from './client-adapter'
import { Dashboard } from './Dashboard'
import { InspectorEventStore, instrumentTransportFactory } from './inspector-events'
import { syncPresentation } from './offline-status'
import { peerJsTransportOptions } from './peerjs-config'
import { SyncLogPanel } from './SyncLogPanel'

const defaultDocumentId = '11111111-1111-4111-8111-111111111111'
const sidecarUrl = import.meta.env.VITE_E2E_COL_SIDECAR_URL as string | undefined
const identityServerUrl =
  (import.meta.env.VITE_E2E_COL_IDENTITY_URL as string | undefined) ?? 'http://127.0.0.1:18080'
const mockSignalUrl =
  (import.meta.env.VITE_E2E_COL_MOCK_SIGNAL_URL as string | undefined) ??
  'ws://127.0.0.1:18080/api/v1/messages'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface WorkspaceBinding {
  readonly documentId: string
  readonly groupId?: string
}

export function CollaborativeWorkspace({
  identity,
  configuredTransport
}: {
  readonly identity: UserIdentity
  readonly configuredTransport?: string | undefined
}) {
  const binding = useMemo(workspaceBinding, [])
  const inspector = useMemo(() => new InspectorEventStore(), [])
  const clientRef = useRef<CollaborativeClient | undefined>(undefined)
  const sessionUnsubscribeRef = useRef<(() => void) | undefined>(undefined)
  const [session, setSession] = useState<DocumentSession>()
  const [documents, setDocuments] = useState<readonly DocumentSummary[]>([])
  const [text, setText] = useState('')
  const [status, setStatus] = useState<SessionStatus>()
  const [access, setAccess] = useState<DocumentAccessState>()
  const [syncMode, setSyncModeState] = useState<SyncMode>('auto')
  const [error, setError] = useState<string>()
  const [syncLogVisible, setSyncLogVisible] = useState(false)
  const [dashboardVisible, setDashboardVisible] = useState(false)
  const [shareVisible, setShareVisible] = useState(false)
  const [sharePhone, setSharePhone] = useState('')
  const [shareRole, setShareRole] = useState<DocumentRole>('writer')
  const [sharing, setSharing] = useState(false)
  const [renameDocument, setRenameDocument] = useState<DocumentSummary>()
  const [renameTitle, setRenameTitle] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [dashboardTransport, setDashboardTransport] = useState<ObservableCollaborativeTransport>()
  const syncLogClient = useMemo(() => new SyncLogClient({ baseUrl: identityServerUrl }), [])

  const showError = useCallback((cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : 'Collaboration operation failed')
  }, [])

  const handleSessionEvent = useCallback((event: DocumentSessionEvent): void => {
    if (event.type === 'document') setText(event.view.text)
    else if (event.type === 'status') setStatus(event.status)
    else if (event.type === 'access') setAccess(event.access)
    else {
      const cause = event.error.cause
      setError(
        cause instanceof Error ? `${event.error.message}: ${cause.message}` : event.error.message
      )
    }
  }, [])

  const refreshDocuments = useCallback(async (client?: CollaborativeClient): Promise<void> => {
    const target = client ?? clientRef.current
    if (!target) return
    setDocuments(await target.listDocuments())
  }, [])

  const attachSession = useCallback(
    (next: DocumentSession): void => {
      sessionUnsubscribeRef.current?.()
      setSession(next)
      setText(next.getView().text)
      setStatus(next.getStatus())
      setAccess(next.getAccessState())
      const storedMode = readSyncMode(next.documentId)
      next.setSyncMode(storedMode)
      setSyncModeState(storedMode)
      sessionUnsubscribeRef.current = next.subscribe(handleSessionEvent)
      if (!binding.groupId) {
        const url = new URL(window.location.href)
        url.searchParams.set('document', next.documentId)
        window.history.replaceState(null, '', url)
      }
    },
    [handleSessionEvent, binding.groupId]
  )

  useEffect(() => {
    let active = true
    const identityClient = createIdentityClient()
    const storage = new IndexedDbCollaborativeStorage({ name: `e2e-col-${identity.userId}` })
    const browserTransportFactory = createBrowserTransportFactory(
      identity,
      binding.groupId,
      configuredTransport
    )
    const transportFactory = instrumentTransportFactory((context) => {
      const transport = browserTransportFactory(context)
      if (active) setDashboardTransport(transport)
      return transport
    }, inspector)
    const identityAdapter = createBrowserIdentityAdapter({
      identity,
      identityClient,
      baseUrl: identityServerUrl,
      inspector,
      ...(binding.groupId === undefined ? {} : { groupId: binding.groupId })
    })
    const client = new CollaborativeClient({
      senderId: identity.userId,
      storage,
      transportFactory,
      identity: identityAdapter
    })
    clientRef.current = client

    void client
      .openDocument(binding.documentId)
      .then(async (opened) => {
        if (!active) return opened.close()
        attachSession(opened)
        await refreshDocuments(client)
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Document session failed to open')
      })

    return () => {
      active = false
      sessionUnsubscribeRef.current?.()
      sessionUnsubscribeRef.current = undefined
      clientRef.current = undefined
      setDashboardTransport(undefined)
      void client.close().finally(() => identityClient.close())
    }
  }, [
    binding.documentId,
    binding.groupId,
    identity,
    configuredTransport,
    inspector,
    attachSession,
    refreshDocuments
  ])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setSyncLogVisible((visible) => !visible)
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
        event.preventDefault()
        if (session?.getSyncMode() === 'manual') void session.flush().catch(showError)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [session, showError])

  async function openDocument(documentId: string): Promise<void> {
    const client = clientRef.current
    if (!client) return
    setError(undefined)
    try {
      attachSession(await client.openDocument(documentId))
    } catch (cause) {
      showError(cause)
    }
  }

  function beginRename(document: DocumentSummary): void {
    const unavailable = Boolean(binding.groupId && document.documentId !== binding.documentId)
    if (unavailable) return
    setError(undefined)
    setRenameDocument(document)
    setRenameTitle(document.title ?? '')
  }

  async function rename(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const client = clientRef.current
    if (!client || !renameDocument || renaming) return
    setRenaming(true)
    setError(undefined)
    try {
      await client.updateDocumentMetadata(renameDocument.documentId, { title: renameTitle })
      await refreshDocuments(client)
      setRenameDocument(undefined)
      setRenameTitle('')
    } catch (cause) {
      showError(cause)
    } finally {
      setRenaming(false)
    }
  }

  async function toggleArchive(): Promise<void> {
    if (!session || !access || access.deleted) return
    setError(undefined)
    try {
      if (access.archived) await session.unarchive()
      else await session.archive()
      await refreshDocuments()
    } catch (cause) {
      showError(cause)
    }
  }

  async function createDocument(): Promise<void> {
    const client = clientRef.current
    if (!client || binding.groupId) return
    setError(undefined)
    try {
      const opened = await client.createDocument()
      attachSession(opened)
      await refreshDocuments(client)
    } catch (cause) {
      showError(cause)
    }
  }

  async function edit(nextText: string): Promise<void> {
    if (!session) return
    const inputSizeBytes = new TextEncoder().encode(text).byteLength
    const outputSizeBytes = new TextEncoder().encode(nextText).byteLength
    const eventCountBeforeEdit = inspector.events().length
    try {
      await session.editText(nextText)
      const emittedEnvelope = inspector
        .events()
        .slice(eventCountBeforeEdit)
        .find(
          (event) =>
            event.direction === 'outbound' &&
            event.operation === 'envelope' &&
            event.documentId === session.documentId
        )
      inspector.append({
        direction: 'outbound',
        operation: 'crdt_change',
        sender: identity.phoneNumber,
        documentId: session.documentId,
        ...(emittedEnvelope?.messageId === undefined
          ? {}
          : { messageId: emittedEnvelope.messageId }),
        inputSizeBytes,
        outputSizeBytes,
        result: 'ok',
        detail: {
          measurement:
            'document UTF-8 size before/after edit; encoded Automerge change bytes are not exposed'
        }
      })
      await refreshDocuments()
    } catch (cause) {
      inspector.append({
        direction: 'outbound',
        operation: 'crdt_change',
        sender: identity.phoneNumber,
        documentId: session.documentId,
        inputSizeBytes,
        outputSizeBytes,
        result: `error: ${cause instanceof Error ? cause.message : 'edit failed'}`
      })
      showError(cause)
    }
  }

  function setSyncMode(mode: SyncMode): void {
    if (!session) return
    session.setSyncMode(mode)
    localStorage.setItem(syncModeKey(session.documentId), mode)
    setSyncModeState(mode)
  }

  async function flush(): Promise<void> {
    if (!session) return
    try {
      await session.flush()
    } catch (cause) {
      showError(cause)
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!session || !binding.groupId || sharing) return
    setSharing(true)
    setError(undefined)
    try {
      await addGroupMember({
        baseUrl: identityServerUrl,
        groupId: binding.groupId,
        identity,
        phoneNumber: sharePhone.trim(),
        role: shareRole
      })
      await session.inviteParticipant(sharePhone.trim(), shareRole)
      setSharePhone('')
      setShareVisible(false)
      await refreshDocuments()
    } catch (cause) {
      showError(cause)
    } finally {
      setSharing(false)
    }
  }

  const canEdit = Boolean(
    session &&
      access &&
      !access.archived &&
      !access.deleted &&
      (access.selfRole === 'writer' || access.selfRole === 'admin') &&
      status?.phase !== 'closed'
  )
  const canShare = Boolean(binding.groupId && access?.selfRole === 'admin' && !access.deleted)
  const canManageLifecycle = Boolean(
    binding.groupId && access?.selfRole === 'admin' && !access.deleted
  )
  const transportLabel = transportDescription(binding.groupId, configuredTransport)
  const currentDocument = documents.find((document) => document.documentId === session?.documentId)
  const syncState = syncPresentation(status, access)

  if (dashboardVisible) {
    return (
      <Dashboard
        identity={identity}
        identityServerUrl={identityServerUrl}
        documentId={session?.documentId ?? binding.documentId}
        {...(binding.groupId === undefined ? {} : { groupId: binding.groupId })}
        {...(access === undefined ? {} : { access })}
        {...(status === undefined ? {} : { status })}
        transportLabel={transportLabel}
        {...(dashboardTransport === undefined ? {} : { transport: dashboardTransport })}
        inspector={inspector}
        syncLogClient={syncLogClient}
        onShowWorkspace={() => setDashboardVisible(false)}
      />
    )
  }

  return (
    <main className="shell workspace-shell">
      <header className="app-bar">
        <div className="brand-lockup">
          <span className="product-mark small" aria-hidden="true">
            EC
          </span>
          <div>
            <strong>SignalCD Modern PoC</strong>
            <span>independent E2EE-CD research implementation</span>
          </div>
        </div>
        <fieldset className="identity-chip" aria-label="Current identity">
          <span className="avatar" aria-hidden="true">
            {identity.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span>
            <strong>{identity.displayName}</strong>
            <small data-testid="identity-phone">{identity.phoneNumber}</small>
          </span>
        </fieldset>
        <button
          type="button"
          className="secondary-button compact-button"
          onClick={() => setDashboardVisible(true)}
        >
          Dashboard
        </button>
      </header>

      <section className="workspace-heading compact-heading">
        <div>
          <p className="eyebrow">Private drafts</p>
          <h1>Your encrypted workspace.</h1>
          <p className="muted">
            Documents stay local-first while each open session owns its transport, durable queue,
            access state, and sync mode.
          </p>
        </div>
        <div
          className={`status-pill ${status?.transport === 'online' ? 'online' : ''}`}
          role="status"
        >
          <span aria-hidden="true" />
          {status?.phase ?? 'Opening'} · {status?.transport ?? 'disconnected'}
        </div>
      </section>

      <section className="workspace-grid">
        <aside className="document-list" aria-label="Documents">
          <header>
            <div>
              <p className="section-label">Documents</p>
              <h2>Local library</h2>
            </div>
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={() => void createDocument()}
              disabled={Boolean(binding.groupId)}
            >
              New
            </button>
          </header>
          {documents.length === 0 ? (
            <p className="muted empty-list">No saved documents yet.</p>
          ) : null}
          <nav>
            {documents.map((document) => {
              const isCurrent = document.documentId === session?.documentId
              const unavailable = Boolean(
                binding.groupId && document.documentId !== binding.documentId
              )
              const displayTitle = document.title ?? `Document ${document.documentId.slice(0, 8)}`
              return (
                <div
                  key={document.documentId}
                  className={`document-entry ${isCurrent ? 'active' : ''}`}
                >
                  <button
                    type="button"
                    className="document-row"
                    aria-current={isCurrent ? 'page' : undefined}
                    disabled={unavailable}
                    onClick={() => void openDocument(document.documentId)}
                  >
                    <strong>{displayTitle}</strong>
                    <small>
                      {document.archived
                        ? 'Archived'
                        : new Date(document.updatedAt).toLocaleString()}
                    </small>
                  </button>
                  <button
                    type="button"
                    className="document-rename secondary-button"
                    aria-label={`Rename ${displayTitle}`}
                    disabled={unavailable}
                    onClick={() => beginRename(document)}
                  >
                    Rename
                  </button>
                </div>
              )
            })}
          </nav>
        </aside>

        <section className="editor-card" aria-labelledby="editor-title">
          <header className="editor-toolbar">
            <div>
              <p className="section-label">Document</p>
              <h2 id="editor-title">
                {session
                  ? (currentDocument?.title ?? `Document ${session.documentId.slice(0, 8)}`)
                  : 'Opening document'}
              </h2>
              {session ? <small className="document-id">{session.documentId}</small> : null}
            </div>
            <div className="toolbar-actions">
              <span className={`role-badge role-${access?.selfRole ?? 'reader'}`}>
                {access?.selfRole ?? 'reader'}
              </span>
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={!canShare}
                onClick={() => setShareVisible(true)}
              >
                Share
              </button>
              <button
                type="button"
                className="secondary-button compact-button"
                disabled={!canManageLifecycle}
                onClick={() => void toggleArchive()}
              >
                {access?.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button
                type="button"
                className="secondary-button compact-button"
                aria-pressed={syncLogVisible}
                title="Toggle sync log (Ctrl+Shift+L)"
                onClick={() => setSyncLogVisible((visible) => !visible)}
              >
                Log
              </button>
            </div>
          </header>

          <fieldset className="sync-controls">
            <span>{transportLabel}</span>
            <label className="sync-mode-toggle">
              <span>Sync mode</span>
              <select
                value={syncMode}
                onChange={(event) => setSyncMode(event.target.value as SyncMode)}
              >
                <option value="auto">Auto</option>
                <option value="manual">Manual</option>
              </select>
            </label>
            <span className="pending-count" data-testid="pending-outbound">
              {status?.pendingOutbound ?? 0} pending
            </span>
            {syncMode === 'manual' ? (
              <button
                type="button"
                className="compact-button"
                onClick={() => void flush()}
                disabled={!session || (status?.pendingOutbound ?? 0) === 0}
              >
                Sync now
              </button>
            ) : null}
          </fieldset>

          <div
            className={`sync-state sync-state-${syncState.tone}`}
            data-testid="sync-state"
            aria-live="polite"
          >
            <strong>{syncState.label}</strong>
            <span>{syncState.detail}</span>
          </div>

          <label className="sr-only" htmlFor="document-editor">
            Document text
          </label>
          <textarea
            id="document-editor"
            value={text}
            onChange={(event) => void edit(event.target.value)}
            disabled={!canEdit}
            placeholder={
              access?.selfRole === 'reader'
                ? 'You have read-only access.'
                : 'Write something worth sharing…'
            }
          />
          <footer>
            <span>Browser-owned keys</span>
            <span aria-hidden="true">·</span>
            <span>
              {access?.participants.filter((participant) => participant.active).length ?? 1}{' '}
              participants
            </span>
            <span aria-hidden="true">·</span>
            <span>{text.length} chars</span>
          </footer>
        </section>
      </section>

      {shareVisible && session ? (
        <div
          className="dialog-backdrop"
          role="dialog"
          aria-modal="false"
          onClick={(event) => {
            if (event.currentTarget === event.target) setShareVisible(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setShareVisible(false)
          }}
        >
          <section
            className="share-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-title"
          >
            <header>
              <div>
                <p className="section-label">Access control</p>
                <h2 id="share-title">Invite participant</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close share dialog"
                onClick={() => setShareVisible(false)}
              >
                ×
              </button>
            </header>
            <form onSubmit={(event) => void invite(event)}>
              <label htmlFor="invite-phone">Phone number</label>
              <input
                id="invite-phone"
                type="tel"
                required
                pattern="\+[1-9][0-9]{7,14}"
                value={sharePhone}
                onChange={(event) => setSharePhone(event.target.value)}
                placeholder="+15550000002"
              />
              <label htmlFor="invite-role">Role</label>
              <select
                id="invite-role"
                value={shareRole}
                onChange={(event) => setShareRole(event.target.value as DocumentRole)}
              >
                <option value="reader">Reader</option>
                <option value="writer">Writer</option>
                <option value="admin">Admin</option>
              </select>
              <button type="submit" disabled={sharing}>
                {sharing ? 'Inviting…' : 'Invite'}
              </button>
            </form>
            <div className="participant-list">
              <p className="section-label">Participants</p>
              {access?.participants.map((participant) => (
                <div
                  key={participant.participantId}
                  className={!participant.active ? 'inactive' : ''}
                >
                  <span>
                    <strong>
                      {participant.displayName ?? participant.participantId.slice(0, 8)}
                    </strong>
                    <small>{participant.active ? 'Active' : 'Removed'}</small>
                  </span>
                  <span className={`role-badge role-${participant.role}`}>{participant.role}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      {renameDocument ? (
        <div
          className="dialog-backdrop"
          role="dialog"
          aria-modal="false"
          onClick={(event) => {
            if (event.currentTarget === event.target && !renaming) setRenameDocument(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !renaming) setRenameDocument(undefined)
          }}
        >
          <section
            className="share-dialog rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="rename-title"
            aria-describedby="rename-local-note"
          >
            <header>
              <div>
                <p className="section-label">Local metadata</p>
                <h2 id="rename-title">Rename document</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close rename dialog"
                disabled={renaming}
                onClick={() => setRenameDocument(undefined)}
              >
                ×
              </button>
            </header>
            <p id="rename-local-note" className="muted metadata-note">
              This title is stored only on this browser/device. It does not change the document ID,
              collaboration group, content, or the title seen by other devices.
            </p>
            <form onSubmit={(event) => void rename(event)}>
              <label htmlFor="document-title">Document title</label>
              <input
                id="document-title"
                value={renameTitle}
                maxLength={MAX_DOCUMENT_TITLE_LENGTH}
                onChange={(event) => setRenameTitle(event.target.value)}
                placeholder={`Document ${renameDocument.documentId.slice(0, 8)}`}
              />
              <div className="dialog-actions">
                <button
                  type="button"
                  className="secondary-button compact-button"
                  disabled={renaming}
                  onClick={() => setRenameDocument(undefined)}
                >
                  Cancel
                </button>
                <button type="submit" className="compact-button" disabled={renaming}>
                  {renaming ? 'Saving…' : 'Save title'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {syncLogVisible ? <SyncLogPanel client={syncLogClient} /> : null}
      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  )
}

function createIdentityClient(): IdentityClient {
  return new IdentityClient({
    provider: new HttpIdentityProvider({ baseUrl: identityServerUrl }),
    storage: new IndexedDbIdentityStorage({ name: 'e2e-col-identity' })
  })
}

function createBrowserTransportFactory(
  identity: UserIdentity,
  groupId: string | undefined,
  configuredTransport: string | undefined
): TransportFactory {
  const type = resolveTransportType(groupId, configuredTransport)
  if (type === 'deterministic') return createTransportFactory({ type: 'deterministic' })
  if (type === 'peerjs') {
    if (!groupId)
      throw new Error(
        'peerjs transport requires a group query parameter for encrypted collaboration'
      )
    return createTransportFactory({
      type: 'peerjs',
      peerjs: {
        ...peerJsTransportOptions(
          {
            VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET: import.meta.env
              .VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET,
            VITE_E2E_COL_PEERJS_HOST: import.meta.env.VITE_E2E_COL_PEERJS_HOST,
            VITE_E2E_COL_PEERJS_PORT: import.meta.env.VITE_E2E_COL_PEERJS_PORT,
            VITE_E2E_COL_PEERJS_PATH: import.meta.env.VITE_E2E_COL_PEERJS_PATH,
            VITE_E2E_COL_PEERJS_KEY: import.meta.env.VITE_E2E_COL_PEERJS_KEY,
            VITE_E2E_COL_PEERJS_SECURE: import.meta.env.VITE_E2E_COL_PEERJS_SECURE
          },
          window.location.hash
        ),
        recipientPhoneNumber: identity.phoneNumber
      }
    })
  }
  if (type === 'websocket') {
    if (!sidecarUrl) throw new Error('VITE_E2E_COL_SIDECAR_URL is required for websocket transport')
    return createTransportFactory({ type: 'websocket', websocket: { url: sidecarUrl } })
  }
  if (!groupId) throw new Error('mock transport requires a group query parameter')
  return createTransportFactory({
    type: 'mock',
    mock: {
      serverUrl: mockSignalUrl,
      resolveRuntime: () => ({
        authToken: identity.sessionToken,
        groupId,
        userId: identity.userId,
        phoneNumber: identity.phoneNumber
      })
    }
  })
}

function workspaceBinding(): WorkspaceBinding {
  const params = new URLSearchParams(window.location.search)
  const documentId = params.get('document') ?? defaultDocumentId
  const groupId = params.get('group') ?? undefined
  if (!UUID_RE.test(documentId)) throw new Error('document query parameter must be a UUID')
  if (groupId !== undefined && !UUID_RE.test(groupId))
    throw new Error('group query parameter must be a UUID')
  return { documentId, ...(groupId === undefined ? {} : { groupId }) }
}

function resolveTransportType(
  groupId: string | undefined,
  configuredTransport: string | undefined
): 'deterministic' | 'mock' | 'peerjs' | 'websocket' {
  // PeerJS is an encrypted group collaboration backend. Before a document is
  // group-bound (identity setup/local library), keep the established local
  // deterministic transport instead of opening an unauthenticated lobby.
  if (configuredTransport === 'peerjs') return groupId ? 'peerjs' : 'deterministic'
  if (
    configuredTransport === 'deterministic' ||
    configuredTransport === 'mock' ||
    configuredTransport === 'websocket'
  )
    return configuredTransport
  if (configuredTransport !== undefined && configuredTransport !== '')
    throw new Error(`Unsupported VITE_E2E_COL_TRANSPORT value: ${configuredTransport}`)
  return groupId ? 'mock' : sidecarUrl ? 'websocket' : 'deterministic'
}

function transportDescription(
  groupId: string | undefined,
  configuredTransport: string | undefined
): string {
  const type = resolveTransportType(groupId, configuredTransport)
  if (type === 'mock') return 'Encrypted mock Signal group'
  if (type === 'peerjs') return 'Encrypted PeerJS Signal-semantics demo'
  if (type === 'websocket') return 'Signal sidecar'
  return 'Local deterministic transport'
}

function syncModeKey(documentId: string): string {
  return `e2e-col-sync-mode-${documentId}`
}

function readSyncMode(documentId: string): SyncMode {
  return localStorage.getItem(syncModeKey(documentId)) === 'manual' ? 'manual' : 'auto'
}
