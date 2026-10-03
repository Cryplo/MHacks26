import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, RatingRequest } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../../src/core/canonical.ts';
import { decisionCacheKey, ratingCacheKey } from '../../src/cache/key.ts';
import { InflightCoalescer, ResponseCache, exportResponseTape } from '../../src/cache/response-cache.ts';
import { MockProvider } from '../../src/providers/mock.ts';
import { ProviderError } from '../../src/providers/types.ts';
import { ManualClock, MemoryLogger, SequenceJitter } from '../../src/runtime/clock.ts';
import { CounterIds } from '../../src/runtime/commands.ts';
import { FileStore, MemoryStore, jsonBytes } from '../../src/runtime/store.ts';
import { InferenceService } from '../../src/worker/inference.ts';
import type { CacheEntry } from '../../src/worker/ports.ts';
import { UsageLedger } from '../../src/worker/usage.ts';
import { conformance } from '../helpers/fixtures.ts';
import { ScriptedJev, rehash } from '../helpers/providers.ts';
import { fakeServer } from '../helpers/runtime.ts';
import { pump, settle } from '../helpers/worker.ts';

const jev = { source: 'jev' as const, model: 'jev-1.13.0', instructionsVersion: 'jev-instructions-v1' };
const base = (): DecisionRequest => {
  const r = structuredClone(conformance().decisionRequest);
  r.options.push({
    id: 'pass_splash', label: 'Buy passes and join', description: 'Pass lane for all three.',
    action: { kind: 'buy_pass_and_join', placeId: 'splash', riderIds: ['a001', 'a002', 'a003'], quote: { quoteId: 'q1', revision: '1', productId: 'pass', unitPriceCents: 1500, quantity: 3, totalCents: 4500, beneficiaryIds: ['a001', 'a002', 'a003'], validUntilMs: 3605000, discountMessageId: null } },
  });
  r.promptOptionOrder = [...r.promptOptionOrder, 'pass_splash'];
  return rehash(r);
};
const key = (r: DecisionRequest) => decisionCacheKey(r, jev);

describe('B-09 exact cache keys', () => {
  const k0 = key(base());
  const variant = (mut: (r: DecisionRequest) => void) => { const r = base(); mut(r); return key(rehash(r)); };

  it.each<[string, (r: DecisionRequest) => void]>([
    ['board text', (r) => { r.observation.facts[0]!.text = 'Splash Falls - 40 minutes'; }],
    ['trailing whitespace in observed text (no trimming)', (r) => { r.observation.facts[0]!.text += ' '; }],
    ['pass price', (r) => { const a = r.options[3]!.action as Extract<DecisionRequest['options'][number]['action'], { kind: 'buy_pass_and_join' }>; a.quote.unitPriceCents = 2500; a.quote.totalCents = 7500; }],
    ['price by one cent (no coarsening)', (r) => { const a = r.options[3]!.action as Extract<DecisionRequest['options'][number]['action'], { kind: 'buy_pass_and_join' }>; a.quote.unitPriceCents = 1501; a.quote.totalCents = 4503; }],
    ['budget', (r) => { r.observation.wallet.balanceCents = 3999; }],
    ['backstory', (r) => { r.observation.members[0]!.persona.backstory += ' Loves water rides.'; }],
    ['memory', (r) => { r.observation.recentEventSummaries[0]!.text = 'Finished a long rest.'; }],
    ['goal', (r) => { r.observation.members[0]!.persona.mustDoPlaceIds = []; }],
    ['needs', (r) => { r.observation.members[1]!.needs.hunger = 71; }],
    ['route argument', (r) => { (r.options[2]!.action as { routeProfileId: string | null }).routeProfileId = 'scenic'; }],
    ['option description', (r) => { r.options[0]!.description = 'Wander.'; }],
    ['prompt option order', (r) => { r.promptOptionOrder = ['browse', 'travel_splash', 'leave', 'pass_splash']; }],
    ['policy version', (r) => { r.policyVersion = 'fixture-policy-v2'; }],
    ['moment', (r) => { r.moment = 'hungry_tired'; }],
  ])('changes with %s', (_label, mut) => {
    expect(variant(mut)).not.toBe(k0);
  });

  it('changes with requested model, provider source or instructions version', () => {
    expect(decisionCacheKey(base(), { ...jev, model: 'jev-1.14.0' })).not.toBe(k0);
    expect(decisionCacheKey(base(), { ...jev, source: 'mock' })).not.toBe(k0);
    expect(decisionCacheKey(base(), { ...jev, instructionsVersion: 'jev-instructions-v2' })).not.toBe(k0);
  });

  it('is unchanged by request/run IDs and transport bookkeeping', () => {
    expect(variant((r) => {
      r.requestId = 'decision:g001:4:r7'; r.runId = 'other-run-B'; r.requestRevision = 3; r.decisionSeq = 9; r.momentSeq = 5;
      r.createdAtMs = 3_590_000; r.planRevision = 8; r.dependencyRevisions = { 'plan:g001': '8' }; r.candidateAudit = { considered: [], excluded: [] };
    })).toBe(k0);
  });

  it('rating keys change with rubric/levels/member/evidence but not rating ID', () => {
    const obs = conformance().decisionRequest.observation;
    const rr: RatingRequest = { ratingId: 'r1', runId: 'x', agentId: 'a001', atMs: 1, endpoint: 'periodic', evidenceHash: hashCanonical(obs), observation: obs, rubricVersion: 'satisfaction-rubric-v1', levels: ['a', 'b', 'c'] };
    const k = ratingCacheKey(rr, jev);
    expect(ratingCacheKey({ ...rr, ratingId: 'r2', runId: 'y' }, jev)).toBe(k);
    expect(ratingCacheKey({ ...rr, levels: ['a', 'b', 'd'] }, jev)).not.toBe(k);
    expect(ratingCacheKey({ ...rr, rubricVersion: 'satisfaction-rubric-v2' }, jev)).not.toBe(k);
    expect(ratingCacheKey({ ...rr, agentId: 'a002' }, jev)).not.toBe(k);
    expect(ratingCacheKey({ ...rr, evidenceHash: 'f'.repeat(64) }, jev)).not.toBe(k);
  });
});

function infra<P extends ScriptedJev | MockProvider = ScriptedJev>(provider: P = new ScriptedJev() as P, store = new MemoryStore()) {
  const clock = new ManualClock();
  const { server } = fakeServer({}, clock);
  const client = server.client('worker');
  const logger = new MemoryLogger();
  const ledger = new UsageLedger(store, client, { clock, jitter: new SequenceJitter([0.5]), logger });
  const cache = new ResponseCache(store);
  const coalescer = new InflightCoalescer();
  const inference = new InferenceService(
    { provider, client, ledger, store, clock, jitter: new SequenceJitter([0.5]), ids: new CounterIds('c'), logger, cache, coalescer },
    { maxAttempts: 2, backoff: { baseMs: 10, maxMs: 10 }, namespace: () => 'exp/e1', billingOwnerRunId: (s) => s.runId },
  );
  return { clock, server, store, ledger, cache, coalescer, inference, provider, logger };
}
const sig = () => new AbortController().signal;
const scopeA = { runId: 'run-A', experimentId: 'e1' };

describe('B-09 cache hits within an experiment namespace', () => {
  it('second identical request is a cache hit with original source preserved; no TTL effect', async () => {
    const t = infra();
    const r1 = await t.inference.decide('w1', scopeA, base(), sig());
    t.clock.advance(30 * 24 * 3_600_000);
    const other = base(); other.requestId = 'decision:g001:4:r1'; other.runId = 'run-B';
    const r2 = await t.inference.decide('w2', { runId: 'run-B', experimentId: 'e1' }, other, sig());
    expect(t.provider.calls).toBe(1);
    expect(r1.source).toBe('jev');
    expect(r2.source).toBe('cache');
    expect(r2.originalSource).toBe('jev');
    expect(r2.probabilities).toEqual(r1.probabilities);
    expect(r2.responseArtifact).toEqual(r1.responseArtifact);
    expect(r2.usage.callId).toBeNull();
    expect(r2.cacheKey).toBe(r1.cacheKey);
    expect(await t.cache.links('exp/e1', r1.cacheKey!)).toEqual(['decision:g001:4:r0', 'decision:g001:4:r1']);
  });
});

describe('B-10 coalescing, invalid results, write-once and provenance', () => {
  it('concurrent identical requests make exactly one provider call', async () => {
    const t = infra();
    let open!: () => void;
    (t.provider as ScriptedJev).gate = new Promise((r) => { open = r; });
    const ps = Array.from({ length: 5 }, (_, i) => { const r = base(); r.requestId = `decision:g001:4:c${i}`; return t.inference.decide(`w${i}`, scopeA, r, sig()); });
    await settle();
    open();
    const rs = await Promise.all(ps);
    expect(t.provider.calls).toBe(1);
    expect(rs.filter((r) => r.source === 'jev')).toHaveLength(1);
    expect(rs.filter((r) => r.source === 'cache')).toHaveLength(4);
    expect(new Set(rs.map((r) => r.responseArtifact.sha256)).size).toBe(1);
    const recs = await t.ledger.records();
    expect(recs).toHaveLength(1);
    expect(recs[0]!.beneficiaries.sort()).toEqual(['w0', 'w1', 'w2', 'w3', 'w4']);
    const totals = await t.ledger.totals();
    expect(totals.calls).toBe(1);
    expect(totals.inputTokens).toBe(100);
  });

  it('invalid results are never cached', async () => {
    const t = infra();
    (t.provider as ScriptedJev).script = [() => ({ probabilities: [{ optionId: 'browse', probability: 0 }] }), () => ({ probabilities: [] })];
    await expect(t.inference.decide('w1', scopeA, base(), sig())).rejects.toMatchObject({ kind: 'invalid_output' });
    expect(await t.cache.entries('exp/e1')).toEqual([]);
    (t.provider as ScriptedJev).script = [];
    const r = await t.inference.decide('w1', scopeA, base(), sig());
    expect(r.source).toBe('jev');
  });

  it('transient failures do not poison the cache', async () => {
    const t = infra();
    (t.provider as ScriptedJev).script = [() => new ProviderError('transient', '503'), () => new ProviderError('transient', '503')];
    const p = t.inference.decide('w1', scopeA, base(), sig());
    await expect(pump(t.clock, p)).rejects.toMatchObject({ kind: 'transient' });
    expect(await t.cache.entries('exp/e1')).toEqual([]);
  });

  it('write-once: the first accepted value wins on FileStore under concurrent writers', async () => {
    const store = new FileStore(mkdtempSync(join(tmpdir(), 'cache-')));
    const cache = new ResponseCache(store);
    const mk = (p: number): CacheEntry => ({
      schema: 'response-cache-entry.v1', namespace: 'exp/e1', key: 'a'.repeat(64), kind: 'decision', modelRequested: 'm', modelReturned: 'm',
      policyVersion: 'p', instructionsVersion: 'i', originalSource: 'jev', probabilities: [{ optionId: 'x', probability: p }], score: null, confidence: null,
      responseArtifact: { artifactId: 'a', kind: 'model_response', sha256: 'b'.repeat(64), byteLength: 1, mediaType: 'application/json', contractVersion: 'behavior.v1' },
      normalization: { rawSum: 1, sumError: 0, appliedBy: 'engine' }, callId: `c${p}`, createdAtEpochMs: 0,
    });
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => cache.putIfAbsent(mk(i))));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const winner = results.find((r) => r.created)!.entry;
    for (const r of results) expect(r.entry).toEqual(winner);
    expect(await cache.get('exp/e1', 'a'.repeat(64))).toEqual(winner);
    expect((await store.list('cache/')).length).toBe(1);
  });

  it('a mock-originated entry is never accepted as a Jev cache hit', async () => {
    const t = infra();
    const r0 = base();
    const k = key(r0);
    const mockEntry: CacheEntry = {
      schema: 'response-cache-entry.v1', namespace: 'exp/e1', key: k, kind: 'decision', modelRequested: 'jev-1.13.0', modelReturned: 'mock-policy-v1',
      policyVersion: r0.policyVersion, instructionsVersion: 'jev-instructions-v1', originalSource: 'mock',
      probabilities: r0.options.map((o) => ({ optionId: o.id, probability: 0.25 })), score: null, confidence: null,
      responseArtifact: { artifactId: 'm', kind: 'model_response', sha256: 'c'.repeat(64), byteLength: 1, mediaType: 'application/json', contractVersion: 'behavior.v1' },
      normalization: { rawSum: 1, sumError: 0, appliedBy: 'engine' }, callId: null, createdAtEpochMs: 0,
    };
    await t.store.put(`cache/exp/e1/${k}`, jsonBytes(mockEntry));
    const r = await t.inference.decide('w1', scopeA, r0, sig());
    expect(t.provider.calls).toBe(1);
    expect(r.source).toBe('jev');
    expect(r.originalSource).toBe('jev');
    expect(r.probabilities.every((p) => p.probability !== 0.25)).toBe(true);
    expect(t.logger.text()).toMatch(/provenance/);
  });

  it('mock results keep mock provenance in the cache and tape', async () => {
    const t = infra(new MockProvider());
    await t.inference.decide('w1', scopeA, base(), sig());
    const r2 = await t.inference.decide('w2', scopeA, base(), sig());
    expect(r2.source).toBe('cache');
    expect(r2.originalSource).toBe('mock');
    const { tape, sha256 } = await exportResponseTape(t.cache, 'exp/e1');
    expect(tape.sourceCounts).toEqual({ mock: 1 });
    expect(tape.entries[0]!.rawPresent).toBe(true);
    expect(tape.entries[0]!.consumers).toEqual(['decision:g001:4:r0']);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await exportResponseTape(t.cache, 'exp/e1')).sha256).toBe(sha256);
  });
});
