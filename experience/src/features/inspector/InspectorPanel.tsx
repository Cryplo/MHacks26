import { useEffect, useRef, useState } from 'react';
import type { AgentDetail, AppliedDecision, Id, ParkBundle } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { classifyError } from '../../runtime/errors';
import { Alert, ErrorBox, Explain, KV, Spinner } from '../../ui/components';
import { formatAge, formatCents, formatProbability, formatSimClock } from '../../ui/format';
import { EventLine } from '../live/EventFeed';
import { governance, knowledgeVsTruth, narrateFromState, optionRows, sourceLabel } from './evidence';
import { useNarration } from './useNarration';
import { NarrativeView } from '../results/NarrativeView';

type Props = { runId: Id; agentId: Id; store: LiveStore; park: ParkBundle; canOperate: boolean; onSelectAgent: (id: Id) => void; isFixture: boolean };

export function InspectorPanel(props: Props) {
  const rt = useRuntime();
  const latestEvidence = useLiveSelector(props.store, (s) => s.agents.get(props.agentId)?.latestEvidenceId ?? null);
  // While pinned (e.g. after requesting narration) the card stays on one evidence record.
  const [follow, setFollow] = useState(true);
  const [pinnedTo, setPinnedTo] = useState<string | null>(null);
  const refreshKey = follow ? latestEvidence : pinnedTo;
  const [state, setState] = useState<{ detail: AgentDetail | null; error: ReturnType<typeof classifyError> | null; loading: boolean }>({ detail: null, error: null, loading: true });
  const req = useRef(0);
  useEffect(() => {
    const my = ++req.current;
    setState((s) => ({ detail: s.detail?.agent.agentId === props.agentId ? s.detail : null, error: null, loading: true }));
    rt.client.query('getAgent', { runId: props.runId, agentId: props.agentId }).then(
      (detail) => { if (my === req.current) setState({ detail, error: null, loading: false }); },
      (e: unknown) => { if (my === req.current) setState({ detail: null, error: classifyError(e), loading: false }); },
    );
  }, [rt.client, props.runId, props.agentId, refreshKey]);

  const d = state.detail?.agent.agentId === props.agentId ? state.detail : null;
  if (!d) {
    if (state.error) return <ErrorBox error={state.error.error} transport={state.error.transport} />;
    return <Spinner label={`Loading guest ${props.agentId}…`} />;
  }
  const p = d.persona;
  const g = d.group;
  const openLocal = props.park.openLocal;
  const placeName = (id: Id | null) => (id ? props.park.places.find((x) => x.id === id)?.name ?? id : '—');
  return (
    <div className="stack" data-testid="inspector" data-agent-id={d.agent.agentId}>
      <div>
        <h2 style={{ marginBottom: 2 }}>Guest <span className="mono">{d.agent.agentId}</span></h2>
        <p className="small muted">{p.role}, {p.ageYears} y · {p.archetype.replace('_', ' ')} · now {d.agent.state.replace('_', ' ')}{d.agent.targetPlaceId ? ` → ${placeName(d.agent.targetPlaceId)}` : ''}</p>
      </div>
      <section aria-label="Persona">
        <h4>Persona (frozen at population sampling)</h4>
        <p data-testid="backstory" style={{ whiteSpace: 'pre-wrap' }}>{p.backstory}</p>
        <KV items={[
          ['Occasion', p.occasion], ['Must-do', p.mustDoPlaceIds.map(placeName).join(', ') || '—'],
          ['Height / walk', `${p.heightCm} cm · ${p.walkSpeedMps.toFixed(2)} m/s`], ['Thrill preference', p.thrillPreference.toFixed(2)],
          ['App', p.hasApp ? 'has the park app' : 'no app'], ['Mobility', [p.stroller ? 'stroller' : null, p.mobilityRestricted ? 'mobility restricted' : null].filter(Boolean).join(', ') || 'no restrictions'],
        ]} />
      </section>
      <section aria-label="Group">
        <h4>Group {g.groupId}</h4>
        <ul className="card-list">
          {g.memberIds.map((m) => (
            <li key={m} className="row" style={{ gap: 6 }}>
              <button type="button" className="btn small mono" onClick={() => props.onSelectAgent(m)} aria-current={m === d.agent.agentId ? 'true' : undefined}>{m}</button>
              {m === g.leaderId && <span className="badge neutral">leader</span>}
              {g.guardianIds.includes(m) && <span className="badge neutral">guardian</span>}
            </li>
          ))}
        </ul>
        <p className="small">Shared wallet <span className="mono">{g.walletId}</span>, owned by the group (starting {formatCents(g.startingBalanceCents)}).{d.evidence ? ` Balance seen at the last decision: ${formatCents(d.evidence.request.observation.wallet.balanceCents)}.` : ''} Planned departure {formatSimClock(g.plannedDepartureMs, openLocal)}.</p>
      </section>
      <section aria-label="Individual state">
        <h4>Individual needs (this guest)</h4>
        <div className="grid-2" style={{ gridTemplateColumns: 'repeat(2, minmax(0,1fr))' }}>
          {(['hunger', 'fatigue', 'patience', 'fun'] as const).map((k) => (
            <div key={k}><div className="small">{k} <b>{d.agent.needs[k]}</b>/100</div><div className="bar"><span style={{ width: `${d.agent.needs[k]}%` }} /></div></div>
          ))}
        </div>
        <p className="small" style={{ marginTop: 6 }}>Modeled experience <b>{d.agent.experienceValue}</b> points <Explain label="modeled experience">Deterministic model ledger, not a measurement.</Explain> · Satisfaction {d.agent.rating ? <>rating <b>{d.agent.rating.value}</b>/100 from {d.agent.rating.source}, measured at {formatSimClock(d.agent.rating.atMs, openLocal)}</> : 'not yet rated'}</p>
      </section>
      <section aria-label="Guest knowledge">
        <h4>What this guest's group has observed</h4>
        {d.observedFacts.length === 0 && <p className="small muted">No observations recorded yet.</p>}
        <ul className="card-list small">
          {[...d.observedFacts].reverse().slice(0, 12).map((f) => (
            <li key={f.id} className="panel tight">
              <div className="spread"><span><b>{f.kind}</b> via {f.source} · {placeName(f.placeId)}</span><span className="muted">{formatSimClock(f.observedAtMs, openLocal)} · <span className="mono">{f.contentVersion}</span></span></div>
              <q style={{ whiteSpace: 'pre-wrap' }}>{f.text}</q>
              {(f.waitLowerMs !== null || f.waitUpperMs !== null) && <div className="muted">Wait promise frozen at observation: {f.waitLowerMs !== null ? Math.round(f.waitLowerMs / 60_000) : '?'}–{f.waitUpperMs !== null ? Math.round(f.waitUpperMs / 60_000) : '?'} min</div>}
            </li>
          ))}
        </ul>
      </section>
      {props.canOperate && <OperatorTruth detail={d} store={props.store} placeName={placeName} />}
      {d.evidence ? <EvidenceView e={d.evidence} detail={d} openLocal={openLocal} isFixture={props.isFixture} /> : <p className="muted">No decision evidence yet.</p>}
      {!follow && (
        <Alert tone="info">
          <p>Pinned to evidence <span className="mono">{pinnedTo}</span>. {latestEvidence !== pinnedTo ? 'This guest has made newer decisions since.' : ''}</p>
          <button type="button" className="btn small" onClick={() => { setFollow(true); setPinnedTo(null); }}>Follow latest decision</button>
        </Alert>
      )}
      {d.evidence && <Narration runId={props.runId} agentId={d.agent.agentId} e={d.evidence} onRequest={() => { setFollow(false); setPinnedTo(d.evidence!.evidenceId); }} />}
      <section aria-label="Chronology">
        <h4>What happened (recorded events, chronological)</h4>
        <ul className="feed-list" style={{ maxHeight: 220 }}>
          {d.recentEvents.map((e) => <li key={e.sequence} style={{ padding: '4px 0' }}><EventLine e={e} park={props.park} /></li>)}
        </ul>
        <p className="small muted">A chronology of committed events, not recovered private reasoning.</p>
      </section>
    </div>
  );
}

function OperatorTruth(props: { detail: AgentDetail; store: LiveStore; placeName: (id: Id | null) => string }) {
  const [open, setOpen] = useState(false);
  const places = useLiveSelector(props.store, (s) => s.places);
  const rows = knowledgeVsTruth(props.detail.observedFacts, places);
  return (
    <section aria-label="World versus guest knowledge" className="panel tight" style={{ borderColor: '#b9d3f2' }}>
      <div className="spread">
        <h4 style={{ margin: 0 }}>World vs guest knowledge</h4>
        <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="truth-toggle">{open ? 'Hide' : 'Show'} operator truth</button>
      </div>
      <p className="small muted">Operator-only view. Current world state is shown to you; it is never part of the guest's model input.</p>
      {open && (
        <table className="small">
          <thead><tr><th>Place</th><th>Guest last observed</th><th>World now (operator)</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const last = r.guestFacts[r.guestFacts.length - 1]!;
              return (
                <tr key={r.placeId}>
                  <td>{props.placeName(r.placeId)}</td>
                  <td>"{last.text}" <span className="muted">({last.contentVersion})</span></td>
                  <td>{r.truth ? <>{r.truth.closed ? <b>CLOSED</b> : 'open'}{r.truth.boardText ? ` · board "${r.truth.boardText}"` : ''}{r.truth.predictedWaitMs !== null ? ` · backend estimate ${Math.round(r.truth.predictedWaitMs / 60_000)} min` : ''}</> : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function EvidenceView(props: { e: AppliedDecision; detail: AgentDetail; openLocal: string; isFixture: boolean }) {
  const { e } = props;
  const rows = optionRows(e);
  const src = sourceLabel(e.response.source, e.response.originalSource, e.response.modelReturned);
  const gov = governance(props.detail);
  const anyNorm = rows.some((r) => r.normalizationDiffers);
  return (
    <section aria-label="Last decision evidence" data-testid="evidence">
      <h4>Last decision · evidence <span className="mono">{e.evidenceId}</span></h4>
      <Alert tone={src.tone === 'ok' ? 'ok' : src.tone === 'warn' ? 'warn' : 'info'}>
        <p data-testid="evidence-source"><b>Source:</b> {src.text}{props.isFixture ? ' (fixture script)' : ''}. Model requested {e.response.modelRequested}.</p>
      </Alert>
      <KV items={[
        ['Moment', `${e.request.moment.replace(/_/g, ' ')} (decision #${e.request.decisionSeq}, moment seq ${e.request.momentSeq}, request rev ${e.request.requestRevision})`],
        ['Triggered / applied', `${formatSimClock(e.request.createdAtMs, props.openLocal, true)} / ${formatSimClock(e.request.applyAtMs, props.openLocal, true)}`],
        ['Governs', gov.text],
        ['Observation hash', <span className="hash" key="o">{e.request.observationHash}</span>],
        ['Options hash', <span className="hash" key="h">{e.request.optionsHash}</span>],
        ['Policy', e.request.policyVersion],
      ]} />
      <h4 style={{ marginTop: 8 }}>Observed text given to the model (immutable)</h4>
      <ul className="small">
        {e.request.observation.facts.map((f) => <li key={f.id}><q style={{ whiteSpace: 'pre-wrap' }}>{f.text}</q> <span className="muted mono">{f.contentVersion} @ {formatSimClock(f.observedAtMs, props.openLocal)}</span></li>)}
        {e.request.observation.facts.length === 0 && <li className="muted">No notice/board facts in this observation.</li>}
      </ul>
      <h4>Options and probabilities (in prompt order)</h4>
      <div className="stack" style={{ gap: 6 }} data-testid="options">
        {rows.map((r) => (
          <div key={r.id} className={`opt-row ${r.sampled ? 'sampled' : ''}`} data-option-id={r.id} data-sampled={r.sampled || undefined}>
            <div>
              <div className="row" style={{ gap: 6 }}>
                <b>{r.label}</b>
                {r.highest && <span className="tag">highest probability</span>}
                {r.sampled && <span className="tag sampled">sampled</span>}
              </div>
              <div className="small muted">{r.description}</div>
              <div className="bar applied" aria-hidden="true"><span style={{ width: `${(r.applied ?? 0) * 100}%` }} /></div>
            </div>
            <div className="small" style={{ textAlign: 'right' }}>
              <div><b>{r.applied === null ? '—' : formatProbability(r.applied)}</b> applied</div>
              {r.normalizationDiffers && <div className="muted">raw {r.raw === null ? '—' : r.raw.toFixed(7)}</div>}
              <div className="muted mono">[{r.cdfFrom.toFixed(4)}, {r.cdfTo.toFixed(4)})</div>
            </div>
          </div>
        ))}
      </div>
      <p className="small" style={{ marginTop: 6 }}>
        Draw <b className="mono">u = {e.draw.toFixed(6)}</b> fell in the sampled option's interval (options in ascending ID order, inverse CDF). The highest-probability option is not necessarily the one sampled.
        {anyNorm && ' Raw probabilities were within the accepted 1e-6 round-off and normalized; both vectors are shown.'}
      </p>
      <p className="small" data-testid="outcome">Outcome: <b>{e.outcome === 'committed' ? 'committed' : 'failed precondition'}</b>{e.failureReason ? ` — ${e.failureReason}` : ''} at {formatSimClock(e.committedAtMs, props.openLocal, true)}. Resulting events: {e.causedEventIds.length ? e.causedEventIds.map((x) => <span key={x} className="mono"> {x}</span>) : 'none'}.</p>
      {e.request.candidateAudit.excluded.length > 0 && (
        <details className="explain"><summary>Excluded candidates ({e.request.candidateAudit.excluded.length})</summary>
          <ul className="small">{e.request.candidateAudit.excluded.map((x) => <li key={x.id}>{x.id}: {x.reason}</li>)}</ul>
        </details>
      )}
      {e.response.usage.httpMs > 0 && <p className="small muted">Provider latency {formatAge(e.response.usage.httpMs)} after {e.response.usage.attemptCount} attempt(s).</p>}
    </section>
  );
}

function Narration(props: { runId: Id; agentId: Id; e: AppliedDecision; onRequest: () => void }) {
  const rt = useRuntime();
  const { state, request } = useNarration(rt.client, rt.runner, props.runId, props.e.evidenceId, props.agentId);
  return (
    <section aria-label="Narration" data-testid="narration" data-narration-for={`${props.e.evidenceId}|${props.agentId}`}>
      <div className="spread">
        <h4 style={{ margin: 0 }}>Narration</h4>
        <button type="button" className="btn small" onClick={() => { props.onRequest(); void request(); }} disabled={state.kind === 'loading'} data-testid="narrate">Narrate this decision</button>
      </div>
      <p className="small muted">Requested only for this evidence record. Narration describes recorded state; it is not recovered private reasoning.</p>
      {state.kind === 'loading' && <Spinner label="Requesting narration…" />}
      {state.kind === 'ready' && <NarrativeView narrative={state.narrative} facts={null} expectedEvidenceHash={null} />}
      {state.kind === 'failed' && (
        <>
          <ErrorBox error={state.error} />
          <div className="panel tight" data-testid="local-narration">
            <span className="badge neutral">narrated from state · local template, no model</span>
            <p className="small" style={{ marginTop: 4 }}>{narrateFromState(props.e, props.agentId)}</p>
          </div>
        </>
      )}
    </section>
  );
}
