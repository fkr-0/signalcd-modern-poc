import type { ProtocolEnvelope } from './types'

export interface DedupCacheOptions {
  readonly maxEntries?: number
  readonly ttlMs?: number
}

export class DedupCache {
  private readonly entries = new Map<string, number>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(options: DedupCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 4096
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0)
      throw new Error('maxEntries must be a positive safe integer')
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0)
      throw new Error('ttlMs must be a positive safe integer')
  }

  hasOrAdd(
    envelope: Pick<ProtocolEnvelope, 'documentId' | 'messageId'>,
    now = Date.now()
  ): boolean {
    this.prune(now)
    const key = `${envelope.documentId}\u0000${envelope.messageId}`
    const seenAt = this.entries.get(key)
    if (seenAt !== undefined) {
      this.entries.delete(key)
      this.entries.set(key, now)
      return true
    }
    this.entries.set(key, now)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return false
  }

  prune(now = Date.now()): void {
    for (const [key, seenAt] of this.entries) {
      if (now - seenAt < this.ttlMs) continue
      this.entries.delete(key)
    }
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
