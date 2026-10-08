import { defineConfig } from 'vitest/config';

// Unit tests only: no Docker, no network. Integration tests have their own config.
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
