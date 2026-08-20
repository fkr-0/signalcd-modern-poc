import { describe, expect, it } from 'vitest'
import { DeterministicTransportNetwork } from './deterministic-network'
import { createLoopbackPair } from './loopback'

const bytes = (...values: number[]) => new Uint8Array(values)

describe('deterministic transport network', () => {
  it('delivers loopback updates as defensive copies', async () => {
    const { left, right } = createLoopbackPair()
    await left.connect('doc-1')
    await right.connect('doc-1')

    const received: Uint8Array[] = []
    right.subscribe((update) => received.push(update))
    const update = bytes(1, 2, 3)
    await left.send(update)
    update[0] = 99

    expect([...received[0]!]).toEqual([1, 2, 3])
    expect(left.getMetrics().delivered).toBe(1)
    expect(right.getMetrics().received).toBe(1)
  })

  it('uses virtual time to create deterministic reordering', async () => {
    const network = new DeterministicTransportNetwork({
      faults: [{ send: 1, delayMs: 20 }]
    })
    const left = network.createTransport('left')
    const right = network.createTransport('right')
    await left.connect('doc-1')
    await right.connect('doc-1')

    const received: number[] = []
    right.subscribe((update) => received.push(update[0]!))

    await left.send(bytes(1))
    await left.send(bytes(2))
    expect(received).toEqual([2])

    network.advanceBy(20)
    expect(received).toEqual([2, 1])
  })

  it('duplicates selected sends deterministically', async () => {
    const network = new DeterministicTransportNetwork({
      faults: [{ send: 1, duplicate: 2 }]
    })
    const left = network.createTransport('left')
    const right = network.createTransport('right')
    await left.connect('doc-1')
    await right.connect('doc-1')

    const received: number[] = []
    right.subscribe((update) => received.push(update[0]!))
    await left.send(bytes(7))

    expect(received).toEqual([7, 7, 7])
    expect(left.getMetrics().duplicated).toBe(2)
  })

  it('supports explicit hold/release reordering', async () => {
    const network = new DeterministicTransportNetwork({
      faults: [
        { send: 1, hold: true },
        { send: 2, hold: true }
      ]
    })
    const left = network.createTransport('left')
    const right = network.createTransport('right')
    await left.connect('doc-1')
    await right.connect('doc-1')

    const received: number[] = []
    right.subscribe((update) => received.push(update[0]!))
    await left.send(bytes(1))
    await left.send(bytes(2))
    expect(received).toEqual([])

    network.releaseHeld({ order: 'lifo' })
    expect(received).toEqual([2, 1])
  })

  it('queues outbound work while offline and flushes after reconnect', async () => {
    const { network, left, right } = createLoopbackPair()
    await left.connect('doc-1')
    await right.connect('doc-1')
    await left.disconnect()

    const received: number[] = []
    right.subscribe((update) => received.push(update[0]!))
    await left.send(bytes(5))

    expect(left.getMetrics().pendingOutbound).toBe(1)
    expect(received).toEqual([])

    await left.connect('doc-1')
    network.flush()
    expect(left.getMetrics().pendingOutbound).toBe(0)
    expect(left.getMetrics().reconnects).toBe(1)
    expect(received).toEqual([5])
  })

  it('retains inbound work for an offline receiver and catches up on reconnect', async () => {
    const { left, right } = createLoopbackPair()
    await left.connect('doc-1')
    await right.connect('doc-1')
    await right.disconnect()

    const received: number[] = []
    right.subscribe((update) => received.push(update[0]!))
    await left.send(bytes(8))

    expect(right.getMetrics().pendingInbound).toBe(1)
    expect(received).toEqual([])

    await right.connect('doc-1')
    expect(received).toEqual([8])
    expect(right.getMetrics().pendingInbound).toBe(0)
  })

  it('signals an intentional drop so a harness can request a snapshot/checkpoint', async () => {
    const network = new DeterministicTransportNetwork({
      faults: [{ send: 1, drop: true }]
    })
    const left = network.createTransport('left')
    const right = network.createTransport('right')
    await left.connect('doc-1')
    await right.connect('doc-1')

    const received: number[] = []
    const targetRecovery: number[] = []
    const sourceRecovery: number[] = []
    right.subscribe((update) => received.push(update[0]!))
    right.subscribeRecovery((event) => targetRecovery.push(event.sendSequence))
    left.subscribeRecovery((event) => sourceRecovery.push(event.sendSequence))

    await left.send(bytes(1))
    expect(received).toEqual([])
    expect(targetRecovery).toEqual([1])
    expect(sourceRecovery).toEqual([1])
    expect(left.getMetrics().dropped).toBe(1)
    expect(right.getMetrics().recoverySignals).toBe(1)
    expect(left.getMetrics().recoverySignals).toBe(1)

    // The transport does not interpret protocol kinds. A higher layer can react
    // to the recovery signal by sending an opaque snapshot/checkpoint payload.
    await left.send(bytes(9))
    expect(received).toEqual([9])
  })

  it('delivers already-published delayed work after the sender closes', async () => {
    const network = new DeterministicTransportNetwork({ latencyMs: 10 })
    const left = network.createTransport('left')
    const right = network.createTransport('right')
    await left.connect('doc-1')
    await right.connect('doc-1')

    const received: number[] = []
    right.subscribe((update) => received.push(update[0]!))
    await left.send(bytes(6))
    await left.close()

    network.advanceBy(10)
    expect(received).toEqual([6])
  })

  it('keeps repeated online connects idempotent and binds one document', async () => {
    const network = new DeterministicTransportNetwork()
    const transport = network.createTransport('left')
    await transport.connect('doc-1')
    await transport.connect('doc-1')

    expect(transport.getMetrics()).toMatchObject({
      connectAttempts: 1,
      successfulConnections: 1,
      reconnects: 0
    })

    await transport.disconnect()

    await expect(transport.connect('doc-2')).rejects.toThrow('already bound')
  })

  it('rejects invalid deterministic fault schedules', () => {
    expect(() => new DeterministicTransportNetwork({ faults: [{ send: 0, drop: true }] })).toThrow(
      'positive integer'
    )
    expect(
      () => new DeterministicTransportNetwork({ faults: [{ send: 1, delayMs: Number.NaN }] })
    ).toThrow('finite value')
  })

  it('isolates documents on the same simulated network', async () => {
    const network = new DeterministicTransportNetwork()
    const a = network.createTransport('a')
    const b = network.createTransport('b')
    const c = network.createTransport('c')
    await a.connect('doc-1')
    await b.connect('doc-1')
    await c.connect('doc-2')

    const bReceived: number[] = []
    const cReceived: number[] = []
    b.subscribe((update) => bReceived.push(update[0]!))
    c.subscribe((update) => cReceived.push(update[0]!))
    await a.send(bytes(4))

    expect(bReceived).toEqual([4])
    expect(cReceived).toEqual([])
  })
})
