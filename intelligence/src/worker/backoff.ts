import type { Jitter } from '../runtime/clock.ts';

export type BackoffPolicy = { baseMs: number; maxMs: number };

/** Bounded "full jitter" exponential backoff in wall time: uniform in [delay/2, delay]. */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy, jitter: Jitter): number {
  const exp = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + (exp / 2) * jitter.next());
}

/**
 * Parses Retry-After as delta-seconds or an HTTP-date. Returns milliseconds from now,
 * clamped to [0, capMs], or null when absent/unparseable.
 */
export function parseRetryAfter(header: string | null | undefined, nowEpochMs: number, capMs: number): number | null {
  if (header == null) return null;
  const v = header.trim();
  if (v === '') return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.min(capMs, Math.max(0, Math.round(Number(v) * 1000)));
  const at = Date.parse(v);
  if (Number.isNaN(at)) return null;
  return Math.min(capMs, Math.max(0, at - nowEpochMs));
}
