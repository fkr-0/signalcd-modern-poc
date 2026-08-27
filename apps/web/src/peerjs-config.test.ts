import { describe, expect, it } from 'vitest'
import { peerJsSecretFromFragment, peerJsTransportOptions } from './peerjs-config'

const secret = '0123456789abcdef0123456789abcdef'

describe('peerJsTransportOptions', () => {
  it('uses PeerJS client defaults for the cloud/demo service when only the secret is set', () => {
    expect(peerJsTransportOptions({ VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET: secret })).toEqual({
      rendezvousSecret: secret,
      namespace: 'e2e-col-web'
    })
  })

  it('prefers the URL fragment capability over a build-time fallback', () => {
    const fragmentSecret = 'fragment-secret-0123456789abcdef'
    expect(
      peerJsTransportOptions(
        { VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET: secret },
        `#peerjs=${encodeURIComponent(fragmentSecret)}`
      ).rendezvousSecret
    ).toBe(fragmentSecret)
    expect(peerJsSecretFromFragment('#other=x&peerjs=a%2Bb%3Dc')).toBe('a+b=c')
  })

  it('parses an explicit self-hosted PeerServer endpoint', () => {
    expect(
      peerJsTransportOptions({
        VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET: secret,
        VITE_E2E_COL_PEERJS_HOST: 'peer.example.test',
        VITE_E2E_COL_PEERJS_PORT: '443',
        VITE_E2E_COL_PEERJS_PATH: '/peerjs',
        VITE_E2E_COL_PEERJS_KEY: 'peerjs',
        VITE_E2E_COL_PEERJS_SECURE: 'true'
      })
    ).toEqual({
      rendezvousSecret: secret,
      namespace: 'e2e-col-web',
      peerOptions: {
        host: 'peer.example.test',
        port: 443,
        path: '/peerjs',
        key: 'peerjs',
        secure: true
      }
    })
  })

  it('fails closed for missing/weak secrets and partial or malformed server config', () => {
    expect(() => peerJsTransportOptions({})).toThrow('rendezvous capability is required')
    expect(() =>
      peerJsTransportOptions({ VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET: 'short' })
    ).toThrow('at least 16 bytes')
    expect(() =>
      peerJsTransportOptions({
        VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET: secret,
        VITE_E2E_COL_PEERJS_PORT: '9000'
      })
    ).toThrow('HOST is required')
    expect(() =>
      peerJsTransportOptions({
        VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET: secret,
        VITE_E2E_COL_PEERJS_HOST: 'localhost',
        VITE_E2E_COL_PEERJS_PORT: '0'
      })
    ).toThrow('between 1 and 65535')
    expect(() =>
      peerJsTransportOptions({
        VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET: secret,
        VITE_E2E_COL_PEERJS_HOST: 'localhost',
        VITE_E2E_COL_PEERJS_SECURE: 'yes'
      })
    ).toThrow('exactly true or false')
  })
})
