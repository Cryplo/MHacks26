# 0002 — What `Narrative.evidenceHash` hashes for reports

**Gap.** For `report` work the payload is `{ facts: FactBundle }`. The contract does not say
whether `Narrative.evidenceHash` is `sha256(canonical(FactBundle))` or `FactBundle.sourceHash`.

**Current behavior.** `src/features/results/facts.ts` accepts either binding; any other value
produces a visible "Report data error" and no numbers are rendered (never a best guess).

**Proposal.** Pin `evidenceHash = sha256(canonicalJson(FactBundle))` for report narratives and
`sha256(canonicalJson(AppliedDecision))` for thought narratives; Experience will then accept
only that binding.
