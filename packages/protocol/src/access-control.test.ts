import { describe, expect, it } from 'vitest'
import {
  archivePayloadSigningBytes,
  decodeArchivePayload,
  decodeDeletePayload,
  decodeMembershipPayload,
  deletePayloadSigningBytes,
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

  it('rejects membership with unsupported action codes decoded from raw bytes', () => {
    const valid = encodeMembershipPayload({
      action: 'invite',
      targetUserId: 'target',
      role: 'writer',
      actorUserId: 'admin',
      timestamp: 1,
      signature
    })
    // Patch the action byte (byte index 1) to an invalid code 99
    const tampered = new Uint8Array(valid)
    tampered[1] = 99
    expect(() => decodeMembershipPayload(tampered)).toThrow(ProtocolValidationError)
  })

  it('rejects archive with unsupported action codes decoded from raw bytes', () => {
    const valid = encodeArchivePayload({
      action: 'archive',
      actorUserId: 'admin',
      timestamp: 1,
      signature
    })
    const tampered = new Uint8Array(valid)
    tampered[1] = 99
    expect(() => decodeArchivePayload(tampered)).toThrow(ProtocolValidationError)
  })

  it('rejects membership encode with invalid action string', () => {
    expect(() =>
      encodeMembershipPayload({
        action: 'bogus' as 'invite',
        targetUserId: 'target',
        role: 'writer',
        actorUserId: 'admin',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
  })

  it('rejects archive encode with invalid action string', () => {
    expect(() =>
      encodeArchivePayload({
        action: 'bogus' as 'archive',
        actorUserId: 'admin',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
  })

  it('signature round-trip: signing bytes are deterministically recoverable from payload fields', () => {
    const value = {
      action: 'invite' as const,
      targetUserId: 'target',
      role: 'admin' as const,
      actorUserId: 'actor',
      timestamp: 42
    }
    const signingBytesA = membershipPayloadSigningBytes(value)
    const signingBytesB = membershipPayloadSigningBytes(value)
    expect(signingBytesA).toEqual(signingBytesB)

    // Signing bytes must differ from the encoded payload (no signature embedded)
    const encoded = encodeMembershipPayload({ ...value, signature })
    expect(signingBytesA).not.toEqual(encoded)
  })

  it('archive signing bytes are deterministic and distinct from encoded payload', () => {
    const value = { action: 'archive' as const, actorUserId: 'admin', timestamp: 100 }
    const signingA = archivePayloadSigningBytes(value)
    const signingB = archivePayloadSigningBytes(value)
    expect(signingA).toEqual(signingB)

    const encoded = encodeArchivePayload({ ...value, signature })
    expect(signingA).not.toEqual(encoded)
  })

  it('delete signing bytes are deterministic and distinct from encoded payload', () => {
    const value = { action: 'delete' as const, actorUserId: 'admin', timestamp: 200 }
    const signingA = deletePayloadSigningBytes(value)
    const signingB = deletePayloadSigningBytes(value)
    expect(signingA).toEqual(signingB)

    const encoded = encodeDeletePayload({ ...value, signature })
    expect(signingA).not.toEqual(encoded)
  })

  it('rejects empty-string IDs in membership', () => {
    expect(() =>
      encodeMembershipPayload({
        action: 'invite',
        targetUserId: '',
        role: 'writer',
        actorUserId: 'admin',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
    expect(() =>
      encodeMembershipPayload({
        action: 'invite',
        targetUserId: 'target',
        role: 'writer',
        actorUserId: '',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
  })

  it('rejects empty-string IDs in archive', () => {
    expect(() =>
      encodeArchivePayload({
        action: 'archive',
        actorUserId: '',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
  })

  it('rejects empty-string IDs in delete', () => {
    expect(() =>
      encodeDeletePayload({
        action: 'delete',
        actorUserId: '',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
  })

  it('accepts IDs up to the max byte-length boundary', () => {
    // 512 ASCII chars = 512 UTF-8 bytes, which is the MAX_ID_BYTES limit
    const maxId = 'x'.repeat(512)
    expect(() =>
      encodeMembershipPayload({
        action: 'invite',
        targetUserId: maxId,
        role: 'writer',
        actorUserId: 'admin',
        timestamp: 1,
        signature
      })
    ).not.toThrow()
  })

  it('rejects IDs exceeding the max byte-length boundary', () => {
    const overMax = 'x'.repeat(513)
    expect(() =>
      encodeMembershipPayload({
        action: 'invite',
        targetUserId: overMax,
        role: 'writer',
        actorUserId: 'admin',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
  })

  it('rejects membership with remove action and non-null role', () => {
    expect(() =>
      encodeMembershipPayload({
        action: 'remove',
        targetUserId: 'target',
        role: 'admin',
        actorUserId: 'admin',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
  })

  it('rejects membership with invite action and null role', () => {
    expect(() =>
      encodeMembershipPayload({
        action: 'invite',
        targetUserId: 'target',
        role: null,
        actorUserId: 'admin',
        timestamp: 1,
        signature
      })
    ).toThrow(ProtocolValidationError)
  })

  it('round-trips membership with multi-byte UTF-8 IDs', () => {
    const value = {
      action: 'invite' as const,
      targetUserId: 'user-日本語-test',
      role: 'writer' as const,
      actorUserId: 'admin-🔐-id',
      timestamp: 999,
      signature
    }
    const decoded = decodeMembershipPayload(encodeMembershipPayload(value))
    expect(decoded).toEqual(value)
  })

  it('round-trips archive and delete with max-length actor IDs', () => {
    const maxId = 'a'.repeat(512)
    const archiveValue = {
      action: 'archive' as const,
      actorUserId: maxId,
      timestamp: 1,
      signature
    }
    expect(decodeArchivePayload(encodeArchivePayload(archiveValue))).toEqual(archiveValue)

    const deleteValue = {
      action: 'delete' as const,
      actorUserId: maxId,
      timestamp: 2,
      signature
    }
    expect(decodeDeletePayload(encodeDeletePayload(deleteValue))).toEqual(deleteValue)
  })
})
