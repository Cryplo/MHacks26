import { Link } from 'react-router-dom';
import type { RunView } from '../../../contract/behavior-v1';
import { useAsync } from '../../data/useAsync';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { Alert, Empty, ErrorBox, Panel, Spinner } from '../../ui/components';
import { formatSimOffset } from '../../ui/format';
import { RunStatusBadge } from '../live/RunStatusBadge';

export function HomePage() {
  const rt = useRuntime();
  const session = rt.session;
  const isOperator = session?.roles.includes('operator') ?? false;
  const runs = useAsync(async () => {
    const ids = session?.runIds ?? [];
    const views = await Promise.all(ids.map((runId) => rt.client.query('getRun', { runId }).then((v) => v, () => null)));
    return views.filter((v): v is RunView => v !== null).reverse();
  }, [rt.client, session?.runIds.join(',')], { pollMs: 3000 });
  return (
    <div className="stack">
      <div className="spread">
        <div>
          <h1>Harbor Lights runs</h1>
          <p className="muted">Test pricing, messaging and operating decisions on a synthetic park before trying them on real visitors.</p>
        </div>
        {isOperator && <Link className="btn primary" to="/setup">New run</Link>}
      </div>
      {!session?.roles.length && (
        <Alert tone="info" title="No role in this session">
          Open a share link from an operator, or <Link to="/session">sign in with an operator credential</Link>.
        </Alert>
      )}
      <Panel title="Runs you can see">
        {runs.loading && !runs.data && <Spinner label="Loading runs…" />}
        {runs.error && <ErrorBox error={runs.error} transport={runs.transport} onRetry={runs.reload} />}
        {runs.data && runs.data.length === 0 && <Empty>No runs yet.{isOperator ? ' Start one from New run.' : ''}</Empty>}
        {runs.data && runs.data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Run</th><th>Status</th><th>Mode</th><th>Sim time</th><th>Open</th></tr></thead>
              <tbody>
                {runs.data.map((r) => (
                  <tr key={r.runId}>
                    <td className="mono">{r.runId}</td>
                    <td><RunStatusBadge status={r.status} /></td>
                    <td>{rt.settings.profile === 'fixture' ? 'Fixture (scripted)' : r.mode}</td>
                    <td className="mono">{formatSimOffset(r.simMs)}</td>
                    <td className="row" style={{ gap: 8 }}>
                      <Link to={`/runs/${encodeURIComponent(r.runId)}`}>Live</Link>
                      <Link to={`/runs/${encodeURIComponent(r.runId)}/results`}>Results</Link>
                      <Link to={`/runs/${encodeURIComponent(r.runId)}/replay`}>Replay</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Roadmap (not available)">
        <p className="small muted">Blueprint/BIM import, other venue types, automatic optimization and live real-world telemetry are future scope. There is no upload here because nothing would parse it.</p>
      </Panel>
    </div>
  );
}
