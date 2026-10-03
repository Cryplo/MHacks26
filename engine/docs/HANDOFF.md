# Engine handoff

Branch: `feat/behavior-engine-runtime`. The source repository was initially empty. Bootstrap/base commit: `adf003b5eaebdf7a790446daeec0d672ce6e7434`. Worktree: `/Users/dylanli/.codex/worktrees/mhacks-engine/MHacks26`. Git remote is `https://github.com/Cryplo/MHacks26.git`. Work is committed incrementally; it has not been merged or pushed.

## Delivered

Pure deterministic TypeScript mechanics; actual SpacetimeDB 2.10.2 module; generated private-view/reducer bindings; browser and Node `RuntimeClient` bundles; PNG compiler; synthetic park/population fixtures; operator provisioning and immutable artifact tools; durable jobs/receipts/leases; scoped shares; scheduled fenced advancement; metrics/heat/rating evidence; checkpoints and response-tape replay; strict/partial integration launcher; CI and acceptance/load tests.

The frozen `behavior.v1` file remains byte-identical, SHA-256 `c25776a4883f70c71e8b4991dabc1b7a641baa8baeb615b1cfc145c0b8f1aac4`. Generated bindings and runtime SDK/CLI are 2.10.2. Node 24, TypeScript 6.0.2. Build commands and local configuration are in `engine/README.md`; integration requirements are in `integration/README.md`.

## Contract support

All entries below route through real module handlers. The pure runtime shares those handlers. The table describes implementation support, not a claim that every variant has completed a separate real-server integration test.

| Commands | Support / access |
|---|---|
| `registerPark`, `createRun` | Validated immutable artifacts; staged navigation/ready gate; trusted operator or assigned experiment coordinator |
| `requestProductWork` | Population, crowd/scenario parse, evidence-resolved thought/report jobs; role/scope and rate checks |
| `startRun`, `pauseRun`, `resumeRun`, `setSpeed`, `cancelRun` | Scoped control, expected revisions, safe pause points and terminal cancellation |
| `scheduleEvents` | Future unprepared boundaries, confirmed draft equality, scenario revisions; comparative runs reject edits |
| `claimWork`, `renewWork`, `completeWork`, `failWork` | Fenced attempts, recorded validation errors, retries, ready versus applied state |
| `recordProviderAttempt` | Unique call-ID ownership, monotonic started/finished usage; missing cost stays unknown |
| `acquireDriver`, `renewDriver`, `advanceRun`, `releaseDriver` | One owner/epoch, exact boundary preconditions, bounded deterministic work and durable retry |
| `checkpointRun` | Committed boundaries only; no reusable operational credentials |
| `createExperiment`, `recordExperimentProgress` | Coordinator lease, fixed spec/pairs, child-arm provenance and canonical engine metric checks; analysis/coordinator algorithm belongs to B |
| `issueShare`, `redeemShare`, `revokeShare` | Hashed capabilities, expiry/revocation, bound identity and restricted delegation |

| Queries / adapter methods | Support |
|---|---|
| `capabilities`, `session`, `listParks` | Explicit feature gates, role/run access, bounded catalog pages |
| `getRun`, `getManifest`, `getLiveSnapshot` | Authorized metadata and coherent published boundary state |
| `getAgent`, `getDecision`, `getWork` | Scoped guest evidence and private job results |
| `getMetrics`, `getEvents`, `getHeatmap`, `getFrames` | Canonical accumulators, deterministic filtered pagination and interval heat exposure |
| `getExperiment`, `getFactBundle` | Authorized comparison/fact projections |
| `subscribeLive`, `subscribeWorkAvailable` | Snapshot/monotonic patch/reset semantics; worker hints are not claims |
| `putArtifact`, `getArtifact`, `close` | Bounded immutable chunks, hash verification, ownership/access checks and cleanup |

Routes, shows, prices, closures, board/notice changes and app messages are implemented. Bump reactions, split groups, speech bubbles and discounts remain explicitly unsupported by the declared MVP feature gates.

## Verified evidence

- 71 automated tests across 13 suites pass, including a 400-person ten-minute movement invariant and persisted partial-substep recovery. See `ACCEPTANCE.md` for precise coverage and limits.
- Build, typecheck and ESLint pass. Final coverage: 85.46% lines, 77.95% branches. Coverage is evidence, not an assertion of exhaustive correctness.
- Actual local SDK/module smoke passed an eight-hour horizon: 3 scripted visitors, 385 advance commands, 60-second frames, 6,000 cents reconciled and all 3 physical exits, two snapshots across a real reconnect, population-worker handoff and checkpoint retrieval. Guests leave early; this is not an occupied-day load test.
- Real-server 200/300/400 guest × one/four viewer benchmark, 200×150 grid, 15 destination fields, ten simulated seconds: final p95 command round trips 64.6–168.9 ms. Source snapshots and the two prior optimization passes are retained in `server-load-*.json`.
- Partial launcher PASS from dependency installation through build, module publish, fixture registration and actual SDK smoke (79 advances, 2 snapshots, 80 patches). Strict preflight correctly fails because `intelligence/` and `experience/` are absent.

## Performance and fidelity limits

The load results are loopback client-observed `advanceRun` latency, including reducer/transport, not isolated reducer CPU timing. Samples include coincident entrance arrivals. p99/outliers remain above 250 ms in some cases. Ten simulated seconds took approximately 4.2–34.3 wall seconds in the final pass; serialized mock response uploads/claims contributed 2.1–13.2 seconds of that. Do not describe this as a full realtime/accelerated 400-guest day. Received application bytes exclude SDK wire overhead. Server memory and actual network egress have not been measured independently; recorded heap figures describe the harness process.

Waiting heat uses actual person exposure at current physical positions. Queue overlays expose those positions; this version does not pack parties into authored queue-zone lanes. It preserves continuous movement/individual poses outside queue service and never teleports children to a group anchor.

Large destination-field initialization is resumable, but initial manifest/topology validation and individual field builds still run synchronously. Maximum-size authored assets need separate stress testing. Histories are normalized, but the core currently reloads event/evidence histories during advancement, so long busy-day scaling needs more profiling.

## External gates not run

Real Jev/provider behavior, paid-call latency/cost, B's mock/real coordinator comparison, C's Harbor Lights park and UI/Playwright, strict all-lanes startup and end-to-end A/A integration remain unrun. No API key was invented and no paid inference was called. Synthetic distributions/ratings are not calibrated visitor predictions. The strict launcher must continue to fail visibly until the missing lanes and their documented entry points exist.

Local test-server data and exported fixtures remain in ignored `engine/.local/`. The test server is stopped after verification; follow README.md to start a development server. No credentials are included in committed artifacts.
