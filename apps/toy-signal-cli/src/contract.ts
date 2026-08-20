export const TOY_SIGNAL_CLI_CONTRACT_VERSION = 1 as const

export const SIGNAL_CLI_HTTP_ENDPOINTS = {
  check: '/api/v1/check',
  events: '/api/v1/events',
  rpc: '/api/v1/rpc'
} as const

export const TOY_CONTROL_ENDPOINTS = {
  contract: '/__toy__/v1/contract',
  state: '/__toy__/v1/state',
  reset: '/__toy__/v1/reset',
  faults: '/__toy__/v1/faults',
  inject: '/__toy__/v1/inject'
} as const

/**
 * Compatibility profile implemented semantically by the toy daemon.
 * Unknown upstream signal-cli commands fail with JSON-RPC -32601 rather than
 * returning a misleading no-op success.
 */
export const SUPPORTED_RPC_METHODS = [
  'version',
  'listAccounts',
  'listDevices',
  'listGroups',
  'getUserStatus',
  'send',
  'updateGroup',
  'quitGroup',
  'sendSyncRequest',
  'subscribeReceive',
  'unsubscribeReceive',
  'startLink',
  'finishLink'
] as const

export type SupportedRpcMethod = (typeof SUPPORTED_RPC_METHODS)[number]

export interface RpcMethodContract {
  readonly accountScope: 'none' | 'account' | 'subscription'
  readonly requiredParams: readonly string[]
  readonly optionalParams: readonly string[]
  readonly result: string
  readonly notes?: string
}

/** Machine-readable semantic contract for every method the toy claims to support. */
export const RPC_METHOD_CONTRACTS = {
  version: {
    accountScope: 'none',
    requiredParams: [],
    optionalParams: [],
    result: '{ version: string }'
  },
  listAccounts: {
    accountScope: 'none',
    requiredParams: [],
    optionalParams: [],
    result: 'string[]'
  },
  listDevices: {
    accountScope: 'account',
    requiredParams: ['account'],
    optionalParams: [],
    result: 'Array<{ id: number; name: string; created: number; lastSeen: number }>'
  },
  listGroups: {
    accountScope: 'account',
    requiredParams: ['account'],
    optionalParams: ['groupId', 'groupIds'],
    result: 'Group[]'
  },
  getUserStatus: {
    accountScope: 'account',
    requiredParams: ['account'],
    optionalParams: ['recipient', 'recipients'],
    result: 'Array<{ recipient: string; isRegistered: boolean }>',
    notes: 'recipient or recipients supplies the lookup targets'
  },
  send: {
    accountScope: 'account',
    requiredParams: ['account', 'message'],
    optionalParams: ['groupId', 'groupIds', 'recipient', 'recipients'],
    result: '{ timestamp: number }',
    notes: 'exactly one target family is required: group(s) or recipient(s)'
  },
  updateGroup: {
    accountScope: 'account',
    requiredParams: ['account'],
    optionalParams: [
      'groupId',
      'name',
      'description',
      'member',
      'members',
      'removeMember',
      'admin',
      'removeAdmin'
    ],
    result: '{ timestamp: number }',
    notes: 'without groupId, name is required and a new toy group is created'
  },
  quitGroup: {
    accountScope: 'account',
    requiredParams: ['account', 'groupId'],
    optionalParams: [],
    result: '{ timestamp: number }'
  },
  sendSyncRequest: {
    accountScope: 'account',
    requiredParams: ['account'],
    optionalParams: [],
    result: '{}'
  },
  subscribeReceive: {
    accountScope: 'account',
    requiredParams: ['account'],
    optionalParams: [],
    result: 'number'
  },
  unsubscribeReceive: {
    accountScope: 'subscription',
    requiredParams: ['subscription'],
    optionalParams: [],
    result: '{}'
  },
  startLink: {
    accountScope: 'none',
    requiredParams: [],
    optionalParams: [],
    result: '{ deviceLinkUri: string }'
  },
  finishLink: {
    accountScope: 'none',
    requiredParams: ['deviceLinkUri'],
    optionalParams: ['deviceName'],
    result: '{ deviceLinkUri: string }',
    notes: 'toy validates the link session but does not perform real Signal provisioning'
  }
} as const satisfies Record<SupportedRpcMethod, RpcMethodContract>

export const TOY_SIGNAL_CLI_API_SPEC = {
  profile: 'e2e-col-signal-cli-http',
  contractVersion: TOY_SIGNAL_CLI_CONTRACT_VERSION,
  transport: {
    rpc: {
      method: 'POST',
      path: SIGNAL_CLI_HTTP_ENDPOINTS.rpc,
      protocol: 'JSON-RPC 2.0',
      singleAndBatch: true,
      notifications: true
    },
    events: {
      method: 'GET',
      path: SIGNAL_CLI_HTTP_ENDPOINTS.events,
      protocol: 'Server-Sent Events',
      jsonRpcNotificationMethod: 'receive',
      accountField: 'params.account'
    },
    health: {
      method: 'GET',
      path: SIGNAL_CLI_HTTP_ENDPOINTS.check
    }
  },
  rpcMethods: SUPPORTED_RPC_METHODS,
  rpcContracts: RPC_METHOD_CONTRACTS,
  errorCodes: {
    parseError: -32700,
    invalidRequest: -32600,
    methodNotFound: -32601,
    invalidParams: -32602,
    internalError: -32603,
    injectedSendFailure: -32000
  },
  unsupportedMethodBehavior: {
    code: -32601,
    message: 'Method not found'
  },
  toyControls: TOY_CONTROL_ENDPOINTS,
  fidelity: {
    localDaemonApi: 'semantic',
    signalCryptography: 'not-implemented',
    signalService: 'not-implemented',
    realDeviceProvisioning: 'not-implemented'
  }
} as const
export type JsonRpcId = string | number | null

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: Readonly<Record<string, unknown>>
  readonly id?: JsonRpcId
}

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data: unknown
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly result: unknown
  readonly id: JsonRpcId
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly error: JsonRpcErrorObject
  readonly id: JsonRpcId
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure

export interface ToyDeviceConfig {
  readonly id: number
  readonly name: string
  readonly created?: number
  readonly lastSeen?: number
}

export interface ToyAccountConfig {
  readonly account: string
  readonly uuid: string
  readonly devices?: readonly ToyDeviceConfig[]
}

export interface ToyGroupConfig {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly members: readonly string[]
  readonly admins?: readonly string[]
}

export interface ToySignalConfig {
  readonly accounts: readonly ToyAccountConfig[]
  readonly groups: readonly ToyGroupConfig[]
}

export interface ToyFaultProfile {
  readonly failNextRpcSends?: number
  readonly dropNextDeliveries?: number
  readonly duplicateNextDeliveries?: number
  readonly deliveryDelayMs?: number
  readonly closeSseAfterNextDelivery?: boolean
}

export interface ToyInjectRequest {
  readonly account: string
  readonly message: string
  readonly groupId?: string
  readonly source?: string
}

export const DEFAULT_TOY_GROUP_ID = 'VE9ZLUUyRS1DT0wtREVNTy1HUk9VUA=='
export const DEFAULT_TOY_ACCOUNT_A = '+15550000001'
export const DEFAULT_TOY_ACCOUNT_B = '+15550000002'

export const DEFAULT_TOY_SIGNAL_CONFIG: ToySignalConfig = {
  accounts: [
    {
      account: DEFAULT_TOY_ACCOUNT_A,
      uuid: '10000000-0000-4000-8000-000000000001',
      devices: [
        { id: 1, name: 'Toy primary A' },
        { id: 2, name: 'Toy linked A' }
      ]
    },
    {
      account: DEFAULT_TOY_ACCOUNT_B,
      uuid: '10000000-0000-4000-8000-000000000002',
      devices: [
        { id: 1, name: 'Toy primary B' },
        { id: 2, name: 'Toy linked B' }
      ]
    }
  ],
  groups: [
    {
      id: DEFAULT_TOY_GROUP_ID,
      name: 'e2e-col demo',
      description: 'Deterministic toy Signal group',
      members: [DEFAULT_TOY_ACCOUNT_A, DEFAULT_TOY_ACCOUNT_B],
      admins: [DEFAULT_TOY_ACCOUNT_A]
    }
  ]
}
