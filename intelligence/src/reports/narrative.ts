import type { Fact, FactBundle, MetricId, Narrative } from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { hashCanonical, isHash } from '../core/canonical.ts';
import { METRIC_IDS, isId, isSimMs } from '../core/validate.ts';

export const REPORT_TEMPLATE_VERSION = 'report-template-v1';

const MODELED_METRICS: ReadonlySet<MetricId> = new Set(['satisfaction_0_100']);

export const REPORT_LIMITATIONS = [
  'Synthetic guests in a modeled park; results describe this simulation, not measured real visitors.',
  'Satisfaction is a synthetic rubric rating from a language model, reported separately from the modeled-experience ledger.',
  'Paired whole-park differences only; guests and ride episodes are not independent replicates.',
  'Simulation variability only; calibration, structural and model-policy uncertainty are not measured.',
];

/** Structural validation of a fact bundle. Empty means valid. */
export function validateFactBundle(b: FactBundle): string[] {
  const errors: string[] = [];
  if (b.contractVersion !== CONTRACT_VERSION) errors.push('contract version mismatch');
  if (!isId(b.id)) errors.push('invalid bundle id');
  if (!isHash(b.sourceHash)) errors.push('sourceHash is not a sha256 hex hash');
  if (!isSimMs(b.asOfMs)) errors.push('invalid asOfMs');
  const seen = new Set<string>();
  for (const f of b.facts) {
    if (!isId(f.id)) errors.push(`invalid fact id ${String(f.id)}`);
    if (seen.has(f.id)) errors.push(`duplicate fact id ${f.id}`);
    seen.add(f.id);
    if (typeof f.value === 'number' && !Number.isFinite(f.value)) errors.push(`fact ${f.id} has a non-finite value`);
    if (typeof f.value !== 'number' && typeof f.value !== 'string') errors.push(`fact ${f.id} has a non-scalar value`);
    if (!f.unit || typeof f.unit !== 'string') errors.push(`fact ${f.id} lacks a unit`);
    if (typeof f.denominator !== 'string') errors.push(`fact ${f.id} lacks a denominator description`);
    if (f.metricId !== null && !(METRIC_IDS as readonly string[]).includes(f.metricId)) errors.push(`fact ${f.id} has unknown metric ${f.metricId}`);
  }
  return errors;
}

export function factBundleHash(b: FactBundle): string { return hashCanonical(b); }

const isModeled = (f: Fact) => (f.metricId !== null && MODELED_METRICS.has(f.metricId)) || /(^|[._-])(experience|satisfaction|rating)/i.test(f.id);

const factList = (facts: Fact[]): Narrative['sections'][number]['segments'] => {
  const segs: Narrative['sections'][number]['segments'] = [];
  facts.forEach((f, i) => {
    if (i > 0) segs.push({ kind: 'text', text: '; ' });
    segs.push({ kind: 'fact', factId: f.id });
  });
  if (facts.length) segs.push({ kind: 'text', text: '.' });
  return segs;
};

/** Deterministic report narrative. All numbers enter through fact references; text segments carry none. */
export function templateReport(b: FactBundle): Narrative {
  const errs = validateFactBundle(b);
  if (errs.length) throw new Error(`invalid fact bundle: ${errs.join('; ')}`);
  const observed = b.facts.filter((f) => !isModeled(f));
  const modeled = b.facts.filter(isModeled);
  const sections: Narrative['sections'] = [];
  sections.push({
    heading: 'Observed in simulation',
    segments: observed.length
      ? [{ kind: 'text', text: 'Outcomes counted by the Engine: ' }, ...factList(observed)]
      : [{ kind: 'text', text: 'No observed-outcome facts are available yet.' }],
  });
  sections.push({
    heading: 'Modeled experience and ratings',
    segments: modeled.length
      ? [{ kind: 'text', text: 'Modeled-experience and synthetic rating facts, reported separately from observed outcomes: ' }, ...factList(modeled)]
      : [{ kind: 'text', text: 'No modeled-experience or rating facts are available.' }],
  });
  const quality = b.quality;
  const limits = [...REPORT_LIMITATIONS, ...new Set(b.facts.flatMap((f) => f.limitations))];
  if (quality && !quality.comparisonEligible) limits.push(`Not comparison-eligible: ${quality.reasons.join('; ') || 'reason not given'}.`);
  sections.push({ heading: 'Limitations', segments: [{ kind: 'text', text: limits.filter((l) => !/\d/.test(l)).join(' ') }] });
  const nextText = quality && !quality.comparisonEligible
    ? 'Next experiment: resolve the eligibility issues above, then rerun the same paired comparison with unchanged seeds and population settings.'
    : 'Next experiment: repeat the paired comparison with additional predeclared seeds, keeping the population generator fixed and changing only one lever at a time.';
  sections.push({ heading: 'Proposed next experiment', segments: [{ kind: 'text', text: nextText }] });
  return {
    id: `report-${hashCanonical({ v: REPORT_TEMPLATE_VERSION, bundle: factBundleHash(b) }).slice(0, 32)}`,
    evidenceHash: factBundleHash(b), origin: 'template', label: 'modeled-results report', sections,
    limitations: limits,
  };
}

const PRESCRIPTIVE = /\b(should|must|recommend(ed|s)?|we advise|roll(ing)? out|adopt|switch to|definitely|proves?|guarantee[sd]?|best option|the winner|clearly better)\b/i;
const COMMANDY = /\b(ignore (all|previous)|system prompt|api key|jv_[a-z0-9]|schedule (an? )?event|issue (a )?command)\b/i;

/** Validates a narrative against its bundle: known fact references, matching hash, no numeric literals or prescriptions in prose. */
export function validateReportNarrative(n: Narrative, b: FactBundle): string[] {
  const reasons: string[] = [];
  if (n.label !== 'modeled-results report') reasons.push('report must be labeled "modeled-results report"');
  if (n.evidenceHash !== factBundleHash(b)) reasons.push('narrative evidence hash does not match the fact bundle');
  const ids = new Set(b.facts.map((f) => f.id));
  const headings = n.sections.map((s) => s.heading.toLowerCase());
  for (const need of ['observed', 'limitation', 'next']) if (!headings.some((h) => h.includes(need))) reasons.push(`missing section about ${need}`);
  for (const s of n.sections) {
    for (const seg of s.segments) {
      if (seg.kind === 'fact') { if (!ids.has(seg.factId)) reasons.push(`unknown fact reference ${seg.factId}`); continue; }
      if (/\d/.test(seg.text)) reasons.push(`ungrounded numeric literal in prose: "${seg.text.slice(0, 60)}"`);
      if (PRESCRIPTIVE.test(seg.text)) reasons.push(`prescriptive or overclaiming language: "${seg.text.slice(0, 60)}"`);
      if (COMMANDY.test(seg.text)) reasons.push('prose contains command or secret-like text');
    }
  }
  return reasons;
}

export interface ReportProseProvider {
  readonly model: string;
  readonly promptVersion: string;
  compose(bundle: FactBundle, template: Narrative, signal?: AbortSignal): Promise<Narrative>;
}

export async function composeReport(
  b: FactBundle, provider: ReportProseProvider | null = null, signal?: AbortSignal, buildTemplate: (b: FactBundle) => Narrative = templateReport,
): Promise<{ narrative: Narrative; fallbackReason: string | null }> {
  const template = buildTemplate(b);
  if (!provider) return { narrative: template, fallbackReason: null };
  let candidate: Narrative;
  try { candidate = await provider.compose(b, template, signal); } catch (e) {
    return { narrative: template, fallbackReason: `provider error: ${(e as Error).message}` };
  }
  const reasons = validateReportNarrative({ ...candidate, evidenceHash: candidate.evidenceHash }, b);
  if (candidate.origin !== 'llm') reasons.push('provider narrative must be labeled origin llm');
  if (reasons.length) return { narrative: template, fallbackReason: reasons.join('; ') };
  return { narrative: { ...candidate, limitations: [...new Set([...template.limitations, ...candidate.limitations])] }, fallbackReason: null };
}
