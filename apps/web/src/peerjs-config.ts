import type { PeerJsTransportOptions } from '@e2e-col/transport'

export interface PeerJsWebEnvironment {
  readonly VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET?: string
  readonly VITE_E2E_COL_PEERJS_HOST?: string
  readonly VITE_E2E_COL_PEERJS_PORT?: string
  readonly VITE_E2E_COL_PEERJS_PATH?: string
  readonly VITE_E2E_COL_PEERJS_KEY?: string
  readonly VITE_E2E_COL_PEERJS_SECURE?: string
}

/**
 * Parse the explicit browser demo configuration for PeerJS.
 *
 * With only a rendezvous secret, peerjslib uses the normal PeerJS client
 * defaults (the public PeerJS signalling service). Supplying any self-hosted
 * option requires HOST so a partial deployment config fails closed.
 */
export function peerJsTransportOptions(
  env: PeerJsWebEnvironment,
  locationHash = ''
): PeerJsTransportOptions {
  const rendezvousSecret =
    peerJsSecretFromFragment(locationHash) ?? env.VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET
  if (!rendezvousSecret)
    throw new Error(
      'PeerJS rendezvous capability is required via #peerjs=... or VITE_E2E_COL_PEERJS_RENDEZVOUS_SECRET'
    )
  if (new TextEncoder().encode(rendezvousSecret).byteLength < 16)
    throw new Error('PeerJS rendezvous capability must contain at least 16 bytes')

  const host = optionalNonEmpty(env.VITE_E2E_COL_PEERJS_HOST)
  const portText = optionalNonEmpty(env.VITE_E2E_COL_PEERJS_PORT)
  const path = optionalNonEmpty(env.VITE_E2E_COL_PEERJS_PATH)
  const key = optionalNonEmpty(env.VITE_E2E_COL_PEERJS_KEY)
  const secureText = optionalNonEmpty(env.VITE_E2E_COL_PEERJS_SECURE)
  const hasSelfHostedOption =
    host !== undefined ||
    portText !== undefined ||
    path !== undefined ||
    key !== undefined ||
    secureText !== undefined

  if (hasSelfHostedOption && host === undefined)
    throw new Error('VITE_E2E_COL_PEERJS_HOST is required when PeerServer options are configured')

  const port = portText === undefined ? undefined : parsePort(portText)
  const secure = secureText === undefined ? undefined : parseBoolean(secureText)
  const peerOptions =
    host === undefined
      ? undefined
      : {
          host,
          ...(port === undefined ? {} : { port }),
          ...(path === undefined ? {} : { path }),
          ...(key === undefined ? {} : { key }),
          ...(secure === undefined ? {} : { secure })
        }

  return {
    rendezvousSecret,
    namespace: 'e2e-col-web',
    ...(peerOptions === undefined ? {} : { peerOptions })
  }
}

export function peerJsSecretFromFragment(locationHash: string): string | undefined {
  const raw = locationHash.startsWith('#') ? locationHash.slice(1) : locationHash
  if (!raw) return undefined
  const value = new URLSearchParams(raw).get('peerjs')
  return value === null || value === '' ? undefined : value
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/u.test(value))
    throw new Error('VITE_E2E_COL_PEERJS_PORT must be an integer between 1 and 65535')
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error('VITE_E2E_COL_PEERJS_PORT must be an integer between 1 and 65535')
  return port
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error('VITE_E2E_COL_PEERJS_SECURE must be exactly true or false')
}
