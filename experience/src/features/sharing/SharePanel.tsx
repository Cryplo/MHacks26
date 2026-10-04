import { useState } from 'react';
import type { DomainError, Id } from '../../../contract/behavior-v1';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { ActionButton, Alert, ErrorBox } from '../../ui/components';
import { formatEpoch } from '../../ui/format';
import { buildShareLink, generateShareToken, hashShareToken } from './shareToken';

const EXPIRY = [{ label: '1 hour', ms: 3600_000 }, { label: '8 hours', ms: 8 * 3600_000 }, { label: '24 hours', ms: 24 * 3600_000 }, { label: '7 days', ms: 7 * 24 * 3600_000 }];
type Issued = { grantId: Id; access: 'viewer' | 'operator'; expiresAtEpochMs: number; revoked: boolean };

export function SharePanel(props: { runId: Id }) {
  const rt = useRuntime();
  const [access, setAccess] = useState<'viewer' | 'operator'>('viewer');
  const [expiry, setExpiry] = useState(EXPIRY[1]!.ms);
  const [ack, setAck] = useState(false);
  const [link, setLink] = useState<string | null>(null); // held in memory only; never logged or persisted
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ error: DomainError; transport: boolean } | null>(null);
  const [issued, setIssued] = useState<Issued[]>([]);
  const [copied, setCopied] = useState(false);

  const issue = async () => {
    setBusy(true); setError(null); setLink(null); setCopied(false);
    const token = generateShareToken();
    const tokenHash = await hashShareToken(token);
    const expiresAtEpochMs = Date.now() + expiry;
    const out = await rt.runner.run('issueShare', { runId: props.runId, access, tokenHash, expiresAtEpochMs }, `share:${tokenHash}`);
    setBusy(false);
    if (out.kind === 'accepted') {
      setLink(buildShareLink(window.location.origin, token));
      setIssued((l) => [{ grantId: out.result.grantId, access, expiresAtEpochMs, revoked: false }, ...l]);
    } else setError({ error: out.error, transport: out.kind === 'transport' });
  };
  const revoke = async (grantId: Id) => {
    const out = await rt.runner.run('revokeShare', { grantId }, `revoke:${grantId}`);
    if (out.kind === 'accepted') setIssued((l) => l.map((g) => (g.grantId === grantId ? { ...g, revoked: true } : g)));
    else setError({ error: out.error, transport: out.kind === 'transport' });
  };
  return (
    <div className="stack" data-testid="share-panel">
      <h3 style={{ margin: 0 }}>Share this run</h3>
      <p className="small muted">A link carries a random capability in its #fragment. Only its SHA-256 is sent to the server. Recipients redeem it through the server, which binds a scoped role to their own session.</p>
      <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ fontWeight: 600 }}>Access</legend>
        <label className="row small"><input type="radio" name="access" checked={access === 'viewer'} onChange={() => setAccess('viewer')} /> Read-only viewer (default)</label>
        <label className="row small"><input type="radio" name="access" checked={access === 'operator'} onChange={() => { setAccess('operator'); setAck(false); }} /> Operator (can control this run)</label>
      </fieldset>
      {access === 'operator' && (
        <Alert tone="warn" title="Operator links grant control">
          <p>Anyone holding this link can pause, change speed and schedule interventions on this run until it expires or you revoke it. Only the run owner can issue one.</p>
          <label className="row small"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand and will share it only with a trusted person.</label>
        </Alert>
      )}
      <label className="field"><span className="label">Expires after</span>
        <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>{EXPIRY.map((x) => <option key={x.ms} value={x.ms}>{x.label}</option>)}</select>
      </label>
      <ActionButton tone="primary" onClick={() => void issue()} busy={busy} testId="issue-share"
        disabledReason={access === 'operator' && !ack ? 'Confirm the operator-access warning first.' : null}>Create {access} link</ActionButton>
      {error && <ErrorBox error={error.error} transport={error.transport} />}
      {link && (
        <div className="stack" style={{ gap: 4 }}>
          <label className="field"><span className="label">Link (shown once; not stored)</span>
            <input type="text" readOnly value={link} onFocus={(e) => e.currentTarget.select()} data-testid="share-link" />
          </label>
          <div className="row">
            <button type="button" className="btn small" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => setCopied(false))}>Copy</button>
            <button type="button" className="btn small" onClick={() => setLink(null)}>Done (forget link)</button>
            {copied && <span className="small" role="status">Copied</span>}
          </div>
        </div>
      )}
      {issued.length > 0 && (
        <div>
          <h4>Links issued in this session</h4>
          <ul className="card-list small">
            {issued.map((g) => (
              <li key={g.grantId} className="spread">
                <span><span className="mono">{g.grantId}</span> · {g.access} · expires {formatEpoch(g.expiresAtEpochMs)}</span>
                {g.revoked ? <span className="badge neutral">revoked</span> : <button type="button" className="btn small danger" onClick={() => void revoke(g.grantId)}>Revoke</button>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
