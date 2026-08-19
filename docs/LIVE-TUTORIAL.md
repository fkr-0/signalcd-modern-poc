# Hands-on go-live tutorial

This guide shows how to run `e2e-col` today, how to prepare a real Signal
transport, and exactly what remains before two remote browsers can collaborate
through Signal.

The repository now has the Automerge core, binary protocol, deterministic and
WebSocket transports, IndexedDB persistence/outbound replay, a Node.js Signal
sidecar, and test harnesses. The remaining deployment distinction is evidence:
the sidecar contract is locally tested, while a real two-account Signal smoke
test still requires linked devices and a live collaboration group.

Status in this guide is based on the repository state on **2026-08-19**.

## 1. What “live” means

There are three useful deployment levels:

| Level                         | Result                                                       | Current state                                                 |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Local demo                    | Two independent Automerge replicas in one browser tab        | Ready now                                                     |
| Local browser + sidecar       | Browser connects to a localhost WebSocket companion          | Implemented and contract-testable                             |
| Two-user Signal collaboration | Two machines exchange protocol frames through a Signal group | Implementation present; live two-account smoke still required |

The fastest useful path is therefore:

```text
clone
  -> install
  -> verify
  -> run local two-replica demo
  -> prepare and verify signal-cli independently
  -> configure/run sidecar
  -> configure a production browser instance to use WebSocketTransport
  -> run two-machine Signal smoke test
  -> add persistence/restart hardening
```

## 2. Requirements

### 2.1 Local browser demo

Required:

- Git;
- Node.js compatible with Vite 7;
- npm;
- a current desktop browser.

Vite 7 requires Node.js `20.19+` or `22.12+`. For a new installation, Node 24
LTS is a good baseline. This repository was locally verified with Node
`v24.18.0` and npm `11.16.0` on 2026-08-19.

References:

- [Vite 7 Node.js requirements](https://v7.vite.dev/guide/)
- [Node.js downloads](https://nodejs.org/en/download)

### 2.2 Real Signal transport

In addition to the browser requirements, each machine participating through
Signal needs:

- a current `signal-cli` release;
- Java Runtime Environment 25 or newer for the JVM distribution;
- an existing Signal account on a primary phone;
- `signal-cli` linked as an additional device;
- a Signal group shared by the collaborators;
- a private writable directory for `signal-cli` device state;
- the `e2e-col` sidecar process running on localhost.

As of 2026-08-19 the latest upstream release observed while validating this
guide is `signal-cli` `0.14.7` (released 2026-08-01). Do not treat that version as permanently pinned:
`signal-cli` explicitly warns that it must stay current with Signal server
changes and that old releases can stop working.

Current upstream references:

- [`signal-cli` repository and installation requirements](https://github.com/AsamK/signal-cli)
- [`signal-cli` command manual](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli.1.adoc)
- [`signal-cli` JSON-RPC manual](https://github.com/AsamK/signal-cli/blob/master/man/signal-cli-jsonrpc.5.adoc)
- [`signal-cli` releases](https://github.com/AsamK/signal-cli/releases)

The normal x86_64 Linux, Windows, and macOS distributions bundle the required
`libsignal-client` native library. Other architectures may need additional
native-library setup; follow the current upstream installation notes rather than
copying an old package recipe.

## 3. Run the project locally now

### Step 1 — clone and enter the repository

If you already have the project locally, skip the clone.

```bash
git clone <your-e2e-col-repository-url> e2e-col
cd e2e-col
```

### Step 2 — verify Node and npm

```bash
node --version
npm --version
```

Use Node 24 LTS when possible. At minimum, satisfy the Vite 7 Node requirement
above.

### Step 3 — install exactly from the lockfile

```bash
npm ci
```

Use `npm ci` for a reproducible checkout. Use `npm install` only when you intend
to change dependency resolution and update `package-lock.json`.

### Step 4 — run the verification gate

```bash
npm run check
```

This runs the repository's typecheck, lint, formatting check, tests, and build.
Before debugging networking, make this gate green.

For the browser E2E suite, install Playwright's browser once if necessary and
then run the release-level check:

```bash
npx playwright install chromium
npm run test:e2e
```

### Step 5 — start the development UI

```bash
npm run dev
```

Vite normally serves the current application at:

```text
http://localhost:5173/
```

The repository was smoke-tested at `http://127.0.0.1:5173/` while this guide was
written.

### Step 6 — prove collaboration in the current demo

The page shows two editor panes, `Replica A` and `Replica B`.

1. Type into Replica A.
2. Confirm Replica B updates.
3. Type into Replica B.
4. Confirm Replica A converges to the same text.

These are independent `CollaborativeDocument` instances. Their updates travel
through the shared `@e2e-col/protocol`, `@e2e-col/transport`, and
`@e2e-col/storage` packages. The in-page demo still uses a deterministic local
transport, so it proves the integrated client path but does **not** prove live
Signal delivery.

### Step 7 — build production web assets

```bash
npm run build
```

The web workspace produces a Vite production build. Do not expose this as a
remote collaborative service yet: until the sidecar, durable storage, and access
semantics are complete, the build is a development proof rather than a secure
multi-user deployment.

## 4. Understand the final live topology

The intended first production topology is deliberately local-first:

```text
Machine A                                      Machine B

Browser A                                      Browser B
   |                                              |
   | ws://127.0.0.1:<sidecar-port>                | ws://127.0.0.1:<sidecar-port>
   v                                              v
E2E-Col sidecar A                              E2E-Col sidecar B
   |                                              |
   | HTTP/SSE JSON-RPC on localhost               | HTTP/SSE JSON-RPC on localhost
   v                                              v
signal-cli daemon A                            signal-cli daemon B
   |                                              |
   +---------------- Signal E2EE group -----------+
```

Important trust boundary:

- the browser never owns Signal credentials;
- the sidecar owns the local Signal integration;
- `signal-cli` state stays outside browser storage;
- Signal transports opaque encoded collaborative-document frames;
- the sidecar is not the authoritative plaintext document store.

For the first implementation, the cleanest local boundary is:

```yaml
signal_cli:
  bind: 127.0.0.1
  http_port: 8080
  rpc: /api/v1/rpc
  events: /api/v1/events
  health: /api/v1/check
sidecar:
  bind: 127.0.0.1
  browser_transport: WebSocket
  browser_payload: binary @e2e-col/protocol envelope
```

The sidecar defaults to `127.0.0.1:43127` and can be overridden with
`E2E_COL_SIDECAR_HOST` and `E2E_COL_SIDECAR_PORT`.

## 5. Prepare `signal-cli` before writing the sidecar

Do this independently on each machine. It lets you separate Signal/account
problems from `e2e-col` bugs.

### Step 1 — install a current `signal-cli`

Follow the current upstream release instructions and then verify:

```bash
signal-cli --version
java --version
```

For current `signal-cli` releases, Java 25 or newer is required by the JVM
build.

### Step 2 — choose an isolated data directory

Do not place Signal state inside the Git repository.

```bash
export E2E_COL_SIGNAL_DIR="$HOME/.local/share/e2e-col/signal-cli"
mkdir -p "$E2E_COL_SIGNAL_DIR"
chmod 700 "$E2E_COL_SIGNAL_DIR"
```

`signal-cli` stores passwords and cryptographic device keys in its data
directory, so treat this directory as credential material. Never commit it,
copy it into the web build, or expose it through a static file server.

### Step 3 — link `signal-cli` to the existing phone account

Run:

```bash
signal-cli --data-dir "$E2E_COL_SIGNAL_DIR" link -n "e2e-col"
```

On current releases this may render a QR code directly in the terminal. If your
build prints only an `sgnl://linkdevice?...` URI, generate the QR **locally**;
do not paste the provisioning URI into an online QR-code service.

For example, with `qrencode` installed:

```bash
printf '%s' 'sgnl://linkdevice?uuid=REDACTED&pub_key=REDACTED' | qrencode -t UTF8
```

Then, on the primary Signal phone, open the linked-devices workflow and scan the
QR code.

### Step 4 — confirm the linked account

```bash
signal-cli --data-dir "$E2E_COL_SIGNAL_DIR" listAccounts
```

Set the resulting account identifier for the remaining examples:

```bash
export E2E_COL_SIGNAL_ACCOUNT='+49...'
```

For current `signal-cli`, the account value is the account phone number in
international form (for example `+49...`). Use the value returned for your
linked account rather than hard-coding someone else's example.

### Step 5 — make sure the collaboration group is visible

Create the intended collaboration group in Signal, add both collaborators, then
run:

```bash
signal-cli \
  --data-dir "$E2E_COL_SIGNAL_DIR" \
  -a "$E2E_COL_SIGNAL_ACCOUNT" \
  listGroups -d
```

Record the base64 group ID in a local configuration file or environment
variable; do not bake a real group ID into committed source code.

```bash
export E2E_COL_SIGNAL_GROUP='BASE64_GROUP_ID'
```

### Step 6 — prove plain Signal send/receive first

Send a harmless smoke-test message:

```bash
signal-cli \
  --data-dir "$E2E_COL_SIGNAL_DIR" \
  -a "$E2E_COL_SIGNAL_ACCOUNT" \
  send -g "$E2E_COL_SIGNAL_GROUP" \
  -m 'e2e-col Signal transport smoke test'
```

Confirm it appears on the other Signal account. Do not proceed to CRDT frames
until this succeeds in both directions.

## 6. Start and verify the `signal-cli` daemon

The current daemon supports JSON-RPC over UNIX socket, TCP, or HTTP. For the
first `e2e-col` sidecar, localhost HTTP plus SSE is easy to inspect and keeps the
browser away from `signal-cli` directly.

Start it:

```bash
signal-cli \
  --data-dir "$E2E_COL_SIGNAL_DIR" \
  -a "$E2E_COL_SIGNAL_ACCOUNT" \
  daemon --http 127.0.0.1:8080
```

Current `signal-cli` daemon mode no longer assumes a channel automatically, so
specify `--http`, `--socket`, or another channel explicitly.

### Health check

```bash
curl -fsS http://127.0.0.1:8080/api/v1/check
```

A successful HTTP response proves the daemon is reachable.

### JSON-RPC check

```bash
curl -fsS \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"listGroups","id":"e2e-col-check"}' \
  http://127.0.0.1:8080/api/v1/rpc
```

### Observe incoming events

```bash
curl -N http://127.0.0.1:8080/api/v1/events
```

Incoming Signal messages should appear in the event stream. The daemon receives
continuously by default, which is preferable to occasional polling for a live
collaboration process.

## 7. What is implemented, and what still needs live validation

The repository now contains the local bridge. The remaining critical path is
live linked-device validation plus the post-`0.0.1` access-control and recovery
hardening described below.

### 7.1 `apps/sidecar` — implemented

The Node.js/TypeScript companion process now:

1. binds only to loopback by default;
2. exposes a binary WebSocket endpoint to the browser;
3. accepts a `documentId` when the browser connects;
4. validates every incoming frame with `@e2e-col/protocol`;
5. chunks oversized logical messages using the protocol package;
6. encodes binary protocol frames into a Signal-safe message representation;
7. sends those messages to the configured Signal group through JSON-RPC;
8. consumes `/api/v1/events` from `signal-cli`;
9. filters only the configured group and application message namespace;
10. decodes, validates, deduplicates, and reassembles inbound frames;
11. forwards only valid frames for the connected document to browsers;
12. reports health without logging payloads, phone numbers, provisioning URIs,
    keys, or Signal device state.

A practical application-level Signal body can be text-safe and self-identifying:

```text
e2e-col:v1:<base64-of-binary-protocol-frame>
```

The protocol package already provides the binary frame format; base64 is only a
Signal message-body transport encoding and must not become a second semantic
protocol.

The preserved upstream prototype under `upstream/` is useful implementation
evidence: its `signal-api.js` already demonstrates JSON-RPC send/receive and
base64 transfer of CRDT bytes. New code should keep those ideas but use the
strict `@e2e-col/protocol` validation, chunking, deduplication, and sidecar trust
boundary instead of copying the benchmark code directly.

### 7.2 Web runtime integration — implemented for shared contracts

`apps/web` no longer carries a private transport implementation. Its
`BrowserReplicaSession` composes the core, protocol, storage, and transport
packages. The visible two-pane demo selects a deterministic local transport;
deployment can instantiate `WebSocketTransport` against the sidecar without
changing CRDT or protocol semantics.

The production path should select transport through configuration, for example:

```text
E2E_COL_TRANSPORT=loopback   -> current local demo
E2E_COL_TRANSPORT=websocket  -> localhost sidecar
```

The UI should not contain Signal-specific logic. It should only know that a
collaborative transport connects to a document, sends bytes, receives bytes, and
reports connection state.

### 7.3 CRDT-to-protocol path — implemented

The web/transport boundary now follows the full chain:

```text
Automerge change
  -> ProtocolEnvelope(kind=automerge-change)
  -> encodeEnvelope()
  -> WebSocketTransport.send()
  -> sidecar
  -> Signal
```

On receive:

```text
Signal
  -> sidecar validation/reassembly/dedup
  -> browser WebSocket
  -> decodeEnvelope()
  -> verify documentId/kind
  -> CollaborativeDocument.applyChanges()
```

Do not send naked Automerge changes over the production WebSocket. The protocol
metadata is what gives the transport versioning, document isolation, frame kind,
dedup identity, and future control-frame compatibility.

### 7.4 Durable browser storage — implemented baseline

The storage track now supplies:

- IndexedDB document state;
- durable outbound queue;
- snapshots/checkpoints;
- schema-versioned IndexedDB initialization;
- restart recovery and outbound replay.

Further hardening still needs explicit migration fixtures, corruption recovery,
and checkpoint/compaction policy.

### 7.5 Add access semantics

The Signal group supplies encrypted transport and group membership, but the
paper-level application model still needs explicit document authorization:

- participant list;
- read/write/admin roles;
- authenticated membership/control frames;
- archive/delete behavior;
- explicit handling of retained local copies.

Until this exists, treat a Signal-backed build as an integration prototype, not
a complete secure document-sharing product.

## 8. The first real two-machine smoke test

Once `apps/sidecar` and web wiring exist, use this exact progression.

### Machine A

```bash
npm ci
npm run check
signal-cli --data-dir "$E2E_COL_SIGNAL_DIR" -a "$E2E_COL_SIGNAL_ACCOUNT" daemon --http 127.0.0.1:8080
# in another terminal
npm run dev -w @e2e-col/sidecar
# in another terminal
npm run dev -w @e2e-col/web
```

### Machine B

Repeat with Machine B's own linked Signal device state and account.

### Test sequence

1. Both sidecars report healthy `signal-cli` connectivity.
2. Both browsers open the same application document ID.
3. Type `alpha` on Machine A.
4. Observe a protocol frame leave browser A.
5. Observe a namespaced Signal message reach Machine B.
6. Observe sidecar B validate/decode it.
7. Confirm browser B becomes `alpha`.
8. Disconnect Machine B's network.
9. Edit both machines independently.
10. Restore Machine B's network.
11. Confirm both replicas converge.
12. Restart sidecar B and repeat delivery.
13. Restart browser B and verify persisted state is restored.
14. Deliver a duplicate frame and verify no duplicate edit appears.
15. Deliver shuffled chunks and verify deterministic reassembly.

The release gate for this milestone should fail unless those behaviors are
covered by automated tests as well as the manual smoke test.

## 9. Production deployment recommendations

### Keep everything local except Signal itself

For the first release, prefer one local companion per user rather than a central
sidecar service. Bind `signal-cli` and the sidecar to `127.0.0.1` or a local UNIX
socket.

Do **not** expose `signal-cli` JSON-RPC directly to the LAN or Internet.

### Serve the web UI from the local companion when possible

A robust packaged topology is:

```text
localhost companion
  ├── serves built web assets
  ├── exposes local WebSocket API
  └── talks to signal-cli over local HTTP/socket
```

That avoids remote origins needing direct access to local credential-bearing
services and makes origin/CSP configuration much easier to reason about.

### Treat logs as sensitive

Default production logs should contain:

- component state;
- frame kind;
- document/message IDs only if needed for diagnostics;
- byte counts;
- timing;
- retry/error categories.

They should not contain:

- Signal provisioning URIs;
- phone numbers unless explicitly opted in for debugging;
- message bodies;
- decoded document payloads;
- cryptographic keys or `signal-cli` data files.

`signal-cli` itself provides log-scrubbing support; still avoid verbose logging
for normal operation.

### Keep `signal-cli` current

Make the sidecar health screen report the installed `signal-cli` version and
warn when it is outside the project's tested range. Because `signal-cli` tracks
Signal server behavior, “installed once” is not a maintenance strategy.

## 10. Troubleshooting ladder

Debug from the lowest layer upward.

### Browser demo fails

```bash
npm ci
npm run check
npm run dev
```

If the test gate fails, fix that before inspecting Signal.

### `signal-cli` does not start

```bash
java --version
signal-cli --version
```

Check the current upstream release requirements. Modern `signal-cli` JVM builds
require Java 25 or newer.

### Linked device is absent

```bash
signal-cli --data-dir "$E2E_COL_SIGNAL_DIR" listAccounts
signal-cli --data-dir "$E2E_COL_SIGNAL_DIR" -a "$E2E_COL_SIGNAL_ACCOUNT" listDevices
```

Relink if necessary. Do not delete the data directory casually; it represents a
Signal device identity.

### Group is missing

```bash
signal-cli --data-dir "$E2E_COL_SIGNAL_DIR" -a "$E2E_COL_SIGNAL_ACCOUNT" listGroups -d
```

Make sure the linked device has received recent Signal state. The upstream tool
expects incoming messages to be received regularly; daemon mode does this
continuously by default.

### Daemon is down

```bash
curl -v http://127.0.0.1:8080/api/v1/check
```

If this fails, the `e2e-col` sidecar cannot be expected to work.

### JSON-RPC works but e2e-col does not

Inspect in order:

```text
sidecar signal-cli health
-> sidecar event subscription
-> Signal group filter
-> application prefix/base64 decode
-> protocol decode + validation
-> chunk reassembly/dedup
-> documentId routing
-> browser WebSocket
-> CRDT apply
```

This ordering prevents transport/account errors from being misdiagnosed as CRDT
convergence bugs.

## 11. Definition of “ready to go live”

For a real multi-user release, require all of the following:

- [ ] local `npm run check` is green;
- [ ] browser E2E tests are green;
- [ ] `signal-cli` version is current and tested;
- [ ] linked-device onboarding is documented and repeatable;
- [ ] sidecar binds locally by default;
- [ ] sidecar never exposes Signal credentials to the browser;
- [ ] browser uses versioned `@e2e-col/protocol` frames;
- [ ] malformed/unknown frames fail closed;
- [ ] chunking and dedup work across real Signal delivery;
- [ ] IndexedDB state and outbound queue survive browser restart;
- [ ] sidecar restart recovers cleanly;
- [ ] offline concurrent edits converge after reconnect;
- [ ] participant/access rules are enforced;
- [ ] logs are scrubbed of credential/document payload data;
- [ ] two-machine real-Signal E2E test passes;
- [ ] release artifacts are reproducible.

Until the sidecar, web wiring, and storage items above are implemented, the
correct description is **working local collaboration prototype with production
protocol/transport foundations**, not yet a live Signal-backed collaborative
editor.
