# Desktop scaffold feasibility

Status: **GO for a wrapper-only desktop Phase 1, implementation not yet started**
Date: **2026-08-27**

The existing web renderer, IndexedDB/WebCrypto ownership model, `WebSocketTransport`, and Node sidecar are sufficient to support a desktop shell without redesigning the collaboration protocol. A desktop application is therefore technically feasible. It must remain a wrapper around the already-qualified browser/client boundary rather than becoming a second identity, crypto, or Signal implementation.

## Security-preserving Phase-1 boundary

A desktop host may:

- create one application window with a stable application origin/profile;
- supervise an already-configured localhost sidecar process;
- expose a narrow, typed set of non-secret runtime values such as sidecar URL and readiness;
- persist ordinary renderer profile data across restart;
- open external links through an explicit allowlist;
- report sidecar lifecycle/health to the renderer.

A desktop host must **not**:

- receive or export browser Ed25519/X25519 private keys;
- receive browser identity/session bearer tokens;
- decode collaborative application ciphertext;
- derive authorization state from sidecar/Signal membership;
- provision, link, import, or silently mutate a Signal account;
- inject arbitrary process environment or filesystem/native authority into the renderer;
- weaken the existing exact-origin sidecar policy.

The renderer remains the authority for WebCrypto private keys, IndexedDB identity/document state, R6 authorization verification, Automerge merge state, encryption/decryption, durable outbound records, and recovery semantics.

## Runtime assessment

Both Electron and Tauri can host the required renderer. **Tauri is the preferred implementation candidate**, primarily because this Phase 1 needs a narrow native shell rather than a second Node-capable renderer environment. This is a recommendation, not a dependency decision: implementation should begin only when repository authority explicitly accepts the host contract below and chooses the runtime.

The Node sidecar does not need to be rewritten before the first desktop slice. Phase 1 can supervise a packaged Node executable/script bundle or an externally installed sidecar command. A later native sidecar binary is an optimization/packaging project, not a correctness prerequisite.

## Contract required before scaffold implementation

1. **Runtime:** choose Tauri or Electron and pin its supported major version.
2. **Renderer origin/profile:** define the packaged application origin, persistent profile path, upgrade behavior, CSP, single-window policy, navigation confinement, and external-link policy.
3. **Host → renderer API:** permit only typed, non-secret endpoint/readiness values; no generic shell, env, filesystem, or process bridge.
4. **Sidecar lifecycle:** define executable discovery, start/stop/restart, readiness timeout, crash behavior, logging, port ownership, and single-instance rules.
5. **Signal ownership:** Phase 1 consumes an already-configured local `signal-cli`/sidecar deployment; provisioning and account linking remain external.
6. **Endpoint composition:** define how identity/group/sidecar endpoints are supplied without transferring browser credentials to the host.
7. **Storage lifecycle:** preserve renderer IndexedDB/WebCrypto profile identity across close/reopen and upgrades; destructive reset must be an explicit user operation.
8. **Acceptance matrix:** cold start, close/reopen, renderer reload, sidecar crash/restart, offline durable replay, identity restoration, two-client convergence, CSP/navigation rejection, and exact-origin rejection.

## Smallest safe implementation plan

### D1 — host shell

Create one window, fixed CSP/navigation policy, stable profile, and no application IPC beyond a typed read-only configuration object.

### D2 — sidecar supervisor

Launch or attach to the existing sidecar according to the ratified lifecycle contract. Expose readiness only. Do not provision Signal.

### D3 — renderer composition

Reuse the existing web entrypoint and `WebSocketTransport`. Renderer-side `IdentityClient`, IndexedDB storage, R6 verification, E2EE, and Automerge remain unchanged.

### D4 — acceptance

Prove persistent identity/document restoration, sidecar restart recovery, durable replay, two-client encrypted convergence, and host privilege confinement before considering packaging complete.

## Explicit non-goals

- no Signal account registration/linking;
- no host-owned application crypto;
- no native reimplementation of Automerge/protocol/client;
- no automatic Ed25519 identity-key rebinding;
- no iOS work implied by the desktop wrapper;
- no claim that Electron/Tauri packaging makes the real-Signal live evidence gate complete.

Until the host contract is ratified, adding an Electron/Tauri dependency or IPC/preload/native bridge would create more trust surface than usable product evidence. The roadmap therefore records desktop as **feasible but intentionally unscaffolded**.
