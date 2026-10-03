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
import { ActionButton, Alert, ErrorBox, Explain, KV, Panel, Spinner } from '../../ui/components';
import { formatCents, formatDuration, formatSimClock } from '../../ui/format';
import { decorFor } from '../../content/harborLights';
import { paintParkCanvas } from '../../renderer/parkCanvas';
import { describeChange, eventTime } from '../scenarios/describe';
import { ARCHETYPE_LABEL, ARCHETYPE_ORDER, buildCrowd, DEFAULT_GUESTS, defaultMix, fitMix, mixFromShares, summarizePopulation, sumMix, validateCrowd, type GuestMix } from './crowd';
import { buildManifest, defaultRunConfig, HORIZON_OPTIONS_MS, NO_FEATURES } from './plan';

type Preview =
  | { kind: 'none' }
  | { kind: 'stale'; reason: string }
  | { kind: 'pending'; status: WorkStatus['status'] | 'requesting' }
  | { kind: 'failed'; error: DomainError; transport: boolean }
  | { kind: 'ready'; crowdKey: string; artifact: ArtifactRef; manifest: PopulationManifest };

const newSeed = () => `seed-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;

export function SetupPage() {
  const rt = useRuntime();
  const navigate = useNavigate();
  const isOperator = rt.session?.roles.includes('operator') ?? false;
  const parks = useAsync(() => rt.client.query('listParks', { cursor: null }), [rt.client], { pollMs: 2000 });
  const [parkSummary, setParkSummary] = useState<ParkSummary | null>(null);
  const [park, setPark] = useState<LoadedPark | null>(null);
  const [parkError, setParkError] = useState<string | null>(null);
  const [guestCount, setGuestCount] = useState(DEFAULT_GUESTS);
  const [mix, setMix] = useState<GuestMix>(defaultMix());
  const [seed, setSeed] = useState('seed-001');
  const [notes, setNotes] = useState('');
  const [rawPreview, setPreview] = useState<Preview>({ kind: 'none' });
  const [presetId, setPresetId] = useState('baseline');
  const [mode, setMode] = useState<Mode>('mock');
  const [horizon, setHorizon] = useState(3 * 3600_000);
  const [ratingMode, setRatingMode] = useState<'periodic' | 'terminal'>('periodic');
  const [createError, setCreateError] = useState<{ error: DomainError; transport: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const crowd: CrowdSpec = useMemo(() => buildCrowd(guestCount, mix, seed, notes), [guestCount, mix, seed, notes]);
  const crowdKey = canonicalJson({ crowd, park: park?.park.revision ?? null });
  const check = validateCrowd(guestCount, mix, rt.capabilities.maxGuests);

  // Editing crowd, seed or park invalidates the preview: never reuse an old manifest invisibly.
  const preview: Preview = rawPreview.kind === 'ready' && rawPreview.crowdKey !== crowdKey
    ? { kind: 'stale', reason: 'Crowd, seed or park changed after the preview. Generate a new preview.' } : rawPreview;

  const choosePark = async (s: ParkSummary) => {
    setParkSummary(s); setPark(null); setParkError(null);
    try { setPark(await loadPark(rt.client, s.artifact)); } catch (e) { setParkError(e instanceof Error ? e.message : classifyError(e).error.message); }
  };

  const requestPreview = async () => {
    if (!parkSummary) return;
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    const key = crowdKey;
    setPreview({ kind: 'pending', status: 'requesting' });
    const out = await rt.runner.run('requestProductWork', { request: { kind: 'population', crowd, park: parkSummary.artifact } }, `population:${await canonicalHash({ crowd, park: parkSummary.artifact.sha256 })}`);
    if (out.kind !== 'accepted') { setPreview({ kind: 'failed', error: out.error, transport: out.kind === 'transport' }); return; }
    try {
      const st = await awaitWork<'population'>(rt.client, out.result.workId, { signal: ctrl.signal, onStatus: (s) => setPreview({ kind: 'pending', status: s.status }) });
      if (st.status !== 'ready' || !st.result) { setPreview({ kind: 'failed', error: st.error ?? { code: 'INCOMPLETE', message: `Population job ${st.status}.`, retryable: true, fieldErrors: [] }, transport: false }); return; }
      const json = await fetchVerifiedJson(rt.client, st.result.artifact);
      const v = validate<PopulationManifest>(populationManifestSchema, json);
      if (!v.ok) throw new Error(`Population artifact failed validation: ${v.issues.join('; ')}`);
      if (v.value.parkHash !== parkSummary.artifact.sha256) throw new Error('Population was generated for a different park artifact.');
      if (canonicalJson(v.value.crowd) !== canonicalJson(crowd)) throw new Error('Population artifact crowd does not match the requested crowd.');
      setPreview({ kind: 'ready', crowdKey: key, artifact: st.result.artifact, manifest: v.value });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setPreview({ kind: 'failed', error: e instanceof Error && !('error' in e) ? { code: 'INVALID_INPUT', message: e.message, retryable: false, fieldErrors: [] } : classifyError(e).error, transport: classifyError(e).transport });
    }
  };

  const stage = park?.park.places.some((p) => p.id === 'river_rapids') ? 2 : 1;
  const presets = SCENARIO_PRESETS.filter((p) => p.meta.stage <= stage);
  const preset = presets.find((p) => p.scenario.id === presetId) ?? presets[0]!;
  const unsupportedKinds = preset.scenario.events.filter((e) => !rt.capabilities.eventKinds.includes(e.change.kind)).map((e) => e.change.kind);
  const config: RunConfig = { ...defaultRunConfig(mode, NO_FEATURES), horizonMs: horizon, ratingEveryMs: ratingMode === 'periodic' ? 30 * 60_000 : null };
  const manifest = preview.kind === 'ready' && parkSummary ? buildManifest({ park: parkSummary.artifact, population: preview.artifact, scenario: preset.scenario, seed, config }) : null;
  const [planHash, setPlanHash] = useState<string | null>(null);
  useEffect(() => { let live = true; if (manifest) void canonicalHash(manifest).then((h) => live && setPlanHash(h)); else setPlanHash(null); return () => { live = false; }; }, [manifest ? canonicalJson(manifest) : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const liveModeReason = rt.settings.profile === 'fixture' ? 'The fixture profile has no Jev connection; Live Jev needs the live profile.' : null;
  const createReason = !isOperator ? 'Only operator sessions can create runs.'
    : !parkSummary ? 'Choose a park.' : parkSummary.status !== 'ready' ? `Park is ${parkSummary.status}.`
      : check.errors.length ? 'Fix the crowd settings first.'
        : preview.kind === 'pending' ? 'Population preview is still running.'
          : preview.kind === 'failed' ? 'Population preview failed; retry it.'
            : preview.kind === 'stale' ? 'Preview is out of date; generate a new one.'
              : preview.kind !== 'ready' ? 'Generate and review a population preview first.'
                : unsupportedKinds.length ? `The server does not support ${unsupportedKinds.join(', ')} events.`
                  : mode === 'live' && liveModeReason ? liveModeReason
                    : rt.settings.profile === 'fixture' && horizon > 4 * 3600_000 ? 'Fixture scenes cover at most 4 hours.' : !planHash ? 'Computing plan hash…' : null;

  const create = async () => {
    if (!manifest || !planHash) return;
    setCreating(true); setCreateError(null);
    const out = await rt.runner.run('createRun', { manifest }, `create:${planHash}`, { durable: true });
    setCreating(false);
    if (out.kind === 'accepted') {
      await rt.refreshSession();
      navigate(`/runs/${encodeURIComponent(out.result.runId)}`);
    } else setCreateError({ error: out.error, transport: out.kind === 'transport' });
  };

  if (!isOperator) {
    return <Alert tone="info" title="Operator session required">Creating runs needs an operator session. <Link to="/session">Sign in</Link> or open a run from a share link.</Alert>;
  }
  const step = !park ? 1 : preview.kind !== 'ready' ? 2 : 3;
  return (
    <div className="stack" data-testid="setup-page">
      <div>
        <h1>New run</h1>
        <p className="muted">Frame a descriptive question (for example: does a higher pass price change revenue without reducing satisfaction?). The engine does not optimize or pick a "best" option.</p>
        <ol className="steps" aria-label="Setup progress">
          <li aria-current={step === 1 ? 'step' : undefined}>1 Park</li>
          <li aria-current={step === 2 ? 'step' : undefined}>2 Crowd and preview</li>
          <li aria-current={step === 3 ? 'step' : undefined}>3 Scenario and frozen plan</li>
        </ol>
      </div>

      <Panel title="1. Park">
        {parks.error && <ErrorBox error={parks.error} transport={parks.transport} />}
        {!parks.data && !parks.error && <Spinner label="Loading registered parks…" />}
        <div className="grid-2">
          {parks.data?.items.map((s) => (
            <div key={s.artifact.artifactId} className="panel tight stack" style={{ gap: 6 }}>
              <div className="spread"><b>{s.label}</b><span className={`badge ${s.status === 'ready' ? 'ok' : s.status === 'preparing' ? 'info' : 'bad'}`}>{s.status === 'preparing' ? '… preparing' : s.status === 'ready' ? '✓ ready' : '✕ invalid'}</span></div>
              <span className="small muted mono">{s.parkId} · {s.revision}</span>
              {s.issues.length > 0 && <ul className="small" style={{ color: 'var(--bad-ink)' }}>{s.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
              <ActionButton small onClick={() => void choosePark(s)} disabledReason={s.status === 'preparing' ? 'Waiting for asset validation to finish.' : s.status === 'invalid' ? 'This park failed validation.' : null}
                testId={`choose-park-${s.revision}`}>{parkSummary?.artifact.artifactId === s.artifact.artifactId ? 'Selected' : 'Select'}</ActionButton>
            </div>
          ))}
        </div>
        {parkError && <Alert tone="bad" title="Park artifact rejected">{parkError}</Alert>}
        {park && <ParkPreview park={park} />}
      </Panel>

      {park && (
        <Panel title="2. Describe the crowd">
          <CrowdEditor guestCount={guestCount} setGuestCount={setGuestCount} mix={mix} setMix={setMix} seed={seed} setSeed={setSeed} notes={notes} setNotes={setNotes} check={check} crowd={crowd} />
          <div className="row" style={{ marginTop: 12 }}>
            <ActionButton tone="primary" onClick={() => void requestPreview()} busy={preview.kind === 'pending'} disabledReason={check.errors.length ? 'Fix the crowd settings first.' : null} testId="request-preview">Generate population preview</ActionButton>
            <span className="small muted">The population service samples people and groups; this browser never generates personas.</span>
          </div>
          <PreviewView preview={preview} mix={mix} onRetry={() => void requestPreview()} />
        </Panel>
      )}

      {preview.kind === 'ready' && park && parkSummary && (
        <Panel title="3. Scenario, settings and frozen plan">
          <fieldset className="stack" style={{ border: 0, padding: 0 }}>
            <legend className="label" style={{ fontWeight: 600 }}>Scenario</legend>
            {presets.map((p) => <PresetOption key={p.scenario.id} p={p} park={park} checked={p.scenario.id === preset.scenario.id} onChange={() => setPresetId(p.scenario.id)} supported={p.scenario.events.every((e) => rt.capabilities.eventKinds.includes(e.change.kind))} />)}
          </fieldset>
          <p className="small muted">To compare a baseline with a variant across paired seeds, use <Link to="/experiments/new">Compare A/B</Link>.</p>
          <div className="grid-3" style={{ marginTop: 8 }}>
            <label className="field"><span className="label">Mode</span>
              <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} data-testid="mode-select">
                <option value="mock">Mock (deterministic mock provider)</option>
                <option value="live" disabled={Boolean(liveModeReason)}>Live Jev{liveModeReason ? ' (unavailable)' : ''}</option>
              </select>
              {liveModeReason && <span className="small muted">{liveModeReason}</span>}
            </label>
            <label className="field"><span className="label">Operating horizon</span>
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
                {HORIZON_OPTIONS_MS.map((h) => <option key={h} value={h}>{formatDuration(h)} (to {formatSimClock(Math.min(h, park.park.closeAfterMs), park.park.openLocal)})</option>)}
              </select>
            </label>
            <label className="field"><span className="label">Satisfaction ratings</span>
              <select value={ratingMode} onChange={(e) => setRatingMode(e.target.value as 'periodic' | 'terminal')}>
                <option value="periodic">Every 30 sim-min + departure/horizon</option>
                <option value="terminal">Departure/horizon only (constrained)</option>
              </select>
            </label>
          </div>
          <FeatureNote />
          {manifest && <FrozenPlan manifest={manifest} park={park} summary={summarizePopulation(preview.manifest)} planHash={planHash} preset={preset} />}
          <div className="row" style={{ marginTop: 12 }}>
            <ActionButton tone="primary" onClick={() => void create()} busy={creating} disabledReason={createReason} testId="create-run">Create run</ActionButton>
            <span className="small muted">Creation and start are separate: the run prepares first, then you start it.</span>
          </div>
          {createError && <ErrorBox error={createError.error} transport={createError.transport} onRetry={() => void create()} retryLabel="Retry (same command ID)" />}
        </Panel>
      )}
    </div>
  );
}

function ParkPreview(props: { park: LoadedPark }) {
  const { park, codes } = props.park;
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = paintParkCanvas(codes, park.grid.width, park.grid.height, 2, decorFor(new Set(park.places.map((p) => p.id))));
    const target = ref.current;
    if (!target) return;
    target.width = c.width; target.height = c.height;
    target.getContext('2d')?.drawImage(c, 0, 0);
  }, [park, codes]);
  const attractions = park.places.filter((p) => p.kind === 'ride' || p.kind === 'show');
  return (
    <div className="grid-2" style={{ marginTop: 12 }}>
      <canvas ref={ref} className="park-thumb" role="img" aria-label={`Map of ${park.label}: ${park.grid.width} by ${park.grid.height} metres`} />
      <div className="stack small">
        <KV items={[['Revision', <span className="mono" key="r">{park.revision}</span>], ['Grid', `${park.grid.width} x ${park.grid.height} cells at ${park.grid.cellM} m`],
          ['Hours', `${park.openLocal} for ${formatDuration(park.closeAfterMs)}`], ['Harbor Pass', `${formatCents(park.pass.unitPriceCents)} per guest, rest of day`],
          ['Attractions', `${attractions.length} (rides and shows only)`], ['Queue zones', String(park.queueZones.length)], ['Grid hash', <span className="hash" key="h">{park.grid.cellsSha256}</span>]]} />
        <details className="explain"><summary>Places</summary>
          <ul>{park.places.map((p) => <li key={p.id}>{p.name} <span className="muted">({p.kind}{p.minHeightCm ? `, min ${p.minHeightCm} cm` : ''})</span></li>)}</ul>
        </details>
        <p className="muted">Capacities and prices are synthetic inputs, not measured facts.</p>
      </div>
    </div>
  );
}

export function CrowdEditor(props: {
  guestCount: number; setGuestCount: (n: number) => void; mix: GuestMix; setMix: (m: GuestMix) => void; seed: string; setSeed: (s: string) => void;
  notes: string; setNotes: (s: string) => void; check: { errors: string[]; warnings: string[] }; crowd: CrowdSpec; hideSeed?: boolean;
}) {
  const rt = useRuntime();
  const total = sumMix(props.mix);
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
  const setOne = (a: Archetype, v: number) => props.setMix({ ...props.mix, [a]: Math.max(0, Math.round(v)) });
  return (
    <div className="stack">
      <div className="grid-3">
        <label className="field"><span className="label">Crowd size (guests)</span>
          <input type="number" min={1} max={rt.capabilities.maxGuests} value={props.guestCount} onChange={(e) => props.setGuestCount(Number(e.target.value))} data-testid="guest-count" />
          <span className="small muted">Default range 200-400; server maximum {rt.capabilities.maxGuests}.</span>
        </label>
        {!props.hideSeed && <label className="field"><span className="label">Seed</span>
          <span className="row"><input type="text" value={props.seed} onChange={(e) => props.setSeed(e.target.value)} className="grow" /><button type="button" className="btn small" onClick={() => props.setSeed(newSeed())}>New</button></span>
          <span className="small muted">Same seed + same crowd = same population artifact.</span>
        </label>}
      </div>
      <fieldset className="stack" style={{ border: 0, padding: 0, gap: 6 }}>
        <legend className="label" style={{ fontWeight: 600 }}>Archetype mix (in guests, not groups) <Explain label="archetype sliders">Sliders count individual guests. Families and friend groups are then formed by the population service; group-size feasibility can shift a few guests between archetypes, shown as requested vs realized after preview.</Explain></legend>
        {ARCHETYPE_ORDER.map((a) => (
          <div key={a} className="slider-row">
            <label htmlFor={`mix-${a}`} className="small">{ARCHETYPE_LABEL[a]}</label>
            <input id={`mix-${a}`} type="range" min={0} max={Math.max(props.guestCount, props.mix[a])} value={props.mix[a]} onChange={(e) => setOne(a, Number(e.target.value))} aria-valuetext={`${props.mix[a]} guests`} />
            <input type="number" min={0} value={props.mix[a]} onChange={(e) => setOne(a, Number(e.target.value))} aria-label={`${ARCHETYPE_LABEL[a]} guests`} data-testid={`mix-${a}`} />
          </div>
        ))}
        <div className="spread small">
          <span aria-live="polite">Assigned <b>{total}</b> of <b>{props.guestCount}</b> guests ({props.guestCount > 0 ? ((total / props.guestCount) * 100).toFixed(0) : 0}%).</span>
          <button type="button" className="btn small" onClick={() => props.setMix(fitMix(props.mix, props.guestCount))} disabled={total === props.guestCount}>Fit to crowd size</button>
        </div>
      </fieldset>
      {props.check.errors.length > 0 && <Alert tone="bad" title="Crowd settings invalid"><ul>{props.check.errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
      {props.check.warnings.map((w) => <Alert key={w} tone="warn">{w}</Alert>)}
      <label className="field"><span className="label">Context notes (recorded, not modeled)</span>
        <input type="text" value={props.notes} onChange={(e) => props.setNotes(e.target.value)} placeholder="e.g. school holiday week" maxLength={500} />
        <span className="small muted">Context such as weather or day of week has no mechanic in v1 and does not change behavior.</span>
      </label>
      <details className="panel tight">
        <summary style={{ cursor: 'pointer' }}><b>Describe the crowd in words</b> <span className="small muted">(proposal only)</span></summary>
        <div className="stack" style={{ marginTop: 8 }}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. 350 guests, mostly families, fewer teens, hot Saturday" maxLength={500} />
          <ActionButton small onClick={() => void parse()} busy={proposal === 'pending'} disabledReason={!text.trim() ? 'Write a description first.' : null}>Propose changes</ActionButton>
          {proposal && proposal !== 'pending' && 'error' in proposal && <ErrorBox error={proposal.error} />}
          {proposal && proposal !== 'pending' && 'proposal' in proposal && (
            <div className="panel tight" data-testid="crowd-proposal">
              <b>Proposed crowd</b>
              <table className="small"><thead><tr><th>Archetype</th><th className="num">Now</th><th className="num">Proposed</th></tr></thead>
                <tbody>{(() => { const pm = mixFromShares(proposal.proposal.shares, proposal.proposal.guestCount); return ARCHETYPE_ORDER.map((a) => <tr key={a}><td>{ARCHETYPE_LABEL[a]}</td><td className="num">{props.mix[a]}</td><td className="num">{pm[a]}</td></tr>); })()}
                  <tr><td><b>Total</b></td><td className="num">{props.guestCount}</td><td className="num">{proposal.proposal.guestCount}</td></tr></tbody></table>
              {proposal.assumptions.length > 0 && <><h4>Assumptions</h4><ul className="small">{proposal.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></>}
              {proposal.unsupported.length > 0 && <><h4>Not modeled / not supported</h4><ul className="small">{proposal.unsupported.map((x) => <li key={x}>{x}</li>)}</ul></>}
              <div className="row">
                <button type="button" className="btn small primary" onClick={() => { props.setGuestCount(proposal.proposal.guestCount); props.setMix(mixFromShares(proposal.proposal.shares, proposal.proposal.guestCount)); props.setNotes(proposal.proposal.contextNotes); setProposal(null); }}>Accept proposal</button>
                <button type="button" className="btn small" onClick={() => setProposal(null)}>Dismiss</button>
              </div>
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

function PreviewView(props: { preview: Preview; mix: GuestMix; onRetry: () => void }) {
  const p = props.preview;
  if (p.kind === 'none') return null;
  if (p.kind === 'stale') return <Alert tone="warn" title="Preview invalidated">{p.reason}</Alert>;
  if (p.kind === 'pending') return <div style={{ marginTop: 8 }}><Spinner label={`Population job ${p.status}…`} /></div>;
  if (p.kind === 'failed') return <div style={{ marginTop: 8 }}><ErrorBox error={p.error} transport={p.transport} onRetry={props.onRetry} /></div>;
  const s = summarizePopulation(p.manifest);
  const examples = ARCHETYPE_ORDER.map((a) => p.manifest.groups.find((g) => p.manifest.personas.find((x) => x.agentId === g.leaderId)?.archetype === a)).filter(Boolean);
  return (
    <div className="stack" style={{ marginTop: 12 }} data-testid="population-preview">
      <h3>Population preview</h3>
      <KV items={[['Guests / groups', `${s.guests} guests in ${s.groups} groups (${s.children} children, ${s.withApp} with the app)`],
        ['Population', <span className="mono" key="p">{p.manifest.populationId}</span>], ['Artifact hash', <span className="hash" key="h">{p.artifact.sha256}</span>],
        ['Versions', `generator ${p.manifest.crowd.generatorVersion} · prose ${p.manifest.proseVersion} · random ${p.manifest.randomVersion}`],
        ['Group budgets', `${formatCents(s.budgets.min)} – ${formatCents(s.budgets.max)} (median ${formatCents(s.budgets.median)}); each wallet is shared by its group`]]} />
      <div className="table-wrap">
        <table className="small"><thead><tr><th>Archetype</th><th className="num">Requested guests</th><th className="num">Realized guests</th></tr></thead>
          <tbody>{ARCHETYPE_ORDER.map((a) => <tr key={a}><td>{ARCHETYPE_LABEL[a]}</td><td className="num">{props.mix[a]}</td><td className="num">{s.realized[a]}{s.realized[a] !== props.mix[a] ? ' *' : ''}</td></tr>)}</tbody></table>
      </div>
      {ARCHETYPE_ORDER.some((a) => s.realized[a] !== props.mix[a]) && <p className="small muted">* Groups must be feasible (e.g. families of 3-5), so deterministic rounding moved a few guests between archetypes. The realized mix is what will run.</p>}
      <p className="small">Group sizes: {Object.entries(s.groupSizes).sort().map(([k, v]) => `${v} x ${k}`).join(', ')}</p>
      <h4>Example groups (actual sampled output)</h4>
      <ul className="card-list small">
        {examples.map((g) => {
          const lead = p.manifest.personas.find((x) => x.agentId === g!.leaderId)!;
          return (
            <li key={g!.groupId} className="panel tight">
              <b>{ARCHETYPE_LABEL[lead.archetype]}</b> · group {g!.groupId} · {g!.memberIds.length} member(s) · wallet {formatCents(g!.startingBalanceCents)} · arrives {formatDuration(g!.arrivalMs)} after opening
              <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>{lead.backstory}</p>
              <span className="muted">Hooks: occasion "{lead.occasion}"; must-do {lead.mustDoPlaceIds.join(', ') || 'none'}; {lead.hasApp ? 'has app' : 'no app'}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PresetOption(props: { p: ScenarioPreset; park: LoadedPark; checked: boolean; onChange: () => void; supported: boolean }) {
  const rt = useRuntime();
  return (
    <label className="panel tight" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', opacity: props.supported ? 1 : 0.6 }}>
      <input type="radio" name="preset" checked={props.checked} onChange={props.onChange} disabled={!props.supported} data-testid={`preset-${props.p.scenario.id}`} />
      <span className="stack" style={{ gap: 2 }}>
        <b>{props.p.scenario.label}{props.p.meta.primaryAB ? ` (primary A/B arm ${props.p.meta.primaryAB})` : ''}</b>
        <span className="small">{props.p.meta.summary}</span>
        {props.p.scenario.events.map((e) => <span key={e.id} className="small muted">{describeChange(e.change, props.park.park, rt.capabilities.features.discountMessages).operation} at {eventTime(e, props.park.park)}</span>)}
        {props.p.meta.authoredHypothesis && <span className="small"><span className="badge neutral">authored hypothesis, unmeasured</span> {props.p.meta.authoredHypothesis.replace(/^Authored hypothesis \(unmeasured\): /, '')}</span>}
        {!props.supported && <span className="small" style={{ color: 'var(--bad-ink)' }}>Not supported by this server's capabilities.</span>}
      </span>
    </label>
  );
}

function FeatureNote() {
  const rt = useRuntime();
  const f = rt.capabilities.features;
  const off = Object.entries(f).filter(([, v]) => !v).map(([k]) => k);
  return <p className="small muted" style={{ marginTop: 8 }}>Optional features: {Object.entries(f).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none supported by this server'}. Not available here: {off.join(', ') || 'none'} (hidden rather than shown as non-functional toggles). Features are off for this run.</p>;
}

function FrozenPlan(props: { manifest: ReturnType<typeof buildManifest>; park: LoadedPark; summary: ReturnType<typeof summarizePopulation>; planHash: string | null; preset: ScenarioPreset }) {
  const m = props.manifest;
  const c = m.config;
  const rt = useRuntime();
  return (
    <section className="panel tight" aria-label="Frozen plan" data-testid="frozen-plan" style={{ marginTop: 12 }}>
      <h3>Frozen plan</h3>
      <KV items={[
        ['Park', `${props.park.park.label} · ${props.park.park.revision}`], ['Guests / groups', `${props.summary.guests} / ${props.summary.groups}`],
        ['Seed', <span className="mono" key="s">{m.replicateSeed}</span>], ['Horizon', `${formatDuration(c.horizonMs)} from opening (${props.park.park.openLocal} to ${formatSimClock(c.horizonMs, props.park.park.openLocal)})`],
        ['Scenario', `${m.scenario.label} (rev ${m.scenario.revision})`],
        ['Events', m.scenario.events.length ? m.scenario.events.map((e) => `${describeChange(e.change, props.park.park, rt.capabilities.features.discountMessages).operation}: ${describeChange(e.change, props.park.park, false).value} at ${eventTime(e, props.park.park)}`).join(' | ') : 'none (baseline)'],
        ['Mode', c.mode === 'mock' ? 'Mock provider (not a real-Jev comparison)' : 'Live Jev'],
        ['Ratings', c.ratingEveryMs ? 'every 30 sim-min + departure/horizon' : 'departure/horizon only'],
        ['Steps', '5,000 ms logical steps, 250 ms movement substeps, temperature 1'],
        ['Features', 'none enabled'], ['Fallback', c.fallback === 'forbidden' ? 'forbidden (clock waits for inference)' : `live timeout fallback after ${c.liveTimeoutMs} ms (marks run degraded)`],
        ['Plan hash', props.planHash ? <span className="hash" key="h">{props.planHash}</span> : '…'],
      ]} />
    </section>
  );
}
