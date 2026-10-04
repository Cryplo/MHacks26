import type { ParkBundle, ScenarioChange, ScenarioEvent, WaitDisplay } from '../../../contract/behavior-v1';
import { formatCents, formatSimClock } from '../../ui/format';

export type ChangeSummary = { operation: string; place: string | null; value: string; notes: string[] };

const displayText = (d: WaitDisplay) => d.kind === 'fixed' ? `fixed text "${d.text}"${d.lowerMin !== null || d.upperMin !== null ? ` (${d.lowerMin ?? '?'}-${d.upperMin ?? '?'} min)` : ''}`
  : d.kind === 'rounded_estimate' ? `runtime estimate rounded to ${d.roundToMin} min` : `runtime range estimate, ${d.spreadMin}-min spread`;

export function describeChange(c: ScenarioChange, park: ParkBundle, discountsSupported: boolean): ChangeSummary {
  const name = (id: string | null) => (id ? park.places.find((p) => p.id === id)?.name ?? `${id} (unknown place)` : null);
  switch (c.kind) {
    case 'pass_price': return { operation: 'Change Harbor Pass price', place: null, value: `${formatCents(c.unitPriceCents)} per guest (${c.unitPriceCents} cents; was ${formatCents(park.pass.unitPriceCents)} at park baseline)`, notes: [] };
    case 'pass_share': return { operation: 'Change pass-lane share', place: name(c.placeId), value: `${(c.shareBps / 100).toFixed(1)}% target (not a guaranteed per-vehicle fraction)`, notes: [] };
    case 'board': return { operation: 'Rewrite wait board', place: name(c.placeId), value: displayText(c.display), notes: ['Guests who already observed the old board keep their original wait promise.'] };
    case 'notice': return { operation: 'Rewrite notice', place: name(c.placeId), value: `"${c.notice.text}" (${c.notice.channel}, ${c.notice.radiusM} m)`, notes: ['Only guests who newly observe the changed version see it.'] };
    case 'closure': return { operation: c.closed ? 'Close' : 'Reopen', place: name(c.placeId), value: c.closed ? 'stop new boarding; queued parties released (not abandonment); active rides complete' : 'resume admissions', notes: c.closed ? ['Guests learn of the closure only when they observe it.'] : [] };
    case 'show_schedule': return { operation: 'Change show schedule', place: name(c.placeId), value: c.startsAtMs.map((t) => formatSimClock(t, park.openLocal)).join(', '), notes: [] };
    case 'app_message': {
      const notes = ['Reaches only guests with the app, delivery and attention.'];
      if (c.discount && !discountsSupported) notes.push('Discount not supported by this server.');
      if (!c.discount && /%|off|discount|free|\$/i.test(c.text)) notes.push('Text mentions a price or discount, but this message changes NO price: it is a text-only statement.');
      return { operation: 'Send app message', place: name(c.suggestedPlaceId), value: `"${c.text}" until ${formatSimClock(c.expiresAtMs, park.openLocal)}${c.discount ? `; discount ${(c.discount.discountBps / 100).toFixed(0)}% on ${c.discount.productIds.join(', ')} (max ${c.discount.maxUsesPerGroup}/group)` : '; no discount'}`, notes };
    }
  }
}

export const eventTime = (e: ScenarioEvent, park: ParkBundle) => `${formatSimClock(e.atMs, park.openLocal)} park time`;
