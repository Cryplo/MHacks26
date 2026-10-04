import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { EventRecord, FactBundle, Heatmap, HeatLayer, Id, MetricSnapshot, Narrative, ParkBundle, RunManifest, RunView } from '../../../contract/behavior-v1';
import { decorFor } from '../../content/harborLights';
import { useRunManifestAndPark } from '../../data/hooks';
import { useAsync } from '../../data/useAsync';
import { METRICS, METRIC_ORDER } from '../../domain/metrics';
import { factBundleSchema, narrativeSchema, validate } from '../../domain/schemas';
import { paintParkCanvas } from '../../renderer/parkCanvas';
import { classifyError } from '../../runtime/errors';
import { displayModes } from '../../runtime/mode';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { awaitWork } from '../../runtime/work';
import { ActionButton, Alert, Empty, ErrorBox, Explain, KV, ModeBadges, Panel, Spinner } from '../../ui/components';
import { EM_DASH, formatCents, formatDuration, formatEpoch, formatMetric, formatNumber, formatPercent, formatSimClock } from '../../ui/format';
import { EventLine } from '../live/EventFeed';
import { RunStatusBadge } from '../live/RunStatusBadge';
import { describeChange, eventTime } from '../scenarios/describe';
import { download, toCsv } from './exportCsv';
import { cellCenter, heatColor, LAYER_INFO, topCells } from './heat';
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

export function resultQualityLabel(run: RunView): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  if (run.status === 'failed' || run.status === 'cancelled') return { label: `Incomplete (${run.status})`, tone: 'bad' };
  if (run.status !== 'completed') return { label: 'Incomplete: run still in progress, values are partial', tone: 'warn' };
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
  return (
    <div className="stack" data-testid="results-page">
      <div className="spread">
        <div>
          <h1>Results · <span className="mono">{run.runId}</span></h1>
          <div className="row"><ModeBadges modes={modes} /><RunStatusBadge status={run.status} /><span className={`badge ${q.tone}`} data-testid="result-quality">{q.label}</span></div>
        </div>
        <div className="row no-print">
          <Link className="btn" to={`/runs/${encodeURIComponent(run.runId)}`}>Live view</Link>
          <Link className="btn" to={`/runs/${encodeURIComponent(run.runId)}/replay`}>Recorded replay</Link>
          <button type="button" className="btn" onClick={exportJson} data-testid="export-json">Download JSON</button>
          <button type="button" className="btn" onClick={exportCsv} data-testid="export-csv">Download CSV</button>
          <Link className="btn" to={`/runs/${encodeURIComponent(run.runId)}/print`}>Printable summary</Link>
        </div>
      </div>
      <Panel title="Before the numbers: what was run">
        <KV items={[
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
        <h4 style={{ marginTop: 8 }}>Limitations</h4>
        <ul className="small" data-testid="limitations">{limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </Panel>
      <Panel title="Metrics (Engine values, original units)">
        {!metrics ? <Empty>No metric snapshot yet.</Empty> : (
          <div className="table-wrap">
            <table data-testid="metrics-table">
              <thead><tr><th>Metric</th><th className="num">Value</th><th className="num">Numerator / denominator</th><th className="num">n</th><th className="num">Coverage</th><th>Status</th></tr></thead>
              <tbody>
                {METRIC_ORDER.map((id) => {
                  const m = metrics.measures[id];
                  return (
                    <tr key={id}>
                      <td>{METRICS[id].label}<Explain label={METRICS[id].label}>{METRICS[id].definition} Denominator: {METRICS[id].denominator}</Explain></td>
                      <td className="num"><b>{formatMetric(m)}</b></td>
                      <td className="num small">{formatNumber(m.numerator, 1)} / {m.denominator === null ? 'none' : formatNumber(m.denominator, 1)}</td>
                      <td className="num">{m.n}</td>
                      <td className="num">{formatPercent(m.coverage, 0)}</td>
                      <td className="small">{m.complete ? 'final' : 'partial'}{m.missingReason ? ` · ${m.missingReason}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <HeatmapPanel runId={props.runId} run={run} park={park} codes={props.codes} bumpEnabled={manifest.config.features.bumpReactions} />
      <ReportPanel runId={props.runId} facts={props.facts} kind="run" />
    </div>
  );
}

const LAYERS: HeatLayer[] = ['waiting_person_minutes', 'negative_experience', 'spending_cents', 'early_departures', 'bump_episodes'];

function HeatmapPanel(props: { runId: Id; run: RunView; park: ParkBundle; codes: Uint8Array; bumpEnabled: boolean }) {
  const rt = useRuntime();
  const [layer, setLayer] = useState<HeatLayer>('waiting_person_minutes');
  const [windowKind, setWindowKind] = useState<'all' | 'hour'>('all');
  const toMs = props.run.simMs;
  const fromMs = windowKind === 'all' ? 0 : Math.max(0, toMs - 3600_000);
  const heat = useAsync(() => rt.client.query('getHeatmap', { runId: props.runId, layer, fromMs, toMs }), [rt.client, props.runId, layer, fromMs, toMs], { enabled: layer !== 'bump_episodes' || props.bumpEnabled });
  const [cell, setCell] = useState<number | null>(null);
  const info = LAYER_INFO[layer];
  return (
    <Panel title="Where it happened (heatmaps)">
      <div className="row">
        <label className="field"><span className="label">Layer</span>
          <select value={layer} onChange={(e) => { setLayer(e.target.value as HeatLayer); setCell(null); }} data-testid="heat-layer">
            {LAYERS.map((l) => <option key={l} value={l}>{LAYER_INFO[l].label}{l === 'bump_episodes' && !props.bumpEnabled ? ' (not enabled)' : ''}</option>)}
          </select>
        </label>
        <label className="field"><span className="label">Window</span>
          <select value={windowKind} onChange={(e) => setWindowKind(e.target.value as 'all' | 'hour')}>
            <option value="all">Whole run so far</option><option value="hour">Last simulated hour</option>
          </select>
        </label>
      </div>
      {layer === 'bump_episodes' && !props.bumpEnabled ? <Empty>Bump reactions are not enabled in this run, so there is no bump layer. This is not a zero result.</Empty>
        : heat.error ? <ErrorBox error={heat.error} transport={heat.transport} />
          : !heat.data ? <Spinner label="Loading heatmap…" />
            : <HeatView h={heat.data} park={props.park} codes={props.codes} runId={props.runId} selected={cell} onSelect={setCell} note={info.note} measure={info.measure} />}
    </Panel>
  );
}

function HeatView(props: { h: Heatmap; park: ParkBundle; codes: Uint8Array; runId: Id; selected: number | null; onSelect: (i: number | null) => void; note: string; measure: string }) {
  const { h, park } = props;
  const ref = useRef<HTMLCanvasElement>(null);
  const px = 4;
  const max = Math.max(0, ...h.values);
  const sizeOk = h.width === park.grid.width && h.height === park.grid.height && h.cellM === park.grid.cellM;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !sizeOk) return;
    const base = paintParkCanvas(props.codes, park.grid.width, park.grid.height, px, decorFor(new Set(park.places.map((p) => p.id))));
    canvas.width = base.width; canvas.height = base.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.globalAlpha = 0.45; ctx.drawImage(base, 0, 0); ctx.globalAlpha = 1;
    h.values.forEach((v, i) => {
      const [r, g, b, a] = heatColor(v, max);
      if (!a) return;
      ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
      ctx.fillRect((i % h.width) * px, Math.floor(i / h.width) * px, px, px);
    });
    if (props.selected !== null) {
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.strokeRect((props.selected % h.width) * px - 6, Math.floor(props.selected / h.width) * px - 6, px + 12, px + 12);
    }
  }, [h, park, props.codes, max, props.selected, sizeOk]);
  if (!sizeOk) return <Alert tone="bad" title="Heatmap data error">Heatmap grid ({h.width}x{h.height} at {h.cellM} m) does not match the park grid ({park.grid.width}x{park.grid.height} at {park.grid.cellM} m). Not drawn.</Alert>;
  const tops = topCells(h, park);
  const fmt = (v: number) => (h.unit === 'cents' ? formatCents(v) : `${formatNumber(v, 1)} ${h.unit}`);
  return (
    <div className="grid-2" data-testid="heat-view">
      <div>
        <canvas ref={ref} className="heat-canvas" role="img" aria-label={`Heatmap of ${h.layer}, total ${fmt(h.total)}`} />
        <div className="small" data-testid="heat-legend">
          <b>Legend:</b> darker = larger value · unit <b>{h.unit}</b> per 1 m cell ({props.measure}) · window {formatSimClock(h.fromMs, park.openLocal)}–{formatSimClock(h.toMs, park.openLocal)} · total <b>{fmt(h.total)}</b> · {h.denominator}{h.complete ? '' : ' · incomplete'}
          <br /><span className="muted">{props.note}</span>
        </div>
      </div>
      <div>
        <h4>Top locations</h4>
        {h.total === 0 ? <Empty>Nothing recorded for this layer in this window. That is a real zero for the window, not missing data.</Empty> : (
          <ol className="small">
            {tops.map((t) => (
              <li key={t.index}>
                <button type="button" className="btn ghost small" onClick={() => props.onSelect(t.index)} aria-pressed={props.selected === t.index}>
                  {fmt(t.value)} at ({t.center.xM.toFixed(1)} m, {t.center.yM.toFixed(1)} m){t.nearestPlace ? ` near ${t.nearestPlace}` : ''}
                </button>
              </li>
            ))}
          </ol>
        )}
        <p className="small muted">Contributions are assigned by the model to locations; they are not proven real-world causes.</p>
        {props.selected !== null && <CellEvents runId={props.runId} h={h} index={props.selected} park={park} />}
      </div>
    </div>
  );
}

function CellEvents(props: { runId: Id; h: Heatmap; index: number; park: ParkBundle }) {
  const rt = useRuntime();
  const center = cellCenter(props.h, props.index);
  const evs = useAsync(async () => {
    const out: EventRecord[] = [];
    let after = -1;
    for (let page = 0; page < 20; page++) {
      const p = await rt.client.query('getEvents', { runId: props.runId, afterSequence: after, limit: 500 });
      out.push(...p.items.filter((e) => e.position && e.atMs >= props.h.fromMs && e.atMs <= props.h.toMs && Math.hypot(e.position.xM - center.xM, e.position.yM - center.yM) <= 3));
      if (p.nextAfterSequence === null) break;
      after = p.nextAfterSequence;
    }
    return out.slice(-40);
  }, [rt.client, props.runId, props.index, props.h.fromMs, props.h.toMs]);
  return (
    <div className="panel tight" data-testid="cell-events">
      <h4>Supporting events within 3 m</h4>
      {evs.loading && <Spinner label="Searching event history…" />}
      {evs.data && evs.data.length === 0 && <p className="small muted">No positioned events near this cell (queue time is accumulated from positions, not single events).</p>}
      <ul className="feed-list" style={{ maxHeight: 200 }}>
        {evs.data?.map((e) => (
          <li key={e.sequence} style={{ padding: '4px 0' }}>
            <EventLine e={e} park={props.park} />
            {e.agentIds[0] && <Link className="small" to={`/runs/${encodeURIComponent(props.runId)}?guest=${encodeURIComponent(e.agentIds[0])}`}>inspect</Link>}
          </li>
        ))}
      </ul>
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
    <Panel title="Modeled-results report" actions={<ActionButton small onClick={() => void generate()} busy={state.kind === 'loading'} testId="generate-report">Generate report</ActionButton>}>
      <p className="small muted">Prose references facts by ID; numbers are filled in by code from the authorized fact bundle ({props.facts.facts.length} facts, as of {formatDuration(props.facts.asOfMs)}). A mismatch is shown as an error, never guessed.</p>
      {state.kind === 'loading' && <Spinner label="Composing report…" />}
      {state.kind === 'error' && <ErrorBox error={state.e.error} transport={state.e.transport} />}
      {state.kind === 'ready' && <NarrativeView narrative={state.n} facts={state.facts} expectedEvidenceHash={null} />}
    </Panel>
  );
}
