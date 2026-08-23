import type { SessionStatus } from '@e2e-col/client'
import type { DocumentAccessState } from '@e2e-col/protocol'
import { describe, expect, it } from 'vitest'
import { syncPresentation } from './offline-status'

function status(overrides: Partial<SessionStatus> = {}): SessionStatus {
  return {
    phase: 'ready',
    transport: 'online',
    pendingOutbound: 0,
    recoveryRequired: false,
    ...overrides
  }
}

function access(authorizationStatus: 'active' | 'conflict'): DocumentAccessState {
  return {
    selfRole: 'admin',
    participants: [{ participantId: 'alice', role: 'admin', active: true }],
    archived: false,
    deleted: false,
    revision: 0,
    authorizationStatus
  }
}

describe('syncPresentation', () => {
  it('keeps the initialized opening phase distinct from ready state', () => {
    expect(
      syncPresentation(status({ phase: 'opening', transport: 'disconnected' }), access('active'))
    ).toMatchObject({ tone: 'opening', label: 'Opening local document' })
  })

  it('makes offline local durability and queue depth explicit', () => {
    expect(
      syncPresentation(
        status({ phase: 'offline', transport: 'offline', pendingOutbound: 3 }),
        access('active')
      )
    ).toEqual({
      tone: 'offline',
      label: 'Offline · 3 queued locally',
      detail: 'Editing stays local and durable. Queued work replays after a connection is restored.'
    })
  })

  it('shows reconnect replay progress without claiming remote acknowledgement', () => {
    const presentation = syncPresentation(
      status({ phase: 'syncing', replay: { completed: 2, total: 5, active: true } }),
      access('active')
    )
    expect(presentation.label).toBe('Replaying 2/5')
    expect(presentation.detail).toContain('not remote acknowledgement')
  })

  it('lets a newer queued edit supersede stale replay-complete presentation', () => {
    expect(
      syncPresentation(
        status({
          phase: 'ready',
          pendingOutbound: 1,
          replay: { completed: 2, total: 2, active: false }
        }),
        access('active')
      )
    ).toMatchObject({ tone: 'ready', label: '1 queued locally' })
  })

  it('keeps snapshot recovery distinct from ordinary replay', () => {
    expect(
      syncPresentation(status({ phase: 'recovering', recoveryRequired: true }), access('active'))
    ).toMatchObject({ tone: 'recovering', label: 'Recovering from transport history risk' })
  })

  it('surfaces the durable R6 authorization fork as the conflict indicator', () => {
    expect(syncPresentation(status(), access('conflict'))).toEqual({
      tone: 'conflict',
      label: 'Authorization conflict',
      detail: 'Collaboration is frozen until the signed authorization fork is resolved.'
    })
  })
})
