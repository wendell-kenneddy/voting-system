import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 5000,
    hookTimeout: 5000,
    restoreMocks: true,
    include: ['test/**/*.test.ts'],
  },
});
