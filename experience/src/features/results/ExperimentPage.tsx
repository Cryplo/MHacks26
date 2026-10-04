import { Link, useParams } from 'react-router-dom';
import type { ExperimentReport, MetricId, PairResult } from '../../../contract/behavior-v1';
import { useAsync } from '../../data/useAsync';
import { describeDelta, METRICS, METRIC_ORDER } from '../../domain/metrics';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { Alert, ErrorBox, Explain, KV, Panel, Spinner } from '../../ui/components';
import { EM_DASH, formatDuration, formatEpoch, formatMetric, formatMetricDelta } from '../../ui/format';
import { evidenceLabels, intervalText } from './experiment';
import { download, toCsv } from './exportCsv';
import { ReportPanel } from './ResultsPage';

const STATUS_TONE: Record<PairResult['status'], string> = { complete: 'ok', pending: 'neutral', running: 'info', incomplete: 'warn', degraded: 'warn', failed: 'bad' };
const unitOf = (r: ExperimentReport, id: MetricId) => r.pairs.find((p) => p.a)?.a?.measures[id].unit ?? r.pairs.find((p) => p.b)?.b?.measures[id].unit ?? 'ratio';

export function ExperimentPage() {
  const { experimentId = '' } = useParams();
  const rt = useRuntime();
  const report = useAsync(() => rt.client.query('getExperiment', { experimentId }), [rt.client, experimentId], { pollMs: 2000 });
  const facts = useAsync(() => rt.client.query('getFactBundle', { runId: null, experimentId }), [rt.client, experimentId, report.data?.revision]);
  if (report.error) return <ErrorBox error={report.error} transport={report.transport} onRetry={report.reload} />;
  if (!report.data) return <Spinner label="Loading experiment…" />;
  const r = report.data;
  const labels = evidenceLabels(r, rt.settings.profile);
  const s = r.spec;
  const exportCsv = () => {
    const rows: (string | number | null)[][] = [
      ['# Behavior Engine experiment export', `labels=${labels.join('+')}`, `experiment=${s.experimentId}`, `status=${r.status}`, `generated=${formatEpoch(Date.now())}`],
      ['# intervention', s.interventionLabel, `lever=${s.changedLever}`, `horizonMs=${s.config.horizonMs}`, `analysis=${s.analysis}`],
      ['pair_id', 'seed', 'status', 'reasons', 'metric_id', 'unit', 'a_value', 'b_value', 'b_minus_a'],
      ...r.pairs.flatMap((p) => METRIC_ORDER.map((id) => [p.pairId, p.seed, p.status, p.reasons.join(' | '), id, unitOf(r, id), p.a?.measures[id].value ?? null, p.b?.measures[id].value ?? null, p.deltas[id] ?? null])),
      ['# summaries (descriptive; min/max are spread, not confidence bounds)'],
      ['metric_id', 'pair_count', 'mean', 'min', 'max', 'sample_sd', 'interval'],
      ...r.summaries.map((x) => [x.metricId, x.pairCount, x.mean, x.min, x.max, x.sampleSd, x.interval ? `${x.interval.kind} ${x.interval.level}: ${x.interval.lower}..${x.interval.upper}` : null]),
      ['# limitations', ...r.limitations],
    ];
    download(`experiment-${s.experimentId}.csv`, 'text/csv', toCsv(rows));
  };
  const exportJson = () => download(`experiment-${s.experimentId}.json`, 'application/json', JSON.stringify({ exportVersion: 'experience-experiment-export-v1', generatedAtEpochMs: Date.now(), labels, profile: rt.settings.profile, report: r, facts: facts.data ?? null }, null, 2));
  return (
    <div className="stack" data-testid="experiment-page">
      <div className="spread">
        <div>
          <h1>Experiment <span className="mono">{s.experimentId}</span></h1>
          <div className="row" data-testid="evidence-labels">{labels.map((l) => <span key={l} className={`badge ${l === 'Fixture' ? 'mode-fixture' : l === 'Mock' ? 'mode-mock' : l === 'Live Jev' ? 'mode-live' : l === 'Running' ? 'info' : l === 'Incomplete' ? 'warn' : 'neutral'}`}>{l}</span>)}</div>
        </div>
        <div className="row no-print">
          <button type="button" className="btn" onClick={exportJson}>Download JSON</button>
          <button type="button" className="btn" onClick={exportCsv} data-testid="experiment-csv">Download CSV</button>
        </div>
      </div>
      <Panel title="Before the numbers: definition, coverage and limitations">
        <KV items={[
          ['Intervention', s.interventionLabel], ['Changed lever', s.changedLever === 'bundled' ? 'bundled (labeled; not attributable to one lever)' : s.changedLever],
          ['Arm A / arm B', `${s.baseline.label} / ${s.variant.label}`], ['Seeds', s.seeds.join(', ')],
          ['Horizon', `${formatDuration(s.config.horizonMs)} from opening`], ['Mode', s.config.mode === 'mock' || s.config.versions.requestedModel === 'mock-policy-v1' ? 'Mock provider (not a real-Jev comparison)' : `Real Jev (${s.config.versions.requestedModel}; mock and fallback rejected)`],
          ['Analysis', s.analysis === 'paired_t' ? 'paired t (explicit choice; assumptions disclosed)' : 'paired descriptive'],
          ['Pairs', `${r.completePairs} complete of ${r.requestedPairs} requested`], ['Report revision', String(r.revision)],
        ]} />
        <ul className="small">{r.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        {r.completePairs <= 1 && <Alert tone="info" title="Illustrative">With {r.completePairs} complete pair this is an illustration, not evidence of an effect.</Alert>}
      </Panel>
      <Panel title="Every requested pair">
        <div className="table-wrap">
          <table data-testid="pairs-table">
            <thead><tr><th>Pair</th><th>Seed</th><th>Status</th><th>Reasons</th><th>Runs</th></tr></thead>
            <tbody>
              {r.pairs.map((p) => (
                <tr key={p.pairId} data-pair-status={p.status}>
                  <td className="mono">{p.pairId}</td><td className="mono">{p.seed}</td>
                  <td><span className={`badge ${STATUS_TONE[p.status]}`}>{p.status}</span></td>
                  <td className="small">{p.reasons.join('; ') || EM_DASH}</td>
                  <td className="small">{p.aRunId ? <span>A <span className="mono">{p.aRunId}</span></span> : 'A —'}<br />{p.bRunId ? <span>B <span className="mono">{p.bRunId}</span></span> : 'B —'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Incomplete, degraded and failed pairs stay listed and are not included in the summaries below.</p>
      </Panel>
      <Panel title="Per-pair values (original units) and B minus A">
        <div className="table-wrap">
          <table className="small">
            <thead><tr><th>Metric</th>{r.pairs.map((p) => <th key={p.pairId} className="num">{p.pairId}: A / B / B−A</th>)}</tr></thead>
            <tbody>
              {METRIC_ORDER.map((id) => (
                <tr key={id}>
                  <td>{METRICS[id].short}</td>
                  {r.pairs.map((p) => (
                    <td key={p.pairId} className="num">
                      {p.a ? formatMetric(p.a.measures[id]) : EM_DASH} / {p.b ? formatMetric(p.b.measures[id]) : EM_DASH} / <b>{p.deltas[id] !== undefined ? formatMetricDelta(id, unitOf(r, id), p.deltas[id]) : EM_DASH}</b>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Summary of paired differences (B − A)">
        <div className="table-wrap">
          <table data-testid="summary-table">
            <thead><tr><th>Metric</th><th className="num">Pairs</th><th className="num">Mean</th><th className="num">Min</th><th className="num">Max</th><th className="num">Sample SD</th><th>Interval</th><th>Reading</th></tr></thead>
            <tbody>
              {r.summaries.map((x) => {
                const u = unitOf(r, x.metricId);
                return (
                  <tr key={x.metricId}>
                    <td>{METRICS[x.metricId].label}<Explain label={METRICS[x.metricId].label}>{METRICS[x.metricId].definition}</Explain></td>
                    <td className="num">{x.pairCount}</td>
                    <td className="num"><b>{formatMetricDelta(x.metricId, u, x.mean)}</b></td>
                    <td className="num">{formatMetricDelta(x.metricId, u, x.min)}</td>
                    <td className="num">{formatMetricDelta(x.metricId, u, x.max)}</td>
                    <td className="num">{x.sampleSd === null ? EM_DASH : formatMetricDelta(x.metricId, u, x.sampleSd).replace(/^\+/, '')}</td>
                    <td className="small">{x.interval ? `${intervalText(x)}: ${formatMetricDelta(x.metricId, u, x.interval.lower)} to ${formatMetricDelta(x.metricId, u, x.interval.upper)}` : 'none supplied'}</td>
                    <td className="small">{describeDelta(x.metricId, x.mean)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="small muted">Min and max describe spread across seed pairs; they are not confidence bounds. Values are shown with their sign; zero and negative effects are valid results. Colour is not used to imply that higher is better.</p>
      </Panel>
      {facts.data && <ReportPanel experimentId={experimentId} facts={facts.data} kind="experiment" />}
      <p><Link to="/">Back to runs</Link></p>
    </div>
  );
}
