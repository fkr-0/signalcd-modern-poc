import { expect, test } from 'vitest'
import { parseRoomInput, roomLink, validateRoomJoin } from './peerjs-room-invitation'

const id = 'c87037ea-b9a2-4783-a88c-c4f04f6b63f3'
const secret = 'aa'.repeat(32)
const origin = 'https://signalcd-poc.fkr.dev/peerjs/'

test('UUID alone is not a decryptable invitation', () => {
  expect(() => validateRoomJoin(id, '')).toThrow('A UUID alone cannot decrypt')
  expect(() => validateRoomJoin('invalid', secret)).toThrow('Document UUID')
})

test('accepts a complete invite without navigating to the source origin', () => {
  const full = roomLink(origin, id, secret)
  expect(parseRoomInput(full, '', '', origin)).toBe(full)
  expect(parseRoomInput('', id, secret, origin)).toBe(full)
})

test('does not accept external origins, other paths or truncated links', () => {
  expect(() =>
    parseRoomInput(`https://example.com/peerjs/?document=${id}#peerjs=${secret}`, '', '', origin)
  ).toThrow('must point')
  expect(() => parseRoomInput(`${origin}?document=${id}`, '', '', origin)).toThrow(
    'An invitation secret'
  )
  expect(() =>
    parseRoomInput(`${origin}other?document=${id}#peerjs=${secret}`, '', '', origin)
  ).toThrow('must point')
})
