/**
 * In-process copy of Intelligence's MOCK provider policy (`mock-policy-v1`,
 * intelligence/src/providers/mock.ts). Mock-mode runs resolve their decision and rating
 * barriers inside Engine with this function instead of a worker round trip per decision.
 * It is a deterministic, interpretable mechanical policy, NOT a model of human behavior, and
 * it returns the same probability vectors the Intelligence worker would submit for the same
 * request (tests pin parity). Keep it byte-for-byte equivalent to the Intelligence version.
 */
import type * as C from "../../contract/behavior-v1.js";
import { canonical, hashBytes, random } from "../domain/primitives.js";

export const MOCK_MODEL = "mock-policy-v1";

function groupNeeds(o: C.GuestObservation) {
  const n = o.members.length || 1;
  const avg = (k: "hunger" | "fatigue" | "patience" | "fun") =>
    o.members.reduce((s, m) => s + m.needs[k], 0) / n / 100;
  return {
    hunger: avg("hunger"),
    fatigue: avg("fatigue"),
    patience: avg("patience"),
    fun: avg("fun"),
  };
}
function observedWaitUpperMin(
  o: C.GuestObservation,
  placeId: string,
): number | null {
  const f = o.facts
    .filter((x) => x.placeId === placeId && x.waitUpperMs !== null)
    .sort((a, b) => b.observedAtMs - a.observedAtMs)[0];
  return f ? f.waitUpperMs! / 60000 : null;
}
/** Unnormalized weight for one option; interpretable mechanical tendencies only. */
export function mockWeight(o: C.GuestObservation, opt: C.ActionOption): number {
  const n = groupNeeds(o);
  const md = new Set(o.members.flatMap((m) => m.persona.mustDoPlaceIds));
  const balance = o.wallet.balanceCents;
  const thrill =
    o.members.reduce((s, m) => s + m.persona.thrillPreference, 0) /
    (o.members.length || 1);
  const remainingMin = Math.max(0, (o.plannedDepartureMs - o.atMs) / 60000);
  const a = opt.action;
  switch (a.kind) {
    case "browse":
      return 0.6 + 0.4 * n.fatigue;
    case "continue":
      return 0.8;
    case "rest":
      return 0.3 + 2.5 * n.fatigue ** 2;
    case "leave_park":
      return (
        0.01 +
        3 * Math.max(0, n.fatigue - 0.5) ** 2 +
        (remainingMin < 30 ? 2 : 0) +
        (remainingMin <= 0 ? 4 : 0) +
        0.5 * Math.max(0, 0.25 - n.patience)
      );
    case "travel":
    case "join_queue":
    case "notice_enter": {
      const wait = observedWaitUpperMin(o, a.placeId);
      const tolerance = 15 + 60 * n.patience;
      const waitPenalty =
        wait === null ? 1 : Math.exp(-Math.max(0, wait - tolerance) / 20);
      const isFood = /food|eat|snack|taco|cone|lunch/i.test(
        `${opt.label} ${opt.description}`,
      );
      return (
        (0.6 +
          (md.has(a.placeId) ? 1.5 : 0) +
          (isFood ? 2.5 * n.hunger ** 2 : 0.5 * thrill)) *
        waitPenalty
      );
    }
    case "buy_pass_and_join": {
      if (a.quote.totalCents > balance) return 1e-6;
      const share = balance > 0 ? a.quote.totalCents / balance : 1;
      const wait = observedWaitUpperMin(o, a.placeId) ?? 0;
      return (
        (0.2 + (md.has(a.placeId) ? 0.8 : 0) + wait / 60) *
        Math.max(0.02, 1 - share)
      );
    }
    case "order": {
      const total = a.cart.reduce((s, q) => s + q.totalCents, 0);
      if (total > balance) return 1e-6;
      return (
        (0.2 + 3 * n.hunger ** 2) *
        Math.max(0.05, 1 - total / Math.max(1, balance))
      );
    }
    case "leave_queue":
      return 0.1 + 1.5 * (1 - n.patience) ** 2;
    case "notice_stop":
      return 0.3 + 1.2 * n.hunger;
    case "route":
      return 1;
    case "bump_response":
      return a.response === "continue" ? 1 : 0.6;
    case "regroup":
      return 1.2;
  }
}
export function mockDistribution(req: C.DecisionRequest): C.Distribution {
  const weights = req.options.map((opt) => {
    const jitter =
      0.9 + 0.2 * random(MOCK_MODEL, "mock", req.observationHash, opt.id);
    return Math.max(1e-9, mockWeight(req.observation, opt) * jitter);
  });
  const total = weights.reduce((s, w) => s + w, 0);
  return req.options.map((opt, i) => ({
    optionId: opt.id,
    probability: weights[i]! / total,
  }));
}
export function mockRatingDistribution(req: C.RatingRequest): number[] {
  const k = req.levels.length;
  const me = req.observation.members.find(
    (m) => m.persona.agentId === req.agentId,
  );
  if (!me)
    throw new Error(`rated member ${req.agentId} is not in the observation`);
  const needs = me.needs;
  const center =
    Math.max(
      0,
      Math.min(
        1,
        (needs.fun * 0.5 +
          needs.patience * 0.3 +
          (100 - needs.hunger) * 0.1 +
          (100 - needs.fatigue) * 0.1) /
          100,
      ),
    ) *
    (k - 1);
  const w = Array.from({ length: k }, (_, i) =>
    Math.exp(-((i - center) ** 2) / 1.2),
  );
  const t = w.reduce((s, v) => s + v, 0);
  return w.map((v) => v / t);
}
/** Reference to the canonical bytes the worker would have stored for this response. */
function inlineRef(value: unknown): C.ArtifactRef {
  const bytes = new TextEncoder().encode(canonical(value)),
    sha256 = hashBytes(bytes);
  return {
    artifactId: `inline-mock:${sha256.slice(0, 32)}`,
    kind: "model_response",
    sha256,
    byteLength: bytes.length,
    mediaType: "application/json",
    contractVersion: "behavior.v1",
  };
}
const ZERO_USAGE: C.Usage = {
  callId: null,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostUsd: 0,
  priceVersion: null,
  queueMs: 0,
  httpMs: 0,
  attemptCount: 0,
};
/** The mock decision result Engine applies in-process for a mock-mode run. */
export function inProcessMockDecision(
  req: C.DecisionRequest,
): C.DecisionResult {
  const probabilities = mockDistribution(req);
  return {
    requestId: req.requestId,
    observationHash: req.observationHash,
    optionsHash: req.optionsHash,
    modelRequested: MOCK_MODEL,
    modelReturned: MOCK_MODEL,
    source: "mock",
    probabilities,
    confidence: null,
    responseArtifact: inlineRef({
      mock: true,
      model: MOCK_MODEL,
      note: "Deterministic mock policy, evaluated in-process by Engine.",
      probabilities,
    }),
    usage: ZERO_USAGE,
    cacheKey: null,
    originalSource: "mock",
  };
}
/** The mock rating result Engine applies in-process for a mock-mode run. */
export function inProcessMockRating(req: C.RatingRequest): C.RatingResult {
  const probabilities = mockRatingDistribution(req);
  const scoreIndex = probabilities.reduce(
    (best, p, i) => (p > probabilities[best]! ? i : best),
    0,
  );
  return {
    ratingId: req.ratingId,
    evidenceHash: req.evidenceHash,
    rubricVersion: req.rubricVersion,
    scoreIndex,
    probabilities,
    source: "mock",
    modelReturned: MOCK_MODEL,
    responseArtifact: inlineRef({
      mock: true,
      model: MOCK_MODEL,
      note: "Deterministic mock rating, evaluated in-process by Engine.",
      score: scoreIndex,
      probabilities,
    }),
    usage: ZERO_USAGE,
  };
}
