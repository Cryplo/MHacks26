import type { Archetype } from '../../contract/behavior-v1.ts';
import type { FieldError } from '../core/errors.ts';
import { ARCHETYPES, GROUP_SHAPES } from './assumptions.ts';

export type ShareValidation =
  | { ok: true; normalized: Record<Archetype, number>; normalizedFromSum: number; warnings: string[] }
  | { ok: false; errors: FieldError[] };

/** Rejects negative/NaN/unknown/all-zero shares; normalizes an accepted mix to sum 1, recording the original sum. */
export function validateShares(shares: Record<string, unknown>): ShareValidation {
  const errors: FieldError[] = [];
  for (const key of Object.keys(shares)) if (!(ARCHETYPES as readonly string[]).includes(key)) errors.push({ path: `shares.${key}`, message: 'unsupported archetype' });
  for (const a of ARCHETYPES) {
    const v = shares[a];
    if (v === undefined) errors.push({ path: `shares.${a}`, message: 'missing share' });
    else if (typeof v !== 'number' || !Number.isFinite(v)) errors.push({ path: `shares.${a}`, message: 'share must be a finite number' });
    else if (v < 0) errors.push({ path: `shares.${a}`, message: 'share must be nonnegative' });
  }
  if (errors.length) return { ok: false, errors };
  const sum = ARCHETYPES.reduce((s, a) => s + (shares[a] as number), 0);
  if (!(sum > 0)) return { ok: false, errors: [{ path: 'shares', message: 'all shares are zero' }] };
  const normalized = Object.fromEntries(ARCHETYPES.map((a) => [a, (shares[a] as number) / sum])) as Record<Archetype, number>;
  const warnings = Math.abs(sum - 1) > 1e-9 ? [`shares summed to ${sum}; normalized to 1`] : [];
  return { ok: true, normalized, normalizedFromSum: sum, warnings };
}

export function isFeasibleQuota(a: Archetype, q: number): boolean {
  const s = GROUP_SHAPES[a];
  if (q === 0) return true;
  if (q < s.minSize) return false;
  if (s.evenOnly && q % 2 !== 0) return false;
  return true;
}

export type Allocation =
  | { ok: true; targets: Record<Archetype, number>; realized: Record<Archetype, number>; warnings: string[] }
  | { ok: false; errors: FieldError[] };

/**
 * Largest-remainder allocation of guests to archetypes (ties by archetype order), followed by a
 * deterministic feasibility repair: an infeasible bucket is rounded down to its nearest feasible
 * count and the remainder moves to the requested bucket with the largest deficit that can absorb it.
 * Never drops or duplicates guests; returns an actionable error when no repair exists.
 */
export function allocateGuests(guestCount: number, shares: Record<Archetype, number>): Allocation {
  const exact = ARCHETYPES.map((a) => ({ a, x: shares[a] * guestCount }));
  const base = Object.fromEntries(exact.map(({ a, x }) => [a, Math.floor(x)])) as Record<Archetype, number>;
  let remaining = guestCount - ARCHETYPES.reduce((s, a) => s + base[a], 0);
  const order = [...exact].sort((p, q) => (q.x - Math.floor(q.x)) - (p.x - Math.floor(p.x)) || ARCHETYPES.indexOf(p.a) - ARCHETYPES.indexOf(q.a));
  for (const { a } of order) { if (remaining <= 0) break; base[a] += 1; remaining -= 1; }
  const targets = { ...base };
  const realized = { ...base };
  const warnings: string[] = [];

  for (let guard = 0; guard < 4 * ARCHETYPES.length; guard++) {
    const bad = ARCHETYPES.find((a) => !isFeasibleQuota(a, realized[a]));
    if (!bad) break;
    let down = realized[bad];
    while (down > 0 && !isFeasibleQuota(bad, down)) down -= 1;
    const moved = realized[bad] - down;
    const absorbers = ARCHETYPES
      .filter((a) => a !== bad && shares[a] > 0 && isFeasibleQuota(a, realized[a] + moved))
      .sort((p, q) => (shares[q] * guestCount - realized[q]) - (shares[p] * guestCount - realized[p]) || ARCHETYPES.indexOf(p) - ARCHETYPES.indexOf(q));
    const up = realized[bad] + 1;
    const donors = ARCHETYPES.filter((a) => a !== bad && realized[a] > 0 && isFeasibleQuota(a, realized[a] - (up - realized[bad])));
    if (absorbers.length) {
      const to = absorbers[0]!;
      realized[bad] = down; realized[to] += moved;
      warnings.push(`feasibility: moved ${moved} guest(s) from ${bad} to ${to} (${bad} groups need ${GROUP_SHAPES[bad].evenOnly ? 'an even count' : `at least ${GROUP_SHAPES[bad].minSize} guests`})`);
    } else if (isFeasibleQuota(bad, up) && donors.length) {
      const from = donors[0]!;
      realized[from] -= 1; realized[bad] = up;
      warnings.push(`feasibility: moved 1 guest from ${from} to ${bad} to form a valid ${bad} group`);
    } else {
      const s = GROUP_SHAPES[bad];
      return {
        ok: false,
        errors: [{
          path: 'guestCount',
          message: `${guestCount} guest(s) cannot form valid ${bad} groups (${s.evenOnly ? 'requires an even count' : `minimum group size ${s.minSize}`}) with the requested mix; increase guestCount to at least ${Math.max(s.minSize, guestCount + 1)} or add a share for a flexible archetype such as solo`,
        }],
      };
    }
  }
  for (const a of ARCHETYPES) {
    const exactX = shares[a] * guestCount;
    if (targets[a] !== exactX && Math.abs(targets[a] - exactX) >= 1e-9) warnings.push(`rounding: ${a} requested ${exactX.toFixed(2)} guests, target ${targets[a]}`);
  }
  return { ok: true, targets, realized, warnings };
}
