# e2e-col Android

Native Kotlin Android scaffold for the e2e-col collaboration client. The TypeScript browser packages remain the behavioral reference; Android mirrors stable wire and sidecar contracts through executable compatibility fixtures.

## Modules

```text
app/            Compose entry point, ViewModel, deep-link handling
core/model/     platform-neutral join/domain values
core/protocol/  ProtocolEnvelope v1 codec and TypeScript golden fixture
core/sidecar/   loopback-first OkHttp WebSocket client
```

The scaffold intentionally does **not** send editor text. CRDT mutation remains disabled until an Automerge Java/Kotlin binding passes snapshot/change interoperability tests against `@e2e-col/core`. This avoids shipping a second, superficially compatible document model.

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

- Sidecar: binary WebSocket, `documentId` query parameter, no invented auth frame.
- Protocol: exact `E2EC` v1 codec parity with `packages/protocol`.
- Secrets: no tokens or key material in deep links, WorkManager input, logs, or UI state.
- Networking: cleartext is permitted only for loopback development; remote sidecars require explicit opt-in and TLS.
- Persistence: Room is introduced with the first real document/outbound/seen/access transaction schema, not as unused generated code.

See `docs/android-integration.md` for the complete architecture, security constraints, and milestone plan.
