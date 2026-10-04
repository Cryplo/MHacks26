/**
 * A read-only view that forwards to one LiveStore at a time (the live stream, or a store
 * filled from a recorded frame while scrubbing). Components keep one store reference, so the
 * map scene is not rebuilt when switching between live and the past.
 */
import type { LiveState, LiveStore } from './liveStore';

export class ViewStore {
  private source: LiveStore;
  private unsub: () => void;
  private readonly listeners = new Set<() => void>();

  constructor(initial: LiveStore) {
    this.source = initial;
    this.unsub = initial.subscribe(this.notify);
  }

  private notify = () => { this.listeners.forEach((l) => l()); };

  setSource(next: LiveStore) {
    if (next === this.source) return;
    this.unsub();
    this.source = next;
    this.unsub = next.subscribe(this.notify);
    this.notify();
  }

  getState = (): LiveState => this.source.getState();
  subscribe = (cb: () => void): (() => void) => { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; };
  /** Typed as a LiveStore for read-only consumers (getState/subscribe only). */
  asStore = (): LiveStore => this as unknown as LiveStore;
}
