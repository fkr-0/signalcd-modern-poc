import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TOY_ACCOUNT_A,
  DEFAULT_TOY_ACCOUNT_B,
  DEFAULT_TOY_GROUP_ID,
  RPC_METHOD_CONTRACTS,
  SUPPORTED_RPC_METHODS,
  TOY_SIGNAL_CLI_API_SPEC
} from './contract'
import { ToySignalCliServer } from './server'

interface ReceiveEvent {
  readonly method: 'receive'
  readonly params: {
    readonly account: string
    readonly envelope: {
      readonly syncMessage?: {
        readonly sentMessage: {
          readonly message: string
          readonly groupInfo?: { readonly groupId: string }
        }
      }
      readonly dataMessage?: {
        readonly message: string
        readonly groupInfo?: { readonly groupId: string }
      }
    }
  }
}

describe('toy signal-cli HTTP/JSON-RPC contract', () => {
  const servers: ToySignalCliServer[] = []
  afterEach(async () => Promise.all(servers.splice(0).map((server) => server.stop())))

  async function start(): Promise<string> {
    const server = new ToySignalCliServer({ port: 0 })
    servers.push(server)
    return (await server.start()).baseUrl
  }

  it('implements the exact health, RPC, SSE and toy-control endpoint profile', async () => {
    const baseUrl = await start()
    const check = await fetch(`${baseUrl}/api/v1/check`)
    expect(check.status).toBe(200)
    expect(await check.json()).toEqual({ ok: true, toy: true, contractVersion: 1 })

    const contract = await fetch(`${baseUrl}/__toy__/v1/contract`).then((response) =>
      response.json()
    )
    expect(contract).toEqual(TOY_SIGNAL_CLI_API_SPEC)

    const state = await fetch(`${baseUrl}/__toy__/v1/state`).then((response) => response.json())
    expect(state).toMatchObject({
      contractVersion: 1,
      accounts: [DEFAULT_TOY_ACCOUNT_A, DEFAULT_TOY_ACCOUNT_B]
    })
  })

  it('handles single and batch JSON-RPC requests with JSON-RPC errors', async () => {
    const baseUrl = await start()
    const single = await rpc(baseUrl, { jsonrpc: '2.0', method: 'listAccounts', id: 'accounts' })
    expect(single).toEqual({
      jsonrpc: '2.0',
      result: [DEFAULT_TOY_ACCOUNT_A, DEFAULT_TOY_ACCOUNT_B],
      id: 'accounts'
    })

    const batch = await rpc(baseUrl, [
      { jsonrpc: '2.0', method: 'version', id: 1 },
      {
        jsonrpc: '2.0',
        method: 'listGroups',
        params: { account: DEFAULT_TOY_ACCOUNT_A },
        id: 2
      },
      { jsonrpc: '2.0', method: 'doesNotExist', id: 3 }
    ])
    expect(batch).toEqual([
      { jsonrpc: '2.0', result: { version: '0.14.7-toy-e2e-col.1' }, id: 1 },
      expect.objectContaining({ jsonrpc: '2.0', id: 2 }),
      {
        jsonrpc: '2.0',
        error: { code: -32601, message: 'Method not found: doesNotExist', data: null },
        id: 3
      }
    ])

    const invalid = await rpc(baseUrl, { jsonrpc: '2.0', id: 'bad' })
    expect(invalid).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'method field must be set', data: null },
      id: 'bad'
    })

    const invalidId = await rpc(baseUrl, { jsonrpc: '2.0', method: 'version', id: { nope: true } })
    expect(invalidId).toEqual({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'id must be a string, number, or null', data: null },
      id: null
    })

    const notification = await fetch(`${baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'version' })
    })
    expect(notification.status).toBe(204)

    const malformed = await fetch(`${baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-json'
    }).then((response) => response.json())
    expect(malformed).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 }, id: null })
  })

  it('requires account routing in multi-account mode and supports fixed-account mode', async () => {
    const baseUrl = await start()
    const missing = await rpc(baseUrl, { jsonrpc: '2.0', method: 'listGroups', id: 1 })
    expect(missing).toMatchObject({ error: { code: -32602 } })
    const statusWithoutAccount = await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'getUserStatus',
      params: { recipient: DEFAULT_TOY_ACCOUNT_B },
      id: 'status-without-account'
    })
    expect(statusWithoutAccount).toMatchObject({ error: { code: -32602 } })

    const fixed = new ToySignalCliServer({ port: 0, fixedAccount: DEFAULT_TOY_ACCOUNT_A })
    servers.push(fixed)
    const fixedUrl = (await fixed.start()).baseUrl
    const groups = await rpc(fixedUrl, { jsonrpc: '2.0', method: 'listGroups', id: 2 })
    expect(groups).toMatchObject({ result: [{ id: DEFAULT_TOY_GROUP_ID }] })
  })

  it('implements group discovery, devices, link flow, subscriptions and group mutation', async () => {
    const baseUrl = await start()
    const params = { account: DEFAULT_TOY_ACCOUNT_A }
    const devices = await rpc(baseUrl, { jsonrpc: '2.0', method: 'listDevices', params, id: 1 })
    expect(devices).toMatchObject({ result: [{ id: 1 }, { id: 2 }] })

    const groups = await rpc(baseUrl, { jsonrpc: '2.0', method: 'listGroups', params, id: 2 })
    expect(groups).toMatchObject({
      result: [
        {
          id: DEFAULT_TOY_GROUP_ID,
          name: 'e2e-col demo',
          isMember: true,
          members: [{ number: DEFAULT_TOY_ACCOUNT_A }, { number: DEFAULT_TOY_ACCOUNT_B }]
        }
      ]
    })

    const updated = await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'updateGroup',
      params: { ...params, groupId: DEFAULT_TOY_GROUP_ID, name: 'renamed' },
      id: 3
    })
    expect(updated).toMatchObject({ result: { timestamp: expect.any(Number) } })

    const created = await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'updateGroup',
      params: { ...params, name: 'new group', members: [DEFAULT_TOY_ACCOUNT_B] },
      id: 'create-group'
    })
    expect(created).toMatchObject({ result: { timestamp: expect.any(Number) } })
    const groupsAfterCreate = await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'listGroups',
      params,
      id: 'groups-after-create'
    })
    expect(groupsAfterCreate).toMatchObject({
      result: expect.arrayContaining([
        expect.objectContaining({ name: 'new group', isMember: true })
      ])
    })

    const subscription = await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'subscribeReceive',
      params,
      id: 4
    })
    expect(subscription).toEqual({ jsonrpc: '2.0', result: 0, id: 4 })
    expect(
      await rpc(baseUrl, {
        jsonrpc: '2.0',
        method: 'unsubscribeReceive',
        params: { subscription: 0 },
        id: 5
      })
    ).toEqual({ jsonrpc: '2.0', result: {}, id: 5 })

    const startLink = (await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'startLink',
      id: 6
    })) as { result: { deviceLinkUri: string } }
    expect(startLink.result.deviceLinkUri).toMatch(/^sgnl:\/\/linkdevice\?uuid=/)
    const finishLink = await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'finishLink',
      params: { deviceLinkUri: startLink.result.deviceLinkUri, deviceName: 'demo' },
      id: 7
    })
    expect(finishLink).toMatchObject({ result: { deviceLinkUri: startLink.result.deviceLinkUri } })
  })

  it('delivers group send as receiver dataMessage plus sender syncMessage over SSE', async () => {
    const baseUrl = await start()
    const stream = await openSse(baseUrl)
    const send = await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'send',
      params: { account: DEFAULT_TOY_ACCOUNT_A, groupId: DEFAULT_TOY_GROUP_ID, message: 'hello' },
      id: 'send'
    })
    expect(send).toMatchObject({ result: { timestamp: expect.any(Number) } })

    const first = await stream.nextEvent()
    const second = await stream.nextEvent()
    const events = [first, second] as ReceiveEvent[]
    expect(events.map((event) => event.params.account).sort()).toEqual([
      DEFAULT_TOY_ACCOUNT_A,
      DEFAULT_TOY_ACCOUNT_B
    ])
    const sender = events.find((event) => event.params.account === DEFAULT_TOY_ACCOUNT_A)!
    const receiver = events.find((event) => event.params.account === DEFAULT_TOY_ACCOUNT_B)!
    expect(sender.params.envelope.syncMessage!.sentMessage).toMatchObject({
      message: 'hello',
      groupInfo: { groupId: DEFAULT_TOY_GROUP_ID }
    })
    expect(receiver.params.envelope.dataMessage!).toMatchObject({
      message: 'hello',
      groupInfo: { groupId: DEFAULT_TOY_GROUP_ID }
    })
    stream.close()
  })

  it('exposes deterministic test controls for failure, duplication, dropping and injection', async () => {
    const baseUrl = await start()
    await post(baseUrl, '/__toy__/v1/faults', {
      failNextRpcSends: 1,
      duplicateNextDeliveries: 1,
      dropNextDeliveries: 0,
      deliveryDelayMs: 0
    })
    const failed = await rpc(baseUrl, {
      jsonrpc: '2.0',
      method: 'send',
      params: { account: DEFAULT_TOY_ACCOUNT_A, groupId: DEFAULT_TOY_GROUP_ID, message: 'fail' },
      id: 1
    })
    expect(failed).toMatchObject({ error: { code: -32000 } })

    const stream = await openSse(baseUrl)
    await post(baseUrl, '/__toy__/v1/inject', {
      account: DEFAULT_TOY_ACCOUNT_B,
      groupId: DEFAULT_TOY_GROUP_ID,
      source: DEFAULT_TOY_ACCOUNT_A,
      message: 'injected'
    })
    expect((await stream.nextEvent()) as ReceiveEvent).toMatchObject({
      method: 'receive',
      params: { account: DEFAULT_TOY_ACCOUNT_B, envelope: { dataMessage: { message: 'injected' } } }
    })
    stream.close()
  })

  it('keeps its declared compatibility surface stable and explicit', () => {
    expect(SUPPORTED_RPC_METHODS).toEqual([
      'version',
      'listAccounts',
      'listDevices',
      'listGroups',
      'getUserStatus',
      'send',
      'updateGroup',
      'quitGroup',
      'sendSyncRequest',
      'subscribeReceive',
      'unsubscribeReceive',
      'startLink',
      'finishLink'
    ])
    expect(Object.keys(RPC_METHOD_CONTRACTS)).toEqual([...SUPPORTED_RPC_METHODS])
    for (const method of SUPPORTED_RPC_METHODS) {
      expect(RPC_METHOD_CONTRACTS[method].result.length).toBeGreaterThan(0)
    }
  })
})

async function rpc(baseUrl: string, body: unknown): Promise<unknown> {
  return fetch(`${baseUrl}/api/v1/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then((response) => (response.status === 204 ? undefined : response.json()))
}

async function post(baseUrl: string, path: string, body: unknown): Promise<unknown> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then((response) => response.json())
}

async function openSse(baseUrl: string): Promise<{
  nextEvent(): Promise<unknown>
  close(): void
}> {
  const abort = new AbortController()
  const response = await fetch(`${baseUrl}/api/v1/events`, { signal: abort.signal })
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
    close() {
      abort.abort()
    }
  }
}
