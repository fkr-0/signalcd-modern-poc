import type { DocumentRole } from './access-control'
import { AUTHORIZATION_COMMITMENT_BYTES, authorizationControlCommitment } from './access-control'
import { Reader, Writer } from './codec'
import { ProtocolValidationError } from './validation'

const ROOT_VERSION = 1
const RESOLUTION_VERSION = 1
const SIGNATURE_BYTES = 64
const MAX_ID_BYTES = 512
const MAX_PARTICIPANTS = 0xffff
const MAX_RESOLUTION_CONTROLS = 0xffff
const encoder = new TextEncoder()

const ROLE_CODE: Readonly<Record<DocumentRole, number>> = { reader: 1, writer: 2, admin: 3 }

export interface AuthorizationRootParticipant {
  readonly participantId: string
  readonly role: DocumentRole
  readonly active: boolean
  /** SHA-256 commitment to the participant's Ed25519 identity public key. */
  readonly identityKeyCommitment: Uint8Array
}

export interface AuthorizationRootPayload {
  readonly documentId: string
  readonly creatorUserId: string
  readonly participants: readonly AuthorizationRootParticipant[]
  readonly signature: Uint8Array
}

export interface ForkResolutionApproval {
  readonly actorUserId: string
  readonly signature: Uint8Array
}

export interface ForkResolutionPayload {
  readonly documentId: string
  readonly commonPredecessor: Uint8Array
  readonly forkRevision: number
  readonly competingControlIds: readonly Uint8Array[]
  readonly chosenControlId: Uint8Array
  readonly resolutionRevision: number
  readonly resultingStateCommitment: Uint8Array
  readonly approvals: readonly ForkResolutionApproval[]
}

export function authorizationRootSigningBytes(
  value: Omit<AuthorizationRootPayload, 'signature'>
): Uint8Array {
  const participants = canonicalRootParticipants(value.participants)
  validateId(value.documentId, 'authorizationRoot.documentId')
  validateId(value.creatorUserId, 'authorizationRoot.creatorUserId')
  validateRootSemantics(value.creatorUserId, participants)
  const writer = new Writer()
  writer.string('e2e-col:authorization-root:v1')
  writer.string(value.documentId)
  writer.string(value.creatorUserId)
  writeRootParticipants(writer, participants)
  return writer.finish()
}

export async function authorizationRootCommitment(
  value: Omit<AuthorizationRootPayload, 'signature'>
): Promise<Uint8Array> {
  return authorizationControlCommitment(authorizationRootSigningBytes(value))
}

export function encodeAuthorizationRootPayload(value: AuthorizationRootPayload): Uint8Array {
  const participants = canonicalRootParticipants(value.participants)
  const unsigned = {
    documentId: value.documentId,
    creatorUserId: value.creatorUserId,
    participants
  }
  authorizationRootSigningBytes(unsigned)
  validateSignature(value.signature, 'authorizationRoot.signature')
  const writer = new Writer()
  writer.u8(ROOT_VERSION)
  writer.string(value.documentId)
  writer.string(value.creatorUserId)
  writeRootParticipants(writer, participants)
  writeSignature(writer, value.signature)
  return writer.finish()
}

export function decodeAuthorizationRootPayload(bytes: Uint8Array): AuthorizationRootPayload {
  const reader = payloadReader(bytes, 'authorizationRoot')
  if (reader.u8() !== ROOT_VERSION)
    throw new ProtocolValidationError('authorizationRoot.version', 'is unsupported')
  const documentId = validateId(reader.string(), 'authorizationRoot.documentId')
  const creatorUserId = validateId(reader.string(), 'authorizationRoot.creatorUserId')
  const participants = readRootParticipants(reader)
  const signature = readSignature(reader, 'authorizationRoot.signature')
  expectDone(reader, 'authorizationRoot')
  validateRootSemantics(creatorUserId, participants)
  return { documentId, creatorUserId, participants, signature }
}

export function forkResolutionSigningBytes(
  value: Omit<ForkResolutionPayload, 'approvals'>
): Uint8Array {
  validateId(value.documentId, 'forkResolution.documentId')
  validateCommitment(value.commonPredecessor, 'forkResolution.commonPredecessor')
  validatePositiveRevision(value.forkRevision, 'forkResolution.forkRevision')
  validatePositiveRevision(value.resolutionRevision, 'forkResolution.resolutionRevision')
  if (value.resolutionRevision !== value.forkRevision + 1)
    throw new ProtocolValidationError(
      'forkResolution.resolutionRevision',
      'must equal forkRevision + 1'
    )
  const competingControlIds = canonicalCommitments(
    value.competingControlIds,
    'forkResolution.competingControlIds'
  )
  if (competingControlIds.length < 2)
    throw new ProtocolValidationError(
      'forkResolution.competingControlIds',
      'must contain at least two distinct controls'
    )
  validateCommitment(value.chosenControlId, 'forkResolution.chosenControlId')
  if (!competingControlIds.some((entry) => equalBytes(entry, value.chosenControlId)))
    throw new ProtocolValidationError(
      'forkResolution.chosenControlId',
      'must identify one competing control'
    )
  validateCommitment(value.resultingStateCommitment, 'forkResolution.resultingStateCommitment')
  const writer = new Writer()
  writer.string('e2e-col:fork-resolution:v1')
  writer.string(value.documentId)
  writer.raw(value.commonPredecessor)
  writer.u64(value.forkRevision)
  writer.u16(competingControlIds.length)
  for (const controlId of competingControlIds) writer.raw(controlId)
  writer.raw(value.chosenControlId)
  writer.u64(value.resolutionRevision)
  writer.raw(value.resultingStateCommitment)
  return writer.finish()
}

export async function forkResolutionCommitment(
  value: Omit<ForkResolutionPayload, 'approvals'>
): Promise<Uint8Array> {
  return authorizationControlCommitment(forkResolutionSigningBytes(value))
}

export function encodeForkResolutionPayload(value: ForkResolutionPayload): Uint8Array {
  const unsigned = resolutionUnsigned(value)
  const signingBytes = forkResolutionSigningBytes(unsigned)
  void signingBytes
  const competingControlIds = canonicalCommitments(
    value.competingControlIds,
    'forkResolution.competingControlIds'
  )
  const approvals = canonicalApprovals(value.approvals)
  if (approvals.length < 1)
    throw new ProtocolValidationError('forkResolution.approvals', 'must not be empty')
  const writer = new Writer()
  writer.u8(RESOLUTION_VERSION)
  writer.string(value.documentId)
  writer.raw(value.commonPredecessor)
  writer.u64(value.forkRevision)
  writer.u16(competingControlIds.length)
  for (const controlId of competingControlIds) writer.raw(controlId)
  writer.raw(value.chosenControlId)
  writer.u64(value.resolutionRevision)
  writer.raw(value.resultingStateCommitment)
  writer.u16(approvals.length)
  for (const approval of approvals) {
    writer.string(approval.actorUserId)
    writeSignature(writer, approval.signature)
  }
  return writer.finish()
}

export function decodeForkResolutionPayload(bytes: Uint8Array): ForkResolutionPayload {
  const reader = payloadReader(bytes, 'forkResolution')
  if (reader.u8() !== RESOLUTION_VERSION)
    throw new ProtocolValidationError('forkResolution.version', 'is unsupported')
  const documentId = validateId(reader.string(), 'forkResolution.documentId')
  const commonPredecessor = reader.raw(AUTHORIZATION_COMMITMENT_BYTES)
  const forkRevision = reader.u64()
  const count = reader.u16()
  if (count < 2 || count > MAX_RESOLUTION_CONTROLS)
    throw new ProtocolValidationError(
      'forkResolution.competingControlIds',
      'must contain at least two controls'
    )
  const competingControlIds = Array.from({ length: count }, () =>
    reader.raw(AUTHORIZATION_COMMITMENT_BYTES)
  )
  const chosenControlId = reader.raw(AUTHORIZATION_COMMITMENT_BYTES)
  const resolutionRevision = reader.u64()
  const resultingStateCommitment = reader.raw(AUTHORIZATION_COMMITMENT_BYTES)
  const approvalCount = reader.u16()
  const approvals = Array.from({ length: approvalCount }, () => ({
    actorUserId: validateId(reader.string(), 'forkResolution.approval.actorUserId'),
    signature: readSignature(reader, 'forkResolution.approval.signature')
  }))
  expectDone(reader, 'forkResolution')
  const value = {
    documentId,
    commonPredecessor,
    forkRevision,
    competingControlIds,
    chosenControlId,
    resolutionRevision,
    resultingStateCommitment,
    approvals
  }
  forkResolutionSigningBytes(resolutionUnsigned(value))
  assertCanonicalCommitments(competingControlIds, 'forkResolution.competingControlIds')
  assertCanonicalApprovals(approvals)
  if (approvals.length < 1)
    throw new ProtocolValidationError('forkResolution.approvals', 'must not be empty')
  return value
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

function canonicalRootParticipants(
  participants: readonly AuthorizationRootParticipant[]
): AuthorizationRootParticipant[] {
  if (participants.length < 1 || participants.length > MAX_PARTICIPANTS)
    throw new ProtocolValidationError('authorizationRoot.participants', 'has an invalid size')
  const output = participants
    .map((participant) => {
      validateId(participant.participantId, 'authorizationRoot.participantId')
      if (!(participant.role in ROLE_CODE))
        throw new ProtocolValidationError('authorizationRoot.role', 'is unsupported')
      validateCommitment(
        participant.identityKeyCommitment,
        'authorizationRoot.identityKeyCommitment'
      )
      return {
        ...participant,
        identityKeyCommitment: new Uint8Array(participant.identityKeyCommitment)
      }
    })
    .sort((left, right) => left.participantId.localeCompare(right.participantId))
  for (let index = 1; index < output.length; index += 1)
    if (output[index - 1]!.participantId === output[index]!.participantId)
      throw new ProtocolValidationError(
        'authorizationRoot.participants',
        'contains duplicate participant ids'
      )
  return output
}

function validateRootSemantics(
  creatorUserId: string,
  participants: readonly AuthorizationRootParticipant[]
): void {
  const creator = participants.find((participant) => participant.participantId === creatorUserId)
  if (!creator?.active || creator.role !== 'admin')
    throw new ProtocolValidationError(
      'authorizationRoot.creatorUserId',
      'must identify an active admin participant'
    )
  if (!participants.some((participant) => participant.active && participant.role === 'admin'))
    throw new ProtocolValidationError(
      'authorizationRoot.participants',
      'must retain an active admin'
    )
}

function writeRootParticipants(
  writer: Writer,
  participants: readonly AuthorizationRootParticipant[]
): void {
  writer.u16(participants.length)
  for (const participant of participants) {
    writer.string(participant.participantId)
    writer.u8(ROLE_CODE[participant.role])
    writer.u8(participant.active ? 1 : 0)
    writer.raw(participant.identityKeyCommitment)
  }
}

function readRootParticipants(reader: Reader): AuthorizationRootParticipant[] {
  const count = reader.u16()
  if (count < 1 || count > MAX_PARTICIPANTS)
    throw new ProtocolValidationError('authorizationRoot.participants', 'has an invalid size')
  const participants = Array.from({ length: count }, () => {
    const participantId = validateId(reader.string(), 'authorizationRoot.participantId')
    const role = roleFromCode(reader.u8())
    const activeCode = reader.u8()
    if (activeCode !== 0 && activeCode !== 1)
      throw new ProtocolValidationError('authorizationRoot.active', 'must be encoded as 0 or 1')
    return {
      participantId,
      role,
      active: activeCode === 1,
      identityKeyCommitment: reader.raw(AUTHORIZATION_COMMITMENT_BYTES)
    }
  })
  const canonical = canonicalRootParticipants(participants)
  if (
    canonical.some(
      (participant, index) => participant.participantId !== participants[index]!.participantId
    )
  )
    throw new ProtocolValidationError(
      'authorizationRoot.participants',
      'must be sorted by participant id'
    )
  return participants
}

function canonicalCommitments(values: readonly Uint8Array[], path: string): Uint8Array[] {
  if (values.length > MAX_RESOLUTION_CONTROLS)
    throw new ProtocolValidationError(path, 'contains too many controls')
  const encoded = values.map((value) => {
    validateCommitment(value, path)
    return { bytes: new Uint8Array(value), hex: bytesHex(value) }
  })
  encoded.sort((left, right) => left.hex.localeCompare(right.hex))
  for (let index = 1; index < encoded.length; index += 1)
    if (encoded[index - 1]!.hex === encoded[index]!.hex)
      throw new ProtocolValidationError(path, 'contains duplicate controls')
  return encoded.map((entry) => entry.bytes)
}

function canonicalApprovals(values: readonly ForkResolutionApproval[]): ForkResolutionApproval[] {
  const output = values
    .map((approval) => {
      validateId(approval.actorUserId, 'forkResolution.approval.actorUserId')
      validateSignature(approval.signature, 'forkResolution.approval.signature')
      return { actorUserId: approval.actorUserId, signature: new Uint8Array(approval.signature) }
    })
    .sort((left, right) => left.actorUserId.localeCompare(right.actorUserId))
  for (let index = 1; index < output.length; index += 1)
    if (output[index - 1]!.actorUserId === output[index]!.actorUserId)
      throw new ProtocolValidationError('forkResolution.approvals', 'contains duplicate actors')
  return output
}

function assertCanonicalCommitments(values: readonly Uint8Array[], path: string): void {
  const canonical = canonicalCommitments(values, path)
  if (canonical.some((value, index) => !equalBytes(value, values[index]!)))
    throw new ProtocolValidationError(path, 'must be sorted lexicographically')
}

function assertCanonicalApprovals(values: readonly ForkResolutionApproval[]): void {
  const canonical = canonicalApprovals(values)
  if (canonical.some((value, index) => value.actorUserId !== values[index]!.actorUserId))
    throw new ProtocolValidationError('forkResolution.approvals', 'must be sorted by actor id')
}

function payloadReader(bytes: Uint8Array, path: string): Reader {
  if (!(bytes instanceof Uint8Array))
    throw new ProtocolValidationError(path, 'encoded payload must be a Uint8Array')
  return new Reader(bytes)
}

function validateCommitment(value: Uint8Array, path: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== AUTHORIZATION_COMMITMENT_BYTES)
    throw new ProtocolValidationError(
      path,
      `must be a ${AUTHORIZATION_COMMITMENT_BYTES}-byte Uint8Array`
    )
}

function validateSignature(value: Uint8Array, path: string): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== SIGNATURE_BYTES)
    throw new ProtocolValidationError(path, `must be a ${SIGNATURE_BYTES}-byte Uint8Array`)
}

function writeSignature(writer: Writer, signature: Uint8Array): void {
  writer.u16(signature.byteLength)
  writer.raw(signature)
}

function readSignature(reader: Reader, path: string): Uint8Array {
  const length = reader.u16()
  if (length !== SIGNATURE_BYTES)
    throw new ProtocolValidationError(path, `must be ${SIGNATURE_BYTES} bytes`)
  return reader.raw(length)
}

function validateId(value: string, path: string): string {
  const size = encoder.encode(value).byteLength
  if (value.length === 0 || size > MAX_ID_BYTES)
    throw new ProtocolValidationError(
      path,
      `must contain between 1 and ${MAX_ID_BYTES} UTF-8 bytes`
    )
  return value
}

function validatePositiveRevision(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ProtocolValidationError(path, 'must be a positive safe integer')
}

function roleFromCode(code: number): DocumentRole {
  if (code === 1) return 'reader'
  if (code === 2) return 'writer'
  if (code === 3) return 'admin'
  throw new ProtocolValidationError('authorizationRoot.role', 'is unsupported')
}

function expectDone(reader: Reader, path: string): void {
  if (!reader.done()) throw new ProtocolValidationError(path, 'contains trailing bytes')
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((byte, index) => byte === right[index])
}

function bytesHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
