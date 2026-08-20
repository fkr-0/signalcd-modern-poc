import { afterEach, describe, expect, it } from 'vitest'
import { ToySignalCliServer } from './server'

const servers: ToySignalCliServer[] = []

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()))
})

async function start(options: ConstructorParameters<typeof ToySignalCliServer>[0] = {}) {
  const server = new ToySignalCliServer({ port: 0, ...options })
  servers.push(server)
  return { server, baseUrl: (await server.start()).baseUrl }
}

describe('toy sync-log API', () => {
  it('toggles debug mode at runtime and exposes readiness counters', async () => {
    const { baseUrl } = await start({ debugDecrypt: false })

    await expect(
      fetch(`${baseUrl}/api/v1/check`).then((response) => response.json())
    ).resolves.toEqual({
      status: 'ok',
      toy: true,
      apiVersion: 1,
      debugDecrypt: false,
      registeredIdentities: 0,
      activeGroups: 0
    })

    const configured = await fetch(`${baseUrl}/__toy__/v1/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ debugDecrypt: true })
    })
    expect(configured.status).toBe(200)
    await expect(configured.json()).resolves.toEqual({ debugDecrypt: true })

    await expect(
      fetch(`${baseUrl}/api/v1/check`).then((response) => response.json())
    ).resolves.toMatchObject({
      status: 'ok',
      debugDecrypt: true
    })
  })

  it('supports polling, complete JSON export, and an SSE event stream', async () => {
    let now = 100
    const { server, baseUrl } = await start({ now: () => now })
    server.syncLog.append({ level: 'wire', direction: 'inbound', rawSizeBytes: 17 })
    now = 101
    server.syncLog.append({
      level: 'application',
      direction: 'outbound',
      documentId: '11111111-1111-4111-8111-111111111111',
      envelopeKind: 'membership'
    })

    const polled = await fetch(`${baseUrl}/__toy__/v1/sync-log?since=100`)
    expect(polled.status).toBe(200)
    await expect(polled.json()).resolves.toEqual([
      expect.objectContaining({ timestamp: 101, level: 'application', direction: 'outbound' })
    ])

    const exported = await fetch(`${baseUrl}/__toy__/v1/sync-log/export`)
    expect(exported.status).toBe(200)
    await expect(exported.json()).resolves.toHaveLength(2)

    const stream = await fetch(`${baseUrl}/__toy__/v1/sync-log`)
    expect(stream.status).toBe(200)
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const reader = stream.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader!.read()
    expect(new TextDecoder().decode(first.value)).toContain('"level":"wire"')
    await reader!.cancel()
  })

  it('rejects malformed poll timestamps and config values', async () => {
    const { baseUrl } = await start()
    expect((await fetch(`${baseUrl}/__toy__/v1/sync-log?since=bad`)).status).toBe(400)
    expect(
      (
        await fetch(`${baseUrl}/__toy__/v1/config`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ debugDecrypt: 'yes' })
        })
      ).status
    ).toBe(400)
  })
})
