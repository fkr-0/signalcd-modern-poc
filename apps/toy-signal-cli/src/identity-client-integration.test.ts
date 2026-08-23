import { afterEach, describe, expect, it } from 'vitest'
import { IdentityClient } from '../../../packages/identity/src/client'
import { exportRawKey } from '../../../packages/identity/src/encoding'
import { HttpIdentityProvider } from '../../../packages/identity/src/provider'
import { MemoryIdentityStorage } from '../../../packages/identity/src/storage'
import { SIGNED_PREKEY_ROTATION_INTERVAL_MS } from './identity-registry'
import { ToySignalCliServer } from './server'

const running: ToySignalCliServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe('IdentityClient + toy identity lifecycle', () => {
  it('rotates the signed prekey and replenishes a depleted one-time pool on session open', async () => {
    let now = 1_700_000_000_000
    const server = new ToySignalCliServer({ port: 0, now: () => now })
    running.push(server)
    const { baseUrl } = await server.start()
    const provider = new HttpIdentityProvider({ baseUrl })
    const client = new IdentityClient({
      provider,
      storage: new MemoryIdentityStorage(),
      now: () => now
    })
    const identity = await client.register('Lifecycle user')
    const identityKey = await exportRawKey(identity.identityKeyPair.publicKey)
    const signedPrekey = await exportRawKey(identity.signedPrekeyPair.publicKey)

    for (let index = 0; index < 8; index += 1)
      await provider.lookupKeys(identity.phoneNumber, identity.sessionToken)
    expect((await provider.verifySession(identity.sessionToken)).prekeyCount).toBe(2)

    now += SIGNED_PREKEY_ROTATION_INTERVAL_MS
    const reopened = await client.openSession()
    const session = await provider.verifySession(identity.sessionToken)

    expect(await exportRawKey(reopened!.identityKeyPair.publicKey)).toBe(identityKey)
    expect(await exportRawKey(reopened!.signedPrekeyPair.publicKey)).not.toBe(signedPrekey)
    expect(await exportRawKey(reopened!.retiredSignedPrekeys[0]!.publicKey)).toBe(signedPrekey)
    expect(reopened?.pendingSignedPrekey).toBeUndefined()
    expect(session.signedPrekeyRotationRequired).toBe(false)
    expect(session.signedPrekeyPublic).toBe(
      await exportRawKey(reopened!.signedPrekeyPair.publicKey)
    )
    expect(session.prekeyCount).toBe(10)
  })
})
