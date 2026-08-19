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
