import type { BroadcastBackend, BroadcastMessage } from './backend'

export interface SignalCliHttpOptions {
  readonly baseUrl?: string
  readonly account?: string
  readonly fetch?: typeof fetch
  readonly allowRemote?: boolean
  readonly reconnectDelayMs?: number
  readonly reconnectMaxDelayMs?: number
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
  private abort: AbortController | undefined
  private receiveTask: Promise<void> | undefined

  constructor(options: SignalCliHttpOptions = {}) {
    const baseUrl = new URL(options.baseUrl ?? 'http://127.0.0.1:8080')
    if (!options.allowRemote && !isLoopbackHostname(baseUrl.hostname)) {
      throw new Error('signal-cli HTTP endpoint must be loopback unless allowRemote is enabled')
    }
    this.baseUrl = baseUrl.toString().replace(/\/$/, '')
    this.account = options.account
    this.fetchImpl = options.fetch ?? globalThis.fetch
    this.reconnectDelayMs = Math.max(MIN_RECONNECT_DELAY_MS, options.reconnectDelayMs ?? 250)
    this.reconnectMaxDelayMs = Math.max(this.reconnectDelayMs, options.reconnectMaxDelayMs ?? 5_000)
  }

  async start(listener: (message: BroadcastMessage) => void): Promise<void> {
    const health = await this.fetchImpl(`${this.baseUrl}/api/v1/check`)
    if (!health.ok) throw new Error(`signal-cli health check failed: HTTP ${health.status}`)
    this.abort = new AbortController()
    this.receiveTask = this.runEventLoop(listener, this.abort.signal)
  }

  async send(groupId: string, message: string): Promise<void> {
    const params: Record<string, unknown> = { groupId, message }
    if (this.account) params.account = this.account
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'send', params })
    })
    if (!response.ok) throw new Error(`signal-cli send failed: HTTP ${response.status}`)
    const body = (await response.json()) as { error?: { message?: string } }
    if (body.error)
      throw new Error(`signal-cli send failed: ${body.error.message ?? 'JSON-RPC error'}`)
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

  private async consumeEvents(
    listener: (message: BroadcastMessage) => void,
    signal: AbortSignal
  ): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/v1/events`, { signal })
    if (!response.ok || !response.body)
      throw new Error(`signal-cli event stream failed: HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
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
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n')
        if (data) {
          const parsed = parseSignalReceive(JSON.parse(data))
          if (parsed && (!this.account || !parsed.account || parsed.account === this.account)) {
            listener(parsed)
          }
        }
        boundary = findEventBoundary(buffer)
      }
    }
  }

  private async runEventLoop(
    listener: (message: BroadcastMessage) => void,
    signal: AbortSignal
  ): Promise<void> {
    let delay = this.reconnectDelayMs
    while (!signal.aborted) {
      try {
        await this.consumeEvents(listener, signal)
        delay = this.reconnectDelayMs
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
      }
      if (signal.aborted) return
      await sleep(delay, signal)
      delay = Math.min(delay * 2, this.reconnectMaxDelayMs)
    }
  }
}

export function parseSignalReceive(value: unknown): BroadcastMessage | undefined {
  const root = asRecord(value)
  const params = asRecord(root?.params)
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
  const account = subscriptionResult?.account ?? params?.account ?? root?.account
  return { groupId, message, ...(typeof account === 'string' ? { account } : {}) }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}
