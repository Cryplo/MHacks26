/**
 * Persists ONLY the caller's own session credential issued by the runtime (onToken).
 * Live: localStorage (survives reload). Fixture: sessionStorage, so each tab is a separate
 * fixture session (lets one browser context hold operator and viewer tabs). Never logged.
 */
import type { Profile } from './config';

const KEY = 'behavior-engine.session-token.v1';
const EXPLICIT_KEY = 'behavior-engine.session-explicit.v1';

/** `explicit` marks a credential the person chose on /session; a local auto-session never replaces it. */
export type TokenStore = {
  get(): string | null; set(token: string, opts?: { explicit?: boolean }): void; clear(): void; isExplicit(): boolean;
};

export function browserTokenStore(profile: Profile): TokenStore {
  const storage = () => (profile === 'live' ? window.localStorage : window.sessionStorage);
  return {
    get: () => { try { return storage().getItem(KEY); } catch { return null; } },
    set: (token, opts) => {
      try {
        storage().setItem(KEY, token);
        if (opts?.explicit) storage().setItem(EXPLICIT_KEY, '1');
        else if (opts?.explicit === false) storage().removeItem(EXPLICIT_KEY);
      } catch { /* storage unavailable: session only */ }
    },
    clear: () => { try { storage().removeItem(KEY); storage().removeItem(EXPLICIT_KEY); } catch { /* ignore */ } },
    isExplicit: () => { try { return storage().getItem(EXPLICIT_KEY) === '1'; } catch { return false; } },
  };
}

export function memoryTokenStore(initial: string | null = null): TokenStore {
  let token = initial;
  let explicit = false;
  return {
    get: () => token,
    set: (t, opts) => { token = t; if (opts?.explicit !== undefined) explicit = opts.explicit; },
    clear: () => { token = null; explicit = false; },
    isExplicit: () => explicit,
  };
}
