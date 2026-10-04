import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionRequest } from '../../contract/behavior-v1.ts';
import { FetchHttp } from '../../src/providers/http.ts';
import { JevProvider } from '../../src/providers/jev.ts';
import { BatchingJevProvider, JEV_BATCH_INSTRUCTIONS_VERSION, buildBatchBody } from '../../src/providers/jev-batch.ts';
import { ProviderError } from '../../src/providers/types.ts';
import { systemClock } from '../../src/runtime/clock.ts';
import { conformance } from '../helpers/fixtures.ts';
import { fakeHttp, json } from '../helpers/http-server.ts';

const API_KEY = 'jv_live_SECRETSECRET123456';
let closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers) await c(); closers = []; });

const variant = (i: number): DecisionRequest => {
  const r = structuredClone(conformance().decisionRequest);
  r.requestId = `decision:g${i}:1:r0`;
  r.observation.wallet.balanceCents += i;
  return r;
};

/** Answers every question with a distribution that favours option index (q index mod n). */
function answerAll(body: string, extra: (q: string) => Record<string, unknown> = () => ({})) {
  const parsed = JSON.parse(body) as { questions: Record<string, { type: string; criteria: Record<string, string> }> };
  const answers: Record<string, unknown> = {};
  for (const [q, spec] of Object.entries(parsed.questions)) {
    const keys = Object.keys(spec.criteria);
    const fav = Number(q.slice(1)) % keys.length;
    answers[q] = { type: 'choice', choice: keys[fav], confidence: 0.9, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === fav ? 0.8 : 0.2 / (keys.length - 1)])), ...extra(q) };
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1000 * Object.keys(answers).length, output_tokens: 40 * Object.keys(answers).length } };
}

async function setup(responder: Parameters<typeof fakeHttp>[0], cfg: Partial<ConstructorParameters<typeof BatchingJevProvider>[1]> = {}) {
  const http = await fakeHttp(responder);
  closers.push(http.close);
  const jev = new JevProvider({ endpoint: http.url, apiKey: API_KEY, model: 'jev-1.13.0', timeoutMs: 5000, maxResponseBytes: 1024 * 1024, retryAfterCapMs: 60_000 }, new FetchHttp(systemClock), systemClock);
  const batch = new BatchingJevProvider(jev, { maxItems: 8, maxInputTokens: 1_000_000, lingerMs: 20, maxInFlight: 2, minIntervalMs: 0, ...cfg }, systemClock);
  return { http, batch };
}
const ctx = (i: number) => ({ signal: new AbortController().signal, callId: `call-${i}` });

describe('batched Jev calls', () => {
  it('builds one question per request, each bound to its own observation key', () => {
    const body = buildBatchBody([{ kind: 'decision', req: variant(0) }, { kind: 'decision', req: variant(1) }], 'jev-1.13.0');
    expect(Object.keys(body.questions)).toEqual(['q0', 'q1']);
    const state = JSON.parse(body.state);
    expect(state.items.q1).toEqual(variant(1).observation);
    expect(body.questions.q1!.instructions).toContain('state.items.q1');
    expect(Object.keys(body.questions.q0!.criteria as Record<string, string>)).toEqual(variant(0).promptOptionOrder);
    expect(JSON.stringify(body)).not.toContain('decision:g1:1:r0');
  });

  it('answers many concurrent decisions with few HTTP calls and maps each answer to its request', async () => {
    const { http, batch } = await setup((hit, _n, res) => json(res, 200, answerAll(hit.body)));
    const reqs = Array.from({ length: 20 }, (_, i) => variant(i));
    const out = await Promise.all(reqs.map((r, i) => batch.decide(r, ctx(i))));
    expect(http.hits.length).toBe(3); // 8 + 8 + 4
    expect(batch.instructionsVersion).toBe(JEV_BATCH_INSTRUCTIONS_VERSION);
    out.forEach((d, i) => {
      const keys = variant(i).promptOptionOrder;
      const fav = (i % 8) % keys.length;
      const top = (d.probabilities as { optionId: string; probability: number }[]).reduce((a, b) => (b.probability > a.probability ? b : a));
      expect(top.optionId).toBe(keys[fav]);
      expect(d.usage.inputTokens).toBe(1000);
      expect(d.reasoning ?? null).toBeNull();
    });
  });

  it('surfaces provider reasoning text when an answer carries one', async () => {
    const { batch } = await setup((hit, _n, res) => json(res, 200, answerAll(hit.body, (q) => ({ reasoning: `because ${q}` }))));
    const d = await batch.decide(variant(0), ctx(0));
    expect(d.reasoning).toBe('because q0');
  });

  it('splits a batch the vendor rejects for size and fails only a missing answer', async () => {
    let calls = 0;
    const { batch } = await setup((hit, _n, res) => {
      calls++;
      const n = Object.keys(JSON.parse(hit.body).questions).length;
      if (n > 2) return json(res, 400, { detail: { error_type: 'max_tokens_exceeded' } });
      const body = answerAll(hit.body);
      if (n === 2) delete (body.answers as Record<string, unknown>).q1;
      return json(res, 200, body);
    });
    const results = await Promise.allSettled([0, 1, 2, 3].map((i) => batch.decide(variant(i), ctx(i))));
    expect(calls).toBe(3); // 4 rejected, then 2 + 2
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(ProviderError);
  });
});
