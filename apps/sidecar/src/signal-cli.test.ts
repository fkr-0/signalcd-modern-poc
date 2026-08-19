import { describe, expect, it } from 'vitest'
import { SignalCliHttpBackend, parseSignalReceive } from './signal-cli'

describe('parseSignalReceive', () => {
  it('extracts a group data message from signal-cli JSON-RPC events', () => {
    expect(
      parseSignalReceive({
        params: {
          envelope: { dataMessage: { message: 'payload', groupInfo: { groupId: 'group==' } } }
        }
      })
    ).toEqual({ groupId: 'group==', message: 'payload' })
  })

  it('extracts account identity for multi-account event filtering', () => {
    expect(
      parseSignalReceive({
        params: {
          account: '+49123',
          envelope: { dataMessage: { message: 'payload', groupInfo: { groupId: 'group==' } } }
        }
      })
    ).toEqual({ groupId: 'group==', message: 'payload', account: '+49123' })
  })

  it('ignores unrelated receive events', () => {
    expect(parseSignalReceive({ params: { envelope: { receiptMessage: {} } } })).toBeUndefined()
  })

  it('rejects remote signal-cli endpoints unless explicitly enabled', () => {
    expect(() => new SignalCliHttpBackend({ baseUrl: 'http://example.com:8080' })).toThrow(
      /loopback/
    )
  })

  it('includes the configured account on JSON-RPC sends', async () => {
    let requestBody: unknown
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'test', result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const backend = new SignalCliHttpBackend({ account: '+49123', fetch: fetchMock })
    await backend.send('group==', 'payload')
    expect(requestBody).toMatchObject({
      method: 'send',
      params: { account: '+49123', groupId: 'group==', message: 'payload' }
    })
  })

  it('reconnects SSE streams and filters other configured accounts', async () => {
    let eventRequests = 0
    const received: unknown[] = []
    const event = (account: string) =>
      `data: ${JSON.stringify({
        params: {
          account,
          envelope: { dataMessage: { message: account, groupInfo: { groupId: 'group==' } } }
        }
      })}\r\n\r\n`
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/check')) return new Response('{}', { status: 200 })
      if (url.endsWith('/api/v1/events')) {
        eventRequests += 1
        return new Response(event(eventRequests === 1 ? '+49999' : '+49123'), { status: 200 })
      }
      throw new Error(`unexpected URL ${url}`)
    }
    const backend = new SignalCliHttpBackend({
      account: '+49123',
      fetch: fetchMock,
      reconnectDelayMs: 1,
      reconnectMaxDelayMs: 1
    })
    await backend.start((message) => received.push(message))
    await waitFor(() => received.length === 1 && eventRequests >= 2)
    await backend.stop()
    expect(received).toEqual([{ groupId: 'group==', message: '+49123', account: '+49123' }])
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('condition was not met')
}
