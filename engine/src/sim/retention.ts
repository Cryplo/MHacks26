/**
 * History retention for crowd-scale runs.
 *
 * A 1000-guest day produces ~40k decisions per simulated hour; keeping every full
 * DecisionRequest (observation with personas, facts, destinations) twice (decision slot and
 * evidence) costs ~300 MB per simulated hour, far beyond what an in-memory database should
 * hold. Mock and live runs therefore keep:
 * - open decision slots only (applied slots are dropped; their evidence holds the request);
 * - full AppliedDecision evidence for each group's latest FULL_EVIDENCE_PER_GROUP decisions;
 * - a compact DecisionSummary log (rationale, chosen option, probabilities) of each group's
 *   latest DECISION_LOG_PER_GROUP decisions for the inspector;
 * - rating requests without their bulky observation once the rating has a result.
 * Replay frames are compact and budgeted separately (replay/frames.ts).
 * Experiment and replay runs keep complete history (response tapes, A/A replay guarantees).
 * Physical mechanics and results are unaffected; only stored explanatory history is bounded.
 */
import type * as C from "../../contract/behavior-v1.js";
import type { CoreState } from "../domain/state.js";
import { MOCK_MODEL } from "./mock-policy.js";

export const FULL_EVIDENCE_PER_GROUP = 2;
export const DECISION_LOG_PER_GROUP = 12;

export const compactsHistory = (s: CoreState) =>
  s.manifest.config.mode === "mock" ||
  s.manifest.config.mode === "live" ||
  s.manifest.config.mode === "local";
/**
 * Mock runs (and experiment arms that request the mock policy) evaluate the mock policy inside
 * Engine unless configured to use a worker (`config.mockResolution: "worker"`).
 */
export const resolvesInProcess = (s: CoreState) =>
  (s.manifest.config.mode === "mock" ||
    (s.manifest.config.mode === "experiment" &&
      s.manifest.config.versions.requestedModel === MOCK_MODEL)) &&
  (s.manifest.config.mockResolution ?? "engine") === "engine";
/**
 * Bounded-history runs whose responses came from outside Engine keep a compact response tape
 * (responses only) so the run can still be replayed; in-process mock responses are a pure
 * function of their requests and are not taped.
 */
export const keepsTape = (s: CoreState) =>
  compactsHistory(s) && !resolvesInProcess(s);

export function recordDecision(s: CoreState, e: C.AppliedDecision) {
  if (keepsTape(s)) (s.tapeResponses ??= []).push(e.response);
  if (!e.rationale) return;
  const log = ((s.decisionLog ??= {})[e.request.groupId] ??= {
    rev: 0,
    entries: [],
  });
  const chosen = e.request.options.find((o) => o.id === e.chosenOptionId);
  log.entries.push({
    evidenceId: e.evidenceId,
    atMs: e.committedAtMs,
    moment: e.request.moment,
    chosenOptionId: e.chosenOptionId,
    chosenLabel: chosen?.label ?? e.chosenOptionId,
    outcome: e.outcome,
    source: e.response.source,
    rationale: e.rationale,
  });
  if (log.entries.length > DECISION_LOG_PER_GROUP)
    log.entries.splice(0, log.entries.length - DECISION_LOG_PER_GROUP);
  log.rev++;
}

/** Drops applied decision slots and evidence older than each group's latest few. */
export function compactAfterApply(s: CoreState, appliedIds: string[]) {
  if (!compactsHistory(s) || !appliedIds.length) return;
  for (const id of appliedIds) {
    const slot = s.decisions[id];
    if (slot && slot.status === "applied") delete s.decisions[id];
  }
  const counts = new Map<string, number>();
  let drop = false;
  for (let i = s.evidence.length - 1; i >= 0; i--) {
    const g = s.evidence[i]!.request.groupId,
      n = (counts.get(g) ?? 0) + 1;
    counts.set(g, n);
    if (n > FULL_EVIDENCE_PER_GROUP) drop = true;
  }
  if (!drop) return;
  counts.clear();
  const kept: C.AppliedDecision[] = [];
  for (let i = s.evidence.length - 1; i >= 0; i--) {
    const e = s.evidence[i]!,
      n = (counts.get(e.request.groupId) ?? 0) + 1;
    counts.set(e.request.groupId, n);
    if (n <= FULL_EVIDENCE_PER_GROUP) kept.push(e);
  }
  s.evidence = kept.reverse();
}

/** Minimal schema-valid stand-in for an observation that is no longer needed. */
export function archivedObservation(o: C.GuestObservation): C.GuestObservation {
  return {
    ...o,
    members: o.members.map((m) => ({
      persona: { ...m.persona, backstory: "" },
      needs: m.needs,
    })),
    facts: [],
    knownDestinations: [],
    recentEventSummaries: [],
  };
}

/**
 * Stored evidence in bounded-history runs keeps an abridged observation: personas without
 * backstory (AgentDetail.persona carries it), the group's latest 3 facts, no candidate audit, and only the known
 * destinations an option refers to. `request.observationHash` still identifies the full
 * observation the behavior model saw; the rationale was computed from the full one.
 */
export function abridgeEvidence(
  s: CoreState,
  e: C.AppliedDecision,
): C.AppliedDecision {
  if (!compactsHistory(s)) return e;
  const o = e.request.observation,
    referenced = new Set(
      e.request.options.flatMap((x) =>
        "placeId" in x.action ? [x.action.placeId] : [],
      ),
    );
  return {
    ...e,
    request: {
      ...e.request,
      candidateAudit: { considered: [], excluded: [] },
      observation: {
        ...o,
        members: o.members.map((m) => ({
          persona: { ...m.persona, backstory: "" },
          needs: m.needs,
        })),
        facts: o.facts.slice(-3),
        knownDestinations: o.knownDestinations.filter((d) =>
          referenced.has(d.placeId),
        ),
      },
    },
  };
}
