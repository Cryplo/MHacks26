/**
 * Persists ONLY the caller's own session credential issued by the runtime (onToken).
 * Live: localStorage (survives reload). Fixture: sessionStorage, so each tab is a separate
 * fixture session (lets one browser context hold operator and viewer tabs). Never logged.
 */
import type { Profile } from './config';

const KEY = 'behavior-engine.session-token.v1';

export type TokenStore = { get(): string | null; set(token: string): void; clear(): void };

export function browserTokenStore(profile: Profile): TokenStore {
  const storage = () => (profile === 'live' ? window.localStorage : window.sessionStorage);
  return {
    get: () => { try { return storage().getItem(KEY); } catch { return null; } },
    set: (token) => { try { storage().setItem(KEY, token); } catch { /* storage unavailable: session only */ } },
    clear: () => { try { storage().removeItem(KEY); } catch { /* ignore */ } },
  };
}

export function memoryTokenStore(initial: string | null = null): TokenStore {
  let token = initial;
  return { get: () => token, set: (t) => { token = t; }, clear: () => { token = null; } };
}
