# Architecture

## Paper-aligned composition

```text
strongly convergent reconciliation  +  E2EE asynchronous broadcast
              │                                   │
           Automerge                  Signal / MLS / future adapter
              └──────────────────┬────────────────┘
                                 ▼
                        collaborative document
```

This directly reflects the generic construction in the USENIX Security 2026
paper and keeps edit semantics independent from the cryptographic transport.

## Runtime components

```text
┌──────────────────────────────────────────────────────────┐
│ Vite / React browser                                    │
│                                                          │
│  Editor UI ──> BrowserReplicaSession ──> Automerge core   │
│                          │              ├─ protocol v1     │
│                          │              └─ IndexedDB       │
│                          ▼                                 │
│                  CollaborativeTransport                   │
└──────────────────────────┬───────────────────────────────┘
                           │
                      localhost API
                           │
┌──────────────────────────▼───────────────────────────────┐
│ Signal sidecar                                           │
│                                                          │
│  envelope validation + base64 Signal framing             │
│  dedup / chunking / bounded send retry                   │
│  signal-cli HTTP JSON-RPC + SSE receive stream           │
└──────────────────────────┬───────────────────────────────┘
                           │
                      Signal group
                           │
                     other replicas
```

## Frontend transport contract

```ts
export interface CollaborativeTransport {
  connect(documentId: string): Promise<void>
  send(update: Uint8Array): Promise<void>
  subscribe(listener: (update: Uint8Array) => void): () => void
  close(): Promise<void>
}
```

Implemented adapters:

1. deterministic/loopback transports for local development and fault testing;
2. `WebSocketTransport` for browser-to-sidecar communication;
3. Future encrypted broadcast transports without changing editor code.

## Suggested logical envelope

```yaml
version: 1
documentId: uuid
messageId: uuid
kind: automerge-change
createdAt: epoch-ms
payload: binary automerge change
```

Snapshots/checkpoints should use a distinct `kind` rather than overloading
incremental updates.

## Chosen trunk stack

```yaml
frontend:
  bundler: Vite
  language: TypeScript
  ui: React
  reconciliation: Automerge
  persistence: @e2e-col/storage IndexedDB adapter
sidecar:
  runtime: Node.js LTS
  language: TypeScript
  browser_transport: WebSocket
  signal_boundary: signal-cli daemon HTTP JSON-RPC + SSE event stream
protocol:
  encoding: compact binary envelope v1
  identifiers: UUID via crypto.randomUUID()
  validation: schema validation at trust boundaries
testing:
  unit: Vitest
  browser_e2e: Playwright
  property: shuffled/duplicated/delayed update delivery
  integration: fake broadcast plus real signal-cli smoke profile
```

Why this stack:

- Vite/React provides a mature browser toolchain without coupling the core to
  React.
- Automerge directly satisfies the strong-convergence requirement from the
  paper.
- Node is the lowest-friction boundary for `signal-cli` and binary WebSocket
  transport.
- the protocol remains transport-agnostic so Signal can later be replaced by
  MLS or another E2EE asynchronous broadcast backend.
