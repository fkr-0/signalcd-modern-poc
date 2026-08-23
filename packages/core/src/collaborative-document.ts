import * as Automerge from '@automerge/automerge'

type DocumentState = { text: string }

const BOOTSTRAP_ACTOR = '00000000000000000000000000000001'
const EMPTY_DOCUMENT = Automerge.save(
  Automerge.change(
    Automerge.init<DocumentState>({ actor: BOOTSTRAP_ACTOR }),
    { time: 0 },
    (draft) => {
      draft.text = ''
    }
  )
)

export type DocumentChange = Uint8Array
export type DocumentSubscriber = (text: string) => void

export interface TextEdit {
  index: number
  deleteCount: number
  insert: string
}

function deriveSingleSplice(previous: string, next: string): TextEdit | undefined {
  if (previous === next) return undefined

  let prefix = 0
  const maxPrefix = Math.min(previous.length, next.length)
  while (prefix < maxPrefix && previous[prefix] === next[prefix]) prefix += 1

  let suffix = 0
  const maxSuffix = Math.min(previous.length - prefix, next.length - prefix)
  while (
    suffix < maxSuffix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    index: prefix,
    deleteCount: previous.length - prefix - suffix,
    insert: next.slice(prefix, next.length - suffix)
  }
}

export class CollaborativeDocument {
  private doc: Automerge.Doc<DocumentState>
  private readonly listeners = new Set<DocumentSubscriber>()

  constructor(initialState?: Uint8Array) {
    this.doc = Automerge.load<DocumentState>(initialState ?? EMPTY_DOCUMENT)
  }

  getText(): string {
    return this.doc.text
  }

  getHeads(): Automerge.Heads {
    return Automerge.getHeads(this.doc)
  }

  subscribe(listener: DocumentSubscriber): () => void {
    this.listeners.add(listener)
    listener(this.getText())
    return () => this.listeners.delete(listener)
  }

  editText(nextText: string): DocumentChange[] {
    const edit = deriveSingleSplice(this.getText(), nextText)
    return edit ? this.spliceText(edit) : []
  }

  spliceText(edit: TextEdit): DocumentChange[] {
    const { index, deleteCount, insert } = edit
    const length = this.doc.text.length
    if (index < 0 || deleteCount < 0 || index > length || index + deleteCount > length) {
      throw new RangeError('text splice is outside the current document')
    }
    if (deleteCount === 0 && insert.length === 0) return []

    const before = this.doc
    this.doc = Automerge.change(this.doc, (draft) => {
      Automerge.splice(draft, ['text'], index, deleteCount, insert)
    })
    const changes = Automerge.getChanges(before, this.doc)
    this.emit()
    return changes
  }

  applyChanges(changes: readonly DocumentChange[]): boolean {
    if (changes.length === 0) return false
    const beforeHeads = this.getHeads().join(',')
    const [next] = Automerge.applyChanges(this.doc, [...changes])
    this.doc = next
    const changed = beforeHeads !== this.getHeads().join(',')
    if (changed) this.emit()
    return changed
  }

  mergeSnapshot(snapshot: Uint8Array): boolean {
    const beforeHeads = this.getHeads().join(',')
    this.doc = Automerge.merge(this.doc, Automerge.load<DocumentState>(snapshot))
    const changed = beforeHeads !== this.getHeads().join(',')
    if (changed) this.emit()
    return changed
  }

  save(): Uint8Array {
    return Automerge.save(this.doc)
  }

  clone(): CollaborativeDocument {
    return new CollaborativeDocument(this.save())
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.getText())
  }
}
