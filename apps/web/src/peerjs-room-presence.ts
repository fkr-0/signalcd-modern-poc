// Anonymous, best-effort presence updates travel inside the AES-GCM room envelope.
// These IDs are *not* authenticated participant identities.
export const PRESENCE_INTERVAL_MS = 12_000
export const PRESENCE_TTL_MS = 45_000
export const MAX_OBSERVED_PEERS = 64
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu

export interface ObservedPeer {
  readonly id: string
  readonly seenAt: number
}

export function encodePresence(id: string): Uint8Array {
  if (!UUID_PATTERN.test(id)) throw new Error('Invalid anonymous presence ID')
  return new TextEncoder().encode(id.toLowerCase())
}

export function decodePresence(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength !== 36) return undefined
  const id = new TextDecoder().decode(bytes)
  return UUID_PATTERN.test(id) ? id.toLowerCase() : undefined
}

export function updateObservedPeers(
  current: readonly ObservedPeer[],
  id: string,
  now: number
): ObservedPeer[] {
  if (!UUID_PATTERN.test(id)) return [...current]
  const filtered = current.filter((peer) => peer.id !== id && now - peer.seenAt < PRESENCE_TTL_MS)
  return [...filtered, { id, seenAt: now }]
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, MAX_OBSERVED_PEERS)
}

export function freshObservedPeers(current: readonly ObservedPeer[], now: number): ObservedPeer[] {
  return current.filter((peer) => now - peer.seenAt < PRESENCE_TTL_MS)
}
