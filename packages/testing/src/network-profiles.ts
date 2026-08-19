import type { DeterministicNetworkOptions } from '@e2e-col/transport'

/**
 * Deterministic projections of upstream/netprofile.sh.
 *
 * The research harness targets 5 ms / 60 Mbps for "fast" and 30 ms / 5 Mbps
 * for "slow". DeterministicTransportNetwork currently models latency and
 * delivery faults, not throughput, so targetRateMbps is retained as benchmark
 * metadata instead of being silently approximated.
 */
export const NETWORK_PROFILES = {
  off: {
    latencyMs: 0,
    targetRateMbps: undefined
  },
  fast: {
    latencyMs: 5,
    targetRateMbps: 60
  },
  slow: {
    latencyMs: 30,
    targetRateMbps: 5
  }
} as const

export type NetworkProfileName = keyof typeof NETWORK_PROFILES
export type NetworkProfile = (typeof NETWORK_PROFILES)[NetworkProfileName]

export function networkProfileOptions(name: NetworkProfileName): DeterministicNetworkOptions {
  return { latencyMs: NETWORK_PROFILES[name].latencyMs }
}
