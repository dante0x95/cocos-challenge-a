import { defineConfig } from 'vitest/config';
import { TEST_ADMIN_URL, TEST_API_URL } from './test/support/urls.js';

export default defineConfig({
  test: {
    globalSetup: ['test/support/global-setup.ts'],
    env: {
      DATABASE_URL: TEST_API_URL,
      DATABASE_ADMIN_URL: TEST_ADMIN_URL,
      INTERNAL_TOKEN: 'test-token',
      LOG_REQUESTS: 'false',
    },
    // Las pruebas de base comparten un Postgres y algunas cambian settings: en serie.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
