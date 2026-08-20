# Roadmap

Status: **2026-08-20**  
Current release: **v0.0.2**

This document tracks implementation gaps, future features, and production
readiness milestones beyond the current v0.0.2 state.

## Current state summary

| Area | Status | Key gap |
|------|--------|---------|
| CRDT core | Solid | Structured document model missing |
| Protocol | Solid | Persistent dedup missing |
| Identity | Solid | Key rotation lifecycle missing |
| Encryption | Solid | — |
| Access control | Done | Authenticated proof format unresolved |
| Client SDK | Done | Snapshot recovery missing |
| Storage | Good | Atomic commit, durable seen-message |
| Transport | Good | — |
| Mock sidecar | Solid | Debug decrypt key boundary |
| Web app | Functional | Multi-document, offline UX |
| Production sidecar | Not started | Real signal-cli integration |
| Android | Not started | Spec only |

## 1. Production gaps (must-fix before real Signal)

### 1.1 Sidecar: real signal-cli integration

- **Gap:** No code connects to a real `signal-cli daemon --http`
- **What's needed:**
  - Signal account provisioning (device linking flow)
  - Real group creation via `updateGroup`
  - Document-to-group mapping configuration
  - SSE event parsing for real signal-cli event format
  - Signal body size limits (chunking thresholds)
- **Reference:** `docs/SIDECAR-CONTRACT.md` §5

### 1.2 Storage: atomic snapshot + outbound

- **Gap:** `commitLocalChange()` interface exists in `DurableCollaborativeStorage` but implementation is not atomic — separate IndexedDB operations
- **What's needed:** Single IndexedDB transaction for snapshot + outbound records
- **Risk:** Crash between snapshot save and outbound enqueue loses the edit

### 1.3 Storage: durable seen-message ledger

- **Gap:** `DedupCache` is in-memory only. Browser refresh loses dedup state.
- **What's needed:** Persistent `seen_messages` IndexedDB store with TTL pruning
- **Risk:** Duplicate messages applied after restart

### 1.4 Client: snapshot recovery

- **Gap:** `publishSnapshot()` exists in `DocumentSession` but no recovery algorithm
- **What's needed:**
  - Detect incomplete incremental history
  - Publish/retain snapshot envelope
  - Merge snapshot with local state on receive
  - Compact older incremental records
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

- **Current:** `DedupCache` is in-memory with TTL pruning
- **Target:** IndexedDB-backed seen-message store
- **Gap:** Restart loses dedup state; duplicates may be applied

### 2.6 Durable attempt state

- **Current:** Outbound records have `state` and `attempts` fields in the interface
- **Target:** Actual retry tracking with exponential backoff
- **Gap:** Fields exist but are not populated by current implementation

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

- **Gap:** No test exercises the full E2EE path: identity register → encrypt → transport → decrypt → CRDT apply
- **What's needed:** End-to-end test using MockSignalTransport + IdentityClient + CollaborativeClient

### 4.2 Sidecar contract tests

- **Gap:** Contract tests in `docs/SIDECAR-CONTRACT.md` are specified but not implemented as runnable tests
- **What's needed:** Vitest suite that starts the toy daemon and verifies each contract call

### 4.3 Restart recovery tests

- **Gap:** No test verifies that a browser can restart and resume editing
- **What's needed:** Playwright test that creates a document, closes browser, reopens, verifies state

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
- **Mitigation:** Snapshot compaction (not implemented), periodic full-save replacement

### 6.3 Key bundle fetching

- **Current:** `fetchRemoteIdentity()` makes an HTTP call per recipient per encryption
- **Concern:** N recipients = N HTTP calls per edit
- **Mitigation:** Cache `RemoteIdentity` in IndexedDB; refresh on stale

## 7. Priority order

```
P0 (blocking production):
  1. Real signal-cli integration
  2. Atomic snapshot + outbound
  3. Durable seen-message ledger

P1 (production quality):
  4. Snapshot recovery
  5. Authenticated access control review
  6. Integration test (full E2EE path)

P2 (feature completeness):
  7. Multi-document UI
  8. Offline-first UX
  9. Key rotation lifecycle
  10. Persistent dedup

P3 (platform extension):
  11. Android app (Phase 1: sidecar proxy)
  12. Desktop app

P4 (future):
  13. Structured document model
  14. iOS app
  15. Double Ratchet (if forward secrecy beyond per-session is needed)
```
