import { useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Id, RunManifest, RunView } from '../../../contract/behavior-v1';
import { useAsync } from '../../data/useAsync';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { Alert, ErrorBox, Icon, Spinner } from '../../ui/components';
import { formatDuration } from '../../ui/format';
import { RunStatusBadge } from '../live/RunStatusBadge';

export function HomePage() {
  const rt = useRuntime();
  const navigate = useNavigate();
  const session = rt.session;
  const isOperator = session?.roles.includes('operator') ?? false;
  // Manifests are immutable, so each run's scenario label is fetched once.
  const manifests = useRef(new Map<Id, RunManifest | null>());
  const runs = useAsync(async () => {
    const ids = session?.runIds ?? [];
    const views = await Promise.all(ids.map((runId) => rt.client.query('getRun', { runId }).then((v) => v, () => null)));
    await Promise.all(ids.filter((id) => !manifests.current.has(id)).map((runId) =>
      rt.client.query('getManifest', { runId }).then((m) => { manifests.current.set(runId, m); }, () => { manifests.current.set(runId, null); })));
    return views.filter((v): v is RunView => v !== null).reverse();
  }, [rt.client, session?.runIds.join(',')], { pollMs: 3000 });
  const open = (r: RunView) => navigate(`/runs/${encodeURIComponent(r.runId)}`);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Simulations</h1>
          <p>Try a pricing, messaging or operating change on a synthetic Harbor Lights crowd before trying it on real visitors.</p>
        </div>
        {isOperator && <Link className="btn primary large" to="/setup"><Icon name="plus" />New simulation</Link>}
      </div>
      {!session?.roles.length && (
        <Alert tone="info" title="Nothing to show yet">
          Open a share link to view a simulation.
        </Alert>
      )}
      {runs.loading && !runs.data && <Spinner label="Loading simulations…" />}
      {runs.error && <ErrorBox error={runs.error} transport={runs.transport} onRetry={runs.reload} />}
      {runs.data && runs.data.length === 0 && (
        <div className="empty">
          <h3>No simulations yet</h3>
          <p>{isOperator ? 'Start one: pick a crowd size and watch guests decide in real time.' : 'Simulations shared with you will appear here.'}</p>
          {isOperator && <Link className="btn primary" to="/setup">New simulation</Link>}
        </div>
      )}
      {runs.data && runs.data.length > 0 && (
        <div className="panel flush table-wrap">
          <table>
            <thead><tr><th>Simulation</th><th>Status</th><th className="num">Simulated time</th><th><span className="sr-only">Links</span></th></tr></thead>
            <tbody>
              {runs.data.map((r) => {
                const m = manifests.current.get(r.runId);
                const href = `/runs/${encodeURIComponent(r.runId)}`;
                return (
                  <tr key={r.runId} className="clickable" onClick={(e) => { if (!(e.target as HTMLElement).closest('a')) open(r); }}>
                    <td>
                      <div className="run-row-title">
                        <Link to={href}>{m ? m.scenario.label : 'Simulation'}</Link>
                        <span className="faint small">{m && m.scenario.events.length ? `${m.scenario.events.length} scheduled change${m.scenario.events.length === 1 ? '' : 's'}` : 'No scheduled changes'}{m ? ` · ${formatDuration(m.config.horizonMs)} day` : ''}</span>
                      </div>
                    </td>
                    <td><RunStatusBadge status={r.status} /></td>
                    <td className="num">{formatDuration(r.simMs)}</td>
                    <td>
                      <div className="row-actions">
                        <Link to={href}>Live</Link>
                        <Link to={`${href}/results`}>Results</Link>
                        <Link to={`${href}?t=0`}>Replay</Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
