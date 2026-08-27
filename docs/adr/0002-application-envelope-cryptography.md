# ADR 0002: Application envelope cryptography above transport

- **Status:** Accepted for the technical preview
- **Date:** 2026-08-27

## Context

The browser must keep collaborative document plaintext and private application identity keys outside the Signal sidecar, toy service, PeerServer, and generic transports. The system also needs the same encrypted application envelope to work over multiple transports.

## Decision

Keep recipient-bound application E2EE above `CollaborativeTransport`: long-term Ed25519 signing identity, X25519 signed/one-time prekeys, ephemeral X25519 agreement, domain-separated HKDF-SHA-256, and AES-256-GCM authenticated encryption.

This is an application-envelope construction for the PoC. It does **not** claim to reimplement Signal's Double Ratchet or Sender Keys, and does not inherit Signal's forward-secrecy/post-compromise-security properties merely because one transport is Signal.

## Why not put Signal's ratchet in the browser?

The production Signal implementation and device state live behind `signal-cli`; importing or duplicating Signal internals in browser JavaScript would couple the application to an unstable/private integration surface and make PeerJS/local transports depend on Signal-specific state. The research question is better served by a transport-independent application ciphertext boundary.

## Consequences

- Sidecars/transports see opaque application ciphertext.
- Identity and authorization commitments remain application-owned.
- Long-term identity-key rotation requires an explicit authenticated rebind protocol; directory overwrite is forbidden.
- If future requirements demand Signal-equivalent forward secrecy or post-compromise security at the application layer, introduce a separately reviewed versioned key schedule rather than relabeling the current construction.
