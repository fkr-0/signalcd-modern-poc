import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import {
  DEFAULT_TOY_SIGNAL_CONFIG,
  type JsonRpcRequest,
  type ToyAccountConfig,
  type ToyFaultProfile,
  type ToyGroupConfig,
  type ToyInjectRequest,
  type ToySignalConfig
} from './contract'

interface AccountState {
  readonly account: string
  readonly uuid: string
  readonly devices: Array<{ id: number; name: string; created: number; lastSeen: number }>
}

interface GroupState {
  readonly id: string
  name: string
  description: string
  readonly members: Set<string>
  readonly admins: Set<string>
}

interface SseClient {
  readonly id: number
  readonly response: ServerResponse
}

interface LinkSession {
  readonly uri: string
  readonly createdAt: number
}

export interface ToySignalStateView {
  readonly contractVersion: 1
  readonly accounts: readonly string[]
  readonly groups: readonly {
    id: string
    name: string
    members: readonly string[]
    admins: readonly string[]
  }[]
  readonly sseClients: number
  readonly deliveredNotifications: number
  readonly faults: Required<ToyFaultProfile>
}

export class ToyRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown = null
  ) {
    super(message)
  }
}

interface MutableToyFaultProfile {
  failNextRpcSends: number
  dropNextDeliveries: number
  duplicateNextDeliveries: number
  deliveryDelayMs: number
  closeSseAfterNextDelivery: boolean
}

const DEFAULT_FAULTS: MutableToyFaultProfile = {
  failNextRpcSends: 0,
  dropNextDeliveries: 0,
  duplicateNextDeliveries: 0,
  deliveryDelayMs: 0,
  closeSseAfterNextDelivery: false
}

export class ToySignalNetwork {
  private readonly now: () => number
  private readonly accounts = new Map<string, AccountState>()
  private readonly groups = new Map<string, GroupState>()
  private readonly sseClients = new Map<number, SseClient>()
  private readonly subscriptions = new Set<number>()
  private readonly links = new Map<string, LinkSession>()
  private nextSseClientId = 1
  private nextSubscriptionId = 0
  private deliveredNotifications = 0
  private faults: MutableToyFaultProfile = { ...DEFAULT_FAULTS }

  constructor(config: ToySignalConfig = DEFAULT_TOY_SIGNAL_CONFIG, now: () => number = Date.now) {
    this.now = now
    this.reset(config)
  }

  reset(config: ToySignalConfig = DEFAULT_TOY_SIGNAL_CONFIG): void {
    this.accounts.clear()
    this.groups.clear()
    const timestamp = this.now()
    for (const account of config.accounts) this.addAccount(account, timestamp)
    for (const group of config.groups) this.addGroup(group)
    this.faults = { ...DEFAULT_FAULTS }
    this.deliveredNotifications = 0
    this.subscriptions.clear()
    this.links.clear()
  }

  setFaults(profile: ToyFaultProfile): Required<ToyFaultProfile> {
    this.faults = {
      failNextRpcSends: nonNegativeInteger(profile.failNextRpcSends ?? 0, 'failNextRpcSends'),
      dropNextDeliveries: nonNegativeInteger(profile.dropNextDeliveries ?? 0, 'dropNextDeliveries'),
      duplicateNextDeliveries: nonNegativeInteger(
        profile.duplicateNextDeliveries ?? 0,
        'duplicateNextDeliveries'
      ),
      deliveryDelayMs: nonNegativeInteger(profile.deliveryDelayMs ?? 0, 'deliveryDelayMs'),
      closeSseAfterNextDelivery: profile.closeSseAfterNextDelivery ?? false
    }
    return { ...this.faults }
  }

  view(): ToySignalStateView {
    return {
      contractVersion: 1,
      accounts: [...this.accounts.keys()],
      groups: [...this.groups.values()].map((group) => ({
        id: group.id,
        name: group.name,
        members: [...group.members],
        admins: [...group.admins]
      })),
      sseClients: this.sseClients.size,
      deliveredNotifications: this.deliveredNotifications,
      faults: { ...this.faults }
    }
  }

  attachSse(response: ServerResponse): () => void {
    const id = this.nextSseClientId++
    this.sseClients.set(id, { id, response })
    return () => this.sseClients.delete(id)
  }

  closeSseClients(): void {
    for (const client of this.sseClients.values()) client.response.end()
    this.sseClients.clear()
  }

  async invoke(request: JsonRpcRequest, fixedAccount?: string): Promise<unknown> {
    const params = request.params ?? {}
    switch (request.method) {
      case 'version':
        return { version: '0.14.7-toy-e2e-col.1' }
      case 'listAccounts':
        return [...this.accounts.keys()]
      case 'listDevices':
        return this.listDevices(this.accountFor(params, fixedAccount))
      case 'listGroups':
        return this.listGroups(this.accountFor(params, fixedAccount), params)
      case 'getUserStatus':
        this.accountFor(params, fixedAccount)
        return this.getUserStatus(params)
      case 'send':
        return this.send(this.accountFor(params, fixedAccount), params)
      case 'updateGroup':
        return this.updateGroup(this.accountFor(params, fixedAccount), params)
      case 'quitGroup':
        return this.quitGroup(this.accountFor(params, fixedAccount), params)
      case 'sendSyncRequest':
        this.accountFor(params, fixedAccount)
        return {}
      case 'subscribeReceive': {
        this.accountFor(params, fixedAccount)
        const subscription = this.nextSubscriptionId++
        this.subscriptions.add(subscription)
        return subscription
      }
      case 'unsubscribeReceive': {
        const subscription = requiredInteger(params.subscription, 'subscription')
        this.subscriptions.delete(subscription)
        return {}
      }
      case 'startLink':
        return this.startLink()
      case 'finishLink':
        return this.finishLink(params)
      default:
        throw new ToyRpcError(-32601, `Method not found: ${request.method}`)
    }
  }

  async inject(request: ToyInjectRequest): Promise<void> {
    const account = this.requireAccount(request.account)
    const source = request.source ?? '+15559999999'
    const timestamp = this.now()
    const dataMessage: Record<string, unknown> = {
      timestamp,
      message: request.message,
      expiresInSeconds: 0,
      viewOnce: false,
      mentions: [],
      attachments: [],
      contacts: []
    }
    if (request.groupId) dataMessage.groupInfo = { groupId: request.groupId, type: 'DELIVER' }
    await this.emitReceive(account.account, {
      source,
      sourceNumber: source,
      sourceUuid: deterministicUuid(source),
      sourceName: 'Toy injected sender',
      sourceDevice: 1,
      timestamp,
      dataMessage
    })
  }

  private addAccount(account: ToyAccountConfig, timestamp: number): void {
    if (!account.account) throw new Error('toy account identifier must be non-empty')
    if (this.accounts.has(account.account))
      throw new Error(`duplicate toy account ${account.account}`)
    this.accounts.set(account.account, {
      account: account.account,
      uuid: account.uuid,
      devices: (account.devices ?? [{ id: 1, name: 'Toy primary' }]).map((device) => ({
        id: device.id,
        name: device.name,
        created: device.created ?? timestamp,
        lastSeen: device.lastSeen ?? timestamp
      }))
    })
  }

  private addGroup(group: ToyGroupConfig): void {
    if (this.groups.has(group.id)) throw new Error(`duplicate toy group ${group.id}`)
    for (const member of group.members) this.requireAccount(member)
    for (const admin of group.admins ?? []) this.requireAccount(admin)
    this.groups.set(group.id, {
      id: group.id,
      name: group.name,
      description: group.description ?? '',
      members: new Set(group.members),
      admins: new Set(group.admins ?? [])
    })
  }

  private accountFor(
    params: Readonly<Record<string, unknown>>,
    fixedAccount?: string
  ): AccountState {
    const requested = params.account
    if (fixedAccount) {
      if (requested !== undefined && requested !== fixedAccount)
        throw new ToyRpcError(-32602, 'account does not match single-account daemon')
      return this.requireAccount(fixedAccount)
    }
    if (typeof requested !== 'string' || requested.length === 0)
      throw new ToyRpcError(-32602, 'account param is required in multi-account mode')
    return this.requireAccount(requested)
  }

  private requireAccount(account: string): AccountState {
    const result = this.accounts.get(account)
    if (!result) throw new ToyRpcError(-32602, `unknown account ${account}`)
    return result
  }

  private listDevices(account: AccountState): unknown[] {
    return account.devices.map((device) => ({ ...device }))
  }

  private listGroups(account: AccountState, params: Readonly<Record<string, unknown>>): unknown[] {
    const filter = stringArray(params.groupIds ?? params.groupId)
    return [...this.groups.values()]
      .filter((group) => group.members.has(account.account))
      .filter((group) => filter.length === 0 || filter.includes(group.id))
      .map((group) => ({
        id: group.id,
        name: group.name,
        description: group.description,
        isMember: group.members.has(account.account),
        isBlocked: false,
        members: [...group.members].map((member) => this.recipient(member)),
        pendingMembers: [],
        requestingMembers: [],
        admins: [...group.admins].map((admin) => this.recipient(admin)),
        groupInviteLink: null
      }))
  }

  private getUserStatus(params: Readonly<Record<string, unknown>>): unknown[] {
    return stringArray(params.recipients ?? params.recipient).map((recipient) => ({
      recipient,
      isRegistered: this.accounts.has(recipient)
    }))
  }

  private async send(
    sender: AccountState,
    params: Readonly<Record<string, unknown>>
  ): Promise<{ timestamp: number }> {
    if (this.faults.failNextRpcSends > 0) {
      this.faults.failNextRpcSends -= 1
      throw new ToyRpcError(-32000, 'toy injected send failure')
    }
    const message = requiredString(params.message, 'message')
    const groupIds = stringArray(params.groupIds ?? params.groupId)
    const recipients = stringArray(params.recipients ?? params.recipient)
    if (groupIds.length === 0 && recipients.length === 0)
      throw new ToyRpcError(-32602, 'send requires groupId/groupIds or recipient/recipients')
    if (groupIds.length > 0 && recipients.length > 0)
      throw new ToyRpcError(-32602, 'toy send accepts either groups or recipients, not both')
    const timestamp = this.now()
    if (groupIds.length > 0) {
      for (const groupId of groupIds) await this.sendGroup(sender, groupId, message, timestamp)
    } else {
      for (const recipient of recipients)
        await this.sendDirect(sender, recipient, message, timestamp)
    }
    return { timestamp }
  }

  private async sendGroup(
    sender: AccountState,
    groupId: string,
    message: string,
    timestamp: number
  ): Promise<void> {
    const group = this.groups.get(groupId)
    if (!group) throw new ToyRpcError(-32602, `unknown group ${groupId}`)
    if (!group.members.has(sender.account))
      throw new ToyRpcError(-32602, `account ${sender.account} is not a member of ${groupId}`)

    await this.emitSenderSync(sender, message, timestamp, groupId)
    for (const member of group.members) {
      if (member === sender.account) continue
      await this.emitDataMessage(this.requireAccount(member), sender, message, timestamp, groupId)
    }
  }

  private async sendDirect(
    sender: AccountState,
    recipientId: string,
    message: string,
    timestamp: number
  ): Promise<void> {
    const recipient = this.requireAccount(recipientId)
    await this.emitSenderSync(sender, message, timestamp)
    await this.emitDataMessage(recipient, sender, message, timestamp)
  }

  private updateGroup(
    account: AccountState,
    params: Readonly<Record<string, unknown>>
  ): { timestamp: number } {
    const requestedGroupId = typeof params.groupId === 'string' ? params.groupId : undefined
    let group: GroupState
    if (requestedGroupId) {
      const existing = this.groups.get(requestedGroupId)
      if (!existing) throw new ToyRpcError(-32602, `unknown group ${requestedGroupId}`)
      if (!existing.admins.has(account.account))
        throw new ToyRpcError(-32003, 'group admin required')
      group = existing
    } else {
      const name = requiredString(params.name, 'name')
      const groupId = Buffer.from(`toy-group:${this.groups.size + 1}:${name}`, 'utf8').toString(
        'base64'
      )
      group = {
        id: groupId,
        name,
        description: '',
        members: new Set([account.account]),
        admins: new Set([account.account])
      }
      this.groups.set(groupId, group)
    }
    if (typeof params.name === 'string') group.name = params.name
    if (typeof params.description === 'string') group.description = params.description
    for (const member of stringArray(params.members ?? params.member)) {
      this.requireAccount(member)
      group.members.add(member)
    }
    for (const member of stringArray(params.removeMember)) group.members.delete(member)
    for (const admin of stringArray(params.admin)) {
      this.requireAccount(admin)
      group.members.add(admin)
      group.admins.add(admin)
    }
    for (const admin of stringArray(params.removeAdmin)) group.admins.delete(admin)
    return { timestamp: this.now() }
  }

  private quitGroup(
    account: AccountState,
    params: Readonly<Record<string, unknown>>
  ): { timestamp: number } {
    const groupId = requiredString(params.groupId, 'groupId')
    const group = this.groups.get(groupId)
    if (!group) throw new ToyRpcError(-32602, `unknown group ${groupId}`)
    group.members.delete(account.account)
    group.admins.delete(account.account)
    return { timestamp: this.now() }
  }

  private startLink(): { deviceLinkUri: string } {
    const uri = `sgnl://linkdevice?uuid=${randomUUID()}&pub_key=${randomUUID().replaceAll('-', '')}`
    this.links.set(uri, { uri, createdAt: this.now() })
    return { deviceLinkUri: uri }
  }

  private finishLink(params: Readonly<Record<string, unknown>>): { deviceLinkUri: string } {
    const uri = requiredString(params.deviceLinkUri, 'deviceLinkUri')
    if (!this.links.has(uri)) throw new ToyRpcError(-32602, 'unknown or expired deviceLinkUri')
    this.links.delete(uri)
    return { deviceLinkUri: uri }
  }

  private recipient(account: string): { number: string; uuid: string } {
    const state = this.requireAccount(account)
    return { number: state.account, uuid: state.uuid }
  }

  private async emitSenderSync(
    sender: AccountState,
    message: string,
    timestamp: number,
    groupId?: string
  ): Promise<void> {
    const sentMessage: Record<string, unknown> = {
      timestamp,
      message,
      expiresInSeconds: 0,
      viewOnce: false
    }
    if (groupId) sentMessage.groupInfo = { groupId, type: 'DELIVER' }
    await this.emitReceive(sender.account, {
      source: sender.account,
      sourceNumber: sender.account,
      sourceUuid: sender.uuid,
      sourceName: 'Toy self',
      sourceDevice: 2,
      timestamp,
      syncMessage: { sentMessage }
    })
  }

  private async emitDataMessage(
    recipient: AccountState,
    sender: AccountState,
    message: string,
    timestamp: number,
    groupId?: string
  ): Promise<void> {
    const dataMessage: Record<string, unknown> = {
      timestamp,
      message,
      expiresInSeconds: 0,
      viewOnce: false,
      mentions: [],
      attachments: [],
      contacts: []
    }
    if (groupId) dataMessage.groupInfo = { groupId, type: 'DELIVER' }
    await this.emitReceive(recipient.account, {
      source: sender.account,
      sourceNumber: sender.account,
      sourceUuid: sender.uuid,
      sourceName: `Toy ${sender.account}`,
      sourceDevice: 1,
      timestamp,
      dataMessage
    })
  }

  private async emitReceive(account: string, envelope: Record<string, unknown>): Promise<void> {
    if (this.faults.dropNextDeliveries > 0) {
      this.faults.dropNextDeliveries -= 1
      return
    }
    const notification = {
      jsonrpc: '2.0',
      method: 'receive',
      params: { account, envelope }
    }
    const copies = this.faults.duplicateNextDeliveries > 0 ? 2 : 1
    if (copies === 2) this.faults.duplicateNextDeliveries -= 1
    if (this.faults.deliveryDelayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, this.faults.deliveryDelayMs))
    for (let copy = 0; copy < copies; copy += 1) this.broadcast(notification)
    if (this.faults.closeSseAfterNextDelivery) {
      this.faults.closeSseAfterNextDelivery = false
      this.closeSseClients()
    }
  }

  private broadcast(notification: unknown): void {
    const body = `data: ${JSON.stringify(notification)}\n\n`
    for (const client of this.sseClients.values()) client.response.write(body)
    this.deliveredNotifications += 1
  }
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new ToyRpcError(-32602, `${name} must be a non-empty string`)
  return value
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value)) throw new ToyRpcError(-32602, `${name} must be a safe integer`)
  return value as number
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative safe integer`)
  return value
}

function stringArray(value: unknown): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new ToyRpcError(-32602, 'expected a string or array of strings')
  return [...value] as string[]
}

function deterministicUuid(input: string): string {
  let hash = 2166136261
  for (const char of input) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0
  const suffix = hash.toString(16).padStart(8, '0')
  return `20000000-0000-4000-8000-${suffix.padStart(12, '0')}`
}
