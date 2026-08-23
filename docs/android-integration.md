# Android integration

Status: **P3 Phase-1 sidecar proxy complete / CRDT UI and native E2EE pending**
Date: **2026-08-22**

This document is the implementation contract for the Android application in `apps/android`. The Android client is intentionally a native Kotlin application, not an embedded browser and not a second TypeScript runtime. It shares the same e2e-col wire protocol and sidecar contract through executable cross-language fixtures.

## 1. Current decision

The Android app uses a native Kotlin architecture with a small compatibility layer that mirrors only stable public contracts from the TypeScript monorepo:

```text
apps/android/app                Compose UI + lifecycle/ViewModel
        │
        ├── core:model          platform-neutral join/domain values, SessionTransport
        ├── core:protocol       E2EC ProtocolEnvelope codec + TS golden fixtures
        ├── core:sidecar        loopback-first OkHttp WebSocket transport
        ├── core:identity       Room entities for local/remote identity
        ├── core:storage        Room database, DAOs, atomic transactions
        └── core:session        Automerge DocumentSession lifecycle
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

Candidate native CRDT dependency: `org.automerge:automerge-kotlin:0.0.9` / `org.automerge:automerge:0.0.9`. It is wired into `core:session` and `DocumentSession` uses it for text editing, change encoding, and snapshot persistence. Before enabling CRDT mutation in the Compose UI, Android must prove that Java/Kotlin Automerge changes and snapshots round-trip against the JavaScript implementation used by `@e2e-col/core`.

Room 2.7.2 is used for persistence in `core:storage` and `core:identity`. The schema covers documents, outbound queue, access control, local identity, and remote identity tables with atomic transaction support via `StorageTransactionDao`.

## 3. Sidecar mode: first production path

Phase 1 uses the existing sidecar contract rather than trying to run Signal protocol code inside Android. The current sidecar accepts a WebSocket upgrade with the document UUID as a query parameter and binary `ProtocolEnvelope` frames:

```text
ws://127.0.0.1:43127/?documentId=<uuid>
```

There is **no bearer-token first frame in this sidecar protocol**. That authentication handshake belongs to the separate toy `MockSignalTransport` group backbone. Do not add a token to the sidecar URL or invent an auth frame that the Node sidecar does not understand.

The Android `core:sidecar` module therefore:

- accepts WebSocket endpoint schemes only (`ws://` or `wss://`);
- appends exactly one `documentId` query parameter;
- sends and receives binary frames only;
- defaults to `localhost`, `127.0.0.1`, or `::1`;
- requires an explicit `allowRemote=true` opt-in for any non-loopback endpoint;
- requires `wss://` even after that remote opt-in;
- rejects URL credentials rather than allowing implicit HTTP/WebSocket authentication;
- sends no Authorization header unless a future sidecar contract explicitly adds one;
- reports `SessionTransport.isConnected` from the actual WebSocket open/closed/failure lifecycle instead of assuming the adapter is online;
- maps only sidecar close code `4409` to explicit history-risk recovery evidence. Ordinary `1011`, restart, and socket-failure paths remain ordinary replayable transport failures, matching the browser transport contract.

This completes the P3 Phase-1 **proxy transport** boundary. It deliberately does not make the current Compose text field collaborative: Android does not yet implement the recipient-bound encrypted `E2EE` wrapper, so emitting native CRDT document material through the production sidecar at this stage would cross the repository's E2EE boundary. Phase 1 therefore proves and hardens the proxy seam without introducing an Android private-key ownership model or weakening the browser-owned/private-key guarantees.

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

`core:session` provides a `DocumentSession` that owns:

- Automerge document load/save and text object identity;
- local edit -> Automerge change bytes;
- remote change/snapshot application;
- protocol envelope creation/validation;
- durable snapshot + outbound queue transaction via `StorageTransactionDao`;
- `StateFlow` document/session state.

What remains before UI integration:

- durable `(documentId,messageId)` seen ledger;
- retry metadata and recovery checkpoint policy;
- wiring `DocumentSession` into the Compose ViewModel instead of the local draft field.

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

Android reproduces the semantics already implemented in `@e2e-col/storage` / `@e2e-col/client`. The Room schema in `core:storage` contains:

```text
document(documentId PK, snapshot BLOB, updatedAt, title, archived)
outbound(id PK, documentId, payload BLOB, createdAt, state, attempts, kind)
access_control(documentId PK, selfRole, participants, archived, deleted, revision)
```

`core:identity` adds:

```text
identity(userId PK, phoneNumber, displayName, identityKeyPublic, signedPrekeyPublic, sessionToken, createdAt)
remote_identity(userId PK, phoneNumber, identityKeyPublic, verified, fetchedAt)
```

Still missing before M1 completion:

```text
seen_messages(document_id, message_id, seen_at, PK(document_id,message_id))
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
pnpm run android:check       # pure JVM model/protocol/sidecar/identity/storage/session tests
pnpm run android:assemble    # Android debug APK; requires API 36 SDK + build tools
```

Use a JDK 17 Gradle runtime. The checked-in wrapper is pinned to Gradle 9.3.1.

Required local Android SDK packages:

```text
platforms;android-36
build-tools;36.0.0
```

Dedicated GitHub Actions workflows run Android CI independently:

- `.github/workflows/android-build.yml` — assembles debug APK on every push/PR; assembles release APK on version tags; uploads APK artifacts.
- `.github/workflows/android-test.yml` — runs all core module unit tests (model, protocol, sidecar, identity, storage, session) and Android lint on push/PR.

The main `ci.yml` workflow also includes an Android job that runs `android:check` and `android:assemble` as part of the release gate. Both gates should be required for changes under shared protocol/contract fixtures.

## 11. Milestones

### M0 — buildable compatibility scaffold

- [x] Gradle multi-module project under `apps/android`
- [x] AGP 9 built-in Kotlin application setup
- [x] Compose/ViewModel/StateFlow shell
- [x] validated custom join-link parser
- [x] loopback-first OkHttp sidecar transport
- [x] fail-closed sidecar endpoint policy (`ws(s)` only, loopback default, remote `wss` opt-in, no URL credentials)
- [x] truthful sidecar connection state and browser-parity `4409` history-risk recovery signaling
- [x] deterministic native binary-frame/lifecycle proxy tests
- [x] native ProtocolEnvelope v1 codec
- [x] byte-for-byte TypeScript/Kotlin golden fixture
- [x] Android API 36 assembly verified in a provisioned SDK environment
- [x] dedicated Android CI workflows (build + test)

### M1 — local-first document core

- [x] Automerge Java/Kotlin binding wired into `core:session`
- [x] `DocumentSession` with text editing, change encoding, and snapshot persistence
- [x] Room durable snapshot/outbound/access transactions via `StorageTransactionDao`
- [ ] CRDT interop fixtures proving JS<->JVM change/snapshot round-trip
- [ ] process-death restore tests
- [ ] sidecar send/receive convergence against two clients
- [ ] wire `DocumentSession` into Compose ViewModel

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
