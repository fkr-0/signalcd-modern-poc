import { defineConfig, devices } from '@playwright/test'

const toyPort = process.env.E2E_COL_TEST_TOY_PORT ?? '18080'
if (!/^\d{1,5}$/.test(toyPort) || Number(toyPort) < 1 || Number(toyPort) > 65535)
  throw new Error('E2E_COL_TEST_TOY_PORT must be a TCP port between 1 and 65535')
const toyBaseUrl = `http://127.0.0.1:${toyPort}`
const toyWebSocketUrl = `ws://127.0.0.1:${toyPort}/api/v1/messages`

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  // The toy Signal fault injector is process-global. Serial browser workers keep
  // fault schedules deterministic while each test still uses isolated contexts.
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
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
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] }
    }
  ],
  webServer: [
    {
      command: `TOY_SIGNAL_CLI_PORT=${toyPort} pnpm --filter @e2e-col/toy-signal-cli dev`,
      url: `${toyBaseUrl}/api/v1/check`,
      reuseExistingServer: !process.env.CI
    },
    {
      command: `VITE_E2E_COL_IDENTITY_URL=${toyBaseUrl} VITE_E2E_COL_MOCK_SIGNAL_URL=${toyWebSocketUrl} pnpm --filter @e2e-col/web build && pnpm --filter @e2e-col/web exec vite preview --host 127.0.0.1 --port 4174`,
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI
    }
  ]
})
