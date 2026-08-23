import {
  decodeEncryptedEnvelope,
  type EncryptedEnvelope,
  type ProtocolEnvelope
} from '@e2e-col/protocol'
import {
  base64ToBytes,
  bytesToBase64,
  exportRawKey,
  importEd25519Public,
  importX25519Public
} from './encoding'
import { decryptProtocolEnvelope, encryptProtocolEnvelope } from './encryption'
import type {
  IdentityProvider,
  IdentityRecipient,
  IdentityStorage,
  OneTimePrekey,
  RemoteIdentity,
  SignedPrekey,
  SignedPrekeyPublicMaterial,
  UserIdentity
} from './types'

const DEFAULT_ONE_TIME_PREKEY_COUNT = 10
const ONE_TIME_PREKEY_REPLENISH_THRESHOLD = 5

export interface IdentityClientOptions {
  readonly provider: IdentityProvider
  readonly storage: IdentityStorage
  readonly now?: () => number
}

export class IdentityClient {
  private readonly now: () => number

  constructor(private readonly options: IdentityClientOptions) {
    this.now = options.now ?? Date.now
  }

  async encryptEnvelopeForRecipient(
    envelope: ProtocolEnvelope,
    recipient: IdentityRecipient,
    localIdentity: UserIdentity
  ): Promise<EncryptedEnvelope> {
    const remote = await this.fetchRemoteIdentity(recipient.phoneNumber, localIdentity)
    return encryptProtocolEnvelope(envelope, localIdentity, recipient, remote)
  }

  async decryptEnvelope(
    value: Uint8Array | EncryptedEnvelope,
    localIdentity: UserIdentity
  ): Promise<ProtocolEnvelope> {
    const encrypted = value instanceof Uint8Array ? decodeEncryptedEnvelope(value) : value
    if (
      encrypted.recipientId !== localIdentity.userId ||
      encrypted.recipientPhoneNumber !== localIdentity.phoneNumber
    )
      throw new Error('encrypted envelope is bound to a different recipient identity')
    let sender = await this.options.storage.loadRemoteIdentity(encrypted.senderId)
    if (!sender || sender.phoneNumber !== encrypted.senderPhoneNumber)
      sender = await this.fetchRemoteIdentity(encrypted.senderPhoneNumber, localIdentity)
    return decryptProtocolEnvelope(encrypted, localIdentity, sender)
  }

  async register(displayName: string): Promise<UserIdentity> {
    const normalizedName = displayName.trim()
    if (normalizedName.length < 1 || normalizedName.length > 64)
      throw new Error('display name must contain between 1 and 64 characters')

    const identityKeyPair = asKeyPair(
      await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
    )
    const signedPrekeyPair = await this.createSignedPrekey()
    const signedPrekeyPublic = await exportRawKey(signedPrekeyPair.publicKey)
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      identityKeyPair.privateKey,
      base64ToBytes(signedPrekeyPublic)
    )
    const oneTimePrekeys = await Promise.all(
      Array.from({ length: DEFAULT_ONE_TIME_PREKEY_COUNT }, () => this.createOneTimePrekey())
    )
    const oneTimePrekeyPublic = await Promise.all(
      oneTimePrekeys.map((prekey) => exportRawKey(prekey.publicKey))
    )
    const identityKeyPublic = await exportRawKey(identityKeyPair.publicKey)
    const claim = await this.options.provider.register({
      displayName: normalizedName,
      identityKeyPublic,
      signedPrekeyPublic,
      signedPrekeySignature: bytesToBase64(new Uint8Array(signature)),
      oneTimePrekeys: oneTimePrekeyPublic
    })
    if (
      claim.identityKeyPublic !== identityKeyPublic ||
      claim.signedPrekeyPublic !== signedPrekeyPublic
    )
      throw new Error('identity provider changed the registered public key material')

    const publishedAt = this.now()
    const identity: UserIdentity = {
      userId: claim.userId,
      phoneNumber: claim.phoneNumber,
      displayName: claim.displayName,
      identityKeyPair,
      signedPrekeyPair,
      retiredSignedPrekeys: [],
      oneTimePrekeys: oneTimePrekeys.map((prekey) => ({ ...prekey, publishedAt })),
      sessionToken: claim.sessionToken,
      createdAt: claim.createdAt
    }
    await this.options.storage.saveLocalIdentity(identity)
    return identity
  }

  async openSession(): Promise<UserIdentity | undefined> {
    let identity = await this.options.storage.loadLocalIdentity()
    if (!identity) return undefined
    const session = await this.options.provider.verifySession(identity.sessionToken)
    if (session.userId !== identity.userId || session.phoneNumber !== identity.phoneNumber)
      throw new Error('identity session does not match locally persisted identity')
    const hadPendingSignedPrekey = identity.pendingSignedPrekey !== undefined
    identity = await this.reconcileSignedPrekey(identity, session.signedPrekeyPublic)
    if (session.signedPrekeyRotationRequired && !hadPendingSignedPrekey)
      identity = await this.rotateSignedPrekey(identity)
    identity = await this.replenishOneTimePrekeys(identity, session.prekeyCount)
    return identity
  }

  async fetchRemoteIdentity(
    phoneNumber: string,
    localIdentity: UserIdentity
  ): Promise<RemoteIdentity> {
    const bundle = await this.options.provider.lookupKeys(phoneNumber, localIdentity.sessionToken)
    const identityKeyPublic = await importEd25519Public(bundle.identityKeyPublic)
    const signedPrekeyPublic = await importX25519Public(bundle.signedPrekeyPublic)
    const signatureValid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      identityKeyPublic,
      base64ToBytes(bundle.signedPrekeySignature),
      base64ToBytes(bundle.signedPrekeyPublic)
    )
    if (!signatureValid) throw new Error('remote signed prekey signature is invalid')
    const oneTimePrekey = bundle.oneTimePrekey
      ? await importX25519Public(bundle.oneTimePrekey)
      : undefined
    const remote: RemoteIdentity = {
      userId: bundle.userId,
      phoneNumber: bundle.phoneNumber,
      ...(bundle.displayName === undefined ? {} : { displayName: bundle.displayName }),
      identityKeyPublic,
      signedPrekeyPublic,
      ...(oneTimePrekey === undefined ? {} : { oneTimePrekey }),
      verified: false,
      fetchedAt: this.now()
    }
    await this.options.storage.saveRemoteIdentity(remote)
    return remote
  }

  async verifyRemoteIdentity(userId: string): Promise<RemoteIdentity> {
    const identity = await this.options.storage.loadRemoteIdentity(userId)
    if (!identity) throw new Error(`unknown remote identity ${userId}`)
    const verified = { ...identity, verified: true }
    await this.options.storage.saveRemoteIdentity(verified)
    return verified
  }

  async close(): Promise<void> {
    await this.options.storage.close()
  }

  private async reconcileSignedPrekey(
    identity: UserIdentity,
    providerSignedPrekeyPublic: string
  ): Promise<UserIdentity> {
    const currentPublic = await exportRawKey(identity.signedPrekeyPair.publicKey)
    const pending = identity.pendingSignedPrekey
    if (!pending) {
      if (currentPublic !== providerSignedPrekeyPublic)
        throw new Error('identity provider changed the persisted signed prekey')
      return identity
    }

    const pendingPublic = await exportRawKey(pending.publicKey)
    if (providerSignedPrekeyPublic === pendingPublic)
      return this.finalizeSignedPrekey(identity, pending)
    if (providerSignedPrekeyPublic !== currentPublic)
      throw new Error('identity provider signed prekey does not match current or staged material')
    return this.publishSignedPrekey(identity, pending)
  }

  private async rotateSignedPrekey(identity: UserIdentity): Promise<UserIdentity> {
    const pending = await this.createSignedPrekey()
    const staged: UserIdentity = { ...identity, pendingSignedPrekey: pending }
    await this.options.storage.saveLocalIdentity(staged)
    return this.publishSignedPrekey(staged, pending)
  }

  private async publishSignedPrekey(
    identity: UserIdentity,
    pending: SignedPrekey
  ): Promise<UserIdentity> {
    const material = await this.signedPrekeyPublicMaterial(identity, pending)
    const claim = await this.options.provider.rotateSignedPrekey(identity.sessionToken, material)
    if (
      claim.signedPrekeyPublic !== material.signedPrekeyPublic ||
      claim.signedPrekeySignature !== material.signedPrekeySignature
    )
      throw new Error('identity provider changed rotated signed-prekey material')
    return this.finalizeSignedPrekey(identity, pending)
  }

  private async finalizeSignedPrekey(
    identity: UserIdentity,
    pending: SignedPrekey
  ): Promise<UserIdentity> {
    const { pendingSignedPrekey: _pending, ...stable } = identity
    const next: UserIdentity = {
      ...stable,
      signedPrekeyPair: pending,
      retiredSignedPrekeys: [identity.signedPrekeyPair, ...identity.retiredSignedPrekeys]
    }
    await this.options.storage.saveLocalIdentity(next)
    return next
  }

  private async replenishOneTimePrekeys(
    identity: UserIdentity,
    providerCount: number
  ): Promise<UserIdentity> {
    let current = identity
    let count = providerCount
    const pending = current.oneTimePrekeys.filter((prekey) => prekey.publishedAt === undefined)
    if (pending.length > 0) {
      const published = await this.publishOneTimePrekeys(current, pending)
      current = published.identity
      count = published.providerCount
    }
    if (count >= ONE_TIME_PREKEY_REPLENISH_THRESHOLD) return current

    const replenishCount = Math.max(1, DEFAULT_ONE_TIME_PREKEY_COUNT - count)
    const stagedPrekeys = await Promise.all(
      Array.from({ length: replenishCount }, () => this.createOneTimePrekey())
    )
    const staged: UserIdentity = {
      ...current,
      oneTimePrekeys: [...current.oneTimePrekeys, ...stagedPrekeys]
    }
    await this.options.storage.saveLocalIdentity(staged)
    return (await this.publishOneTimePrekeys(staged, stagedPrekeys)).identity
  }

  private async publishOneTimePrekeys(
    identity: UserIdentity,
    pending: readonly OneTimePrekey[]
  ): Promise<{ identity: UserIdentity; providerCount: number }> {
    const publicKeys = await Promise.all(pending.map((prekey) => exportRawKey(prekey.publicKey)))
    const providerCount = await this.options.provider.replenishPrekeys(
      identity.sessionToken,
      publicKeys
    )
    const publishedIds = new Set(pending.map((prekey) => prekey.keyId))
    const publishedAt = this.now()
    const next: UserIdentity = {
      ...identity,
      oneTimePrekeys: identity.oneTimePrekeys.map((prekey) =>
        publishedIds.has(prekey.keyId) ? { ...prekey, publishedAt } : prekey
      )
    }
    await this.options.storage.saveLocalIdentity(next)
    return { identity: next, providerCount }
  }

  private async signedPrekeyPublicMaterial(
    identity: UserIdentity,
    signedPrekey: SignedPrekey
  ): Promise<SignedPrekeyPublicMaterial> {
    const signedPrekeyPublic = await exportRawKey(signedPrekey.publicKey)
    const signature = await crypto.subtle.sign(
      { name: 'Ed25519' },
      identity.identityKeyPair.privateKey,
      base64ToBytes(signedPrekeyPublic)
    )
    return {
      signedPrekeyPublic,
      signedPrekeySignature: bytesToBase64(new Uint8Array(signature))
    }
  }

  private async createSignedPrekey(): Promise<SignedPrekey> {
    const pair = asKeyPair(
      await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
    )
    return {
      keyId: crypto.randomUUID(),
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      createdAt: this.now()
    }
  }

  private async createOneTimePrekey(): Promise<OneTimePrekey> {
    const pair = asKeyPair(
      await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
    )
    return {
      keyId: crypto.randomUUID(),
      publicKey: pair.publicKey,
      privateKey: pair.privateKey,
      createdAt: this.now()
    }
  }
}

export async function createSafetyNumber(
  firstIdentityPublic: CryptoKey,
  secondIdentityPublic: CryptoKey
): Promise<string> {
  const publicKeys = await Promise.all([
    crypto.subtle.exportKey('raw', firstIdentityPublic),
    crypto.subtle.exportKey('raw', secondIdentityPublic)
  ])
  const ordered = publicKeys
    .map((value) => new Uint8Array(value))
    .sort((left, right) => compareBytes(left, right))
  const combined = new Uint8Array(ordered[0]!.byteLength + ordered[1]!.byteLength)
  combined.set(ordered[0]!, 0)
  combined.set(ordered[1]!, ordered[0]!.byteLength)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', combined))
  let value = 0n
  for (const byte of digest) value = (value << 8n) | BigInt(byte)
  return (value % 10n ** 60n).toString().padStart(60, '0')
}

export function formatSafetyNumber(value: string): string {
  if (!/^\d{60}$/.test(value)) throw new Error('safety number must contain exactly 60 digits')
  return value.match(/.{1,5}/g)?.join(' ') ?? value
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const delta = left[index]! - right[index]!
    if (delta !== 0) return delta
  }
  return left.length - right.length
}

function asKeyPair(value: CryptoKeyPair): CryptoKeyPair {
  if (!value.publicKey || !value.privateKey) throw new Error('WebCrypto did not return a keypair')
  return value
}
