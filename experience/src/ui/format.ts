/**
 * Display formatting. Money is integer cents end to end; conversion to dollars happens only
 * in strings (integer arithmetic, no floating-point dollars). Null is "not available", never 0.
 */
import type { MetricValue, SimMs } from '../../contract/behavior-v1';

export const EM_DASH = '—';
export const MINUS = '−';
const group = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function formatCents(cents: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (cents === null || cents === undefined) return EM_DASH;
  if (!Number.isFinite(cents)) return EM_DASH;
  const rounded = Math.round(cents); // per-guest averages can be fractional cents
  const abs = Math.abs(rounded);
  const body = `$${group.format(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}`;
  if (rounded < 0) return `${MINUS}${body}`;
  if (opts.signed && rounded > 0) return `+${body}`;
  return body;
}

/** Parses "$25", "25.5", "1,500.00" into integer cents. Rejects >2 decimals and negatives. */
export function parseDollarsToCents(input: string): { ok: true; cents: number } | { ok: false; message: string } {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { ok: false, message: 'Enter dollars with at most two decimals, e.g. 25 or 25.50.' };
  const [whole, frac = ''] = s.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return { ok: false, message: 'Amount is too large.' };
  return { ok: true, cents };
}

/** A ratio (0..1) shown as a percentage. */
export function formatPercent(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return EM_DASH;
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** A difference between two ratios is in percentage points, not percent. */
export function formatPpDelta(ratioDelta: number | null | undefined, digits = 1): string {
  if (ratioDelta === null || ratioDelta === undefined || !Number.isFinite(ratioDelta)) return EM_DASH;
  const v = ratioDelta * 100;
  return `${signed(v, digits)} pp`;
}

function signed(v: number, digits: number): string {
  const fixed = Math.abs(v).toFixed(digits);
  if (Number(fixed) === 0) return (0).toFixed(digits);
  return v < 0 ? `${MINUS}${fixed}` : `+${fixed}`;
}

export function formatNumber(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function formatSignedNumber(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return EM_DASH;
  return signed(v, digits);
}

export function formatMinutes(min: number | null | undefined, digits = 1): string {
  if (min === null || min === undefined || !Number.isFinite(min)) return EM_DASH;
  return `${formatNumber(min, digits)} min`;
}

export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH;
  return group.format(n);
}

/** Formats one contract MetricValue in its own unit. */
export function formatMetric(m: MetricValue | null | undefined): string {
  if (!m || m.value === null) return EM_DASH;
  switch (m.unit) {
    case 'cents': return formatCents(m.value);
    case 'score': return `${formatNumber(m.value, 1)} / 100`;
    case 'minutes': return formatMinutes(m.value);
    case 'ratio': return isShareMetric(m.id) ? formatPercent(m.value) : formatNumber(m.value, 2);
    case 'guests': return formatCount(m.value);
  }
}

/** Ratios that are shares (shown in %) vs counts-per-guest (shown as plain numbers). */
export const isShareMetric = (id: MetricValue['id']) =>
  id === 'abandonment_rate' || id === 'queue_time_share' || id === 'ride_seat_utilization' || id === 'server_utilization';

/** Formats a B-minus-A delta in the metric's original unit. */
export function formatMetricDelta(id: MetricValue['id'], unit: MetricValue['unit'], delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return EM_DASH;
  switch (unit) {
    case 'cents': return formatCents(delta, { signed: true });
    case 'score': return `${formatSignedNumber(delta, 1)} points`;
    case 'minutes': return `${formatSignedNumber(delta, 1)} min`;
    case 'ratio': return isShareMetric(id) ? formatPpDelta(delta) : formatSignedNumber(delta, 2);
    case 'guests': return `${formatSignedNumber(delta, 0)} guests`;
  }
}

// ---- Simulation time. Wire time is ms since park opening; display adds the opening time.
// The browser timezone never enters these calculations.

export function parseOpenLocal(openLocal: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(openLocal);
  if (!m) throw new Error(`invalid openLocal ${openLocal}`);
  return (Number(m[1]) * 60 + Number(m[2])) * 60_000;
}

export function formatSimClock(simMs: SimMs | null | undefined, openLocal: string, withSeconds = false): string {
  if (simMs === null || simMs === undefined) return EM_DASH;
  const total = parseOpenLocal(openLocal) + simMs;
  const day = 24 * 3600_000;
  const t = ((total % day) + day) % day;
  const h24 = Math.floor(t / 3600_000);
  const m = Math.floor((t % 3600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const suffix = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${String(m).padStart(2, '0')}${withSeconds ? `:${String(s).padStart(2, '0')}` : ''} ${suffix}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EM_DASH;
  const neg = ms < 0;
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600_000);
  const m = Math.floor((abs % 3600_000) / 60_000);
  const s = Math.floor((abs % 60_000) / 1000);
  const body = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  return neg ? `${MINUS}${body}` : body;
}

/** Elapsed simulated time as +HH:MM:SS since opening. */
export function formatSimOffset(simMs: SimMs): string {
  const h = Math.floor(simMs / 3600_000);
  const m = Math.floor((simMs % 3600_000) / 60_000);
  const s = Math.floor((simMs % 60_000) / 1000);
  return `+${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Converts a park-local wall clock ("14:00", "2:00 pm") into ms since opening. Rejects
 * times before opening, after closing, or not on a 5,000 ms boundary (never rounds).
 */
export function parseParkLocalTime(input: string, openLocal: string, closeAfterMs: number):
  { ok: true; simMs: SimMs } | { ok: false; message: string } {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(input);
  if (!m) return { ok: false, message: 'Use a park-local time such as 14:00 or 2:00 pm.' };
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const sec = Number(m[3] ?? 0);
  const ampm = m[4]?.toLowerCase();
  if (min > 59 || sec > 59) return { ok: false, message: 'Minutes and seconds must be below 60.' };
  if (ampm) {
    if (h < 1 || h > 12) return { ok: false, message: 'Hours must be 1-12 with am/pm.' };
    h = (h % 12) + (ampm === 'pm' ? 12 : 0);
  } else if (h > 23) return { ok: false, message: 'Hours must be 0-23.' };
  const simMs = (h * 3600 + min * 60 + sec) * 1000 - parseOpenLocal(openLocal);
  if (simMs < 0) return { ok: false, message: `That is before the park opens (${formatSimClock(0, openLocal)}).` };
  if (simMs > closeAfterMs) return { ok: false, message: `That is after closing (${formatSimClock(closeAfterMs, openLocal)}).` };
  if (simMs % 5000 !== 0) return { ok: false, message: 'Scenario times must fall on a 5-second boundary.' };
  return { ok: true, simMs };
}

export function formatAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return EM_DASH;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3600_000).toFixed(1)} h`;
}

export function formatProbability(p: number): string {
  if (!Number.isFinite(p)) return EM_DASH;
  if (p > 0 && p < 0.001) return '<0.1%';
  return `${(p * 100).toFixed(1)}%`;
}

export function formatEpoch(epochMs: number | null | undefined): string {
  if (epochMs === null || epochMs === undefined) return EM_DASH;
  return new Date(epochMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}
