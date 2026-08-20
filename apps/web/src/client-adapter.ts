import type { ClientIdentityAdapter } from '@e2e-col/client'
import type { IdentityClient, UserIdentity } from '@e2e-col/identity'
import {
  type DocumentParticipant,
  type DocumentRole,
  decodeEncryptedEnvelope,
  encodeEncryptedEnvelope,
  encodeEnvelope
} from '@e2e-col/protocol'
import { encodeMockSignalFanoutFrame } from '@e2e-col/transport'
import { bytesToHex, type InspectorEventStore } from './inspector-events'

export interface CollaborationGroupMemberView {
  readonly user_id: string
  readonly phone_number: string
  readonly display_name: string
  readonly role: DocumentRole
  readonly joined_at?: number
}

function envelopeMetadata(envelope: {
  readonly version: number
  readonly documentId: string
  readonly messageId: string
  readonly senderId: string
  readonly kind: string
  readonly createdAt: number
  readonly sequence?: number
  readonly payload: Uint8Array
}): Record<string, unknown> {
  return {
    version: envelope.version,
    documentId: envelope.documentId,
    messageId: envelope.messageId,
    senderId: envelope.senderId,
    kind: envelope.kind,
    createdAt: envelope.createdAt,
    ...(envelope.sequence === undefined ? {} : { sequence: envelope.sequence }),
    payloadBytes: envelope.payload.byteLength,
    payloadPolicy: 'plaintext payload omitted from inspector diagnostics'
  }
}

export interface CollaborationGroupView {
  readonly group_id: string
  readonly document_id: string
  readonly name: string
  readonly members: readonly CollaborationGroupMemberView[]
}

interface BrowserIdentityAdapterOptions {
  readonly identity: UserIdentity
  readonly identityClient: IdentityClient
  readonly baseUrl: string
  readonly groupId?: string
  readonly inspector?: InspectorEventStore
}

export function createBrowserIdentityAdapter(
  options: BrowserIdentityAdapterOptions
): ClientIdentityAdapter {
  const membersByUser = new Map<string, CollaborationGroupMemberView>()

  async function group(): Promise<CollaborationGroupView> {
    if (!options.groupId) throw new Error('document is not bound to a collaboration group')
    const value = await getGroup({
      baseUrl: options.baseUrl,
      groupId: options.groupId,
      identity: options.identity
    })
    for (const member of value.members) membersByUser.set(member.user_id, member)
    return value
  }

  const base: ClientIdentityAdapter = {
    async signControl(bytes) {
      return new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          options.identity.identityKeyPair.privateKey,
          bytes.buffer as ArrayBuffer
        )
      )
    },
    async verifyControl(actorUserId, bytes, signature) {
      if (actorUserId === options.identity.userId) {
        return crypto.subtle.verify(
          { name: 'Ed25519' },
          options.identity.identityKeyPair.publicKey,
          signature.buffer as ArrayBuffer,
          bytes.buffer as ArrayBuffer
        )
      }
      let member = membersByUser.get(actorUserId)
      if (!member && options.groupId) {
        await group()
        member = membersByUser.get(actorUserId)
      }
      if (!member) return false
      const remote = await options.identityClient.fetchRemoteIdentity(
        member.phone_number,
        options.identity
      )
      if (remote.userId !== actorUserId) return false
      return crypto.subtle.verify(
        { name: 'Ed25519' },
        remote.identityKeyPublic,
        signature.buffer as ArrayBuffer,
        bytes.buffer as ArrayBuffer
      )
    },
    async resolveParticipant(phoneNumber) {
      const remote = await options.identityClient.fetchRemoteIdentity(phoneNumber, options.identity)
      return {
        participantId: remote.userId,
        ...(remote.displayName === undefined ? {} : { displayName: remote.displayName })
      }
    }
  }

  if (!options.groupId) return base

  return {
    ...base,
    async bootstrapAccess(context) {
      const current = await group()
      if (current.document_id !== context.documentId)
        throw new Error('collaboration group is bound to a different document')
      return current.members.map(groupMemberToParticipant)
    },
    async encodeEnvelope(envelope, context) {
      const current = await group()
      if (current.document_id !== envelope.documentId)
        throw new Error('collaboration group is bound to a different document')
      const active = new Set(
        context.participants
          .filter((participant) => participant.active)
          .map((participant) => participant.participantId)
      )
      const recipients = current.members.filter(
        (member) => member.user_id !== options.identity.userId && active.has(member.user_id)
      )
      if (recipients.length === 0)
        throw new Error('Encrypted collaboration group has no active remote recipients')
      const encodedEnvelope = encodeEnvelope(envelope)
      options.inspector?.append({
        direction: 'outbound',
        operation: 'envelope',
        sender: options.identity.phoneNumber,
        recipients: recipients.map((recipient) => recipient.phone_number),
        documentId: envelope.documentId,
        envelopeKind: envelope.kind,
        messageId: envelope.messageId,
        inputSizeBytes: envelope.payload.byteLength,
        outputSizeBytes: encodedEnvelope.byteLength,
        detail: envelopeMetadata(envelope)
      })

      const started = performance.now()
      try {
        const encrypted = await Promise.all(
          recipients.map(async (recipient) => {
            const value = await options.identityClient.encryptEnvelopeForRecipient(
              envelope,
              { userId: recipient.user_id, phoneNumber: recipient.phone_number },
              options.identity
            )
            return {
              recipient,
              value,
              bytes: encodeEncryptedEnvelope(value)
            }
          })
        )
        options.inspector?.append({
          direction: 'outbound',
          operation: 'encrypt',
          sender: options.identity.phoneNumber,
          recipients: recipients.map((recipient) => recipient.phone_number),
          documentId: envelope.documentId,
          envelopeKind: envelope.kind,
          messageId: envelope.messageId,
          inputSizeBytes: encodedEnvelope.byteLength,
          outputSizeBytes: encrypted.reduce((total, item) => total + item.bytes.byteLength, 0),
          durationMs: performance.now() - started,
          detail: {
            algorithm: 'X25519 + HKDF-SHA-256 + AES-256-GCM',
            recipients: encrypted.map(({ recipient, value, bytes }) => ({
              phoneNumber: recipient.phone_number,
              recipientPrekeyKind: value.recipientPrekeyKind,
              recipientKeySelector: value.recipientKeySelector,
              ephemeralPublicHex: bytesToHex(value.ephemeralPublic),
              nonceHex: bytesToHex(value.nonce),
              ciphertextHex: bytesToHex(value.ciphertext),
              encryptedBytes: bytes.byteLength
            }))
          }
        })
        options.inspector?.append({
          direction: 'outbound',
          operation: 'sign',
          sender: options.identity.phoneNumber,
          recipients: recipients.map((recipient) => recipient.phone_number),
          documentId: envelope.documentId,
          envelopeKind: envelope.kind,
          messageId: envelope.messageId,
          outputSizeBytes: encrypted.reduce(
            (total, item) => total + item.value.signature.byteLength,
            0
          ),
          detail: {
            algorithm: 'Ed25519',
            signatures: encrypted.map(({ recipient, value }) => ({
              phoneNumber: recipient.phone_number,
              signatureHex: bytesToHex(value.signature)
            }))
          }
        })
        const fanoutStarted = performance.now()
        const fanout = encodeMockSignalFanoutFrame({
          version: 1,
          messageId: envelope.messageId,
          recipients: encrypted.map(({ recipient, bytes }) => ({
            phoneNumber: recipient.phone_number,
            payload: bytes
          }))
        })
        options.inspector?.append({
          direction: 'outbound',
          operation: 'fanout_frame',
          sender: options.identity.phoneNumber,
          recipients: recipients.map((recipient) => recipient.phone_number),
          documentId: envelope.documentId,
          envelopeKind: envelope.kind,
          messageId: envelope.messageId,
          inputSizeBytes: encrypted.reduce((total, item) => total + item.bytes.byteLength, 0),
          outputSizeBytes: fanout.byteLength,
          durationMs: performance.now() - fanoutStarted,
          detail: { version: 1, recipientCount: encrypted.length, rawFrameHex: bytesToHex(fanout) }
        })
        return fanout
      } catch (cause) {
        options.inspector?.append({
          direction: 'outbound',
          operation: 'encrypt',
          sender: options.identity.phoneNumber,
          recipients: recipients.map((recipient) => recipient.phone_number),
          documentId: envelope.documentId,
          envelopeKind: envelope.kind,
          messageId: envelope.messageId,
          inputSizeBytes: encodedEnvelope.byteLength,
          durationMs: performance.now() - started,
          result: `error: ${cause instanceof Error ? cause.message : 'encryption failed'}`
        })
        throw cause
      }
    },
    async decodeEnvelope(wire) {
      const encrypted = decodeEncryptedEnvelope(wire)
      options.inspector?.append({
        direction: 'inbound',
        operation: 'fanout_decode',
        sender: encrypted.senderPhoneNumber,
        recipients: [encrypted.recipientPhoneNumber],
        documentId: encrypted.documentId,
        messageId: encrypted.messageId,
        inputSizeBytes: wire.byteLength,
        outputSizeBytes: encrypted.ciphertext.byteLength,
        detail: {
          recipientPrekeyKind: encrypted.recipientPrekeyKind,
          recipientKeySelector: encrypted.recipientKeySelector,
          ephemeralPublicHex: bytesToHex(encrypted.ephemeralPublic),
          nonceHex: bytesToHex(encrypted.nonce),
          ciphertextHex: bytesToHex(encrypted.ciphertext)
        }
      })
      const started = performance.now()
      try {
        const envelope = await options.identityClient.decryptEnvelope(encrypted, options.identity)
        const encoded = encodeEnvelope(envelope)
        options.inspector?.append({
          direction: 'inbound',
          operation: 'decrypt',
          sender: encrypted.senderPhoneNumber,
          recipients: [encrypted.recipientPhoneNumber],
          documentId: envelope.documentId,
          envelopeKind: envelope.kind,
          messageId: envelope.messageId,
          inputSizeBytes: encrypted.ciphertext.byteLength,
          outputSizeBytes: encoded.byteLength,
          durationMs: performance.now() - started,
          detail: {
            algorithm: 'X25519 + HKDF-SHA-256 + AES-256-GCM',
            timingScope: 'authenticated decrypt + signature verification + envelope decode'
          }
        })
        options.inspector?.append({
          direction: 'inbound',
          operation: 'verify_signature',
          sender: encrypted.senderPhoneNumber,
          recipients: [encrypted.recipientPhoneNumber],
          documentId: envelope.documentId,
          envelopeKind: envelope.kind,
          messageId: envelope.messageId,
          inputSizeBytes: encrypted.signature.byteLength,
          result: 'ok',
          detail: { algorithm: 'Ed25519', signatureHex: bytesToHex(encrypted.signature) }
        })
        options.inspector?.append({
          direction: 'inbound',
          operation: 'envelope_decode',
          sender: encrypted.senderPhoneNumber,
          recipients: [encrypted.recipientPhoneNumber],
          documentId: envelope.documentId,
          envelopeKind: envelope.kind,
          messageId: envelope.messageId,
          inputSizeBytes: encoded.byteLength,
          outputSizeBytes: envelope.payload.byteLength,
          detail: envelopeMetadata(envelope)
        })
        return envelope
      } catch (cause) {
        options.inspector?.append({
          direction: 'inbound',
          operation: 'decrypt',
          sender: encrypted.senderPhoneNumber,
          recipients: [encrypted.recipientPhoneNumber],
          documentId: encrypted.documentId,
          messageId: encrypted.messageId,
          inputSizeBytes: encrypted.ciphertext.byteLength,
          durationMs: performance.now() - started,
          result: `error: ${cause instanceof Error ? cause.message : 'decryption failed'}`
        })
        throw cause
      }
    }
  }
}

export async function getGroup(options: {
  readonly baseUrl: string
  readonly groupId: string
  readonly identity: UserIdentity
}): Promise<CollaborationGroupView> {
  return requestJson<CollaborationGroupView>(
    `${options.baseUrl}/api/v1/groups/${encodeURIComponent(options.groupId)}`,
    { headers: authHeaders(options.identity) }
  )
}

export async function addGroupMember(options: {
  readonly baseUrl: string
  readonly groupId: string
  readonly identity: UserIdentity
  readonly phoneNumber: string
  readonly role: DocumentRole
}): Promise<CollaborationGroupView> {
  return requestJson<CollaborationGroupView>(
    `${options.baseUrl}/api/v1/groups/${encodeURIComponent(options.groupId)}/members`,
    {
      method: 'POST',
      headers: {
        ...authHeaders(options.identity),
        'content-type': 'application/json'
      },
      body: JSON.stringify({ phone_number: options.phoneNumber, role: options.role })
    }
  )
}

function groupMemberToParticipant(member: CollaborationGroupMemberView): DocumentParticipant {
  return {
    participantId: member.user_id,
    role: member.role,
    displayName: member.display_name,
    active: true
  }
}

function authHeaders(identity: UserIdentity): Record<string, string> {
  return { authorization: `Bearer ${identity.sessionToken}` }
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined
    const detail = typeof body?.error === 'string' ? `: ${body.error}` : ''
    throw new Error(`collaboration group request failed (${response.status})${detail}`)
  }
  return (await response.json()) as T
}
