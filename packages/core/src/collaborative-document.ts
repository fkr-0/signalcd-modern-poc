import * as Automerge from '@automerge/automerge'

export type DocumentBlockKind = 'paragraph' | 'heading' | 'list-item' | 'quote' | 'code'
export type DocumentListStyle = 'bullet' | 'ordered' | 'task'

export interface DocumentBlock {
  readonly id: string
  readonly kind: DocumentBlockKind
  readonly text: string
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  readonly listStyle?: DocumentListStyle
  readonly indent?: number
  readonly checked?: boolean
}

export interface DocumentBlockUpdate {
  readonly kind?: DocumentBlockKind
  readonly text?: string
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  readonly listStyle?: DocumentListStyle
  readonly indent?: number
  readonly checked?: boolean
}

export interface DocumentComment {
  readonly id: string
  readonly authorId: string
  readonly body: string
  readonly createdAt: number
  readonly blockId?: string
  readonly resolved: boolean
}

export interface CreateDocumentComment {
  readonly id: string
  readonly authorId: string
  readonly body: string
  readonly createdAt: number
  readonly blockId?: string
}

export interface DocumentAttachment {
  readonly id: string
  readonly name: string
  readonly mediaType: string
  readonly sizeBytes: number
  readonly sha256?: string
  /** Opaque application-managed content reference; attachment bytes are not stored in the CRDT. */
  readonly contentRef?: string
}

export interface StructuredDocumentView {
  readonly blocks: readonly DocumentBlock[]
  readonly comments: readonly DocumentComment[]
  readonly attachments: readonly DocumentAttachment[]
}

type MutableBlock = {
  id: string
  kind: DocumentBlockKind
  text: string
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  listStyle?: DocumentListStyle
  indent?: number
  checked?: boolean
}

type MutableComment = {
  id: string
  authorId: string
  body: string
  createdAt: number
  blockId?: string
  resolved: boolean
}

type MutableAttachment = {
  id: string
  name: string
  mediaType: string
  sizeBytes: number
  sha256?: string
  contentRef?: string
}

type DocumentState = {
  text: string
  blocks?: MutableBlock[]
  comments?: MutableComment[]
  attachments?: MutableAttachment[]
}

const BOOTSTRAP_ACTOR = '00000000000000000000000000000001'
const EMPTY_DOCUMENT = Automerge.save(
  Automerge.change(
    Automerge.init<DocumentState>({ actor: BOOTSTRAP_ACTOR }),
    { time: 0 },
    (draft) => {
      // Keep the canonical bootstrap text-only. Structured collections are
      // created lazily so historical text-only snapshots remain compatible.
      draft.text = ''
    }
  )
)

export type DocumentChange = Uint8Array
export type DocumentSubscriber = (text: string) => void
export type StructuredDocumentSubscriber = (view: StructuredDocumentView) => void

export interface TextEdit {
  index: number
  deleteCount: number
  insert: string
}

const MAX_STRUCTURED_ID_LENGTH = 128
const MAX_BLOCK_TEXT_LENGTH = 1_048_576
const MAX_COMMENT_BODY_LENGTH = 65_536
const MAX_ATTACHMENT_NAME_LENGTH = 512
const MAX_MEDIA_TYPE_LENGTH = 255
const MAX_CONTENT_REF_LENGTH = 4_096

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

function structuredId(value: string, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const id = value.trim()
  if (id.length === 0 || id.length > MAX_STRUCTURED_ID_LENGTH)
    throw new RangeError(
      `${label} must contain between 1 and ${MAX_STRUCTURED_ID_LENGTH} characters`
    )
  return id
}

function boundedText(value: string, label: string, max: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  if (value.length > max) throw new RangeError(`${label} must be at most ${max} characters`)
  return value
}

function normalizeBlock(value: DocumentBlock): MutableBlock {
  const id = structuredId(value.id, 'block id')
  const text = boundedText(value.text, 'block text', MAX_BLOCK_TEXT_LENGTH)
  const kind = value.kind
  if (!['paragraph', 'heading', 'list-item', 'quote', 'code'].includes(kind))
    throw new TypeError(`unsupported block kind ${String(kind)}`)

  if (kind === 'heading') {
    const headingLevel = value.headingLevel ?? 1
    if (!Number.isInteger(headingLevel) || headingLevel < 1 || headingLevel > 6)
      throw new RangeError('headingLevel must be an integer between 1 and 6')
    return { id, kind, text, headingLevel }
  }

  if (kind === 'list-item') {
    const listStyle = value.listStyle ?? 'bullet'
    if (!['bullet', 'ordered', 'task'].includes(listStyle))
      throw new TypeError(`unsupported list style ${String(listStyle)}`)
    const indent = value.indent ?? 0
    if (!Number.isSafeInteger(indent) || indent < 0 || indent > 8)
      throw new RangeError('list indent must be an integer between 0 and 8')
    return {
      id,
      kind,
      text,
      listStyle,
      indent,
      ...(listStyle === 'task' ? { checked: value.checked ?? false } : {})
    }
  }

  return { id, kind, text }
}

function normalizeComment(value: CreateDocumentComment): MutableComment {
  const id = structuredId(value.id, 'comment id')
  const authorId = structuredId(value.authorId, 'comment author id')
  const body = boundedText(value.body, 'comment body', MAX_COMMENT_BODY_LENGTH)
  if (body.trim().length === 0) throw new TypeError('comment body must be non-empty')
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0)
    throw new RangeError('comment createdAt must be a non-negative safe integer')
  return {
    id,
    authorId,
    body,
    createdAt: value.createdAt,
    ...(value.blockId === undefined
      ? {}
      : { blockId: structuredId(value.blockId, 'comment block id') }),
    resolved: false
  }
}

function normalizeAttachment(value: DocumentAttachment): MutableAttachment {
  const id = structuredId(value.id, 'attachment id')
  const name = boundedText(value.name.trim(), 'attachment name', MAX_ATTACHMENT_NAME_LENGTH)
  if (name.length === 0) throw new TypeError('attachment name must be non-empty')
  const mediaType = boundedText(
    value.mediaType.trim(),
    'attachment mediaType',
    MAX_MEDIA_TYPE_LENGTH
  )
  if (mediaType.length === 0) throw new TypeError('attachment mediaType must be non-empty')
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0)
    throw new RangeError('attachment sizeBytes must be a non-negative safe integer')
  if (value.sha256 !== undefined && !/^[a-f0-9]{64}$/iu.test(value.sha256))
    throw new TypeError('attachment sha256 must contain exactly 64 hexadecimal characters')
  const contentRef =
    value.contentRef === undefined
      ? undefined
      : boundedText(value.contentRef.trim(), 'attachment contentRef', MAX_CONTENT_REF_LENGTH)
  if (contentRef !== undefined && contentRef.length === 0)
    throw new TypeError('attachment contentRef must be non-empty when provided')
  return {
    id,
    name,
    mediaType,
    sizeBytes: value.sizeBytes,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256.toLowerCase() }),
    ...(contentRef === undefined ? {} : { contentRef })
  }
}

function cloneBlock(value: MutableBlock): DocumentBlock {
  return {
    id: value.id,
    kind: value.kind,
    text: value.text,
    ...(value.headingLevel === undefined ? {} : { headingLevel: value.headingLevel }),
    ...(value.listStyle === undefined ? {} : { listStyle: value.listStyle }),
    ...(value.indent === undefined ? {} : { indent: value.indent }),
    ...(value.checked === undefined ? {} : { checked: value.checked })
  }
}

function cloneComment(value: MutableComment): DocumentComment {
  return {
    id: value.id,
    authorId: value.authorId,
    body: value.body,
    createdAt: value.createdAt,
    ...(value.blockId === undefined ? {} : { blockId: value.blockId }),
    resolved: value.resolved
  }
}

function cloneAttachment(value: MutableAttachment): DocumentAttachment {
  return {
    id: value.id,
    name: value.name,
    mediaType: value.mediaType,
    sizeBytes: value.sizeBytes,
    ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
    ...(value.contentRef === undefined ? {} : { contentRef: value.contentRef })
  }
}

export class CollaborativeDocument {
  private doc: Automerge.Doc<DocumentState>
  private readonly listeners = new Set<DocumentSubscriber>()
  private readonly structuredListeners = new Set<StructuredDocumentSubscriber>()

  constructor(initialState?: Uint8Array) {
    this.doc = Automerge.load<DocumentState>(initialState ?? EMPTY_DOCUMENT)
  }

  getText(): string {
    return this.doc.text
  }

  getStructuredView(): StructuredDocumentView {
    return {
      blocks: (this.doc.blocks ?? []).map(cloneBlock),
      comments: (this.doc.comments ?? []).map(cloneComment),
      attachments: (this.doc.attachments ?? []).map(cloneAttachment)
    }
  }

  getHeads(): Automerge.Heads {
    return Automerge.getHeads(this.doc)
  }

  subscribe(listener: DocumentSubscriber): () => void {
    this.listeners.add(listener)
    listener(this.getText())
    return () => this.listeners.delete(listener)
  }

  subscribeStructured(listener: StructuredDocumentSubscriber): () => void {
    this.structuredListeners.add(listener)
    listener(this.getStructuredView())
    return () => this.structuredListeners.delete(listener)
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

    return this.change(
      (draft) => {
        Automerge.splice(draft, ['text'], index, deleteCount, insert)
      },
      true,
      false
    )
  }

  insertBlock(block: DocumentBlock, index = this.doc.blocks?.length ?? 0): DocumentChange[] {
    const normalized = normalizeBlock(block)
    const blocks = this.doc.blocks ?? []
    if (!Number.isSafeInteger(index) || index < 0 || index > blocks.length)
      throw new RangeError('block insertion index is outside the current structured document')
    if (blocks.some((candidate) => candidate.id === normalized.id))
      throw new Error(`block ${normalized.id} already exists`)
    return this.change(
      (draft) => {
        if (!draft.blocks) draft.blocks = []
        draft.blocks.splice(index, 0, normalized)
      },
      false,
      true
    )
  }

  updateBlock(blockId: string, update: DocumentBlockUpdate): DocumentChange[] {
    const id = structuredId(blockId, 'block id')
    const index = (this.doc.blocks ?? []).findIndex((block) => block.id === id)
    if (index < 0) throw new Error(`unknown block ${id}`)
    const current = cloneBlock(this.doc.blocks![index]!)
    const normalized = normalizeBlock({ ...current, ...update, id })
    if (JSON.stringify(current) === JSON.stringify(normalized)) return []
    return this.change(
      (draft) => {
        if (!draft.blocks) throw new Error('structured block state disappeared')
        draft.blocks[index] = normalized
      },
      false,
      true
    )
  }

  moveBlock(blockId: string, toIndex: number): DocumentChange[] {
    const id = structuredId(blockId, 'block id')
    const blocks = this.doc.blocks ?? []
    const fromIndex = blocks.findIndex((block) => block.id === id)
    if (fromIndex < 0) throw new Error(`unknown block ${id}`)
    if (!Number.isSafeInteger(toIndex) || toIndex < 0 || toIndex >= blocks.length)
      throw new RangeError('block destination index is outside the current structured document')
    if (fromIndex === toIndex) return []
    return this.change(
      (draft) => {
        if (!draft.blocks) throw new Error('structured block state disappeared')
        const [block] = draft.blocks.splice(fromIndex, 1)
        if (!block) throw new Error(`block ${id} disappeared during move`)
        draft.blocks.splice(toIndex, 0, block)
      },
      false,
      true
    )
  }

  removeBlock(blockId: string): DocumentChange[] {
    const id = structuredId(blockId, 'block id')
    const index = (this.doc.blocks ?? []).findIndex((block) => block.id === id)
    if (index < 0) return []
    return this.change(
      (draft) => {
        draft.blocks?.splice(index, 1)
        if (draft.comments) {
          for (let cursor = draft.comments.length - 1; cursor >= 0; cursor -= 1) {
            if (draft.comments[cursor]?.blockId === id) draft.comments.splice(cursor, 1)
          }
        }
      },
      false,
      true
    )
  }

  addComment(comment: CreateDocumentComment): DocumentChange[] {
    const normalized = normalizeComment(comment)
    const comments = this.doc.comments ?? []
    if (comments.some((candidate) => candidate.id === normalized.id))
      throw new Error(`comment ${normalized.id} already exists`)
    if (
      normalized.blockId !== undefined &&
      !(this.doc.blocks ?? []).some((block) => block.id === normalized.blockId)
    )
      throw new Error(`unknown comment block ${normalized.blockId}`)
    return this.change(
      (draft) => {
        if (!draft.comments) draft.comments = []
        draft.comments.push(normalized)
      },
      false,
      true
    )
  }

  resolveComment(commentId: string, resolved = true): DocumentChange[] {
    const id = structuredId(commentId, 'comment id')
    const index = (this.doc.comments ?? []).findIndex((comment) => comment.id === id)
    if (index < 0) throw new Error(`unknown comment ${id}`)
    if (this.doc.comments![index]!.resolved === resolved) return []
    return this.change(
      (draft) => {
        if (!draft.comments) throw new Error('structured comment state disappeared')
        draft.comments[index]!.resolved = resolved
      },
      false,
      true
    )
  }

  removeComment(commentId: string): DocumentChange[] {
    const id = structuredId(commentId, 'comment id')
    const index = (this.doc.comments ?? []).findIndex((comment) => comment.id === id)
    if (index < 0) return []
    return this.change(
      (draft) => {
        draft.comments?.splice(index, 1)
      },
      false,
      true
    )
  }

  addAttachment(attachment: DocumentAttachment): DocumentChange[] {
    const normalized = normalizeAttachment(attachment)
    if ((this.doc.attachments ?? []).some((candidate) => candidate.id === normalized.id))
      throw new Error(`attachment ${normalized.id} already exists`)
    return this.change(
      (draft) => {
        if (!draft.attachments) draft.attachments = []
        draft.attachments.push(normalized)
      },
      false,
      true
    )
  }

  removeAttachment(attachmentId: string): DocumentChange[] {
    const id = structuredId(attachmentId, 'attachment id')
    const index = (this.doc.attachments ?? []).findIndex((attachment) => attachment.id === id)
    if (index < 0) return []
    return this.change(
      (draft) => {
        draft.attachments?.splice(index, 1)
      },
      false,
      true
    )
  }

  applyChanges(changes: readonly DocumentChange[]): boolean {
    if (changes.length === 0) return false
    const beforeHeads = this.getHeads().join(',')
    const beforeText = this.getText()
    const [next] = Automerge.applyChanges(this.doc, [...changes])
    this.doc = next
    const changed = beforeHeads !== this.getHeads().join(',')
    if (changed) {
      if (beforeText !== this.getText()) this.emitText()
      this.emitStructured()
    }
    return changed
  }

  mergeSnapshot(snapshot: Uint8Array): boolean {
    const beforeHeads = this.getHeads().join(',')
    const beforeText = this.getText()
    this.doc = Automerge.merge(this.doc, Automerge.load<DocumentState>(snapshot))
    const changed = beforeHeads !== this.getHeads().join(',')
    if (changed) {
      if (beforeText !== this.getText()) this.emitText()
      this.emitStructured()
    }
    return changed
  }

  save(): Uint8Array {
    return Automerge.save(this.doc)
  }

  clone(): CollaborativeDocument {
    return new CollaborativeDocument(this.save())
  }

  private change(
    mutate: (
      draft: Automerge.ChangeFn<DocumentState> extends (doc: infer D) => unknown ? D : never
    ) => void,
    textChanged: boolean,
    structuredChanged: boolean
  ): DocumentChange[] {
    const before = this.doc
    this.doc = Automerge.change(this.doc, mutate as Automerge.ChangeFn<DocumentState>)
    const changes = Automerge.getChanges(before, this.doc)
    if (changes.length === 0) return []
    if (textChanged) this.emitText()
    if (structuredChanged) this.emitStructured()
    return changes
  }

  private emitText(): void {
    for (const listener of this.listeners) listener(this.getText())
  }

  private emitStructured(): void {
    const view = this.getStructuredView()
    for (const listener of this.structuredListeners) listener(view)
  }
}
