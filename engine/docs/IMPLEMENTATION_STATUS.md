# Engine implementation status

Scope: the full engine assignment in ASSIGNMENT.md, A-01 through A-25.
Source repository was unborn (no commit, files, or remote refs). Bootstrap is
the first commit on feat/behavior-engine-runtime; implementation continues in
an isolated worktree from that commit. No existing AGENTS.md was found.
Starting toolchain: Node 25.9.0, npm 11.12.1; SpacetimeDB CLI not installed.

- [x] Bootstrap: frozen contract, fixtures, canonicalization and golden checks
- [x] Validated manifests, pure state/phase model, 12-guest synthetic park
- [ ] Mock vertical slice: arrival, free motion, admission, service, purchase, exit
- [ ] Navigation, PNG compilation, simultaneous motion and group invariants
- [ ] Observations, action options, notices, scenarios and decision barriers
- [ ] Queues, accounting, meters, ratings, reconciled metrics/heatmaps
- [ ] Durable work, receipts, artifacts, driver fencing and trusted access
- [ ] Real SpacetimeDB module, generated SDK and portable adapter
- [ ] Replay, checkpoints, experiments/product plumbing and subscriptions
- [ ] Integration launcher, real local tests, load measurements and handoff

External gates: intelligence/experience lanes are absent; real Jev calls need
authorized credentials and budget. These do not block owned offline work.

Bootstrap validation: typecheck, lint and 6 contract tests PASS. TypeScript 6.0.2
pinned for typescript-eslint compatibility; Node 24 is lane-local for Vitest 5.

Second slice: 19 validation/navigation tests + 6 golden checks PASS; typecheck/lint PASS.
Base: adf003b5eaebdf7a790446daeec0d672ce6e7434. Isolated worktree: ~/.codex/worktrees/mhacks-engine/MHacks26.
