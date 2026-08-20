export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function exportRawKey(key: CryptoKey): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
}

export async function importEd25519Public(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(value), { name: 'Ed25519' }, true, ['verify'])
}

export async function importX25519Public(value: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', base64ToBytes(value), { name: 'X25519' }, true, [])
}
