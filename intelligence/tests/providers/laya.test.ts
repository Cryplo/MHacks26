import { afterEach, expect, it } from 'vitest';
import { fixtureDecisionRequest } from '../../src/fixtures/orchestration.ts';
import { compactObservation, LAYA_MODEL, LayaProvider } from '../../src/providers/laya.ts';
import { fakeHttp, json } from '../helpers/http-server.ts';
import type { RatingRequest } from '../../contract/behavior-v1.ts';
import { RUBRICS } from '../../src/measurements/rating.ts';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });
const ctx = () => ({ signal: new AbortController().signal, callId: 'local-test' });

it('batches independent states, restores option IDs and stores exact compact inputs as local evidence', async () => {
  const server = await fakeHttp((hit, _, res) => {
    const input = JSON.parse(hit.body);
    json(res, 200, { model: LAYA_MODEL, results: input.items.map((item: { question: { criteria: Record<string, string> } }) => ({ probabilities: Object.fromEntries(Object.keys(item.question.criteria).map((key, i) => [key, [0.2, 0.3, 0.5][i]])), confidence: 0.5, inputTokens: 150, truncated: false })) });
  }); closers.push(server.close);
  const provider = new LayaProvider(server.url);
  const a = fixtureDecisionRequest(), b = structuredClone(a);
  b.observation.wallet.balanceCents = 12345;
  const results = await Promise.all([provider.decide(a, ctx()), provider.decide(b, ctx())]);
  expect(server.hits).toHaveLength(1);
  const inputs = JSON.parse(server.hits[0]!.body).items;
  expect(inputs[0].state).not.toEqual(inputs[1].state);
  expect(inputs[1].state).toContain('$123.45');
  expect(provider.source).toBe('laya');
  expect(results[0]!.probabilities.map(p => p.optionId)).toEqual(a.promptOptionOrder);
  expect(results[0]!.usage.costUsd).toBe(0);
  expect(results[0]!.reasoning).toBeUndefined();
  expect(JSON.parse(new TextDecoder().decode(results[0]!.raw)).input).toEqual(inputs[0]);
});

it.each(['wrong-model', 'truncated', 'missing-option', 'extra-option'])('rejects %s instead of claiming valid local evidence', async (failure) => {
  const server = await fakeHttp((hit, _, res) => {
    const criteria = JSON.parse(hit.body).items[0].question.criteria;
    const probabilities = Object.fromEntries(Object.keys(criteria).map(key => [key, 1 / 3]));
    if (failure === 'missing-option') delete probabilities.o0;
    if (failure === 'extra-option') probabilities.extra = 0;
    json(res, 200, { model: failure === 'wrong-model' ? 'other' : LAYA_MODEL, results: [{ probabilities, confidence: 0.5, inputTokens: 100, truncated: failure === 'truncated' }] });
  }); closers.push(server.close);
  await expect(new LayaProvider(server.url).decide(fixtureDecisionRequest(), ctx())).rejects.toMatchObject({ kind: 'invalid_output' });
});

it('maps a rating distribution to an expected level without fabricated prose', async () => {
  const server = await fakeHttp((_, __, res) => json(res, 200, { model: LAYA_MODEL, results: [{ probabilities: { 0: 0.1, 1: 0.1, 2: 0.2, 3: 0.3, 4: 0.3 }, confidence: 0.3, inputTokens: 99, truncated: false }] }));
  closers.push(server.close);
  const observation = fixtureDecisionRequest().observation;
  const req = { observation, agentId: observation.members[0]!.persona.agentId, levels: [...RUBRICS['satisfaction-rubric-v1']!.levels] } as RatingRequest;
  const result = await new LayaProvider(server.url).rate(req, ctx());
  expect(result.score).toBeCloseTo(2.6);
  expect(result.probabilities).toHaveLength(5);
});

it('does not send cancelled work or allow a remote endpoint', async () => {
  expect(() => new LayaProvider('https://example.com')).toThrow('loopback');
  const signal = AbortSignal.abort();
  await expect(new LayaProvider().decide(fixtureDecisionRequest(), { signal, callId: 'cancelled' })).rejects.toMatchObject({ kind: 'aborted' });
});

it('compresses only observed guest information, including the shared wallet', () => {
  const req = fixtureDecisionRequest();
  expect(compactObservation(req.observation)).not.toContain(req.runId);
  expect(compactObservation(req.observation)).toContain('Shared budget');
});
