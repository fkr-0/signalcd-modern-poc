import { describe, expect, it, vi } from 'vitest'
import { SyncEventLog } from './sync-log'

describe('SyncEventLog', () => {
  it('retains structured events, bounds previews, and polls strictly after a timestamp', () => {
    let now = 100
    const log = new SyncEventLog(() => now)
    log.append({ level: 'wire', direction: 'inbound', rawSizeBytes: 12 })
    now = 101
    log.append({
      level: 'decrypted',
      direction: 'outbound',
      preview: 'x'.repeat(300),
      signatureValid: true
    })

    expect(log.all()).toHaveLength(2)
    expect(log.all()[1]!.preview).toHaveLength(256)
    expect(log.since(100)).toEqual([
      expect.objectContaining({ timestamp: 101, level: 'decrypted' })
    ])
  })

  it('streams defensive entry copies and can reset retained history', () => {
    const listener = vi.fn()
    const log = new SyncEventLog(() => 42)
    const unsubscribe = log.subscribe(listener)
    log.append({ level: 'application', documentId: 'doc' })
    unsubscribe()
    log.append({ level: 'wire', rawSizeBytes: 1 })

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({
      timestamp: 42,
      level: 'application',
      documentId: 'doc'
    })
    log.reset()
    expect(log.all()).toEqual([])
  })
})
