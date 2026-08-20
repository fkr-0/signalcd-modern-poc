# Android Integration — Experimental Production Spec

Status: **experimental design**  
Date: **2026-08-20**

This document specifies how an Android app could integrate with the e2e-col
collaboration system. It covers three approaches to Signal secret access,
sidecar communication, document-channel agreement, and UI requirements.

## 1. Architecture overview

```text
┌─────────────────────────────────────────────────────────────┐
│                     Android App                             │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────────┐ │
│  │ Editor   │  │ e2e-col      │  │ Signal Secret         │ │
│  │ UI       │──│ Client SDK   │──│ Provider              │ │
│  │          │  │ (Kotlin/JS)  │  │ (ContentProvider /    │ │
│  └──────────┘  └──────┬───────┘  │  direct integration)  │ │
│                       │          └───────────────────────┘ │
└───────────────────────┼────────────────────────────────────┘
                        │
            ┌───────────┴───────────┐
            │                       │
    ┌───────┴───────┐      ┌───────┴───────┐
    │ Local sidecar │      │ Direct Signal │
    │ (localhost WS)│      │ (future)      │
    └───────┬───────┘      └───────┬───────┘
            │                       │
    ┌───────┴───────┐      ┌───────┴───────┐
    │ signal-cli    │      │ Signal        │
    │ daemon        │      │ Service API   │
    └───────────────┘      └───────────────┘
```

## 2. Signal secret access

The e2e-col browser app never touches Signal credentials. The Android app
has three options, ordered by feasibility:

### 2.1 Phase 1: Sidecar proxy (recommended first)

The Android app runs a localhost sidecar process (or connects to a desktop
sidecar) and communicates via WebSocket, exactly like the browser.

**How it works:**
- Sidecar runs as a bound Android service or connects to a remote sidecar
- App connects to `ws://127.0.0.1:<port>/api/v1/messages?documentId=<uuid>`
- Sidecar owns all Signal interaction
- App sends/receives binary `ProtocolEnvelope` frames

**Signal secret access:** None required. The sidecar owns the Signal account.

**Pros:**
- Zero Signal integration code in the app
- Same architecture as browser
- Sidecar can be shared across devices

**Cons:**
- Sidecar must be running (foreground service or persistent process)
- Extra network hop
- Battery impact from persistent WebSocket

**Android component:**
```kotlin
class SidecarService : Service() {
    // Starts signal-cli daemon as a child process
    // Exposes WebSocket endpoint on localhost
    // Manages lifecycle (start/stop/restart)
}
```

### 2.2 Phase 2: Signal ContentProvider (if available)

Some Signal-compatible apps expose a ContentProvider for inter-app message
passing. If the user's Signal client supports this, the e2e-col app can
send/receive messages through it.

**How it works:**
- App queries the Signal client's ContentProvider for available groups
- App sends messages via `ContentProvider.insert()` with the e2e-col payload
- App receives messages via `ContentObserver` or polling

**Signal secret access:** None required. The Signal client owns the account.

**Pros:**
- No sidecar needed
- No Signal account management
- Uses the user's existing Signal identity

**Cons:**
- Requires the Signal client to expose a ContentProvider (not standard)
- Limited to what the ContentProvider exposes
- May not support group creation or key lookup
- Deprecation risk if Signal changes its API

**Android component:**
```kotlin
class SignalContentProviderBridge {
    // Queries: content://<signal-package>/groups
    // Sends: content://<signal-package>/send
    // Receives: ContentObserver on content://<signal-package>/messages
}
```

### 2.3 Phase 3: Direct Signal integration (future, risky)

The app implements the Signal protocol directly, managing its own keys
and communicating with the Signal server.

**How it works:**
- App generates its own identity keypair
- App registers with Signal server (phone number verification)
- App manages session keys, prekeys, and message encryption
- App sends/receives via Signal's WebSocket API

**Signal secret access:** Full. The app owns the Signal identity.

**Pros:**
- No external dependencies
- Full control over the protocol

**Cons:**
- Massive implementation effort (Signal protocol, server API, storage)
- Account management (phone number, verification)
- App Store review risk (crypto apps)
- Signal may block unofficial clients
- Key backup and recovery

**Not recommended** unless there is a specific reason to avoid the sidecar.

## 3. Sidecar communication protocol

### 3.1 WebSocket connection

```kotlin
// Connect to the sidecar's encrypted message endpoint
val url = "ws://127.0.0.1:$port/api/v1/messages?documentId=$documentId"
val socket = OkHttpClient().newWebSocket(
    Request.Builder().url(url).build(),
    E2ColWebSocketListener()
)
```

**Authentication:** First text frame must be a bearer token (JSON).
Subsequent frames are binary `ProtocolEnvelope` frames.

**First frame format:**
```json
{"type": "auth", "token": "<session-token>"}
```

### 3.2 Sending envelopes

```kotlin
// Encode a ProtocolEnvelope to binary
val envelope = createEnvelope(
    documentId = documentId,
    messageId = UUID.randomUUID().toString(),
    senderId = identity.userId,
    kind = "automerge-change",
    createdAt = System.currentTimeMillis(),
    payload = automergeChange
)
val wire = encodeEnvelope(envelope)
socket.send(ByteString.of(*wire))
```

### 3.3 Receiving envelopes

```kotlin
override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
    val envelope = decodeEnvelope(bytes.toByteArray())
    if (envelope.documentId != activeDocumentId) return
    if (envelope.kind != "automerge-change") return
    if (dedupCache.hasOrAdd(envelope)) return
    document.applyChanges(listOf(envelope.payload))
    persistSnapshot()
}
```

### 3.4 Encrypted mode

When using encrypted envelopes (per-recipient encryption):

```kotlin
// Encode: encrypt for each recipient, bundle as fanout frame
val recipients = groupMembers.filter { it.userId != identity.userId }
val encrypted = recipients.map { recipient ->
    EncryptedRecipient(
        phoneNumber = recipient.phoneNumber,
        payload = encodeEncryptedEnvelope(
            encryptEnvelope(envelope, recipient, identity)
        )
    )
}
val fanoutFrame = encodeMockSignalFanoutFrame(
    FanoutFrame(version = 1, messageId = envelope.messageId, recipients = encrypted)
)
socket.send(ByteString.of(*fanoutFrame))
```

## 4. Document-channel agreement

### 4.1 The problem

Two users want to collaborate on a document. They need to agree on:
- A shared document UUID
- A Signal group (or equivalent broadcast channel) for that document
- Who has what role (admin, writer, reader)

### 4.2 Approach A: QR code / deep link

The document creator generates a shareable link:

```
e2e-col://join?document=<uuid>&group=<group-id>&inviter=<phone>
```

The recipient opens the link, which:
1. Registers their identity (if not already)
2. Joins the Signal group
3. Opens the document session
4. Receives the initial state via the group

**Android component:**
```kotlin
class JoinActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val uri = intent.data
        val documentId = uri?.getQueryParameter("document")
        val groupId = uri?.getQueryParameter("group")
        val inviter = uri?.getQueryParameter("inviter")
        // Join the group and open the document
    }
}
```

**Manifest:**
```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="e2e-col" android:host="join" />
</intent-filter>
```

### 4.3 Approach B: Contact-based discovery

The app integrates with the phone's contacts to discover other e2e-col users:

1. User A selects contact B from their phone
2. App checks if B is registered with the identity server
3. If yes, A creates a document and invites B
4. B receives an invitation (push notification or in-app message)
5. B accepts and joins

**Requires:** Push notification infrastructure or a shared discovery service.

### 4.4 Approach C: In-band Signal group invitation

The document creator adds the recipient to a Signal group directly:

1. Creator knows recipient's Signal phone number
2. Creator calls `updateGroup` to add recipient
3. Recipient's Signal client receives the group update
4. Recipient's e2e-col app detects the new group and opens the document

**Requires:** Signal group management API access (available via sidecar).

### 4.5 Recommended approach

**Phase 1:** QR code / deep link (Approach A). Simple, no infrastructure needed.

**Phase 2:** Contact-based discovery (Approach B). Better UX but requires
a discovery service or push notifications.

**Phase 3:** In-band Signal invitation (Approach C). Best UX but requires
tight Signal integration.

## 5. UI requirements

### 5.1 Document list

- Shows all documents the user has access to
- Filter by: active, archived, by role
- Pull-to-refresh
- Long-press for: archive, delete, share

### 5.2 Editor

- Full-screen text editor
- Auto-save on every keystroke
- Sync status indicator (synced/syncing/offline/pending)
- Character count
- Undo/redo (local only)

### 5.3 Share / invite

- "Invite" button in document toolbar
- Options: QR code, deep link, phone number input
- Role selector: reader, writer, admin
- Pending invitations list

### 5.4 Identity management

- Registration screen (first launch)
- Display name input
- Identity verification (safety number comparison)
- Key backup warning (if keys are lost, access is lost)

### 5.5 Sync status

- Persistent notification when syncing
- Notification shows: document name, pending count, last sync time
- Tap notification to open document

## 6. Background sync

### 6.1 Foreground service

```kotlin
class SyncForegroundService : Service() {
    // Runs as a foreground service with a persistent notification
    // Maintains WebSocket connection to sidecar
    // Syncs pending outbound on reconnect
    // Shows sync status in notification
}
```

### 6.2 WorkManager for periodic sync

```kotlin
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        // Connect to sidecar
        // Flush pending outbound
        // Receive pending inbound
        // Disconnect
        return Result.success()
    }
}
```

### 6.3 Push notifications

For real-time collaboration, the app needs push notifications when a
remote peer sends an update:

- **Option A:** Sidecar sends FCM push when it receives a message for the app
- **Option B:** Signal's built-in push (if using direct Signal integration)
- **Option C:** Polling (least efficient, but simplest)

## 7. Data storage

### 7.1 Room database

```kotlin
@Entity(tableName = "documents")
data class DocumentEntity(
    @PrimaryKey val documentId: String,
    val snapshot: ByteArray,  // Automerge save()
    val updatedAt: Long,
    val title: String?,
    val archived: Boolean
)

@Entity(tableName = "outbound")
data class OutboundEntity(
    @PrimaryKey val id: String,
    val documentId: String,
    val payload: ByteArray,  // encoded ProtocolEnvelope
    val createdAt: Long,
    val state: String,  // "pending" | "attempted"
    val attempts: Int
)

@Entity(tableName = "access_control")
data class AccessControlEntity(
    @PrimaryKey val documentId: String,
    val selfRole: String,
    val participants: String,  // JSON
    val archived: Boolean,
    val deleted: Boolean,
    val revision: Int
)
```

### 7.2 Encrypted storage

For production, the database should be encrypted:

```kotlin
val db = Room.databaseBuilder(context, E2ColDatabase::class.java, "e2e-col")
    .openHelperFactory(SupportFactory(SQLiteDatabase.getBytes(password)))
    .build()
```

## 8. Build configuration

### 8.1 Dependencies

```kotlin
dependencies {
    // e2e-col SDK (compiled from TypeScript via Kotlin/JS or as a native library)
    implementation(project(":packages:client"))
    implementation(project(":packages:protocol"))
    implementation(project(":packages:identity"))
    implementation(project(":packages:transport"))
    implementation(project(":packages:storage"))

    // Android
    implementation("androidx.room:room-runtime:2.6.0")
    implementation("androidx.work:work-runtime:2.9.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // CRDT (if using native Automerge)
    implementation("org.automerge:automerge:0.x.x")
}
```

### 8.2 SDK integration strategy

**Option A: Kotlin/JS** — Compile the TypeScript packages to JS and run via
Kotlin/JS interop. Fastest to implement, largest APK.

**Option B: Native Kotlin** — Rewrite the core packages in Kotlin. Smallest
APK, most effort.

**Option C: Shared library** — Compile core/protocol as a native shared
library (via Kotlin Native or Rust). Medium effort, medium APK size.

**Recommended:** Start with Kotlin/JS (Option A) for prototyping, then
evaluate native (Option B or C) for production.

## 9. Security considerations

### 9.1 Key storage

- Identity private keys MUST be stored in Android Keystore
- Session tokens MUST NOT be logged or stored in plaintext
- Database SHOULD be encrypted (SQLCipher or Room encryption)

### 9.2 Network

- Sidecar communication MUST be localhost only (127.0.0.1)
- No plaintext Signal credentials over the network
- TLS required for identity server communication

### 9.3 Permissions

- `INTERNET` — for identity server and sidecar communication
- `FOREGROUND_SERVICE` — for background sync
- `CAMERA` — for QR code scanning (optional)
- `READ_CONTACTS` — for contact-based discovery (optional)

## 10. Milestones

### Milestone 1: Sidecar proxy prototype

- Android app connects to a running sidecar via WebSocket
- Can register identity, create document, edit text
- Basic sync (auto, no manual mode)
- Duration: 2-3 weeks

### Milestone 2: Standalone sidecar

- Sidecar runs as an Android foreground service
- signal-cli runs as a child process
- Full sync with auto/manual modes
- Duration: 2-3 weeks

### Milestone 3: Document sharing

- QR code / deep link for document invitation
- Multi-document support
- Access control UI
- Duration: 2 weeks

### Milestone 4: Production hardening

- Encrypted storage
- Background sync with WorkManager
- Push notifications
- Key backup warning
- Duration: 3-4 weeks

### Milestone 5: Signal integration (if needed)

- Direct Signal ContentProvider integration
- Or: direct Signal protocol implementation
- Duration: 4-8 weeks (high uncertainty)
