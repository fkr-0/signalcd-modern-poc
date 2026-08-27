# ADR 0003: Local sidecar for `signal-cli`

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

`signal-cli` owns linked-device credentials, Signal protocol state, daemon APIs, and platform/native dependencies. Browser code should not gain direct access to those credentials or assume undocumented Signal internals.

## Decision

Keep `signal-cli` behind the Node sidecar. Browsers exchange bounded binary frames with a localhost WebSocket adapter; the sidecar owns Signal JSON-RPC/SSE translation, configured document-to-group mapping, chunking/reassembly, sender-echo suppression, retry at the daemon boundary, and startup validation.

## Consequences

- Signal device credentials stay outside browser storage.
- The browser/client remains transport-agnostic.
- Sidecar remote exposure is not enabled by default; non-loopback deployment requires explicit secure configuration.
- Account linking, registration, and group mutation remain provisioning operations outside ordinary sidecar startup.
- Live two-account Signal qualification remains an external deployment gate even when the contract tests are green.
