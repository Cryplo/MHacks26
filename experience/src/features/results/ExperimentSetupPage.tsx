import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DomainError, ExperimentSpec, ParkSummary } from '../../../contract/behavior-v1';
import { CONTRACT_VERSION } from '../../../contract/behavior-v1';
import { SCENARIO_PRESETS } from '../../content/harborLights';
import { useAsync } from '../../data/useAsync';
import { canonicalHash } from '../../domain/canonical';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { ActionButton, Alert, ErrorBox, KV, Panel, Spinner } from '../../ui/components';
import { formatDuration } from '../../ui/format';
import { CrowdEditor } from '../setup/SetupPage';
import { buildCrowd, DEFAULT_GUESTS, defaultMix, validateCrowd, type GuestMix } from '../setup/crowd';
import { defaultRunConfig, HORIZON_OPTIONS_MS, NO_FEATURES, REQUESTED_MODEL } from '../setup/plan';
import { changedLever } from './experiment';

export function ExperimentSetupPage() {
  const rt = useRuntime();
  const navigate = useNavigate();
  const parks = useAsync(() => rt.client.query('listParks', { cursor: null }), [rt.client]);
  const [parkId, setParkId] = useState<string | null>(null);
  const [guestCount, setGuestCount] = useState(DEFAULT_GUESTS);
  const [mix, setMix] = useState<GuestMix>(defaultMix());
  const [notes, setNotes] = useState('');
  const [seedCount, setSeedCount] = useState(3);
  const [seedPrefix, setSeedPrefix] = useState('pair');
  const [baselineId, setBaselineId] = useState('baseline');
  const [variantId, setVariantId] = useState('price-only');
  const [horizon, setHorizon] = useState(3 * 3600_000);
  const [analysis, setAnalysis] = useState<'paired_descriptive' | 'paired_t'>('paired_descriptive');
  const [tAck, setTAck] = useState(false);
  const [provider, setProvider] = useState<'mock' | 'jev'>('mock');
  const jevReason = rt.settings.profile === 'fixture' ? 'The fixture profile has no Jev connection.' : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ error: DomainError; transport: boolean } | null>(null);
  const [expId] = useState(() => `exp-${crypto.randomUUID().slice(0, 8)}`);
  if (!rt.session?.roles.includes('operator')) return <Alert tone="info" title="Operator session required">Creating experiments needs an operator session.</Alert>;
  const park: ParkSummary | undefined = parks.data?.items.find((p) => p.artifact.artifactId === parkId) ?? parks.data?.items.find((p) => p.status === 'ready' && p.revision.includes('s1'));
  const check = validateCrowd(guestCount, mix, rt.capabilities.maxGuests);
  const baseline = SCENARIO_PRESETS.find((p) => p.scenario.id === baselineId)!.scenario;
  const variant = SCENARIO_PRESETS.find((p) => p.scenario.id === variantId)!.scenario;
  const lever = changedLever(baseline, variant);
  const seeds = Array.from({ length: seedCount }, (_, i) => `${seedPrefix}-${i + 1}`);
  const crowd = buildCrowd(guestCount, mix, 'per-pair', notes);
  const { seed: _seed, ...crowdNoSeed } = crowd;
  const spec: ExperimentSpec | null = park ? {
    contractVersion: CONTRACT_VERSION, experimentId: expId, park: park.artifact, crowd: crowdNoSeed, seeds, baseline, variant,
    // Real comparisons run as `experiment` mode with Jev requested; Engine then rejects any
    // mock or fallback distribution, so every arm decision is real Jev or a Jev-origin cache hit.
    config: provider === 'jev'
      ? { ...defaultRunConfig('mock', NO_FEATURES), mode: 'experiment', horizonMs: horizon, fallback: 'forbidden', versions: { ...defaultRunConfig('mock').versions, requestedModel: REQUESTED_MODEL.live } }
      : { ...defaultRunConfig('mock', NO_FEATURES), mode: 'mock', horizonMs: horizon }, interventionLabel: lever.label, changedLever: lever.lever,
    analysis, alpha: 0.05, operationBudgetMs: 30 * 60_000, maxConcurrentArms: 1, start: { kind: 'opening' },
  } : null;
  const reason = !park ? 'Choose a ready park.' : park.status !== 'ready' ? `Park is ${park.status}.` : check.errors.length ? 'Fix the crowd settings.'
    : lever.lever === 'none' ? 'Baseline and variant are identical (A/A checks run in Engine test suites).'
      : analysis === 'paired_t' && !tAck ? 'Acknowledge the paired-t assumptions.' : rt.settings.profile === 'fixture' && horizon > 4 * 3600_000 ? 'Fixture scenes cover at most 4 hours.' : null;
  const create = async () => {
    if (!spec) return;
    setBusy(true); setError(null);
    const out = await rt.runner.run('createExperiment', { spec }, `experiment:${await canonicalHash(spec)}`, { durable: true });
    setBusy(false);
    if (out.kind === 'accepted') navigate(`/experiments/${encodeURIComponent(out.result.experimentId)}`);
    else setError({ error: out.error, transport: out.kind === 'transport' });
  };
  return (
    <div className="stack" data-testid="experiment-setup">
      <h1>Compare A/B (paired seeds)</h1>
      <p className="muted">Each seed produces one frozen population shared by both arms; arm A and arm B differ only in the scenario. The result is unknown in advance and may be neutral or negative.</p>
      <Panel title="Park and crowd">
        {!parks.data ? <Spinner label="Loading parks…" /> : (
          <label className="field"><span className="label">Park</span>
            <select value={park?.artifact.artifactId ?? ''} onChange={(e) => setParkId(e.target.value)}>
              {parks.data.items.map((p) => <option key={p.artifact.artifactId} value={p.artifact.artifactId} disabled={p.status !== 'ready'}>{p.label} ({p.status})</option>)}
            </select>
          </label>
        )}
        <CrowdEditor guestCount={guestCount} setGuestCount={setGuestCount} mix={mix} setMix={setMix} seed="" setSeed={() => undefined} hideSeed notes={notes} setNotes={setNotes} check={check} crowd={crowd} />
      </Panel>
      <Panel title="Arms and analysis">
        <div className="grid-3">
          <label className="field"><span className="label">Arm A (baseline)</span>
            <select value={baselineId} onChange={(e) => setBaselineId(e.target.value)}>{SCENARIO_PRESETS.map((p) => <option key={p.scenario.id} value={p.scenario.id}>{p.scenario.label}</option>)}</select></label>
          <label className="field"><span className="label">Arm B (variant)</span>
            <select value={variantId} onChange={(e) => setVariantId(e.target.value)} data-testid="variant-select">{SCENARIO_PRESETS.map((p) => <option key={p.scenario.id} value={p.scenario.id}>{p.scenario.label}</option>)}</select></label>
          <label className="field"><span className="label">Seed pairs</span>
            <select value={seedCount} onChange={(e) => setSeedCount(Number(e.target.value))}>{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}{n === 1 ? ' (illustration only)' : n < 3 ? ' (exploratory)' : ' (exploratory, default)'}</option>)}</select></label>
          <label className="field"><span className="label">Seed prefix</span><input type="text" value={seedPrefix} onChange={(e) => setSeedPrefix(e.target.value.replace(/[^A-Za-z0-9_.:-]/g, ''))} /></label>
          <label className="field"><span className="label">Horizon</span>
            <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>{HORIZON_OPTIONS_MS.map((h) => <option key={h} value={h}>{formatDuration(h)}</option>)}</select></label>
          <label className="field"><span className="label">Behavior provider</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as 'mock' | 'jev')} data-testid="experiment-provider">
              <option value="mock">Mock provider (infrastructure check)</option>
              <option value="jev" disabled={Boolean(jevReason)}>Real Jev (billable){jevReason ? ' (unavailable)' : ''}</option>
            </select>
            {jevReason && <span className="small muted">{jevReason}</span>}
          </label>
          <label className="field"><span className="label">Analysis</span>
            <select value={analysis} onChange={(e) => { setAnalysis(e.target.value as 'paired_descriptive' | 'paired_t'); setTAck(false); }}>
              <option value="paired_descriptive">Paired descriptive (mean, min, max, SD)</option>
              <option value="paired_t">Paired t interval (explicit opt-in)</option>
            </select></label>
        </div>
        {lever.bundled ? <Alert tone="warn" title="Bundled change">{lever.label}</Alert> : <p className="small">Changed lever: <b>{lever.label}</b></p>}
        {analysis === 'paired_t' && (
          <Alert tone="warn" title="Paired-t assumptions">
            <p>Assumes approximately normal paired differences across seeds; with few pairs the interval is wide. It describes variability of modeled mean differences, not calibration to real visitors.</p>
            <label className="row small"><input type="checkbox" checked={tAck} onChange={(e) => setTAck(e.target.checked)} /> I understand these assumptions.</label>
          </Alert>
        )}
        <KV items={[['Mode', provider === 'jev' ? 'Real Jev (experiment mode; mock and fallback rejected by Engine; billable)' : 'Mock provider (not a real-Jev comparison)'], ['Seeds', seeds.join(', ')], ['Arms run', 'one at a time (maxConcurrentArms 1)'], ['Start', 'park opening']]} />
        <div className="row" style={{ marginTop: 8 }}>
          <ActionButton tone="primary" onClick={() => void create()} busy={busy} disabledReason={reason} testId="create-experiment">Create experiment</ActionButton>
          <Link to="/setup" className="small">Single exploratory run instead</Link>
        </div>
        {error && <ErrorBox error={error.error} transport={error.transport} onRetry={() => void create()} />}
      </Panel>
    </div>
  );
}
