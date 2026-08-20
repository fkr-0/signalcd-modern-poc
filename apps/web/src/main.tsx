import {
  HttpIdentityProvider,
  IdentityClient,
  IndexedDbIdentityStorage,
  type UserIdentity
} from '@e2e-col/identity'
import {
  type CollaborativeTransport,
  DeterministicTransportNetwork,
  WebSocketTransport
} from '@e2e-col/transport'
import { type FormEvent, StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserReplicaSession } from './session'
import './styles.css'

const network = new DeterministicTransportNetwork()
const documentId = '11111111-1111-4111-8111-111111111111'
const sidecarUrl = import.meta.env.VITE_E2E_COL_SIDECAR_URL as string | undefined
const identityServerUrl =
  (import.meta.env.VITE_E2E_COL_IDENTITY_URL as string | undefined) ?? 'http://127.0.0.1:18080'

let transportSequence = 0

function createTransport(identity: UserIdentity): CollaborativeTransport {
  if (sidecarUrl) return new WebSocketTransport({ url: sidecarUrl })
  transportSequence += 1
  return network.createTransport(`${identity.userId}:${transportSequence}`)
}

function createIdentityClient(): IdentityClient {
  return new IdentityClient({
    provider: new HttpIdentityProvider({ baseUrl: identityServerUrl }),
    storage: new IndexedDbIdentityStorage({ name: 'e2e-col-identity' })
  })
}

function Registration({ onRegistered }: { onRegistered: (identity: UserIdentity) => void }) {
  const [displayName, setDisplayName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const clientRef = useRef<IdentityClient | undefined>(undefined)

  useEffect(() => {
    const client = createIdentityClient()
    clientRef.current = client
    return () => {
      clientRef.current = undefined
      void client.close()
    }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const client = clientRef.current
    if (!client || submitting) return
    setSubmitting(true)
    setError(undefined)
    try {
      onRegistered(await client.register(displayName))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Identity registration failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="shell shell-registration">
      <section className="hero" aria-labelledby="registration-title">
        <span className="product-mark" aria-hidden="true">
          EC
        </span>
        <p className="eyebrow">Local-first collaboration lab</p>
        <h1 id="registration-title">Create your local identity.</h1>
        <p className="lede">
          One browser profile, one collaboration identity. Your private keys are generated here and
          remain non-exportable; the toy service receives only public key material.
        </p>
      </section>

      <section className="registration-card" aria-label="Identity registration">
        <div>
          <p className="section-label">Start a private workspace</p>
          <h2>Choose a display name</h2>
          <p className="muted">
            The development identity service assigns a Signal-shaped phone number after your browser
            creates its keys.
          </p>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label htmlFor="display-name">Display name</label>
          <input
            id="display-name"
            name="display-name"
            autoComplete="nickname"
            minLength={1}
            maxLength={64}
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            placeholder="Ada"
          />
          {error ? <p className="error-message">{error}</p> : null}
          <button type="submit" disabled={submitting || displayName.trim().length === 0}>
            {submitting ? 'Creating identity…' : 'Create identity'}
          </button>
        </form>
        <div className="security-note">
          <span className="security-dot" aria-hidden="true" />
          <span>Ed25519 identity · X25519 prekeys · private keys stay in IndexedDB</span>
        </div>
      </section>
    </main>
  )
}

function Workspace({ identity }: { identity: UserIdentity }) {
  const [text, setText] = useState('')
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string>()
  const [session, setSession] = useState<BrowserReplicaSession>()
  const storageName = useMemo(() => `e2e-col-${identity.userId}`, [identity.userId])

  useEffect(() => {
    let active = true
    let current: BrowserReplicaSession | undefined
    let unsubscribe: (() => void) | undefined
    const transport = createTransport(identity)

    void BrowserReplicaSession.open({
      documentId,
      senderId: identity.userId,
      transport,
      storageName
    })
      .then((opened) => {
        if (!active) return void opened.close()
        current = opened
        setText(opened.getText())
        unsubscribe = opened.subscribe(setText)
        setSession(opened)
        setConnected(true)
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : 'Document session failed to open')
          setConnected(false)
        }
        void transport.close()
      })

    return () => {
      active = false
      unsubscribe?.()
      setSession(undefined)
      if (current) void current.close()
      else void transport.close()
    }
  }, [identity, storageName])

  return (
    <main className="shell workspace-shell">
      <header className="app-bar">
        <div className="brand-lockup">
          <span className="product-mark small" aria-hidden="true">
            EC
          </span>
          <div>
            <strong>e2e-col</strong>
            <span>collaboration PoC</span>
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
      </header>

      <section className="workspace-heading">
        <div>
          <p className="eyebrow">Private draft</p>
          <h1>Your encrypted workspace.</h1>
          <p className="muted">
            This browser owns one identity and one active editor session. A later backend swap
            changes transport configuration, not the editor contract.
          </p>
        </div>
        <div className={`status-pill ${connected ? 'online' : ''}`} role="status">
          <span aria-hidden="true" />
          {connected ? 'Ready' : error ? 'Offline' : 'Opening'}
        </div>
      </section>

      <section className="editor-card" aria-labelledby="editor-title">
        <header>
          <div>
            <p className="section-label">Document</p>
            <h2 id="editor-title">Untitled collaboration</h2>
          </div>
          <div className="transport-label">
            {sidecarUrl ? 'Signal sidecar' : 'Local deterministic transport'}
          </div>
        </header>
        <label className="sr-only" htmlFor="document-editor">
          Document text
        </label>
        <textarea
          id="document-editor"
          value={text}
          onChange={(event) => void session?.editText(event.target.value)}
          disabled={!connected}
          placeholder="Write something worth sharing…"
        />
        <footer>
          <span>Browser-owned keys</span>
          <span aria-hidden="true">·</span>
          <span>Local-first persistence</span>
          <span aria-hidden="true">·</span>
          <span>{text.length} chars</span>
        </footer>
      </section>

      {error ? <p className="error-banner">{error}</p> : null}
    </main>
  )
}

function App() {
  const [phase, setPhase] = useState<'loading' | 'registration' | 'workspace' | 'error'>('loading')
  const [identity, setIdentity] = useState<UserIdentity>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let active = true
    const client = createIdentityClient()
    void client
      .openSession()
      .then((loaded) => {
        if (!active) return
        if (loaded) {
          setIdentity(loaded)
          setPhase('workspace')
        } else {
          setPhase('registration')
        }
      })
      .catch((cause) => {
        if (!active) return
        setError(cause instanceof Error ? cause.message : 'Unable to restore local identity')
        setPhase('error')
      })
      .finally(() => void client.close())
    return () => {
      active = false
      void client.close()
    }
  }, [])

  if (phase === 'loading') {
    return (
      <main className="loading-shell" aria-live="polite">
        <span className="spinner" aria-hidden="true" />
        Restoring local identity…
      </main>
    )
  }
  if (phase === 'error') {
    return (
      <main className="loading-shell error-state">
        <strong>Identity session unavailable</strong>
        <span>{error}</span>
      </main>
    )
  }
  if (!identity) {
    return (
      <Registration
        onRegistered={(registered) => {
          setIdentity(registered)
          setPhase('workspace')
        }}
      />
    )
  }
  return <Workspace identity={identity} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
