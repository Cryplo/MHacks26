/** C-02: snapshot/patch gap, duplicate/out-of-order delivery, deletes, run switch, bounded memory. */
import { describe, expect, it, vi } from 'vitest';
import { EVENT_LIMIT, LiveStore, METRIC_HISTORY_LIMIT, mergeEvents, pushMetric } from '../../src/data/liveStore';
import { agent, event, metrics, patch, snapshot } from '../helpers';

describe('LiveStore', () => {
  it('applies a coherent snapshot then a contiguous patch', () => {
    const s = new LiveStore();
    s.reset('r1');
    s.applySnapshot(snapshot(5, [agent('a1', 1), agent('a2', 2)]));
    expect(s.applyPatch(patch(5, 6, [agent('a1', 3)]))).toBe('applied');
    expect(s.getState().revision).toBe(6);
    expect(s.getState().agents.get('a1')!.position.xM).toBe(3);
  });

  it('preserves object identity of unchanged agents', () => {
    const s = new LiveStore();
    s.reset('r1');
    s.applySnapshot(snapshot(1, [agent('a1', 1), agent('a2', 2)]));
    const a2 = s.getState().agents.get('a2');
    s.applyPatch(patch(1, 2, [agent('a1', 5), agent('a2', 2)]));
    expect(s.getState().agents.get('a2')).toBe(a2);
    const mapBefore = s.getState().agents;
    s.applyPatch(patch(2, 3, [agent('a2', 2)])); // no change at all
    expect(s.getState().agents).toBe(mapBefore);
    // A fresh snapshot with identical values also keeps identity.
    s.applySnapshot(snapshot(10, [agent('a1', 5), agent('a2', 2)]));
    expect(s.getState().agents.get('a2')).toBe(a2);
  });

  it('ignores duplicates and already-applied revisions', () => {
    const s = new LiveStore();
    s.reset('r1');
    s.applySnapshot(snapshot(5, [agent('a1', 1)]));
    expect(s.applyPatch(patch(5, 6, [agent('a1', 2)]))).toBe('applied');
    expect(s.applyPatch(patch(5, 6, [agent('a1', 99)]))).toBe('duplicate');
    expect(s.applyPatch(patch(4, 5, [agent('a1', 98)]))).toBe('duplicate');
    expect(s.getState().agents.get('a1')!.position.xM).toBe(2);
    expect(s.getState().counters.duplicates).toBe(2);
  });

  it('detects a gap, freezes as stale, requests a snapshot and replays buffered patches', () => {
    const onGap = vi.fn();
    const s = new LiveStore(onGap);
    s.reset('r1');
    s.applySnapshot(snapshot(5, [agent('a1', 1)]));
    expect(s.applyPatch(patch(6, 7, [agent('a1', 7)]))).toBe('gap');
    expect(onGap).toHaveBeenCalledWith('r1');
    expect(s.getState().stale).toBe(true);
    expect(s.getState().status).toBe('resyncing');
    expect(s.getState().agents.get('a1')!.position.xM).toBe(1); // frozen, not partially applied
    expect(s.applyPatch(patch(7, 8, [agent('a1', 8)]))).toBe('buffered');
    s.applySnapshot(snapshot(7, [agent('a1', 7)]));
    expect(s.getState().stale).toBe(false);
    expect(s.getState().revision).toBe(8);
    expect(s.getState().agents.get('a1')!.position.xM).toBe(8);
  });

  it('handles out-of-order delivery via the gap path without double-applying', () => {
    const s = new LiveStore(() => undefined);
    s.reset('r1');
    s.applySnapshot(snapshot(1, [agent('a1', 1)]));
    expect(s.applyPatch(patch(2, 3, [agent('a1', 3)]))).toBe('gap');
    expect(s.applyPatch(patch(1, 2, [agent('a1', 2)]))).toBe('buffered');
    s.applySnapshot(snapshot(1, [agent('a1', 1)]));
    expect(s.getState().revision).toBe(3);
    expect(s.getState().agents.get('a1')!.position.xM).toBe(3);
  });

  it('applies deletes', () => {
    const s = new LiveStore();
    s.reset('r1');
    s.applySnapshot(snapshot(1, [agent('a1', 1), agent('a2', 2)]));
    s.applyPatch(patch(1, 2, [], { agents: { upsert: [], removeIds: ['a2', 'unknown'] } }));
    expect([...s.getState().agents.keys()]).toEqual(['a1']);
  });

  it('rejects patches and snapshots for another run and clears state on run switch', () => {
    const s = new LiveStore();
    s.reset('r1');
    s.applySnapshot(snapshot(1, [agent('a1', 1)]));
    expect(s.applyPatch({ ...patch(1, 2), runId: 'other' })).toBe('wrong_run');
    s.reset('r2');
    expect(s.getState().agents.size).toBe(0);
    expect(s.getState().revision).toBe(-1);
    expect(s.applySnapshot(snapshot(3, [agent('a1', 1)]))).toBe(false); // snapshot is for r1
  });

  it('never concatenates events twice and keeps the feed bounded', () => {
    const merged = mergeEvents([event(1), event(2)], [event(2), event(3)]);
    expect(merged.map((e) => e.sequence)).toEqual([1, 2, 3]);
    const many = Array.from({ length: EVENT_LIMIT + 50 }, (_, i) => event(i + 1));
    const bounded = mergeEvents([], many);
    expect(bounded.length).toBe(EVENT_LIMIT);
    expect(bounded[0]!.sequence).toBe(51);
  });

  it('keeps the latest revision per metric time and bounds history', () => {
    let h = pushMetric([], metrics('r1', 60_000, 3));
    h = pushMetric(h, metrics('r1', 60_000, 2));
    expect(h.length).toBe(1);
    expect(h[0]!.revision).toBe(3);
    h = pushMetric(h, metrics('r1', 60_000, 4));
    expect(h[0]!.revision).toBe(4);
    for (let i = 0; i < METRIC_HISTORY_LIMIT + 10; i++) h = pushMetric(h, metrics('r1', 120_000 + i * 60_000, 5 + i));
    expect(h.length).toBe(METRIC_HISTORY_LIMIT);
  });

  it('notifies and removes listeners', () => {
    const s = new LiveStore();
    const l = vi.fn();
    const off = s.subscribe(l);
    s.reset('r1');
    expect(l).toHaveBeenCalled();
    off();
    expect(s.listenerCount()).toBe(0);
  });
});
