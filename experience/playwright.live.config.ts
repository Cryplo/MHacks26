import { defineConfig, devices } from '@playwright/test';

/**
 * Live-profile browser suite. E2E_LIVE_MODE=missing serves a live build with NO adapter and
 * proves the startup error (no fixture fallback). E2E_LIVE_MODE=integrated runs against A's
 * launcher (SpacetimeDB + registered park) and B's mock worker. See scripts/e2e-live.mjs.
 */
const PORT = 4319;
const mode = process.env.E2E_LIVE_MODE ?? 'missing';
const outDir = mode === 'missing' ? 'dist/live-check' : mode === 'stub' ? 'dist/live-stub' : 'dist/live';
const build = mode === 'missing' ? 'npx vite build --mode live --outDir dist/live-check --logLevel error'
  : mode === 'stub' ? 'npx vite build --mode live --outDir dist/live-stub --logLevel error && mkdir -p dist/live-stub/runtime && cp tests/e2e/live/stub-adapter.js dist/live-stub/runtime/browser.js'
    : 'npm run build:live';
export default defineConfig({
  testDir: 'tests/e2e/live',
  timeout: 600_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [['list'], ['json', { outputFile: `test-results/e2e-live-${mode}.json` }]],
  use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure', viewport: { width: 1440, height: 900 } },
  grep: mode === 'missing' ? /@missing-adapter/ : mode === 'stub' ? /@stub-adapter/ : /@integrated|@real-jev/,
  webServer: {
    command: `${build} && npx vite preview --mode live --outDir ${outDir} --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`, reuseExistingServer: false, timeout: 240_000,
  },
});
