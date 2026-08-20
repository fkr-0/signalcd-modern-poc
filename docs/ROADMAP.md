# Roadmap

Status: **2026-08-20**  
Current release: **v0.0.2**

This document tracks implementation gaps, future features, and production
readiness milestones beyond the current v0.0.2 state.

## Current state summary

| Area | Status | Key gap |
|------|--------|---------|
| CRDT core | Solid | Structured document model missing |
| Protocol | Solid | — |
| Identity | Solid | Key rotation lifecycle missing |
| Encryption | Solid | — |
| Access control | Done | Authenticated proof format unresolved |
| Client SDK | Done | — |
| Storage | Good | Corruption-recovery fixtures remain |
| Transport | Good | — |
| Mock sidecar | Solid | Debug decrypt key boundary |
| Web app | Functional | Multi-document, offline UX |
| Production sidecar | Partial | signal-cli v0.14.7 boundary audited; live two-account evidence unavailable |
| Android | Not started | Spec only |

## 1. Production gaps (must-fix before real Signal)

### 1.1 Sidecar: real signal-cli integration

- **Status:** Production boundary implemented and contract-audited against
  signal-cli v0.14.7 (2026-08-20); live two-account evidence remains pending.
- `SignalCliHttpBackend` now verifies `/api/v1/check`, active/unblocked membership
  of every configured group, and a usable initial `text/event-stream` subscription
  before browser listening begins; it probes JSON-RPC `version` only best-effort
  because v0.14.7 does not document that method. JSON-RPC response IDs/errors
  (including signal-cli's observed `id:null` command-error form), the documented
  send timestamp result, automatic/manual receive wrappers, sender sync messages,
  account-scoped multi-account SSE, and reconnect parsing have focused coverage.
- Runtime configuration validates UUID → base64 group mappings, unique group
  ownership, loopback daemon/sidecar boundaries, optional exact Origin allowlists,
  and account selection. Account/device linking and group creation are deliberately
  outside default sidecar startup; production consumes preconfigured state only.
- signal-cli does not publish a stable numeric text-body boundary in the audited
  JSON-RPC manual, and v0.14.0+ can represent long text as attachments. Production
  therefore requires an explicit `E2E_COL_SIGNAL_BODY_MAX_BYTES`; sidecar chunking
  accounts for namespace, envelope, chunk metadata, and base64 overhead and tests
  every emitted body against the configured final-text boundary.
- Backend/HTTP send errors are treated as **ambiguous outcomes**, not proof that
  signal-cli failed to accept a message. After retries they close only the affected
  browser document with ordinary adapter code `1011`, preserving durable outbound
  replay without manufacturing a recovery checkpoint. Code `4409` is reserved for
  an explicit backend `BroadcastRecoveryRequiredError` proving transport-history
  risk beyond ordinary replay; the current `SignalCliHttpBackend` never emits that
  proof because no audited v0.14.7 response establishes it. `WebSocketTransport`
  maps only `4409` to `sidecar-history-risk`. Ordinary sidecar/SSE disconnects and
  v1 envelope sequence jumps remain non-evidence.
- An opt-in two-account live smoke profile exists and performs no provisioning or
  group mutation. This host has no signal-cli executable and no configured fixture,
  so the live smoke is explicitly unavailable/skipped rather than claimed green.
- **Remaining:** execute the opt-in profile with two already-linked accounts and a
  pre-existing shared group, record a deployment-specific safe text-body boundary,
  and decide whether future v1 receive support should fetch long-text attachments.
- **Reference:** `docs/SIDECAR-CONTRACT.md` §5

### 1.2 Storage: atomic snapshot + outbound

- **Status:** Complete (2026-08-20).
- `commitLocalChange()` uses one IndexedDB transaction for the post-edit snapshot
  and all matching outbound records.
- Injected write-failure tests prove a failed outbound write cannot leave the
  snapshot committed by itself.

### 1.3 Storage: durable seen-message ledger

- **Status:** Complete (2026-08-20).
- IndexedDB schema v3 stores durable `seen_messages` records and a `seenAt` index.
- Retention is configurable with a 24-hour default TTL; stale IDs are pruned
  before a `DocumentSession` begins processing inbound traffic and lazily when
  queried.
- Restart coverage reopens the same IndexedDB database, replays the exact same
  control envelope, and proves the access revision is not applied twice.

### 1.4 Client: snapshot recovery

- **Status:** Complete for provable recovery signals (2026-08-20).
- A transport recovery signal moves both affected sessions into `recovering`; an
  authorized writable replica durably publishes a full-state snapshot checkpoint,
  and the receiver merges that snapshot before clearing its recovery state.
- Checkpoint compaction removes only older `automerge-change`/`snapshot` records
  that the retained checkpoint subsumes. Membership, archive, and delete history is
  deliberately outside document-byte compaction.
- Deterministic loss coverage proves incremental loss -> recovery signal -> retained
  snapshot -> merge -> convergence, including reader recovery. Ordinary send
  completion no longer clears an outstanding recovery obligation.
- **Sequence ambiguity:** v1 envelope `sequence` is optional, sender-session-local,
  resets after a session restart, and spans control/snapshot traffic as well as CRDT
  changes. It has no sender epoch, predecessor hash, or per-recipient chain. A
  receiver therefore cannot safely infer a missing CRDT increment from a numeric
  jump without false positives. The client intentionally uses only trustworthy
  transport loss/recovery signals today; a future protocol version may add causal
  predecessor metadata if generic wire-gap proof is required.
- **Reference:** `TARGET-API-SPEC.md` §9.7

### 1.5 Protocol: authenticated access control proof

- **Gap:** Membership envelopes have signatures but no formal proof format
- **What's needed:**
  - Decide on signature scheme (current: Ed25519 over domain-separated signing bytes)
  - Define how recipients verify the signer's identity key is authorized
  - Cross-device consistency proof
- **Status:** Design is in `extend.yml` §4, implementation exists, formal review pending

## 2. Feature gaps (post-v0.0.2)

### 2.1 Multi-document support

- **Current:** Web app opens one document per URL (`?document=<uuid>`)
- **Target:** `CollaborativeClient.listDocuments()` → document picker → open any document
- **Work done:** `listDocuments()` API exists, web app has document list UI
- **Gap:** No document creation UI, no document metadata editing

### 2.2 Offline-first UX

- **Current:** Transport status shows online/offline
- **Target:** Full offline editing with visual queue depth, replay progress, conflict indicators
- **Gap:** No replay progress indicator, no conflict detection UI

### 2.3 Structured document model

- **Current:** Plain text only (`CollaborativeDocument.getText()`)
- **Target:** Block/list/comment/attachment operations
- **Gap:** No structured CRDT model; transport/protocol remain structure-agnostic
- **Reference:** `TARGET-API-SPEC.md` §5.3

### 2.4 Key rotation lifecycle

- **Current:** Identity key is generated once, signed prekey is static
- **Target:**
  - Signed prekey rotation (periodic, server-triggered)
  - One-time prekey replenishment (automatic when pool low)
  - Identity key rotation (rare, requires re-verification)
- **Gap:** No rotation logic, no prekey pool monitoring

### 2.5 Persistent dedup

- **Status:** Complete (2026-08-20).
- The protocol `DedupCache` remains a useful in-memory hot cache, while client
  correctness uses the durable storage ledger across browser/session restarts.

### 2.6 Durable attempt state

- **Status:** Baseline complete. Outbound records persist `state` and `attempts`,
  restart replay reuses the durable record, and Phase-2 browser evidence observes
  a pending record become the same attempted record after profile restart.
- **Remaining:** Production retry scheduling/backoff policy above the durable
  counters remains transport/client policy work.

## 3. Platform extensions

### 3.1 Android app

- **Status:** Spec written (`docs/android-integration.yml`)
- **Key challenges:**
  - Signal secret retrieval (ContentProvider / Signal's internal API)
  - Sidecar communication (localhost WebSocket or direct integration)
  - Document-channel agreement protocol
  - Background sync and notification
- **Approach:** Two-phase — first use the sidecar proxy, later direct Signal integration

### 3.2 iOS app

- **Status:** Not started
- **Key challenges:**
  - Signal secret access (App Group sharing, Keychain)
  - Background execution limits
  - App Store review for crypto apps

### 3.3 Desktop (Electron/Tauri)

- **Status:** Not started
- **Approach:** Reuse web app + sidecar; native sidecar binary

## 4. Testing gaps

### 4.1 Integration tests

- **Status:** Complete for the mock-Signal production-style composition (2026-08-20).
- Vitest registers and restores real `IdentityClient` identities, uses real
  X25519/HKDF/AES-GCM encryption plus Ed25519 validation, routes recipient-bound
  ciphertext through `MockSignalTransport`, decrypts at the peer, and converges via
  `CollaborativeClient` / `DocumentSession`. The toy daemon is also checked not to
  expose the document plaintext in inspectable state.

### 4.2 Sidecar contract tests

- **Status:** Complete for the toy signal-cli contract and production adapter
  boundary; real linked-device smoke remains externally gated (2026-08-20).
- Runnable Vitest coverage starts an ephemeral toy daemon and verifies health,
  JSON-RPC send/group semantics and errors, SSE receive parsing/reconnect behavior,
  the `e2e-col:v1:` body namespace, sender-echo suppression, bounded retries, and
  sidecar-owned chunking/reassembly across two real sidecars. Real linked-device
  `signal-cli` evidence remains the separate P0 production gap.
- Focused production-boundary tests additionally cover best-effort version and
  mandatory group startup checks, JSON-RPC ID/error handling, automatic/manual/sync receive forms,
  multi-account SSE routing, endpoint/origin safety, configured final-body chunk
  thresholds, and the explicit pre-acceptance recovery close code.
- `real-signal.smoke.test.ts` is skip-by-default and requires two already-linked
  accounts/daemons plus a pre-existing shared group; CI/local checks never require
  Signal credentials or network/account mutation.

### 4.3 Restart recovery tests

- **Status:** Complete in Chromium and Firefox (2026-08-20).
- Playwright closes a persistent browser profile and reopens the same profile,
  proving identity/document restoration, durable seen-message retention, and a
  pending outbound record surviving shutdown and replaying to convergence after
  restart. WebKit remains subject to the host runtime-library gate.

### 4.4 Multi-browser encrypted convergence

- **Gap:** Existing Playwright test covers basic convergence but not access control across browsers
- **What's needed:** Test that verifies admin invites, role enforcement, and removal across two browser contexts

## 5. Documentation gaps

### 5.1 Getting started guide

- **Current:** README has basic setup instructions
- **Gap:** No step-by-step guide for: register identity → create document → invite peer → edit together

### 5.2 Architecture decision records

- **Gap:** No ADRs for key decisions:
  - Why Automerge over Yjs?
  - Why X25519+AES-GCM over Signal's Double Ratchet?
  - Why sidecar over in-browser Signal?
  - Why per-recipient encryption over group key?

### 5.3 API reference

- **Gap:** No generated API reference for `@e2e-col/client`, `@e2e-col/protocol`, etc.
- **What's needed:** TypeDoc or similar, published to docs site

## 6. Performance considerations

### 6.1 Envelope size

- **Current:** Each edit produces one envelope per recipient (N recipients = N× envelope size)
- **Concern:** Large documents with many participants may exceed Signal body limits quickly
- **Mitigation:** Chunking exists but adds overhead; snapshot recovery reduces incremental history

### 6.2 Storage growth

- **Current:** IndexedDB stores full Automerge snapshots on every edit
- **Concern:** Unbounded growth over long editing sessions
- **Mitigation:** Full document saves replace the current stored snapshot, while
  checkpoint compaction can bound retained CRDT outbound history without deleting
  access/lifecycle records. Production checkpoint cadence still needs workload tuning.

### 6.3 Key bundle fetching

- **Current:** `fetchRemoteIdentity()` makes an HTTP call per recipient per encryption
- **Concern:** N recipients = N HTTP calls per edit
- **Mitigation:** Cache `RemoteIdentity` in IndexedDB; refresh on stale

## 7. Priority order

```
P0 (blocking production):
  1. Real signal-cli integration
  2. Atomic snapshot + outbound (complete)
  3. Durable seen-message ledger (complete)

P1 (production quality):
  4. Snapshot recovery (complete for provable loss signals)
  5. Authenticated access control review
  6. Integration test (full E2EE mock-Signal path complete)

P2 (feature completeness):
  7. Multi-document UI
  8. Offline-first UX
  9. Key rotation lifecycle
  10. Persistent dedup (complete)

P3 (platform extension):
  11. Android app (Phase 1: sidecar proxy)
  12. Desktop app

P4 (future):
  13. Structured document model
  14. iOS app
  15. Double Ratchet (if forward secrecy beyond per-session is needed)
```
