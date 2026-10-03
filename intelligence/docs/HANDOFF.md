# Intelligence lane (B) handoff

## Repository state

| | |
|---|---|
| Branch | `feat/behavior-engine-intelligence` |
| Base | unborn `main` (no commits existed when work started; nothing to rebase onto) |
| HEAD | see `git log -1` (the commit that adds this file; previous code commit `739aa3d`) |
| Owned paths | `intelligence/**`, `.github/workflows/intelligence.yml` (nothing else touched) |
| Contract | `intelligence/contract/behavior-v1.ts`, sha256 `c25776a4883f70c71e8b4991dabc1b7a641baa8baeb615b1cfc145c0b8f1aac4` (checked by `npm run lint` and `npm run test:contract`) |

Commits (oldest first):

1. `d52bc65` package, frozen contract mirror, golden vectors and typed port fakes
2. `e480a70` deterministic population generator with exact counts, groups, hooks and frozen prose
3. `06d39c3` worker lease/journal/mock provider pipeline with durable submit, recovery and shutdown
4. `6330c19` Jev HTTP adapter, response mapping, Retry-After/backoff/fail-fast and opt-in billable smoke
5. `6254c15` exact write-once response cache, coalescing, provider limiter and usage ledger fixes
6. `376b675` deterministic crowd and scenario parsers, available-case rating summary
7. `e36c1e8` evidence narration, fact-grounded report narratives and text/rating job handlers
8. `b6858df` durable paired experiment coordinator, exact t intervals, preflight and fact-backed reports
9. `d726ffa` plausibility lab with placebo noise floor, worker/experiment/plausibility CLIs, readable experiment narrative
10. `739aa3d` B-22 billable-smoke gate, env names aligned with `.env.example`, explicit startup errors
11. this commit: docs, CI CLI smokes

No merge, rebase of another branch, force-push or deployment was performed.

## Versions and checksums

Node v26.7.0 (CI uses Node 22; `engines.node >= 22`), npm 11.19.0, TypeScript 6.0.3, Vitest 5.0.3 (+ `@vitest/coverage-v8` 5.0.3), ESLint 10.12.0, typescript-eslint 8.71.0, tsx 4.23.15, `@types/node` 26.6.4. No runtime dependencies (no vendor SDK).

| File | sha256 |
|---|---|
| `package-lock.json` | `5b33c50961bfebb85c65328118d990c28b66ce9f962ae81bce9baeac59bbacf9` |
| `contract/behavior-v1.ts` | `c25776a4883f70c71e8b4991dabc1b7a641baa8baeb615b1cfc145c0b8f1aac4` |
| `fixtures/conformance-fixtures.json` | `499eea76474de51246ecb634f9769383d8217c4681197dc5909c04e66464980b` |
| `fixtures/golden-vectors.json` | `8e4233df20aadd2c8d6119baf22ff6353f4b995fbbabd40151d9d99624687413` |
| `fixtures/population-300.fixture.json` | `080bd80765ec2130857f1c0059ad7f231e95a2bd6f78a3184a362b4967261402` |

## Commands and actual results (this machine, 2026-10-03)

All from `intelligence/` after `npm ci`.

| Command | Result |
|---|---|
| `npm run build` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0, `contract ok c25776a4…aac4` |
| `npm run test:unit` | 8 files, 116 passed |
| `npm run test:integration` | 2 files, 24 passed |
| `npm run test:contract` | contract hash ok; 2 files, 30 passed |
| `npm run test:providers` | 2 files, 36 passed (no network; loopback fake HTTP only) |
| `npm run test:experiments` | 2 files, 28 passed, **2 skipped** (real-Engine B-18/B-21, titled "NOT RUN when skipped: BEHAVIOR_RUNTIME_ADAPTER not set") |
| `npx vitest run --coverage` | statements 85.2%, branches 75.8%, functions 92.2%, lines 92.8% |
| `npm run population:fixture -- --out /tmp/p.json` | 300 guests, 142 groups; output byte-identical to the committed fixture |
| `npm run dev:worker` | fixture demo: population (300/142), parse_crowd, mock decision all `ready`; clean shutdown, exit 0 |
| `npm run experiment:mock` | 3/3 pairs complete (ORCHESTRATION-ONLY), report/facts/narrative/tape artifacts |
| `npm run plausibility` | mock-mechanical: 6 as_expected, 3 flat, 0 opposite; real-provider section NOT RUN |
| `npm run smoke:jev -- --billable` | NOT RUN (`JEV_API_KEY` not set; no credentials were authorized) |

The skipped tests are visible in Vitest output with their NOT RUN reason; nothing else is skipped.

## Acceptance coverage

"Fake" means the scripted fake RuntimeClient in `src/runtime/fake-runtime.ts`: it is orchestration-only and simulates no park.

| ID | Evidence | Where |
|---|---|---|
| B-01..B-04 | population determinism, validity, quotas, prose fallback, artifact reuse | `tests/unit/population.test.ts` |
| B-05, B-08 | fake port lease to mock distribution; lost-ack submit, expiry/renew/race/restart/supersession | `tests/integration/worker.test.ts` |
| B-06, B-07, B-15 | response mapping paths, malformed/oversized output, Retry-After, timeout, abort, backoff, 401/schema fail-fast, prompt injection; **against documentation-derived shapes, not captured responses** | `tests/providers/jev.test.ts` |
| B-09, B-10 | exact cache keys, write-once winner, coalescing, mock-cache provenance | `tests/unit/cache.test.ts` |
| B-11, B-12 | limiter bursts/fairness/reservation/shutdown, usage with retries and unknown usage; coordinator never claims behavior work | `tests/unit/limiter-usage.test.ts`, `tests/experiments/coordinator.test.ts` |
| B-13, B-14, B-16 | per-member ratings, scenario/crowd parsing, grounded narration and offline report fallback | `tests/integration/text-ratings.test.ts`, `tests/unit/text.test.ts`, `tests/unit/narration.test.ts` |
| B-17 | crash at 13 phases then restart: exactly 4 runs, each run advanced exactly 12 steps, same population/initial hashes/summaries as an uninterrupted run; warmup checkpoint reuse; superseded coordinator cannot advance, record progress or overwrite state; driver epoch bumps on takeover | `tests/experiments/coordinator.test.ts` |
| B-18 | **fake only**: A/A gives zero deltas, equal final hashes, arm B fully served from frozen A responses. Real Engine: NOT RUN | `coordinator.test.ts`, `engine-adapter.test.ts` |
| B-19 | price-only diff, mislabeled bundled change rejected, 1/2/3 seed counts, failed arm, missing rating coverage, degraded (mock in real-provider mode, including cache-hit provenance), all pairs preserved | `tests/unit/preflight.test.ts`, `coordinator.test.ts` |
| B-20 | golden vector, t quantiles for df 1, 2, 3, 4, 9, 29, 1000 to 1e-9, n=0/n=1, zero and negative deltas, unavailable denominators | `tests/unit/stats.test.ts` |
| B-21 | **fake only**: mock A/B 1500 to 2500 through the full worker + coordinator path. Real Engine: NOT RUN (test written, env-gated) | `coordinator.test.ts`, `engine-adapter.test.ts` |
| B-22 | billable smoke never runs implicitly; no test targets the production endpoint. Live smoke: NOT RUN | `tests/providers/smoke-gate.test.ts`, `src/cli/jev-smoke.ts` |
| B-23 | lab states/model/version/counts; mock-mechanical vs real-provider labeling; errors recorded, not dropped | `tests/unit/plausibility.test.ts` |
| B-24 | artifact and response-tape hashes, facts provenance, exact report shape, narrative validation, byte-identical re-finalize after crash | `coordinator.test.ts` |

## Incomplete gates (not run, not claimed)

1. **B-22 live Jev smoke and captured fixtures.** No `JEV_API_KEY` or budget was authorized. `fixtures/jev/documentation-derived.json` holds documentation-derived shapes from the public skill page, labeled as such, so B-06 is verified only against those shapes. To close: `JEV_API_KEY=… npm run smoke:jev -- --billable --max-calls 2 --max-usd 0.01 --capture`, then add the sanitized captures to the provider tests.
2. **B-18 / B-21 on the real Engine.** `engine/client/dist/node.js` does not exist on this branch. `tests/experiments/engine-adapter.test.ts` runs both once these are set: `BEHAVIOR_RUNTIME_ADAPTER`, `BEHAVIOR_RUNTIME_URI`, `BEHAVIOR_RUNTIME_DATABASE`, `BEHAVIOR_OPERATOR_TOKEN`, `BEHAVIOR_COORDINATOR_TOKEN`, `BEHAVIOR_WORKER_TOKEN`. The same path is available as `npm run experiment:mock -- --runtime spacetime`.
3. **Real-provider plausibility observation.** `npm run plausibility -- --jev --billable` (bounded to 22 calls and `--max-usd 0.05` by default). Not run.

Every report generated in this lane so far comes from the fixture runtime. None of them is a verified full-stack experiment.

## Environment variables

All listed in `.env.example`. Secrets are never logged: the JSON-lines logger sanitizes `JEV_API_KEY` and all tokens.

| Variable | Used by | Meaning |
|---|---|---|
| `BEHAVIOR_RUNTIME_MODE` | `dev:worker` | `fixture` (default; in-process fake + demo work) or `spacetime` (Engine adapter; no fallback) |
| `BEHAVIOR_RUNTIME_ADAPTER` | spacetime mode, Engine tests | path to Engine's built `engine/client/dist/node.js` exporting `createRuntimeClient` |
| `BEHAVIOR_RUNTIME_URI`, `BEHAVIOR_RUNTIME_DATABASE` | spacetime mode | `RuntimeConfig.uri` / `.database` |
| `BEHAVIOR_ROLE` | `dev:worker` | `worker` (decision, rating, population, parse_crowd, parse_scenario, thought, report) or `coordinator` (experiment only) |
| `BEHAVIOR_WORKER_TOKEN`, `BEHAVIOR_COORDINATOR_TOKEN`, `BEHAVIOR_OPERATOR_TOKEN` | spacetime | separate identities; the operator token is only for `experiment:mock --runtime spacetime` and the Engine tests |
| `BEHAVIOR_PROVIDER` | `dev:worker` | `mock` (default) or `jev` (requires `JEV_API_KEY`) |
| `JEV_API_KEY`, `JEV_ENDPOINT`, `JEV_MODEL` | Jev | default endpoint `https://api.typesafe.ai/v1/systemone`, model `jev-1.13.0` |
| `JEV_HTTP_TIMEOUT_MS`, `JEV_MAX_RESPONSE_BYTES` | Jev | defaults 10000 ms, 262144 bytes |
| `JEV_REQUESTS_PER_SECOND`, `JEV_INPUT_TOKENS_PER_MINUTE`, `JEV_MAX_CONCURRENCY`, `WORKER_QUEUE_LIMIT` | limiter | defaults 2 rps (burst 2), 60000 tokens/min (burst 20000), 4 concurrent with 1 reserved for behavior, queue 256 |
| `BEHAVIOR_MAX_PROVIDER_CALLS` | limiter | optional hard stop per executor class (visible `budget` error; the work fails with code `RATE_LIMITED`) |
| `WORKER_LEASE_MS`, `BEHAVIOR_STATUS_EVERY_MS` | worker | defaults 30000 ms, 30000 ms |
| `INTELLIGENCE_DATA_DIR` | spacetime mode | durable `FileStore` root (default `.data`, gitignored), one subdirectory per role |

## Identities, executors and operational limits

- **Worker identity** (role `worker`) uses `claimWork`, `renewWork`, `completeWork`, `failWork`, `recordProviderAttempt` and `putArtifact`. It never samples or chooses actions, and never calls world-mutation or scenario commands. Default capacity: behavior 8, measurement 2, text 2, experiment 0. Lease 30 s, renewed every 10 s.
- **Coordinator identity** (role `coordinator`) is a separate process created by `createCoordinator`. It claims only `experiment` jobs (capacity experiment 1, everything else 0; lease 120 s, renewed every 20 s), so an experiment that is waiting on its own behavior work never occupies behavior capacity. Driver leases last 60 s and are renewed every 20 s.
- **Limiter** (`CONSERVATIVE_LIMITS`): the limits are account-wide and adding workers does not raise them. Non-behavior work may use at most `maxConcurrency - reservedForBehavior` slots. Fair queueing gives other classes a turn every 4 behavior grants. `Retry-After` pauses the whole limiter.
- **Experiment budget:** `ExperimentSpec.operationBudgetMs` (default 1 h per arm) is applied identically to A and B. A timed-out arm is cancelled, marked `incomplete` and never replaced.

## Durable storage schema

`DurableStore` keys (`MemoryStore` in tests, `FileStore` in processes):

| Key | Content |
|---|---|
| `cache/<namespace>/<key>` | `response-cache-v1` entry: write-once winner, key version `cache-key-v1`, original source, model requested/returned, policy and instructions versions, probabilities/score, response artifact |
| `cache-links/<namespace>/<key>/<requestId>` | write-once consumer marker (used for the response tape) |
| `raw/<sha256>` | raw provider bytes (sanitized), write-once |
| `journal/<workId>` | worker processing journal (attempt, state, note) for restart recovery |
| `usage/<callId>` | usage ledger: started/finished attempt, tokens, reported or estimated cost (`jev-price-estimate-2026-10-v1`, labeled estimate), beneficiaries |
| `narration/<id>` | frozen narration per evidence/agent |
| `experiments/<experimentId>/state` | `experiment-state.v1`: specHash, owner lease attempt (write fence), per-pair population/warmup/arms/run IDs/hashes/metrics, artifact refs |

Namespaces: `exp/<experimentId>` (frozen for the whole experiment, with no TTL), `run/<runId>`, `common`.

## Versions of prompts, rubrics and algorithms

`jev-instructions-v1` (Jev action and rating instructions; observed text is framed as data), `satisfaction-rubric-v1` (5 levels), `mock-policy-v1` / `mock-instructions-v1`, `population-v1`, `assumptions-v1`, `template-prose-v1` / `prose-prompt-v1`, `behavior-rng-v1`, `crowd-parser-v1`, `scenario-parser-v1`, `narration-v1`, `report-template-v1`, `experiment-facts-v1`, `paired-analysis-v1`, `paired-coordinator-v1`, `plausibility-lab-v1`.

## Fixture versus real evidence

- **Mock provider:** a deterministic policy, labeled `mock` in every result, report and limitation. It is not a model of human behavior.
- **Fake runtime and `src/fixtures/orchestration.ts`:** scripted runs and metrics. In the fixture, pass buyers depend only on the scripted price, so the revenue difference there is a property of the script. Reports produced on it carry `ORCHESTRATION-ONLY` in their limitations and facts.
- **Jev adapter:** request and response shapes come from public documentation, not from captured traffic. No live call has been made.
- **Plausibility lab:** the mock-mechanical check shows the plumbing carries designed signals: 6 factors the mock implements, plus 3 it does not (wording, promise overrun, memory), which stay flat once a measured placebo noise floor is applied. That says nothing about real Jev; the real-provider observation is a separate, labeled, NOT RUN section.

## Demo steps

```bash
cd intelligence && npm ci
npm run population:fixture -- --out /tmp/population-300.json   # 300 guests, deterministic
npm run dev:worker                                             # fixture runtime, mock worker, exits
npm run experiment:mock -- --out .data/exp-demo                # paired A/B; writes report/facts/narrative/tape
npm run plausibility -- --out .data/plausibility.json
```

### Price comparison with no assumed sign

`npm run experiment:mock -- --seeds s1,s2,s3 --analysis paired_descriptive` predeclares three seeds and a single change: pass price 1500 to 2500 cents at `atMs` 10000, identical in every other field (`preflight` rejects any other difference unless it is labeled `bundled`). For each complete pair and each metric, the report gives B minus A with whatever sign results, along with n, mean, min, max and sample SD. A paired-t interval appears only with `--analysis paired_t` and n of at least 2. Seeds are never added, dropped or rerun based on the sign. Incomplete or failed pairs stay listed with reasons and are excluded from that metric's denominator only. On the fixture runtime the output (net revenue −1000 cents per pair, n=3) reflects the scripted fixture and is labeled orchestration-only. On the real Engine the same command (`--runtime spacetime`) measures whatever the simulation produces, which may be positive, zero or negative.

## Benchmark

Apple M2, 24 GB, macOS 26.6.2, Node 26.7.0. Fixture runtime, mock provider, in-memory store, behavior capacity 32: 1000 distinct decisions in 507 ms (≈1970/s), worker behavior latency p50 12 ms, p95 16 ms, 0 failures. `experiment:mock` (3 pairs, 12 steps per arm) takes 0.47 s wall time including tsx startup; `population:fixture` (300 guests) takes 0.37 s. These numbers measure orchestration overhead only; real throughput is bounded by the Jev limits above.

## Interface assumptions for Engine (lane A) and proposed contract notes

These are things this lane relies on that the contract does not state outright. They are covered by the fake and should be confirmed by A's adapter tests:

1. `checkpointRun` on a freshly created, not-yet-advanced child run returns its `physicalStateHash`. The coordinator uses this to verify that A and B start identically before driving either arm.
2. The warmup common run is created as an experiment child with `pairId = "<pair>.warmup"` and `arm = "A"`, since the contract has no warmup arm value. Arms are then cloned from its `checkpointRun` artifact through `initialCheckpoint`.
3. `physicalStateHash` must not include run IDs or request IDs; otherwise frozen-response A/A cannot produce equal hashes on the real Engine.
4. Command receipts: the same `commandId` with the same payload returns the original receipt, and a different payload returns `CONFLICT`. Because `renewDriver` changes the lease payload, the coordinator's `advanceRun` IDs include the epoch, lease expiry, run revision, step and phase.
5. `recordExperimentProgress` requires the coordinator's current work lease. The coordinator may only `createRun` experiment child runs.
6. `getMetrics`: the snapshot with the highest `revision` within `[0, horizonMs]` is the final one.
7. A rating's `evidenceHash` is checked for format and echoed, not recomputed.
8. **Proposed contract addition:** `Quality.behaviorCounts` reports cache hits as `cache`, which loses the original source. The coordinator currently recovers it from the response tape and degrades real-provider pairs if any mock or fallback entry is present. An `originalSourceCounts` field on `Quality` would make this explicit for coordinators that are not co-located with the cache.

## Risks

- Jev response shapes are unverified against live traffic (B-22). The adapter fails fast on unknown shapes rather than guessing.
- Real Engine integration is untested here (B-18/B-21). The assumptions above are the most likely friction points.
- The `persist()` write fence (read the stored owner attempt, then write) is safe for one process per store. Coordinators sharing a store across hosts would need a store-level compare-and-swap.
- The coordinator exports the response tape from the co-located worker cache. Without co-location, the cache-hit provenance check is skipped, and the report says so in its limitations.
