export interface BroadcastMessage {
  readonly groupId: string
  readonly message: string
  readonly account?: string
}

export interface BroadcastBackend {
  start(listener: (message: BroadcastMessage) => void): Promise<void>
  send(groupId: string, message: string): Promise<void>
  stop(): Promise<void>
}

/**
 * Reserved for a backend that can prove transport history became unrecoverable
 * by ordinary durable outbound replay. Generic send/HTTP errors are ambiguous
 * and MUST NOT be upgraded to this error.
 */
export class BroadcastRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BroadcastRecoveryRequiredError'
  }
}

export class MemoryBroadcastBackend implements BroadcastBackend {
  readonly sent: BroadcastMessage[] = []
  private listener: ((message: BroadcastMessage) => void) | undefined

  async start(listener: (message: BroadcastMessage) => void): Promise<void> {
    this.listener = listener
  }

  async send(groupId: string, message: string): Promise<void> {
    this.sent.push({ groupId, message })
  }

  receive(message: BroadcastMessage): void {
    this.listener?.(message)
  }

  async stop(): Promise<void> {
    this.listener = undefined
  }
}
