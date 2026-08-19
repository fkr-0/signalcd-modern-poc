import { describe, expect, it } from 'vitest'
import {
  DedupCache,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  chunkEnvelope,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  isSupportedProtocolVersion,
  reassembleChunks,
  validateEnvelope
} from './index'

const documentId = '11111111-1111-4111-8111-111111111111'
const messageId = '22222222-2222-4222-8222-222222222222'

function changeEnvelope(payload = new Uint8Array([1, 2, 3, 4])) {
  return createEnvelope({
    documentId,
    messageId,
    senderId: 'device-A',
    kind: 'automerge-change',
    createdAt: 1_787_159_200_000,
    sequence: 7,
    payload
  })
}

describe('protocol envelope', () => {
  it('round-trips the v1 binary codec without aliasing payload storage', () => {
    const original = changeEnvelope()
    const decoded = decodeEnvelope(encodeEnvelope(original))
    expect(decoded).toEqual(original)
    expect(decoded.payload).not.toBe(original.payload)
  })

  it('keeps the v1 wire representation stable', () => {
    const encoded = encodeEnvelope(changeEnvelope())
    const hex = Array.from(encoded, (byte) => byte.toString(16).padStart(2, '0')).join('')
    expect(hex).toBe(
      '45324543010101000001a01afd41000000000000000007002431313131313131312d313131312d343131312d383131312d313131313131313131313131002432323232323232322d323232322d343232322d383232322d32323232323232323232323200086465766963652d410000000401020304'
    )
  })

  it('rejects malformed envelopes and unknown frame kinds', () => {
    expect(() => validateEnvelope({ ...changeEnvelope(), documentId: 'not-a-uuid' })).toThrow(
      ProtocolValidationError
    )
    expect(() => validateEnvelope({ ...changeEnvelope(), kind: 'future-frame' })).toThrow(
      /unsupported frame kind/
    )
    expect(() => validateEnvelope({ ...changeEnvelope(), unexpected: true })).toThrow(
      /not a recognized field/
    )
  })

  it('rejects unknown protocol versions before payload processing', () => {
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION)).toBe(true)
    expect(isSupportedProtocolVersion(PROTOCOL_VERSION + 1)).toBe(false)
    const encoded = encodeEnvelope(changeEnvelope())
    encoded[4] = 2
    expect(() => decodeEnvelope(encoded)).toThrow(/unsupported protocol version 2/)

    const unknownKind = encodeEnvelope(changeEnvelope())
    unknownKind[5] = 255
    expect(() => decodeEnvelope(unknownKind)).toThrow(/unknown frame kind code 255/)
  })

  it('rejects trailing and truncated binary frames', () => {
    const encoded = encodeEnvelope(changeEnvelope())
    expect(() => decodeEnvelope(encoded.slice(0, -1))).toThrow(/truncated envelope/)
    const trailing = new Uint8Array(encoded.byteLength + 1)
    trailing.set(encoded)
    expect(() => decodeEnvelope(trailing)).toThrow(/trailing bytes/)
  })
})

describe('chunking and reassembly', () => {
  it('reassembles shuffled chunks deterministically and ignores identical duplicate indexes', () => {
    let counter = 0
    const ids = [
      '30000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003'
    ]
    const original = changeEnvelope(new Uint8Array([10, 20, 30, 40, 50]))
    const chunks = chunkEnvelope(original, {
      maxPayloadBytes: 2,
      createMessageId: () => ids[counter++]!
    })
    expect(decodeEnvelope(encodeEnvelope(chunks[0]!))).toEqual(chunks[0])
    const rebuilt = reassembleChunks([chunks[2]!, chunks[0]!, chunks[1]!, chunks[0]!])
    expect(rebuilt).toEqual(original)
  })

  it('rejects a broken chunk message ID generator', () => {
    expect(() =>
      chunkEnvelope(changeEnvelope(new Uint8Array([1, 2, 3])), {
        maxPayloadBytes: 1,
        createMessageId: () => '50000000-0000-4000-8000-000000000001'
      })
    ).toThrow(/duplicate identifier/)
  })

  it('rejects incomplete and conflicting chunk sets', () => {
    let counter = 0
    const ids = [
      '40000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000003'
    ]
    const chunks = chunkEnvelope(changeEnvelope(new Uint8Array([1, 2, 3, 4, 5])), {
      maxPayloadBytes: 2,
      createMessageId: () => ids[counter++]!
    })
    expect(() => reassembleChunks(chunks.slice(0, 2))).toThrow(/incomplete chunk set/)
    const conflicting = { ...chunks[0]!, payload: new Uint8Array([99, 99]) }
    expect(() => reassembleChunks([...chunks, conflicting])).toThrow(/conflicting duplicate chunk/)
  })
})

describe('dedup cache', () => {
  it('deduplicates by document/message identity with bounded TTL state', () => {
    const cache = new DedupCache({ maxEntries: 2, ttlMs: 10 })
    const envelope = changeEnvelope()
    expect(cache.hasOrAdd(envelope, 100)).toBe(false)
    expect(cache.hasOrAdd(envelope, 105)).toBe(true)
    expect(cache.hasOrAdd(envelope, 116)).toBe(false)
    expect(cache.size).toBe(1)
  })
})
