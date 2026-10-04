# All-lanes integration report (`integration/all-lanes`)

Branch `integration/all-lanes` merges the three lane branches as pushed to GitHub:
`origin/main` (Engine, lane A, including `integration/`),
`origin/feat/behavior-engine-intelligence` (lane B) and
`origin/feat/behavior-engine-experience` (lane C). The three were independent root histories
with disjoint paths, so the merges (`--allow-unrelated-histories`) had no conflicts. All three
`behavior-v1.ts` contract mirrors are byte-identical (SHA-256 `c25776a4…aac4`), as are the golden
vectors and conformance fixtures. Nothing was pushed to `main` or force-pushed.

## How to run the full stack locally

Prerequisites: Node 24, SpacetimeDB CLI/server 2.10.2 (`spacetime login` for the local
publisher identity), and optionally a Jev key in `engine/.local/jev.env` (gitignored, 0600).

```sh
# 1. Engine: build, start DB, publish module (once per checkout)
(cd engine && npm ci && npm run build)
spacetime start --listen-addr 127.0.0.1:3000 &
(cd engine && npm ci --prefix module && spacetime publish mhacks-engine --server http://127.0.0.1:3000 --module-path module --yes --no-config)

# 2. Harbor Lights compiled by Engine's compiler, then registered
(cd experience && npm ci && npm run content:compile)       # -> experience/assets/park.bundle.json
(cd engine && npm run dev:seed -- ../experience/assets/park.bundle.json)

# 3. Worker/coordinator identities -> engine/.local/integration.env (0600, never printed)
node integration/bootstrap-identities.mjs

# 4. Intelligence worker + coordinator (mock by default; real Jev is opt-in)
(cd intelligence && npm ci && npm run dev:integration)
#    real Jev: (cd intelligence && set -a && . ../engine/.local/jev.env && set +a && BEHAVIOR_PROVIDER=jev npm run dev:integration)

# 5. Experience live UI with Engine's browser adapter (http://127.0.0.1:4317)
#    signs in automatically as the local operator; no sign-in step (local use only)
(cd experience && npm run dev:integration)
```

`node integration/run.mjs --check` (strict) passes; strict mode now runs the identity bootstrap
after seeding. Run only ONE provider class of worker at a time (see "Known limitations").

## Integration defects found and fixed

| # | Lane | Defect (observed against the real stack) | Fix |
|---|---|---|---|
| 1 | C | Harbor Lights PNG palette differed from Engine's compiler palette; assets would not compile | Content uses Engine's palette; paint emits compiler metadata; `content:compile` runs Engine's compiler |
| 2 | B | Real-Engine paths created runs before the registered park left `preparing` | Shared `registerParkAndWait` |
| 3 | B | Content-addressed artifact command IDs reused across experiment scopes -> `Transport ID conflict` | Scope-bound `artifactCommandId` |
| 4 | B | Coordinator invented pair IDs; Engine pre-creates `pair:<i>` and rejected every progress write | Adopt the runtime's published pair inventory; resync revision; fail if the final report is refused |
| 5 | B | `maxSteps` 120 > Engine limit 100 | Default 100 |
| 6 | A | Experiment metric check compared full snapshots including `revision`, which differs between history and published views | Compare measured content (revision excluded) |
| 7 | C | Crowd generator version `population-generator-v1` unknown to Intelligence (`population-v1`) | Use `population-v1` |
| 8 | B | `advanceRun` command IDs repeated when a bounded advance made progress inside a step -> receipt replay loop, no progress at ~50% server CPU | Per-arm advance sequence in the ID |
| 9 | C | Share `tokenHash` = sha256(token) but Engine verifies sha256(canonicalJson(token)); every real share link failed | Match Engine; fixture server matches too |
| 10 | A | Share-link viewers could not read the run's park artifact, so the live map could not render | Park reads allowed via an unexpired, unrevoked grant on a run using that park |
| 11 | A | One work queue let a mock worker answer Live-Jev runs (or Jev answer Mock runs) silently | `completeWork` rejects provider sources that do not match the run mode |
| 12 | B | Pending pairs reported `populationHash: ""`, rejected by Engine's contract validation | Engine's 64-zero placeholder |
| 13 | A/C | Rating requests used labels ("Very poor"…) not matching Intelligence's rubric; every rating was rejected. UI declared placeholder versions | Engine sends the declared rubric's exact labels; UI declares Intelligence's real versions and requests `jev-1.13.0` for live runs |
| 14 | B | Real Jev rounds probabilities to 0.01, so valid vectors sum to 0.99/1.01 and failed the 1e-6 tolerance (paid retries; plausibility lab 9/9 errors) | Explicit adapter-level dequantization within the rounding bound, raw bytes kept, event logged |
| 15 | C | Live config defaults (`ws://…`, `behavior-engine`) did not match Engine (`http://…`, `mhacks-engine`); no `dev:integration`; missing-adapter test build contained the copied adapter | Fixed defaults and entry points |
| 16 | A | A failed experiment job left `getExperiment` reporting `running` forever | Failed experiment job marks the experiment `incomplete` with the reason |
| 17 | A | `dev:seed` refused to re-register an identical park uploaded with different JSON serialization ("Park revision conflict"), breaking the strict launcher | Reuse a registration whose content is canonically identical; still fail on different content |

Each lane's own suite still passes after these fixes (see below).

## Verified evidence (this machine, 2026-10-03/04)

| Check | Result |
|---|---|
| Engine `typecheck`, `lint`, `test` | pass; 71/71 |
| Intelligence `typecheck`, `lint`, `test` | pass; 240 passed, 2 env-gated skips (real-Engine gates, run separately below) |
| Experience `typecheck`, `lint`, contract/unit/integration | pass (16 + 126 + 7) |
| Experience fixture browser suite | 17/17 |
| Engine partial launcher smoke (real SpacetimeDB) | PASS: 79 steps, revenue reconciled, all exits |
| Harbor Lights through Engine's compiler | both stages valid (12 and 27 destinations); compiled bundles equal the fixture assembly |
| Mock A/B experiment (Intelligence worker + coordinator + real Engine) | completes; report accepted by Engine |
| Live UI against the real stack | operator sign-in, park listing (invalid park disabled with issues), population preview (Intelligence-generated, Engine-validated, UI hash-checked), create/start, live map, inspector evidence, share link viewer, unauthorized session denied, what-if accepted and scheduled |
| Live missing-adapter / stub-adapter browser checks | pass |
| **Real Jev** smoke (B-22) | decision + rating valid, model `jev-1.13.0`; captured sanitized responses committed as provider fixtures |
| **Real Jev** UI run (C-23) | pass: Live-Jev run, inspector shows Jev source; Engine counts jev 6 / mock 0 / fallback 0, comparison-eligible |
| **Real Jev** plausibility lab (B-23) | 22 calls, 0 errors: 5 as expected, 3 flat, 1 sensitive, 0 opposite (synthetic states; not calibration) |
| **Real Jev** paired A/B (pass $15 -> $25) | 2/2 pairs complete, report accepted by Engine (below) |
| Coordinator crash recovery (real Jev) | worker + coordinator killed mid-experiment; restarted coordinator resumed from persisted state and completed the experiment |
| **Strict all-lanes launcher** `node integration/run.mjs --external-db --smoke` | PASS: clean `npm ci` + build of all lanes, publish, idempotent Harbor Lights seed, identity bootstrap, Intelligence real-Engine gates 3/3 (no-fallback loader, B-21 mock A/B exact report shape, B-18 A/A zero deltas) |
| **Experience integrated browser suite** `npm run test:e2e:live` (real stack, mock provider) | PASS: missing-adapter, stub-adapter, and the full integrated journey (park -> population -> run -> inspect -> share viewer / unauthorized -> approved intervention applied -> metrics -> A/B report) |

## Real-Jev paired A/B result

Spec: Harbor Lights stage 1, 60 guests (Intelligence `population-v1`), seeds `s1`, `s2`,
90-minute horizon, `mode: experiment`, `requestedModel: jev-1.13.0`, fallback forbidden, single
change pass price 1500 -> 2500 cents at 60 s. Engine rejected any mock/fallback distribution.

| Pair | Admitted | Arm A decisions | Arm B decisions | Terminal ratings | Net revenue A -> B |
|---|---|---|---|---|---|
| pair:0 (s1) | 35 | 188 Jev | 107 Jev + 97 cached (Jev origin) | 35/35, 35/35 | $43.50 -> $52.50 |
| pair:1 (s2) | 18 | 207 Jev | 291 Jev + 61 cached (Jev origin) | 18/18, 18/18 | $34.50 -> $66.00 |

Paired differences B - A, mean (min, max) over 2 pairs: net ancillary revenue +$20.25 (+$9.00,
+$31.50); queue minutes per guest +2.81 (+2.41, +3.21); synthetic satisfaction +1.4 points (0,
+2.8); early departures -3.5 (-5, -2); rides per guest +0.35. These are model outputs from two
small synthetic pairs, labeled exploratory by the coordinator; min/max is not a confidence
interval and nothing here is calibrated to real visitors. The report also states that cache-hit
provenance was not re-verified because the worker and coordinator ran as separate processes.
Provider usage: Arm A of pair 0 alone was ~232 calls (estimated $0.29); Jev usually reports no
cost, so totals stay unknown rather than zero.

## Known limitations (not fixed here)

- **One provider class per deployment.** Engine's `claimWork` cannot route by run mode or provider.
  With fix 11 a mismatched worker now fails safely (its submissions are rejected) instead of
  mislabeling evidence, but mock and Jev workers should not run at the same time.
- **Throughput (superseded, see "Crowd scale and speed" below).** Before that work, 300-guest
  runs advanced at roughly 0.5-0.8x real time with the mock provider.
- **Jev cost is often unreported** by the provider; usage stays `null` (unknown), never zero.
- Proposals recorded in `experience/docs/integration-proposals/` remain open.

## Crowd scale and speed (2026-10-04)

Measured on this machine against a real SpacetimeDB 2.10.2 server (Harbor Lights, Intelligence
`population-v1`, scheduler-driven live run, `engine/tools/live-load.ts`):

| Run | Guests in park vs wall time | Achieved speed |
|---|---|---|
| 1000 guests, mock, 20x | 140 at 10 s, 283 at 30 s, 488 at 60 s, 550 at 90 s | 19.9x sustained |
| 1000 guests, mock, 60x | 283 at 11 s, 540 at 29 s, 630 at 47 s, ~800 from 97 s on (peak 801) | 59.2x sustained |
| 300 guests, live Jev (batched), 20x requested | 60 at 45 s | ~6x |
| 1000 guests, live Jev (batched), 20x requested | 131 at 39 s, 173 at 61 s | ~4.5x |

In-process (no database) the 1000-guest day runs at ~150x. `getAgent` answers in 10-80 ms
during a 1000-guest run (up to ~200 ms at 60x).

What changed:
- **Arrivals** (`intelligence/src/population/assumptions.ts` `ARRIVAL_BANDS`): gate-opening surge.
  About 15% of groups arrive at rope drop, most within 75 minutes, and a tail up to 4 h. Stays
  are 2.5-6 h. The fixture population matches. The mock policy's `leave_park` weight no longer
  sends rested guests home early.
- **Caps**: Engine `maxGuests` and the population generator default are now 2000 (were 1000/400).
- **Mock runs resolve behavior inside Engine** (`engine/src/sim/mock-policy.ts`, a pinned copy of
  `mock-policy-v1`). There is no worker round trip and no barrier stall. One scheduler tick
  completes up to 8 whole steps. Set `config.mockResolution: "worker"` to use the old
  worker-queue path; test fixtures do. Experiment arms requesting `mock-policy-v1` also resolve
  in-process.
- **Hot path**: navigation adjacency, bounded local fields for browsing, cached orders/indices,
  an O(n) canonical encoder, and squared-distance neighbour checks. The physical hash is recorded
  every 30 sim-s, not every step.
- **Persistence**: Engine keeps loaded run state in a cache across reducer calls, validated by a
  per-save stamp in the run row. A rolled-back transaction invalidates the cache. Saves write
  only new or changed rows, and completeWork persists only the touched slot.
- **Bounded history (mock/live only; experiment/replay keep everything)**: applied decision slots
  are dropped. Each group keeps full evidence for its last 2 decisions and a compact log of its
  last 12. Resolved ratings drop their bulky observation. Replay frames for crowds over 500 are
  stored every 120 s with rounded coordinates. Mock runs with in-process resolution produce no
  response tape (their responses are a pure function of the request). Worker-resolved live runs
  keep a responses-only tape up to 6000 decisions.
- **Jev batching** (`intelligence/src/providers/jev-batch.ts`, on by default for
  `BEHAVIOR_PROVIDER=jev`): up to 16 requests per HTTP call (`JEV_BATCH_SIZE`; 1 disables), split
  automatically on `max_tokens_exceeded`. Measured: 1 question about 0.25 s, 16 about 0.2-0.3 s,
  32 about 0.4 s, 48 rejected. Each request is still cached, validated and telemetered
  individually. Batched prompts use instructions version `jev-batch-instructions-v1`, so they have
  their own cache keys. Live-Jev throughput is now bounded by Engine round trips per decision
  (claim, artifact upload, complete), not by Jev latency.
- **Rationale**: every applied decision carries `AppliedDecision.rationale` (contract
  `DecisionRationale`). `AgentDetail` gains `statusText` and `decisions` (newest first). Any
  reasoning text Jev returns is surfaced as `rationale.modelReasoning`; Jev does not return any today.

The contract changes are additive optional fields. The new contract SHA-256 is
`38502f63cf2a63f750658ae3e771a5429cd15eb9df4c66b20869970d177c40f6`, identical in all three lanes.

### Stage 2 (27 destinations), queues, scrubbing (2026-10-04, own server on :3100)

| Run (Harbor Lights stage 2, mock unless noted) | Guests in park over wall time | Speed achieved | getAgent |
|---|---|---|---|
| 1000 @20x | 151 at 10 s, 264 at 26 s, 427 at 59 s, 513 at 76 s | 20.0x | 14-63 ms |
| 1000 @60x | 274 at 11 s, 547 at 28 s, 716 at 56 s, about 830 from 85 s | 59.6x | 60-530 ms |
| 1500 @20x | 287 at 11 s, 547 at 40 s, 740 at 59 s, 862 at 78 s | 19.8x | 150-340 ms |
| 1500 @40x | 411 at 12 s, 870 at 42 s, 1121 at 91 s | 39.4x | 210-680 ms |
| 1500 @60x | 529 at 12 s, 931 at 34 s, 1267 at 92 s | 60x at first, about 45-50x once more than 1100 guests are in | 250-970 ms |
| 300 live Jev (batched) @20x | 26 at 16 s, 54 at 37 s, 72 at 57 s | about 7x | 90-170 ms |

getAgent latency is time spent waiting behind simulation ticks (SpacetimeDB runs reducers one at a time).
- **Queues:** guests in a queue stand single file along the queue zone, then along an overflow line on the walkway. All 21 stage-2 zones were checked: guests on a queue line were never on a blocked cell.
- **Frames:** one is recorded every 15 s for 1000 guests (20 s for 1500), about 60-90 KB each. A page of 10 loads in 70-950 ms depending on load.
- **MetricSnapshot.breakdown:** each snapshot now also reports guests per state, per-place queue, revenue and served counts, and the satisfaction distribution.
