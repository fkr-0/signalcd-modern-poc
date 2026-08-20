import { describe, expect, it, vi } from 'vitest'
import { SyncLogClient, type SyncLogEventSource } from './sync-log'

class FakeEventSource implements SyncLogEventSource {
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  closed = false

  close(): void {
    this.closed = true
  }

  emit(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent<string>)
  }
}

describe('SyncLogClient', () => {
  it('subscribes to structured SSE events and disconnects idempotently', () => {
    const source = new FakeEventSource()
    const factory = vi.fn(() => source)
    const listener = vi.fn()
    const client = new SyncLogClient({
      baseUrl: 'http://127.0.0.1:18080',
      eventSourceFactory: factory
    })
    const unsubscribe = client.subscribe(listener)

    client.connect()
    client.connect()
    source.emit({ timestamp: 10, level: 'wire', direction: 'inbound', rawSizeBytes: 42 })
    source.emit({ timestamp: 'bad', level: 'wire' })

    expect(factory).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({
      timestamp: 10,
      level: 'wire',
      direction: 'inbound',
      rawSizeBytes: 42
    })
    unsubscribe()
    client.disconnect()
    expect(source.closed).toBe(true)
  })

  it('polls entries after a timestamp and validates server data', async () => {
    const fetcher = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify([
            {
              timestamp: 11,
              level: 'decrypted',
              envelopeKind: 'automerge-change',
              signatureValid: true
            }
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    )
    const client = new SyncLogClient({ baseUrl: 'http://localhost:18080', fetch: fetcher })

    await expect(client.getLogSince(10)).resolves.toEqual([
      {
        timestamp: 11,
        level: 'decrypted',
        envelopeKind: 'automerge-change',
        signatureValid: true
      }
    ])
    expect(new URL(fetcher.mock.calls[0]![0]).searchParams.get('since')).toBe('10')
    await expect(client.getLogSince(-1)).rejects.toThrow('non-negative safe integer')
  })
})
