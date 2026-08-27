# ADR 0001: Automerge over Yjs

- **Status:** Accepted
- **Date:** 2026-08-27 (retrospective documentation of the established design)

## Context

The E2EE-CD construction needs deterministic reconciliation of independently authored document state after asynchronous, duplicated, delayed, and reordered delivery. The upstream SignalCD research prototype also uses Automerge, and this repository already persists Automerge snapshots/changes across browser restart and deterministic network faults.

## Decision

Use Automerge as the canonical CRDT/reconciliation engine. Protocol envelopes carry opaque Automerge changes or full snapshots; transports do not interpret document operations.

The canonical empty text bootstrap remains byte-stable. Structured blocks, comments, and attachment metadata are additive/lazy fields so historical text-only snapshots remain loadable without a forced wire migration.

## Why not Yjs now?

Yjs is a strong CRDT implementation, but switching would create a new persistence and reconciliation format, invalidate the existing snapshot/change fixtures, and reduce comparability with the research prototype without solving an identified correctness defect. A migration would need explicit cross-engine state conversion and durable upgrade evidence rather than a library substitution.

## Consequences

- Automerge change/snapshot compatibility is a storage and protocol-adjacent contract.
- CRDT changes remain opaque to Signal, PeerJS, WebSocket, and sidecar transports.
- Rich-document evolution happens inside the Automerge state model.
- A future engine change requires a versioned persistence/import migration and convergence evidence.
