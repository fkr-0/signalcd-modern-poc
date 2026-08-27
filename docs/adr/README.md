# Architecture decision records

ADRs record decisions that materially affect interoperability, security boundaries, or long-lived application structure. They describe why the repository chose a direction and what would justify revisiting it; they are not claims that the current technical preview is production-secure.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-automerge-over-yjs.md) | Use Automerge as the CRDT/reconciliation engine | Accepted |
| [0002](0002-application-envelope-cryptography.md) | Keep application envelope E2EE above the asynchronous transport | Accepted for the PoC |
| [0003](0003-signal-sidecar-boundary.md) | Isolate `signal-cli` behind a localhost sidecar | Accepted |
| [0004](0004-per-recipient-encryption.md) | Encrypt one application copy per active recipient | Accepted for the current identity model |
| [0005](0005-peerjs-alternative-transport.md) | Treat PeerJS as a bounded live-P2P demo transport, not a Signal mailbox | Accepted |

New ADRs use the next four-digit sequence and should link implementation/tests that enforce the decision.
