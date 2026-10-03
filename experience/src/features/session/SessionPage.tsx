import { useState } from 'react';
import { useRuntime } from '../../runtime/RuntimeProvider';
import { Alert, KV, Panel } from '../../ui/components';

/** Fixture-only allowlisted local identity; the live build has no such constant. */
const FIXTURE_HINT = import.meta.env.VITE_RUNTIME_PROFILE === 'fixture' ? 'fixture-operator-local' : null;

export function SessionPage() {
  const rt = useRuntime();
  const [token, setToken] = useState('');
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <h1>Session</h1>
      <Panel title="Current session">
        {rt.session ? (
          <KV items={[
            ['Identity', <span className="mono" key="i">{rt.session.identity}</span>],
            ['Roles', rt.session.roles.length ? rt.session.roles.join(', ') : 'none (read access only through share links)'],
            ['Runs visible', String(rt.session.runIds.length)],
            ['Profile', rt.settings.profile],
          ]} />
        ) : <Alert tone="warn">{rt.sessionError ?? 'Loading session…'}</Alert>}
        <p className="small muted" style={{ marginTop: 8 }}>Roles come from the server session and its grants. Links or URL parameters cannot grant roles.</p>
      </Panel>
      <Panel title="Use a different credential">
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (token.trim()) rt.signIn(token.trim()); }}>
          <label className="field">
            <span className="label">Session credential</span>
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-describedby="cred-help" />
          </label>
          <p id="cred-help" className="small muted">Operator credentials come from the trusted local allowlist bootstrap (see HANDOFF). The credential is stored only in this browser for this session and never placed in URLs.</p>
          <div className="row">
            <button type="submit" className="btn primary" disabled={!token.trim()}>Use credential</button>
            {FIXTURE_HINT && (
              <button type="button" className="btn" onClick={() => rt.signIn(FIXTURE_HINT)} data-testid="fixture-operator-signin">
                Sign in as fixture operator (fixture only)
              </button>
            )}
          </div>
        </form>
      </Panel>
      <Panel title="Sign out">
        <p className="small muted">Clears this browser's session credential and cached private run data. You become an anonymous session with no roles.</p>
        <button type="button" className="btn danger" onClick={() => rt.signOut()} data-testid="sign-out">Sign out</button>
      </Panel>
    </div>
  );
}
