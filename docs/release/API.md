# e2e-col 0.5.0 — current API reference

> **Archived forward-looking draft.** This document was prepared for a proposed 0.5.0 documentation target before the current 0.0.3 implementation state. It is preserved as design/history, not as the authoritative current release guide. Start at [`../index.md`](../index.md) and the generated [`/api/`](/api/) reference instead.


> Documentation target: **0.5.0**. The checkout used to verify this reference still reports package
> version `0.0.1`.
>
> This document is intentionally implementation-first. **IMPLEMENTED** means the symbol/behavior is
> present in the current source. **TARGET / MISSING** means it appears in the design specification
> but cannot currently be imported or relied on as implemented behavior.

See the [introduction](INTRO.md) for setup, the [tutorial](TUTORIAL.md) for a complete walkthrough,
and the [developer guide](DEVELOPER.md) for contribution workflows. The intended future contract is
specified separately in [`TARGET-API-SPEC.md`](../TARGET-API-SPEC.md).

## 1. API status at a glance

```yaml
implemented_packages:
  - '@e2e-col/core'
  - '@e2e-col/protocol'
  - '@e2e-col/transport'
  - '@e2e-col/storage'
  - '@e2e-col/testing'

implementation_apps:
  apps/sidecar:
    package_exports_field: absent
  apps/toy-signal-cli:
    package_exports_field: absent

missing_target_packages:
  - '@e2e-col/client'

protocol_wire_version: 1
```

All five library workspaces are currently private packages whose root `exports` field points to
`src/index.ts`. The app packages are also private, but `apps/sidecar` and `apps/toy-signal-cli` do
**not** define package exports; their exported TypeScript declarations are repository-internal
module surfaces used by tests/implementation.

## 2. `@e2e-col/core` — IMPLEMENTED

### 2.1 Exports

```ts
export type DocumentChange = Uint8Array
export type DocumentSubscriber = (text: string) => void

export interface TextEdit {
  index: number
  deleteCount: number
  insert: string
}

export class CollaborativeDocument { /* methods below */ }
```

No other core types are currently exported. In particular, `DocumentView`, `ApplyResult`,
`DocumentSnapshot`, `getView()`, and `mergeSnapshot()` are target-only.

### 2.2 `CollaborativeDocument`

#### Constructor

```ts
new CollaborativeDocument(initialState?: Uint8Array)
```

With no argument, the instance loads the project's canonical empty Automerge history. With bytes,
it calls `Automerge.load()` on that saved document state.

The constructor does not expose a custom core error type. Invalid Automerge snapshot bytes can
therefore surface an Automerge error.

#### `getText()`

```ts
getText(): string
```

Returns the current plain-text document value.

#### `getHeads()`

```ts
getHeads(): Automerge.Heads
```

Returns the current Automerge heads. This leaks an Automerge-specific type in the current API; the
target spec proposes hiding it behind a library-owned heads type, but that refinement is not
implemented.

#### `subscribe()`

```ts
subscribe(listener: DocumentSubscriber): () => void
```

Registers a text listener and **immediately invokes it** with the current text. The returned
function removes the listener. Local splices and remote change applications notify subscribers only
when they change the document state.

#### `editText()`

```ts
editText(nextText: string): DocumentChange[]
```

Derives one prefix/suffix-minimized splice from current text to `nextText`, delegates to
`spliceText()`, and returns the Automerge changes produced by that operation. If text is unchanged,
it returns `[]` and emits nothing.

This method is operation-aware; it does not intentionally replace the full string on every edit.

#### `spliceText()`

```ts
spliceText(edit: TextEdit): DocumentChange[]
```

Applies one text splice. Current validation requires:

```text
index >= 0
deleteCount >= 0
index <= current text length
index + deleteCount <= current text length
```

An invalid range throws:

```text
RangeError: text splice is outside the current document
```

A splice with `deleteCount === 0` and an empty insertion returns `[]` without mutation.

#### `applyChanges()`

```ts
applyChanges(changes: readonly DocumentChange[]): boolean
```

Applies Automerge changes and compares heads before/after. It returns:

- `true` when heads changed;
- `false` for an empty input or duplicate/already-applied changes.

Duplicate Automerge change delivery is therefore idempotent at this layer.

#### `save()`

```ts
save(): Uint8Array
```

Returns a complete Automerge snapshot suitable for the constructor.

#### `clone()`

```ts
clone(): CollaborativeDocument
```

Creates a new `CollaborativeDocument` from `save()`.

### 2.3 Core example

```ts
import { CollaborativeDocument } from '@e2e-col/core'

const author = new CollaborativeDocument()
const peer = new CollaborativeDocument()

const changes = author.editText('hello')
console.log(author.getText()) // hello
console.log(peer.applyChanges(changes)) // true
console.log(peer.getText()) // hello
console.log(peer.applyChanges(changes)) // false: duplicate

const restored = new CollaborativeDocument(author.save())
console.log(restored.getText()) // hello
```

## 3. `@e2e-col/protocol` — IMPLEMENTED

The protocol root re-exports every declaration from `types.ts`, `validation.ts`, `codec.ts`,
`chunking.ts`, and `dedup.ts`.

### 3.1 Constants

```ts
export const PROTOCOL_VERSION = 1 as const
export const SUPPORTED_PROTOCOL_VERSIONS = [PROTOCOL_VERSION] as const

export const ENVELOPE_KINDS = [
  'automerge-change',
  'snapshot',
  'membership',
  'archive',
  'delete',
  'health',
  'chunk'
] as const

export const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
export const MAX_CHUNKS = 4096
export const DEFAULT_CHUNK_PAYLOAD_BYTES = 32 * 1024
```

The generic envelope recognizes the control/lifecycle kinds shown above, but recognizing a kind is
not the same as implementing its application semantics. Typed membership/access/lifecycle payload
codecs are **missing**; see [Target-only surfaces](#10-target--missing-surfaces).

### 3.2 Types

```ts
export type ProtocolVersion = typeof PROTOCOL_VERSION
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number]
export type NonChunkEnvelopeKind = Exclude<EnvelopeKind, 'chunk'>

export interface ChunkMetadata {
  readonly index: number
  readonly total: number
  readonly originalMessageId: string
  readonly originalKind: NonChunkEnvelopeKind
}

export interface ProtocolEnvelope {
  readonly version: ProtocolVersion
  readonly documentId: string
  readonly messageId: string
  readonly senderId: string
  readonly kind: EnvelopeKind
  readonly createdAt: number
  readonly sequence?: number
  readonly chunk?: ChunkMetadata
  readonly payload: Uint8Array
}

export type ProtocolEnvelopeInput = Omit<ProtocolEnvelope, 'version'> & {
  readonly version?: ProtocolVersion
}

export interface ChunkEnvelopeOptions {
  readonly maxPayloadBytes?: number
  readonly createMessageId?: () => string
}

export interface DedupCacheOptions {
  readonly maxEntries?: number
  readonly ttlMs?: number
}
```

### 3.3 `ProtocolValidationError`

```ts
export class ProtocolValidationError extends Error {
  readonly path: string
}
```

The error name is `ProtocolValidationError`, `path` identifies the failing logical location, and the
message is formed as:

```text
<path>: <reason>
```

Examples include `documentId`, `chunk.total`, `codec`, and `version`.

### 3.4 Validation and ID functions

#### `isSupportedProtocolVersion()`

```ts
isSupportedProtocolVersion(value: unknown): value is ProtocolVersion
```

Currently true only for numeric value `1`.

#### `assertSupportedProtocolVersion()`

```ts
assertSupportedProtocolVersion(value: unknown): asserts value is ProtocolVersion
```

Throws `ProtocolValidationError` for any unsupported version.

#### `validateEnvelope()`

```ts
validateEnvelope(value: unknown): ProtocolEnvelope
```

The validator is strict:

- the envelope must be a non-array object;
- unknown envelope and chunk fields are rejected;
- `documentId` and `messageId` must be UUID-form strings;
- `senderId` must be non-empty and at most 512 characters;
- `createdAt`, optional `sequence`, chunk index, and chunk total use non-negative safe integers;
- payload must be a `Uint8Array` no larger than `MAX_PAYLOAD_BYTES`;
- the returned payload is defensively copied;
- a `chunk` envelope requires chunk metadata;
- non-chunk envelopes may not carry chunk metadata;
- chunk `total` must be between 2 and `MAX_CHUNKS`;
- chunk `index < total`;
- `originalMessageId` must be a UUID;
- `originalKind` may not itself be `chunk`.

#### `createEnvelope()`

```ts
createEnvelope(input: ProtocolEnvelopeInput): ProtocolEnvelope
```

Supplies version `1` when omitted, then delegates to `validateEnvelope()`.

#### `createProtocolId()`

```ts
createProtocolId(): string
```

Returns `globalThis.crypto.randomUUID()`. If that function does not exist, it throws:

```text
Error: crypto.randomUUID is required to create protocol identifiers
```

### 3.5 Binary codec

#### `encodeEnvelope()`

```ts
encodeEnvelope(value: ProtocolEnvelope): Uint8Array
```

Re-validates the logical envelope before encoding it.

#### `decodeEnvelope()`

```ts
decodeEnvelope(bytes: Uint8Array): ProtocolEnvelope
```

Rejects non-`Uint8Array` input and malformed wire data with `ProtocolValidationError`.

The current v1 layout is:

```text
4 bytes   magic: 45 32 45 43 (ASCII "E2EC")
1 byte    version
1 byte    kind code
1 byte    flags
8 bytes   createdAt, unsigned big-endian
[8]       sequence if flag bit 0 is set
2 + N     documentId UTF-8 byte length + bytes
2 + N     messageId UTF-8 byte length + bytes
2 + N     senderId UTF-8 byte length + bytes
[4]       chunk.index if flag bit 1 is set
[4]       chunk.total
[2 + N]   chunk.originalMessageId
[1]       chunk.originalKind code
4 + N     payload byte length + payload
```

Current kind codes are:

| Code | Kind |
| ---: | --- |
| 1 | `automerge-change` |
| 2 | `snapshot` |
| 3 | `membership` |
| 4 | `archive` |
| 5 | `delete` |
| 6 | `health` |
| 7 | `chunk` |

Flags currently use bit 0 for `sequence` and bit 1 for chunk metadata. Unknown flags are rejected.
Strings are strict/fatal UTF-8. The decoder also rejects:

- invalid magic;
- protocol versions other than 1;
- unknown kind codes;
- truncated input;
- trailing bytes;
- integer values outside the JavaScript safe-integer range;
- payload lengths above the protocol maximum;
- any logical validation failure after decoding.

The protocol test suite pins a complete encoded v1 byte fixture. Changing the byte interpretation is
a compatibility decision, not merely an implementation refactor.

### 3.6 Chunking

#### `chunkEnvelope()`

```ts
chunkEnvelope(
  input: ProtocolEnvelope,
  options: ChunkEnvelopeOptions = {}
): ProtocolEnvelope[]
```

Behavior:

- validates the input first;
- rejects attempts to chunk an existing `chunk` envelope;
- default payload target is `DEFAULT_CHUNK_PAYLOAD_BYTES` (32 KiB at package level);
- `maxPayloadBytes` must be a positive safe integer;
- if the payload fits, returns one validated non-chunk envelope;
- otherwise emits `chunk` frames with per-frame `messageId`s;
- the logical message ID/kind are preserved in `ChunkMetadata`;
- a custom `createMessageId` factory may be supplied for deterministic fixtures;
- duplicate IDs returned by that factory are rejected;
- more than `MAX_CHUNKS` is rejected.

Note that `SidecarBridge` currently chooses a smaller default chunk payload of **24 KiB** for its
Signal body path. That is a sidecar option, not a change to the protocol package constant.

#### `reassembleChunks()`

```ts
reassembleChunks(inputs: readonly ProtocolEnvelope[]): ProtocolEnvelope
```

Requires a complete logical set. It verifies matching document, sender, creation time, sequence,
chunk count, original message ID, and original kind. Identical duplicate chunk indexes are ignored;
a duplicate index with different payload bytes is rejected. Reassembly order is chunk index, not
arrival order.

The final payload remains capped at `MAX_PAYLOAD_BYTES`.

### 3.7 `DedupCache`

```ts
export class DedupCache {
  constructor(options?: DedupCacheOptions)

  hasOrAdd(
    envelope: Pick<ProtocolEnvelope, 'documentId' | 'messageId'>,
    now?: number
  ): boolean

  prune(now?: number): void
  clear(): void
  get size(): number
}
```

Defaults:

```yaml
maxEntries: 4096
ttlMs: 86400000 # 24 hours
```

`hasOrAdd()` is keyed by `(documentId, messageId)`:

- first sighting returns `false` and stores it;
- a still-live repeat returns `true` and refreshes its recency;
- expired entries behave as unseen;
- capacity eviction removes oldest map entries.

This cache is **in-memory only**. It is not the missing durable seen-message ledger from the target
client/storage design.

### 3.8 Protocol example

```ts
import {
  createEnvelope,
  decodeEnvelope,
  DedupCache,
  encodeEnvelope
} from '@e2e-col/protocol'

const envelope = createEnvelope({
  documentId: '11111111-1111-4111-8111-111111111111',
  messageId: '22222222-2222-4222-8222-222222222222',
  senderId: 'device-a',
  kind: 'health',
  createdAt: 1,
  payload: new Uint8Array([1, 2, 3])
})

const wire = encodeEnvelope(envelope)
const decoded = decodeEnvelope(wire)
const dedup = new DedupCache()

console.log(decoded.version) // 1
console.log(dedup.hasOrAdd(decoded, 10)) // false
console.log(dedup.hasOrAdd(decoded, 11)) // true
```

The example demonstrates generic framing only. There is no current typed `health` payload schema.

## 4. `@e2e-col/transport` — IMPLEMENTED

### 4.1 Shared transport types

```ts
export type TransportConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'online'
  | 'offline'
  | 'closed'

export type TransportUpdateListener = (update: Uint8Array) => void

export interface TransportStateChange {
  readonly previous: TransportConnectionState
  readonly current: TransportConnectionState
  readonly at: number
}

export type TransportStateListener = (event: TransportStateChange) => void

export interface TransportRecoveryRequired {
  readonly documentId: string
  readonly sourceId: string
  readonly targetId: string
  readonly sendSequence: number
  readonly reason: 'dropped-frame'
}

export type TransportRecoveryListener = (event: TransportRecoveryRequired) => void

export interface TransportMetrics {
  readonly state: TransportConnectionState
  readonly connectAttempts: number
  readonly successfulConnections: number
  readonly reconnects: number
  readonly sent: number
  readonly delivered: number
  readonly received: number
  readonly dropped: number
  readonly duplicated: number
  readonly queuedOutbound: number
  readonly pendingOutbound: number
  readonly pendingInbound: number
  readonly recoverySignals: number
}
```

`delivered` is adapter-specific diagnostics. It is **not** a remote CRDT acknowledgement.

### 4.2 Interfaces

```ts
export interface CollaborativeTransport {
  connect(documentId: string): Promise<void>
  send(update: Uint8Array): Promise<void>
  subscribe(listener: TransportUpdateListener): () => void
  close(): Promise<void>
}

export interface ObservableCollaborativeTransport extends CollaborativeTransport {
  getState(): TransportConnectionState
  getMetrics(): TransportMetrics
  subscribeState(listener: TransportStateListener): () => void
  subscribeRecovery(listener: TransportRecoveryListener): () => void
}
```

Payloads are intentionally opaque to this package.

### 4.3 Deterministic network types

```ts
export interface FaultDirective {
  readonly send: number
  readonly from?: string
  readonly to?: string
  readonly drop?: boolean
  readonly delayMs?: number
  readonly duplicate?: number
  readonly hold?: boolean
}

export interface DeterministicNetworkOptions {
  readonly latencyMs?: number
  readonly faults?: readonly FaultDirective[]
  readonly retainOffline?: boolean
}

export interface ReleaseHeldOptions {
  readonly order?: 'fifo' | 'lifo'
}
```

Defaults are `latencyMs: 0` and `retainOffline: true`. Fault `send` is the global 1-based publish
sequence, optionally narrowed by source/target transport ID.

Constructor validation rejects invalid latency/fault sequence/delay/duplicate values with
`RangeError`.

### 4.4 `DeterministicTransportNetwork`

```ts
export class DeterministicTransportNetwork {
  constructor(options?: DeterministicNetworkOptions)

  get now(): number
  createTransport(id: string): SimulatedTransport
  advanceBy(milliseconds: number): void
  flush(): void
  releaseHeld(options?: ReleaseHeldOptions): void
  pendingScheduled(): number
  pendingHeld(): number
  pendingOffline(targetId?: string): number
}
```

`createTransport()` requires a non-empty unique ID. Duplicate IDs throw an error such as:

```text
transport id already exists: left
```

`advanceBy()` and `flush()` use virtual time. `releaseHeld({ order: 'lifo' })` is the explicit
reordering primitive. Offline inbound delivery is retained by default and drained when the target
returns online.

A `drop` directive removes that delivery and emits a `TransportRecoveryRequired` event to the
target. The transport does not synthesize a snapshot or replay policy.

### 4.5 `SimulatedTransport`

```ts
export class SimulatedTransport implements ObservableCollaborativeTransport {
  readonly id: string
  documentId: string | undefined

  connect(documentId: string): Promise<void>
  send(update: Uint8Array): Promise<void>
  subscribe(listener: TransportUpdateListener): () => void
  subscribeState(listener: TransportStateListener): () => void
  subscribeRecovery(listener: TransportRecoveryListener): () => void
  disconnect(): Promise<void>
  close(): Promise<void>
  getState(): TransportConnectionState
  getMetrics(): TransportMetrics
}
```

Important semantics:

- one instance can bind to one document only;
- repeated connect while already online is a no-op;
- `disconnect()` moves into recoverable `offline` state;
- send while not online is copied into an in-memory outbound queue and resolves;
- reconnect flushes that queue;
- delivered bytes are defensively copied for listeners;
- `close()` is terminal and removes the transport from the deterministic network;
- operations requiring an open transport throw `Error('transport is closed')` after close.

Metrics distinguish cumulative `queuedOutbound` from current `pendingOutbound`.

### 4.6 Loopback factory

```ts
export interface LoopbackPair {
  readonly network: DeterministicTransportNetwork
  readonly left: SimulatedTransport
  readonly right: SimulatedTransport
}

export function createLoopbackPair(
  options: DeterministicNetworkOptions = {}
): LoopbackPair
```

The factory creates transport IDs `left` and `right` on one fresh deterministic network.

Example:

```ts
import { createLoopbackPair } from '@e2e-col/transport'

const { network, left, right } = createLoopbackPair({ latencyMs: 5 })
await Promise.all([left.connect('doc'), right.connect('doc')])

right.subscribe((bytes) => console.log([...bytes]))
await left.send(new Uint8Array([1, 2]))
network.advanceBy(5) // logs [1, 2]
```

The transport accepts any non-empty document string; UUID enforcement belongs to the protocol
boundary.

### 4.7 WebSocket types

```ts
export interface WebSocketLike {
  readonly readyState: number
  binaryType: BinaryType
  send(data: ArrayBufferView | ArrayBuffer | Blob | string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

export type WebSocketFactory = (url: string) => WebSocketLike

export interface WebSocketTransportOptions {
  readonly url: string
  readonly socketFactory?: WebSocketFactory
}
```

The injectable factory exists so tests can drive socket lifecycle deterministically.

### 4.8 `WebSocketTransport`

```ts
export class WebSocketTransport implements ObservableCollaborativeTransport {
  constructor(options: WebSocketTransportOptions)
  // implements the observable transport methods
}
```

Connection behavior:

- parses the configured base URL with `new URL()` during `connect()`;
- sets/replaces the `documentId` query parameter;
- sets `binaryType = 'arraybuffer'`;
- one instance binds to one document;
- repeated connect while online is a no-op;
- connect while already `connecting` rejects;
- a synchronous socket-factory error moves state to `offline` and is rethrown;
- close/error before `open` rejects the connect promise;
- a later socket close moves an open transport to `offline`;
- reconnecting the same document creates another socket and increments reconnect metrics.

Send behavior:

- `send()` requires a `Uint8Array`;
- while disconnected/connecting/offline, it stores a defensive copy in an in-memory queue and
  resolves;
- on open, queued bytes are flushed;
- online sends call the underlying socket and increment `sent`;
- an underlying synchronous `socket.send()` exception propagates;
- after `close()`, send/connect reject with `Error('transport is closed')`.

Receive behavior:

- accepts `ArrayBuffer`, any `ArrayBufferView`, and `Blob` messages;
- string/other messages are ignored and increment `dropped`;
- binary data is copied before subscriber delivery.

The current WebSocket metrics intentionally report:

```yaml
delivered: 0
# the browser socket cannot prove remote Signal delivery
duplicated: 0
pendingInbound: 0
recoverySignals: 0
```

`subscribeRecovery()` is implemented because the class conforms to the observable interface, but
the current WebSocket adapter does not emit recovery events.

Example:

```ts
import { WebSocketTransport } from '@e2e-col/transport'

const transport = new WebSocketTransport({
  url: 'ws://127.0.0.1:43127/'
})

transport.subscribe((wire) => {
  // Decode/validate in the protocol/session layer, not in transport.
  console.log(wire.byteLength)
})

await transport.connect('11111111-1111-4111-8111-111111111111')
await transport.send(new Uint8Array([1, 2, 3]))
await transport.close()
```

Production sidecar traffic should be encoded `ProtocolEnvelope` bytes; the short example is only
showing the transport API.

## 5. `@e2e-col/storage` — IMPLEMENTED BASELINE

### 5.1 Exports

```ts
export interface StoredDocument {
  readonly documentId: string
  readonly snapshot: Uint8Array
  readonly updatedAt: number
}

export interface OutboundRecord {
  readonly id: string
  readonly documentId: string
  readonly payload: Uint8Array
  readonly createdAt: number
}

export interface CollaborativeStorage {
  loadDocument(documentId: string): Promise<StoredDocument | undefined>
  saveDocument(document: StoredDocument): Promise<void>
  deleteDocument(documentId: string): Promise<void>
  listDocuments(): Promise<readonly StoredDocument[]>
  enqueue(record: OutboundRecord): Promise<void>
  listOutbound(documentId?: string): Promise<readonly OutboundRecord[]>
  acknowledgeOutbound(id: string): Promise<void>
  close(): Promise<void>
}

export class MemoryCollaborativeStorage implements CollaborativeStorage { /* ... */ }

export function cloneDocument(value: StoredDocument): StoredDocument
export function cloneOutbound(value: OutboundRecord): OutboundRecord

export interface IndexedDbStorageOptions {
  readonly name?: string
  readonly indexedDB?: IDBFactory
}

export class IndexedDbCollaborativeStorage implements CollaborativeStorage {
  constructor(options?: IndexedDbStorageOptions)
  // implements CollaborativeStorage
}
```

`cloneDocument()` and `cloneOutbound()` are genuine current package exports even though application
code normally does not need to call them directly. They return shallow object copies with fresh
`Uint8Array` snapshot/payload storage.

### 5.2 Memory storage

`MemoryCollaborativeStorage` stores documents by `documentId` and outbound records by `id`.

Behavior:

- inputs and outputs are defensively cloned;
- documents list by `updatedAt` descending;
- outbound records list by `createdAt` ascending;
- `listOutbound(documentId)` filters by document;
- enqueuing the same `id` replaces that record in the map;
- acknowledgement removes by ID and is harmless when the ID is absent;
- `close()` is a no-op.

### 5.3 IndexedDB storage

`IndexedDbCollaborativeStorage` defaults to database name `e2e-col` and uses the supplied
`indexedDB` factory or `globalThis.indexedDB`.

If no factory exists, construction throws synchronously:

```text
Error: IndexedDB is unavailable
```

Current schema version is `1` with:

```text
documents  keyPath=documentId
outbound   keyPath=id
```

Each public operation opens its own IndexedDB transaction. Open/request/transaction failures reject
with the browser error where available or fallback messages such as:

```text
IndexedDB open failed
IndexedDB request failed
IndexedDB transaction failed
IndexedDB transaction aborted
```

`close()` resolves the database promise and closes the `IDBDatabase`.

### 5.4 Storage example

```ts
import { MemoryCollaborativeStorage } from '@e2e-col/storage'

const storage = new MemoryCollaborativeStorage()

await storage.saveDocument({
  documentId: 'doc-a',
  snapshot: new Uint8Array([1, 2]),
  updatedAt: 10
})

await storage.enqueue({
  id: 'outbound-1',
  documentId: 'doc-a',
  payload: new Uint8Array([3, 4]),
  createdAt: 11
})

console.log((await storage.loadDocument('doc-a'))?.snapshot)
console.log((await storage.listOutbound('doc-a')).length) // 1

await storage.acknowledgeOutbound('outbound-1')
await storage.close()
```

Storage itself accepts opaque string IDs. Protocol-level UUID requirements apply when those IDs are
put into protocol envelopes.

### 5.5 Current durability gaps

The package is useful and tested, but it is **not** the target durable client store yet.

Current limitations:

- saving a new snapshot and enqueueing its outbound frames are separate transactions;
- there is no atomic `commitLocalChange()` operation;
- there is no persistent inbound seen-message/dedup ledger;
- there is no durable attempted-send state;
- there is no checkpoint/snapshot compaction policy;
- there are no explicit schema migration/corruption-recovery APIs;
- `acknowledgeOutbound()` physically deletes an entry without knowing whether a remote replica
  merged it.

`apps/web/src/session.ts` currently removes an outbound record after `transport.send()` resolves.
That is current demo behavior, **not** proof of remote acknowledgement and not the stronger target
durability guarantee.

## 6. `@e2e-col/testing` — IMPLEMENTED, TEST-ONLY

This package is for deterministic tests, fixtures, and convergence experiments. It is not part of
the production application dependency path.

### 6.1 Network profiles

```ts
export const NETWORK_PROFILES = {
  off:  { latencyMs: 0,  targetRateMbps: undefined },
  fast: { latencyMs: 5,  targetRateMbps: 60 },
  slow: { latencyMs: 30, targetRateMbps: 5 }
} as const

export type NetworkProfileName = keyof typeof NETWORK_PROFILES
export type NetworkProfile = (typeof NETWORK_PROFILES)[NetworkProfileName]

export function networkProfileOptions(
  name: NetworkProfileName
): DeterministicNetworkOptions
```

`networkProfileOptions()` currently returns **latency only**. `targetRateMbps` is benchmark metadata;
`DeterministicTransportNetwork` does not simulate bandwidth throttling.

### 6.2 Scenario types

```ts
export interface CollaborativeScenarioOptions {
  readonly documentId?: string
  readonly network?: DeterministicNetworkOptions
}

export interface ScenarioPeer {
  readonly id: string
  readonly document: CollaborativeDocument
  readonly transport: SimulatedTransport
  readonly recoveryEvents: readonly TransportRecoveryRequired[]
}
```

### 6.3 `CollaborativeScenario`

```ts
export class CollaborativeScenario {
  readonly network: DeterministicTransportNetwork
  readonly documentId: string

  constructor(options?: CollaborativeScenarioOptions)
  addPeer(id: string, initialState?: Uint8Array): ScenarioPeer
  peer(id: string): ScenarioPeer
  connect(...ids: string[]): Promise<void>
  disconnect(id: string): Promise<void>
  reconnect(id: string): Promise<void>
  editText(id: string, nextText: string): Promise<DocumentChange[]>
  spliceText(id: string, edit: TextEdit): Promise<DocumentChange[]>
  flush(): void
  advanceBy(milliseconds: number): void
  releaseHeld(order?: 'fifo' | 'lifo'): void
  texts(): Readonly<Record<string, string>>
  converged(): boolean
  metrics(id: string): TransportMetrics
}
```

The default scenario document ID is `test-document`. This harness sends **raw Automerge change
bytes** over the deterministic transport intentionally; it contains no protocol framing or UI. The
separate `wire-path.test.ts` composes core + protocol + transport when the encoded wire boundary is
the subject under test.

Unknown/duplicate peer IDs produce ordinary `Error`s.

### 6.4 Delivery helpers

```ts
export interface DeliveryBatch {
  target: CollaborativeDocument
  changes: readonly DocumentChange[]
}

export function deliverBatches(batches: readonly DeliveryBatch[]): void

export function duplicateChanges(
  changes: readonly DocumentChange[]
): DocumentChange[]
```

`deliverBatches()` applies each batch in order. `duplicateChanges()` repeats each input change twice;
it is intended to test idempotence, not to make defensive byte copies.

### 6.5 Testing example

```ts
import { CollaborativeScenario } from '@e2e-col/testing'

const scenario = new CollaborativeScenario({
  network: { faults: [{ send: 1, duplicate: 1, hold: true }] }
})

scenario.addPeer('a')
scenario.addPeer('b')
await scenario.connect()
await scenario.editText('a', 'eventual')

scenario.releaseHeld('lifo')
console.log(scenario.converged()) // true
```

## 7. `apps/sidecar` — CURRENT IMPLEMENTATION MODULES

### 7.1 Package/API status

`apps/sidecar/package.json` has **no `exports` field**. Do not document these declarations as if an
external consumer can import a supported `@e2e-col/sidecar` SDK. They are implementation-level
modules used by the app and repository integration tests.

The process entry point is:

```bash
pnpm --filter @e2e-col/sidecar dev
```

### 7.2 `backend.ts`

Repository-internal declarations:

```ts
export interface BroadcastMessage {
  readonly groupId: string
  readonly message: string
  readonly account?: string
}

export interface BroadcastBackend {
  start(listener: (message: BroadcastMessage) => void): Promise<void>
  send(groupId: string, message: string): Promise<void>
  stop(): Promise<void>
}

export class MemoryBroadcastBackend implements BroadcastBackend {
  readonly sent: BroadcastMessage[]
  start(listener: (message: BroadcastMessage) => void): Promise<void>
  send(groupId: string, message: string): Promise<void>
  receive(message: BroadcastMessage): void
  stop(): Promise<void>
}
```

`MemoryBroadcastBackend` is primarily a sidecar test helper. `receive()` injects an inbound
broadcast into the registered listener.

### 7.3 `SidecarBridgeOptions`

```ts
export interface SidecarBridgeOptions {
  readonly backend: BroadcastBackend
  readonly documentGroups: Readonly<Record<string, string>>
  readonly host?: string
  readonly port?: number
  readonly chunkPayloadBytes?: number
  readonly sendAttempts?: number
  readonly retryDelayMs?: number
  readonly chunkTtlMs?: number
  readonly maxChunkSets?: number
  readonly allowRemoteHost?: boolean
  readonly allowedOrigins?: readonly string[]
}
```

Current defaults:

```yaml
host: 127.0.0.1
port: 43127
chunkPayloadBytes: 24576 # 24 KiB
sendAttempts: 3
retryDelayMs: 25
chunkTtlMs: 300000 # 5 minutes
maxChunkSets: 1024
allowRemoteHost: false
allowedOrigins: not-set # means loopback-origin policy, not allow-all
```

Without `allowRemoteHost`, constructor hosts other than `localhost`, `127.0.0.1`, `::1`, or `[::1]`
are rejected.

### 7.4 `SidecarBridge`

```ts
export class SidecarBridge {
  constructor(options: SidecarBridgeOptions)
  start(): Promise<{ host: string; port: number }>
  stop(): Promise<void>
}
```

`start()` may only be called once while running; a second call throws
`sidecar bridge is already running`.

#### Current HTTP endpoint

```text
GET /health
```

Response:

```json
{"ok":true}
```

Other ordinary HTTP requests return 404. This is the current endpoint; the richer target
`GET /api/v1/health` payload is **not implemented**.

#### Current WebSocket upgrade

The current server accepts a WebSocket upgrade when the query contains a configured document:

```text
ws://127.0.0.1:43127/?documentId=<configured-document-uuid>
```

The current implementation does not require the target `/api/v1/documents` pathname. Missing or
unconfigured `documentId` receives HTTP 400.

Origin behavior:

- no Origin header is accepted;
- when `allowedOrigins` is supplied, only exact listed strings are accepted;
- otherwise the Origin URL's hostname must be loopback;
- a rejected/malformed Origin receives HTTP 403.

#### Browser -> broadcast path

```text
binary WebSocket bytes
  -> decodeEnvelope()
  -> require envelope.documentId == connection documentId
  -> logical dedup bookkeeping
  -> chunkEnvelope() unless already a chunk
  -> encode each frame
  -> base64
  -> "e2e-col:v1:" prefix
  -> BroadcastBackend.send(groupId, body)
```

Non-binary, malformed, and wrong-document browser messages are currently ignored rather than
forwarded.

`sendFrames()` retries each frame up to `sendAttempts`, using exponential delays based on
`retryDelayMs`. Final failure logs only the generic text
`sidecar broadcast send failed after retries`; it does not throw back through the already-handled
WebSocket message callback or claim successful remote delivery.

#### Broadcast -> browser path

```text
BroadcastMessage
  -> require e2e-col:v1: prefix
  -> map group to configured document
  -> base64 decode + decodeEnvelope()
  -> require frame document match
  -> physical message dedup
  -> bounded chunk accumulator when needed
  -> reassembleChunks()
  -> logical message dedup
  -> encodeEnvelope(logical frame)
  -> send to ready WebSocket clients for that document
```

Chunk accumulator state is bounded by both TTL and `maxChunkSets`. Identical retransmitted chunk
indexes are tolerated; conflicting chunk contents discard that logical set.

`stop()` closes browser clients with WebSocket code `1001` and reason `sidecar stopping`, closes the
HTTP/WebSocket servers, then stops the broadcast backend.

### 7.5 `SignalCliHttpOptions`

```ts
export interface SignalCliHttpOptions {
  readonly baseUrl?: string
  readonly account?: string
  readonly fetch?: typeof fetch
  readonly allowRemote?: boolean
  readonly reconnectDelayMs?: number
  readonly reconnectMaxDelayMs?: number
}
```

Defaults:

```yaml
baseUrl: http://127.0.0.1:8080
allowRemote: false
reconnectDelayMs: 250
reconnectMaxDelayMs: 5000
```

A non-loopback signal-cli URL is rejected unless `allowRemote` is explicitly true.

### 7.6 `SignalCliHttpBackend`

```ts
export class SignalCliHttpBackend implements BroadcastBackend {
  constructor(options?: SignalCliHttpOptions)
  start(listener: (message: BroadcastMessage) => void): Promise<void>
  send(groupId: string, message: string): Promise<void>
  stop(): Promise<void>
}
```

`start()` first requests:

```text
GET <baseUrl>/api/v1/check
```

A non-2xx response rejects with `signal-cli health check failed: HTTP <status>`.

Sending uses:

```text
POST <baseUrl>/api/v1/rpc
content-type: application/json

{
  "jsonrpc": "2.0",
  "id": "<random UUID>",
  "method": "send",
  "params": {
    "groupId": "...",
    "message": "...",
    "account": "... only when configured ..."
  }
}
```

HTTP failure or a JSON-RPC `error` rejects the send.

Receive uses:

```text
GET <baseUrl>/api/v1/events
```

The backend parses Server-Sent Event `data:` blocks, extracts compatible Signal receive envelopes,
filters other accounts when account metadata is available, and reconnects an ended/failing stream
with exponential delay capped by `reconnectMaxDelayMs`. Stopping aborts the receive loop.

### 7.7 `parseSignalReceive()`

```ts
export function parseSignalReceive(
  value: unknown
): BroadcastMessage | undefined
```

Recognizes either a received `dataMessage` or a sender-sync `syncMessage.sentMessage`, including the
shape where signal-cli nests an envelope under `params.result`. It returns `undefined` unless both a
string message and string `groupInfo.groupId` exist. If account identity is present, the returned
message includes it.

### 7.8 Sidecar process configuration

`apps/sidecar/src/main.ts` reads:

| Environment variable | Meaning | Default |
| --- | --- | --- |
| `E2E_COL_DOCUMENT_GROUPS` | JSON map from document UUID to Signal group ID | none; empty map is rejected |
| `SIGNAL_CLI_HTTP_URL` | signal-cli daemon base URL | backend default `http://127.0.0.1:8080` |
| `SIGNAL_CLI_ACCOUNT` | optional account routed into JSON-RPC send/filtering | unset |
| `E2E_COL_SIDECAR_HOST` | sidecar host | `127.0.0.1` |
| `E2E_COL_SIDECAR_PORT` | sidecar TCP port | `43127` |

An empty document mapping fails startup with:

```text
E2E_COL_DOCUMENT_GROUPS must map document UUIDs to Signal group IDs
```

Example process launch:

```bash
E2E_COL_DOCUMENT_GROUPS='{"11111111-1111-4111-8111-111111111111":"GROUP_ID"}' \
SIGNAL_CLI_HTTP_URL='http://127.0.0.1:8080' \
SIGNAL_CLI_ACCOUNT='+49...' \
pnpm --filter @e2e-col/sidecar dev
```

### 7.9 Sidecar trust/security behavior

The current sidecar is a local companion, not a plaintext document server:

- it owns signal-cli HTTP integration so browser code does not receive linked-device credentials;
- it validates protocol framing/document routing before broadcast forwarding;
- it handles encoded Automerge payload bytes without performing CRDT merges;
- it binds to loopback by default;
- its default browser Origin policy is loopback-only when an Origin is supplied;
- its signal-cli HTTP backend is loopback-only unless explicitly overridden;
- it avoids payload-bearing send failure logs.

`allowRemoteHost`/`allowRemote` are low-level implementation switches, not a complete remote
authentication/security design.

## 8. `apps/toy-signal-cli` — DEVELOPMENT/TESTING APPENDIX

### 8.1 Purpose and package status

The toy daemon is a deterministic local semantic double for the signal-cli HTTP JSON-RPC/SSE
boundary used by `SignalCliHttpBackend`. It has no package `exports` field and is not a production
Signal implementation.

It explicitly does **not** provide:

- Signal cryptography;
- Signal service connectivity/authentication;
- pre-key/session management;
- real device provisioning;
- identity verification;
- attachment transport;
- Signal rate-limit behavior.

Run it with:

```bash
pnpm --filter @e2e-col/toy-signal-cli dev
```

### 8.2 HTTP contract constants

Repository-internal `contract.ts` exports:

```ts
export const TOY_SIGNAL_CLI_CONTRACT_VERSION = 1 as const

export const SIGNAL_CLI_HTTP_ENDPOINTS = {
  check: '/api/v1/check',
  events: '/api/v1/events',
  rpc: '/api/v1/rpc'
} as const

export const TOY_CONTROL_ENDPOINTS = {
  contract: '/__toy__/v1/contract',
  state: '/__toy__/v1/state',
  reset: '/__toy__/v1/reset',
  faults: '/__toy__/v1/faults',
  inject: '/__toy__/v1/inject'
} as const
```

`SUPPORTED_RPC_METHODS` currently contains:

```text
version
listAccounts
listDevices
listGroups
getUserStatus
send
updateGroup
quitGroup
sendSyncRequest
subscribeReceive
unsubscribeReceive
startLink
finishLink
```

`RPC_METHOD_CONTRACTS` describes the parameter/result contract for each declared method, and
`TOY_SIGNAL_CLI_API_SPEC` exposes the complete machine-readable compatibility profile. Unknown RPC
methods return JSON-RPC `-32601`; the toy never pretends an unsupported command succeeded.

### 8.3 Contract types

The module currently exports these TypeScript types/interfaces:

```text
SupportedRpcMethod
RpcMethodContract
JsonRpcId
JsonRpcRequest
JsonRpcErrorObject
JsonRpcSuccess
JsonRpcFailure
JsonRpcResponse
ToyDeviceConfig
ToyAccountConfig
ToyGroupConfig
ToySignalConfig
ToyFaultProfile
ToyInjectRequest
```

Default fixture constants are:

```text
DEFAULT_TOY_ACCOUNT_A = +15550000001
DEFAULT_TOY_ACCOUNT_B = +15550000002
DEFAULT_TOY_GROUP_ID   = VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==
DEFAULT_TOY_SIGNAL_CONFIG
```

### 8.4 `ToySignalNetwork`

`network.ts` exports:

```ts
export interface ToySignalStateView { /* accounts/groups/SSE/fault state */ }

export class ToyRpcError extends Error {
  readonly code: number
  readonly data: unknown
}

export class ToySignalNetwork {
  constructor(config?: ToySignalConfig, now?: () => number)
  reset(config?: ToySignalConfig): void
  setFaults(profile: ToyFaultProfile): Required<ToyFaultProfile>
  view(): ToySignalStateView
  attachSse(response: ServerResponse): () => void
  closeSseClients(): void
  invoke(request: JsonRpcRequest, fixedAccount?: string): Promise<unknown>
  inject(request: ToyInjectRequest): Promise<void>
}
```

Test faults include failed next RPC sends, dropped next deliveries, duplicated next deliveries,
delivery delay, and closing SSE after the next delivery.

JSON-RPC errors include the standard parse/request/method/params/internal codes plus `-32000` for an
injected send failure. Group-admin failures in the toy can use a toy-specific server error code.

### 8.5 `ToySignalCliServer`

`server.ts` exports:

```ts
export interface ToySignalCliServerOptions {
  readonly host?: string
  readonly port?: number
  readonly fixedAccount?: string
  readonly config?: ToySignalConfig
  readonly now?: () => number
}

export class ToySignalCliServer {
  readonly network: ToySignalNetwork
  constructor(options?: ToySignalCliServerOptions)
  start(): Promise<{ host: string; port: number; baseUrl: string }>
  stop(): Promise<void>
}

export const toySignalCliContract = {
  endpoints: SIGNAL_CLI_HTTP_ENDPOINTS,
  controls: TOY_CONTROL_ENDPOINTS,
  methods: SUPPORTED_RPC_METHODS
} as const
```

The server is hard-wired to loopback hostnames. Its JSON request body cap is 1 MiB. RPC supports
single requests, batch requests, and notifications (notifications return no body).

### 8.6 Toy process configuration

`main.ts` reads:

| Environment variable | Meaning | Default |
| --- | --- | --- |
| `TOY_SIGNAL_CLI_HOST` | HTTP bind host | `127.0.0.1` |
| `TOY_SIGNAL_CLI_PORT` | TCP port | `18080` |
| `TOY_SIGNAL_CLI_FIXED_ACCOUNT` | optional single-account daemon mode | unset |

The port must be a safe integer in `0..65535`. The host must be loopback.

Typical health/contract checks are:

```bash
curl -fsS http://127.0.0.1:18080/api/v1/check
curl -fsS http://127.0.0.1:18080/__toy__/v1/contract
```

The complete two-account use with real sidecar modules is exercised by:

```bash
pnpm exec vitest run apps/toy-signal-cli/src/sidecar-e2e.test.ts
```

## 9. Current app-local orchestration: `BrowserReplicaSession`

`apps/web/src/session.ts` is worth documenting because it is the present composition path, but it
is **not a package export** and must not be confused with the missing `@e2e-col/client` SDK.

Its current behavior is:

```text
open:
  load IndexedDB snapshot
  -> new CollaborativeDocument(snapshot)
  -> connect transport
  -> subscribe to protocol bytes
  -> replay current outbound records

local edit:
  CollaborativeDocument.editText()
  -> save document snapshot
  -> create+encode one envelope per change
  -> enqueue outbound record
  -> transport.send()
  -> acknowledge/delete outbound record

remote bytes:
  decodeEnvelope()
  -> require document + automerge-change kind
  -> in-memory DedupCache
  -> applyChanges()
  -> save document snapshot
```

The ordering above exposes known durability gaps: snapshot + outbound enqueue is not atomic, and
transport send resolution is currently followed by physical queue deletion. This implementation is
evidence for the composition, not the final durable client contract.

## 10. TARGET / MISSING surfaces

Everything in this section is intentionally **not** described as importable current API.

### 10.1 `@e2e-col/client` — MISSING

The package does not exist in the workspace. Target names such as these are design-only today:

```text
CollaborativeClient
DocumentSession
SessionStatus
DocumentSessionEvent
TransportFactory
ClientError
DocumentAccessState
```

Do not write current examples importing them.

### 10.2 Core target refinements — MISSING

Not current core exports:

```text
DocumentSnapshot
DocumentHeads
DocumentView
ApplyResult
getView()
mergeSnapshot()
```

`mergeSnapshot()` is particularly important: loading/replacing local state is not equivalent to
merging a remote snapshot while preserving concurrent unsent work.

### 10.3 Durable storage extension — MISSING

The target specification proposes concepts such as:

```text
DurableCollaborativeStorage
SeenMessage
CheckpointPolicy
commitLocalChange()
persistRemoteState()
markOutboundAttempt()
compactOutbound()
hasSeen()
```

None are current `@e2e-col/storage` exports.

### 10.4 Access-control payloads and roles — MISSING / UNRESOLVED

The envelope reserves `membership`, `archive`, and `delete`, but the repository does not currently
export implemented typed codecs such as:

```text
encodeMembershipPayload/decodeMembershipPayload
encodeLifecyclePayload/decodeLifecyclePayload
DocumentRole
DocumentParticipant
DocumentAccessState
setParticipantRole()
removeParticipant()
archive()
deleteForGroup()
```

The authenticated proof/authorization representation remains unresolved in the target design. Do
not invent an ad-hoc payload and describe it as the e2e-col access-control protocol.

### 10.5 Versioned browser-facing sidecar API — TARGET

Current:

```text
GET /health
WS  <server>?documentId=<configured document>
```

Target-only:

```text
GET /api/v1/health
WS  /api/v1/documents?documentId=<uuid>
```

The target typed health payload (`status`, API/sidecar version, Signal adapter status, time) is also
not implemented. Current health is simply `{"ok":true}`.

### 10.6 Other target-only recovery/product surfaces

Still absent from the current exported implementation:

- persistent dedup/seen-message ledger;
- snapshot/checkpoint recovery policy and safe compaction;
- target typed client/session status and diagnostics;
- broader transport recovery-reason union beyond deterministic `dropped-frame`;
- structured block/list/comment/attachment document operations;
- stable typed `health` control payload semantics;
- a reusable real-Signal smoke-test profile as a normal CI surface.

## 11. Error-handling summary

| Surface | Typed error? | Current failure behavior |
| --- | --- | --- |
| `CollaborativeDocument.spliceText` | no | `RangeError` for invalid range. |
| Automerge load/apply | external | Automerge failures may propagate. |
| Protocol validation/codec/chunking | **yes** | `ProtocolValidationError` with `path`. |
| Protocol ID generation | no | `Error` when `crypto.randomUUID` is unavailable. |
| Deterministic network configuration | no | `RangeError`/`TypeError`/`Error`. |
| Simulated/WebSocket lifecycle | no | Promise rejection / `Error` or `TypeError`. |
| WebSocket non-binary inbound | n/a | Drop and increment metric. |
| IndexedDB construction/operations | no | Sync unavailable error; async request/transaction rejection. |
| `SidecarBridge` policy input | no exported error class | Constructor/start errors; malformed frames mostly ignored at boundary. |
| Signal-cli health/send | no exported error class | Promise rejection with HTTP/JSON-RPC context. |
| Toy JSON-RPC semantic failure | repository-internal `ToyRpcError` | Converted to JSON-RPC error response. |

The target client-level typed error model is not available yet.

## 12. Minimal current composition example

This example uses only implemented public library exports and demonstrates the intended boundary:
core creates a change, protocol frames it, transport moves opaque bytes, then protocol/core handle
it on the peer.

```ts
import { CollaborativeDocument } from '@e2e-col/core'
import { createEnvelope, decodeEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { createLoopbackPair } from '@e2e-col/transport'

const documentId = '11111111-1111-4111-8111-111111111111'
const a = new CollaborativeDocument()
const b = new CollaborativeDocument()
const { left, right } = createLoopbackPair()

right.subscribe((wire) => {
  const envelope = decodeEnvelope(wire)
  if (
    envelope.documentId === documentId &&
    envelope.kind === 'automerge-change'
  ) {
    b.applyChanges([envelope.payload])
  }
})

await Promise.all([left.connect(documentId), right.connect(documentId)])

for (const change of a.editText('current API')) {
  await left.send(
    encodeEnvelope(
      createEnvelope({
        documentId,
        messageId: crypto.randomUUID(),
        senderId: 'a',
        kind: 'automerge-change',
        createdAt: Date.now(),
        payload: change
      })
    )
  )
}

console.log(b.getText()) // current API
```

A production browser/session path additionally needs local storage, durable delivery policy, dedup,
and a sidecar transport. The current web app demonstrates that composition; the target
`@e2e-col/client` package is intended to make it reusable without duplicating those concerns in
every application.
