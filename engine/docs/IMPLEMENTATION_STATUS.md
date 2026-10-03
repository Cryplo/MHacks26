# Engine implementation status

Owned implementation is delivered on `feat/behavior-engine-runtime` in the isolated `mhacks-engine` worktree. The original repository was empty; bootstrap/base is `adf003b5eaebdf7a790446daeec0d672ce6e7434`. No existing AGENTS.md was found. Remote: `https://github.com/Cryplo/MHacks26.git`.

- [x] Frozen contract, golden vectors and lane-local tooling
- [x] Validated immutable park/population/config/scenario input and 12-person synthetic fixture
- [x] Pure seven-phase mechanics, queues, money, needs and frozen measurements
- [x] PNG compilation, topology checks, persisted destination fields and resumable preparation
- [x] Simultaneous individual motion with restartable 32-agent proposal batches
- [x] Observations, executable options, notices, route alternatives and complete-set decision barriers
- [x] Durable work, retries, receipts, artifacts, driver fencing and trusted access
- [x] Actual SpacetimeDB 2.10.2 module and generated browser/Node adapter
- [x] Checkpoints, response replay, experiment/product plumbing and subscriptions
- [x] Integration launcher, real local mock day, load measurements, CI and handoff
- [ ] External B/C integration, real Jev/provider mode and authored production park/UI gates

Verified ordinary suite: 71 tests across 13 files, including ten simulated minutes of 400-person motion. Typecheck, lint, build and frozen hash checks pass. Final coverage passes: 85.46% lines and 77.95% branches.

Real-server final smoke: eight-hour horizon, 3 scripted guests, 385 advance invocations, 60-second frames, two snapshots across reconnect, 30 patches, 6,000 cents reconciled and all 3 physical exits. Includes worker-generated population handoff, a scheduled scenario, private receipt retry, read-only denial and checkpoint retrieval. Full launcher smoke also passes from dependency installation through publication/seed and a six-minute visit.

Load: 200/300/400 guests × one/four viewers on a 200×150 grid with 15 fields. Latest recorded p95 advance-command round trips are 64.6–168.9 ms. Timing conditions and limits are in HANDOFF.md; baseline and intermediate results are retained. This does not establish accelerated full-day occupied-park performance or real-provider economics.

Strict integration preflight intentionally fails for missing intelligence/experience contracts. No paid inference was made. See ACCEPTANCE.md for the evidence mapping and HANDOFF.md for operational notes and limitations.
