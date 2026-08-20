import type {
  IdentityProvider,
  IdentitySessionClaim,
  RegisteredIdentityClaim,
  RegistrationPublicMaterial,
  RemoteIdentityBundle
} from './types'

export interface HttpIdentityProviderOptions {
  readonly baseUrl: string
  readonly fetch?: typeof fetch
}

export class IdentityProviderError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export class HttpIdentityProvider implements IdentityProvider {
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(options: HttpIdentityProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  }

  async register(material: RegistrationPublicMaterial): Promise<RegisteredIdentityClaim> {
    const value = await this.request('/api/v1/identity/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        display_name: material.displayName,
        identity_key_public: material.identityKeyPublic,
        signed_prekey_public: material.signedPrekeyPublic,
        signed_prekey_signature: material.signedPrekeySignature,
        one_time_prekeys: material.oneTimePrekeys
      })
    })
    return registeredClaim(value)
  }

  async verifySession(sessionToken: string): Promise<IdentitySessionClaim> {
    return sessionClaim(
      await this.request('/api/v1/identity/session', {
        headers: authorization(sessionToken)
      })
    )
  }

  async lookupKeys(phoneNumber: string, sessionToken: string): Promise<RemoteIdentityBundle> {
    return remoteBundle(
      await this.request(`/api/v1/identity/keys/${encodeURIComponent(phoneNumber)}`, {
        headers: authorization(sessionToken)
      })
    )
  }

  async replenishPrekeys(sessionToken: string, oneTimePrekeys: readonly string[]): Promise<number> {
    const value = asRecord(
      await this.request('/api/v1/identity/keys/replenish', {
        method: 'POST',
        headers: { ...authorization(sessionToken), 'content-type': 'application/json' },
        body: JSON.stringify({ one_time_prekeys: oneTimePrekeys })
      })
    )
    return requiredNumber(value.prekey_count, 'prekey_count')
  }

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, init)
    const value = await response.json().catch(() => ({}))
    if (!response.ok) {
      const record = asRecord(value)
      throw new IdentityProviderError(
        typeof record.error === 'string'
          ? record.error
          : `identity request failed (${response.status})`,
        response.status
      )
    }
    return value
  }
}

function authorization(sessionToken: string): Record<string, string> {
  return { authorization: `Bearer ${sessionToken}` }
}

function registeredClaim(value: unknown): RegisteredIdentityClaim {
  const record = asRecord(value)
  return {
    userId: requiredString(record.user_id, 'user_id'),
    phoneNumber: requiredString(record.phone_number, 'phone_number'),
    displayName: requiredString(record.display_name, 'display_name'),
    identityKeyPublic: requiredString(record.identity_key_public, 'identity_key_public'),
    signedPrekeyPublic: requiredString(record.signed_prekey_public, 'signed_prekey_public'),
    signedPrekeySignature: requiredString(
      record.signed_prekey_signature,
      'signed_prekey_signature'
    ),
    oneTimePrekeys: stringArray(record.one_time_prekeys, 'one_time_prekeys'),
    sessionToken: requiredString(record.session_token, 'session_token'),
    createdAt: requiredNumber(record.created_at, 'created_at')
  }
}

function sessionClaim(value: unknown): IdentitySessionClaim {
  const record = asRecord(value)
  return {
    userId: requiredString(record.user_id, 'user_id'),
    phoneNumber: requiredString(record.phone_number, 'phone_number'),
    displayName: requiredString(record.display_name, 'display_name'),
    createdAt: requiredNumber(record.created_at, 'created_at')
  }
}

function remoteBundle(value: unknown): RemoteIdentityBundle {
  const record = asRecord(value)
  const displayName = typeof record.display_name === 'string' ? record.display_name : undefined
  const oneTimePrekey =
    typeof record.one_time_prekey === 'string' ? record.one_time_prekey : undefined
  return {
    userId: requiredString(record.user_id, 'user_id'),
    phoneNumber: requiredString(record.phone_number, 'phone_number'),
    ...(displayName === undefined ? {} : { displayName }),
    identityKeyPublic: requiredString(record.identity_key_public, 'identity_key_public'),
    signedPrekeyPublic: requiredString(record.signed_prekey_public, 'signed_prekey_public'),
    signedPrekeySignature: requiredString(
      record.signed_prekey_signature,
      'signed_prekey_signature'
    ),
    ...(oneTimePrekey === undefined ? {} : { oneTimePrekey }),
    remainingPrekeys: requiredNumber(record.remaining_prekeys, 'remaining_prekeys')
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('identity provider returned a non-object response')
  return value as Record<string, unknown>
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`identity provider response is missing ${name}`)
  return value
}

function requiredNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`identity provider response is missing ${name}`)
  return value
}

function stringArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string'))
    throw new Error(`identity provider response is missing ${name}`)
  return value as string[]
}
