import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { DomainError } from '../../../contract/behavior-v1';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { Alert, ErrorBox, Spinner } from '../../ui/components';
import { readShareFragment, scrubFragment } from './shareToken';

export function RedeemPage() {
  const rt = useRuntime();
  const navigate = useNavigate();
  const [state, setState] = useState<{ kind: 'working' } | { kind: 'none' } | { kind: 'error'; error: DomainError; transport: boolean }>({ kind: 'working' });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = readShareFragment(window.location.hash);
    scrubFragment(); // capability material leaves the address bar/history before any request
    if (!token) { setState({ kind: 'none' }); return; }
    void rt.runner.run('redeemShare', { token }, `redeem:${crypto.randomUUID()}`).then(async (out) => {
      if (out.kind === 'accepted') {
        await rt.refreshSession();
        navigate(`/runs/${encodeURIComponent(out.result.runId)}`, { replace: true });
      } else setState({ kind: 'error', error: out.error, transport: out.kind === 'transport' });
    });
  }, [rt, navigate]);
  return (
    <div className="stack" style={{ maxWidth: 640 }}>
      <h1>Open shared run</h1>
      {state.kind === 'working' && <Spinner label="Redeeming share link…" />}
      {state.kind === 'none' && <Alert tone="warn" title="No share link">This page expects a share link containing an access fragment. Ask the run's operator for a new link.</Alert>}
      {state.kind === 'error' && (
        <>
          <ErrorBox error={state.error} transport={state.transport} />
          <p className="muted small">The link was removed from your address bar. Expired or revoked links cannot be reused; ask the operator for a new one. Your other access is unaffected.</p>
        </>
      )}
      <p><Link to="/">Back to runs</Link></p>
    </div>
  );
}
