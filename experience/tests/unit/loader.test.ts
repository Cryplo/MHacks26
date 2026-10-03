/** C-01: explicit profiles, adapter absence/version mismatch errors, no hidden fallback. */
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../../contract/behavior-v1';
import { readRuntimeSettings, RuntimeConfigError } from '../../src/runtime/config';
import { loadRuntime, RuntimeStartupError } from '../../src/runtime/loader';
import { memoryTokenStore } from '../../src/runtime/tokenStore';
import { displayModes } from '../../src/runtime/mode';
import { FIXTURE_CAPABILITIES } from '../../src/fixture/server';

const live = { profile: 'live' as const, adapterUrl: '/runtime/browser.js', uri: 'ws://x', database: 'db' };
const fakeClient = (version = 'behavior.v1', capVersion = 'behavior.v1'): RuntimeClient => ({
  contractVersion: version as 'behavior.v1',
  command: vi.fn(), subscribeLive: vi.fn(), subscribeWorkAvailable: vi.fn(), putArtifact: vi.fn(), getArtifact: vi.fn(),
  query: vi.fn(async () => ({ ...FIXTURE_CAPABILITIES, contractVersion: capVersion })) as unknown as RuntimeClient['query'],
  close: vi.fn(async () => undefined),
});

describe('runtime profile selection', () => {
  it('requires an explicit profile', () => {
    expect(() => readRuntimeSettings({})).toThrow(RuntimeConfigError);
    expect(() => readRuntimeSettings({ VITE_RUNTIME_PROFILE: 'recorded' })).toThrow(RuntimeConfigError);
    expect(readRuntimeSettings({ VITE_RUNTIME_PROFILE: 'fixture' }).profile).toBe('fixture');
    expect(() => readRuntimeSettings({ VITE_RUNTIME_PROFILE: 'live', VITE_RUNTIME_ADAPTER_URL: 'https://cdn.example/x.js', VITE_RUNTIME_URI: 'ws://x', VITE_RUNTIME_DATABASE: 'd' })).toThrow(/same-origin/);
  });

  it('missing live adapter is a startup error and never loads the fixture', async () => {
    const loadFixture = vi.fn();
    const err = await loadRuntime(live, { importModule: () => Promise.reject(new Error('404')), loadFixture, tokens: memoryTokenStore() }).catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeStartupError);
    expect(err.kind).toBe('missing_adapter');
    expect(loadFixture).not.toHaveBeenCalled();
  });

  it('adapter without createRuntimeClient is invalid', async () => {
    const err = await loadRuntime(live, { importModule: async () => ({}), loadFixture: vi.fn(), tokens: memoryTokenStore() }).catch((e) => e);
    expect(err.kind).toBe('invalid_adapter');
  });

  it('contract version mismatch (client or capabilities) is rejected and the client closed', async () => {
    for (const [v, cv] of [['behavior.v2', 'behavior.v1'], ['behavior.v1', 'behavior.v0']]) {
      const c = fakeClient(v, cv);
      const err = await loadRuntime(live, { importModule: async () => ({ createRuntimeClient: async () => c }), loadFixture: vi.fn(), tokens: memoryTokenStore() }).catch((e) => e);
      expect(err.kind).toBe('version_mismatch');
      expect(c.close).toHaveBeenCalled();
    }
  });

  it('passes the stored session token and persists a newly issued one', async () => {
    const tokens = memoryTokenStore('tok-1');
    let seen: { token: string | null; onToken?: (t: string) => void } | null = null;
    await loadRuntime(live, { importModule: async () => ({ createRuntimeClient: async (cfg: typeof seen) => { seen = cfg; return fakeClient(); } }), loadFixture: vi.fn(), tokens });
    expect(seen!.token).toBe('tok-1');
    seen!.onToken!('tok-2');
    expect(tokens.get()).toBe('tok-2');
  });
});

describe('display modes', () => {
  it('labels fixture, mock, live, degraded and recorded explicitly', () => {
    expect(displayModes({ profile: 'fixture', run: { mode: 'mock' } })).toEqual(['Fixture']);
    expect(displayModes({ profile: 'live', run: { mode: 'mock' } })).toEqual(['Mock']);
    expect(displayModes({ profile: 'live', run: { mode: 'live' }, quality: { behaviorCounts: { jev: 3, cache: 0, mock: 0, fallback: 1 } } as never })).toEqual(['Live Jev', 'Degraded']);
    expect(displayModes({ profile: 'live', run: { mode: 'experiment' }, quality: { behaviorCounts: { jev: 0, cache: 0, mock: 5, fallback: 0 } } as never })).toEqual(['Mock']);
    expect(displayModes({ profile: 'live', recorded: true, run: { mode: 'replay' } })).toEqual(['Recorded']);
    expect(displayModes({ profile: 'fixture', recorded: true })).toEqual(['Fixture', 'Recorded']);
  });
});
