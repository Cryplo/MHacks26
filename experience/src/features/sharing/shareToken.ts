/**
 * Share capability material. 32 bytes from the browser CSPRNG (never the simulation RNG),
 * base64url encoded. Only its SHA-256 is sent to the server when issuing; the raw token
 * lives only in the URL fragment (never sent in requests, logs or analytics).
 */
import { canonicalHash } from '../../domain/canonical';

export function generateShareToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Engine verifies `sha256(canonicalJson(token))` (the canonical JSON string), not raw bytes. */
export const hashShareToken = (token: string) => canonicalHash(token);

export function buildShareLink(origin: string, token: string): string {
  return `${origin}/share#t=${encodeURIComponent(token)}`;
}

/** Reads the token from a fragment like "#t=..." and returns it (or null). */
export function readShareFragment(hash: string): string | null {
  const m = /^#t=([A-Za-z0-9_%-]{20,200})$/.exec(hash);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Removes capability material from the address bar and history entry immediately. */
export function scrubFragment(win: Pick<Window, 'history' | 'location'> = window) {
  win.history.replaceState(null, '', win.location.pathname + win.location.search);
}
