import { createEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { SidecarBridge } from '../../sidecar/src/bridge'
import { SignalCliHttpBackend } from '../../sidecar/src/signal-cli'
import { DEFAULT_TOY_ACCOUNT_A, DEFAULT_TOY_ACCOUNT_B, DEFAULT_TOY_GROUP_ID } from './contract'
import { ToySignalCliServer } from './server'

const documentId = '11111111-1111-4111-8111-111111111111'
const servers: ToySignalCliServer[] = []
const bridges: SidecarBridge[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()))
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

describe('sidecar backend contract API', () => {
  it('health check returns the documented mock capability payload', async () => {
    const baseUrl = await startToy()
    const response = await fetch(`${baseUrl}/api/v1/check`)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'ok',
      toy: true,
      apiVersion: 1,
      debugDecrypt: false,
      registeredIdentities: 0,
      activeGroups: 0
    })
  })

  it('enables and disables debug decrypt through config and reflects both states in health', async () => {
    const baseUrl = await startToy()

    for (const debugDecrypt of [true, false]) {
      const configured = await fetch(`${baseUrl}/__toy__/v1/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ debugDecrypt })
      })
      expect(configured.status).toBe(200)
      await expect(configured.json()).resolves.toEqual({ debugDecrypt })
      await expect(
        fetch(`${baseUrl}/api/v1/check`).then((response) => response.json())
      ).resolves.toMatchObject({ debugDecrypt })
    }
  })

  it('exports sync-log entries with the complete structured diagnostic field set', async () => {
    const server = new ToySignalCliServer({ port: 0, now: () => 1234 })
    servers.push(server)
    const { baseUrl } = await server.start()
    server.syncLog.append({
      level: 'decrypted',
      direction: 'outbound',
      senderPhone: '+15550000001',
      recipientPhone: '+15550000002',
      documentId,
      envelopeKind: 'automerge-change',
      messageId: '22222222-2222-4222-8222-222222222222',
      preview: 'hello encrypted world',
      signatureValid: true
    })

    const response = await fetch(`${baseUrl}/__toy__/v1/sync-log/export`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      {
        timestamp: 1234,
        level: 'decrypted',
        direction: 'outbound',
        senderPhone: '+15550000001',
        recipientPhone: '+15550000002',
        documentId,
        envelopeKind: 'automerge-change',
        messageId: '22222222-2222-4222-8222-222222222222',
        preview: 'hello encrypted world',
        signatureValid: true
      }
    ])
  })

  it('send to group validates input and returns a timestamp result', async () => {
    const baseUrl = await startToy()
    const result = await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 'test-send-1',
      method: 'send',
      params: {
        account: DEFAULT_TOY_ACCOUNT_A,
        groupId: DEFAULT_TOY_GROUP_ID,
        message: 'e2e-col:v1:AQIDBA=='
      }
    })

    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 'test-send-1',
      result: { timestamp: expect.any(Number) }
    })
  })

  it('send with missing account returns invalid params in multi-account mode', async () => {
    const baseUrl = await startToy()
    const result = await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 'test-send-2',
      method: 'send',
      params: { groupId: DEFAULT_TOY_GROUP_ID, message: 'e2e-col:v1:AQIDBA==' }
    })

    expect(result).toMatchObject({
      jsonrpc: '2.0',
      id: 'test-send-2',
      error: { code: -32602 }
    })
  })

  it('send to a non-existent group returns the documented backend error', async () => {
    const baseUrl = await startToy()
    const result = await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 'test-send-3',
      method: 'send',
      params: {
        account: DEFAULT_TOY_ACCOUNT_A,
        groupId: 'bm9uLWV4aXN0ZW50',
        message: 'e2e-col:v1:AQIDBA=='
      }
    })

    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 'test-send-3',
      error: { code: -32000, message: 'group not found', data: null }
    })
  })

  it('receive via SSE emits a recipient dataMessage with account and group binding', async () => {
    const baseUrl = await startToy()
    const stream = await openSse(baseUrl)
    await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 'test-sse',
      method: 'send',
      params: {
        account: DEFAULT_TOY_ACCOUNT_B,
        groupId: DEFAULT_TOY_GROUP_ID,
        message: 'e2e-col:v1:AQIDBA=='
      }
    })

    const events = [await stream.nextEvent(), await stream.nextEvent()].map(asRecord)
    const recipient = events.find(
      (event) => asRecord(event.params).account === DEFAULT_TOY_ACCOUNT_A
    )
    expect(recipient).toBeDefined()
    const params = asRecord(recipient!.params)
    const envelope = asRecord(params.envelope)
    expect(asRecord(envelope.dataMessage)).toMatchObject({
      message: 'e2e-col:v1:AQIDBA==',
      groupInfo: { groupId: DEFAULT_TOY_GROUP_ID }
    })
    stream.close()
  })

  it('suppresses the sender sync echo before it reaches the originating browser', async () => {
    const baseUrl = await startToy()
    const bridge = new SidecarBridge({
      backend: new SignalCliHttpBackend({ baseUrl, account: DEFAULT_TOY_ACCOUNT_A }),
      documentGroups: { [documentId]: DEFAULT_TOY_GROUP_ID },
      port: 0,
      retryDelayMs: 1
    })
    bridges.push(bridge)
    const address = await bridge.start()
    const socket = await openSocket(
      `ws://${address.host}:${address.port}/?documentId=${documentId}`
    )
    sockets.push(socket)
    const echoed = messageWithin(socket, 80)

    socket.send(
      encodeEnvelope(
        createEnvelope({
          documentId,
          messageId: crypto.randomUUID(),
          senderId: 'browser-a',
          kind: 'automerge-change',
          createdAt: Date.now(),
          payload: new Uint8Array([1, 2, 3])
        })
      )
    )

    expect(await echoed).toBe(false)
  })

  it('unknown RPC methods return JSON-RPC method-not-found', async () => {
    const baseUrl = await startToy()
    const result = await rpc(baseUrl, {
      jsonrpc: '2.0',
      id: 'test-unknown',
      method: 'nonExistentMethod',
      params: {}
    })

    expect(result).toEqual({
      jsonrpc: '2.0',
      id: 'test-unknown',
      error: { code: -32601, message: 'Method not found: nonExistentMethod', data: null }
    })
  })
})

async function startToy(): Promise<string> {
  const server = new ToySignalCliServer({ port: 0 })
  servers.push(server)
  return (await server.start()).baseUrl
}

async function rpc(baseUrl: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}/api/v1/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  expect(response.status).toBe(200)
  return response.json()
}

async function openSse(baseUrl: string): Promise<{ nextEvent(): Promise<unknown>; close(): void }> {
  const abort = new AbortController()
  const response = await fetch(`${baseUrl}/api/v1/events`, { signal: abort.signal })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async nextEvent() {
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (data) return JSON.parse(data) as unknown
        }
        const { done, value } = await reader.read()
        if (done) throw new Error('SSE stream ended before an event arrived')
        buffer += decoder.decode(value, { stream: true })
      }
    },
    close: () => abort.abort()
  }
}

async function openSocket(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return socket
}

function messageWithin(socket: WebSocket, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage)
      resolve(false)
    }, milliseconds)
    const onMessage = () => {
      clearTimeout(timer)
      resolve(true)
    }
    socket.once('message', onMessage)
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('expected object')
  return value as Record<string, unknown>
}
