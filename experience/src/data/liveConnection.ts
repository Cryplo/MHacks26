/**
 * Binds one run's live subscription to a LiveStore. Switching runs unsubscribes the old
 * subscription first and ignores anything it delivers afterwards. Gaps request a fresh
 * snapshot (getLiveSnapshot) while the store holds content frozen.
 */
import type { Id, RuntimeClient } from '../../contract/behavior-v1';
import { classifyError } from '../runtime/errors';
import { LiveStore } from './liveStore';

export class LiveConnection {
  readonly store: LiveStore;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private resyncInFlight = false;

  constructor(private readonly client: RuntimeClient) {
    this.store = new LiveStore((runId) => void this.resync(runId));
  }

  get runId() {
    return this.store.getState().runId;
  }

  connect(runId: Id) {
    if (this.unsubscribe && this.runId === runId) return;
    this.disconnect();
    const gen = ++this.generation;
    this.store.reset(runId);
    const live = () => gen === this.generation;
    try {
      this.unsubscribe = this.client.subscribeLive(runId, {
        snapshot: (s) => { if (live()) this.store.applySnapshot(s); },
        patch: (p) => { if (live()) this.store.applyPatch(p); },
        status: (s) => {
          if (!live()) return;
          if (s === 'reconnecting') this.store.setStatus('reconnecting');
          else if (s === 'live') this.store.setStatus(this.store.getState().stale ? 'resyncing' : 'live');
          else this.store.setStatus(s);
        },
        error: (e) => { if (live()) this.store.setError(e); },
      });
    } catch (e) {
      this.store.setError(classifyError(e).error);
    }
  }

  disconnect() {
    this.generation++;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resyncInFlight = false;
  }

  async resync(runId: Id) {
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    const gen = this.generation;
    try {
      const snapshot = await this.client.query('getLiveSnapshot', { runId });
      if (gen === this.generation) this.store.applySnapshot(snapshot);
    } catch (e) {
      if (gen === this.generation) this.store.setError(classifyError(e).error);
    } finally {
      if (gen === this.generation) this.resyncInFlight = false;
    }
  }
}
