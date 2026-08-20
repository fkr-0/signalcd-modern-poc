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

export type SyncLogListener = (entry: SyncLogEntry) => void

export interface SyncLogEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null
  onerror: ((event: Event) => void) | null
  close(): void
}

export interface SyncLogClientOptions {
  readonly baseUrl: string
  readonly eventSourceFactory?: (url: string) => SyncLogEventSource
  readonly fetch?: (url: string, init?: RequestInit) => Promise<Response>
}

export class SyncLogClient {
  private readonly listeners = new Set<SyncLogListener>()
  private readonly eventSourceFactory: (url: string) => SyncLogEventSource
  private readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>
  private readonly endpoint: string
  private source: SyncLogEventSource | undefined

  constructor(options: SyncLogClientOptions) {
    this.endpoint = new URL('/__toy__/v1/sync-log', ensureTrailingSlash(options.baseUrl)).toString()
    this.eventSourceFactory =
      options.eventSourceFactory ?? ((url) => new EventSource(url) as SyncLogEventSource)
    this.fetcher = options.fetch ?? ((url, init) => fetch(url, init))
  }

  connect(): void {
    if (this.source) return
    const source = this.eventSourceFactory(this.endpoint)
    source.onmessage = (event) => {
      try {
        const entry = parseSyncLogEntry(JSON.parse(event.data) as unknown)
        for (const listener of this.listeners) listener(entry)
      } catch {
        // Malformed diagnostic events are ignored rather than affecting document synchronization.
      }
    }
    this.source = source
  }

  subscribe(listener: SyncLogListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  disconnect(): void {
    this.source?.close()
    this.source = undefined
  }

  async getLogSince(timestamp: number): Promise<readonly SyncLogEntry[]> {
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new TypeError('sync-log timestamp must be a non-negative safe integer')
    const url = new URL(this.endpoint)
    url.searchParams.set('since', String(timestamp))
    const response = await this.fetcher(url.toString(), { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`sync-log request failed with HTTP ${response.status}`)
    const value = (await response.json()) as unknown
    if (!Array.isArray(value)) throw new Error('sync-log response must be an array')
    return value.map(parseSyncLogEntry)
  }
}

function parseSyncLogEntry(value: unknown): SyncLogEntry {
  const record = asRecord(value)
  const timestamp = record.timestamp
  if (!Number.isSafeInteger(timestamp) || (timestamp as number) < 0)
    throw new Error('sync-log entry timestamp is invalid')
  const level = record.level
  if (level !== 'wire' && level !== 'envelope' && level !== 'application' && level !== 'decrypted')
    throw new Error('sync-log entry level is invalid')
  const direction = record.direction
  if (direction !== undefined && direction !== 'inbound' && direction !== 'outbound')
    throw new Error('sync-log entry direction is invalid')
  const rawSizeBytes = optionalNonNegativeInteger(record.rawSizeBytes, 'rawSizeBytes')
  return {
    timestamp: timestamp as number,
    level,
    ...(direction === undefined ? {} : { direction }),
    ...optionalString(record, 'senderPhone'),
    ...optionalString(record, 'recipientPhone'),
    ...optionalString(record, 'documentId'),
    ...optionalString(record, 'envelopeKind'),
    ...optionalString(record, 'messageId'),
    ...optionalString(record, 'preview'),
    ...optionalString(record, 'debugError'),
    ...(record.signatureValid === undefined
      ? {}
      : typeof record.signatureValid === 'boolean'
        ? { signatureValid: record.signatureValid }
        : invalid('signatureValid')),
    ...(rawSizeBytes === undefined ? {} : { rawSizeBytes })
  }
}

function optionalString<K extends string>(
  record: Record<string, unknown>,
  key: K
): Partial<Record<K, string>> {
  const value = record[key]
  if (value === undefined) return {}
  if (typeof value !== 'string') throw new Error(`sync-log entry ${key} is invalid`)
  return { [key]: value } as Partial<Record<K, string>>
}

function optionalNonNegativeInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`sync-log entry ${name} is invalid`)
  return value as number
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('sync-log entry must be an object')
  return value as Record<string, unknown>
}

function invalid(name: string): never {
  throw new Error(`sync-log entry ${name} is invalid`)
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}
