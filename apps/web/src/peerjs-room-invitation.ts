// The UUID is only a locator, never the authorization or encryption secret.
// Never print or persist the secret into diagnostics.
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const SECRET_PATTERN = /^[0-9a-f]{64}$/iu

export function validateRoomJoin(
  documentId: string,
  secret: string
): {
  documentId: string
  secret: string
} {
  const id = documentId.trim().toLowerCase()
  const key = secret.trim().toLowerCase()
  if (!UUID_PATTERN.test(id))
    throw new Error('Document UUID must be a valid UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).')
  if (!SECRET_PATTERN.test(key))
    throw new Error(
      'An invitation secret (64 hex characters) is also required. A UUID alone cannot decrypt a room.'
    )
  return { documentId: id, secret: key }
}

export function roomLink(origin: string, documentId: string, secret: string): string {
  const room = validateRoomJoin(documentId, secret)
  const url = new URL(origin)
  url.search = `?document=${encodeURIComponent(room.documentId)}`
  url.hash = `peerjs=${encodeURIComponent(room.secret)}`
  return url.href
}

export function parseRoomInput(
  urlInput: string,
  uuidInput: string,
  secretInput: string,
  origin: string
): string {
  if (urlInput.trim()) {
    let url: URL
    try {
      url = new URL(urlInput.trim(), origin)
    } catch {
      throw new Error('Paste a valid full invitation link.')
    }
    const expected = new URL(origin)
    if (url.origin !== expected.origin || url.pathname !== expected.pathname)
      throw new Error('Invitation must point to this SignalCD browser demo.')
    return roomLink(
      origin,
      url.searchParams.get('document') ?? '',
      new URLSearchParams(url.hash.slice(1)).get('peerjs') ?? ''
    )
  }
  return roomLink(origin, uuidInput, secretInput)
}

export function safeRoomCode(roomId: string): string {
  return roomId.slice(0, 12)
}
