import { describe, expect, it, vi } from 'vitest'
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

  it('keeps the canonical empty history stable across independent module initialization times', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-08-21T10:00:00Z'))
      vi.resetModules()
      const FirstDocument = (await import('./collaborative-document')).CollaborativeDocument
      const first = new FirstDocument().save()

      vi.setSystemTime(new Date('2026-08-21T10:05:00Z'))
      vi.resetModules()
      const SecondDocument = (await import('./collaborative-document')).CollaborativeDocument
      const second = new SecondDocument().save()

      expect(second).toEqual(first)
      const source = new FirstDocument(first)
      const target = new SecondDocument(second)
      expect(() => target.applyChanges(source.editText('cross-context bootstrap'))).not.toThrow()
      expect(target.getText()).toBe('cross-context bootstrap')
    } finally {
      vi.useRealTimers()
      vi.resetModules()
    }
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

  it('keeps text-only snapshots compatible while structured state is created lazily', () => {
    const textOnly = new CollaborativeDocument()
    textOnly.editText('legacy text lane')
    const snapshot = textOnly.save()

    const structured = new CollaborativeDocument(snapshot)
    expect(structured.getStructuredView()).toEqual({ blocks: [], comments: [], attachments: [] })
    structured.insertBlock({ id: 'p-1', kind: 'paragraph', text: 'first block' })

    expect(structured.getText()).toBe('legacy text lane')
    expect(structured.getStructuredView().blocks).toEqual([
      { id: 'p-1', kind: 'paragraph', text: 'first block' }
    ])
  })

  it('supports block/list/comment/attachment operations and round-trips them', () => {
    const document = new CollaborativeDocument()
    document.insertBlock({ id: 'heading', kind: 'heading', text: 'Roadmap', headingLevel: 2 })
    document.insertBlock({
      id: 'task',
      kind: 'list-item',
      text: 'Ship structured CRDT',
      listStyle: 'task',
      checked: false,
      indent: 1
    })
    document.updateBlock('task', { checked: true })
    document.addComment({
      id: 'comment-1',
      authorId: 'alice',
      blockId: 'task',
      body: 'Verified in core',
      createdAt: 42
    })
    document.resolveComment('comment-1')
    document.addAttachment({
      id: 'attachment-1',
      name: 'evidence.txt',
      mediaType: 'text/plain',
      sizeBytes: 12,
      sha256: 'a'.repeat(64),
      contentRef: 'content://sha256/aaaaaaaa'
    })

    const restored = new CollaborativeDocument(document.save())
    expect(restored.getStructuredView()).toEqual({
      blocks: [
        { id: 'heading', kind: 'heading', text: 'Roadmap', headingLevel: 2 },
        {
          id: 'task',
          kind: 'list-item',
          text: 'Ship structured CRDT',
          listStyle: 'task',
          checked: true,
          indent: 1
        }
      ],
      comments: [
        {
          id: 'comment-1',
          authorId: 'alice',
          blockId: 'task',
          body: 'Verified in core',
          createdAt: 42,
          resolved: true
        }
      ],
      attachments: [
        {
          id: 'attachment-1',
          name: 'evidence.txt',
          mediaType: 'text/plain',
          sizeBytes: 12,
          sha256: 'a'.repeat(64),
          contentRef: 'content://sha256/aaaaaaaa'
        }
      ]
    })
  })

  it('removes comments bound to a removed block and keeps attachment metadata independent', () => {
    const document = new CollaborativeDocument()
    document.insertBlock({ id: 'p', kind: 'paragraph', text: 'annotated' })
    document.addComment({ id: 'c', authorId: 'alice', blockId: 'p', body: 'note', createdAt: 1 })
    document.addAttachment({
      id: 'a',
      name: 'asset.bin',
      mediaType: 'application/octet-stream',
      sizeBytes: 4
    })

    document.removeBlock('p')
    expect(document.getStructuredView()).toEqual({
      blocks: [],
      comments: [],
      attachments: [
        { id: 'a', name: 'asset.bin', mediaType: 'application/octet-stream', sizeBytes: 4 }
      ]
    })
  })

  it('converges concurrent structured-list inserts without changing the text lane', () => {
    const seed = new CollaborativeDocument()
    seed.editText('plain text stays independent')
    const a = seed.clone()
    const b = seed.clone()

    const aChanges = a.insertBlock({ id: 'a', kind: 'paragraph', text: 'A' })
    const bChanges = b.insertBlock({ id: 'b', kind: 'paragraph', text: 'B' })
    deliver(a, bChanges)
    deliver(b, aChanges)

    expect(a.getStructuredView()).toEqual(b.getStructuredView())
    expect(a.getText()).toBe('plain text stays independent')
    expect(b.getText()).toBe('plain text stays independent')
    expect(a.getHeads()).toEqual(b.getHeads())
  })

  it('validates structured operations before mutating CRDT state', () => {
    const document = new CollaborativeDocument()
    const before = document.save()

    expect(() => document.insertBlock({ id: '', kind: 'paragraph', text: 'bad' })).toThrow(
      'block id'
    )
    expect(() =>
      document.insertBlock({
        id: 'bad-heading',
        kind: 'heading',
        text: 'bad',
        headingLevel: 9 as 1
      })
    ).toThrow('headingLevel')
    expect(() =>
      document.addAttachment({
        id: 'a',
        name: 'a',
        mediaType: 'text/plain',
        sizeBytes: -1
      })
    ).toThrow('sizeBytes')
    expect(document.save()).toEqual(before)
  })
})
