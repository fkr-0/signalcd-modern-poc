import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { IdentityRegistrationRequest } from './identity-registry'
import { ToySignalCliServer } from './server'

const running: ToySignalCliServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe('mock identity HTTP API', () => {
  it('registers browser-owned keys, authenticates sessions, consumes and replenishes prekeys', async () => {
    const server = new ToySignalCliServer({ port: 0, now: () => 1_700_000_000_000 })
    running.push(server)
    const { baseUrl } = await server.start()
    const registration = await createRegistration('Ada')

    const registeredResponse = await fetch(`${baseUrl}/api/v1/identity/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration)
    })
    expect(registeredResponse.status).toBe(201)
    const registered = asRecord(await registeredResponse.json())
    expect(registered.display_name).toBe('Ada')
    expect(registered.phone_number).toMatch(/^\+1555000\d{4}$/)
    expect(registered.session_token).toEqual(expect.any(String))
    expect(registered).not.toHaveProperty('identity_key_private')
    const token = String(registered.session_token)
    const phone = String(registered.phone_number)

    const sessionResponse = await fetch(`${baseUrl}/api/v1/identity/session`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(sessionResponse.status).toBe(200)
    expect(asRecord(await sessionResponse.json()).user_id).toBe(registered.user_id)

    const first = asRecord(await jsonFetch(`${baseUrl}/api/v1/identity/keys/${phone}`, token))
    expect(first.one_time_prekey).toBe(registration.one_time_prekeys[0])
    expect(first.remaining_prekeys).toBe(1)

    const second = asRecord(await jsonFetch(`${baseUrl}/api/v1/identity/keys/${phone}`, token))
    expect(second.one_time_prekey).toBe(registration.one_time_prekeys[1])
    expect(second.remaining_prekeys).toBe(0)

    const third = asRecord(await jsonFetch(`${baseUrl}/api/v1/identity/keys/${phone}`, token))
    expect(third.one_time_prekey).toBeNull()

    const extraPrekey = await x25519Public()
    const replenishResponse = await fetch(`${baseUrl}/api/v1/identity/keys/replenish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ one_time_prekeys: [extraPrekey] })
    })
    expect(replenishResponse.status).toBe(200)
    expect(asRecord(await replenishResponse.json()).prekey_count).toBe(1)
  })

  it('rejects invalid sessions and non-loopback browser origins without leaking token state', async () => {
    const server = new ToySignalCliServer({ port: 0 })
    running.push(server)
    const { baseUrl } = await server.start()

    expect((await fetch(`${baseUrl}/api/v1/identity/session`)).status).toBe(401)
    expect(
      (
        await fetch(`${baseUrl}/api/v1/identity/register`, {
          method: 'OPTIONS',
          headers: { origin: 'https://example.com' }
        })
      ).status
    ).toBe(403)
    const state = asRecord(await (await fetch(`${baseUrl}/__toy__/v1/state`)).json())
    expect(JSON.stringify(state)).not.toContain('session_token')
  })

  it('invalidates identity sessions on toy reset', async () => {
    const server = new ToySignalCliServer({ port: 0 })
    running.push(server)
    const { baseUrl } = await server.start()
    const registration = await createRegistration('Grace')
    const registered = asRecord(
      await (
        await fetch(`${baseUrl}/api/v1/identity/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(registration)
        })
      ).json()
    )
    const token = String(registered.session_token)

    await fetch(`${baseUrl}/__toy__/v1/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    const sessionResponse = await fetch(`${baseUrl}/api/v1/identity/session`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(sessionResponse.status).toBe(401)
  })
})

async function createRegistration(displayName: string): Promise<IdentityRegistrationRequest> {
  const identity = asNodeKeyPair(
    await webcrypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  )
  const signedPrekey = asNodeKeyPair(
    await webcrypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  )
  const signedPrekeyPublic = new Uint8Array(
    await webcrypto.subtle.exportKey('raw', signedPrekey.publicKey)
  )
  const signature = new Uint8Array(
    await webcrypto.subtle.sign({ name: 'Ed25519' }, identity.privateKey, signedPrekeyPublic)
  )
  return {
    display_name: displayName,
    identity_key_public: base64(
      new Uint8Array(await webcrypto.subtle.exportKey('raw', identity.publicKey))
    ),
    signed_prekey_public: base64(signedPrekeyPublic),
    signed_prekey_signature: base64(signature),
    one_time_prekeys: [await x25519Public(), await x25519Public()]
  }
}

async function x25519Public(): Promise<string> {
  const pair = asNodeKeyPair(
    await webcrypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])
  )
  return base64(new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey)))
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

type NodeCryptoKey = Parameters<typeof webcrypto.subtle.exportKey>[1]

function asNodeKeyPair(value: unknown): { publicKey: NodeCryptoKey; privateKey: NodeCryptoKey } {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('publicKey' in value) ||
    !('privateKey' in value)
  )
    throw new Error('expected WebCrypto keypair')
  return value as { publicKey: NodeCryptoKey; privateKey: NodeCryptoKey }
}

async function jsonFetch(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
  expect(response.status).toBe(200)
  return response.json()
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('expected object')
  return value as Record<string, unknown>
}
