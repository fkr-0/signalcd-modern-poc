# Roadmap design specification

## 1. Purpose

`e2e-col` should evolve from a research reproduction into a modern reference
implementation of end-to-end encrypted collaborative documents. The design
follows the USENIX Security 2026 construction directly: combine a strongly
convergent reconciliation mechanism with an end-to-end encrypted asynchronous
broadcast channel, while keeping the helper infrastructure untrusted with
respect to plaintext document state.

The implementation should therefore optimize for four properties:

1. client-side convergence independent of message ordering;
2. strict separation between editor state and transport credentials;
3. local-first operation with durable offline state;
4. transport replaceability so Signal is an adapter, not the architecture.

## 2. Target repository shape

```text
e2e-col/
├── apps/
│   ├── web/                 # Vite/React user interface
│   └── sidecar/             # local Node/TS Signal bridge
├── packages/
│   ├── core/                # CRDT document/session abstractions
│   ├── protocol/            # typed envelopes + codecs + validation
│   ├── transport/           # common transport contracts + test transports
│   ├── storage/             # IndexedDB/local persistence adapters
│   └── testing/             # reusable convergence/network test harness
├── tests/
│   ├── integration/
│   └── e2e/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── POC-REVIEW.md
│   ├── PROJECT-PLAN.md
│   ├── ROADMAP-DESIGN-SPEC.md
│   └── REPORT.md
└── upstream/                # preserved SPRING/EPFL research prototype
```

## 3. Architectural modules

### 3.1 `packages/core`

Responsibilities:

- own Automerge document creation/load/change/apply semantics;
- expose editor-neutral document operations;
- emit opaque CRDT changes to the transport layer;
- consume remote changes idempotently;
- expose document/session lifecycle and synchronization state.

Non-responsibilities:

- no Signal APIs;
- no WebSocket APIs;
- no React hooks;
- no IndexedDB implementation details.

### 3.2 `packages/protocol`

Responsibilities:

- define the stable wire envelope;
- schema validation at every boundary;
- binary codec and versioning;
- message/document IDs;
- chunking metadata;
- control frame kinds for membership, archive, delete, snapshot, and health.

Suggested envelope:

```yaml
version: 1
documentId: uuid
messageId: uuid
senderId: opaque-device-id
kind: automerge-change | snapshot | membership | archive | delete | chunk
createdAt: epoch-ms
sequence: optional-local-sequence
chunk:
  index: optional
  total: optional
payload: bytes
```

### 3.3 `packages/transport`

Responsibilities:

- define transport interfaces;
- provide deterministic loopback, delayed, duplicated, reordered, and dropping
  test transports;
- provide browser WebSocket client transport;
- expose reconnect/offline state transitions.

Signal-specific code remains outside this package.

### 3.4 `packages/storage`

Responsibilities:

- IndexedDB persistence for local document state;
- device-local application metadata such as display titles;
- durable outbound queue;
- snapshots/checkpoints;
- compaction metadata;
- recovery after browser restart or crash.

Document display metadata is a separate local-storage authority lane. It is not CRDT
content, access-control state, or wire payload. Metadata-only updates MUST preserve
snapshot bytes, outbound/access/authorization stores, document UUID, and group
binding. Conversely CRDT/local and remote snapshot persistence MUST preserve the
already-durable metadata record rather than treating an open session's cached copy as
authoritative. This prevents a stale content write from racing and undoing a local
rename.

### 3.5 `apps/sidecar`

Responsibilities:

- own `signal-cli` linked-device state and process lifecycle;
- expose a narrow localhost-only WebSocket/HTTP API;
- convert protocol envelopes to/from Signal group messages;
- handle chunking, deduplication, retries, and transport diagnostics;
- never become the canonical plaintext document store.

### 3.6 `apps/web`

Responsibilities:

- document/editor UX;
- connection/offline/sync indicators;
- durable outbound queue depth plus reconnect/restart replay progress, without claiming peer ack;
- explicit fail-closed authorization-conflict and checkpoint-recovery indicators;
- membership/access UI;
- local-first persistence integration;
- no Signal credentials or daemon management.

## 4. Core invariants

```yaml
security:
  - Signal/device credentials never enter browser storage.
  - helper services are not authoritative for plaintext documents.
  - protocol frames are validated before use.
  - access-control state is authenticated and convergent.
correctness:
  - same set of valid changes converges regardless of order.
  - duplicates are harmless.
  - local edits remain available offline.
  - restart does not lose acknowledged local state.
  - remote transport failure cannot corrupt local state.
architecture:
  - UI depends on core, not Automerge internals directly.
  - core depends on transport interfaces, not Signal.
  - sidecar depends on protocol, not UI.
  - storage is replaceable and testable independently.
```

## 5. Roadmap

### R0 — repository foundation

**Status: implemented (2026-08-19).** Shared TypeScript, ESLint/Prettier, Vitest, Playwright, CI, workspace scripts, and the reusable testing package are in trunk.

Deliverables:

- establish workspaces for `apps/*` and `packages/*`;
- add shared TypeScript configuration;
- add lint/format/test scripts;
- add Vitest and Playwright baselines;
- add CI matrix for typecheck, unit, build, browser E2E.

Exit criteria:

- clean install from repository root;
- all package boundaries compile independently;
- no generated files tracked accidentally.

### R1 — convergence core

**Status: Track A implemented (2026-08-19).** The Automerge core is UI/transport-neutral, uses operation-aware text splices, supports save/load and explicit remote change application, and has convergence/idempotence tests.

Deliverables:

- extract current `CollaborativeDocument` into `packages/core`;
- use operation-aware text editing rather than whole-document replacement;
- expose explicit local/remote change flow;
- support state save/load;
- add property tests for order-independent convergence.

Exit criteria:

- two replicas converge under shuffled delivery;
- duplicate changes are idempotent;
- concurrent inserts/deletes converge;
- reload preserves document state.

### R2 — protocol layer

**Status: implemented for envelope v1 (Track B, 2026-08-19).** Typed product
control payloads remain reserved for R6.

Deliverables:

- implement versioned binary envelope;
- runtime schema validation;
- IDs and frame kinds;
- chunking/reassembly;
- dedup cache semantics;
- snapshot/control frame support.

Exit criteria:

- malformed envelopes are rejected;
- chunked payloads reassemble deterministically;
- unknown future frame kinds fail safely;
- protocol versioning has compatibility tests.

### R3 — transport simulation and resilience

**Status: implemented for provable loss signals (Track C + Phase 2, 2026-08-20).**
Deterministic faults, offline queues, metrics, recovery signaling, WebSocket
transport, and automatic durable snapshot/checkpoint repair are present. The v1
logical envelope sequence is intentionally not used as a generic gap detector
because it is session-local/resettable and lacks causal predecessor metadata.

Deliverables:

- deterministic fault-injection transport;
- delay, reorder, duplicate, disconnect, reconnect, and drop scenarios;
- outbound queue model;
- delivery-state metrics.

Exit criteria:

- convergence tests pass under reordering and duplication;
- offline edits synchronize after reconnect;
- dropped frames are recoverable via snapshot/checkpoint strategy.

### R4 — durable local-first storage

**Status: initial release implementation complete (Track D, 2026-08-19).**
Memory and IndexedDB stores persist snapshots and durable outbound work, and the
browser replays queued frames on reopen. Migration/corruption fixtures and
checkpoint compaction remain hardening work.

Deliverables:

- IndexedDB document store;
- durable outbound queue;
- snapshot/checkpoint persistence;
- migration/versioning layer;
- storage corruption/recovery tests.

Exit criteria:

- browser restart preserves local edits;
- pending outbound work resumes safely;
- storage migrations are tested.

### R5 — Signal sidecar

**Status: production adapter boundary audited against signal-cli v0.14.7
(Track E + Phase 3, 2026-08-20); live Signal interoperability evidence pending.**
The localhost sidecar validates protocol frames, maps configured UUIDs to
pre-existing Signal groups, verifies daemon health/group visibility, performs a
non-fatal best-effort version probe, requires an initial usable SSE subscription,
parses automatic/manual/sync receive forms, validates documented send responses,
chunks/deduplicates bounded Signal bodies, retries sends, and integrates with
signal-cli HTTP JSON-RPC/SSE. Ambiguous send outcomes remain ordinary transport
failures; recovery code `4409` is reserved for explicit backend proof of history
risk and is not inferred by the real HTTP adapter. The runtime deliberately does
not provision accounts or mutate groups.

Deliverables:

- current `signal-cli` API verification;
- pre-linked account selection, group visibility, health, and best-effort version checks;
- localhost WebSocket API;
- send/receive bridge using protocol envelopes;
- chunking and dedup;
- secure local configuration handling.

Exit criteria:

- two linked devices exchange a CRDT change through Signal;
- sidecar restart is recoverable;
- credentials never appear in logs or browser state.

### R6 — paper-level access semantics

**Status: complete for the authenticated-identity model (2026-08-21).** R6 now
covers a shared creator-signed authorization root, replay-safe causal controls, and
explicit signed fork reconciliation, with durable restart and Chromium/Firefox
evidence. The outer `ProtocolEnvelope` remains v1.

Bootstrap trust model:

- canonical authorization-root v1 binds document id, creator identity, sorted
  participant ids/roles/active state, and a 32-byte SHA-256 commitment to each
  participant's authenticated Ed25519 identity key; the creator MUST be an active
  initial admin and signs the canonical root;
- production browser creation installs a creator-only root only from an explicit
  local `CollaborativeClient.createDocument()` operation. A shared-group
  `openDocument()` MUST NOT mint a root from `created_by`, membership, or cache
  emptiness. Group membership is routing/discovery metadata and cannot install ACL
  authority; later participants enter through signed membership-v3 invites that bind
  the target identity key;
- a fresh replica verifies the root signature plus every identity-key commitment
  before installing revision-0 authority. A late joiner replays root + signed
  control/resolution evidence to the supplied current head; CRDT bootstrap is a
  separate concern;
- an established replica MUST NOT let bootstrap/group metadata replace a durable
  root/head. Conflicting root/head hints fail closed; an established replica MAY
  republish its already-verified durable root/head into an empty evidence cache;
- the toy group authorization endpoint is an untrusted evidence cache. Private
  identity keys never move into server state. Its root/head fields are evidence
  selection/freshness hints, not signatures or plaintext ACL authority.

Authorization ordering is independent from `ProtocolEnvelope.sequence`. Control
payload v2 binds document id, positive authorization revision, predecessor, actor,
timestamp, and semantic fields; authenticated invite payload v3 additionally binds
the target identity-key commitment. Accepted control history and pending/conflict
state survive dedup expiry, restart, snapshots, and CRDT checkpoint compaction.

Concurrency and reconciliation policy:

- authorize a control against the ACL at its signed predecessor; on a verified root,
  re-check the actor's current authenticated key against the predecessor ACL's bound
  identity-key commitment;
- durably buffer a valid future control until its predecessor becomes known;
- two valid same-predecessor/revision controls freeze at the common predecessor;
- fork-resolution v1 binds document id, common predecessor, fork revision, exact
  sorted competing control commitments, deterministic chosen branch/resulting ACL
  commitment, and resolution revision. The resolution commitment becomes the new
  authorization head;
- resolution requires the exact unanimous set of active admins at the pre-fork
  predecessor and at least two independent admins. Every approval is signature- and
  identity-key-binding-checked. A one-admin fork remains frozen fail-closed;
- delete branches take deterministic precedence; otherwise the lexicographically
  smallest competing control commitment is canonical. Arrival order, server choice,
  and first-writer rules are never authority;
- resolution may arrive before branch controls and is durably buffered until the
  exact fork evidence exists. Resolved branches remain superseded after restart and
  seen-message TTL expiry; delete remains terminal.

Compatibility is explicit and fail-closed. Legacy control payload v1 is rejected.
Persisted revision-0 and revision>0 state become `legacy-zero-genesis` and
`legacy-local-anchor` respectively; neither is silently promoted to `verified-root`.

R6 does not solve first-contact identity-directory compromise or freshness of an
untrusted bootstrap cache. A brand-new device can be censored or shown an older
valid signed prefix unless an external pin/transparency mechanism proves a newer
head; an established durable replica cannot be rolled back. R5 live real-Signal
evidence remains a separate, unchanged deployment gate.

#### P2 §2.4 — key-material lifecycle

**Status: prekey lifecycle implemented (2026-08-22).** Session establishment is the
maintenance boundary. The identity provider returns its currently advertised signed
prekey, a rotation-due flag, and remaining one-time-prekey count. The browser MUST
first reconcile that signed-prekey public material with either its durable current
key or an already-staged pending key; any third value fails closed.

Signed-prekey rotation uses the existing long-term Ed25519 identity only as the
authenticator. The browser generates a non-exportable X25519 pair, persists it as a
pending signed prekey, signs its public half with the unchanged Ed25519 private key,
publishes it, verifies the provider echoed the exact material, then atomically makes
it current and archives the previous private pair. Retired pairs remain selectable
by the existing encrypted-envelope recipient-key fingerprint so delayed ciphertext
does not become undecryptable merely because a maintenance rotation occurred. The
toy provider requests this transition after seven days.

One-time prekey replenishment follows the same durability ordering. When provider
inventory falls below five, the browser stages enough X25519 pairs to target ten,
publishes their public halves, then records them as published. A crash after provider
acceptance but before that final write retries the same staged public keys; provider
deduplication makes the retry idempotent.

This lifecycle MUST NOT silently replace the Ed25519 identity key. Verified R6 roots,
membership-v3 invitations, controls, and fork approvals bind that key. Identity-key
rotation therefore remains a separate §2.4 gap until an authenticated rebind and
re-verification transition can preserve historical signature verification and update
authority commitments explicitly rather than by directory substitution.

Deliverables:

- participant list and role model;
- read/write/admin permissions;
- membership change frames;
- archive/delete semantics;
- explicit UX around deletion limitations.

Exit criteria:

- participant list changes are authenticated;
- unauthorized edit frames are rejected;
- archive/delete behavior matches documented model.
- stale authenticated controls remain rejected after dedup expiry and restart;
- authorization ordering does not depend on transport order or envelope sequence;
- a shared signed bootstrap root is independently verifiable across devices;
- a fork stays frozen until a quorum-backed signed resolution is valid, then the
  resolution converges and survives durable restart;
- Chromium and Firefox verify the same root/head through encrypted invite + lifecycle
  control without trusting plaintext group membership as ACL authority.

### R7 — production editor

**Status: planned after `0.0.1`.** The release web app is intentionally a
plain-text integration reference, not a rich document editor.

Deliverables:

- structured block model;
- headings, paragraphs, lists, links;
- comments/annotations;
- history/timeline;
- attachment references;
- accessibility and mobile behavior.

Exit criteria:

- editor operations map cleanly onto convergent document operations;
- no transport-specific logic leaks into UI components.

### R8 — hardening and deployment

**Status: partial.** CI/release gates, deterministic resilience tests,
multi-context/browser test definitions, deployment documentation, and the
browser/sidecar topology exist. Real Signal two-device E2E, access-control threat
tests, and packaged desktop/distribution artifacts remain outstanding.

Deliverables:

- Playwright multi-context scenarios;
- threat-model review against R8–R10 from the paper;
- packaging strategy: browser + companion daemon first, desktop bundle optional;
- reproducible release builds;
- operational documentation.

Exit criteria:

- full E2E scenario from local edit → sidecar → Signal → remote sidecar → remote
  browser passes;
- offline catch-up and restart scenarios pass;
- release artifacts are reproducible.

## 6. Concurrent work decomposition

The following tasks are intentionally split by path ownership so multiple agents
can work concurrently with minimal overlap.

### Track A — core CRDT

```yaml
paths:
  - packages/core/**
  - packages/testing/src/core-*.test.ts
tasks:
  - extract document core from apps/web
  - implement operation-aware text edits
  - implement save/load/apply APIs
  - convergence property tests
depends_on:
  - R0 workspace skeleton only
```

### Track B — protocol

**Status: implemented.**

```yaml
paths:
  - packages/protocol/**
  - packages/testing/src/protocol-*.test.ts
tasks:
  - envelope types
  - codec
  - validation
  - chunking/reassembly
  - version compatibility tests
depends_on: []
```

### Track C — transport simulation

**Status: implemented.**

```yaml
paths:
  - packages/transport/**
  - packages/testing/src/transport-*.test.ts
tasks:
  - transport interface
  - loopback adapter
  - deterministic fault injection
  - reconnect/offline state model
depends_on:
  - stable protocol envelope shape preferred but not required for initial mocks
```

### Track D — storage

**Status: implemented for `0.0.1`; hardening items remain under R4/R8.**

```yaml
paths:
  - packages/storage/**
  - packages/testing/src/storage-*.test.ts
tasks:
  - IndexedDB adapter
  - outbound queue persistence
  - snapshots/checkpoints
  - migrations
depends_on:
  - core serialization contract
```

### Track E — Signal sidecar

**Status: implemented, production-contract-audited, and locally contract-tested;
real Signal smoke profile exists but fixture evidence is pending.**

```yaml
paths:
  - apps/sidecar/**
  - tests/integration/signal-*.test.ts
tasks:
  - verify signal-cli v0.14.7 daemon API and JSON-RPC/SSE shapes
  - sidecar process lifecycle
  - localhost WebSocket API
  - Signal send/receive bridge
  - configured final-body chunk boundary plus chunk/dedup/retry integration
  - explicit pre-signal-cli-acceptance recovery signaling
  - skip-by-default two-account real Signal smoke profile
depends_on:
  - protocol package
  - transport interface
```

### Track F — web UX

**Status: initial integration plus P2 local-library metadata complete.** The web
runtime consumes the framework-neutral client facade and IndexedDB storage. The Local
library can create/switch independent documents and edit a device-local display title.
Group-bound workspaces keep unrelated document switching/rename disabled so metadata
UX cannot retarget a collaboration group to another UUID. Richer organization and
offline-first UX remain later product work.

```yaml
paths:
  - apps/web/**
tasks:
  - consume core/transport/storage packages
  - editor UI
  - sync/offline indicators
  - document list and lifecycle UX
depends_on:
  - core public API
```

### Track G — test and release harness

**Status: implemented and extended through Phase 3 (2026-08-20).** The reusable testing package composes the real core and deterministic transport, includes upstream-derived fast/slow latency profiles, and verifies concurrency, duplicate/reorder, offline catch-up, recovery signaling, and dropped-increment checkpoint repair. Production-style Vitest evidence exercises real IdentityClient encryption over MockSignalTransport; sidecar tests now separately audit the signal-cli v0.14.7 boundary and expose an opt-in two-account live profile. Playwright verifies encrypted browser convergence plus persistent-profile restart/queue/dedup recovery in Chromium and Firefox. CI remains deterministic and does not require Signal credentials.

```yaml
paths:
  - packages/testing/**
  - tests/e2e/**
  - .github/**
tasks:
  - Vitest setup
  - Playwright multi-browser/context setup
  - benchmark-derived network scenarios
  - CI and release checks
depends_on:
  - package scripts stabilized by R0
```

## 7. Merge-order guidance

Recommended integration order:

```text
R0 foundation
  ├─ Track A core ───────┐
  ├─ Track B protocol ───┼─> integration tests
  ├─ Track C transport ──┤
  └─ Track G harness ────┘
              │
              ├─ Track D storage
              ├─ Track E sidecar
              └─ Track F web
                     │
                     └─ R6/R7/R8
```

Agents should claim only their assigned paths and avoid editing root manifests
except during R0 or coordinated integration windows.

## 8. Decision log

### Decision: Automerge remains the reconciliation engine

Reason: it directly fits the paper's strong-convergence requirement, is already
used by the PoC, and has a modern browser-capable implementation.

### Decision: Signal lives behind a sidecar

Reason: Signal device state belongs outside browser JavaScript, and the research
construction does not require the editor to be transport-specific.

### Decision: plain text first, structured blocks later

Reason: transport, persistence, and convergence failure modes should be hardened
before rich-text semantics multiply the state space.

### Decision: helper services remain untrusted for plaintext state

Reason: this preserves the paper's security model and prevents architectural
drift toward a conventional centralized collaborative editor.
