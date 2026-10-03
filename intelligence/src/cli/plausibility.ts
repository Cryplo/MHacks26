/**
 * Plausibility lab (B-23). Always runs the mock-mechanical check offline; optionally runs the same
 * states against real Jev as a separately labeled observation (BILLABLE, bounded, opt-in):
 *
 *   npm run plausibility -- [--out evidence.json] [--samples 200]
 *   JEV_API_KEY=... npm run plausibility -- --jev --billable [--max-calls 22] [--max-usd 0.05]
 *
 * Without --jev/--billable/key the real-provider section is reported as NOT RUN.
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sanitize } from '../core/errors.ts';
import { fixtureDecisionRequest } from '../fixtures/orchestration.ts';
import { LAB_CASES, PLACEBOS, runPlausibilityLab } from '../plausibility/lab.ts';
import { FetchHttp } from '../providers/http.ts';
import { DEFAULT_JEV_MODEL, JevProvider } from '../providers/jev.ts';
import { MockProvider } from '../providers/mock.ts';
import type { BehaviorProvider } from '../providers/types.ts';
import { systemClock } from '../runtime/clock.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string' }, samples: { type: 'string', default: '200' },
    jev: { type: 'boolean', default: false }, billable: { type: 'boolean', default: false },
    'max-calls': { type: 'string', default: String(1 + PLACEBOS.length + 2 * LAB_CASES.length) },
    'max-usd': { type: 'string', default: '0.05' },
  },
});

const samples = Math.max(1, Math.min(10_000, Number(values.samples)));
const template = fixtureDecisionRequest();
const mock = await runPlausibilityLab({ provider: new MockProvider(), template, samplesPerState: samples });

const key = process.env.JEV_API_KEY ?? '';
const needed = 1 + PLACEBOS.length + 2 * LAB_CASES.length;
let real: unknown;
if (!values.jev) real = { status: 'NOT RUN', reason: '--jev not supplied' };
else if (!values.billable) real = { status: 'NOT RUN', reason: '--billable not supplied (real-provider lab spends provider credit)' };
else if (!key) real = { status: 'NOT RUN', reason: 'JEV_API_KEY is not set' };
else if (Number(values['max-calls']) < needed) real = { status: 'NOT RUN', reason: `--max-calls ${values['max-calls']} is below the ${needed} calls this lab needs` };
else {
  const maxUsd = Number(values['max-usd']);
  const jev = new JevProvider({ endpoint: process.env.JEV_ENDPOINT ?? 'https://api.typesafe.ai/v1/systemone', apiKey: key, model: process.env.JEV_MODEL ?? DEFAULT_JEV_MODEL, timeoutMs: 15_000, maxResponseBytes: 256 * 1024, retryAfterCapMs: 60_000 }, new FetchHttp(systemClock), systemClock);
  let calls = 0;
  let spent = 0;
  const bounded: BehaviorProvider = {
    source: jev.source, model: jev.model, instructionsVersion: jev.instructionsVersion, estimateInputTokens: (r) => jev.estimateInputTokens(r),
    decide: async (req, opts) => {
      if (calls >= Number(values['max-calls'])) throw new Error('call budget exhausted');
      if (spent >= maxUsd) throw new Error(`spend budget ${maxUsd} USD reached`);
      calls += 1;
      const r = await jev.decide(req, opts);
      spent += r.usage.costUsd ?? 0;
      return r;
    },
    rate: (req, opts) => jev.rate(req, opts),
  };
  const evidence = await runPlausibilityLab({ provider: bounded, template, samplesPerState: samples });
  real = { status: 'RAN', calls, reportedSpendUsd: spent, evidence };
}

const out = { mockMechanical: mock, realProvider: real };
const text = sanitize(JSON.stringify(out, null, 2), key ? [key] : []);
if (values.out) writeFileSync(values.out, `${text}\n`);
console.log(JSON.stringify({
  mockMechanical: { evidenceKind: mock.evidenceKind, model: mock.provider.modelRequested, summary: mock.summary, verdicts: Object.fromEntries(mock.cases.map((c) => [c.id, c.verdict])) },
  realProvider: (real as { status: string }).status === 'RAN'
    ? { status: 'RAN', summary: (real as { evidence: { summary: unknown } }).evidence.summary }
    : real,
  label: mock.label, wrote: values.out ?? null,
}, null, 2));
