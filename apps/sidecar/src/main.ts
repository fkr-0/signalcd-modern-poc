import { SidecarBridge } from './bridge'
import { readSidecarRuntimeConfig } from './config'
import { SignalCliHttpBackend } from './signal-cli'

const config = readSidecarRuntimeConfig(process.env)
const backend = new SignalCliHttpBackend({
  baseUrl: config.signalCliHttpUrl,
  ...(config.signalCliAccount === undefined ? {} : { account: config.signalCliAccount }),
  requiredGroupIds: Object.values(config.documentGroups)
})

const bridge = new SidecarBridge({
  backend,
  documentGroups: config.documentGroups,
  host: config.sidecarHost,
  port: config.sidecarPort,
  signalBodyMaxBytes: config.signalBodyMaxBytes,
  ...(config.allowedOrigins === undefined ? {} : { allowedOrigins: config.allowedOrigins })
})

const address = await bridge.start()
console.log(`e2e-col sidecar listening on ws://${address.host}:${address.port}`)
console.log(
  `signal-cli compatibility check passed (${backend.detectedVersion() ?? 'daemon version API unavailable'})`
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void bridge.stop().finally(() => process.exit(0)))
}
