import type { DocumentParticipant } from '@e2e-col/protocol'
import { MemoryCollaborativeStorage } from '@e2e-col/storage'
import { DeterministicTransportNetwork, type SimulatedTransport } from '@e2e-col/transport'
import { describe, expect, it } from 'vitest'
import { DocumentSession } from './session'
import type { ClientIdentityAdapter, DocumentSessionEvent, SessionPhase } from './types'

const documentId = '11111111-1111-4111-8111-111111111111'

function lifecycleIdentity(): ClientIdentityAdapter {
  const participants: readonly DocumentParticipant[] = [
    { participantId: 'alice', role: 'admin', active: true },
    { participantId: 'bob', role: 'writer', active: true }
  ]
  return {
    async signControl(bytes) {
      return new Uint8Array(64).fill(bytes.length & 0xff)
    },
    async verifyControl() {
      return true
    },
    async resolveParticipant(phoneNumber) {
      return { participantId: phoneNumber, displayName: phoneNumber }
    },
    async bootstrapAccess() {
      return participants
    }
  }
}

function createSession(): {
  readonly session: DocumentSession
  readonly transport: SimulatedTransport
} {
  const network = new DeterministicTransportNetwork()
  const transport = network.createTransport('alice')
  let now = 1_000
  let message = 0
  const session = new DocumentSession({
    documentId,
    senderId: 'alice',
    transport,
    storage: new MemoryCollaborativeStorage(),
    identity: lifecycleIdentity(),
    now: () => ++now,
    createMessageId: () => `22222222-2222-4222-8222-${String(++message).padStart(12, '0')}`,
    replayAttemptedOnReconnect: true,
    publishSnapshotOnRecoverySignal: false,
    onClosed: () => undefined
  })
  return { session, transport }
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function expectOrderedPhases(
  actual: readonly SessionPhase[],
  expected: readonly SessionPhase[]
): void {
  let cursor = 0
  for (const phase of actual) {
    if (phase === expected[cursor]) cursor += 1
    if (cursor === expected.length) return
  }
  throw new Error(
    `Missing ordered phase sequence ${expected.join(' -> ')} in ${actual.join(' -> ')}`
  )
}

describe('DocumentSession lifecycle', () => {
  it('transitions opening -> ready -> offline -> syncing -> ready across reconnect replay', async () => {
    const { session, transport } = createSession()
    const phases: SessionPhase[] = [session.getStatus().phase]
    const unsubscribe = session.subscribe((event: DocumentSessionEvent) => {
      if (event.type === 'status') phases.push(event.status.phase)
    })

    await session.open()
    expect(session.getStatus().phase).toBe('ready')

    session.setSyncMode('manual')
    await session.editText('queued while manual')
    expect(session.getStatus().pendingOutbound).toBe(1)

    await transport.disconnect()
    expect(session.getStatus().phase).toBe('offline')

    await transport.connect(documentId)
    await tick()
    await tick()

    expect(session.getStatus().phase).toBe('ready')
    expect(session.getStatus().pendingOutbound).toBe(0)
    expectOrderedPhases(phases, ['opening', 'ready', 'offline', 'syncing', 'ready'])

    unsubscribe()
    await session.close()
  })

  it('closes idempotently and rejects edits after close with transport-closed', async () => {
    const { session } = createSession()
    await session.open()
    await session.close()
    await expect(session.close()).resolves.toBeUndefined()
    await expect(session.editText('after close')).rejects.toMatchObject({
      code: 'transport-closed'
    })
  })

  it('rejects flush while offline with transport-unavailable', async () => {
    const { session, transport } = createSession()
    await session.open()
    session.setSyncMode('manual')
    await session.editText('pending update')
    await transport.disconnect()

    await expect(session.flush()).rejects.toMatchObject({ code: 'transport-unavailable' })
    expect(session.getStatus().phase).toBe('offline')
    await session.close()
  })
})
