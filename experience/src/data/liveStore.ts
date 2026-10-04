/**
 * Coherent live state for one run. Snapshot first; patches apply only when runId matches
 * and fromRevision equals the current revision. Duplicates are ignored, gaps freeze the
 * view (stale) and trigger a fresh snapshot. Unchanged entities keep object identity so
 * React selectors and the renderer only touch what changed. Feeds/charts are bounded.
 */
import type {
  AgentView, DomainError, EventRecord, Health, Id, LivePatch, LiveSnapshot, MetricSnapshot,
  PlaceView, QueueView, RunView,
} from '../../contract/behavior-v1';

export type ConnectionStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'resyncing' | 'closed' | 'error';
export const EVENT_LIMIT = 300;
export const METRIC_HISTORY_LIMIT = 720;
const BUFFER_LIMIT = 200;

export type LiveState = {
  runId: Id | null;
  revision: number;
  run: RunView | null;
  agents: ReadonlyMap<Id, AgentView>;
  places: ReadonlyMap<Id, PlaceView>;
  queues: ReadonlyMap<Id, QueueView>;
  metrics: MetricSnapshot | null;
  metricHistory: readonly MetricSnapshot[];
  health: Health | null;
  events: readonly EventRecord[];
  lastSequence: number;
  /** True while a gap is being repaired: content is frozen and labeled stale. */
  stale: boolean;
  status: ConnectionStatus;
  error: DomainError | null;
  /** Monotonic counter of applied snapshots (renderer uses it to reset interpolation). */
  snapshotEpoch: number;
  counters: { applied: number; duplicates: number; gaps: number; wrongRun: number; resyncs: number };
};

export type PatchResult = 'applied' | 'duplicate' | 'gap' | 'wrong_run' | 'buffered' | 'no_snapshot';

const EMPTY_STATE: LiveState = {
  runId: null, revision: -1, run: null, agents: new Map(), places: new Map(), queues: new Map(),
  metrics: null, metricHistory: [], health: null, events: [], lastSequence: -1, stale: false,
  status: 'idle', error: null, snapshotEpoch: 0,
  counters: { applied: 0, duplicates: 0, gaps: 0, wrongRun: 0, resyncs: 0 },
};

export function sameAgent(a: AgentView, b: AgentView): boolean {
  return a.agentId === b.agentId && a.groupId === b.groupId && a.state === b.state
    && a.position.xM === b.position.xM && a.position.yM === b.position.yM
    && a.velocity.xMps === b.velocity.xMps && a.velocity.yMps === b.velocity.yMps
    && a.targetPlaceId === b.targetPlaceId && a.experienceValue === b.experienceValue
    && a.latestEvidenceId === b.latestEvidenceId
    && a.needs.hunger === b.needs.hunger && a.needs.fatigue === b.needs.fatigue
    && a.needs.patience === b.needs.patience && a.needs.fun === b.needs.fun
    && (a.rating === b.rating || (a.rating !== null && b.rating !== null && a.rating.value === b.rating.value
      && a.rating.atMs === b.rating.atMs && a.rating.source === b.rating.source));
}
const samePlace = (a: PlaceView, b: PlaceView) => a.closed === b.closed && a.boardText === b.boardText
  && a.boardVersion === b.boardVersion && a.noticeVersion === b.noticeVersion && a.predictedWaitMs === b.predictedWaitMs;
const sameQueue = (a: QueueView, b: QueueView) => JSON.stringify(a) === JSON.stringify(b);

export class LiveStore {
  private state: LiveState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private buffer: LivePatch[] = [];

  constructor(private readonly onGap: (runId: Id) => void = () => undefined) {}

  getState = (): LiveState => this.state;
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };
  listenerCount = () => this.listeners.size;

  private set(next: Partial<LiveState>) {
    this.state = { ...this.state, ...next };
    this.listeners.forEach((l) => l());
  }

  /** Switch to a run (or clear). Drops all prior run content and buffered patches. */
  reset(runId: Id | null) {
    this.buffer = [];
    this.state = { ...EMPTY_STATE, runId, snapshotEpoch: this.state.snapshotEpoch + 1, status: runId ? 'connecting' : 'idle' };
    this.listeners.forEach((l) => l());
  }

  setStatus(status: ConnectionStatus) {
    if (this.state.status !== status) this.set({ status });
  }
  setError(error: DomainError | null) {
    this.set({ error, status: error ? 'error' : this.state.status });
  }

  applySnapshot(s: LiveSnapshot): boolean {
    if (this.state.runId !== null && s.run.runId !== this.state.runId) {
      this.set({ counters: { ...this.state.counters, wrongRun: this.state.counters.wrongRun + 1 } });
      return false;
    }
    const prev = this.state;
    const agents = new Map<Id, AgentView>();
    for (const a of s.agents) {
      const old = prev.agents.get(a.agentId);
      agents.set(a.agentId, old && sameAgent(old, a) ? old : a);
    }
    const places = new Map<Id, PlaceView>();
    for (const p of s.places) {
      const old = prev.places.get(p.placeId);
      places.set(p.placeId, old && samePlace(old, p) ? old : p);
    }
    const queues = new Map<Id, QueueView>();
    for (const q of s.queues) {
      const old = prev.queues.get(q.placeId);
      queues.set(q.placeId, old && sameQueue(old, q) ? old : q);
    }
    const events = mergeEvents(prev.runId === s.run.runId ? prev.events : [], s.recentEvents);
    const wasResync = prev.stale;
    this.state = {
      ...prev,
      runId: s.run.runId,
      revision: s.run.revision,
      run: s.run,
      agents, places, queues,
      metrics: s.metrics,
      metricHistory: pushMetric(prev.runId === s.run.runId ? prev.metricHistory : [], s.metrics),
      health: s.health,
      events,
      lastSequence: events.length ? events[events.length - 1]!.sequence : prev.lastSequence,
      stale: false,
      status: prev.status === 'resyncing' || prev.status === 'connecting' ? 'live' : prev.status,
      error: null,
      snapshotEpoch: prev.snapshotEpoch + 1,
      counters: { ...prev.counters, resyncs: prev.counters.resyncs + (wasResync ? 1 : 0) },
    };
    // Replay buffered patches that continue from the snapshot; older ones are duplicates.
    const buffered = this.buffer.sort((a, b) => a.fromRevision - b.fromRevision);
    this.buffer = [];
    this.listeners.forEach((l) => l());
    for (const p of buffered) if (p.toRevision > this.state.revision) this.applyPatch(p);
    return true;
  }

  applyPatch(p: LivePatch): PatchResult {
    const st = this.state;
    if (st.runId !== null && p.runId !== st.runId) {
      this.set({ counters: { ...st.counters, wrongRun: st.counters.wrongRun + 1 } });
      return 'wrong_run';
    }
    if (st.revision < 0) {
      this.bufferPatch(p);
      return 'no_snapshot';
    }
    if (p.toRevision <= st.revision) {
      this.set({ counters: { ...st.counters, duplicates: st.counters.duplicates + 1 } });
      return 'duplicate';
    }
    if (st.stale) {
      this.bufferPatch(p);
      return 'buffered';
    }
    if (p.fromRevision !== st.revision) {
      this.bufferPatch(p);
      this.set({ stale: true, status: 'resyncing', counters: { ...st.counters, gaps: st.counters.gaps + 1 } });
      this.onGap(p.runId);
      return 'gap';
    }
    let agents: Map<Id, AgentView> | null = null;
    for (const a of p.agents.upsert) {
      const old = st.agents.get(a.agentId);
      if (old && sameAgent(old, a)) continue;
      agents ??= new Map(st.agents);
      agents.set(a.agentId, a);
    }
    for (const id of p.agents.removeIds) {
      if (!st.agents.has(id) && !agents?.has(id)) continue;
      agents ??= new Map(st.agents);
      agents.delete(id);
    }
    let places: Map<Id, PlaceView> | null = null;
    for (const pl of p.places) {
      const old = st.places.get(pl.placeId);
      if (old && samePlace(old, pl)) continue;
      places ??= new Map(st.places);
      places.set(pl.placeId, pl);
    }
    let queues: Map<Id, QueueView> | null = null;
    for (const q of p.queues) {
      const old = st.queues.get(q.placeId);
      if (old && sameQueue(old, q)) continue;
      queues ??= new Map(st.queues);
      queues.set(q.placeId, q);
    }
    const events = p.appendedEvents.length ? mergeEvents(st.events, p.appendedEvents) : st.events;
    this.state = {
      ...st,
      revision: p.toRevision,
      run: p.run,
      agents: agents ?? st.agents,
      places: places ?? st.places,
      queues: queues ?? st.queues,
      metrics: p.metrics ?? st.metrics,
      metricHistory: p.metrics ? pushMetric(st.metricHistory, p.metrics) : st.metricHistory,
      health: p.health ?? st.health,
      events,
      lastSequence: events.length ? Math.max(st.lastSequence, events[events.length - 1]!.sequence) : st.lastSequence,
      counters: { ...st.counters, applied: st.counters.applied + 1 },
    };
    this.listeners.forEach((l) => l());
    return 'applied';
  }

  private bufferPatch(p: LivePatch) {
    this.buffer.push(p);
    if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
  }
  bufferedCount = () => this.buffer.length;
}

/** Merge by sequence: never concatenates an event twice; keeps the newest EVENT_LIMIT. */
export function mergeEvents(existing: readonly EventRecord[], incoming: readonly EventRecord[]): EventRecord[] {
  const bySeq = new Map<number, EventRecord>();
  for (const e of existing) bySeq.set(e.sequence, e);
  for (const e of incoming) bySeq.set(e.sequence, e);
  const merged = [...bySeq.values()].sort((a, b) => a.sequence - b.sequence);
  return merged.length > EVENT_LIMIT ? merged.slice(merged.length - EVENT_LIMIT) : merged;
}

/** Keep the latest revision for each measurement time, sorted by (simMs, revision), bounded. */
export function pushMetric(history: readonly MetricSnapshot[], m: MetricSnapshot): MetricSnapshot[] {
  const out = history.filter((h) => h.simMs !== m.simMs || h.revision > m.revision);
  if (!out.some((h) => h.simMs === m.simMs)) out.push(m);
  out.sort((a, b) => a.simMs - b.simMs || a.revision - b.revision);
  return out.length > METRIC_HISTORY_LIMIT ? out.slice(out.length - METRIC_HISTORY_LIMIT) : out;
}
