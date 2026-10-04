import type { CoreState } from "../domain/state.js";
import { hash, asciiCompare } from "../domain/primitives.js";
import { groups, personsInOrder } from "../sim/common.js";
export function physicalProjection(s: CoreState): unknown {
  return {
    engine: s.manifest.config.versions.engine,
    simMs: s.view.simMs,
    stepIndex: s.view.stepIndex,
    persons: personsInOrder(s).map(
      ({
        rating: _rating,
        terminalRatingId: _terminal,
        facts,
        ...physical
      }) => ({
        ...physical,
        // Remembered facts are covered by the person's fact digest chain.
        facts: physical.factDigest === undefined ? facts : undefined,
      }),
    ),
    // Group manifests are immutable population input (bound by the population hash).
    groups: groups(s).map(({ manifest, ...g }) => ({
      groupId: manifest.groupId,
      ...g,
    })),
    places: Object.values(s.places).sort((a, b) =>
      asciiCompare(a.definition.id, b.definition.id),
    ),
    queues: [...s.queues].sort((a, b) => a.sequence - b.sequence),
    sessions: [...s.sessions].sort((a, b) => asciiCompare(a.id, b.id)),
    sales: s.sales,
    entitlements: [...s.entitlements].sort(),
    passPriceCents: s.passPriceCents,
    passRevision: s.passRevision,
    nextQueueSequence: s.nextQueueSequence,
    nextSessionSequence: s.nextSessionSequence,
    closing: s.closing,
    totals: s.totals,
  };
}
export const physicalHash = (s: CoreState) => hash(physicalProjection(s));
