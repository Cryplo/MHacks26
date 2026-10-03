# Experience lane — handoff

**Branch** `feat/behavior-engine-experience` · **Base** none: the repository had no commits
(empty `main`, empty `origin`), so this lane branch is a root branch. **HEAD** is the commit
that adds this file (see `git log`). **Owned paths** `experience/**`,
`.github/workflows/experience.yml`. No other paths were touched; no root workspace,
lockfile or tsconfig was created. Nothing was merged, rebased, pushed or deployed.

## Commits

1. `chore(experience)` tooling, frozen contract mirror (SHA-256 `c25776a4…aac4` verified), golden checks
2. `feat(experience)` Harbor Lights content in two stages
3. `feat(experience)` runtime service layer, coherent live store, scripted fixture adapter
4. `feat(experience)` renderer core (camera, picking, interpolation)
5. `feat(experience)` evidence/scenario/crowd/report view-models
6. `feat(experience)` operator product UI (setup, live, inspector, what-if, sharing, results, replay)
7. `test(experience)` fixture browser suite, screenshot matrix, render profile
8. `feat(experience)` live-profile gates, secret scan, live integration command, CI
9. `feat(experience)` queue labels, notice-version observers, docs and handoff (this commit)

## Environment

Node 24.19.0, npm 11.17.0. `package-lock.json` SHA-256
`d4153980061f4928d1f6c8c84ccfe614e45ef636bd261eb62cd9bf8a97576aee`. React 19.3.0,
react-router-dom 7.18.4, pixi.js 8.22.0, zod 4.6.5, Vite 8.3.2, TypeScript 6.0.3 (TS 7 is not
yet supported by typescript-eslint), Vitest 5.0.3, @playwright/test 1.63.0 (Chromium 1243),
ESLint 10.12.0, pngjs 7.0.0, jsdom 30.1.1.

Environment variables (public, non-secret, `VITE_RUNTIME_*` only): `VITE_RUNTIME_PROFILE`
(`fixture`|`live`), `VITE_RUNTIME_ADAPTER_URL` (default `/runtime/browser.js`),
`VITE_RUNTIME_URI` (default `ws://127.0.0.1:3000`), `VITE_RUNTIME_DATABASE` (default
`behavior-engine`). Test-only: `BEHAVIOR_OPERATOR_TOKEN`, `BEHAVIOR_REAL_JEV`, `PERF`.

## Exact commands and results (this machine, 2026-10-03)

| Command | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass (0 warnings) |
| `npm run test:contract` | 16/16 pass (contract hash, golden canonical/random/sampling/money/waiting, decision hashes, conformance DTOs) |
| `npm run test:unit` | 126/126 pass |
| `npm run test:integration` | 7/7 pass (runtime layer vs **fixture** server only) |
| `npm run content:validate` | OK |
| `npm run content:compile` | **NOT RUN** (exit 2): `engine/` absent |
| `npm run check:secrets` | OK; live bundle contains no fixture adapter/credentials |
| `npm run build:fixture` | pass |
| `npm run build:live` | fails by design (exit 1): Engine adapter not present at `public/runtime/browser.js` |
| `npm run test:e2e:fixture` | 17/17 pass (desktop 1440×900 + 375px mobile, production fixture build) |
| `npm run test:e2e:live` | exit 2: missing-adapter check **pass**, stub-adapter swap check **pass**, integrated suite **NOT RUN** (needs A's adapter + `BEHAVIOR_OPERATOR_TOKEN`) |
| `npm run test:perf` | 9 measurements recorded (below) |

Coverage (unit+integration, diagnostic): branches — `ui/format.ts` 100%, `domain/random.ts`
100%, `runtime/commands.ts` 95.8%, `data/liveStore.ts` 93.2%, view-model helpers 82–100%
(evidence 95.6, facts 100, csv 97.2, heat 93.3, describe 89.7, crowd 82.9, interpolation
88.1, picking 100). React pages are exercised by Playwright, not counted in this figure.

**Fixture versus real coverage.** Every passing UI test above runs on scripted fixture data
(or a contract stub). None of it is evidence of real SpacetimeDB subscriptions, Engine
mechanics, B's worker or Jev. Those are covered only by the integrated live suite, which has
not run.

## Acceptance IDs

| ID | Status | Evidence |
|---|---|---|
| C-01 | Done (fixture + live build) | `tests/unit/loader.test.ts`; `tests/e2e/live/missing-adapter.spec.ts`, `stub-adapter.spec.ts`; badges in UI/exports |
| C-02 | Done | `tests/unit/liveStore.test.ts`, `core-branches.test.ts`, integration gap/duplicate test, `faults.spec.ts` |
| C-03 | Done | `tests/unit/setup.test.ts`; journey (invalid shares, stale preview); fault (failed job); ESLint forbids product → fixture imports |
| C-04 | Done | `tests/unit/commands.test.ts`; integration lost-ack; E2E double click, lost ack, reload |
| C-05 | Standalone done; Engine compiler NOT RUN | `tests/unit/content.test.ts`, `content:validate`; display map painted from the authoritative grid, decor only on blocked cells |
| C-06 | Done | `tests/unit/renderer.test.ts`; E2E picking after zoom/pan/resize, keyboard alternative |
| C-07 | Done | `renderer.test.ts` (bounds, barrier freeze, walls, transitions, seek); replay steps without tweening |
| C-08 | Done (fixture) | Agent positions/queue labels from authoritative `AgentView`/`QueueView`; closure badge from `PlaceView`; `queue-notices.test.ts`; no client purchases/reordering |
| C-09 | Done | `format.test.ts`, `core-branches.test.ts`; satisfaction legend age/unrated; null = em dash |
| C-10 | Done | `inspector.test.tsx`; operator-only truth toggle; facts keep original promise text |
| C-11 | Done | narration A→B race test; safe-rendering test; evidence/hash labels |
| C-12 | Done (fixture parser) | journey E2E: parse → draft (park time) → confirm → scheduled → applied; unsupported fragments listed |
| C-13 | Done (fixture server) | integration: stale revision, past-time conflict, frozen experiment arm, discount UNSUPPORTED; text-only discount note |
| C-14 | Fixture done; integrated NOT RUN | fixture viewer/unauthorized E2E; `live/integrated.spec.ts` written |
| C-15 | Done (fixture) | share issue/redeem/expire/revoke (integration + E2E), fragment scrub, role-by-URL ignored, `check:secrets` |
| C-16 | Fixture tabs done; real subscriptions NOT RUN | `sharing.spec.ts` same revision; live suite pending |
| C-17 | Done | `results.test.ts` labels; experiment page shows incomplete pair, no CI from min/max |
| C-18 | Done | heatmap placement tests; zero/disabled layers; drill-down to events/inspector |
| C-19 | Done | fact resolution/hash tests; CSV formula escaping round trip; print caveats E2E |
| C-20 | Done | journey E2E asserts replay calls only `getFrames`; resolution shown; seek resets scene |
| C-21 | Done | `journey.spec.ts` with Fixture badge in screenshots/exports |
| C-22 | **NOT RUN** | `tests/e2e/live/integrated.spec.ts` (needs A launcher + B mock worker + operator token) |
| C-23 | **NOT RUN** | `tests/e2e/live/real-jev.spec.ts` (needs `BEHAVIOR_REAL_JEV=1` + authorized budget) |
| C-24 | Done | `a11y.spec.ts` (skip link, labels on every control, keyboard), `mobile.spec.ts` (375px, touch) |
| C-25 | Done (headless profile) | `perf.spec.ts` profile; context loss fallback; canvas-renderer degradation; hidden-tab resume; bounded feed; error boundaries |

## Benchmark (C-25)

`artifacts/perf/profile.json`: Apple M4 Pro (12 cores, 24 GB), macOS 25.6, headless Chromium
via Playwright, fixture scene at 60x after ~75 simulated minutes.

| Guests | Rendered in park (desktop/hiDPI/mobile) | fps (all) | p95 frame | long tasks |
|---|---|---|---|---|
| 200 | 170 / 184 / 194 | 60.2 | 16.7–16.8 ms | 0 ms |
| 300 | 253 / 274 / 286 | 60.2–60.4 | ~16.8 ms | 0 ms |
| 400 | 337 / 365 / 390 | 60.2 | 16.7–16.8 ms | 0 ms |

Conditions: desktop 1440×900 DPR 1, desktop DPR 2, mobile 375×812 DPR 3 (CDP emulation).
Headless rAF is vsync-capped at 60 Hz, so "60" means no dropped frames observed at the cap,
not headroom. This is a measurement on this machine, not a claim for other hardware or for
the live adapter.

## Screenshots

`artifacts/screenshots/`: setup, live, inspector, scenario confirmation, blocked (inference
barrier), run results, experiment with incomplete pair, mobile viewer, print preview. All are
fixture screenshots and visibly carry the Fixture badge/banner. They test presentation only.

## Adapter requirements (A)

`engine/client/dist/browser.js`: same-origin ES module exporting
`createRuntimeClient(config: RuntimeConfig): Promise<RuntimeClient>` with
`contractVersion === 'behavior.v1'` and `capabilities.contractVersion === 'behavior.v1'`; it
must call `config.onToken(token)` when the server issues a session token and must not embed
secrets. A's launcher copies it to `experience/public/runtime/browser.js` (gitignored), then
`npm run build:live`. Startup shows `missing_adapter`, `invalid_adapter`, `version_mismatch`
or `connect_failed` errors explicitly.

## Content compile/import (A)

`content/harbor-lights/` holds the source of truth (see its README). `npm run content:paint`
regenerates the PNGs, queue masks and fixture bundles deterministically; `content:validate`
checks metadata, references, palette coverage, queue ownership, services and presets.
`content:compile` runs Engine's compiler when present (script name per proposal 0004).
Registration happens through A's authorized `registerPark`; the setup page waits for
`preparing → ready` and lists `invalid` issues.

## Demo and recording

`docs/DEMO.md` (three-minute script on live evidence, recording procedure). The fixture is
for rehearsal only.

## Incomplete gates and risks

- **NOT RUN**: integrated live suite (C-14/C-16/C-22 on real state), real-Jev decision test
  (C-23), Engine compiler on Harbor Lights assets, `build:live` with A's real adapter.
- **Unverified against real DTO content**: Engine-owned `EventRecord.details` shapes
  (proposal 0005), `Narrative.evidenceHash` binding (0002), VersionSet (0001). The UI fails
  visibly rather than guessing in each case.
- The fixture is a scripted, non-reactive choreography: guests do not respond to what-ifs,
  closures or price changes made live (disclosed in the banner); its metrics, mock
  distributions and A/B values are not outcomes.
- Report fact bundles are not versioned (0003), so reports on running runs can mismatch; they
  show a data error.
- Roles in a live session are global (`session.roles`); per-run operator vs viewer is enforced
  by the server, and the UI may show controls that the server then rejects with a scoped
  FORBIDDEN message.

## Proposed contract changes

`docs/integration-proposals/` (0001–0006), all additive. No boundary type was changed.
