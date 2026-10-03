import type {
  DecisionRequest,
  DecisionResult,
} from "../contract/behavior-v1.js";
import type { CoreState } from "../src/domain/state.js";
import { fixtureRef } from "./tiny.js";
import { acceptDecision, advanceCore, startCore } from "../src/sim/engine.js";
import { Navigation } from "../src/navigation/grid.js";
export function mockResponse(
  request: DecisionRequest,
  chosen: string,
): DecisionResult {
  const probabilities = request.options.map((o) => ({
    optionId: o.id,
    probability: o.id === chosen ? 1 : 0,
  }));
  return {
    requestId: request.requestId,
    observationHash: request.observationHash,
    optionsHash: request.optionsHash,
    modelRequested: "mock-policy-v1",
    modelReturned: "mock-policy-v1",
    source: "mock",
    probabilities,
    confidence: null,
    responseArtifact: fixtureRef("model_response", {
      mock: true,
      probabilities,
    }),
    usage: {
      callId: null,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      priceVersion: null,
      queueMs: 0,
      httpMs: 0,
      attemptCount: 0,
    },
    cacheKey: null,
    originalSource: "mock",
  };
}
export function scriptedChoice(s: CoreState, r: DecisionRequest): string {
  const options = new Set(r.options.map((o) => o.id)),
    did = (kind: string, place: string) =>
      s.events.some(
        (e) =>
          e.groupId === r.groupId && e.kind === kind && e.placeId === place,
      );
  const priorities =
    r.moment === "noticed"
      ? ["continue"]
      : r.moment === "closing_soon"
        ? ["leave"]
        : r.moment === "stay_line"
          ? ["continue"]
          : !did("service_completed", "ride")
            ? ["buy_pass", "join_pass", "join_standard", "travel:ride"]
            : !did("service_completed", "food")
              ? ["order:meal", "travel:food"]
              : ["leave"];
  return (
    priorities.find((id) => options.has(id)) ??
    (options.has("leave") ? "leave" : r.options[0]!.id)
  );
}
export function runMock(
  s: CoreState,
  options: {
    maxWork?: number;
    reverseResponses?: boolean;
    limit?: number;
  } = {},
) {
  const nav = new Navigation(s.park.grid);
  if (s.view.status === "ready") startCore(s);
  let invocations = 0,
    neighborChecks = 0;
  while (s.view.status !== "completed") {
    if (++invocations > (options.limit ?? 100000))
      throw new Error(
        `Mock invocation budget exhausted at ${s.view.simMs}/${s.view.phase}`,
      );
    const progress = advanceCore(s, nav, options.maxWork ?? 100);
    neighborChecks += progress.neighborChecks;
    if (s.view.status === "blocked") {
      let ids = [...s.view.blockedWorkIds];
      if (options.reverseResponses) ids = ids.reverse();
      for (const id of ids) {
        const r = s.decisions[id]!.request;
        acceptDecision(s, mockResponse(r, scriptedChoice(s, r)));
      }
    }
  }
  return { invocations, neighborChecks };
}
