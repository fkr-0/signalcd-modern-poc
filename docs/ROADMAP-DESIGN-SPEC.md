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
- durable outbound queue;
- snapshots/checkpoints;
- compaction metadata;
- recovery after browser restart or crash.

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

**Status: substantially implemented (Track C, 2026-08-19).** Deterministic
faults, offline queues, metrics, recovery signaling, and WebSocket transport are
present. Automatic snapshot/checkpoint recovery after a loss signal remains an
R4/R8 follow-up.

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

**Status: implementation complete for the `0.0.1` contract (Track E,
2026-08-19); live Signal interoperability evidence pending.** The localhost
sidecar validates protocol frames, chunks/deduplicates Signal bodies, retries
sends, exposes health, and integrates with signal-cli HTTP JSON-RPC/SSE.

Deliverables:

- current `signal-cli` API verification;
- linked-device bootstrap and health checks;
- localhost WebSocket API;
- send/receive bridge using protocol envelopes;
- chunking and dedup;
- secure local configuration handling.

Exit criteria:

- two linked devices exchange a CRDT change through Signal;
- sidecar restart is recoverable;
- credentials never appear in logs or browser state.

### R6 — paper-level access semantics

**Status: planned after `0.0.1`.**

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

**Status: implemented and locally contract-tested; real Signal smoke pending.**

```yaml
paths:
  - apps/sidecar/**
  - tests/integration/signal-*.test.ts
tasks:
  - verify current signal-cli daemon API
  - sidecar process lifecycle
  - localhost WebSocket API
  - Signal send/receive bridge
  - chunk/dedup/retry integration
depends_on:
  - protocol package
  - transport interface
```

### Track F — web UX

**Status: initial integration implemented.** The web runtime now consumes core,
protocol, transport, and IndexedDB storage through `BrowserReplicaSession`.
Richer document-list/access/lifecycle UX remains part of the product phases.

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

**Status: implemented (2026-08-19).** The reusable testing package now composes the real core and deterministic transport, includes upstream-derived fast/slow latency profiles, and verifies concurrency, duplicate/reorder, offline catch-up, and recovery signaling. Playwright verifies browser-to-browser replica synchronization, and CI contains verify, benchmark-scenario, browser-E2E, and tag release gates.

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
