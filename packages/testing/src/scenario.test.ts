import { describe, expect, it } from 'vitest'
import { NETWORK_PROFILES, networkProfileOptions } from './network-profiles'
import { CollaborativeScenario } from './scenario'

describe('CollaborativeScenario', () => {
  it.each(['off', 'fast', 'slow'] as const)(
    'converges concurrent edits under the upstream %s latency profile',
    async (profile) => {
      const scenario = new CollaborativeScenario({ network: networkProfileOptions(profile) })
      scenario.addPeer('a')
      scenario.addPeer('b')
      await scenario.connect()

      await scenario.editText('a', 'alpha')
      await scenario.editText('b', 'beta')
      scenario.flush()

      expect(scenario.converged()).toBe(true)
      expect(scenario.network.now).toBe(NETWORK_PROFILES[profile].latencyMs)
    }
  )

  it('converges after deterministic duplicate and reorder faults', async () => {
    const scenario = new CollaborativeScenario({
      network: {
        faults: [
          { send: 1, hold: true, duplicate: 1 },
          { send: 2, hold: true }
        ]
      }
    })
    scenario.addPeer('a')
    scenario.addPeer('b')
    await scenario.connect()

    await scenario.editText('a', 'left')
    await scenario.editText('b', 'right')
    scenario.releaseHeld('lifo')

    expect(scenario.converged()).toBe(true)
    expect(scenario.metrics('a').duplicated + scenario.metrics('b').duplicated).toBe(1)
  })

  it('catches up edits made while the receiver is offline', async () => {
    const scenario = new CollaborativeScenario()
    scenario.addPeer('a')
    scenario.addPeer('b')
    await scenario.connect()
    await scenario.disconnect('b')

    await scenario.editText('a', 'offline delivery')
    expect(scenario.peer('b').document.getText()).toBe('')
    expect(scenario.metrics('b').pendingInbound).toBe(1)

    await scenario.reconnect('b')
    expect(scenario.peer('b').document.getText()).toBe('offline delivery')
    expect(scenario.converged()).toBe(true)
  })

  it('surfaces dropped frames as recovery requirements', async () => {
    const scenario = new CollaborativeScenario({ network: { faults: [{ send: 1, drop: true }] } })
    scenario.addPeer('a')
    scenario.addPeer('b')
    await scenario.connect()

    await scenario.editText('a', 'lost')

    expect(scenario.peer('b').recoveryEvents).toHaveLength(1)
    expect(scenario.peer('b').recoveryEvents[0]).toMatchObject({
      sourceId: 'a',
      targetId: 'b',
      reason: 'dropped-frame'
    })
    expect(scenario.converged()).toBe(false)
  })
})
