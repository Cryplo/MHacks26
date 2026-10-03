/**
 * Canonical metric definitions (charter section 5) for display. The UI formats and explains
 * Engine's values; it never recomputes a competing KPI.
 */
import type { MetricId } from '../../contract/behavior-v1';

export type Direction = 'guest_better_when_higher' | 'guest_better_when_lower' | 'business_measure' | 'operational';

export type MetricInfo = {
  id: MetricId; label: string; short: string; definition: string; denominator: string; direction: Direction;
};

export const METRICS: Record<MetricId, MetricInfo> = {
  net_revenue_cents: {
    id: 'net_revenue_cents', label: 'Net ancillary revenue', short: 'Net revenue',
    definition: 'Pass + food + shop sales less refunds. Excludes admission. Not profit: no costs are modeled.',
    denominator: 'Total for the run (no denominator).', direction: 'business_measure',
  },
  revenue_per_guest_cents: {
    id: 'revenue_per_guest_cents', label: 'Revenue per admitted guest', short: 'Revenue / guest',
    definition: 'Net ancillary revenue divided by admitted guests (not by guests currently in the park).',
    denominator: 'Admitted guests.', direction: 'business_measure',
  },
  satisfaction_0_100: {
    id: 'satisfaction_0_100', label: 'Satisfaction (synthetic rating)', short: 'Satisfaction',
    definition: 'Mean of one terminal departure-or-horizon rating per admitted individual, mapped 100 x index / (K-1). Available cases only; missing ratings are never imputed. A synthetic judgment, not a human survey.',
    denominator: 'Individuals with a terminal rating (coverage shown separately).', direction: 'guest_better_when_higher',
  },
  queue_minutes_per_guest: {
    id: 'queue_minutes_per_guest', label: 'Queue minutes per guest', short: 'Queue min / guest',
    definition: 'All queued person-minutes, including episodes later abandoned, divided by admitted guests.',
    denominator: 'Admitted guests.', direction: 'guest_better_when_lower',
  },
  completed_ride_wait_minutes: {
    id: 'completed_ride_wait_minutes', label: 'Wait per completed ride admission', short: 'Completed-ride wait',
    definition: 'Mean queue wait of rider admissions that reached the ride. Separate from all-queue minutes.',
    denominator: 'Completed rider admissions.', direction: 'guest_better_when_lower',
  },
  rides_per_guest: {
    id: 'rides_per_guest', label: 'Rides per guest', short: 'Rides / guest',
    definition: 'Completed rider admissions divided by admitted guests.',
    denominator: 'Admitted guests.', direction: 'guest_better_when_higher',
  },
  abandonment_rate: {
    id: 'abandonment_rate', label: 'Queue abandonment rate', short: 'Abandonment',
    definition: 'Voluntarily abandoned person-queue episodes / joined person-queue episodes. Closure releases are excluded.',
    denominator: 'Joined person-queue episodes.', direction: 'guest_better_when_lower',
  },
  queue_time_share: {
    id: 'queue_time_share', label: 'Share of park time spent queueing', short: 'Queue-time share',
    definition: 'Queued person-time divided by total in-park person-time.',
    denominator: 'In-park person-time.', direction: 'guest_better_when_lower',
  },
  early_departures: {
    id: 'early_departures', label: 'Early departures', short: 'Early departures',
    definition: 'Guests whose actual exit preceded their pre-sampled planned exit by more than the declared threshold (default 30 min).',
    denominator: 'Count of guests (no denominator).', direction: 'guest_better_when_lower',
  },
  ride_seat_utilization: {
    id: 'ride_seat_utilization', label: 'Ride seat utilization', short: 'Seat use',
    definition: 'Used seats / dispatched seats across rides.',
    denominator: 'Dispatched seats.', direction: 'operational',
  },
  server_utilization: {
    id: 'server_utilization', label: 'Counter server utilization', short: 'Server use',
    definition: 'Busy server time / available server time at food and shop counters.',
    denominator: 'Available server time.', direction: 'operational',
  },
};

export const METRIC_ORDER: MetricId[] = [
  'net_revenue_cents', 'revenue_per_guest_cents', 'satisfaction_0_100', 'queue_minutes_per_guest',
  'completed_ride_wait_minutes', 'rides_per_guest', 'abandonment_rate', 'queue_time_share',
  'early_departures', 'ride_seat_utilization', 'server_utilization',
];

/**
 * Plain-language reading of a B-minus-A delta. Deliberately neutral: more money alone is not
 * a better guest experience, and more waiting is never shown as an improvement.
 */
export function describeDelta(id: MetricId, delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return 'not available';
  if (delta === 0) return 'no change';
  const up = delta > 0;
  switch (METRICS[id].direction) {
    case 'guest_better_when_higher': return up ? 'higher (better for guests in the model)' : 'lower (worse for guests in the model)';
    case 'guest_better_when_lower': return up ? 'higher (worse for guests in the model)' : 'lower (better for guests in the model)';
    case 'business_measure': return up ? 'higher (a business measure, not proof of a better visit)' : 'lower (a business measure)';
    case 'operational': return up ? 'higher' : 'lower';
  }
}
