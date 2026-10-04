# Intelligence implementation status

Branch `feat/behavior-engine-intelligence`. Base: unborn `main` (the repository had no commits when work started). Details, commands and results: [HANDOFF.md](HANDOFF.md).

- [x] Package, frozen contract mirror (sha256 `c25776a4…aac4`, hash-checked by `lint`/`test:contract`), golden vectors, conformance fixtures
- [x] Canonical JSON, SHA-256, semantic random, distribution and DTO validation
- [x] Scripted fake RuntimeClient (orchestration-only) and explicit fixture/spacetime loader (no fallback)
- [x] Deterministic population generator, prose, manifest, diversity, 300-guest fixture (regenerates byte-identical)
- [x] Worker: claim/lease/renew, journal, dispatch, durable submit, restart recovery, graceful shutdown, status
- [x] Mock provider, Jev HTTP adapter (documentation-derived shapes), retries/Retry-After/fail-fast, response validation
- [x] Exact write-once cache, coalescing, namespaces, provider limiter with behavior reservation, usage ledger
- [x] Ratings (per member, terminal, never imputed), crowd parser, scenario parser, evidence narration
- [x] Durable paired coordinator (resume per phase, driver/work-lease fencing, warmup clone), exact Student t, preflight, fact bundles, response tape, experiment narrative
- [x] Plausibility lab with placebo noise floor (mock-mechanical vs real-provider evidence separated)
- [x] CLIs: `dev:worker`, `experiment:mock`, `plausibility`, `population:fixture`, `smoke:jev`
- [x] HANDOFF.md

External gates (NOT RUN; see HANDOFF "Incomplete gates"):

- [ ] B-22 live Jev smoke and captured sanitized fixtures (no `JEV_API_KEY` authorized in this environment)
- [ ] B-18 / B-21 on the real Engine RuntimeClient (`engine/client/dist/node.js` not present on this branch)
