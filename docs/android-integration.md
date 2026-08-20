# Android integration

Status: **scaffolded / protocol-compatible, CRDT runtime integration pending**  
Date: **2026-08-20**

This document is the implementation contract for the Android application in `apps/android`. The Android client is intentionally a native Kotlin application, not an embedded browser and not a second TypeScript runtime. It shares the same e2e-col wire protocol and sidecar contract through executable cross-language fixtures.

## 1. Current decision

The Android app uses a native Kotlin architecture with a small compatibility layer that mirrors only stable public contracts from the TypeScript monorepo:

```text
apps/android/app                Compose UI + lifecycle/ViewModel
        │
        ├── core:model          platform-neutral join/domain values
        ├── core:protocol       E2EC ProtocolEnvelope codec + TS golden fixtures
        └── core:sidecar        loopback-first OkHttp WebSocket transport
                                      │
                                      ▼
                             e2e-col sidecar (Node)
                                      │
                                      ▼
                            signal-cli HTTP JSON-RPC/SSE
```

The TypeScript packages remain the canonical implementation for browser behavior. They are **not Gradle modules** and must not appear as `implementation(project(":packages:client"))` dependencies. Android compatibility is enforced at stable seams instead:

1. byte-for-byte protocol fixtures;
2. sidecar request/response contract tests;
3. CRDT change/snapshot interoperability fixtures;
4. identity/encryption fixtures before any native encrypted transport is enabled.

This approach avoids two runtimes with subtly different assumptions while still allowing Android-specific lifecycle, storage, security, and background execution.

## 2. Toolchain baseline

The scaffold deliberately uses stable, current dependencies that remain compatible with Android 16 / API 36:

| Component | Scaffold baseline | Rationale |
|---|---:|---|
| Android Gradle Plugin | 9.1.1 | AGP 9 built-in Kotlin model; API 36/37 capable |
| Gradle wrapper | 9.3.1 | AGP 9.1 compatibility baseline |
| JDK | 17 | Android build toolchain baseline |
| Kotlin | 2.4.10 | current stable Kotlin bug-fix line |
| `compileSdk` | 36 | Android 16 APIs |
| `targetSdk` | 36 | required for new Play submissions/updates from 2026-08-31 |
| `minSdk` | 23 | current AndroidX default floor and Keystore-capable baseline |
| Compose BOM | 2026.06.00 | stable Compose 1.11 line without forcing API 37 |
| Activity Compose | 1.13.0 | stable |
| Lifecycle | 2.10.0 | stable |
| WorkManager | 2.11.2 | stable reliable background work line |
| OkHttp | 5.4.0 | stable WebSocket/HTTP client |

Compose 1.12 / BOM 2026.08.00 moves core Compose to `compileSdk 37` and requires a newer AGP point release. The project intentionally stays on the 1.11 BOM until the repository toolchain moves to API 37 as one coordinated change.

Candidate native CRDT dependency: `org.automerge:automerge-kotlin:0.0.9` / `org.automerge:automerge:0.0.9`. It is **not yet wired into the app**. Before enabling document mutation/send, Android must prove that Java/Kotlin Automerge changes and snapshots round-trip against the JavaScript implementation used by `@e2e-col/core`.

For persistence, Room 2.8.4 is the current planned Android implementation, but the Room schema should be added only with the first real durable document/outbound-queue implementation rather than as unused scaffold code.

## 3. Sidecar mode: first production path

Phase 1 uses the existing sidecar contract rather than trying to run Signal protocol code inside Android. The current sidecar accepts a WebSocket upgrade with the document UUID as a query parameter and binary `ProtocolEnvelope` frames:

```text
ws://127.0.0.1:43127/?documentId=<uuid>
```

There is **no bearer-token first frame in this sidecar protocol**. That authentication handshake belongs to the separate toy `MockSignalTransport` group backbone. Do not add a token to the sidecar URL or invent an auth frame that the Node sidecar does not understand.

The Android `core:sidecar` module therefore:

- appends exactly one `documentId` query parameter;
- sends and receives binary frames only;
- defaults to `localhost`, `127.0.0.1`, or `::1`;
- requires an explicit `allowRemote=true` opt-in for any non-loopback endpoint;
- sends no Authorization header unless a future sidecar contract explicitly adds one.

### Development from an emulator or physical device

Prefer ADB reverse so the Android app can still use loopback semantics:

```bash
adb reverse tcp:43127 tcp:43127
```

Then configure the app with `ws://127.0.0.1:43127`. Do not hard-code emulator-only `10.0.2.2` into production configuration.

The manifest disables general cleartext networking and grants a network-security exception only to local sidecar hosts. Remote sidecars must use TLS (`wss://`) and require a separate threat-model/configuration change.

## 4. Protocol compatibility

`core:protocol` is a native implementation of the stable v1 binary envelope codec. The test suite contains the exact canonical fixture from `packages/protocol/src/protocol.test.ts`:

```text
E2EC magic
version = 1
kind automerge-change = 1
flags: sequence present
createdAt = 1787159200000
sequence = 7
document = 11111111-1111-4111-8111-111111111111
message  = 22222222-2222-4222-8222-222222222222
sender   = device-A
payload  = 01 02 03 04
```

The Kotlin encoder must produce the same full hex fixture as TypeScript, and Kotlin must decode the same bytes. This is the minimum acceptance gate for every Android protocol change.

The encrypted `E2EE` wrapper is intentionally not mirrored yet. Native encryption must not ship until Android has equivalent Ed25519/X25519/HKDF/AES-GCM fixtures, key-selector semantics, and recipient-binding validation.

## 5. App architecture

The Android application follows unidirectional state flow:

```text
Compose UI
   │ events
   ▼
EditorViewModel ─── StateFlow<EditorUiState> ───► Compose UI
   │
   ├── JoinRequestParser
   ├── SidecarWebSocketTransport
   └── future AndroidCollaborationRepository
```

The current scaffold can:

- accept and validate `e2e-col://join?...` links;
- configure a document UUID and loopback sidecar URL;
- connect/disconnect from the real sidecar contract;
- validate inbound `ProtocolEnvelope` frames using the native codec;
- expose connection and last-frame state to Compose.

The text field is deliberately labeled a **local scaffold draft**. It does not emit CRDT changes yet; pretending plain text is an Automerge change would create a wire-compatible-looking but semantically broken client.

### Next repository boundary

Introduce an `AndroidCollaborationRepository` only after CRDT interop fixtures pass. It should own:

- Automerge document load/save and text object identity;
- local edit -> Automerge change bytes;
- remote change/snapshot application;
- protocol envelope creation/validation;
- durable snapshot + outbound queue transaction;
- durable `(documentId,messageId)` seen ledger;
- retry metadata and recovery checkpoint policy;
- `StateFlow` document/session state for the ViewModel.

The UI must never directly manipulate Automerge, Room, OkHttp, or key material.

## 6. Deep links and invitations

The documented development link remains:

```text
e2e-col://join?document=<uuid>&group=<uuid>&inviter=<display-name>
```

`JoinRequestParser` validates the scheme/host and UUIDs before state mutation. A production public release should additionally provide verified HTTPS Android App Links; custom schemes can be claimed by another installed application and must not be treated as proof of inviter identity.

A join link contains identifiers only. It must never contain bearer tokens, private keys, one-time prekeys, or plaintext document material.

## 7. Identity and key storage

The Android identity implementation is still pending. Required rules:

- Ed25519 identity private keys and X25519 prekeys must be generated/stored using Android Keystore-backed protection where algorithm/provider support permits;
- exportability and backup behavior must be explicitly tested rather than assumed;
- session tokens must be encrypted at rest and excluded from Android backup;
- public-key lookup must use TLS outside loopback development;
- safety-number derivation must match browser fixtures exactly;
- no key material may enter logs, WorkManager input data, deep links, notifications, or saved instance state.

The app currently sets `android:allowBackup="false"` until a reviewed backup/restore story exists.

## 8. Persistence and offline behavior

Android should reproduce the semantics already implemented in `@e2e-col/storage` / `@e2e-col/client`, not invent a separate queue model. The first Room schema should contain at least:

```text
documents(document_id PK, automerge_snapshot BLOB, updated_at, schema_version, metadata...)
outbound(id PK, document_id, payload BLOB, created_at, state, attempts, last_attempt_at)
seen_messages(document_id, message_id, seen_at, PK(document_id,message_id))
access_control(document_id PK, state BLOB/columns, revision)
```

Required transaction boundaries:

- local mutation: new snapshot + outbound records atomically;
- remote mutation: new snapshot + seen marker atomically;
- access mutation: access state + outbound control record atomically.

A process crash must never leave a visible local edit without its corresponding outbound work.

## 9. Background work

Use foreground execution only for genuinely user-visible continuous synchronization. Use WorkManager for deferrable retry/recovery work. Do not keep an immortal service merely to maintain a socket.

When background sync is implemented:

- use unique work per document/account;
- constrain network-dependent work with `NetworkType.CONNECTED`;
- retain durable queue state in Room rather than WorkManager input;
- make workers idempotent;
- surface foreground notifications only while long-running user-visible sync is active;
- stop/reconnect cleanly across app process death and OS background restrictions.

Running a desktop `signal-cli` JVM child process inside an ordinary Android app is **not** the default Phase-1 design. A standalone on-device Signal backend remains a separate feasibility/security milestone because packaging a JVM/Rust/native Signal stack on Android has materially different lifecycle and ABI constraints.

## 10. Build and verification

The repository exposes:

```bash
pnpm run android:check       # pure JVM model/protocol/sidecar compatibility tests
pnpm run android:assemble    # Android debug APK; requires API 36 SDK + build tools
```

Use a JDK 17 Gradle runtime. The checked-in wrapper is pinned to Gradle 9.3.1.

Required local Android SDK packages:

```text
platforms;android-36
build-tools;36.0.0
```

The Android checks are intentionally separate from the pnpm TypeScript `check` gate until Android CI has an explicit JDK/SDK image. Once CI is provisioned, both gates should be required for changes under shared protocol/contract fixtures.

## 11. Milestones

### M0 — buildable compatibility scaffold

- [x] Gradle multi-module project under `apps/android`
- [x] AGP 9 built-in Kotlin application setup
- [x] Compose/ViewModel/StateFlow shell
- [x] validated custom join-link parser
- [x] loopback-first OkHttp sidecar transport
- [x] native ProtocolEnvelope v1 codec
- [x] byte-for-byte TypeScript/Kotlin golden fixture
- [ ] Android API 36 assembly verified in a provisioned SDK environment

### M1 — local-first document core

- [ ] pin Automerge Java/Kotlin binding after JS<->JVM change/snapshot fixtures pass
- [ ] native document repository and text editing
- [ ] Room durable snapshot/outbound/seen/access transactions
- [ ] process-death restore tests
- [ ] sidecar send/receive convergence against two clients

### M2 — identity and encrypted envelopes

- [ ] Keystore-backed identity/prekey storage
- [ ] identity REST adapter and session restoration
- [ ] encrypted `E2EE` codec and cryptographic fixture parity
- [ ] safety-number parity tests
- [ ] no-secret logging/backup verification

### M3 — sharing and recovery UX

- [ ] participant list and role controls
- [ ] invite link creation/acceptance
- [ ] auto/manual sync mode + pending count
- [ ] retry/recovery state and explicit error model
- [ ] WorkManager retry policy

### M4 — production hardening

- [ ] verified HTTPS App Links
- [ ] instrumented tests across supported API levels and process death
- [ ] encrypted database/key backup threat-model decision
- [ ] accessibility/adaptive layout/predictive-back pass
- [ ] baseline profile and release build checks
- [ ] production sidecar/signal-cli smoke environment

### M5 — optional direct/on-device Signal backend

Only pursue after M1–M4. It requires a dedicated feasibility review for Signal protocol library licensing/API stability, Android ABI packaging, background execution, account linking, and key ownership. The public `AndroidCollaborationRepository`/transport boundary must remain stable if this backend is swapped in later.
