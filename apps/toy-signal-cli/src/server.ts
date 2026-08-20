import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import {
  DEFAULT_TOY_SIGNAL_CONFIG,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  MOCK_GROUP_ENDPOINTS,
  MOCK_IDENTITY_ENDPOINTS,
  SIGNAL_CLI_HTTP_ENDPOINTS,
  SUPPORTED_RPC_METHODS,
  TOY_CONTROL_ENDPOINTS,
  TOY_SIGNAL_CLI_API_SPEC,
  type ToyFaultProfile,
  type ToyInjectRequest,
  type ToySignalConfig
} from './contract'
import { DebugObserverManager } from './debug-observer'
import { EncryptedMessageRouter } from './encrypted-router'
import { CollaborationGroupRegistry, GroupApiError } from './group-registry'
import {
  IdentityApiError,
  type IdentityRegistrationRequest,
  IdentityRegistry
} from './identity-registry'
import { ToyRpcError, ToySignalNetwork } from './network'
import { SyncEventLog } from './sync-log'

const MAX_BODY_BYTES = 1024 * 1024

export interface ToySignalCliServerOptions {
  readonly host?: string
  readonly port?: number
  readonly fixedAccount?: string
  readonly config?: ToySignalConfig
  readonly now?: () => number
  readonly debugDecrypt?: boolean
}

export class ToySignalCliServer {
  readonly network: ToySignalNetwork
  readonly identities: IdentityRegistry
  readonly groups: CollaborationGroupRegistry
  readonly syncLog: SyncEventLog
  private readonly host: string
  private readonly port: number
  private readonly fixedAccount: string | undefined
  private server: Server | undefined
  private sockets: WebSocketServer | undefined
  private readonly debugObserver: DebugObserverManager
  private readonly encryptedMessages: EncryptedMessageRouter

  constructor(options: ToySignalCliServerOptions = {}) {
    this.host = options.host ?? '127.0.0.1'
    if (!isLoopbackHostname(this.host)) throw new Error('toy signal-cli binds to loopback only')
    this.port = options.port ?? 18080
    this.fixedAccount = options.fixedAccount
    this.network = new ToySignalNetwork(options.config ?? DEFAULT_TOY_SIGNAL_CONFIG, options.now)
    this.identities = new IdentityRegistry(
      options.now,
      (options.config ?? DEFAULT_TOY_SIGNAL_CONFIG).accounts.map((account) => account.account)
    )
    this.groups = new CollaborationGroupRegistry(this.identities, options.now)
    this.syncLog = new SyncEventLog(options.now)
    this.debugObserver = new DebugObserverManager(
      options.debugDecrypt ?? process.env.E2E_COL_DEBUG_DECRYPT === 'true'
    )
    this.encryptedMessages = new EncryptedMessageRouter(
      this.identities,
      this.groups,
      this.network,
      options.now,
      this.syncLog,
      this.debugObserver
    )
  }

  private openSyncLog(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    response.flushHeaders()
    for (const entry of this.syncLog.all()) response.write(`data: ${JSON.stringify(entry)}\n\n`)
    const detach = this.syncLog.subscribe((entry) => {
      if (!response.destroyed) response.write(`data: ${JSON.stringify(entry)}\n\n`)
    })
    request.once('close', detach)
    response.once('close', detach)
  }

  get debugDecrypt(): boolean {
    return this.encryptedMessages.getDebugDecrypt()
  }

  async start(): Promise<{ host: string; port: number; baseUrl: string }> {
    if (this.server) throw new Error('toy signal-cli is already running')
    const server = createServer((request, response) => void this.route(request, response))
    const sockets = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      if (
        url.pathname !== MOCK_GROUP_ENDPOINTS.messages ||
        !originAllowed(request.headers.origin)
      ) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      sockets.handleUpgrade(request, socket, head, (client) =>
        this.encryptedMessages.attach(client)
      )
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, this.host, resolve)
    })
    this.server = server
    this.sockets = sockets
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('toy signal-cli did not obtain a TCP address')
    return { host: this.host, port: address.port, baseUrl: `http://${this.host}:${address.port}` }
  }

  async stop(): Promise<void> {
    this.network.closeSseClients()
    this.encryptedMessages.reset()
    this.sockets?.close()
    this.sockets = undefined
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
      if (!applyCors(request, response)) {
        json(response, 403, { error: 'cross-origin access is limited to loopback origins' })
        return
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end()
        return
      }
      if (request.method === 'GET' && url.pathname === SIGNAL_CLI_HTTP_ENDPOINTS.check) {
        json(response, 200, this.healthView())
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
        json(response, 200, this.stateView())
        return
      }
      if (request.method === 'GET' && url.pathname === TOY_CONTROL_ENDPOINTS.debugObserverKey) {
        const capability = await this.debugObserver.capability()
        if (!capability) json(response, 404, { error: 'debug observer is disabled' })
        else json(response, 200, capability)
        return
      }
      if (request.method === 'POST' && url.pathname === TOY_CONTROL_ENDPOINTS.config) {
        const value = await readJson(request)
        if (!isRecord(value) || typeof value.debugDecrypt !== 'boolean')
          throw new Error('debugDecrypt must be a boolean')
        this.encryptedMessages.setDebugDecrypt(value.debugDecrypt)
        if (!value.debugDecrypt) this.syncLog.redactPreviews()
        json(response, 200, { debugDecrypt: this.debugDecrypt })
        return
      }
      if (request.method === 'GET' && url.pathname === TOY_CONTROL_ENDPOINTS.syncLogExport) {
        json(response, 200, this.syncLog.all())
        return
      }
      if (request.method === 'GET' && url.pathname === TOY_CONTROL_ENDPOINTS.syncLog) {
        if (url.searchParams.has('since')) {
          const since = Number(url.searchParams.get('since'))
          json(response, 200, this.syncLog.since(since))
        } else {
          this.openSyncLog(request, response)
        }
        return
      }
      if (request.method === 'POST' && url.pathname === TOY_CONTROL_ENDPOINTS.reset) {
        const value = await readJson(request)
        const config = asOptionalConfig(value)
        const effectiveConfig = config ?? DEFAULT_TOY_SIGNAL_CONFIG
        this.network.reset(effectiveConfig)
        this.identities.reset(effectiveConfig.accounts.map((account) => account.account))
        this.groups.reset()
        this.encryptedMessages.reset()
        this.debugObserver.reset()
        this.syncLog.reset()
        json(response, 200, this.stateView())
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
      if (request.method === 'POST' && url.pathname === MOCK_IDENTITY_ENDPOINTS.register) {
        const value = (await readJson(request)) as IdentityRegistrationRequest
        json(response, 201, await this.identities.register(value))
        return
      }
      if (request.method === 'GET' && url.pathname === MOCK_IDENTITY_ENDPOINTS.session) {
        json(response, 200, this.identities.session(request.headers.authorization))
        return
      }
      if (request.method === 'POST' && url.pathname === MOCK_IDENTITY_ENDPOINTS.replenish) {
        const value = await readJson(request)
        const record = isRecord(value) ? value : {}
        json(
          response,
          200,
          this.identities.replenish(
            request.headers.authorization,
            Array.isArray(record.one_time_prekeys) ? (record.one_time_prekeys as string[]) : []
          )
        )
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith(MOCK_IDENTITY_ENDPOINTS.keyPrefix)) {
        const phoneNumber = decodeURIComponent(
          url.pathname.slice(MOCK_IDENTITY_ENDPOINTS.keyPrefix.length)
        )
        json(response, 200, this.identities.lookup(phoneNumber, request.headers.authorization))
        return
      }
      if (request.method === 'POST' && url.pathname === MOCK_GROUP_ENDPOINTS.groups) {
        const caller = this.identities.authenticate(request.headers.authorization)
        const value = await readJson(request)
        const group = this.groups.create(caller, isRecord(value) ? value : {})
        this.logApplicationAccess(caller.phoneNumber, group.document_id, 'membership')
        json(response, 201, group)
        return
      }
      if (request.method === 'GET' && url.pathname === MOCK_GROUP_ENDPOINTS.groups) {
        const caller = this.identities.authenticate(request.headers.authorization)
        json(response, 200, { groups: this.groups.list(caller) })
        return
      }
      const groupRoute = parseGroupRoute(url.pathname)
      if (groupRoute) {
        const caller = this.identities.authenticate(request.headers.authorization)
        if (request.method === 'GET' && groupRoute.kind === 'group') {
          json(response, 200, this.groups.get(groupRoute.groupId, caller))
          return
        }
        if (request.method === 'POST' && groupRoute.kind === 'members') {
          const value = await readJson(request)
          const group = this.groups.addMember(
            groupRoute.groupId,
            caller,
            isRecord(value) ? value : {}
          )
          this.logApplicationAccess(caller.phoneNumber, group.document_id, 'membership')
          json(response, 200, group)
          return
        }
        if (request.method === 'DELETE' && groupRoute.kind === 'member') {
          const group = this.groups.removeMember(groupRoute.groupId, groupRoute.phoneNumber, caller)
          this.logApplicationAccess(caller.phoneNumber, group.document_id, 'membership')
          json(response, 200, group)
          return
        }
      }
      response.writeHead(404).end()
    } catch (error) {
      if (response.headersSent) {
        response.end()
        return
      }
      json(
        response,
        error instanceof IdentityApiError || error instanceof GroupApiError ? error.status : 400,
        {
          error: error instanceof Error ? error.message : 'bad request'
        }
      )
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

  private stateView(): Record<string, unknown> {
    return {
      ...this.network.view(),
      identity: this.identities.view(),
      collaboration: {
        groups: this.groups.view(),
        ...this.encryptedMessages.view()
      }
    }
  }

  private healthView(): Record<string, unknown> {
    return {
      status: 'ok',
      toy: true,
      apiVersion: 1,
      debugDecrypt: this.debugDecrypt,
      registeredIdentities: this.identities.view().registered,
      activeGroups: this.groups.view().length
    }
  }

  private logApplicationAccess(
    senderPhone: string,
    documentId: string,
    envelopeKind: string
  ): void {
    this.syncLog.append({
      level: 'application',
      direction: 'inbound',
      senderPhone,
      documentId,
      envelopeKind
    })
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
  identity: MOCK_IDENTITY_ENDPOINTS,
  collaboration: MOCK_GROUP_ENDPOINTS,
  methods: SUPPORTED_RPC_METHODS
} as const

function parseGroupRoute(
  pathname: string
):
  | { kind: 'group'; groupId: string }
  | { kind: 'members'; groupId: string }
  | { kind: 'member'; groupId: string; phoneNumber: string }
  | undefined {
  const prefix = `${MOCK_GROUP_ENDPOINTS.groups}/`
  if (!pathname.startsWith(prefix)) return undefined
  const parts = pathname.slice(prefix.length).split('/').map(decodeURIComponent)
  if (parts.length === 1 && parts[0]) return { kind: 'group', groupId: parts[0] }
  if (parts.length === 2 && parts[0] && parts[1] === 'members')
    return { kind: 'members', groupId: parts[0] }
  if (parts.length === 3 && parts[0] && parts[1] === 'members' && parts[2])
    return { kind: 'member', groupId: parts[0], phoneNumber: parts[2] }
  return undefined
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    return ['http:', 'https:'].includes(parsed.protocol) && isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

function applyCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHostname(parsed.hostname))
      return false
  } catch {
    return false
  }
  response.setHeader('access-control-allow-origin', origin)
  response.setHeader('vary', 'origin')
  response.setHeader('access-control-allow-headers', 'authorization, content-type')
  response.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  return true
}
