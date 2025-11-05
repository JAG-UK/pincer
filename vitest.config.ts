import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 600000, // 10 minutes for integration tests (Filecoin Pin uploads can take time)
  },
});

