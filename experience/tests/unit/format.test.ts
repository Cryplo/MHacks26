import { describe, expect, it } from 'vitest';
import {
  EM_DASH, formatCents, formatMetric, formatMetricDelta, formatPercent, formatPpDelta, formatSimClock, parseDollarsToCents, parseParkLocalTime,
} from '../../src/ui/format';
import type { MetricValue } from '../../contract/behavior-v1';

describe('money (C-09)', () => {
  it('formats integer cents without floating point dollars', () => {
    expect(formatCents(150000)).toBe('$1,500.00');
    expect(formatCents(2500)).toBe('$25.00');
    expect(formatCents(1)).toBe('$0.01');
    expect(formatCents(0)).toBe('$0.00');
    expect(formatCents(-1234)).toBe('−$12.34');
    expect(formatCents(1000, { signed: true })).toBe('+$10.00');
    expect(formatCents(Number.MAX_SAFE_INTEGER)).toBe('$90,071,992,547,409.91');
  });
  it('null is an em dash, never zero', () => {
    expect(formatCents(null)).toBe(EM_DASH);
    expect(formatPercent(null)).toBe(EM_DASH);
  });
  it('parses dollars to cents exactly', () => {
    expect(parseDollarsToCents('$25')).toEqual({ ok: true, cents: 2500 });
    expect(parseDollarsToCents('0.29')).toEqual({ ok: true, cents: 29 });
    expect(parseDollarsToCents('1,500.5')).toEqual({ ok: true, cents: 150050 });
    expect(parseDollarsToCents('2.555').ok).toBe(false);
    expect(parseDollarsToCents('-5').ok).toBe(false);
  });
});

describe('percent vs percentage points (C-09)', () => {
  it('distinguishes a share from a difference of shares', () => {
    expect(formatPercent(0.25)).toBe('25.0%');
    expect(formatPpDelta(0.05)).toBe('+5.0 pp');
    expect(formatPpDelta(-0.123)).toBe('−12.3 pp');
    expect(formatPpDelta(0)).toBe('0.0 pp');
  });
  it('metric deltas keep original units and signs', () => {
    expect(formatMetricDelta('net_revenue_cents', 'cents', -5000)).toBe('−$50.00');
    expect(formatMetricDelta('abandonment_rate', 'ratio', 0.02)).toBe('+2.0 pp');
    expect(formatMetricDelta('rides_per_guest', 'ratio', 0.5)).toBe('+0.50');
    expect(formatMetricDelta('satisfaction_0_100', 'score', 0)).toBe('0.0 points');
    expect(formatMetricDelta('queue_minutes_per_guest', 'minutes', null)).toBe(EM_DASH);
  });
  it('formats metric values in their units; null value is not zero', () => {
    const m = (v: number | null, unit: MetricValue['unit'], id: MetricValue['id']): MetricValue => ({ id, value: v, unit, numerator: 0, denominator: 0, n: 0, coverage: 0, complete: false, missingReason: null });
    expect(formatMetric(m(0.25, 'ratio', 'abandonment_rate'))).toBe('25.0%');
    expect(formatMetric(m(1.5, 'ratio', 'rides_per_guest'))).toBe('1.50');
    expect(formatMetric(m(75, 'score', 'satisfaction_0_100'))).toBe('75.0 / 100');
    expect(formatMetric(m(null, 'score', 'satisfaction_0_100'))).toBe(EM_DASH);
  });
});

describe('park-local time (never device timezone)', () => {
  it('converts local clock to ms since opening', () => {
    expect(parseParkLocalTime('14:00', '09:00', 36_000_000)).toEqual({ ok: true, simMs: 18_000_000 });
    expect(parseParkLocalTime('2pm', '09:00', 36_000_000)).toEqual({ ok: true, simMs: 18_000_000 });
    expect(parseParkLocalTime('12:00 am', '09:00', 36_000_000).ok).toBe(false);
    expect(parseParkLocalTime('20:00', '09:00', 36_000_000).ok).toBe(false);
    expect(parseParkLocalTime('14:00:03', '09:00', 36_000_000).ok).toBe(false);
  });
  it('formats sim clock by adding opening time', () => {
    expect(formatSimClock(0, '09:00')).toBe('9:00 AM');
    expect(formatSimClock(18_000_000, '09:00')).toBe('2:00 PM');
    expect(formatSimClock(10_800_000, '09:30')).toBe('12:30 PM');
  });
});
