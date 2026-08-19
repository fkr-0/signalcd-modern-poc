# End-to-End Encrypted Collaborative Documents: Motivation, Concept, Solution, and Deployment

Collaborative editing has become an ordinary part of modern computing, yet most
collaborative document systems still depend on a central service that can see,
index, or otherwise process the plaintext contents of a document. That model is
convenient because it gives the service provider a single authoritative state
and a natural place to perform synchronization, access control, history, and
conflict resolution. It is also the reason collaborative editing remains much
harder to reconcile with strong end-to-end encryption than ordinary messaging.

The central motivation behind `e2e-col` is to separate two concerns that are
usually bundled together: deciding what the shared document state is, and moving
encrypted updates between participants. The research prototype from SPRING/EPFL
and the accompanying USENIX Security 2026 paper show that these concerns can be
composed cleanly. A strongly convergent reconciliation mechanism can run at the
clients, while an end-to-end encrypted asynchronous broadcast channel carries
opaque update messages between those clients. The helper infrastructure does
not need to understand or arbitrate the plaintext document at all.

This is a powerful reframing. Instead of asking a server to merge edits, the
clients exchange CRDT changes and independently arrive at the same state. In our
implementation, Automerge provides the strongly convergent reconciliation
layer. Local edits create compact binary changes; remote changes can be applied
in different orders, duplicated, or delayed without requiring a central
plaintext authority. This property is especially important for real-world
collaboration because networks are unreliable, people go offline, devices
restart, and asynchronous delivery is normal rather than exceptional.

Signal then becomes one possible transport for those changes. The original PoC
demonstrates that Automerge updates can be serialized and sent through Signal
group messages, allowing the Signal protocol to provide end-to-end encrypted
broadcast while the CRDT provides convergence. `e2e-col` retains this idea but
modernizes the software boundaries. The browser application does not invoke
`signal-cli` directly and never stores Signal device credentials. Instead, a
small local sidecar owns the Signal linked-device state and exposes a narrow
localhost API to the browser. The browser sees only a transport interface that
can send and receive opaque document updates.

That abstraction is central to the design because the paper's construction is
not fundamentally tied to Signal. Signal is the initial backend because it is a
well-understood E2EE asynchronous broadcast system and because the research PoC
already provides evidence for its feasibility. But the document core is written
against a generic collaborative transport interface. A future MLS-based group
channel, an encrypted object relay, or another messaging substrate could replace
Signal without rewriting the editor or reconciliation layer.

The modern implementation is organized as a small TypeScript monorepo. The
browser application uses Vite and React for the user interface, while Automerge
provides the CRDT engine. The CRDT logic is extracted into a UI-neutral core
package so that React components do not depend directly on Automerge internals.
A separate protocol package defines versioned binary envelopes, message and
document identifiers, frame kinds, chunking metadata, and runtime validation.
Transport adapters implement loopback, deterministic fault injection, and
WebSocket delivery, while the local sidecar implements the Signal bridge. An IndexedDB storage package makes
the system local-first by preserving document state, snapshots, and pending
outbound work across browser restarts.

This package structure is not merely organizational. It enforces the trust and
correctness boundaries required by the design. The editor can be tested without
Signal. The Signal sidecar can be tested without React. Protocol validation can
be fuzzed independently. Storage recovery can be exercised without a network.
Most importantly, the helper sidecar never becomes the canonical plaintext
document store. The source of truth remains the set of client replicas and the
convergent operations they have received.

The deployment model follows naturally from those boundaries. The first target
is a web application paired with a local companion daemon. The user opens the
Vite-built application, while the local Node.js sidecar manages `signal-cli`,
linked-device state, transport health, and the conversion between Signal group
messages and typed document envelopes. The browser and sidecar communicate over
a localhost-only WebSocket or HTTP interface. Signal credentials and device
state remain on the local machine and do not cross into browser storage.

For local-first behavior, the browser persists documents and pending updates in
IndexedDB. A user can therefore continue editing while offline. When the
connection is restored, queued CRDT changes are sent through the sidecar and
merged by the other replicas. Because the reconciliation layer is designed to
converge under delayed and reordered delivery, reconnecting does not require a
central merge server. Periodic snapshots or checkpoints bound recovery time and
history growth, while incremental changes remain the normal synchronization
unit.

The deployment can later be packaged more tightly if desired. A desktop shell
such as Tauri or Electron could bundle the web UI and sidecar into one install,
but that is an operational decision rather than an architectural requirement.
Keeping the web and sidecar boundary explicit during development makes the
security model easier to inspect and the components easier to test.

The `0.0.1` implementation deliberately begins with correctness rather than rich-text
features. The first milestone is to prove robust convergence with independent
replicas under duplicated, delayed, reordered, and offline delivery. The second
milestone is to harden the protocol and persistence layers. Only then does the
real Signal sidecar become part of the main execution path. Access-control
semantics from the paper—participant lists, read/write/admin roles, archival,
and deletion behavior—follow once the transport and convergence substrate are
stable. The first release includes the browser protocol/storage integration and
the locally testable Signal sidecar, while authenticated access semantics and a
richer block-based editor remain intentionally later.

This order matters because the hardest failures in encrypted collaborative
editing are not visual. They are failures where one device silently diverges,
where queued work is lost after a restart, where a duplicate frame changes the
document twice, where membership state can be forged, or where the helper
service gradually becomes trusted with more plaintext than intended. The design
of `e2e-col` makes those failure modes explicit and testable.

The resulting system is therefore best understood not as "Google Docs over
Signal," but as a reference architecture for private collaborative state. It
combines a local-first convergent data model with a replaceable encrypted
broadcast transport, preserves client authority over plaintext state, and
creates a clean path from a research PoC to a deployable, inspectable modern
application.
