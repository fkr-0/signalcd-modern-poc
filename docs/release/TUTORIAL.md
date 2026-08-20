# e2e-col 0.5.0 — hands-on tutorial

> Documentation target: **0.5.0**. The checkout used to verify this tutorial still
> reports package version `0.0.1`; version bumping is intentionally outside this
> documentation phase.

This tutorial starts with the current local two-replica demo and then walks down
through the real package APIs, binary protocol, deterministic transport, browser
persistence, localhost sidecar, and the deterministic `toy-signal-cli` mock.
Every code example below is written against exports that exist in the current
repository.

One API distinction matters from the start: the repository does **not** currently
export the originally proposed convenience functions `createDocument()` or
`applyChange()`. The current equivalent is the low-level `@e2e-col/core` API:

```ts
const document = new CollaborativeDocument()
const changes = document.editText('next text')
remote.applyChanges(changes)
```

That is the API this tutorial uses. The higher-level `@e2e-col/client` facade in
`docs/TARGET-API-SPEC.md` is still a target, not a package you can import today.

## Step 1 — clone and install the pnpm workspace

### Purpose

Create a reproducible local checkout using the package manager required by
`AGENTS.md`. The repository is a pnpm workspace; do not substitute npm/yarn
commands from older documentation.

### Commands

```bash
read -r -p 'Repository clone URL: ' E2E_COL_REPOSITORY_URL
export E2E_COL_REPOSITORY_URL

git clone "$E2E_COL_REPOSITORY_URL" e2e-col
cd e2e-col

git submodule update --init --recursive
pnpm install --frozen-lockfile

node --version
pnpm --version
```

The documentation pass was verified with Node `v24.18.0` and pnpm `11.3.0`.
Current Vite 8 requires Node `^20.19.0 || >=22.12.0`; Node 24 LTS is a sensible
baseline.

### Expected result

`pnpm install --frozen-lockfile` completes without changing the lockfile. The
workspace contains these active components:

```text
packages/core
packages/protocol
packages/transport
packages/storage
packages/testing
apps/web
apps/sidecar
apps/toy-signal-cli
```

### Common errors and fixes

- **`pnpm: command not found`** — install pnpm with Corepack or your system
  package manager, then rerun `pnpm --version`.
- **Vite reports an unsupported Node engine** — upgrade Node; do not suppress the
  engine warning and then debug unrelated browser failures.
- **The lockfile would change** — make sure you cloned the intended revision and
  used `pnpm install --frozen-lockfile`. Only use a non-frozen install when you
  intentionally want to update dependency resolution.
- **Submodule checkout fails** — the active TypeScript implementation does not
  depend on the research prototype to run, so you can continue locally and fix
  submodule credentials separately.

## Step 2 — run the local two-replica demo

### Purpose

Prove the current browser composition before adding a sidecar. The default page
creates two independent `CollaborativeDocument` instances and gives each one its
own `BrowserReplicaSession` and IndexedDB database. Their bytes travel through a
shared in-process `DeterministicTransportNetwork`.

### Commands

```bash
pnpm run dev
```

Open the URL Vite prints, normally:

```text
http://localhost:5173/
```

Then:

1. type `hello from A` into **Replica A**;
2. verify **Replica B** becomes `hello from A`;
3. edit Replica B to `hello from both`;
4. verify Replica A converges to the same text.

### Expected browser observation

The page shows two textareas and two `connected` labels. The transport label is:

```text
transport: deterministic local
```

The important model is:

```text
Replica A                                  Replica B
+-----------------------+                  +-----------------------+
| CollaborativeDocument |                  | CollaborativeDocument |
+-----------+-----------+                  +-----------+-----------+
            |                                          ^
            | Automerge change                         |
            v                                          |
+-----------+-----------+    deterministic bytes      |
| BrowserReplicaSession | -----------------------------+
+-----------+-----------+
            |
            +--> its own IndexedDB snapshot/outbound store
```

The two panes are not two views over one shared Automerge object. They are
separate CRDT replicas that happen to share one deterministic network instance.
That is why the browser E2E suite can also prove that separate browser contexts
stay isolated before a shared sidecar is introduced.

### Common errors and fixes

- **Port 5173 is busy** — use the alternate URL Vite prints, or run
  `pnpm --filter @e2e-col/web dev -- --port 5174`.
- **A pane restores old text after reload** — that is IndexedDB persistence, not
  phantom network state. Clear the site data/IndexedDB database if you want a
  clean demo.
- **The page stays on `connecting`** — inspect the browser console. The session
  opens storage, creates/connects a transport, then subscribes to document
  state; failure in any of those steps leaves the pane disconnected.
- **You expect this to prove Signal delivery** — it does not. This step proves
  core/protocol/storage/session composition using an in-process deterministic
  transport only.

## Step 3 — understand core → protocol → transport → storage

### Purpose

Know which layer owns each responsibility before writing programmatic examples.
The package tour is shown in the requested order, but storage is a durability
side path rather than a network hop after transport.

```text
@e2e-col/core
  CollaborativeDocument
  editText()/spliceText() -> Automerge change bytes
              |
              v
@e2e-col/protocol
  createEnvelope()/encodeEnvelope()
  versioned, validated binary frame
              |
              v
@e2e-col/transport
  opaque Uint8Array delivery
  deterministic network OR WebSocketTransport
              |
              v
remote protocol decode -> remote core applyChanges()

@e2e-col/storage
  snapshot persistence + outbound byte queue
  used alongside the local/remote paths, not as a wire transport
```

Current package responsibilities:

| Layer | Current public surface used here | Must not own |
| --- | --- | --- |
| `@e2e-col/core` | `CollaborativeDocument`, `DocumentChange`, `TextEdit` | WebSocket, Signal, IndexedDB, React |
| `@e2e-col/protocol` | envelope types, validation, binary codec, chunking, dedup | CRDT semantics, network I/O |
| `@e2e-col/transport` | `CollaborativeTransport`, deterministic network, `WebSocketTransport` | protocol decoding, Automerge semantics |
| `@e2e-col/storage` | memory + IndexedDB snapshot/outbound queue | Signal credentials, React |

### Commands

Run each package's current typecheck:

```bash
pnpm --filter @e2e-col/core typecheck
pnpm --filter @e2e-col/protocol typecheck
pnpm --filter @e2e-col/transport typecheck
pnpm --filter @e2e-col/storage typecheck
```

### Expected result

Each command exits successfully without TypeScript diagnostics. There is no
`@e2e-col/client` package in the current workspace; `BrowserReplicaSession` in
`apps/web/src/session.ts` is the current app-local orchestration precursor.

### Common errors and fixes

- **An example imports `@e2e-col/client`** — it is target-spec material only.
  Use the current low-level packages or the app-local `BrowserReplicaSession`.
- **Transport code starts decoding Automerge internally** — keep transport
  opaque. Decode `ProtocolEnvelope` at the client/session boundary.
- **Storage is treated as remote acknowledgement** — persistence and transport
  acceptance are separate concerns. A WebSocket send does not prove a remote
  replica merged the change.

## Step 4 — create the first document with the actual core API

### Purpose

Create, edit, copy changes to a second replica, save a snapshot, and restore it
using the real exports that exist today.

Again, there is no current `createDocument()` or `applyChange()` export. Use:

```text
new CollaborativeDocument()
editText() / spliceText()
applyChanges()
save()
new CollaborativeDocument(snapshot)
```

### Commands

The sidecar workspace already carries the repository's `tsx` development runner,
so it is a convenient way to execute a TypeScript snippet without adding files:

```bash
pnpm --filter @e2e-col/sidecar exec tsx <<'TS'
import { CollaborativeDocument } from '@e2e-col/core'

const author = new CollaborativeDocument()
const changes = author.editText('Hello from replica A')

const peer = new CollaborativeDocument()
const changed = peer.applyChanges(changes)

console.log({
  changes: changes.length,
  changed,
  author: author.getText(),
  peer: peer.getText()
})

const snapshot = author.save()
const restored = new CollaborativeDocument(snapshot)
console.log({ restored: restored.getText() })
TS
```

### Expected output

```text
{
  changes: 1,
  changed: true,
  author: 'Hello from replica A',
  peer: 'Hello from replica A'
}
{ restored: 'Hello from replica A' }
```

`editText()` returns an array because one logical editor operation may map to one
or more CRDT changes over time. A no-op edit returns an empty array.
`applyChanges()` currently returns a boolean: `true` when the replica heads
changed, `false` for an empty/duplicate application.

For operation-aware edits you can use the current splice API directly:

```ts
const changes = author.spliceText({
  index: 6,
  deleteCount: 4,
  insert: 'CRDT'
})
```

### Common errors and fixes

- **`createDocument is not exported`** — correct: it is not implemented. Use
  `new CollaborativeDocument()`.
- **`applyChange is not exported`** — correct: use
  `document.applyChanges([change])` or pass the full returned changes array.
- **`RangeError: text splice is outside the current document`** — `index`,
  `deleteCount`, and `index + deleteCount` must fit the current text.
- **A duplicate change seems to be delivered twice** — Automerge change
  application is idempotent; the second `applyChanges()` returns `false`. The
  protocol layer also has `DedupCache` as a first line of defense.

## Step 5 — encode and send a protocol message over deterministic transport

### Purpose

Wrap a real Automerge change in the current v1 binary envelope, send the encoded
bytes through the deterministic/test transport, decode them at the peer, and
apply the payload to the peer's CRDT.

### Binary envelope fields

The logical v1 envelope is:

```ts
interface ProtocolEnvelope {
  version: 1
  documentId: string       // UUID
  messageId: string        // UUID
  senderId: string
  kind:
    | 'automerge-change'
    | 'snapshot'
    | 'membership'
    | 'archive'
    | 'delete'
    | 'health'
    | 'chunk'
  createdAt: number        // non-negative safe integer
  sequence?: number
  chunk?: {
    index: number
    total: number
    originalMessageId: string
    originalKind: Exclude<ProtocolEnvelope['kind'], 'chunk'>
  }
  payload: Uint8Array
}
```

`encodeEnvelope()` serializes those fields in this exact order:

```text
4 bytes   magic = 45 32 45 43 = ASCII "E2EC"
1 byte    protocol version
1 byte    kind code
1 byte    flags (bit 0 = sequence, bit 1 = chunk metadata)
8 bytes   createdAt, unsigned big-endian
[8]       sequence when flag bit 0 is set
2 + N     documentId UTF-8 length + bytes
2 + N     messageId UTF-8 length + bytes
2 + N     senderId UTF-8 length + bytes
[4]       chunk.index when chunk flag is set
[4]       chunk.total
[2 + N]   chunk.originalMessageId
[1]       chunk.originalKind code
4 + N     payload length + payload bytes
```

Current kind codes are stable in the v1 codec:

```text
1 automerge-change
2 snapshot
3 membership
4 archive
5 delete
6 health
7 chunk
```

All multibyte integers are encoded big-endian by the current writer. Decoding
rejects bad magic, unsupported versions, unknown kinds/flags, truncated/trailing
bytes, invalid UTF-8, invalid UUID IDs, oversized payloads, and inconsistent
chunk metadata before the CRDT sees the payload.

### Commands

```bash
pnpm --filter @e2e-col/sidecar exec tsx <<'TS'
import { CollaborativeDocument } from '@e2e-col/core'
import { createEnvelope, decodeEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { DeterministicTransportNetwork } from '@e2e-col/transport'

const documentId = '11111111-1111-4111-8111-111111111111'
const network = new DeterministicTransportNetwork()
const aTransport = network.createTransport('tutorial-a')
const bTransport = network.createTransport('tutorial-b')
const a = new CollaborativeDocument()
const b = new CollaborativeDocument()

bTransport.subscribe((wire) => {
  const envelope = decodeEnvelope(wire)
  if (
    envelope.documentId === documentId &&
    envelope.kind === 'automerge-change'
  ) {
    b.applyChanges([envelope.payload])
  }
})

await Promise.all([
  aTransport.connect(documentId),
  bTransport.connect(documentId)
])

const [change] = a.editText('hello over the wire')
if (!change) throw new Error('expected one Automerge change')

const envelope = createEnvelope({
  documentId,
  messageId: '22222222-2222-4222-8222-222222222222',
  senderId: 'tutorial-a',
  kind: 'automerge-change',
  createdAt: 1_787_159_200_000,
  sequence: 1,
  payload: change
})

const wire = encodeEnvelope(envelope)
console.log({
  version: envelope.version,
  kind: envelope.kind,
  bytes: wire.byteLength
})

await aTransport.send(wire)
network.flush()
console.log(b.getText())
TS
```

### Expected output

The exact byte count depends on the Automerge change representation, but the
verified current checkout prints the following for this example:

```text
{ version: 1, kind: 'automerge-change', bytes: 261 }
hello over the wire
```

### Common errors and fixes

- **`documentId` or `messageId` validation fails** — the protocol requires UUID
  strings at this boundary.
- **You send the raw Automerge `change` instead of `wire`** — that is valid only
  for low-level CRDT transport tests. Production WebSocket/sidecar traffic must
  carry encoded protocol envelopes.
- **A future/unknown kind is ignored** — the current decoder intentionally fails
  closed; do not pass unknown kinds through to the CRDT.
- **The receiver applies every decoded payload regardless of kind** — check both
  `documentId` and `kind` before calling `applyChanges()`.

## Step 6 — run `apps/toy-signal-cli` and one sidecar

### Purpose

Exercise the real sidecar HTTP/SSE integration without a Signal account. The toy
app implements the exact local daemon endpoints consumed by
`SignalCliHttpBackend`, but it does **not** implement Signal cryptography, the
Signal service, or real provisioning.

The built-in deterministic fixtures are:

```text
account A: +15550000001
account B: +15550000002
group:     VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==
document:  11111111-1111-4111-8111-111111111111
```

### Commands

Terminal 1 — start the toy daemon:

```bash
pnpm --filter @e2e-col/toy-signal-cli dev
```

Verify it:

```bash
curl -fsS http://127.0.0.1:18080/api/v1/check
curl -fsS http://127.0.0.1:18080/__toy__/v1/contract
```

Terminal 2 — start sidecar A:

```bash
export SIGNAL_CLI_HTTP_URL='http://127.0.0.1:18080'
export SIGNAL_CLI_ACCOUNT='+15550000001'
export E2E_COL_DOCUMENT_GROUPS='{"11111111-1111-4111-8111-111111111111":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=="}'
export E2E_COL_SIDECAR_HOST='127.0.0.1'
export E2E_COL_SIDECAR_PORT='43127'

pnpm --filter @e2e-col/sidecar dev
```

Verify the sidecar:

```bash
curl -fsS http://127.0.0.1:43127/health
```

### Expected output

Toy daemon startup includes:

```text
toy signal-cli listening on http://127.0.0.1:18080
demo accounts: +15550000001, +15550000002
demo group: VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==
contract: /__toy__/v1/contract
```

Sidecar startup includes:

```text
e2e-col sidecar listening on ws://127.0.0.1:43127
```

The sidecar health request returns:

```json
{"ok":true}
```

### Common errors and fixes

- **`E2E_COL_DOCUMENT_GROUPS must map document UUIDs...`** — the environment
  value must be valid non-empty JSON mapping document UUIDs to group IDs.
- **`signal-cli health check failed`** — make sure the toy daemon is running on
  the same `SIGNAL_CLI_HTTP_URL` and that `/api/v1/check` succeeds directly.
- **Port 18080/43127 is already in use** — set `TOY_SIGNAL_CLI_PORT` or
  `E2E_COL_SIDECAR_PORT` to another loopback port and update dependent URLs.
- **You expect real Signal encryption** — the toy daemon is a semantic local API
  double only. Use two real linked `signal-cli` devices for external release
  evidence.

## Step 7 — connect the browser through `WebSocketTransport`

### Purpose

Switch the current web app from its deterministic in-process transport to the
browser-to-sidecar WebSocket adapter, and understand the public transport API.

`WebSocketTransport.connect(documentId)` adds `documentId` as a query parameter
to the configured base URL. Application messages are binary
`@e2e-col/protocol` frames.

### Commands

With the toy daemon and sidecar from Step 6 still running:

```bash
VITE_E2E_COL_SIDECAR_URL='ws://127.0.0.1:43127/' \
  pnpm --filter @e2e-col/web dev
```

Open the Vite URL.

A minimal current-API usage example is:

```ts
import { CollaborativeDocument } from '@e2e-col/core'
import {
  createEnvelope,
  DedupCache,
  decodeEnvelope,
  encodeEnvelope
} from '@e2e-col/protocol'
import { WebSocketTransport } from '@e2e-col/transport'

const documentId = '11111111-1111-4111-8111-111111111111'
const document = new CollaborativeDocument()
const dedup = new DedupCache()
const transport = new WebSocketTransport({
  url: 'ws://127.0.0.1:43127/'
})

const unsubscribe = transport.subscribe((wire) => {
  const envelope = decodeEnvelope(wire)
  if (
    envelope.documentId !== documentId ||
    envelope.kind !== 'automerge-change' ||
    dedup.hasOrAdd(envelope, envelope.createdAt)
  ) {
    return
  }
  document.applyChanges([envelope.payload])
})

await transport.connect(documentId)

let sequence = 0
for (const change of document.editText('browser-side edit')) {
  sequence += 1
  await transport.send(
    encodeEnvelope(
      createEnvelope({
        documentId,
        messageId: crypto.randomUUID(),
        senderId: 'browser-example',
        kind: 'automerge-change',
        createdAt: Date.now(),
        sequence,
        payload: change
      })
    )
  )
}

// Later during shutdown:
unsubscribe()
await transport.close()
```

### Expected browser observation

The page transport label changes to:

```text
transport: localhost sidecar
```

Both replica sessions establish WebSockets to sidecar A. This proves browser →
sidecar connectivity, but one sidecar/account alone is not a two-account
round-trip.

A subtle but important UI distinction: in deterministic-local mode the two
panes communicate through the one in-page deterministic network. In sidecar mode
both panes connect to the same configured sidecar; the sidecar does not act as a
plaintext/in-process pane-to-pane relay. Use Step 8 for an actual A-sidecar ↔
B-sidecar path.

### Common errors and fixes

- **The label still says `deterministic local`** — Vite reads `VITE_*` variables
  at startup. Stop and restart the dev server with
  `VITE_E2E_COL_SIDECAR_URL` set.
- **WebSocket upgrade returns 400** — the sidecar only accepts configured
  `documentId` values. The web app currently uses the fixed UUID shown above.
- **WebSocket upgrade returns 403** — the sidecar's default Origin policy accepts
  loopback origins. Keep Vite/sidecar on loopback for this tutorial.
- **Text sent over WebSocket is dropped** — `WebSocketTransport` and the sidecar
  use binary frames. Send encoded `Uint8Array` protocol envelopes.
- **`send()` resolves, so you assume the peer merged it** — do not. It means the
  adapter accepted/wrote the bytes locally, not that a remote CRDT acknowledged
  them.

## Step 8 — prove two-sidecar/toy-account delivery and convergence

### Purpose

Exercise the closest deterministic equivalent of two users: two independent
sidecars, each scoped to one toy account, sharing the same toy Signal group.
Distinguish that real two-sidecar harness from the single-page deterministic UI.

### Commands

Keep the Step-6 toy daemon running.

Terminal 2 — sidecar A:

```bash
SIGNAL_CLI_HTTP_URL='http://127.0.0.1:18080' \
SIGNAL_CLI_ACCOUNT='+15550000001' \
E2E_COL_DOCUMENT_GROUPS='{"11111111-1111-4111-8111-111111111111":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=="}' \
E2E_COL_SIDECAR_PORT='43127' \
pnpm --filter @e2e-col/sidecar dev
```

Terminal 3 — sidecar B:

```bash
SIGNAL_CLI_HTTP_URL='http://127.0.0.1:18080' \
SIGNAL_CLI_ACCOUNT='+15550000002' \
E2E_COL_DOCUMENT_GROUPS='{"11111111-1111-4111-8111-111111111111":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=="}' \
E2E_COL_SIDECAR_PORT='43128' \
pnpm --filter @e2e-col/sidecar dev
```

The repository's most precise two-sidecar proof is the automated harness:

```bash
pnpm exec vitest run apps/toy-signal-cli/src/sidecar-e2e.test.ts
```

That test constructs exactly this path:

```text
browser-like WebSocket A
  -> SidecarBridge A
  -> SignalCliHttpBackend A
  -> toy JSON-RPC send
  -> toy SSE receive for account B
  -> SignalCliHttpBackend B
  -> SidecarBridge B
  -> browser-like WebSocket B
```

It also verifies sidecar chunking/reassembly and retry after an injected toy
JSON-RPC send failure.

For a manual browser observation, run two separate Vite origins so each one has a
different configured sidecar:

Terminal 4:

```bash
VITE_E2E_COL_SIDECAR_URL='ws://127.0.0.1:43127/' \
  pnpm --filter @e2e-col/web dev -- --host 127.0.0.1 --port 5173
```

Terminal 5:

```bash
VITE_E2E_COL_SIDECAR_URL='ws://127.0.0.1:43128/' \
  pnpm --filter @e2e-col/web dev -- --host 127.0.0.1 --port 5174
```

Open both pages and compare one replica pane on the 5173 page with one replica
pane on the 5174 page. An edit on the A-side page should reach the B-side page
through toy JSON-RPC/SSE, and vice versa.

### Expected result

The Vitest file passes all of its tests. For the manual browser setup, the
meaningful proof is cross-page/cross-sidecar propagation, not whether the two
panes inside one sidecar-backed page mirror each other exactly like the default
in-process demo.

The default single-page demo and the two-sidecar harness prove different things:

```yaml
single_page_deterministic_ui:
  replicas: 2
  transport: one in-process DeterministicTransportNetwork
  signal_boundary: none

two_sidecar_toy_harness:
  replicas/clients: separate WebSocket endpoints
  sidecars: 2
  accounts: 2 toy accounts
  transport: toy signal-cli HTTP JSON-RPC + SSE
  signal_cryptography: not implemented by toy
```

### Common errors and fixes

- **Both sidecars use the same account** — set `SIGNAL_CLI_ACCOUNT` separately;
  the two-account topology is the point of this step.
- **Both sidecars try port 43127** — sidecar B must use another port such as
  43128.
- **You edit one sidecar-backed page and expect its second local pane to update
  first** — compare across the two configured sidecars. The current React page
  is a demo shell, not an account selector.
- **A manual test passes but the automated harness fails** — trust the failing
  deterministic harness and inspect the exact sidecar/toy contract rather than
  declaring convergence proven from visual observation alone.
- **You call this a real Signal E2E test** — do not. The toy harness validates the
  local API/sidecar composition; real Signal encryption and service delivery
  still require live linked accounts.

## Step 9 — persist snapshots and outbound work with IndexedDB

### Purpose

Understand what persistence is implemented today and, equally importantly, what
durability guarantees are **not** implemented yet.

Current `IndexedDbCollaborativeStorage` uses schema version 1 with two object
stores:

```text
documents  keyPath=documentId
outbound   keyPath=id
```

The current interface is:

```ts
interface CollaborativeStorage {
  loadDocument(documentId: string): Promise<StoredDocument | undefined>
  saveDocument(document: StoredDocument): Promise<void>
  deleteDocument(documentId: string): Promise<void>
  listDocuments(): Promise<readonly StoredDocument[]>
  enqueue(record: OutboundRecord): Promise<void>
  listOutbound(documentId?: string): Promise<readonly OutboundRecord[]>
  acknowledgeOutbound(id: string): Promise<void>
  close(): Promise<void>
}
```

### Commands

Run the storage contract tests:

```bash
pnpm --filter @e2e-col/storage test
```

Then inspect browser persistence manually:

```bash
pnpm run dev
```

1. enter text in a replica;
2. reload the page at the same origin;
3. verify the replica restores its text;
4. in browser developer tools, inspect **Application/Storage → IndexedDB** and
   find the `e2e-col-Replica A` / `e2e-col-Replica B` databases.

### Expected result

The storage tests prove both the memory and IndexedDB implementations copy bytes
defensively, retain outbound records, and delete them when
`acknowledgeOutbound()` is called.

`BrowserReplicaSession.open()` currently:

1. loads the saved document snapshot;
2. constructs `CollaborativeDocument(snapshot)`;
3. connects/subscribes to transport;
4. replays records still present in the outbound store;
5. deletes each replayed record after `transport.send()` resolves.

On normal local edits it saves the new snapshot, enqueues each encoded envelope,
sends it, then acknowledges/deletes the outbound record.

### Current durability caveats

Do not overstate the current IndexedDB implementation. It does **not** yet
provide the target crash-safe client semantics from `TARGET-API-SPEC.md`:

- snapshot save and outbound enqueue are separate IndexedDB transactions, not
  one atomic `commitLocalChange()` transaction;
- successful `transport.send()` currently triggers
  `acknowledgeOutbound()` even though that send is not remote acknowledgement;
- dedup state lives in in-memory `DedupCache`, not durable IndexedDB state;
- there is no durable seen-message/checkpoint store;
- there is no implemented checkpoint/compaction policy proving which outbound
  changes are safe to remove;
- schema migration/corruption recovery is still minimal beyond opening schema
  version 1.

These limitations mean current persistence is a useful baseline and demo
feature, not yet a proof that every locally visible edit survives every crash
window and eventually reaches every peer.

### Common errors and fixes

- **`IndexedDB is unavailable`** — use a normal modern browser context. Some
  hardened/private test contexts can disable persistence.
- **Reload restores text you wanted to discard** — delete the site's IndexedDB
  data or use another origin/port for a clean demo.
- **Outbound queue is empty immediately after an online edit** — the current
  session acknowledges/removes the record after `transport.send()` resolves.
  That is current behavior, not proof of remote merge.
- **You need crash-safe at-least-once delivery** — the target requires atomic
  snapshot+outbound persistence plus durable checkpoint/dedup semantics; those
  APIs are documented targets, not current implementations.

## Step 10 — deterministic fault tolerance: delay, duplicate, reorder, drop, offline

### Purpose

Make failure modes reproducible. `DeterministicTransportNetwork` and
`CollaborativeScenario` deliberately expose virtual time, duplicate delivery,
held/reordered frames, offline backlogs, and explicit drops.

The current semantics are important:

```yaml
delay:
  behavior: delivery waits for virtual time/flush
  expected: eventual convergence when all valid changes arrive

duplicate:
  behavior: extra copies are scheduled
  expected: Automerge remains idempotent; protocol wire tests also use DedupCache
reorder:
  behavior: held deliveries can be released FIFO or LIFO
  expected: convergence after all changes arrive
offline:
  retainOffline_default: true
  behavior: inbound bytes queue for the offline receiver
  expected: reconnect drains backlog and converges
drop:
  behavior: delivery is removed and recovery-required event is emitted
  expected: no automatic convergence from the missing change alone
```

A dropped frame is therefore intentionally different from a temporarily offline
receiver. The deterministic transport tells higher layers that recovery is
required; the not-yet-extracted production client/checkpoint layer owns the
recovery policy.

### Commands

Run a self-contained scenario:

```bash
pnpm --filter @e2e-col/sidecar exec tsx <<'TS'
import { CollaborativeScenario } from '@e2e-col/testing'

const reordered = new CollaborativeScenario({
  network: {
    faults: [
      { send: 1, hold: true, duplicate: 1 },
      { send: 2, hold: true }
    ]
  }
})
reordered.addPeer('a')
reordered.addPeer('b')
await reordered.connect()
await reordered.editText('a', 'left')
await reordered.editText('b', 'right')
reordered.releaseHeld('lifo')
console.log('reorder+duplicate', reordered.converged())

const offline = new CollaborativeScenario()
offline.addPeer('a')
offline.addPeer('b')
await offline.connect()
await offline.disconnect('b')
await offline.editText('a', 'queued while offline')
console.log('offline backlog', offline.metrics('b').pendingInbound)
await offline.reconnect('b')
console.log('offline recovered', offline.converged())

const dropped = new CollaborativeScenario({
  network: { faults: [{ send: 1, drop: true }] }
})
dropped.addPeer('a')
dropped.addPeer('b')
await dropped.connect()
await dropped.editText('a', 'lost')
console.log(
  'drop',
  dropped.converged(),
  dropped.peer('b').recoveryEvents[0]?.reason
)
TS
```

Then run the repository tests that cover both raw CRDT scenario behavior and the
encoded protocol wire path:

```bash
pnpm exec vitest run \
  packages/testing/src/scenario.test.ts \
  packages/testing/src/wire-path.test.ts
```

### Expected output

The verified scenario snippet prints:

```text
reorder+duplicate true
offline backlog 1
offline recovered true
drop false dropped-frame
```

The Vitest command should pass the deterministic convergence, offline backlog,
drop/recovery-signal, malformed-wire rejection, duplicate, and reordered encoded
wire tests.

### Delay example

Delay is virtual, not a real sleep. For example:

```ts
const delayed = new CollaborativeScenario({ network: { latencyMs: 50 } })
delayed.addPeer('a')
delayed.addPeer('b')
await delayed.connect()
await delayed.editText('a', 'later')

// Not delivered before virtual time advances.
delayed.advanceBy(49)
console.log(delayed.peer('b').document.getText()) // ''

delayed.advanceBy(1)
console.log(delayed.peer('b').document.getText()) // 'later'
```

### Common errors and fixes

- **You use wall-clock sleeps to test the deterministic network** — use
  `advanceBy()`, `flush()`, or `releaseHeld()` instead.
- **A drop test does not converge** — that is expected. The drop emits a
  `dropped-frame` recovery signal; missing data needs a higher-level replay or
  snapshot/checkpoint recovery policy.
- **An offline test reports a drop** — make sure `retainOffline` was not set to
  `false`. Its default is `true` specifically to model an asynchronous retained
  delivery substrate.
- **A duplicate edit appears twice in visible text** — reproduce it with the
  core/protocol tests. Duplicate Automerge changes should be idempotent, and
  protocol-level message dedup should prevent repeated application when message
  identity is retained.

## Verification commands for this tutorial

For a focused pass after editing tutorial examples, run:

```bash
pnpm --filter @e2e-col/web typecheck
pnpm exec vitest run \
  packages/core/src/collaborative-document.test.ts \
  packages/protocol/src/protocol.test.ts \
  packages/transport/src/websocket-transport.test.ts \
  packages/storage/src/storage.test.ts \
  packages/testing/src/scenario.test.ts \
  packages/testing/src/wire-path.test.ts \
  apps/toy-signal-cli/src/sidecar-e2e.test.ts
pnpm exec playwright test --project=chromium
```

The repository-wide gate is still:

```bash
pnpm run check
```

Phase 1 recorded a Biome 2.5 formatting/import-organization blocker in unrelated
dirty files. During this Phase 2 pass that blocker stopped reproducing after
concurrent cleanup settled, and `pnpm run check` passed without this tutorial
mass-formatting or otherwise rewriting unrelated files. If the Biome diagnostics
reappear in another dirty checkout, preserve unrelated work and diagnose the
specific current failures rather than running a repository-wide write-format as
a documentation side effect.

## What you have proven

After completing all ten steps you have exercised the current implementation at
increasing trust boundaries:

```text
1. reproducible pnpm checkout
2. two independent in-browser CRDT replicas
3. real low-level package boundaries
4. current CollaborativeDocument API
5. Automerge change -> v1 binary envelope -> deterministic bytes -> remote CRDT
6. real sidecar against deterministic signal-cli HTTP/SSE semantics
7. browser WebSocketTransport -> localhost sidecar
8. two independent sidecars/toy accounts across JSON-RPC + SSE
9. current IndexedDB snapshot/outbound persistence baseline
10. deterministic delay/duplicate/reorder/offline/drop behavior
```

The remaining production gap is not whether the pieces can exchange and merge
changes. It is the stronger client contract around atomic local durability,
persistent dedup/checkpointing, replay/compaction policy, authenticated document
roles, and external two-account real-Signal evidence. Those are deliberately
kept distinct from what the current code already proves.
