import type { SyncLogEntry } from '@e2e-col/identity'
import { decodeEncryptedEnvelope, decodeEnvelope } from '@e2e-col/protocol'
import type {
  ObservableCollaborativeTransport,
  TransportFactory,
  TransportMetrics,
  TransportRecoveryListener,
  TransportStateListener,
  TransportUpdateListener
} from '@e2e-col/transport'
import { decodeMockSignalFanoutFrame } from '@e2e-col/transport'

export const OUTBOUND_PIPELINE = [
  'crdt_change',
  'envelope',
  'sign',
  'encrypt',
  'fanout_frame',
  'transport_send'
] as const

export const INBOUND_PIPELINE = [
  'transport_receive',
  'fanout_decode',
  'decrypt',
  'verify_signature',
  'envelope_decode',
  'dedup',
  'crdt_apply'
] as const

export type PipelineOperation =
  | (typeof OUTBOUND_PIPELINE)[number]
  | (typeof INBOUND_PIPELINE)[number]

export type InspectorDirection = 'outbound' | 'inbound' | 'internal'

export interface InspectorEventInput {
  readonly timestamp?: number
  readonly source?: 'browser' | 'sidecar'
  readonly direction: InspectorDirection
  readonly operation: string
  readonly sender?: string
  readonly recipients?: readonly string[]
  readonly documentId?: string
  readonly envelopeKind?: string
  readonly messageId?: string
  readonly inputSizeBytes?: number
  readonly outputSizeBytes?: number
  readonly durationMs?: number
  readonly result?: string
  readonly detail?: unknown
}

export interface InspectorEvent
  extends Omit<InspectorEventInput, 'timestamp' | 'source' | 'result'> {
  readonly id: string
  readonly timestamp: number
  readonly source: 'browser' | 'sidecar'
  readonly result: string
}

type SnapshotListener = () => void

const MAX_EVENTS = 1000
const FORBIDDEN_DETAIL_KEY = /(?:private|session.?token|auth.?token|credential|password|secret)/i

/**
 * In-memory, read-only diagnostic stream for the dashboard. The store only accepts
 * sanitized metadata/public cryptographic material and deliberately strips fields
 * whose names suggest credentials or private key material.
 */
export class InspectorEventStore {
  private readonly entries: InspectorEvent[] = []
  private readonly listeners = new Set<SnapshotListener>()
  private readonly externalKeys = new Set<string>()
  private sequence = 0
  private transportMetrics: TransportMetrics | undefined

  append(input: InspectorEventInput, externalKey?: string): InspectorEvent | undefined {
    if (externalKey && this.externalKeys.has(externalKey)) return undefined
    if (externalKey) this.externalKeys.add(externalKey)
    const timestamp = input.timestamp ?? Date.now()
    this.sequence += 1
    const event: InspectorEvent = {
      id: `${timestamp}:${this.sequence}`,
      timestamp,
      source: input.source ?? 'browser',
      direction: input.direction,
      operation: input.operation,
      ...(input.sender === undefined ? {} : { sender: input.sender }),
      ...(input.recipients === undefined ? {} : { recipients: [...input.recipients] }),
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      ...(input.envelopeKind === undefined ? {} : { envelopeKind: input.envelopeKind }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.inputSizeBytes === undefined ? {} : { inputSizeBytes: input.inputSizeBytes }),
      ...(input.outputSizeBytes === undefined ? {} : { outputSizeBytes: input.outputSizeBytes }),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
      result: input.result ?? 'ok',
      ...(input.detail === undefined ? {} : { detail: sanitizeDetail(input.detail) })
    }
    this.entries.push(event)
    if (this.entries.length > MAX_EVENTS) this.entries.splice(0, this.entries.length - MAX_EVENTS)
    this.notify()
    return event
  }

  events(): readonly InspectorEvent[] {
    return this.entries.map((entry) => ({
      ...entry,
      ...(entry.recipients === undefined ? {} : { recipients: [...entry.recipients] })
    }))
  }

  setTransportMetrics(metrics: TransportMetrics): void {
    this.transportMetrics = { ...metrics }
    this.notify()
  }

  getTransportMetrics(): TransportMetrics | undefined {
    return this.transportMetrics === undefined ? undefined : { ...this.transportMetrics }
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export function instrumentTransportFactory(
  factory: TransportFactory,
  store: InspectorEventStore
): TransportFactory {
  return (context) => new InspectableTransport(factory(context), context.documentId, store)
}

export function appendSidecarSyncEvent(store: InspectorEventStore, entry: SyncLogEntry): void {
  const direction = entry.direction ?? 'internal'
  const operation = `sidecar_${entry.level}`
  const result =
    entry.debugError !== undefined
      ? `error: ${entry.debugError}`
      : entry.signatureValid === false
        ? 'error: signature invalid'
        : 'ok'
  const externalKey = [
    entry.timestamp,
    entry.level,
    entry.direction ?? '',
    entry.senderPhone ?? '',
    entry.recipientPhone ?? '',
    entry.documentId ?? '',
    entry.messageId ?? '',
    entry.rawSizeBytes ?? ''
  ].join(':')
  store.append(
    {
      timestamp: entry.timestamp,
      source: 'sidecar',
      direction,
      operation,
      ...(entry.senderPhone === undefined ? {} : { sender: entry.senderPhone }),
      ...(entry.recipientPhone === undefined ? {} : { recipients: [entry.recipientPhone] }),
      ...(entry.documentId === undefined ? {} : { documentId: entry.documentId }),
      ...(entry.envelopeKind === undefined ? {} : { envelopeKind: entry.envelopeKind }),
      ...(entry.messageId === undefined ? {} : { messageId: entry.messageId }),
      ...(entry.rawSizeBytes === undefined
        ? {}
        : { inputSizeBytes: entry.rawSizeBytes, outputSizeBytes: entry.rawSizeBytes }),
      result,
      detail: {
        level: entry.level,
        ...(entry.preview === undefined ? {} : { debugPreview: entry.preview }),
        ...(entry.debugError === undefined ? {} : { debugError: entry.debugError }),
        ...(entry.signatureValid === undefined ? {} : { signatureValid: entry.signatureValid })
      }
    },
    `sidecar:${externalKey}`
  )
}

class InspectableTransport implements ObservableCollaborativeTransport {
  constructor(
    private readonly transport: ObservableCollaborativeTransport,
    private readonly documentId: string,
    private readonly store: InspectorEventStore
  ) {
    this.updateMetrics()
  }

  async connect(documentId: string): Promise<void> {
    try {
      await this.transport.connect(documentId)
    } finally {
      this.updateMetrics()
    }
  }

  async send(update: Uint8Array): Promise<void> {
    const started = monotonicNow()
    const metadata = inspectWireMetadata(update)
    try {
      await this.transport.send(update)
      this.store.append({
        direction: 'outbound',
        operation: 'transport_send',
        documentId: this.documentId,
        ...metadata,
        inputSizeBytes: update.byteLength,
        outputSizeBytes: update.byteLength,
        durationMs: monotonicNow() - started,
        result: 'ok',
        detail: { metrics: this.transport.getMetrics() }
      })
    } catch (cause) {
      this.store.append({
        direction: 'outbound',
        operation: 'transport_send',
        documentId: this.documentId,
        ...metadata,
        inputSizeBytes: update.byteLength,
        durationMs: monotonicNow() - started,
        result: `error: ${safeError(cause)}`
      })
      throw cause
    } finally {
      this.updateMetrics()
    }
  }

  subscribe(listener: TransportUpdateListener): () => void {
    return this.transport.subscribe((update) => {
      const metadata = inspectWireMetadata(update)
      this.store.append({
        direction: 'inbound',
        operation: 'transport_receive',
        documentId: this.documentId,
        ...metadata,
        inputSizeBytes: update.byteLength,
        outputSizeBytes: update.byteLength,
        result: 'ok'
      })
      this.updateMetrics()
      listener(update)
    })
  }

  subscribeState(listener: TransportStateListener): () => void {
    return this.transport.subscribeState((event) => {
      this.updateMetrics()
      listener(event)
    })
  }

  subscribeRecovery(listener: TransportRecoveryListener): () => void {
    return this.transport.subscribeRecovery(listener)
  }

  getState() {
    return this.transport.getState()
  }

  getMetrics(): TransportMetrics {
    return this.transport.getMetrics()
  }

  async close(): Promise<void> {
    await this.transport.close()
    this.updateMetrics()
  }

  private updateMetrics(): void {
    this.store.setTransportMetrics(this.transport.getMetrics())
  }
}

function sanitizeDetail(value: unknown): unknown {
  if (value instanceof Uint8Array) return bytesToHex(value)
  if (Array.isArray(value)) return value.map(sanitizeDetail)
  if (typeof value !== 'object' || value === null) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_DETAIL_KEY.test(key)) continue
    result[key] = sanitizeDetail(entry)
  }
  return result
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now()
}

function safeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'operation failed'
}

function inspectWireMetadata(
  update: Uint8Array
): Pick<
  InspectorEventInput,
  'messageId' | 'sender' | 'recipients' | 'documentId' | 'envelopeKind'
> {
  try {
    const fanout = decodeMockSignalFanoutFrame(update)
    return {
      messageId: fanout.messageId,
      recipients: fanout.recipients.map((recipient) => recipient.phoneNumber)
    }
  } catch {
    // Not a mock fanout frame; try the other currently supported wire codecs.
  }
  try {
    const encrypted = decodeEncryptedEnvelope(update)
    return {
      messageId: encrypted.messageId,
      sender: encrypted.senderPhoneNumber,
      recipients: [encrypted.recipientPhoneNumber],
      documentId: encrypted.documentId
    }
  } catch {
    // Not an encrypted recipient envelope.
  }
  try {
    const envelope = decodeEnvelope(update)
    return {
      messageId: envelope.messageId,
      sender: envelope.senderId,
      documentId: envelope.documentId,
      envelopeKind: envelope.kind
    }
  } catch {
    return {}
  }
}
