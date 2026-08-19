import { describe, expect, it } from 'vitest'
import { CollaborativeDocument, type DocumentChange } from './collaborative-document'

function deliver(target: CollaborativeDocument, changes: DocumentChange[]): void {
  target.applyChanges(changes)
}

describe('CollaborativeDocument', () => {
  it('uses operation-aware text splices', () => {
    const document = new CollaborativeDocument()
    document.editText('hello world')
    document.editText('hello brave world')
    expect(document.getText()).toBe('hello brave world')
  })

  it('round-trips saved state', () => {
    const original = new CollaborativeDocument()
    original.editText('persist me')
    const restored = new CollaborativeDocument(original.save())
    expect(restored.getText()).toBe('persist me')
  })

  it('shares a canonical empty history across independently created replicas', () => {
    const a = new CollaborativeDocument()
    const b = new CollaborativeDocument()
    const changes = a.editText('hello peer')

    deliver(b, changes)

    expect(b.getText()).toBe('hello peer')
  })

  it('converges after concurrent inserts delivered in opposite orders', () => {
    const seed = new CollaborativeDocument()
    seed.editText('abcd')
    const a = seed.clone()
    const b = seed.clone()

    const aChanges = a.spliceText({ index: 1, deleteCount: 0, insert: 'A' })
    const bChanges = b.spliceText({ index: 3, deleteCount: 0, insert: 'B' })

    deliver(a, bChanges)
    deliver(b, aChanges)

    expect(a.getText()).toBe(b.getText())
    expect(a.getHeads()).toEqual(b.getHeads())
  })

  it('converges after overlapping concurrent edits', () => {
    const seed = new CollaborativeDocument()
    seed.editText('abcdefgh')
    const a = seed.clone()
    const b = seed.clone()

    const aChanges = a.spliceText({ index: 2, deleteCount: 3, insert: 'X' })
    const bChanges = b.spliceText({ index: 3, deleteCount: 2, insert: 'YZ' })

    deliver(a, bChanges)
    deliver(b, aChanges)

    expect(a.getText()).toBe(b.getText())
    expect(a.getHeads()).toEqual(b.getHeads())
  })

  it('treats duplicate delivery as idempotent', () => {
    const seed = new CollaborativeDocument()
    const a = seed.clone()
    const b = seed.clone()
    const changes = a.editText('once')

    expect(b.applyChanges(changes)).toBe(true)
    expect(b.applyChanges(changes)).toBe(false)
    expect(b.getText()).toBe('once')
  })
})
