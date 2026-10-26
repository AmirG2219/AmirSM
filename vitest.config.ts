import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['server/test/**/*.test.ts', 'shared/**/*.test.ts'], testTimeout: 120000, hookTimeout: 60000, pool: 'forks' },
});
