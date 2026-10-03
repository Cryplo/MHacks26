# Integration proposals (Experience lane)

Proposed **additive** changes or clarifications found while implementing against the frozen
`behavior.v1` contract. Experience keeps implementing v1 as-is; none of these are required
for the current code to work, and none change an existing field's meaning.

| # | Topic | Current Experience behavior |
|---|---|---|
| 0001 | Server-reported `VersionSet` | Sends labeled *requested* versions in `RunConfig.versions`; Engine must validate/reject. |
| 0002 | `Narrative.evidenceHash` binding | Accepts a match against SHA-256(canonical FactBundle) **or** `FactBundle.sourceHash`; otherwise shows a data error. |
| 0003 | Versioned fact bundles | `getFactBundle` has no `asOf`/revision input, so a report for a running run can mismatch; shown as an error with a "regenerate after completion" note. |
| 0004 | Engine park compiler CLI | `npm run content:compile` calls `engine` `compile:park --source <dir> --stage 1|2`; script name to be confirmed by A. |
| 0005 | `observed` event details | Notice-version grouping reads `details.contentVersion` when present, else shows "version not reported". |
| 0006 | Location queries for heatmap drill-down | UI pages through `getEvents` (bounded) and filters by position client-side. |
