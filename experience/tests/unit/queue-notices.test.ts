/** C-08: queue labels from authoritative membership; notice observers by committed events. */
import { describe, expect, it } from 'vitest';
import { noticeObservations, queueLabel } from '../../src/features/live/queueAndNotices';
import { event } from '../helpers';

describe('queue and notice summaries', () => {
  it('queue label uses QueueView counts only', () => {
    expect(queueLabel(undefined)).toBeNull();
    expect(queueLabel({ placeId: 'p', standardPersons: 0, passPersons: 0, entries: [] })).toBeNull();
    expect(queueLabel({ placeId: 'p', standardPersons: 12, passPersons: 0, entries: [] })).toBe('queue 12');
    expect(queueLabel({ placeId: 'p', standardPersons: 12, passPersons: 3, entries: [] })).toBe('queue 12 + pass 3');
  });
  it('groups observers by notice version without double counting', () => {
    const rows = noticeObservations([
      event(1, { kind: 'observed', placeId: 'churro', agentIds: ['a1', 'a2'], details: { contentVersion: 'v1' } }),
      event(2, { kind: 'observed', placeId: 'churro', agentIds: ['a2', 'a3'], details: { contentVersion: 'v1' } }),
      event(3, { kind: 'observed', placeId: 'churro', agentIds: ['a4'], details: { contentVersion: 'v2' } }),
      event(4, { kind: 'observed', placeId: 'gifts', agentIds: ['a5'], details: ['not-an-object'] }),
      event(5, { kind: 'purchase', placeId: 'churro', agentIds: ['a9'] }),
    ]);
    expect(rows.map((r) => [r.placeId, r.version, r.observers.length])).toEqual([['churro', 'v1', 3], ['churro', 'v2', 1], ['gifts', 'version not reported', 1]]);
  });
});
