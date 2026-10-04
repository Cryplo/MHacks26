/**
 * FIXTURE RuntimeClient: implements the frozen contract interface on top of FixtureServer.
 * Loaded only by the fixture profile (the live build never includes this module).
 * Fault hooks (globalThis.__BEHAVIOR_FIXTURE_FAULTS__) let tests simulate lost
 * acknowledgements, duplicate/gapped patches and failed work.
 */
import type { CreateRuntimeClient, DomainError, Id, LivePatch, LiveSnapshot, RuntimeClient, RuntimeConfig } from '../../contract/behavior-v1';
import { CONTRACT_VERSION } from '../../contract/behavior-v1';
import { domainError, makeRuntimeClientError } from '../runtime/errors';
import { FixtureDomainError, FixtureServer, type FixtureFaults, type FixtureStorage } from './server';

export type PatchFaults = { duplicateEvery?: number; dropOnceAtCount?: number; reorderOnceAtCount?: number };
type GlobalFaults = FixtureFaults & { patches?: PatchFaults; latencyMs?: number };
declare global {
  var __BEHAVIOR_FIXTURE_FAULTS__: GlobalFaults | undefined;
  /** Test-only: when a test installs an array here, every client call is appended to it. */
  var __fixtureCallLog: string[] | undefined;
}
const logCall = (what: string) => { globalThis.__fixtureCallLog?.push(what); };

const STORAGE_KEY = 'behavior-engine.fixture-server.v1';
export function browserFixtureStorage(): FixtureStorage {
  return {
    read: () => { try { return window.localStorage.getItem(STORAGE_KEY); } catch { return memory.v; } },
    write: (v) => { try { window.localStorage.setItem(STORAGE_KEY, v); } catch { memory.v = v; } },
  };
}
const memory: { v: string | null } = { v: null };
export function memoryFixtureStorage(): FixtureStorage {
  let v: string | null = null;
  return { read: () => v, write: (x) => { v = x; } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FixtureRuntimeClient implements RuntimeClient {
  readonly contractVersion = CONTRACT_VERSION;
  private closed = false;
  private readonly subs = new Set<() => void>();

  constructor(private readonly server: FixtureServer, readonly identity: string, private readonly opts: { tickMs?: number; latencyMs?: number; patchFaults?: PatchFaults } = {}) {}

  private async latency() {
    const ms = this.opts.latencyMs ?? globalThis.__BEHAVIOR_FIXTURE_FAULTS__?.latencyMs ?? 40;
    if (ms > 0) await sleep(ms);
  }
  private guard() {
    if (this.closed) throw makeRuntimeClientError(domainError('DEPENDENCY_UNAVAILABLE', 'Fixture client is closed.', true), true);
  }

  async command<K extends keyof import('../../contract/behavior-v1').Commands>(name: K, input: import('../../contract/behavior-v1').Commands[K]['input'], commandId: Id) {
    this.guard();
    logCall(`command:${name}`);
    await this.latency();
    const { receipt, dropAck } = this.server.command(this.identity, name, input, commandId);
    if (dropAck) throw makeRuntimeClientError(domainError('DEPENDENCY_UNAVAILABLE', 'Fixture fault: acknowledgement lost after commit.', true), true);
    return receipt;
  }

  async query<K extends keyof import('../../contract/behavior-v1').Queries>(name: K, input: import('../../contract/behavior-v1').Queries[K]['input']) {
    this.guard();
    logCall(`query:${name}`);
    await this.latency();
    try {
      return this.server.query(this.identity, name, input);
    } catch (e) {
      if (e instanceof FixtureDomainError) throw makeRuntimeClientError(e.error, false);
      throw e;
    }
  }

  subscribeLive(runId: Id, handlers: {
    snapshot: (value: LiveSnapshot) => void; patch: (value: LivePatch) => void;
    status: (value: 'connecting' | 'live' | 'reconnecting' | 'closed') => void; error: (value: DomainError) => void;
  }): () => void {
    logCall('subscribeLive');
    let stopped = false;
    let last: LiveSnapshot | null = null;
    let patchCount = 0;
    let held: LivePatch | null = null;
    const faults = () => this.opts.patchFaults ?? globalThis.__BEHAVIOR_FIXTURE_FAULTS__?.patches ?? {};
    handlers.status('connecting');
    const emitPatch = (p: LivePatch) => {
      patchCount++;
      const f = faults();
      if (f.dropOnceAtCount === patchCount) return; // creates a revision gap
      if (f.reorderOnceAtCount === patchCount) { held = p; return; }
      handlers.patch(p);
      if (held) { const h = held; held = null; handlers.patch(h); }
      if (f.duplicateEvery && patchCount % f.duplicateEvery === 0) handlers.patch(p);
    };
    const tick = async () => {
      if (stopped) return;
      let snap: LiveSnapshot;
      try {
        snap = this.server.query(this.identity, 'getLiveSnapshot', { runId });
      } catch (e) {
        if (e instanceof FixtureDomainError) handlers.error(e.error);
        stopped = true;
        handlers.status('closed');
        return;
      }
      if (!last) {
        last = snap;
        handlers.snapshot(snap);
        handlers.status('live');
        return;
      }
      if (snap.run.revision <= last.run.revision) return;
      emitPatch(diff(last, snap));
      last = snap;
    };
    const timer = setInterval(() => void tick(), this.opts.tickMs ?? 250);
    void sleep(30).then(tick);
    const unsub = () => {
      stopped = true;
      clearInterval(timer);
      this.subs.delete(unsub);
    };
    this.subs.add(unsub);
    return unsub;
  }

  subscribeWorkAvailable(): () => void {
    return () => undefined; // the fixture has no worker queue to watch
  }

  async putArtifact(): Promise<never> {
    throw makeRuntimeClientError(domainError('UNSUPPORTED', 'The fixture does not accept artifact uploads.'), false);
  }

  async getArtifact(ref: import('../../contract/behavior-v1').ArtifactRef): Promise<Uint8Array> {
    this.guard();
    logCall(`artifact:${ref.kind}`);
    await this.latency();
    try {
      return this.server.getArtifactBytes(this.identity, ref);
    } catch (e) {
      if (e instanceof FixtureDomainError) throw makeRuntimeClientError(e.error, false);
      throw e;
    }
  }

  async close() {
    this.closed = true;
    [...this.subs].forEach((u) => u());
  }
}

export function diff(prev: LiveSnapshot, next: LiveSnapshot): LivePatch {
  const prevAgents = new Map(prev.agents.map((a) => [a.agentId, a]));
  const upsert = next.agents.filter((a) => JSON.stringify(prevAgents.get(a.agentId)) !== JSON.stringify(a));
  const nextIds = new Set(next.agents.map((a) => a.agentId));
  const removeIds = prev.agents.filter((a) => !nextIds.has(a.agentId)).map((a) => a.agentId);
  const prevPlaces = new Map(prev.places.map((p) => [p.placeId, JSON.stringify(p)]));
  const prevQueues = new Map(prev.queues.map((q) => [q.placeId, JSON.stringify(q)]));
  const lastSeq = prev.recentEvents.length ? prev.recentEvents[prev.recentEvents.length - 1]!.sequence : -1;
  return {
    runId: next.run.runId, fromRevision: prev.run.revision, toRevision: next.run.revision, run: next.run,
    agents: { upsert, removeIds },
    places: next.places.filter((p) => prevPlaces.get(p.placeId) !== JSON.stringify(p)),
    queues: next.queues.filter((q) => prevQueues.get(q.placeId) !== JSON.stringify(q)),
    metrics: next.metrics, health: next.health,
    appendedEvents: next.recentEvents.filter((e) => e.sequence > lastSeq),
  };
}

let sharedServer: FixtureServer | null = null;
export function browserFixtureServer(): FixtureServer {
  sharedServer ??= new FixtureServer(browserFixtureStorage(), () => Date.now(), globalThis.__BEHAVIOR_FIXTURE_FAULTS__ ?? {});
  return sharedServer;
}

export const createFixtureRuntimeClient: CreateRuntimeClient = async (config: RuntimeConfig) => {
  const server = browserFixtureServer();
  const { identity, token } = server.connect(config.token);
  if (token !== config.token) config.onToken?.(token);
  return new FixtureRuntimeClient(server, identity);
};
