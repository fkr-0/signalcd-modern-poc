import { expect, test } from 'vitest'
import { decryptRoomPacket, encryptRoomPacket, newRoomInvitation } from './peerjs-room-crypto'

async function key(secret: string, documentId: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(`signalcd-room-salt-v1:${documentId}`),
      info: new TextEncoder().encode('signalcd-room-AES-GCM-v1')
    },
    raw,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

test('room invitation carries 256 bits of fresh random secret', () => {
  const a = newRoomInvitation()
  const b = newRoomInvitation()
  expect(a.secret).toMatch(/^[0-9a-f]{64}$/)
  expect(a.secret).not.toBe(b.secret)
  expect(a.documentId).not.toBe(b.documentId)
})

test('authenticated room packet keeps ciphertext opaque and document-bound', async () => {
  const invite = newRoomInvitation()
  const cipher = await key(invite.secret, invite.documentId)
  const text = new TextEncoder().encode('a confidential document')
  const wire = await encryptRoomPacket(cipher, invite.documentId, 1, text)
  expect(new TextDecoder().decode(wire)).not.toContain('confidential')
  const decoded = await decryptRoomPacket(cipher, invite.documentId, wire)
  expect(decoded.kind).toBe(1)
  expect(decoded.payload).toEqual(text)
  await expect(decryptRoomPacket(cipher, crypto.randomUUID(), wire)).rejects.toThrow()
  const tampered = wire.slice()
  tampered[tampered.byteLength - 1]! ^= 0xff
  await expect(decryptRoomPacket(cipher, invite.documentId, tampered)).rejects.toThrow()
})

test('room protocol rejects invalid frames before accepting plaintext', async () => {
  const invite = newRoomInvitation()
  const cipher = await key(invite.secret, invite.documentId)
  await expect(
    decryptRoomPacket(cipher, invite.documentId, new Uint8Array([1, 2, 3]))
  ).rejects.toThrow('Invalid encrypted room frame')
})
