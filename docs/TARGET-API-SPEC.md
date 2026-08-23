# e2e-col target API specification

Status: **draft target contract**  
API revision: **draft-1**  
Protocol wire version: **1**  
Status snapshot: **2026-08-22**

This document defines the API shape that applications should target while
`e2e-col` evolves from the current local collaboration proof into a durable,
Signal-backed, end-to-end encrypted collaborative-document platform.

It is intentionally more normative than `ARCHITECTURE.md` and more concrete
than `ROADMAP-DESIGN-SPEC.md`. The companion
[`API-IMPLEMENTATION-STATUS.md`](API-IMPLEMENTATION-STATUS.md) records which
parts already exist and which remain implementation work.

## 1. Normative language and stability

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used
normatively.

API surfaces are classified as:

| Stability    | Meaning                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `candidate`  | Existing behavior that applications may reasonably begin targeting. Breaking changes should be deliberate and documented. |
| `target`     | Intended public contract that is not fully implemented yet. Applications may design against it and use mocks/adapters.    |
| `internal`   | Test/support behavior that applications should not depend on.                                                             |
| `unresolved` | Architectural requirement is known, but the exact contract is intentionally not frozen yet.                               |

The repository is still pre-1.0; the current release sweep is `0.0.2`.
This specification therefore describes the intended stable boundary rather than
claiming semver stability that the packages do not yet have.

## 2. Design goals

The target API MUST preserve the following properties:

```yaml
source_of_truth:
  plaintext_document: client_replica
  reconciliation: Automerge
  helper_service: never_authoritative_for_plaintext
security:
  browser_signal_credentials: forbidden
  malformed_wire_frames: reject_before_CRDT
  document_access: authenticated_before_apply
correctness:
  reordered_delivery: convergent
  duplicate_delivery: idempotent
  offline_edits: durable_and_replayed
  process_restart: must_not_lose_locally_committed_work
transport:
  semantics: asynchronous_at_least_once_capable
  initial_backend: Signal_via_local_sidecar
  replaceable: true
application_boundary:
  UI: depends_on_client_facade
  UI_direct_Automerge_dependency: discouraged
  UI_signal_cli_dependency: forbidden
```

## 3. Target package topology

The target dependency direction is:

```text
                                  ┌──────────────────┐
                                  │   applications   │
                                  │ web/mobile/etc.  │
                                  └────────┬─────────┘
                                           │
                                           ▼
                                  ┌──────────────────┐
                                  │ @e2e-col/client  │  implemented baseline
                                  │ app-facing SDK   │
                                  └───┬────┬────┬────┘
                                      │    │    │
                     ┌────────────────┘    │    └────────────────┐
                     ▼                     ▼                     ▼
             ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
             │     core     │      │   protocol   │      │   storage    │
             │ CRDT model   │      │ wire format  │      │ local-first  │
             └──────────────┘      └──────────────┘      └──────────────┘
                                            ▲
                                            │ opaque bytes
                                            │
                                   ┌────────┴────────┐
                                   │    transport    │
                                   │ byte delivery   │
                                   └────────┬────────┘
                                            │ localhost WebSocket
                                            ▼
                                   ┌─────────────────┐
                                   │  apps/sidecar   │
                                   │ Signal adapter  │
                                   └────────┬────────┘
                                            │
                                            ▼
                                         Signal
```

`@e2e-col/testing` composes public contracts for deterministic verification but
is not part of the production dependency path.

### 3.1 Why `@e2e-col/client` is a target package

The current packages expose good low-level boundaries, but an application should
not need to manually implement this sequence on every edit:

```text
CRDT change
  -> protocol envelope
  -> local persistence transaction
  -> encoded wire bytes
  -> retry bookkeeping
  -> transport send
  -> reconnect replay
  -> remote validation
  -> deduplication
  -> chunk recovery
  -> CRDT apply
  -> snapshot persistence
  -> UI status update
```

That orchestration belongs in a reusable client facade. Applications SHOULD
consume `@e2e-col/client` and treat `core`, `protocol`, `transport`, and `storage`
as lower-level extension/testing surfaces.

## 4. Shared identifiers and byte ownership

### 4.1 Identifier rules

For protocol-visible identifiers:

```ts
export type DocumentId = string
export type MessageId = string
export type ParticipantId = string
export type SenderId = string
export type UnixMillis = number
```

`DocumentId` and `MessageId` MUST be UUID strings at the protocol boundary.
Application code MAY keep them as plain strings; nominal/branded TypeScript types
may be introduced later without changing the wire representation.

`SenderId` is an opaque application/device identity and MUST NOT be assumed to be
a phone number, Signal account identifier, or human-readable username.

### 4.2 Byte ownership

All public byte-returning APIs MUST behave as though ownership is transferred or
copied. Callers MUST NOT be able to mutate internal document, protocol, transport,
or storage state by mutating a previously supplied `Uint8Array`.

This rule applies to:

- CRDT changes;
- snapshots;
- encoded protocol frames;
- transport receive callbacks;
- persisted queue entries.

## 5. `@e2e-col/core`

Stability: **candidate for the text/CRDT substrate; target refinements below**.

`core` owns convergent document state. It MUST NOT know about Signal,
WebSockets, IndexedDB, React, or sidecar configuration.

### 5.1 Target public types

```ts
export type DocumentChange = Uint8Array
export type DocumentSnapshot = Uint8Array
export type DocumentHeads = readonly string[]

export interface TextEdit {
  readonly index: number
  readonly deleteCount: number
  readonly insert: string
}

export interface DocumentView {
  readonly text: string
  readonly heads: DocumentHeads
}

export interface ApplyResult {
  readonly changed: boolean
  readonly heads: DocumentHeads
}

export type DocumentSubscriber = (view: DocumentView) => void
```

The target `DocumentHeads` type deliberately hides `Automerge.Heads` from
applications. The CRDT engine is an implementation choice; public application
interfaces SHOULD NOT expose Automerge-specific types.

### 5.2 Target `CollaborativeDocument`

```ts
export class CollaborativeDocument {
  constructor(initialState?: DocumentSnapshot)

  getText(): string
  getHeads(): DocumentHeads
  getView(): DocumentView

  subscribe(listener: DocumentSubscriber): () => void

  editText(nextText: string): DocumentChange[]
  spliceText(edit: TextEdit): DocumentChange[]

  applyChanges(changes: readonly DocumentChange[]): ApplyResult
  mergeSnapshot(snapshot: DocumentSnapshot): ApplyResult

  save(): DocumentSnapshot
  clone(): CollaborativeDocument
}
```

Normative behavior:

- `editText()` and `spliceText()` MUST produce operation-aware CRDT changes.
- A no-op edit MUST return an empty change list.
- `applyChanges()` MUST be idempotent for duplicate Automerge changes.
- `mergeSnapshot()` MUST merge remote snapshot state with local state; it MUST
  NOT blindly replace unsent local edits.
- `save()` MUST return a complete reloadable snapshot.
- subscribers MUST only be notified when visible/convergent state changes.
- range-invalid text splices MUST fail before mutating document state.

### 5.3 Text versus structured documents

Plain text is the baseline v1 model. Applications MAY build text editors now,
but richer document structure is expected later.

Future block/list/comment APIs MUST be additive at the client/core operation
layer. Transport and protocol payload handling MUST remain opaque to structure,
so a rich editor does not require a new transport architecture.

Applications SHOULD therefore avoid reaching into Automerge paths such as
`['text']` directly.

## 6. `@e2e-col/protocol`

Stability: **candidate for envelope v1**.

The protocol package owns validation and binary framing. It does not send bytes
and it does not interpret CRDT internals.

### 6.1 Envelope v1

The v1 logical envelope is:

```ts
export const PROTOCOL_VERSION = 1 as const

export type EnvelopeKind =
  | 'automerge-change'
  | 'snapshot'
  | 'membership'
  | 'archive'
  | 'delete'
  | 'health'
  | 'chunk'
  | 'authorization-resolution'

export interface ChunkMetadata {
  readonly index: number
  readonly total: number
  readonly originalMessageId: string
  readonly originalKind: Exclude<EnvelopeKind, 'chunk'>
}

export interface ProtocolEnvelope {
  readonly version: 1
  readonly documentId: string
  readonly messageId: string
  readonly senderId: string
  readonly kind: EnvelopeKind
  readonly createdAt: number
  readonly sequence?: number
  readonly chunk?: ChunkMetadata
  readonly payload: Uint8Array
}
```

Limits:

```ts
MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
MAX_CHUNKS = 4096
DEFAULT_CHUNK_PAYLOAD_BYTES = 32 * 1024
```

### 6.2 Required v1 APIs

```ts
validateEnvelope(value: unknown): ProtocolEnvelope
createEnvelope(input: ProtocolEnvelopeInput): ProtocolEnvelope
createProtocolId(): string

encodeEnvelope(value: ProtocolEnvelope): Uint8Array
decodeEnvelope(bytes: Uint8Array): ProtocolEnvelope

export interface ChunkEnvelopeOptions {
  readonly maxPayloadBytes?: number
  readonly createMessageId?: () => string
}

chunkEnvelope(
  envelope: ProtocolEnvelope,
  options?: ChunkEnvelopeOptions
): ProtocolEnvelope[]

reassembleChunks(chunks: readonly ProtocolEnvelope[]): ProtocolEnvelope

class DedupCache {
  hasOrAdd(
    envelope: Pick<ProtocolEnvelope, 'documentId' | 'messageId'>,
    now?: number
  ): boolean
  prune(now?: number): void
  clear(): void
  readonly size: number
}
```

### 6.3 Validation policy

All externally received frames MUST be decoded and validated before payload use.
The decoder MUST reject:

- invalid magic;
- unsupported protocol version;
- unknown kind code;
- unknown flags;
- truncated frames;
- trailing bytes;
- invalid UTF-8;
- invalid UUID document/message identifiers;
- oversized payloads;
- malformed or inconsistent chunk metadata.

Protocol validation errors MUST be data errors, not process crashes.

### 6.4 Versioning policy

Envelope v1 kind codes and header semantics are frozen once applications begin
interoperating across real devices.

A change that makes an existing v1 decoder interpret the same bytes differently
MUST use a new protocol version.

Unknown future kinds MUST fail closed rather than being passed to the CRDT.

### 6.5 Payload ownership by kind

The envelope only defines framing. Payload semantics are owned by higher layers:

| Kind               | Target payload owner           | Target semantics                           |
| ------------------ | ------------------------------ | ------------------------------------------ |
| `automerge-change` | `core` / `client`              | one Automerge change byte sequence         |
| `snapshot`         | `core` / `client`              | complete mergeable document snapshot       |
| `membership`       | access-control layer           | authenticated membership state transition  |
| `archive`          | access-control/lifecycle layer | authenticated archive transition           |
| `delete`           | access-control/lifecycle layer | authenticated delete/tombstone transition  |
| `authorization-resolution` | access-control layer | signed quorum reconciliation of a frozen authorization fork |
| `health`           | client/sidecar integration     | non-secret diagnostics/control metadata    |
| `chunk`            | protocol/sidecar               | fragment of one non-chunk logical envelope |

### 6.6 Control-payload codecs

Stability: **implemented review candidate; control payload v2 is intentionally
incompatible with legacy control payload v1**.

The outer `ProtocolEnvelope` stays at version 1 and continues to reserve
`membership`/`archive`/`delete`. Those kinds now contain an independently versioned
control payload. The current codec emits control payload **v2** with these common
authenticated fields before kind-specific data:

```ts
interface AuthorizationProof {
  documentId: string
  revision: number          // positive, exactly predecessor revision + 1
  predecessor: Uint8Array   // 32-byte authorization commitment
}
```

Membership/archive/delete signing preimages use separate v2 domain separators and
cover the authorization proof plus all semantic action fields. A control commitment
is SHA-256 over that canonical signing preimage. The signature itself is not part of
the commitment.

Applications MUST NOT invent independent ad-hoc wire formats for those kinds.
The current protocol API exposes typed codecs and signing helpers including:

```ts
encodeMembershipPayload(value: MembershipPayload): Uint8Array
decodeMembershipPayload(bytes: Uint8Array): MembershipPayload
encodeArchivePayload(value: ArchivePayload): Uint8Array
decodeArchivePayload(bytes: Uint8Array): ArchivePayload
encodeDeletePayload(value: DeletePayload): Uint8Array
decodeDeletePayload(bytes: Uint8Array): DeletePayload

membershipPayloadSigningBytes(value): Uint8Array
archivePayloadSigningBytes(value): Uint8Array
deletePayloadSigningBytes(value): Uint8Array
authorizationControlCommitment(signingBytes): Promise<Uint8Array>
```

Legacy control payload v1 is rejected during decode with an explicit
not-replay-safe error. This is a deliberate fail-closed compatibility boundary:
there is no safe way to infer a predecessor for an old signed control. Persisted
revision-0 ACL state can migrate to the all-zero v2 genesis predecessor; persisted
legacy state with prior control history is anchored to a deterministic semantic
state commitment instead of pretending that history is reconstructable.

`ProtocolEnvelope.sequence` MUST NOT be substituted for `revision` or
`predecessor`. It remains optional, sender-session-local/resettable, and shared by
CRDT, snapshot, and control frames.

## 7. `@e2e-col/transport`

Stability: **candidate low-level byte-channel contract**.

Transport moves opaque bytes. It MUST NOT parse `ProtocolEnvelope`, Automerge
changes, membership controls, or Signal-specific payloads.

### 7.1 Minimum contract

```ts
export interface CollaborativeTransport {
  connect(documentId: string): Promise<void>
  send(update: Uint8Array): Promise<void>
  subscribe(listener: (update: Uint8Array) => void): () => void
  close(): Promise<void>
}
```

Target semantics:

- one transport instance SHOULD bind to one document for its lifetime;
- repeated `connect()` to the same already-online document SHOULD be idempotent;
- binding the same instance to a different document MUST fail;
- `send()` accepts opaque bytes and MUST defensively isolate byte ownership;
- `send()` resolving means the adapter accepted the bytes locally; it MUST NOT
  be interpreted as remote-document acknowledgement;
- duplicate remote delivery is allowed by the architecture;
- `close()` is terminal for that transport instance.

The client layer, not the transport, owns durable delivery semantics.

### 7.2 Observable contract

```ts
export type TransportConnectionState =
  'disconnected' | 'connecting' | 'online' | 'offline' | 'closed'

export interface TransportStateChange {
  readonly previous: TransportConnectionState
  readonly current: TransportConnectionState
  readonly at: number
}

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

export interface ObservableCollaborativeTransport extends CollaborativeTransport {
  getState(): TransportConnectionState
  getMetrics(): TransportMetrics
  subscribeState(listener: (event: TransportStateChange) => void): () => void
  subscribeRecovery(listener: (event: TransportRecoveryRequired) => void): () => void
}
```

`delivered` is adapter-specific diagnostics and MUST NOT be used by applications
as a correctness acknowledgement. For example, a browser WebSocket adapter
cannot know that a remote Signal peer has merged a change.

### 7.3 Recovery events

Current simulation uses:

```ts
export interface TransportRecoveryRequired {
  readonly documentId: string
  readonly sourceId: string
  readonly targetId: string
  readonly sendSequence: number
  readonly reason: 'dropped-frame' | 'sidecar-history-risk'
}
```

`sidecar-history-risk` is emitted only when a sidecar backend explicitly proves
transport history cannot be recovered by ordinary durable outbound replay. A
generic HTTP/RPC send failure is ambiguous: signal-cli may have processed the
request before the response path failed. The current `SignalCliHttpBackend`
therefore does **not** produce this proof. Ordinary sidecar/SSE/WebSocket
disconnects and ambiguous sends do not emit it. The event's `sendSequence` remains
a transport-local event counter and is not the protocol envelope sequence.
Applications SHOULD NOT implement recovery logic directly from this event;
`@e2e-col/client` owns the snapshot/checkpoint policy.

The current v1 envelope `sequence` field is **not** a correctness-grade gap proof.
It is optional, allocated by a sender's live `DocumentSession`, resets when that
session is recreated, and counts logical control/snapshot envelopes as well as
CRDT changes. It also has no sender epoch, predecessor commitment, or
recipient-specific delivery chain. A receiver MUST NOT interpret a sequence jump
as proof of a missing CRDT increment. A future protocol version may define causal
predecessor/epoch metadata and then add a corresponding recovery reason.

### 7.4 `WebSocketTransport`

```ts
export type WebSocketLike = Pick<
  WebSocket,
  'readyState' | 'binaryType' | 'send' | 'close' | 'addEventListener'
>

export type WebSocketFactory = (url: string) => WebSocketLike

export interface WebSocketTransportOptions {
  readonly url: string
  readonly socketFactory?: WebSocketFactory
}

export class WebSocketTransport implements ObservableCollaborativeTransport {
  constructor(options: WebSocketTransportOptions)
}
```

The configured URL is the sidecar endpoint base. `connect(documentId)` appends
or supplies the document identifier to the sidecar connection.

Production WebSocket payloads MUST be encoded `@e2e-col/protocol` envelopes,
not naked Automerge changes.

### 7.5 Deterministic transport

`DeterministicTransportNetwork`, `SimulatedTransport`, `FaultDirective`, and
`createLoopbackPair()` are **internal/testing-oriented public utilities**.

They are allowed to expose virtual-time and fault-injection controls that a
production adapter does not implement.

## 8. `@e2e-col/storage`

Stability: **candidate baseline implemented; target durability extensions remain**.

Storage is responsible for browser/local durability. It MUST NOT know about
Signal credentials or React.

### 8.1 Candidate baseline that exists today

The current package already exports these useful names, which the target keeps
rather than replacing with a second storage vocabulary:

```ts
export interface StoredDocument {
  readonly documentId: string
  readonly snapshot: Uint8Array
  readonly updatedAt: number
  // target additive fields:
  readonly schemaVersion?: number
  readonly createdAt?: number
  readonly metadata?: DocumentMetadata
}

export interface DocumentMetadata {
  readonly title?: string
  readonly archived?: boolean
  /** Application-owned additive local metadata is preserved. */
  readonly [key: string]: unknown
}

export interface DocumentMetadataUpdate {
  /** null clears the local display title. */
  readonly title: string | null
}

export interface OutboundRecord {
  readonly id: string
  readonly documentId: string
  readonly payload: Uint8Array
  readonly createdAt: number
  // target durable-attempt metadata, additive during migration:
  readonly state?: 'pending' | 'attempted'
  readonly attempts?: number
  readonly lastAttemptAt?: number
}

export interface CollaborativeStorage {
  loadDocument(documentId: string): Promise<StoredDocument | undefined>
  saveDocument(document: StoredDocument): Promise<void>
  updateDocumentMetadata(
    documentId: string,
    update: DocumentMetadataUpdate,
    updatedAt: number
  ): Promise<StoredDocument>
  deleteDocument(documentId: string): Promise<void>
  listDocuments(): Promise<readonly StoredDocument[]>
  enqueue(record: OutboundRecord): Promise<void>
  listOutbound(documentId?: string): Promise<readonly OutboundRecord[]>
  acknowledgeOutbound(id: string): Promise<void>
  close(): Promise<void>
}
```

`MemoryCollaborativeStorage` and `IndexedDbCollaborativeStorage` implement this
baseline now. `metadata` MUST contain only application-safe, **device-local** document
metadata. It is not CRDT/network state and MUST NOT be presented as automatically
convergent across replicas. Signal device keys/account state MUST never be stored
here.

`updateDocumentMetadata()` is a metadata-only atomic write. A successful update MUST
preserve document snapshot bytes and every unrelated metadata key and MUST NOT touch
outbound, seen-message, access-control, or authorization stores. A failed transaction
MUST leave the previous durable record intact. Content/snapshot transactions MUST in
turn preserve the already-durable metadata lane, so stale session metadata cannot
race a rename and overwrite it.

### 8.2 Target durable semantics

The baseline methods are sufficient for a first persistence proof but not for a
crash-safe, at-least-once production session. The target extends them rather than
forcing apps to invent a parallel store abstraction.

```ts
export interface SeenMessage {
  readonly documentId: string
  readonly messageId: string
  readonly seenAt: number
}

export interface CheckpointPolicy {
  /** Explicit queue entries the client has proven safe to remove. */
  readonly safeRecordIds: readonly string[]
  /** Keep a bounded tail even when additional entries are proven safe. */
  readonly retainAtLeast?: number
}

export interface DurableCollaborativeStorage extends CollaborativeStorage {
  commitLocalChange(input: {
    document: StoredDocument
    outbound: readonly OutboundRecord[]
  }): Promise<void>

  persistRemoteState(input: {
    document: StoredDocument
    seen: readonly SeenMessage[]
  }): Promise<void>

  markOutboundAttempt(recordIds: readonly string[], attemptedAt: number): Promise<void>
  compactOutbound(documentId: string, policy: CheckpointPolicy): Promise<void>
  hasSeen(documentId: string, messageId: string, now?: number): Promise<boolean>
  pruneSeenMessages(now?: number): Promise<number>
}
```

`commitLocalChange()` MUST atomically persist the new document snapshot and the
outbound envelopes produced from that edit. The system MUST NOT allow this
failure mode:

```text
UI shows local edit
  -> snapshot persisted
  -> crash
  -> outbound queue was never persisted
  -> edit exists only on one machine forever
```

Nor may it persist outbound work without the matching local snapshot.

A successful `transport.send()` MUST NOT by itself imply that an outbound record
can be deleted. The current `acknowledgeOutbound()` method therefore has a
strong target precondition: the caller MUST only invoke it when recovery or
checkpoint policy has proven that removal is safe. Merely writing bytes to a
WebSocket is not such proof.

The in-memory `DedupCache` remains useful as a hot cache, but production client
correctness SHOULD NOT rely only on in-memory dedup state. Distributed
wall-clock time MUST NOT be treated as proof that remote replicas incorporated
an edit.

### 8.3 IndexedDB implementation

The existing implementation name is retained:

```ts
export interface IndexedDbStorageOptions {
  readonly name?: string
  readonly indexedDB?: IDBFactory
  /** Defaults to 24 hours. */
  readonly seenMessageTtlMs?: number
  /** Injectable wall clock for deterministic retention tests. */
  readonly now?: () => number
}

export class IndexedDbCollaborativeStorage implements DurableCollaborativeStorage {
  constructor(options?: IndexedDbStorageOptions)
}
```

The implementation uses schema v3 for the durable `seen_messages` ledger and its
`seenAt` pruning index. Schema migrations MUST remain explicit, versioned, and
tested. Corrupt/incompatible state MUST fail with a recoverable storage error
rather than silently resetting local data.

## 9. `@e2e-col/client`

Stability: **implemented baseline; target refinements remain**.

`@e2e-col/client` provides the framework-neutral orchestration layer that composes
core + protocol + storage + transport behind view/status/access contracts and
durable replay/recovery semantics. The target sections below describe the
implemented baseline plus additive refinements rather than a missing future package.

This is the primary API that new applications SHOULD design against.

### 9.1 Client construction

```ts
export interface TransportContext {
  readonly documentId: string
}

export type TransportFactory = (context: TransportContext) => ObservableCollaborativeTransport

export interface ClientClock {
  now(): number
}

export interface ClientIdFactory {
  createMessageId(): string
  createDocumentId(): string
}

export interface RecoveryPolicy {
  readonly replayAttemptedOnReconnect?: boolean
  readonly publishSnapshotOnRecoverySignal?: boolean
  /** Threshold that triggers recovery/checkpoint work, not unsafe deletion. */
  readonly snapshotThresholdOutboundEntries?: number
}

export interface CreateDocumentOptions {
  readonly documentId?: string
  readonly initialText?: string
  readonly metadata?: DocumentMetadata
}

export interface CollaborativeClientOptions {
  readonly senderId: string
  readonly transportFactory: TransportFactory
  readonly storage: DurableCollaborativeStorage
  readonly clock?: ClientClock
  readonly ids?: ClientIdFactory
  readonly recovery?: RecoveryPolicy
}

export const MAX_DOCUMENT_TITLE_LENGTH = 200

export interface UpdateDocumentMetadataOptions {
  /** null or blank/whitespace-only text clears the local display title. */
  readonly title: string | null
}

export interface DocumentSummary {
  readonly documentId: string
  readonly title?: string
  readonly updatedAt: number
  readonly archived: boolean
}

export class CollaborativeClient {
  constructor(options: CollaborativeClientOptions)

  createDocument(options?: CreateDocumentOptions): Promise<DocumentSession>
  openDocument(documentId: string): Promise<DocumentSession>
  listDocuments(): Promise<readonly DocumentSummary[]>
  updateDocumentMetadata(
    documentId: string,
    update: UpdateDocumentMetadataOptions
  ): Promise<DocumentSummary>
  close(): Promise<void>
}
```

Display-title authority is local to the client/storage instance. `documentId` remains
immutable identity. Title normalization trims surrounding whitespace, accepts one
line only, and rejects normalized strings longer than 200 JavaScript string code
units. `null` or a normalized empty string clears the title. Applications SHOULD
render a stable UUID-derived fallback when `DocumentSummary.title` is absent.

A metadata update MUST NOT emit CRDT, membership, lifecycle,
authorization-resolution, or transport traffic. It MUST NOT alter group binding,
authorization root/head/revision, participant ACL, archive/delete state, or document
content. Because this is local presentation metadata, reader/archived/deleted access
state does not grant or revoke the ability to change the local label; the operation
MUST still leave those collaboration restrictions fully enforced.

### 9.2 `DocumentSession`

```ts
export type SessionPhase =
  'opening' | 'ready' | 'syncing' | 'offline' | 'recovering' | 'error' | 'closed'

export interface OutboundReplayProgress {
  readonly total: number
  readonly completed: number
  readonly active: boolean
}

export interface SessionStatus {
  readonly phase: SessionPhase
  readonly transport: TransportConnectionState
  // Durable records never yet successfully handed to the transport.
  readonly pendingOutbound: number
  // Reconnect/restart replay progress; not remote acknowledgement.
  readonly replay?: OutboundReplayProgress
  readonly recoveryRequired: boolean
  readonly lastReceivedAt?: number
  readonly lastSentAt?: number
  readonly lastPersistedAt?: number
  readonly error?: ClientError
}

export interface DocumentSession {
  readonly documentId: string

  getView(): DocumentView
  getStatus(): SessionStatus
  getAccessState(): DocumentAccessState

  subscribe(listener: (event: DocumentSessionEvent) => void): () => void

  editText(nextText: string): Promise<void>
  spliceText(edit: TextEdit): Promise<void>

  flush(): Promise<void>
  publishSnapshot(): Promise<void>
  close(): Promise<void>
}
```

`DocumentSession` MUST hide protocol envelopes, retry loops, storage
transactions, chunking, deduplication, and transport reconnection from normal UI
code.

`flush()` means "attempt to hand every durable outbound record known at method
entry to the current transport". It MUST NOT mean remote acknowledgement. If the
transport is offline or rejects a send, durable records remain queued and the
method MAY reject with a recoverable transport error.

`SessionStatus.replay` is present after a reconnect/restart replay batch begins.
`completed` advances only after the corresponding durable record has been accepted
by the local transport adapter; `active: false` records the final local result for
that batch. Applications MUST NOT present `completed === total` as a peer ack or as
proof that a remote replica merged the change.

`publishSnapshot()` creates a `snapshot` envelope for the current complete CRDT
state and persists it as outbound recovery/checkpoint material before attempting
delivery. It is primarily a recovery/compaction primitive; normal editors SHOULD
not need to call it after every edit.

### 9.3 Session events

```ts
export type DocumentSessionEvent =
  | { readonly type: 'document'; readonly view: DocumentView }
  | { readonly type: 'status'; readonly status: SessionStatus }
  | { readonly type: 'access'; readonly access: DocumentAccessState }
  | { readonly type: 'error'; readonly error: ClientError }
```

Applications MAY derive framework-specific hooks/stores from this event stream.
The core SDK itself SHOULD remain framework-neutral.

### 9.4 Required local-edit transaction

A target client local edit MUST behave conceptually as:

```text
session.editText()
  │
  ├─ mutate CollaborativeDocument
  │    └─ produce DocumentChange[]
  │
  ├─ create ProtocolEnvelope(kind=automerge-change) per change
  ├─ encode envelopes
  │
  ├─ ATOMIC STORAGE TRANSACTION
  │    ├─ persist new document snapshot
  │    └─ append encoded envelopes to outbound queue
  │
  ├─ emit document/status event
  │
  └─ attempt send of pending queue
       ├─ online: send at least once
       └─ offline: leave durable queue untouched
```

The UI MUST NOT have to await network availability before observing its own local
edit.

### 9.5 Required inbound path

```text
transport bytes
  -> decodeEnvelope()
  -> validate version/document/kind
  -> durable dedup check
  -> chunk handling if applicable
  -> authorization check
  -> apply CRDT change OR merge snapshot
  -> persist resulting snapshot + seen-message identity atomically
  -> emit document/status event
```

An invalid frame MUST stop before `CollaborativeDocument.applyChanges()`.

### 9.6 Reconnect and replay

When transport returns online, the client MUST replay durable pending/attempted
outbound entries according to policy. Duplicate delivery is acceptable and MUST
remain harmless.

Applications SHOULD assume session status can transition repeatedly:

```text
opening -> ready -> offline -> syncing -> ready
                       │
                       └-> recovering -> syncing -> ready
```

### 9.7 Snapshot/checkpoint recovery

The target recovery algorithm is:

```text
recovery signal / gap / excessive retained history
  -> session enters recovering
  -> sender retains or publishes a complete snapshot/checkpoint envelope
  -> reconnect/replay includes the retained checkpoint
  -> receiving peer merges snapshot with local state
  -> ordinary incremental replay continues
  -> older incremental records covered by a durable newer checkpoint may compact
  -> session returns to syncing/ready
```

A snapshot MUST be merged, never used to destroy unsent concurrent local state.
A local queue entry is safe to compact without remote acknowledgement only when a
newer **durably retained snapshot/checkpoint** semantically subsumes it; that
checkpoint itself remains replayable until superseded by another durable
checkpoint. Snapshot compaction applies only to CRDT increment/snapshot history;
membership, archive, and delete records are not represented by document bytes and
MUST NOT be discarded by this rule. This gives bounded history without pretending
WebSocket/Signal send success proves remote merge.

Recovery state MUST NOT be cleared merely because an ordinary outbound send
returns successfully. A sender may clear its obligation after it successfully
publishes the durable full-state checkpoint; a receiver clears only after an
authorized snapshot is accepted, merged, and durably persisted.

The baseline recovery design therefore does not require a wire-level
`snapshot-request` kind. A future explicit peer request/ack protocol MAY be added
only with a separately specified/versioned control contract. The exact
checkpoint cadence and thresholds are policy, not UI API.

## 10. Access-control application API

Stability: **implemented application shape; R6 authenticated bootstrap, replay-safe
causal authorization, and signed fork reconciliation implemented**.

Applications can consume the current role/lifecycle model without depending on the
transport ordering model. The authorization proof is complete within the documented
authenticated-identity trust model; first-contact identity-key authenticity and
freshness/transparency remain external deployment concerns.

### 10.1 Roles and participants

```ts
export type DocumentRole = 'reader' | 'writer' | 'admin'

export interface DocumentParticipant {
  readonly participantId: string
  readonly role: DocumentRole
  readonly displayName?: string
  readonly active: boolean
  readonly identityKeyCommitment?: string
}

export interface DocumentAccessState {
  readonly selfRole: DocumentRole
  readonly participants: readonly DocumentParticipant[]
  readonly archived: boolean
  readonly deleted: boolean
  readonly revision: number
  readonly authorizationRoot?: string
  readonly authorizationHead?: string
  readonly authorizationStatus?: 'active' | 'conflict'
}
```

`authorizationRoot` is the creator-signed shared-root commitment when the state is
anchored by a verified R6 root. `authorizationHead` is the durable hexadecimal
current authorization commitment. Both are absent only on explicitly unverified
legacy anchor states. `identityKeyCommitment` binds verified-root participants to
SHA-256 commitments of authenticated Ed25519 identity keys.
`authorizationStatus: 'conflict'` means a valid same-predecessor authorization fork
was detected and document/admin mutation is frozen fail-closed.

### 10.2 Session commands

`DocumentSession` currently implements these admin/lifecycle operations:

```ts
inviteParticipant(phoneNumber: string, role: DocumentRole): Promise<void>
setParticipantRole(participantId: string, role: DocumentRole): Promise<void>
removeParticipant(participantId: string): Promise<void>
archive(): Promise<void>
unarchive(): Promise<void>
deleteForGroup(): Promise<void>
approveForkResolution(chosenControlId: string): Promise<ForkResolutionApproval>
resolveFork(
  chosenControlId: string,
  approvals: readonly ForkResolutionApproval[]
): Promise<void>
```

Normative access behavior:

- readers MUST NOT generate accepted document-edit frames;
- writers MAY edit but MUST NOT mutate membership/admin state;
- admins MAY mutate membership and lifecycle state;
- unauthorized inbound frames MUST be rejected before CRDT application;
- signer cryptographic validity is insufficient by itself: the actor MUST have
  been an active admin at the signed predecessor state;
- a control whose predecessor is ahead of local knowledge MAY be durably buffered,
  but MUST NOT mutate access state until its parent is known and valid;
- a stale/superseded control MUST NOT roll the ACL backward, including after the
  seen-message TTL expires or after restart;
- competing valid controls from the same predecessor MUST fail closed as an
  authorization conflict rather than use transport arrival order as authority;
- a fork resolution MUST bind the exact common predecessor, competing control ids,
  deterministic resulting ACL commitment, and next authorization revision;
- resolution MUST carry signatures from the exact active-admin set at the common
  predecessor and that set MUST contain at least two independent admins. A one-admin
  fork therefore remains fail-closed;
- on a verified root, control actors and fork approvers MUST still match the identity
  keys committed by the predecessor authority state;
- delete semantics MUST acknowledge that previously authorized devices may retain
  local plaintext copies and a delete branch MUST NOT be reconciled into a live state.

R6 bootstrap is cryptographic rather than server-ACL based: a creator-signed root
binds document, creator, participant role/active state, and participant identity-key
commitments. Fresh devices verify that root from authenticated identity material and
replay signed controls/resolutions to the supplied head. Group membership and the
toy authorization endpoint are untrusted discovery/evidence cache surfaces. They
cannot overwrite an established durable root/head. CRDT bootstrap is independent.

Compatibility remains explicit: legacy revision-0 and revision>0 persisted ACLs are
marked as unverified zero-genesis/local anchors and cannot be mistaken for a verified
shared root. Outer `ProtocolEnvelope` stays v1; replay-safe controls are v2, while an
authenticated membership invite uses payload v3 to bind the target identity key.

Security scope: first-contact trust assumes authenticated identity-key material. A
Byzantine identity directory before any key is pinned remains outside R6. Likewise,
an untrusted evidence cache may censor or replay an older valid signed prefix to a
brand-new device unless a separate freshness/transparency pin exists, but it cannot
forge proof or roll back an established durable replica. R5 real-Signal evidence is
separate and unchanged.

### 10.3 Identity key-material lifecycle

Stability: **implemented for signed-prekey rotation and one-time-prekey
replenishment; long-term identity-key rebinding is intentionally unsupported**.

`IdentityProvider.verifySession()` returns enough public state for deterministic
maintenance without exposing private material:

```ts
export interface IdentitySessionClaim {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly signedPrekeyPublic: string
  readonly signedPrekeyRotationRequired: boolean
  readonly prekeyCount: number
  readonly createdAt: number
}
```

`IdentityClient.openSession()` MUST:

1. verify the session user/phone binding against durable local identity metadata;
2. require the provider's signed-prekey public key to match the durable current key
   or a durable pending rotation, otherwise fail closed;
3. when rotation is requested, persist the new non-exportable X25519 private pair
   before publishing its Ed25519-signed public half;
4. retain the previous signed-prekey private pair after publication so an existing
   encrypted-envelope `recipientKeySelector` can decrypt delayed ciphertext;
5. when `prekeyCount < 5`, persist enough new X25519 one-time prekeys to target ten,
   publish only their public halves, and mark them published only after provider
   acceptance; and
6. retry already-staged signed/one-time material after interrupted publication rather
   than generating replacement private keys.

The provider's signed-prekey update MUST verify the replacement signature against the
existing Ed25519 identity key. Provider responses MUST echo the accepted public key
and signature so the browser can reject material substitution.

The long-term Ed25519 identity key is immutable under this lifecycle. In particular,
directory replacement MUST NOT be treated as identity rotation: R6 authorization
roots and causal controls bind the authenticated key and established replicas
already fail closed when the current directory key no longer matches that binding.
A future identity-key rotation API requires an explicit authenticated rebind and
re-verification protocol that also preserves historical-signature verification.

No `ProtocolEnvelope` change is required: it remains v1, and signed-prekey selection
continues to use the existing encrypted-envelope public-key selector.

## 11. Local sidecar API

Stability: **candidate bridge implemented and signal-cli v0.14.7 boundary-audited;
live two-account evidence remains externally gated**.

The first `SidecarBridge` and `SignalCliHttpBackend` now exist and validate binary
protocol frames, map configured documents to Signal groups, use the
`e2e-col:v1:` namespace, and implement chunk/reassembly/dedup plus bounded send
attempts. Production startup checks daemon health plus configured group visibility,
best-effort probes version only where the daemon exposes it, validates
loopback/origin/runtime mappings, and requires an explicit
Signal text-body boundary so prefix/base64/chunk overhead is included. The
contract below is the versioned endpoint/security target; the current prototype
still exposes `GET /health` and a WebSocket upgrade selected by `?documentId=...`
without the final `/api/v1/...` route normalization.

The sidecar is a localhost companion, not a document server.

### 11.1 Trust boundary

The sidecar:

- MUST own `signal-cli` account/device integration;
- MUST bind to loopback by default;
- MUST NOT expose Signal credentials to the browser;
- MUST NOT become the authoritative plaintext document store;
- SHOULD operate only on encoded protocol frames and transport metadata;
- MUST validate untrusted inbound Signal frames before forwarding them.

### 11.2 Browser-facing endpoints

Target endpoint shape:

```text
GET /api/v1/health
WS  /api/v1/documents?documentId=<uuid>
```

The exact port is configuration, not part of the stable API.

#### `GET /api/v1/health`

Target response:

```ts
export interface SidecarHealth {
  readonly status: 'ok' | 'degraded' | 'unavailable'
  readonly apiVersion: 1
  readonly sidecarVersion: string
  readonly signalAdapter: {
    readonly status: 'connected' | 'disconnected' | 'error'
    readonly version?: string
  }
  readonly time: number
}
```

Health output MUST NOT contain:

- phone numbers unless explicitly redacted/local-only policy later allows them;
- provisioning URIs;
- private keys;
- Signal data-directory contents;
- document payloads.

#### WebSocket document endpoint

After successful connection, application data messages are binary encoded
`ProtocolEnvelope` frames.

The sidecar MUST route only frames matching the connection's `documentId`.
Policy violations SHOULD close the connection rather than forwarding ambiguous
frames.

Recommended close codes:

| Code   | Meaning                                    |
| ------ | ------------------------------------------ |
| `1000` | normal client shutdown                     |
| `1008` | invalid document/protocol/policy frame     |
| `1011` | transient sidecar/internal adapter failure |
| `4409` | explicit backend proof of transport-history risk; trigger snapshot recovery |

### 11.3 Signal body representation

The first Signal adapter MAY use the text-safe namespace already documented by
`LIVE-TUTORIAL.md`:

```text
e2e-col:v1:<base64-of-binary-protocol-frame>
```

Base64 is transport encoding only. It MUST NOT become a second semantic
protocol.

### 11.4 Chunking ownership

For the initial sidecar integration:

```text
browser/client
  -> sends one logical non-chunk ProtocolEnvelope
sidecar
  -> chunkEnvelope() when Signal-safe body size requires it
  -> encode + base64 each chunk frame
Signal
remote sidecar
  -> decode + validate + dedup
  -> reassembleChunks()
  -> forwards original logical envelope bytes to browser
```

This gives one clear owner for Signal-level chunking and prevents application
code from double-chunking.

### 11.5 Delivery semantics

The Signal path is asynchronous and applications MUST tolerate at-least-once,
delayed, and reordered delivery.

The sidecar MAY retry sends. The client MUST retain enough durable local history
to recover from sidecar restarts or ambiguous send outcomes. It MUST NOT assume
that a WebSocket write proves a remote replica has received or merged the frame.
A generic HTTP/RPC failure after an attempted send cannot establish whether
signal-cli processed the request, so the current real adapter closes with `1011`
and relies on replay/dedup. The sidecar MAY use `4409` only when a backend provides
separate, explicit evidence that ordinary replay cannot cover a transport-history
risk. Ordinary disconnects, ambiguous outcomes, and v1 sequence jumps are non-proof.

## 12. `apps/web` and other application contracts

Stability: **target application architecture**.

Applications SHOULD have this dependency shape:

```text
React/Vue/Svelte/TUI/mobile component
  -> application store/view-model
  -> DocumentSession
  -> @e2e-col/client
```

They SHOULD NOT do this:

```text
component
  -> Automerge.change()
  -> encodeEnvelope()
  -> IndexedDB transaction
  -> WebSocket.send()
  -> signal-cli concept
```

### 12.1 Recommended application adapter

A framework adapter can be tiny:

```ts
export interface DocumentViewModel {
  readonly documentId: string
  readonly text: string
  readonly status: SessionStatus
  readonly access: DocumentAccessState
}

export function bindSession(
  session: DocumentSession,
  publish: (view: DocumentViewModel) => void
): () => void
```

React hooks, Zustand stores, Redux adapters, mobile observables, or TUI models
belong in applications or optional framework packages, not `core`.

### 12.2 Transport selection

Applications MAY select transport by environment/configuration:

```yaml
local_demo:
  transport: deterministic_or_loopback
production_companion:
  transport: websocket
future:
  transport: other_encrypted_broadcast_adapter
```

Transport choice MUST NOT change editor operations.

### 12.3 Offline UX contract

Apps MUST be able to display at least:

- ready/synced enough for normal work;
- offline but local editing available, including the durable local queue depth;
- syncing/replaying pending work, including reconnect/restart replay progress;
- recovering via checkpoint/snapshot;
- an authorization-fork conflict when `DocumentAccessState.authorizationStatus === 'conflict'`;
- unrecoverable client/storage error.

"Connected" alone is not a sufficient user-facing synchronization state.
Replay completion alone is likewise not sufficient evidence of remote acknowledgement.

## 13. `@e2e-col/testing`

Stability: **candidate testing API**.

Existing useful surfaces include:

```ts
CollaborativeScenario
NETWORK_PROFILES
networkProfileOptions()
deliverBatches()
duplicateChanges()
```

The target testing package SHOULD grow adapters for:

```ts
createMemoryCollaborativeStorage()
createPersistentTestStorage()
runConvergenceScenario()
runRestartRecoveryScenario()
runWirePathScenario()
runSidecarContractScenario()
```

The same scenario definitions SHOULD be runnable against deterministic transport,
WebSocket sidecar transport, and—where explicitly enabled—a real Signal profile.

## 14. End-to-end invariants

A conforming production client must satisfy all of the following.

### 14.1 Local edit

```text
local edit
  -> visible immediately
  -> persisted atomically with outbound work
  -> survives browser restart
  -> eventually transmitted when transport returns
```

### 14.2 Duplicate frame

```text
duplicate envelope
  -> protocol-valid
  -> dedup identifies already seen message
  -> no second user-visible edit
```

Even if dedup state is lost, duplicate Automerge changes SHOULD remain
idempotent as a second defense.

### 14.3 Reordering

```text
change B arrives before change A
  -> both validate
  -> both eventually apply
  -> replica converges with any replica that received the same valid changes
```

### 14.4 Offline editing

```text
transport offline
  -> edit remains enabled
  -> snapshot + outbound frames persist
  -> reconnect replays frames
  -> replicas converge
```

### 14.5 Restart

```text
browser/process restart
  -> load persisted snapshot
  -> load pending/attempted outbound queue
  -> restore durable dedup/checkpoint state
  -> reconnect
  -> replay safely
```

### 14.6 Malformed remote data

```text
untrusted bytes
  -> decode/validation error
  -> diagnostic counter/log without payload disclosure
  -> CRDT untouched
  -> process remains healthy
```

### 14.7 Sidecar failure

```text
sidecar disappears
  -> transport offline
  -> local edit remains available
  -> outbound work remains durable
  -> replacement/restarted sidecar reconnects
  -> replay resumes
```

### 14.8 Snapshot recovery

```text
incremental history incomplete
  -> recovery state
  -> obtain snapshot
  -> merge with local state
  -> replay remaining increments
  -> converge
```

## 15. Error model

The target client SHOULD expose typed errors without leaking implementation
secrets.

```ts
export type ClientErrorCode =
  | 'protocol-invalid'
  | 'protocol-unsupported'
  | 'storage-unavailable'
  | 'storage-corrupt'
  | 'transport-unavailable'
  | 'transport-closed'
  | 'authorization-denied'
  | 'recovery-failed'
  | 'document-not-found'
  | 'internal'

export interface ClientError {
  readonly code: ClientErrorCode
  readonly message: string
  readonly recoverable: boolean
  readonly cause?: unknown
}
```

UI code SHOULD branch on `code`/`recoverable`, not parse error-message strings.
Sensitive transport/account details MUST be sanitized before becoming a
user-visible error.

## 16. Observability contract

Production diagnostics SHOULD be structured and payload-free by default.

```ts
export interface ClientDiagnostics {
  readonly documentId: string
  readonly status: SessionStatus
  readonly transport: TransportMetrics
  readonly seenMessageCacheSize?: number
  readonly outboundQueueDepth: number
  readonly lastCheckpointAt?: number
}
```

Diagnostics MUST NOT include plaintext document contents, Signal provisioning
material, or private credentials unless a separate explicit debug policy is
introduced.

## 17. App-design compatibility rules

Application teams can begin implementation now if they follow these rules:

1. Target `DocumentSession`, not raw Automerge, as the primary editor model.
2. Model document IDs as UUID strings.
3. Treat collaboration network state as multi-state (`ready/offline/syncing/
recovering/error`), not boolean connected/disconnected.
4. Assume local edits are available offline.
5. Assume duplicate and reordered remote delivery.
6. Keep protocol and transport bytes out of component state.
7. Keep Signal concepts entirely outside application UI except optional
   diagnostics/setup screens.
8. Model participant roles (`reader`, `writer`, `admin`) and keep privileged
   controls gated on the verified authorization state and local role.
9. Do not assume a WebSocket send is remote acknowledgement.
10. Keep document rendering independent from the current plain-text CRDT shape so
    structured block operations can be added later.

## 18. Target package exports summary

```yaml
'@e2e-col/core':
  candidate:
    - CollaborativeDocument
    - DocumentChange
    - TextEdit
  target_additions:
    - DocumentSnapshot
    - DocumentHeads
    - DocumentView
    - ApplyResult
    - mergeSnapshot
    - getView

'@e2e-col/protocol':
  candidate:
    - ProtocolEnvelope
    - createEnvelope
    - validateEnvelope
    - encodeEnvelope
    - decodeEnvelope
    - chunkEnvelope
    - reassembleChunks
    - DedupCache
    - createProtocolId
    - typed membership/archive/delete payload codecs
    - authorization-root proof codecs
    - authorization-resolution proof codecs
    - authenticated control commitments/signing bytes

'@e2e-col/transport':
  candidate:
    - CollaborativeTransport
    - ObservableCollaborativeTransport
    - WebSocketTransport
    - DeterministicTransportNetwork
    - SimulatedTransport
    - createLoopbackPair
    - TransportMetrics
    - TransportConnectionState
  target_refinement:
    - broader recovery reasons

'@e2e-col/storage':
  candidate:
    - CollaborativeStorage
    - MemoryCollaborativeStorage
    - IndexedDbCollaborativeStorage
    - StoredDocument
    - OutboundRecord
  target_additions:
    - DurableCollaborativeStorage
    - SeenMessage
    - atomic local/remote persistence operations
    - durable attempt/checkpoint metadata

'@e2e-col/client':
  candidate:
    - CollaborativeClient
    - DocumentSession
    - SessionStatus
    - DocumentSessionEvent
    - TransportFactory
    - DocumentAccessState

'@e2e-col/testing':
  candidate:
    - CollaborativeScenario
    - NETWORK_PROFILES
    - networkProfileOptions
  target_additions:
    - storage restart scenarios
    - sidecar contract scenarios
    - reusable real-Signal smoke profile

'apps/sidecar':
  candidate:
    - SidecarBridge
    - SignalCliHttpBackend
    - GET /health
    - WS ?documentId=<uuid>
    - signal-cli HTTP RPC + SSE
    - Signal namespace framing
    - chunk/reassembly/dedup/retry-backoff routing
    - loopback + Origin guards
  target_refinement:
    - GET /api/v1/health with typed health payload
    - WS /api/v1/documents?documentId=<uuid>
    - broader signal-cli fault integration evidence
    - real linked-device Signal smoke profile
```

## 19. Compatibility milestones

The target may be implemented incrementally without forcing applications to
wait for every security/product feature.

### Milestone A — app SDK baseline

Freeze/mock:

- `CollaborativeClient`;
- `DocumentSession`;
- `SessionStatus`;
- `DocumentView`;
- `DurableCollaborativeStorage` interface.

This is the milestone at which independent application projects can build their
editor/view models with minimal future rewrites.

### Milestone B — durable local-first client

Implement:

- IndexedDB store;
- atomic snapshot + outbound persistence;
- persistent dedup/checkpoint data;
- reconnect replay;
- snapshot merge/recovery.

### Milestone C — sidecar transport

Implement:

- sidecar HTTP health;
- binary WebSocket document endpoint;
- real Signal adapter;
- sidecar chunk/reassembly/dedup;
- app `WebSocketTransport` selection.

### Milestone D — authenticated collaboration

Implemented baseline / freeze during compatibility review:

- role/membership control payload schemas;
- authenticated authorization proof;
- lifecycle controls;
- unauthorized-frame rejection.

### Milestone E — structured document API

Add block/list/comment/attachment operations without changing transport or
sidecar contracts.

## 20. Non-goals of this API

The target API does not make these promises:

- globally ordered edits;
- exactly-once network delivery;
- immediate online presence;
- a central authoritative plaintext server;
- remote deletion of copies a previously authorized user already retained;
- Signal-specific behavior in the editor model;
- rich-text semantics in the baseline CRDT API;
- remote acknowledgement merely because `transport.send()` resolved.

Those exclusions are deliberate and should be reflected in application UX and
testing.
