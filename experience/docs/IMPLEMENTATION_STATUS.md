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
- [ ] App shell + routes, session, share redemption
- [ ] Setup flow (park, crowd, preview job, scenario, frozen plan, create/start)
- [ ] Live park: Pixi renderer, camera, picking, interpolation, legend, stats, health, feed
- [ ] Inspector: evidence, knowledge vs truth, narration with stale-guard
- [ ] What-if: parse -> draft -> confirm -> receipt -> applied; structured editor
- [ ] Sharing: issue/revoke/redeem, fragment scrub
- [ ] Results: metrics, heatmaps, fact-backed report, exports (JSON/CSV/print)
- [ ] Experiments: A/B spec, pair table, summaries, labels
- [ ] Replay: recorded frames, step/seek
- [ ] E2E (fixture) + screenshot matrix + accessibility + perf profile
- [ ] Live-integration command wired to A's launcher (NOT RUN until A/B exist)
- [ ] HANDOFF.md
