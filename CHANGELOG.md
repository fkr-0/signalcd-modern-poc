# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

## [0.0.4] - 2026-08-27

### Added

- Browser-only `PeerJsTransport` alternative backed by `peerjslib` v0.3.2, preserving the existing recipient-bound application E2EE and authorization boundary while using capability-derived document rendezvous, elected-browser fan-out, bounded replay, heartbeat recovery, and explicit checkpoint repair.
- Dedicated local-PeerServer Playwright qualification for Chromium and Firefox with three encrypted browser contexts, late-join replay, browser-hub loss, survivor re-election/reconnect, and post-loss convergence.
- `docs/PEERJS-TRANSPORT.md` plus root/architecture documentation that distinguish PeerJS signalling/live P2P behavior from Signal's service-backed asynchronous mailbox semantics.

### Changed

- Workspace and Android app versions advance to `0.0.4` for the technical-preview candidate.
- Root Vitest discovery explicitly excludes injected `node_modules` workspace copies so each canonical source test is executed once after fresh pnpm installs.
- Browser transport configuration can select PeerJS for group-bound encrypted collaboration while unbound local workspaces remain deterministic/local.

### Fixed

- Existing browser E2E identity inspection now reads the schema-v2 IndexedDB stores (`identities_v2` / `sessions_v2`) instead of removed v1 store names.
- The adopted `peerjslib` v0.3.2 normalizes real PeerJS BinaryPack `ArrayBuffer`/view payloads back to canonical `Uint8Array`, closing the browser-only data-frame drop discovered during Chromium qualification.
- WebKit-safe IndexedDB identity storage uses out-of-line keys in the schema-v2 stores, avoiding the key-path behavior diagnosed on the current WebKit compatibility branch.

### Compatibility and limits

- `PeerJsTransport.send()` completion means acceptance by the elected browser hub, not remote CRDT merge or durable third-party storage.
- PeerJS bounded replay can survive hub loss while replay-carrying participants remain online, but it does **not** survive a period where every participant is offline; real Signal qualification remains separately pending.
- Local WebKit execution on the current Arch host is blocked by Playwright's missing `libicu74`/`libxml2`/`libflite1` runtime dependencies. GitHub CI and the tagged release workflow install Chromium/Firefox/WebKit dependencies explicitly before browser E2E.

## [0.0.3] - 2026-08-23

### Added

- Public technical-preview identity **SignalCD Modern PoC**, preserving the explicit connection to the SignalCD system from the USENIX Security 2026 E2EE-CD paper while distinguishing this repository from the authors' prototype and from official Signal projects.
- Documentation landing page organized around current state, architecture, done/not-done capability matrix, release/Signal/Android FAQ, implemented workflow diagrams, missing workflow diagrams, release artifacts, and research lineage.
- Canonical `docs/RESEARCH-PROVENANCE.md` explaining the paper → generic E2EE-CD construction → SignalCD → authors' SPRING/EPFL prototype → this independent implementation relationship.
- Generated API documentation for the public client/core/identity/protocol/storage/transport package entry points, with GitHub Pages publication under `/api/` and tagged API-doc archives.
- GitHub Pages workflow and tagged release-artifact workflow producing the browser build, Android debug APK, sidecar/protocol source archive, API documentation archive, and SHA-256 manifest.
- Reproducible PoC screenshot capture (`pnpm run docs:screenshots`) plus captured two-browser encrypted-convergence/inspector images for the documentation landing page.
- A real-`signal-cli` validation experiment and explicit help-wanted matrix covering two-account bidirectional convergence, restart/replay, daemon compatibility drift, and sanitized evidence collection.

- P2 multi-document local title editing: `CollaborativeClient.updateDocumentMetadata()`
  and the web Local library now rename device-local display metadata without changing
  immutable document UUID, CRDT content, collaboration group binding, authorization
  root/head/revision, participant ACL, or outbound history. Titles normalize to one
  trimmed line (200 JavaScript string code units), blank/null clears to the stable
  UUID-derived fallback, and additive metadata fields are retained.
- Durable metadata-only IndexedDB updates with injected-failure coverage, stale-session
  race protection, and Chromium/Firefox persistent-profile proof for two independent
  titled documents across switch/restart plus group-bound UUID pinning.
- R6 authenticated authorization proof: canonical creator-signed authorization-root
  v1 binds document, initial participant role/active state, and participant identity-key
  commitments; authenticated membership invite v3 binds the target identity key;
  late joiners verify root + signed causal evidence instead of trusting plaintext group
  membership, while established durable replicas reject conflicting bootstrap metadata.
- Signed authorization-resolution v1 for frozen same-predecessor forks. Resolution
  binds the exact fork and deterministic resulting ACL/head, requires unanimous active
  pre-fork admin signatures with at least two independent admins, verifies approver
  identity-key bindings, buffers safely out of order, and survives IndexedDB restart.
- Replay-resistant authorization control payload v2 for membership/archive/delete:
  signed document binding, monotonic authorization revision, 32-byte predecessor
  commitment, SHA-256 authorization heads, durable accepted/pending/conflict history,
  and adversarial TTL-expiry/restart/stale-admin/out-of-order/fork/snapshot coverage.
- Production signal-cli v0.14.7 boundary coverage for daemon health, best-effort version probing,
  JSON-RPC response IDs/errors (including observed `id:null` command failures),
  documented send-result validation, account-aware automatic/manual/sync receive
  forms, active/unblocked startup group checks, initial SSE readiness plus reconnect
  parsing, and an explicit opt-in two-account real-Signal smoke profile that remains
  skipped without a fixture.
- Sidecar runtime configuration for strict UUID → base64 Signal-group mappings,
  exact Origin allowlists, and an explicit final Signal text-body byte boundary;
  chunk planning now accounts for namespace, envelope, chunk metadata, and base64
  overhead instead of relying on an unexplained production threshold.
- Proof-only production recovery signaling: ambiguous HTTP/RPC send failures now
  close with `1011` and rely on durable replay/dedup, while `4409` is reserved for
  an explicit backend history-risk proof and reuses the existing snapshot/checkpoint
  recovery path. The current real `SignalCliHttpBackend` does not fabricate that proof.
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
- Durable IndexedDB seen-message dedup with a configurable 24-hour default TTL,
  schema-v3 `seenAt` pruning index, pre-inbound pruning on session open, and
  restart replay coverage proving duplicate control frames are not re-applied.
- Production-style E2EE integration evidence using real `IdentityClient`
  registration/session restoration, recipient-bound encryption/decryption,
  `MockSignalTransport`, and `CollaborativeClient` CRDT convergence against an
  ephemeral toy daemon. Existing access-control suites continue to cover invite,
  role enforcement, and removal separately.
- Persistent-profile Playwright restart coverage proving identity/document
  restoration, durable seen-message retention, pending-outbound persistence,
  restart replay, and peer convergence in Chromium and Firefox.
- Additional unit tests for `normalizeSeenMessageTtlMs` validation (default,
  custom, zero/negative/fractional/unsafe rejection), `MemoryCollaborativeStorage`
  TTL expiry and multi-entry pruning, `BroadcastRecoveryRequiredError` class
  properties, sidecar config edge cases (non-JSON, empty arrays, port bounds,
  empty accounts, origin dedup, query/fragment rejection), `SignalCliHttpBackend`
  constructor validation (protocol, credentials, path, query, fragment, empty
  account), and `SidecarBridge` construction guards (empty mappings, empty IDs,
  non-positive chunk/body limits).
- Experimental Android integration spec (`docs/android-integration.md`) with
  three Signal secret access approaches, document-channel agreement protocol,
  and5-milestone implementation plan.
- Roadmap document (`docs/ROADMAP.md`) with P0-P4 priority tiers covering
  production gaps, feature gaps, platform extensions, and testing gaps.

### Changed

- Public-facing web/Android branding and repository metadata now use **SignalCD Modern PoC**. Compatibility-sensitive `@e2e-col/*`, `E2E_COL_*`, `e2e-col:v1:`, storage, deep-link, and Android package identifiers remain unchanged in the 0.x line.
- Workspace and Android app versions advance to `0.0.3` for the technical-preview release.

- CRDT/local and remote snapshot persistence now preserves the already-durable
  device-local metadata lane, preventing a stale open-session content write from
  overwriting a successful local rename. Metadata edits emit no collaboration traffic
  and remain independent of reader/archive/delete access restrictions.
- Shared-group bootstrap no longer derives authorization-root creation permission
  from plaintext `created_by`, group membership, or evidence-cache emptiness. Root
  minting is restricted to an explicit local `CollaborativeClient.createDocument()`
  operation; a normal fresh `openDocument()` without a verified root fails closed,
  while an established verified replica may republish its pinned proof to heal an
  empty evidence cache without accepting cache authority.
- Access-control authorization ordering is now independent of transport order and
  `ProtocolEnvelope.sequence`. Future controls may be durably buffered; stale or
  superseded controls cannot roll access state backward; same-predecessor valid forks
  freeze at their common predecessor instead of choosing a first-arrival winner.
- Legacy membership/archive/delete control payload v1 is rejected fail-closed as not
  replay-safe. Revision-0 persisted ACL state migrates to the v2 genesis predecessor,
  while post-history legacy ACL state receives a deterministic semantic-state anchor.
- Production sidecar startup now validates signal-cli health and visibility of
  configured groups before accepting browser connections; the undocumented
  version RPC is best-effort and method-not-found is non-fatal. Account linking,
  registration, and group mutation remain explicit external provisioning steps.
- Ordinary sidecar/SSE/WebSocket disconnects remain non-evidence for missing CRDT
  history; generic send errors are also ambiguous and do not produce recovery.
  Only explicit close code `4409` produces `sidecar-history-risk`. v1 envelope
  sequence remains diagnostic/session-local and is not reused as a gap detector.
- Debug inspection no longer depends on browser identity key export. Observer
  ciphertext is bound to its key id and document/message/sender metadata, never
  routed to participants, and malformed/tampered/stale copies are diagnostic-only.
- Client outbound records now retain their protocol kind so snapshot compaction can
  remove only CRDT change/snapshot history while preserving membership, archive, and
  delete transitions that are not represented by document snapshots.
- Browser E2E can select an isolated toy-daemon port with
  `E2E_COL_TEST_TOY_PORT`, allowing encrypted Playwright runs to coexist with
  unrelated localhost services instead of requiring port 18080 to be free.
- Recovery state is no longer cleared by ordinary outbound send completion; a
  sender clears after publishing a durable full-state checkpoint and a receiver
  clears only after accepting, merging, and persisting the snapshot.
- v1 envelope sequence numbers are documented as diagnostic/session-local rather
  than a safe receiver-side CRDT gap detector; generic gap proof requires future
  epoch/predecessor metadata.
- `extend.yml` progress section updated to reflect P1-P4 DONE, P5-P7 PARTIAL.

### Fixed

- The workspace root now declares its direct `ws` test dependency, so clean `pnpm install --frozen-lockfile` environments can collect and run the top-level E2EE integration suite instead of depending on incidental transitive installation state.
- Android sidecar explicit-close handling now suppresses a late WebSocket `onOpen` callback at the listener/UI boundary as well as the internal connection state, preventing a closed connection from being presented as online.
- Canonical empty Automerge bootstrap now pins its fixed actor's initial change to
  timestamp 0. Independent browser contexts therefore derive identical bootstrap
  history instead of occasionally producing conflicting actor/sequence-1 changes
  when an invite snapshot is merged.
- IndexedDB multi-store commits now explicitly abort on synchronous write-setup
  failures, preventing a snapshot from committing without its matching outbound
  record. Recovery snapshots also respect reader/archive/delete write restrictions.

### Security

- signal-cli endpoint URLs reject embedded credentials and default to loopback;
  default diagnostics expose neither account/group configuration nor JSON-RPC
  error data. Browser runtime configuration still contains no Signal credentials.
- The bounded seen-message TTL remains only a duplicate-suppression mechanism;
  authorization replay safety now comes from the durable v2 predecessor chain and
  authorization history. Replaying an old valid control after TTL pruning or restart
  cannot make it current again.
- R6 is complete within the authenticated-identity trust model: server/group
  plaintext metadata cannot install ACL authority; fresh replicas verify the shared
  signed root and causal chain, and valid forks remain frozen until the documented
  multi-admin signed resolution proof succeeds. Single-admin forks stay fail-closed.
- Root creation intent is local state, not bootstrap metadata: a group/toy server
  that withholds the evidence cache or substitutes `created_by` can deny service but
  cannot induce a joining `openDocument()` replica to mint a replacement root.
- Remaining authorization deployment limits are explicit: first-contact trust still
  depends on authenticated identity-key material, and a Byzantine evidence cache can
  censor or replay an older valid signed prefix to a brand-new device without an
  external freshness/transparency pin. It cannot forge proof or roll back an
  established durable replica. R5 real-Signal evidence remains separately pending.
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

At the time of the `0.0.1` release, the repository had no configured Git remote, so that release did not hard-code remote release links.
