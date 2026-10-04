import { it, expect } from "vitest";
import fixture from "../../fixtures/conformance-fixtures.json";
import type * as C from "../../contract/behavior-v1.js";
import {
  inProcessMockDecision,
  mockDistribution,
} from "../../src/sim/mock-policy.js";
import { decisionRationale } from "../../src/sim/rationale.js";
import { distribution } from "../../src/domain/primitives.js";

// Pinned in BOTH lanes (intelligence/tests/providers/mock-parity.test.ts): Engine's in-process
// copy must return exactly what Intelligence's mock-policy-v1 worker would submit.
const PINNED = [
  { optionId: "browse", probability: 0.23470734685509148 },
  { optionId: "leave", probability: 0.0031673232835691873 },
  { optionId: "travel_splash", probability: 0.7621253298613393 },
];
const request = fixture.decisionRequest as unknown as C.DecisionRequest;

it("in-process mock policy matches Intelligence's mock-policy-v1 exactly", () => {
  expect(mockDistribution(request)).toEqual(PINNED);
  const result = inProcessMockDecision(request);
  expect(result.source).toBe("mock");
  expect(result.originalSource).toBe("mock");
  expect(result.requestId).toBe(request.requestId);
});

it("rationale names the needs, wallet and chosen option with its probability", () => {
  const probabilities = distribution(
    PINNED,
    request.options.map((o) => o.id),
  );
  const r = decisionRationale(
    request,
    probabilities,
    "travel_splash",
    inProcessMockDecision(request),
    "committed",
    null,
  );
  expect(r.chosen).toEqual({
    optionId: "travel_splash",
    label: request.options.find((o) => o.id === "travel_splash")!.label,
    probability: 0.762,
  });
  expect(r.alternatives[0]!.optionId).toBe("browse");
  expect(r.summary).toMatch(/left in the wallet/);
  expect(r.summary).toMatch(/-> chose .*\(p=0\.76\) over .*\(p=0\.23\)/);
  expect(r.modelReasoning).toBeNull();
  const withReasoning = decisionRationale(
    request,
    probabilities,
    "travel_splash",
    {
      ...inProcessMockDecision(request),
      reasoning: "Splash Falls has a short line.",
    },
    "committed",
    null,
  );
  expect(withReasoning.modelReasoning).toBe("Splash Falls has a short line.");
});
