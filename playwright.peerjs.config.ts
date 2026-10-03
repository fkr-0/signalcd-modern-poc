import { defineConfig, devices } from '@playwright/test'

const toyPort = process.env.E2E_COL_TEST_PEERJS_TOY_PORT ?? '18081'
const peerPort = process.env.E2E_COL_TEST_PEERJS_PORT ?? '19001'
const webPort = process.env.E2E_COL_TEST_PEERJS_WEB_PORT ?? '4175'
for (const [name, value] of [
  ['E2E_COL_TEST_PEERJS_TOY_PORT', toyPort],
  ['E2E_COL_TEST_PEERJS_PORT', peerPort],
  ['E2E_COL_TEST_PEERJS_WEB_PORT', webPort]
] as const) {
  if (!/^\d{1,5}$/u.test(value) || Number(value) < 1 || Number(value) > 65_535)
    throw new Error(`${name} must be a TCP port between 1 and 65535`)
}

const toyBaseUrl = `http://127.0.0.1:${toyPort}`
const peerPath = '/e2e-col-peerjs'
const peerBaseUrl = `http://127.0.0.1:${peerPort}${peerPath}`
const webBaseUrl = `http://127.0.0.1:${webPort}`

export default defineConfig({
  testDir: './tests/e2e-peerjs',
  fullyParallel: false,
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: webBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] }
    }
  ],
  webServer: [
    {
      command: `TOY_SIGNAL_CLI_PORT=${toyPort} pnpm --filter @e2e-col/toy-signal-cli dev`,
      url: `${toyBaseUrl}/api/v1/check`,
      reuseExistingServer: !process.env.CI
    },
    {
      command: `pnpm exec peerjs --host 127.0.0.1 --port ${peerPort} --key peerjs --path ${peerPath}`,
      url: peerBaseUrl,
      reuseExistingServer: !process.env.CI
    },
    {
      command: `VITE_E2E_COL_IDENTITY_URL=${toyBaseUrl} VITE_E2E_COL_TRANSPORT=peerjs VITE_E2E_COL_PEERJS_HOST=127.0.0.1 VITE_E2E_COL_PEERJS_PORT=${peerPort} VITE_E2E_COL_PEERJS_PATH=${peerPath} VITE_E2E_COL_PEERJS_KEY=peerjs VITE_E2E_COL_PEERJS_SECURE=false pnpm --filter @e2e-col/web build && pnpm --filter @e2e-col/web exec vite preview --host 127.0.0.1 --port ${webPort}`,
      url: webBaseUrl,
      reuseExistingServer: !process.env.CI
    }
  ]
})
