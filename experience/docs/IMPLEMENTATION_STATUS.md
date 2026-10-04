# Experience lane — implementation checklist

Branch `feat/behavior-engine-experience`. Base: the repository had no commits (empty `main`,
empty remote), so this lane branch is a root branch. Owned paths: `experience/**`,
`.github/workflows/experience.yml`.

- [x] Isolated tooling (Vite 8, React 19, TS 6.0, Vitest 5, Playwright 1.63), lane-local lockfile
- [x] Frozen contract mirror `contract/behavior-v1.ts` (SHA-256 verified in `test:contract`)
- [x] Golden vectors + conformance fixtures validated
- [x] Domain utilities: canonical JSON, SHA-256, semantic RNG check, unit formatters
- [x] Harbor Lights authored content: layout source, categorical PNGs (2 stages), queue masks, places, notices, presets, README
- [x] Runtime layer: explicit profiles, adapter loader (no fallback), command runner (stable IDs), work polling
- [x] Coherent live store (snapshot/patch, gaps, duplicates, identity preservation, bounded feeds)
- [x] Fixture runtime (scripted server, scene, population, parsers, reports), labeled Fixture
- [x] App shell + routes, session, share redemption
- [x] Setup flow (park, crowd, preview job, scenario, frozen plan, create/start)
- [x] Live park: Pixi renderer, camera, picking, interpolation, legend, stats, health, feed
- [x] Inspector: evidence, knowledge vs truth, narration with stale-guard
- [x] What-if: parse -> draft -> confirm -> receipt -> applied; structured editor
- [x] Sharing: issue/revoke/redeem, fragment scrub
- [x] Results: metrics, heatmaps, fact-backed report, exports (JSON/CSV/print)
- [x] Experiments: A/B spec, pair table, summaries, labels
- [x] Replay: recorded frames, step/seek
- [x] E2E (fixture) + screenshot matrix + accessibility + perf profile
- [x] Live-integration command (`test:e2e:live`): missing/stub adapter checks pass; integrated suite NOT RUN until A/B exist
- [x] HANDOFF.md

Outstanding external gates (see HANDOFF): integrated live suite (C-14/C-16/C-22), real-Jev test (C-23), Engine compiler on Harbor Lights assets, `build:live` with A's adapter.
