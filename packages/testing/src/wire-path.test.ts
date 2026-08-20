import { CollaborativeDocument, type DocumentChange } from '@e2e-col/core'
import { createEnvelope, DedupCache, decodeEnvelope, encodeEnvelope } from '@e2e-col/protocol'
import { DeterministicTransportNetwork, type SimulatedTransport } from '@e2e-col/transport'
import { describe, expect, it } from 'vitest'

const documentId = '11111111-1111-4111-8111-111111111111'

function messageId(sequence: number): string {
  return `22222222-2222-4222-8222-${sequence.toString().padStart(12, '0')}`
}

function bindReceiver(document: CollaborativeDocument, transport: SimulatedTransport): DedupCache {
  const dedup = new DedupCache()
  transport.subscribe((wireBytes) => {
    const envelope = decodeEnvelope(wireBytes)
    if (envelope.documentId !== documentId || envelope.kind !== 'automerge-change') return
    if (dedup.hasOrAdd(envelope, envelope.createdAt)) return
    document.applyChanges([envelope.payload])
  })
  return dedup
}

async function sendChanges(
  transport: SimulatedTransport,
  senderId: string,
  changes: readonly DocumentChange[],
  sequenceOffset: number
): Promise<void> {
  for (let index = 0; index < changes.length; index += 1) {
    const sequence = sequenceOffset + index
    const envelope = createEnvelope({
      documentId,
      messageId: messageId(sequence),
      senderId,
      kind: 'automerge-change',
      createdAt: 1_787_159_200_000 + sequence,
      sequence,
      payload: changes[index]!
    })
    await transport.send(encodeEnvelope(envelope))
  }
}

describe('core + protocol + transport wire path', () => {
  it('converges concurrent encoded changes despite duplicate and reordered wire delivery', async () => {
    const network = new DeterministicTransportNetwork({
      faults: [
        { send: 1, hold: true, duplicate: 1 },
        { send: 2, hold: true }
      ]
    })
    const aTransport = network.createTransport('a')
    const bTransport = network.createTransport('b')
    const a = new CollaborativeDocument()
    const b = new CollaborativeDocument()
    const aDedup = bindReceiver(a, aTransport)
    const bDedup = bindReceiver(b, bTransport)
    await Promise.all([aTransport.connect(documentId), bTransport.connect(documentId)])

    const aChanges = a.editText('alpha')
    const bChanges = b.editText('beta')
    await sendChanges(aTransport, 'device-a', aChanges, 1)
    await sendChanges(bTransport, 'device-b', bChanges, 100)

    network.releaseHeld({ order: 'lifo' })

    expect(a.getText()).toBe(b.getText())
    expect(a.getHeads()).toEqual(b.getHeads())
    expect(bDedup.size).toBe(1)
    expect(aDedup.size).toBe(1)
  })

  it('rejects malformed wire frames before they reach the CRDT', async () => {
    const network = new DeterministicTransportNetwork()
    const left = network.createTransport('left')
    const right = network.createTransport('right')
    const document = new CollaborativeDocument()
    let rejected = 0

    right.subscribe((wireBytes) => {
      try {
        const envelope = decodeEnvelope(wireBytes)
        document.applyChanges([envelope.payload])
      } catch {
        rejected += 1
      }
    })
    await Promise.all([left.connect(documentId), right.connect(documentId)])

    await left.send(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))

    expect(rejected).toBe(1)
    expect(document.getText()).toBe('')
  })
})
