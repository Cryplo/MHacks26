/**
 * Explicit runtime profile selection. The profile is fixed at build time (`--mode fixture`
 * or `--mode live`); nothing at runtime can switch a live session to fixture data.
 * These values are public configuration, never credentials.
 */
export type Profile = 'fixture' | 'live';
export type RuntimeSettings = {
  profile: Profile;
  adapterUrl: string;
  uri: string;
  database: string;
  /**
   * Local integration build only (`npm run dev:integration`): same-origin path of a file the
   * launcher writes with the local operator credential, so the local UI needs no sign-in.
   */
  localSessionUrl?: string;
};

export class RuntimeConfigError extends Error {
  override name = 'RuntimeConfigError';
}

type Env = Record<string, string | boolean | undefined>;

export function readRuntimeSettings(env: Env): RuntimeSettings {
  const profile = env.VITE_RUNTIME_PROFILE;
  if (profile !== 'fixture' && profile !== 'live') {
    throw new RuntimeConfigError(`VITE_RUNTIME_PROFILE must be "fixture" or "live" (got ${JSON.stringify(profile ?? null)}).`);
  }
  if (profile === 'fixture') return { profile, adapterUrl: '', uri: '', database: '' };
  const adapterUrl = String(env.VITE_RUNTIME_ADAPTER_URL ?? '');
  const uri = String(env.VITE_RUNTIME_URI ?? '');
  const database = String(env.VITE_RUNTIME_DATABASE ?? '');
  if (!adapterUrl.startsWith('/')) throw new RuntimeConfigError('VITE_RUNTIME_ADAPTER_URL must be a same-origin absolute path such as /runtime/browser.js.');
  if (!uri) throw new RuntimeConfigError('VITE_RUNTIME_URI is required for the live profile.');
  if (!database) throw new RuntimeConfigError('VITE_RUNTIME_DATABASE is required for the live profile.');
  const localSessionUrl = String(env.VITE_RUNTIME_LOCAL_SESSION_URL ?? '');
  if (localSessionUrl && !localSessionUrl.startsWith('/')) throw new RuntimeConfigError('VITE_RUNTIME_LOCAL_SESSION_URL must be a same-origin absolute path.');
  return { profile, adapterUrl, uri, database, ...(localSessionUrl ? { localSessionUrl } : {}) };
}
