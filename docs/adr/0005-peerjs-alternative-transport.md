# ADR 0005: PeerJS as a bounded alternative transport

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

The project benefits from a browser-only collaboration backend for demos and transport-independence testing. PeerJS supplies WebRTC DataConnections and signalling but does not supply Signal's service-backed durable asynchronous mailbox semantics.

## Decision

Use `peerjslib`/`PeerJsTransport` as an alternative live-P2P transport with capability-derived rendezvous, elected-browser fan-out, bounded browser-resident replay, epochs/heartbeat/backpressure, and explicit replay-gap checkpoint repair.

Keep encryption, authorization, CRDT merge, durable local outbound state, and checkpoint authority in e2e-col. Peer IDs are routing identifiers, not authenticated identities.

## Consequences

- `send()` completion means elected-hub acceptance, not remote merge or third-party durability.
- Replay may survive hub loss while another replay-carrying participant stays online.
- If every replay-carrying browser is offline, PeerJS has no Signal-equivalent mailbox.
- URL-fragment capability material is preferred over build-time `VITE_*` secrets, which are visible in distributed bundles.
- TURN-required NAT traversal is deployment evidence and must not be inferred from localhost PeerServer tests.
