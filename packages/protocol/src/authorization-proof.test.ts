import { describe, expect, it } from 'vitest'
import {
  authorizationRootCommitment,
  authorizationRootSigningBytes,
  decodeAuthorizationRootPayload,
  decodeForkResolutionPayload,
  encodeAuthorizationRootPayload,
  encodeForkResolutionPayload,
  forkResolutionCommitment,
  forkResolutionSigningBytes
} from './authorization-proof'

const documentId = '11111111-1111-4111-8111-111111111111'
const signature = Uint8Array.from({ length: 64 }, (_, index) => index)
const commitment = (byte: number) => Uint8Array.from({ length: 32 }, () => byte)

function root() {
  return {
    documentId,
    creatorUserId: 'alice',
    participants: [
      {
        participantId: 'alice',
        role: 'admin' as const,
        active: true,
        identityKeyCommitment: commitment(1)
      }
    ],
    signature
  }
}

function resolution() {
  return {
    documentId,
    commonPredecessor: commitment(1),
    forkRevision: 4,
    competingControlIds: [commitment(2), commitment(3)],
    chosenControlId: commitment(2),
    resolutionRevision: 5,
    resultingStateCommitment: commitment(4),
    approvals: [
      { actorUserId: 'alice', signature },
      { actorUserId: 'bob', signature: new Uint8Array(signature).reverse() }
    ]
  }
}

describe('authorization root proof', () => {
  it('round-trips a canonical signed root and copies binary fields', () => {
    const value = root()
    const decoded = decodeAuthorizationRootPayload(encodeAuthorizationRootPayload(value))
    expect(decoded).toEqual(value)
    expect(decoded.signature).not.toBe(value.signature)
    expect(decoded.participants[0]!.identityKeyCommitment).not.toBe(
      value.participants[0]!.identityKeyCommitment
    )
  })

  it('canonicalizes participant order into identical root signing bytes and commitments', async () => {
    const participants = [
      {
        participantId: 'bob',
        role: 'writer' as const,
        active: true,
        identityKeyCommitment: commitment(2)
      },
      ...root().participants
    ]
    const first = { documentId, creatorUserId: 'alice', participants }
    const second = { ...first, participants: [...participants].reverse() }
    expect(authorizationRootSigningBytes(first)).toEqual(authorizationRootSigningBytes(second))
    expect(await authorizationRootCommitment(first)).toEqual(
      await authorizationRootCommitment(second)
    )
  })

  it('rejects duplicate participants and roots whose creator is not an active admin', () => {
    const value = root()
    expect(() =>
      encodeAuthorizationRootPayload({
        ...value,
        participants: [...value.participants, ...value.participants]
      })
    ).toThrow(/duplicate participant/)
    expect(() =>
      encodeAuthorizationRootPayload({
        ...value,
        participants: [{ ...value.participants[0]!, role: 'writer' }]
      })
    ).toThrow(/active admin/)
  })

  it('rejects malformed identity commitments and signatures', () => {
    const value = root()
    expect(() =>
      encodeAuthorizationRootPayload({
        ...value,
        participants: [{ ...value.participants[0]!, identityKeyCommitment: new Uint8Array(31) }]
      })
    ).toThrow(/32-byte/)
    expect(() =>
      encodeAuthorizationRootPayload({ ...value, signature: new Uint8Array(63) })
    ).toThrow(/64-byte/)
  })
})

describe('fork resolution proof', () => {
  it('round-trips canonical competing commitments and independent approvals', () => {
    const value = resolution()
    const decoded = decodeForkResolutionPayload(encodeForkResolutionPayload(value))
    expect(decoded).toEqual(value)
    expect(decoded.approvals[0]!.signature).not.toBe(value.approvals[0]!.signature)
  })

  it('canonicalizes proposal commitment independently of competing-control input order', async () => {
    const value = resolution()
    const unsigned = { ...value, approvals: undefined }
    const proposal = {
      documentId: unsigned.documentId,
      commonPredecessor: unsigned.commonPredecessor,
      forkRevision: unsigned.forkRevision,
      competingControlIds: unsigned.competingControlIds,
      chosenControlId: unsigned.chosenControlId,
      resolutionRevision: unsigned.resolutionRevision,
      resultingStateCommitment: unsigned.resultingStateCommitment
    }
    const reversed = {
      ...proposal,
      competingControlIds: [...proposal.competingControlIds].reverse()
    }
    expect(forkResolutionSigningBytes(proposal)).toEqual(forkResolutionSigningBytes(reversed))
    expect(await forkResolutionCommitment(proposal)).toEqual(
      await forkResolutionCommitment(reversed)
    )
  })

  it('rejects incomplete forks, a non-competing choice, and non-causal resolution revisions', () => {
    const value = resolution()
    expect(() =>
      encodeForkResolutionPayload({ ...value, competingControlIds: [commitment(2)] })
    ).toThrow(/at least two/)
    expect(() => encodeForkResolutionPayload({ ...value, chosenControlId: commitment(9) })).toThrow(
      /one competing control/
    )
    expect(() => encodeForkResolutionPayload({ ...value, resolutionRevision: 6 })).toThrow(
      /forkRevision \+ 1/
    )
  })

  it('rejects duplicate approval actors and raw non-canonical approval order', () => {
    const value = resolution()
    expect(() =>
      encodeForkResolutionPayload({
        ...value,
        approvals: [value.approvals[0]!, value.approvals[0]!]
      })
    ).toThrow(/duplicate actors/)

    const encoded = encodeForkResolutionPayload(value)
    const decoded = decodeForkResolutionPayload(encoded)
    expect(decoded.approvals.map((approval) => approval.actorUserId)).toEqual(['alice', 'bob'])
  })
})
