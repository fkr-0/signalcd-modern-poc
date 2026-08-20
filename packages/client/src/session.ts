import { CollaborativeDocument, type TextEdit } from '@e2e-col/core'
import {
  type ArchivePayload,
  archivePayloadSigningBytes,
  createEnvelope,
  type DeletePayload,
  type DocumentAccessState,
  type DocumentParticipant,
  type DocumentRole,
  decodeArchivePayload,
  decodeDeletePayload,
  decodeEnvelope,
  decodeMembershipPayload,
  deletePayloadSigningBytes,
  type EnvelopeKind,
  encodeArchivePayload,
  encodeDeletePayload,
  encodeEnvelope,
  encodeMembershipPayload,
  type MembershipPayload,
  membershipPayloadSigningBytes,
  type ProtocolEnvelope
} from '@e2e-col/protocol'
import {
  cloneAccessState,
  type DocumentMetadata,
  type DurableCollaborativeStorage,
  type OutboundRecord,
  type StoredDocument
} from '@e2e-col/storage'
import type { ObservableCollaborativeTransport } from '@e2e-col/transport'
import type {
  ClientError,
  ClientIdentityAdapter,
  DocumentSessionCommands,
  DocumentSessionEvent,
  DocumentView,
  SessionStatus,
  SyncMode
} from './types'

interface DocumentSessionOptions {
  readonly documentId: string
  readonly senderId: string
  readonly transport: ObservableCollaborativeTransport
  readonly storage: DurableCollaborativeStorage
  readonly identity?: ClientIdentityAdapter
  readonly now: () => number
  readonly createMessageId: () => string
  readonly replayAttemptedOnReconnect: boolean
  readonly publishSnapshotOnRecoverySignal: boolean
  readonly snapshotThresholdOutboundEntries?: number
  readonly onClosed: () => void
}

export class DocumentSession implements DocumentSessionCommands {
  readonly documentId: string
  private document = new CollaborativeDocument()
  private access: DocumentAccessState
  private metadata: DocumentMetadata | undefined
  private readonly listeners = new Set<(event: DocumentSessionEvent) => void>()
  private readonly unsubscribers: Array<() => void> = []
  private sequence = 0
  private syncMode: SyncMode = 'auto'
  private opened = false
  private closed = false
  private inbound = Promise.resolve()
  private inboundReady = false
  private readonly bufferedInbound: Uint8Array[] = []
  private replayInFlight = false
  private recoveryInFlight = false
  private status: SessionStatus

  constructor(private readonly options: DocumentSessionOptions) {
    this.documentId = options.documentId
    this.access = selfAdminAccess(options.senderId)
    this.status = {
      phase: 'opening',
      transport: options.transport.getState(),
      pendingOutbound: 0,
      recoveryRequired: false
    }
  }

  private canPublishSnapshot(): boolean {
    const self = this.activeParticipant(this.options.senderId)
    return Boolean(self && self.role !== 'reader' && !this.access.archived && !this.access.deleted)
  }

  private scheduleRecoveryCheckpoint(): void {
    if (this.recoveryInFlight || this.closed || !this.canPublishSnapshot()) return
    this.recoveryInFlight = true
    void this.createCheckpoint(true)
      .then(() => {
        if (!this.closed && this.options.transport.getState() === 'online')
          this.setStatus({ phase: 'ready', recoveryRequired: false })
      })
      .catch((cause: unknown) => {
        this.reportError(
          'recovery-failed',
          'Document checkpoint recovery could not be completed',
          true,
          cause
        )
      })
      .finally(() => {
        this.recoveryInFlight = false
      })
  }

  private async maybeCheckpoint(): Promise<void> {
    const threshold = this.options.snapshotThresholdOutboundEntries
    if (threshold === undefined || this.closed) return
    const records = await this.options.storage.listOutbound(this.documentId)
    const crdtHistory = records.filter(
      (record) => record.kind === 'automerge-change' || record.kind === 'snapshot'
    )
    if (crdtHistory.length < threshold) return
    await this.createCheckpoint(this.syncMode === 'auto')
  }

  private async createCheckpoint(sendNow: boolean): Promise<void> {
    const recipients = this.activeParticipants()
    if (!recipients.some((participant) => participant.participantId !== this.options.senderId)) {
      await this.persistDocument()
      return
    }

    // Capture the history before the checkpoint. Only CRDT changes/snapshots
    // are semantically covered by the new snapshot. Membership/lifecycle
    // records remain replayable because document bytes do not encode ACL state.
    const prior = await this.options.storage.listOutbound(this.documentId)
    const safeRecordIds = prior
      .filter((record) => record.kind === 'automerge-change' || record.kind === 'snapshot')
      .map((record) => record.id)
    const now = this.options.now()
    const snapshot = await this.createOutbound('snapshot', this.document.save(), recipients)
    await this.options.storage.commitLocalChange({
      document: this.storedDocument(this.document, now),
      outbound: [snapshot]
    })
    this.status = { ...this.status, lastPersistedAt: now }
    if (safeRecordIds.length > 0) {
      await this.options.storage.compactOutbound(this.documentId, {
        safeRecordIds,
        retainAtLeast: 1
      })
    }
    await this.refreshPending()

    if (sendNow && this.options.transport.getState() === 'online') {
      await this.sendRecords([snapshot])
      // Publishing a durably retained full checkpoint is sufficient to clear
      // this sender's recovery obligation. The receiver independently clears
      // recovery only after it accepts and merges the snapshot.
      this.setStatus({ phase: 'ready', recoveryRequired: false })
    } else if (this.options.transport.getState() !== 'online') {
      this.setStatus({ phase: 'offline', recoveryRequired: true })
    }
  }

  async open(): Promise<void> {
    if (this.opened) return
    this.opened = true
    const stored = await this.options.storage.loadDocument(this.documentId)
    if (stored) {
      this.document = new CollaborativeDocument(stored.snapshot)
      this.metadata = stored.metadata
    }
    const storedAccess = await this.options.storage.loadAccessControl(this.documentId)
    if (storedAccess) this.access = storedAccess
    // Initialize durable dedup state before subscribing/connecting so a
    // transport that delivers immediately on connect cannot race restart
    // recovery. Expired IDs are removed according to the storage TTL policy.
    await this.options.storage.pruneSeenMessages(this.options.now())

    this.unsubscribers.push(
      this.options.transport.subscribe((wire) => {
        if (!this.inboundReady) {
          this.bufferedInbound.push(new Uint8Array(wire))
          return
        }
        this.enqueueInbound(wire)
      }),
      this.options.transport.subscribeState((event) => this.handleTransportState(event.current)),
      this.options.transport.subscribeRecovery(() => {
        this.setStatus({ phase: 'recovering', recoveryRequired: true })
        if (this.options.publishSnapshotOnRecoverySignal) this.scheduleRecoveryCheckpoint()
      })
    )

    try {
      await this.options.transport.connect(this.documentId)
      await this.bootstrapAccess()
      this.inboundReady = true
      for (const wire of this.bufferedInbound.splice(0)) this.enqueueInbound(wire)
      if (!stored) await this.persistDocument()
      await this.refreshPending()
      this.setStatus({ phase: 'ready', transport: this.options.transport.getState() })
      if (this.options.replayAttemptedOnReconnect) void this.replayOutbound()
    } catch (cause) {
      this.inboundReady = false
      this.bufferedInbound.length = 0
      this.reportError(
        'transport-unavailable',
        'Document transport could not be opened',
        true,
        cause
      )
      throw cause
    }
  }

  getView(): DocumentView {
    return { text: this.document.getText(), heads: [...this.document.getHeads()] }
  }

  getStatus(): SessionStatus {
    return { ...this.status }
  }

  getAccessState(): DocumentAccessState {
    return cloneAccessState(this.access)
  }

  getSyncMode(): SyncMode {
    return this.syncMode
  }

  setSyncMode(mode: SyncMode): void {
    this.assertActive()
    this.syncMode = mode
    if (mode === 'auto' && this.options.transport.getState() === 'online') void this.flush()
  }

  subscribe(listener: (event: DocumentSessionEvent) => void): () => void {
    this.listeners.add(listener)
    listener({ type: 'document', view: this.getView() })
    listener({ type: 'status', status: this.getStatus() })
    listener({ type: 'access', access: this.getAccessState() })
    return () => this.listeners.delete(listener)
  }

  async editText(nextText: string): Promise<void> {
    await this.applyLocalEdit((document) => document.editText(nextText))
  }

  async spliceText(edit: TextEdit): Promise<void> {
    await this.applyLocalEdit((document) => document.spliceText(edit))
  }

  async publishSnapshot(): Promise<void> {
    this.assertWritable()
    await this.createCheckpoint(true)
  }

  async flush(): Promise<void> {
    this.assertActive()
    if (this.options.transport.getState() !== 'online') {
      this.setStatus({ phase: 'offline', transport: this.options.transport.getState() })
      throw operationError('transport-unavailable', 'Document transport is offline', true)
    }
    const records = (await this.options.storage.listOutbound(this.documentId)).filter(
      (record) => record.state !== 'attempted'
    )
    if (records.length === 0) {
      await this.refreshPending()
      this.setStatus({ phase: 'ready' })
      return
    }
    await this.sendRecords(records)
  }

  async inviteParticipant(phoneNumber: string, role: DocumentRole): Promise<void> {
    this.assertAdmin()
    const identity = this.requireIdentity()
    const resolved = await identity.resolveParticipant(phoneNumber, role)
    if (this.activeParticipant(resolved.participantId))
      throw operationError('authorization-denied', 'Participant is already active', false)
    const unsigned = {
      action: 'invite' as const,
      targetUserId: resolved.participantId,
      role,
      actorUserId: this.options.senderId,
      timestamp: this.options.now()
    }
    const payload: MembershipPayload = {
      ...unsigned,
      signature: await identity.signControl(membershipPayloadSigningBytes(unsigned))
    }
    const nextAccess = this.applyMembership(this.access, payload, resolved.displayName)
    const membership = await this.createOutbound(
      'membership',
      encodeMembershipPayload(payload),
      nextAccess.participants
    )
    const snapshot = await this.createOutbound(
      'snapshot',
      this.document.save(),
      nextAccess.participants
    )
    const outbound = [membership, snapshot]
    await this.options.storage.commitAccessChange({
      documentId: this.documentId,
      access: nextAccess,
      outbound
    })
    this.access = nextAccess
    this.emit({ type: 'access', access: this.getAccessState() })
    await this.afterLocalOutbound(outbound)
  }

  async setParticipantRole(participantId: string, role: DocumentRole): Promise<void> {
    this.assertAdmin()
    if (!this.activeParticipant(participantId))
      throw operationError('authorization-denied', 'Participant is not active', false)
    const unsigned = {
      action: 'role_change' as const,
      targetUserId: participantId,
      role,
      actorUserId: this.options.senderId,
      timestamp: this.options.now()
    }
    await this.commitMembership(unsigned)
  }

  async removeParticipant(participantId: string): Promise<void> {
    this.assertAdmin()
    if (participantId === this.options.senderId)
      throw operationError(
        'authorization-denied',
        'An admin cannot remove the active local identity',
        false
      )
    if (!this.activeParticipant(participantId))
      throw operationError('authorization-denied', 'Participant is not active', false)
    const unsigned = {
      action: 'remove' as const,
      targetUserId: participantId,
      role: null,
      actorUserId: this.options.senderId,
      timestamp: this.options.now()
    }
    await this.commitMembership(unsigned, this.access.participants)
  }

  async archive(): Promise<void> {
    await this.commitArchive('archive')
  }

  async unarchive(): Promise<void> {
    await this.commitArchive('unarchive')
  }

  async deleteForGroup(): Promise<void> {
    this.assertAdmin()
    const identity = this.requireIdentity()
    const unsigned = {
      action: 'delete' as const,
      actorUserId: this.options.senderId,
      timestamp: this.options.now()
    }
    const payload: DeletePayload = {
      ...unsigned,
      signature: await identity.signControl(deletePayloadSigningBytes(unsigned))
    }
    const nextAccess = { ...this.access, deleted: true, revision: this.access.revision + 1 }
    await this.commitControl(
      'delete',
      encodeDeletePayload(payload),
      nextAccess,
      this.access.participants
    )
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe()
    this.inboundReady = false
    this.bufferedInbound.length = 0
    await this.inbound.catch(() => undefined)
    await this.persistDocument().catch(() => undefined)
    await this.options.transport.close()
    this.status = { ...this.status, phase: 'closed', transport: 'closed' }
    this.emit({ type: 'status', status: this.getStatus() })
    this.listeners.clear()
    this.options.onClosed()
  }

  private async applyLocalEdit(
    mutate: (document: CollaborativeDocument) => readonly Uint8Array[]
  ): Promise<void> {
    this.assertWritable()
    const working = this.document.clone()
    const changes = mutate(working)
    if (changes.length === 0) return
    const now = this.options.now()
    const recipients = this.activeParticipants()
    const hasRemoteRecipients = recipients.some(
      (participant) => participant.participantId !== this.options.senderId
    )
    const outbound = hasRemoteRecipients
      ? await Promise.all(
          changes.map((change) => this.createOutbound('automerge-change', change, recipients))
        )
      : []
    await this.options.storage.commitLocalChange({
      document: this.storedDocument(working, now),
      outbound
    })
    this.document = working
    this.status = { ...this.status, lastPersistedAt: now }
    this.emit({ type: 'document', view: this.getView() })
    await this.refreshPending()
    await this.afterLocalOutbound(outbound)
    await this.maybeCheckpoint()
  }

  private async afterLocalOutbound(records: readonly OutboundRecord[]): Promise<void> {
    if (records.length === 0) return
    if (this.syncMode === 'manual' || this.options.transport.getState() !== 'online') {
      if (this.options.transport.getState() !== 'online') this.setStatus({ phase: 'offline' })
      return
    }
    try {
      await this.sendRecords(records)
    } catch {
      return
    }
  }

  private async sendRecords(records: readonly OutboundRecord[]): Promise<void> {
    this.setStatus({ phase: 'syncing' })
    const sent: string[] = []
    try {
      for (const record of records) {
        await this.options.transport.send(record.payload)
        sent.push(record.id)
        this.status = { ...this.status, lastSentAt: this.options.now() }
      }
      if (sent.length > 0) await this.options.storage.markOutboundAttempt(sent, this.options.now())
      await this.refreshPending()
      // A successful ordinary send is not proof that a previously reported
      // loss has been repaired. Recovery is cleared only after this replica
      // publishes its durable checkpoint or after an accepted remote snapshot
      // is merged.
      this.setStatus({ phase: this.status.recoveryRequired ? 'recovering' : 'ready' })
    } catch (cause) {
      if (sent.length > 0) await this.options.storage.markOutboundAttempt(sent, this.options.now())
      await this.refreshPending()
      this.reportError(
        'transport-unavailable',
        'Pending collaboration updates could not be sent',
        true,
        cause
      )
      throw cause
    }
  }

  private async replayOutbound(): Promise<void> {
    if (
      this.replayInFlight ||
      !this.inboundReady ||
      this.closed ||
      this.options.transport.getState() !== 'online'
    )
      return
    this.replayInFlight = true
    try {
      const records = await this.options.storage.listOutbound(this.documentId)
      if (records.length > 0) await this.sendRecords(records)
    } catch {
      return
    } finally {
      this.replayInFlight = false
    }
  }

  private enqueueInbound(wire: Uint8Array): void {
    this.inbound = this.inbound
      .then(() => this.receiveWire(wire))
      .catch((cause: unknown) => {
        this.reportError(
          'protocol-invalid',
          'Inbound collaboration frame was rejected',
          true,
          cause
        )
      })
  }

  private async receiveWire(wire: Uint8Array): Promise<void> {
    if (this.closed) return
    const envelope = this.options.identity?.decodeEnvelope
      ? await this.options.identity.decodeEnvelope(
          wire,
          this.envelopeContext(this.access.participants)
        )
      : decodeEnvelope(wire)
    if (envelope.documentId !== this.documentId) return
    if (await this.options.storage.hasSeen(this.documentId, envelope.messageId, this.options.now()))
      return

    if (envelope.kind === 'automerge-change') {
      this.assertSenderCanWrite(envelope.senderId)
      if (this.access.archived || this.access.deleted)
        throw operationError('authorization-denied', 'Document is read-only', false)
      const working = this.document.clone()
      const changed = working.applyChanges([envelope.payload])
      const now = this.options.now()
      await this.options.storage.persistRemoteState({
        document: this.storedDocument(changed ? working : this.document, now),
        seen: [{ documentId: this.documentId, messageId: envelope.messageId, seenAt: now }]
      })
      if (changed) {
        this.document = working
        this.emit({ type: 'document', view: this.getView() })
      }
      this.status = { ...this.status, lastReceivedAt: now, lastPersistedAt: now }
      this.emit({ type: 'status', status: this.getStatus() })
      return
    }

    if (envelope.kind === 'snapshot') {
      this.assertSenderCanWrite(envelope.senderId)
      if (this.access.archived || this.access.deleted)
        throw operationError('authorization-denied', 'Document is read-only', false)
      const working = this.document.clone()
      working.mergeSnapshot(envelope.payload)
      const now = this.options.now()
      await this.options.storage.persistRemoteState({
        document: this.storedDocument(working, now),
        seen: [{ documentId: this.documentId, messageId: envelope.messageId, seenAt: now }]
      })
      this.document = working
      this.status = {
        ...this.status,
        phase: this.options.transport.getState() === 'online' ? 'ready' : this.status.phase,
        recoveryRequired: false,
        lastReceivedAt: now,
        lastPersistedAt: now
      }
      this.emit({ type: 'document', view: this.getView() })
      this.emit({ type: 'status', status: this.getStatus() })
      return
    }

    if (envelope.kind === 'membership') {
      const payload = decodeMembershipPayload(envelope.payload)
      await this.verifyControlEnvelope(
        envelope,
        payload.actorUserId,
        membershipPayloadSigningBytes(payload),
        payload.signature
      )
      const next = this.applyMembership(this.access, payload)
      await this.persistInboundAccess(envelope, next)
      return
    }
    if (envelope.kind === 'archive') {
      const payload = decodeArchivePayload(envelope.payload)
      await this.verifyControlEnvelope(
        envelope,
        payload.actorUserId,
        archivePayloadSigningBytes(payload),
        payload.signature
      )
      const next = {
        ...this.access,
        archived: payload.action === 'archive',
        revision: this.access.revision + 1
      }
      await this.persistInboundAccess(envelope, next)
      return
    }
    if (envelope.kind === 'delete') {
      const payload = decodeDeletePayload(envelope.payload)
      await this.verifyControlEnvelope(
        envelope,
        payload.actorUserId,
        deletePayloadSigningBytes(payload),
        payload.signature
      )
      const next = { ...this.access, deleted: true, revision: this.access.revision + 1 }
      await this.persistInboundAccess(envelope, next)
    }
  }

  private async persistInboundAccess(
    envelope: ProtocolEnvelope,
    access: DocumentAccessState
  ): Promise<void> {
    const now = this.options.now()
    await this.options.storage.commitAccessChange({
      documentId: this.documentId,
      access,
      outbound: [],
      seen: [{ documentId: this.documentId, messageId: envelope.messageId, seenAt: now }]
    })
    this.access = access
    this.status = { ...this.status, lastReceivedAt: now, lastPersistedAt: now }
    this.emit({ type: 'access', access: this.getAccessState() })
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private async verifyControlEnvelope(
    envelope: ProtocolEnvelope,
    actorUserId: string,
    signingBytes: Uint8Array,
    signature: Uint8Array
  ): Promise<void> {
    if (actorUserId !== envelope.senderId)
      throw operationError(
        'authorization-denied',
        'Control actor does not match envelope sender',
        false
      )
    const identity = this.requireIdentity()
    if (!(await identity.verifyControl(actorUserId, signingBytes, signature)))
      throw operationError('authorization-denied', 'Control signature is invalid', false)
    const actor = this.activeParticipant(actorUserId)
    if (actor?.role !== 'admin')
      throw operationError(
        'authorization-denied',
        'Only an active admin may mutate access state',
        false
      )
  }

  private async commitMembership(
    unsigned: Omit<MembershipPayload, 'signature'>,
    recipients?: readonly DocumentParticipant[]
  ): Promise<void> {
    const identity = this.requireIdentity()
    const payload: MembershipPayload = {
      ...unsigned,
      signature: await identity.signControl(membershipPayloadSigningBytes(unsigned))
    }
    const next = this.applyMembership(this.access, payload)
    await this.commitControl(
      'membership',
      encodeMembershipPayload(payload),
      next,
      recipients ?? next.participants
    )
  }

  private async commitArchive(action: ArchivePayload['action']): Promise<void> {
    this.assertAdmin()
    const identity = this.requireIdentity()
    const unsigned = {
      action,
      actorUserId: this.options.senderId,
      timestamp: this.options.now()
    }
    const payload: ArchivePayload = {
      ...unsigned,
      signature: await identity.signControl(archivePayloadSigningBytes(unsigned))
    }
    const next = {
      ...this.access,
      archived: action === 'archive',
      revision: this.access.revision + 1
    }
    await this.commitControl(
      'archive',
      encodeArchivePayload(payload),
      next,
      this.access.participants
    )
  }

  private async commitControl(
    kind: 'membership' | 'archive' | 'delete',
    payload: Uint8Array,
    nextAccess: DocumentAccessState,
    recipients: readonly DocumentParticipant[]
  ): Promise<void> {
    const outbound = [await this.createOutbound(kind, payload, recipients)]
    await this.options.storage.commitAccessChange({
      documentId: this.documentId,
      access: nextAccess,
      outbound
    })
    this.access = nextAccess
    this.emit({ type: 'access', access: this.getAccessState() })
    await this.refreshPending()
    await this.afterLocalOutbound(outbound)
  }

  private applyMembership(
    current: DocumentAccessState,
    payload: MembershipPayload,
    displayName?: string
  ): DocumentAccessState {
    const participants = current.participants.map((participant) => ({ ...participant }))
    const index = participants.findIndex(
      (participant) => participant.participantId === payload.targetUserId
    )
    if (payload.action === 'remove') {
      if (index < 0)
        throw operationError('authorization-denied', 'Removed participant is unknown', false)
      const existing = participants[index]!
      participants[index] = { ...existing, active: false }
    } else {
      if (payload.role === null)
        throw operationError('protocol-invalid', 'Membership role is missing', false)
      if (payload.action === 'role_change' && index < 0)
        throw operationError('authorization-denied', 'Role-change participant is unknown', false)
      const existing = index >= 0 ? participants[index] : undefined
      const updated: DocumentParticipant = {
        participantId: payload.targetUserId,
        role: payload.role,
        active: true,
        ...(displayName !== undefined
          ? { displayName }
          : existing?.displayName !== undefined
            ? { displayName: existing.displayName }
            : {})
      }
      if (index >= 0) participants[index] = updated
      else participants.push(updated)
    }
    assertHasActiveAdmin(participants)
    const self = participants.find(
      (participant) => participant.participantId === this.options.senderId
    )
    return {
      ...current,
      selfRole: self?.role ?? current.selfRole,
      participants,
      revision: current.revision + 1
    }
  }

  private async createOutbound(
    kind: Exclude<EnvelopeKind, 'chunk'>,
    payload: Uint8Array,
    participants: readonly DocumentParticipant[]
  ): Promise<OutboundRecord> {
    this.sequence += 1
    const now = this.options.now()
    const envelope = createEnvelope({
      documentId: this.documentId,
      messageId: this.options.createMessageId(),
      senderId: this.options.senderId,
      kind,
      createdAt: now,
      sequence: this.sequence,
      payload
    })
    const wire = this.options.identity?.encodeEnvelope
      ? await this.options.identity.encodeEnvelope(envelope, this.envelopeContext(participants))
      : encodeEnvelope(envelope)
    return {
      id: envelope.messageId,
      documentId: this.documentId,
      payload: wire,
      createdAt: now,
      kind,
      state: 'pending'
    }
  }

  private async bootstrapAccess(): Promise<void> {
    const bootstrap = this.options.identity?.bootstrapAccess
    if (!bootstrap) return
    const participants = await bootstrap({
      documentId: this.documentId,
      transport: this.options.transport
    })
    if (participants.length === 0) return
    const merged = new Map(
      this.access.participants.map((participant) => [participant.participantId, participant])
    )
    for (const participant of participants)
      merged.set(participant.participantId, { ...participant })
    assertHasActiveAdmin([...merged.values()])
    const self = merged.get(this.options.senderId)
    if (!self?.active)
      throw operationError(
        'authorization-denied',
        'Local identity is not an active document participant',
        false
      )
    this.access = {
      ...this.access,
      selfRole: self.role,
      participants: [...merged.values()]
    }
    await this.options.storage.saveAccessControl(this.documentId, this.access)
    this.emit({ type: 'access', access: this.getAccessState() })
  }

  private handleTransportState(state: SessionStatus['transport']): void {
    if (this.closed) return
    if (state === 'offline' || state === 'disconnected')
      this.setStatus({ phase: 'offline', transport: state })
    else if (state === 'connecting') this.setStatus({ phase: 'opening', transport: state })
    else if (state === 'online') {
      this.setStatus({
        phase: !this.inboundReady
          ? 'opening'
          : this.status.recoveryRequired
            ? 'recovering'
            : 'ready',
        transport: state
      })
      if (this.opened && this.inboundReady && this.options.replayAttemptedOnReconnect)
        void this.replayOutbound()
    }
  }

  private activeParticipants(): readonly DocumentParticipant[] {
    return this.access.participants.filter((participant) => participant.active)
  }

  private activeParticipant(participantId: string): DocumentParticipant | undefined {
    return this.access.participants.find(
      (participant) => participant.participantId === participantId && participant.active
    )
  }

  private assertSenderCanWrite(senderId: string): void {
    const sender = this.activeParticipant(senderId)
    if (!sender || sender.role === 'reader')
      throw operationError(
        'authorization-denied',
        `Sender ${senderId} is not allowed to edit`,
        false
      )
  }

  private assertWritable(): void {
    this.assertActive()
    const self = this.activeParticipant(this.options.senderId)
    if (!self || self.role === 'reader' || this.access.archived || this.access.deleted)
      throw operationError(
        'authorization-denied',
        'Document is read-only for the local identity',
        false
      )
  }

  private assertAdmin(): void {
    this.assertActive()
    const self = this.activeParticipant(this.options.senderId)
    if (self?.role !== 'admin' || this.access.deleted)
      throw operationError('authorization-denied', 'Document admin permission is required', false)
  }

  private assertActive(): void {
    if (this.closed || this.status.phase === 'closed')
      throw operationError('transport-closed', 'Document session is closed', false)
  }

  private requireIdentity(): ClientIdentityAdapter {
    if (!this.options.identity)
      throw operationError(
        'authorization-denied',
        'Authenticated identity adapter is required',
        false
      )
    return this.options.identity
  }

  private envelopeContext(participants: readonly DocumentParticipant[]) {
    return {
      documentId: this.documentId,
      transport: this.options.transport,
      participants
    }
  }

  private storedDocument(document: CollaborativeDocument, updatedAt: number): StoredDocument {
    return {
      documentId: this.documentId,
      snapshot: document.save(),
      updatedAt,
      schemaVersion: 1,
      ...(this.metadata === undefined ? {} : { metadata: this.metadata })
    }
  }

  private async persistDocument(): Promise<void> {
    const now = this.options.now()
    await this.options.storage.saveDocument(this.storedDocument(this.document, now))
    this.status = { ...this.status, lastPersistedAt: now }
  }

  private async refreshPending(): Promise<void> {
    const records = await this.options.storage.listOutbound(this.documentId)
    const pendingOutbound = records.filter((record) => record.state !== 'attempted').length
    this.status = { ...this.status, pendingOutbound }
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private setStatus(patch: Partial<SessionStatus>): void {
    this.status = { ...this.status, ...patch }
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private reportError(
    code: ClientError['code'],
    message: string,
    recoverable: boolean,
    cause?: unknown
  ): void {
    const error: ClientError = {
      code,
      message,
      recoverable,
      ...(cause === undefined ? {} : { cause })
    }
    this.status = {
      ...this.status,
      phase: recoverable
        ? this.options.transport.getState() === 'online'
          ? 'error'
          : 'offline'
        : 'error',
      error
    }
    this.emit({ type: 'error', error })
    this.emit({ type: 'status', status: this.getStatus() })
  }

  private emit(event: DocumentSessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function selfAdminAccess(senderId: string): DocumentAccessState {
  return {
    selfRole: 'admin',
    participants: [{ participantId: senderId, role: 'admin', active: true }],
    archived: false,
    deleted: false,
    revision: 0
  }
}

function assertHasActiveAdmin(participants: readonly DocumentParticipant[]): void {
  if (!participants.some((participant) => participant.active && participant.role === 'admin'))
    throw operationError(
      'authorization-denied',
      'Document must retain at least one active admin',
      false
    )
}

function operationError(
  code: ClientError['code'],
  message: string,
  recoverable: boolean
): Error & ClientError {
  return Object.assign(new Error(message), { code, recoverable })
}
