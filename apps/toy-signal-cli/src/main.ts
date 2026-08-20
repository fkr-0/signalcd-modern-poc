import { DEFAULT_TOY_ACCOUNT_A, DEFAULT_TOY_ACCOUNT_B, DEFAULT_TOY_GROUP_ID } from './contract'
import { ToySignalCliServer } from './server'

const port = Number(process.env.TOY_SIGNAL_CLI_PORT ?? 18080)
if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
  throw new Error('TOY_SIGNAL_CLI_PORT must be a valid TCP port')

const server = new ToySignalCliServer({
  host: process.env.TOY_SIGNAL_CLI_HOST ?? '127.0.0.1',
  port,
  ...(process.env.TOY_SIGNAL_CLI_FIXED_ACCOUNT
    ? { fixedAccount: process.env.TOY_SIGNAL_CLI_FIXED_ACCOUNT }
    : {})
})

const address = await server.start()
console.log(`toy signal-cli listening on ${address.baseUrl}`)
console.log(`demo accounts: ${DEFAULT_TOY_ACCOUNT_A}, ${DEFAULT_TOY_ACCOUNT_B}`)
console.log(`demo group: ${DEFAULT_TOY_GROUP_ID}`)
console.log('contract: /__toy__/v1/contract')
console.log('test controls: /__toy__/v1/state, /reset, /faults, /inject')

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void server.stop().finally(() => process.exit(0)))
}
