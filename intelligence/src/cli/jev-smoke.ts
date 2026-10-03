/**
 * Bounded, opt-in, BILLABLE Jev smoke test (acceptance B-22). Never run by CI or unit tests.
 *
 *   JEV_API_KEY=... npm run smoke:jev -- --billable [--max-calls 2] [--max-usd 0.01] [--capture]
 *
 * Sends at most `--max-calls` requests (one decision, optionally one rating) built from the
 * conformance fixture, validates them through the real adapter, and prints sanitized evidence.
 * Without `--billable` or a key it prints NOT RUN and exits with code 2.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { DecisionRequest, RatingRequest } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../core/canonical.ts';
import { sanitize } from '../core/errors.ts';
import { validateDistribution } from '../core/validate.ts';
import { RUBRICS, validateRatingOutput } from '../measurements/rating.ts';
import { FetchHttp } from '../providers/http.ts';
import { DEFAULT_JEV_MODEL, JevProvider } from '../providers/jev.ts';
import { systemClock } from '../runtime/clock.ts';

const { values } = parseArgs({
  options: {
    billable: { type: 'boolean', default: false },
    'max-calls': { type: 'string', default: '2' },
    'max-usd': { type: 'string', default: '0.01' },
    capture: { type: 'boolean', default: false },
  },
});

const key = process.env.JEV_API_KEY ?? '';
const notRun = (reason: string) => {
  console.log(JSON.stringify({ gate: 'B-22 real-Jev smoke', status: 'NOT RUN', reason }));
  process.exit(2);
};
if (!values.billable) notRun('--billable flag not supplied (this command spends provider credit)');
if (!key) notRun('JEV_API_KEY is not set');

const maxCalls = Math.min(3, Math.max(1, Number(values['max-calls'])));
const maxUsd = Number(values['max-usd']);
const endpoint = process.env.JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone';
const model = process.env.JEV_MODEL ?? DEFAULT_JEV_MODEL;
const provider = new JevProvider({ endpoint, apiKey: key, model, timeoutMs: 15_000, maxResponseBytes: 256 * 1024, retryAfterCapMs: 60_000 }, new FetchHttp(systemClock), systemClock);

const fixtures = JSON.parse(readFileSync(new URL('../../fixtures/conformance-fixtures.json', import.meta.url), 'utf8')) as { decisionRequest: DecisionRequest };
const decision = fixtures.decisionRequest;
const report: Record<string, unknown> = { gate: 'B-22 real-Jev smoke', endpoint, modelRequested: model, startedAt: new Date().toISOString(), calls: [] as unknown[] };
let spent = 0;

async function call(name: string, fn: () => Promise<{ raw: Uint8Array; usage: { inputTokens: number | null; costUsd: number | null }; modelReturned: string; check: string }>) {
  if ((report.calls as unknown[]).length >= maxCalls || spent >= maxUsd) return;
  try {
    const r = await fn();
    spent += r.usage.costUsd ?? 0;
    const raw = sanitize(new TextDecoder().decode(r.raw), [key]);
    (report.calls as unknown[]).push({ name, ok: true, modelReturned: r.modelReturned, usage: r.usage, validation: r.check, rawSha256: hashCanonical(raw) });
    if (values.capture) {
      mkdirSync(new URL('../../fixtures/jev/captured/', import.meta.url), { recursive: true });
      writeFileSync(new URL(`../../fixtures/jev/captured/${name}-${Date.now()}.json`, import.meta.url), `${JSON.stringify({ provenance: `CAPTURED ${new Date().toISOString()} from ${endpoint}, sanitized`, body: JSON.parse(raw) }, null, 2)}\n`);
    }
  } catch (e) {
    (report.calls as unknown[]).push({ name, ok: false, error: sanitize(String((e as Error).message), [key]), kind: (e as { kind?: string }).kind ?? null });
  }
}

await call('decision', async () => {
  const r = await provider.decide(decision, { signal: new AbortController().signal, callId: 'smoke-decision' });
  const v = validateDistribution(decision.options.map((o) => o.id), r.probabilities);
  return { raw: r.raw, usage: r.usage, modelReturned: r.modelReturned, check: v.ok ? 'valid distribution' : `INVALID: ${v.errors.map((e) => e.message).join('; ')}` };
});

if (maxCalls >= 2) {
  const obs = decision.observation;
  const rating: RatingRequest = {
    ratingId: 'smoke-rating', runId: 'smoke', agentId: obs.leaderId, atMs: obs.atMs, endpoint: 'periodic',
    evidenceHash: hashCanonical(obs), observation: obs, rubricVersion: 'satisfaction-rubric-v1', levels: [...RUBRICS['satisfaction-rubric-v1']!.levels],
  };
  await call('rating', async () => {
    const r = await provider.rate(rating, { signal: new AbortController().signal, callId: 'smoke-rating' });
    const v = validateRatingOutput(rating, r.probabilities, r.score);
    return { raw: r.raw, usage: r.usage, modelReturned: r.modelReturned, check: v.ok ? `valid rating index ${v.scoreIndex}` : `INVALID: ${v.reason}` };
  });
}

report.finishedAt = new Date().toISOString();
report.reportedSpendUsd = spent;
report.status = (report.calls as { ok: boolean }[]).every((c) => c.ok) ? 'RAN (see per-call validation)' : 'RAN WITH ERRORS';
console.log(JSON.stringify(report, null, 2));
