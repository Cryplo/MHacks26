import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { canonicalBytes, canonicalJson, hashCanonical, sha256Hex } from '../../src/core/canonical.ts';
import { referenceInverseCdf, semanticUniform } from '../../src/core/random.ts';
import {
  observationHash, optionsHash, validateDecisionRequest, validateDistribution, validateMetricSnapshot, validateScenario,
} from '../../src/core/validate.ts';
import { conformance, golden } from '../helpers/fixtures.ts';

describe('frozen contract mirror', () => {
  it('is byte-identical to the agreed SHA-256', () => {
    const bytes = readFileSync(fileURLToPath(new URL('../../contract/behavior-v1.ts', import.meta.url)));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('2753b3c5c1eb16106f1a1eb69fc84174aa3c733eb5e6450927d5b60f98083a97');
    expect(CONTRACT_VERSION).toBe('behavior.v1');
  });
});

describe('golden canonical JSON', () => {
  const g = golden();
  for (const [i, v] of (g.canonicalJson as any[]).entries()) {
    it(`vector ${i}`, () => {
      expect(canonicalJson(v.input)).toBe(v.expectedCanonical);
      expect(hashCanonical(v.input)).toBe(v.sha256);
    });
  }

  it('rejects non-JSON values and omits absent optional keys', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Infinity })).toThrow(/non-finite/);
    expect(() => canonicalJson([1, undefined])).toThrow(/undefined array/);
    expect(() => canonicalJson({ a: 1n })).toThrow(/BigInt/);
    expect(() => canonicalJson(new Map())).toThrow(/non-plain/);
    expect(() => canonicalJson({ s: new Set() })).toThrow(/non-plain/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(/function/);
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/non-plain/);
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  it('does not trim or normalize text', () => {
    expect(canonicalJson({ t: '  e\u0301 ' })).toBe('{"t":"  e\u0301 "}');
    expect(canonicalJson({ t: '\u00e9' })).not.toBe(canonicalJson({ t: 'e\u0301' }));
  });
});

describe('golden semantic random', () => {
  for (const v of golden().random as any[]) {
    it(v.canonical, () => {
      expect(canonicalJson(v.key)).toBe(v.canonical);
      expect(sha256Hex(canonicalBytes(v.key))).toBe(v.sha256);
      const [, seed, stream, ...keys] = v.key;
      expect(semanticUniform(seed, stream, ...keys)).toBe(v.uniform);
    });
  }

  it('reference inverse CDF matches sampling vectors', () => {
    for (const v of golden().sampling as any[]) expect(referenceInverseCdf(v.probabilities, v.u)).toBe(v.chosen);
  });

  it('money and waiting arithmetic vectors', () => {
    const g = golden();
    expect(g.money.unitPriceCents * g.money.quantity).toBe(g.money.expectedTotalCents);
    expect(g.money.startingBalanceCents - g.money.expectedTotalCents).toBe(g.money.expectedFinalBalanceCents);
    expect((g.waiting.persons * g.waiting.durationMs) / 60000).toBe(g.waiting.expectedPersonMinutes);
  });
});

describe('conformance fixtures', () => {
  const c = conformance();

  it('decision hashes match golden values', () => {
    expect(observationHash(c.decisionRequest)).toBe(golden().canonicalDecisionHashes.observationHash);
    expect(optionsHash(c.decisionRequest)).toBe(golden().canonicalDecisionHashes.optionsHash);
    expect(validateDecisionRequest(c.decisionRequest).ok).toBe(true);
  });

  it('optionsHash binds the prompt permutation and executable arguments', () => {
    const reordered = { ...c.decisionRequest, promptOptionOrder: ['browse', 'travel_splash', 'leave'] };
    expect(optionsHash(reordered)).not.toBe(c.decisionRequest.optionsHash);
    expect(validateDecisionRequest(reordered).ok).toBe(false);
    const changedArg = structuredClone(c.decisionRequest);
    (changedArg.options[0]!.action as { durationMs: number }).durationMs = 60000;
    expect(validateDecisionRequest(changedArg).ok).toBe(false);
  });

  it('raw response artifact byte length and hash match the fixture reference', () => {
    const bytes = canonicalBytes(c.rawFixtureResponse);
    expect(bytes.byteLength).toBe(c.decisionResult.responseArtifact.byteLength);
    expect(sha256Hex(bytes)).toBe(c.decisionResult.responseArtifact.sha256);
  });

  it('fixture decision result is valid and labeled mock', () => {
    const r = c.decisionResult;
    expect(r.source).toBe('mock');
    expect(r.originalSource).toBe('mock');
    expect(validateDistribution(c.decisionRequest.options.map((o) => o.id), r.probabilities).ok).toBe(true);
  });

  it('metric snapshot and scenario validate', () => {
    expect(validateMetricSnapshot(c.metricSnapshot)).toEqual([]);
    expect(validateScenario(c.scenario)).toEqual([]);
  });
});

describe('distribution validation', () => {
  const ids = ['a', 'b', 'c'];
  const d = (...p: number[]) => p.map((probability, i) => ({ optionId: ids[i]!, probability }));
  it('accepts valid and round-off vectors without normalizing', () => {
    const r = validateDistribution(ids, d(0.2, 0.3, 0.5 + 5e-7));
    expect(r.ok && r.value.raw[2]!.probability).toBe(0.5 + 5e-7);
  });
  it.each([
    ['missing', [{ optionId: 'a', probability: 0.5 }, { optionId: 'b', probability: 0.5 }]],
    ['extra', [...d(0.2, 0.3, 0.5), { optionId: 'z', probability: 0 }]],
    ['duplicate', [...d(0.2, 0.3), { optionId: 'b', probability: 0.5 }]],
    ['NaN', d(Number.NaN, 0.5, 0.5)],
    ['negative', d(-0.1, 0.6, 0.5)],
    ['zero', d(0, 0, 0)],
    ['bad sum', d(0.2, 0.2, 0.2)],
    ['non-string id', [{ optionId: 1, probability: 1 }]],
  ])('rejects %s', (_label, values) => {
    expect(validateDistribution(ids, values as any).ok).toBe(false);
  });
});
