import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@emilswork/harness-core': at('./packages/core/src/index.ts'),
      '@emilswork/harness-worker': at('./packages/worker/src/index.ts'),
      '@emilswork/harness-daemon': at('./packages/daemon/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/tests/**/*.test.ts'],
    globalSetup: ['./vitest.setup.ts'],
    // Every run spawns real child processes (workers, checks, daemons) and talks to
    // a fake DeepSeek over HTTP, so the files must not stampede each other.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
