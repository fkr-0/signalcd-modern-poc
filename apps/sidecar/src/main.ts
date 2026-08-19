import { SidecarBridge } from './bridge'
import { SignalCliHttpBackend } from './signal-cli'

const documentGroups = JSON.parse(process.env.E2E_COL_DOCUMENT_GROUPS ?? '{}') as Record<
  string,
  string
>
if (Object.keys(documentGroups).length === 0) {
  throw new Error('E2E_COL_DOCUMENT_GROUPS must map document UUIDs to Signal group IDs')
}

const bridge = new SidecarBridge({
  backend: new SignalCliHttpBackend({
    ...(process.env.SIGNAL_CLI_HTTP_URL ? { baseUrl: process.env.SIGNAL_CLI_HTTP_URL } : {}),
    ...(process.env.SIGNAL_CLI_ACCOUNT ? { account: process.env.SIGNAL_CLI_ACCOUNT } : {})
  }),
  documentGroups,
  host: process.env.E2E_COL_SIDECAR_HOST ?? '127.0.0.1',
  port: Number(process.env.E2E_COL_SIDECAR_PORT ?? 43127)
})

const address = await bridge.start()
console.log(`e2e-col sidecar listening on ws://${address.host}:${address.port}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void bridge.stop().finally(() => process.exit(0)))
}
