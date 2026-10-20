import { expect, test } from 'vitest'
import {
  decodePresence,
  encodePresence,
  freshObservedPeers,
  MAX_OBSERVED_PEERS,
  PRESENCE_TTL_MS,
  updateObservedPeers
} from './peerjs-room-presence'

const a = '11111111-1111-4111-8111-111111111111'
const b = '22222222-2222-4222-8222-222222222222'

test('presence frames carry only anonymous tab UUID and reject malformed frames', () => {
  expect(decodePresence(encodePresence(a))).toBe(a)
  expect(decodePresence(new TextEncoder().encode('invalid'))).toBeUndefined()
  expect(() => encodePresence('unknown')).toThrow()
})

test('observed participants refresh, expire, and never exceed the bound', () => {
  let peers = updateObservedPeers([], a, 100)
  peers = updateObservedPeers(peers, b, 120)
  peers = updateObservedPeers(peers, a, 140)
  expect(peers).toHaveLength(2)
  expect(peers[0]?.id).toBe(a)
  expect(freshObservedPeers(peers, 140 + PRESENCE_TTL_MS + 1)).toHaveLength(0)
  for (let i = 0; i < MAX_OBSERVED_PEERS + 5; i++) {
    const id = `${(i + 3).toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
    peers = updateObservedPeers(peers, id, 500 + i)
  }
  expect(peers).toHaveLength(MAX_OBSERVED_PEERS)
})
