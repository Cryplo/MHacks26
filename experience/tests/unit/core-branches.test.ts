/** Branch coverage for money formatting, protocol store, commands, work polling, sampling. */
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeClient } from '../../contract/behavior-v1';
import { inverseCdfChoice } from '../../src/domain/random';
import * as f from '../../src/ui/format';
import { LiveStore } from '../../src/data/liveStore';
import { LiveConnection } from '../../src/data/liveConnection';
import { CommandRunner, memoryIntentStore, sessionIntentStore } from '../../src/runtime/commands';
import { awaitWork, AbortedError } from '../../src/runtime/work';
import { classifyError, domainError, isAccessError, makeRuntimeClientError } from '../../src/runtime/errors';
import { browserTokenStore, memoryTokenStore } from '../../src/runtime/tokenStore';
import { agent, event, patch, snapshot } from '../helpers';

describe('format branches', () => {
  it('handles non-finite and edge values', () => {
    expect(f.formatCents(NaN)).toBe(f.EM_DASH);
    expect(f.formatCents(undefined)).toBe(f.EM_DASH);
    expect(f.formatCents(12.6)).toBe('$0.13');
    expect(f.formatCents(0, { signed: true })).toBe('$0.00');
    expect(f.formatPercent(Infinity)).toBe(f.EM_DASH);
    expect(f.formatPpDelta(null)).toBe(f.EM_DASH);
    expect(f.formatNumber(null)).toBe(f.EM_DASH);
    expect(f.formatNumber(1234.5, 1)).toBe('1,234.5');
    expect(f.formatSignedNumber(undefined)).toBe(f.EM_DASH);
    expect(f.formatSignedNumber(-0.04, 1)).toBe('0.0');
    expect(f.formatMinutes(NaN)).toBe(f.EM_DASH);
    expect(f.formatCount(null)).toBe(f.EM_DASH);
    expect(f.formatCount(12345)).toBe('12,345');
    expect(f.parseDollarsToCents('9'.repeat(20)).ok).toBe(false);
  });
  it('formats all metric units and deltas', () => {
    const m = (unit: 'cents' | 'guests' | 'minutes', value: number) => ({ id: 'early_departures' as const, unit, value, numerator: 0, denominator: null, n: 0, coverage: 1, complete: true, missingReason: null });
    expect(f.formatMetric(m('guests', 3))).toBe('3');
    expect(f.formatMetric(m('cents', 250))).toBe('$2.50');
    expect(f.formatMetric(m('minutes', 2))).toBe('2.0 min');
    expect(f.formatMetric(null)).toBe(f.EM_DASH);
    expect(f.formatMetricDelta('early_departures', 'guests', 2)).toBe('+2 guests');
    expect(f.formatMetricDelta('queue_minutes_per_guest', 'minutes', -1.25)).toBe('−1.3 min');
  });
  it('clock, duration, offset, age, probability, epoch', () => {
    expect(f.formatSimClock(null, '09:00')).toBe(f.EM_DASH);
    expect(f.formatSimClock(3 * 3600_000 + 5000, '09:00', true)).toBe('12:00:05 PM');
    expect(f.formatSimClock(15 * 3600_000 + 60_000, '09:00')).toBe('12:01 AM');
    expect(() => f.parseOpenLocal('9am')).toThrow();
    expect(f.formatDuration(null)).toBe(f.EM_DASH);
    expect(f.formatDuration(3_725_000)).toBe('1h 02m');
    expect(f.formatDuration(65_000)).toBe('1m 05s');
    expect(f.formatDuration(-5000)).toBe('−5s');
    expect(f.formatSimOffset(3_725_000)).toBe('+01:02:05');
    expect(f.formatAge(null)).toBe(f.EM_DASH);
    expect(f.formatAge(30_000)).toBe('30s');
    expect(f.formatAge(600_000)).toBe('10 min');
    expect(f.formatAge(7_200_000)).toBe('2.0 h');
    expect(f.formatProbability(0.0001)).toBe('<0.1%');
    expect(f.formatProbability(NaN)).toBe(f.EM_DASH);
    expect(f.formatProbability(0.5)).toBe('50.0%');
    expect(f.formatEpoch(null)).toBe(f.EM_DASH);
    expect(f.formatEpoch(0)).toBe('1970-01-01 00:00:00 UTC');
  });
  it('park-local parsing edge cases', () => {
    expect(f.parseParkLocalTime('nonsense', '09:00', 36e6).ok).toBe(false);
    expect(f.parseParkLocalTime('10:61', '09:00', 36e6).ok).toBe(false);
    expect(f.parseParkLocalTime('13 pm', '09:00', 36e6).ok).toBe(false);
    expect(f.parseParkLocalTime('25:00', '09:00', 36e6).ok).toBe(false);
    expect(f.parseParkLocalTime('8:59', '09:00', 36e6).ok).toBe(false);
    expect(f.parseParkLocalTime('12pm', '09:00', 36e6)).toEqual({ ok: true, simMs: 3 * 3600_000 });
  });
});

describe('sampling branches', () => {
  it('final interval absorbs round-off; empty distribution throws', () => {
    expect(inverseCdfChoice([{ optionId: 'b', probability: 0.5 }, { optionId: 'a', probability: 0.4999999 }], 0.99999999)).toBe('b');
    expect(() => inverseCdfChoice([], 0.5)).toThrow();
  });
});

describe('store/connection branches', () => {
  it('patch before snapshot is buffered; setError/status; agent field changes replace identity', () => {
    const s = new LiveStore();
    s.reset('r1');
    expect(s.applyPatch(patch(0, 1))).toBe('no_snapshot');
    expect(s.bufferedCount()).toBe(1);
    s.applySnapshot(snapshot(1, [agent('a1', 1, 10, { rating: { value: 50, atMs: 0, source: 'mock' } })]));
    const before = s.getState().agents.get('a1');
    s.applyPatch(patch(1, 2, [agent('a1', 1, 10, { rating: { value: 75, atMs: 0, source: 'mock' } })], {
      places: [{ placeId: 'p', closed: false, boardText: null, boardVersion: '1', noticeVersion: '1', predictedWaitMs: null }],
      queues: [{ placeId: 'p', standardPersons: 0, passPersons: 0, entries: [] }], appendedEvents: [event(5)],
    }));
    expect(s.getState().agents.get('a1')).not.toBe(before);
    const places = s.getState().places;
    s.applyPatch(patch(2, 3, [], { places: [{ placeId: 'p', closed: false, boardText: null, boardVersion: '1', noticeVersion: '1', predictedWaitMs: null }], queues: [{ placeId: 'p', standardPersons: 0, passPersons: 0, entries: [] }] }));
    expect(s.getState().places).toBe(places);
    s.setStatus('reconnecting');
    expect(s.getState().status).toBe('reconnecting');
    s.setError(domainError('FORBIDDEN', 'x'));
    expect(s.getState().status).toBe('error');
    s.setError(null);
  });
  it('connection forwards status/errors, resyncs on gap, ignores old subscriptions', async () => {
    let handlers: Parameters<RuntimeClient['subscribeLive']>[1] | null = null;
    const unsub = vi.fn();
    const client = {
      subscribeLive: vi.fn((_id, h) => { handlers = h; return unsub; }),
      query: vi.fn(async () => snapshot(9, [agent('a1', 9)])),
    } as unknown as RuntimeClient;
    const c = new LiveConnection(client);
    c.connect('r1');
    c.connect('r1'); // idempotent
    expect(client.subscribeLive).toHaveBeenCalledTimes(1);
    handlers!.status('connecting');
    handlers!.snapshot(snapshot(1, [agent('a1', 1)]));
    handlers!.status('live');
    handlers!.patch(patch(5, 6));
    await vi.waitFor(() => expect(c.store.getState().revision).toBe(9));
    handlers!.status('reconnecting');
    expect(c.store.getState().status).toBe('reconnecting');
    handlers!.error(domainError('FORBIDDEN', 'revoked'));
    expect(c.store.getState().error?.code).toBe('FORBIDDEN');
    const old = handlers!;
    c.connect('r2');
    expect(unsub).toHaveBeenCalled();
    old.snapshot(snapshot(50, []));
    expect(c.store.getState().revision).toBe(-1);
    c.disconnect();
  });
  it('resync failure surfaces an error; subscribe throwing is an error state', async () => {
    const client = { subscribeLive: vi.fn(() => { throw makeRuntimeClientError(domainError('DEPENDENCY_UNAVAILABLE', 'down', true), true); }),
      query: vi.fn(async () => { throw makeRuntimeClientError(domainError('INTERNAL', 'boom'), false); }) } as unknown as RuntimeClient;
    const c = new LiveConnection(client);
    c.connect('r1');
    expect(c.store.getState().status).toBe('error');
    await c.resync('r1');
    expect(c.store.getState().error?.message).toBe('boom');
  });
});

describe('commands/work/errors/tokens branches', () => {
  it('non-transport throw is a rejection; pending snapshot updates; subscribe/unsubscribe', async () => {
    const client = { command: vi.fn(async () => { throw new Error('reducer trap'); }) } as unknown as RuntimeClient;
    const r = new CommandRunner(client, { sleep: async () => undefined });
    const l = vi.fn();
    const off = r.subscribe(l);
    const out = await r.run('startRun', { runId: 'x' }, 'k');
    expect(out).toMatchObject({ kind: 'rejected', error: { code: 'INTERNAL', message: 'reducer trap' } });
    expect(l).toHaveBeenCalled();
    off();
    expect(r.commandIdFor('k')).toBeNull();
  });
  it('session intent store round-trips and tolerates bad JSON', () => {
    const s = sessionIntentStore('t.');
    s.set('a', { commandId: 'c1', payload: 'p' });
    expect(s.get('a')).toEqual({ commandId: 'c1', payload: 'p' });
    sessionStorage.setItem('t.bad', '{');
    expect(s.get('bad')).toBeNull();
    s.delete('a');
    expect(s.get('a')).toBeNull();
    const m = memoryIntentStore(); m.set('x', { commandId: 'y', payload: 'z' }); m.delete('x'); expect(m.get('x')).toBeNull();
  });
  it('work polling: terminal, abort, timeout', async () => {
    let n = 0;
    const client = { query: vi.fn(async () => ({ workId: 'w', kind: 'thought', status: ++n > 2 ? 'failed' : 'pending', result: null, error: null })) } as unknown as RuntimeClient;
    expect((await awaitWork(client, 'w', { sleep: async () => undefined })).status).toBe('failed');
    const ctrl = new AbortController(); ctrl.abort();
    await expect(awaitWork(client, 'w', { signal: ctrl.signal })).rejects.toBeInstanceOf(AbortedError);
    const stuck = { query: vi.fn(async () => ({ workId: 'w', kind: 'thought', status: 'leased', result: null, error: null })) } as unknown as RuntimeClient;
    let t = 0;
    await expect(awaitWork(stuck, 'w', { sleep: async () => undefined, now: () => (t += 1000), timeoutMs: 3000 })).rejects.toThrow(/still leased/);
  });
  it('error classification and token stores', () => {
    expect(classifyError('plain').error.code).toBe('INTERNAL');
    expect(classifyError(makeRuntimeClientError(domainError('CONFLICT', 'c'), false))).toMatchObject({ transport: false, error: { code: 'CONFLICT' } });
    expect(isAccessError('FORBIDDEN') && isAccessError('UNAUTHORIZED') && !isAccessError('CONFLICT')).toBe(true);
    const t = browserTokenStore('fixture'); t.set('abc'); expect(t.get()).toBe('abc'); t.clear(); expect(t.get()).toBeNull();
    const l = browserTokenStore('live'); l.set('x'); expect(localStorage.getItem('behavior-engine.session-token.v1')).toBe('x'); l.clear();
    const mem = memoryTokenStore('a'); mem.clear(); expect(mem.get()).toBeNull();
  });
});
