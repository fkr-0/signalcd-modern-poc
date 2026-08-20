import { createEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { SidecarBridge } from './bridge'
import { SignalCliHttpBackend } from './signal-cli'

interface RealSignalFixture {
  readonly httpUrlA: string
  readonly httpUrlB: string
  readonly accountA: string
  readonly accountB: string
  readonly groupId: string
  readonly signalBodyMaxBytes: number
}

const documentId = '33333333-3333-4333-8333-333333333333'
const fixture = readFixture(process.env)

if (!fixture) {
  describe.skip('real signal-cli opt-in smoke', () => {
    it('unavailable: explicit two-account linked-device fixture is not configured', () => undefined)
  })
} else {
  describe('real signal-cli opt-in smoke', () => {
    const bridges: SidecarBridge[] = []
    afterEach(async () => Promise.all(bridges.splice(0).map((bridge) => bridge.stop())))

    it('routes one opaque protocol frame through two preconfigured Signal accounts without provisioning', async () => {
      const firstBackend = new SignalCliHttpBackend({
        baseUrl: fixture.httpUrlA,
        account: fixture.accountA,
        requiredGroupIds: [fixture.groupId]
      })
      const secondBackend = new SignalCliHttpBackend({
        baseUrl: fixture.httpUrlB,
        account: fixture.accountB,
        requiredGroupIds: [fixture.groupId]
      })
      const first = new SidecarBridge({
        backend: firstBackend,
        documentGroups: { [documentId]: fixture.groupId },
        port: 0,
        signalBodyMaxBytes: fixture.signalBodyMaxBytes
      })
      const second = new SidecarBridge({
        backend: secondBackend,
        documentGroups: { [documentId]: fixture.groupId },
        port: 0,
        signalBodyMaxBytes: fixture.signalBodyMaxBytes
      })
      bridges.push(first, second)
      const [firstAddress, secondAddress] = await Promise.all([first.start(), second.start()])
      const sender = new WebSocket(
        `ws://${firstAddress.host}:${firstAddress.port}/?documentId=${documentId}`
      )
      const receiver = new WebSocket(
        `ws://${secondAddress.host}:${secondAddress.port}/?documentId=${documentId}`
      )
      await Promise.all([opened(sender), opened(receiver)])

      const wire = encodeEnvelope(
        createEnvelope({
          documentId,
          messageId: crypto.randomUUID(),
          senderId: 'real-signal-smoke-a',
          kind: 'health',
          createdAt: Date.now(),
          payload: new Uint8Array([3, 1, 4, 1, 5, 9])
        })
      )
      const received = new Promise<Uint8Array>((resolve, reject) => {
        receiver.once('message', (data) => resolve(new Uint8Array(data as Buffer)))
        receiver.once('error', reject)
      })
      sender.send(wire)

      expect([...(await received)]).toEqual([...wire])
      sender.close()
      receiver.close()
    }, 60_000)
  })
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function readFixture(env: NodeJS.ProcessEnv): RealSignalFixture | undefined {
  if (env.E2E_COL_REAL_SIGNAL_SMOKE !== '1') return undefined
  const httpUrlA = env.E2E_COL_REAL_SIGNAL_HTTP_URL_A
  const httpUrlB = env.E2E_COL_REAL_SIGNAL_HTTP_URL_B
  const accountA = env.E2E_COL_REAL_SIGNAL_ACCOUNT_A
  const accountB = env.E2E_COL_REAL_SIGNAL_ACCOUNT_B
  const groupId = env.E2E_COL_REAL_SIGNAL_GROUP_ID
  const bodyLimit = env.E2E_COL_REAL_SIGNAL_BODY_MAX_BYTES
  if (!httpUrlA || !httpUrlB || !accountA || !accountB || !groupId || !bodyLimit) return undefined
  if (!/^[1-9][0-9]*$/.test(bodyLimit) || !Number.isSafeInteger(Number(bodyLimit))) return undefined
  return {
    httpUrlA,
    httpUrlB,
    accountA,
    accountB,
    groupId,
    signalBodyMaxBytes: Number(bodyLimit)
  }
}
