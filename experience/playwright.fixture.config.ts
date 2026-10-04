import { defineConfig, devices } from '@playwright/test';

/**
 * Standalone browser suite against the PRODUCTION fixture build. Proves UI workflows on
 * scripted data only; it is not evidence of real subscriptions, Engine or Jev.
 */
const PORT = 4318;
export default defineConfig({
  testDir: 'tests/e2e',
  testIgnore: ['**/live/**'],
  // Perf profiling runs separately and serially (npm run test:perf) so it is not distorted.
  grepInvert: process.env.PERF ? undefined : /@perf/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: 2,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-fixture.json' }]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  webServer: {
    command: `npm run build:fixture && npx vite preview --mode fixture --outDir dist/fixture --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`, reuseExistingServer: false, timeout: 180_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }, testIgnore: ['**/mobile.spec.ts', '**/live/**'] },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 375, height: 812 } }, testMatch: ['**/mobile.spec.ts'] },
  ],
});
