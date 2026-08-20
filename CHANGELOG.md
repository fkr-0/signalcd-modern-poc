# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Added

- Android CI workflows: dedicated `android-build.yml` (debug/release APK
  assembly with artifact upload) and `android-test.yml` (unit tests across
  all six core modules plus Android lint) GitHub Actions workflows.
- Android core:protocol tests for chunk encoding, EnvelopeKind.fromCode edge
  cases, validation errors (empty senderId, invalid UUID, negative timestamps),
  and payload boundary conditions.
- Android core:sidecar contract test verifying SidecarSessionTransportAdapter
  implements the SessionTransport interface.
- Toy-only P5 observer encryption for plaintext inspection: explicit debug mode
  exposes a rotating X25519 observer public key/id and browsers attach a separate
  HKDF-SHA-256/AES-256-GCM observer copy signed by the sender Ed25519 identity.
- Durable client checkpoint recovery: transport recovery signals now trigger a
  persisted full-document snapshot that is replayable across reconnects, and
  `DocumentSession.publishSnapshot()` exposes the same explicit recovery primitive.
- Optional snapshot-history thresholds in the client recovery policy for replacing
  accumulated CRDT increments with a retained checkpoint.
- E2EE integration test suite exercising the full path: identity → encrypt →
  transport → decrypt → CRDT merge → convergence, including admin invite, role
  enforcement, and removal scenarios.
- Experimental Android integration spec (`docs/android-integration.md`) with
  three Signal secret access approaches, document-channel agreement protocol,
  and5-milestone implementation plan.
- Roadmap document (`docs/ROADMAP.md`) with P0-P4 priority tiers covering
  production gaps, feature gaps, platform extensions, and testing gaps.

### Changed

- Debug inspection no longer depends on browser identity key export. Observer
  ciphertext is bound to its key id and document/message/sender metadata, never
  routed to participants, and malformed/tampered/stale copies are diagnostic-only.
- Client outbound records now retain their protocol kind so snapshot compaction can
  remove only CRDT change/snapshot history while preserving membership, archive, and
  delete transitions that are not represented by document snapshots.
- Browser E2E can select an isolated toy-daemon port with
  `E2E_COL_TEST_TOY_PORT`, allowing encrypted Playwright runs to coexist with
  unrelated localhost services instead of requiring port 18080 to be free.
- `extend.yml` progress section updated to reflect P1-P4 DONE, P5-P7 PARTIAL.

### Fixed

- IndexedDB multi-store commits now explicitly abort on synchronous write-setup
  failures, preventing a snapshot from committing without its matching outbound
  record. Recovery snapshots also respect reader/archive/delete write restrictions.

### Security

- Browser identity/prekey private keys remain non-exportable and browser-local. The
  separate observer secret key stays inside the loopback toy daemon, rotates on
  reset or disable/enable, and is not returned through state/config/log/export APIs.
- Debug decrypt remains off by default; without an active observer capability,
  fanout remains recipient-ciphertext-only and decrypted previews are absent.

## [0.0.2] - 2026-08-20

### Added

- Standalone `@e2e-col/toy-signal-cli` daemon implementing the e2e-col signal-cli
  compatibility profile over real localhost HTTP JSON-RPC/SSE, including
  multi-account routing, group fan-out, sender sync echoes, deterministic fault
  controls, explicit contract documentation, and two-sidecar end-to-end tests.
- New `@e2e-col/identity` browser identity layer with Ed25519 identity signing
  keys, X25519 signed/one-time prekeys, IndexedDB-backed CryptoKey persistence,
  remote-key verification primitives, and deterministic 60-digit safety numbers.
- Toy identity REST API for registration, authenticated session restoration,
  public prekey lookup/consumption, replenishment, and redacted inspectable state.
- Browser end-to-end coverage for one identity and one editor session per browser
  profile, durable identity/document reload, and isolation between browser contexts.
- Recipient-bound encrypted collaboration envelopes using ephemeral X25519 ECDH,
  domain-separated HKDF-SHA-256, AES-256-GCM authenticated metadata, and Ed25519
  sender signatures, with recoverable prekey selectors and signed-prekey fallback.
- Bearer-authenticated toy collaboration-group APIs plus `MockSignalTransport`
  WebSocket fan-out, sender delivery acknowledgements, offline queueing, and safe
  group/message inspection metadata.
- Two-browser encrypted convergence coverage in Chromium and Firefox, including
  duplicate/delayed delivery and identity-preserving encrypted-session reload.
- `@e2e-col/protocol` access-control payload codecs for membership, archive, and
  delete control envelopes with Ed25519 signature verification, domain-separated
  signing bytes, and binary wire format.
- `@e2e-col/client` package implementing `CollaborativeClient` and `DocumentSession`
  with transport-agnostic document sessions, access-control enforcement, auto/manual
  sync modes, durable outbound replay, and session lifecycle management.
- `@e2e-col/storage` durable collaborative storage extensions with atomic
  `commitLocalChange`, `persistRemoteState`, access-control state persistence,
  and `DurableCollaborativeStorage` interface.
- `@e2e-col/transport` transport factory with `createTransportFactory()` for
  config-driven transport selection (deterministic, mock Signal, WebSocket).
- Toy-sidecar debug decrypt controls (`E2E_COL_DEBUG_DECRYPT`) with structured sync-log
  SSE/poll endpoints, JSON export, encrypted-envelope signature diagnostics, and an
  injectable plaintext-inspection hook for mock identities that actually have server-side
  decryption material.
- `@e2e-col/identity` `SyncLogClient` for browser-side structured sync event
  subscription and polling.
- Web app sync-log panel with level/direction filtering, auto-scroll, and JSON export.
- Web app share/invite dialog for admin participant management by phone number.
- Web app sync-mode toggle (auto/manual) with pending-outbound count display.
- `extend.yml` P7 appendix rewritten as two-tier inspectable sidecar dashboard:
  Tier 1 (default) is a dense inspector with data pipeline, identity/group
  readouts, traffic log, and transport metrics; Tier 2 (opt-in, Ctrl+Shift+G)
  is a guided view with plain-language annotations and paper citations layered
  on top of the same event stream.
- `docs/SIDECAR-CONTRACT.md` specifying the sidecar ↔ signal-cli HTTP API
  contract: health check, JSON-RPC `send`, SSE `receive`, message format
  (`e2e-col:v1:` namespace), chunking ownership, sender echo suppression,
  fidelity matrix, and per-call input/behavior/expected-output tests.
- 26 new tests for `@e2e-col/identity` encoding utilities, `@e2e-col/client`
  error handling, `@e2e-col/protocol` access-control edge cases, and
  `@e2e-col/storage` access-control state persistence.

### Changed

- Replaced the two-replica same-page web demo with a single-client workspace shell
  so each browser profile models one real client and backend transport can be
  exchanged independently of editor UI state.
- Playwright now launches the toy daemon alongside an e2e-col-specific web preview
  for browser identity/integration tests while retaining Chromium, Firefox, and
  WebKit projects; deterministic fault-injection tests use one browser worker.
- Browser replica composition accepts an asynchronous wire-codec seam so encrypted
  routing can wrap canonical protocol envelopes without changing CRDT logic or the
  `CollaborativeTransport` interface.
- Biome configuration migrated from v2.0.0 to v2.5.9 schema with corrected folder
  ignore patterns and linter preset.
- Web app uses `@e2e-col/client` `CollaborativeClient` instead of direct
  `BrowserReplicaSession` for document lifecycle management.
- `DeterministicTransportNetwork` in web app is now lazily initialized.
- `docs/API-IMPLEMENTATION-STATUS.md` updated to reflect P3-P5 completion:
  protocol typed control payloads, client SDK, access-control enforcement,
  and web app integration all marked DONE.

### Fixed

- `CryptoKeyPair` TypeScript type error in `encrypted-routing.test.ts` for
  Ed25519 `generateKey` return type (TS7+ generic `Uint8Array`).
- `BufferSource` type incompatibility in `encrypted-router.ts` and identity
  client for `webcrypto.subtle.sign/verify` calls (TS7+ `ArrayBufferLike`).
- React `useCallback` dependency warnings in `CollaborativeWorkspace` for
  `attachSession`, `refreshDocuments`, and `showError`.
- Biome a11y lint: dialog backdrop `noStaticElementInteractions`, sync controls
  `useAriaPropsSupportedByRole`, sync-log panel `role` attribute.
- Missing `access-control` export from `@e2e-col/protocol` index.
- Missing `client.ts` and `session.ts` exports from `@e2e-col/client` index.

### Security

- Browser private identity and prekey keys are generated non-exportable and are
  never sent to the toy backend; the server validates signed public prekeys and
  stores only public material plus opaque bearer sessions. Consequently, normal browser
  identities cannot be plaintext-decrypted by the toy server even when debug inspection is enabled.
- Toy browser APIs accept only loopback HTTP(S) origins, and inspectable toy state
  omits session tokens, private key material, ciphertext bodies, and document plaintext.
- Mock Signal WebSockets authenticate in the first frame rather than URL query strings;
  ciphertext is signed and bound to document/message/sender/recipient metadata before
  protocol decoding, while browser private keys remain confined to identity storage.

## [0.0.1] - 2026-08-19

### Added

- Modern TypeScript monorepo foundation with Vite, React, strict TypeScript, ESLint, Prettier, Vitest, Playwright, and GitHub Actions.
- Transport-neutral Automerge collaborative document core with operation-aware text edits, persistence, explicit remote-change application, and convergence tests.
- Versioned binary collaborative protocol with validation, chunking, reassembly, deduplication, stable wire fixtures, and malformed-frame rejection.
- Deterministic transport simulator supporting latency, reordering, duplication, dropping, offline queues, recovery signals, and a browser WebSocket transport.
- Durable storage package with memory and IndexedDB implementations for snapshots and outbound queues.
- Local Signal sidecar using a localhost WebSocket bridge and signal-cli HTTP JSON-RPC/SSE backend abstraction.
- Browser integration that uses the shared core, protocol, storage, and transport packages and persists local replicas in IndexedDB.
- Cross-package convergence, wire-path, storage, sidecar, and browser end-to-end tests.
- Architecture, PoC review, project plan, roadmap, deployment tutorial, and research-motivation documentation.

### Changed

- Preserved the original SPRING/EPFL research repository under `upstream/` while moving the modern implementation into project trunk.
- Signal is treated as a replaceable encrypted broadcast adapter instead of a dependency of the editor core.

### Security

- Signal credentials and linked-device state remain outside browser storage.
- Sidecar validates protocol envelopes before forwarding them between the browser and Signal transport.
- Localhost is the default bind address for sidecar and signal-cli HTTP integration.
- Remote sidecar binding and remote signal-cli endpoints require explicit opt-in; browser WebSocket origins default to loopback-only.

The repository currently has no configured Git remote, so release links are intentionally not hard-coded here.
