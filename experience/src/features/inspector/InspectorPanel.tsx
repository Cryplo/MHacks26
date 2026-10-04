import { useEffect, useRef, useState } from 'react';
import type { AgentDetail, AgentView, AppliedDecision, DecisionSummary, EventRecord, Id, ParkBundle } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { STATE_STYLE, SHAPE_GLYPH, hex } from '../../renderer/colors';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { classifyError } from '../../runtime/errors';
import { Disclosure, ErrorBox, Explain, Icon, KV, Spinner } from '../../ui/components';
import { formatAge, formatCents, formatDuration, formatProbability, formatSimClock } from '../../ui/format';
import { ARCHETYPE_LABEL } from '../setup/crowd';
import { guestName } from '../../domain/guestNames';
import { describeEvent } from '../live/EventFeed';
import { deriveRationale, governance, knowledgeVsTruth, momentLabel, narrateFromState, optionRows, recordedRationale, sourceLabel } from './evidence';
import { useNarration } from './useNarration';
import { NarrativeView } from '../results/NarrativeView';

type Props = { runId: Id; agentId: Id; store: LiveStore; park: ParkBundle; canOperate: boolean; onSelectAgent: (id: Id) => void; onClose: () => void; isFixture: boolean; asOfMs?: number | null };

const ROLE_LABEL: Record<string, string> = { parent: 'Parent', child: 'Child', teen: 'Teen', adult: 'Adult', senior: 'Senior' };

export function InspectorPanel(props: Props) {
  const rt = useRuntime();
  const live = useLiveSelector(props.store, (s) => s.agents.get(props.agentId) ?? null);
  const simMs = useLiveSelector(props.store, (s) => s.run?.simMs ?? 0);
  const latestEvidence = live?.latestEvidenceId ?? null;
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
    return (
      <div className="side-body">
        {state.error ? <ErrorBox error={state.error.error} transport={state.error.transport} /> : <Spinner label="Loading guest…" />}
      </div>
    );
  }
  // Live state (from the stream) wins over the detail snapshot for "right now" facts.
  const agent: AgentView = live ?? d.agent;
  const p = d.persona;
  const g = d.group;
  const openLocal = props.park.openLocal;
  const placeName = (id: Id | null) => (id ? props.park.places.find((x) => x.id === id)?.name ?? id : '—');
  const st = STATE_STYLE[agent.state];
  const asOf = props.asOfMs ?? null;
  const name = (id: Id) => guestName(id, g.groupId);
  // Looking back in time: only what had happened by then, and the decision in force then.
  const events = asOf === null ? d.recentEvents : d.recentEvents.filter((e) => e.atMs <= asOf);
  const evidenceThen = d.evidence && (asOf === null || d.evidence.request.createdAtMs <= asOf) ? d.evidence : null;
  const pastDecision = asOf !== null && !evidenceThen ? (d.decisions ?? []).find((x) => x.atMs <= asOf) ?? null : null;
  const laterDecisions = asOf === null ? d.decisions : d.decisions?.filter((x) => x.atMs <= asOf);
  return (
    <div className="side-body" data-testid="inspector" data-agent-id={d.agent.agentId}>
      {asOf !== null && <p className="as-of" data-testid="as-of">As of {formatSimClock(asOf, openLocal)}</p>}
      <div className="guest-head">
        <span className="guest-avatar" aria-hidden="true" style={{ color: hex(st.color) }}>{SHAPE_GLYPH[st.shape]}</span>
        <div className="grow">
          <h2 data-testid="guest-name">{name(d.agent.agentId)}</h2>
          <div className="sub">{ROLE_LABEL[p.role] ?? p.role}, {p.ageYears} · {ARCHETYPE_LABEL[p.archetype]} · {g.memberIds.length > 1 ? `group of ${g.memberIds.length}` : 'on their own'}</div>
        </div>
      </div>
      <p className="backstory" data-testid="backstory">{p.backstory}</p>

      <StatusCard agent={agent} detail={d} simMs={simMs} openLocal={openLocal} placeName={placeName} showStatusText={asOf === null} />

      {pastDecision ? <PastDecision x={pastDecision} openLocal={openLocal} /> : evidenceThen
        ? <DecisionCard e={evidenceThen} detail={d} openLocal={openLocal} placeName={placeName} isFixture={props.isFixture}
            pinned={!follow} newer={!follow && latestEvidence !== pinnedTo} onFollow={() => { setFollow(true); setPinnedTo(null); }}
            onNarrate={() => { setFollow(false); setPinnedTo(evidenceThen.evidenceId); }} runId={props.runId} name={name} />
        : <section className="decision" aria-label="Latest decision"><div className="thought-label">Latest decision</div><p className="small muted" style={{ margin: 0 }}>{asOf !== null && (d.evidence || d.decisions?.length) ? `Only their most recent decisions are kept for inspection; none of those were made before ${formatSimClock(asOf, openLocal)}.` : 'No decision recorded yet. Guests decide when they arrive, finish something, or notice a change.'}</p></section>}

      {laterDecisions && laterDecisions.length > 1 && <DecisionHistory decisions={laterDecisions} current={pastDecision?.evidenceId ?? evidenceThen?.evidenceId ?? null} openLocal={openLocal} />}

      <section className="side-section" aria-label="Chronology">
        <h3>Timeline</h3>
        {asOf !== null && !events.length && d.recentEvents.length ? <p className="small muted" style={{ margin: 0 }}>Recent history starts at {formatSimClock(d.recentEvents[0]!.atMs, openLocal)}.</p> : <Timeline events={events} park={props.park} evidence={evidenceThen} />}
      </section>

      <section className="side-section" aria-label="Group">
        <h3>{g.memberIds.length > 1 ? `Their group · ${g.memberIds.length} people` : 'Visiting alone'}</h3>
        <div className="member-list">
          {g.memberIds.map((m) => (
            <button key={m} type="button" className="member" onClick={() => props.onSelectAgent(m)} aria-current={m === d.agent.agentId ? 'true' : undefined}>
              {name(m)}{m === g.leaderId && <em>leads</em>}{g.guardianIds.includes(m) && m !== g.leaderId && <em>guardian</em>}
            </button>
          ))}
        </div>
      </section>

      <div>
        <Disclosure summary="Profile" count={p.occasion}>
          <KV items={[
            ['Occasion', p.occasion], ['Must-do', p.mustDoPlaceIds.map(placeName).join(', ') || '—'],
            ['Height / walk', `${p.heightCm} cm · ${p.walkSpeedMps.toFixed(2)} m/s`], ['Thrill preference', p.thrillPreference.toFixed(2)],
            ['App', p.hasApp ? 'has the park app' : 'no app'], ['Mobility', [p.stroller ? 'stroller' : null, p.mobilityRestricted ? 'mobility restricted' : null].filter(Boolean).join(', ') || 'no restrictions'],
            ['Budget', `${formatCents(g.startingBalanceCents)}, shared by the group`], ['Plans to leave', formatSimClock(g.plannedDepartureMs, openLocal)],
          ]} />
        </Disclosure>
        <Disclosure summary="What they know" count={`${d.observedFacts.length} observation${d.observedFacts.length === 1 ? '' : 's'}`}>
          {d.observedFacts.length === 0 && <p className="small muted">No observations recorded yet.</p>}
          <ul className="noticed">
            {[...d.observedFacts].reverse().slice(0, 12).map((f) => (
              <li key={f.id}>
                “{f.text}”
                <span className="tiny faint" style={{ display: 'block' }}>{placeName(f.placeId)} · {formatSimClock(f.observedAtMs, openLocal)}
                  {(f.waitLowerMs !== null || f.waitUpperMs !== null) && ` · promised ${f.waitLowerMs !== null ? Math.round(f.waitLowerMs / 60_000) : '?'}–${f.waitUpperMs !== null ? Math.round(f.waitUpperMs / 60_000) : '?'} min`}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
        {props.canOperate && asOf === null && <OperatorTruth detail={d} store={props.store} placeName={placeName} />}
        <Disclosure summary="Technical details">
          <KV items={[['Guest id', <span className="mono" key="a">{d.agent.agentId}</span>], ['Group id', <span className="mono" key="g">{g.groupId}</span>],
            ['Wallet id', <span className="mono" key="w">{g.walletId}</span>], ['Modeled experience', `${agent.experienceValue > 0 ? '+' : ''}${Math.round(agent.experienceValue)} points (model ledger, not a survey)`],
            ['Rating source', agent.rating ? `${agent.rating.source} at ${formatSimClock(agent.rating.atMs, openLocal)}` : '—'],
            ['Members', g.memberIds.join(', ')]]} />
          <p className="note">Profile values were frozen when the population was sampled.</p>
        </Disclosure>
      </div>
    </div>
  );
}

function StatusCard(props: { agent: AgentView; detail: AgentDetail; simMs: number; openLocal: string; placeName: (id: Id | null) => string; showStatusText: boolean }) {
  const { agent, detail } = props;
  const st = STATE_STYLE[agent.state];
  const arrived = agent.state !== 'not_arrived';
  const inPark = arrived ? Math.max(0, props.simMs - detail.group.arrivalMs) : null;
  const wallet = detail.evidence?.request.observation.wallet.balanceCents ?? detail.group.startingBalanceCents;
  return (
    <section className="status-card" aria-label="Current status" data-testid="guest-status">
      <div className="status-now">
        <span className="state-pill"><span className="glyph" aria-hidden="true" style={{ color: hex(st.color) }}>{SHAPE_GLYPH[st.shape]}</span>{st.label}</span>
        {agent.targetPlaceId && <span className="where"><Icon name="arrow-right" size={12} /> {props.placeName(agent.targetPlaceId)}</span>}
      </div>
      {props.showStatusText && detail.statusText && <p className="small muted" style={{ margin: '-6px 0 0' }} data-testid="status-text">{detail.statusText}</p>}
      <div className="facts-grid">
        <div><div className="k">Wallet</div><div className="v" title={detail.evidence ? 'Group balance seen at the last decision' : 'Starting group balance'}>{formatCents(wallet)}</div></div>
        <div><div className="k">In park</div><div className="v">{inPark === null ? '—' : formatDuration(inPark)}</div></div>
        <div><div className="k">Satisfaction</div><div className="v">{agent.rating ? <>{agent.rating.value}<small>/100</small></> : <small>not rated</small>}</div></div>
      </div>
      <div className="needs" aria-label="Needs">
        {(['hunger', 'fatigue', 'patience', 'fun'] as const).map((k) => {
          const v = Math.round(agent.needs[k]);
          const high = (k === 'hunger' || k === 'fatigue') ? v >= 60 : v <= 35;
          return (
            <div key={k} className={`need ${high ? 'high' : ''}`}>
              <div className="top"><span style={{ textTransform: 'capitalize' }}>{k}</span><b>{v}</b></div>
              <div className="bar" role="meter" aria-label={k} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${v}%` }} /></div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DecisionCard(props: {
  e: AppliedDecision; detail: AgentDetail; openLocal: string; placeName: (id: Id | null) => string; isFixture: boolean; runId: Id;
  pinned: boolean; newer: boolean; onFollow: () => void; onNarrate: () => void; name: (id: Id) => string;
}) {
  const { e } = props;
  const rows = optionRows(e);
  const recorded = recordedRationale(e);
  const why = recorded?.summary ?? deriveRationale(e, props.detail.agent.agentId);
  const src = sourceLabel(e.response.source, e.response.originalSource, e.response.modelReturned);
  const gov = governance(props.detail);
  return (
    <section className="decision" aria-label="Latest decision" data-testid="evidence">
      <div className="decision-head">
        <div>
          <div className="thought-label">{props.pinned ? 'Pinned decision' : 'Latest decision'}</div>
          <div className="moment">{momentLabel(e.request.moment)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="when">{formatSimClock(e.request.createdAtMs, props.openLocal, true)}</div>
          {(e.response.source === 'jev' || (e.response.source === 'cache' && e.response.originalSource === 'jev')) && <span className="badge plain" title={src.text} style={{ marginTop: 4 }}>Jev</span>}
        </div>
      </div>

      {recorded && recorded.drivers.length > 0 && (
        <div>
          <div className="thought-label">On their mind</div>
          <div className="driver-list">{recorded.drivers.map((d) => <span key={d} className="driver">{d}</span>)}</div>
        </div>
      )}
      {e.request.observation.facts.length > 0 && (
        <div>
          <div className="thought-label">Noticed</div>
          <ul className="noticed">
            {e.request.observation.facts.slice(-3).map((f) => <li key={f.id}>“{f.text}” <span className="tiny faint">{props.placeName(f.placeId)}</span></li>)}
          </ul>
        </div>
      )}

      <div>
        <div className="thought-label">Considered</div>
        <div className="options" data-testid="options">
          {[...rows].sort((x, y) => (y.applied ?? 0) - (x.applied ?? 0)).map((r) => (
            <div key={r.id} className={`opt ${r.sampled ? 'sampled' : ''}`} data-option-id={r.id} data-sampled={r.sampled || undefined} title={r.description}>
              <span className="name"><span>{r.label}</span>{r.sampled && <span className="tag sampled">Chosen</span>}</span>
              <span className="pct">{r.applied === null ? '—' : formatProbability(r.applied)}</span>
              <div className="bar" aria-hidden="true"><span style={{ width: `${(r.applied ?? 0) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className="thought-label">Why</div>
        <p className="why" data-testid="rationale">{why}<span className="src">{recorded ? 'Built from what they saw and how likely each option was.' : 'Summarized from what they saw and how likely each option was.'}</span></p>
      </div>
      {recorded?.modelReasoning && (
        <div>
          <div className="thought-label">In the model’s words</div>
          <blockquote className="model-quote">{recorded.modelReasoning}</blockquote>
        </div>
      )}

      <p className="small muted" data-testid="outcome" style={{ margin: 0 }}>
        {e.outcome === 'committed' ? 'Carried out' : 'Could not be carried out'}{e.failureReason ? ` — ${e.failureReason}` : ''} at {formatSimClock(e.committedAtMs, props.openLocal, true)}.{e.request.agentIds.length > 1 ? ` Decided together with their group${e.request.observation.leaderId !== props.detail.agent.agentId ? `, led by ${props.name(e.request.observation.leaderId)}` : ''}.` : ''}
      </p>

      {props.pinned && (
        <p className="small muted" style={{ margin: 0 }}>{props.newer ? 'This guest has made newer decisions. ' : ''}<button type="button" className="link-btn" onClick={props.onFollow}>Follow latest decision</button></p>
      )}

      <Narration runId={props.runId} agentId={props.detail.agent.agentId} e={e} onRequest={props.onNarrate} />

      <EvidenceDetails e={e} detail={props.detail} openLocal={props.openLocal} isFixture={props.isFixture} srcText={src.text} govText={gov.text} />
    </section>
  );
}

function EvidenceDetails(props: { e: AppliedDecision; detail: AgentDetail; openLocal: string; isFixture: boolean; srcText: string; govText: string }) {
  const { e } = props;
  const rows = optionRows(e);
  const anyNorm = rows.some((r) => r.normalizationDiffers);
  return (
    <Disclosure summary="Evidence" count={<span className="mono">{e.evidenceId}</span>}>
      <p className="small" data-testid="evidence-source" style={{ margin: 0 }}><b>Source:</b> {props.srcText}{props.isFixture ? ' (fixture script)' : ''}. Model requested {e.response.modelRequested}.</p>
      <KV items={[
        ['Moment', `${e.request.moment} (decision #${e.request.decisionSeq}, moment seq ${e.request.momentSeq}, request rev ${e.request.requestRevision})`],
        ['Triggered / applied', `${formatSimClock(e.request.createdAtMs, props.openLocal, true)} / ${formatSimClock(e.request.applyAtMs, props.openLocal, true)}`],
        ['Governs', props.govText],
        ['Draw', <span className="mono" key="d">u = {e.draw.toFixed(6)}</span>],
        ['Observation hash', <span className="hash" key="o">{e.request.observationHash}</span>],
        ['Options hash', <span className="hash" key="h">{e.request.optionsHash}</span>],
        ['Policy', e.request.policyVersion],
        ['Resulting events', e.causedEventIds.length ? <span className="mono" key="c">{e.causedEventIds.join(' ')}</span> : 'none'],
      ]} />
      <table className="small">
        <thead><tr><th>Option (prompt order)</th><th className="num">Applied</th><th className="num">Interval</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.id}><td>{r.label}{r.highest ? ' · highest' : ''}{r.sampled ? ' · sampled' : ''}<div className="tiny faint">{r.description}</div></td>
            <td className="num">{r.applied === null ? '—' : formatProbability(r.applied)}{r.normalizationDiffers && <div className="tiny faint">raw {r.raw === null ? '—' : r.raw.toFixed(7)}</div>}</td>
            <td className="num mono tiny">[{r.cdfFrom.toFixed(4)}, {r.cdfTo.toFixed(4)})</td></tr>
        ))}</tbody>
      </table>
      <p className="note">The draw fell in the sampled option’s interval (options in ascending ID order, inverse CDF). The most likely option is not necessarily the one sampled.{anyNorm ? ' Raw probabilities were within the accepted 1e-6 round-off and normalized; both are shown.' : ''}</p>
      {e.request.candidateAudit.excluded.length > 0 && (
        <div><h4>Excluded candidates</h4><ul className="note-list">{e.request.candidateAudit.excluded.map((x) => <li key={x.id}>{x.id}: {x.reason}</li>)}</ul></div>
      )}
      {e.response.usage.httpMs > 0 && <p className="note">Provider latency {formatAge(e.response.usage.httpMs)} after {e.response.usage.attemptCount} attempt(s).</p>}
    </Disclosure>
  );
}

/** A decision from the past (scrubbed view): its recorded rationale and probabilities. */
function PastDecision(props: { x: DecisionSummary; openLocal: string }) {
  const r = props.x.rationale;
  const opts = [{ ...r.chosen, chosen: true }, ...r.alternatives.map((a) => ({ ...a, chosen: false }))].sort((a, b) => b.probability - a.probability);
  return (
    <section className="decision" aria-label="Decision at this time" data-testid="evidence">
      <div className="decision-head">
        <div><div className="thought-label">Decision in force</div><div className="moment">{momentLabel(props.x.moment)}</div></div>
        <div className="when">{formatSimClock(props.x.atMs, props.openLocal, true)}</div>
      </div>
      {r.drivers.length > 0 && <div><div className="thought-label">On their mind</div><div className="driver-list">{r.drivers.map((d) => <span key={d} className="driver">{d}</span>)}</div></div>}
      <div>
        <div className="thought-label">Considered</div>
        <div className="options" data-testid="options">
          {opts.map((o) => (
            <div key={o.optionId} className={`opt ${o.chosen ? 'sampled' : ''}`} data-sampled={o.chosen || undefined}>
              <span className="name"><span>{o.label}</span>{o.chosen && <span className="tag sampled">Chosen</span>}</span>
              <span className="pct">{formatProbability(o.probability)}</span>
              <div className="bar" aria-hidden="true"><span style={{ width: `${o.probability * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </div>
      <div><div className="thought-label">Why</div><p className="why" data-testid="rationale">{r.summary}</p></div>
      {r.modelReasoning && <div><div className="thought-label">In the model’s words</div><blockquote className="model-quote">{r.modelReasoning}</blockquote></div>}
    </section>
  );
}

function DecisionHistory(props: { decisions: DecisionSummary[]; current: Id | null; openLocal: string }) {
  return (
    <section className="side-section" aria-label="Recent decisions" data-testid="decision-history">
      <h3>Recent decisions</h3>
      <ol className="decision-list">
        {props.decisions.slice(0, 12).map((x) => (
          <li key={x.evidenceId} className={x.evidenceId === props.current ? 'current' : undefined}>
            <div className="spread" style={{ gap: 8, flexWrap: 'nowrap' }}>
              <span className="grow"><b>{x.chosenLabel}</b> <span className="faint tiny">{(x.rationale.chosen.probability * 100).toFixed(0)}%</span></span>
              <span className="mono tiny faint">{formatSimClock(x.atMs, props.openLocal)}</span>
            </div>
            <div className="tiny muted">{momentLabel(x.moment)}{x.outcome !== 'committed' ? ' · could not be carried out' : ''}</div>
            <details className="explain"><summary>Why</summary><p className="small muted" style={{ margin: '4px 0 0' }}>{x.rationale.summary}</p></details>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Timeline(props: { events: EventRecord[]; park: ParkBundle; evidence: AppliedDecision | null }) {
  const caused = new Set(props.evidence?.causedEventIds ?? []);
  const items = [...props.events].reverse().slice(0, 14);
  if (!items.length) return <p className="small muted" style={{ margin: 0 }}>Nothing recorded yet.</p>;
  return (
    <ol className="timeline">
      {items.map((e) => {
        const d = describeEvent(e, props.park);
        return (
          <li key={e.sequence} className={caused.has(e.eventId) ? 'decision-ev' : undefined}>
            <span className="t">{formatSimClock(e.atMs, props.park.openLocal, true)}</span>
            <span><strong style={{ fontWeight: 500 }}>{d.label}</strong>{d.detail ? <span className="muted"> · {d.detail}</span> : null}</span>
          </li>
        );
      })}
    </ol>
  );
}

function OperatorTruth(props: { detail: AgentDetail; store: LiveStore; placeName: (id: Id | null) => string }) {
  const [open, setOpen] = useState(false);
  const places = useLiveSelector(props.store, (s) => s.places);
  const rows = knowledgeVsTruth(props.detail.observedFacts, places);
  return (
    <section aria-label="World versus guest knowledge" className="disclosure" style={{ borderTop: '1px solid var(--line)', padding: '10px 0' }}>
      <div className="spread">
        <span className="small muted" style={{ fontWeight: 500 }}>What they believe vs. reality <Explain label="operator truth">Operator-only. Current world state is shown to you; it is never part of the guest’s model input.</Explain></span>
        <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="truth-toggle">{open ? 'Hide' : 'Compare'}</button>
      </div>
      {open && (
        rows.length === 0 ? <p className="small muted">No observed places to compare yet.</p> : (
          <table className="small" style={{ marginTop: 8 }}>
            <thead><tr><th>Place</th><th>Guest saw</th><th>Reality now</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const last = r.guestFacts[r.guestFacts.length - 1]!;
                return (
                  <tr key={r.placeId}>
                    <td>{props.placeName(r.placeId)}</td>
                    <td>“{last.text}” <span className="faint">({last.contentVersion})</span></td>
                    <td>{r.truth ? <>{r.truth.closed ? <b>Closed</b> : 'Open'}{r.truth.boardText ? ` · board “${r.truth.boardText}”` : ''}{r.truth.predictedWaitMs !== null ? ` · est. ${Math.round(r.truth.predictedWaitMs / 60_000)} min` : ''}</> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}

function Narration(props: { runId: Id; agentId: Id; e: AppliedDecision; onRequest: () => void }) {
  const rt = useRuntime();
  const { state, request } = useNarration(rt.client, rt.runner, props.runId, props.e.evidenceId, props.agentId);
  return (
    <section aria-label="Narration" data-testid="narration" data-narration-for={`${props.e.evidenceId}|${props.agentId}`} className="stack" style={{ gap: 8 }}>
      {state.kind === 'idle' && (
        <div><button type="button" className="btn small" onClick={() => { props.onRequest(); void request(); }} data-testid="narrate">Explain in words</button></div>
      )}
      {state.kind === 'loading' && <Spinner label="Writing an explanation…" />}
      {state.kind === 'ready' && <NarrativeView narrative={state.narrative} facts={null} expectedEvidenceHash={null} />}
      {state.kind === 'failed' && (
        <div className="stack" style={{ gap: 6 }}>
          <div data-testid="local-narration">
            <p className="small" style={{ margin: 0 }}>{narrateFromState(props.e, props.agentId)}</p>
            <span className="tiny faint">Narrated from state · local template, no model ({state.error.message})</span>
          </div>
          <div><button type="button" className="btn small ghost" onClick={() => { props.onRequest(); void request(); }} data-testid="narrate">Try again</button></div>
        </div>
      )}
      {state.kind === 'ready' && <p className="note">Narration describes recorded state; it is not recovered private reasoning.</p>}
    </section>
  );
}
