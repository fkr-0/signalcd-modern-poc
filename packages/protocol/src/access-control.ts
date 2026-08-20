import { Reader, Writer } from './codec'
import { ProtocolValidationError } from './validation'

const CONTROL_VERSION = 1
const SIGNATURE_BYTES = 64
const MAX_ID_BYTES = 512
const encoder = new TextEncoder()

export type DocumentRole = 'reader' | 'writer' | 'admin'

export interface DocumentParticipant {
  readonly participantId: string
  readonly role: DocumentRole
  readonly displayName?: string
  readonly active: boolean
}

export interface DocumentAccessState {
  readonly selfRole: DocumentRole
  readonly participants: readonly DocumentParticipant[]
  readonly archived: boolean
  readonly deleted: boolean
  readonly revision: number
}

export interface MembershipPayload {
  readonly action: 'invite' | 'remove' | 'role_change'
  readonly targetUserId: string
  readonly role: DocumentRole | null
  readonly actorUserId: string
  readonly timestamp: number
  readonly signature: Uint8Array
}

export interface ArchivePayload {
  readonly action: 'archive' | 'unarchive'
  readonly actorUserId: string
  readonly timestamp: number
  readonly signature: Uint8Array
}

export interface DeletePayload {
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
  const writer = new Writer()
  writer.u8(CONTROL_VERSION)
  writer.u8(MEMBERSHIP_ACTION[value.action])
  writer.string(value.targetUserId)
  writer.u8(value.role === null ? 0 : ROLE_CODE[value.role])
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  writeSignature(writer, value.signature)
  return writer.finish()
}

export function decodeMembershipPayload(bytes: Uint8Array): MembershipPayload {
  const reader = payloadReader(bytes)
  expectVersion(reader)
  const action = membershipAction(reader.u8())
  const targetUserId = id(reader.string(), 'membership.targetUserId')
  const role = roleFromCode(reader.u8(), 'membership.role')
  const actorUserId = id(reader.string(), 'membership.actorUserId')
  const timestamp = reader.u64()
  const signature = readSignature(reader)
  expectDone(reader, 'membership')
  const value = {
    action,
    targetUserId,
    role,
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
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  writeSignature(writer, value.signature)
  return writer.finish()
}

export function decodeArchivePayload(bytes: Uint8Array): ArchivePayload {
  const reader = payloadReader(bytes)
  expectVersion(reader)
  const action = archiveAction(reader.u8())
  const actorUserId = id(reader.string(), 'archive.actorUserId')
  const timestamp = reader.u64()
  const signature = readSignature(reader)
  expectDone(reader, 'archive')
  return { action, actorUserId, timestamp, signature }
}

export function encodeDeletePayload(value: DeletePayload): Uint8Array {
  validateDelete(value)
  const writer = new Writer()
  writer.u8(CONTROL_VERSION)
  writer.u8(1)
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  writeSignature(writer, value.signature)
  return writer.finish()
}

export function decodeDeletePayload(bytes: Uint8Array): DeletePayload {
  const reader = payloadReader(bytes)
  expectVersion(reader)
  if (reader.u8() !== 1) throw new ProtocolValidationError('delete.action', 'is unsupported')
  const actorUserId = id(reader.string(), 'delete.actorUserId')
  const timestamp = reader.u64()
  const signature = readSignature(reader)
  expectDone(reader, 'delete')
  return { action: 'delete', actorUserId, timestamp, signature }
}

export function membershipPayloadSigningBytes(
  value: Omit<MembershipPayload, 'signature'>
): Uint8Array {
  const signature = new Uint8Array(SIGNATURE_BYTES)
  validateMembership({ ...value, signature })
  const writer = new Writer()
  writer.string('e2e-col:membership:v1')
  writer.u8(MEMBERSHIP_ACTION[value.action])
  writer.string(value.targetUserId)
  writer.u8(value.role === null ? 0 : ROLE_CODE[value.role])
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  return writer.finish()
}

export function archivePayloadSigningBytes(value: Omit<ArchivePayload, 'signature'>): Uint8Array {
  validateArchive({ ...value, signature: new Uint8Array(SIGNATURE_BYTES) })
  const writer = new Writer()
  writer.string('e2e-col:archive:v1')
  writer.u8(ARCHIVE_ACTION[value.action])
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  return writer.finish()
}

export function deletePayloadSigningBytes(value: Omit<DeletePayload, 'signature'>): Uint8Array {
  validateDelete({ ...value, signature: new Uint8Array(SIGNATURE_BYTES) })
  const writer = new Writer()
  writer.string('e2e-col:delete:v1')
  writer.u8(1)
  writer.string(value.actorUserId)
  writer.u64(value.timestamp)
  return writer.finish()
}

function validateMembership(value: MembershipPayload): void {
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
}

function validateArchive(value: ArchivePayload): void {
  if (!(value.action in ARCHIVE_ACTION))
    throw new ProtocolValidationError('archive.action', 'is unsupported')
  id(value.actorUserId, 'archive.actorUserId')
  timestamp(value.timestamp, 'archive.timestamp')
  signature(value.signature, 'archive.signature')
}

function validateDelete(value: DeletePayload): void {
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
  if (reader.u8() !== CONTROL_VERSION)
    throw new ProtocolValidationError('control.version', 'is unsupported')
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
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ProtocolValidationError(path, 'must be a non-negative safe integer')
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
