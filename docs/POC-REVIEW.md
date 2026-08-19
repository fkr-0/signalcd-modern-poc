# PoC review

## Summary

The upstream repository is primarily a benchmark harness, not a product UI. It
does, however, provide solid implementation evidence for the SignalCD concept:

- Automerge creates incremental binary CRDT updates.
- those updates are wrapped and sent through Signal group messages;
- a second replica receives them and applies the incremental updates;
- experiments cover asynchronous collaboration, concurrent non-overlapping
  edits, concurrent overlapping edits, and large edits;
- Docker plus traffic shaping simulates slow and fast links.

The USENIX Security 2026 paper confirms that the important construction is not
Signal-specific. It composes a strongly convergent reconciliation mechanism
with an end-to-end encrypted asynchronous broadcast primitive. SignalCD is one
instantiation of that generic E2EE-CD construction.

## What is reusable

### CRDT/transport separation

Local edits produce opaque update bytes. The transport only needs to deliver
those bytes to authorized replicas. That boundary should become a first-class
software interface.

### Incremental Automerge updates

The upstream Automerge adapter uses incremental state changes instead of sending
a whole document after every edit. That is the correct primitive for a modern
implementation.

### Signal as E2EE asynchronous broadcast

The prototype talks to `signal-cli` over local daemon APIs. Keeping Signal in a
local sidecar is the right product boundary because account/device state should
not be exposed to frontend JavaScript.

### Benchmark scenarios as acceptance tests

The existing asynchronous, overlapping, non-overlapping, and large-edit
benchmarks can be converted into deterministic integration and property tests.

## Paper requirements to preserve

```yaml
functional:
  R1: sharing with read/write/admin permissions
  R2: archival
  R3: deletion semantics
  R4: collaborative editing
  R5: asynchronous/offline editing
  R6: concurrent near-real-time editing
  R7: strong convergence
security:
  R8: participant-list unforgeability
  R9: confidentiality
  R10: integrity
```

The paper also treats the helper server as generally untrusted. The modern
system therefore must not move plaintext reconciliation or authoritative
document state into a server-side service.

## Gaps before this can be an application

- upstream code is Node-centric and uses `Buffer`, `child_process`,
  `worker_threads`, filesystem writes, and direct `signal-cli` processes;
- no browser-safe transport abstraction exists;
- no durable document lifecycle or IndexedDB persistence exists;
- the benchmark envelope needs versioning, document IDs, message IDs,
  deduplication, payload kinds, chunking, and recovery semantics;
- access control, archival, deletion, and participant management are not yet an
  application-level protocol;
- the editor model is plain text by index, not a product-grade structured
  document model.

## Feasibility judgment

**Feasible.** The core is small and modular enough to modernize cleanly.

The right direction is:

```text
Vite editor
   │
   │ Automerge changes / remote-change events
   ▼
CollaborativeTransport
   │
   │ localhost WebSocket/HTTP
   ▼
Signal sidecar
   │
   │ signal-cli JSON-RPC + receive stream
   ▼
Signal group
```

Signal should remain swappable with another E2EE asynchronous broadcast
mechanism, including a future MLS-based backend.

## Remaining doubt

The exact production-grade Signal integration contract should be re-verified
against the current `signal-cli` release before implementing the real sidecar.
The upstream repository pins an older version and daemon API details can change.
