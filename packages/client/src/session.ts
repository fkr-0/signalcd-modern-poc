import { CollaborativeDocument, type TextEdit } from '@e2e-col/core'
import {
  type ArchivePayload,
  type AuthorizationRootPayload,
  archivePayloadSigningBytes,
  authorizationControlCommitment,
  authorizationGenesisPredecessor,
  authorizationRootCommitment,
  authorizationRootSigningBytes,
  authorizationStateCommitment,
  createEnvelope,
  type DeletePayload,
  type DocumentAccessState,
  type DocumentParticipant,
  type DocumentRole,
  decodeArchivePayload,
  decodeAuthorizationCommitment,
  decodeAuthorizationRootPayload,
  decodeDeletePayload,
  decodeEnvelope,
  decodeForkResolutionPayload,
  decodeMembershipPayload,
  deletePayloadSigningBytes,
  type EnvelopeKind,
  encodeArchivePayload,
  encodeAuthorizationCommitment,
  encodeAuthorizationRootPayload,
  encodeDeletePayload,
  encodeEnvelope,
  encodeForkResolutionPayload,
  encodeMembershipPayload,
  type ForkResolutionApproval,
  type ForkResolutionPayload,
  forkResolutionCommitment,
  forkResolutionSigningBytes,
  type MembershipPayload,
  membershipPayloadSigningBytes
} from '@e2e-col/protocol'
import {
  type AuthorizationControlKind,
  cloneAccessState,
  type DocumentMetadata,
  type DurableCollaborativeStorage,
  type OutboundRecord,
  type PendingAuthorizationControl,
  type PendingAuthorizationResolution,
  type StoredAuthorizationControl,
  type StoredAuthorizationResolution,
  type StoredAuthorizationState,
  type StoredDocument
} from '@e2e-col/storage'
import type { ObservableCollaborativeTransport } from '@e2e-col/transport'
import type {
  AuthorizationEvidencePublish,
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
  /** True only for an explicit local CollaborativeClient.createDocument() call. */
  readonly allowAuthorizationRootCreation: boolean
  readonly replayAttemptedOnReconnect: boolean
  readonly publishSnapshotOnRecoverySignal: boolean
  readonly snapshotThresholdOutboundEntries?: number
  readonly onClosed: () => void
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

export class DocumentSession implements DocumentSessionCommands {
  readonly documentId: string
  private document = new CollaborativeDocument()
  private access: DocumentAccessState
  private authorization: StoredAuthorizationState | undefined
  private accessWasStored = false
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

  private async requireIdentityKeyCommitment(participantId: string): Promise<Uint8Array> {
    const identityKeyCommitment = this.requireIdentity().identityKeyCommitment
    if (!identityKeyCommitment)
      throw operationError(
        'authorization-denied',
        'Authenticated authorization requires identity-key commitments',
        false
      )
    const value = await identityKeyCommitment(participantId)
    if (!(value instanceof Uint8Array) || value.byteLength !== 32)
      throw operationError(
        'authorization-denied',
        `Identity-key commitment for ${participantId} is malformed`,
        false
      )
    return value
  }

  private async verifyBoundControlIdentity(
    parent: DocumentAccessState,
    kind: AuthorizationControlKind,
    payload: MembershipPayload | ArchivePayload | DeletePayload
  ): Promise<void> {
    if (this.authorization?.anchorKind !== 'verified-root') return
    const actor = activeParticipantIn(parent, payload.actorUserId)
    const expectedActorKey = actor?.identityKeyCommitment
    if (!expectedActorKey)
      throw operationError(
        'authorization-denied',
        `Verified authorization state has no identity-key binding for ${payload.actorUserId}`,
        false
      )
    const actualActorKey = encodeAuthorizationCommitment(
      await this.requireIdentityKeyCommitment(payload.actorUserId)
    )
    if (actualActorKey !== expectedActorKey)
      throw operationError(
        'authorization-denied',
        `Identity-key binding mismatch for control actor ${payload.actorUserId}`,
        false
      )
    if (kind !== 'membership') return
    const membership = payload as MembershipPayload
    if (membership.action !== 'invite') return
    if (!membership.targetIdentityKeyCommitment)
      throw operationError(
        'authorization-denied',
        'Verified authorization invites must bind the target identity key',
        false
      )
    const targetKey = encodeAuthorizationCommitment(
      await this.requireIdentityKeyCommitment(membership.targetUserId)
    )
    if (targetKey !== encodeAuthorizationCommitment(membership.targetIdentityKeyCommitment))
      throw operationError(
        'authorization-denied',
        `Identity-key binding mismatch for invited participant ${membership.targetUserId}`,
        false
      )
    const existing = parent.participants.find(
      (participant) => participant.participantId === membership.targetUserId
    )
    if (
      existing?.identityKeyCommitment !== undefined &&
      existing.identityKeyCommitment !== targetKey
    )
      throw operationError(
        'authorization-denied',
        `Invite cannot rebind the established identity key for ${membership.targetUserId}`,
        false
      )
  }

  private authorizationConflicted(): boolean {
    return (
      this.authorization?.conflict !== undefined || this.access.authorizationStatus === 'conflict'
    )
  }

  async approveForkResolution(chosenControlId: string): Promise<ForkResolutionApproval> {
    this.assertActive()
    const proposal = await this.buildForkResolutionProposal(chosenControlId)
    const parent = this.authorization
      ? authorizationAccessAt(
          this.authorization,
          encodeAuthorizationCommitment(proposal.commonPredecessor)
        )
      : undefined
    if (!parent)
      throw operationError('authorization-denied', 'Fork predecessor is unavailable', false)
    const admins = preForkAdminIds(parent)
    if (admins.length < 2)
      throw operationError(
        'authorization-denied',
        'Fork resolution requires at least two independent pre-fork admins',
        false
      )
    if (!admins.includes(this.options.senderId))
      throw operationError(
        'authorization-denied',
        'Local identity was not a pre-fork active admin',
        false
      )
    return {
      actorUserId: this.options.senderId,
      signature: await this.requireIdentity().signControl(forkResolutionSigningBytes(proposal))
    }
  }

  async resolveFork(
    chosenControlId: string,
    approvals: readonly ForkResolutionApproval[]
  ): Promise<void> {
    this.assertActive()
    const proposal = await this.buildForkResolutionProposal(chosenControlId)
    const payload: ForkResolutionPayload = { ...proposal, approvals }
    const bytes = encodeForkResolutionPayload(payload)
    const parent = this.authorization
      ? authorizationAccessAt(
          this.authorization,
          encodeAuthorizationCommitment(proposal.commonPredecessor)
        )
      : undefined
    if (!parent)
      throw operationError('authorization-denied', 'Fork predecessor is unavailable', false)
    const outbound = await this.createOutbound(
      'authorization-resolution',
      bytes,
      parent.participants
    )
    await this.acceptForkResolution(bytes, this.options.senderId, outbound.id, outbound.createdAt, [
      outbound
    ])
    await this.publishAuthorizationEvidence()
    await this.refreshPending()
    await this.afterLocalOutbound([outbound])
  }

  private canPublishSnapshot(): boolean {
    const self = this.activeParticipant(this.options.senderId)
    return Boolean(
      self &&
        self.role !== 'reader' &&
        !this.access.archived &&
        !this.access.deleted &&
        !this.authorizationConflicted()
    )
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
    if (storedAccess) {
      this.access = storedAccess
      this.accessWasStored = true
    }
    this.authorization = await this.options.storage.loadAuthorizationState(this.documentId)
    if (this.authorization) {
      if (this.authorization.anchorKind === undefined) {
        const anchorKind =
          this.authorization.anchorAccess.revision === 0 &&
          this.authorization.anchorHead ===
            encodeAuthorizationCommitment(authorizationGenesisPredecessor())
            ? ('legacy-zero-genesis' as const)
            : ('legacy-local-anchor' as const)
        this.authorization = { ...this.authorization, anchorKind }
        await this.options.storage.commitAccessChange({
          documentId: this.documentId,
          access: this.access,
          authorization: this.authorization,
          outbound: []
        })
      }
      this.access = withAuthorizationHead(
        this.access,
        this.authorization.head,
        this.authorization.conflict === undefined ? 'active' : 'conflict'
      )
    } else if (storedAccess) {
      // Legacy revision-0 state can join the v2 genesis chain; post-history
      // legacy state is pinned to a local semantic-state anchor. Legacy v1 wire
      // controls are rejected in either case rather than ambiguously upgraded.
      const anchor = encodeAuthorizationCommitment(
        this.access.revision === 0
          ? authorizationGenesisPredecessor()
          : await authorizationStateCommitment(this.documentId, this.access)
      )
      this.access = withAuthorizationHead(this.access, anchor, 'active')
      this.authorization = initialAuthorizationState(
        this.access,
        anchor,
        this.access.revision === 0 ? 'legacy-zero-genesis' : 'legacy-local-anchor'
      )
      await this.options.storage.commitAccessChange({
        documentId: this.documentId,
        access: this.access,
        authorization: this.authorization,
        outbound: []
      })
    } else {
      const genesis = encodeAuthorizationCommitment(authorizationGenesisPredecessor())
      this.access = withAuthorizationHead(this.access, genesis, 'active')
      this.authorization = initialAuthorizationState(this.access, genesis, 'legacy-zero-genesis')
    }
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
      this.options.transport.subscribeRecovery((event) => {
        // A PeerJS checkpoint request means another replica has a bounded
        // replay-history gap. This healthy replica should publish a full
        // snapshot without marking itself as recovering. Conversely, the
        // receiver-side replay-gap event must enter recovering but must not
        // publish its potentially incomplete local state as the repair source.
        if (event.reason === 'peerjs-checkpoint-request') {
          if (this.options.publishSnapshotOnRecoverySignal) this.scheduleRecoveryCheckpoint()
          return
        }
        this.setStatus({ phase: 'recovering', recoveryRequired: true })
        if (event.reason !== 'peerjs-replay-gap' && this.options.publishSnapshotOnRecoverySignal)
          this.scheduleRecoveryCheckpoint()
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
    return {
      ...this.status,
      ...(this.status.replay === undefined ? {} : { replay: { ...this.status.replay } })
    }
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
    const targetIdentityKeyCommitment =
      this.authorization?.anchorKind === 'verified-root'
        ? await this.requireIdentityKeyCommitment(resolved.participantId)
        : undefined
    const unsigned = {
      ...this.nextAuthorizationProof(),
      action: 'invite' as const,
      targetUserId: resolved.participantId,
      role,
      ...(targetIdentityKeyCommitment === undefined ? {} : { targetIdentityKeyCommitment }),
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
    const advanced = await this.advanceAuthorization(
      'membership',
      encodeMembershipPayload(payload),
      nextAccess,
      membership.id,
      membership.createdAt,
      this.options.senderId
    )
    await this.options.storage.commitAccessChange({
      documentId: this.documentId,
      access: advanced.access,
      authorization: advanced.authorization,
      outbound
    })
    this.access = advanced.access
    this.authorization = advanced.authorization
    this.emit({ type: 'access', access: this.getAccessState() })
    await this.publishAuthorizationEvidence()
    await this.afterLocalOutbound(outbound)
  }

  async setParticipantRole(participantId: string, role: DocumentRole): Promise<void> {
    this.assertAdmin()
    if (!this.activeParticipant(participantId))
      throw operationError('authorization-denied', 'Participant is not active', false)
    const unsigned = {
      ...this.nextAuthorizationProof(),
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
      ...this.nextAuthorizationProof(),
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
      ...this.nextAuthorizationProof(),
      action: 'delete' as const,
      actorUserId: this.options.senderId,
      timestamp: this.options.now()
    }
    const payload: DeletePayload = {
      ...unsigned,
      signature: await identity.signControl(deletePayloadSigningBytes(unsigned))
    }
    const nextAccess = { ...this.access, deleted: true, revision: payload.revision }
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

  /**
   * Refresh the session's local-only metadata cache after the client has
   * durably committed metadata. This intentionally emits no document/access
   * event and does not touch the transport or CRDT state.
   */
  applyDurableMetadata(metadata: DocumentMetadata | undefined, persistedAt: number): void {
    this.metadata = metadata === undefined ? undefined : { ...metadata }
    if (this.closed) return
    this.status = { ...this.status, lastPersistedAt: persistedAt }
    this.emit({ type: 'status', status: this.getStatus() })
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

  private async sendRecords(
    records: readonly OutboundRecord[],
    trackReplay = false
  ): Promise<void> {
    this.setStatus({
      phase: 'syncing',
      ...(trackReplay ? { replay: { total: records.length, completed: 0, active: true } } : {})
    })
    const sent: string[] = []
    try {
      for (const record of records) {
        await this.options.transport.send(record.payload)
        sent.push(record.id)
        this.status = {
          ...this.status,
          lastSentAt: this.options.now(),
          ...(trackReplay
            ? { replay: { total: records.length, completed: sent.length, active: true } }
            : {})
        }
        if (trackReplay) this.emit({ type: 'status', status: this.getStatus() })
      }
      if (sent.length > 0) await this.options.storage.markOutboundAttempt(sent, this.options.now())
      await this.refreshPending()
      // A successful ordinary send is not proof that a previously reported
      // loss has been repaired. Recovery is cleared only after this replica
      // publishes its durable checkpoint or after an accepted remote snapshot
      // is merged.
      this.setStatus({
        phase: this.status.recoveryRequired ? 'recovering' : 'ready',
        ...(trackReplay
          ? { replay: { total: records.length, completed: sent.length, active: false } }
          : {})
      })
    } catch (cause) {
      if (sent.length > 0) await this.options.storage.markOutboundAttempt(sent, this.options.now())
      await this.refreshPending()
      if (trackReplay)
        this.setStatus({
          replay: { total: records.length, completed: sent.length, active: false }
        })
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
      if (records.length > 0) await this.sendRecords(records, true)
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
      await this.receiveAuthorizationControl(
        'membership',
        envelope.payload,
        envelope.senderId,
        envelope.messageId
      )
      return
    }
    if (envelope.kind === 'archive') {
      await this.receiveAuthorizationControl(
        'archive',
        envelope.payload,
        envelope.senderId,
        envelope.messageId
      )
      return
    }
    if (envelope.kind === 'delete') {
      await this.receiveAuthorizationControl(
        'delete',
        envelope.payload,
        envelope.senderId,
        envelope.messageId
      )
      return
    }
    if (envelope.kind === 'authorization-resolution') {
      await this.receiveForkResolution(envelope.payload, envelope.senderId, envelope.messageId)
    }
  }

  private async verifyControlSignature(
    senderId: string,
    actorUserId: string,
    signingBytes: Uint8Array,
    signature: Uint8Array
  ): Promise<void> {
    if (actorUserId !== senderId)
      throw operationError(
        'authorization-denied',
        'Control actor does not match envelope sender',
        false
      )
    const identity = this.requireIdentity()
    if (!(await identity.verifyControl(actorUserId, signingBytes, signature)))
      throw operationError('authorization-denied', 'Control signature is invalid', false)
  }

  private async receiveAuthorizationControl(
    kind: AuthorizationControlKind,
    payloadBytes: Uint8Array,
    senderId: string,
    messageId: string,
    receivedAt = this.options.now()
  ): Promise<void> {
    const authorization = this.authorization
    if (!authorization)
      throw operationError('authorization-denied', 'Authorization state is unavailable', false)

    const payload = decodeControl(kind, payloadBytes)
    const signingBytes = controlPayloadSigningBytes(kind, payload)
    await this.verifyControlSignature(
      senderId,
      payload.actorUserId,
      signingBytes,
      payload.signature
    )
    if (payload.documentId !== this.documentId)
      throw operationError('authorization-denied', 'Control document binding is invalid', false)

    const controlId = encodeAuthorizationCommitment(
      await authorizationControlCommitment(signingBytes)
    )
    const predecessor = encodeAuthorizationCommitment(payload.predecessor)
    if (
      authorization.records.some((record) => record.controlId === controlId) ||
      authorization.pending.some((record) => record.controlId === controlId)
    ) {
      await this.persistAuthorizationState(this.access, authorization, messageId, receivedAt)
      return
    }
    if (authorization.conflict) {
      const conflict = authorization.conflict
      if (predecessor === conflict.predecessor && payload.revision === conflict.revision) {
        const parent = authorizationAccessAt(authorization, predecessor)
        if (!parent)
          throw operationError('authorization-denied', 'Fork predecessor is unavailable', false)
        if (parent.deleted)
          throw operationError(
            'authorization-denied',
            'Deleted authorization state is terminal',
            false
          )
        const actor = activeParticipantIn(parent, payload.actorUserId)
        if (actor?.role !== 'admin')
          throw operationError(
            'authorization-denied',
            'Control actor was not an active admin at the referenced authorization state',
            false
          )
        await this.verifyBoundControlIdentity(parent, kind, payload)
        const semanticNext = this.applyControl(kind, parent, payload)
        const record: StoredAuthorizationControl = {
          controlId,
          kind,
          predecessor,
          revision: payload.revision,
          senderId,
          messageId,
          payload: new Uint8Array(payloadBytes),
          receivedAt,
          resultingAccess: withAuthorizationHead(semanticNext, controlId, 'active')
        }
        const nextAuthorization: StoredAuthorizationState = {
          ...authorization,
          records: [...authorization.records, record],
          pending: authorization.pending.filter((candidate) => candidate.controlId !== controlId),
          conflict: {
            ...conflict,
            controlIds: [...new Set([...conflict.controlIds, controlId])].sort()
          }
        }
        const frozen = withAuthorizationHead(parent, predecessor, 'conflict')
        await this.persistAuthorizationState(frozen, nextAuthorization, messageId, receivedAt)
        this.access = frozen
        this.authorization = nextAuthorization
        this.emit({ type: 'access', access: this.getAccessState() })
        await this.drainPendingResolutions()
        return
      }
      const pending: PendingAuthorizationControl = {
        controlId,
        kind,
        predecessor,
        revision: payload.revision,
        senderId,
        messageId,
        payload: new Uint8Array(payloadBytes),
        receivedAt
      }
      const nextAuthorization: StoredAuthorizationState = {
        ...authorization,
        pending: [...authorization.pending, pending].sort((a, b) =>
          a.controlId.localeCompare(b.controlId)
        )
      }
      await this.persistAuthorizationState(this.access, nextAuthorization, messageId, receivedAt)
      this.authorization = nextAuthorization
      return
    }

    const parent = authorizationAccessAt(authorization, predecessor)
    if (!parent) {
      if (payload.revision <= this.access.revision)
        throw operationError(
          'authorization-denied',
          'Control predecessor is unknown or stale',
          false
        )
      const pending: PendingAuthorizationControl = {
        controlId,
        kind,
        predecessor,
        revision: payload.revision,
        senderId,
        messageId,
        payload: new Uint8Array(payloadBytes),
        receivedAt
      }
      const nextAuthorization = {
        ...authorization,
        pending: [...authorization.pending, pending].sort((a, b) =>
          a.controlId.localeCompare(b.controlId)
        )
      }
      await this.persistAuthorizationState(this.access, nextAuthorization, messageId, receivedAt)
      this.authorization = nextAuthorization
      return
    }

    if (payload.revision !== parent.revision + 1)
      throw operationError(
        'authorization-denied',
        'Control revision does not follow its predecessor',
        false
      )
    if (parent.deleted)
      throw operationError('authorization-denied', 'Deleted authorization state is terminal', false)
    const actor = activeParticipantIn(parent, payload.actorUserId)
    if (actor?.role !== 'admin')
      throw operationError(
        'authorization-denied',
        'Control actor was not an active admin at the referenced authorization state',
        false
      )
    await this.verifyBoundControlIdentity(parent, kind, payload)

    const semanticNext = this.applyControl(kind, parent, payload)
    const resultingAccess = withAuthorizationHead(semanticNext, controlId, 'active')
    const record: StoredAuthorizationControl = {
      controlId,
      kind,
      predecessor,
      revision: payload.revision,
      senderId,
      messageId,
      payload: new Uint8Array(payloadBytes),
      receivedAt,
      resultingAccess
    }
    if (
      (authorization.resolutions ?? []).some(
        (resolution) =>
          resolution.commonPredecessor === predecessor &&
          resolution.forkRevision === payload.revision
      )
    )
      throw operationError(
        'authorization-denied',
        'Control belongs to an authorization fork that is already resolved',
        false
      )

    const siblings = authorization.records.filter(
      (candidate) =>
        candidate.predecessor === predecessor && candidate.revision === payload.revision
    )

    if (siblings.length > 0) {
      const conflictIds = [...siblings.map((candidate) => candidate.controlId), controlId]
      const conflict = {
        predecessor,
        revision: payload.revision,
        controlIds: [...new Set(conflictIds)].sort()
      }
      const frozen = withAuthorizationHead(parent, predecessor, 'conflict')
      const nextAuthorization: StoredAuthorizationState = {
        ...authorization,
        head: predecessor,
        records: [...authorization.records, record],
        pending: authorization.pending.filter((candidate) => candidate.controlId !== controlId),
        conflict
      }
      await this.persistAuthorizationState(frozen, nextAuthorization, messageId, receivedAt)
      this.access = frozen
      this.authorization = nextAuthorization
      this.emit({ type: 'access', access: this.getAccessState() })
      await this.drainPendingResolutions()
      return
    }

    if (predecessor !== authorization.head)
      throw operationError('authorization-denied', 'Control is causally superseded', false)

    const nextAuthorization: StoredAuthorizationState = {
      ...authorization,
      head: controlId,
      records: [...authorization.records, record],
      pending: authorization.pending.filter((candidate) => candidate.controlId !== controlId)
    }
    await this.persistAuthorizationState(resultingAccess, nextAuthorization, messageId, receivedAt)
    this.access = resultingAccess
    this.authorization = nextAuthorization
    this.emit({ type: 'access', access: this.getAccessState() })
    await this.publishAuthorizationEvidence()
    await this.drainPendingAuthorization()
  }

  private async buildForkResolutionProposal(
    chosenControlId: string
  ): Promise<Omit<ForkResolutionPayload, 'approvals'>> {
    const authorization = this.authorization
    const conflict = authorization?.conflict
    if (!authorization || !conflict)
      throw operationError(
        'authorization-denied',
        'Authorization state is not fork-conflicted',
        false
      )
    const parent = authorizationAccessAt(authorization, conflict.predecessor)
    if (!parent)
      throw operationError('authorization-denied', 'Fork predecessor is unavailable', false)
    if (parent.deleted)
      throw operationError('authorization-denied', 'Deleted authorization state is terminal', false)
    const branches = conflict.controlIds.map((controlId) => {
      const record = authorization.records.find((candidate) => candidate.controlId === controlId)
      if (!record)
        throw operationError(
          'authorization-denied',
          'Fork resolution is missing a competing control record',
          false
        )
      return record
    })
    const deleteBranches = branches.filter((record) => record.resultingAccess.deleted)
    const canonicalChoice = [...(deleteBranches.length > 0 ? deleteBranches : branches)].sort(
      (a, b) => a.controlId.localeCompare(b.controlId)
    )[0]!
    if (chosenControlId !== canonicalChoice.controlId)
      throw operationError(
        'authorization-denied',
        `Fork resolution must choose deterministic control ${canonicalChoice.controlId}`,
        false
      )
    for (const participant of parent.participants) {
      if (participant.active) continue
      if (
        canonicalChoice.resultingAccess.participants.some(
          (candidate) => candidate.participantId === participant.participantId && candidate.active
        )
      )
        throw operationError(
          'authorization-denied',
          'Fork resolution cannot reactivate a participant removed before the fork authority state',
          false
        )
    }
    const resolutionRevision = conflict.revision + 1
    const semanticResult = {
      ...cloneAccessState(canonicalChoice.resultingAccess),
      revision: resolutionRevision
    }
    return {
      documentId: this.documentId,
      commonPredecessor: decodeAuthorizationCommitment(conflict.predecessor),
      forkRevision: conflict.revision,
      competingControlIds: conflict.controlIds.map(decodeAuthorizationCommitment),
      chosenControlId: decodeAuthorizationCommitment(canonicalChoice.controlId),
      resolutionRevision,
      resultingStateCommitment: await authorizationStateCommitment(this.documentId, semanticResult)
    }
  }

  private async receiveForkResolution(
    payloadBytes: Uint8Array,
    senderId: string,
    messageId: string,
    receivedAt = this.options.now()
  ): Promise<void> {
    const authorization = this.authorization
    if (!authorization)
      throw operationError('authorization-denied', 'Authorization state is unavailable', false)
    const payload = decodeForkResolutionPayload(payloadBytes)
    if (payload.documentId !== this.documentId)
      throw operationError(
        'authorization-denied',
        'Fork resolution document binding is invalid',
        false
      )
    const proposal = resolutionUnsigned(payload)
    const resolutionId = encodeAuthorizationCommitment(await forkResolutionCommitment(proposal))
    if ((authorization.resolutions ?? []).some((entry) => entry.resolutionId === resolutionId)) {
      await this.persistAuthorizationState(this.access, authorization, messageId, receivedAt)
      return
    }
    const resolvedFork = (authorization.resolutions ?? []).find(
      (entry) =>
        entry.commonPredecessor === encodeAuthorizationCommitment(payload.commonPredecessor) &&
        entry.forkRevision === payload.forkRevision
    )
    if (resolvedFork)
      throw operationError(
        'authorization-denied',
        'Authorization fork already has a durable resolution',
        false
      )
    if (!payload.approvals.some((approval) => approval.actorUserId === senderId))
      throw operationError(
        'authorization-denied',
        'Fork resolution sender must be one of its approving admins',
        false
      )
    const conflict = authorization.conflict
    const commonPredecessor = encodeAuthorizationCommitment(payload.commonPredecessor)
    const expectedControls = payload.competingControlIds.map(encodeAuthorizationCommitment).sort()
    const canApplyNow =
      conflict !== undefined &&
      conflict.predecessor === commonPredecessor &&
      conflict.revision === payload.forkRevision &&
      equalStrings([...conflict.controlIds].sort(), expectedControls) &&
      expectedControls.every((controlId) =>
        authorization.records.some((record) => record.controlId === controlId)
      )
    if (!canApplyNow) {
      const pending: PendingAuthorizationResolution = {
        resolutionId,
        senderId,
        messageId,
        payload: new Uint8Array(payloadBytes),
        receivedAt
      }
      const nextAuthorization: StoredAuthorizationState = {
        ...authorization,
        pendingResolutions: [
          ...(authorization.pendingResolutions ?? []).filter(
            (entry) => entry.resolutionId !== resolutionId
          ),
          pending
        ].sort((left, right) => left.resolutionId.localeCompare(right.resolutionId))
      }
      await this.persistAuthorizationState(this.access, nextAuthorization, messageId, receivedAt)
      this.authorization = nextAuthorization
      return
    }
    await this.acceptForkResolution(payloadBytes, senderId, messageId, receivedAt, [])
  }

  private async acceptForkResolution(
    payloadBytes: Uint8Array,
    senderId: string,
    messageId: string,
    receivedAt: number,
    outbound: readonly OutboundRecord[]
  ): Promise<void> {
    const authorization = this.authorization
    const conflict = authorization?.conflict
    if (!authorization || !conflict)
      throw operationError('authorization-denied', 'Fork resolution has no active conflict', false)
    const payload = decodeForkResolutionPayload(payloadBytes)
    const chosenControlId = encodeAuthorizationCommitment(payload.chosenControlId)
    const expected = await this.buildForkResolutionProposal(chosenControlId)
    const signingBytes = forkResolutionSigningBytes(resolutionUnsigned(payload))
    if (!equalBytes(signingBytes, forkResolutionSigningBytes(expected)))
      throw operationError(
        'authorization-denied',
        'Fork resolution proposal does not match the frozen conflict',
        false
      )
    const parent = authorizationAccessAt(authorization, conflict.predecessor)
    if (!parent)
      throw operationError('authorization-denied', 'Fork predecessor is unavailable', false)
    const requiredAdmins = preForkAdminIds(parent)
    if (requiredAdmins.length < 2)
      throw operationError(
        'authorization-denied',
        'Fork resolution requires at least two independent pre-fork admins',
        false
      )
    const approvals = [...payload.approvals].sort((a, b) =>
      a.actorUserId.localeCompare(b.actorUserId)
    )
    if (
      !equalStrings(
        requiredAdmins,
        approvals.map((approval) => approval.actorUserId)
      )
    )
      throw operationError(
        'authorization-denied',
        'Fork resolution requires unanimous signatures from the pre-fork active-admin set',
        false
      )
    if (!approvals.some((approval) => approval.actorUserId === senderId))
      throw operationError(
        'authorization-denied',
        'Fork resolution sender must be one of its approving admins',
        false
      )
    const identity = this.requireIdentity()
    for (const approval of approvals) {
      if (authorization.anchorKind === 'verified-root') {
        const approvingAdmin = activeParticipantIn(parent, approval.actorUserId)
        const expectedKey = approvingAdmin?.identityKeyCommitment
        if (!expectedKey)
          throw operationError(
            'authorization-denied',
            `Verified fork authority has no identity-key binding for ${approval.actorUserId}`,
            false
          )
        const actualKey = encodeAuthorizationCommitment(
          await this.requireIdentityKeyCommitment(approval.actorUserId)
        )
        if (actualKey !== expectedKey)
          throw operationError(
            'authorization-denied',
            `Identity-key binding mismatch for fork-resolution approver ${approval.actorUserId}`,
            false
          )
      }
      if (!(await identity.verifyControl(approval.actorUserId, signingBytes, approval.signature)))
        throw operationError(
          'authorization-denied',
          `Fork resolution approval is invalid for ${approval.actorUserId}`,
          false
        )
    }

    const chosen = authorization.records.find((record) => record.controlId === chosenControlId)
    if (!chosen)
      throw operationError('authorization-denied', 'Chosen fork control is unavailable', false)
    const resolutionId = encodeAuthorizationCommitment(
      await forkResolutionCommitment(resolutionUnsigned(payload))
    )
    const resultingAccess = withAuthorizationHead(
      { ...cloneAccessState(chosen.resultingAccess), revision: payload.resolutionRevision },
      resolutionId,
      'active'
    )
    const actualStateCommitment = await authorizationStateCommitment(
      this.documentId,
      resultingAccess
    )
    if (!equalBytes(actualStateCommitment, payload.resultingStateCommitment))
      throw operationError(
        'authorization-denied',
        'Fork resolution resulting ACL commitment is invalid',
        false
      )
    const stored: StoredAuthorizationResolution = {
      resolutionId,
      commonPredecessor: conflict.predecessor,
      forkRevision: conflict.revision,
      competingControlIds: [...conflict.controlIds].sort(),
      chosenControlId,
      revision: payload.resolutionRevision,
      senderId,
      messageId,
      payload: new Uint8Array(payloadBytes),
      receivedAt,
      resultingAccess
    }
    const { conflict: _resolvedConflict, ...authorizationWithoutConflict } = authorization
    const nextAuthorization: StoredAuthorizationState = {
      ...authorizationWithoutConflict,
      head: resolutionId,
      resolutions: [...(authorization.resolutions ?? []), stored],
      pendingResolutions: (authorization.pendingResolutions ?? []).filter(
        (entry) => entry.resolutionId !== resolutionId
      ),
      pending: authorization.pending.filter(
        (entry) => !conflict.controlIds.includes(entry.predecessor)
      )
    }
    await this.options.storage.commitAccessChange({
      documentId: this.documentId,
      access: resultingAccess,
      authorization: nextAuthorization,
      outbound,
      seen:
        outbound.length > 0 ? [] : [{ documentId: this.documentId, messageId, seenAt: receivedAt }]
    })
    this.access = resultingAccess
    this.authorization = nextAuthorization
    this.emit({ type: 'access', access: this.getAccessState() })
    if (outbound.length === 0) await this.publishAuthorizationEvidence()
    await this.drainPendingAuthorization()
  }

  private async drainPendingResolutions(): Promise<void> {
    while (this.authorization?.conflict) {
      const authorization = this.authorization
      const conflict = authorization.conflict!
      const ready = (authorization.pendingResolutions ?? [])
        .filter((entry) => {
          try {
            const payload = decodeForkResolutionPayload(entry.payload)
            return (
              encodeAuthorizationCommitment(payload.commonPredecessor) === conflict.predecessor &&
              payload.forkRevision === conflict.revision &&
              equalStrings(
                payload.competingControlIds.map(encodeAuthorizationCommitment).sort(),
                [...conflict.controlIds].sort()
              )
            )
          } catch {
            return false
          }
        })
        .sort((left, right) => left.resolutionId.localeCompare(right.resolutionId))
      if (ready.length === 0) return
      // Canonical branch choice makes at most one distinct proposal valid for
      // a given conflict. Multiple encodings of that proposal share the same
      // resolution id because signatures are not part of the commitment.
      const candidate = ready[0]!
      await this.acceptForkResolution(
        candidate.payload,
        candidate.senderId,
        candidate.messageId,
        candidate.receivedAt,
        []
      )
    }
  }

  private applyControl(
    kind: AuthorizationControlKind,
    current: DocumentAccessState,
    payload: MembershipPayload | ArchivePayload | DeletePayload
  ): DocumentAccessState {
    if (kind === 'membership') return this.applyMembership(current, payload as MembershipPayload)
    if (kind === 'archive') {
      const archive = payload as ArchivePayload
      return { ...current, archived: archive.action === 'archive', revision: archive.revision }
    }
    const deleted = payload as DeletePayload
    return { ...current, deleted: true, revision: deleted.revision }
  }

  private async drainPendingAuthorization(): Promise<void> {
    while (this.authorization && !this.authorization.conflict) {
      const ready = this.authorization.pending
        .filter((candidate) => candidate.predecessor === this.authorization!.head)
        .sort((a, b) => a.controlId.localeCompare(b.controlId))
      if (ready.length === 0) return
      for (const candidate of ready) {
        if (!this.authorization || this.authorization.conflict) return
        this.authorization = {
          ...this.authorization,
          pending: this.authorization.pending.filter(
            (entry) => entry.controlId !== candidate.controlId
          )
        }
        await this.receiveAuthorizationControl(
          candidate.kind,
          candidate.payload,
          candidate.senderId,
          candidate.messageId,
          candidate.receivedAt
        )
      }
    }
  }

  private async persistAuthorizationState(
    access: DocumentAccessState,
    authorization: StoredAuthorizationState,
    messageId: string,
    receivedAt: number
  ): Promise<void> {
    await this.options.storage.commitAccessChange({
      documentId: this.documentId,
      access,
      authorization,
      outbound: [],
      seen: [{ documentId: this.documentId, messageId, seenAt: receivedAt }]
    })
    this.status = { ...this.status, lastReceivedAt: receivedAt, lastPersistedAt: receivedAt }
    this.emit({ type: 'status', status: this.getStatus() })
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
      ...this.nextAuthorizationProof(),
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
      revision: payload.revision
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
    const advanced = await this.advanceAuthorization(
      kind,
      payload,
      nextAccess,
      outbound[0]!.id,
      outbound[0]!.createdAt,
      this.options.senderId
    )
    await this.options.storage.commitAccessChange({
      documentId: this.documentId,
      access: advanced.access,
      authorization: advanced.authorization,
      outbound
    })
    this.access = advanced.access
    this.authorization = advanced.authorization
    this.emit({ type: 'access', access: this.getAccessState() })
    await this.publishAuthorizationEvidence()
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
        ...(payload.targetIdentityKeyCommitment === undefined
          ? existing?.identityKeyCommitment === undefined
            ? {}
            : { identityKeyCommitment: existing.identityKeyCommitment }
          : {
              identityKeyCommitment: encodeAuthorizationCommitment(
                payload.targetIdentityKeyCommitment
              )
            }),
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
      revision: payload.revision
    }
  }

  private nextAuthorizationProof(): {
    documentId: string
    revision: number
    predecessor: Uint8Array
  } {
    if (!this.authorization)
      throw operationError('authorization-denied', 'Authorization state is unavailable', false)
    if (this.authorization.conflict)
      throw operationError('authorization-denied', 'Authorization state is conflicted', false)
    return {
      documentId: this.documentId,
      revision: this.access.revision + 1,
      predecessor: decodeAuthorizationCommitment(this.authorization.head)
    }
  }

  private controlSigningBytes(kind: AuthorizationControlKind, payload: Uint8Array): Uint8Array {
    if (kind === 'membership')
      return membershipPayloadSigningBytes(decodeMembershipPayload(payload))
    if (kind === 'archive') return archivePayloadSigningBytes(decodeArchivePayload(payload))
    return deletePayloadSigningBytes(decodeDeletePayload(payload))
  }

  private async advanceAuthorization(
    kind: AuthorizationControlKind,
    payload: Uint8Array,
    nextAccess: DocumentAccessState,
    messageId: string,
    receivedAt: number,
    senderId: string
  ): Promise<{ access: DocumentAccessState; authorization: StoredAuthorizationState }> {
    const authorization = this.authorization
    if (!authorization || authorization.conflict)
      throw operationError('authorization-denied', 'Authorization state cannot advance', false)
    const signingBytes = this.controlSigningBytes(kind, payload)
    const decoded = decodeControlProof(kind, payload)
    const predecessor = encodeAuthorizationCommitment(decoded.predecessor)
    if (decoded.documentId !== this.documentId)
      throw operationError('authorization-denied', 'Control document binding is invalid', false)
    if (decoded.revision !== this.access.revision + 1 || predecessor !== authorization.head)
      throw operationError(
        'authorization-denied',
        'Control authorization predecessor is stale',
        false
      )
    const controlId = encodeAuthorizationCommitment(
      await authorizationControlCommitment(signingBytes)
    )
    const access = withAuthorizationHead(nextAccess, controlId, 'active')
    const record: StoredAuthorizationControl = {
      controlId,
      kind,
      predecessor,
      revision: decoded.revision,
      senderId,
      messageId,
      payload: new Uint8Array(payload),
      receivedAt,
      resultingAccess: access
    }
    return {
      access,
      authorization: {
        ...authorization,
        head: controlId,
        records: [...authorization.records, record]
      }
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
    if (this.options.identity?.bootstrapAuthorization) {
      await this.bootstrapAuthenticatedAuthorization()
      return
    }
    if (
      this.options.allowAuthorizationRootCreation &&
      this.options.identity?.identityKeyCommitment
    ) {
      await this.bootstrapLocalAuthorizationRoot()
      return
    }
    await this.bootstrapLegacyAccess()
  }

  private async bootstrapLocalAuthorizationRoot(): Promise<void> {
    const current = this.authorization
    const identityKeyCommitment = this.requireIdentity().identityKeyCommitment
    if (!current || !identityKeyCommitment)
      throw operationError('authorization-denied', 'Authorization state is unavailable', false)
    if (current.anchorKind === 'verified-root') return
    if (!this.isPristineSelfOnlyLegacyAnchor(current))
      throw operationError(
        'authorization-denied',
        'Legacy authorization state requires an explicit migration proof before shared bootstrap',
        false
      )
    const rootBytes = await this.createAuthorizationRoot(identityKeyCommitment)
    await this.installAuthorizationRoot(rootBytes)
    this.emit({ type: 'access', access: this.getAccessState() })
  }

  private async bootstrapAuthenticatedAuthorization(): Promise<void> {
    const identity = this.requireIdentity()
    const bootstrap = identity.bootstrapAuthorization
    const identityKeyCommitment = identity.identityKeyCommitment
    if (!bootstrap || !identityKeyCommitment)
      throw operationError(
        'authorization-denied',
        'Authenticated authorization bootstrap requires identity-key commitments',
        false
      )
    const material = await bootstrap({
      documentId: this.documentId,
      transport: this.options.transport
    })
    const current = this.authorization
    if (!current)
      throw operationError('authorization-denied', 'Authorization state is unavailable', false)

    if (current.anchorKind === 'verified-root') {
      await this.verifyEstablishedBootstrap(material)
      // An already-established device may repopulate an empty/censored evidence
      // cache from its durable root/head, but cache metadata can never replace it.
      await this.publishAuthorizationEvidence()
      return
    }

    const pristineSelfOnly = this.isPristineSelfOnlyLegacyAnchor(current)
    if (this.accessWasStored && !pristineSelfOnly)
      throw operationError(
        'authorization-denied',
        'Legacy authorization state requires an explicit migration proof before shared bootstrap',
        false
      )

    let rootBytes: Uint8Array | undefined
    if (material.expectedRoot) {
      rootBytes = await this.selectRoot(material.roots, material.expectedRoot)
      if (!rootBytes)
        throw operationError(
          'authorization-denied',
          'Bootstrap did not contain the supplied authorization root',
          false
        )
    } else if (material.roots.length > 0) {
      if (!this.options.allowAuthorizationRootCreation)
        throw operationError(
          'authorization-denied',
          'Joining a shared authorization root requires an explicit bootstrap root commitment',
          false
        )
      const selfRoots: Array<{ bytes: Uint8Array; commitment: string }> = []
      for (const bytes of material.roots) {
        const root = decodeAuthorizationRootPayload(bytes)
        if (root.creatorUserId !== this.options.senderId) continue
        selfRoots.push({ bytes, commitment: await this.rootCommitment(root) })
      }
      if (selfRoots.length !== 1)
        throw operationError(
          'authorization-denied',
          'Joining a shared authorization root requires an explicit bootstrap root commitment',
          false
        )
      rootBytes = selfRoots[0]!.bytes
    } else {
      if (!this.options.allowAuthorizationRootCreation || !pristineSelfOnly)
        throw operationError(
          'authorization-denied',
          'No authenticated authorization root is available for this replica',
          false
        )
      rootBytes = await this.createAuthorizationRoot(
        identityKeyCommitment,
        material.initialParticipants
      )
    }

    await this.installAuthorizationRoot(rootBytes, material.expectedRoot)
    // Resolution evidence is deliberately accepted before branch controls so
    // an out-of-order bootstrap can durably buffer the proof, then apply it
    // only after the exact fork evidence becomes available.
    for (const evidence of material.resolutions) {
      await this.receiveForkResolution(
        evidence.payload,
        evidence.senderId,
        evidence.messageId,
        evidence.receivedAt
      )
    }
    for (const evidence of material.controls) {
      await this.receiveAuthorizationControl(
        evidence.kind,
        evidence.payload,
        evidence.senderId,
        evidence.messageId,
        evidence.receivedAt
      )
    }

    const installed = this.authorization
    if (!installed)
      throw operationError(
        'authorization-denied',
        'Authorization bootstrap was not installed',
        false
      )
    if (material.expectedHead && material.expectedHead !== installed.head)
      throw operationError(
        'authorization-denied',
        'Bootstrap chain does not end at the supplied authorization head',
        false
      )
    const self = activeParticipantIn(this.access, this.options.senderId)
    if (!self)
      throw operationError(
        'authorization-denied',
        'Verified bootstrap chain does not authorize the local identity',
        false
      )
    await this.publishAuthorizationEvidence()
    this.emit({ type: 'access', access: this.getAccessState() })
  }

  private async verifyEstablishedBootstrap(
    material: Awaited<ReturnType<NonNullable<ClientIdentityAdapter['bootstrapAuthorization']>>>
  ): Promise<void> {
    const authorization = this.authorization!
    if (material.expectedRoot && material.expectedRoot !== authorization.anchorHead)
      throw operationError(
        'authorization-denied',
        'Bootstrap root conflicts with the durable authorization anchor',
        false
      )
    if (material.expectedHead && material.expectedHead !== authorization.head)
      throw operationError(
        'authorization-denied',
        'Bootstrap head conflicts with the durable authorization head',
        false
      )
    if (material.roots.length > 0) {
      const matching = await this.selectRoot(material.roots, authorization.anchorHead)
      if (!matching)
        throw operationError(
          'authorization-denied',
          'Bootstrap root evidence conflicts with the durable authorization anchor',
          false
        )
      await this.verifyAuthorizationRoot(matching, authorization.anchorHead)
    }
  }

  private isPristineSelfOnlyLegacyAnchor(authorization: StoredAuthorizationState): boolean {
    const self = authorization.anchorAccess.participants.filter((participant) => participant.active)
    return (
      authorization.anchorKind === 'legacy-zero-genesis' &&
      authorization.anchorAccess.revision === 0 &&
      authorization.records.length === 0 &&
      (authorization.resolutions?.length ?? 0) === 0 &&
      self.length === 1 &&
      self[0]?.participantId === this.options.senderId &&
      self[0]?.role === 'admin'
    )
  }

  private async createAuthorizationRoot(
    identityKeyCommitment: NonNullable<ClientIdentityAdapter['identityKeyCommitment']>,
    initialParticipants?: readonly DocumentParticipant[]
  ): Promise<Uint8Array> {
    const identity = this.requireIdentity()
    const source = initialParticipants ?? [
      { participantId: this.options.senderId, role: 'admin' as const, active: true }
    ]
    const deduplicated = new Map<string, DocumentParticipant>()
    for (const participant of source) {
      if (deduplicated.has(participant.participantId))
        throw operationError(
          'authorization-denied',
          'Initial authorization participants contain a duplicate identity',
          false
        )
      deduplicated.set(participant.participantId, participant)
    }
    const creator = deduplicated.get(this.options.senderId)
    if (!creator?.active || creator.role !== 'admin')
      throw operationError(
        'authorization-denied',
        'Authorization root creator must be an active initial admin',
        false
      )
    assertHasActiveAdmin([...deduplicated.values()])
    const unsigned = {
      documentId: this.documentId,
      creatorUserId: this.options.senderId,
      participants: await Promise.all(
        [...deduplicated.values()]
          .sort((left, right) => left.participantId.localeCompare(right.participantId))
          .map(async (participant) => ({
            participantId: participant.participantId,
            role: participant.role,
            active: participant.active,
            identityKeyCommitment: await identityKeyCommitment(participant.participantId)
          }))
      )
    }
    const root: AuthorizationRootPayload = {
      ...unsigned,
      signature: await identity.signControl(authorizationRootSigningBytes(unsigned))
    }
    return encodeAuthorizationRootPayload(root)
  }

  private async installAuthorizationRoot(bytes: Uint8Array, expectedRoot?: string): Promise<void> {
    const root = await this.verifyAuthorizationRoot(bytes, expectedRoot)
    const head = await this.rootCommitment(root)
    const participants: DocumentParticipant[] = root.participants.map((participant) => ({
      participantId: participant.participantId,
      role: participant.role,
      active: participant.active,
      identityKeyCommitment: encodeAuthorizationCommitment(participant.identityKeyCommitment)
    }))
    assertHasActiveAdmin(participants)
    const self = participants.find(
      (participant) => participant.participantId === this.options.senderId
    )
    const access: DocumentAccessState = {
      selfRole: self?.role ?? 'reader',
      participants,
      archived: false,
      deleted: false,
      revision: 0,
      authorizationRoot: head,
      authorizationHead: head,
      authorizationStatus: 'active'
    }
    const authorization: StoredAuthorizationState = {
      version: 2,
      anchorKind: 'verified-root',
      anchorHead: head,
      anchorAccess: cloneAccessState(access),
      rootProof: new Uint8Array(bytes),
      head,
      records: [],
      pending: [],
      resolutions: [],
      pendingResolutions: []
    }
    await this.options.storage.commitAccessChange({
      documentId: this.documentId,
      access,
      authorization,
      outbound: []
    })
    this.access = access
    this.authorization = authorization
  }

  private async verifyAuthorizationRoot(
    bytes: Uint8Array,
    expectedRoot?: string
  ): Promise<AuthorizationRootPayload> {
    const identity = this.requireIdentity()
    const identityKeyCommitment = identity.identityKeyCommitment
    if (!identityKeyCommitment)
      throw operationError(
        'authorization-denied',
        'Identity-key commitments are unavailable',
        false
      )
    const root = decodeAuthorizationRootPayload(bytes)
    if (root.documentId !== this.documentId)
      throw operationError(
        'authorization-denied',
        'Authorization root document binding is invalid',
        false
      )
    const unsigned = {
      documentId: root.documentId,
      creatorUserId: root.creatorUserId,
      participants: root.participants
    }
    const signingBytes = authorizationRootSigningBytes(unsigned)
    if (!(await identity.verifyControl(root.creatorUserId, signingBytes, root.signature)))
      throw operationError('authorization-denied', 'Authorization root signature is invalid', false)
    for (const participant of root.participants) {
      const actual = await identityKeyCommitment(participant.participantId)
      if (!equalBytes(actual, participant.identityKeyCommitment))
        throw operationError(
          'authorization-denied',
          `Authorization root identity-key commitment mismatch for ${participant.participantId}`,
          false
        )
    }
    const commitment = await this.rootCommitment(root)
    if (expectedRoot && commitment !== expectedRoot)
      throw operationError(
        'authorization-denied',
        'Authorization root does not match the supplied commitment',
        false
      )
    return root
  }

  private async rootCommitment(root: AuthorizationRootPayload): Promise<string> {
    const { signature: _signature, ...unsigned } = root
    return encodeAuthorizationCommitment(await authorizationRootCommitment(unsigned))
  }

  private async selectRoot(
    roots: readonly Uint8Array[],
    expectedRoot: string
  ): Promise<Uint8Array | undefined> {
    for (const bytes of roots) {
      const root = decodeAuthorizationRootPayload(bytes)
      if ((await this.rootCommitment(root)) === expectedRoot) return bytes
    }
    return undefined
  }

  private async publishAuthorizationEvidence(): Promise<void> {
    const publish = this.options.identity?.publishAuthorizationEvidence
    const authorization = this.authorization
    if (!publish || !authorization || authorization.anchorKind !== 'verified-root') return
    const evidence: AuthorizationEvidencePublish = {
      rootCommitment: authorization.anchorHead,
      headCommitment: authorization.head,
      ...(authorization.rootProof === undefined
        ? {}
        : { root: new Uint8Array(authorization.rootProof) }),
      controls: authorization.records.map((record) => ({
        kind: record.kind,
        senderId: record.senderId,
        messageId: record.messageId,
        payload: new Uint8Array(record.payload),
        receivedAt: record.receivedAt
      })),
      resolutions: (authorization.resolutions ?? []).map((resolution) => ({
        senderId: resolution.senderId,
        messageId: resolution.messageId,
        payload: new Uint8Array(resolution.payload),
        receivedAt: resolution.receivedAt
      }))
    }
    await publish({ documentId: this.documentId, transport: this.options.transport }, evidence)
  }

  private async bootstrapLegacyAccess(): Promise<void> {
    const bootstrap = this.options.identity?.bootstrapAccess
    if (!bootstrap) return
    // Once a replay-safe authorization chain exists, authenticated controls are
    // the only authority allowed to change it. Server/group membership may help
    // bootstrap a brand-new replica, but must never overwrite durable history.
    if (this.accessWasStored && (this.authorization?.records.length ?? 0) > 0) return
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
    if (this.authorization && this.authorization.records.length === 0) {
      this.authorization = {
        ...this.authorization,
        anchorAccess: cloneAccessState(this.access)
      }
      await this.options.storage.commitAccessChange({
        documentId: this.documentId,
        access: this.access,
        authorization: this.authorization,
        outbound: []
      })
    } else {
      await this.options.storage.saveAccessControl(this.documentId, this.access)
    }
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
    if (this.authorizationConflicted())
      throw operationError('authorization-denied', 'Authorization state is conflicted', false)
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
    if (this.authorizationConflicted())
      throw operationError('authorization-denied', 'Authorization state is conflicted', false)
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
    if (this.authorizationConflicted())
      throw operationError('authorization-denied', 'Authorization state is conflicted', false)
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
  const head = encodeAuthorizationCommitment(authorizationGenesisPredecessor())
  return {
    selfRole: 'admin',
    participants: [{ participantId: senderId, role: 'admin', active: true }],
    archived: false,
    deleted: false,
    revision: 0,
    authorizationHead: head,
    authorizationStatus: 'active'
  }
}

function initialAuthorizationState(
  access: DocumentAccessState,
  head: string,
  anchorKind: 'legacy-zero-genesis' | 'legacy-local-anchor'
): StoredAuthorizationState {
  return {
    version: 2,
    anchorKind,
    anchorHead: head,
    anchorAccess: cloneAccessState(access),
    head,
    records: [],
    pending: []
  }
}

function withAuthorizationHead(
  access: DocumentAccessState,
  head: string,
  status: 'active' | 'conflict'
): DocumentAccessState {
  return { ...cloneAccessState(access), authorizationHead: head, authorizationStatus: status }
}

function authorizationAccessAt(
  authorization: StoredAuthorizationState,
  head: string
): DocumentAccessState | undefined {
  if (authorization.anchorHead === head) return cloneAccessState(authorization.anchorAccess)
  const record = authorization.records.find((candidate) => candidate.controlId === head)
  if (record) return cloneAccessState(record.resultingAccess)
  const resolution = (authorization.resolutions ?? []).find(
    (candidate) => candidate.resolutionId === head
  )
  return resolution ? cloneAccessState(resolution.resultingAccess) : undefined
}

function resolutionUnsigned(
  value: ForkResolutionPayload
): Omit<ForkResolutionPayload, 'approvals'> {
  return {
    documentId: value.documentId,
    commonPredecessor: value.commonPredecessor,
    forkRevision: value.forkRevision,
    competingControlIds: value.competingControlIds,
    chosenControlId: value.chosenControlId,
    resolutionRevision: value.resolutionRevision,
    resultingStateCommitment: value.resultingStateCommitment
  }
}

function preForkAdminIds(access: DocumentAccessState): string[] {
  return access.participants
    .filter((participant) => participant.active && participant.role === 'admin')
    .map((participant) => participant.participantId)
    .sort()
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function activeParticipantIn(
  access: DocumentAccessState,
  participantId: string
): DocumentParticipant | undefined {
  return access.participants.find(
    (participant) => participant.participantId === participantId && participant.active
  )
}

type AuthorizationPayload = MembershipPayload | ArchivePayload | DeletePayload

function decodeControl(kind: AuthorizationControlKind, payload: Uint8Array): AuthorizationPayload {
  if (kind === 'membership') return decodeMembershipPayload(payload)
  if (kind === 'archive') return decodeArchivePayload(payload)
  return decodeDeletePayload(payload)
}

function decodeControlProof(
  kind: AuthorizationControlKind,
  payload: Uint8Array
): Pick<AuthorizationPayload, 'documentId' | 'revision' | 'predecessor'> {
  const decoded = decodeControl(kind, payload)
  return {
    documentId: decoded.documentId,
    revision: decoded.revision,
    predecessor: decoded.predecessor
  }
}

function controlPayloadSigningBytes(
  kind: AuthorizationControlKind,
  payload: AuthorizationPayload
): Uint8Array {
  if (kind === 'membership') return membershipPayloadSigningBytes(payload as MembershipPayload)
  if (kind === 'archive') return archivePayloadSigningBytes(payload as ArchivePayload)
  return deletePayloadSigningBytes(payload as DeletePayload)
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
