# e2e-col

Modern exploration of the SignalCD idea from SPRING/EPFL's
`signal-collaborative-documents` research prototype.

The upstream research code is pinned under `upstream/` as a Git submodule at the
reviewed commit, leaving it unchanged and reproducible. This repository adds a
browser-oriented architecture and implementation trunk around the paper's
generic construction: strongly convergent client-side reconciliation plus an
end-to-end encrypted asynchronous broadcast channel.

See:

- `docs/POC-REVIEW.md`
- `docs/ARCHITECTURE.md`
- `docs/PROJECT-PLAN.md`
- `docs/ROADMAP-DESIGN-SPEC.md`
- `docs/TARGET-API-SPEC.md` — normative target API for app/client/storage/sidecar design
- `docs/API-IMPLEMENTATION-STATUS.md` — exact implemented/partial/missing API matrix
- `docs/REPORT.md`
- `docs/LIVE-TUTORIAL.md` — hands-on local run + real Signal go-live path

## Proposed trunk stack

- Vite + React + TypeScript
- `@automerge/automerge` for strong convergence
- IndexedDB persistence baseline with durable-semantics hardening still in progress
- Node.js/TypeScript localhost sidecar for `signal-cli` (initial bridge implemented)
- WebSocket browser ↔ sidecar transport
- protocol envelopes designed for duplicate/reordered delivery

The browser must never own Signal device credentials. Signal is the initial
E2EE asynchronous-broadcast backend, not a dependency of the editor core.

## Motivation and solution

Collaborative editors usually rely on a central service that can see and merge
plaintext document state. `e2e-col` takes a different approach: clients own the
document state, Automerge provides strong convergence, and an encrypted
asynchronous broadcast channel moves opaque updates between participants.

The SPRING/EPFL SignalCD prototype demonstrates this concept using Automerge and
Signal. This repository keeps that construction but modernizes the software
architecture. The editor is a Vite/React application, the CRDT core is
transport-agnostic, and Signal is isolated behind a local Node.js sidecar so
device credentials never enter browser storage.

The first deployment target is a browser application plus a localhost companion
daemon. The browser stores local-first state in IndexedDB, continues editing
offline, and exchanges typed binary update envelopes through the sidecar. The
sidecar maps those envelopes to Signal group messages and back again. Because
the CRDT layer is designed to converge under delayed, duplicated, and reordered
delivery, the helper process does not need to become a plaintext merge server.

For the full narrative covering motivation, concept, architecture, and
deployment, see `docs/REPORT.md`. For the package-level roadmap and concurrent
agent work split, see `docs/ROADMAP-DESIGN-SPEC.md`. Application projects should
design against `docs/TARGET-API-SPEC.md`; its companion
`docs/API-IMPLEMENTATION-STATUS.md` distinguishes the interfaces that exist now
from target surfaces that still need implementation or secure design review.

## Getting started

The current repository already runs a local two-replica Automerge demo. If the
research source is wanted locally, initialize the pinned submodule first; it is
not required by the application build. Then install from the lockfile, verify
the workspace, and start Vite:

```bash
git submodule update --init --recursive
npm ci
npm run check
npm run dev
```

Then open `http://localhost:5173/` and edit either replica. The other pane should
converge immediately.

The default web demo is still a **local deterministic transport proof**, but it
now exercises the shared core, protocol, storage, and transport packages through
`BrowserReplicaSession`. Set `VITE_E2E_COL_SIDECAR_URL` to select the localhost
`WebSocketTransport` companion mode instead. The main post-`0.0.1` gaps are
extracting the reusable `@e2e-col/client` facade, strengthening storage to atomic
checkpoint/recovery semantics, implementing authenticated document access/lifecycle
semantics, and proving a real two-device Signal round trip.

For a complete step-by-step guide covering Node requirements, `signal-cli`
installation/linking, group setup, JSON-RPC daemon checks, the sidecar contract
and remaining hardening, two-machine smoke testing, deployment, and
troubleshooting, see
[`docs/LIVE-TUTORIAL.md`](docs/LIVE-TUTORIAL.md).

## Useful commands

```bash
npm run dev          # Vite browser demo
npm run check        # typecheck + lint + format + unit/integration tests + build
npm run test:e2e     # Playwright browser test
npm run build        # production workspace builds
```

## Current implementation map

```text
e2e-col/
├── apps/
│   ├── web/             # Vite/React demo + BrowserReplicaSession precursor
│   └── sidecar/         # hardened localhost WebSocket <-> signal-cli bridge
├── packages/
│   ├── core/            # Automerge document/session abstraction
│   ├── protocol/        # versioned binary envelopes, validation, chunks, dedup
│   ├── transport/       # fault simulation + browser WebSocket client
│   ├── storage/         # memory + IndexedDB persistence baseline
│   └── testing/         # network/convergence/wire scenarios
├── docs/
│   ├── TARGET-API-SPEC.md
│   ├── API-IMPLEMENTATION-STATUS.md
│   └── LIVE-TUTORIAL.md
├── tests/e2e/           # Playwright browser checks
└── upstream/            # preserved SPRING/EPFL research prototype
```
