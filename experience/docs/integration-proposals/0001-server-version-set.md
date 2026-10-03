# 0001 — Server-reported VersionSet

**Gap.** `RunConfig.versions: VersionSet` is a `createRun` input, but no query reports the
engine/observation/options/meter/metrics/rubric/replay versions or `sourceCommit` the server
actually runs. The browser cannot know them.

**Current behavior.** `src/features/setup/plan.ts` sends `REQUESTED_VERSIONS` with
`sourceCommit: "unknown"`. Engine must validate or reject them; the UI never claims they are
the server's versions.

**Proposal (additive).** Add `versions: VersionSet` to `Capabilities` (or a
`serverVersions` query). Experience would prefill `RunConfig.versions` from it and display
them in the frozen plan and exports.
