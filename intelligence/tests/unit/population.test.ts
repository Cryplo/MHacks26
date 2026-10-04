import { describe, expect, it } from 'vitest';
import type { CrowdSpec, PopulationManifest } from '../../contract/behavior-v1.ts';
import { DEFAULT_CROWD_300, TINY_CROWD } from '../../src/fixtures/crowds.ts';
import { allocateGuests, validateShares } from '../../src/population/allocation.ts';
import { generatePopulation } from '../../src/population/index.ts';
import { validatePopulationManifest } from '../../src/population/manifest.ts';
import { parkContext } from '../../src/population/park.ts';
import type { ProseProvider } from '../../src/population/prose.ts';
import { templateBackstory, validateBackstory } from '../../src/population/prose.ts';
import { hashCanonical } from '../../src/core/canonical.ts';
import { readFixture } from '../helpers/fixtures.ts';
import { fixturePark } from '../helpers/park.ts';

const { bundle, ctx } = fixturePark();
const close = bundle.closeAfterMs;

async function gen(crowd: CrowdSpec, prose: ProseProvider | null = null) {
  const r = await generatePopulation({ crowd, park: ctx, closeAfterMs: close, prose });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r;
}

describe('B-01 deterministic manifest', () => {
  it('same complete input yields byte-identical manifest and exact size', async () => {
    const a = await gen(DEFAULT_CROWD_300);
    const b = await gen(structuredClone(DEFAULT_CROWD_300));
    expect(a.sha256).toBe(b.sha256);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.manifest.personas).toHaveLength(300);
    expect(a.manifest.groups.reduce((s, g) => s + g.memberIds.length, 0)).toBe(300);
  });

  it('seed, shares, generator/goal-policy and park changes alter the manifest', async () => {
    const base = (await gen(DEFAULT_CROWD_300)).sha256;
    const seed = (await gen({ ...DEFAULT_CROWD_300, seed: 'seed-002' })).sha256;
    const shares = (await gen({ ...DEFAULT_CROWD_300, shares: { ...DEFAULT_CROWD_300.shares, teens: 0.2, solo: 0.05 } })).sha256;
    const policy = (await gen({ ...DEFAULT_CROWD_300, generatorVersion: 'population-v1+aspirations' })).sha256;
    const notes = (await gen({ ...DEFAULT_CROWD_300, contextNotes: 'rainy morning' })).sha256;
    expect(new Set([base, seed, shares, policy, notes]).size).toBe(5);
    const otherPark = parkContext(bundle, 'f'.repeat(64));
    const r = await generatePopulation({ crowd: DEFAULT_CROWD_300, park: otherPark, closeAfterMs: close });
    expect(r.ok && r.sha256).not.toBe(base);
  });

  it('committed 300-guest fixture regenerates byte-identically', async () => {
    const committed = readFixture<PopulationManifest>('population-300.fixture.json');
    const r = await gen(DEFAULT_CROWD_300);
    expect(r.manifest).toEqual(committed);
    expect(hashCanonical(committed)).toBe(r.sha256);
  });

  it.each([1, 2, 7, 33, 299, 400])('produces exactly %i guests', async (n) => {
    const r = await gen({ ...DEFAULT_CROWD_300, guestCount: n, shares: { ...DEFAULT_CROWD_300.shares } });
    expect(r.manifest.personas).toHaveLength(n);
  });

  it('rejects out-of-range guest counts and unsupported generator versions', async () => {
    for (const crowd of [{ ...TINY_CROWD, guestCount: 0 }, { ...TINY_CROWD, guestCount: 401 }, { ...TINY_CROWD, guestCount: 2.5 }, { ...TINY_CROWD, generatorVersion: 'v9' }]) {
      const r = await generatePopulation({ crowd, park: ctx, closeAfterMs: close });
      expect(r.ok).toBe(false);
    }
  });
});

describe('B-02 structural validity', () => {
  it('families have adult guardians/leaders; ids unique and referenced; wallets not duplicated', async () => {
    const { manifest } = await gen(DEFAULT_CROWD_300);
    expect(validatePopulationManifest(manifest, ctx, 'population-v1', 300).errors).toEqual([]);
    const agents = new Map(manifest.personas.map((p) => [p.agentId, p]));
    for (const g of manifest.groups) {
      const members = g.memberIds.map((id) => agents.get(id)!);
      if (members.some((m) => m.ageYears < 13)) {
        expect(g.guardianIds.length).toBeGreaterThan(0);
        expect(agents.get(g.leaderId)!.ageYears).toBeGreaterThanOrEqual(18);
      }
      expect(g.arrivalMs % 5000).toBe(0);
      expect(g.plannedDepartureMs % 5000).toBe(0);
      expect(g.plannedDepartureMs).toBeGreaterThan(g.arrivalMs);
      expect(g.plannedDepartureMs).toBeLessThanOrEqual(close);
      for (const m of members) for (const pid of m.mustDoPlaceIds) {
        const place = ctx.places.get(pid)!;
        expect(ctx.reachable.has(pid)).toBe(true);
        if (place.minHeightCm !== null) expect(m.heightCm).toBeGreaterThanOrEqual(place.minHeightCm);
      }
    }
    expect(new Set(manifest.groups.map((g) => g.walletId)).size).toBe(manifest.groups.length);
    expect(new Set(manifest.personas.map((p) => p.agentId)).size).toBe(300);
  });

  it('validator catches broken references, shared wallets, unsupervised children, bad times and height violations', async () => {
    const { manifest } = await gen(DEFAULT_CROWD_300);
    const broken: PopulationManifest = structuredClone(manifest);
    const fam = broken.groups.find((g) => g.guardianIds.length > 0)!;
    fam.guardianIds = [];
    broken.groups[1]!.walletId = broken.groups[0]!.walletId;
    broken.groups[2]!.arrivalMs = 1234;
    broken.groups[3]!.memberIds.push('a9999');
    const child = broken.personas.find((p) => p.heightCm < 122)!;
    child.mustDoPlaceIds = ['comet'];
    broken.personas[5]!.mustDoPlaceIds = ['nonexistent'];
    const msgs = validatePopulationManifest(broken, ctx, 'population-v1', 300).errors.map((e) => e.message).join('\n');
    expect(msgs).toMatch(/children without a guardian/);
    expect(msgs).toMatch(/wallet shared/);
    expect(msgs).toMatch(/5000 ms boundaries/);
    expect(msgs).toMatch(/unknown agent a9999/);
    expect(msgs).toMatch(/comet requires 122 cm/);
    expect(msgs).toMatch(/unknown or unreachable place nonexistent/);
  });

  it('rejects hooks that point at unreachable places', async () => {
    const isolated = structuredClone(bundle);
    // Move the pier entrance onto grass (unreachable) and check the reachability set.
    isolated.places.find((p) => p.id === 'pier')!.entrance = { xM: 57 * 2 + 1, yM: 10 * 2 + 1 };
    const iso = parkContext(isolated, ctx.parkHash);
    expect(iso.reachable.has('pier')).toBe(false);
    const { manifest } = await gen(TINY_CROWD);
    const m = structuredClone(manifest);
    m.personas[0]!.mustDoPlaceIds = ['pier'];
    expect(validatePopulationManifest(m, iso, 'population-v1', 8).errors.some((e) => /unreachable place pier/.test(e.message))).toBe(true);
  });

  it('deliberately infeasible aspirations are labeled and only exist in the aspirations generator', async () => {
    const def = await gen(DEFAULT_CROWD_300);
    expect(def.summary.hooks.infeasibleAspirations).toBe(0);
    const asp = await gen({ ...DEFAULT_CROWD_300, generatorVersion: 'population-v1+aspirations' });
    expect(asp.summary.hooks.infeasibleAspirations).toBeGreaterThan(0);
    const agents = new Map(asp.manifest.personas.map((p) => [p.agentId, p]));
    for (const p of asp.manifest.personas) for (const pid of p.mustDoPlaceIds) {
      const place = ctx.places.get(pid)!;
      if (place.minHeightCm !== null && p.heightCm < place.minHeightCm) expect(p.backstory).toMatch(/aspiration/);
    }
    expect(agents.size).toBe(300);
  });
});

describe('B-03 quotas, feasibility and diversity', () => {
  it('validates shares: negative, NaN, unknown, missing, all-zero rejected; non-unit sums normalized with warning', () => {
    const base = { ...DEFAULT_CROWD_300.shares };
    expect(validateShares({ ...base, teens: -0.1 }).ok).toBe(false);
    expect(validateShares({ ...base, teens: Number.NaN }).ok).toBe(false);
    expect(validateShares({ ...base, tourists: 0.1 }).ok).toBe(false);
    const { solo: _solo, ...missing } = base;
    expect(validateShares(missing).ok).toBe(false);
    expect(validateShares({ young_family: 0, teens: 0, couple: 0, thrill_seekers: 0, seniors: 0, solo: 0 }).ok).toBe(false);
    const r = validateShares({ young_family: 2, teens: 0, couple: 1, thrill_seekers: 0, seniors: 0, solo: 1 });
    expect(r.ok && r.normalized.young_family).toBe(0.5);
    expect(r.ok && r.warnings[0]).toMatch(/normalized/);
  });

  it('largest remainder hits the exact total and records rounding', () => {
    const r = allocateGuests(7, { young_family: 1 / 3, teens: 0, couple: 0, thrill_seekers: 1 / 3, seniors: 0, solo: 1 / 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.values(r.realized).reduce((s, v) => s + v, 0)).toBe(7);
    expect(r.warnings.some((w) => w.startsWith('rounding'))).toBe(true);
  });

  it('repairs an infeasible small family quota rather than creating a lone child', () => {
    const r = allocateGuests(5, { young_family: 0.2, teens: 0, couple: 0, thrill_seekers: 0, seniors: 0, solo: 0.8 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.targets.young_family).toBe(1);
    expect([0, 2]).toContain(r.realized.young_family);
    expect(r.warnings.some((w) => w.startsWith('feasibility'))).toBe(true);
    expect(Object.values(r.realized).reduce((s, v) => s + v, 0)).toBe(5);
  });

  it('odd couple-only crowd and one-guest family crowd return actionable errors', async () => {
    const coupleOnly = { young_family: 0, teens: 0, couple: 1, thrill_seekers: 0, seniors: 0, solo: 0 };
    const r1 = allocateGuests(3, coupleOnly);
    expect(r1.ok).toBe(false);
    const famOnly = { ...coupleOnly, couple: 0, young_family: 1 };
    const r2 = await generatePopulation({ crowd: { ...TINY_CROWD, guestCount: 1, shares: famOnly }, park: ctx, closeAfterMs: close });
    expect(r2.ok).toBe(false);
    expect(!r2.ok && r2.errors[0]!.message).toMatch(/increase guestCount|add a share/);
  });

  it('records requested vs realized shares and broad diversity without stereotype assertions', async () => {
    const r = await gen(DEFAULT_CROWD_300);
    const d = r.summary;
    expect(d.disclaimer).toMatch(/not empirically representative/);
    expect(d.reproducibilityHash).toBe(r.sha256);
    for (const a of Object.keys(d.requestedShares) as (keyof typeof d.requestedShares)[]) {
      expect(Math.abs(d.realizedShares[a] - d.requestedShares[a])).toBeLessThan(0.02);
    }
    // Broad coverage checks: several group sizes, languages, both app states, ranges of budget/needs.
    expect(Object.keys(d.groupSizes).length).toBeGreaterThanOrEqual(4);
    expect(Object.keys(d.languages).length).toBeGreaterThanOrEqual(3);
    expect(d.app.withApp).toBeGreaterThan(0);
    expect(d.app.withoutApp).toBeGreaterThan(0);
    expect(d.budgetPerGuestCents.max! - d.budgetPerGuestCents.min!).toBeGreaterThan(3000);
    expect(d.needs.patience.max! - d.needs.patience.min!).toBeGreaterThan(20);
    expect(d.hooks.groupsWithMustDo).toBeGreaterThan(0);
    expect(d.constraints.mustDoHeightViolations).toBe(0);
    expect(d.constraints.unsupervisedMinors).toBe(0);
    // Within-archetype variation: thrill preference spans a wide range inside every archetype.
    for (const a of ['young_family', 'seniors', 'thrill_seekers'] as const) {
      const t = r.manifest.personas.filter((p) => p.archetype === a).map((p) => p.thrillPreference);
      expect(Math.max(...t) - Math.min(...t)).toBeGreaterThan(0.4);
    }
    expect(r.manifest.diversity.find((x) => x.key === 'guests.realized')!.counts).toEqual(d.realizedGuests);
  });
});

describe('B-04 prose', () => {
  const liar: ProseProvider = {
    model: 'fixture-prose-model', promptVersion: 'prose-prompt-v1',
    generate: async (f) => `A ${f.ageYears}-year-old with a $200 budget and a nut allergy who must ride Harbor Comet before 3pm.`,
  };
  const faithful: ProseProvider = {
    model: 'fixture-prose-model', promptVersion: 'prose-prompt-v1',
    generate: async (f) => `A ${f.ageYears}-year-old enjoying ${f.parkLabel} for the day.`,
  };

  it('contradictory prose falls back to template and never changes structured traits', async () => {
    const tmpl = await gen(TINY_CROWD);
    const r = await gen(TINY_CROWD, liar);
    expect(r.prose.every((p) => p.origin === 'template' && p.fallbackReason)).toBe(true);
    const strip = (m: PopulationManifest) => m.personas.map(({ backstory: _b, ...rest }) => rest);
    expect(strip(r.manifest)).toEqual(strip(tmpl.manifest));
    expect(r.manifest.groups).toEqual(tmpl.manifest.groups);
    expect(r.manifest.personas.map((p) => p.backstory)).toEqual(tmpl.manifest.personas.map((p) => p.backstory));
    expect(r.manifest.proseVersion).toMatch(/^llm:fixture-prose-model:prose-prompt-v1\+fallback/);
    expect(r.sha256).not.toBe(tmpl.sha256);
  });

  it('accepted LLM prose is frozen with versions; structured traits unchanged', async () => {
    const tmpl = await gen(TINY_CROWD);
    const r = await gen(TINY_CROWD, faithful);
    expect(r.prose.filter((p) => p.origin === 'llm').length).toBeGreaterThan(0);
    expect(r.manifest.personas.map((p) => p.ageYears)).toEqual(tmpl.manifest.personas.map((p) => p.ageYears));
  });

  it('prose cache key covers complete input', async () => {
    const r1 = await gen(TINY_CROWD, faithful);
    const r2 = await gen({ ...TINY_CROWD, seed: 'tiny-002' }, faithful);
    expect(r1.prose[0]!.cacheKey).not.toBe(r2.prose[0]!.cacheKey);
    const r3 = await gen(TINY_CROWD, { ...faithful, promptVersion: 'prose-prompt-v2' });
    expect(r3.prose[0]!.cacheKey).not.toBe(r1.prose[0]!.cacheKey);
  });

  it('template prose passes its own validator for every persona of the 300 fixture', async () => {
    const r = await gen(DEFAULT_CROWD_300);
    expect(r.manifest.personas.every((p) => p.backstory.startsWith('Synthetic persona:'))).toBe(true);
    const f = { parkLabel: 'Harbor Lights', role: 'parent' as const, ageYears: 38, groupSize: 4, companions: ['parent', 'child', 'child'] as const, occasion: 'birthday', mustDoNames: ['Splash Falls'], aspirationNames: [], hasApp: true, stroller: false, forbiddenPlaceNames: ['Harbor Comet'] };
    expect(validateBackstory(templateBackstory({ ...f, companions: [...f.companions] }), { ...f, companions: [...f.companions] })).toEqual({ ok: true });
  });
});
