import type { BroadcastBackend, BroadcastMessage } from './backend'

export interface SignalCliHttpOptions {
  readonly baseUrl?: string
  readonly account?: string
  readonly fetch?: typeof fetch
  readonly allowRemote?: boolean
  readonly reconnectDelayMs?: number
  readonly reconnectMaxDelayMs?: number
  readonly requiredGroupIds?: readonly string[]
}

interface JsonRpcErrorShape {
  readonly code: number
  readonly message: string
}

export class SignalCliRpcError extends Error {
  readonly code: number

  constructor(method: string, error: JsonRpcErrorShape) {
    super(`signal-cli ${method} failed: JSON-RPC ${error.code}: ${error.message}`)
    this.name = 'SignalCliRpcError'
    this.code = error.code
  }
}

function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(buffer)
  return match ? { index: match.index, length: match[0].length } : undefined
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

const MIN_RECONNECT_DELAY_MS = 10

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

export class SignalCliHttpBackend implements BroadcastBackend {
  private readonly baseUrl: string
  private readonly account: string | undefined
  private readonly fetchImpl: typeof fetch
  private readonly reconnectDelayMs: number
  private readonly reconnectMaxDelayMs: number
  private readonly requiredGroupIds: readonly string[]
  private abort: AbortController | undefined
  private receiveTask: Promise<void> | undefined
  private version: string | undefined

  constructor(options: SignalCliHttpOptions = {}) {
    const baseUrl = new URL(options.baseUrl ?? 'http://127.0.0.1:8080')
    if (!['http:', 'https:'].includes(baseUrl.protocol)) {
      throw new Error('signal-cli HTTP endpoint must use http or https')
    }
    if (baseUrl.username || baseUrl.password) {
      throw new Error('signal-cli HTTP endpoint must not contain URL credentials')
    }
    if (baseUrl.pathname !== '/' || baseUrl.search || baseUrl.hash) {
      throw new Error('signal-cli HTTP endpoint must be an origin without path, query, or fragment')
    }
    if (!options.allowRemote && !isLoopbackHostname(baseUrl.hostname)) {
      throw new Error('signal-cli HTTP endpoint must be loopback unless allowRemote is enabled')
    }
    if (options.account !== undefined && options.account.trim().length === 0) {
      throw new Error('signal-cli account must be non-empty when configured')
    }
    this.baseUrl = baseUrl.origin
    this.account = options.account
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.reconnectDelayMs = Math.max(MIN_RECONNECT_DELAY_MS, options.reconnectDelayMs ?? 250)
    this.reconnectMaxDelayMs = Math.max(this.reconnectDelayMs, options.reconnectMaxDelayMs ?? 5_000)
    this.requiredGroupIds = [...new Set(options.requiredGroupIds ?? [])]
  }

  async start(listener: (message: BroadcastMessage) => void): Promise<void> {
    if (this.abort) throw new Error('signal-cli backend is already running')
    await this.checkHealth()
    this.version = await this.detectVersion()
    if (this.requiredGroupIds.length > 0) await this.validateRequiredGroups()
    this.abort = new AbortController()
    let resolveInitialEvents!: () => void
    let rejectInitialEvents!: (error: unknown) => void
    const initialEvents = new Promise<void>((resolve, reject) => {
      resolveInitialEvents = resolve
      rejectInitialEvents = reject
    })
    this.receiveTask = this.runEventLoop(
      listener,
      this.abort.signal,
      resolveInitialEvents,
      rejectInitialEvents
    )
    try {
      await initialEvents
    } catch (error) {
      this.abort.abort()
      await this.receiveTask
      this.receiveTask = undefined
      this.abort = undefined
      throw error
    }
  }

  async send(groupId: string, message: string): Promise<void> {
    const params: Record<string, unknown> = { groupId, message }
    if (this.account) params.account = this.account
    const result = asRecord(await this.rpc('send', params))
    if (
      typeof result?.timestamp !== 'number' ||
      !Number.isSafeInteger(result.timestamp) ||
      result.timestamp < 0
    ) {
      throw new Error('signal-cli send returned an unsupported result shape')
    }
  }

  detectedVersion(): string | undefined {
    return this.version
  }

  async stop(): Promise<void> {
    this.abort?.abort()
    try {
      await this.receiveTask
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error
    }
    this.receiveTask = undefined
    this.abort = undefined
  }

  private async checkHealth(): Promise<void> {
    const health = await this.fetchImpl(`${this.baseUrl}/api/v1/check`)
    if (!health.ok) throw new Error(`signal-cli health check failed: HTTP ${health.status}`)
  }

  private async detectVersion(): Promise<string | undefined> {
    let result: unknown
    try {
      result = await this.rpc('version', {})
    } catch (error) {
      if (error instanceof SignalCliRpcError && error.code === -32601) return undefined
      throw error
    }
    if (typeof result === 'string' && result.length > 0) return result
    const record = asRecord(result)
    if (typeof record?.version === 'string' && record.version.length > 0) return record.version
    throw new Error('signal-cli version returned an unsupported result shape')
  }

  private async validateRequiredGroups(): Promise<void> {
    const params: Record<string, unknown> = {}
    if (this.account) params.account = this.account
    const result = await this.rpc('listGroups', params)
    if (!Array.isArray(result)) throw new Error('signal-cli listGroups returned a non-array result')
    const available = new Set(
      result
        .map((value) => asRecord(value))
        .filter(
          (value): value is Record<string, unknown> =>
            value !== undefined &&
            typeof value.id === 'string' &&
            value.isMember === true &&
            value.isBlocked !== true
        )
        .map((value) => value.id as string)
    )
    const missing = this.requiredGroupIds.filter((groupId) => !available.has(groupId))
    if (missing.length > 0) {
      throw new Error(
        `signal-cli account does not expose ${missing.length} configured document group(s)`
      )
    }
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID()
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
    })
    if (!response.ok) throw new Error(`signal-cli ${method} failed: HTTP ${response.status}`)

    let value: unknown
    try {
      value = await response.json()
    } catch {
      throw new Error(`signal-cli ${method} returned invalid JSON`)
    }
    const body = asRecord(value)
    if (body?.jsonrpc !== '2.0') {
      throw new Error(`signal-cli ${method} returned an invalid JSON-RPC response`)
    }
    const error = asRecord(body.error)
    // signal-cli has historically emitted command-execution failures with
    // id:null even when the single HTTP request carried a valid id. Because
    // this adapter sends exactly one request per HTTP POST, preserve that
    // daemon error instead of replacing it with an id-mismatch diagnostic.
    if (body.id !== id && !(error && body.id === null)) {
      throw new Error(`signal-cli ${method} returned a mismatched JSON-RPC id`)
    }
    if (error) {
      if (typeof error.code !== 'number' || typeof error.message !== 'string') {
        throw new Error(`signal-cli ${method} returned a malformed JSON-RPC error`)
      }
      throw new SignalCliRpcError(method, { code: error.code, message: error.message })
    }
    if (!Object.hasOwn(body, 'result')) {
      throw new Error(`signal-cli ${method} JSON-RPC response has no result`)
    }
    return body.result
  }

  private async consumeEvents(
    listener: (message: BroadcastMessage) => void,
    signal: AbortSignal,
    onConnected: () => void
  ): Promise<boolean> {
    const eventsUrl = new URL(`${this.baseUrl}/api/v1/events`)
    if (this.account) eventsUrl.searchParams.set('account', this.account)
    const response = await this.fetchImpl(eventsUrl, {
      headers: { accept: 'text/event-stream' },
      signal
    })
    if (!response.ok || !response.body)
      throw new Error(`signal-cli event stream failed: HTTP ${response.status}`)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!contentType.startsWith('text/event-stream')) {
      throw new Error('signal-cli event stream did not return text/event-stream')
    }
    onConnected()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let received = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let boundary = findEventBoundary(buffer)
      while (boundary) {
        const event = buffer.slice(0, boundary.index)
        buffer = buffer.slice(boundary.index + boundary.length)
        const parsed = parseSseReceiveEvent(event)
        if (parsed) {
          const routed =
            parsed.account || !this.account ? parsed : { ...parsed, account: this.account }
          if (!this.account || !routed.account || routed.account === this.account) {
            received = true
            listener(routed)
          }
        }
        boundary = findEventBoundary(buffer)
      }
    }
    return received
  }

  private async runEventLoop(
    listener: (message: BroadcastMessage) => void,
    signal: AbortSignal,
    onInitialConnection: () => void,
    onInitialFailure: (error: unknown) => void
  ): Promise<void> {
    let delay = this.reconnectDelayMs
    let connected = false
    while (!signal.aborted) {
      try {
        const received = await this.consumeEvents(listener, signal, () => {
          if (connected) return
          connected = true
          onInitialConnection()
        })
        delay = received ? this.reconnectDelayMs : Math.min(delay * 2, this.reconnectMaxDelayMs)
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
        if (!connected) {
          onInitialFailure(error)
          return
        }
        delay = Math.min(delay * 2, this.reconnectMaxDelayMs)
      }
      if (signal.aborted) return
      await sleep(delay, signal)
    }
  }
}

function parseSseReceiveEvent(event: string): BroadcastMessage | undefined {
  let eventName: string | undefined
  const data: string[] = []
  for (const line of event.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1).trimStart()
    if (field === 'event') eventName = value
    if (field === 'data') data.push(value)
  }
  if (eventName && eventName !== 'receive' && eventName !== 'message') return undefined
  if (data.length === 0) return undefined
  try {
    return parseSignalReceive(JSON.parse(data.join('\n')))
  } catch {
    return undefined
  }
}

export function parseSignalReceive(value: unknown): BroadcastMessage | undefined {
  const root = asRecord(value)
  if (!root || (root.method !== undefined && root.method !== 'receive')) return undefined
  const params = asRecord(root.params)
  const subscriptionResult = asRecord(params?.result)
  const envelope = asRecord(subscriptionResult?.envelope ?? params?.envelope)
  const dataMessage = asRecord(envelope?.dataMessage)
  const syncMessage = asRecord(envelope?.syncMessage)
  const sentMessage = asRecord(syncMessage?.sentMessage)
  const messageNode = dataMessage ?? sentMessage
  const message = messageNode?.message
  const groupInfo = asRecord(messageNode?.groupInfo)
  const groupId = groupInfo?.groupId
  if (typeof message !== 'string' || typeof groupId !== 'string') return undefined
  const account = subscriptionResult?.account ?? params?.account ?? root.account
  return { groupId, message, ...(typeof account === 'string' ? { account } : {}) }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}
