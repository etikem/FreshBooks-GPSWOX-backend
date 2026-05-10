import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // setup.ts populates ABCTRACK_* / FRESHBOOKS_* env vars BEFORE
    // src/config/env.ts loads, so unit tests don't require a real .env.
    setupFiles: ['./tests/setup.ts'],
  },
});
