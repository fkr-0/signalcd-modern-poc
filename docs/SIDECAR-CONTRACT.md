# Sidecar ↔ signal-cli Contract

Status: **draft**  
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

### 2.1 Health check

```
GET /api/v1/check
```

| Aspect | Expected |
|--------|----------|
| Method | `GET` |
| Path | `/api/v1/check` |
| Success status | `200` |
| Response body | Any JSON with `ok: true` or equivalent |
| Failure | Non-200 status means daemon is unreachable |
| Sidecar behavior | Called once in `start()`. If it fails, the backend throws and the sidecar refuses to start. |

**Mock implementation:** Returns the enhanced toy health view, for example `{ status: "ok", toy: true, apiVersion: 1, debugDecrypt: false, registeredIdentities: 0, activeGroups: 0 }` on a fresh server. The sidecar intentionally checks HTTP success rather than depending on those toy-only fields.

**Production signal-cli:** Returns `{ ok: true }` or similar. The sidecar only
checks `response.ok`, so any 200-level response is accepted.

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
| `params.account` | Signal phone number (E.164-style, e.g. `+15550000001`) |
| `params.groupId` | Base64-encoded group identifier |
| `params.message` | `e2e-col:v1:` prefix + base64-encoded binary `ProtocolEnvelope` |
| Success result | `{ timestamp: number }` |
| Error result | `{ error: { code: number, message: string } }` |
| Batch support | Array of JSON-RPC requests; array of responses |

**Mock implementation:** Validates the JSON-RPC structure, checks account
exists, routes the message to all group members except the sender via SSE.
Returns `{ timestamp: <now> }`.

**Production signal-cli:** Same contract. The `account` field identifies which
linked device sends. The `groupId` maps to a real Signal group. The `message`
is delivered as a Signal data message body.

### 2.3 Receive messages (SSE)

```
GET /api/v1/events
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
| Account field | `params.account` — the Signal account that received the message |
| Message body | `params.envelope.dataMessage.message` — prefixed with `e2e-col:v1:` |
| Group ID | `params.envelope.dataMessage.groupInfo.groupId` — base64 |
| Sender echo | The sidecar suppresses events where `source` matches its own account |

**Mock implementation:** The toy maintains an SSE client list. When a `send`
is received, it emits `receive` events to all other group members' SSE streams,
plus a `syncMessage.sentMessage` echo to the sender.

**Production signal-cli:** Same SSE contract. The daemon connects to the Signal
service and receives real messages. The event structure matches the
signal-cli daemon's documented SSE format.

### 2.4 Other RPC methods

The sidecar currently uses only `send`. The toy supports additional methods
for completeness:

| Method | Required by sidecar? | Notes |
|--------|---------------------|-------|
| `version` | No | Returns daemon version |
| `listAccounts` | No | Returns configured accounts |
| `listDevices` | No | Returns devices for an account |
| `listGroups` | No | Returns groups for an account |
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
3. If chunking is needed, calls `chunkEnvelope()`
4. Base64-encodes each chunk with the `e2e-col:v1:` prefix
5. Sends via JSON-RPC `send` to signal-cli

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
| Account (phone number) | Configured in sidecar; used in `send` params | Never sees the account |
| Group ID mapping | `documentGroups` config maps document UUID → Signal group ID | Passes `documentId` in WebSocket URL |
| Chunking | `chunkEnvelope()` when message exceeds Signal body size | Sends one logical envelope |
| Reassembly | Accumulates chunks, calls `reassembleChunks()` | Receives one logical envelope |
| Dedup (Signal-level) | `physicalDedup` on raw received frame | `DedupCache` on protocol envelope |
| Retry | Exponential backoff on send failure | Durable outbound queue |
| SSE reconnect | Exponential backoff from 250ms to 5000ms | WebSocket reconnect via transport |

## 5. Swapping from mock to production

### 5.1 What changes

| Component | Mock | Production |
|-----------|------|-----------|
| `signal-cli` process | `apps/toy-signal-cli` | `signal-cli daemon --http` |
| Base URL | `http://127.0.0.1:18080` | `http://127.0.0.1:8080` (or configured port) |
| Account | Mock phone `+15550000001` | Real Signal phone number |
| Group | Mock group with base64 ID | Real Signal group created via `updateGroup` |
| Identity | Mock key generation | Real Signal key provisioning |
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
| `SIGNAL_CLI_ACCOUNT` | `+15550000001` | Real phone number |
| `E2E_COL_DOCUMENT_GROUPS` | `{"<doc-uuid>": "<mock-group-id>"}` | `{"<doc-uuid>": "<real-group-id>"}` |

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
{ ok: true }  // or any 200-level response
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
// - Production: error (account is required)

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
GET /api/v1/events
Accept: text/event-stream

// Behavior
// - Sidecar opens SSE connection
// - When another account sends to a shared group, a receive event is emitted
// - Event data is JSON with method "receive"

// Expected SSE event
data: {"method":"receive","params":{"account":"+15550000001","envelope":{"source":"+15550000002","sourceDevice":1,"timestamp":1234567890,"dataMessage":{"message":"e2e-col:v1:AQIDBA==","groupInfo":{"groupId":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=="}}}}}

// Sidecar behavior on receive
// - Extracts params.account (filters by own account)
// - Extracts params.envelope.dataMessage.message
// - Strips "e2e-col:v1:" prefix
// - Base64-decodes to binary
// - Validates with decodeEnvelope()
// - Forwards to browser WebSocket
```

### 6.6 Sender echo suppression

```typescript
// Input
// Account A sends to group containing A and B

// Behavior
// - Sidecar receives SSE event for account A (sender echo)
// - Sidecar ignores events where envelope.source === sidecar's own account
// - Only forwards messages from other accounts

// Expected
// - Sender's SSE stream receives syncMessage (not dataMessage)
// - Recipient's SSE stream receives dataMessage
// - Sidecar forwards only the dataMessage to browser
```

### 6.7 Unknown RPC method

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

### 6.8 Message format validation

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
| Group management | In-memory registry | Signal groups | `updateGroup` creates real groups |
| Account management | Mock registry | Signal provisioning | `startLink`/`finishLink` perform real linking |
| Cryptography | None (browser-owned) | Signal protocol | Sidecar treats messages as opaque |
| Device provisioning | Mock | Real linked devices | `listDevices` returns real devices |
| Delivery guarantees | Deterministic (fault-injectable) | At-least-once via Signal | Same sidecar retry logic works |
| Chunking | Sidecar-owned | Sidecar-owned | Identical; Signal body size limits apply |
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
