import { DeterministicTransportNetwork } from './deterministic-network'
import { MockSignalTransport, type MockSignalTransportOptions } from './mock-signal-transport'
import type { ObservableCollaborativeTransport } from './types'
import { type WebSocketFactory, WebSocketTransport } from './websocket-transport'

export interface TransportFactoryContext {
  readonly documentId: string
}

export interface MockTransportRuntime {
  readonly authToken: string
  readonly groupId: string
  readonly userId: string
  readonly phoneNumber: string
}

export interface TransportFactoryConfig {
  readonly type: 'deterministic' | 'mock' | 'websocket'
  readonly mock?: {
    readonly serverUrl: string
    readonly resolveRuntime?: (context: TransportFactoryContext) => MockTransportRuntime
    readonly socketFactory?: WebSocketFactory
    readonly ackTimeoutMs?: number
  }
  readonly websocket?: {
    readonly url: string
    readonly socketFactory?: WebSocketFactory
  }
}

export type TransportFactory = (
  context: TransportFactoryContext
) => ObservableCollaborativeTransport

export function createTransportFactory(config: TransportFactoryConfig): TransportFactory {
  if (config.type === 'deterministic') {
    const network = new DeterministicTransportNetwork()
    let sequence = 0
    return ({ documentId }) => {
      sequence += 1
      return network.createTransport(`${documentId}:${sequence}`)
    }
  }

  if (config.type === 'websocket') {
    const websocket = config.websocket
    if (!websocket?.url) throw new TypeError('websocket transport requires websocket.url')
    return () =>
      new WebSocketTransport({
        url: websocket.url,
        ...(websocket.socketFactory === undefined ? {} : { socketFactory: websocket.socketFactory })
      })
  }

  const mock = config.mock
  if (!mock?.serverUrl) throw new TypeError('mock transport requires mock.serverUrl')
  return (context) => {
    const runtime = mock.resolveRuntime?.(context)
    if (!runtime)
      throw new Error('mock transport requires identity runtime binding via mock.resolveRuntime')
    const options: MockSignalTransportOptions = {
      url: mockMessagesUrl(mock.serverUrl),
      authToken: runtime.authToken,
      groupId: runtime.groupId,
      userId: runtime.userId,
      phoneNumber: runtime.phoneNumber,
      ...(mock.socketFactory === undefined ? {} : { socketFactory: mock.socketFactory }),
      ...(mock.ackTimeoutMs === undefined ? {} : { ackTimeoutMs: mock.ackTimeoutMs })
    }
    return new MockSignalTransport(options)
  }
}

function mockMessagesUrl(serverUrl: string): string {
  const url = new URL(serverUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
    throw new TypeError('mock.serverUrl must use http(s) or ws(s)')
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/api/v1/messages'
  return url.toString()
}
