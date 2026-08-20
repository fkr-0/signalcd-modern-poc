import type { ClientIdentityAdapter } from '@e2e-col/client'
import type { IdentityClient, UserIdentity } from '@e2e-col/identity'
import {
  type DocumentParticipant,
  type DocumentRole,
  encodeEncryptedEnvelope
} from '@e2e-col/protocol'
import { encodeMockSignalFanoutFrame } from '@e2e-col/transport'

export interface CollaborationGroupMemberView {
  readonly user_id: string
  readonly phone_number: string
  readonly display_name: string
  readonly role: DocumentRole
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
}

export function createBrowserIdentityAdapter(
  options: BrowserIdentityAdapterOptions
): ClientIdentityAdapter {
  const membersByUser = new Map<string, CollaborationGroupMemberView>()

  async function group(): Promise<CollaborationGroupView> {
    if (!options.groupId) throw new Error('document is not bound to a collaboration group')
    const value = await requestJson<CollaborationGroupView>(
      `${options.baseUrl}/api/v1/groups/${encodeURIComponent(options.groupId)}`,
      { headers: authHeaders(options.identity) }
    )
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
      const routed = await Promise.all(
        recipients.map(async (recipient) => ({
          phoneNumber: recipient.phone_number,
          payload: encodeEncryptedEnvelope(
            await options.identityClient.encryptEnvelopeForRecipient(
              envelope,
              { userId: recipient.user_id, phoneNumber: recipient.phone_number },
              options.identity
            )
          )
        }))
      )
      return encodeMockSignalFanoutFrame({
        version: 1,
        messageId: envelope.messageId,
        recipients: routed
      })
    },
    decodeEnvelope: (wire) => options.identityClient.decryptEnvelope(wire, options.identity)
  }
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
