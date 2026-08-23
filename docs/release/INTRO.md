# e2e-col 0.5.0 — introduction and setup

> **Archived forward-looking draft.** This document was prepared for a proposed 0.5.0 documentation target before the current 0.0.3 implementation state. It is preserved as design/history, not as the authoritative current release guide. Start at [`../index.md`](../index.md) and the generated [`/api/`](/api/) reference instead.


> Documentation target: **0.5.0**. The checkout used to prepare this guide still
> reports package version `0.0.1`; the release/version bump is intentionally
> separate from this documentation task.

`e2e-col` is a local-first collaborative text editor architecture built around a
simple idea: the service that carries collaboration messages does not need to
see or merge the document. Each participant owns an independent Automerge CRDT
replica, produces compact binary changes locally, and eventually exchanges those
changes through an asynchronous encrypted broadcast channel. The replicas, not a
central plaintext server, decide the converged document state.

The project is a modern exploration of the SignalCD construction from
SPRING/EPFL's `signal-collaborative-documents` research. The current TypeScript
monorepo turns that research idea into separately testable components: CRDT
state, a strict binary protocol, transport adapters, browser persistence, a
React demo, and a localhost sidecar that bridges WebSockets to `signal-cli`.
Signal is the first real transport backend, but the editor core is deliberately
not Signal-specific.

For deeper background, see:

- [Architecture](../ARCHITECTURE.md)
- [Target API specification](../TARGET-API-SPEC.md)
- [API implementation status](../API-IMPLEMENTATION-STATUS.md)
- [Existing live tutorial](../LIVE-TUTORIAL.md)
- [Project report](../REPORT.md)

## 1. Why end-to-end encrypted collaboration matters

A conventional collaborative editor normally has a central service that can
receive plaintext operations, maintain the canonical document, index it, and
resolve synchronization. That design is operationally convenient, but it also
means the service sits directly on the plaintext collaboration path.

`e2e-col` separates **reconciliation** from **transport**:

```text
local edit
   |
   v
Automerge CRDT change ------------------------------+
   |                                                 |
   | versioned binary envelope                       |
   v                                                 |
local storage / pending queue                        |
   |                                                 |
   v                                                 |
opaque transport bytes                               |
   |                                                 |
   v                                                 |
Signal group / another async broadcast backend      |
   |                                                 |
   v                                                 |
remote replica -> validate -> apply -----------------+
                         |
                         v
                    same document state
```

The important property is not that every message arrives immediately or in one
global order. The important property is that replicas which eventually receive
the same valid CRDT changes converge even when delivery is delayed, duplicated,
or reordered.

This gives the architecture several useful security and reliability properties:

- plaintext document state stays with client replicas;
- the Signal-linked device credentials stay outside browser storage;
- protocol validation happens before untrusted bytes reach the CRDT;
- offline editing remains possible;
- duplicate and reordered delivery are treated as normal network behavior;
- Signal can be replaced later without rewriting the CRDT core.

It does **not** make the system magically production-complete. The current
implementation still has documented gaps around atomic durability, persistent
deduplication/checkpointing, reusable client-session APIs, authenticated document
roles, and real two-account Signal release evidence. See
[API implementation status](../API-IMPLEMENTATION-STATUS.md) for the exact
implemented/partial/missing matrix.

## 2. How this differs from Google Docs, Notion, and "CRDTs with a server"

| Model | Where plaintext authority usually lives | What the network/server does | Offline/reorder model |
| --- | --- | --- | --- |
| Google Docs / Notion style hosted editor | Provider-controlled service is normally authoritative or deeply involved in document processing | Synchronizes, stores, indexes, often merges or validates application state | Product-specific; central service is a major coordination point |
| CRDT with a conventional sync server | Clients merge CRDT state, but a server commonly stores and relays readable document operations/state | Relay, persistence, presence, often metadata/indexing | CRDT reduces ordering requirements, but server may still see plaintext |
| **e2e-col** | Client replicas | Carries encoded protocol frames; Signal supplies encrypted asynchronous broadcast | Delays, duplication, reordering, disconnect/reconnect are explicit design inputs |

`e2e-col` should therefore not be described as "Google Docs over Signal." It is
closer to a private replicated state system in which the collaboration channel
is intentionally less trusted than the local replicas.

## 3. What Signal provides — and what it does not

Signal is used as the first asynchronous broadcast backend because it already
provides mature end-to-end encrypted messaging and group delivery. `signal-cli`
lets the local sidecar participate as a linked Signal device without putting
Signal device state in the browser.

Signal provides:

- end-to-end encrypted message transport between Signal participants;
- group distribution;
- asynchronous delivery suitable for temporarily offline participants;
- linked-device operation through `signal-cli`;
- an HTTP JSON-RPC + Server-Sent Events daemon interface that the sidecar can
  consume locally.

Signal does **not** provide the editor's CRDT semantics. It also does not, by
itself, give `e2e-col` all of the following:

- Automerge convergence;
- document/protocol versioning;
- document-ID isolation;
- application-level deduplication and chunk reassembly;
- durable browser queues and checkpoint policy;
- document-specific reader/writer/admin authorization;
- proof that a remote replica has merged a change merely because a send call
  succeeded;
- a globally ordered collaboration log.

Those concerns belong to `e2e-col`'s core, protocol, storage, client/session, and
access-control layers.

## 4. Architecture overview

```text
+--------------------------------------------------------------------+
| Browser: apps/web                                                  |
|                                                                    |
|  React UI                                                          |
|     |                                                              |
|     v                                                              |
|  BrowserReplicaSession  (current app-local orchestration)          |
|     |             |               |                |               |
|     |             |               |                |               |
|     v             v               v                v               |
| @e2e-col/core  @e2e-col/protocol  @e2e-col/storage @e2e-col/transport
|   Automerge      binary v1          IndexedDB       deterministic / |
|   document       envelopes          + memory        WebSocket       |
+---------------------------------------------------------|----------+
                                                          |
                                               localhost WebSocket
                                                          |
+---------------------------------------------------------v----------+
| apps/sidecar                                                        |
|                                                                      |
|  validate envelope -> chunk/base64 -> Signal JSON-RPC                |
|  Signal SSE -> base64/decode -> dedup/reassemble -> browser          |
+---------------------------------------------------------|------------+
                                                          |
                                             localhost HTTP + SSE
                                                          |
+---------------------------------------------------------v------------+
| signal-cli daemon (real) OR apps/toy-signal-cli (development mock)  |
+---------------------------------------------------------|------------+
                                                          |
                                             Signal group (real only)
                                                          |
                                                  other replicas
```

Package responsibilities:

```yaml
packages/core:
  owns: Automerge document state and text edits
  must_not_own: Signal, WebSocket, IndexedDB, React

packages/protocol:
  owns: versioned binary envelope, strict validation, chunking, dedup cache
  wire_version: 1

packages/transport:
  owns: opaque byte delivery
  adapters:
    - deterministic fault simulation
    - loopback utilities
    - browser WebSocketTransport

packages/storage:
  owns: local document snapshots and outbound queue persistence
  adapters:
    - MemoryCollaborativeStorage
    - IndexedDbCollaborativeStorage

packages/testing:
  owns: deterministic convergence and wire-path helpers

apps/web:
  owns: React demo and current BrowserReplicaSession precursor

apps/sidecar:
  owns: localhost WebSocket <-> signal-cli bridge

apps/toy-signal-cli:
  owns: deterministic development substitute for the signal-cli HTTP/SSE API
```

## 5. Prerequisites

### 5.1 Node.js and pnpm

This repository is a **pnpm workspace**. Use pnpm for normal development even
though some older project docs still show npm-compatible command spellings.

The current dependency set includes Vite 8, whose Node engine requirement is
`^20.19.0 || >=22.12.0`. Node 24 LTS is the recommended baseline for a new
setup.

The documentation pass was verified with:

```text
Node.js  v24.18.0
pnpm     11.3.0
npm      11.16.0   # present, but not the repository's canonical package manager
```

Install pnpm with Corepack or your system package manager, then verify:

```bash
node --version
pnpm --version
```

### 5.2 Browser requirements

Use a current Chromium- or Firefox-family desktop browser with:

- WebAssembly support for Automerge;
- IndexedDB;
- WebSocket support;
- modern ES modules.

The Playwright suite targets Chromium, Firefox, and WebKit. On some Linux hosts,
Playwright's WebKit runtime may require extra distribution libraries even when
Chromium and Firefox run locally.

### 5.3 Real Signal-only prerequisites

You only need these for the optional live integration path:

- a current `signal-cli` release;
- JRE 25 or newer for the JVM distribution;
- an existing Signal account on a primary phone;
- a linked `signal-cli` device;
- a Signal group shared by the test participants;
- a private writable `signal-cli` data directory.

`signal-cli` explicitly needs to stay current with Signal server changes. Do not
hard-pin an old tutorial version indefinitely.

## 6. Clone, install, and verify the workspace

Set `E2E_COL_REPOSITORY_URL` to the clone URL for the repository you intend to
use, then run:

```bash
git clone "$E2E_COL_REPOSITORY_URL" e2e-col
cd e2e-col

# Optional: fetch the preserved research prototype as well.
git submodule update --init --recursive

pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` currently performs:

```text
version:check
  -> typecheck
  -> lint
  -> format:check
  -> Vitest unit/integration tests
  -> workspace build
```

Run browser E2E separately:

```bash
pnpm exec playwright install chromium firefox
pnpm run test:e2e
```

If you want every locally supported release gate in one command:

```bash
pnpm run check:release
```

## 7. Start the local two-replica demo

```bash
pnpm run dev
```

Vite normally serves the app at:

```text
http://localhost:5173/
```

You should see:

```text
+---------------------------+  +---------------------------+
| Replica A       connected |  | Replica B       connected |
|                           |  |                           |
| [ editable textarea ]     |  | [ editable textarea ]     |
|                           |  |                           |
+---------------------------+  +---------------------------+
```

Type into **Replica A**. Replica B should update to the same text. Then edit
Replica B and confirm Replica A converges.

These are separate `CollaborativeDocument` instances. In the default demo their
frames travel through a deterministic in-process transport, so this proves the
core/protocol/storage/transport composition without requiring Signal.

## 8. `signal-cli` and the sidecar

### 8.1 Why `signal-cli` is needed

Browsers should not own Signal device credentials. `signal-cli` runs as a local
linked Signal device and exposes a daemon API. `apps/sidecar` connects to that API
and offers the browser a much narrower binary WebSocket boundary.

The sidecar talks to these `signal-cli` HTTP endpoints:

```text
GET  /api/v1/check   # daemon health
POST /api/v1/rpc     # JSON-RPC commands, including send
GET  /api/v1/events  # Server-Sent Events receive stream
```

The Signal message body used by the sidecar is transport encoding only:

```text
e2e-col:v1:<base64-of-binary-@e2e-col/protocol-frame>
```

The semantic protocol remains the binary envelope from `@e2e-col/protocol`.
The production compatibility audit for this release line targets signal-cli
v0.14.7. Startup verifies HTTP health and visibility of every configured Signal
group before the sidecar accepts browser connections. Version probing is
best-effort because the v0.14.7 JSON-RPC manual does not document a version RPC.

### 8.2 Installing real `signal-cli`

Use the current upstream release page rather than a stale package recipe. On
Linux, the upstream JVM distribution can be installed with the same pattern the
project documents:

```bash
VERSION=$(curl -Ls -o /dev/null -w '%{url_effective}' \
  https://github.com/AsamK/signal-cli/releases/latest | sed -e 's/^.*\/v//')

curl -L -O \
  "https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}.tar.gz"

sudo tar xf "signal-cli-${VERSION}.tar.gz" -C /opt
sudo ln -sf "/opt/signal-cli-${VERSION}/bin/signal-cli" /usr/local/bin/signal-cli

signal-cli --version
java --version
```

Current `signal-cli` JVM releases require Java 25. The upstream distributions
bundle `libsignal-client` for common x86_64 Linux, Windows, and macOS targets;
other architectures may need additional native-library setup.

## 9. Mock Signal setup for development

For development you do **not** need a Signal account. The repository includes
`apps/toy-signal-cli`, a deterministic local daemon that implements the exact
HTTP JSON-RPC/SSE surface consumed by `SignalCliHttpBackend`.

It provides:

- `/api/v1/check`, `/api/v1/rpc`, and `/api/v1/events`;
- two fixed demo accounts;
- one fixed demo group;
- send/list/link-compatible JSON-RPC semantics used by tests;
- fault controls for dropped, duplicated, delayed, and failed sends;
- no Signal service connection, cryptography, or real device provisioning.

### 9.1 Terminal 1 — start the toy daemon

```bash
pnpm --filter @e2e-col/toy-signal-cli dev
```

Expected output includes:

```text
toy signal-cli listening on http://127.0.0.1:18080
demo accounts: +15550000001, +15550000002
demo group: VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==
contract: /__toy__/v1/contract
```

Verify its health and contract:

```bash
curl -fsS http://127.0.0.1:18080/api/v1/check
curl -fsS http://127.0.0.1:18080/__toy__/v1/contract
```

### 9.2 Terminal 2 — start one sidecar against the toy daemon

The web demo's built-in document UUID is:

```text
11111111-1111-4111-8111-111111111111
```

Start a sidecar for toy account A:

```bash
export SIGNAL_CLI_HTTP_URL='http://127.0.0.1:18080'
export SIGNAL_CLI_ACCOUNT='+15550000001'
export E2E_COL_DOCUMENT_GROUPS='{"11111111-1111-4111-8111-111111111111":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=="}'
export E2E_COL_SIGNAL_BODY_MAX_BYTES='8192' # toy-only fixture value, not a production recommendation
export E2E_COL_SIDECAR_HOST='127.0.0.1'
export E2E_COL_SIDECAR_PORT='43127'

pnpm --filter @e2e-col/sidecar dev
```

Expected output:

```text
e2e-col sidecar listening on ws://127.0.0.1:43127
```

Verify the sidecar:

```bash
curl -fsS http://127.0.0.1:43127/health
```

Expected response:

```json
{"ok":true}
```

### 9.3 Terminal 3 — point the browser at the sidecar

```bash
VITE_E2E_COL_SIDECAR_URL='ws://127.0.0.1:43127/' pnpm run dev
```

The page's transport label should change from `deterministic local` to
`localhost sidecar`.

For a true two-account mock round trip, run **two sidecars** against the same toy
daemon, using accounts `+15550000001` and `+15550000002` on different sidecar
ports. The repository's automated
`apps/toy-signal-cli/src/sidecar-e2e.test.ts` exercises exactly that path:

```text
browser bytes A
  -> sidecar A
  -> toy signal-cli JSON-RPC/SSE
  -> sidecar B
  -> browser bytes B
```

Run that contract suite with:

```bash
pnpm run test:toy-signal-cli
```

## 10. Mock configuration reference

```yaml
toy_signal_cli:
  host_env: TOY_SIGNAL_CLI_HOST
  port_env: TOY_SIGNAL_CLI_PORT
  fixed_account_env: TOY_SIGNAL_CLI_FIXED_ACCOUNT
  defaults:
    host: 127.0.0.1
    port: 18080
    account_a: '+15550000001'
    account_b: '+15550000002'
    group_id: VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==

sidecar:
  signal_cli_url_env: SIGNAL_CLI_HTTP_URL
  signal_cli_account_env: SIGNAL_CLI_ACCOUNT
  document_groups_env: E2E_COL_DOCUMENT_GROUPS
  signal_body_max_bytes_env: E2E_COL_SIGNAL_BODY_MAX_BYTES
  allowed_origins_env: E2E_COL_ALLOWED_ORIGINS
  host_env: E2E_COL_SIDECAR_HOST
  port_env: E2E_COL_SIDECAR_PORT
  defaults:
    signal_cli_url: http://127.0.0.1:8080
    host: 127.0.0.1
    port: 43127
    signal_body_max_bytes: required_explicit_value

web:
  sidecar_url_env: VITE_E2E_COL_SIDECAR_URL
  default_transport: deterministic local
```

`E2E_COL_DOCUMENT_GROUPS` must be a non-empty JSON object mapping document UUIDs
to base64 Signal group IDs; group IDs must be unique across documents.
`E2E_COL_SIGNAL_BODY_MAX_BYTES` is also required by the production entrypoint.
It limits the complete UTF-8 `e2e-col:v1:` + base64 body after all framing
overhead. The audited signal-cli manual does not publish a stable numeric body
limit, and signal-cli v0.14.0+ can turn long text into attachments, so choose the
production value only from a verified deployment boundary rather than copying the
toy fixture value above.

## 11. Optional real Signal setup

Use this path only for integration testing. Keep all Signal state outside the
repository.

### 11.1 Create a private Signal data directory

```bash
export E2E_COL_SIGNAL_DIR="$HOME/.local/share/e2e-col/signal-cli"
mkdir -p "$E2E_COL_SIGNAL_DIR"
chmod 700 "$E2E_COL_SIGNAL_DIR"
```

This directory contains linked-device credentials and must not be committed,
served by the web app, or copied into logs/build artifacts.

### 11.2 Link a Signal device

```bash
signal-cli --data-dir "$E2E_COL_SIGNAL_DIR" link -n 'e2e-col'
```

Current releases can print a QR code in the terminal. Scan it from Signal's
**Linked devices** screen on the primary phone.

Then verify the account:

```bash
signal-cli --data-dir "$E2E_COL_SIGNAL_DIR" listAccounts
```

Set the returned account identifier:

```bash
export SIGNAL_CLI_ACCOUNT='+49...'
```

### 11.3 Create or select a test group

Create a dedicated group in Signal and add the test participants. Then discover
its group ID:

```bash
signal-cli \
  --data-dir "$E2E_COL_SIGNAL_DIR" \
  -a "$SIGNAL_CLI_ACCOUNT" \
  listGroups -d
```

Keep the resulting group ID in local environment/configuration, not committed
source:

```bash
export E2E_COL_SIGNAL_GROUP='BASE64_GROUP_ID'
```

### 11.4 Prove Signal itself works before involving e2e-col

```bash
signal-cli \
  --data-dir "$E2E_COL_SIGNAL_DIR" \
  -a "$SIGNAL_CLI_ACCOUNT" \
  send -g "$E2E_COL_SIGNAL_GROUP" \
  -m 'e2e-col transport smoke test'
```

Confirm the message arrives on the other Signal account. This isolates account,
linking, and group problems from application problems.

### 11.5 Start JSON-RPC daemon mode

```bash
signal-cli \
  --data-dir "$E2E_COL_SIGNAL_DIR" \
  -a "$SIGNAL_CLI_ACCOUNT" \
  daemon --http 127.0.0.1:8080
```

Daemon mode requires an explicit channel such as `--http` on current releases.

Verify health:

```bash
curl -fsS http://127.0.0.1:8080/api/v1/check
```

Verify JSON-RPC:

```bash
curl -fsS \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"listGroups","id":"e2e-col-check"}' \
  http://127.0.0.1:8080/api/v1/rpc
```

Observe incoming events in another terminal:

```bash
curl -N http://127.0.0.1:8080/api/v1/events
```

### 11.6 Connect the sidecar to real Signal

```bash
export SIGNAL_CLI_HTTP_URL='http://127.0.0.1:8080'
export SIGNAL_CLI_ACCOUNT='+49...'
export E2E_COL_DOCUMENT_GROUPS="{\"11111111-1111-4111-8111-111111111111\":\"${E2E_COL_SIGNAL_GROUP}\"}"
export E2E_COL_SIGNAL_BODY_MAX_BYTES='<verified-safe-text-body-byte-boundary>'

pnpm --filter @e2e-col/sidecar dev
```

The sidecar performs signal-cli health and configured-group visibility checks,
plus a non-fatal best-effort version probe, before it starts listening. A minimal
connectivity check is therefore:

```bash
curl -fsS http://127.0.0.1:43127/health
```

If it returns `{"ok":true}`, the sidecar process started successfully after
reaching the configured `signal-cli` daemon. This is a connectivity check, not
proof of a remote Signal round trip.

For release evidence, the repository now contains
`apps/sidecar/src/real-signal.smoke.test.ts`. It is disabled unless the operator
sets `E2E_COL_REAL_SIGNAL_SMOKE=1` and supplies two already-linked account/daemon
fixtures, a pre-existing shared group, and an explicit body boundary. The smoke
does not register/link accounts or mutate groups; it routes one opaque protocol
frame from sidecar A through Signal to sidecar B. Without that explicit fixture,
the test reports unavailable/skipped and the deterministic toy contract remains
the default gate.

## 12. Security notes for setup

```text
DO:
  - keep signal-cli and sidecar on loopback
  - keep signal-cli data outside the repository
  - use a dedicated test group/account path for integration work
  - validate protocol frames before CRDT application
  - treat WebSocket send success as local transport acceptance only

DO NOT:
  - expose signal-cli JSON-RPC directly to the LAN or Internet
  - paste provisioning URIs into online QR-code generators
  - commit Signal account IDs/group IDs when they are sensitive operational data
  - put Signal device state in IndexedDB or browser local storage
  - claim document-level role enforcement until authenticated access semantics land
```

The sidecar defaults to loopback and rejects a non-loopback host unless remote
use is explicitly enabled in code. Its default Origin policy also accepts only
loopback origins when an Origin header is present.

## 13. Troubleshooting setup

### `pnpm run check` fails before networking

Run the narrow failing gate first:

```bash
pnpm run typecheck
pnpm run lint
pnpm run format:check
pnpm test
pnpm run build
```

Do not debug Signal until the local repository is healthy.

### Toy daemon is unreachable

```bash
curl -v http://127.0.0.1:18080/api/v1/check
```

If the default port is busy:

```bash
TOY_SIGNAL_CLI_PORT=18081 pnpm --filter @e2e-col/toy-signal-cli dev
```

and update `SIGNAL_CLI_HTTP_URL` accordingly.

### Sidecar exits immediately

The most common cause is a missing document-group mapping:

```bash
printf '%s\n' "$E2E_COL_DOCUMENT_GROUPS"
```

It must be valid non-empty JSON of the form:

```json
{"11111111-1111-4111-8111-111111111111":"GROUP_ID"}
```

### Sidecar cannot reach real signal-cli

Debug from the lowest layer upward:

```text
signal-cli process
  -> GET /api/v1/check
  -> JSON-RPC listGroups/send
  -> SSE /api/v1/events
  -> sidecar /health
  -> browser WebSocket
  -> protocol decode
  -> CRDT apply
```

### Browser still says `deterministic local`

Make sure the variable is set in the environment that starts Vite:

```bash
VITE_E2E_COL_SIDECAR_URL='ws://127.0.0.1:43127/' pnpm run dev
```

Vite reads `VITE_*` variables at startup, so restart the development server after
changing it.

## 14. Where to go next

The rest of the 0.5.0 release documentation suite adds a hands-on tutorial, a
package API reference, and a developer/contributor guide. Until those files are
present in your checkout, the existing [live tutorial](../LIVE-TUTORIAL.md),
[target API specification](../TARGET-API-SPEC.md), and
[implementation-status matrix](../API-IMPLEMENTATION-STATUS.md) are the
canonical deeper references.
