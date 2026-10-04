import type { Fact, FactBundle, Narrative } from '../../../contract/behavior-v1';
import { canonicalHash } from '../../domain/canonical';
import { formatCents, formatCount, formatMinutes, formatNumber, formatPercent } from '../../ui/format';

export function formatFactValue(f: Fact): string {
  if (typeof f.value === 'string') return f.value;
  switch (f.unit) {
    case 'cents': return formatCents(f.value, { signed: f.id.includes(':delta:') });
    case 'minutes': return formatMinutes(f.value);
    case 'score': return `${formatNumber(f.value, 1)} / 100`;
    case 'ratio': return f.metricId === 'rides_per_guest' ? formatNumber(f.value, 2) : formatPercent(f.value);
    case 'guests': case 'passes': return `${formatCount(f.value)} ${f.unit}`;
    default: return `${formatNumber(f.value, 2)} ${f.unit}`;
  }
}

export type ResolvedSegment = { kind: 'text'; text: string } | { kind: 'fact'; fact: Fact; text: string } | { kind: 'error'; factId: string };
export type ResolvedNarrative = { sections: { heading: string; segments: ResolvedSegment[] }[]; errors: string[]; hashMatches: boolean | null };

/**
 * Resolves fact references against the authorized FactBundle. Unknown IDs or a bundle
 * whose hash does not match the narrative's evidence produce visible data errors, never a
 * best-guess sentence.
 */
export async function resolveNarrative(n: Narrative, bundle: FactBundle | null): Promise<ResolvedNarrative> {
  const errors: string[] = [];
  let hashMatches: boolean | null = null;
  if (bundle) {
    const canonical = await canonicalHash(bundle);
    hashMatches = canonical === n.evidenceHash || bundle.sourceHash === n.evidenceHash;
    if (!hashMatches) errors.push(`Narrative evidence hash ${n.evidenceHash.slice(0, 12)}… does not match fact bundle ${bundle.id}. Numbers are not shown. If the run is still in progress its evidence has moved on since the report was composed; regenerate after it completes.`);
  }
  const byId = new Map((bundle?.facts ?? []).map((f) => [f.id, f]));
  const sections = n.sections.map((s) => ({
    heading: s.heading,
    segments: s.segments.map((seg): ResolvedSegment => {
      if (seg.kind === 'text') return seg;
      const fact = hashMatches ? byId.get(seg.factId) : undefined;
      if (!fact) {
        errors.push(bundle ? (hashMatches ? `Unknown fact reference ${seg.factId}.` : `Fact ${seg.factId} withheld: evidence mismatch.`) : `Fact ${seg.factId} cannot be resolved: no fact bundle for this narrative.`);
        return { kind: 'error', factId: seg.factId };
      }
      return { kind: 'fact', fact, text: formatFactValue(fact) };
    }),
  }));
  return { sections, errors: [...new Set(errors)], hashMatches };
}
