import { createServer, type Server } from 'node:http'
import {
  chunkEnvelope,
  DedupCache,
  decodeEnvelope,
  encodeEnvelope,
  type ProtocolEnvelope,
  reassembleChunks
} from '@e2e-col/protocol'
import { type WebSocket, WebSocketServer } from 'ws'
import {
  type BroadcastBackend,
  type BroadcastMessage,
  BroadcastRecoveryRequiredError
} from './backend'

const SIGNAL_PREFIX = 'e2e-col:v1:'
export const SIDECAR_RECOVERY_CLOSE_CODE = 4409
export const SIDECAR_RECOVERY_CLOSE_REASON = 'backend proved transport history risk'
const SIDECAR_TRANSIENT_FAILURE_CLOSE_CODE = 1011
const SIDECAR_TRANSIENT_FAILURE_CLOSE_REASON = 'signal-cli send outcome unavailable'
const CHUNK_MESSAGE_ID = '00000000-0000-4000-8000-000000000000'

export interface SidecarBridgeOptions {
  readonly backend: BroadcastBackend
  readonly documentGroups: Readonly<Record<string, string>>
  readonly host?: string
  readonly port?: number
  readonly chunkPayloadBytes?: number
  readonly signalBodyMaxBytes?: number
  readonly sendAttempts?: number
  readonly retryDelayMs?: number
  readonly chunkTtlMs?: number
  readonly maxChunkSets?: number
  readonly allowRemoteHost?: boolean
  readonly allowedOrigins?: readonly string[]
}

function signalBody(frame: ProtocolEnvelope): string {
  return SIGNAL_PREFIX + Buffer.from(encodeEnvelope(frame)).toString('base64')
}

function signalBodyBytes(frame: ProtocolEnvelope): number {
  return Buffer.byteLength(signalBody(frame), 'utf8')
}

function maxRawBytesForBase64Body(maxBodyBytes: number): number {
  const base64Bytes = maxBodyBytes - Buffer.byteLength(SIGNAL_PREFIX, 'utf8')
  if (base64Bytes < 4) return 0
  return Math.floor(base64Bytes / 4) * 3
}

interface PendingChunkSet {
  readonly frames: Map<number, ProtocolEnvelope>
  readonly total: number
  readonly createdAt: number
}

export class SidecarBridge {
  private readonly backend: BroadcastBackend
  private readonly documentGroups: Readonly<Record<string, string>>
  private readonly groupDocuments: ReadonlyMap<string, string>
  private readonly host: string
  private readonly port: number
  private readonly chunkPayloadBytes: number
  private readonly signalBodyMaxBytes: number | undefined
  private readonly sendAttempts: number
  private readonly retryDelayMs: number
  private readonly chunkTtlMs: number
  private readonly maxChunkSets: number
  private readonly allowedOrigins: readonly string[] | undefined
  private readonly clients = new Map<string, Set<WebSocket>>()
  private readonly physicalDedup = new DedupCache()
  private readonly logicalDedup = new DedupCache()
  private readonly chunkSets = new Map<string, PendingChunkSet>()
  private server: Server | undefined
  private sockets: WebSocketServer | undefined

  constructor(options: SidecarBridgeOptions) {
    this.backend = options.backend
    const documentGroups = Object.entries(options.documentGroups)
    if (documentGroups.length === 0)
      throw new Error('at least one document-to-group mapping is required')
    const groupIds = new Set<string>()
    for (const [documentId, groupId] of documentGroups) {
      if (!documentId || !groupId) throw new Error('document and group IDs must be non-empty')
      if (groupIds.has(groupId))
        throw new Error('Signal group IDs must map to exactly one document')
      groupIds.add(groupId)
    }
    this.documentGroups = options.documentGroups
    this.groupDocuments = new Map(
      documentGroups.map(([documentId, groupId]) => [groupId, documentId])
    )
    this.host = options.host ?? '127.0.0.1'
    if (!options.allowRemoteHost && !isLoopbackHostname(this.host)) {
      throw new Error('sidecar host must be loopback unless allowRemoteHost is enabled')
    }
    this.port = options.port ?? 43127
    this.chunkPayloadBytes = options.chunkPayloadBytes ?? 24 * 1024
    if (!Number.isSafeInteger(this.chunkPayloadBytes) || this.chunkPayloadBytes <= 0)
      throw new Error('chunkPayloadBytes must be a positive safe integer')
    if (
      options.signalBodyMaxBytes !== undefined &&
      (!Number.isSafeInteger(options.signalBodyMaxBytes) || options.signalBodyMaxBytes <= 0)
    )
      throw new Error('signalBodyMaxBytes must be a positive safe integer')
    this.signalBodyMaxBytes = options.signalBodyMaxBytes
    this.sendAttempts = options.sendAttempts ?? 3
    this.retryDelayMs = options.retryDelayMs ?? 25
    this.chunkTtlMs = options.chunkTtlMs ?? 5 * 60 * 1000
    this.maxChunkSets = options.maxChunkSets ?? 1_024
    this.allowedOrigins = options.allowedOrigins
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('sidecar bridge is already running')
    await this.backend.start((message) => this.receiveBroadcast(message))
    const server = createServer((request, response) => {
      if (request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
        return
      }
      response.writeHead(404).end()
    })
    const sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      const documentId = url.searchParams.get('documentId')
      if (!this.originAllowed(request.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      if (!documentId || !this.documentGroups[documentId]) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }
      sockets.handleUpgrade(request, socket, head, (client) =>
        this.attachClient(documentId, client)
      )
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.port, this.host, resolve)
      })
    } catch (error) {
      sockets.close()
      await this.backend.stop()
      throw error
    }
    this.server = server
    this.sockets = sockets
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('sidecar did not obtain a TCP address')
    return { host: this.host, port: address.port }
  }

  async stop(): Promise<void> {
    for (const peers of this.clients.values())
      for (const client of peers) client.close(1001, 'sidecar stopping')
    this.clients.clear()
    this.sockets?.close()
    if (this.server)
      await new Promise<void>((resolve, reject) =>
        this.server!.close((error) => (error ? reject(error) : resolve()))
      )
    this.sockets = undefined
    this.server = undefined
    await this.backend.stop()
  }

  private attachClient(documentId: string, client: WebSocket): void {
    const peers = this.clients.get(documentId) ?? new Set<WebSocket>()
    peers.add(client)
    this.clients.set(documentId, peers)
    client.binaryType = 'arraybuffer'
    client.on('message', (raw, isBinary) => {
      if (!isBinary) return
      const bytes = new Uint8Array(raw as Buffer)
      try {
        const envelope = decodeEnvelope(bytes)
        if (envelope.documentId !== documentId) return
      } catch {
        return
      }
      const groupId = this.documentGroups[documentId]!
      const envelope = decodeEnvelope(bytes)
      this.logicalDedup.hasOrAdd(envelope)
      let frames: readonly ProtocolEnvelope[]
      try {
        frames = this.framesForSignal(envelope)
      } catch {
        console.error('sidecar frame cannot fit configured Signal message boundary')
        this.signalUnavailable(documentId)
        return
      }
      void this.sendFrames(documentId, groupId, frames)
    })
    client.on('close', () => peers.delete(client))
  }

  private receiveBroadcast(message: BroadcastMessage): void {
    if (!message.message.startsWith(SIGNAL_PREFIX)) return
    const documentId = this.groupDocuments.get(message.groupId)
    if (!documentId) return
    let frame: ProtocolEnvelope
    try {
      const bytes = new Uint8Array(
        Buffer.from(message.message.slice(SIGNAL_PREFIX.length), 'base64')
      )
      frame = decodeEnvelope(bytes)
      if (frame.documentId !== documentId || this.physicalDedup.hasOrAdd(frame)) return
    } catch {
      return
    }
    if (frame.kind === 'chunk' && frame.chunk) {
      this.pruneChunkSets(Date.now())
      const key = `${frame.documentId}\u0000${frame.senderId}\u0000${frame.chunk.originalMessageId}`
      if (!this.chunkSets.has(key) && this.chunkSets.size >= this.maxChunkSets) {
        const oldest = [...this.chunkSets.entries()].sort(
          (left, right) => left[1].createdAt - right[1].createdAt
        )[0]
        if (oldest) this.chunkSets.delete(oldest[0])
      }
      const set = this.chunkSets.get(key) ?? {
        frames: new Map<number, ProtocolEnvelope>(),
        total: frame.chunk.total,
        createdAt: Date.now()
      }
      if (set.total !== frame.chunk.total) {
        this.chunkSets.delete(key)
        return
      }
      const existing = set.frames.get(frame.chunk.index)
      if (existing) {
        if (!bytesEqual(existing.payload, frame.payload)) this.chunkSets.delete(key)
        return
      }
      set.frames.set(frame.chunk.index, frame)
      this.chunkSets.set(key, set)
      if (set.frames.size < frame.chunk.total) return
      try {
        frame = reassembleChunks([...set.frames.values()])
      } catch {
        return
      } finally {
        this.chunkSets.delete(key)
      }
      if (this.logicalDedup.hasOrAdd(frame)) return
    } else if (this.logicalDedup.hasOrAdd(frame)) {
      return
    }
    const bytes = encodeEnvelope(frame)
    for (const client of this.clients.get(documentId) ?? []) {
      if (client.readyState === client.OPEN) client.send(bytes)
    }
  }

  private signalUnavailable(documentId: string): void {
    for (const client of this.clients.get(documentId) ?? []) {
      if (client.readyState === client.OPEN) {
        client.close(SIDECAR_TRANSIENT_FAILURE_CLOSE_CODE, SIDECAR_TRANSIENT_FAILURE_CLOSE_REASON)
      }
    }
  }

  private async sendFrames(
    documentId: string,
    groupId: string,
    frames: readonly ProtocolEnvelope[]
  ): Promise<void> {
    for (const frame of frames) {
      const body = signalBody(frame)
      let lastError: unknown
      for (let attempt = 1; attempt <= this.sendAttempts; attempt += 1) {
        try {
          await this.backend.send(groupId, body)
          lastError = undefined
          break
        } catch (error) {
          lastError = error
          if (attempt < this.sendAttempts) await sleep(this.retryDelayMs * 2 ** (attempt - 1))
        }
      }
      if (lastError) {
        console.error(
          'sidecar broadcast send failed after retries; acceptance outcome is unavailable'
        )
        if (lastError instanceof BroadcastRecoveryRequiredError) this.signalRecovery(documentId)
        else this.signalUnavailable(documentId)
        return
      }
    }
  }

  private framesForSignal(envelope: ProtocolEnvelope): readonly ProtocolEnvelope[] {
    if (this.signalBodyMaxBytes === undefined) {
      return envelope.kind === 'chunk'
        ? [envelope]
        : chunkEnvelope(envelope, { maxPayloadBytes: this.chunkPayloadBytes })
    }
    if (signalBodyBytes(envelope) <= this.signalBodyMaxBytes) return [envelope]
    if (envelope.kind === 'chunk' || envelope.payload.byteLength === 0) {
      throw new Error('protocol frame exceeds configured Signal body limit')
    }

    const representativeChunk: ProtocolEnvelope = {
      ...envelope,
      messageId: CHUNK_MESSAGE_ID,
      kind: 'chunk',
      chunk: {
        index: 0,
        total: 2,
        originalMessageId: envelope.messageId,
        originalKind: envelope.kind
      },
      payload: new Uint8Array()
    }
    const rawBudget = maxRawBytesForBase64Body(this.signalBodyMaxBytes)
    const envelopeOverhead = encodeEnvelope(representativeChunk).byteLength
    const maxPayloadBytes = Math.min(this.chunkPayloadBytes, rawBudget - envelopeOverhead)
    if (maxPayloadBytes <= 0)
      throw new Error('configured Signal body limit cannot fit chunk metadata')

    const frames = chunkEnvelope(envelope, { maxPayloadBytes })
    if (frames.some((frame) => signalBodyBytes(frame) > this.signalBodyMaxBytes!)) {
      throw new Error('chunk framing exceeded configured Signal body limit')
    }
    return frames
  }

  private signalRecovery(documentId: string): void {
    for (const client of this.clients.get(documentId) ?? []) {
      if (client.readyState === client.OPEN) {
        client.close(SIDECAR_RECOVERY_CLOSE_CODE, SIDECAR_RECOVERY_CLOSE_REASON)
      }
    }
  }

  private originAllowed(origin: string | undefined): boolean {
    if (!origin) return true
    if (this.allowedOrigins) return this.allowedOrigins.includes(origin)
    try {
      return isLoopbackHostname(new URL(origin).hostname)
    } catch {
      return false
    }
  }

  private pruneChunkSets(now: number): void {
    for (const [key, set] of this.chunkSets) {
      if (now - set.createdAt >= this.chunkTtlMs) this.chunkSets.delete(key)
    }
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1)
    if (left[index] !== right[index]) return false
  return true
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
