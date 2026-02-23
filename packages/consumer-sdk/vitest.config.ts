import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      include: ['src/**'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 65,
      },
    },
  },
  resolve: {
    alias: {
      '@littlebearapps/platform-consumer-sdk/middleware': resolve(__dirname, 'src/middleware.ts'),
      '@littlebearapps/platform-consumer-sdk/patterns': resolve(__dirname, 'src/patterns.ts'),
      '@littlebearapps/platform-consumer-sdk/dynamic-patterns': resolve(__dirname, 'src/dynamic-patterns.ts'),
      '@littlebearapps/platform-consumer-sdk': resolve(__dirname, 'src/index.ts'),
    },
  },
});
