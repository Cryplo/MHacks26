# Behavior Engine — Experience lane

Operator product for the Behavior Engine: React 19 + Vite 8 + PixiJS 8 UI, the authored
**Harbor Lights** park content, a scripted fixture runtime for standalone development, and
browser tests. Everything talks to the frozen `behavior.v1` contract
(`contract/behavior-v1.ts`, byte-identical across lanes) through a `RuntimeClient`.

The model is not calibrated to real people. The UI is built to make evidence, sources and
limitations visible rather than to tell a predetermined story.

## Quick start (no keys, no server)

```bash
cd experience
npm ci
npm run dev            # fixture profile on http://localhost:4317
```

Click **New simulation**, keep the defaults (Harbor Lights, 1,000 guests) and press **Start
simulation**. The run opens on the isometric live map and starts by itself. Click any guest to
see their status, needs and the reasoning behind each decision. Fixture screens show a small
**Fixture data** chip: the data is a scripted choreography driven by a mock policy, not Engine
and not Jev.

## Profiles and data modes

| Profile (build-time) | How | Runtime |
|---|---|---|
| `fixture` | `npm run dev`, `npm run build:fixture` | Scripted `FixtureRuntimeClient` (bundled only in this profile). |
| `live` | `npm run dev:live`, `npm run build:live` | Engine's browser adapter loaded from `VITE_RUNTIME_ADAPTER_URL` (default `/runtime/browser.js`, same origin). Missing or version-mismatched adapter = startup error. **Never** falls back to fixture data. |

Data-mode badges shown on every run screen and in exports: **Fixture**, **Mock** (Engine +
deterministic mock provider; not a Jev comparison), **Live Jev**, **Degraded** (any fallback
decisions), **Recorded** (replay of saved frames; no inference).

Public build settings live in `.env.fixture` / `.env.live` (`VITE_RUNTIME_*` only; the Vite
`envPrefix` exposes nothing else). No credential is ever a build variable: the session token
comes from the runtime (`RuntimeConfig.onToken`) and is stored only in this browser
(localStorage for live, per-tab sessionStorage for fixture).

## Routes

| Route | Purpose |
|---|---|
| `/` | Runs visible to this session (from `session.runIds`). |
| `/session` | Redirects home (there is no sign-in UI; the app acts as the local operator). |
| `/setup` | One screen: park, crowd size and mix, optional crowd description and advanced settings (collapsed), then **Start simulation** (creates and starts the run). |
| `/runs/:runId` | Isometric live map with a run bar (play/pause, speed 1×–60×, headline KPIs, ⋯ menu for What if, Share, Results, Replay and Cancel) and one side panel: Overview / Guests / Activity, or the guest detail when a guest is selected. `?guest=ID` selects a guest (selection only; never a role). |
| `/runs/:runId/results` | Definition/coverage/limitations first, metrics, heatmaps with drill-down, fact-backed report, JSON/CSV export. |
| `/runs/:runId/print` | One-page executive summary for browser print ("Save as PDF" is the browser's; no PDF generator). |
| `/runs/:runId/replay` | Redirects to the live view scrubbed to the start (`?t=0`); the run-bar timeline scrubs recorded frames. |
| `/experiments/new`, `/experiments/:id` | Paired A/B setup and report (all pairs, B−A deltas, descriptive spread). |
| `/share#t=…` | Redeems a share capability through the server and scrubs it from history. |

## Scripts

| Script | What it does |
|---|---|
| `dev`, `dev:live` | Dev server (fixture / live; live requires the adapter). |
| `build` / `build:fixture`, `build:live` | Production builds to `dist/fixture`, `dist/live`. |
| `typecheck`, `lint` | `tsc --noEmit`; ESLint (product code may not import the fixture adapter). |
| `test:contract` | Contract hash, golden vectors, conformance fixtures. |
| `test:unit`, `test:integration` | Vitest (jsdom). Integration = runtime layer against the fixture server. |
| `test:e2e:fixture` | Playwright against the production fixture build (desktop + 375px mobile). |
| `test:e2e:live` | Live-profile checks (missing adapter, stub adapter) + integrated suite when A/B are running; exit 2 = integrated suite NOT RUN. |
| `test:perf` | Serial 200/300/400-guest frame profile → `artifacts/perf/profile.json`. |
| `content:paint`, `content:validate`, `content:compile` | Harbor Lights painter, validator, Engine compiler hook. |
| `check:secrets` | Secret scan of sources/env/bundles; proves the live bundle has no fixture code. |

## Architecture

```
contract/behavior-v1.ts     frozen DTO mirror (do not edit)
content/harbor-lights/      authored park: layout.json (geometry source), places.json, park.json,
                            scenarios/*.json, generated PNG + queue masks, tools/, README
fixtures/                   golden vectors, conformance fixtures, fixture-assembled ParkBundles
src/runtime/                profiles, adapter loader, command runner (stable command IDs),
                            work polling, mode labels, RuntimeProvider
src/data/                   LiveStore (snapshot/patch revisions), LiveConnection, hooks
src/renderer/               Camera (single transform), picking, interpolation, ParkScene (Pixi)
src/features/               setup, live, inspector, scenarios, sharing, results, replay
src/fixture/                scripted fixture server/client/scene (fixture profile only)
src/ui/                     tokens/styles, accessible components, unit formatters
tests/{unit,integration,contract,e2e}
```

Key rules implemented: patches apply only on matching `runId` and `fromRevision`; gaps
freeze the view and resync from a snapshot; duplicates are ignored; unchanged entities keep
identity; feeds/charts are bounded. Commands carry caller-generated IDs reused for
double clicks, lost acknowledgements and reloads (durable intents in sessionStorage);
success is shown only after an accepted receipt and nothing is optimistically mutated.
Canvas animation runs on Pixi's ticker, separate from React. Interpolation never
extrapolates and never tweens through walls, services, queue entry/exit, seeks or
impossible speeds.

## Accessibility notes

Skip link; every control has a label (checked in E2E); keyboard map control (`+`/`-`/`0`,
arrows, `Esc`); a searchable guest list as the canvas alternative; all states carry text and
shapes as well as colour (Okabe–Ito palette); definitions are toggles, not hover-only
tooltips; charts have data tables; layouts verified at 375px; reduced-motion respected.

## Live integration

1. Engine (A) builds `engine/client/dist/browser.js`; A's launcher copies it to
   `experience/public/runtime/browser.js` (gitignored) and starts SpacetimeDB, registers the
   Harbor Lights bundle compiled from `content/harbor-lights/`, and B's mock worker.
2. `npm run dev:integration` builds the live profile and serves it on http://127.0.0.1:4317.
   It signs in automatically as the local operator (from `engine/.local/integration.env`,
   written by `node integration/bootstrap-identities.mjs`), so there is no sign-in step.
   Local use only: the served build contains the local operator credential. A plain
   `npm run build:live` never does, so it has no credential and cannot operate runs.
4. `BEHAVIOR_OPERATOR_TOKEN=… npm run test:e2e:live` (add `BEHAVIOR_REAL_JEV=1` only when a
   real-Jev budget is authorized).

See `docs/HANDOFF.md` for results, gates and proposals, and `docs/DEMO.md` for the demo.
