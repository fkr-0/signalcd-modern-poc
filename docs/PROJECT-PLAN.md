# Project plan

## Goal

Build a modern, inspectable implementation of the E2EE collaborative-document
construction described in the USENIX Security 2026 paper, using the upstream
SignalCD prototype as implementation evidence rather than as an application
codebase.

## Design invariants

```yaml
source_of_truth:
  document_state: client replicas
  reconciliation: Automerge
  helper_server: never authoritative for plaintext state
security_boundary:
  browser: no Signal device credentials
  sidecar: owns Signal device state and transport integration
transport:
  contract: asynchronous encrypted broadcast
  initial_backend: Signal via signal-cli
  future_backends:
    - MLS-based broadcast
    - encrypted relay/object channel
correctness:
  convergence: same unordered set of edits => equivalent state
  offline: edits reconcile after reconnect
  duplicate_delivery: idempotent
  reordered_delivery: convergent
  concurrent_delivery: convergent
```

## Phase 0 — research extraction

- preserve upstream code under `upstream/`;
- map paper requirements R1–R10 into testable requirements;
- document trust boundaries and threat assumptions;
- preserve benchmark scenarios as regression scenarios.

## Phase 1 — browser convergence core

**Status: implemented for the plain-text v1 substrate.**

- implement two independent Automerge replicas;
- keep UI, CRDT core, and transport separate;
- add deterministic transports that reorder, duplicate, delay, and drop frames;
- use operation-aware text updates rather than whole-string replacement for
  realistic concurrent editing;
- add convergence property tests.

Acceptance:

- replicas converge after concurrent edits;
- delivery order does not affect final state;
- duplicate frames do not affect final state;
- offline replicas catch up after reconnect.

## Phase 2 — durable local-first documents

**Status: initial implementation complete in `@e2e-col/storage` and the browser session.**

- IndexedDB persistence;
- stable document IDs and metadata;
- reload/reopen without network;
- snapshots plus incremental changes;
- durable outbound replay after restart.

Still required after `0.0.1`: explicit schema-migration fixtures, corruption
recovery, snapshot/checkpoint exchange after detected transport loss, and
bounded historical compaction.

## Phase 3 — Signal sidecar

**Status: implementation present and contract-tested; live two-account Signal
smoke test remains external release evidence.**

- Node/TypeScript sidecar;
- narrow browser-facing WebSocket API;
- typed binary envelopes;
- current `signal-cli` send/receive adapter;
- deduplication, chunking, and health diagnostics;
- real linked-device E2E smoke test (pending live credentials/devices).

The operational bring-up sequence, current external requirements, linked-device
setup, JSON-RPC health probes, sidecar configuration, and two-machine smoke test
are documented in [`LIVE-TUTORIAL.md`](LIVE-TUTORIAL.md). The sidecar code is
now present; the guide distinguishes its tested local contract from the still
pending real two-account Signal execution.

## Phase 4 — paper-level access semantics

**Status: pending after `0.0.1`.** Envelope kinds are reserved, but authenticated
membership/control payloads are intentionally not frozen yet.

- read/write/admin authorization;
- admin-only participant changes;
- archive and delete control frames;
- explicit UX for locally retained copies after deletion, matching the paper's
  stated limitation.

## Phase 5 — structured documents

**Status: pending after `0.0.1`.** The first release intentionally stays with
plain text until durability and Signal interoperability are hardened.

- block-oriented paragraphs/headings/lists;
- comments, annotations, suggestions as overlay content;
- encrypted referenced blobs for images/attachments;
- authorship and history metadata.

## Phase 6 — hardening

**Status: partial.** Deterministic network profiles, cross-package tests,
multi-browser Playwright configuration, CI, and release gates exist. Live Signal,
access-control adversarial tests, packaging, and reproducible distribution
artifacts remain later work.

- Playwright multi-context E2E;
- property/fuzz tests for ordering and duplication;
- slow/fast network profiles derived from upstream benchmarks;
- threat-model review against R8–R10;
- package as browser + companion daemon or desktop application.

## Early non-goals

- making a relay authoritative for the plaintext document;
- storing Signal credentials in browser storage;
- coupling Automerge directly to React components;
- starting with rich text before transport/convergence are hardened;
- assuming Signal is the only E2EE broadcast backend.

## References

- Christian Knabenhans, Zayd Maradni, Carmela Troncoso, _End-to-End Encrypted
  Collaborative Documents_, 35th USENIX Security Symposium, 2026.
- SPRING/EPFL `signal-collaborative-documents` prototype under `upstream/`.
