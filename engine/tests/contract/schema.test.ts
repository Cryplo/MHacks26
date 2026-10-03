import { it, expect } from "vitest";
import fixture from "../../fixtures/conformance-fixtures.json";
import {
  validateContract,
  validatePortInput,
} from "../../src/domain/contract-validation.js";
it("A-01 frozen application fixtures conform to generated structural schemas", () => {
  validateContract("DecisionRequest", fixture.decisionRequest);
  validateContract("DecisionResult", fixture.decisionResult);
  validateContract("MetricSnapshot", fixture.metricSnapshot);
  expect(() =>
    validatePortInput("Commands", "createRun", { manifest: {} }),
  ).toThrow();
  expect(() =>
    validatePortInput("Commands", "startRun", { runId: "ok", extra: true }),
  ).toThrow();
  expect(() =>
    validatePortInput("Commands", "startRun", { runId: "../escape" }),
  ).toThrow();
});
