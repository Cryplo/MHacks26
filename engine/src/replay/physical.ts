import type { CoreState } from "../domain/state.js";
import { hash, asciiCompare } from "../domain/primitives.js";
export function physicalProjection(s: CoreState): unknown {
  return {
    engine: s.manifest.config.versions.engine,
    simMs: s.view.simMs,
    stepIndex: s.view.stepIndex,
    persons: Object.values(s.persons)
      .sort((a, b) => asciiCompare(a.agentId, b.agentId))
      .map(
        ({ rating: _rating, terminalRatingId: _terminal, ...physical }) =>
          physical,
      ),
    groups: Object.values(s.groups).sort((a, b) =>
      asciiCompare(a.manifest.groupId, b.manifest.groupId),
    ),
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
