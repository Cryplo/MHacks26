# Standalone coding-harness assignment: ENGINE

**Assigned branch:** `feat/behavior-engine-runtime`
**Your owned implementation root:** `engine/`

This entire file is ONE master prompt. Implement only this lane. All necessary product context, ownership rules, interface definitions and sample fixtures are included below. Do not wait for another teammate's branch to start; use the specified local ports/fixtures. Read the complete prompt before changing code. The other lane names describe boundaries, not an instruction to implement their work.

After checking repository instructions, the agreed base commit and a safe isolated working tree, create the assigned branch with `git switch -c feat/behavior-engine-runtime` (or resume it after verifying it is already your branch). Do not initialize a replacement repository or discard unrelated work. Finish implementation and tests with incremental commits, not just a plan.

The protocol and fixtures below are proposed application contracts. They are not an implemented product or an assertion about a vendor SDK.

---

# MASTER PROMPT 1 - ENGINE
## Authoritative simulation, durable backend, navigation, and integration foundation

You are the **Engine owner**. Your branch is `feat/behavior-engine-runtime`. Your exclusive roots are `engine/` and `integration/`, plus `.github/workflows/engine.yml`. Build the authoritative engine and its public application adapter completely. Do not build the Jev HTTP worker, persona generator, report prose, React app, or authored production park; those have separate owners. Your first successful slice must run without them.

Read the complete shared charter and frozen contract in this prompt, then execute. Start with repository inspection and your branch, create a short checklist, and begin implementation. Do not return only architecture or ask the other agents to implement your tests.

## A1. Your deliverable and architecture

Deliver a pure deterministic TypeScript simulation library, a real SpacetimeDB TypeScript module, a browser/Node runtime-client adapter, navigation/content compilation tools, engine-owned test fixtures, and an integration launcher. Keep business mechanics independent of database/SDK imports so exhaustive unit/property/replay tests run without a server. The actual module must call those mechanics, not an alternative implementation. The same advancement path powers live and headless runs.

Suggested internal layout, adaptable only within your owned roots:

```text
engine/
  contract/behavior-v1.ts
  src/domain/           # entities, state transitions, checked units
  src/sim/              # phase machine, motion, observations, actions
  src/navigation/       # grid validator, fields, collision tests
  src/accounting/       # money, queues, metrics, heat accumulators
  src/replay/           # snapshots, serialization, hashes, action tape
  module/               # actual SpacetimeDB tables/reducers/views
  client/               # generated SDK internals + stable port adapter
  tools/                # authoring compiler, importer, provisioning, smoke
  fixtures/             # tiny synthetic contract/engine fixtures, not C's park
  tests/{unit,integration,invariants,replay,contract}/
  docs/
integration/
  check-contracts.mjs
  run.mjs
  smoke.mjs
  README.md
```

Do not depend on B's package to accept a population: validate the exact `PopulationManifest` artifact. Do not depend on C to get moving agents: author a small test-only grid and a complete 12-guest manifest within `engine/fixtures`. The production Harbor Lights content belongs only to C. Import it via tooling once present; do not copy it into another mutable source tree.

### A1.1 First three commits

1. Isolated lane bootstrap, exact contract copy, golden vectors, unit tooling and branch/status notes.
2. Pure run/phase model plus a tiny legal grid, one ride, one food counter, a rest place and an exit; validate units and manifests.
3. A mock-policy test driver emits known distributions and runs the real core through arrivals, movement, queues, service, purchases and exit with conservation checks.

From there commit coherent slices for navigation, accounting, durable protocol, server adapter, access/replay, and integration/load tests. Aim for at least 10 reviewable commits. Do not defer tests to the last commit.

## A2. Data ownership, initialization, and manifests

Implement the authoritative families from v3: run/manifest/config, static park assets and initialization status, places/operational versions, persona/group/individual state, observations, queue entries, service sessions, wallets/entitlements, decision requests/inbox/evidence, typed events, timed scenarios, rating snapshots/results, metrics, heat accumulators, frames/checkpoints, artifact staging/metadata, work jobs/leases, command receipts, role/run grants, share capabilities, provider-attempt telemetry and driver leases. You may embed small records, but hot query/filter fields must be typed/indexed. No giant mutable JSON world row as the primary database representation.

Enforce run-scoped foreign references in reducers even where the database schema cannot express them. Index due work, queued parties by place/lane/order, active agents by run, service completion times, recent events and authorized caller receipts. IDs are semantic/stable within run; the database primary key can be a composite or encoded key but must not replace the stable ID in random addresses.

Registering a park validates JSON schema, palette-derived byte count/hash, dimensions, bounds, all entrance/exit reachability, non-overlapping queue-zone ownership, entrance/queue connectivity, service configuration and route profiles. Build navigation once per topology. Large initialization work uses bounded resumable stages; the park/run remains preparing until every required asset and field is valid. Invalid assets expose actionable issues, not half-ready runs. A cancelled setup must not spawn guests.

Run creation rejects an unready park, population from a different park hash, duplicate people/groups, mismatched membership/guardian references, wrong guest count, impossible money/time/height values, incompatible versions and invalid scenarios. Validate arrival < planned departure <= supported day bounds. Register all future guests without counting them admitted yet. Arrivals are events; admitted count increases once, and departed guests remain in history. Persist the immutable original input hashes and explicit config.

Population goals/hooks affecting mechanics must be structured. Treat backstory text as descriptive input, not a command to modify a wallet or create a ride. B validates prose; you still enforce all structured constraints.

## A3. Deterministic time, drivers, and bounded transactions

Implement the seven-phase boundary state machine in the charter. A restart at every phase must resume safely. Persist enough phase/cursor information that a bounded transaction can stop without duplicating a phase or exposing partially integrated positions as a completed frame. Use explicit deterministic work budgets; a wall-clock execution budget can decide when to yield, never which physical operations are skipped.

At a boundary, first process declared scenario order, service completions and scheduled arrivals. Then consolidate moments and create immutable requests. At a barrier, capture the complete due request set; do not execute any of its choices until the set is resolved. New authoritative scenario commands may target only a future UNPREPARED boundary. Reject a stale operator draft instead of mutating already-prepared state. Supersession is explicit and preserves the decision slot/random address until an action has actually been attempted.

At apply, use moment priority (`forced_replan` first, queue/admission next, then needs/closing, ordinary choices and notices) and stable group/sequence tie breaks. Document the exact total order in an exported policy constant and test it. Sample once against canonical option IDs. If an earlier same-boundary action consumed a scarce capacity/budget dependency, record a failed attempt, charge nothing, reveal appropriate information and request a new choice at the next boundary. Do not mask the failed choice by resampling until success.

Give each run one fenced advancement owner. A scheduler driver cannot advance a coordinator-owned run. Driver renewal/expiry is operational; a stale epoch/token is rejected. `advanceRun` validates expected step/phase and max work, returns blocked IDs and last completed state hash. Command receipt idempotency prevents a retry from advancing twice. `pauseRun` is honored at a safe point; pause/resume/speed change never changes logical duration, coefficients or RNG addresses.

Cancellation terminates pending jobs safely, prevents later submissions from mutating state, and preserves evidence. Keep incomplete/cancelled runs distinct from completed runs. At a common horizon, snapshot metrics/terminal ratings before any optional cleanup. Mark still-present agents censored rather than fabricating exits or service completions.

## A4. Grid, fields, motion and groups

Implement a deterministic grid loader/compiler. Input PNG authoring conversion is a local Node tool: exact palette matching, no anti-aliased colors, no scale inferred from display pixels, explicit queue masks/sets. Unknown colors fail with pixel coordinates/counts. Emit the frozen ParkBundle representation, a validation report and deterministic asset hash. Runtime reducers read the uploaded bytes, never an arbitrary path or URL.

Implement destination fields with stable equal-cost ties and diagonal rules. Use an unreachable sentinel and distance fields for supported estimates. Queue-only cells are not public walking shortcuts. Distinguish path topology from operational ride status; closing a ride does not erase surrounding paths. Authored route profiles need reachable waypoints and executable fields. Do not offer a route-choice option when only one route exists.

During each 250 ms movement substep, read all neighbor forces from one start-of-substep snapshot, query a spatial hash, compute preferred flow + separation + wall avoidance + density slowing + group cohesion, and commit simultaneously. Clamp speed/displacement, test swept segment/cell intersections, and prevent diagonal corner cutting. Use keyed jitter only when enabled. Bound separation forces at coincident positions with a stable ID-based tie break; do not produce NaN or infinite acceleration. A stopped/deciding/service guest has correct zero/no-walk movement semantics.

Keep each person's own position/speed/needs. Together-groups pace to members who cannot keep up and regroup by waiting/cohesion, not by teleporting children or parenting all sprites to a single anchor. Shared destination does not permit crossing blocked cells. Arrival at a place stops movement until a valid admission/notice/order choice commits. Graph-distance or path estimates may support navigation internally but must not turn the visible movement into graph-edge motion.

Neutral browsing can use deterministic nearby walkable waypoints and heading persistence. Do not rank notice text by persona and quietly steer toward the winning shop. Exposure requires actual traversal/proximity; detect crossed notice regions during substeps so a 5-second step does not skip them. Preserve member-level observation records and consolidate the group's decision.

## A5. Observations, action options and decision triggers

Engine owns `GuestObservation`, option construction and executable arguments. The worker cannot rewrite them. Build a bounded guest-knowledge projection with exact facts and versions, member personas/needs, wallet, known destinations, recent activities and departure context. Do not include backend predicted waits, globally unseen closures or unreceived messages. Keep operator truth in separate views. Validate request and executable-option hashes independently.

Implement core moments: forced replan, what next, join queue, stay/abandon/upgrade queue, hunger/tiredness, noticed stop/enter/continue, received message and closing soon. Bind every option to a state-valid action. Travelling does not purchase or automatically join. Notice-enter reaches/discovers the entrance, then follows normal admission/service rules. Continue means continue the already-valid plan, not jump to another destination. Rest must have an actually reachable/supported place and duration. Leave routes to an exit; it is not instant disappearance.

Hunger triggers use thresholds/cooldowns/reset states. Queue reconsideration compares against the original observed quote and a periodic interval, default 10 simulated minutes. Never ask a rider to leave an active ride because hunger crossed a threshold. Coalesce competing moments; preserve a deferred incidental notice instead of cancelling a critical request repeatedly. Keep explicit trigger provenance so B/C can explain why a request exists.

For the initial small park include known relevant destinations; for the expanded park use an explicitly logged cap of up to eight destinations plus fixed legal choices. Use transparent distance/knowledge/eligibility constraints, not a utility model that makes the substantive decision first. Record candidates/exclusions. Always provide a feasible continue/rest/browse/exit option appropriate to state; never solve an empty option set with a silent random choice. Unknown facts can remain unknown. Known height restrictions may filter impossible admissions; unseen closures must not leak through travel candidates.

## A6. Queues, services, payments, and metric evidence

Implement actual ordered queue entries; summary lengths are projections. A whole party cannot occupy both lanes or two rides. Upgrade-to-pass semantics remove the standard entry and insert the pass entry at the current logical join position under a documented rule; preserve elapsed waiting and original promise in the episode ledger. A party already owning valid passes is not charged again. Mixing entitled/unentitled intended riders requires an explicit exact purchase for missing beneficiaries; never double-sell a pass.

Ride dispatch and completion are separate. Validate vehicles against overlapping duration/turnaround; dispatch only an available vehicle. The nominal example is eight seats, one vehicle, 90-second ride and 30-second turnaround, one dispatch every 120 seconds. Underfilled vehicles are legal; overcapacity is not. Loading target/guard/tie rules are deterministic. Prevent unserviceable parties, stale queued references and completion events that fire twice.

Counters have explicit server slots. Orders become queued immutable carts, charge atomically at service start, then complete service and any defined eating interval. Record one order ID, sale ID, service ID and causal chain. An unaffordable/stale cart at service start produces no debit and a failure/replan. Restrooms use service/capacity mechanics without invented sales. Shows have explicit admissions, seats and start/completion boundaries. If schedule changes are unsupported in your first slice, capability-gate them until implemented rather than treating them as ordinary continuously cycling rides.

Temporary closure: finish occupied sessions, stop new admissions/dispatch, release queued entries with closure-release cause, cancel unstarted orders without charge. Park closing follows the charter. Queue waiting is integrated for each actual queued person across interval overlap; closure/abandonment retains already-accrued wait. Event positions and person multiplicity must support reconciled heatmaps.

All monetary writes use checked integer arithmetic. A transaction must atomically update wallet, entitlement/order state and sale/refund event. Deduplication covers client retries, worker duplicate replies and replayed phase entries. Refunds cannot exceed original sale net balance. Group/member spending allocation for analytics must sum to the actual transaction, without cloning a group purchase onto every member.

Validate and store provider-attempt telemetry independently of physical actions. Started/finished records are monotonic and idempotent; derive per-run/account usage from unique call IDs and their billing-owner scope, not the number of DecisionResults referencing them. Missing final usage remains unknown. The accounting events for business purchases are entirely separate.

Own versioned needs/meters and the modeled-experience ledger. Clamp 0-100, integrate correct elapsed time/distance, apply each event contribution once, and configure demographic correlations through sampled parameters instead of hard-coded stereotypes. Never force satisfaction down merely because a price rose. Ratings are stored by frozen evidence/time/member and updated through the measurement path, not action commits.

Canonical accumulators and metric definitions belong here. Return all contract metric keys with null/reason when undefined. Do not let B or C maintain a second queue/revenue truth. Heat accumulators for waiting are time-weighted person exposure; experience is signed modeled contributions; money is net transaction locations; exits are actual exit locations. Event count is not waiting time. Reconcile each layer total to corresponding ledger/metric within declared numerical tolerance.

## A7. Durable work, SDK adapter and trusted access

Implement all contract commands/queries needed by the other lanes, including product jobs, experiment records, artifacts, shares and durable receipts. Typecheck the client against the frozen port. A request can be queued without the worker; it exposes pending/blocked, not a success simulation. Protocol requests and ratings are created only from your authoritative snapshots. Product thought/report jobs resolve authorized reference IDs server-side rather than accepting arbitrary caller-supplied evidence.

Use server-validated leases with attempt/token/expiry/owner. Test two claimants racing. The loser cannot submit; expired attempts cannot renew or complete over a newer lease. Preserve invalid raw responses as private evidence, create error records, and follow explicit retry/failure policy. A valid response becomes ready, not a purchase. Record original versus cache source and reject mock-derived responses in a declared real-Jev experiment. An explicitly mock-mode comparison remains a valid infrastructure test, labeled Mock throughout.

Implement private command receipts for idempotent commands, including claim/start/advance/artifact finalization. The adapter must survive reconnect and missed acknowledgement. Do not assume generated reducer return values support the port's output object. Use actual server-supported private views/receipts and, where necessary, caller-scoped query requests; do not invent unsupported SQL authorization or procedure APIs. Test the pinned SDK against a real local SpacetimeDB server early.

Expose minimal authorized projections and bounded historical pages. `subscribeLive` must begin with a consistent snapshot, then monotonic patches. Assemble SDK row diffs into a coherent public revision after their transaction marker; never expose half a transaction as a full patch. Use bounded per-run revision history or a documented full-snapshot reset on reconnect/gap. The adapter owns this buffering. Generate no fake revisions in the UI. Worker availability subscriptions are wake-up hints; claims/periodic reconciliation are authoritative.

Implement an operator provisioning tool, scoped worker/coordinator identities, read-only grants, secure share issue/redeem/revoke/expiry and access tests against both reads and writes. Secret material is never in public tables, command debug logs or exports. Public client filters are not authorization. Rate-limit artifact upload, work requests and viewer narration to prevent accidental cost exhaustion. Verify that a read-only viewer cannot directly call hidden reducers successfully.

## A8. Replay, exports, integration runner, and load

Checkpoint the full logical state and typed pending future work at a supported committed boundary; include all semantic counters, groups, observations, memories, queues, service occupancy, wallets, entitlements and coefficients. Do not serialize live worker tokens as reusable branch authorization. On restore, remap run scope, rebuild grants/operational records, reissue appropriate work and preserve semantic random addresses. Exact replay consumes recorded actions/responses, rechecks applicability, and compares hashes at the same completed phase. It does not call Jev.

Record visual frames on logical cadence with enough queue/service overlays to reconstruct scene. Default visual cadence may be five simulated seconds for the short demo and coarser for full-day storage; report actual cadence. Large frame/event retrieval is paginated and authorized. Backups should restore with no network inference, clearly recorded.

`integration/run.mjs` must check three contract hashes, install/build lane-local packages without editing others' tracked files, launch the configured local database/module/client build/worker/web app, seed C's compiled park once, pass explicit configuration and shut down child processes on failure/signals. No embedding credentials in command-line URLs. Provide partial-lane development mode and a strict all-lanes integration mode; the latter fails when a dependency is absent. `integration/smoke.mjs` runs real runtime + B mock provider + C-compatible commands through setup, one scenario, final metrics and comparison. C owns Playwright UI tests; your launcher makes them runnable, not duplicated.

Measure at 200, 300 and 400 guests, nominal 200x150 grid, 15 destination fields, single and several viewers, with no-inference-fixture and real-provider modes separately. Capture reducer p50/p95/p99, neighbor work, steps/invocation, achieved simulated speed, row/byte changes, egress, memory and request barrier delays. Proposed target: p95 comfortably below the 250 ms live wake-up interval; publish measurements rather than asserting success. Optimize spatial queries, serialization and publication before weakening mechanics or moving physics into B's worker.

## A9. Required tests and acceptance IDs

Use table-driven/property-based tests, deterministic seeds and fake operational clocks. No arbitrary sleeps in unit suites. Real database integration uses bounded polling/receipts and isolated test databases. Implement every group below; test names must include the ID for traceability.

| ID | Required evidence |
|---|---|
| A-01 | Empty/bad manifests; duplicate/missing group members; cross-run references; overflow/negative money; invalid times and unsupported flags rejected |
| A-02 | PNG unknown color, wrong dimensions, mismatched hash, orphan/overlapping queue zone, unreachable entrance/exit, diagonal-only path rejected |
| A-03 | Fixed flow ties, unreachable sentinel, no corner cutting/wall tunneling, narrow path/swept notice crossing, zero-distance neighbor stability |
| A-04 | Reversing agent row order and neighbor iteration preserves motion/observations/hash; 400-agent long run remains finite and walkable |
| A-05 | Individual group poses retained; slower member not abandoned; custody/eligibility rules; browsing does not select by semantic utility |
| A-06 | Repeated barrier wake-ups leave sim time/meters/purchases unchanged; no partial choice prefix; phase restart after every phase |
| A-07 | Same fixtures at slow/fast pacing, reordered/batched responses and reconnects produce identical completed-boundary hashes |
| A-08 | One active driver; stale fencing token/expected step rejected; same advance command returns original receipt without advancing again |
| A-09 | Claim race, lease expiry, renewal, duplicate completion, invalid distribution, late response after fallback and superseded request |
| A-10 | Same command ID/different payload CONFLICT; lost acknowledgement/reconnect reuses original accepted receipt |
| A-11 | Known-vs-hidden closure, unreceived app message, stale board, once-per-content-version notice, aroma/visual exposure distinction |
| A-12 | Hunger hysteresis, simultaneous notices coalesced, active rider not interrupted, failed action does not resample or charge |
| A-13 | Whole-party/lane FIFO/three-dispatch guard, unused seats, oversized party rejection, no double queue/service occupancy |
| A-14 | Multi-vehicle timing, closed ride behavior, exactly-once completion, show admission/time/capacity, close/horizon censoring |
| A-15 | Four 2,500-cent passes cost 10,000 cents; insufficient wallet/stale quote reject atomically; no duplicate entitlement/sale |
| A-16 | Upgrade queue preserves past waiting; food charges at service start only; closure cancels unpaid order; bounded linked refunds |
| A-17 | Revenue/wallet/entitlements/event ledger reconcile; all queue time including abandoned/released entries retained; undefined metrics null |
| A-18 | Individual fixed-time/terminal ratings, missing coverage, no rating-to-behavior feedback, late rating arrival does not change physical hash |
| A-19 | Heatmap layer totals reconcile; a 3-person 120-second wait contributes 6 person-minutes, not one event or 2 minutes |
| A-20 | Viewer/worker/coordinator/operator matrix for commands, queries, subscriptions and artifacts; share expiry/revoke/forged token |
| A-21 | Artifact partial/chunk reorder/duplicate/corruption/oversize/cross-owner access; incomplete upload never accepted as complete |
| A-22 | Live snapshot+patch revision consistency, deletes, duplicate/out-of-order patches, reconnect reset and listener cleanup |
| A-23 | Full checkpoint restore and exact replay match; warmup clone has identical initial physical state, new operational scopes |
| A-24 | Real local SDK/module smoke, generated adapter conforms to v1, private receipts correctly resolve both success and domain failure |
| A-25 | Complete full mock day conservation and money reconciliation; 200/300/400 load profile; documented benchmark conditions |

Additional release conditions: no externally callable action-commit bypass; all core commands actually work against the real module; no filesystem/HTTP access inside reducers; test fixture tests are not falsely labeled full-stack tests. A/A exact equality is jointly integrated with B, but you provide the engine hashes/replay needed to prove it.

## A10. Definition of done and handoff

Your lane is done when a clean checkout can build and test your pure core, publish/start the local module with documented tools, run a complete mock day through the real adapter, verify authorization and protocol faults, restore/replay a run, and supply stable Node/browser bundles that B/C load without editing their implementation. Include a command/query support table and generated-binding version in your handoff. Complete the root integration scripts even if teammates' code is not yet present; strict integrated tests must report missing lanes explicitly rather than pass.

Finish by running all engine scripts and `git diff --check`, reviewing ownership and secrets, committing the final verified slice, and writing `engine/docs/HANDOFF.md` with actual test results and unrun integration gates. Do not claim the entire product is flawless or integrated before those external gates have run. Deliver correct, inspectable infrastructure that makes final integration mechanical.


---

<!-- BEGIN_SHARED_CHARTER -->
# Shared execution charter - identical in all three master prompts

## 1. Product context and authority of this assignment

You are one of THREE engineers, each operating a separate coding harness and Git branch. Implement your assigned lane, not the other two. Deliver working code and tests, not merely a plan, scaffolding, pseudocode, screenshots, or a design essay. Work independently against the exact contract included below. Continue through implementation, verification, incremental commits, and a precise handoff. Do not stop after asking a teammate to build a dependency that your local fixture can replace for development.

The product is a **behavior engine for real places**. An operations or guest-experience manager tests pricing, messaging, and operating decisions before trying them on real visitors. The first vertical is a synthetic theme park. Movement establishes a believable setting; the value is the decisions, spending, experience, and auditable operational comparison. The broader vision includes venues, retail, airports, museums, and other spaces; do NOT implement those domains now.

The complete user journey is: select Harbor Lights -> describe the crowd with sliders/text -> preview sampled people and groups -> choose a baseline and a question -> watch the park -> inspect one guest's observed information and actual decision probabilities -> preview/approve a what-if -> inspect results and spatial contributions -> compare paired scenarios -> share a read-only live link and an evidence-backed report. Support an explicitly granted operator link for the judge's phone, not an unauthenticated global control panel.

Core proof: 200-400 individually represented guests, families/groups, free movement on a painted grid, browsing and text-driven notices, a clickable evidence inspector, actual purchases and queue effects, and one honest A/B answer. The content target is approximately 15 attractions plus amenities. First make 4-6 attractions work end to end, then expand content without bypassing correctness. Do not call a population of 300 guests 300 independent behavioral decision streams: together-groups share travel/purchase choices, while members retain individual state and ratings.

Source basis: `Theme Park Behavior Sim - System Design v3` (October 3, 2026), especially sections 1-14 and 18; `Product Brief - Behavior Engine for Real Places` (October 3, 2026), especially pages 1-2 and 5-10. The relevant requirements are reproduced in this prompt, so these attachments are not required to start. Product positioning in the brief is not verified competitive research. Do not publish its absolute competitor, speed, accuracy, or cost headlines as measured facts.

Precedence: this three-person assignment resolves ownership and implementation interfaces; v3 resolves mechanics/reliability; the brief supplies product purpose and journey. Where the brief says every person decides independently, promises unqualified causes/ranges, or includes a separated-child demo, preserve v3's more precise group semantics, uncertainty labels, and safety/cut lines. Three teammates are confirmed; the old four-person/36-hour estimate is NOT a new deadline. The interfaces, paths, job bus, receipt protocol, and defaults explicitly selected here are new implementation decisions, not claims that they appeared verbatim in the source documents. Do not otherwise replace the product with a different stack or architecture.

## 2. Three lanes, exclusive ownership, and zero blocking bootstrap

| Lane | Branch | Exclusive tracked paths | Owns |
|---|---|---|---|
| A / Engine | `feat/behavior-engine-runtime` | `engine/**`, `integration/**`, `.github/workflows/engine.yml` | Simulation, SpacetimeDB module, authorization, durable protocol, run metrics, navigation compiler, SDK transport adapter, shared integration launcher |
| B / Intelligence | `feat/behavior-engine-intelligence` | `intelligence/**`, `.github/workflows/intelligence.yml` | Persona generation, Jev worker, inference/cache/recovery, ratings, text jobs, paired experiment coordinator, numerical analysis and report composition |
| C / Experience | `feat/behavior-engine-experience` | `experience/**`, `.github/workflows/experience.yml` | React/Vite/Pixi product, authored park assets/content, setup/live/results/share flows, renderer, scenario review, browser integration tests, presentation exports |

Every lane owns its own `package.json`, lockfile, TypeScript configuration, tests, `.env.example`, `.gitignore`, and documentation under its directory. No lane edits another lane's files. No lane creates a competing root workspace, root lockfile, root tsconfig, root README rewrite, or shared generated-bindings directory. Preserve the repository's existing root infrastructure; A may add `integration/` without rewriting it. If existing repository rules require an additional root edit, record a patch proposal under your own `docs/integration-proposals/`; do not make competing root edits. Dependency manifests are lane-local to eliminate lockfile merge contention.

Use the exact contract appendix as `<lane>/contract/behavior-v1.ts`. The three files are intentionally byte-identical frozen mirrors, not three evolving schemas. A supplies an integration check that compares their hashes and rejects drift. Each lane can compile/test immediately with its own copy. Do not import a teammate's source implementation during standalone development. Boundary types are portable DTOs, not generated SpacetimeDB types. SDK bindings live only under `engine/client/` and are hidden behind `RuntimeClient`.

A builds `engine/client/dist/node.js` and `engine/client/dist/browser.js`, both exporting `createRuntimeClient(config)` with the appended signature. Bundle the browser artifact and its required dependencies for use as a same-origin ES module; never copy server secrets into it. B selects `fixture` or `spacetime` explicitly and loads the Node adapter through a configured local module path. C selects `fixture`, `live`, or `recorded` explicitly and dynamically loads the browser module from a configured same-origin URL. A's integration launcher copies generated browser assets into a gitignored `experience/public/runtime/` location before a live build. The fixture build does not require A's artifact to exist.

Fixtures are scripted protocol/data fixtures, NOT a second simulation engine. C can animate a finite recorded fixture for development but must visibly label it Fixture. B uses a fake port to test retries/orchestration, not invented successful experimental outcomes. Actual mock end-to-end mode uses A's real simulation plus B's deterministic mock probability provider. Missing real dependencies cause an explicit error in real mode, never an invisible fallback to fixtures.

Changes to boundary types are not unilateral. Record proposed additive changes under your lane's docs, and keep implementing against v1. Internal types are freely extensible inside your lane. An unsupported future feature is disabled honestly instead of silently changing a field's meaning. The complete v1 contract is the agreement, not a request to hold a schema meeting before work can begin.

## 3. Git and execution discipline

Before coding, inspect `git status --short --branch`, repository instructions including `AGENTS.md`, existing tests, installed toolchain, and relevant package files. Record the starting commit. Reuse an existing branch only if it is the exact assigned lane branch; otherwise create that branch from the agreed starting commit. Work in an isolated clone/worktree. If a shared checkout or uncommitted unrelated changes are present, preserve them and create a safe worktree when feasible; never reset, discard, stash, or clean somebody else's work automatically. Ask only if proceeding would risk data loss or an irreversible external action.

Keep a short implementation checklist in your own `docs/IMPLEMENTATION_STATUS.md`. Implement vertical slices; run tests at every slice. Commit each coherent passing slice, including the contract mirror/fixtures, before starting the next substantial subsystem. Use 8-12 meaningful commits rather than one giant final commit. Commit messages use `feat(engine): ...`, `test(intelligence): ...`, `fix(experience): ...`, etc. Stage explicit owned paths, not `git add .`. Check `git diff --cached --check`, review the staged diff, run the relevant checks, then commit. Never commit `.env`, tokens, raw secrets, `node_modules`, generated build output, or huge API logs.

No automatic merge, rebase of another branch, force-push, deployment to production, or paid long-running experiment. Local development and bounded smoke calls are permitted only with credentials/budgets already authorized by the operator. Use mock providers by default in tests. Missing keys must not block offline implementation. Report the real-provider test as NOT RUN with the exact command/requirement; do not describe it as passed. Do not claim product readiness until the actual gates pass.

All lanes provide runnable package scripts: `build`, `typecheck`, `lint`, `test:unit`, `test:integration`, and `test:contract`. A additionally provides `test:invariants`, `test:replay`, `dev:db`, `dev:seed`; B provides `dev:worker`, `test:providers`, `test:experiments`; C provides `dev`, `build:fixture`, `build:live`, `test:e2e:fixture`, `test:e2e:live`. Honor existing package conventions inside your lane when present, but these aliases must work. Record exact runtime/package versions and dependency-lock checksums. Verify actual vendor methods against installed SDK types and official documentation during implementation; the contract is not a claim about the vendor's API spelling.

## 4. Non-negotiable behavioral and physical boundaries

Jev supplies distributions over supplied actions. Only the Engine samples, revalidates, commits, spends money, moves guests, dispatches rides, or updates entitlements. An LLM can propose a structured operator draft and write prose, but cannot choose guest actions or mutate the world. Ratings are frozen measurement jobs and do not feed back into choices in v1. Mock/fallback/recorded data is always labeled.

One fixed simulation: 5,000 ms logical steps, 250 ms deterministic movement substeps, nominal 250 ms scheduler wake-ups. These are initial versioned engineering choices, not calibrated physics. Faster playback means more of the SAME steps, not longer steps. Wall time controls leases, timeouts, rate limits, and UI health. Simulation time controls guests, queues, exposures, and scenarios. Render time only controls interpolation.

Boundary order is `prepare -> requests -> barrier -> apply -> dispatch -> integrate -> persist`. Prepare due events, completions, and arrivals once; freeze/consolidate decision slots; wait for ALL due required distributions; apply in deterministic priority/group/decision order; dispatch; integrate all motion/needs over the next interval; persist. Save phase/cursors durably when work is split across reducer calls. Never commit a prefix of choices because those replies arrived first. A repeated blocked wake-up must not duplicate a purchase, exposure, arrival, meter update, or scenario effect.

No reducer waits on HTTP. At an unresolved required decision, the simulation clock pauses at its boundary; the transaction returns. An experiment never substitutes heuristics just because inference is slow. Live mode may apply a declared, versioned fallback at the same boundary after an operational timeout, marking the run degraded. Live fallback is a safety bridge, not evidence of Jev behavior. A late response cannot replace it.

One active behavioral slot per group. Incidental notices cannot repeatedly supersede an important unresolved request. Need thresholds have reset hysteresis and cooldowns. Separate `decisionSeq` (new substantive decision), `momentSeq` (per-moment sampling address), and `requestRevision` (refresh before application). A retry does not allocate a new decision or random draw. A stale observation refresh records supersession and reuses the pending slot; a failed already-attempted action schedules a NEW next-boundary decision.

Group members have individual continuous metre positions and needs; use cohesion/member-ability pacing, not identical anchor offsets. Simple motion follows flow fields with no wall tunneling, no blocked diagonal corner cutting, and row-order-independent neighbor forces. Ordinary walkers use path/plaza cells; grass is non-walkable in the initial park; queue-zone entry is controlled. Browsing uses neutral local wandering, not hidden persona-text attraction selection. Jev determines notice stop/enter/continue behavior. Route alternatives must map to genuinely different supported routes.

Physical knowledge and guest knowledge are different. Store observations with source, time, exact text and content version. Notice deduplication is by guest/place/content version plus cooldown. Visual notices use line of sight; aromas use proximity. App messages require the app, delivery, and attention assumptions. A guest may know a static map but not hidden live waits/closures. Do not remove a physically reachable travel option just because a closure is known only to the backend. Admission discovers the closure. Never give Jev operator-only global information.

## 5. Numeric, queue, payment, and measurement conventions

Wire coordinates: continuous metres, top-left grid origin, x right and y down; cell center `(col + 0.5, row + 0.5) * cellM`. Velocity is metres/second. Grid bytes are row-major `row * width + col`; codes are 0 blocked, 1 path, 2 plaza, 3 grass, 4 queue. Grid bytes and authored topology must match. Queue zones have explicit ownership, not merely a shared PNG color. Navigation/geometry validation precedes ready status.

Operational controls use `RunView.controlRevision`, which changes on accepted control commands, not every simulation pose update. Pause/resume/speed/cancel compare `expectedControlRevision`; a busy simulation must not make every control command stale. Scenario edits use the separate scenario revision.

Wire time: safe integer milliseconds since park opening. All scenario, dispatch, and service-duration boundaries are multiples of 5,000 ms in v1. Do not silently round invalid input. Display local clock time by adding opening time; do not use the browser timezone to determine simulation events. Wall-time epoch milliseconds are reserved for operational leases/shares. Monetary state is safe integer cents; validate multiplication, totals, refunds and overflow before execution. Probabilities are finite nonnegative doubles; reject missing/extra/duplicate options, zero sum, or sum error greater than `1e-6`; normalize only accepted round-off and preserve raw versus applied vectors.

Queue membership is authoritative. FIFO per lane, whole riding party, one queue/service per member. The default load policy guards a lane head after three missed dispatches, then fills toward configured pass/standard targets with documented deterministic borrowing/ties. Never bypass a head within its lane to pack smaller parties. If a party is larger than any supported vehicle, reject the offered admission rather than strand it forever. Pass share is a target, not a guaranteed exact fraction per vehicle.

A wait expectation is frozen on queue entry. For a numeric range, use the upper bound as the v1 promise-exceeded trigger; for a qualitative/unknown promise, use periodic queue checks without fabricating minutes. Keep displayed, expected, elapsed, and backend-predicted waits separate. Closure release is not voluntary abandonment. Active rides complete on a temporary closure; stop new boarding and release queued parties. At park closing, stop new queue admissions, complete active sessions, release remaining queue parties, and route guests out. At a fixed analysis horizon, take terminal horizon snapshots and mark still-present guests censored; cleanup/draining beyond the horizon does not alter that horizon's endpoints.

Pass purchase plus queue admission is atomic. Show all beneficiaries, units, quantities, quote revision, expiry and total. Four $25 passes cost $100. Reject a stale price unless an explicitly configured quote rule honors it; never charge a different price silently. V1 rejects stale quotes. Food/shop orders enqueue an immutable cart, debit only when service starts and affordability/quote validity pass, and create one sale event. If closed while waiting, cancel without charge; active paid service completes. No duplicate sale on completion. Do not lower hunger until an actual eating/service outcome defined by the model. No inventory claims without inventory mechanics. Refund events reference a prior sale and cannot exceed its unrefunded amount. Standalone purchase-intent scores never cause transactions.

Measure both (a) a deterministic modeled-experience ledger and (b) Jev satisfaction from a fixed rubric, separately. Default rating cadence: 30 simulated minutes and individual departure/horizon; use a predeclared departure/horizon-only mode for constrained runs. Never copy one leader rating to all members. Missing ratings stay missing; carry coverage and completeness. Map a valid score index to the display as `100 * index / (K-1)` and retain its distribution. A score is a synthetic judgment, not a validated human survey.

Canonical metric definitions:
- Net ancillary revenue = pass + food + shop sales less refunds; excludes admission. Revenue/guest divides by admitted guests, not concurrent occupancy. Do not call it profit without costs.
- Queue minutes/guest includes all queued person-minutes, including later-abandoned episodes. Completed-ride wait uses completed rider admissions only and is a separate statistic.
- Abandonment rate uses voluntarily abandoned person-queue episodes / joined person-queue episodes; closure releases are distinct. Queue-time share uses queued / total in-park person-time.
- Rides/guest uses completed rider admissions. Early departure compares actual exit with pre-sampled planned exit using the declared threshold, default 30 minutes. Leaving two hours before close is only a separate descriptive measure.
- Satisfaction uses one terminal departure-or-common-horizon rating per admitted individual, including early leavers; publish available-case values and coverage, never impute missing values to zero.
- Use null, not NaN/infinity or invented zero, for an undefined denominator. Distinguish used seats/dispatched seats from busy/available server time.

## 6. Stable identity, serialization, randomness, and cache

Use stable IDs within a run, scoped everywhere by `runId`. Stable guest/group/place IDs remain the same across paired variants; internal database row IDs do not define behavior. JSON schemas reject invalid units, unknown enum values and oversized payloads. Typed boundary objects are versioned; raw vendor JSON/event-specific details are explicitly separate.

Canonical JSON recursively sorts object keys by ASCII/code-unit order, preserves array order and exact string content, and uses JSON string/number serialization with no whitespace. Omit absent optional keys before serialization; reject undefined array values, non-finite numbers, BigInt, Map, Set, functions, and non-plain objects. Do not Unicode-normalize or trim observed text. Hash UTF-8 canonical bytes using SHA-256, lowercase hex. In a DecisionRequest, `observationHash = hash(observation)` and `optionsHash = hash({ options, promptOptionOrder })`; the latter must bind executable arguments AND the actual prompt permutation. `promptOptionOrder` is a complete unique permutation of the offered IDs. Use the supplied golden vectors to check cross-runtime behavior. Keep cryptographic operational nonces separate from reproducible simulation randomness.

Semantic random value: canonicalize `["behavior-rng-v1", seed, stream, ...keys]`, SHA-256 it, take the first 13 hex digits as an integer, and divide by `2^52`. For behavioral draws use stream `behavior` and keys `[stableGroupId, moment, momentSeq]`. Sampling uses option IDs in ascending ASCII order and inverse CDF with `u < cumulative`; the final interval absorbs only normalization round-off. Never include run/variant ID, wall time, HTTP order, batching, or cache status. Separate streams for personas, arrivals, service, movement and behavior. Treat near-zero chance as chance, not deterministic top-one selection. Temperature stays 1 in the initial experiment.

Physical-state hashes include sorted agents, poses, needs, observations/memories, plans/counters, queues, services, wallets, entitlements and operational world state at the same committed boundary. Exclude run/variant row IDs, transport leases/times, narration, rating-delivery timing and API latency. Keep scheduled scenario/config hashes in the run manifest separately; compare equal physical checkpoint state before applying different interventions. Exact replay additionally verifies the manifest and scheduled-event tape, so a physical-state hash is not a substitute for those records.

Cache key = SHA-256 of canonical exact semantic model request + requested model/policy version + executable option-contract hash. Include text, goals, persona, needs, budget, memory, quoted prices/quantities, option descriptions/order and rubric. Exclude lease tokens, request IDs and transport-only wall timestamps from the model request itself. Cache distributions, not chosen actions. Deduplicate in-flight identical calls. Use a versioned write-once response namespace per experiment; no TTL-driven behavior changes. Keep original raw response/model identity and raw/applied distributions. A cache entry from mock/fallback is never silently a Jev cache entry. Exact cache may have few hits; budget honestly.

## 7. Durable commands, work, artifacts, and authorization

`RuntimeClient` is a portable application port, not a promise that a reducer returns an object. Commands carry a caller-generated `commandId`. A stores a private durable receipt under `(callerIdentity, commandId)` with a canonical payload hash. Same ID/same payload returns the original result; same ID/different payload is CONFLICT. A's client subscribes/queries the receipt and resolves the Promise. A lost acknowledgement is retried with the SAME command ID. A new intent, such as a later claim/renewal/advance, uses a new command ID; do not reuse one constant ID for a worker loop. Expected domain failures produce committed rejected receipts, not a throw that rolls the receipt back. Unexpected reducer traps are surfaced as errors, never an endlessly pending success. This is at-least-once delivery with idempotent effects, not a claim of exactly-once external HTTP execution. Domain failures use `Receipt.ok=false`; transport failures are distinguishable and retriable. Reads and transport failures throw the contract's `RuntimeClientError` shape (`error`, `transport`); commands return domain rejections in receipts. Historical pages are ordered deterministically; metric pages sort by `(simMs, revision)` and consumers keep the latest revision for each measurement time. Event pagination uses `nextAfterSequence`; other histories use opaque cursors, which must be reused only with the same filters. No success toast before an accepted receipt.

Work lifecycle: pending -> leased -> ready -> applied for decisions; pending -> leased -> ready for completed nonbehavior jobs. Invalid attempts are recorded then retried/failed, not silently normalized beyond tolerance. Pending/leased/ready may be superseded/cancelled. Claims and renewals use server wall time, authenticated identity, attempt, lease token and expiry. Late/expired/replaced attempts cannot overwrite the winner. `ready` is not `applied`. A alone transitions physical consequences. Intelligence validates before submission; Engine validates again at the trust boundary.

`claimWork` validates requested kinds against role. Worker identities handle decisions, ratings, population and text jobs; a separately authorized coordinator identity handles experiment jobs and its assigned child runs. A generic worker cannot schedule scenarios or drive arbitrary runs. A runs authorization tests for each command/query/view. Roles and grants are server-enforced, including subscriptions and artifacts. Ordinary viewers cannot start runs or inject events; a viewer may request only rate-limited narration for an evidence record they can read. Run access does not automatically imply access to every experiment or private response blob.

Artifacts use immutable content-hashed references, bounded sizes, authenticated ownership, explicit run/experiment scope and resumable/idempotent chunk handling in the Engine adapter. Staging is not visible as a complete artifact. Verify full hash and expected kind before promotion/use. Never have a reducer fetch an HTTP URL or read a client filesystem path. Large PNG authoring assets are compiled by A's local tooling into a ParkBundle before upload. Population/checkpoint/report payloads are validated JSON artifacts. Completing a job attaches result artifacts to its authorized requester/run; do not leak private content through global hash lookup. The API-key-bearing vendor response and internal lease records are not public projection data.

Use a trusted allowlist/bootstrap flow for local operator/worker identities; anonymous users cannot self-promote. Share links contain high-entropy capability material generated with an appropriate cryptographic source outside the simulation RNG, server stores only hashes, grants expire/revoke, and redemption binds a scoped role to the caller. C should use a URL fragment for redemption and remove the secret from browser history immediately after processing. Never log capability tokens or persist them in report artifacts. Do not use sequence numbers as secret access tokens. Delegating operator access is restricted to the run owner or an explicit delegation grant; being a temporary operator does not automatically permit unlimited further delegation.

## 8. Nonblocking product workflows and integration seams

Setup: C selects a ready registered park and submits a population job. A validates/records it. B samples traits/groups/goals/arrival/departure, freezes accepted prose, uploads the population artifact and completes the job. C previews it, then submits `createRun` with both immutable artifacts, scenario and config. A validates again, prepares navigation/state and exposes ready status; only then start. Reusing a crowd across variants reuses the actual manifest, not another prompt with the same seed.

What-if: C requests parse -> B returns a typed draft with assumptions/unsupported parts -> C shows the change and time -> operator confirms -> A schedules against an expected scenario revision at an unprepared valid boundary. If context advanced past the requested application time, return a conflict and request confirmation of the corrected draft, not a hidden time shift. Comparative runs reject ad hoc edits; propose a new exploratory run/scenario instead.

Inspector: C loads an immutable decision by evidence ID, displays actual data, and may request narration for that ID. A supplies B the frozen evidence, not a moving live-agent query. B returns tagged narration. A later click on another guest must not receive the first guest's stale asynchronous thought.

Experiment: C creates a fixed spec. B's coordinator obtains its durable job, creates one frozen population per seed, and runs paired A/B children through A's exact same advance path. A permits only one driver per run via fenced driver lease/epoch; live scheduler and coordinator cannot both drive it. B renews long-lived work/driver leases, resumes from persisted progress and receipts after restart, and does not rerun a completed arm accidentally. B's experiment executor must NOT occupy all worker capacity while awaiting the very behavior jobs that advance its run. Separate executor/semaphores/identities and reserve capacity for barrier-critical work. Ratings and user text jobs must eventually progress too.

Usage telemetry: B submits `recordProviderAttempt` once in started phase before each actual provider attempt and once in finished phase after it. A validates the associated work/caller and stores one monotonic attempt record per call ID; duplicate telemetry cannot double-charge. A finished record cannot regress to started. Attribute a coalesced call to one declared billing-owner run (or common preparation scope), and count it once account-wide; all beneficiaries retain provenance. Cache hits do not create a provider attempt. A crash leaving only started means unresolved/unknown usage, not zero spend. A late usage record may be accepted for a formerly owned attempt without reopening its expired decision lease or mutating physics. Secrets and prompt bodies do not belong in this telemetry.

Reports: A owns canonical run accumulators and run fact bundles. B owns paired analysis, experiment fact bundles, response tapes and narrative composition; A stores/exposes them as versioned artifacts. C formats numbers/units and visualizes facts, never recomputes a competing KPI definition. Facts carry IDs, definitions, denominators, coverage and provenance. LLM prose uses fact references resolved by code or falls back to deterministic templates. Do not label model penalty allocation as discovered real-world causality.

## 9. Pairing, failure policy, replay, and release gates

First A/B changes only the pass unit price from 1,500 to 2,500 cents at the declared common point; all boards/messages and other settings are held fixed. A bundled change can be supported but must be labeled bundled. The price result is unknown: do not force revenue up or satisfaction down. A board-only or app-only test is a distinct experiment, not a post hoc rescue hidden inside the first one.

Predeclare seeds, population generator, scenario diff, observation/option/meter/queue/rating versions, horizon, analysis and operational budget. Paired whole-park differences are `B_i - A_i`; interacting guests are not independent replications. Default to 3-5 pairs with individual differences and mean/min/max/sample SD, labeled exploratory. One pair is an illustration. Min/max is not a confidence interval. Optional paired-t analysis requires an explicit analysis choice and disclosed assumptions; it quantifies modeled mean-difference variability, not calibration error. Do not search seeds until a favorable story appears. Failed/degraded/missing pairs remain visible and do not silently enter the valid-pair denominator.

A/A with identical scenarios, manifests, seeds and frozen provider fixtures must yield identical physical hashes and zero metric deltas. Reorder responses, change batching, change playback speed, restart workers and replay after a checkpoint: with identical response fixtures, mechanics must still match. Fresh external model calls are not an exact-determinism test.

Visual replay uses recorded frames with known resolution. Exact execution replay uses full checkpoint, manifest, applied-action/response tape, logical timing and engine version, with no new inference. `RunManifest.replayTape` is required for exact replay and null for fresh mock/live/experiment runs; the initial checkpoint and tape must refer to compatible engine/schema/population versions. Fresh stochastic rerun is a different mode. Clone checkpoints only at an explicitly supported committed phase; remap run scope and recreate operational leases/work registrations while preserving semantic decisions, observations, service state and random counters. Do not replay a saved position array as though it were complete state.

Release gates are executable evidence: complete mock day; real-Jev smoke/run when credentials permit; invariant and protocol fault suites; frozen-fixture A/A; one traceable price comparison; recoverable recorded run; authenticated viewer/operator isolation; measured live performance profile. No polished animation substitutes for them. Unit coverage targets are at least 90% branches for money, queues, protocol, sampling, cache and experiment accounting; other lane code targets at least 80% branches. Coverage is a diagnostic, not proof of correctness. Cover every named acceptance case regardless of percentage.

There is no assumed 36-hour stop condition. P0/P1 are implementation order and risk controls, not permission to stop at a partial scaffold. Complete the owned core and planned product paths, and stage expansion toward the full authored park after the first working slice. Record genuine blocked/deferred features explicitly.

P0: full core journey, synthetic grid/individual motion, together-groups, queues/purchases, notices/browsing, durable inference, evidence, fixed-schedule measurement, A/A and one paired result, basic heatmap and fact-backed report, secure sharing, recoverable replay and honesty labels. P1: multi-seed UI, authored full park expansion, heatmap polish, report export, more levers, true route alternatives and richer content. P2: bump reactions, splitting, speech bubbles, polished replay scrubber. The relevant basic heatmap and report data path remains required even if presentation polish is P1. Blueprint import, 3D, automatic optimization, external venue models and live real-world telemetry are explicitly future scope. Every feature still has a lane owner; do not ship placeholder controls for disabled work.

At completion, provide `docs/HANDOFF.md` with branch/base/HEAD, commits, owned files, implemented feature IDs, exact commands/results, fixture-versus-real coverage, environment variables, adapter requirements, demo steps, benchmark hardware/workload, incomplete gates, risks and any proposed contract changes. No invented passes, hidden skipped tests, unresolved core TODOs presented as done, or sweeping unrelated refactors.
<!-- END_SHARED_CHARTER -->


---

# Appendix A - Frozen portable TypeScript contract

Copy the code fence contents exactly to `engine/contract/behavior-v1.ts`. Do not add lane-specific fields to this mirror. Implement internal extensions in other files. The same code is embedded in all three prompts. SHA-256 of its UTF-8 LF-terminated bytes: `c25776a4883f70c71e8b4991dabc1b7a641baa8baeb615b1cfc145c0b8f1aac4`.

<!-- BEGIN_FROZEN_CONTRACT -->
```typescript
/** Frozen application contract, behavior.v1. Not a vendor SDK or implementation. */
export const CONTRACT_VERSION = 'behavior.v1' as const;
export type ContractVersion = typeof CONTRACT_VERSION;
export type Id = string; // ASCII [A-Za-z0-9_.:-], 1..160 chars; always scope by run.
export type Hash = string; // Lowercase SHA-256 hex.
export type SimMs = number; // Nonnegative safe integer milliseconds from park opening.
export type Cents = number; // Safe integer USD cents; no floating-point money.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Mode = 'mock' | 'live' | 'experiment' | 'replay';
export type Source = 'jev' | 'cache' | 'mock' | 'fallback';
export type Role = 'viewer' | 'operator' | 'worker' | 'coordinator';
export type Vec2 = { xM: number; yM: number };
export type Velocity = { xMps: number; yMps: number };
export type Scope = { runId: Id | null; experimentId: Id | null };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type SequencePage<T> = { items: T[]; nextAfterSequence: number | null };
export type ArtifactKind = 'park' | 'population' | 'model_response' | 'checkpoint'
  | 'response_tape' | 'fact_bundle' | 'experiment_report' | 'narrative' | 'frames';
export type ArtifactRef = {
  artifactId: Id; kind: ArtifactKind; sha256: Hash; byteLength: number;
  mediaType: string; contractVersion: ContractVersion;
};
export type DomainError = {
  code: 'INVALID_INPUT' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT'
    | 'STALE_REVISION' | 'STALE_LEASE' | 'INVALID_STATE' | 'UNSUPPORTED'
    | 'RATE_LIMITED' | 'DEPENDENCY_UNAVAILABLE' | 'INCOMPLETE' | 'INTERNAL';
  message: string; retryable: boolean; fieldErrors: { path: string; message: string }[];
};
export interface RuntimeClientError extends Error {
  name: 'RuntimeClientError'; error: DomainError; transport: boolean;
}
export type Receipt<T> =
  | { commandId: Id; ok: true; result: T }
  | { commandId: Id; ok: false; error: DomainError };
export type VersionSet = {
  engine: string; observation: string; options: string; random: string;
  persona: string; prompt: string; requestedModel: string; meter: string;
  loading: string; metrics: string; rubric: string; replay: string; sourceCommit: string;
};
export type FeatureFlags = {
  routeChoice: boolean; bumpReactions: boolean; splitGroups: boolean;
  speechBubbles: boolean; discountMessages: boolean;
};
export type Capabilities = {
  contractVersion: ContractVersion; eventKinds: ScenarioEvent['change']['kind'][];
  workKinds: ProductRequest['kind'][]; features: FeatureFlags;
  maxGuests: number; maxArtifactBytes: number; maxChunkBytes: number;
};

// PARK. PNG is an authoring format. This is the validated, portable runtime payload.
export type CellCode = 0 | 1 | 2 | 3 | 4; // blocked,path,plaza,grass,queue
export type Grid = {
  width: number; height: number; cellM: number; encoding: 'u8-row-major-v1';
  cellsBase64: string; cellsSha256: Hash; grassWalkable: boolean;
};
export type QueueZone = { id: Id; placeId: Id; cellIndices: number[]; entry: Vec2; exit: Vec2 };
export type WaitDisplay =
  | { kind: 'rounded_estimate'; roundToMin: number; template: string }
  | { kind: 'range_estimate'; roundToMin: number; spreadMin: number; template: string }
  | { kind: 'fixed'; lowerMin: number | null; upperMin: number | null; text: string };
export type Service =
  | { kind: 'ride'; seats: number; vehicles: number; dispatchMs: SimMs;
      durationMs: SimMs; turnaroundMs: SimMs; passShareBps: number; passEnabled: boolean }
  | { kind: 'counter'; servers: number; serviceMs: SimMs; activityMs: SimMs;
      products: { id: Id; label: string; unitPriceCents: Cents }[] }
  | { kind: 'show'; seats: number; startsAtMs: SimMs[]; durationMs: SimMs }
  | { kind: 'rest'; durationMs: SimMs }
  | { kind: 'none' };
export type Notice = { text: string; channel: 'visual' | 'aroma'; radiusM: number; cooldownMs: SimMs };
export type Place = {
  id: Id; name: string; kind: 'ride' | 'food' | 'shop' | 'restroom' | 'show'
    | 'scenery' | 'entrance' | 'exit'; entrance: Vec2; queueZoneId: Id | null;
  service: Service; minHeightCm: number | null; thrill: number;
  board: WaitDisplay | null; notice: Notice | null;
};
export type RouteProfile = { id: Id; destinationId: Id; via: Vec2[]; label: string };
export type ParkBundle = {
  contractVersion: ContractVersion; parkId: Id; revision: string; label: string;
  openLocal: string; closeAfterMs: SimMs; grid: Grid; places: Place[];
  queueZones: QueueZone[]; routeProfiles: RouteProfile[];
  pass: { productId: Id; unitPriceCents: Cents; unit: 'per_guest'; validity: 'remaining_day' };
};
export type ParkSummary = {
  parkId: Id; revision: string; label: string; artifact: ArtifactRef;
  status: 'preparing' | 'ready' | 'invalid'; issues: string[];
};

// POPULATION. All behavioral traits/goals/hooks are sampled in code, then frozen.
export type Archetype = 'young_family' | 'teens' | 'couple' | 'thrill_seekers' | 'seniors' | 'solo';
export type CrowdSpec = {
  guestCount: number; seed: string; shares: Record<Archetype, number>;
  contextNotes: string; generatorVersion: string;
};
export type Needs = { hunger: number; fatigue: number; patience: number; fun: number };
export type Persona = {
  agentId: Id; groupId: Id; archetype: Archetype; role: 'parent' | 'child' | 'teen' | 'adult' | 'senior';
  ageYears: number; heightCm: number; walkSpeedMps: number; thrillPreference: number;
  initialNeeds: Needs; hungerPerHour: number; fatiguePerKm: number; patiencePerMinute: number;
  familiarity: number; hasApp: boolean; language: string;
  phoneActiveUntilMs: SimMs | null; stroller: boolean; mobilityRestricted: boolean;
  occasion: string; mustDoPlaceIds: Id[]; backstory: string;
};
export type GroupManifest = {
  groupId: Id; memberIds: Id[]; leaderId: Id; guardianIds: Id[]; rallyPlaceId: Id;
  walletId: Id; startingBalanceCents: Cents; arrivalMs: SimMs; plannedDepartureMs: SimMs;
};
export type PopulationManifest = {
  contractVersion: ContractVersion; populationId: Id; crowd: CrowdSpec;
  parkHash: Hash; personas: Persona[]; groups: GroupManifest[];
  proseVersion: string; randomVersion: string;
  diversity: { key: string; counts: Record<string, number> }[];
};

// SCENARIOS. Geometry mutation is deliberately not an MVP event.
export type ScenarioChange =
  | { kind: 'pass_price'; unitPriceCents: Cents }
  | { kind: 'pass_share'; placeId: Id; shareBps: number }
  | { kind: 'board'; placeId: Id; display: WaitDisplay }
  | { kind: 'notice'; placeId: Id; notice: Notice }
  | { kind: 'closure'; placeId: Id; closed: boolean }
  | { kind: 'show_schedule'; placeId: Id; startsAtMs: SimMs[] }
  | { kind: 'app_message'; messageId: Id; text: string; expiresAtMs: SimMs;
      suggestedPlaceId: Id | null; discount: null | {
        productIds: Id[]; discountBps: number; maxUsesPerGroup: number;
      } };
export type ScenarioEvent = { id: Id; atMs: SimMs; order: number; change: ScenarioChange };
export type Scenario = { id: Id; revision: string; label: string; events: ScenarioEvent[] };
export type ScenarioContext = {
  runId: Id | null; currentSimMs: SimMs; earliestSchedulableMs: SimMs;
  scenarioRevision: string; park: ParkSummary; places: Pick<Place, 'id' | 'name' | 'kind'>[];
  capabilities: Capabilities;
};
export type ScenarioDraft = {
  draftId: Id; contextRevision: string; events: ScenarioEvent[];
  assumptions: string[]; unsupported: string[]; requiresConfirmation: true;
};
export type RunConfig = {
  mode: Mode; horizonMs: SimMs; logicalStepMs: 5000; movementStepMs: 250;
  requestedSpeed: number; temperature: 1; earlyDepartureThresholdMs: SimMs;
  ratingEveryMs: SimMs | null; visualFrameEveryMs: SimMs; checkpointEveryMs: SimMs;
  fallback: 'forbidden' | 'live_timeout_v1'; liveTimeoutMs: number;
  features: FeatureFlags; versions: VersionSet;
};
export type RunManifest = {
  contractVersion: ContractVersion; park: ArtifactRef; population: ArtifactRef;
  scenario: Scenario; replicateSeed: string; config: RunConfig;
  experiment: null | { experimentId: Id; pairId: Id; arm: 'A' | 'B' };
  initialCheckpoint: ArtifactRef | null; replayTape: ArtifactRef | null;
};
export type BoundaryPhase = 'prepare' | 'requests' | 'barrier' | 'apply'
  | 'dispatch' | 'integrate' | 'persist';
export type RunStatus = 'preparing' | 'ready' | 'running' | 'paused' | 'blocked'
  | 'draining' | 'completed' | 'failed' | 'cancelled';
export type Quality = {
  comparisonEligible: boolean; reasons: string[]; behaviorCounts: Record<Source, number>;
  invalidAttempts: number; staleAttempts: number; pendingRatings: number;
  terminalRatingsExpected: number; terminalRatingsComplete: number;
};
export type RunView = {
  runId: Id; revision: number; controlRevision: number; manifestHash: Hash; mode: Mode; status: RunStatus;
  simMs: SimMs; stepIndex: number; phase: BoundaryPhase; scenarioRevision: string;
  earliestSchedulableMs: SimMs; requestedSpeed: number; achievedSpeed: number;
  blockedWorkIds: Id[]; quality: Quality;
};

// OBSERVATION AND DECISION. Runtime owns these snapshots and executable actions.
export type ObservationFact = {
  id: Id; kind: 'board' | 'notice' | 'message' | 'price' | 'crowd' | 'closure' | 'experience';
  placeId: Id | null; source: 'sight' | 'aroma' | 'app' | 'memory' | 'static_map' | 'self';
  observedAtMs: SimMs; contentVersion: string; text: string;
  waitLowerMs: SimMs | null; waitUpperMs: SimMs | null; priceCents: Cents | null;
};
export type KnownDestination = {
  placeId: Id; name: string; walkEstimateMs: SimMs | null;
  lastObservedFactIds: Id[]; knownRestrictions: string[];
};
export type GuestObservation = {
  schema: 'observation.v1'; groupId: Id; leaderId: Id; atMs: SimMs;
  members: { persona: Persona; needs: Needs }[];
  wallet: { walletId: Id; balanceCents: Cents };
  facts: ObservationFact[]; knownDestinations: KnownDestination[];
  recentEventSummaries: { eventId: Id; atMs: SimMs; text: string }[];
  currentActivity: string; plannedDepartureMs: SimMs;
};
export type Quote = {
  quoteId: Id; revision: string; productId: Id; unitPriceCents: Cents;
  quantity: number; totalCents: Cents; beneficiaryIds: Id[]; validUntilMs: SimMs;
  discountMessageId: Id | null;
};
export type Action =
  | { kind: 'travel'; placeId: Id; routeProfileId: Id | null }
  | { kind: 'browse'; durationMs: SimMs }
  | { kind: 'rest'; placeId: Id; durationMs: SimMs }
  | { kind: 'join_queue'; placeId: Id; lane: 'standard' | 'pass'; riderIds: Id[] }
  | { kind: 'leave_queue'; queueEntryId: Id }
  | { kind: 'buy_pass_and_join'; placeId: Id; riderIds: Id[]; quote: Quote }
  | { kind: 'order'; placeId: Id; cart: Quote[] }
  | { kind: 'leave_park' }
  | { kind: 'continue' }
  | { kind: 'notice_stop'; placeId: Id; durationMs: SimMs }
  | { kind: 'notice_enter'; placeId: Id }
  | { kind: 'route'; profileId: Id }
  | { kind: 'bump_response'; response: 'continue' | 'step_aside'; durationMs: SimMs }
  | { kind: 'regroup'; rallyPlaceId: Id };
export type ActionOption = { id: Id; label: string; description: string; action: Action };
export type Moment = 'forced_replan' | 'what_next' | 'noticed' | 'join_line' | 'stay_line'
  | 'hungry_tired' | 'message_seen' | 'closing_soon' | 'route_choice' | 'bumped' | 'separated';
export type DecisionRequest = {
  contractVersion: ContractVersion; requestId: Id; runId: Id; groupId: Id;
  agentIds: Id[]; moment: Moment; decisionSeq: number; momentSeq: number; requestRevision: number;
  createdAtMs: SimMs; applyAtMs: SimMs; planRevision: number;
  dependencyRevisions: Record<string, string>; observationHash: Hash; optionsHash: Hash;
  policyVersion: string; observation: GuestObservation; options: ActionOption[];
  promptOptionOrder: Id[];
  candidateAudit: { considered: Id[]; excluded: { id: Id; reason: string }[] };
};
export type Distribution = { optionId: Id; probability: number }[];
export type Usage = {
  callId: Id | null; inputTokens: number | null; outputTokens: number | null;
  estimatedCostUsd: number | null; priceVersion: string | null;
  queueMs: number; httpMs: number; attemptCount: number;
};
export type ProviderAttempt = {
  callId: Id; workId: Id; phase: 'started' | 'finished'; provider: 'jev' | 'prose';
  modelRequested: string; modelReturned: string | null; startedAtEpochMs: number;
  durationMs: number | null; outcome: null | 'success' | 'timeout' | 'rate_limited' | 'invalid' | 'error';
  inputTokens: number | null; outputTokens: number | null;
  estimatedCostUsd: number | null; priceVersion: string | null; billingOwnerRunId: Id | null;
};
export type DecisionResult = {
  requestId: Id; observationHash: Hash; optionsHash: Hash; modelRequested: string;
  modelReturned: string; source: Source; probabilities: Distribution;
  confidence: number | null; responseArtifact: ArtifactRef; usage: Usage;
  cacheKey: Hash | null; originalSource: Exclude<Source, 'cache'>;
};
export type AppliedDecision = {
  evidenceId: Id; request: DecisionRequest; response: DecisionResult;
  appliedProbabilities: Distribution; draw: number; chosenOptionId: Id;
  outcome: 'committed' | 'failed_precondition'; failureReason: string | null;
  committedAtMs: SimMs; causedEventIds: Id[];
};

// MEASUREMENTS ARE FROZEN JOBS, NOT BEHAVIORAL DEPENDENCIES.
export type RatingRequest = {
  ratingId: Id; runId: Id; agentId: Id; atMs: SimMs;
  endpoint: 'periodic' | 'departure' | 'horizon'; evidenceHash: Hash;
  observation: GuestObservation; rubricVersion: string; levels: string[];
};
export type RatingResult = {
  ratingId: Id; evidenceHash: Hash; rubricVersion: string; scoreIndex: number;
  probabilities: number[]; source: Source; modelReturned: string;
  responseArtifact: ArtifactRef; usage: Usage;
};
export type MetricId = 'net_revenue_cents' | 'revenue_per_guest_cents'
  | 'satisfaction_0_100' | 'queue_minutes_per_guest' | 'completed_ride_wait_minutes'
  | 'rides_per_guest' | 'abandonment_rate' | 'queue_time_share'
  | 'early_departures' | 'ride_seat_utilization' | 'server_utilization';
export type MetricValue = {
  id: MetricId; value: number | null; unit: 'cents' | 'score' | 'minutes' | 'ratio' | 'guests';
  numerator: number; denominator: number | null; n: number; coverage: number;
  complete: boolean; missingReason: string | null;
};
export type MetricSnapshot = {
  runId: Id; simMs: SimMs; revision: number; definitionVersion: string;
  admittedGuests: number; guestsInPark: number; measures: Record<MetricId, MetricValue>;
};
export type EventKind = 'arrived' | 'observed' | 'queue_joined' | 'queue_left'
  | 'closure_release' | 'service_started' | 'service_completed' | 'purchase' | 'refund'
  | 'experience' | 'departed' | 'action_failed' | 'scenario_applied' | 'bump' | 'regrouped';
export type EventRecord = {
  eventId: Id; runId: Id; sequence: number; atMs: SimMs; kind: EventKind;
  groupId: Id | null; agentIds: Id[]; placeId: Id | null; position: Vec2 | null;
  causationId: Id | null; amountCents: Cents | null; experienceDelta: number | null;
  reason: string | null; details: Json; // kind-specific validated event schemas owned by Engine.
};
export type Health = {
  queuedWork: number; leasedWork: number; oldestRequestAgeMs: number;
  httpP95Ms: number | null; reducerP95Ms: number | null;
  calls: number; inputTokens: number; estimatedCostUsd: number | null;
  tokenCoverage: number; warnings: string[];
};
export type AgentView = {
  agentId: Id; groupId: Id; position: Vec2; velocity: Velocity;
  state: 'not_arrived' | 'walking' | 'browsing' | 'queueing' | 'riding' | 'eating'
    | 'shopping' | 'resting' | 'watching' | 'deciding' | 'left';
  targetPlaceId: Id | null; needs: Needs; experienceValue: number;
  rating: null | { value: number; atMs: SimMs; source: Source };
  latestEvidenceId: Id | null;
};
export type PlaceView = {
  placeId: Id; closed: boolean; boardText: string | null; boardVersion: string;
  noticeVersion: string; predictedWaitMs: SimMs | null; // operator truth; not guest knowledge
};
export type QueueView = {
  placeId: Id; standardPersons: number; passPersons: number;
  entries: { entryId: Id; agentIds: Id[]; lane: 'standard' | 'pass'; sequence: number;
    joinedAtMs: SimMs; positions: { agentId: Id; position: Vec2 }[] }[];
};
export type LiveSnapshot = {
  contractVersion: ContractVersion; run: RunView; agents: AgentView[]; places: PlaceView[];
  queues: QueueView[]; metrics: MetricSnapshot; health: Health; recentEvents: EventRecord[];
};
export type LivePatch = {
  runId: Id; fromRevision: number; toRevision: number; run: RunView;
  agents: { upsert: AgentView[]; removeIds: Id[] };
  places: PlaceView[]; queues: QueueView[]; metrics: MetricSnapshot | null;
  health: Health | null; appendedEvents: EventRecord[];
};
export type HeatLayer = 'waiting_person_minutes' | 'negative_experience'
  | 'spending_cents' | 'early_departures' | 'bump_episodes';
export type Heatmap = {
  runId: Id; layer: HeatLayer; fromMs: SimMs; toMs: SimMs; cellM: number;
  width: number; height: number; values: number[]; total: number;
  unit: string; denominator: string; complete: boolean;
};
export type ReplayFrame = { atMs: SimMs; frameSchema: string; snapshot: LiveSnapshot };
export type AgentDetail = {
  agent: AgentView; persona: Persona; group: GroupManifest;
  observedFacts: ObservationFact[]; evidence: AppliedDecision | null; recentEvents: EventRecord[];
};

// EXPERIMENTS AND REPORTS. No aggregate is allowed to hide an incomplete pair.
export type ExperimentSpec = {
  contractVersion: ContractVersion; experimentId: Id; park: ArtifactRef;
  crowd: Omit<CrowdSpec, 'seed'>; seeds: string[]; baseline: Scenario; variant: Scenario;
  config: RunConfig; interventionLabel: string; changedLever: string;
  analysis: 'paired_descriptive' | 'paired_t'; alpha: 0.05;
  operationBudgetMs: number; maxConcurrentArms: 1 | 2;
  start: { kind: 'opening' } | { kind: 'warmup'; toMs: SimMs; warmupScenario: Scenario };
};
export type PairResult = {
  pairId: Id; seed: string; populationHash: Hash; initialStateHash: Hash | null;
  aRunId: Id | null; bRunId: Id | null;
  status: 'pending' | 'running' | 'complete' | 'incomplete' | 'degraded' | 'failed';
  reasons: string[]; a: MetricSnapshot | null; b: MetricSnapshot | null;
  deltas: Partial<Record<MetricId, number>>;
};
export type PairedSummary = {
  metricId: MetricId; pairCount: number; differences: number[];
  mean: number | null; min: number | null; max: number | null; sampleSd: number | null;
  interval: null | { kind: 'paired_t_mean'; lower: number; upper: number; level: 0.95 };
};
export type ExperimentReport = {
  spec: ExperimentSpec; revision: number; status: 'running' | 'complete' | 'incomplete';
  pairs: PairResult[]; summaries: PairedSummary[]; requestedPairs: number; completePairs: number;
  exploratory: boolean; limitations: string[]; facts: ArtifactRef | null; responseTape: ArtifactRef | null;
};
export type Fact = {
  id: Id; label: string; value: number | string; unit: string; denominator: string;
  scope: Scope; sourceEventIds: Id[]; metricId: MetricId | null; limitations: string[];
};
export type FactBundle = {
  contractVersion: ContractVersion; id: Id; asOfMs: SimMs; sourceHash: Hash;
  facts: Fact[]; quality: Quality | null; scope: Scope;
};
export type Narrative = {
  id: Id; evidenceHash: Hash; origin: 'template' | 'llm';
  label: 'narrated from state' | 'modeled-results report';
  sections: { heading: string; segments: ({ kind: 'text'; text: string }
    | { kind: 'fact'; factId: Id })[] }[];
  limitations: string[];
};

// JOBS. Only Engine creates behavior/rating jobs from authoritative snapshots.
export type WorkPayloads = {
  decision: DecisionRequest;
  rating: RatingRequest;
  population: { crowd: CrowdSpec; park: ArtifactRef; closeAfterMs: SimMs };
  parse_crowd: { text: string; current: CrowdSpec };
  parse_scenario: { text: string; context: ScenarioContext };
  thought: { evidence: AppliedDecision; agentId: Id };
  experiment: ExperimentSpec;
  report: { facts: FactBundle };
};
export type WorkResults = {
  decision: DecisionResult; rating: RatingResult;
  population: { artifact: ArtifactRef; guestCount: number; groupCount: number };
  parse_crowd: { proposal: CrowdSpec; assumptions: string[]; unsupported: string[] };
  parse_scenario: ScenarioDraft; thought: Narrative;
  experiment: { report: ArtifactRef }; report: Narrative;
};
export type WorkKind = keyof WorkPayloads;
export type WorkLease = {
  workId: Id; attempt: number; leaseToken: string; expiresAtEpochMs: number; ownerIdentity: string;
};
export type LeasedWork = { [K in WorkKind]: {
  kind: K; scope: Scope; lease: WorkLease; payload: WorkPayloads[K];
} }[WorkKind];
export type CompletedWork = { [K in WorkKind]: {
  kind: K; lease: WorkLease; result: WorkResults[K];
} }[WorkKind];
export type WorkStatus = { [K in WorkKind]: {
  workId: Id; kind: K; status: 'pending' | 'leased' | 'ready' | 'applied'
    | 'failed' | 'cancelled' | 'superseded';
  result: WorkResults[K] | null; error: DomainError | null;
} }[WorkKind];
export type ProductRequest =
  | { kind: 'population'; crowd: CrowdSpec; park: ArtifactRef }
  | { kind: 'parse_crowd'; text: string; current: CrowdSpec }
  | { kind: 'parse_scenario'; text: string; runId: Id | null; park: ArtifactRef;
      expectedScenarioRevision: string }
  | { kind: 'thought'; runId: Id; evidenceId: Id; agentId: Id }
  | { kind: 'report'; runId: Id | null; experimentId: Id | null };
export type DriverLease = { runId: Id; epoch: number; token: string; expiresAtEpochMs: number };
export type AdvanceResult = {
  run: RunView; completedSteps: number; physicalStateHash: Hash | null; blockedWorkIds: Id[];
};

// COMMANDS USE PRIVATE DURABLE RECEIPTS. A reducer's void return is not a result DTO.
export type Commands = {
  registerPark: { input: { artifact: ArtifactRef }; output: ParkSummary };
  requestProductWork: { input: { request: ProductRequest }; output: { workId: Id } };
  createRun: { input: { manifest: RunManifest }; output: { runId: Id } };
  startRun: { input: { runId: Id }; output: RunView };
  pauseRun: { input: { runId: Id; expectedControlRevision: number }; output: RunView };
  resumeRun: { input: { runId: Id; expectedControlRevision: number }; output: RunView };
  setSpeed: { input: { runId: Id; requestedSpeed: number; expectedControlRevision: number }; output: RunView };
  cancelRun: { input: { runId: Id; expectedControlRevision: number }; output: RunView };
  scheduleEvents: { input: { runId: Id; expectedScenarioRevision: string;
    draftId: Id | null; events: ScenarioEvent[] }; output: { scenarioRevision: string; events: ScenarioEvent[] } };
  claimWork: { input: { kinds: WorkKind[]; limit: number; workerNonce: string;
    leaseMs: number }; output: { items: LeasedWork[] } };
  renewWork: { input: { leases: WorkLease[]; leaseMs: number }; output: { leases: WorkLease[] } };
  completeWork: { input: { item: CompletedWork }; output: { workId: Id; status: WorkStatus['status'] } };
  recordProviderAttempt: { input: { attempt: ProviderAttempt }; output: { callId: Id; phase: 'started' | 'finished' } };
  failWork: { input: { lease: WorkLease; error: DomainError; retryAtEpochMs: number | null };
    output: { workId: Id; status: WorkStatus['status'] } };
  acquireDriver: { input: { runId: Id; leaseMs: number }; output: DriverLease };
  renewDriver: { input: { lease: DriverLease; leaseMs: number }; output: DriverLease };
  advanceRun: { input: { lease: DriverLease; expectedStep: number; expectedPhase: BoundaryPhase;
    maxSteps: number }; output: AdvanceResult };
  releaseDriver: { input: { lease: DriverLease }; output: { released: boolean } };
  checkpointRun: { input: { runId: Id }; output: { checkpoint: ArtifactRef; physicalStateHash: Hash } };
  createExperiment: { input: { spec: ExperimentSpec }; output: { experimentId: Id; workId: Id } };
  recordExperimentProgress: { input: { experimentId: Id; lease: WorkLease;
    report: ExperimentReport }; output: { revision: number } };
  issueShare: { input: { runId: Id; access: 'viewer' | 'operator'; tokenHash: Hash;
    expiresAtEpochMs: number }; output: { grantId: Id } };
  redeemShare: { input: { token: string }; output: { runId: Id; role: 'viewer' | 'operator' } };
  revokeShare: { input: { grantId: Id }; output: { revoked: boolean } };
};
export type Queries = {
  capabilities: { input: Record<string, never>; output: Capabilities };
  session: { input: Record<string, never>; output: { identity: string; roles: Role[]; runIds: Id[] } };
  listParks: { input: { cursor: string | null }; output: Page<ParkSummary> };
  getRun: { input: { runId: Id }; output: RunView };
  getManifest: { input: { runId: Id }; output: RunManifest };
  getLiveSnapshot: { input: { runId: Id }; output: LiveSnapshot };
  getAgent: { input: { runId: Id; agentId: Id }; output: AgentDetail };
  getDecision: { input: { runId: Id; evidenceId: Id }; output: AppliedDecision };
  getWork: { input: { workId: Id }; output: WorkStatus };
  getMetrics: { input: { runId: Id; fromMs: SimMs; toMs: SimMs; cursor: string | null };
    output: Page<MetricSnapshot> };
  getEvents: { input: { runId: Id; afterSequence: number; limit: number }; output: SequencePage<EventRecord> };
  getHeatmap: { input: { runId: Id; layer: HeatLayer; fromMs: SimMs; toMs: SimMs }; output: Heatmap };
  getFrames: { input: { runId: Id; fromMs: SimMs; toMs: SimMs; cursor: string | null };
    output: Page<ReplayFrame> };
  getExperiment: { input: { experimentId: Id }; output: ExperimentReport };
  getFactBundle: { input: { runId: Id | null; experimentId: Id | null }; output: FactBundle };
};
export type RuntimeConfig = {
  uri: string; database: string; token: string | null;
  onToken?: (token: string) => void;
};
export interface RuntimeClient {
  readonly contractVersion: ContractVersion;
  command<K extends keyof Commands>(name: K, input: Commands[K]['input'],
    commandId: Id): Promise<Receipt<Commands[K]['output']>>;
  query<K extends keyof Queries>(name: K, input: Queries[K]['input']): Promise<Queries[K]['output']>;
  subscribeLive(runId: Id, handlers: {
    snapshot: (value: LiveSnapshot) => void; patch: (value: LivePatch) => void;
    status: (value: 'connecting' | 'live' | 'reconnecting' | 'closed') => void;
    error: (value: DomainError) => void;
  }): () => void;
  subscribeWorkAvailable(kinds: WorkKind[], wake: () => void): () => void;
  putArtifact(input: { kind: ArtifactKind; mediaType: string; bytes: Uint8Array;
    scope: Scope; commandId: Id }): Promise<ArtifactRef>;
  getArtifact(ref: ArtifactRef): Promise<Uint8Array>;
  close(): Promise<void>;
}
export type CreateRuntimeClient = (config: RuntimeConfig) => Promise<RuntimeClient>;
```
<!-- END_FROZEN_CONTRACT -->

# Appendix B - Golden test vectors

Copy this JSON to `engine/fixtures/golden-vectors.json`. These are cross-lane canonicalization/randomness/arithmetic checks, not observed behavioral outcomes. In particular, integral JSON numbers serialize as JavaScript JSON.stringify does: 1.0 becomes 1.

<!-- BEGIN_GOLDEN_VECTORS -->
```json
{
  "version": "behavior-golden-v1",
  "canonicalJson": [
    {
      "input": {
        "z": 1,
        "a": {
          "b": 2,
          "a": "text"
        },
        "integralFloat": 1.0
      },
      "expectedCanonical": "{\"a\":{\"a\":\"text\",\"b\":2},\"integralFloat\":1,\"z\":1}",
      "sha256": "645800ffafbf4ac63108a5903cbcd86044880ee0d1f71afd0b0db2136663ed60"
    },
    {
      "input": {
        "text": "  Shop sign - $25  ",
        "order": [
          "b",
          "a"
        ],
        "fraction": 0.125
      },
      "expectedCanonical": "{\"fraction\":0.125,\"order\":[\"b\",\"a\"],\"text\":\"  Shop sign - $25  \"}",
      "sha256": "9b8b4e7c1b10639ede23deab40bccd0cd5e863d71940005dd27022fa88d39a44"
    }
  ],
  "random": [
    {
      "key": [
        "behavior-rng-v1",
        "seed-001",
        "behavior",
        "g001",
        "what_next",
        2
      ],
      "canonical": "[\"behavior-rng-v1\",\"seed-001\",\"behavior\",\"g001\",\"what_next\",2]",
      "sha256": "bdff702b00e101ea5d938bd73d941f4d0c4fbabc01060bb1f2546de4197e9514",
      "uniform": 0.7421789269436694
    },
    {
      "key": [
        "behavior-rng-v1",
        "seed-001",
        "personas",
        "g001",
        "budget"
      ],
      "canonical": "[\"behavior-rng-v1\",\"seed-001\",\"personas\",\"g001\",\"budget\"]",
      "sha256": "60f79c6e06640aef99539b070a407ce0b66e6aa5aeb4b35a2ab994c3b6293265",
      "uniform": 0.3787782448402055
    },
    {
      "key": [
        "behavior-rng-v1",
        "seed-002",
        "behavior",
        "g001",
        "what_next",
        2
      ],
      "canonical": "[\"behavior-rng-v1\",\"seed-002\",\"behavior\",\"g001\",\"what_next\",2]",
      "sha256": "528c865667b6a24c6a2e80700d4d1d0faf2f9c792c582a9b99dacd710278dab8",
      "uniform": 0.322456737608912
    }
  ],
  "sampling": [
    {
      "probabilities": [
        {
          "optionId": "browse",
          "probability": 0.2
        },
        {
          "optionId": "leave",
          "probability": 0.1
        },
        {
          "optionId": "travel_splash",
          "probability": 0.7
        }
      ],
      "u": 0,
      "chosen": "browse"
    },
    {
      "probabilities": [
        {
          "optionId": "browse",
          "probability": 0.2
        },
        {
          "optionId": "leave",
          "probability": 0.1
        },
        {
          "optionId": "travel_splash",
          "probability": 0.7
        }
      ],
      "u": 0.2,
      "chosen": "leave"
    },
    {
      "probabilities": [
        {
          "optionId": "browse",
          "probability": 0.2
        },
        {
          "optionId": "leave",
          "probability": 0.1
        },
        {
          "optionId": "travel_splash",
          "probability": 0.7
        }
      ],
      "u": 0.31,
      "chosen": "travel_splash"
    }
  ],
  "money": {
    "unitPriceCents": 2500,
    "quantity": 4,
    "expectedTotalCents": 10000,
    "startingBalanceCents": 12000,
    "expectedFinalBalanceCents": 2000
  },
  "waiting": {
    "persons": 3,
    "durationMs": 120000,
    "expectedPersonMinutes": 6
  },
  "pairedAnalysis": {
    "a": [
      100,
      200,
      300
    ],
    "b": [
      110,
      220,
      330
    ],
    "deltas": [
      10,
      20,
      30
    ],
    "n": 3,
    "mean": 20,
    "min": 10,
    "max": 30,
    "sampleSd": 10,
    "defaultInterval": null,
    "defaultLabel": "exploratory descriptive",
    "note": "A three-pair vector for testing arithmetic; not evidence of model validity."
  },
  "canonicalDecisionHashes": {
    "observationHash": "99b85204c11fff99a21f374f377588c334a6cc0adb1e6c7bf045951f07154ef2",
    "optionsHash": "a0e7af57469c9e40671c993a050a15274e5e2a6120e98cea32e001c5962b5605"
  }
}
```
<!-- END_GOLDEN_VECTORS -->

# Appendix C - Independent synthetic application DTO examples

Copy this JSON to `engine/fixtures/conformance-fixtures.json` and validate it against your application schemas. These are independent DTO examples, not one complete simulated run and not captured vendor API responses. The deliberately mock source must remain mock in all displays. The original response body is included so its artifact byte count/hash can be tested.

<!-- BEGIN_CONFORMANCE_FIXTURES -->
```json
{
  "disclaimer": "Independent synthetic application-DTO examples, not one complete run, production results, or captured vendor payloads.",
  "decisionRequest": {
    "contractVersion": "behavior.v1",
    "requestId": "decision:g001:4:r0",
    "runId": "fixture-run",
    "groupId": "g001",
    "agentIds": [
      "a001",
      "a002",
      "a003"
    ],
    "moment": "what_next",
    "decisionSeq": 4,
    "momentSeq": 2,
    "requestRevision": 0,
    "createdAtMs": 3600000,
    "applyAtMs": 3600000,
    "planRevision": 3,
    "dependencyRevisions": {
      "plan:g001": "3"
    },
    "observationHash": "99b85204c11fff99a21f374f377588c334a6cc0adb1e6c7bf045951f07154ef2",
    "optionsHash": "a0e7af57469c9e40671c993a050a15274e5e2a6120e98cea32e001c5962b5605",
    "policyVersion": "fixture-policy-v1",
    "observation": {
      "schema": "observation.v1",
      "groupId": "g001",
      "leaderId": "a001",
      "atMs": 3600000,
      "members": [
        {
          "persona": {
            "agentId": "a001",
            "groupId": "g001",
            "archetype": "young_family",
            "role": "parent",
            "ageYears": 38,
            "heightCm": 175,
            "walkSpeedMps": 1.2,
            "thrillPreference": 0.5,
            "initialNeeds": {
              "hunger": 35,
              "fatigue": 20,
              "patience": 80,
              "fun": 50
            },
            "hungerPerHour": 10,
            "fatiguePerKm": 8,
            "patiencePerMinute": 1,
            "familiarity": 0.4,
            "hasApp": true,
            "language": "en",
            "phoneActiveUntilMs": null,
            "stroller": false,
            "mobilityRestricted": false,
            "occasion": "birthday",
            "mustDoPlaceIds": [
              "splash"
            ],
            "backstory": "Synthetic fixture: parent with two children, hoping to visit Splash Falls."
          },
          "needs": {
            "hunger": 70,
            "fatigue": 45,
            "patience": 35,
            "fun": 55
          }
        },
        {
          "persona": {
            "agentId": "a002",
            "groupId": "g001",
            "archetype": "young_family",
            "role": "child",
            "ageYears": 6,
            "heightCm": 115,
            "walkSpeedMps": 0.9,
            "thrillPreference": 0.5,
            "initialNeeds": {
              "hunger": 35,
              "fatigue": 20,
              "patience": 80,
              "fun": 50
            },
            "hungerPerHour": 10,
            "fatiguePerKm": 8,
            "patiencePerMinute": 1,
            "familiarity": 0.4,
            "hasApp": false,
            "language": "en",
            "phoneActiveUntilMs": null,
            "stroller": false,
            "mobilityRestricted": false,
            "occasion": "birthday",
            "mustDoPlaceIds": [
              "splash"
            ],
            "backstory": "Synthetic fixture: child visiting with a parent and sibling."
          },
          "needs": {
            "hunger": 70,
            "fatigue": 45,
            "patience": 35,
            "fun": 55
          }
        },
        {
          "persona": {
            "agentId": "a003",
            "groupId": "g001",
            "archetype": "young_family",
            "role": "child",
            "ageYears": 9,
            "heightCm": 130,
            "walkSpeedMps": 1.0,
            "thrillPreference": 0.5,
            "initialNeeds": {
              "hunger": 35,
              "fatigue": 20,
              "patience": 80,
              "fun": 50
            },
            "hungerPerHour": 10,
            "fatiguePerKm": 8,
            "patiencePerMinute": 1,
            "familiarity": 0.4,
            "hasApp": false,
            "language": "en",
            "phoneActiveUntilMs": null,
            "stroller": false,
            "mobilityRestricted": false,
            "occasion": "birthday",
            "mustDoPlaceIds": [
              "splash"
            ],
            "backstory": "Synthetic fixture: child visiting with a parent and sibling."
          },
          "needs": {
            "hunger": 70,
            "fatigue": 45,
            "patience": 35,
            "fun": 55
          }
        }
      ],
      "wallet": {
        "walletId": "w001",
        "balanceCents": 4000
      },
      "facts": [
        {
          "id": "obs001",
          "kind": "board",
          "placeId": "splash",
          "source": "sight",
          "observedAtMs": 3595000,
          "contentVersion": "board:3",
          "text": "Splash Falls - 35 minutes",
          "waitLowerMs": 2100000,
          "waitUpperMs": 2100000,
          "priceCents": null
        }
      ],
      "knownDestinations": [
        {
          "placeId": "splash",
          "name": "Splash Falls",
          "walkEstimateMs": 120000,
          "lastObservedFactIds": [
            "obs001"
          ],
          "knownRestrictions": [
            "Minimum height 100 cm"
          ]
        }
      ],
      "recentEventSummaries": [
        {
          "eventId": "evt009",
          "atMs": 3580000,
          "text": "Finished a short rest."
        }
      ],
      "currentActivity": "deciding after rest",
      "plannedDepartureMs": 25200000
    },
    "options": [
      {
        "id": "browse",
        "label": "Browse nearby",
        "description": "Wander without choosing an attraction.",
        "action": {
          "kind": "browse",
          "durationMs": 120000
        }
      },
      {
        "id": "leave",
        "label": "Head to the exit",
        "description": "Walk to the exit earlier than planned.",
        "action": {
          "kind": "leave_park"
        }
      },
      {
        "id": "travel_splash",
        "label": "Walk to Splash Falls",
        "description": "About two minutes away; last observed wait 35 minutes. This does not join the queue.",
        "action": {
          "kind": "travel",
          "placeId": "splash",
          "routeProfileId": null
        }
      }
    ],
    "promptOptionOrder": [
      "travel_splash",
      "browse",
      "leave"
    ],
    "candidateAudit": {
      "considered": [
        "splash"
      ],
      "excluded": []
    }
  },
  "rawFixtureResponse": {
    "fixture": true,
    "note": "Application contract example, NOT a captured vendor response.",
    "probabilities": [
      {
        "optionId": "browse",
        "probability": 0.2
      },
      {
        "optionId": "leave",
        "probability": 0.1
      },
      {
        "optionId": "travel_splash",
        "probability": 0.7
      }
    ]
  },
  "decisionResult": {
    "requestId": "decision:g001:4:r0",
    "observationHash": "99b85204c11fff99a21f374f377588c334a6cc0adb1e6c7bf045951f07154ef2",
    "optionsHash": "a0e7af57469c9e40671c993a050a15274e5e2a6120e98cea32e001c5962b5605",
    "modelRequested": "mock-policy-v1",
    "modelReturned": "mock-policy-v1",
    "source": "mock",
    "probabilities": [
      {
        "optionId": "browse",
        "probability": 0.2
      },
      {
        "optionId": "leave",
        "probability": 0.1
      },
      {
        "optionId": "travel_splash",
        "probability": 0.7
      }
    ],
    "confidence": null,
    "responseArtifact": {
      "artifactId": "fixture-response-artifact",
      "kind": "model_response",
      "sha256": "87234338e9c4722e6db6aeabc7ed296c775dde6e2169b2b8db37179ceaa228ac",
      "byteLength": 231,
      "mediaType": "application/json",
      "contractVersion": "behavior.v1"
    },
    "usage": {
      "callId": null,
      "inputTokens": 0,
      "outputTokens": 0,
      "estimatedCostUsd": 0,
      "priceVersion": null,
      "queueMs": 0,
      "httpMs": 0,
      "attemptCount": 0
    },
    "cacheKey": null,
    "originalSource": "mock"
  },
  "metricSnapshot": {
    "runId": "fixture-metrics-run",
    "simMs": 3600000,
    "revision": 1,
    "definitionVersion": "metrics-v1",
    "admittedGuests": 12,
    "guestsInPark": 0,
    "measures": {
      "net_revenue_cents": {
        "id": "net_revenue_cents",
        "value": 12000,
        "unit": "cents",
        "numerator": 12000,
        "denominator": null,
        "n": 12,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "revenue_per_guest_cents": {
        "id": "revenue_per_guest_cents",
        "value": 1000,
        "unit": "cents",
        "numerator": 12000,
        "denominator": 12,
        "n": 12,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "satisfaction_0_100": {
        "id": "satisfaction_0_100",
        "value": 75,
        "unit": "score",
        "numerator": 900,
        "denominator": 12,
        "n": 12,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "queue_minutes_per_guest": {
        "id": "queue_minutes_per_guest",
        "value": 15,
        "unit": "minutes",
        "numerator": 180,
        "denominator": 12,
        "n": 12,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "completed_ride_wait_minutes": {
        "id": "completed_ride_wait_minutes",
        "value": 10,
        "unit": "minutes",
        "numerator": 120,
        "denominator": 12,
        "n": 12,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "rides_per_guest": {
        "id": "rides_per_guest",
        "value": 1,
        "unit": "ratio",
        "numerator": 12,
        "denominator": 12,
        "n": 12,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "abandonment_rate": {
        "id": "abandonment_rate",
        "value": 0.25,
        "unit": "ratio",
        "numerator": 4,
        "denominator": 16,
        "n": 16,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "queue_time_share": {
        "id": "queue_time_share",
        "value": 0.25,
        "unit": "ratio",
        "numerator": 180,
        "denominator": 720,
        "n": 12,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "early_departures": {
        "id": "early_departures",
        "value": 2,
        "unit": "guests",
        "numerator": 2,
        "denominator": null,
        "n": 12,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "ride_seat_utilization": {
        "id": "ride_seat_utilization",
        "value": 0.75,
        "unit": "ratio",
        "numerator": 12,
        "denominator": 16,
        "n": 16,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      },
      "server_utilization": {
        "id": "server_utilization",
        "value": 0.5,
        "unit": "ratio",
        "numerator": 360,
        "denominator": 720,
        "n": 2,
        "coverage": 1,
        "complete": true,
        "missingReason": null
      }
    }
  },
  "scenario": {
    "id": "price-variant",
    "revision": "1",
    "label": "Price-only fixture",
    "events": [
      {
        "id": "pass-price-25",
        "atMs": 1800000,
        "order": 0,
        "change": {
          "kind": "pass_price",
          "unitPriceCents": 2500
        }
      }
    ]
  },
  "rejectedReceipt": {
    "commandId": "fixture-command",
    "ok": false,
    "error": {
      "code": "STALE_LEASE",
      "message": "The work lease was replaced.",
      "retryable": false,
      "fieldErrors": []
    }
  }
}
```
<!-- END_CONFORMANCE_FIXTURES -->

---

# Execute the assignment

Start with repository/branch inspection and the first small passing slice. Implement the full owned domain, not another design document. Keep the boundaries frozen, test every listed acceptance group, commit each coherent slice, and finish with the required handoff containing actual results and explicit unrun integration gates. Do not merge the three branches; that happens outside this assignment.
