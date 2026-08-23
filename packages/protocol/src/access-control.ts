import { Reader, Writer } from './codec'
import { ProtocolValidationError } from './validation'

const CONTROL_VERSION = 2
const SIGNATURE_BYTES = 64
export const AUTHORIZATION_COMMITMENT_BYTES = 32
const MAX_ID_BYTES = 512
const encoder = new TextEncoder()

export type DocumentRole = 'reader' | 'writer' | 'admin'

export interface DocumentParticipant {
  readonly participantId: string
  readonly role: DocumentRole
  readonly displayName?: string
  readonly active: boolean
  /** Hex SHA-256 commitment to the participant's Ed25519 identity key when cryptographically bound. */
  readonly identityKeyCommitment?: string
}

export interface DocumentAccessState {
  readonly selfRole: DocumentRole
  readonly participants: readonly DocumentParticipant[]
  readonly archived: boolean
  readonly deleted: boolean
  readonly revision: number
  /**
   * Replay-safe authorization head. Absent only on legacy persisted state that
   * has not yet been migrated by a current client.
   */
  readonly authorizationHead?: string
  /**
   * Commitment to a creator-signed shared authorization root. This is absent
   * for legacy zero-genesis/local-anchor state so legacy ACLs cannot be
   * mistaken for cryptographically shared bootstrap authority.
   */
  readonly authorizationRoot?: string
  /** A detected valid fork freezes authorization/document mutation fail-closed. */
  readonly authorizationStatus?: 'active' | 'conflict'
}

export interface MembershipPayload {
  readonly documentId: string
  readonly revision: number
  readonly predecessor: Uint8Array
  readonly action: 'invite' | 'remove' | 'role_change'
  readonly targetUserId: string
  readonly role: DocumentRole | null
  /** Present on authenticated invite-v3 controls; absent on legacy membership-v2. */
  readonly targetIdentityKeyCommitment?: Uint8Array
  readonly actorUserId: string
  readonly timestamp: number
  readonly signature: Uint8Array
}

export interface ArchivePayload {
  readonly documentId: string
  readonly revision: number
  readonly predecessor: Uint8Array
  readonly action: 'archive' | 'unarchive'
  readonly actorUserId: string
  readonly timestamp: number
  readonly signature: Uint8Array
}

export interface DeletePayload {
  readonly documentId: string
  readonly revision: number
  readonly predecessor: Uint8Array
  readonly action: 'delete'
  readonly actorUserId: string
  readonly timestamp: number
  readonly signature: Uint8Array
}

const MEMBERSHIP_ACTION = { invite: 1, remove: 2, role_change: 3 } as const
const ROLE_CODE = { reader: 1, writer: 2, admin: 3 } as const
const ARCHIVE_ACTION = { archive: 1, unarchive: 2 } as const

export function encodeMembershipPayload(value: MembershipPayload): Uint8Array {
  validateMembership(value)
  const version = value.targetIdentityKeyCommitment === undefined ? CONTROL_VERSION : 3
  const writer = new Writer()
  writer.u8(version)
  writer.u8(MEMBERSHIP_ACTION[value.action])
  writeAuthorizationProof(writer, value)
  writer.string(value.targetUserId)
  writer.u8(value.role === null ? 0 : ROLE_CODE[value.role])
  if (version === 3) writer.raw(value.targetIdentityKeyCommitment!)
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  writeSignature(writer, value.signature)
  return writer.finish()
}

export function decodeMembershipPayload(bytes: Uint8Array): MembershipPayload {
  const reader = payloadReader(bytes)
  const version = reader.u8()
  if (version !== CONTROL_VERSION && version !== 3) {
    const detail = version === 1 ? 'legacy v1 controls are not replay-safe' : 'is unsupported'
    throw new ProtocolValidationError('control.version', detail)
  }
  const action = membershipAction(reader.u8())
  const proof = readAuthorizationProof(reader, 'membership')
  const targetUserId = id(reader.string(), 'membership.targetUserId')
  const role = roleFromCode(reader.u8(), 'membership.role')
  const targetIdentityKeyCommitment =
    version === 3 ? reader.raw(AUTHORIZATION_COMMITMENT_BYTES) : undefined
  const actorUserId = id(reader.string(), 'membership.actorUserId')
  const timestamp = reader.u64()
  const signature = readSignature(reader)
  expectDone(reader, 'membership')
  const value = {
    ...proof,
    action,
    targetUserId,
    role,
    ...(targetIdentityKeyCommitment === undefined ? {} : { targetIdentityKeyCommitment }),
    actorUserId,
    timestamp,
    signature
  } as MembershipPayload
  validateMembership(value)
  return value
}

export function encodeArchivePayload(value: ArchivePayload): Uint8Array {
  validateArchive(value)
  const writer = new Writer()
  writer.u8(CONTROL_VERSION)
  writer.u8(ARCHIVE_ACTION[value.action])
  writeAuthorizationProof(writer, value)
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  writeSignature(writer, value.signature)
  return writer.finish()
}

export function decodeArchivePayload(bytes: Uint8Array): ArchivePayload {
  const reader = payloadReader(bytes)
  expectVersion(reader)
  const action = archiveAction(reader.u8())
  const proof = readAuthorizationProof(reader, 'archive')
  const actorUserId = id(reader.string(), 'archive.actorUserId')
  const timestamp = reader.u64()
  const signature = readSignature(reader)
  expectDone(reader, 'archive')
  return { ...proof, action, actorUserId, timestamp, signature }
}

export function encodeDeletePayload(value: DeletePayload): Uint8Array {
  validateDelete(value)
  const writer = new Writer()
  writer.u8(CONTROL_VERSION)
  writer.u8(1)
  writeAuthorizationProof(writer, value)
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  writeSignature(writer, value.signature)
  return writer.finish()
}

export function decodeDeletePayload(bytes: Uint8Array): DeletePayload {
  const reader = payloadReader(bytes)
  expectVersion(reader)
  if (reader.u8() !== 1) throw new ProtocolValidationError('delete.action', 'is unsupported')
  const proof = readAuthorizationProof(reader, 'delete')
  const actorUserId = id(reader.string(), 'delete.actorUserId')
  const timestamp = reader.u64()
  const signature = readSignature(reader)
  expectDone(reader, 'delete')
  return { ...proof, action: 'delete', actorUserId, timestamp, signature }
}

export function membershipPayloadSigningBytes(
  value: Omit<MembershipPayload, 'signature'>
): Uint8Array {
  const signature = new Uint8Array(SIGNATURE_BYTES)
  validateMembership({ ...value, signature })
  const writer = new Writer()
  writer.string(
    value.targetIdentityKeyCommitment === undefined
      ? 'e2e-col:membership:v2'
      : 'e2e-col:membership:v3'
  )
  writer.u8(MEMBERSHIP_ACTION[value.action])
  writeAuthorizationProof(writer, value)
  writer.string(value.targetUserId)
  writer.u8(value.role === null ? 0 : ROLE_CODE[value.role])
  if (value.targetIdentityKeyCommitment !== undefined) writer.raw(value.targetIdentityKeyCommitment)
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  return writer.finish()
}

export function archivePayloadSigningBytes(value: Omit<ArchivePayload, 'signature'>): Uint8Array {
  validateArchive({ ...value, signature: new Uint8Array(SIGNATURE_BYTES) })
  const writer = new Writer()
  writer.string('e2e-col:archive:v2')
  writer.u8(ARCHIVE_ACTION[value.action])
  writeAuthorizationProof(writer, value)
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  return writer.finish()
}

export function deletePayloadSigningBytes(value: Omit<DeletePayload, 'signature'>): Uint8Array {
  validateDelete({ ...value, signature: new Uint8Array(SIGNATURE_BYTES) })
  const writer = new Writer()
  writer.string('e2e-col:delete:v2')
  writer.u8(1)
  writeAuthorizationProof(writer, value)
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  return writer.finish()
}

function validateMembership(value: MembershipPayload): void {
  validateAuthorizationProof(value, 'membership')
  id(value.targetUserId, 'membership.targetUserId')
  id(value.actorUserId, 'membership.actorUserId')
  timestamp(value.timestamp, 'membership.timestamp')
  signature(value.signature, 'membership.signature')
  if (!(value.action in MEMBERSHIP_ACTION))
    throw new ProtocolValidationError('membership.action', 'is unsupported')
  if (value.action === 'remove') {
    if (value.role !== null)
      throw new ProtocolValidationError('membership.role', 'must be null for remove')
  } else if (value.role === null || !(value.role in ROLE_CODE)) {
    throw new ProtocolValidationError('membership.role', 'must be reader, writer, or admin')
  }
  if (value.targetIdentityKeyCommitment !== undefined)
    predecessor(value.targetIdentityKeyCommitment, 'membership.targetIdentityKeyCommitment')
  if (value.action !== 'invite' && value.targetIdentityKeyCommitment !== undefined)
    throw new ProtocolValidationError(
      'membership.targetIdentityKeyCommitment',
      'is only valid for invite'
    )
}

function validateArchive(value: ArchivePayload): void {
  validateAuthorizationProof(value, 'archive')
  if (!(value.action in ARCHIVE_ACTION))
    throw new ProtocolValidationError('archive.action', 'is unsupported')
  id(value.actorUserId, 'archive.actorUserId')
  timestamp(value.timestamp, 'archive.timestamp')
  signature(value.signature, 'archive.signature')
}

function validateDelete(value: DeletePayload): void {
  validateAuthorizationProof(value, 'delete')
  if (value.action !== 'delete')
    throw new ProtocolValidationError('delete.action', 'must be delete')
  id(value.actorUserId, 'delete.actorUserId')
  timestamp(value.timestamp, 'delete.timestamp')
  signature(value.signature, 'delete.signature')
}

function payloadReader(bytes: Uint8Array): Reader {
  if (!(bytes instanceof Uint8Array))
    throw new ProtocolValidationError('control', 'encoded payload must be a Uint8Array')
  return new Reader(bytes)
}

function expectVersion(reader: Reader): void {
  const version = reader.u8()
  if (version !== CONTROL_VERSION) {
    const detail = version === 1 ? 'legacy v1 controls are not replay-safe' : 'is unsupported'
    throw new ProtocolValidationError('control.version', detail)
  }
}

export function authorizationGenesisPredecessor(): Uint8Array {
  return new Uint8Array(AUTHORIZATION_COMMITMENT_BYTES)
}

export async function authorizationControlCommitment(
  signingBytes: Uint8Array
): Promise<Uint8Array> {
  if (!(signingBytes instanceof Uint8Array))
    throw new ProtocolValidationError('authorization.commitment', 'input must be a Uint8Array')
  const input = signingBytes.slice().buffer as ArrayBuffer
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input))
}

export async function authorizationStateCommitment(
  documentId: string,
  state: DocumentAccessState
): Promise<Uint8Array> {
  id(documentId, 'authorization.documentId')
  revision(state.revision, 'authorization.revision', true)
  const participants = [...state.participants].sort((left, right) =>
    left.participantId.localeCompare(right.participantId)
  )
  if (participants.length > 0xffff)
    throw new ProtocolValidationError(
      'authorization.participants',
      'contains too many participants'
    )
  const keyed = participants.some((participant) => participant.identityKeyCommitment !== undefined)
  const writer = new Writer()
  writer.string(keyed ? 'e2e-col:authorization-state:v3' : 'e2e-col:authorization-state:v2')
  writer.string(documentId)
  writer.u64(state.revision)
  writer.u8(state.archived ? 1 : 0)
  writer.u8(state.deleted ? 1 : 0)
  writer.u16(participants.length)
  for (const participant of participants) {
    id(participant.participantId, 'authorization.participantId')
    writer.string(participant.participantId)
    writer.u8(ROLE_CODE[participant.role])
    writer.u8(participant.active ? 1 : 0)
    if (keyed) {
      writer.u8(participant.identityKeyCommitment === undefined ? 0 : 1)
      if (participant.identityKeyCommitment !== undefined)
        writer.raw(decodeAuthorizationCommitment(participant.identityKeyCommitment))
    }
  }
  return authorizationControlCommitment(writer.finish())
}

export function encodeAuthorizationCommitment(value: Uint8Array): string {
  predecessor(value, 'authorization.commitment')
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function decodeAuthorizationCommitment(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value))
    throw new ProtocolValidationError(
      'authorization.commitment',
      `must be ${AUTHORIZATION_COMMITMENT_BYTES} bytes of hexadecimal`
    )
  return Uint8Array.from({ length: AUTHORIZATION_COMMITMENT_BYTES }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  )
}

function writeAuthorizationProof(
  writer: Writer,
  value: Pick<MembershipPayload, 'documentId' | 'revision' | 'predecessor'>
): void {
  writer.string(value.documentId)
  writer.u64(value.revision)
  writer.raw(value.predecessor)
}

function readAuthorizationProof(
  reader: Reader,
  path: string
): Pick<MembershipPayload, 'documentId' | 'revision' | 'predecessor'> {
  const documentId = id(reader.string(), `${path}.documentId`)
  const valueRevision = reader.u64()
  revision(valueRevision, `${path}.revision`)
  const valuePredecessor = reader.raw(AUTHORIZATION_COMMITMENT_BYTES)
  predecessor(valuePredecessor, `${path}.predecessor`)
  return { documentId, revision: valueRevision, predecessor: valuePredecessor }
}

function validateAuthorizationProof(
  value: Pick<MembershipPayload, 'documentId' | 'revision' | 'predecessor'>,
  path: string
): void {
  id(value.documentId, `${path}.documentId`)
  revision(value.revision, `${path}.revision`)
  predecessor(value.predecessor, `${path}.predecessor`)
}

function predecessor(value: Uint8Array, path: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== AUTHORIZATION_COMMITMENT_BYTES)
    throw new ProtocolValidationError(
      path,
      `must be a ${AUTHORIZATION_COMMITMENT_BYTES}-byte Uint8Array`
    )
}

function writeSignature(writer: Writer, value: Uint8Array): void {
  writer.u16(value.byteLength)
  writer.raw(value)
}

function readSignature(reader: Reader): Uint8Array {
  const length = reader.u16()
  if (length !== SIGNATURE_BYTES)
    throw new ProtocolValidationError('control.signature', `must be ${SIGNATURE_BYTES} bytes`)
  return reader.raw(length)
}

function signature(value: Uint8Array, path: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== SIGNATURE_BYTES)
    throw new ProtocolValidationError(path, `must be a ${SIGNATURE_BYTES}-byte Uint8Array`)
}

function id(value: string, path: string): string {
  const size = encoder.encode(value).byteLength
  if (value.length === 0 || size > MAX_ID_BYTES)
    throw new ProtocolValidationError(
      path,
      `must contain between 1 and ${MAX_ID_BYTES} UTF-8 bytes`
    )
  return value
}

function timestamp(value: number, path: string): void {
  revision(value, path, true)
}

function revision(value: number, path: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
    throw new ProtocolValidationError(
      path,
      allowZero ? 'must be a non-negative safe integer' : 'must be a positive safe integer'
    )
}

function membershipAction(code: number): MembershipPayload['action'] {
  if (code === 1) return 'invite'
  if (code === 2) return 'remove'
  if (code === 3) return 'role_change'
  throw new ProtocolValidationError('membership.action', 'is unsupported')
}

function archiveAction(code: number): ArchivePayload['action'] {
  if (code === 1) return 'archive'
  if (code === 2) return 'unarchive'
  throw new ProtocolValidationError('archive.action', 'is unsupported')
}

function roleFromCode(code: number, path: string): DocumentRole | null {
  if (code === 0) return null
  if (code === 1) return 'reader'
  if (code === 2) return 'writer'
  if (code === 3) return 'admin'
  throw new ProtocolValidationError(path, 'is unsupported')
}

function expectDone(reader: Reader, path: string): void {
  if (!reader.done()) throw new ProtocolValidationError(path, 'contains trailing bytes')
}
