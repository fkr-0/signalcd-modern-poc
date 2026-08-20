# API implementation status

Status snapshot: **2026-08-20**  
Target contract: [`TARGET-API-SPEC.md`](TARGET-API-SPEC.md)

This document answers two questions for application designers:

1. Which target APIs exist and are verified today?
2. Which target APIs must still be mocked, implemented, or deliberately kept
   behind a feature flag?

## 1. Status legend

| Marker       | Meaning                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------- |
| `DONE`       | Implemented in trunk and covered by relevant tests/checks.                                  |
| `PARTIAL`    | Useful implementation exists, but target semantics are incomplete.                          |
| `MISSING`    | Target surface/package does not exist yet.                                                  |
| `DIVERGENT`  | Current application code bypasses or duplicates the target boundary and should be migrated. |
| `UNRESOLVED` | Requirement is known but exact secure contract intentionally remains open.                  |

## 2. Executive status

```yaml
foundation:
  workspace_tooling: DONE
  typecheck_lint_format_build: DONE
  unit_integration_tests: DONE
  browser_e2e_baseline: DONE

core:
  plain_text_crdt: DONE
  operation_aware_edits: DONE
  save_load_clone: DONE
  duplicate_idempotence: DONE
  concurrent_convergence: DONE
  public_automerge_type_isolation: PARTIAL
  snapshot_merge_api: DONE
  structured_document_model: MISSING

protocol:
  v1_envelope: DONE
  strict_validation: DONE
  binary_codec: DONE
  chunking_reassembly: DONE
  in_memory_dedup: DONE
  wire_path_integration: DONE
  typed_control_payloads: DONE
  persistent_dedup: DONE
  authenticated_access_controls: DONE

transport:
  public_byte_contract: DONE
  deterministic_simulation: DONE
  delay_reorder_duplicate_drop: DONE
  offline_reconnect_model: DONE
  metrics_recovery_signal: DONE
  browser_websocket_adapter: DONE
  production_sidecar_endpoint: PARTIAL
  durable_delivery: intentionally_not_transport_responsibility

storage:
  package: DONE
  memory_adapter: DONE
  indexeddb_baseline: DONE
  defensive_snapshot_and_queue_bytes: DONE
  atomic_snapshot_plus_outbound: DONE
  durable_attempt_state: PARTIAL
  durable_seen_message_ledger: DONE
  access_control_state: DONE
  migration_recovery_tests: MISSING
  restart_recovery: DONE

client_sdk:
  package: DONE
  browser_replica_session_precursor: DONE
  protocol_storage_transport_orchestration: DONE
  durable_reconnect_replay: DONE
  typed_session_status_events: DONE
  snapshot_recovery: DONE

sidecar:
  package: DONE
  basic_health_api: DONE
  browser_websocket_bridge: DONE
  signal_cli_http_sse_adapter: DONE
  signal_cli_v0_14_7_contract_audit: DONE
  startup_best_effort_version_group_visibility_checks: DONE
  protocol_validation_routing: DONE
  chunking_reassembly_dedup: DONE
  configured_final_signal_body_boundary: DONE
  bounded_send_retries_backoff: DONE
  pre_acceptance_recovery_signal: DONE
  sse_reconnect_backoff: DONE
  account_aware_receive_filter: DONE
  localhost_origin_hardening: DONE
  strict_runtime_document_group_config: DONE
  bounded_chunk_accumulator: DONE
  sidecar_test_gate: DONE
  real_signal_e2e: PARTIAL

web_app:
  local_two_replica_demo: DONE
  local_browser_e2e: DONE
  uses_core_package: DONE
  uses_transport_package: DONE
  uses_protocol_on_runtime_path: DONE
  uses_indexeddb_storage: DONE
  browser_replica_session: DONE
  uses_target_client_sdk: DONE
  identity_registration: DONE
  encrypted_wire_codec: DONE
  sync_log_panel: DONE
  sync_mode_toggle: DONE
  share_invite_dialog: DONE
  websocket_sidecar_runtime_mode: PARTIAL
  signal_backed: MISSING

access_and_product_semantics:
  role_model_target: specified
  enforced_roles: DONE
  membership_authentication: DONE
  archive_delete_semantics: DONE
  structured_blocks_comments_attachments: MISSING
```

## 3. Verified repository baseline

Phase-2 verification on 2026-08-20 records this current repository state:

```text
version/type/build:
  -> version check: 0.0.2 across 10 workspaces
  -> all workspace typechecks pass
  -> Biome check/format gate: 123 files clean
  -> production Vite build passes

phase-2 focused Vitest evidence:
  -> recovery + deterministic client + production-style encrypted client + sidecar contracts
  -> 8/8 files, 54/54 tests pass

full Vitest gate:
  -> 94/94 files, 826/826 tests pass

browser E2E (isolated E2E_COL_TEST_TOY_PORT):
  -> Chromium: 6/6 scenarios pass
  -> Firefox:  6/6 scenarios pass
  -> combined: 12/12 scenarios pass
  -> WebKit: launch blocked before test execution because this Arch host lacks
             Playwright fallback dependencies libicu74, libxml2, and libflite1
```

The code/type/unit/integration/build gates are green. Browser runtime evidence is
green for Chromium and Firefox. WebKit remains a configured target rather than
local execution evidence on this host; the suite was not weakened or skipped to
hide the missing runtime libraries. A real two-account linked-device Signal smoke
test also remains external production evidence rather than a local CI claim.

The integration suite now contains both deliberately deterministic access-control
coverage and a production-style encrypted mock-Signal path:

```text
IdentityClient.register()/openSession()
  -> recipient-bound X25519/HKDF/AES-GCM + Ed25519 envelope
  -> MockSignalTransport
  -> ephemeral toy Signal WebSocket fanout
  -> recipient IdentityClient.decryptEnvelope()
  -> CollaborativeClient / DocumentSession
  -> CRDT apply
  -> convergence
```

The persistent-browser restart scenario separately proves document/identity state,
the durable seen-message ledger, and queued outbound replay survive a full profile
close/reopen.

## 4. `@e2e-col/core`

Overall status: **DONE for the current plain-text CRDT substrate; PARTIAL versus
the target app-facing contract**.

### 4.1 Implemented exports

Current public exports:

```ts
export { CollaborativeDocument }
export type { DocumentChange, DocumentSubscriber, TextEdit }
```

Current `CollaborativeDocument` supports:

```ts
constructor(initialState?: Uint8Array)
getText(): string
getHeads(): Automerge.Heads
subscribe(listener: (text: string) => void): () => void
editText(nextText: string): DocumentChange[]
spliceText(edit: TextEdit): DocumentChange[]
applyChanges(changes: readonly DocumentChange[]): boolean
save(): Uint8Array
clone(): CollaborativeDocument
```

### 4.2 Verified behavior

`DONE`:

- operation-aware text splices rather than whole-document overwrite;
- save/load round trip;
- concurrent inserts converge;
- overlapping concurrent edits converge;
- duplicate change application is idempotent;
- three-way/multi-peer behavior is exercised by the shared testing harness.

### 4.3 Target gaps

`PARTIAL`:

- `getHeads()` currently exposes `Automerge.Heads`; target API should normalize
  this behind `DocumentHeads`.
- `subscribe()` currently emits only text; target emits a `DocumentView`.
- `applyChanges()` returns boolean rather than a structured `ApplyResult`.

`MISSING`:

- `DocumentSnapshot` public alias;
- `DocumentView`;
- `getView()`;
- `mergeSnapshot()` that merges rather than replaces concurrent local state;
- block/list/comment/attachment operations.

### 4.4 App guidance

Application teams may safely treat `DocumentChange` as opaque bytes and model a
plain-text editor, but SHOULD wrap current `CollaborativeDocument` behind their
own temporary session/view-model rather than bind component architecture to the
current subscriber signature.

## 5. `@e2e-col/protocol`

Overall status: **DONE for generic envelope v1; MISSING typed product control
payloads**.

### 5.1 Implemented

`DONE`:

- `PROTOCOL_VERSION = 1`;
- supported envelope kinds:
  - `automerge-change`;
  - `snapshot`;
  - `membership`;
  - `archive`;
  - `delete`;
  - `health`;
  - `chunk`;
- UUID validation for document/message IDs;
- sender ID bounds;
- sequence/timestamp safe-integer checks;
- unknown-field rejection;
- binary magic/version/kind/flag codec;
- payload size enforcement;
- chunk metadata validation;
- deterministic chunk/reassembly;
- duplicate chunk conflict rejection;
- in-memory `DedupCache` with TTL and capacity limits;
- random UUID helper through `crypto.randomUUID()`.

### 5.2 Verified integration

`DONE`:

- encoded CRDT changes converge across duplicate/reordered transport delivery;
- protocol dedup prevents repeat application on the wire path;
- malformed raw bytes are rejected before entering `CollaborativeDocument`.

### 5.3 Target gaps

`MISSING`:

- typed payload schema/codec for `membership`;
- typed lifecycle codec for `archive`/`delete`;
- stable health/control payload schema;
- persistent seen-message ledger;
- stream/incremental chunk accumulator for long-lived sidecar operation if
  needed beyond batch `reassembleChunks()`.

`UNRESOLVED`:

- authenticated membership proof format;
- precise authorization-validation API.

### 5.4 App guidance

Apps may rely on envelope v1 for generic data framing. They MUST NOT ship
independently invented membership/archive/delete payload formats. Those kinds
are reserved but not product-ready.

## 6. `@e2e-col/transport`

Overall status: **DONE for Track C and suitable as the low-level target transport
boundary**.

### 6.1 Implemented exports

`DONE`:

```ts
CollaborativeTransport
ObservableCollaborativeTransport
TransportConnectionState
TransportMetrics
TransportRecoveryRequired
DeterministicTransportNetwork
SimulatedTransport
FaultDirective
createLoopbackPair
WebSocketTransport
```

### 6.2 Deterministic network behavior

`DONE`:

- virtual time;
- configured base latency;
- deterministic per-send delay;
- deterministic duplication;
- explicit hold/release;
- FIFO/LIFO release for deterministic reorder testing;
- frame drop injection;
- offline inbound retention;
- offline outbound memory queue;
- reconnect flush;
- per-document isolation;
- defensive byte copies;
- one-document binding;
- idempotent repeated online connect;
- delayed published frames can arrive after sender shutdown;
- metrics;
- recovery-required signal on intentional loss;
- invalid fault schedule validation.

### 6.3 Browser WebSocket behavior

`DONE`:

- one-document binding;
- binary mode;
- document ID query binding;
- disconnected outbound memory queue;
- reconnect state transitions;
- malformed/non-binary inbound drop accounting;
- close-before-open rejection;
- injectable socket factory for testing.

### 6.4 Target gaps/refinements

`PARTIAL`:

- `TransportRecoveryRequired.reason` currently only has `dropped-frame`; target
  may widen it.
- WebSocket metrics cannot report remote delivery, by design.
- WebSocket queue is in memory only; this is acceptable for the transport but
  insufficient for the production client without storage.

`MISSING` outside the package:

- the actual localhost sidecar endpoint that `WebSocketTransport` should connect
  to.

### 6.5 App guidance

Applications SHOULD NOT call `WebSocketTransport` directly once
`@e2e-col/client` exists. If a prototype does, it MUST send encoded protocol
frames rather than raw Automerge changes.

## 7. `@e2e-col/testing`

Overall status: **DONE for current core/protocol/transport convergence baseline**.

### 7.1 Implemented

`DONE`:

- `CollaborativeScenario` composing real core + deterministic transport;
- benchmark-derived `off`, `fast`, `slow` latency profiles;
- duplicate/reorder convergence scenarios;
- offline catch-up;
- recovery-signal scenario;
- full core + protocol + transport encoded wire path;
- malformed-wire rejection test.

The upstream benchmark throughput metadata is retained, but the deterministic
simulator currently models latency/faults rather than bandwidth throttling. This
is explicitly documented rather than silently approximated.

### 7.2 Target gaps

Now covered at baseline level:

- memory + IndexedDB snapshot/queue behavior;
- browser session persistence path;
- package-local sidecar bridge/parser tests exist.

Still `MISSING` or `PARTIAL`:

- IndexedDB corruption fixture and typed recoverable corruption error path;
- opt-in real Signal two-machine smoke profile;
- broader access-control/adversarial frame scenarios.

Now verified include atomic snapshot+outbound rollback, durable attempted-queue
restart replay, snapshot/checkpoint recovery from a known dropped increment, and
toy signal-cli HTTP JSON-RPC/SSE contract coverage including two-sidecar chunked
round trips.

## 8. `@e2e-col/storage`

Overall status: **DONE for the current durable client contract; broader
corruption-recovery hardening remains**.

### 8.1 Implemented baseline

Current exports include:

```ts
StoredDocument
OutboundRecord
CollaborativeStorage
DurableCollaborativeStorage
SeenMessage
MemoryCollaborativeStorage
IndexedDbStorageOptions
IndexedDbCollaborativeStorage
```

`DONE`:

- snapshot persistence in memory and IndexedDB;
- outbound-record persistence in memory and IndexedDB;
- document listing/deletion;
- outbound listing/removal;
- defensive byte cloning;
- atomic post-edit snapshot + outbound commits;
- durable inbound seen-message ledger with configurable TTL pruning;
- durable send-attempt metadata and safe checkpoint-driven queue compaction;
- schema-v3 migration adding the `seenAt` pruning index;
- fake-IndexedDB tests for snapshots, outbound records, atomic rollback,
  restart dedup, TTL expiry, and migration.

### 8.2 Remaining storage hardening

`REMAINING`:

- corruption fixtures for malformed/incompatible durable state with a typed,
  recoverable storage error path;
- production retry/backoff policy above the persisted attempt counters.

`commitLocalChange()`, `persistRemoteState()`, and `commitAccessChange()` use
multi-store transactions and explicitly abort on synchronous write-setup
failure. `DocumentSession` consults `hasSeen()` before applying an inbound frame,
and prunes expired durable IDs before it subscribes/connects on open.

The current `acknowledgeOutbound(id)` physically removes a record. In the target
contract, callers MUST NOT use a successful `transport.send()` alone as proof
that removal is safe, because a WebSocket write does not mean another replica
received or merged the message.

### App guidance

Apps SHOULD depend on `DurableCollaborativeStorage`; both memory and IndexedDB
implementations satisfy that interface for the current client SDK.

## 9. `@e2e-col/client`

Overall status: **DONE for the current reusable client/session baseline**.

`@e2e-col/client` now provides `CollaborativeClient` + `DocumentSession` and
composes the real core, protocol, durable storage, identity adapter, and shared
transport packages. It validates and durably deduplicates inbound envelopes,
uses atomic local persistence, replays durable outbound work, enforces access
state, and publishes/merges recovery snapshots.

Current public baseline:

```text
CollaborativeClient
DocumentSession
SessionStatus
DocumentSessionEvent
TransportFactory
ClientError
local edit atomic persistence path
inbound validation/dedup/apply path
reconnect replay
snapshot recovery
access-state projection
```

## 10. `apps/sidecar`

Overall status: **PARTIAL: the first real localhost bridge and signal-cli adapter
exist, but Track E hardening and release evidence are not complete**.

### 10.1 Implemented baseline

`DONE` in the current code:

- `BroadcastBackend` abstraction plus memory backend;
- `SidecarBridge` HTTP/WebSocket process;
- default sidecar bind to `127.0.0.1`;
- configured document-ID -> Signal-group mapping;
- browser binary protocol decoding/validation before broadcast;
- `e2e-col:v1:` Signal message namespace;
- outbound `chunkEnvelope()` support;
- inbound validation, deduplication, chunk accumulation, and `reassembleChunks()`;
- browser forwarding after logical-frame reconstruction;
- bounded send-attempt loop;
- `SignalCliHttpBackend` health probe, JSON-RPC send, and SSE receive parser;
- account parameter support for sends;
- generic/sanitized final send-failure log.

Current prototype endpoints are:

```text
GET /health
WS  <upgrade URL>?documentId=<configured-document-uuid>
```

The target spec intentionally normalizes these later to versioned `/api/v1/...`
routes.

### 10.2 Remaining Track E/hardening gaps

The review follow-ups now implemented include:

- exponential send retry delay;
- SSE reconnect/backoff;
- account-aware receive filtering;
- fail-closed loopback checks unless remote use is explicitly enabled;
- WebSocket Origin filtering;
- separate physical/logical deduplication to suppress Signal sync echoes;
- bounded/TTL-pruned chunk accumulation with duplicate-conflict handling.

Still `MISSING` or requiring stronger evidence:

- retryable-versus-terminal real Signal error classification is still coarse;
- real linked-device Signal E2E.

### 10.3 Test gate

The toy contract gate is runnable and green. `contract.test.ts` /
`contract-api.test.ts` verify health, JSON-RPC group/send/error semantics and SSE;
`signal-cli.test.ts` covers health failure, event parsing, account filtering and
reconnect; `bridge.test.ts` covers namespace/chunk/dedup/retry/origin behavior;
and `sidecar-e2e.test.ts` drives two real sidecars through an ephemeral toy daemon
over HTTP/SSE, including chunk reassembly and injected retry. Phase-2 focused
verification passes these five files together.

### Security gate

A sidecar is not production-complete until loopback/origin policy, reconnect
behavior, tests, logs, and health responses are verified to exclude credential
material and plaintext document payloads by default.

## 11. `apps/web`

Overall status: **PARTIAL production-path integration: the app now uses shared
core/protocol/storage/transport packages, but the reusable client facade and
sidecar runtime mode remain**.

### 11.1 Done

`DONE`:

- Vite + React application;
- independent Automerge replicas;
- shared `DeterministicTransportNetwork` from `@e2e-col/transport`;
- encoded `ProtocolEnvelope` runtime path;
- IndexedDB snapshot/outbound storage;
- `BrowserReplicaSession` orchestration precursor;
- production build;
- Playwright rendering and synchronization scenarios.

The previous app-local `LoopbackBus` / duplicate `CollaborativeTransport` has
been removed.

### 11.2 Remaining migration

The web app defaults to the deterministic local network for the self-contained
demo and selects `WebSocketTransport` when `VITE_E2E_COL_SIDECAR_URL` is set.
`BrowserReplicaSession` should still be extracted/generalized into the target
`@e2e-col/client` API before applications treat the app-local session class as a
stable SDK surface.

Its current UI exposes a boolean connected state rather than the target
ready/offline/syncing/recovering/error session model.

### 11.3 Required target shape

The web app target is:

```text
React component
  -> DocumentSession
  -> @e2e-col/client
       -> @e2e-col/core
       -> @e2e-col/protocol
       -> @e2e-col/storage
       -> @e2e-col/transport
            -> loopback/deterministic in dev
            -> WebSocketTransport in companion mode
```

The local demo MAY remain as a development mode, but it SHOULD use the same
client/session facade as production so local testing exercises the same
orchestration path.

## 12. Snapshot/checkpoint recovery

Overall status: **DONE for provable recovery signals; generic v1 sequence-gap
inference is intentionally unsupported**.

Implemented and verified:

- `CollaborativeDocument.mergeSnapshot()` full-state merge;
- durable snapshot publication/retention through `DocumentSession.publishSnapshot()`
  and transport recovery signals;
- atomic checkpoint persistence with a replayable retained snapshot;
- CRDT-only queue/history compaction that preserves membership/archive/delete
  records;
- writer/admin checkpoint publication plus reader recovery;
- deterministic dropped-increment -> recovery -> snapshot -> convergence;
- recovery flags clear only after checkpoint publication or accepted snapshot
  merge, not after an unrelated successful send.

The current envelope `sequence` cannot safely prove a missing CRDT increment: it
is optional, session-local/resettable, spans non-CRDT logical kinds, and lacks a
sender epoch or predecessor chain. The strongest safe baseline therefore reacts
to trustworthy transport recovery signals. Production signal-cli integration must
surface such known-loss/reset conditions, or a future protocol version must add
causal predecessor metadata before receiver-side gap detection is enabled.

## 13. Access control and lifecycle semantics

Overall status: **wire kinds reserved; enforcement MISSING; proof format
UNRESOLVED**.

Already reserved in protocol:

```text
membership
archive
delete
```

Target app model now specifies:

```text
reader
writer
admin
participant list
archived state
deleted/tombstoned state
```

Still required:

- authenticated membership transition schema;
- sender identity binding;
- authorization check before CRDT apply;
- admin-only participant/lifecycle operations;
- replay/rollback protection for control state;
- documented retained-copy semantics;
- adversarial tests.

Apps MAY design role-aware UI but MUST feature-gate enforcement claims until
these are complete.

## 14. Structured editor API

Overall status: **MISSING by deliberate roadmap order**.

Current core document state is plain text. This was intentional so convergence,
protocol, transport, persistence, and access semantics could be hardened first.

Future APIs are expected for:

- block paragraphs;
- headings;
- lists;
- links;
- comments/annotations;
- suggestions;
- history/timeline;
- attachment references.

App teams SHOULD isolate rendering/edit commands behind a local editor model so
plain-text `spliceText()` is not embedded throughout component trees.

## 15. Application readiness matrix

| Application type                 | Can design now?         | Can implement useful UI now? | Can securely ship now?                  | Recommended target                                           |
| -------------------------------- | ----------------------- | ---------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| Local collaborative text demo    | Yes                     | Yes                          | Development only                        | `DocumentSession` over deterministic transport               |
| Offline-first personal editor    | Yes                     | Yes                          | Not until atomic durability is complete | `DocumentSession` + `DurableCollaborativeStorage`            |
| Browser + localhost companion UX | Yes                     | Yes against current bridge   | Not until sidecar hardening is complete | `DocumentSession` + `WebSocketTransport`                     |
| Signal-backed two-user prototype | Yes                     | Partial                      | No real-Signal release evidence yet     | sidecar + client + durable storage                           |
| Role-aware shared document UI    | Yes                     | Yes behind flags             | No                                      | `DocumentAccessState` target                                 |
| Production secure collaboration  | Yes                     | Architecture + prototype     | No                                      | client + durable storage + hardened sidecar + R6 + hardening |
| Structured/rich editor           | Yes at view-model layer | Prototype                    | No stable content API yet               | isolate editor operations from current plain-text core       |

## 16. What application teams should target immediately

Use these target contracts as seams even before their packages are implemented:

```ts
DocumentSession
DocumentView
SessionStatus
DocumentAccessState
DurableCollaborativeStorage
TransportFactory
```

`BrowserReplicaSession` is already a temporary implementation of much of this
composition. New app work should treat it as a precursor to extract, not as the
final public SDK surface.

Do not make these current implementation details part of an app's architectural
contract:

```text
Automerge.Heads
BrowserReplicaSession as a cross-app public contract
raw Automerge bytes over production WebSocket
`acknowledgeOutbound()` immediately after WebSocket send
in-memory-only transport outbound queue
in-memory-only DedupCache as restart correctness
signal-cli JSON-RPC details in UI code
```

## 17. Recommended implementation sequence

The most app-enabling order from the current state is:

```text
API-01  Freeze core target aliases/result/view types
   │
   ├─ API-02  Extend CollaborativeStorage -> DurableCollaborativeStorage
   │            ├─ atomic snapshot + outbound commit
   │            ├─ persistent dedup ledger
   │            └─ durable attempt/checkpoint metadata
   │
   ├─ API-03  Extract BrowserReplicaSession -> @e2e-col/client
   │            ├─ DocumentSession facade
   │            ├─ typed status/events
   │            ├─ durable reconnect replay
   │            └─ transport factory
   │
   ├─ API-04  Add snapshot merge + checkpoint recovery
   │
   ├─ API-05  Switch apps/web to @e2e-col/client
   │            └─ add WebSocket sidecar runtime mode
   │
   ├─ API-06  Finish sidecar Track E hardening/test gate
   │            └─ real Signal integration smoke
   │
   └─ API-07  Freeze authenticated access-control payloads and enforcement
                │
                └─ production/security hardening
```

Storage durability, sidecar hardening, and app UI work can proceed concurrently
once the `DocumentSession` facade and `DurableCollaborativeStorage` seam are
frozen/mocked.

## 18. Acceptance gates for an app-facing API freeze

Before labeling the client API stable enough for separate app repositories, the
following should pass:

```yaml
client_contract:
  - DocumentSession can be mocked without importing Automerge
  - components receive DocumentView and SessionStatus only
  - transport can be swapped through TransportFactory
  - storage can be swapped through DurableCollaborativeStorage

local_first:
  - local edit persists snapshot and outbound envelope atomically
  - browser restart restores state
  - pending outbound work replays after restart
  - duplicate replay remains harmless

wire:
  - all remote bytes decode/validate before CRDT apply
  - wrong document ID is rejected
  - unsupported protocol version fails closed
  - malformed wire data leaves document unchanged

recovery:
  - dropped incremental history can recover via merged snapshot
  - snapshot recovery preserves concurrent unsent local edits
  - queue/history compaction has tests

sidecar:
  - localhost API matches WebSocketTransport contract
  - sidecar restart returns client to offline then ready/syncing
  - Signal adapter round-trip works between two linked devices

security:
  - browser contains no Signal credentials
  - diagnostics exclude plaintext/credential payloads by default
  - unauthorized control/edit frames are rejected once R6 is enabled
```

## 19. Current bottom line

The repository has moved beyond a conceptual PoC: the CRDT, protocol framing,
deterministic/WebSocket transport, storage baseline, app-local session
orchestration, and first Signal sidecar bridge are now real code.

The remaining work is primarily **production-boundary hardening**: real
`signal-cli` integration/evidence, authenticated access-control review and causal
replay semantics, storage corruption recovery, richer offline UX, and later
feature/platform work. Atomic local durability, durable dedup, checkpoint recovery,
and the reusable `@e2e-col/client` session facade are now implemented baselines.

Application teams can build against `DocumentSession` plus
`DurableCollaborativeStorage` without owning protocol, IndexedDB, checkpoint, or
mock-Signal orchestration details. Production release claims must still wait for
the real Signal and R6 security gates.
