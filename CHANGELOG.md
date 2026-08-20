# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

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

### Changed

- Replaced the two-replica same-page web demo with a single-client workspace shell
  so each browser profile models one real client and backend transport can be
  exchanged independently of editor UI state.
- Playwright now launches the toy daemon alongside the web preview for browser
  identity integration tests while retaining Chromium, Firefox, and WebKit projects.

### Security

- Browser private identity and prekey keys are generated non-exportable and are
  never sent to the toy backend; the server validates signed public prekeys and
  stores only public material plus opaque bearer sessions.
- Toy browser APIs accept only loopback HTTP(S) origins, and inspectable toy state
  omits session tokens and private key material.

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
