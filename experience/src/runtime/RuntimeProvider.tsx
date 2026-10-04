import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Capabilities, Id, Role, RuntimeClient } from '../../contract/behavior-v1';
import { CommandRunner, sessionIntentStore } from './commands';
import type { RuntimeSettings } from './config';
import { classifyError } from './errors';
import { loadRuntime, RuntimeStartupError, type LoaderDeps } from './loader';
import { browserTokenStore, type TokenStore } from './tokenStore';

export type SessionInfo = { identity: string; roles: Role[]; runIds: Id[] };
export type Runtime = {
  client: RuntimeClient; capabilities: Capabilities; settings: RuntimeSettings; runner: CommandRunner; tokens: TokenStore;
  session: SessionInfo | null; sessionError: string | null; refreshSession: () => Promise<SessionInfo | null>;
  signIn: (token: string) => void; signOut: () => void; generation: number;
};

const Ctx = createContext<Runtime | null>(null);

export function useRuntime(): Runtime {
  const r = useContext(Ctx);
  if (!r) throw new Error('useRuntime outside RuntimeProvider');
  return r;
}

/** Fixture adapter is included ONLY in the fixture build (Vite replaces the env constant). */
const loadFixture: LoaderDeps['loadFixture'] = import.meta.env.VITE_RUNTIME_PROFILE === 'fixture'
  ? () => import('../fixture/client').then((m) => m.createFixtureRuntimeClient)
  : () => Promise.reject(new Error('This build does not include the fixture adapter.'));

type LoadState = { kind: 'loading' } | { kind: 'error'; error: RuntimeStartupError | Error } | { kind: 'ready'; runtime: Omit<Runtime, 'session' | 'sessionError' | 'refreshSession' | 'signIn' | 'signOut' | 'generation'> };

const CLEAR_PREFIXES = ['behavior-engine.intent.', 'behavior-engine.cache.'];
export function clearPrivateRunData() {
  for (const store of [window.sessionStorage, window.localStorage]) {
    try {
      for (const k of Object.keys(store)) if (CLEAR_PREFIXES.some((p) => k.startsWith(p))) store.removeItem(k);
    } catch { /* storage unavailable */ }
  }
}

export function RuntimeProvider(props: { settings: RuntimeSettings; children: ReactNode; deps?: Partial<LoaderDeps> }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [generation, setGeneration] = useState(0);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const tokens = useMemo(() => props.deps?.tokens ?? browserTokenStore(props.settings.profile), [props.deps?.tokens, props.settings.profile]);
  const clientRef = useRef<RuntimeClient | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    loadRuntime(props.settings, {
      importModule: props.deps?.importModule ?? ((url) => import(/* @vite-ignore */ url)),
      loadFixture: props.deps?.loadFixture ?? loadFixture,
      tokens,
    }).then((loaded) => {
      if (cancelled) { void loaded.client.close(); return; }
      clientRef.current = loaded.client;
      const runner = new CommandRunner(loaded.client, { durable: sessionIntentStore() });
      setState({ kind: 'ready', runtime: { ...loaded, runner, tokens } });
    }, (error: unknown) => {
      if (!cancelled) setState({ kind: 'error', error: error instanceof Error ? error : new Error(String(error)) });
    });
    return () => {
      cancelled = true;
      void clientRef.current?.close();
      clientRef.current = null;
    };
  }, [props.settings, props.deps, tokens, generation]);

  const client = state.kind === 'ready' ? state.runtime.client : null;
  const refreshSession = useCallback(async () => {
    if (!client) return null;
    try {
      const s = await client.query('session', {});
      setSession(s);
      setSessionError(null);
      return s;
    } catch (e) {
      setSession(null);
      setSessionError(classifyError(e).error.message);
      return null;
    }
  }, [client]);

  useEffect(() => { void refreshSession(); }, [refreshSession]);

  const signIn = useCallback((token: string) => {
    clearPrivateRunData();
    tokens.set(token, { explicit: true });
    setSession(null);
    setGeneration((g) => g + 1);
  }, [tokens]);
  const signOut = useCallback(() => {
    clearPrivateRunData();
    tokens.clear();
    setSession(null);
    setGeneration((g) => g + 1);
  }, [tokens]);

  if (state.kind === 'loading') {
    return <div className="fallback-map" role="status"><span className="spinner" aria-hidden="true" />&nbsp;Connecting to the {props.settings.profile} runtime…</div>;
  }
  if (state.kind === 'error') return <StartupError error={state.error} settings={props.settings} />;
  const value: Runtime = { ...state.runtime, session, sessionError, refreshSession, signIn, signOut, generation };
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

function StartupError(props: { error: Error; settings: RuntimeSettings }) {
  const e = props.error;
  const kind = e instanceof RuntimeStartupError ? e.kind : 'config';
  return (
    <main>
      <div className="panel stack" role="alert" style={{ maxWidth: 720, margin: '40px auto' }}>
        <h1>Runtime unavailable</h1>
        <p><strong>{e.message}</strong></p>
        {e instanceof RuntimeStartupError && e.detail && <p className="mono">{e.detail}</p>}
        <dl className="kv">
          <dt>Profile</dt><dd>{props.settings.profile}</dd>
          <dt>Adapter</dt><dd className="mono">{props.settings.adapterUrl || '(built-in fixture)'}</dd>
          <dt>Error kind</dt><dd>{kind}</dd>
        </dl>
        <p className="muted">This build does not fall back to fixture data. Fix the configuration and reload. See experience/docs/HANDOFF.md for adapter build steps.</p>
        <p><button type="button" className="btn" onClick={() => window.location.reload()}>Reload</button></p>
      </div>
    </main>
  );
}
