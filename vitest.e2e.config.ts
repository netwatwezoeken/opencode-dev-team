import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.e2e.ts'],
    globalSetup: ['src/test/wiremock.global.ts'],
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
});
