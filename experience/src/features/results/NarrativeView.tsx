import { useEffect, useState } from 'react';
import type { FactBundle, Narrative } from '../../../contract/behavior-v1';
import { Alert } from '../../ui/components';
import { resolveNarrative, type ResolvedNarrative } from './facts';

/** Renders untrusted narrative text as plain text nodes only (never HTML). */
export function NarrativeView(props: { narrative: Narrative; facts: FactBundle | null; expectedEvidenceHash: string | null }) {
  const [resolved, setResolved] = useState<ResolvedNarrative | null>(null);
  useEffect(() => {
    let live = true;
    void resolveNarrative(props.narrative, props.facts).then((r) => { if (live) setResolved(r); });
    return () => { live = false; };
  }, [props.narrative, props.facts]);
  const n = props.narrative;
  return (
    <div className="stack" style={{ gap: 6 }} data-testid="narrative">
      <div className="row" style={{ gap: 6 }}>
        <span className="badge neutral">{n.label}</span>
        <span className="badge neutral">{n.origin === 'llm' ? 'language-model prose, numbers resolved by code' : 'deterministic template'}</span>
        <span className="hash" title="evidence hash">evidence {n.evidenceHash.slice(0, 16)}…</span>
      </div>
      {resolved?.errors.length ? <Alert tone="bad" title="Report data error">{resolved.errors.map((e) => <p key={e}>{e}</p>)}</Alert> : null}
      {(resolved?.sections ?? n.sections.map((s) => ({ heading: s.heading, segments: [] }))).map((s, i) => (
        <div key={i}>
          <h4>{s.heading}</h4>
          <p>
            {s.segments.map((seg, j) => seg.kind === 'text' ? <span key={j}>{seg.text}</span>
              : seg.kind === 'fact' ? <b key={j} title={`${seg.fact.label}; ${seg.fact.denominator}`} data-fact-id={seg.fact.id}>{seg.text}</b>
                : <mark key={j} className="mono">[unresolved fact {seg.factId}]</mark>)}
          </p>
        </div>
      ))}
      {n.limitations.length > 0 && <ul className="small muted">{n.limitations.map((l) => <li key={l}>{l}</li>)}</ul>}
    </div>
  );
}
