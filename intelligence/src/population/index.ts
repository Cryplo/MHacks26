import type { CrowdSpec } from '../../contract/behavior-v1.ts';
import type { FieldError } from '../core/errors.ts';
import type { FrozenPopulation } from './manifest.ts';
import { freezeManifest, proseVersionLabel, validatePopulationManifest } from './manifest.ts';
import type { ParkContext } from './park.ts';
import type { ProseOutcome, ProseProvider } from './prose.ts';
import { composeBackstory, proseFacts } from './prose.ts';
import { samplePopulation } from './sampler.ts';

export type GenerateOptions = {
  crowd: CrowdSpec; park: ParkContext; closeAfterMs: number; maxGuests?: number;
  prose?: ProseProvider | null; proseCache?: Map<string, string>; signal?: AbortSignal;
};

export type GenerateResult =
  | ({ ok: true; prose: ProseOutcome[] } & FrozenPopulation)
  | { ok: false; errors: FieldError[] };

/**
 * Structured sampling -> prose (template or validated LLM) -> frozen manifest -> self-validation.
 * Same complete input and versions yields byte-identical output.
 */
export async function generatePopulation(opts: GenerateOptions): Promise<GenerateResult> {
  const sampled = samplePopulation({ crowd: opts.crowd, park: opts.park, closeAfterMs: opts.closeAfterMs, maxGuests: opts.maxGuests });
  if (!sampled.ok) return sampled;
  const s = sampled.value;
  const all = new Map(s.personas.map((p) => [p.agentId, p]));
  const groups = new Map(s.groups.map((g) => [g.groupId, g]));
  const placeNames = opts.park.bundle.places.map((p) => p.name);
  const prose: ProseOutcome[] = [];
  for (const p of s.personas) {
    const facts = proseFacts(p, groups.get(p.groupId)!, all, opts.park.bundle.label, placeNames);
    prose.push(await composeBackstory(facts, opts.prose ?? null, opts.proseCache, opts.signal));
  }
  const version = proseVersionLabel(opts.prose?.model ?? null, opts.prose?.promptVersion ?? null);
  const frozen = freezeManifest(s, prose, version, opts.park);
  const check = validatePopulationManifest(frozen.manifest, opts.park, s.generatorVersion, opts.crowd.guestCount, { closeAfterMs: opts.closeAfterMs });
  if (check.errors.length) return { ok: false, errors: check.errors };
  return { ok: true, prose, ...frozen };
}

export { parkContext } from './park.ts';
export type { DiversitySummary } from './manifest.ts';
