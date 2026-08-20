import { pathToFileURL } from 'node:url'
import { DEFAULT_TOY_ACCOUNT_A, DEFAULT_TOY_ACCOUNT_B, DEFAULT_TOY_GROUP_ID } from './contract'
import { ToySignalCliServer } from './server'

export const DEBUG_DECRYPT_WARNING = '⚠ DEBUG DECRYPT MODE ACTIVE — do not use in production'

interface OutputSink {
  write(chunk: string): unknown
}

export async function startToySignalCli(
  env: NodeJS.ProcessEnv = process.env,
  output: { readonly stdout: OutputSink; readonly stderr: OutputSink } = {
    stdout: process.stdout,
    stderr: process.stderr
  }
): Promise<ToySignalCliServer> {
  const port = Number(env.TOY_SIGNAL_CLI_PORT ?? 18080)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('TOY_SIGNAL_CLI_PORT must be a valid TCP port')
  const debugDecrypt = env.E2E_COL_DEBUG_DECRYPT === 'true'

  const server = new ToySignalCliServer({
    host: env.TOY_SIGNAL_CLI_HOST ?? '127.0.0.1',
    port,
    debugDecrypt,
    ...(env.TOY_SIGNAL_CLI_FIXED_ACCOUNT ? { fixedAccount: env.TOY_SIGNAL_CLI_FIXED_ACCOUNT } : {})
  })

  const address = await server.start()
  output.stdout.write(`toy signal-cli listening on ${address.baseUrl}\n`)
  if (debugDecrypt) output.stderr.write(`${DEBUG_DECRYPT_WARNING}\n`)
  output.stdout.write(`demo accounts: ${DEFAULT_TOY_ACCOUNT_A}, ${DEFAULT_TOY_ACCOUNT_B}\n`)
  output.stdout.write(`demo group: ${DEFAULT_TOY_GROUP_ID}\n`)
  output.stdout.write('contract: /__toy__/v1/contract\n')
  output.stdout.write('mock identity: /api/v1/identity/register, /session, /keys/:phone_number\n')
  output.stdout.write(
    'test controls: /__toy__/v1/state, /reset, /faults, /inject, /config, /sync-log\n'
  )
  return server
}

if (isMainModule()) {
  const server = await startToySignalCli()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void server.stop().finally(() => process.exit(0)))
  }
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1]
  return entrypoint !== undefined && pathToFileURL(entrypoint).href === import.meta.url
}
