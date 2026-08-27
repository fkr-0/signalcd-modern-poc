# Getting started

This guide gets two independent browser identities editing the same encrypted document with the repository's local toy service. It is the shortest end-to-end path through the real browser identity, authorization, E2EE, storage, transport, and Automerge layers without requiring Signal accounts.

The project is a technical preview. The toy service is loopback-only test infrastructure, not a production identity directory or Signal replacement. For real `signal-cli` deployment evidence, use [`LIVE-TUTORIAL.md`](LIVE-TUTORIAL.md).

## 1. Install and verify

Requirements:

- Node.js 20.19+ (Node 22 or newer recommended);
- pnpm 11.3.0;
- Chromium or Firefox for the browser exercises.

```bash
git clone --recurse-submodules https://github.com/fkr-0/signalcd-modern-poc.git
cd signalcd-modern-poc
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

The non-browser gate type-checks every TypeScript workspace, runs Biome, runs the canonical Vitest suite, and builds the production web application.

For browser coverage:

```bash
pnpm exec playwright install chromium firefox
pnpm test:e2e -- --project=chromium --project=firefox
```

## 2. Start the local collaboration service

In terminal A:

```bash
pnpm --filter @e2e-col/toy-signal-cli dev
```

The toy service listens on `http://127.0.0.1:18080` by default. It provides browser identity/prekey APIs, collaboration-group metadata, authorization-evidence caching, and the mock Signal WebSocket path used by the default encrypted browser demo.

In terminal B:

```bash
pnpm --filter @e2e-col/web dev
```

Open the Vite URL in two independent browser profiles or private contexts. Separate profiles matter: each profile owns one browser identity and its non-exportable private keys.

## 3. Register Alice and Bob

In the first browser:

1. Enter `Alice` as the display name.
2. Select **Create identity**.
3. Confirm the workspace opens and the status reports `ready · online`.

Repeat in the second browser for `Bob`.

Registration creates browser-owned Ed25519 identity keys, an X25519 signed prekey, and one-time prekeys. Private key material stays in browser IndexedDB as non-exportable `CryptoKey` objects. The toy service receives public material only.

## 4. Create and bind a document

In Alice's browser:

1. Select **New** to create a local document.
2. Edit the text or rename the local library title if desired.
3. Create/bind a collaboration group through the application's group flow.
4. Use **Share** and invite Bob's displayed phone number as `writer`.

The document UUID is immutable collaboration identity. The local title is device-local metadata and can differ between browsers without changing the collaboration binding.

The first shared authorization state is not trusted merely because the toy group says who created it. Alice's explicit local create operation signs the authorization root; Bob verifies that root and the signed invite before installing access authority.

## 5. Edit together

Open the same group/document URL in Bob's browser. Both sides should report `ready · online`.

Type in Alice's editor and observe Bob converge. Then type from Bob and observe Alice converge. The application flow is:

```text
editor operation
  -> Automerge change
  -> ProtocolEnvelope v1
  -> per-recipient X25519/HKDF/AES-GCM ciphertext
  -> CollaborativeTransport
  -> peer
  -> authenticated decrypt
  -> authorization check
  -> Automerge merge
  -> IndexedDB persistence
```

Transport acknowledgement is not the same thing as remote merge. Session status intentionally distinguishes local transport handoff, durable replay, and recovery state.

## 6. Exercise offline and retry behavior

Disconnect or stop the active transport while editing. Local changes remain persisted and the workspace exposes queued outbound depth. On reconnect, durable records replay with their original message IDs.

Auto-sync sessions also use a bounded exponential retry policy after recoverable send failures. The default policy starts at 1 second, doubles up to 30 seconds, and stops after six automatic retries. Manual-sync sessions never arm automatic retry timers. Retry state is local observability only; it is not a peer acknowledgement.

## 7. Use the PeerJS browser transport

PeerJS is an alternative browser transport, not a claim of Signal-equivalent durability. Start the app with:

```bash
VITE_E2E_COL_TRANSPORT=peerjs pnpm --filter @e2e-col/web dev
```

A group-bound invitation should carry high-entropy rendezvous material in the URL fragment:

```text
?group=<group-uuid>&document=<document-uuid>#peerjs=<high-entropy-capability>
```

The fragment is not sent in the HTTP request. `peerjslib` derives a document-scoped room ID from that capability. Application E2EE and authorization remain above PeerJS.

For a deterministic self-hosted-browser proof, run:

```bash
pnpm test:e2e:peerjs
```

That suite launches a local PeerServer and proves encrypted three-browser convergence, late replay, browser-hub loss, re-election, and post-loss convergence in Chromium and Firefox.

PeerJS retains only bounded browser-resident replay. If every replay-carrying browser is offline, there is no third-party mailbox equivalent to Signal. See [`PEERJS-TRANSPORT.md`](PEERJS-TRANSPORT.md).

## 8. Structured-document API

The text lane remains backward-compatible, while `@e2e-col/core` and `DocumentSession` also expose additive CRDT operations for:

- paragraph/heading/list-item/quote/code blocks;
- ordered, bullet, and task-list metadata;
- comments bound optionally to blocks;
- attachment metadata with optional SHA-256 and opaque content reference.

Attachment bytes are deliberately not placed inside the CRDT. Applications own content storage and retrieval; the collaborative document carries bounded metadata/reference state only.

These operations still travel as ordinary opaque `automerge-change` envelopes, so protocol and transport adapters do not need document-structure awareness.

## 9. Next deployment steps

Before treating the system as production-ready, the roadmap still requires external or platform-specific evidence including:

- two already-linked accounts exchanging through real `signal-cli` and a pre-existing Signal group;
- a deployment-specific safe Signal body boundary;
- authenticated first-contact/freshness infrastructure and a safe long-term identity-key rebind protocol;
- Android native CRDT/E2EE parity beyond the current sidecar proxy;
- TURN-required PeerJS NAT qualification where applicable.

Use [`ROADMAP.md`](ROADMAP.md) for the current gate list and [`ARCHITECTURE.md`](ARCHITECTURE.md) for trust boundaries.
