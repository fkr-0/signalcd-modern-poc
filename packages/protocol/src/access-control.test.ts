import { describe, expect, it } from 'vitest'
import {
  decodeArchivePayload,
  decodeDeletePayload,
  decodeMembershipPayload,
  encodeArchivePayload,
  encodeDeletePayload,
  encodeMembershipPayload,
  membershipPayloadSigningBytes
} from './access-control'
import { ProtocolValidationError } from './validation'

const signature = Uint8Array.from({ length: 64 }, (_, index) => index)

describe('access-control payload codecs', () => {
  it('round-trips membership actions and copies signature bytes', () => {
    for (const value of [
      {
        action: 'invite' as const,
        targetUserId: 'target',
        role: 'writer' as const,
        actorUserId: 'admin',
        timestamp: 7,
        signature
      },
      {
        action: 'remove' as const,
        targetUserId: 'target',
        role: null,
        actorUserId: 'admin',
        timestamp: 8,
        signature
      },
      {
        action: 'role_change' as const,
        targetUserId: 'target',
        role: 'reader' as const,
        actorUserId: 'admin',
        timestamp: 9,
        signature
      }
    ]) {
      const decoded = decodeMembershipPayload(encodeMembershipPayload(value))
      expect(decoded).toEqual(value)
      expect(decoded.signature).not.toBe(signature)
    }
  })

  it('round-trips archive and delete payloads', () => {
    const archive = { action: 'unarchive' as const, actorUserId: 'admin', timestamp: 11, signature }
    const deleted = { action: 'delete' as const, actorUserId: 'admin', timestamp: 12, signature }
    expect(decodeArchivePayload(encodeArchivePayload(archive))).toEqual(archive)
    expect(decodeDeletePayload(encodeDeletePayload(deleted))).toEqual(deleted)
  })

  it('rejects invalid role/action combinations and malformed signatures', () => {
    expect(() =>
      encodeMembershipPayload({
        action: 'remove',
        targetUserId: 'target',
        role: 'writer',
        actorUserId: 'admin',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
    expect(() =>
      encodeArchivePayload({
        action: 'archive',
        actorUserId: 'admin',
        timestamp: 1,
        signature: new Uint8Array(63)
      })
    ).toThrow(ProtocolValidationError)
  })

  it('uses deterministic signature preimages without embedding the signature', () => {
    const value = {
      action: 'invite' as const,
      targetUserId: 'target',
      role: 'admin' as const,
      actorUserId: 'actor',
      timestamp: 42
    }
    expect([...membershipPayloadSigningBytes(value)]).toEqual([
      ...membershipPayloadSigningBytes(value)
    ])
    expect(membershipPayloadSigningBytes(value)).not.toEqual(
      encodeMembershipPayload({ ...value, signature })
    )
  })

  it('rejects trailing bytes', () => {
    const encoded = encodeDeletePayload({
      action: 'delete',
      actorUserId: 'admin',
      timestamp: 1,
      signature
    })
    const malformed = new Uint8Array(encoded.byteLength + 1)
    malformed.set(encoded)
    expect(() => decodeDeletePayload(malformed)).toThrow(ProtocolValidationError)
  })
})
