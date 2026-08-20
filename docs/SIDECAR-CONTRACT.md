# Sidecar ↔ signal-cli Contract

Status: **implementation-audited against signal-cli v0.14.7; live two-account smoke pending**
Date: **2026-08-20**

This document specifies the interface between the e2e-col sidecar and the
signal-cli daemon. It describes what the sidecar expects from signal-cli,
how the toy mock implements the same contract, and what must change when
swapping from mock to production.

## 1. Architecture

```text
Browser ──WebSocket──► Sidecar ──HTTP JSON-RPC/SSE──► signal-cli ──Signal protocol──► Remote
                        │
                        ├── Validates protocol envelopes
                        ├── Maps documents to Signal groups
                        ├── Handles chunking/reassembly
                        ├── Deduplicates
                        └── Retries with backoff
```

The sidecar is the bridge. It speaks two protocols:

| Direction | Protocol | Transport | Content |
|-----------|----------|-----------|---------|
| Browser → Sidecar | e2e-col binary envelopes | WebSocket | Encrypted `ProtocolEnvelope` frames |
| Sidecar → signal-cli | JSON-RPC 2.0 | HTTP POST | `send` method with base64 message body |
| signal-cli → Sidecar | SSE | HTTP GET | `receive` notifications with base64 message body |
| Sidecar → Browser | e2e-col binary envelopes | WebSocket | Encrypted `ProtocolEnvelope` frames |

## 2. Required signal-cli HTTP API Surface

The sidecar depends on these signal-cli daemon endpoints. If signal-cli
changes its HTTP API, the sidecar adapter (`apps/sidecar/src/signal-cli.ts`)
must be updated to match.

The production compatibility baseline for this phase is upstream `signal-cli`
**v0.14.7** (released 2026-08-01). Its tagged JSON-RPC manual documents the
three HTTP endpoints below, unique request IDs, automatic and manual `receive`
notification shapes, multi-account `params.account`, camelCase `groupId`, and
the `send` result timestamp. No local `signal-cli` executable is installed in
the verification environment, so this phase proves the daemon boundary with
contract tests plus an explicit opt-in live profile; it does not claim a live
Signal round trip.

### 2.1 Health check

```
GET /api/v1/check
```

| Aspect | Expected |
|--------|----------|
| Method | `GET` |
| Path | `/api/v1/check` |
| Success status | `200` |
| Response body | Not part of the production contract; HTTP success is sufficient |
| Failure | Non-200 status means daemon is unreachable |
| Sidecar behavior | Called once in `start()`. If it fails, the backend throws and the sidecar refuses to start. |

**Mock implementation:** Returns the enhanced toy health view, for example `{ status: "ok", toy: true, apiVersion: 1, debugDecrypt: false, registeredIdentities: 0, activeGroups: 0 }` on a fresh server. The sidecar intentionally checks HTTP success rather than depending on those toy-only fields.

**Production signal-cli:** The v0.14.7 manual specifies only `200 OK`. The sidecar
therefore does not parse or require a JSON health body.

### 2.2 Send message (JSON-RPC)

```
POST /api/v1/rpc
Content-Type: application/json
```

**Request body (single):**
```json
{
  "jsonrpc": "2.0",
  "id": "<uuid>",
  "method": "send",
  "params": {
    "account": "+15550000001",
    "groupId": "<base64-group-id>",
    "message": "e2e-col:v1:<base64-encoded-protocol-envelope>"
  }
}
```

**Request body (batch — optional):**
```json
[
  { "jsonrpc": "2.0", "id": "1", "method": "send", "params": { ... } },
  { "jsonrpc": "2.0", "id": "2", "method": "send", "params": { ... } }
]
```

| Aspect | Expected |
|--------|----------|
| Method | `POST` |
| Path | `/api/v1/rpc` |
| Content-Type | `application/json` |
| Protocol | JSON-RPC 2.0 |
| `params.account` | Required by signal-cli in multi-account mode; omitted for a daemon already scoped to one account |
| `params.groupId` | Base64-encoded group identifier |
| `params.message` | `e2e-col:v1:` prefix + base64-encoded binary `ProtocolEnvelope` |
| Success result | `{ timestamp: number }` |
| Error result | `{ error: { code: number, message: string } }` |
| Batch support | Array of JSON-RPC requests; array of responses |

**Mock implementation:** Validates the JSON-RPC structure, checks account
exists, routes the message to all group members except the sender via SSE.
Returns `{ timestamp: <now> }`.

**Production signal-cli:** Same contract. The `account` field identifies which
local account sends when the daemon is in multi-account mode. The `groupId` maps
to a real Signal group. The `message` is delivered as a Signal data message body.
The adapter validates JSON-RPC version/id matching and surfaces only the numeric
error code and message; error `data` is intentionally excluded from diagnostics.
For this one-request-per-HTTP-call adapter, a daemon command error with `id:null`
is preserved because real signal-cli has emitted that form for command-execution
failures. A success is not accepted unless the result contains the documented
non-negative integer `timestamp`.

### 2.3 Receive messages (SSE)

```
GET /api/v1/events[?account=<configured-account>]
Accept: text/event-stream
```

**SSE event format:**
```
data: {"method":"receive","params":{"account":"+15550000001","envelope":{"source":"+15550000002","sourceDevice":1,"timestamp":1234567890,"dataMessage":{"message":"e2e-col:v1:<base64>","groupInfo":{"groupId":"<base64>"}}}}}
```

| Aspect | Expected |
|--------|----------|
| Method | `GET` |
| Path | `/api/v1/events` |
| Response | `text/event-stream` (SSE) |
| Event format | `data: <json>` lines separated by `\n\n` |
| Event method | `"receive"` |
| Account field | Automatic mode may expose `params.account`; manual subscription mode wraps it under `params.result.account` |
| Message body | `params.envelope.dataMessage.message` — prefixed with `e2e-col:v1:` |
| Group ID | `params.envelope.dataMessage.groupInfo.groupId` — base64 |
| Sender sync | `syncMessage.sentMessage` is parsed as well as `dataMessage`; logical message-ID dedup suppresses the sender's already-seen frame |

**Mock implementation:** The toy maintains an SSE client list. When a `send`
is received, it emits `receive` events to all other group members' SSE streams,
plus a `syncMessage.sentMessage` echo to the sender.

**Production signal-cli:** The daemon connects to the Signal service and sends
JSON-RPC `receive` notifications as SSE data. In multi-account mode the backend
opens an account-scoped event stream when `SIGNAL_CLI_ACCOUNT` is configured and
also checks any account field in the notification. SSE comments, event names,
CRLF framing, malformed unrelated event data, stream EOF, and reconnect/backoff
are handled without treating an ordinary disconnect as document-history loss.
Startup waits until the first event request has returned HTTP success with a
`text/event-stream` response; an unusable initial subscription fails startup
instead of leaving a send-only sidecar silently running.

### 2.4 Other RPC methods

The production startup path uses `listGroups` before opening its browser listener,
then uses `send` for data. It also makes a best-effort `version` probe: the toy
supports it, while the signal-cli v0.14.7 JSON-RPC manual does not document such
a method, so JSON-RPC method-not-found is accepted as "version unavailable".
The toy supports additional methods for completeness:

| Method | Required by sidecar? | Notes |
|--------|---------------------|-------|
| `version` | Best-effort startup probe | Records a version where exposed; `-32601` is non-fatal because v0.14.7 does not document this RPC |
| `listAccounts` | No | Returns configured accounts |
| `listDevices` | No | Returns devices for an account |
| `listGroups` | **Yes, startup** | Verifies every configured document group is active (`isMember=true`) and not blocked for the selected account |
| `getUserStatus` | No | Returns registration status |
| `updateGroup` | No | Creates/modifies groups |
| `quitGroup` | No | Leaves a group |
| `sendSyncRequest` | No | Requests sync from other devices |
| `subscribeReceive` | No | Subscribes to messages for an account |
| `unsubscribeReceive` | No | Unsubscribes |
| `startLink` | No | Starts device linking |
| `finishLink` | No | Completes device linking |

**Compatibility rule:** Unknown methods must return JSON-RPC error `-32601`
(Method not found), not a misleading no-op success.

## 3. Message format on the wire

### 3.1 Sidecar → signal-cli

```
e2e-col:v1:<base64-of-binary-ProtocolEnvelope>
```

The sidecar:
1. Receives a binary `ProtocolEnvelope` from the browser WebSocket
2. Validates it with `decodeEnvelope()`
3. Measures the final `e2e-col:v1:` + base64 body against the configured Signal body boundary
4. If chunking is needed, calculates the remaining payload budget after prefix,
   base64, envelope, and chunk-metadata overhead and calls `chunkEnvelope()`
5. Verifies every resulting body remains within the configured boundary
6. Sends via JSON-RPC `send` to signal-cli

### 3.2 signal-cli → Sidecar

```
e2e-col:v1:<base64-of-binary-ProtocolEnvelope>
```

The sidecar:
1. Receives an SSE `receive` event
2. Extracts the message body after the `e2e-col:v1:` prefix
3. Base64-decodes to binary
4. Validates with `decodeEnvelope()`
5. If it's a chunk, accumulates and reassembles
6. Deduplicates using `DedupCache`
7. Forwards the validated binary frame to the browser WebSocket

## 4. Signal-specific concepts the sidecar owns

These concepts live in the sidecar, not in the browser:

| Concept | Sidecar responsibility | Browser responsibility |
|---------|----------------------|----------------------|
| Account | Optional single/multi-account selector configured only in the sidecar | Never sees the account |
| Group ID mapping | `documentGroups` config maps document UUID → Signal group ID | Passes `documentId` in WebSocket URL |
| Chunking | `chunkEnvelope()` against an explicit final-text-body byte boundary | Sends one logical envelope |
| Reassembly | Accumulates chunks, calls `reassembleChunks()` | Receives one logical envelope |
| Dedup (Signal-level) | `physicalDedup` on raw received frame | `DedupCache` on protocol envelope |
| Retry | Exponential backoff on send failure | Durable outbound queue |
| SSE reconnect | Exponential backoff from 250ms to 5000ms | WebSocket reconnect via transport |
| Recovery proof | Close code `4409` only for explicit backend proof that ordinary replay cannot cover transport-history risk | Converts only that explicit code into `TransportRecoveryRequired` |

### 4.1 Signal text-body boundary

There is deliberately **no repository-wide magic production byte limit**. The
v0.14.7 JSON-RPC manual does not specify one, while the signal-cli v0.14.0
changelog records that long text messages are moved to Signal's long-text
attachment representation. e2e-col's v1 receive path expects its namespace in
`dataMessage.message`; silently crossing into an attachment representation would
therefore violate the current parser contract.

Production startup consequently requires `E2E_COL_SIGNAL_BODY_MAX_BYTES`. Its
value must come from the deployed Signal/signal-cli environment's verified safe
text-body boundary. The sidecar treats it as the maximum UTF-8 byte length of the
**complete** prefixed/base64 body, not as a CRDT payload threshold. Focused tests
prove emitted chunks remain under a configured boundary, including framing
overhead. Test fixture values are not production recommendations.

## 5. Swapping from mock to production

### 5.1 What changes

| Component | Mock | Production |
|-----------|------|-----------|
| `signal-cli` process | `apps/toy-signal-cli` | `signal-cli daemon --http` |
| Base URL | `http://127.0.0.1:18080` | `http://127.0.0.1:8080` (or configured port) |
| Account | Mock phone `+15550000001` | Real Signal phone number |
| Group | Mock group with base64 ID | Pre-existing real Signal group selected by configuration |
| Identity | Mock key generation | Pre-linked local signal-cli account/device state |
| Cryptography | Browser-owned X25519/AES-GCM | Signal protocol (server-side) |
| SSE events | Mock fanout delivery | Real Signal message delivery |

### 5.2 What does NOT change

- The sidecar WebSocket protocol (binary `ProtocolEnvelope` frames)
- The `e2e-col:v1:` message namespace
- The `ProtocolEnvelope` wire format (magic bytes, version, kind codes)
- The chunking/reassembly logic
- The dedup logic
- The retry logic
- The browser application code
- The `@e2e-col/client`, `@e2e-col/protocol`, `@e2e-col/transport` packages

### 5.3 Configuration

The sidecar reads these environment variables:

| Variable | Mock value | Production value |
|----------|-----------|-----------------|
| `SIGNAL_CLI_HTTP_URL` | `http://127.0.0.1:18080` | `http://127.0.0.1:8080` |
| `SIGNAL_CLI_ACCOUNT` | `+15550000001` | Account selector for multi-account daemon; optional if daemon is already single-account scoped |
| `E2E_COL_DOCUMENT_GROUPS` | `{"<doc-uuid>": "<mock-group-id>"}` | `{"<doc-uuid>": "<real-group-id>"}` |
| `E2E_COL_SIGNAL_BODY_MAX_BYTES` | Explicit test/deployment value | **Required** verified safe text-body boundary; no guessed default |
| `E2E_COL_ALLOWED_ORIGINS` | Optional comma-separated loopback origins | Optional exact browser origin allowlist |

The runtime parser requires UUID document keys, base64 Signal group IDs, unique
group-to-document mapping, a valid port, and credential-free HTTP(S) origins.
`SignalCliHttpBackend` separately requires a credential-free HTTP(S) origin and
rejects non-loopback daemon URLs unless remote use is explicitly enabled in code.

## 6. Per-call contract tests

These tests verify the sidecar-to-backend contract. They run against the toy
mock but are designed to also pass against a real signal-cli daemon (with
appropriate configuration).

### 6.1 Health check

```typescript
// Input
GET /api/v1/check

// Behavior
// - Sidecar calls this once in start()
// - If non-200, sidecar throws and refuses to start

// Expected output (mock, fresh server)
{ status: "ok", toy: true, apiVersion: 1, debugDecrypt: false,
  registeredIdentities: 0, activeGroups: 0 }

// Expected output (production)
// body unspecified; HTTP 200 is the contract
```

### 6.2 Send to group

```typescript
// Input
POST /api/v1/rpc
{
  "jsonrpc": "2.0",
  "id": "test-send-1",
  "method": "send",
  "params": {
    "account": "+15550000001",
    "groupId": "VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==",
    "message": "e2e-col:v1:AQIDBA=="  // example base64
  }
}

// Behavior
// - Validates JSON-RPC structure
// - Checks account exists
// - Routes to all group members except sender
// - Emits SSE receive events to recipients
// - Emits syncMessage.sentMessage echo to sender

// Expected output
{ "jsonrpc": "2.0", "id": "test-send-1", "result": { "timestamp": 1234567890 } }
```

### 6.3 Send with missing account

```typescript
// Input
POST /api/v1/rpc
{
  "jsonrpc": "2.0",
  "id": "test-send-2",
  "method": "send",
  "params": {
    "groupId": "VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==",
    "message": "e2e-col:v1:AQIDBA=="
  }
}

// Behavior
// - Toy: routes to fixedAccount if configured, else error
// - Production multi-account daemon: account is required
// - Production daemon already scoped to one account: omission is valid

// Expected output (no fixedAccount)
{ "jsonrpc": "2.0", "id": "test-send-2", "error": { "code": -32602, "message": "Invalid params" } }
```

### 6.4 Send to non-existent group

```typescript
// Input
POST /api/v1/rpc
{
  "jsonrpc": "2.0",
  "id": "test-send-3",
  "method": "send",
  "params": {
    "account": "+15550000001",
    "groupId": "bm9uLWV4aXN0ZW50",
    "message": "e2e-col:v1:AQIDBA=="
  }
}

// Behavior
// - Group not found

// Expected output
{ "jsonrpc": "2.0", "id": "test-send-3", "error": { "code": -32000, "message": "group not found" } }
```

### 6.5 Receive via SSE

```typescript
// Input (sidecar subscribes)
GET /api/v1/events?account=%2B15550000001
Accept: text/event-stream

// Behavior
// - Sidecar opens SSE connection
// - When another account sends to a shared group, a receive event is emitted
// - Event data is JSON with method "receive"

// Expected SSE event
data: {"method":"receive","params":{"account":"+15550000001","envelope":{"source":"+15550000002","sourceDevice":1,"timestamp":1234567890,"dataMessage":{"message":"e2e-col:v1:AQIDBA==","groupInfo":{"groupId":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=="}}}}}

// Sidecar behavior on receive
// - Extracts params.account or params.result.account when present
// - Extracts params.envelope.dataMessage.message
// - Strips "e2e-col:v1:" prefix
// - Base64-decodes to binary
// - Validates with decodeEnvelope()
// - Forwards to browser WebSocket
```

### 6.6 Sender sync suppression

```typescript
// Input
// Account A sends to group containing A and B

// Behavior
// - Sidecar parses syncMessage.sentMessage as a valid receive form
// - The outgoing logical message ID is already in sidecar logical dedup state
// - The sender sync copy is therefore not forwarded back to the browser

// Expected
// - Sender's SSE stream receives syncMessage (not dataMessage)
// - Recipient's SSE stream receives dataMessage
// - Sidecar forwards only the dataMessage to browser
```

### 6.7 Production recovery boundary

An ordinary WebSocket/SSE disconnect, sidecar restart, or v1 envelope sequence
jump is **not** proof of missing CRDT history. Neither is an exhausted HTTP/RPC
send attempt: the daemon may have processed the request before the response path
failed. Such ambiguous failures close only that document WebSocket with `1011`;
the client retains durable outbound state and can replay it safely because receive
dedup is idempotent.

Close code `4409` is therefore reserved for `BroadcastRecoveryRequiredError`, an
explicit backend assertion that transport history is at risk in a way ordinary
durable replay cannot cover (for example, a future backend detecting a proven
state reset with unrecoverable queued history). `SignalCliHttpBackend` currently
does not emit that assertion because the audited v0.14.7 HTTP contract exposes no
such proof. `WebSocketTransport` translates only `4409` into
`TransportRecoveryRequired { reason: "sidecar-history-risk" }`, reusing the
existing durable snapshot/checkpoint recovery machinery without inferring gaps.

The event's `sendSequence` is a local recovery-event counter for compatibility
with the existing transport event shape. It is **not** `ProtocolEnvelope.sequence`
and must not be used as a wire-gap detector.

### 6.8 Opt-in real Signal smoke

`apps/sidecar/src/real-signal.smoke.test.ts` is skipped by default. It runs only
when `E2E_COL_REAL_SIGNAL_SMOKE=1` and two already-linked account/daemon fixtures,
a shared pre-existing group ID, and an explicit body boundary are provided. The
test performs no registration, linking, or group mutation; it sends one opaque
`health` protocol frame through sidecar A → Signal → sidecar B. Missing fixture
configuration is reported as unavailable/skipped and does not weaken the toy
contract gate.

### 6.9 Unknown RPC method

```typescript
// Input
POST /api/v1/rpc
{
  "jsonrpc": "2.0",
  "id": "test-unknown",
  "method": "nonExistentMethod",
  "params": {}
}

// Behavior
// - Unknown methods must return JSON-RPC -32601

// Expected output
{ "jsonrpc": "2.0", "id": "test-unknown", "error": { "code": -32601, "message": "Method not found" } }
```

### 6.10 Message format validation

```typescript
// Input
POST /api/v1/rpc
{
  "jsonrpc": "2.0",
  "id": "test-format",
  "method": "send",
  "params": {
    "account": "+15550000001",
    "groupId": "VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==",
    "message": "not-e2e-col-prefixed"
  }
}

// Behavior
// - Toy: accepts (does not validate message prefix)
// - Production: signal-cli delivers as-is (Signal doesn't care about prefix)
// - Sidecar: always uses "e2e-col:v1:" prefix when sending

// Expected (sidecar always sends with prefix)
// This test verifies the sidecar's outbound behavior, not the daemon's.
```

## 7. Fidelity matrix

What the toy mock implements vs what real signal-cli provides:

| Capability | Toy mock | signal-cli | Impact |
|-----------|----------|-----------|--------|
| JSON-RPC HTTP endpoint | Semantic | Native | Sidecar adapter unchanged |
| SSE event stream | Semantic | Native | Sidecar adapter unchanged |
| Message routing | In-memory fanout | Signal network | No code change; different transport |
| Group management | In-memory registry | Signal groups | Production sidecar consumes only pre-existing configured groups; no automatic mutation |
| Account management | Mock registry | Signal provisioning | Production sidecar consumes only pre-linked account state; no automatic linking/registration |
| Cryptography | None (browser-owned) | Signal protocol | Sidecar treats messages as opaque |
| Device provisioning | Mock | Real linked devices | `listDevices` returns real devices |
| Delivery guarantees | Deterministic (fault-injectable) | At-least-once via Signal | Same sidecar retry logic works |
| Chunking | Sidecar-owned | Sidecar-owned | Same framing; production requires an explicit verified text-body byte boundary |
| Dedup | Sidecar-owned | Sidecar-owned | Identical |

## 8. Adapter file reference

| File | Purpose |
|------|---------|
| `apps/sidecar/src/signal-cli.ts` | `SignalCliHttpBackend` — the adapter that talks to signal-cli (or toy) |
| `apps/sidecar/src/bridge.ts` | `SidecarBridge` — orchestrates backend + browser WebSocket + protocol validation |
| `apps/toy-signal-cli/src/server.ts` | Toy daemon HTTP server |
| `apps/toy-signal-cli/src/contract.ts` | Machine-readable contract definitions |
| `apps/toy-signal-cli/src/encrypted-router.ts` | Encrypted message routing + debug decrypt |
| `apps/toy-signal-cli/src/identity-registry.ts` | Mock identity provider |
| `apps/toy-signal-cli/src/group-registry.ts` | Mock group management |
