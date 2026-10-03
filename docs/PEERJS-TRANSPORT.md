# PeerJS Signal-semantics demo transport

`@e2e-col/transport` can use `peerjslib` v0.3.2 as a browser-to-browser transport while preserving the same opaque encrypted application-envelope boundary used by the Signal adapters.

This backend is deliberately a **Signal-semantics demo**, not a claim that PeerJS Cloud is a Signal mailbox.

## Architecture

```text
Browser A                                      Browser B
─────────                                      ─────────
DocumentSession                                DocumentSession
  │ encrypted ProtocolEnvelope                  ▲
  ▼                                             │
PeerJsTransport                                 PeerJsTransport
  │ private transport framing                   ▲
  ▼                                             │
peerjslib PeerJsLobby ═══ WebRTC DataChannel ═══╝
       │
       └── PeerJS signalling ── PeerJS Cloud or self-hosted PeerServer
```

PeerServer participates in rendezvous/signalling. Once WebRTC is established, application bytes travel over the data channel (or an ICE/TURN relay when the WebRTC topology requires one). Peer IDs and lobby membership are routing metadata, not authenticated e2e-col identities.

## Signal-like behavior retained

The adapter preserves the browser-visible behaviors useful for comparing the demo with Signal:

- opaque binary application ciphertext;
- group fan-out through the elected browser hub;
- sender echo suppression;
- hub-acceptance acknowledgement (`send()` completion);
- bounded queue/replay while at least one participant retaining history remains online;
- browser-hub election and failover;
- reconnect/backoff, heartbeat staleness detection, epoch rejection, real-PeerJS binary-ingress normalization and backpressure handling from `peerjslib` 0.3.2;
- local durable e2e-col outbound replay across application/browser restart.

The hard durability boundary remains explicit: if **every** browser carrying the bounded mailbox window is offline at once, PeerJS provides no third-party durable mailbox. The real Signal sidecar remains the asynchronous service-backed backend.

## Replay-gap recovery

A bounded PeerJS replay window can be exhausted while a replica is away. That is not handled by publishing the receiver's potentially incomplete snapshot.

```text
receiver reconnects with cursor 10
        │
        ▼
PeerJS hub only retains 20..50
        │
        ├── replay-gap -> receiver enters `recovering`
        │                 and does NOT publish local state
        │
        └── transport-internal checkpoint request
                           │
                           ▼
                   healthy peer replicas
                           │
                           └── each writable DocumentSession may publish
                               a full encrypted snapshot checkpoint
                                       │
                                       ▼
                              receiver merges snapshot
                              and clears recovery
```

`TransportRecoveryRequired.reason` therefore distinguishes:

| reason | local meaning | DocumentSession action |
| --- | --- | --- |
| `peerjs-replay-gap` | this receiver lacks part of bounded PeerJS history | enter `recovering`; do not publish local snapshot |
| `peerjs-checkpoint-request` | another peer asked healthy replicas for repair | publish a snapshot if this participant is allowed to write; remain healthy |
| existing `dropped-frame` / `sidecar-history-risk` | existing transport-loss semantics | retain the established recovery behavior |

The checkpoint request is internal to `PeerJsTransport`; it never reaches the e2e-col application-envelope subscriber. Application data is wrapped in a versioned private transport frame so a control request cannot be mistaken for CRDT/protocol bytes. More than one writable peer may answer the same request; authenticated snapshots are merge-safe and this avoids coupling recovery authority to whichever browser happens to hold the PeerJS hub role.

## Browser configuration

Select PeerJS for **group-bound encrypted collaboration**:

```sh
VITE_E2E_COL_TRANSPORT=peerjs pnpm --filter @e2e-col/web dev
```

An unbound local workspace continues to use the deterministic local transport. PeerJS activates when the workspace URL contains both the collaboration group and document IDs.

### Rendezvous capability

Preferred demo invitation form:

```text
http://localhost:5173/?group=<group-uuid>&document=<document-uuid>#peerjs=<high-entropy-capability>
```

The fragment is not sent as part of HTTP requests. `PeerJsTransport` domain-separates it with the document UUID and `peerjslib` derives the bounded room ID with SHA-256.

Use random invitation-grade material of at least 16 bytes. A public document UUID, group UUID or human password is not suitable capability material.

For controlled automation only, the browser also accepts:

```sh
VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET=...
```

Because Vite embeds `VITE_*` values in client JavaScript, that variable is **not private in a distributed build**. The URL-fragment path is preferred for interactive demos.

### Self-hosted PeerServer

Without server options the normal PeerJS client defaults are used. To point the demo at a self-hosted PeerServer:

```sh
VITE_E2E_COL_PEERJS_HOST=peer.example.test
VITE_E2E_COL_PEERJS_PORT=443
VITE_E2E_COL_PEERJS_PATH=/peerjs
VITE_E2E_COL_PEERJS_KEY=peerjs
VITE_E2E_COL_PEERJS_SECURE=true
```

Partial self-hosted configuration fails closed: if any server-specific option is supplied, `HOST` is required; ports and booleans are strictly validated.

## Package pin and supply-chain boundary

The transport workspace pins:

```text
peerjslib = github:fkr-0/peerjslib#v0.3.2
```

The lockfile resolves that tag to commit:

```text
6529ef70f3d4b18581a98a7250ef5144b24cdecf
```

`peerjslib` uses a Git `prepare` build, so the root `pnpm-workspace.yaml` explicitly allows only that package (alongside the pre-existing `esbuild`) to run its install-time build. pnpm otherwise rejects the dependency.

## Tests

Focused deterministic tests cover:

- opaque byte fan-out and sender echo suppression;
- document-bound private room derivation;
- replay-gap -> remote checkpoint-request routing;
- transport-internal control hiding/accounting;
- weak-secret and document-rebinding rejection;
- factory creation and browser environment parsing;
- DocumentSession's split receiver/responder recovery semantics.

A separate browser suite uses a **local PeerServer**, not PeerJS Cloud:

```sh
pnpm test:e2e:peerjs
```

It starts the toy service only for identity/group/authorization metadata, a local `peer` PeerServer, and the PeerJS-configured production web build. Chromium and Firefox exercise three independent browser contexts with recipient-bound encrypted convergence, late-join replay, browser-hub loss, survivor re-election/reconnect, and a post-loss edit. The test also verifies the toy Signal message store did not carry the document ciphertext.

The finalized local qualification passes in both Chromium and Firefox. Chromium can require the heartbeat/stale fallback when closing the hub context does not immediately surface a WebRTC close event; the test therefore waits for an observed transport reconnect before sending the post-loss edit instead of treating a stale `online` UI state as proof of recovery.

TURN-relay-required NAT qualification remains deployment evidence rather than a claim of this local-host test.
