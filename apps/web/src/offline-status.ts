import type { SessionStatus } from '@e2e-col/client'
import type { DocumentAccessState } from '@e2e-col/protocol'

export type SyncPresentationTone =
  | 'opening'
  | 'ready'
  | 'offline'
  | 'syncing'
  | 'recovering'
  | 'error'
  | 'conflict'

export interface SyncPresentation {
  readonly tone: SyncPresentationTone
  readonly label: string
  readonly detail: string
}

export function syncPresentation(
  status: SessionStatus | undefined,
  access: DocumentAccessState | undefined
): SyncPresentation {
  if (access?.authorizationStatus === 'conflict') {
    return {
      tone: 'conflict',
      label: 'Authorization conflict',
      detail: 'Collaboration is frozen until the signed authorization fork is resolved.'
    }
  }

  if (!status) {
    return {
      tone: 'opening',
      label: 'Opening local document',
      detail: 'Loading the durable local replica before collaboration starts.'
    }
  }

  if (status.phase === 'opening') {
    return {
      tone: 'opening',
      label: 'Opening local document',
      detail: 'Loading the durable local replica before collaboration starts.'
    }
  }

  if (status.phase === 'offline' || status.transport === 'offline') {
    return {
      tone: 'offline',
      label: `Offline · ${status.pendingOutbound} queued locally`,
      detail: 'Editing stays local and durable. Queued work replays after a connection is restored.'
    }
  }

  if (status.phase === 'recovering' || status.recoveryRequired) {
    return {
      tone: 'recovering',
      label: 'Recovering from transport history risk',
      detail: 'A durable snapshot/checkpoint is repairing provable loss before normal sync resumes.'
    }
  }

  if (status.replay?.active) {
    return {
      tone: 'syncing',
      label: `Replaying ${status.replay.completed}/${status.replay.total}`,
      detail:
        'Progress counts durable records handed to the local transport, not remote acknowledgement.'
    }
  }

  if (status.phase === 'error') {
    return {
      tone: 'error',
      label: status.error?.recoverable ? 'Sync needs attention' : 'Local collaboration error',
      detail: status.error?.message ?? 'The document session reported an error.'
    }
  }

  if (status.phase === 'syncing') {
    return {
      tone: 'syncing',
      label: `Syncing · ${status.pendingOutbound} queued locally`,
      detail: 'Durable outbound work is being handed to the current transport.'
    }
  }

  if (status.pendingOutbound > 0) {
    return {
      tone: 'ready',
      label: `${status.pendingOutbound} queued locally`,
      detail: 'Pending work is safely stored on this device until the selected sync mode sends it.'
    }
  }

  if (status.replay && status.replay.total > 0) {
    return {
      tone: 'ready',
      label: `Replay complete ${status.replay.completed}/${status.replay.total}`,
      detail: 'The replay batch reached the local transport; remote merge is not implied.'
    }
  }

  return {
    tone: 'ready',
    label: 'Local state durable',
    detail: 'Local edits are persisted independently of network availability.'
  }
}
