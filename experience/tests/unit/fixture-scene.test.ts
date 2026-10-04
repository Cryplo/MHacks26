/** Fixture choreography sanity: scripted poses stay on painted walkways, queues are coherent. */
import { describe, expect, it } from 'vitest';
import type { CrowdSpec, ParkBundle } from '../../contract/behavior-v1';
import bundle from '../../fixtures/parks/harbor-lights-stage1.bundle.json';
import { buildFixturePopulation, allocateGuests } from '../../src/fixture/population';
import { buildAppliedDecision, generateScene, poseAt, queueViewsAt } from '../../src/fixture/scene';
import { inverseCdfChoice, semanticUniform } from '../../src/domain/random';
import { populationManifestSchema, validate } from '../../src/domain/schemas';

const park = bundle as unknown as ParkBundle;
const crowd: CrowdSpec = { guestCount: 220, seed: 'seed-t', shares: { young_family: 0.4, teens: 0.15, couple: 0.15, thrill_seekers: 0.1, seniors: 0.1, solo: 0.1 }, contextNotes: '', generatorVersion: 'fixture-pop-v1' };
const pop = buildFixturePopulation(crowd, park, 'f'.repeat(64)).manifest;
const scene = generateScene({ park, population: pop, seed: 'seed-t', horizonMs: 2 * 3600_000, passPriceSchedule: [], ratingEveryMs: 1800_000, earlyDepartureThresholdMs: 1800_000, runId: 'r' });

describe('fixture population', () => {
  it('fills the exact guest count with valid manifest shape and deterministic rounding', () => {
    expect(pop.personas.length).toBe(220);
    expect(validate(populationManifestSchema, pop).ok).toBe(true);
    const alloc = allocateGuests(7, { young_family: 1, teens: 1, couple: 1, thrill_seekers: 0, seniors: 0, solo: 0 });
    expect(Object.values(alloc).reduce((a, b) => a + b, 0)).toBe(7);
    expect(buildFixturePopulation(crowd, park, 'f'.repeat(64)).manifest).toEqual(pop);
  });
});

describe('fixture scene', () => {
  it('keeps every walking/queueing/resting pose on path, plaza or queue cells', () => {
    let bad = 0;
    for (let t = 0; t <= 2 * 3600_000; t += 15_000) {
      for (const p of pop.personas) {
        const pose = poseAt(scene, p.agentId, t);
        if (!pose.present || pose.state === 'riding' || pose.state === 'watching') continue;
        const c = scene.geo.codes[Math.floor(pose.position.yM) * park.grid.width + Math.floor(pose.position.xM)];
        if (c !== 1 && c !== 2 && c !== 4) bad++;
      }
    }
    expect(bad).toBe(0);
  });
  it('queue views list members in FIFO lanes at queue-zone cells', () => {
    const qv = queueViewsAt(scene, 3600_000).find((q) => q.entries.length > 1);
    expect(qv).toBeDefined();
    const seqs = qv!.entries.map((e) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const zone = park.queueZones.find((z) => z.placeId === qv!.placeId)!;
    const cells = new Set(zone.cellIndices);
    const first = qv!.entries[0]!.positions[0]!.position;
    expect(cells.has(Math.floor(first.yM) * 200 + Math.floor(first.xM))).toBe(true);
  });
  it('scripted evidence: draw matches the semantic key and the inverse-CDF choice', async () => {
    const d = [...scene.decisions.values()][5]!;
    const e = buildAppliedDecision(scene, d.evidenceId, 'r')!;
    expect(e.response.source).toBe('mock');
    expect(await semanticUniform(['behavior-rng-v1', 'seed-t', 'behavior', e.request.groupId, e.request.moment, e.request.momentSeq])).toBe(e.draw);
    expect(inverseCdfChoice(e.appliedProbabilities, e.draw)).toBe(e.chosenOptionId);
    const sum = e.response.probabilities.reduce((a, p) => a + p.probability, 0);
    expect(Math.abs(sum - 1)).toBeLessThanOrEqual(1e-6);
    expect([...e.request.promptOptionOrder].sort()).toEqual(e.request.options.map((o) => o.id).sort());
  });
});
