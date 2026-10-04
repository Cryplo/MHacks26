import type {
  ArtifactRef, Capabilities, CrowdSpec, ExperimentSpec, Id, ParkBundle, RunConfig, Scenario, ScenarioEvent, SimMs,
} from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { canonicalJson } from '../core/canonical.ts';
import { SIM_STEP_MS, isId, isSimMs, validateScenario } from '../core/validate.ts';
import { validateShares } from '../population/allocation.ts';

export type ScenarioDiff = {
  added: ScenarioEvent[]; removed: ScenarioEvent[];
  changed: { before: ScenarioEvent; after: ScenarioEvent }[];
  kinds: string[];
};

/** Exact event-level difference between baseline and variant (matched by event id). */
export function scenarioDiff(baseline: Scenario, variant: Scenario): ScenarioDiff {
  const a = new Map(baseline.events.map((e) => [e.id, e]));
  const b = new Map(variant.events.map((e) => [e.id, e]));
  const added = variant.events.filter((e) => !a.has(e.id));
  const removed = baseline.events.filter((e) => !b.has(e.id));
  const changed = baseline.events.filter((e) => b.has(e.id) && canonicalJson(e) !== canonicalJson(b.get(e.id)!)).map((e) => ({ before: e, after: b.get(e.id)! }));
  const kinds = [...new Set([...added, ...removed, ...changed.flatMap((c) => [c.before, c.after])].map((e) => e.change.kind))].sort();
  return { added, removed, changed, kinds };
}

export type Preflight = { ok: boolean; errors: string[]; warnings: string[]; diff: ScenarioDiff; label: 'mock' | 'real-provider' };

/**
 * Validates a predeclared paired experiment before any run is created: versions/mode, unique
 * seeds, identical baseline and variant except the declared lever, shared horizon/rating schedule
 * (one config for both arms), supported events, analysis and budget.
 */
export function preflightExperiment(spec: ExperimentSpec, caps: Capabilities, park: ParkBundle | null): Preflight {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (spec.contractVersion !== CONTRACT_VERSION || caps.contractVersion !== CONTRACT_VERSION) errors.push('contract version mismatch');
  if (!isId(spec.experimentId)) errors.push('invalid experimentId');
  if (!Array.isArray(spec.seeds) || spec.seeds.length === 0) errors.push('at least one seed is required');
  else {
    if (new Set(spec.seeds).size !== spec.seeds.length) errors.push('seeds must be unique');
    for (const s of spec.seeds) if (!isId(s)) errors.push(`invalid seed ${String(s)}`);
    if (spec.seeds.length > 20) errors.push('more than 20 pairs exceeds the operational limit');
    if (spec.seeds.length === 1) warnings.push('one pair is an illustration, not a comparison');
    else if (spec.seeds.length < 3) warnings.push('fewer than three pairs: exploratory illustration only');
  }
  const cfg: RunConfig = spec.config;
  if (cfg.mode !== 'mock' && cfg.mode !== 'experiment') errors.push(`config.mode must be "mock" or "experiment", not ${cfg.mode}`);
  if (cfg.mode === 'experiment' && cfg.fallback !== 'forbidden') errors.push('real-provider experiments must forbid fallback decisions');
  if (cfg.mode === 'mock') warnings.push('Mock experiment: infrastructure demonstration only, not a behavioral result');
  if (cfg.logicalStepMs !== SIM_STEP_MS || cfg.movementStepMs !== 250 || cfg.temperature !== 1) errors.push('unsupported step/temperature configuration');
  if (!isSimMs(cfg.horizonMs) || cfg.horizonMs <= 0 || cfg.horizonMs % SIM_STEP_MS !== 0) errors.push('horizonMs must be a positive multiple of 5000');
  if (cfg.ratingEveryMs !== null && (!isSimMs(cfg.ratingEveryMs) || cfg.ratingEveryMs % SIM_STEP_MS !== 0 || cfg.ratingEveryMs <= 0)) errors.push('ratingEveryMs must be null or a positive multiple of 5000');
  if (park && cfg.horizonMs > park.closeAfterMs) errors.push('horizon extends past park close');
  if (spec.park.kind !== 'park') errors.push('spec.park is not a park artifact');
  if (spec.analysis !== 'paired_descriptive' && spec.analysis !== 'paired_t') errors.push('analysis must be predeclared as paired_descriptive or paired_t');
  if (spec.alpha !== 0.05) errors.push('alpha must be 0.05');
  if (!Number.isSafeInteger(spec.operationBudgetMs) || spec.operationBudgetMs <= 0) errors.push('operationBudgetMs must be a positive integer');
  if (spec.maxConcurrentArms !== 1 && spec.maxConcurrentArms !== 2) errors.push('maxConcurrentArms must be 1 or 2');
  const shares = validateShares(spec.crowd.shares);
  if (!shares.ok) errors.push(`crowd shares invalid: ${shares.errors.map((e) => e.message).join('; ')}`);
  if (!Number.isSafeInteger(spec.crowd.guestCount) || spec.crowd.guestCount < 1 || spec.crowd.guestCount > caps.maxGuests) errors.push(`guestCount must be 1..${caps.maxGuests}`);

  for (const [name, s] of [['baseline', spec.baseline], ['variant', spec.variant]] as const) {
    const v = validateScenario(s, name);
    if (v.length) errors.push(`${name} scenario invalid: ${v.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    for (const e of s.events) {
      if (!caps.eventKinds.includes(e.change.kind)) errors.push(`${name} event ${e.id} kind ${e.change.kind} not supported by Engine capabilities`);
      if (e.atMs > cfg.horizonMs) errors.push(`${name} event ${e.id} is after the horizon`);
      if (e.change.kind === 'app_message' && e.change.discount && !caps.features.discountMessages) errors.push(`${name} event ${e.id} uses a discount but discount messages are not supported`);
    }
  }
  const diff = scenarioDiff(spec.baseline, spec.variant);
  const nDiff = diff.added.length + diff.removed.length + diff.changed.length;
  if (nDiff === 0) {
    if (spec.changedLever !== 'none') errors.push('baseline and variant are identical; declare changedLever "none" for an A/A experiment');
    else warnings.push('A/A experiment: identical arms');
  } else if (spec.changedLever === 'bundled') {
    warnings.push(`bundled intervention: ${diff.kinds.join(', ')} change together and cannot be separated`);
  } else if (diff.kinds.length !== 1 || diff.kinds[0] !== spec.changedLever) {
    errors.push(`declared lever ${spec.changedLever} but the scenario diff changes ${diff.kinds.join(', ') || 'nothing'}; label it "bundled" or remove the extra changes`);
  }
  if (spec.start.kind === 'warmup') {
    const w = spec.start;
    if (!isSimMs(w.toMs) || w.toMs <= 0 || w.toMs % SIM_STEP_MS !== 0 || w.toMs >= cfg.horizonMs) errors.push('warmup toMs must be a positive multiple of 5000 before the horizon');
    if (validateScenario(w.warmupScenario, 'warmupScenario').length) errors.push('warmup scenario invalid');
    for (const e of [...diff.added, ...diff.changed.map((c) => c.after), ...diff.removed]) {
      if (e.atMs < w.toMs) errors.push(`intervention event ${e.id} at ${e.atMs} precedes the common warmup point ${w.toMs}`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, diff, label: cfg.mode === 'mock' ? 'mock' : 'real-provider' };
}

/**
 * The first A/B: only the pass unit price changes (default 1,500 -> 2,500 cents) at `atMs`. Both arms
 * carry the event so the diff is exactly one pass_price change; everything else is identical.
 */
export function passPriceExperiment(input: {
  experimentId: Id; park: ArtifactRef; crowd: Omit<CrowdSpec, 'seed'>; seeds: string[]; config: RunConfig; atMs: SimMs;
  baselineCents?: number; variantCents?: number; analysis?: ExperimentSpec['analysis']; operationBudgetMs?: number;
  maxConcurrentArms?: 1 | 2; start?: ExperimentSpec['start'];
}): ExperimentSpec {
  const from = input.baselineCents ?? 1500;
  const to = input.variantCents ?? 2500;
  const ev = (cents: number): ScenarioEvent => ({ id: 'pass-price', atMs: input.atMs, order: 0, change: { kind: 'pass_price', unitPriceCents: cents } });
  return {
    contractVersion: CONTRACT_VERSION, experimentId: input.experimentId, park: input.park, crowd: input.crowd, seeds: input.seeds,
    baseline: { id: 'baseline', revision: '1', label: `Pass ${from} cents`, events: [ev(from)] },
    variant: { id: 'variant', revision: '1', label: `Pass ${to} cents`, events: [ev(to)] },
    config: input.config, interventionLabel: `Pass price ${from} -> ${to} cents per guest`, changedLever: 'pass_price',
    analysis: input.analysis ?? 'paired_descriptive', alpha: 0.05, operationBudgetMs: input.operationBudgetMs ?? 3_600_000,
    maxConcurrentArms: input.maxConcurrentArms ?? 1, start: input.start ?? { kind: 'opening' },
  };
}
