import { defineConfig, devices } from '@playwright/test'

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
      command: 'TOY_SIGNAL_CLI_PORT=18080 pnpm --filter @e2e-col/toy-signal-cli dev',
      url: 'http://127.0.0.1:18080/api/v1/check',
      reuseExistingServer: !process.env.CI
    },
    {
      command:
        'pnpm --filter @e2e-col/web build && pnpm --filter @e2e-col/web exec vite preview --host 127.0.0.1 --port 4174',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: !process.env.CI
    }
  ]
})
