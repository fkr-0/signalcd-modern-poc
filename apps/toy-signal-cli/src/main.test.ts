import { afterEach, describe, expect, it } from 'vitest'
import { DEBUG_DECRYPT_WARNING, startToySignalCli } from './main'
import type { ToySignalCliServer } from './server'

const running: ToySignalCliServer[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.stop()))
})

describe('toy signal-cli startup diagnostics', () => {
  it('writes the production-safety warning to stderr when debug decrypt is enabled', async () => {
    let stdout = ''
    let stderr = ''
    const server = await startToySignalCli(
      { ...process.env, TOY_SIGNAL_CLI_PORT: '0', E2E_COL_DEBUG_DECRYPT: 'true' },
      {
        stdout: { write: (chunk) => (stdout += chunk) },
        stderr: { write: (chunk) => (stderr += chunk) }
      }
    )
    running.push(server)

    expect(server.debugDecrypt).toBe(true)
    expect(stderr).toBe(`${DEBUG_DECRYPT_WARNING}\n`)
    expect(stdout).toContain('toy signal-cli listening on http://127.0.0.1:')
  })

  it('does not write a debug warning when debug decrypt is disabled', async () => {
    let stderr = ''
    const server = await startToySignalCli(
      { ...process.env, TOY_SIGNAL_CLI_PORT: '0', E2E_COL_DEBUG_DECRYPT: 'false' },
      {
        stdout: { write: () => undefined },
        stderr: { write: (chunk) => (stderr += chunk) }
      }
    )
    running.push(server)

    expect(server.debugDecrypt).toBe(false)
    expect(stderr).toBe('')
  })
})
