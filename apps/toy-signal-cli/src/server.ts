import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  DEFAULT_TOY_SIGNAL_CONFIG,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  SIGNAL_CLI_HTTP_ENDPOINTS,
  SUPPORTED_RPC_METHODS,
  TOY_CONTROL_ENDPOINTS,
  TOY_SIGNAL_CLI_API_SPEC,
  type ToyFaultProfile,
  type ToyInjectRequest,
  type ToySignalConfig
} from './contract'
import { ToyRpcError, ToySignalNetwork } from './network'

const MAX_BODY_BYTES = 1024 * 1024

export interface ToySignalCliServerOptions {
  readonly host?: string
  readonly port?: number
  readonly fixedAccount?: string
  readonly config?: ToySignalConfig
  readonly now?: () => number
}

export class ToySignalCliServer {
  readonly network: ToySignalNetwork
  private readonly host: string
  private readonly port: number
  private readonly fixedAccount: string | undefined
  private server: Server | undefined

  constructor(options: ToySignalCliServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    if (!isLoopbackHostname(this.host)) throw new Error('toy signal-cli binds to loopback only')
    this.port = options.port ?? 18080
    this.fixedAccount = options.fixedAccount
    this.network = new ToySignalNetwork(options.config ?? DEFAULT_TOY_SIGNAL_CONFIG, options.now)
  }

  async start(): Promise<{ host: string; port: number; baseUrl: string }> {
    if (this.server) throw new Error('toy signal-cli is already running')
    const server = createServer((request, response) => void this.route(request, response))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, resolve)
    })
    this.server = server
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('toy signal-cli did not obtain a TCP address')
    return { host: this.host, port: address.port, baseUrl: `http://${this.host}:${address.port}` }
  }

  async stop(): Promise<void> {
    this.network.closeSseClients()
    if (!this.server) return
    const server = this.server
    this.server = undefined
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (request.method === 'GET' && url.pathname === SIGNAL_CLI_HTTP_ENDPOINTS.check) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, toy: true, contractVersion: 1 }))
        return
      }
      if (request.method === 'GET' && url.pathname === SIGNAL_CLI_HTTP_ENDPOINTS.events) {
        this.openEvents(request, response)
        return
      }
      if (request.method === 'POST' && url.pathname === SIGNAL_CLI_HTTP_ENDPOINTS.rpc) {
        await this.handleRpc(request, response)
        return
      }
      if (request.method === 'GET' && url.pathname === TOY_CONTROL_ENDPOINTS.contract) {
        json(response, 200, TOY_SIGNAL_CLI_API_SPEC)
        return
      }
      if (request.method === 'GET' && url.pathname === TOY_CONTROL_ENDPOINTS.state) {
        json(response, 200, this.network.view())
        return
      }
      if (request.method === 'POST' && url.pathname === TOY_CONTROL_ENDPOINTS.reset) {
        const value = await readJson(request)
        const config = asOptionalConfig(value)
        this.network.reset(config ?? DEFAULT_TOY_SIGNAL_CONFIG)
        json(response, 200, this.network.view())
        return
      }
      if (request.method === 'POST' && url.pathname === TOY_CONTROL_ENDPOINTS.faults) {
        const profile = (await readJson(request)) as ToyFaultProfile
        json(response, 200, this.network.setFaults(profile))
        return
      }
      if (request.method === 'POST' && url.pathname === TOY_CONTROL_ENDPOINTS.inject) {
        const value = (await readJson(request)) as ToyInjectRequest
        await this.network.inject(value)
        json(response, 200, { ok: true })
        return
      }
      response.writeHead(404).end()
    } catch (error) {
      if (response.headersSent) {
        response.end()
        return
      }
      json(response, 400, { error: error instanceof Error ? error.message : 'bad request' })
    }
  }

  private openEvents(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.flushHeaders()
    response.write(': toy-signal-cli connected\n\n')
    const detach = this.network.attachSse(response)
    request.once('close', detach)
    response.once('close', detach)
  }

  private async handleRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let value: unknown
    try {
      value = await readJson(request)
    } catch (error) {
      json(
        response,
        200,
        failure(null, -32700, error instanceof Error ? error.message : 'Parse error')
      )
      return
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        json(response, 200, failure(null, -32600, 'Invalid Request'))
        return
      }
      const results = await Promise.all(value.map((entry) => this.execute(entry)))
      const visible = results.filter((entry): entry is JsonRpcResponse => entry !== undefined)
      if (visible.length === 0) response.writeHead(204).end()
      else json(response, 200, visible)
      return
    }

    const result = await this.execute(value)
    if (result === undefined) response.writeHead(204).end()
    else json(response, 200, result)
  }

  private async execute(value: unknown): Promise<JsonRpcResponse | undefined> {
    const parsed = parseRpcRequest(value)
    if ('error' in parsed) return parsed.error
    const request = parsed.request
    const notification = request.id === undefined
    try {
      const result = await this.network.invoke(request, this.fixedAccount)
      if (notification) return undefined
      return { jsonrpc: '2.0', result, id: request.id ?? null }
    } catch (error) {
      if (notification) return undefined
      if (error instanceof ToyRpcError)
        return failure(request.id ?? null, error.code, error.message, error.data)
      return failure(request.id ?? null, -32603, 'Internal error')
    }
  }
}

function parseRpcRequest(value: unknown): { request: JsonRpcRequest } | { error: JsonRpcFailure } {
  if (!isRecord(value)) return { error: failure(null, -32600, 'Invalid Request') }
  if (value.id !== undefined && !validId(value.id))
    return { error: failure(null, -32600, 'id must be a string, number, or null') }
  const id: JsonRpcId = value.id === undefined ? null : value.id
  if (value.jsonrpc !== '2.0') return { error: failure(id, -32600, 'jsonrpc must be 2.0') }
  if (typeof value.method !== 'string' || value.method.length === 0)
    return { error: failure(id, -32600, 'method field must be set') }
  if (value.params !== undefined && !isRecord(value.params))
    return { error: failure(id, -32602, 'params must be an object') }
  const request: JsonRpcRequest =
    value.id === undefined
      ? {
          jsonrpc: '2.0',
          method: value.method,
          ...(value.params === undefined ? {} : { params: value.params })
        }
      : {
          jsonrpc: '2.0',
          method: value.method,
          ...(value.params === undefined ? {} : { params: value.params }),
          id
        }
  return { request }
}

function failure(
  id: JsonRpcId,
  code: number,
  message: string,
  data: unknown = null
): JsonRpcFailure {
  return { jsonrpc: '2.0', error: { code, message, data }, id }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += bytes.byteLength
    if (total > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(bytes)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text) as unknown
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

function validId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asOptionalConfig(value: unknown): ToySignalConfig | undefined {
  if (!isRecord(value) || value.config === undefined) return undefined
  return value.config as ToySignalConfig
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  )
}

export const toySignalCliContract = {
  endpoints: SIGNAL_CLI_HTTP_ENDPOINTS,
  controls: TOY_CONTROL_ENDPOINTS,
  methods: SUPPORTED_RPC_METHODS
} as const
