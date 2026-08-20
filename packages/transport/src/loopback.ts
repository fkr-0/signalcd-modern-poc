import {
  type DeterministicNetworkOptions,
  DeterministicTransportNetwork,
  type SimulatedTransport
} from './deterministic-network'

export interface LoopbackPair {
  readonly network: DeterministicTransportNetwork
  readonly left: SimulatedTransport
  readonly right: SimulatedTransport
}

/**
 * Convenience adapter for the common two-replica development/test case.
 * The underlying deterministic network remains available for virtual-time and
 * fault-control operations.
 */
export function createLoopbackPair(options: DeterministicNetworkOptions = {}): LoopbackPair {
  const network = new DeterministicTransportNetwork(options)
  return {
    network,
    left: network.createTransport('left'),
    right: network.createTransport('right')
  }
}
