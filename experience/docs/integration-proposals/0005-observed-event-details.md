# 0005 — `observed` event details schema

`EventRecord.details` is Engine-owned. To show "which guests newly observed the changed
notice version", Experience reads `details.contentVersion` (string) on `observed` events when
present (`src/features/live/queueAndNotices.ts`). Proposed Engine schema for `observed`:
`{ factId, contentVersion, channel, text }`. Without it the UI shows "version not reported"
rather than guessing.
