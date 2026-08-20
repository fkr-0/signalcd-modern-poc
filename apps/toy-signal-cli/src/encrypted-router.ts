import { webcrypto } from 'node:crypto'
import {
  decodeEncryptedEnvelope,
  encodeEncryptedEnvelopeSignatureInput,
  type ProtocolEnvelope
} from '@e2e-col/protocol'
import type { WebSocket } from 'ws'
import type { CollaborationGroupRegistry } from './group-registry'
import type { AuthenticatedIdentity, IdentityRegistry } from './identity-registry'
import type { ToySignalNetwork } from './network'
import type { SyncEventLog } from './sync-log'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PHONE_RE = /^\+[1-9][0-9]{7,14}$/
const MAX_ROUTED_CIPHERTEXT_BYTES = 20 * 1024 * 1024
const MAX_MESSAGE_LOG = 100

interface BoundConnection {
  readonly identity: AuthenticatedIdentity
  readonly groupId: string
  readonly documentId: string
}

export type DebugEnvelopeDecryptor = (
  payload: Uint8Array,
  recipient: AuthenticatedIdentity
) => Promise<ProtocolEnvelope>

interface RoutedRecipient {
  readonly phoneNumber: string
  readonly payload: Uint8Array
}

interface RoutedFanout {
  readonly messageId: string
  readonly recipients: readonly RoutedRecipient[]
}

interface MessageMetadata {
  readonly message_id: string
  readonly group_id: string
  readonly document_id: string
  readonly sender_user_id: string
  readonly sender_phone_number: string
  readonly recipients: readonly {
    readonly phone_number: string
    readonly ciphertext_bytes: number
    readonly delivery_copies: number
  }[]
  readonly accepted_at: number
}

export class EncryptedMessageRouter {
  private readonly connections = new Map<string, Set<WebSocket>>()
  private readonly backlog = new Map<string, Uint8Array[]>()
  private readonly messages: MessageMetadata[] = []

  constructor(
    private readonly identities: IdentityRegistry,
    private readonly groups: CollaborationGroupRegistry,
    private readonly network: ToySignalNetwork,
    private readonly now: () => number = Date.now,
    private readonly syncLog?: SyncEventLog,
    private readonly debugDecryptor?: DebugEnvelopeDecryptor,
    private debugDecrypt = false
  ) {}

  setDebugDecrypt(enabled: boolean): void {
    this.debugDecrypt = enabled
  }

  private async inspectEnvelope(
    binding: BoundConnection,
    recipient: AuthenticatedIdentity,
    payload: Uint8Array
  ): Promise<void> {
    let signatureValid: boolean | undefined
    try {
      const encrypted = decodeEncryptedEnvelope(payload)
      if (
        encrypted.documentId !== binding.documentId ||
        encrypted.senderId !== binding.identity.userId ||
        encrypted.senderPhoneNumber !== binding.identity.phoneNumber ||
        encrypted.recipientId !== recipient.userId ||
        encrypted.recipientPhoneNumber !== recipient.phoneNumber
      )
        return
      signatureValid = await this.verifyEncryptedSignature(binding.identity.phoneNumber, encrypted)
      this.syncLog?.append({
        level: 'envelope',
        direction: 'outbound',
        senderPhone: binding.identity.phoneNumber,
        recipientPhone: recipient.phoneNumber,
        documentId: encrypted.documentId,
        messageId: encrypted.messageId,
        signatureValid,
        rawSizeBytes: payload.byteLength
      })
    } catch {
      // Opaque transport payloads remain routable even when diagnostics cannot decode metadata.
    }

    if (!this.debugDecrypt || !this.debugDecryptor) return
    try {
      const envelope = await this.debugDecryptor(new Uint8Array(payload), recipient)
      if (
        envelope.documentId !== binding.documentId ||
        envelope.senderId !== binding.identity.userId
      )
        return
      const valid = signatureValid ?? false
      this.syncLog?.append({
        level: 'application',
        direction: 'outbound',
        senderPhone: binding.identity.phoneNumber,
        recipientPhone: recipient.phoneNumber,
        documentId: envelope.documentId,
        envelopeKind: envelope.kind,
        messageId: envelope.messageId,
        signatureValid: valid
      })
      this.syncLog?.append({
        level: 'decrypted',
        direction: 'outbound',
        senderPhone: binding.identity.phoneNumber,
        recipientPhone: recipient.phoneNumber,
        documentId: envelope.documentId,
        envelopeKind: envelope.kind,
        messageId: envelope.messageId,
        preview: new TextDecoder().decode(envelope.payload).slice(0, 256),
        signatureValid: valid,
        rawSizeBytes: payload.byteLength
      })
    } catch {
      // Debug inspection is intentionally observational and cannot fail routing.
    }
  }

  private async verifyEncryptedSignature(
    senderPhone: string,
    encrypted: ReturnType<typeof decodeEncryptedEnvelope>
  ): Promise<boolean> {
    try {
      const keyBytes = Buffer.from(this.identities.identityKeyPublicByPhone(senderPhone), 'base64')
      const key = await webcrypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, [
        'verify'
      ])
      return webcrypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        Buffer.from(encrypted.signature),
        Buffer.from(encodeEncryptedEnvelopeSignatureInput(encrypted))
      )
    } catch {
      return false
    }
  }

  getDebugDecrypt(): boolean {
    return this.debugDecrypt
  }

  attach(client: WebSocket): void {
    let binding: BoundConnection | undefined
    client.binaryType = 'arraybuffer'

    client.on('message', (raw, isBinary) => {
      void (async () => {
        try {
          if (!binding) {
            if (isBinary)
              throw new Error('authenticate with a text frame before sending ciphertext')
            binding = this.authenticate(raw.toString('utf8'))
            const group = this.groups.bindConnection(
              binding.groupId,
              binding.documentId,
              binding.identity
            )
            const key = connectionKey(binding.groupId, binding.identity.userId)
            const peers = this.connections.get(key) ?? new Set<WebSocket>()
            peers.add(client)
            this.connections.set(key, peers)
            sendJson(client, {
              type: 'ready',
              group_id: group.group_id,
              document_id: group.document_id,
              members: group.members
            })
            this.flushBacklog(key, client)
            return
          }
          if (!isBinary)
            throw new Error('authenticated message frames must be binary fanout frames')
          await this.routeFanout(client, binding, new Uint8Array(raw as Buffer))
        } catch (error) {
          const message = error instanceof Error ? error.message : 'mock Signal routing error'
          sendJson(client, { type: 'error', error: message })
          if (!binding) client.close(1008, 'authentication rejected')
        }
      })()
    })
    client.on('close', () => {
      if (!binding) return
      const key = connectionKey(binding.groupId, binding.identity.userId)
      const peers = this.connections.get(key)
      peers?.delete(client)
      if (peers?.size === 0) this.connections.delete(key)
    })
  }

  reset(): void {
    for (const peers of this.connections.values())
      for (const client of peers) client.close(1012, 'toy state reset')
    this.connections.clear()
    this.backlog.clear()
    this.messages.splice(0)
  }

  view(): {
    active_connections: number
    pending_deliveries: number
    messages: readonly MessageMetadata[]
  } {
    let activeConnections = 0
    for (const peers of this.connections.values()) activeConnections += peers.size
    let pendingDeliveries = 0
    for (const queued of this.backlog.values()) pendingDeliveries += queued.length
    return {
      active_connections: activeConnections,
      pending_deliveries: pendingDeliveries,
      messages: this.messages.map((message) => ({
        ...message,
        recipients: message.recipients.map((recipient) => ({ ...recipient }))
      }))
    }
  }

  private authenticate(text: string): BoundConnection {
    const value = asRecord(JSON.parse(text) as unknown)
    if (value.type !== 'authenticate') throw new Error('first frame must authenticate')
    const token = requiredString(value.token, 'token')
    const identity = this.identities.authenticateToken(token)
    return {
      identity,
      groupId: uuid(value.group_id, 'group_id'),
      documentId: uuid(value.document_id, 'document_id')
    }
  }

  private async routeFanout(
    senderClient: WebSocket,
    binding: BoundConnection,
    bytes: Uint8Array
  ): Promise<void> {
    const fanout = decodeFanout(bytes)
    const group = this.groups.bindConnection(binding.groupId, binding.documentId, binding.identity)
    this.syncLog?.append({
      level: 'wire',
      direction: 'inbound',
      senderPhone: binding.identity.phoneNumber,
      documentId: binding.documentId,
      messageId: fanout.messageId,
      rawSizeBytes: bytes.byteLength
    })
    const expected = group.members
      .filter((member) => member.user_id !== binding.identity.userId)
      .map((member) => member.phone_number)
      .sort()
    const actual = fanout.recipients.map((recipient) => recipient.phoneNumber).sort()
    if (!sameStrings(expected, actual))
      throw new Error('fanout recipients must exactly match current group members except sender')
    if (this.network.consumeSendFailure()) {
      sendJson(senderClient, {
        type: 'error',
        message_id: fanout.messageId,
        error: 'toy injected send failure'
      })
      return
    }

    const recipientMetadata: MessageMetadata['recipients'][number][] = []
    for (const recipient of fanout.recipients) {
      const member = group.members.find((entry) => entry.phone_number === recipient.phoneNumber)
      if (!member) throw new Error(`recipient ${recipient.phoneNumber} is no longer a group member`)
      const recipientIdentity = this.identities.identityByPhone(recipient.phoneNumber)
      this.syncLog?.append({
        level: 'wire',
        direction: 'outbound',
        senderPhone: binding.identity.phoneNumber,
        recipientPhone: recipient.phoneNumber,
        documentId: binding.documentId,
        messageId: fanout.messageId,
        rawSizeBytes: recipient.payload.byteLength
      })
      await this.inspectEnvelope(binding, recipientIdentity, recipient.payload)
      const key = connectionKey(group.group_id, member.user_id)
      const copies = await this.network.deliverWithFaults(() =>
        this.deliver(key, recipient.payload)
      )
      recipientMetadata.push({
        phone_number: recipient.phoneNumber,
        ciphertext_bytes: recipient.payload.byteLength,
        delivery_copies: copies
      })
    }

    this.messages.push({
      message_id: fanout.messageId,
      group_id: group.group_id,
      document_id: group.document_id,
      sender_user_id: binding.identity.userId,
      sender_phone_number: binding.identity.phoneNumber,
      recipients: recipientMetadata,
      accepted_at: this.now()
    })
    if (this.messages.length > MAX_MESSAGE_LOG)
      this.messages.splice(0, this.messages.length - MAX_MESSAGE_LOG)
    sendJson(senderClient, {
      type: 'ack',
      message_id: fanout.messageId,
      recipients: fanout.recipients.length
    })
  }

  private deliver(key: string, payload: Uint8Array): void {
    const peers = this.connections.get(key)
    if (!peers || peers.size === 0) {
      const queued = this.backlog.get(key) ?? []
      queued.push(new Uint8Array(payload))
      this.backlog.set(key, queued)
      return
    }
    for (const client of peers) {
      if (client.readyState === 1) client.send(payload)
    }
  }

  private flushBacklog(key: string, client: WebSocket): void {
    const queued = this.backlog.get(key)
    if (!queued || client.readyState !== 1) return
    this.backlog.delete(key)
    for (const payload of queued) client.send(payload)
  }
}

function decodeFanout(bytes: Uint8Array): RoutedFanout {
  let value: Record<string, unknown>
  try {
    value = asRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
  } catch {
    throw new Error('binary fanout must contain valid UTF-8 JSON')
  }
  if (value.type !== 'fanout' || value.version !== 1)
    throw new Error('unsupported mock Signal fanout type or version')
  const messageId = uuid(value.message_id, 'message_id')
  if (!Array.isArray(value.recipients) || value.recipients.length < 1)
    throw new Error('fanout must contain at least one recipient')
  const seen = new Set<string>()
  const recipients = value.recipients.map((entry) => {
    const record = asRecord(entry)
    const phoneNumber = phone(record.phone_number)
    if (seen.has(phoneNumber)) throw new Error(`duplicate fanout recipient ${phoneNumber}`)
    seen.add(phoneNumber)
    const payload = decodeBase64(requiredString(record.payload, 'payload'))
    if (payload.byteLength < 1 || payload.byteLength > MAX_ROUTED_CIPHERTEXT_BYTES)
      throw new Error('fanout ciphertext payload has an invalid size')
    return { phoneNumber, payload }
  })
  return { messageId, recipients }
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0)
    throw new Error('fanout payload must be canonical base64')
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value)
    throw new Error('fanout payload must be canonical base64')
  return new Uint8Array(decoded)
}

function connectionKey(groupId: string, userId: string): string {
  return `${groupId}\u0000${userId}`
}

function sendJson(client: WebSocket, value: unknown): void {
  if (client.readyState === 1) client.send(JSON.stringify(value))
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('mock Signal frame must be an object')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${name} must be a non-empty string`)
  return value
}

function uuid(value: unknown, name: string): string {
  const result = requiredString(value, name)
  if (!UUID_RE.test(result)) throw new Error(`${name} must be a UUID`)
  return result
}

function phone(value: unknown): string {
  const result = requiredString(value, 'phone_number')
  if (!PHONE_RE.test(result)) throw new Error('phone_number must be E.164-style')
  return result
}
