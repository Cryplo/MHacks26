import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useParams } from 'react-router-dom';
import type { RuntimeSettings } from './runtime/config';
import { RuntimeProvider, useRuntime } from './runtime/RuntimeProvider';
import { Brand, FixtureChip, Spinner } from './ui/components';
import { HomePage } from './features/home/HomePage';
import { RedeemPage } from './features/sharing/RedeemPage';

const SetupPage = lazy(() => import('./features/setup/SetupPage').then((m) => ({ default: m.SetupPage })));
const LivePage = lazy(() => import('./features/live/LivePage').then((m) => ({ default: m.LivePage })));
const ResultsPage = lazy(() => import('./features/results/ResultsPage').then((m) => ({ default: m.ResultsPage })));
const PrintPage = lazy(() => import('./features/results/PrintPage').then((m) => ({ default: m.PrintPage })));
const ExperimentSetupPage = lazy(() => import('./features/results/ExperimentSetupPage').then((m) => ({ default: m.ExperimentSetupPage })));
const ExperimentPage = lazy(() => import('./features/results/ExperimentPage').then((m) => ({ default: m.ExperimentPage })));

export function App(props: { settings: RuntimeSettings }) {
  return (
    <ErrorBoundary>
      <RuntimeProvider settings={props.settings}>
        <BrowserRouter>
          <Shell />
        </BrowserRouter>
      </RuntimeProvider>
    </ErrorBoundary>
  );
}

/** Full-bleed routes (live map, replay) draw their own slim run bar instead of the app header. */
const isFullBleed = (path: string) => /^\/runs\/[^/]+\/?$/.test(path);

function Shell() {
  const rt = useRuntime();
  const { pathname } = useLocation();
  const isOperator = rt.session?.roles.includes('operator') ?? false;
  const full = isFullBleed(pathname);
  return (
    <div className="app">
      <a className="skip-link" href="#main">Skip to content</a>
      {!full && (
        <header className="topbar">
          <Brand />
          <nav className="nav" aria-label="Primary">
            <NavLink to="/" end>Simulations</NavLink>
            {isOperator && <NavLink to="/experiments/new">Compare A/B</NavLink>}
          </nav>
          <div className="session">
            <FixtureChip />
          </div>
        </header>
      )}
      <Suspense fallback={<main><Spinner label="Loading…" /></main>}>
        <Routes>
          <Route path="/" element={<main id="main"><HomePage /></main>} />
          <Route path="/session" element={<Navigate to="/" replace />} />
          <Route path="/share" element={<main id="main"><RedeemPage /></main>} />
          <Route path="/setup" element={<main id="main"><SetupPage /></main>} />
          <Route path="/runs/:runId" element={<main id="main" className="full"><LivePage /></main>} />
          <Route path="/runs/:runId/results" element={<main id="main"><ResultsPage /></main>} />
          <Route path="/runs/:runId/print" element={<main id="main"><PrintPage /></main>} />
          <Route path="/runs/:runId/replay" element={<ReplayRedirect />} />
          <Route path="/experiments/new" element={<main id="main"><ExperimentSetupPage /></main>} />
          <Route path="/experiments/:experimentId" element={<main id="main"><ExperimentPage /></main>} />
          <Route path="*" element={<main id="main"><h1>Not found</h1><p><Link to="/">Back to simulations</Link></p></main>} />
        </Routes>
      </Suspense>
    </div>
  );
}

/** Replay lives in the live view's timeline now: open the run scrubbed to opening. */
function ReplayRedirect() {
  const { runId = '' } = useParams();
  return <Navigate to={`/runs/${encodeURIComponent(runId)}?t=0`} replace />;
}

export const shortId = (id: string) => (id.length > 22 ? `${id.slice(0, 20)}…` : id);

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error('UI error boundary', error.message, info.componentStack?.split('\n')[1]?.trim()); }
  override render() {
    if (this.state.error) {
      return (
        <div className="panel" role="alert" style={{ margin: 16 }}>
          <h2>{this.props.label ?? 'Something went wrong'}</h2>
          <p className="muted">{this.state.error.message}</p>
          <button type="button" className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
