import type { CollaborativeDocument, DocumentChange } from '@e2e-col/core'

export { CollaborativeScenario } from './scenario'
export type { CollaborativeScenarioOptions, ScenarioPeer } from './scenario'
export { NETWORK_PROFILES, networkProfileOptions } from './network-profiles'
export type { NetworkProfile, NetworkProfileName } from './network-profiles'

export interface DeliveryBatch {
  target: CollaborativeDocument
  changes: readonly DocumentChange[]
}

export function deliverBatches(batches: readonly DeliveryBatch[]): void {
  for (const { target, changes } of batches) target.applyChanges(changes)
}

export function duplicateChanges(changes: readonly DocumentChange[]): DocumentChange[] {
  return changes.flatMap((change) => [change, change])
}
