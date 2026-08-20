import { describe, expect, it } from 'vitest'
import { parseSignalReceive, SignalCliHttpBackend } from './signal-cli'

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

  it('fails startup when the initial SSE subscription is unavailable', async () => {
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/check') return new Response(null, { status: 200 })
      if (url.pathname === '/api/v1/events') return new Response('', { status: 503 })
      const request = JSON.parse(String(init?.body)) as { id: string; method: string }
      if (request.method !== 'version') throw new Error(`unexpected RPC ${request.method}`)
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { version: '0.14.7' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    const backend = new SignalCliHttpBackend({ fetch: fetchMock })

    await expect(backend.start(() => undefined)).rejects.toThrow(
      'signal-cli event stream failed: HTTP 503'
    )
  })

  it('preserves a signal-cli command error with id:null on a single-request HTTP call', async () => {
    const fetchMock: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'An internal server error has occurred.', data: null }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    const backend = new SignalCliHttpBackend({ fetch: fetchMock })

    await expect(backend.send('group==', 'payload')).rejects.toThrow(
      'signal-cli send failed: JSON-RPC -32603: An internal server error has occurred.'
    )
  })

  it('requires the documented timestamp shape before treating send as accepted', async () => {
    const fetchMock: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const backend = new SignalCliHttpBackend({ fetch: fetchMock })

    await expect(backend.send('group==', 'payload')).rejects.toThrow(
      'signal-cli send returned an unsupported result shape'
    )
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

  it('extracts sender sync messages including manual receive wrappers', () => {
    expect(
      parseSignalReceive({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          subscription: 0,
          result: {
            account: '+49123',
            envelope: {
              syncMessage: {
                sentMessage: { message: 'payload', groupInfo: { groupId: 'group==' } }
              }
            }
          }
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

  it('rejects endpoint credentials and non-origin endpoint configuration', () => {
    expect(
      () => new SignalCliHttpBackend({ baseUrl: 'http://user:secret@127.0.0.1:8080' })
    ).toThrow(/credentials/)
    expect(() => new SignalCliHttpBackend({ baseUrl: 'http://127.0.0.1:8080/rpc' })).toThrow(
      /origin/
    )
  })

  it('rejects non-HTTP protocols for the signal-cli endpoint', () => {
    expect(() => new SignalCliHttpBackend({ baseUrl: 'ftp://127.0.0.1:8080' })).toThrow(
      /http or https/
    )
    expect(() => new SignalCliHttpBackend({ baseUrl: 'ws://127.0.0.1:8080' })).toThrow(
      /http or https/
    )
  })

  it('rejects an empty account string when explicitly provided', () => {
    expect(() => new SignalCliHttpBackend({ account: '   ' })).toThrow(/non-empty/)
  })

  it('rejects endpoints with query strings or fragments', () => {
    expect(() => new SignalCliHttpBackend({ baseUrl: 'http://127.0.0.1:8080?foo=bar' })).toThrow(
      /origin/
    )
    expect(() => new SignalCliHttpBackend({ baseUrl: 'http://127.0.0.1:8080#frag' })).toThrow(
      /origin/
    )
  })

  it('fails startup when the signal-cli health endpoint is not successful', async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/check')) return new Response('{}', { status: 503 })
      throw new Error(`unexpected URL ${url}`)
    }
    const backend = new SignalCliHttpBackend({ fetch: fetchMock })

    await expect(backend.start(() => undefined)).rejects.toThrow(
      'signal-cli health check failed: HTTP 503'
    )
  })

  it('includes the configured account on JSON-RPC sends', async () => {
    let requestBody: unknown
    const fetchMock: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body))
      const request = requestBody as { id: string }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { timestamp: 123 } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    }
    const backend = new SignalCliHttpBackend({ account: '+49123', fetch: fetchMock })
    await backend.send('group==', 'payload')
    expect(requestBody).toMatchObject({
      method: 'send',
      params: { account: '+49123', groupId: 'group==', message: 'payload' }
    })
  })

  it('surfaces JSON-RPC errors without echoing response data', async () => {
    const fetchMock: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: string }
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32602, message: 'bad params', data: { account: 'must-not-leak' } }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    const backend = new SignalCliHttpBackend({ fetch: fetchMock })
    await expect(backend.send('group==', 'payload')).rejects.toThrow(
      'signal-cli send failed: JSON-RPC -32602: bad params'
    )
    await expect(backend.send('group==', 'payload')).rejects.not.toThrow(/must-not-leak/)
  })

  it('checks version and configured group visibility before opening SSE', async () => {
    const methods: string[] = []
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/check') return new Response(null, { status: 200 })
      if (url.pathname !== '/api/v1/rpc') throw new Error(`unexpected URL ${url}`)
      const request = JSON.parse(String(init?.body)) as {
        id: string
        method: string
        params: Record<string, unknown>
      }
      methods.push(request.method)
      const result =
        request.method === 'version'
          ? { version: '0.14.7' }
          : request.method === 'listGroups'
            ? [{ id: 'group==', isMember: true, isBlocked: false }]
            : undefined
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const backend = new SignalCliHttpBackend({
      account: '+49123',
      fetch: fetchMock,
      requiredGroupIds: ['missing==']
    })
    await expect(backend.start(() => undefined)).rejects.toThrow(/does not expose 1 configured/)
    expect(methods).toEqual(['version', 'listGroups'])
    expect(backend.detectedVersion()).toBe('0.14.7')
  })

  it('does not require the undocumented version RPC when the daemon returns method-not-found', async () => {
    const methods: string[] = []
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/check') return new Response(null, { status: 200 })
      if (url.pathname === '/api/v1/events')
        return new Response('', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      const request = JSON.parse(String(init?.body)) as { id: string; method: string }
      methods.push(request.method)
      const body =
        request.method === 'version'
          ? { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }
          : {
              jsonrpc: '2.0',
              id: request.id,
              result: [{ id: 'group==', isMember: true, isBlocked: false }]
            }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    const backend = new SignalCliHttpBackend({
      fetch: fetchMock,
      requiredGroupIds: ['group=='],
      reconnectDelayMs: 10,
      reconnectMaxDelayMs: 10
    })
    await backend.start(() => undefined)
    await backend.stop()
    expect(methods).toEqual(['version', 'listGroups'])
    expect(backend.detectedVersion()).toBeUndefined()
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
    let eventAccept: string | null = null
    let eventAccount: string | null = null
    const fetchMock: typeof fetch = async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === '/api/v1/check') return new Response(null, { status: 200 })
      if (url.pathname === '/api/v1/rpc') {
        const request = JSON.parse(String(init?.body)) as { id: string; method: string }
        if (request.method !== 'version') throw new Error(`unexpected RPC ${request.method}`)
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { version: '0.14.7' } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.pathname === '/api/v1/events') {
        eventRequests += 1
        eventAccount = url.searchParams.get('account')
        eventAccept = new Headers(init?.headers).get('accept')
        const body =
          eventRequests === 1
            ? `event: ignored\ndata: not-json\n\n${event('+49999')}`
            : `event: receive\r\n${event('+49123')}`
        return new Response(body, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
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
    expect(eventAccount).toBe('+49123')
    expect(eventAccept).toBe('text/event-stream')
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('condition was not met')
}
