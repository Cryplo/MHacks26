import type { AppliedDecision, Capabilities, ParkBundle, ScenarioContext } from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../../src/core/canonical.ts';
import { harborLightsFixturePark, parkArtifact } from '../../src/fixtures/harbor-lights.ts';
import { conformance } from './fixtures.ts';

export const ALL_EVENT_KINDS: Capabilities['eventKinds'] = ['pass_price', 'pass_share', 'board', 'notice', 'closure', 'show_schedule', 'app_message'];

export function capabilities(over: Partial<Capabilities> = {}, features: Partial<Capabilities['features']> = {}): Capabilities {
  return {
    contractVersion: 'behavior.v1', eventKinds: ALL_EVENT_KINDS,
    workKinds: ['population', 'parse_crowd', 'parse_scenario', 'thought', 'report'],
    features: { routeChoice: false, bumpReactions: false, splitGroups: false, speechBubbles: false, discountMessages: false, ...features },
    maxGuests: 400, maxArtifactBytes: 8_000_000, maxChunkBytes: 1_000_000, ...over,
  };
}

export function scenarioSetup(opts: { park?: (b: ParkBundle) => ParkBundle; context?: Partial<ScenarioContext>; caps?: Capabilities } = {}) {
  const bundle = (opts.park ?? ((b) => b))(harborLightsFixturePark());
  const art = parkArtifact(bundle);
  const context: ScenarioContext = {
    runId: 'run-1', currentSimMs: 3_600_000, earliestSchedulableMs: 3_605_000, scenarioRevision: 'scn-7',
    park: { parkId: bundle.parkId, revision: bundle.revision, label: bundle.label, artifact: art.ref, status: 'ready', issues: [] },
    places: bundle.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    capabilities: opts.caps ?? capabilities(),
    ...opts.context,
  };
  return { bundle, art, context };
}

/** A self-consistent AppliedDecision built from the conformance fixture (synthetic). */
export function appliedDecision(over: { chosen?: string; outcome?: AppliedDecision['outcome']; mutate?: (e: AppliedDecision) => void } = {}): AppliedDecision {
  const c = conformance();
  const e: AppliedDecision = {
    evidenceId: 'ev-fixture-1', request: c.decisionRequest, response: c.decisionResult,
    appliedProbabilities: c.decisionResult.probabilities, draw: 0.42, chosenOptionId: over.chosen ?? 'travel_splash',
    outcome: over.outcome ?? 'committed', failureReason: over.outcome === 'failed_precondition' ? 'queue closed on arrival' : null,
    committedAtMs: 3_600_000, causedEventIds: ['evt010'],
  };
  over.mutate?.(e);
  return e;
}

export const evidenceHashOf = (e: AppliedDecision) => hashCanonical(e);
