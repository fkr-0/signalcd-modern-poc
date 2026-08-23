# Roadmap

Status: **2026-08-22**
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
| Access control | Complete (R6) | Authenticated root + durable causal chain + signed fork resolution implemented |
| Client SDK | Done | — |
| Storage | Good | Corruption-recovery fixtures remain |
| Transport | Good | — |
| Mock sidecar | Solid | Debug decrypt key boundary |
| Web app | Functional | Multi-document, offline UX |
| Production sidecar | Partial | signal-cli v0.14.7 boundary audited; live two-account evidence unavailable |
| Android | Phase 1 proxy complete | M1 CRDT/process-restore evidence and M2 native E2EE remain |

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
- The ledger is no longer the authorization-security boundary. Control payload v2
  has an independently durable authorization head/history, so a stale signed
  membership/archive/delete control remains stale after the 24-hour dedup entry is
  pruned and across an IndexedDB close/reopen.

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

- **Status:** R6 complete for the repository's authenticated-identity trust model
  (2026-08-21): shared signed bootstrap, replay-safe causal ordering, and signed fork
  reconciliation are implemented and adversarially tested across durable restart.
- A canonical authorization-root v1 binds the document id, creator/admin identity,
  sorted initial participant ids/roles/active state, and each participant's SHA-256
  Ed25519 identity-key commitment. The creator signs the canonical root and its
  SHA-256 commitment becomes the durable authorization anchor/head at revision 0.
  Root minting is permitted only by the explicit local `createDocument()` path;
  shared-group `openDocument()` never derives root-creation authority from
  `created_by`, group membership, or an empty evidence cache. The production web
  bootstrap starts creator-only; other participants become authoritative only
  through a signed membership invite.
- Membership/archive/delete control payload v2 signs the document id, positive
  authorization revision, 32-byte predecessor commitment, actor, timestamp, and
  kind-specific semantic fields. Authenticated invites use membership payload v3 so
  the invite additionally binds the target identity-key commitment. The outer
  `ProtocolEnvelope` remains v1 and existing kind codes remain stable.
- A fresh replica verifies the root signature and every root participant key
  commitment from authenticated identity material before installing authority.
  Late joiners verify the root and replay signed control/resolution evidence to the
  supplied head; CRDT bootstrap remains independent. An established replica rejects
  bootstrap root/head metadata that conflicts with its durable authorization state.
  Group membership and the toy authorization-evidence endpoint are discovery/cache
  data, not plaintext ACL authority.
- The authorization head/history survives restart, seen-message TTL pruning, CRDT
  snapshots, and CRDT-only checkpoint compaction. Signers are authorized against the
  signed predecessor ACL; verified-root controls also re-check the actor's bound
  identity key, so a later directory-key substitution cannot silently gain authority.
- Valid future descendants are durably buffered. Same-predecessor valid forks freeze
  at the common predecessor. Resolution is a separate signed causal transition that
  binds the common predecessor, exact competing control commitments, deterministic
  resulting ACL commitment, and new head. It requires the exact unanimous set of
  active pre-fork admins and at least two independent admins; a single-admin fork
  therefore remains fail-closed. Delete branches are terminal and take deterministic
  precedence; otherwise the canonical control commitment chooses the branch, never
  arrival order or server preference. Resolution evidence is replay-safe,
  out-of-order bufferable, and durable across IndexedDB close/reopen.
- Legacy control payload v1 remains rejected. Persisted revision-0 and revision>0
  states migrate only to explicit `legacy-zero-genesis` / `legacy-local-anchor`
  states and are never relabeled as a verified shared root without a migration proof.
  `ProtocolEnvelope.sequence` remains diagnostic/session-local and unrelated to
  authorization ordering.
- Chromium and Firefox both exercise encrypted creator -> signed invite -> verified
  late-join bootstrap -> archive/unarchive and prove the browser profiles converge on
  the same authenticated root/head.
- **Remaining security/deployment limits (not an R6 downgrade):** first-contact trust
  still depends on authenticated identity-key material (a Byzantine identity directory
  before any key is pinned is not solved here), and an untrusted bootstrap cache can
  censor evidence or replay a previously valid signed prefix to a brand-new device
  unless an external freshness/transparency mechanism pins a newer head. It cannot
  forge a valid root/control/resolution or roll back an established durable replica.
  R5 live two-account real-Signal evidence remains separately unavailable.

## 2. Feature gaps (post-v0.0.2)

### 2.1 Multi-document support

- **Status:** Complete for the P2 local-library scope (2026-08-22).
- `CollaborativeClient.createDocument()` / `openDocument()` / `listDocuments()` plus
  the web Local library create, list, open, and switch independent local documents;
  the active UUID remains reflected in `?document=<uuid>`.
- `CollaborativeClient.updateDocumentMetadata()` now updates the local display title
  without changing immutable `documentId`, CRDT snapshot bytes, collaboration-group
  binding, authorization root/head/revision, participant ACL, or outbound history.
  Titles are explicitly **device-local library metadata**, not CRDT/network state and
  therefore do not converge to other devices automatically.
- Titles are trimmed, single-line, and bounded to 200 JavaScript string code units;
  `null` or an empty/whitespace-only value clears the title and list/editor UI falls
  back deterministically to `Document <first-8-uuid-chars>`. Unknown additive metadata
  fields are preserved.
- The storage update is atomic in IndexedDB. CRDT/local and remote snapshot writes
  preserve the already-durable metadata lane, so an open session with stale cached
  metadata cannot race a rename and overwrite it. Failed metadata transactions leave
  the prior title and snapshot intact.
- Group-bound workspaces stay pinned to their bound UUID: `New`, switching, and rename
  controls for unrelated local documents are disabled. Renaming the bound document is
  allowed because it is local metadata only and does not retarget the group.
- Unit/storage coverage proves two-document UUID/content isolation, rename/clear,
  additive-field preservation, invalid/oversized rejection, lifecycle/authorization
  non-interference, and IndexedDB restart durability. Playwright additionally proves
  create -> title -> switch -> browser-profile restart -> restored titles/content and
  group-bound UUID pinning in Chromium and Firefox.
- **Remaining multi-document product work:** richer organization/search and local
  document-management UX are not part of this P2 slice. The next roadmap slice is
  §2.2 offline-first UX.

### 2.2 Offline-first UX

- **Status:** Complete for the defined offline-first UX contract (2026-08-22).
- **Delivered:** Local editing remains durable while the session transport is offline; the workspace
  shows queued-local depth, distinguishes ordinary replay from snapshot/checkpoint recovery, and
  exposes durable reconnect/restart replay progress from `SessionStatus.replay`.
- **Replay semantics:** `completed / total` counts durable records successfully handed to the local
  transport during that replay batch. It is deliberately not described as peer acknowledgement or
  remote merge confirmation.
- **Conflict indicator:** The UI surfaces the existing fail-closed R6
  `authorizationStatus: conflict` state. Automerge convergence is not relabeled as a synthetic CRDT
  conflict detector.
- **Proof:** Deterministic client lifecycle coverage edits after an actual transport disconnect and
  observes durable queue depth plus ordered reconnect replay progress. Persistent-browser coverage
  proves queued work survives profile restart, replays with the same durable outbound identity, and
  reports replay completion without weakening dedup or authorization state.
- **Remaining §2.2 gaps:** None for the roadmap target above. Automatic retry/backoff policy for
  production transports remains transport/reliability work rather than a user-facing sync-state
  semantic.

### 2.3 Structured document model

- **Current:** Plain text only (`CollaborativeDocument.getText()`)
- **Target:** Block/list/comment/attachment operations
- **Gap:** No structured CRDT model; transport/protocol remain structure-agnostic
- **Reference:** `TARGET-API-SPEC.md` §5.3

### 2.4 Key rotation lifecycle

- **Status:** Prekey lifecycle complete for P2 (2026-08-22); authenticated identity-key
  rebinding remains intentionally unresolved.
- **Implemented:**
  - `IdentityClient.openSession()` consumes the provider's current signed-prekey and
    pool-health claim. A provider-triggered signed-prekey rotation is staged in local
    key storage before publication, signed by the unchanged Ed25519 identity key, and
    finalized only after the provider accepts the exact public material.
  - The toy identity provider requests rotation once the current signed prekey is
    seven days old. Retired signed-prekey private material is kept locally so delayed
    encrypted envelopes addressed by the existing public-key selector remain
    decryptable after rotation.
  - One-time prekeys replenish automatically when the provider pool falls below five,
    targeting ten available public prekeys. Newly generated private material is
    persisted before upload; interrupted publication is idempotently retried on the
    next session open.
  - The outer `ProtocolEnvelope` remains v1 and the existing encrypted-envelope key
    selector carries rotation without a wire-version change.
- **Authorization invariant:** the long-term Ed25519 identity key is unchanged by this
  lifecycle. Existing R6 root/member commitments and historical control signatures
  therefore keep the same authenticated identity binding.
- **Remaining §2.4 gap:** true identity-key rotation is not safe to add as a directory
  overwrite: R6 commits the current authenticated Ed25519 key and re-checks actors
  against that commitment. A future identity-key rotation must define an explicit
  authenticated rebind/re-verification transition (including historical-signature
  verification) before the directory or browser may replace that key.

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

- **Status:** P3 Phase 1 sidecar proxy complete (2026-08-22; `docs/android-integration.md`).
- The existing native scaffold now has a fail-closed localhost-first sidecar transport:
  `ws://`/`wss://` endpoints only, exactly one document binding, no URL credentials
  or invented auth frame, explicit remote opt-in with mandatory `wss://`, binary
  frames, truthful connection state, and browser-parity recovery semantics where
  only close code `4409` is explicit transport-history-risk evidence.
- Phase 1 intentionally does **not** wire the Compose draft to outbound CRDT traffic.
  The native encrypted `E2EE`/Keystore layer is still M2 work, so enabling production
  document sends now would weaken the established client-side encryption boundary.
- **Remaining Android milestones:** M1 still needs JS↔JVM Automerge interop fixtures,
  process-death restore evidence, two-client sidecar convergence, and
  `DocumentSession`/Compose integration. M2 then supplies native identity/encrypted
  envelope parity. Background reliability/recovery UX remains M3/M4.
- Direct/on-device Signal integration remains the later M5 feasibility path; Phase 1
  does not access Signal internals or provision/link accounts.

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

- **Status:** Complete for R6 in Chromium and Firefox (2026-08-22).
- The encrypted browser proof starts from an explicitly locally created,
  creator-signed authorization root, binds that already-durable root to the untrusted
  collaboration-group evidence cache, then exercises signed invite -> verified late
  join -> archive/unarchive. Both browser profiles persist the same verified root and
  authorization head; group `created_by` metadata is not root-minting authority.
- Role/remove browser UX remains useful future product coverage, but it is no longer
  an R6 authorization-proof blocker because the lifecycle-control path exercises the
  same authenticated predecessor/head machinery required by the roadmap acceptance.

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

- **Status:** Implemented for the public TypeScript packages in the 0.0.3 release-prep slice.
- `pnpm run api:docs` generates TypeDoc for `@e2e-col/client`, `@e2e-col/core`, `@e2e-col/identity`, `@e2e-col/protocol`, `@e2e-col/storage`, and `@e2e-col/transport`.
- GitHub Pages publishes the generated reference under `/api/`; the release workflow also archives the generated API documentation as a tagged artifact.

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
  5. Authenticated access control review (R6 complete for authenticated-identity model)
  6. Integration test (full E2EE mock-Signal path complete)

P2 (feature completeness):
  7. Multi-document UI
  8. Offline-first UX
  9. Key rotation lifecycle (prekey lifecycle complete; identity-key rebind gap above)
  10. Persistent dedup (complete)

P3 (platform extension):
  11. Android app (Phase 1: sidecar proxy) (complete)
  12. Desktop app

P4 (future):
  13. Structured document model
  14. iOS app
  15. Double Ratchet (if forward secrecy beyond per-session is needed)
```
