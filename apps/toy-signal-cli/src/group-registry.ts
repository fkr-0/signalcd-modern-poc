import { randomUUID } from 'node:crypto'
import type { AuthenticatedIdentity, IdentityRegistry } from './identity-registry'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type CollaborationRole = 'reader' | 'writer' | 'admin'

export interface CollaborationMember {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly role: CollaborationRole
  readonly joinedAt: number
}

function sha256Commitment(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
    throw new GroupApiError(400, `${name} must be a lowercase SHA-256 hex commitment`)
  return value
}

function authorizationEvidenceView(store: AuthorizationEvidenceStore): AuthorizationEvidenceView {
  return {
    version: 1,
    expected_root: store.expectedRoot ?? null,
    expected_head: store.expectedHead ?? null,
    roots: [...store.roots].sort(),
    controls: [...store.controls.values()].sort((left, right) =>
      left.message_id.localeCompare(right.message_id)
    ),
    resolutions: [...store.resolutions.values()].sort((left, right) =>
      left.message_id.localeCompare(right.message_id)
    )
  }
}

function controlEvidence(value: unknown): AuthorizationControlEvidenceRecord {
  if (!record(value)) throw new GroupApiError(400, 'control evidence must be an object')
  const kind = value.kind
  if (kind !== 'membership' && kind !== 'archive' && kind !== 'delete')
    throw new GroupApiError(400, 'control evidence kind is unsupported')
  return { ...authorizationEvidence(value, 'control'), kind }
}

function authorizationEvidence(value: unknown, name: string): AuthorizationEvidenceRecord {
  if (!record(value)) throw new GroupApiError(400, `${name} evidence must be an object`)
  const senderId = text(value.sender_id, `${name}.sender_id`, 512)
  const messageId = text(value.message_id, `${name}.message_id`, 512)
  const payloadBase64 = encoded(value.payload_base64, `${name}.payload_base64`)
  const receivedAt = value.received_at
  if (!Number.isSafeInteger(receivedAt) || (receivedAt as number) < 0)
    throw new GroupApiError(400, `${name}.received_at must be a non-negative safe integer`)
  return {
    sender_id: senderId,
    message_id: messageId,
    payload_base64: payloadBase64,
    received_at: receivedAt as number
  }
}

function sameAuthorizationEvidence(
  left: AuthorizationEvidenceRecord,
  right: AuthorizationEvidenceRecord
): boolean {
  // received_at is local observation metadata, not cryptographic evidence. Two
  // replicas may publish the same signed record after observing it at different
  // times, so collisions are defined only by immutable sender/message/payload.
  return (
    left.sender_id === right.sender_id &&
    left.message_id === right.message_id &&
    left.payload_base64 === right.payload_base64
  )
}

function sameControlEvidence(
  left: AuthorizationControlEvidenceRecord,
  right: AuthorizationControlEvidenceRecord
): boolean {
  return left.kind === right.kind && sameAuthorizationEvidence(left, right)
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new GroupApiError(400, `${name} must be a bounded array`)
  return value
}

function encoded(value: unknown, name: string): string {
  const result = text(value, name, 1_000_000)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(result)) throw new GroupApiError(400, `${name} must be base64`)
  return result
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw new GroupApiError(400, `${name} must be a non-empty bounded string`)
  return value
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface CollaborationGroup {
  readonly groupId: string
  readonly documentId: string
  readonly createdBy: string
  readonly createdAt: number
  name: string
  readonly members: Map<string, CollaborationMember>
  readonly authorizationEvidence: AuthorizationEvidenceStore
}

export interface AuthorizationEvidenceRecord {
  readonly sender_id: string
  readonly message_id: string
  readonly payload_base64: string
  readonly received_at: number
}

export interface AuthorizationControlEvidenceRecord extends AuthorizationEvidenceRecord {
  readonly kind: 'membership' | 'archive' | 'delete'
}

export interface AuthorizationEvidenceView {
  readonly version: 1
  readonly expected_root: string | null
  readonly expected_head: string | null
  readonly roots: readonly string[]
  readonly controls: readonly AuthorizationControlEvidenceRecord[]
  readonly resolutions: readonly AuthorizationEvidenceRecord[]
}

interface AuthorizationEvidenceStore {
  expectedRoot?: string
  expectedHead?: string
  readonly roots: Set<string>
  readonly controls: Map<string, AuthorizationControlEvidenceRecord>
  readonly resolutions: Map<string, AuthorizationEvidenceRecord>
}

export interface CollaborationGroupView {
  readonly group_id: string
  readonly document_id: string
  readonly name: string
  readonly created_by: string
  readonly created_at: number
  readonly members: readonly {
    readonly user_id: string
    readonly phone_number: string
    readonly display_name: string
    readonly role: CollaborationRole
    readonly joined_at: number
  }[]
}

export class GroupApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export class CollaborationGroupRegistry {
  private readonly groups = new Map<string, CollaborationGroup>()
  private readonly documentGroups = new Map<string, string>()

  constructor(
    private readonly identities: IdentityRegistry,
    private readonly now: () => number = Date.now
  ) {}

  reset(): void {
    this.groups.clear()
    this.documentGroups.clear()
  }

  create(
    caller: AuthenticatedIdentity,
    input: { document_id?: unknown; name?: unknown }
  ): CollaborationGroupView {
    const documentId = uuid(input.document_id, 'document_id')
    if (this.documentGroups.has(documentId))
      throw new GroupApiError(409, `document ${documentId} already has a collaboration group`)
    const groupId = randomUUID()
    const createdAt = this.now()
    const group: CollaborationGroup = {
      groupId,
      documentId,
      createdBy: caller.userId,
      createdAt,
      name: optionalName(input.name) ?? `Document ${documentId.slice(0, 8)}`,
      members: new Map(),
      authorizationEvidence: { roots: new Set(), controls: new Map(), resolutions: new Map() }
    }
    group.members.set(caller.phoneNumber, member(caller, 'admin', createdAt))
    this.groups.set(groupId, group)
    this.documentGroups.set(documentId, groupId)
    return view(group)
  }

  list(caller: AuthenticatedIdentity): readonly CollaborationGroupView[] {
    return [...this.groups.values()]
      .filter((group) => group.members.has(caller.phoneNumber))
      .map(view)
  }

  get(groupId: string, caller: AuthenticatedIdentity): CollaborationGroupView {
    const group = this.requireGroup(uuid(groupId, 'group_id'))
    this.requireMember(group, caller)
    return view(group)
  }

  authorizationEvidence(groupId: string, caller: AuthenticatedIdentity): AuthorizationEvidenceView {
    const group = this.requireGroup(uuid(groupId, 'group_id'))
    this.requireMember(group, caller)
    return authorizationEvidenceView(group.authorizationEvidence)
  }

  publishAuthorizationEvidence(
    groupId: string,
    caller: AuthenticatedIdentity,
    input: Record<string, unknown>
  ): AuthorizationEvidenceView {
    const group = this.requireGroup(uuid(groupId, 'group_id'))
    this.requireMember(group, caller)
    if (input.version !== 1)
      throw new GroupApiError(400, 'authorization evidence version must be 1')
    const rootCommitment = sha256Commitment(input.root_commitment, 'root_commitment')
    const headCommitment = sha256Commitment(input.head_commitment, 'head_commitment')
    const roots = array(input.roots, 'roots').map((value) => encoded(value, 'root'))
    const controls = array(input.controls, 'controls').map(controlEvidence)
    const resolutions = array(input.resolutions, 'resolutions').map((value) =>
      authorizationEvidence(value, 'resolution')
    )
    if (
      group.authorizationEvidence.expectedRoot !== undefined &&
      group.authorizationEvidence.expectedRoot !== rootCommitment
    )
      throw new GroupApiError(409, 'authorization evidence root commitment conflicts with cache')
    group.authorizationEvidence.expectedRoot = rootCommitment
    group.authorizationEvidence.expectedHead = headCommitment
    for (const root of roots) group.authorizationEvidence.roots.add(root)
    for (const control of controls) {
      const key = `${control.kind}:${control.message_id}`
      const existing = group.authorizationEvidence.controls.get(key)
      if (existing) {
        if (!sameControlEvidence(existing, control))
          throw new GroupApiError(
            409,
            `authorization control ${control.message_id} changed evidence`
          )
        continue
      }
      group.authorizationEvidence.controls.set(key, control)
    }
    for (const resolution of resolutions) {
      const existing = group.authorizationEvidence.resolutions.get(resolution.message_id)
      if (existing) {
        if (!sameAuthorizationEvidence(existing, resolution))
          throw new GroupApiError(
            409,
            `authorization resolution ${resolution.message_id} changed evidence`
          )
        continue
      }
      group.authorizationEvidence.resolutions.set(resolution.message_id, resolution)
    }
    return authorizationEvidenceView(group.authorizationEvidence)
  }

  addMember(
    groupId: string,
    caller: AuthenticatedIdentity,
    input: { phone_number?: unknown; role?: unknown }
  ): CollaborationGroupView {
    const group = this.requireGroup(uuid(groupId, 'group_id'))
    this.requireAdmin(group, caller)
    const phoneNumber = phone(input.phone_number)
    if (group.members.has(phoneNumber))
      throw new GroupApiError(409, `${phoneNumber} is already a member of ${group.groupId}`)
    const identity = this.identities.identityByPhone(phoneNumber)
    const role = collaborationRole(input.role ?? 'writer')
    group.members.set(phoneNumber, member(identity, role, this.now()))
    return view(group)
  }

  removeMember(
    groupId: string,
    phoneNumberValue: string,
    caller: AuthenticatedIdentity
  ): CollaborationGroupView {
    const group = this.requireGroup(uuid(groupId, 'group_id'))
    this.requireAdmin(group, caller)
    const phoneNumber = phone(phoneNumberValue)
    if (!group.members.has(phoneNumber))
      throw new GroupApiError(404, `${phoneNumber} is not a member of ${group.groupId}`)
    if (phoneNumber === caller.phoneNumber)
      throw new GroupApiError(409, 'group admin cannot remove its own active membership')
    group.members.delete(phoneNumber)
    return view(group)
  }

  bindConnection(
    groupId: string,
    documentId: string,
    caller: AuthenticatedIdentity
  ): CollaborationGroupView {
    const group = this.requireGroup(uuid(groupId, 'group_id'))
    if (group.documentId !== uuid(documentId, 'document_id'))
      throw new GroupApiError(409, 'group is bound to a different document')
    this.requireMember(group, caller)
    return view(group)
  }

  view(): readonly CollaborationGroupView[] {
    return [...this.groups.values()].map(view)
  }

  private requireGroup(groupId: string): CollaborationGroup {
    const group = this.groups.get(groupId)
    if (!group) throw new GroupApiError(404, `unknown collaboration group ${groupId}`)
    return group
  }

  private requireMember(
    group: CollaborationGroup,
    caller: AuthenticatedIdentity
  ): CollaborationMember {
    const result = group.members.get(caller.phoneNumber)
    if (!result || result.userId !== caller.userId)
      throw new GroupApiError(403, 'collaboration group membership required')
    return result
  }

  private requireAdmin(group: CollaborationGroup, caller: AuthenticatedIdentity): void {
    if (this.requireMember(group, caller).role !== 'admin')
      throw new GroupApiError(403, 'collaboration group admin required')
  }
}

function member(
  identity: AuthenticatedIdentity,
  role: CollaborationRole,
  joinedAt: number
): CollaborationMember {
  return {
    userId: identity.userId,
    phoneNumber: identity.phoneNumber,
    displayName: identity.displayName,
    role,
    joinedAt
  }
}

function view(group: CollaborationGroup): CollaborationGroupView {
  return {
    group_id: group.groupId,
    document_id: group.documentId,
    name: group.name,
    created_by: group.createdBy,
    created_at: group.createdAt,
    members: [...group.members.values()].map((entry) => ({
      user_id: entry.userId,
      phone_number: entry.phoneNumber,
      display_name: entry.displayName,
      role: entry.role,
      joined_at: entry.joinedAt
    }))
  }
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_RE.test(value))
    throw new GroupApiError(400, `${name} must be a UUID`)
  return value
}

function phone(value: unknown): string {
  if (typeof value !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(value))
    throw new GroupApiError(400, 'phone_number must be E.164-style')
  return value
}

function optionalName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new GroupApiError(400, 'name must be a string')
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 128)
    throw new GroupApiError(400, 'name must contain between 1 and 128 characters')
  return normalized
}

function collaborationRole(value: unknown): CollaborationRole {
  if (value === 'reader' || value === 'writer' || value === 'admin') return value
  throw new GroupApiError(400, 'role must be reader, writer, or admin')
}
