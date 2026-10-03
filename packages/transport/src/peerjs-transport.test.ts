import { FakePeerNetwork } from 'peerjslib/testing'
import { describe, expect, it } from 'vitest'
import { encodeMockSignalFanoutFrame } from './mock-signal-transport'
import { PeerJsTransport } from './peerjs-transport'
import type { TransportRecoveryRequired } from './types'

const documentId = '11111111-1111-4111-8111-111111111111'
const otherDocumentId = '22222222-2222-4222-8222-222222222222'
const rendezvousSecret = '0123456789abcdef0123456789abcdef'

async function tick(ms = 0): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return
    await tick(2)
  }
  throw new Error('condition did not become true')
}

describe('PeerJsTransport', () => {
  it('maps peerjslib hub acceptance and fan-out onto the opaque transport contract', async () => {
    const network = new FakePeerNetwork()
    const options = {
      rendezvousSecret,
      peerFactory: network,
      lobby: { ackTimeoutMs: 100, reconnectJitterRatio: 0 }
    } as const
    const alice = new PeerJsTransport(options)
    const bob = new PeerJsTransport(options)
    const bobSeen: number[][] = []
    alice.subscribe(() => {
      throw new Error('sender echo must stay suppressed')
    })
    bob.subscribe((bytes) => bobSeen.push([...bytes]))

    await alice.connect(documentId)
    await bob.connect(documentId)
    await alice.send(new Uint8Array([1, 2, 3]))
    await waitFor(() => bobSeen.length === 1)

    expect(bobSeen).toEqual([[1, 2, 3]])
    expect(alice.getState()).toBe('online')
    expect(bob.getState()).toBe('online')
    expect(alice.getMetrics()).toMatchObject({ sent: 1, delivered: 1 })
    expect(bob.getMetrics().received).toBe(1)

    await alice.close()
    await bob.close()
  })

  it('unwraps the local recipient from e2e-col fan-out while peerjslib carries opaque bytes', async () => {
    const network = new FakePeerNetwork()
    const common = {
      rendezvousSecret,
      peerFactory: network,
      lobby: { ackTimeoutMs: 100, reconnectJitterRatio: 0 }
    } as const
    const alice = new PeerJsTransport({ ...common, recipientPhoneNumber: '+15550000001' })
    const bob = new PeerJsTransport({ ...common, recipientPhoneNumber: '+15550000002' })
    const charlie = new PeerJsTransport({ ...common, recipientPhoneNumber: '+15550000003' })
    const bobSeen: number[][] = []
    const charlieSeen: number[][] = []
    bob.subscribe((bytes) => bobSeen.push([...bytes]))
    charlie.subscribe((bytes) => charlieSeen.push([...bytes]))
    await alice.connect(documentId)
    await bob.connect(documentId)
    await charlie.connect(documentId)

    const fanout = encodeMockSignalFanoutFrame({
      version: 1,
      messageId: '33333333-3333-4333-8333-333333333333',
      recipients: [
        { phoneNumber: '+15550000002', payload: new Uint8Array([2, 2]) },
        { phoneNumber: '+15550000003', payload: new Uint8Array([3, 3]) }
      ]
    })
    await alice.send(fanout)
    await waitFor(() => bobSeen.length === 1 && charlieSeen.length === 1)

    expect(bobSeen).toEqual([[2, 2]])
    expect(charlieSeen).toEqual([[3, 3]])
    await alice.close()
    await bob.close()
    await charlie.close()
  })

  it('uses document-bound private rooms even when the invitation secret is shared', async () => {
    const network = new FakePeerNetwork()
    const options = { rendezvousSecret, peerFactory: network } as const
    const first = new PeerJsTransport(options)
    const second = new PeerJsTransport(options)
    const seen: number[][] = []
    second.subscribe((bytes) => seen.push([...bytes]))

    await first.connect(documentId)
    await second.connect(otherDocumentId)
    await first.send(new Uint8Array([7]))
    await tick()

    expect(seen).toEqual([])
    expect(first.getLobbyHealth()?.role).toBe('hub')
    expect(second.getLobbyHealth()?.role).toBe('hub')

    await first.close()
    await second.close()
  })

  it('converts a bounded replay gap into a remote checkpoint request handled only by the hub', async () => {
    const network = new FakePeerNetwork()
    const options = {
      rendezvousSecret,
      peerFactory: network,
      lobby: {
        replayWindow: 1,
        ackTimeoutMs: 100,
        reconnectBaseDelayMs: 1,
        reconnectMaxDelayMs: 1,
        reconnectJitterRatio: 0
      }
    } as const
    const hub = new PeerJsTransport(options)
    const newcomer = new PeerJsTransport(options)
    const hubRecovery: TransportRecoveryRequired[] = []
    const newcomerRecovery: TransportRecoveryRequired[] = []
    const seen: number[][] = []
    hub.subscribeRecovery((event) => hubRecovery.push(event))
    newcomer.subscribeRecovery((event) => newcomerRecovery.push(event))
    newcomer.subscribe((bytes) => seen.push([...bytes]))

    await hub.connect(documentId)
    await hub.send(new Uint8Array([1]))
    await hub.send(new Uint8Array([2]))
    await newcomer.connect(documentId)

    await waitFor(() => newcomerRecovery.some((event) => event.reason === 'peerjs-replay-gap'))
    await waitFor(() => hubRecovery.some((event) => event.reason === 'peerjs-checkpoint-request'))

    expect(seen).toEqual([[2]])
    expect(newcomerRecovery).toContainEqual(
      expect.objectContaining({
        documentId,
        reason: 'peerjs-replay-gap',
        targetId: 'local-history'
      })
    )
    expect(hubRecovery).toContainEqual(
      expect.objectContaining({
        documentId,
        reason: 'peerjs-checkpoint-request',
        targetId: 'peerjs-checkpoint-publisher'
      })
    )
    // The transport-internal request is not exposed as application bytes or
    // counted as an application send/delivery.
    expect(newcomer.getMetrics()).toMatchObject({ sent: 0, delivered: 0 })
    expect(hub.getMetrics()).toMatchObject({ sent: 2, delivered: 2 })

    await hub.send(new Uint8Array([9, 9]))
    await waitFor(() => seen.some((bytes) => bytes[0] === 9))
    expect(seen.at(-1)).toEqual([9, 9])

    await hub.close()
    await newcomer.close()
  })

  it('fails closed on weak rendezvous secrets and document rebinding', async () => {
    const network = new FakePeerNetwork()
    expect(
      () => new PeerJsTransport({ rendezvousSecret: 'too-short', peerFactory: network })
    ).toThrow('at least 16 bytes')

    const transport = new PeerJsTransport({ rendezvousSecret, peerFactory: network })
    await transport.connect(documentId)
    await expect(transport.connect(otherDocumentId)).rejects.toThrow('already bound')
    await transport.close()
  })

  it('exposes self-hosted PeerJS options without allowing an ambiguous factory override', () => {
    expect(
      () =>
        new PeerJsTransport({
          rendezvousSecret,
          peerFactory: new FakePeerNetwork(),
          peerOptions: { host: '127.0.0.1', port: 9000, path: '/peerjs', secure: false }
        })
    ).toThrow('mutually exclusive')
  })
})
