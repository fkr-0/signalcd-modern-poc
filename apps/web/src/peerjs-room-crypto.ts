const HEADER = new Uint8Array([0x53, 0x43, 0x44, 0x31]) // SCD1
const IV_BYTES = 12
const MAX_PACKET_BYTES = 256 * 1024

export type RoomPacketKind = 1 | 2 | 3 | 4
export interface RoomPacket {
  readonly kind: RoomPacketKind
  readonly payload: Uint8Array
}

export function newRoomInvitation(): { documentId: string; secret: string } {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
  return { documentId: crypto.randomUUID(), secret }
}

function associatedData(documentId: string): Uint8Array {
  return new TextEncoder().encode(`signalcd-browser-demo-v1:${documentId}`)
}

export async function encryptRoomPacket(
  key: CryptoKey,
  documentId: string,
  kind: RoomPacketKind,
  payload: Uint8Array
): Promise<Uint8Array> {
  if (![1, 2, 3, 4].includes(kind)) throw new Error('Unsupported packet kind')
  if (payload.byteLength > MAX_PACKET_BYTES - 64) throw new Error('Packet too large')
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const plaintext = new Uint8Array(payload.byteLength + 1)
  plaintext[0] = kind
  plaintext.set(payload, 1)
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer as ArrayBuffer,
        additionalData: associatedData(documentId).buffer as ArrayBuffer
      },
      key,
      plaintext
    )
  )
  const frame = new Uint8Array(HEADER.byteLength + iv.byteLength + ciphertext.byteLength)
  frame.set(HEADER)
  frame.set(iv, HEADER.byteLength)
  frame.set(ciphertext, HEADER.byteLength + iv.byteLength)
  if (frame.byteLength > MAX_PACKET_BYTES) throw new Error('Encrypted packet too large')
  return frame
}

export async function decryptRoomPacket(
  key: CryptoKey,
  documentId: string,
  frame: Uint8Array
): Promise<RoomPacket> {
  if (
    frame.byteLength < HEADER.byteLength + IV_BYTES + 17 ||
    frame.byteLength > MAX_PACKET_BYTES ||
    HEADER.some((byte, i) => frame[i] !== byte)
  )
    throw new Error('Invalid encrypted room frame')
  const iv = frame.slice(HEADER.byteLength, HEADER.byteLength + IV_BYTES)
  const ciphertext = frame.slice(HEADER.byteLength + IV_BYTES)
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv.buffer as ArrayBuffer,
        additionalData: associatedData(documentId).buffer as ArrayBuffer
      },
      key,
      ciphertext
    )
  )
  const kind = plaintext[0]
  if (kind !== 1 && kind !== 2 && kind !== 3 && kind !== 4)
    throw new Error('Unknown encrypted room message kind')
  if (kind === 3 && plaintext.byteLength !== 1) throw new Error('Invalid snapshot-request body')
  if (kind === 4 && plaintext.byteLength !== 37) throw new Error('Invalid presence body')
  return { kind, payload: plaintext.slice(1) }
}
