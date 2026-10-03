import { useMemo, useRef, useState } from 'react';
import type { Capabilities, DomainError, Id, ParkBundle, RunManifest, ScenarioChange, ScenarioDraft, ScenarioEvent } from '../../../contract/behavior-v1';
import { useLiveSelector } from '../../data/hooks';
import type { LiveStore } from '../../data/liveStore';
import { scenarioDraftSchema, validate } from '../../domain/schemas';
import { classifyError } from '../../runtime/errors';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { awaitWork } from '../../runtime/work';
import { ActionButton, Alert, ErrorBox, Spinner } from '../../ui/components';
import { formatSimClock, parseDollarsToCents, parseParkLocalTime } from '../../ui/format';
import { describeChange, eventTime } from './describe';

type Draft = { source: 'parser' | 'editor'; draft: ScenarioDraft | null; events: ScenarioEvent[]; assumptions: string[]; unsupported: string[]; contextRevision: string; text: string };
type Accepted = { scenarioRevision: string; events: ScenarioEvent[]; commandId: Id };

export function WhatIfPanel(props: { runId: Id; store: LiveStore; park: ParkBundle; manifest: RunManifest; capabilities: Capabilities }) {
  const rt = useRuntime();
  const run = useLiveSelector(props.store, (s) => s.run);
  const events = useLiveSelector(props.store, (s) => s.events);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'confirming'>('idle');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<{ error: DomainError; transport: boolean } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<Accepted[]>([]);
  const abort = useRef<AbortController | null>(null);

  const applied = useMemo(() => {
    const ids = new Set<string>();
    for (const e of events) {
      if (e.kind !== 'scenario_applied') continue;
      if (e.causationId) ids.add(e.causationId);
      const d = e.details as { scenarioEventId?: unknown } | null;
      if (d && typeof d.scenarioEventId === 'string') ids.add(d.scenarioEventId);
    }
    return ids;
  }, [events]);

  if (props.manifest.experiment) {
    return (
      <Alert tone="info" title="Experiment arm: scenario frozen">
        This run is arm {props.manifest.experiment.arm} of experiment {props.manifest.experiment.experimentId}. Comparative arms cannot be edited silently; start a new exploratory scenario or run instead.
      </Alert>
    );
  }
  if (!run) return <Spinner label="Waiting for run state…" />;
  const terminal = ['completed', 'cancelled', 'failed'].includes(run.status);

  const parse = async (t: string) => {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setPhase('parsing'); setError(null); setConflict(null); setDraft(null);
    const rev = run.scenarioRevision;
    const out = await rt.runner.run('requestProductWork', { request: { kind: 'parse_scenario', text: t, runId: props.runId, park: props.manifest.park, expectedScenarioRevision: rev } }, `parse:${props.runId}:${Date.now()}`);
    if (out.kind !== 'accepted') { setError({ error: out.error, transport: out.kind === 'transport' }); setPhase('idle'); return; }
    try {
      const st = await awaitWork<'parse_scenario'>(rt.client, out.result.workId, { signal: ctrl.signal, intervalMs: 300 });
      if (st.status !== 'ready' || !st.result) { setError({ error: st.error ?? { code: 'INCOMPLETE', message: `Parser ${st.status}; the park is unchanged.`, retryable: true, fieldErrors: [] }, transport: false }); setPhase('idle'); return; }
      const v = validate<ScenarioDraft>(scenarioDraftSchema, st.result);
      if (!v.ok) { setError({ error: { code: 'INVALID_INPUT', message: `The parser returned an invalid draft (${v.issues.join('; ')}). Nothing was scheduled.`, retryable: false, fieldErrors: [] }, transport: false }); setPhase('idle'); return; }
      setDraft({ source: 'parser', draft: v.value, events: v.value.events, assumptions: v.value.assumptions, unsupported: v.value.unsupported, contextRevision: v.value.contextRevision, text: t });
    } catch (e) {
      if (!ctrl.signal.aborted) setError(classifyError(e));
    }
    setPhase('idle');
  };

  const confirm = async () => {
    if (!draft) return;
    setPhase('confirming'); setError(null);
    const key = `schedule:${props.runId}:${draft.draft?.draftId ?? draft.events.map((e) => e.id).join(',')}`;
    const out = await rt.runner.run('scheduleEvents', { runId: props.runId, expectedScenarioRevision: draft.contextRevision, draftId: draft.draft?.draftId ?? null, events: draft.events }, key);
    setPhase('idle');
    if (out.kind === 'accepted') {
      setAccepted((a) => [...a, { ...out.result, commandId: out.commandId }]);
      setDraft(null);
      setText('');
    } else if (out.kind === 'rejected' && (out.error.code === 'STALE_REVISION' || out.error.code === 'CONFLICT')) {
      setConflict(out.error.message);
    } else setError({ error: out.error, transport: out.kind === 'transport' });
  };

  const tooEarly = draft?.events.filter((e) => e.atMs < run.earliestSchedulableMs) ?? [];
  const unsupportedKinds = draft?.events.filter((e) => !props.capabilities.eventKinds.includes(e.change.kind)) ?? [];
  const confirmReason = !draft ? 'Nothing to confirm.' : draft.events.length === 0 ? 'The draft has no supported changes.'
    : unsupportedKinds.length ? 'The draft contains event kinds this server does not support.'
      : tooEarly.length ? `An event is earlier than the next schedulable boundary (${formatSimClock(run.earliestSchedulableMs, props.park.openLocal, true)}). Edit the time and preview again.`
        : terminal ? `Run is ${run.status}.` : conflict ? 'The run changed since this draft was reviewed. Refresh the draft first.' : null;

  return (
    <div className="stack" data-testid="whatif">
      <h3 style={{ margin: 0 }}>What if…</h3>
      <p className="small muted">Describe a change. The parser only proposes a draft; nothing changes until you review and confirm. Times are park-local ({props.park.openLocal} opening), not your device timezone.</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void parse(text.trim()); }}>
        <label className="field"><span className="label">Proposed change</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder='e.g. close the coaster at 2pm; raise the pass price to $25 at 11:00' maxLength={1000} data-testid="whatif-text" />
        </label>
        <div className="row">
          <ActionButton type="submit" onClick={() => undefined} busy={phase === 'parsing'} disabledReason={terminal ? `Run is ${run.status}.` : null} testId="whatif-parse">Preview draft</ActionButton>
        </div>
      </form>
      {phase === 'parsing' && <Spinner label="Parsing (the park is unchanged)…" />}
      <StructuredEditor park={props.park} capabilities={props.capabilities} earliest={run.earliestSchedulableMs} contextRevision={run.scenarioRevision}
        onDraft={(d) => { setDraft(d); setConflict(null); setError(null); }} disabled={terminal} />
      {error && <ErrorBox error={error.error} transport={error.transport} />}
      {draft && (
        <section className="panel tight" aria-label="Draft for review" data-testid="draft-card">
          <div className="spread"><h4 style={{ margin: 0 }}>Draft for review</h4><span className="badge warn">not applied</span></div>
          <p className="small muted">{draft.source === 'parser' ? `Parsed from: "${draft.text}"` : 'From the structured editor'} · reviewed against scenario revision {draft.contextRevision} · scope: this run only</p>
          {draft.events.length === 0 && <p>No supported change was found.</p>}
          <ol className="small">
            {draft.events.map((e) => {
              const d = describeChange(e.change, props.park, props.capabilities.features.discountMessages);
              return (
                <li key={e.id} style={{ marginBottom: 6 }}>
                  <b>{d.operation}</b>{d.place ? ` · ${d.place}` : ''}<br />{d.value}<br />
                  <span className="muted">at {eventTime(e, props.park)}</span>
                  {e.atMs < run.earliestSchedulableMs && <div className="badge bad">too early: next schedulable boundary is {formatSimClock(run.earliestSchedulableMs, props.park.openLocal, true)}</div>}
                  {d.notes.map((n) => <div key={n} className="muted">{n}</div>)}
                </li>
              );
            })}
          </ol>
          {draft.assumptions.length > 0 && <><h4>Assumptions</h4><ul className="small">{draft.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></>}
          {draft.unsupported.length > 0 && <><h4>Not supported / not understood (ignored)</h4><ul className="small" data-testid="unsupported">{draft.unsupported.map((a) => <li key={a}>{a}</li>)}</ul></>}
          {conflict && (
            <Alert tone="warn" title="Conflict: refreshed review required">
              <p>{conflict}</p>
              {draft.source === 'parser'
                ? <button type="button" className="btn small" onClick={() => void parse(draft.text)}>Refresh draft against the current run</button>
                : <p className="small">Edit the time in the structured editor and preview again.</p>}
            </Alert>
          )}
          <div className="row">
            <ActionButton tone="primary" onClick={() => void confirm()} busy={phase === 'confirming'} disabledReason={confirmReason} testId="whatif-confirm">Confirm and schedule</ActionButton>
            <button type="button" className="btn" onClick={() => { setDraft(null); setConflict(null); }}>Discard</button>
          </div>
        </section>
      )}
      {accepted.length > 0 && (
        <section aria-label="Scheduled changes" data-testid="scheduled">
          <h4>Accepted by the server</h4>
          <ul className="card-list small">
            {accepted.flatMap((a) => a.events.map((e) => (
              <li key={e.id} className="panel tight" data-event-id={e.id} data-applied={applied.has(e.id) || undefined}>
                <div className="spread">
                  <b>{describeChange(e.change, props.park, props.capabilities.features.discountMessages).operation}</b>
                  {applied.has(e.id) ? <span className="badge ok">{'✓'} applied (Engine evidence)</span> : <span className="badge info">scheduled</span>}
                </div>
                <div className="muted">Logical time {eventTime(e, props.park)} · scenario revision {a.scenarioRevision} · receipt for <span className="mono">{a.commandId}</span></div>
              </li>
            )))}
          </ul>
        </section>
      )}
    </div>
  );
}

type Kind = ScenarioChange['kind'];
const KIND_LABEL: Record<Kind, string> = {
  pass_price: 'Pass price', pass_share: 'Pass-lane share', board: 'Wait board text', notice: 'Notice text', closure: 'Close / reopen', show_schedule: 'Show times', app_message: 'App message',
};

function StructuredEditor(props: { park: ParkBundle; capabilities: Capabilities; earliest: number; contextRevision: string; onDraft: (d: Draft) => void; disabled: boolean }) {
  const kinds = props.capabilities.eventKinds;
  const [kind, setKind] = useState<Kind>(kinds[0] ?? 'pass_price');
  const [time, setTime] = useState('');
  const [placeId, setPlaceId] = useState('');
  const [value, setValue] = useState('');
  const [closed, setClosed] = useState(true);
  const [msgText, setMsgText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const places = props.park.places.filter((p) => {
    if (kind === 'closure') return ['ride', 'show', 'food', 'shop'].includes(p.kind);
    if (kind === 'board' || kind === 'pass_share') return p.kind === 'ride' && (kind !== 'pass_share' || (p.service.kind === 'ride' && p.service.passEnabled));
    if (kind === 'notice') return p.notice !== null;
    if (kind === 'show_schedule') return p.kind === 'show';
    return p.kind !== 'entrance' && p.kind !== 'exit';
  });
  if (!kinds.length) return <p className="small muted">This server supports no scenario events.</p>;
  const build = () => {
    setProblem(null);
    const at = time.trim() ? parseParkLocalTime(time, props.park.openLocal, props.park.closeAfterMs) : { ok: true as const, simMs: props.earliest };
    if (!at.ok) { setProblem(at.message); return; }
    let change: ScenarioChange;
    const needPlace = kind !== 'pass_price' && kind !== 'app_message';
    if (needPlace && !placeId) { setProblem('Choose a place.'); return; }
    if (kind === 'pass_price') {
      const c = parseDollarsToCents(value);
      if (!c.ok) { setProblem(c.message); return; }
      if (c.cents <= 0) { setProblem('Price must be positive.'); return; }
      change = { kind, unitPriceCents: c.cents };
    } else if (kind === 'closure') change = { kind, placeId, closed };
    else if (kind === 'board') {
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(value.trim());
      change = m ? { kind, placeId, display: { kind: 'fixed', lowerMin: Number(m[1]), upperMin: Number(m[2]), text: `${m[1]}-${m[2]} min` } }
        : { kind, placeId, display: { kind: 'fixed', lowerMin: null, upperMin: null, text: value.trim() } };
      if (!value.trim()) { setProblem('Enter board text or a range like 20-30.'); return; }
    } else if (kind === 'notice') {
      const base = props.park.places.find((p) => p.id === placeId)?.notice;
      if (!base || !msgText.trim()) { setProblem('Enter the new notice text.'); return; }
      change = { kind, placeId, notice: { ...base, text: msgText } };
    } else if (kind === 'pass_share') {
      const pct = Number(value);
      if (!(pct >= 0 && pct <= 100)) { setProblem('Share must be 0-100%.'); return; }
      change = { kind, placeId, shareBps: Math.round(pct * 100) };
    } else if (kind === 'show_schedule') {
      const times = value.split(',').map((s) => parseParkLocalTime(s.trim(), props.park.openLocal, props.park.closeAfterMs));
      const bad = times.find((x) => !x.ok);
      if (bad && !bad.ok) { setProblem(bad.message); return; }
      change = { kind, placeId, startsAtMs: times.map((x) => (x.ok ? x.simMs : 0)) };
    } else {
      if (!msgText.trim()) { setProblem('Enter the message text.'); return; }
      change = { kind: 'app_message', messageId: `msg-${crypto.randomUUID().slice(0, 8)}`, text: msgText, expiresAtMs: Math.min(props.park.closeAfterMs, at.simMs + 3600_000), suggestedPlaceId: placeId || null, discount: null };
    }
    props.onDraft({ source: 'editor', draft: null, contextRevision: props.contextRevision, text: '', assumptions: kind === 'app_message' ? ['Message expires one hour after it is sent.', 'No discount: this message changes no price.'] : [], unsupported: [],
      events: [{ id: `ui-${kind}-${crypto.randomUUID().slice(0, 8)}`, atMs: at.simMs, order: 0, change }] });
  };
  return (
    <details className="panel tight" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary style={{ cursor: 'pointer' }}><b>Structured editor</b> <span className="small muted">(only server-supported changes)</span></summary>
      <div className="stack" style={{ marginTop: 8 }}>
        <label className="field"><span className="label">Change</span>
          <select value={kind} onChange={(e) => { setKind(e.target.value as Kind); setPlaceId(''); setValue(''); }}>
            {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>
        {kind !== 'pass_price' && (
          <label className="field"><span className="label">{kind === 'app_message' ? 'Suggested place (optional)' : 'Place'}</span>
            <select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
              <option value="">{kind === 'app_message' ? 'None' : 'Choose…'}</option>
              {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        {kind === 'pass_price' && <label className="field"><span className="label">New price per guest (USD)</span><input type="text" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="25.00" /></label>}
        {kind === 'closure' && <label className="row small"><input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} /> Closed (uncheck to reopen)</label>}
        {kind === 'board' && <label className="field"><span className="label">Board shows (text, or a range like 20-30)</span><input type="text" value={value} onChange={(e) => setValue(e.target.value)} /></label>}
        {kind === 'pass_share' && <label className="field"><span className="label">Pass-lane target share (%)</span><input type="number" min={0} max={100} value={value} onChange={(e) => setValue(e.target.value)} /></label>}
        {kind === 'show_schedule' && <label className="field"><span className="label">Show times (park-local, comma separated)</span><input type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="10:30, 12:00, 14:30" /></label>}
        {(kind === 'notice' || kind === 'app_message') && <label className="field"><span className="label">{kind === 'notice' ? 'New notice text (exact)' : 'Message text (exact)'}</span><textarea value={msgText} onChange={(e) => setMsgText(e.target.value)} maxLength={400} /></label>}
        {kind === 'app_message' && !props.capabilities.features.discountMessages && <p className="small muted">Discounts are not supported by this server, so none can be attached. Discount wording in the text would not change any price.</p>}
        <label className="field"><span className="label">When (park-local time; blank = next schedulable boundary {formatSimClock(props.earliest, props.park.openLocal, true)})</span>
          <input type="text" value={time} onChange={(e) => setTime(e.target.value)} placeholder="14:00" />
        </label>
        {problem && <p className="small" role="alert" style={{ color: 'var(--bad-ink)' }}>{problem}</p>}
        <ActionButton onClick={build} disabledReason={props.disabled ? 'Run is not active.' : null}>Preview draft</ActionButton>
      </div>
    </details>
  );
}
