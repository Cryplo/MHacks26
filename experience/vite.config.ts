/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Profiles are explicit: `--mode fixture` or `--mode live` (see .env.fixture / .env.live).
// No secrets are read here; only VITE_RUNTIME_* public configuration reaches the bundle.
export default defineConfig(({ mode }) => {
  if (mode !== 'fixture' && mode !== 'live' && mode !== 'test') {
    throw new Error(`Unknown build profile "${mode}". Use --mode fixture or --mode live.`);
  }
  return {
    plugins: [react()],
    envPrefix: 'VITE_RUNTIME_',
    server: { port: 4317, strictPort: true },
    build: { sourcemap: true, chunkSizeWarningLimit: 1200 },
    test: {
      projects: [
        {
          extends: true,
          test: { name: 'unit', include: ['tests/unit/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['tests/setup.ts'] },
        },
        {
          extends: true,
          test: { name: 'integration', include: ['tests/integration/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['tests/setup.ts'] },
        },
        {
          extends: true,
          test: { name: 'contract', include: ['tests/contract/**/*.test.ts'], environment: 'node' },
        },
      ],
      coverage: { provider: 'v8', include: ['src/**/*.{ts,tsx}'], reporter: ['text-summary', 'json-summary'] },
    },
  };
});
