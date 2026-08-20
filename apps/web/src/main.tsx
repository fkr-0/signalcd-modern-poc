import {
  type CollaborativeTransport,
  DeterministicTransportNetwork,
  WebSocketTransport
} from '@e2e-col/transport'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserReplicaSession } from './session'
import './styles.css'

const network = new DeterministicTransportNetwork()
const documentId = '11111111-1111-4111-8111-111111111111'
const sidecarUrl = import.meta.env.VITE_E2E_COL_SIDECAR_URL as string | undefined

let transportSequence = 0

function createTransport(name: string): CollaborativeTransport {
  if (sidecarUrl) return new WebSocketTransport({ url: sidecarUrl })
  transportSequence += 1
  return network.createTransport(`${name}:${transportSequence}`)
}

function Replica({ name }: { name: string }) {
  const [text, setText] = useState('')
  const [connected, setConnected] = useState(false)
  const [session, setSession] = useState<BrowserReplicaSession>()

  useEffect(() => {
    let active = true
    let current: BrowserReplicaSession | undefined
    let unsubscribe: (() => void) | undefined
    const transport = createTransport(name)

    void BrowserReplicaSession.open({
      documentId,
      senderId: name,
      transport,
      storageName: `e2e-col-${name}`
    })
      .then((opened) => {
        if (!active) return void opened.close()
        current = opened
        unsubscribe = opened.subscribe(setText)
        setSession(opened)
        setConnected(true)
      })
      .catch(() => {
        if (active) setConnected(false)
        void transport.close()
      })

    return () => {
      active = false
      unsubscribe?.()
      if (current) void current.close()
      else void transport.close()
    }
  }, [name])

  return (
    <section className="replica">
      <header>
        <strong>{name}</strong>
        <span>{connected ? 'connected' : 'connecting'}</span>
      </header>
      <textarea
        value={text}
        onChange={(event) => void session?.editText(event.target.value)}
        disabled={!connected}
        placeholder="Edit either replica…"
      />
    </section>
  )
}

function App() {
  return (
    <main>
      <div className="intro">
        <p className="eyebrow">SignalCD modernization sketch</p>
        <h1>Encrypted transport, CRDT editor.</h1>
        <p>
          Both panes are independent, locally persisted Automerge replicas using the same typed
          protocol and transport contracts as the Signal sidecar.
        </p>
        <p className="eyebrow">
          transport: {sidecarUrl ? 'localhost sidecar' : 'deterministic local'}
        </p>
      </div>
      <div className="grid">
        <Replica name="Replica A" />
        <Replica name="Replica B" />
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
