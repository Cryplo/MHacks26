import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Archetype, ArtifactRef, CrowdSpec, DomainError, Mode, ParkSummary, PopulationManifest, RunConfig, WorkStatus } from '../../../contract/behavior-v1';
import { SCENARIO_PRESETS, type ScenarioPreset } from '../../content/harborLights';
import { fetchVerifiedJson, loadPark, type LoadedPark } from '../../data/hooks';
import { useAsync } from '../../data/useAsync';
import { canonicalHash, canonicalJson } from '../../domain/canonical';
import { populationManifestSchema, validate } from '../../domain/schemas';
import { classifyError } from '../../runtime/errors';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { awaitWork } from '../../runtime/work';
import { ActionButton, Alert, Disclosure, ErrorBox, Icon, KV, Spinner } from '../../ui/components';
import { formatCents, formatDuration, formatSimClock } from '../../ui/format';
import { describeChange, eventTime } from '../scenarios/describe';
import { ParkPreview } from '../dashboard/ParkPreview';
import { ARCHETYPE_LABEL, ARCHETYPE_ORDER, buildCrowd, DEFAULT_GUESTS, DEFAULT_LIVE_GUESTS, defaultMix, fitMix, mixFromShares, summarizePopulation, sumMix, validateCrowd, type GuestMix } from './crowd';
import { buildManifest, defaultRunConfig, HORIZON_OPTIONS_MS, NO_FEATURES } from './plan';

type Preview =
  | { kind: 'none' }
  | { kind: 'pending'; status: WorkStatus['status'] | 'requesting' }
  | { kind: 'failed'; error: DomainError; transport: boolean }
  | { kind: 'ready'; crowdKey: string; artifact: ArtifactRef; manifest: PopulationManifest };

const newSeed = () => `seed-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
/** Muted, distinguishable tints for the archetype mix bar (display only). */
export const ARCHETYPE_TINT: Record<Archetype, string> = {
  young_family: '#f0b43c', teens: '#6ca6f5', couple: '#d982b5', thrill_seekers: '#e8693a', seniors: '#4cc38a', solo: '#8b95a3',
};

export function SetupPage() {
  const rt = useRuntime();
  const navigate = useNavigate();
  const isOperator = rt.session?.roles.includes('operator') ?? false;
  const parks = useAsync(() => rt.client.query('listParks', { cursor: null }), [rt.client], { pollMs: 2000 });
  const [parkSummary, setParkSummary] = useState<ParkSummary | null>(null);
  const [park, setPark] = useState<LoadedPark | null>(null);
  const [parkError, setParkError] = useState<string | null>(null);
  const [guestCount, setGuestCount] = useState(rt.settings.behaviorProvider === 'laya' ? DEFAULT_LIVE_GUESTS : DEFAULT_GUESTS);
  const [mix, setMix] = useState<GuestMix>(defaultMix(rt.settings.behaviorProvider === 'laya' ? DEFAULT_LIVE_GUESTS : DEFAULT_GUESTS));
  const [seed, setSeed] = useState(newSeed);
  const [notes, setNotes] = useState('');
  const [rawPreview, setPreview] = useState<Preview>({ kind: 'none' });
  const [presetId, setPresetId] = useState('baseline');
  const [mode, setMode] = useState<Mode>(rt.settings.behaviorProvider === 'laya' ? 'local' : 'mock');
  // Full operating day by default; the fixture's scripted scenes only cover 4 hours.
  const [horizon, setHorizon] = useState(rt.settings.profile === 'fixture' ? 4 * 3600_000 : 10 * 3600_000);
  const [ratingMode, setRatingMode] = useState<'periodic' | 'terminal'>('periodic');
  const [createError, setCreateError] = useState<{ error: DomainError; transport: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const crowd: CrowdSpec = useMemo(() => buildCrowd(guestCount, mix, seed, notes), [guestCount, mix, seed, notes]);
  const crowdKey = canonicalJson({ crowd, park: park?.park.revision ?? null });
  const check = validateCrowd(guestCount, mix, rt.capabilities.maxGuests);

  // A preview for a different crowd/seed/park is never reused: it shows as "updating".
  const preview: Preview = rawPreview.kind === 'ready' && rawPreview.crowdKey !== crowdKey ? { kind: 'pending', status: 'requesting' } : rawPreview;

  const choosePark = async (s: ParkSummary) => {
    setParkSummary(s); setPark(null); setParkError(null);
    try { setPark(await loadPark(rt.client, s.artifact)); } catch (e) { setParkError(e instanceof Error ? e.message : classifyError(e).error.message); }
  };
  // Sensible default: the most complete ready park, once validation has settled.
  const autoPicked = useRef(false);
  useEffect(() => {
    if (autoPicked.current || parkSummary || !parks.data) return;
    const items = parks.data.items;
    if (items.some((p) => p.status === 'preparing')) return;
    const best = [...items].filter((p) => p.status === 'ready').sort((a, b) => parkRank(b) - parkRank(a))[0];
    if (best) { autoPicked.current = true; void choosePark(best); }
  }, [parks.data, parkSummary]); // eslint-disable-line react-hooks/exhaustive-deps
  const topRank = Math.max(0, ...(parks.data?.items ?? []).map(parkRank));

  const requestPreview = async () => {
    if (!parkSummary) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const key = crowdKey;
    setPreview({ kind: 'pending', status: 'requesting' });
    const out = await rt.runner.run('requestProductWork', { request: { kind: 'population', crowd, park: parkSummary.artifact } }, `population:${await canonicalHash({ crowd, park: parkSummary.artifact.sha256 })}`);
    if (ctrl.signal.aborted) return;
    if (out.kind !== 'accepted') { setPreview({ kind: 'failed', error: out.error, transport: out.kind === 'transport' }); return; }
    try {
      const st = await awaitWork<'population'>(rt.client, out.result.workId, { signal: ctrl.signal, onStatus: (s) => { if (!ctrl.signal.aborted) setPreview({ kind: 'pending', status: s.status }); } });
      if (ctrl.signal.aborted) return;
      if (st.status !== 'ready' || !st.result) { setPreview({ kind: 'failed', error: st.error ?? { code: 'INCOMPLETE', message: `Population job ${st.status}.`, retryable: true, fieldErrors: [] }, transport: false }); return; }
      const json = await fetchVerifiedJson(rt.client, st.result.artifact);
      const v = validate<PopulationManifest>(populationManifestSchema, json);
      if (!v.ok) throw new Error(`Population artifact failed validation: ${v.issues.join('; ')}`);
      if (v.value.parkHash !== parkSummary.artifact.sha256) throw new Error('Population was generated for a different park artifact.');
      if (canonicalJson(v.value.crowd) !== canonicalJson(crowd)) throw new Error('Population artifact crowd does not match the requested crowd.');
      if (!ctrl.signal.aborted) setPreview({ kind: 'ready', crowdKey: key, artifact: st.result.artifact, manifest: v.value });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setPreview({ kind: 'failed', error: e instanceof Error && !('error' in e) ? { code: 'INVALID_INPUT', message: e.message, retryable: false, fieldErrors: [] } : classifyError(e).error, transport: classifyError(e).transport });
    }
  };
  // The population service samples the crowd automatically (debounced) whenever inputs settle.
  const latestRequest = useRef(requestPreview);
  latestRequest.current = requestPreview;
  const canPreview = Boolean(park && parkSummary) && check.errors.length === 0;
  useEffect(() => {
    if (!canPreview) { abort.current?.abort(); return; }
    const t = setTimeout(() => { void latestRequest.current(); }, 450);
    return () => clearTimeout(t);
  }, [crowdKey, canPreview]);
  useEffect(() => () => abort.current?.abort(), []);

  const stage = park?.park.places.some((p) => p.id === 'river_rapids') ? 2 : 1;
  const presets = SCENARIO_PRESETS.filter((p) => p.meta.stage <= stage);
  const preset = presets.find((p) => p.scenario.id === presetId) ?? presets[0]!;
  const unsupportedKinds = preset.scenario.events.filter((e) => !rt.capabilities.eventKinds.includes(e.change.kind)).map((e) => e.change.kind);
  const config: RunConfig = { ...defaultRunConfig(mode, NO_FEATURES), horizonMs: horizon, ratingEveryMs: ratingMode === 'periodic' ? 30 * 60_000 : null };
  const manifest = preview.kind === 'ready' && parkSummary ? buildManifest({ park: parkSummary.artifact, population: preview.artifact, scenario: preset.scenario, seed, config }) : null;
  const [planHash, setPlanHash] = useState<string | null>(null);
  useEffect(() => { let live = true; if (manifest) void canonicalHash(manifest).then((h) => live && setPlanHash(h)); else setPlanHash(null); return () => { live = false; }; }, [manifest ? canonicalJson(manifest) : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const localModeReason = rt.settings.profile !== 'live' || rt.settings.behaviorProvider !== 'laya' ? 'Start the stack with BEHAVIOR_PROVIDER=laya.' : null;
  const liveModeReason = rt.settings.profile === 'fixture' ? 'The fixture profile has no Jev connection; Live Jev needs the live profile.' : rt.settings.behaviorProvider === 'laya' ? 'This stack is running Local Laya. Restart with BEHAVIOR_PROVIDER=jev for Jev.' : null;
  const createReason = !isOperator ? 'Only operator sessions can create runs.'
    : !parkSummary ? 'Choose a park.' : parkSummary.status !== 'ready' ? `Park is ${parkSummary.status}.`
      : !park ? 'Loading park…'
        : check.errors.length ? 'Fix the crowd settings first.'
          : preview.kind === 'failed' ? 'Sampling the crowd failed; retry it.'
            : preview.kind !== 'ready' ? 'Sampling guests…'
              : unsupportedKinds.length ? `The server does not support ${unsupportedKinds.join(', ')} events.`
                : mode === 'local' && localModeReason ? localModeReason
                : mode === 'live' && liveModeReason ? liveModeReason
                  : rt.settings.profile === 'fixture' && horizon > 4 * 3600_000 ? 'Fixture scenes cover at most 4 hours.' : !planHash ? 'Preparing plan…' : null;

  const create = async () => {
    if (!manifest || !planHash) return;
    setCreating(true); setCreateError(null);
    const out = await rt.runner.run('createRun', { manifest }, `create:${planHash}`, { durable: true });
    setCreating(false);
    if (out.kind === 'accepted') {
      await rt.refreshSession();
      // The live view starts the run as soon as Engine reports it ready (one click from here).
      navigate(`/runs/${encodeURIComponent(out.result.runId)}`, { state: { autostart: true } });
    } else setCreateError({ error: out.error, transport: out.kind === 'transport' });
  };

  if (!isOperator) {
    return <Alert tone="info" title="View-only access">This session can view shared simulations but cannot start new ones.</Alert>;
  }
  return (
    <div data-testid="setup-page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link to="/">Simulations</Link><span aria-hidden="true">/</span><span>New</span></div>
          <h1>New simulation</h1>
          <p>Pick a crowd and a scenario. Defaults are ready to go.</p>
        </div>
      </div>
      <div className="setup-grid">
        <div className="setup-form">
          <section className="setup-step" aria-labelledby="step-park">
            <div className="step-head"><span className="n">01</span><h2 id="step-park">Park</h2></div>
            {parks.error && <ErrorBox error={parks.error} transport={parks.transport} />}
            {!parks.data && !parks.error && <Spinner label="Loading parks…" />}
            <div className="choice-grid">
              {parks.data?.items.map((s) => {
                const reason = s.status === 'preparing' ? 'Waiting for asset validation to finish.' : s.status === 'invalid' ? 'This park failed validation.' : null;
                const selected = parkSummary?.artifact.artifactId === s.artifact.artifactId;
                return (
                  <button key={s.artifact.artifactId} type="button" className="choice" aria-pressed={selected} disabled={Boolean(reason)} onClick={() => void choosePark(s)} data-testid={`choose-park-${s.revision}`}>
                    <span className="title">{parkTitle(s, topRank, parks.data!.items.length)}</span>
                    <span className="sub">{parkSize(s) ? `${parkSize(s)} attractions` : s.revision.includes('-s1-') ? 'Smaller layout' : 'Every attraction'}</span>
                    <span className="corner">{s.status === 'ready' ? (selected ? <span className="badge ok plain">Selected</span> : null) : <span className={`badge ${s.status === 'preparing' ? 'info' : 'bad'}`}>{s.status === 'preparing' ? 'Preparing' : 'Invalid'}</span>}</span>
                    {reason && <span className="sub">{reason}</span>}
                    {s.issues.length > 0 && <span className="sub" style={{ color: 'var(--bad)' }}>{s.issues.join(' ')}</span>}
                  </button>
                );
              })}
            </div>
            {parkError && <Alert tone="bad" title="Park artifact rejected">{parkError}</Alert>}
          </section>

          <section className="setup-step" aria-labelledby="step-crowd">
            <div className="step-head"><span className="n">02</span><h2 id="step-crowd">Crowd</h2></div>
            <CrowdEditor guestCount={guestCount} setGuestCount={setGuestCount} mix={mix} setMix={setMix} notes={notes} setNotes={setNotes} check={check} crowd={crowd} />
          </section>

          <section className="setup-step" aria-labelledby="step-scenario">
            <div className="step-head"><span className="n">03</span><h2 id="step-scenario">Scenario</h2></div>
            <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-labelledby="step-scenario">
              {presets.map((p) => <PresetOption key={p.scenario.id} p={p} park={park} checked={p.scenario.id === preset.scenario.id} onChange={() => setPresetId(p.scenario.id)} supported={p.scenario.events.every((e) => rt.capabilities.eventKinds.includes(e.change.kind))} />)}
            </div>
            <p className="note">To compare a baseline with a variant across paired seeds, use <Link to="/experiments/new">Compare A/B</Link>.</p>
          </section>

          <Disclosure summary="Advanced settings" count="seed, provider, horizon, ratings">
            <div className="grid-2">
              <label className="field"><span className="label">Seed</span>
                <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><input type="text" value={seed} onChange={(e) => setSeed(e.target.value)} className="grow" /><button type="button" className="btn small" onClick={() => setSeed(newSeed())}>New seed</button></span>
                <span className="hint">Same seed and crowd give the same population.</span>
              </label>
              <label className="field"><span className="label">Behavior provider</span>
                <select value={mode} onChange={(e) => {
                  const m = e.target.value as Mode;
                  setMode(m);
                  // Live Jev is billable per decision: suggest a smaller crowd when switching from the default.
                  if ((m === 'live' || m === 'local') && guestCount === DEFAULT_GUESTS) { setGuestCount(DEFAULT_LIVE_GUESTS); setMix(fitMix(mix, DEFAULT_LIVE_GUESTS)); }
                }} data-testid="mode-select">
                  <option value="mock">Mock (deterministic mock provider)</option>
                  <option value="local" disabled={Boolean(localModeReason)}>Local Laya{localModeReason ? ' (unavailable)' : ''}</option>
                  <option value="live" disabled={Boolean(liveModeReason)}>Live Jev{liveModeReason ? ' (unavailable)' : ''}</option>
                </select>
                {mode === 'local' ? <span className="hint">On-device decisions and ratings. No API charges; explanations are templates.</span> : liveModeReason && <span className="hint">{liveModeReason}</span>}
              </label>
              <label className="field"><span className="label">Operating horizon</span>
                <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
                  {HORIZON_OPTIONS_MS.map((h) => <option key={h} value={h}>{formatDuration(h)}{park ? ` (to ${formatSimClock(Math.min(h, park.park.closeAfterMs), park.park.openLocal)})` : ''}</option>)}
                </select>
              </label>
              <label className="field"><span className="label">Satisfaction ratings</span>
                <select value={ratingMode} onChange={(e) => setRatingMode(e.target.value as 'periodic' | 'terminal')}>
                  <option value="periodic">Every 30 sim-min + departure</option>
                  <option value="terminal">Departure/horizon only</option>
                </select>
              </label>
            </div>
            <FeatureNote />
          </Disclosure>
        </div>

        <aside className="summary-card" aria-label="Simulation summary">
          <div className="panel stack" style={{ gap: 16 }}>
            {park ? <ParkThumb park={park} /> : <div className="thumb-iso" style={{ height: 250 }} aria-hidden="true" />}
            <div>
              <h2 style={{ marginBottom: 2 }}>{parkSummary ? parkTitle(parkSummary, topRank, parks.data?.items.length ?? 1) : 'Harbor Lights'}</h2>
              <p className="small muted" style={{ margin: 0 }}>{preset.scenario.label}{park ? ` · opens ${park.park.openLocal} · ${formatDuration(horizon)}` : ''}</p>
            </div>
            <PreviewView preview={preview} hasPark={Boolean(parkSummary)} onRetry={() => void requestPreview()} />
            <ActionButton tone="primary" large block onClick={() => void create()} busy={creating} disabledReason={createReason} hideReason={createReason === 'Sampling guests…' || createReason === 'Preparing plan…' || createReason === 'Loading park…'} testId="create-run">
              <Icon name="play" />Start simulation
            </ActionButton>
            {createError && <ErrorBox error={createError.error} transport={createError.transport} onRetry={() => void create()} retryLabel="Retry (same command ID)" />}
            {manifest && park && preview.kind === 'ready' && (
              <Disclosure summary="Run plan details" testId="frozen-plan-details">
                <FrozenPlan manifest={manifest} park={park} summary={summarizePopulation(preview.manifest)} planHash={planHash} />
                <PopulationDetails manifest={preview.manifest} artifact={preview.artifact} mix={mix} />
              </Disclosure>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

/** Attraction count parsed from the registered label ("… 15 attractions") or 0. */
export function parkSize(s: ParkSummary): number {
  const m = /(\d+)\s+(attractions|destinations)/i.exec(s.label);
  return m ? Number(m[1]) : 0;
}
/** Ranking for the default pick: attraction count, else the content stage in the revision (s2 > s1). */
const parkRank = (s: ParkSummary) => parkSize(s) * 100 + Number(/-s(\d+)-/.exec(s.revision)?.[1] ?? 0);
/** "Harbor Lights — full park" for the most complete version, "Harbor Lights — starter" otherwise. */
export function parkTitle(s: ParkSummary, topRank: number, count: number): string {
  const base = s.label.replace(/\s*\(.*\)\s*$/, '');
  if (count < 2) return base;
  return `${base} — ${parkRank(s) === topRank ? 'full park' : 'starter'}`;
}

function ParkThumb(props: { park: LoadedPark }) {
  const { park, codes } = props.park;
  const attractions = park.places.filter((p) => p.kind === 'ride' || p.kind === 'show').length;
  return <ParkPreview park={park} codes={codes} className="thumb-iso" height={250} label={`${park.label}: ${attractions} attractions`} />;
}

export function CrowdEditor(props: {
  guestCount: number; setGuestCount: (n: number) => void; mix: GuestMix; setMix: (m: GuestMix) => void;
  notes: string; setNotes: (s: string) => void; check: { errors: string[]; warnings: string[] }; crowd: CrowdSpec;
}) {
  const rt = useRuntime();
  const total = sumMix(props.mix);
  const max = rt.capabilities.maxGuests;
  const [text, setText] = useState('');
  const [proposal, setProposal] = useState<{ proposal: CrowdSpec; assumptions: string[]; unsupported: string[] } | { error: DomainError } | 'pending' | null>(null);
  const parse = async () => {
    setProposal('pending');
    const out = await rt.runner.run('requestProductWork', { request: { kind: 'parse_crowd', text, current: props.crowd } }, `parse-crowd:${Date.now()}`);
    if (out.kind !== 'accepted') { setProposal({ error: out.error }); return; }
    try {
      const st = await awaitWork<'parse_crowd'>(rt.client, out.result.workId);
      setProposal(st.status === 'ready' && st.result ? st.result : { error: st.error ?? { code: 'INCOMPLETE', message: `Parser ${st.status}.`, retryable: true, fieldErrors: [] } });
    } catch (e) { setProposal({ error: classifyError(e).error }); }
  };
  // Changing the size keeps the current proportions (largest-remainder rescale).
  const setSize = (n: number) => {
    props.setGuestCount(n);
    if (Number.isInteger(n) && n >= 1 && n <= max) props.setMix(fitMix(props.mix, n));
  };
  const setOne = (a: Archetype, v: number) => props.setMix({ ...props.mix, [a]: Math.max(0, Math.round(v)) });
  const presets = [100, 300, 500, 1000, 2000].filter((n) => n <= max);
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="field">
        <label className="label" htmlFor="guest-count">Guests</label>
        <div className="size-row">
          <input type="range" min={1} max={max} value={Math.min(props.guestCount || 0, max)} onChange={(e) => setSize(Number(e.target.value))} aria-label="Crowd size slider" aria-valuetext={`${props.guestCount} guests`} />
          <input id="guest-count" type="number" min={1} max={max} value={props.guestCount} onChange={(e) => setSize(Number(e.target.value))} data-testid="guest-count" />
        </div>
        <div className="size-presets">
          {presets.map((n) => <button key={n} type="button" className="btn small" aria-pressed={props.guestCount === n} onClick={() => setSize(n)}>{n}</button>)}
        </div>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <div className="mix-bar" aria-hidden="true">
          {ARCHETYPE_ORDER.filter((a) => props.mix[a] > 0).map((a) => <span key={a} style={{ flex: props.mix[a], background: ARCHETYPE_TINT[a] }} />)}
        </div>
        <div className="mix-legend">
          {ARCHETYPE_ORDER.map((a) => <span key={a}><i style={{ background: ARCHETYPE_TINT[a] }} />{ARCHETYPE_LABEL[a]} <span className="faint num">{props.mix[a]}</span></span>)}
        </div>
      </div>
      {props.check.errors.length > 0 && <Alert tone="bad" title="Crowd settings need attention"><ul className="note-list">{props.check.errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
      {props.check.warnings.map((w) => <p key={w} className="note">{w}</p>)}
      <div>
        <Disclosure summary="Customize the mix" count={`${total} of ${props.guestCount} assigned`}>
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 8 }}>
            <legend className="sr-only">Archetype mix in guests</legend>
            {ARCHETYPE_ORDER.map((a) => (
              <div key={a} className="slider-row">
                <label htmlFor={`mix-${a}`} className="small">{ARCHETYPE_LABEL[a]}</label>
                <input id={`mix-${a}`} type="range" min={0} max={Math.max(props.guestCount, props.mix[a])} value={props.mix[a]} onChange={(e) => setOne(a, Number(e.target.value))} aria-valuetext={`${props.mix[a]} guests`} />
                <input type="number" min={0} value={props.mix[a]} onChange={(e) => setOne(a, Number(e.target.value))} aria-label={`${ARCHETYPE_LABEL[a]} guests`} data-testid={`mix-${a}`} />
              </div>
            ))}
            <div className="spread small">
              <span className="muted" aria-live="polite">Assigned {total} of {props.guestCount} guests.</span>
              <button type="button" className="btn small" onClick={() => props.setMix(fitMix(props.mix, props.guestCount))} disabled={total === props.guestCount}>Fit to crowd size</button>
            </div>
            <p className="note">Counts are individual guests; the population service forms families and friend groups, which can shift a few guests between archetypes.</p>
          </fieldset>
        </Disclosure>
        <Disclosure summary="Describe the crowd in words">
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 350 guests, mostly families, fewer teens" maxLength={500} aria-label="Describe the crowd in words" />
          <div><ActionButton small onClick={() => void parse()} busy={proposal === 'pending'} disabledReason={!text.trim() ? 'Write a description first.' : null} hideReason>Propose a mix</ActionButton></div>
          {proposal && proposal !== 'pending' && 'error' in proposal && <ErrorBox error={proposal.error} />}
          {proposal && proposal !== 'pending' && 'proposal' in proposal && (
            <div className="panel tight stack" data-testid="crowd-proposal" style={{ gap: 8 }}>
              <b>Proposed crowd</b>
              <table className="small"><thead><tr><th>Archetype</th><th className="num">Now</th><th className="num">Proposed</th></tr></thead>
                <tbody>{(() => { const pm = mixFromShares(proposal.proposal.shares, proposal.proposal.guestCount); return ARCHETYPE_ORDER.map((a) => <tr key={a}><td>{ARCHETYPE_LABEL[a]}</td><td className="num">{props.mix[a]}</td><td className="num">{pm[a]}</td></tr>); })()}
                  <tr><td><b>Total</b></td><td className="num">{props.guestCount}</td><td className="num">{proposal.proposal.guestCount}</td></tr></tbody></table>
              {proposal.assumptions.length > 0 && <><h4>Assumptions</h4><ul className="note-list">{proposal.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></>}
              {proposal.unsupported.length > 0 && <><h4>Not modeled</h4><ul className="note-list">{proposal.unsupported.map((x) => <li key={x}>{x}</li>)}</ul></>}
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="btn small primary" onClick={() => { props.setGuestCount(proposal.proposal.guestCount); props.setMix(mixFromShares(proposal.proposal.shares, proposal.proposal.guestCount)); props.setNotes(proposal.proposal.contextNotes); setProposal(null); }}>Accept proposal</button>
                <button type="button" className="btn small" onClick={() => setProposal(null)}>Dismiss</button>
              </div>
            </div>
          )}
          <label className="field"><span className="label">Context notes</span>
            <input type="text" value={props.notes} onChange={(e) => props.setNotes(e.target.value)} placeholder="e.g. school holiday week" maxLength={500} />
            <span className="hint">Recorded with the run; weather or day of week has no mechanic in v1.</span>
          </label>
        </Disclosure>
      </div>
    </div>
  );
}

function PreviewView(props: { preview: Preview; hasPark: boolean; onRetry: () => void }) {
  const p = props.preview;
  if (p.kind === 'none' && !props.hasPark) return <p className="small faint" style={{ margin: 0 }}>Choose a park to sample a crowd.</p>;
  if (p.kind === 'pending' || p.kind === 'none') return <div className="summary-stats" aria-busy="true"><div style={{ gridColumn: '1 / -1' }}><Spinner label="Sampling guests…" /></div></div>;
  if (p.kind === 'failed') return <ErrorBox error={p.error} transport={p.transport} onRetry={props.onRetry} retryLabel="Sample again" />;
  const s = summarizePopulation(p.manifest);
  const lead = p.manifest.personas.find((x) => x.agentId === p.manifest.groups[0]?.leaderId);
  return (
    <div className="stack" style={{ gap: 12 }} data-testid="population-preview">
      <div className="summary-stats">
        <div><div className="k">Guests</div><div className="v">{s.guests}</div></div>
        <div><div className="k">Groups</div><div className="v">{s.groups}</div></div>
        <div><div className="k">Children</div><div className="v">{s.children}</div></div>
        <div><div className="k">Median group budget</div><div className="v">{formatCents(s.budgets.median)}</div></div>
      </div>
      {lead && (
        <div className="persona-card">
          <div className="who">{ARCHETYPE_LABEL[lead.archetype]} <span className="faint small">· {lead.role}, {lead.ageYears}</span></div>
          <p className="small muted" style={{ margin: 0 }}>{lead.backstory}</p>
        </div>
      )}
    </div>
  );
}

function PopulationDetails(props: { manifest: PopulationManifest; artifact: ArtifactRef; mix: GuestMix }) {
  const s = summarizePopulation(props.manifest);
  const m = props.manifest;
  const examples = ARCHETYPE_ORDER.map((a) => m.groups.find((g) => m.personas.find((x) => x.agentId === g.leaderId)?.archetype === a)).filter(Boolean);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <h4 style={{ margin: 0 }}>Population</h4>
      <KV items={[['Population', <span className="mono" key="p">{m.populationId}</span>], ['Artifact hash', <span className="hash" key="h">{props.artifact.sha256}</span>],
        ['Versions', `generator ${m.crowd.generatorVersion} · prose ${m.proseVersion} · random ${m.randomVersion}`],
        ['With the app', String(s.withApp)], ['Group budgets', `${formatCents(s.budgets.min)} – ${formatCents(s.budgets.max)}, shared per group`],
        ['Group sizes', Object.entries(s.groupSizes).sort().map(([k, v]) => `${v} × ${k}`).join(', ')]]} />
      <table className="small"><thead><tr><th>Archetype</th><th className="num">Requested guests</th><th className="num">Realized</th></tr></thead>
        <tbody>{ARCHETYPE_ORDER.map((a) => <tr key={a}><td>{ARCHETYPE_LABEL[a]}</td><td className="num">{props.mix[a]}</td><td className="num">{s.realized[a]}{s.realized[a] !== props.mix[a] ? ' *' : ''}</td></tr>)}</tbody></table>
      {ARCHETYPE_ORDER.some((a) => s.realized[a] !== props.mix[a]) && <p className="note">* Groups must be feasible (e.g. families of 3–5), so a few guests moved between archetypes. The realized mix is what runs.</p>}
      <h4 style={{ margin: 0 }}>Example groups</h4>
      <ul className="card-list">
        {examples.map((g) => {
          const lead = m.personas.find((x) => x.agentId === g!.leaderId)!;
          return (
            <li key={g!.groupId} className="persona-card">
              <div className="who">{ARCHETYPE_LABEL[lead.archetype]} <span className="faint small">· {g!.memberIds.length} member(s) · {formatCents(g!.startingBalanceCents)} · arrives +{formatDuration(g!.arrivalMs)}</span></div>
              <p className="small muted" style={{ margin: 0 }}>{lead.backstory}</p>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PresetOption(props: { p: ScenarioPreset; park: LoadedPark | null; checked: boolean; onChange: () => void; supported: boolean }) {
  const rt = useRuntime();
  const changes = props.park ? props.p.scenario.events.map((e) => `${describeChange(e.change, props.park!.park, rt.capabilities.features.discountMessages).operation} at ${eventTime(e, props.park!.park)}`) : [];
  return (
    <label className="choice" style={{ minHeight: 0, opacity: props.supported ? 1 : 0.55 }}>
      <input type="radio" name="preset" checked={props.checked} onChange={props.onChange} disabled={!props.supported} data-testid={`preset-${props.p.scenario.id}`} />
      <span className="spread" style={{ gap: 8 }}>
        <span className="title">{props.p.scenario.label}</span>
        
      </span>
      <span className="sub">{props.p.meta.summary}</span>
      {changes.length > 0 && <span className="tiny faint">{changes.join(' · ')}</span>}
      {!props.supported && <span className="sub" style={{ color: 'var(--bad)' }}>Not supported by this server.</span>}
    </label>
  );
}

function FeatureNote() {
  const rt = useRuntime();
  const f = rt.capabilities.features;
  const on = Object.entries(f).filter(([, v]) => v).map(([k]) => k);
  const off = Object.entries(f).filter(([, v]) => !v).map(([k]) => k);
  return <p className="note">Optional features supported by this server: {on.join(', ') || 'none'}. Not available: {off.join(', ') || 'none'}. Features are off for this run.</p>;
}

function FrozenPlan(props: { manifest: ReturnType<typeof buildManifest>; park: LoadedPark; summary: ReturnType<typeof summarizePopulation>; planHash: string | null }) {
  const m = props.manifest;
  const c = m.config;
  const rt = useRuntime();
  return (
    <section aria-label="Frozen plan" data-testid="frozen-plan" className="stack" style={{ gap: 10 }}>
      <h4 style={{ margin: 0 }}>Frozen plan</h4>
      <KV items={[
        ['Park', `${props.park.park.label} · ${props.park.park.revision}`], ['Guests / groups', `${props.summary.guests} / ${props.summary.groups}`],
        ['Seed', <span className="mono" key="s">{m.replicateSeed}</span>], ['Horizon', `${formatDuration(c.horizonMs)} (${props.park.park.openLocal} to ${formatSimClock(c.horizonMs, props.park.park.openLocal)})`],
        ['Scenario', `${m.scenario.label} (rev ${m.scenario.revision})`],
        ['Events', m.scenario.events.length ? m.scenario.events.map((e) => `${describeChange(e.change, props.park.park, rt.capabilities.features.discountMessages).operation}: ${describeChange(e.change, props.park.park, false).value} at ${eventTime(e, props.park.park)}`).join(' | ') : 'none (baseline)'],
        ['Provider', c.mode === 'mock' ? 'Mock provider (not a real-Jev comparison)' : c.mode === 'local' ? 'Local Laya (on-device inference)' : 'Live Jev'],
        ['Ratings', c.ratingEveryMs ? 'every 30 sim-min + departure/horizon' : 'departure/horizon only'],
        ['Steps', '5,000 ms logical steps, 250 ms movement substeps, temperature 1'],
        ['Fallback', c.fallback === 'forbidden' ? 'forbidden (clock waits for inference)' : `live timeout fallback after ${c.liveTimeoutMs} ms (marks run degraded)`],
        ['Plan hash', props.planHash ? <span className="hash" key="h">{props.planHash}</span> : '…'],
      ]} />
      <p className="note">Capacities and prices are synthetic inputs, not measured facts. The engine describes outcomes; it does not optimize or pick a best option.</p>
    </section>
  );
}
