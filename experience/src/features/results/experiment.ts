import type { ExperimentReport, PairedSummary, Scenario } from '../../../contract/behavior-v1';
import type { Profile } from '../../runtime/config';

/** Evidence strength label. One complete pair is an illustration; a few are exploratory. */
export function evidenceLabels(r: ExperimentReport, profile: Profile): string[] {
  const out: string[] = [];
  if (profile === 'fixture') out.push('Fixture');
  if (r.spec.config.mode === 'mock') out.push('Mock');
  out.push(r.completePairs <= 1 ? 'Illustrative' : 'Exploratory');
  if (r.status !== 'complete') out.push(r.status === 'running' ? 'Running' : 'Incomplete');
  return out;
}

/** An interval is shown only when supplied with its method and level. */
export function intervalText(s: PairedSummary): string | null {
  if (!s.interval) return null;
  return `${s.interval.level * 100}% ${s.interval.kind.replace(/_/g, ' ')} interval`;
}

/** Describes what differs between the baseline and variant scenarios. */
export function changedLever(baseline: Scenario, variant: Scenario): { lever: string; label: string; bundled: boolean } {
  const key = (s: Scenario) => s.events.map((e) => JSON.stringify({ atMs: e.atMs, change: e.change }));
  const a = new Set(key(baseline));
  const diff = variant.events.filter((e) => !a.has(JSON.stringify({ atMs: e.atMs, change: e.change })));
  const removed = baseline.events.filter((e) => !new Set(key(variant)).has(JSON.stringify({ atMs: e.atMs, change: e.change })));
  const kinds = [...new Set([...diff, ...removed].map((e) => e.change.kind))];
  if (kinds.length === 0) return { lever: 'none', label: 'No difference (A/A check)', bundled: false };
  if (kinds.length === 1 && diff.length === 1 && removed.length === 0) {
    const c = diff[0]!.change;
    if (c.kind === 'pass_price') return { lever: 'pass_price', label: `Harbor Pass price -> ${c.unitPriceCents} cents per guest`, bundled: false };
    return { lever: c.kind, label: `${c.kind.replace('_', ' ')} change`, bundled: false };
  }
  return { lever: 'bundled', label: `Bundled change (${kinds.join(', ')}) — effects cannot be attributed to one lever`, bundled: true };
}
