# SignalCD Modern PoC — Android

Native Kotlin Android scaffold for the SignalCD Modern PoC collaboration client. The TypeScript browser packages remain the behavioral reference; Android mirrors stable wire and sidecar contracts through executable compatibility fixtures.

## Modules

```text
app/            Compose entry point, ViewModel, deep-link handling
core/model/     platform-neutral join/domain values, SessionTransport interface
core/protocol/  ProtocolEnvelope v1 codec and TypeScript golden fixture
core/sidecar/   fail-closed loopback-first OkHttp WebSocket sidecar proxy
core/identity/  Room entities for local and remote identity storage
core/storage/   Room database, DAOs, and atomic transaction helpers
core/session/   Automerge DocumentSession with CRDT edit/inbound/persistence
```

`core:session` provides a working Automerge-backed `DocumentSession` that can
edit text, encode/decode protocol envelopes, and persist snapshots atomically
via Room. The Compose app scaffold still exposes a local draft text field
rather than wiring the session into the UI; that integration is the next
milestone.

## Requirements

- JDK 17
- Android SDK platform 36
- Android Build Tools 36.0.0
- checked-in Gradle 9.3.1 wrapper

From the repository root:

```bash
pnpm run android:check
pnpm run android:assemble
```

For a desktop sidecar used by an emulator or physical device, preserve loopback semantics with:

```bash
adb reverse tcp:43127 tcp:43127
```

Then use `ws://127.0.0.1:43127` in the app.

## Contract boundaries

- Sidecar: `ws://`/`wss://` only, binary WebSocket, exactly one `documentId` query parameter, no URL credentials and no invented auth frame.
- Sidecar lifecycle: `SessionTransport.isConnected` reflects the real WebSocket lifecycle; close code `4409` alone is explicit sidecar history-risk recovery evidence, while ordinary `1011`/disconnects remain replayable transport failures.
- Protocol: exact `E2EC` v1 codec parity with `packages/protocol`.
- Secrets: no tokens or key material in deep links, WorkManager input, logs, or UI state.
- Networking: cleartext is permitted only for loopback development; remote sidecars require explicit opt-in and TLS.
- Persistence: Room is introduced with the first real document/outbound/seen/access transaction schema, not as unused generated code.

Phase-1 proxy completion does **not** enable native collaborative document sends. The Compose draft remains local until the remaining M1 JS↔JVM CRDT/process-restore evidence is complete, and production encrypted sends remain gated on the M2 native `E2EE`/Keystore parity work. This keeps the browser-owned private-key contract intact rather than sending plaintext CRDT payloads through the production sidecar.

See `docs/android-integration.md` for the complete architecture, security constraints, and milestone plan.
