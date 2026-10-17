import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    // Real git runs in temp repos; isolate it from the developer's own config.
    env: {
      GIT_CONFIG_GLOBAL: resolve(import.meta.dirname, 'tests/gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
    },
  },
});
