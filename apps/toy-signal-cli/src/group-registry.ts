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

interface CollaborationGroup {
  readonly groupId: string
  readonly documentId: string
  readonly createdBy: string
  readonly createdAt: number
  name: string
  readonly members: Map<string, CollaborationMember>
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
      members: new Map()
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
