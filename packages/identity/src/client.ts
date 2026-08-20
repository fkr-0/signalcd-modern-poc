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
  UserIdentity
} from './types'

const DEFAULT_ONE_TIME_PREKEY_COUNT = 10

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
    const signedPrekeyPair = asKeyPair(
      await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
    )
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

    const identity: UserIdentity = {
      userId: claim.userId,
      phoneNumber: claim.phoneNumber,
      displayName: claim.displayName,
      identityKeyPair,
      signedPrekeyPair,
      oneTimePrekeys,
      sessionToken: claim.sessionToken,
      createdAt: claim.createdAt
    }
    await this.options.storage.saveLocalIdentity(identity)
    return identity
  }

  async openSession(): Promise<UserIdentity | undefined> {
    const identity = await this.options.storage.loadLocalIdentity()
    if (!identity) return undefined
    const session = await this.options.provider.verifySession(identity.sessionToken)
    if (session.userId !== identity.userId || session.phoneNumber !== identity.phoneNumber)
      throw new Error('identity session does not match locally persisted identity')
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
