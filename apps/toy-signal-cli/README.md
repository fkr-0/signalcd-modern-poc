# Toy signal-cli

`@e2e-col/toy-signal-cli` is a deterministic, localhost-only demonstration and
test double for the `signal-cli daemon --http` boundary used by e2e-col.

It exists because `apps/sidecar/src/backend.ts::MemoryBroadcastBackend` is useful
for unit tests but deliberately bypasses the real process boundary. The toy
daemon exercises HTTP, JSON-RPC, SSE, account routing, group fan-out, sender sync
echoes, retries, reconnects, chunking, and deduplication without requiring a
Signal account or network access.

## Compatibility contract

The contract is intentionally explicit. The toy implements the complete
**e2e-col signal-cli compatibility profile v1**, not a fake success response for
every command that exists in signal-cli.

Upstream signal-cli HTTP daemon contract mirrored here:

| HTTP   | Path             | Toy behavior                                   |
| ------ | ---------------- | ---------------------------------------------- |
| `POST` | `/api/v1/rpc`    | single or batch JSON-RPC 2.0 requests          |
| `GET`  | `/api/v1/events` | SSE stream of `receive` JSON-RPC notifications |
| `GET`  | `/api/v1/check`  | HTTP 200 health response                       |

The current upstream JSON-RPC manual states that daemon commands map to CLI
commands, parameters use camelCase, multi-account requests require `account`,
and explicit receive subscriptions use `subscribeReceive` / `unsubscribeReceive`.

Semantically implemented RPC methods:

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

An unknown method returns JSON-RPC `-32601 Method not found`. This is important:
tests must never pass because the toy silently accepted a Signal feature it did
not model.

The wire-facing contract constants and TypeScript types live in
`src/contract.ts`; the contract test locks the supported method list so additions
are reviewable. The same machine-readable contract is exposed at runtime:

```bash
curl -fsS http://127.0.0.1:18080/__toy__/v1/contract
```

This returns the profile/version, exact HTTP endpoints, JSON-RPC method list,
error codes, SSE notification/account fields, toy control endpoints, and explicit
fidelity limits.

### JSON-RPC error profile

The server uses standard JSON-RPC codes for protocol failures:

- `-32700` parse error;
- `-32600` invalid request;
- `-32601` method not found;
- `-32602` invalid params/account/group;
- `-32603` unexpected internal error;
- `-32000` deterministic injected send failure.

Notifications without an `id` do not produce a response. Batch requests return
only responses for entries carrying an `id`.

## Default demonstration topology

Run:

```bash
npm run dev -w @e2e-col/toy-signal-cli
```

Defaults:

```text
HTTP:      http://127.0.0.1:18080
Account A: +15550000001
Account B: +15550000002
Group:     VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==
```

Check the daemon:

```bash
curl -fsS http://127.0.0.1:18080/api/v1/check
```

List accounts:

```bash
curl -fsS \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"listAccounts","id":"accounts"}' \
  http://127.0.0.1:18080/api/v1/rpc
```

Watch Signal-style incoming notifications:

```bash
curl -N http://127.0.0.1:18080/api/v1/events
```

Send through the demo group from account A:

```bash
curl -fsS \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"send","params":{"account":"+15550000001","groupId":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA==","message":"hello from the toy"},"id":"send-1"}' \
  http://127.0.0.1:18080/api/v1/rpc
```

The SSE stream emits a sender `syncMessage.sentMessage` for A and a receiver
`dataMessage` for B. That is the exact distinction used by the production
sidecar to suppress its own sync echo while forwarding the remote copy.

## Two real sidecars against the toy

Terminal A:

```bash
E2E_COL_DOCUMENT_GROUPS='{"11111111-1111-4111-8111-111111111111":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=="}' \
SIGNAL_CLI_HTTP_URL=http://127.0.0.1:18080 \
SIGNAL_CLI_ACCOUNT=+15550000001 \
E2E_COL_SIDECAR_PORT=43127 \
npm run dev -w @e2e-col/sidecar
```

Terminal B:

```bash
E2E_COL_DOCUMENT_GROUPS='{"11111111-1111-4111-8111-111111111111":"VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=="}' \
SIGNAL_CLI_HTTP_URL=http://127.0.0.1:18080 \
SIGNAL_CLI_ACCOUNT=+15550000002 \
E2E_COL_SIDECAR_PORT=43128 \
npm run dev -w @e2e-col/sidecar
```

This is also automated by `src/sidecar-e2e.test.ts`: it starts the toy daemon,
two production `SignalCliHttpBackend` instances, two production `SidecarBridge`
instances, and real WebSocket clients. It verifies unchunked transfer, chunked
reassembly, sender echo suppression, and sidecar retry after a toy RPC failure.

## Deterministic test-control API

The test-control namespace is intentionally outside `/api/v1/*` so application
code cannot confuse toy-only controls with signal-cli functionality.

| Method | Path                   | Purpose                                       |
| ------ | ---------------------- | --------------------------------------------- |
| `GET`  | `/__toy__/v1/contract` | machine-readable compatibility contract       |
| `GET`  | `/__toy__/v1/state`    | inspect accounts, groups, SSE clients, faults |
| `POST` | `/__toy__/v1/reset`    | reset to defaults or `{ "config": ... }`      |
| `POST` | `/__toy__/v1/faults`   | install deterministic delivery/RPC faults     |
| `POST` | `/__toy__/v1/inject`   | inject an incoming data message               |

Fault fields:

```json
{
  "failNextRpcSends": 1,
  "dropNextDeliveries": 0,
  "duplicateNextDeliveries": 1,
  "deliveryDelayMs": 10,
  "closeSseAfterNextDelivery": false
}
```

## Deliberate limits

This is not a Signal protocol implementation and performs no cryptography,
service authentication, pre-key/session management, attachment transfer,
identity verification, rate limiting, or real linked-device provisioning.

Those behaviors must be tested against real current `signal-cli`. The toy's job
is narrower: make every e2e-col assumption about the **local daemon API and
message-routing contract** executable, inspectable, deterministic, and suitable
for CI/demos.
