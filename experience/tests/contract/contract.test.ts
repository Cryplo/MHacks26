import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../src/domain/canonical';
import { inverseCdfChoice, semanticUniform } from '../../src/domain/random';
import {
  decisionResultSchema, domainErrorSchema, metricSnapshotSchema, scenarioSchema, validate,
} from '../../src/domain/schemas';
import golden from '../../fixtures/golden-vectors.json';
import conformance from '../../fixtures/conformance-fixtures.json';

const root = join(__dirname, '..', '..');
const FROZEN_SHA = 'c25776a4883f70c71e8b4991dabc1b7a641baa8baeb615b1cfc145c0b8f1aac4';

describe('frozen contract mirror', () => {
  it('is byte-identical to the agreed behavior.v1 contract (SHA-256 of LF bytes)', () => {
    const bytes = readFileSync(join(root, 'contract', 'behavior-v1.ts'));
    expect(bytes.includes(Buffer.from('\r\n'))).toBe(false);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(FROZEN_SHA);
  });
});

describe('golden vectors (cross-lane)', () => {
  it.each(golden.canonicalJson)('canonical JSON + sha256 #%#', async (v) => {
    expect(canonicalJson(v.input)).toBe(v.expectedCanonical);
    expect(await sha256Hex(canonicalJson(v.input))).toBe(v.sha256);
  });
  it.each(golden.random)('semantic uniform %#', async (v) => {
    expect(canonicalJson(v.key)).toBe(v.canonical);
    expect(await sha256Hex(v.canonical)).toBe(v.sha256);
    expect(await semanticUniform(v.key)).toBe(v.uniform);
  });
  it.each(golden.sampling)('inverse-CDF sampling u=$u', (v) => {
    expect(inverseCdfChoice(v.probabilities, v.u)).toBe(v.chosen);
  });
  it('money arithmetic stays in integer cents', () => {
    const m = golden.money;
    expect(m.unitPriceCents * m.quantity).toBe(m.expectedTotalCents);
    expect(m.startingBalanceCents - m.expectedTotalCents).toBe(m.expectedFinalBalanceCents);
  });
  it('waiting person-minutes', () => {
    const w = golden.waiting;
    expect((w.persons * w.durationMs) / 60_000).toBe(w.expectedPersonMinutes);
  });
  it('decision request hashes bind observation and the prompt permutation', async () => {
    const req = conformance.decisionRequest;
    expect(await sha256Hex(canonicalJson(req.observation))).toBe(golden.canonicalDecisionHashes.observationHash);
    expect(await sha256Hex(canonicalJson({ options: req.options, promptOptionOrder: req.promptOptionOrder }))).toBe(golden.canonicalDecisionHashes.optionsHash);
    expect(req.observationHash).toBe(golden.canonicalDecisionHashes.observationHash);
  });
});

describe('conformance fixtures validate against Experience schemas', () => {
  it('decision result (mock source stays mock)', () => {
    const r = validate(decisionResultSchema, conformance.decisionResult);
    expect(r.ok).toBe(true);
    expect(conformance.decisionResult.source).toBe('mock');
  });
  it('raw fixture response bytes match the artifact hash and length', async () => {
    const body = canonicalJson(conformance.rawFixtureResponse);
    const ref = conformance.decisionResult.responseArtifact;
    expect(new TextEncoder().encode(body).length).toBe(ref.byteLength);
    expect(await sha256Hex(body)).toBe(ref.sha256);
  });
  it('metric snapshot, scenario, rejected receipt', () => {
    expect(validate(metricSnapshotSchema, conformance.metricSnapshot).ok).toBe(true);
    expect(validate(scenarioSchema, conformance.scenario).ok).toBe(true);
    expect(validate(domainErrorSchema, conformance.rejectedReceipt.error).ok).toBe(true);
    expect(conformance.rejectedReceipt.ok).toBe(false);
  });
  it('rejects unknown enum values and fractional cents', () => {
    expect(validate(scenarioSchema, { ...conformance.scenario, events: [{ id: 'x', atMs: 5000, order: 0, change: { kind: 'teleport' } }] }).ok).toBe(false);
    expect(validate(scenarioSchema, { ...conformance.scenario, events: [{ id: 'x', atMs: 5000, order: 0, change: { kind: 'pass_price', unitPriceCents: 25.5 } }] }).ok).toBe(false);
    expect(validate(scenarioSchema, { ...conformance.scenario, events: [{ id: 'x', atMs: 1234, order: 0, change: { kind: 'pass_price', unitPriceCents: 2500 } }] }).ok).toBe(false);
  });
});
