export type SyncLogLevel = 'wire' | 'envelope' | 'application' | 'decrypted'
export type SyncLogDirection = 'inbound' | 'outbound'

export interface SyncLogEntry {
  readonly timestamp: number
  readonly level: SyncLogLevel
  readonly direction?: SyncLogDirection
  readonly senderPhone?: string
  readonly recipientPhone?: string
  readonly documentId?: string
  readonly envelopeKind?: string
  readonly messageId?: string
  readonly preview?: string
  readonly debugError?: string
  readonly signatureValid?: boolean
  readonly rawSizeBytes?: number
}

export type SyncLogInput = Omit<SyncLogEntry, 'timestamp'> & { readonly timestamp?: number }
export type SyncLogListener = (entry: SyncLogEntry) => void

export class SyncEventLog {
  private readonly entries: SyncLogEntry[] = []
  private readonly listeners = new Set<SyncLogListener>()

  constructor(private readonly now: () => number = Date.now) {}

  append(input: SyncLogInput): SyncLogEntry {
    const timestamp = input.timestamp ?? this.now()
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new TypeError('sync-log timestamp must be a non-negative safe integer')
    if (
      input.rawSizeBytes !== undefined &&
      (!Number.isSafeInteger(input.rawSizeBytes) || input.rawSizeBytes < 0)
    )
      throw new TypeError('sync-log rawSizeBytes must be a non-negative safe integer')

    const entry: SyncLogEntry = {
      timestamp,
      level: input.level,
      ...(input.direction === undefined ? {} : { direction: input.direction }),
      ...(input.senderPhone === undefined ? {} : { senderPhone: input.senderPhone }),
      ...(input.recipientPhone === undefined ? {} : { recipientPhone: input.recipientPhone }),
      ...(input.documentId === undefined ? {} : { documentId: input.documentId }),
      ...(input.envelopeKind === undefined ? {} : { envelopeKind: input.envelopeKind }),
      ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
      ...(input.preview === undefined ? {} : { preview: input.preview.slice(0, 256) }),
      ...(input.debugError === undefined ? {} : { debugError: input.debugError.slice(0, 64) }),
      ...(input.signatureValid === undefined ? {} : { signatureValid: input.signatureValid }),
      ...(input.rawSizeBytes === undefined ? {} : { rawSizeBytes: input.rawSizeBytes })
    }
    this.entries.push(entry)
    for (const listener of this.listeners) listener({ ...entry })
    return { ...entry }
  }

  since(timestamp: number): readonly SyncLogEntry[] {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new TypeError('sync-log since timestamp must be a non-negative safe integer')
    return this.entries
      .filter((entry) => entry.timestamp > timestamp)
      .map((entry) => ({ ...entry }))
  }

  all(): readonly SyncLogEntry[] {
    return this.entries.map((entry) => ({ ...entry }))
  }

  subscribe(listener: SyncLogListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  redactPreviews(): void {
    for (let index = 0; index < this.entries.length; index += 1) {
      const { preview: _preview, ...entry } = this.entries[index]!
      this.entries[index] = entry
    }
  }

  reset(): void {
    this.entries.splice(0)
  }
}
