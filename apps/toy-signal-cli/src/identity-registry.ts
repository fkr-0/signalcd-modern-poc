import { randomBytes, randomUUID, webcrypto } from 'node:crypto'

interface IdentityRecord {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
  readonly identityKeyPublic: string
  signedPrekeyPublic: string
  signedPrekeySignature: string
  signedPrekeyRotatedAt: number
  readonly oneTimePrekeys: string[]
  readonly sessionToken: string
  readonly createdAt: number
}

export const SIGNED_PREKEY_ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000

function publicIdentity(record: IdentityRecord): AuthenticatedIdentity {
  return {
    userId: record.userId,
    phoneNumber: record.phoneNumber,
    displayName: record.displayName
  }
}

export interface AuthenticatedIdentity {
  readonly userId: string
  readonly phoneNumber: string
  readonly displayName: string
}

export interface IdentityRegistrationRequest {
  readonly display_name: string
  readonly identity_key_public: string
  readonly signed_prekey_public: string
  readonly signed_prekey_signature: string
  readonly one_time_prekeys: readonly string[]
}

export interface IdentityRegistryView {
  readonly registered: number
  readonly identities: readonly {
    user_id: string
    phone_number: string
    display_name: string
    prekey_count: number
    created_at: number
  }[]
}

export class IdentityApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

export class IdentityRegistry {
  private readonly byUserId = new Map<string, IdentityRecord>()
  private readonly byPhone = new Map<string, IdentityRecord>()
  private readonly byToken = new Map<string, IdentityRecord>()
  private reservedPhoneNumbers = new Set<string>()

  constructor(
    private readonly now: () => number = Date.now,
    reservedPhoneNumbers: readonly string[] = []
  ) {
    this.reset(reservedPhoneNumbers)
  }

  reset(reservedPhoneNumbers: readonly string[] = []): void {
    this.byUserId.clear()
    this.byPhone.clear()
    this.byToken.clear()
    this.reservedPhoneNumbers = new Set(reservedPhoneNumbers)
  }

  authenticate(authorization: string | undefined): AuthenticatedIdentity {
    return publicIdentity(this.authorize(authorization))
  }

  authenticateToken(token: string): AuthenticatedIdentity {
    if (!token) throw new IdentityApiError(401, 'session token required')
    const record = this.byToken.get(token)
    if (!record) throw new IdentityApiError(401, 'invalid or expired session token')
    return publicIdentity(record)
  }

  identityKeyPublicByPhone(phoneNumber: string): string {
    const record = this.byPhone.get(phoneNumber)
    if (!record) throw new IdentityApiError(404, `unknown identity ${phoneNumber}`)
    return record.identityKeyPublic
  }

  identityByPhone(phoneNumber: string): AuthenticatedIdentity {
    const record = this.byPhone.get(phoneNumber)
    if (!record) throw new IdentityApiError(404, `unknown identity ${phoneNumber}`)
    return publicIdentity(record)
  }

  async register(request: IdentityRegistrationRequest): Promise<Record<string, unknown>> {
    const displayName = validateDisplayName(request.display_name)
    const identityKey = decodeBase64(request.identity_key_public, 32, 'identity_key_public')
    const signedPrekey = decodeBase64(request.signed_prekey_public, 32, 'signed_prekey_public')
    const signedPrekeySignature = decodeBase64(
      request.signed_prekey_signature,
      64,
      'signed_prekey_signature'
    )
    if (!Array.isArray(request.one_time_prekeys) || request.one_time_prekeys.length < 1)
      throw new IdentityApiError(400, 'one_time_prekeys must contain at least one prekey')
    if (request.one_time_prekeys.length > 100)
      throw new IdentityApiError(400, 'one_time_prekeys cannot contain more than 100 prekeys')
    const oneTimePrekeys = request.one_time_prekeys.map((value, index) => {
      decodeBase64(value, 32, `one_time_prekeys[${index}]`)
      return value
    })

    const publicKey = await webcrypto.subtle.importKey(
      'raw',
      identityKey,
      { name: 'Ed25519' },
      false,
      ['verify']
    )
    const signatureValid = await webcrypto.subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      signedPrekeySignature,
      signedPrekey
    )
    if (!signatureValid) throw new IdentityApiError(400, 'signed prekey signature is invalid')

    const record: IdentityRecord = {
      userId: randomUUID(),
      phoneNumber: this.allocatePhoneNumber(),
      displayName,
      identityKeyPublic: request.identity_key_public,
      signedPrekeyPublic: request.signed_prekey_public,
      signedPrekeySignature: request.signed_prekey_signature,
      signedPrekeyRotatedAt: this.now(),
      oneTimePrekeys: [...new Set(oneTimePrekeys)],
      sessionToken: randomBytes(32).toString('base64url'),
      createdAt: this.now()
    }
    this.byUserId.set(record.userId, record)
    this.byPhone.set(record.phoneNumber, record)
    this.byToken.set(record.sessionToken, record)
    return registrationResponse(record)
  }

  session(authorization: string | undefined): Record<string, unknown> {
    const record = this.authorize(authorization)
    return sessionResponse(record, this.now())
  }

  lookup(phoneNumber: string, authorization: string | undefined): Record<string, unknown> {
    this.authorize(authorization)
    const record = this.byPhone.get(phoneNumber)
    if (!record) throw new IdentityApiError(404, `unknown identity ${phoneNumber}`)
    const oneTimePrekey = record.oneTimePrekeys.shift()
    return {
      user_id: record.userId,
      phone_number: record.phoneNumber,
      display_name: record.displayName,
      identity_key_public: record.identityKeyPublic,
      signed_prekey_public: record.signedPrekeyPublic,
      signed_prekey_signature: record.signedPrekeySignature,
      one_time_prekey: oneTimePrekey ?? null,
      remaining_prekeys: record.oneTimePrekeys.length
    }
  }

  replenish(
    authorization: string | undefined,
    oneTimePrekeys: readonly string[]
  ): Record<string, unknown> {
    const record = this.authorize(authorization)
    if (!Array.isArray(oneTimePrekeys) || oneTimePrekeys.length < 1)
      throw new IdentityApiError(400, 'one_time_prekeys must contain at least one prekey')
    if (oneTimePrekeys.length > 100)
      throw new IdentityApiError(400, 'one_time_prekeys cannot contain more than 100 prekeys')
    for (const [index, value] of oneTimePrekeys.entries()) {
      decodeBase64(value, 32, `one_time_prekeys[${index}]`)
      if (!record.oneTimePrekeys.includes(value)) record.oneTimePrekeys.push(value)
    }
    return { prekey_count: record.oneTimePrekeys.length }
  }

  async rotateSignedPrekey(
    authorization: string | undefined,
    signedPrekeyPublic: unknown,
    signedPrekeySignature: unknown
  ): Promise<Record<string, unknown>> {
    const record = this.authorize(authorization)
    const signedPrekey = decodeBase64(signedPrekeyPublic, 32, 'signed_prekey_public')
    const signature = decodeBase64(signedPrekeySignature, 64, 'signed_prekey_signature')
    const identityKey = decodeBase64(record.identityKeyPublic, 32, 'identity_key_public')
    const publicKey = await webcrypto.subtle.importKey(
      'raw',
      identityKey,
      { name: 'Ed25519' },
      false,
      ['verify']
    )
    if (!(await webcrypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, signedPrekey)))
      throw new IdentityApiError(400, 'signed prekey signature is invalid')

    record.signedPrekeyPublic = signedPrekeyPublic as string
    record.signedPrekeySignature = signedPrekeySignature as string
    record.signedPrekeyRotatedAt = this.now()
    return {
      signed_prekey_public: record.signedPrekeyPublic,
      signed_prekey_signature: record.signedPrekeySignature,
      rotated_at: record.signedPrekeyRotatedAt
    }
  }

  view(): IdentityRegistryView {
    return {
      registered: this.byUserId.size,
      identities: [...this.byUserId.values()].map((record) => ({
        user_id: record.userId,
        phone_number: record.phoneNumber,
        display_name: record.displayName,
        prekey_count: record.oneTimePrekeys.length,
        created_at: record.createdAt
      }))
    }
  }

  private authorize(authorization: string | undefined): IdentityRecord {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)
    if (!match?.[1]) throw new IdentityApiError(401, 'Bearer session token required')
    const record = this.byToken.get(match[1])
    if (!record) throw new IdentityApiError(401, 'invalid or expired session token')
    return record
  }

  private allocatePhoneNumber(): string {
    for (let suffix = 1; suffix <= 9999; suffix += 1) {
      const phone = `+1555000${suffix.toString().padStart(4, '0')}`
      if (!this.reservedPhoneNumbers.has(phone) && !this.byPhone.has(phone)) return phone
    }
    throw new IdentityApiError(503, 'mock identity namespace is exhausted')
  }
}

function registrationResponse(record: IdentityRecord): Record<string, unknown> {
  return {
    user_id: record.userId,
    phone_number: record.phoneNumber,
    display_name: record.displayName,
    identity_key_public: record.identityKeyPublic,
    signed_prekey_public: record.signedPrekeyPublic,
    signed_prekey_signature: record.signedPrekeySignature,
    one_time_prekeys: [...record.oneTimePrekeys],
    session_token: record.sessionToken,
    created_at: record.createdAt
  }
}

function sessionResponse(record: IdentityRecord, now: number): Record<string, unknown> {
  return {
    user_id: record.userId,
    phone_number: record.phoneNumber,
    display_name: record.displayName,
    signed_prekey_public: record.signedPrekeyPublic,
    signed_prekey_rotation_required:
      now - record.signedPrekeyRotatedAt >= SIGNED_PREKEY_ROTATION_INTERVAL_MS,
    prekey_count: record.oneTimePrekeys.length,
    created_at: record.createdAt
  }
}

function validateDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new IdentityApiError(400, 'display_name must be a string')
  const normalized = value.trim()
  if (normalized.length < 1 || normalized.length > 64)
    throw new IdentityApiError(400, 'display_name must contain between 1 and 64 characters')
  return normalized
}

function decodeBase64(value: unknown, length: number, name: string): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || value.length === 0)
    throw new IdentityApiError(400, `${name} must be base64`)
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength !== length)
    throw new IdentityApiError(400, `${name} must decode to ${length} bytes`)
  const owned = new Uint8Array(decoded.byteLength)
  owned.set(decoded)
  return owned
}
