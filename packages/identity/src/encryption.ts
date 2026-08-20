import {
  decodeEnvelope,
  type EncryptedEnvelope,
  encodeEncryptedEnvelopeAad,
  encodeEncryptedEnvelopeKdfInfo,
  encodeEncryptedEnvelopeSignatureInput,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type ProtocolEnvelope,
  validateEncryptedEnvelope
} from '@e2e-col/protocol'
import { bytesToBase64, importX25519Public } from './encoding'
import type { IdentityRecipient, RemoteIdentity, UserIdentity } from './types'

const HKDF_SALT_DOMAIN = new TextEncoder().encode('e2e-col/encrypted-envelope/hkdf-salt/v1')

export async function encryptProtocolEnvelope(
  envelope: ProtocolEnvelope,
  localIdentity: UserIdentity,
  recipient: IdentityRecipient,
  remoteIdentity: RemoteIdentity
): Promise<EncryptedEnvelope> {
  if (envelope.senderId !== localIdentity.userId)
    throw new Error('protocol envelope sender does not match local identity')
  assertRemoteIdentity(recipient, remoteIdentity)

  const recipientKey = remoteIdentity.oneTimePrekey ?? remoteIdentity.signedPrekeyPublic
  const recipientPrekeyKind = remoteIdentity.oneTimePrekey
    ? ('one-time' as const)
    : ('signed' as const)
  const recipientKeySelector = await publicKeyFingerprint(recipientKey)
  const ephemeral = asKeyPair(
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  )
  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const metadata = {
    version: PROTOCOL_VERSION,
    documentId: envelope.documentId,
    messageId: envelope.messageId,
    senderId: localIdentity.userId,
    senderPhoneNumber: localIdentity.phoneNumber,
    recipientId: recipient.userId,
    recipientPhoneNumber: recipient.phoneNumber,
    recipientPrekeyKind,
    recipientKeySelector,
    ephemeralPublic,
    nonce
  } as const
  const key = await deriveAesKey(ephemeral.privateKey, recipientKey, metadata, ['encrypt'])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(nonce),
        additionalData: toArrayBuffer(encodeEncryptedEnvelopeAad(metadata)),
        tagLength: 128
      },
      key,
      toArrayBuffer(encodeEnvelope(envelope))
    )
  )
  const unsigned = { ...metadata, ciphertext }
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      localIdentity.identityKeyPair.privateKey,
      toArrayBuffer(encodeEncryptedEnvelopeSignatureInput(unsigned))
    )
  )
  return validateEncryptedEnvelope({ ...unsigned, signature })
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

export async function decryptProtocolEnvelope(
  encryptedValue: EncryptedEnvelope,
  localIdentity: UserIdentity,
  senderIdentity: RemoteIdentity
): Promise<ProtocolEnvelope> {
  const encrypted = validateEncryptedEnvelope(encryptedValue)
  if (
    encrypted.recipientId !== localIdentity.userId ||
    encrypted.recipientPhoneNumber !== localIdentity.phoneNumber
  )
    throw new Error('encrypted envelope is bound to a different recipient identity')
  if (
    senderIdentity.userId !== encrypted.senderId ||
    senderIdentity.phoneNumber !== encrypted.senderPhoneNumber
  )
    throw new Error('encrypted envelope sender identity does not match distributed identity')

  const signatureValid = await crypto.subtle.verify(
    { name: 'Ed25519' },
    senderIdentity.identityKeyPublic,
    toArrayBuffer(encrypted.signature),
    toArrayBuffer(encodeEncryptedEnvelopeSignatureInput(encrypted))
  )
  if (!signatureValid) throw new Error('encrypted envelope sender signature is invalid')

  const recipientPrivate = await resolveRecipientPrivateKey(encrypted, localIdentity)
  const ephemeralPublic = await importX25519Public(bytesToBase64(encrypted.ephemeralPublic))
  const key = await deriveAesKey(recipientPrivate, ephemeralPublic, encrypted, ['decrypt'])
  let plaintext: Uint8Array
  try {
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: toArrayBuffer(encrypted.nonce),
          additionalData: toArrayBuffer(encodeEncryptedEnvelopeAad(encrypted)),
          tagLength: 128
        },
        key,
        toArrayBuffer(encrypted.ciphertext)
      )
    )
  } catch {
    throw new Error('encrypted envelope authentication failed')
  }

  // Protocol decoding deliberately happens only after recipient binding,
  // sender signature verification, and authenticated decryption all succeed.
  const envelope = decodeEnvelope(plaintext)
  if (
    envelope.documentId !== encrypted.documentId ||
    envelope.messageId !== encrypted.messageId ||
    envelope.senderId !== encrypted.senderId
  )
    throw new Error('decrypted protocol envelope metadata does not match encrypted binding')
  return envelope
}

export async function publicKeyFingerprint(key: CryptoKey): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', await crypto.subtle.exportKey('raw', key))
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function resolveRecipientPrivateKey(
  encrypted: EncryptedEnvelope,
  identity: UserIdentity
): Promise<CryptoKey> {
  if (encrypted.recipientPrekeyKind === 'signed') {
    if (
      (await publicKeyFingerprint(identity.signedPrekeyPair.publicKey)) !==
      encrypted.recipientKeySelector
    )
      throw new Error('encrypted envelope signed-prekey selector is unknown')
    return identity.signedPrekeyPair.privateKey
  }
  for (const prekey of identity.oneTimePrekeys) {
    if ((await publicKeyFingerprint(prekey.publicKey)) === encrypted.recipientKeySelector)
      return prekey.privateKey
  }
  throw new Error('encrypted envelope one-time-prekey selector is unknown')
}

async function deriveAesKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  metadata: Parameters<typeof encodeEncryptedEnvelopeKdfInfo>[0],
  usages: KeyUsage[]
): Promise<CryptoKey> {
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'X25519', public: publicKey },
    privateKey,
    256
  )
  const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveKey'])
  const salt = new Uint8Array(
    await crypto.subtle.digest('SHA-256', toArrayBuffer(HKDF_SALT_DOMAIN))
  )
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(encodeEncryptedEnvelopeKdfInfo(metadata))
    },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  )
}

function assertRemoteIdentity(recipient: IdentityRecipient, remote: RemoteIdentity): void {
  if (remote.userId !== recipient.userId || remote.phoneNumber !== recipient.phoneNumber)
    throw new Error('recipient identity does not match distributed public-key bundle')
}

function asKeyPair(value: CryptoKeyPair): CryptoKeyPair {
  if (!value.publicKey || !value.privateKey) throw new Error('WebCrypto did not return a keypair')
  return value
}
