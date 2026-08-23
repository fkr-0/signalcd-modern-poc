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
│  Editor UI ──> CollaborativeClient / DocumentSession     │
│                          │              ├─ Automerge core  │
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

## Offline-first status authority

`DocumentSession` is the application-facing source of synchronization state. Its
`SessionStatus` distinguishes transport connectivity, durable records that have never
yet been handed to the transport, checkpoint/snapshot recovery, and reconnect/restart
replay progress. The browser must not infer a contradictory connection state from a
separate `navigator.onLine` heuristic.

Replay progress is intentionally local: `completed / total` means the durable replay
batch reached the local transport adapter. It does not mean a peer acknowledged or
merged those records. The workspace combines that status with the existing access
projection; `authorizationStatus: conflict` is rendered as a fail-closed collaboration
conflict rather than inventing an Automerge conflict concept.

Offline edits follow the same atomic local persistence path as connected edits. A
transport disconnect therefore changes delivery state, not whether the editor can
persist an authorized local change. Reconnect/restart replay reuses the already-durable
outbound records and leaves authorization and deduplication semantics unchanged.

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

## Local document metadata authority

Editable display titles belong to the local library/storage layer, not to Automerge,
the protocol envelope, Signal routing, or authorization state. `documentId` is the
immutable collaboration identity; a rename changes only device-local presentation
metadata and is not expected to converge across devices.

The storage boundary enforces two-way isolation:

1. `updateDocumentMetadata()` atomically updates only the document record's local
   metadata and timestamp while preserving snapshot bytes and additive metadata;
2. CRDT/local and remote snapshot transactions preserve whatever metadata is already
   durable instead of accepting an open session's cached metadata as authority.

This second rule closes a race where a stale content write could otherwise undo a
successful rename. Metadata failures leave prior durable state intact and do not emit
CRDT, membership, lifecycle, authorization-resolution, or transport traffic.

Group/document binding is equally independent: a group-bound workspace remains pinned
to its bound UUID. Local rename of that UUID is allowed, but the UI disables creation,
switching, and rename actions that could target an unrelated local document while the
group binding is active.

## Identity and prekey lifecycle

The browser owns all private identity material. The long-term Ed25519 identity key is
the authorization identity and remains stable; signed and one-time X25519 prekeys are
transport key material that may rotate without changing that identity. Session open
is the maintenance boundary: the provider reports its advertised signed prekey,
whether rotation is due, and the remaining one-time-prekey pool.

Rotation is durable-before-publication. A new signed prekey is persisted as pending,
then its public half is signed by the unchanged Ed25519 key and published. Only an
exact provider acknowledgement promotes it to current; the old private pair is kept
as retired material so delayed encrypted envelopes can still resolve their existing
recipient-key selector. One-time replenishment similarly persists new private pairs
before upload and marks them published only after provider acceptance. Interrupted
publication retries the staged material rather than replacing it.

A provider-advertised signed prekey that matches neither durable current nor pending
material fails closed. The same rule applies at the authorization layer to the
Ed25519 identity itself: directory replacement is not a valid rotation mechanism.
R6 roots, membership invites, controls, and fork approvals commit to that key, so a
future identity-key rotation requires an explicit authenticated rebind and
re-verification transition rather than silent key substitution. The outer
`ProtocolEnvelope` remains v1 throughout this prekey lifecycle.

## Authorization ordering and replay safety

CRDT causality and authorization causality are separate. Document edits continue to
converge through Automerge and do not receive a global access-control sequence.
Membership/archive/delete controls carry an inner replay-safe proof. Ordinary
controls use payload v2; authenticated membership invites use v3 so the target
identity-key commitment is signed as part of the invite:

```yaml
documentId: document UUID
revision: predecessor revision + 1
predecessor: 32-byte authorization commitment
actorUserId: signing identity
signature: Ed25519 over domain-separated v2 control fields
```

The authorization commitment is SHA-256 over the canonical signing preimage. The
client persists the current head, accepted history/resulting ACL states, future
pending controls, and fork evidence alongside access state. That durable metadata
is independent of the bounded seen-message ledger, so dedup expiry cannot make old
authenticated control history authoritative again.

Receive policy is causal and fail-closed:

1. verify actor/sender binding and signature;
2. bind the control to the current document;
3. locate the signed predecessor state and verify `revision = parent + 1`;
4. verify that the actor was an active admin at that predecessor;
5. apply only if the predecessor is the current authorization head;
6. durably buffer a valid future descendant whose predecessor is not known yet;
7. if two valid controls share one predecessor/revision, freeze at that common
   predecessor and record deterministic conflict evidence instead of choosing by
   arrival order.

`ProtocolEnvelope.sequence` is intentionally excluded from this model: it is
optional, sender-session-local/resettable, and spans edits, snapshots, and controls.
Snapshots therefore repair CRDT state only; they cannot reset or weaken the durable
authorization head. CRDT-only checkpoint compaction likewise does not remove the
authorization history needed for replay rejection.

R6 adds a cryptographic bootstrap anchor above that causal chain. Authorization-root
v1 is creator-signed and commits to the document, creator, sorted initial participant
role/active state, and each participant's authenticated Ed25519 identity-key
commitment. The web flow creates a creator-only root only as a consequence of an
explicit local `createDocument()` operation. A group-bound `openDocument()` cannot
mint a root from `created_by`, plaintext membership, or an empty evidence cache;
those fields are routing/discovery metadata only. Each later participant enters
through a signed membership-v3 invite. A fresh replica verifies the root and
identity-key bindings before installing authority, and a late joiner replays
root/control/resolution evidence to the supplied head. An established replica never
lets bootstrap metadata overwrite its durable root/head and may republish its pinned
root/head to heal an empty cache. CRDT bootstrap remains separate.

Fork resolution is also authorization-causal rather than transport-causal. A valid
same-predecessor fork stays frozen until an authorization-resolution v1 proof binds
the common predecessor, exact competing control commitments, deterministic resulting
ACL commitment, and next revision. The exact set of active admins at the pre-fork
state must approve, with at least two independent admins; each approval is checked
against the identity key committed by the verified authority state. Delete branches
take deterministic precedence, otherwise the canonical control commitment decides.
A single-admin fork therefore remains permanently fail-closed rather than choosing a
server/arrival winner. Resolution evidence can be durably buffered before branch
evidence and survives IndexedDB restart plus seen-message TTL expiry.

The toy group authorization endpoint is an untrusted evidence cache, not an ACL
server. It stores opaque signed root/control/resolution bytes and root/head hints but
no private identity key. It may censor or replay an older valid prefix to a brand-new
device unless an external freshness/transparency mechanism pins a newer head; it
cannot forge proof or roll back an established durable replica. First-contact trust
likewise assumes authenticated identity-key material. Those deployment trust limits
are distinct from R6's completed cross-device authorization proof and from R5's
separately unavailable real-Signal evidence.

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
