# ADR 0004: Per-recipient application encryption

- **Status:** Accepted for the current identity model
- **Date:** 2026-08-27

## Context

The application has individually authenticated browser identities and prekey material. It needs an encrypted payload that can be delivered over group-like transports without making the transport an encryption authority.

## Decision

For each logical application envelope, create one recipient-bound ciphertext for each active participant. The transport fan-out frame is routing structure only; each receiver is given only its own ciphertext before application decryption.

## Why not one shared group key?

A shared group key would require its own membership-change rekey protocol, distribution/authentication rules, compromise handling, and historical-key lifecycle. Those mechanisms are not implied by the existing R6 authorization chain. Per-recipient encryption is less efficient but keeps recipient identity binding explicit and avoids silently inventing a group-key protocol.

## Consequences

- Network/application encryption work scales roughly with active recipient count.
- Stable identity metadata lookups are separated from consumable one-time-prekey lookup so signature/commitment checks do not waste prekeys.
- Attachment bytes should use a dedicated content layer rather than multiplying large binary content inside CRDT/envelope fan-out.
- A future group-key or MLS design requires a new ADR and migration/security analysis.
