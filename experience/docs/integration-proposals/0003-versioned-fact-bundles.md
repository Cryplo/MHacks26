# 0003 — Versioned fact bundles

**Gap.** `getFactBundle({runId})` returns the bundle "now". A report composed from an earlier
bundle cannot be resolved once a running run advances, because there is no way to fetch the
exact bundle by ID/revision.

**Current behavior.** The mismatch is shown as a data error with guidance to regenerate after
the run completes.

**Proposal (additive).** Return the bundle as an `ArtifactRef` (kind `fact_bundle`) in the
report work result, or add `bundleId` to `getFactBundle` input, so a report always resolves
against the exact bundle it was composed from.
