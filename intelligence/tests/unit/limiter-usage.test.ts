import { describe, expect, it } from 'vitest';
import type { DecisionRequest } from '../../contract/behavior-v1.ts';
import { ResponseCache, InflightCoalescer } from '../../src/cache/response-cache.ts';
import { ProviderError } from '../../src/providers/types.ts';
import { ManualClock, MemoryLogger, SequenceJitter } from '../../src/runtime/clock.ts';
import { CounterIds } from '../../src/runtime/commands.ts';
import { MemoryStore } from '../../src/runtime/store.ts';
import { InferenceService } from '../../src/worker/inference.ts';
import type { LimiterConfig } from '../../src/worker/limiter.ts';
import { ProviderLimiter } from '../../src/worker/limiter.ts';
import type { ExecutorClass, Permit } from '../../src/worker/ports.ts';
import { UsageLedger, costFor, summarizeUsage } from '../../src/worker/usage.ts';
import { conformance } from '../helpers/fixtures.ts';
import { ScriptedJev, rehash } from '../helpers/providers.ts';
import { fakeServer } from '../helpers/runtime.ts';
import { buildWorker, pump, settle } from '../helpers/worker.ts';

const cfg = (over: Partial<LimiterConfig> = {}): LimiterConfig => ({
  requestsPerSecond: 5, requestBurst: 5, inputTokensPerMinute: 600_000, tokenBurst: 100_000,
  maxConcurrency: 100, reservedForBehavior: 1, maxQueue: 100, fairnessEvery: 3, ...over,
});

function harness(over: Partial<LimiterConfig> = {}) {
  const clock = new ManualClock();
  const limiter = new ProviderLimiter(cfg(over), clock);
  const granted: { cls: ExecutorClass; at: number; permit: Permit }[] = [];
  const acquire = (cls: ExecutorClass, tokens = 10, signal = new AbortController().signal) =>
    limiter.acquire(cls, tokens, signal).then((permit) => { granted.push({ cls, at: clock.nowEpochMs() - 1_700_000_000_000, permit }); return permit; });
  return { clock, limiter, granted, acquire };
}

describe('B-11 rate, token and concurrency limits', () => {
  it('request bucket: burst then steady rate under a burst of 12', async () => {
    const h = harness();
    const all = Array.from({ length: 12 }, () => h.acquire('behavior').then((p) => p.release()));
    await settle();
    expect(h.granted).toHaveLength(5);
    await pump(h.clock, Promise.all(all));
    expect(h.granted.map((g) => g.at)).toEqual([0, 0, 0, 0, 0, 200, 400, 600, 800, 1000, 1200, 1400]);
  });

  it('input-token bucket limits admission and charges actual usage', async () => {
    const h = harness({ inputTokensPerMinute: 6000, tokenBurst: 1000 });
    const p1 = await h.acquire('behavior', 600);
    p1.release({ inputTokens: 900 });
    const p2 = h.acquire('behavior', 600);
    await settle();
    expect(h.granted).toHaveLength(1);
    await pump(h.clock, p2);
    // 1000 - 900 = 100 left; need 600 -> 500 tokens at 100/s = 5000 ms
    expect(h.granted[1]!.at).toBe(5000);
  });

  it('bounded concurrency with behavior reservation and fairness', async () => {
    const h = harness({ maxConcurrency: 2, reservedForBehavior: 1, requestsPerSecond: 1000, requestBurst: 1000, fairnessEvery: 2 });
    const held: Permit[] = [];
    const b = Array.from({ length: 6 }, () => h.acquire('behavior').then((p) => { held.push(p); }));
    const m = h.acquire('measurement').then((p) => { held.push(p); });
    await settle();
    expect(h.granted.map((g) => g.cls)).toEqual(['behavior', 'behavior']);
    for (let i = 0; i < 6; i++) { held.shift()?.release(); await settle(); }
    await Promise.all([...b, m]);
    const order = h.granted.map((g) => g.cls);
    expect(order.indexOf('measurement')).toBeLessThan(order.length - 1);
    expect(order.filter((c) => c === 'measurement')).toHaveLength(1);
  });

  it('non-behavior classes can never take the reserved behavior slot', async () => {
    const h = harness({ maxConcurrency: 2, reservedForBehavior: 1, requestsPerSecond: 1000, requestBurst: 1000 });
    const t1 = await h.acquire('text');
    const t2 = h.acquire('text');
    const r1 = h.acquire('measurement');
    const b1 = h.acquire('behavior');
    await settle();
    expect(h.granted.map((g) => g.cls)).toEqual(['text', 'behavior']);
    t1.release(); await settle();
    expect(h.granted).toHaveLength(3);
    void t2; void r1; void b1;
  });

  it('queue bound rejects, cancellation removes waiters, Retry-After pauses admission', async () => {
    const h = harness({ maxQueue: 2, requestsPerSecond: 1, requestBurst: 1 });
    await h.acquire('behavior');
    const ac = new AbortController();
    const q1 = h.acquire('behavior', 10, ac.signal);
    const q2 = h.acquire('behavior');
    await expect(h.acquire('behavior')).rejects.toMatchObject({ kind: 'rate_limited' });
    ac.abort();
    await expect(q1).rejects.toMatchObject({ kind: 'aborted' });
    h.limiter.pauseUntil(h.clock.nowEpochMs() + 10_000);
    await pump(h.clock, q2);
    expect(h.granted[1]!.at).toBe(10_000);
  });

  it('operator stop and per-class budgets fail visibly', async () => {
    const h = harness({ budgets: { text: { maxCalls: 1 } } });
    await h.acquire('text');
    await expect(h.acquire('text')).rejects.toMatchObject({ kind: 'budget' });
    await h.acquire('behavior');
    h.limiter.stop('operator requested');
    await expect(h.acquire('behavior')).rejects.toMatchObject({ kind: 'budget' });
  });

  it('a worker with a limiter keeps behavior capacity while text jobs are saturated, and the experiment class is not claimed', async () => {
    const { server } = fakeServer();
    for (let i = 0; i < 4; i++) server.enqueueWork('decision', conformance().decisionRequest);
    const w = buildWorker(server.client('worker'), { options: { capacity: { behavior: 2, measurement: 1, text: 1, experiment: 0 } } });
    expect(await w.worker.runOnce()).toBe(2);
    await w.worker.drain();
    expect(await w.worker.runOnce()).toBe(2);
    await w.worker.drain();
    expect([...server.work.values()].every((x) => x.status === 'ready')).toBe(true);
    expect(server.commandLog.some((c) => c.name === 'claimWork' && c.identity === 'worker' && !c.applied)).toBe(false);
  });
});

describe('B-12 usage and billing ledger', () => {
  function infra() {
    const clock = new ManualClock();
    const { server } = fakeServer({}, clock);
    const client = server.client('worker');
    const store = new MemoryStore();
    const logger = new MemoryLogger();
    const ledger = new UsageLedger(store, client, { clock, jitter: new SequenceJitter([0.5]), logger });
    const provider = new ScriptedJev();
    const inference = new InferenceService(
      { provider, client, ledger, store, clock, jitter: new SequenceJitter([0.5]), ids: new CounterIds('u'), logger, cache: new ResponseCache(store), coalescer: new InflightCoalescer() },
      { maxAttempts: 3, backoff: { baseMs: 10, maxMs: 10 }, namespace: (s) => `exp/${s.experimentId}`, billingOwnerRunId: (s) => s.runId },
    );
    return { clock, server, ledger, provider, inference, store, client };
  }
  const variant = (n: number): DecisionRequest => { const r = structuredClone(conformance().decisionRequest); r.observation.wallet.balanceCents = 4000 + n; return rehash(r); };

  it('includes failed retries, keeps unknown usage unknown, and bills cache hits nothing', async () => {
    const t = infra();
    t.provider.script = [
      () => new ProviderError('rate_limited', '429', { retryAfterMs: 5, usage: { inputTokens: null, outputTokens: null, costUsd: null } }),
      () => new ProviderError('transient', '503'),
    ];
    const p = t.inference.decide('w1', { runId: 'A', experimentId: 'e' }, variant(1), new AbortController().signal);
    await pump(t.clock, p);
    t.provider.usage = { inputTokens: null, outputTokens: null, costUsd: null };
    await t.inference.decide('w2', { runId: 'B', experimentId: 'e' }, variant(2), new AbortController().signal);
    await t.inference.decide('w3', { runId: 'B', experimentId: 'e' }, variant(2), new AbortController().signal);
    const totals = await t.ledger.totals();
    expect(totals.calls).toBe(4);
    expect(totals.failedCalls).toBe(2);
    expect(totals.inputTokens).toBe(100);
    expect(totals.tokenCoverage).toBeCloseTo(1 / 4);
    expect(totals.unknownCostCalls).toBe(3);
    expect(totals.reportedCostUsd).toBeCloseTo(0.00004);
    expect(t.server.attempts.size).toBe(4);
    const byRun = Object.values(totals.byRun).reduce((s, r) => s + r.calls, 0);
    expect(byRun).toBe(totals.finishedCalls + 0);
    expect(totals.byRun.A!.calls).toBe(3);
    expect(totals.byRun.B!.calls).toBe(1);
  });

  it('duplicate telemetry cannot double-charge and finished never regresses to started', async () => {
    const t = infra();
    await t.inference.decide('w1', { runId: 'A', experimentId: 'e' }, variant(1), new AbortController().signal);
    await t.ledger.flush();
    await t.ledger.flush();
    const attempt = [...t.server.attempts.values()][0]!;
    expect(attempt.phase).toBe('finished');
    const r = await t.client.command('recordProviderAttempt', { attempt: { ...attempt, phase: 'started' } }, 'late-started');
    expect(r.ok && r.result.phase).toBe('finished');
    expect(t.server.attempts.size).toBe(1);
  });

  it('deferred telemetry is flushed after reconnect', async () => {
    const t = infra();
    t.server.faults.failBefore = { recordProviderAttempt: 6 };
    const p = t.inference.decide('w1', { runId: 'A', experimentId: 'e' }, variant(1), new AbortController().signal);
    await expect(pump(t.clock, p)).rejects.toBeTruthy();
    expect(t.provider.calls).toBe(0);
    t.server.faults.failBefore = {};
    await t.inference.decide('w1', { runId: 'A', experimentId: 'e' }, variant(1), new AbortController().signal);
    expect(t.provider.calls).toBe(1);
    expect([...t.server.attempts.values()].filter((a) => a.phase === 'finished')).toHaveLength(1);
  });

  it('cost basis: provider-reported, labeled estimate, or unknown', () => {
    expect(costFor({ inputTokens: 62, outputTokens: null, costUsd: 0.000026 }).basis).toBe('provider_reported');
    const est = costFor({ inputTokens: 62, outputTokens: null, costUsd: null });
    expect(est.basis).toBe('estimated');
    expect(est.priceVersion).toMatch(/estimate/);
    expect(costFor({ inputTokens: null, outputTokens: null, costUsd: null })).toEqual({ usd: null, basis: 'unknown', priceVersion: null });
    expect(summarizeUsage([]).calls).toBe(0);
  });
});
