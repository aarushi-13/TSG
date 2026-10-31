import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'signaling/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./src/testSetup.ts'],
    fileParallelism: false,
    pool: 'threads',
    maxWorkers: 1,
    minWorkers: 1,
    experimental: { fsModuleCache: false },
    restoreMocks: true,
    clearMocks: true,
  },
})
