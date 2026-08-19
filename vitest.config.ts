import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['tests/e2e/**', 'upstream/**'],
    testTimeout: 10_000,
    coverage: {
      reporter: ['text', 'html']
    }
  }
})
