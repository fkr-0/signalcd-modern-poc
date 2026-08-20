import {
  HttpIdentityProvider,
  IdentityClient,
  IndexedDbIdentityStorage,
  type UserIdentity
} from '@e2e-col/identity'
import { type FormEvent, StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CollaborativeWorkspace } from './CollaborativeWorkspace'
import './styles.css'

const identityServerUrl =
  (import.meta.env.VITE_E2E_COL_IDENTITY_URL as string | undefined) ?? 'http://127.0.0.1:18080'
const configuredTransport = import.meta.env.VITE_E2E_COL_TRANSPORT as string | undefined

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
  return <CollaborativeWorkspace identity={identity} configuredTransport={configuredTransport} />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
