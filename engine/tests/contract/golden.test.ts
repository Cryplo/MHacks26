import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vectors from "../../fixtures/golden-vectors.json";
import fixture from "../../fixtures/conformance-fixtures.json";
import {
  canonical,
  hash,
  hashBytes,
  random,
  sample,
  total,
  debit,
} from "../../src/domain/primitives.js";

describe("Frozen behavior.v1", () => {
  it("matches exact contract bytes", () => {
    expect(
      hashBytes(
        readFileSync(new URL("../../contract/behavior-v1.ts", import.meta.url)),
      ),
    ).toBe("c25776a4883f70c71e8b4991dabc1b7a641baa8baeb615b1cfc145c0b8f1aac4");
  });
  it("matches every canonical JSON and keyed random vector", () => {
    for (const v of vectors.canonicalJson) {
      expect(canonical(v.input)).toBe(v.expectedCanonical);
      expect(hash(v.input)).toBe(v.sha256);
    }
    for (const v of vectors.random) {
      expect(canonical(v.key)).toBe(v.canonical);
      expect(hash(v.key)).toBe(v.sha256);
      expect(
        random(String(v.key[1]), String(v.key[2]), ...v.key.slice(3)),
      ).toBe(v.uniform);
    }
  });
  it("A-09 samples exact interval boundaries and rejects malformed distributions", () => {
    for (const v of vectors.sampling)
      expect(sample(v.probabilities, v.u)).toBe(v.chosen);
    expect(() => sample([{ optionId: "a", probability: -1 }], 0)).toThrow();
    expect(() => sample([{ optionId: "a", probability: 0 }], 0)).toThrow();
    expect(() => sample([{ optionId: "a", probability: 0.2 }], 0)).toThrow();
  });
  it("A-15 preserves exact cents", () => {
    const v = vectors.money;
    expect(total(v.unitPriceCents, v.quantity)).toBe(v.expectedTotalCents);
    expect(debit(v.startingBalanceCents, v.expectedTotalCents)).toBe(
      v.expectedFinalBalanceCents,
    );
    expect(() => total(Number.MAX_SAFE_INTEGER, 4)).toThrow();
  });
  it("binds observation, executable arguments, permutation, and raw artifact bytes", () => {
    const request = fixture.decisionRequest;
    expect(hash(request.observation)).toBe(request.observationHash);
    expect(
      hash({
        options: request.options,
        promptOptionOrder: request.promptOptionOrder,
      }),
    ).toBe(request.optionsHash);
    const bytes = new TextEncoder().encode(
      canonical(fixture.rawFixtureResponse),
    );
    expect(bytes.length).toBe(
      fixture.decisionResult.responseArtifact.byteLength,
    );
    expect(hashBytes(bytes)).toBe(
      fixture.decisionResult.responseArtifact.sha256,
    );
  });
  it("rejects lossy JSON values and retains exact text", () => {
    for (const value of [
      NaN,
      Infinity,
      1n,
      new Map(),
      new Set(),
      new Date(),
      [undefined],
      Array(1),
      () => 1,
    ]) {
      expect(() => canonical(value)).toThrow();
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonical(cyclic)).toThrow();
    expect(canonical({ a: undefined, text: " x " })).toBe('{"text":" x "}');
  });
});
