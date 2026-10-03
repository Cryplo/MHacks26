import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Id } from '../../../contract/behavior-v1';
import { ErrorBoundary } from '../../App';
import { useLiveRun, useLiveSelector, useRunManifestAndPark } from '../../data/hooks';
import { isAccessError } from '../../runtime/errors';
import { clearPrivateRunData, useRuntime } from '../../runtime/RuntimeProvider';
import type { ColorMode } from '../../renderer/colors';
import { Alert, ErrorBox, Spinner } from '../../ui/components';
import { InspectorPanel } from '../inspector/InspectorPanel';
import { WhatIfPanel } from '../scenarios/WhatIfPanel';
import { SharePanel } from '../sharing/SharePanel';
import { EventFeed } from './EventFeed';
import { GuestList } from './GuestList';
import { HealthStrip } from './HealthStrip';
import { Legend } from './Legend';
import { ParkMap } from './ParkMap';
import { StatsPanel } from './StatsPanel';

type Tab = 'stats' | 'guests' | 'inspector' | 'whatif' | 'share';

export function LivePage() {
  const { runId = '' } = useParams();
  const rt = useRuntime();
  const loaded = useRunManifestAndPark(runId);
  const conn = useLiveRun(runId);
  const store = conn.store;
  const storeError = useLiveSelector(store, (s) => s.error);
  const [search, setSearch] = useSearchParams();
  const selectedId = search.get('guest');
  const [tab, setTab] = useState<Tab>(selectedId ? 'inspector' : 'stats');
  const [colorMode, setColorMode] = useState<ColorMode>('state');
  const groupId = useLiveSelector(store, (s) => (selectedId ? s.agents.get(selectedId)?.groupId ?? null : null));
  const agents = useLiveSelector(store, (s) => s.agents);
  const groupIds = useMemo(() => (groupId ? [...agents.values()].filter((a) => a.groupId === groupId).map((a) => a.agentId) : []), [agents, groupId]);
  const metricsAt = useLiveSelector(store, (s) => s.metrics?.simMs ?? null);
  const canOperate = useMemo(() => Boolean(rt.session?.roles.includes('operator')), [rt.session]);
  const isFixture = rt.settings.profile === 'fixture';

  const select = useCallback((id: Id | null) => {
    setSearch((p) => { const n = new URLSearchParams(p); if (id) n.set('guest', id); else n.delete('guest'); return n; }, { replace: true });
    if (id) setTab('inspector');
  }, [setSearch]);

  // Revoked/expired access clears cached private run data and stops showing it.
  const accessLost = storeError && isAccessError(storeError.code);
  const refreshSession = rt.refreshSession;
  useEffect(() => { if (accessLost) { clearPrivateRunData(); conn.disconnect(); void refreshSession(); } }, [accessLost, conn, refreshSession]);

  if (accessLost || (loaded.error && isAccessError(loaded.error.code))) {
    const err = storeError ?? loaded.error!;
    return (
      <div style={{ padding: 16, maxWidth: 720 }}>
        <Alert tone="bad" title="No access to this run"><p>{err.message}</p><p className="small">Access is scoped to this run only. Ask its operator for a new link, or <Link to="/session">sign in</Link>.</p></Alert>
      </div>
    );
  }
  if (loaded.error) return <div style={{ padding: 16 }}><ErrorBox error={loaded.error} transport={loaded.transport} onRetry={loaded.reload} /></div>;
  if (!loaded.data) return <div style={{ padding: 16 }}><Spinner label="Loading run manifest and verified park bundle…" /></div>;
  const { manifest, park, codes } = loaded.data;
  const tabs: [Tab, string][] = [['stats', 'Stats'], ['guests', 'Guests'], ['inspector', 'Inspector'], ...(canOperate ? [['whatif', 'What-if'], ['share', 'Share']] as [Tab, string][] : [])];

  return (
    <div className="live-shell" data-testid="live-page">
      <HealthStrip store={store} runId={runId} manifest={manifest} openLocal={park.openLocal} canOperate={canOperate} />
      <div className="map-area">
        <ErrorBoundary label="Map error">
          <ParkMap store={store} park={park} codes={codes} selectedId={selectedId} groupIds={groupIds} colorMode={colorMode} onSelect={select} showOperatorTruth={canOperate} />
        </ErrorBoundary>
        <div className="map-overlay top-left" style={{ pointerEvents: 'none' }}>
          <div style={{ pointerEvents: 'auto' }}><Legend mode={colorMode} onMode={setColorMode} openLocal={park.openLocal} asOfSimMs={metricsAt} /></div>
          <div className="row" style={{ marginLeft: 'auto', pointerEvents: 'auto' }}>
            <Link className="btn small" to={`/runs/${encodeURIComponent(runId)}/results`}>Results</Link>
            <Link className="btn small" to={`/runs/${encodeURIComponent(runId)}/replay`}>Replay</Link>
          </div>
        </div>
      </div>
      <aside className="side" aria-label="Run details">
        <div className="side-tabs" role="tablist" aria-label="Panels">
          {tabs.map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} aria-controls={`panel-${k}`} id={`tab-${k}`} onClick={() => setTab(k)} data-testid={`tab-${k}`}>{label}</button>
          ))}
        </div>
        <div className="side-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'stats' && <StatsPanel store={store} openLocal={park.openLocal} isFixture={isFixture} />}
          {tab === 'guests' && <GuestList store={store} selectedId={selectedId} onSelect={select} />}
          {tab === 'inspector' && (selectedId
            ? <ErrorBoundary label="Inspector error"><InspectorPanel key={selectedId} runId={runId} agentId={selectedId} store={store} park={park} canOperate={canOperate} onSelectAgent={select} isFixture={isFixture} /></ErrorBoundary>
            : <p className="muted">Select a guest on the map or from the Guests tab.</p>)}
          {/* Kept mounted so drafts, receipts and issued links survive tab switches. */}
          {canOperate && <div hidden={tab !== 'whatif'}><WhatIfPanel runId={runId} store={store} park={park} manifest={manifest} capabilities={rt.capabilities} /></div>}
          {canOperate && <div hidden={tab !== 'share'}><SharePanel runId={runId} /></div>}
        </div>
      </aside>
      <div className="feed"><EventFeed store={store} park={park} runId={runId} onAgent={(id) => select(id)} /></div>
    </div>
  );
}
