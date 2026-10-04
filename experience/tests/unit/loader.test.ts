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

describe('local integration auto-session', () => {
  const local = { ...live, localSessionUrl: '/runtime/local-session.json' };
  const connect = async (settings: typeof live & { localSessionUrl?: string }, tokens: ReturnType<typeof memoryTokenStore>, fetchText: (u: string) => Promise<string | null>) => {
    let token: string | null | undefined;
    await loadRuntime(settings, {
      importModule: async () => ({ createRuntimeClient: async (cfg: { token: string | null }) => { token = cfg.token; return fakeClient(); } }),
      loadFixture: vi.fn(), tokens, fetchText,
    });
    return token;
  };

  it('signs in with the local operator credential, replacing an anonymous stored session', async () => {
    const tokens = memoryTokenStore('anonymous');
    expect(await connect(local, tokens, async () => JSON.stringify({ token: 'operator' }))).toBe('operator');
    expect(tokens.isExplicit()).toBe(false);
  });

  it('never replaces a credential chosen on /session', async () => {
    const tokens = memoryTokenStore();
    tokens.set('viewer', { explicit: true });
    const fetchText = vi.fn(async () => JSON.stringify({ token: 'operator' }));
    expect(await connect(local, tokens, fetchText)).toBe('viewer');
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('keeps the stored session when the file is missing or malformed, and is off unless configured', async () => {
    expect(await connect(local, memoryTokenStore('mine'), async () => null)).toBe('mine');
    expect(await connect(local, memoryTokenStore('mine'), async () => 'not json')).toBe('mine');
    const fetchText = vi.fn(async () => JSON.stringify({ token: 'operator' }));
    expect(await connect(live, memoryTokenStore('mine'), fetchText)).toBe('mine');
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('VITE_RUNTIME_LOCAL_SESSION_URL must be same-origin', () => {
    const base = { VITE_RUNTIME_PROFILE: 'live', VITE_RUNTIME_ADAPTER_URL: '/runtime/browser.js', VITE_RUNTIME_URI: 'http://x', VITE_RUNTIME_DATABASE: 'd' };
    expect(readRuntimeSettings({ ...base, VITE_RUNTIME_LOCAL_SESSION_URL: '/runtime/local-session.json' }).localSessionUrl).toBe('/runtime/local-session.json');
    expect(() => readRuntimeSettings({ ...base, VITE_RUNTIME_LOCAL_SESSION_URL: 'https://evil/x.json' })).toThrow(/same-origin/);
    expect(readRuntimeSettings(base).localSessionUrl).toBeUndefined();
  });
});
