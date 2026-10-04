import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { FactBundle, Id, MetricSnapshot, Narrative, ParkBundle, RunManifest, RunView } from '../../../contract/behavior-v1';
import { useLiveRun, useLiveSelector, useRunManifestAndPark } from '../../data/hooks';
import { useRunHistory } from '../../data/history';
import { Dashboard } from '../dashboard/Dashboard';
import { useAsync } from '../../data/useAsync';
import { METRICS, METRIC_ORDER } from '../../domain/metrics';
import { factBundleSchema, narrativeSchema, validate } from '../../domain/schemas';
import { classifyError } from '../../runtime/errors';
import { displayModes } from '../../runtime/mode';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { awaitWork } from '../../runtime/work';
import { ActionButton, Disclosure, Empty, ErrorBox, Explain, Icon, KV, Menu, ModeBadges, Panel, Spinner } from '../../ui/components';
import { EM_DASH, formatDuration, formatEpoch, formatMetric, formatPercent, formatSimClock } from '../../ui/format';
import { RunStatusBadge } from '../live/RunStatusBadge';
import { describeChange, eventTime } from '../scenarios/describe';
import { download, toCsv } from './exportCsv';
import { NarrativeView } from './NarrativeView';

export function ResultsPage() {
  const { runId = '' } = useParams();
  const rt = useRuntime();
  const base = useRunManifestAndPark(runId);
  const data = useAsync(async () => {
    // One coherent snapshot gives the run view and metrics at the same revision.
    const snap = await rt.client.query('getLiveSnapshot', { runId });
    const facts = await rt.client.query('getFactBundle', { runId, experimentId: null });
    return { run: snap.run, metrics: snap.metrics, facts };
  }, [rt.client, runId], { pollMs: 5000 });
  if (base.error) return <ErrorBox error={base.error} transport={base.transport} onRetry={base.reload} />;
  if (!base.data || !data.data) return data.error ? <ErrorBox error={data.error} transport={data.transport} /> : <Spinner label="Loading results…" />;
  const { manifest, park, codes } = base.data;
  const { run, metrics, facts } = data.data;
  return <ResultsView runId={runId} run={run} manifest={manifest} park={park} codes={codes} metrics={metrics} facts={facts} />;
}

/** The dashboard over a live subscription, so results keep updating while the run is going. */
function LiveDashboard(props: { runId: Id; manifest: RunManifest; park: ParkBundle; codes: Uint8Array; run: RunView }) {
  const conn = useLiveRun(props.runId);
  const liveRun = useLiveSelector(conn.store, (s) => s.run);
  const head = liveRun?.simMs ?? props.run.simMs;
  const history = useRunHistory(props.runId, head, { horizonMs: props.manifest.config.horizonMs, frameEveryMs: props.manifest.config.visualFrameEveryMs });
  return <Dashboard runId={props.runId} park={props.park} codes={props.codes} manifest={props.manifest} store={conn.store} history={history} viewMs={head} />;
}

export function resultQualityLabel(run: RunView): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (run.status === 'failed' || run.status === 'cancelled') return { label: `Incomplete (${run.status})`, tone: 'bad' };
  if (run.status !== 'completed') return { label: 'In progress · numbers so far', tone: 'warn' };
  if (run.quality.behaviorCounts.fallback > 0) return { label: 'Degraded: some decisions used the live-timeout fallback', tone: 'warn' };
  return { label: 'Completed', tone: 'ok' };
}

function ResultsView(props: { runId: Id; run: RunView; manifest: RunManifest; park: ParkBundle; codes: Uint8Array; metrics: MetricSnapshot | null; facts: FactBundle }) {
  const rt = useRuntime();
  const { run, manifest, park, metrics } = props;
  const q = resultQualityLabel(run);
  const modes = displayModes({ profile: rt.settings.profile, run, quality: run.quality });
  const sat = metrics?.measures.satisfaction_0_100;
  const limitations = [
    ...(rt.settings.profile === 'fixture' ? ['Fixture data: scripted choreography and mock policy; not an Engine simulation and not Jev.'] : []),
    ...(run.mode === 'mock' ? ['Mock provider: not a real-Jev comparison.'] : []),
    'Synthetic park and guests; not calibrated to real visitors.',
    ...run.quality.reasons,
  ];
  const exportJson = () => {
    const body = {
      exportVersion: 'experience-run-export-v1', generatedAtEpochMs: Date.now(), generatedAt: formatEpoch(Date.now()),
      source: { profile: rt.settings.profile, modes, runMode: run.mode, contractVersion: manifest.contractVersion },
      run: { runId: run.runId, status: run.status, revision: run.revision, simMs: run.simMs, manifestHash: run.manifestHash, quality: run.quality },
      scenario: manifest.scenario, seed: manifest.replicateSeed, horizonMs: manifest.config.horizonMs, openLocal: park.openLocal,
      population: manifest.population, park: manifest.park, units: { money: 'integer USD cents', time: 'ms since park opening', ratios: '0..1' },
      metrics, facts: props.facts, limitations,
    };
    download(`run-${run.runId}-results.json`, 'application/json', JSON.stringify(body, null, 2));
  };
  const exportCsv = () => {
    const rows: (string | number | null)[][] = [
      ['# Behavior Engine run export', `modes=${modes.join('+') || 'none'}`, `run=${run.runId}`, `status=${run.status}`, `generated=${formatEpoch(Date.now())}`],
      ['# scenario', manifest.scenario.label, `seed=${manifest.replicateSeed}`, `horizonMs=${manifest.config.horizonMs}`, `asOfSimMs=${metrics?.simMs ?? ''}`],
      ['metric_id', 'label', 'value', 'unit', 'numerator', 'denominator', 'n', 'coverage', 'complete', 'missing_reason', 'definition'],
      ...METRIC_ORDER.map((id) => { const m = metrics?.measures[id]; return [id, METRICS[id].label, m?.value ?? null, m?.unit ?? null, m?.numerator ?? null, m?.denominator ?? null, m?.n ?? null, m?.coverage ?? null, m ? String(m.complete) : null, m?.missingReason ?? null, METRICS[id].definition]; }),
      ['# limitations', ...limitations],
    ];
    download(`run-${run.runId}-metrics.csv`, 'text/csv', toCsv(rows));
  };
  const runPath = `/runs/${encodeURIComponent(run.runId)}`;
  return (
    <div data-testid="results-page">
      <div className="page-head">
        <div>
          <div className="eyebrow"><Link to="/">Simulations</Link><span aria-hidden="true">/</span><Link to={runPath}>{manifest.scenario.label}</Link><span aria-hidden="true">/</span><span>Results</span></div>
          <h1>Results</h1>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>{q.label !== 'Completed' && <RunStatusBadge status={run.status} />}<span className={`badge ${q.tone}`} data-testid="result-quality">{q.label}</span></div>
        </div>
        <div className="row no-print" style={{ gap: 8 }}>
          <Link className="btn" to={runPath}>Live view</Link>
          <Link className="btn" to={`${runPath}?t=0`}>Replay</Link>
          <Menu label="Export" testId="export-menu" trigger={<><Icon name="download" />Export</>}>
            {(close) => (
              <>
                <button type="button" role="menuitem" onClick={() => { close(); exportCsv(); }} data-testid="export-csv"><Icon name="download" />Metrics CSV</button>
                <button type="button" role="menuitem" onClick={() => { close(); exportJson(); }} data-testid="export-json"><Icon name="download" />Full JSON</button>
                <Link role="menuitem" to={`${runPath}/print`}><Icon name="print" />Printable summary</Link>
              </>
            )}
          </Menu>
        </div>
      </div>
      <LiveDashboard runId={props.runId} manifest={manifest} park={park} codes={props.codes} run={run} />
      <section className="section">
        <h2>All measures</h2>
        <div className="panel flush">
          {!metrics ? <div style={{ padding: 16 }}><Empty>No metric snapshot yet.</Empty></div> : (
            <div className="table-wrap">
              <table data-testid="metrics-table">
                <thead><tr><th>Measure</th><th className="num">Value</th><th className="num">Coverage</th><th>Status</th></tr></thead>
                <tbody>
                  {METRIC_ORDER.map((id) => {
                    const m = metrics.measures[id];
                    return (
                      <tr key={id}>
                        <td>{METRICS[id].label}<Explain label={METRICS[id].label}>{METRICS[id].definition} Denominator: {METRICS[id].denominator}</Explain></td>
                        <td className="num"><b>{formatMetric(m)}</b></td>
                        <td className="num muted">{formatPercent(m.coverage, 0)}</td>
                        <td className="small muted">{m.complete ? 'final' : 'partial'}{m.missingReason ? ` · ${m.missingReason}` : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      <section className="section"><ReportPanel runId={props.runId} facts={props.facts} kind="run" /></section>
      <section className="section">
        <Disclosure summary="Technical details" count="definition, coverage, limitations">
          <ModeBadges modes={modes} />
          <KV items={[
            ['Run', <span className="mono" key="r">{run.runId}</span>],
            ['Scenario', `${manifest.scenario.label} (rev ${manifest.scenario.revision})`],
            ['Events', manifest.scenario.events.length ? manifest.scenario.events.map((e) => `${describeChange(e.change, park, false).operation} — ${eventTime(e, park)}`).join('; ') : 'none (baseline)'],
            ['Live what-if changes', `scenario revision ${run.scenarioRevision}${run.scenarioRevision !== manifest.scenario.revision ? ' (changed during the run; see event history)' : ''}`],
            ['Horizon', `${formatDuration(manifest.config.horizonMs)} from ${park.openLocal}; results as of ${formatSimClock(run.simMs, park.openLocal)}`],
            ['Seed / population', <span key="s"><span className="mono">{manifest.replicateSeed}</span> · <span className="hash">{manifest.population.sha256}</span></span>],
            ['Manifest hash', <span className="hash" key="m">{run.manifestHash}</span>],
            ['Coverage', sat ? `satisfaction ${formatPercent(sat.coverage, 0)} of admitted guests rated (n=${sat.n}); terminal ratings ${run.quality.terminalRatingsComplete}/${run.quality.terminalRatingsExpected}` : EM_DASH],
            ['Decision sources', `jev ${run.quality.behaviorCounts.jev}, cache ${run.quality.behaviorCounts.cache}, mock ${run.quality.behaviorCounts.mock}, fallback ${run.quality.behaviorCounts.fallback}`],
            ['Comparison eligible', run.quality.comparisonEligible ? 'yes' : `no — ${run.quality.reasons.join(' ')}`],
          ]} />
          <h4 style={{ margin: '8px 0 0' }}>Limitations</h4>
          <ul className="note-list" data-testid="limitations">{limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </Disclosure>
      </section>
    </div>
  );
}

export function ReportPanel(props: { runId?: Id; experimentId?: Id; facts: FactBundle; kind: 'run' | 'experiment' }) {
  const rt = useRuntime();
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'loading' } | { kind: 'ready'; n: Narrative; facts: FactBundle } | { kind: 'error'; e: ReturnType<typeof classifyError> }>({ kind: 'idle' });
  const generate = async () => {
    setState({ kind: 'loading' });
    const out = await rt.runner.run('requestProductWork', { request: { kind: 'report', runId: props.runId ?? null, experimentId: props.experimentId ?? null } }, `report:${props.runId ?? props.experimentId}:${Date.now()}`);
    if (out.kind !== 'accepted') { setState({ kind: 'error', e: { error: out.error, transport: out.kind === 'transport' } }); return; }
    try {
      const st = await awaitWork<'report'>(rt.client, out.result.workId);
      if (st.status !== 'ready' || !st.result) { setState({ kind: 'error', e: { error: st.error ?? { code: 'INCOMPLETE', message: `Report ${st.status}.`, retryable: true, fieldErrors: [] }, transport: false } }); return; }
      const v = validate<Narrative>(narrativeSchema, st.result);
      if (!v.ok) throw new Error(`Report failed validation: ${v.issues.join('; ')}`);
      const bundle = await rt.client.query('getFactBundle', { runId: props.runId ?? null, experimentId: props.experimentId ?? null });
      const fb = validate<FactBundle>(factBundleSchema, bundle);
      if (!fb.ok) throw new Error(`Fact bundle failed validation: ${fb.issues.join('; ')}`);
      setState({ kind: 'ready', n: v.value, facts: fb.value });
    } catch (e) {
      setState({ kind: 'error', e: e instanceof Error && !('error' in e) ? { error: { code: 'INVALID_INPUT', message: e.message, retryable: false, fieldErrors: [] }, transport: false } : classifyError(e) });
    }
  };
  return (
    <Panel title="Written summary" actions={<ActionButton small onClick={() => void generate()} busy={state.kind === 'loading'} testId="generate-report">Generate report</ActionButton>}>
      {state.kind === 'idle' && <p className="small muted" style={{ margin: 0 }}>A plain-language summary of this {props.kind === 'run' ? 'run' : 'experiment'}, with every number filled in from the recorded facts.</p>}
      <p className="note" style={{ marginTop: 6 }}>Prose references facts by ID; numbers are filled in by code from the authorized fact bundle ({props.facts.facts.length} facts, as of {formatDuration(props.facts.asOfMs)}). A mismatch is shown as an error, never guessed.</p>
      {state.kind === 'loading' && <Spinner label="Composing report…" />}
      {state.kind === 'error' && <ErrorBox error={state.e.error} transport={state.e.transport} />}
      {state.kind === 'ready' && <NarrativeView narrative={state.n} facts={state.facts} expectedEvidenceHash={null} />}
    </Panel>
  );
}
