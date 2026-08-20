# e2e-col 0.5.0 — developer guide

> Documentation target: **0.5.0**. The checkout used to prepare this guide still reports package
> version `0.0.1`; version bumping is intentionally outside this documentation suite.
>
> This guide describes the **current implementation**. Target-only APIs are called out explicitly
> and are not prerequisites for contributing to the existing code.

For setup and architecture orientation, start with the
[release introduction](INTRO.md). For an end-to-end exercise using the current APIs, see the
[hands-on tutorial](TUTORIAL.md). The exact implemented package surface is in the
[API reference](API.md). The longer-term API design remains in
[`TARGET-API-SPEC.md`](../TARGET-API-SPEC.md).

## 1. Development environment

### 1.1 Monorepo and package manager

`e2e-col` is a TypeScript **pnpm workspace**. The workspace declaration includes both top-level
application and library directories:

```text
apps/*
packages/*
```

Use pnpm for repository work. Older prose in the repository may still contain npm, ESLint, or
Prettier commands; those are not the current contributor workflow.

Install and validate a checkout with:

```bash
pnpm install --frozen-lockfile
pnpm run check
```

Useful root commands are:

| Command | Purpose |
| --- | --- |
| `pnpm run dev` | Start the Vite web app. |
| `pnpm run typecheck` | Run every workspace TypeScript check. |
| `pnpm run lint` | Run `biome check .`. |
| `pnpm run format:check` | Check formatting with Biome. |
| `pnpm run format` | Apply Biome fixes/formatting intentionally. |
| `pnpm test` | Run the complete Vitest suite. |
| `pnpm run build` | Run workspace build scripts; the web app produces the Vite build. |
| `pnpm run test:e2e` | Run Playwright for Chromium, Firefox, and WebKit. |
| `pnpm run check` | Version check, typecheck, Biome checks, Vitest, then build. |
| `pnpm run check:release` | `check` followed by the full Playwright matrix. |

Use a workspace filter when developing one component:

```bash
pnpm --filter @e2e-col/core test
pnpm --filter @e2e-col/storage typecheck
pnpm --filter @e2e-col/sidecar dev
pnpm --filter @e2e-col/toy-signal-cli dev
```

### 1.2 Dependency direction

The current workspace is deliberately layered. Internal package dependencies in `package.json`
form this practical graph:

```text
                                apps/web
                         +----------+----------+
                         |          |          |
                         v          v          v
                      core      protocol    storage
                         \          |          /
                          \         |         /
                           +---- transport ---+

packages/testing
  |--> core
  |--> protocol
  `--> transport

apps/sidecar
  |--> protocol
  `--> ws

apps/toy-signal-cli
  `--> development/test daemon model; no e2e-col library dependency
```

The drawing shows consumption, not an instruction to add dependencies between all sibling
libraries. In particular:

- `core` owns Automerge document state and has no knowledge of protocol, transport, storage,
  Signal, IndexedDB, or React;
- `protocol` owns validation and binary framing, not network delivery or CRDT semantics;
- `transport` moves opaque bytes and does not decode protocol envelopes;
- `storage` persists opaque snapshots and outbound bytes;
- `testing` composes real lower-level packages for deterministic scenarios;
- `apps/sidecar` consumes `protocol` and connects browser WebSockets to the local signal-cli HTTP
  daemon;
- `apps/web` currently contains `BrowserReplicaSession`, an application-local orchestration
  precursor to the **missing** target `@e2e-col/client` package.

Keep new dependencies pointing in the same direction. A change that makes `core` import a web,
transport, storage, or sidecar concern is almost certainly at the wrong layer.

### 1.3 TypeScript configuration

Every workspace extends [`tsconfig.base.json`](../../tsconfig.base.json). The shared baseline is
strict and intentionally catches boundary mistakes:

```yaml
target: ES2022
module: ESNext
moduleResolution: Bundler
strict: true
noUncheckedIndexedAccess: true
exactOptionalPropertyTypes: true
isolatedModules: true
noEmit: true
```

The browser-oriented libraries include DOM types. The sidecar and toy daemon additionally include
Node types. The React app sets `jsx: react-jsx`.

Because `exactOptionalPropertyTypes` is enabled, do not casually pass `undefined` for an optional
field whose declared type does not include `undefined`. Prefer conditional object spreads when
constructing envelopes/options, as the current source does.

### 1.4 Biome linting and formatting

Biome 2.5 is the repository linter and formatter. Current JavaScript/TypeScript formatting uses:

```yaml
indent: 2 spaces
line_width: 100
quotes: single
semicolons: as-needed
trailing_commas: none
```

The recommended linter preset is enabled and unused variables are errors.

For normal review, use the non-mutating commands first:

```bash
pnpm run lint
pnpm run format:check
```

Only run the write form when you intend to modify the affected files:

```bash
pnpm run format
# equivalent repository policy: biome check --write .
```

In a dirty/shared checkout, do not run a repository-wide write-format merely to clear unrelated
changes. Format the files you own or inspect the specific diagnostics first.

## 2. Testing model

The test suite is split by the trust boundary being exercised rather than by one monolithic
integration harness.

### 2.1 Vitest

The complete unit/integration suite is:

```bash
pnpm test
```

Useful focused gates are:

```bash
pnpm run test:core
pnpm run test:storage
pnpm run test:sidecar
pnpm run test:toy-signal-cli
```

The current suite exercises, among other things:

- Automerge concurrent edit convergence and duplicate-change idempotence;
- strict v1 protocol validation and a stable binary wire fixture;
- chunking, shuffled reassembly, duplicate chunk handling, and dedup TTL/capacity;
- deterministic latency, drop, duplicate, hold/reorder, offline retention, and reconnect;
- WebSocket adapter state transitions and binary-only receive behavior;
- memory and fake-IndexedDB persistence;
- malformed protocol bytes being rejected before CRDT application;
- sidecar validation, chunking, deduplication, retry behavior, and Origin/loopback guards;
- signal-cli SSE reconnect/account filtering;
- a two-sidecar/two-toy-account HTTP/SSE/WebSocket round trip.

### 2.2 Deterministic transport tests

`DeterministicTransportNetwork` uses **virtual time**. Prefer its controls over wall-clock sleeps
when testing protocol/core behavior:

```ts
const network = new DeterministicTransportNetwork({ latencyMs: 50 })
// ... send bytes ...
network.advanceBy(49)
// assert not delivered
network.advanceBy(1)
// assert delivered
```

Fault schedules are deterministic and keyed by the global 1-based send sequence. Use fixed IDs and
timestamps in protocol fixtures when the value is part of the assertion. Existing protocol tests
also pin the complete v1 encoded hex representation; a deliberate wire change must update that
fixture as part of the same reviewed compatibility change.

For server integration tests, use port `0` so the operating system allocates a free loopback port.
For IndexedDB tests, use `fake-indexeddb` and unique database names. Keep retry/wait loops bounded.

### 2.3 Sidecar + toy signal-cli integration

The deterministic process-boundary harness is:

```bash
pnpm exec vitest run apps/toy-signal-cli/src/sidecar-e2e.test.ts
```

It starts:

```text
WebSocket client A
  -> SidecarBridge A
  -> SignalCliHttpBackend A
  -> toy signal-cli JSON-RPC/SSE
  -> SignalCliHttpBackend B
  -> SidecarBridge B
  -> WebSocket client B
```

This is deliberately stronger than a pure in-memory backend test, but it is still not a real Signal
cryptographic/service test. The toy daemon models the local signal-cli HTTP contract only.

### 2.4 Playwright

Browser E2E tests live under `tests/e2e/` and the current configuration targets all three browser
engines:

```bash
pnpm exec playwright test --project=chromium
pnpm exec playwright test --project=firefox
pnpm run test:e2e
```

Do not weaken the Playwright project matrix to accommodate one development host. Host dependency
failures and application assertion failures are different evidence.

### 2.5 Repository gate and current verification evidence

The canonical non-browser gate is:

```bash
pnpm run check
```

It runs, in order:

```text
version:check
  -> typecheck
  -> Biome lint
  -> Biome format check
  -> Vitest
  -> build
```

For the documentation checkout used for the 0.5.0 suite, the latest local verification is:

```yaml
pnpm_run_check: PASS
vitest: 21 files / 141 tests PASS
build_inside_check: PASS
playwright_chromium: 3/3 PASS
playwright_firefox: 3/3 PASS
playwright_webkit:
  status: HOST-BLOCKED before test execution
  host: Arch Linux
  missing_playwright_fallback_libraries:
    - libicu74
    - libxml2
    - libflite1
```

The WebKit result is a local host-runtime limitation, not an application test failure and not a
reason to remove WebKit from `playwright.config.ts`.

## 3. Contributor workflow: add a core operation

A core operation belongs in `packages/core` only when it changes convergent document state without
needing transport, protocol, persistence, or UI knowledge.

1. Add the operation to `packages/core/src/collaborative-document.ts`.
2. Export any new public type or function from `packages/core/src/index.ts`.
3. Validate arguments **before** mutating the Automerge document.
4. Return opaque `DocumentChange[]` for locally generated CRDT changes.
5. Preserve no-op behavior: a semantic no-op should not manufacture a change or notify subscribers.
6. Add convergence/idempotence/range tests in `collaborative-document.test.ts`.
7. If the operation is useful in fault scenarios, add a thin scenario helper rather than teaching
   transport about the operation.

Example checks:

```bash
pnpm --filter @e2e-col/core test
pnpm --filter @e2e-col/core typecheck
pnpm exec vitest run packages/testing/src/scenario.test.ts
```

Current `CollaborativeDocument.spliceText()` is the model: it checks index/delete bounds first,
performs one Automerge splice, emits after state changes, and returns the generated changes.

Do not implement the target-only `mergeSnapshot()` by replacing the document with a loaded
snapshot. The target contract specifically requires a merge that preserves concurrent local work;
that API is still missing and needs an Automerge-aware design and tests before it can be documented
as implemented.

## 4. Contributor workflow: add or evolve a protocol message

The protocol package is a strict trust boundary. Changes here require both semantic and byte-level
review.

For a new envelope kind or wire-visible field:

1. update the types/constants in `packages/protocol/src/types.ts`;
2. update validation in `validation.ts`;
3. update the kind-code/header codec in `codec.ts` when the wire representation changes;
4. update chunking/reassembly only if the new semantics affect chunk metadata;
5. add malformed and round-trip tests;
6. decide whether existing v1 bytes retain exactly the same meaning.

If old v1 decoders would interpret an existing byte sequence differently, that is not a silent v1
edit: introduce/version the protocol deliberately.

The reserved kinds `membership`, `archive`, `delete`, and `health` already exist in the generic v1
envelope. Their **typed payload codecs and authenticated authorization semantics are not
implemented**. Adding a payload schema means defining and testing that higher-level codec; it does
not justify inventing application-local JSON hidden inside an existing kind.

Focused verification:

```bash
pnpm --filter @e2e-col/protocol test
pnpm exec vitest run packages/testing/src/wire-path.test.ts
pnpm run typecheck
```

Malformed external bytes must fail before Automerge is called. Prefer `ProtocolValidationError`
with a useful `path` over permissive fallback behavior.

## 5. Contributor workflow: add a transport adapter

A transport adapter moves `Uint8Array` values. It does not know whether those bytes encode an
Automerge change, a snapshot, or any future protocol kind.

At minimum, implement `CollaborativeTransport`:

```ts
interface CollaborativeTransport {
  connect(documentId: string): Promise<void>
  send(update: Uint8Array): Promise<void>
  subscribe(listener: (update: Uint8Array) => void): () => void
  close(): Promise<void>
}
```

For production-style diagnostics, implement `ObservableCollaborativeTransport` as
`WebSocketTransport` and `SimulatedTransport` do.

Adapter tests should cover:

- binding one instance to one document;
- repeat connect behavior;
- send-before-connect/offline semantics;
- defensive byte ownership;
- inbound subscription/unsubscription;
- close semantics and post-close errors;
- state transitions and metrics when observable;
- malformed/non-binary transport input if the underlying channel can produce it.

`send()` resolving means only that this adapter accepted/wrote the bytes. It must never be turned
into a claim that another replica received or merged the update.

If the channel can drop data, expose enough observability for a higher layer to recover, but do not
put snapshot/checkpoint policy inside transport. The existing deterministic transport emits the
narrow `dropped-frame` recovery event; the current browser WebSocket adapter does not have remote
loss knowledge and reports no such event.

## 6. Contributor workflow: add a storage backend

Implement the current `CollaborativeStorage` contract and match the memory/IndexedDB semantics:

- return defensive copies of snapshot and outbound bytes;
- preserve document listing order by newest `updatedAt` first;
- preserve outbound listing order by oldest `createdAt` first;
- support document filtering in `listOutbound(documentId)`;
- make `acknowledgeOutbound(id)` idempotently remove the record;
- make `close()` safe for the backend's lifecycle.

Use `MemoryCollaborativeStorage` as the compact behavioral reference and
`IndexedDbCollaborativeStorage` for asynchronous transaction/error patterns.

Focused checks:

```bash
pnpm --filter @e2e-col/storage test
pnpm --filter @e2e-col/storage typecheck
```

### The durability boundary is not finished

Do not mistake implementing the current interface for implementing the target crash-safety model.
The current IndexedDB baseline has separate transactions for `saveDocument()` and `enqueue()`.
There is no atomic operation that commits one visible local edit's snapshot and outbound records
together. There is also no persistent seen-message ledger, durable attempt metadata, or checkpoint
compaction policy.

The target `DurableCollaborativeStorage` API in `TARGET-API-SPEC.md` is therefore **MISSING**. A
backend that adds those guarantees needs crash-window/restart tests in addition to the current
contract suite.

## 7. Contributor workflow: modify the sidecar

`apps/sidecar` is an application package and has **no package `exports` field**. Its TypeScript
modules are implementation/testing boundaries, not a published `@e2e-col/sidecar` SDK.

The current browser-facing behavior is:

```text
GET /health
WebSocket upgrade on the configured server with ?documentId=<configured UUID>
```

The target `/api/v1/health` and `/api/v1/documents?...` browser routes are not implemented yet.

When changing the sidecar:

1. keep protocol decoding/validation before broadcast forwarding;
2. keep the connection's configured document ID as a routing constraint;
3. keep Signal message framing namespaced as `e2e-col:v1:<base64 protocol frame>`;
4. preserve one owner for Signal-sized chunking/reassembly (`SidecarBridge`);
5. keep the default bind and signal-cli HTTP endpoint on loopback;
6. preserve Origin policy or make any expansion explicit and tested;
7. do not log plaintext payloads, provisioning data, or Signal device secrets;
8. keep retries bounded and treat their exhaustion as an operational error, not delivery proof;
9. test both the in-memory backend and the toy HTTP/SSE boundary.

Focused checks:

```bash
pnpm run test:sidecar
pnpm run test:toy-signal-cli
pnpm --filter @e2e-col/sidecar typecheck
```

`SignalCliHttpBackend` deliberately owns the signal-cli daemon contract: health at
`/api/v1/check`, JSON-RPC sends at `/api/v1/rpc`, and receive notifications from
`/api/v1/events`. Browser code must not receive those credentials or call those endpoints directly.

## 8. Architecture decisions

### 8.1 Why Automerge is the chosen CRDT substrate

The project follows the SignalCD/paper construction: combine a strongly convergent replicated data
model with an end-to-end encrypted asynchronous broadcast channel. Automerge is the current,
well-tested substrate selected to realize the reconciliation half of that construction in this
TypeScript codebase.

That choice should **not** be restated as a universal claim that Yjs lacks convergence. Yjs is also
a CRDT system with its own convergence model and engineering trade-offs. The reason to prefer
Automerge *here* is narrower:

- the project is explicitly aligned with the paper's strongly convergent reconciliation model;
- the existing core, fixtures, snapshots, and concurrency tests are already built on Automerge;
- Automerge exposes change/snapshot primitives that fit the project's asynchronous replay model;
- retaining one CRDT substrate avoids introducing a translation layer whose correctness would also
  need to be proved.

A future engine comparison should evaluate document model, wire/storage costs, ecosystem, undo,
rich-text needs, and migration semantics on evidence. It should not be framed as one CRDT family
having convergence while another categorically does not.

### 8.2 Why a binary protocol

The v1 envelope is a compact, deterministic binary boundary rather than application JSON because it
needs to carry opaque CRDT bytes, reject ambiguous/trailing data, bound allocations, and remain
independent from Signal's text-safe body representation.

Base64 exists only at the Signal adapter boundary:

```text
ProtocolEnvelope --binary--> sidecar --base64 text--> signal-cli/Signal
```

Base64 is not a second semantic protocol. Keep message kinds, IDs, sequence metadata, chunk
metadata, and validation in `@e2e-col/protocol`.

### 8.3 Why a localhost sidecar

The browser should not own Signal linked-device state. The sidecar narrows the trust boundary:

```text
browser:
  owns: plaintext CRDT replica, protocol/session logic, local IndexedDB
  does_not_own: signal-cli account/device credentials

sidecar:
  owns: local signal-cli integration and routing metadata
  sees: validated protocol frames and transport metadata
  does_not_own: authoritative plaintext document state or CRDT merge logic
```

Default loopback bind and loopback Origin checks reduce accidental network exposure. Any deliberate
remote binding requires a separate authentication/threat-model decision; `allowRemoteHost` is an
implementation escape hatch, not a production security design by itself.

### 8.4 Why IndexedDB is the current browser baseline

IndexedDB gives the browser an asynchronous durable store for complete Automerge snapshots and
outbound frames without coupling `core` to browser APIs. It is available in the current web target
and can be tested with `fake-indexeddb`.

The current schema is intentionally modest (`documents` and `outbound`, schema version 1). It is a
baseline, not the final crash-safe client transaction model. Strengthening it should happen behind
the storage/client boundaries rather than by letting UI components manipulate IndexedDB directly.

## 9. Error and trust boundaries

Treat errors according to the layer that can make a correct decision about them.

| Boundary | Current behavior | Contributor rule |
| --- | --- | --- |
| Core edit arguments | Invalid splice range throws `RangeError`; no-op returns no changes. | Validate before mutation. |
| Protocol object/raw bytes | `ProtocolValidationError` for invalid shape/version/codec data. | Reject before CRDT application; do not guess future kinds. |
| Deterministic transport | Programmer/configuration errors use `TypeError`, `RangeError`, or `Error`; injected loss emits recovery. | Keep faults deterministic and payload-opaque. |
| WebSocket transport | Connect/send lifecycle errors reject; non-binary inbound data is dropped and counted. | Do not treat socket send as remote ack. |
| Storage | IndexedDB availability/open/request/transaction failures reject. | Propagate recoverable storage failure; never silently discard local data. |
| Sidecar browser input | Malformed/non-binary/wrong-document frames are currently ignored; bad Origin/document upgrades receive HTTP 403/400. | Keep untrusted input from reaching Signal; hardening may make policy failures more explicit. |
| signal-cli HTTP/SSE | Health/send failures reject; receive stream failures reconnect with bounded exponential delay. | Keep secrets/payloads out of error logs; distinguish transient receive reconnect from send success. |
| Toy daemon | JSON-RPC errors model protocol/parameter failures explicitly. | Unknown methods must fail; never fake support with no-op success. |

The target typed `ClientError` model does not exist yet. Do not write application code that imports
it from a nonexistent `@e2e-col/client` package.

## 10. Contributing conventions

Keep changes small enough that one layer's invariant can be reviewed independently.

```yaml
package_manager: pnpm
language: strict TypeScript
lint_format: Biome
unit_integration: Vitest
browser_e2e: Playwright
public_api:
  - export only from the package index when it is intentionally public
  - keep app implementation modules distinct from package APIs
bytes:
  - treat Uint8Array ownership defensively at boundaries
  - validate external protocol bytes before semantic use
ids:
  - use UUID document/message IDs at the protocol boundary
security:
  - keep signal-cli/device credentials outside browser storage and source control
  - avoid payload-bearing logs at transport/sidecar boundaries
compatibility:
  - do not change v1 wire interpretation silently
  - label target-only API examples as target/missing
```

When a test needs IDs or time only for uniqueness, inject/fix them rather than making assertions
depend on wall-clock timing. When a test is explicitly about server retry/SSE behavior, bounded
real-time waits are acceptable; keep them short and deterministic in fault count/order.

## 11. Validation checklist

Before requesting review for a normal code change:

- [ ] Read the package/app `package.json` and the current source boundary you are changing.
- [ ] Confirm new imports preserve the dependency direction.
- [ ] Add or update a focused Vitest test for the changed invariant.
- [ ] For protocol changes, add malformed-input coverage and review the v1 wire fixture.
- [ ] For transport changes, test offline/queue/close and byte ownership semantics.
- [ ] For storage changes, test defensive copies and persistence/restart behavior appropriate to the
      guarantee claimed.
- [ ] For sidecar changes, test loopback/Origin/document routing and the toy signal-cli boundary.
- [ ] Run `pnpm run typecheck`.
- [ ] Run `pnpm run lint` and `pnpm run format:check`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm run build`.
- [ ] Run Chromium Playwright for browser/session changes.
- [ ] Run the complete Playwright matrix on a host with all browser runtime dependencies before
      claiming three-engine release evidence.
- [ ] Re-read the [API reference](API.md) if a current exported surface changed.
- [ ] Re-read [`TARGET-API-SPEC.md`](../TARGET-API-SPEC.md) if the change promotes a target surface
      into current implementation.

The broad local non-browser gate remains:

```bash
pnpm run check
```

Release evidence additionally needs the browser matrix and, for the Signal path, a deliberately
opt-in real two-account linked-device smoke test. The deterministic toy daemon cannot substitute
for evidence about Signal cryptography/service behavior.
