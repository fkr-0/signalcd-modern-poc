import { describe, expect, it } from 'vitest'
import { SimulatedTransport } from './deterministic-network'
import { createTransportFactory } from './factory'
import { MockSignalTransport } from './mock-signal-transport'
import { WebSocketTransport } from './websocket-transport'

describe('createTransportFactory', () => {
  it('creates deterministic transports on one shared network with unique identities', async () => {
    const factory = createTransportFactory({ type: 'deterministic' })
    const first = factory({ documentId: 'doc' })
    const second = factory({ documentId: 'doc' })
    expect(first).toBeInstanceOf(SimulatedTransport)
    expect(second).toBeInstanceOf(SimulatedTransport)
    expect(first).not.toBe(second)

    const received: number[][] = []
    second.subscribe((bytes) => received.push([...bytes]))
    await first.connect('doc')
    await second.connect('doc')
    await first.send(new Uint8Array([1, 2, 3]))
    expect(received).toEqual([[1, 2, 3]])
  })

  it('creates websocket transports from config', () => {
    const factory = createTransportFactory({
      type: 'websocket',
      websocket: { url: 'ws://127.0.0.1:8765/updates' }
    })
    expect(factory({ documentId: 'doc' })).toBeInstanceOf(WebSocketTransport)
  })

  it('creates mock transports from server config plus identity runtime binding', () => {
    const factory = createTransportFactory({
      type: 'mock',
      mock: {
        serverUrl: 'http://127.0.0.1:18080',
        resolveRuntime: () => ({
          authToken: 'token',
          groupId: '11111111-1111-4111-8111-111111111111',
          userId: '22222222-2222-4222-8222-222222222222',
          phoneNumber: '+15550001234'
        })
      }
    })
    expect(factory({ documentId: '33333333-3333-4333-8333-333333333333' })).toBeInstanceOf(
      MockSignalTransport
    )
  })

  it('fails early for incomplete backend configuration', () => {
    expect(() => createTransportFactory({ type: 'websocket' })).toThrow('websocket.url')
    const factory = createTransportFactory({ type: 'mock', mock: { serverUrl: 'ws://localhost' } })
    expect(() => factory({ documentId: 'doc' })).toThrow('identity runtime binding')
  })
})
