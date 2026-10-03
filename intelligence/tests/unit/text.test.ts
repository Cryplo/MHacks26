import { describe, expect, it } from 'vitest';
import type { CrowdSpec, ScenarioChange } from '../../contract/behavior-v1.ts';
import { validateShares } from '../../src/population/allocation.ts';
import { DEFAULT_CROWD_300 } from '../../src/fixtures/crowds.ts';
import { parseCrowdText } from '../../src/text/crowd.ts';
import { ScenarioContextError, parseMoneyCents, parseScenarioText, resolvePlace, splitScenarioClauses } from '../../src/text/scenario.ts';
import { capabilities, scenarioSetup } from '../helpers/scenario.ts';

const parse = (text: string, opts: Parameters<typeof scenarioSetup>[0] = {}) => {
  const s = scenarioSetup(opts);
  return parseScenarioText(text, s.context, s.bundle);
};
const kinds = (d: { events: { change: ScenarioChange }[] }) => d.events.map((e) => e.change.kind);

describe('B-14 scenario parsing: money and time', () => {
  it('$25 per guest -> 2,500 cents; exact decimal cents; no float money', () => {
    const d = parse('raise passes to $25 per guest at 11am');
    expect(d.events).toHaveLength(1);
    expect(d.events[0]!.change).toEqual({ kind: 'pass_price', unitPriceCents: 2500 });
    expect(d.events[0]!.atMs).toBe(2 * 3_600_000);
    expect(parseMoneyCents('$25.50')).toEqual({ cents: 2550 });
    expect(parseMoneyCents('$0.29')).toEqual({ cents: 29 });
    expect(parseMoneyCents('$1,250')).toEqual({ cents: 125_000 });
    expect(parseMoneyCents('19 dollars')).toEqual({ cents: 1900 });
    expect(parseMoneyCents('$19.999')).toMatchObject({ error: expect.stringMatching(/two decimal/) });
    const bad = parse('set the pass price to $19.999');
    expect(bad.events).toEqual([]);
    expect(bad.unsupported.join()).toMatch(/two decimal/);
  });

  it('relative and per-group price requests are not guessed', () => {
    expect(parse('raise passes by $5').unsupported.join()).toMatch(/relative price/);
    expect(parse('raise passes by 10%').unsupported.join()).toMatch(/relative price/);
    expect(parse('set passes to $40 per family').unsupported.join()).toMatch(/per guest/);
  });

  it('local park time is relative to park opening, not the machine timezone', () => {
    const d = parse('close Harbor Comet at 2pm');
    expect(d.events[0]).toMatchObject({ atMs: 5 * 3_600_000, change: { kind: 'closure', placeId: 'comet', closed: true } });
    const late = parse('close Harbor Comet at 2pm', { park: (b) => ({ ...b, openLocal: '10:30' }) });
    expect(late.events[0]!.atMs).toBe(3.5 * 3_600_000);
    expect(late.assumptions.join()).toMatch(/relative to opening 10:30/);
  });

  it('bare hours resolve only when exactly one reading is within park hours', () => {
    const d = parse('close the carousel at 2');
    expect(d.events[0]!.atMs).toBe(5 * 3_600_000);
    expect(d.assumptions.join()).toMatch(/interpreted "at 2" as 14:00/);
    const longDay = parse('close the carousel at 10', { park: (b) => ({ ...b, closeAfterMs: 14 * 3_600_000 }) });
    expect(longDay.events).toEqual([]);
    expect(longDay.unsupported.join()).toMatch(/ambiguous \(10:00 or 22:00\)/);
    expect(parse('close the carousel at 8pm').unsupported.join()).toMatch(/outside park hours/);
  });

  it('closure with duration emits a reopen event; missing duration is an explicit assumption', () => {
    const d = parse('close the comet at 2:30 pm for an hour');
    expect(d.events.map((e) => [e.atMs, (e.change as { closed: boolean }).closed])).toEqual([[5.5 * 3_600_000, true], [6.5 * 3_600_000, false]]);
    const u = parse('shut down Splash Falls at noon until 1pm');
    expect(u.events.map((e) => e.atMs)).toEqual([3 * 3_600_000, 4 * 3_600_000]);
    const open = parse('close Lantern Carousel at 1pm');
    expect(open.assumptions.join()).toMatch(/stays closed until another event reopens it/);
  });

  it('missing time defaults to the earliest schedulable boundary and is shown for confirmation', () => {
    const d = parse('close the teacups');
    expect(d.events[0]!.atMs).toBe(3_605_000);
    expect(d.assumptions.join()).toMatch(/no time given.*earliest schedulable boundary 10:00/);
  });
});

describe('B-14 unique place resolution', () => {
  const places = scenarioSetup().context.places;
  it('resolves exact names, ids, distinctive words and unique kinds', () => {
    expect(resolvePlace('Harbor Comet', places)).toMatchObject({ place: { id: 'comet' } });
    expect(resolvePlace('the carousel', places)).toMatchObject({ place: { id: 'carousel' } });
    expect(resolvePlace('teacups', places)).toMatchObject({ place: { id: 'teacups' } });
    expect(resolvePlace('the show', places)).toMatchObject({ place: { id: 'cove-show' } });
    expect(resolvePlace('the bathrooms', places)).toMatchObject({ place: { id: 'restroom' } });
  });
  it('rejects ambiguous and unknown references instead of guessing', () => {
    expect(resolvePlace('the coaster', places)).toMatchObject({ error: expect.stringMatching(/does not name a known place/) });
    expect(resolvePlace('the ride', places)).toMatchObject({ error: expect.stringMatching(/could be any of/) });
    expect(resolvePlace('Harbor', places)).toMatchObject({ error: expect.stringMatching(/does not name|several|could be/) });
    const d = parse('close the coaster at 2pm');
    expect(d.events).toEqual([]);
    expect(d.unsupported.join()).toMatch(/coaster/);
  });
});

describe('B-14 stale context, partial requests, confirmation and capability gates', () => {
  it('times before the earliest schedulable boundary are rejected as stale', () => {
    const d = parse('close the comet at 9:30am');
    expect(d.events).toEqual([]);
    expect(d.unsupported.join()).toMatch(/before the earliest schedulable boundary 10:00.*stale/);
  });

  it('a park artifact that does not match the context revision is refused', () => {
    const s = scenarioSetup();
    expect(() => parseScenarioText('close the comet', s.context, { ...s.bundle, revision: 'fixture-0' })).toThrow(ScenarioContextError);
    expect(() => parseScenarioText('close the comet', { ...s.context, earliestSchedulableMs: 3_602_500 }, s.bundle)).toThrow(/earliest schedulable/);
    expect(() => parseScenarioText('close the comet', { ...s.context, park: { ...s.context.park, status: 'preparing' } }, s.bundle)).toThrow(/preparing/);
  });

  it('mixed request keeps supported events AND unsupported parts; always requires confirmation', () => {
    const d = parse('raise passes to $25 at 11am and move the taco stand next to the pier');
    expect(kinds(d)).toEqual(['pass_price']);
    expect(d.unsupported.join()).toMatch(/geometry or stall/);
    expect(d.assumptions.join()).toMatch(/Partial draft: 1 portion/);
    expect(d.requiresConfirmation).toBe(true);
    expect(d.contextRevision).toBe('scn-7');
  });

  it('multiple events keep declared order even when times are out of order', () => {
    const d = parse('close the carousel at 11am, then raise passes to $20 at 10:30am; set the Splash Falls board to "Splash Falls - 10 minutes" at 11am');
    expect(kinds(d)).toEqual(['closure', 'pass_price', 'board']);
    expect(d.events.map((e) => e.order)).toEqual([0, 1, 2]);
    expect(d.events[2]!.change).toMatchObject({ placeId: 'splash', display: { kind: 'fixed', lowerMin: 10, upperMin: 10, text: 'Splash Falls - 10 minutes' } });
    expect(splitScenarioClauses('send "close and open" and close the comet')).toEqual(['send "close and open"', 'close the comet']);
  });

  it('is deterministic: same text and context give the same draft id and events', () => {
    const a = parse('close the comet at 2pm');
    const b = parse('close the comet at 2pm');
    expect(a).toEqual(b);
    expect(parse('close the comet at 2pm', { context: { scenarioRevision: 'scn-8' } }).draftId).not.toBe(a.draftId);
  });

  it('notice rewrite keeps the place notice parameters and shows them as assumptions', () => {
    const d = parse('change the notice at Dockside Tacos to "Two-for-one lemonade" at 11am');
    expect(d.events[0]!.change).toEqual({ kind: 'notice', placeId: 'tacos', notice: { text: 'Two-for-one lemonade', channel: 'aroma', radiusM: 12, cooldownMs: 600_000 } });
    expect(d.assumptions.join()).toMatch(/keeps Dockside Tacos's notice channel aroma/);
    const n = parse('put a notice at Lantern Pier saying "Sunset at the pier"');
    expect(n.assumptions.join()).toMatch(/no notice yet; using defaults/);
  });

  it('a 20% discount push is rejected unless Engine supports discount messages', () => {
    const off = parse('send an app message "Passes 20% off for the next half hour" with 20% off passes at 11am');
    expect(off.events).toEqual([]);
    expect(off.unsupported.join()).toMatch(/discount messages are not enabled.*would not change any quote/);
    const on = parse('send an app message "Passes 20% off for the next half hour" with 20% off passes at 11am', { caps: capabilities({}, { discountMessages: true }) });
    expect(on.events).toHaveLength(1);
    expect(on.events[0]!.change).toMatchObject({
      kind: 'app_message', text: 'Passes 20% off for the next half hour', expiresAtMs: 2 * 3_600_000 + 30 * 60_000,
      discount: { productIds: ['pass'], discountBps: 2000, maxUsesPerGroup: 1 },
    });
    expect(on.assumptions.join()).toMatch(/1 use per group.*confirm/);
    expect(on.assumptions.join()).toMatch(/expires after 30 minutes/);
    const vague = parse('push a 20% discount message', { caps: capabilities({}, { discountMessages: true }) });
    expect(vague.events).toEqual([]);
    expect(vague.unsupported.join()).toMatch(/which product/);
  });

  it('event kinds missing from capabilities stay unsupported', () => {
    const d = parse('close the comet at 2pm and raise passes to $25', { caps: capabilities({ eventKinds: ['pass_price'] }) });
    expect(kinds(d)).toEqual(['pass_price']);
    expect(d.unsupported.join()).toMatch(/closure is not supported by the current Engine capabilities/);
  });

  it('unrecognized text is reported, never fabricated', () => {
    const d = parse('make everyone happier');
    expect(d.events).toEqual([]);
    expect(d.unsupported).toEqual(['"make everyone happier": not understood as a supported scenario change']);
  });
});

describe('crowd description parsing', () => {
  const current: CrowdSpec = DEFAULT_CROWD_300;
  it('"more international tourists, fewer teens" changes teens only and labels the unsupported dimension', () => {
    const r = parseCrowdText('more international tourists, fewer teens', current);
    expect(r.proposal.shares.teens).toBeLessThan(current.shares.teens);
    const ratio = (s: CrowdSpec['shares']) => s.couple / s.seniors;
    expect(ratio(r.proposal.shares)).toBeCloseTo(ratio(current.shares), 3);
    expect(validateShares(r.proposal.shares).ok).toBe(true);
    expect(Object.values(r.proposal.shares).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(r.unsupported.join()).toMatch(/visitor origin is not a supported crowd dimension/);
    expect(r.proposal.contextNotes).toMatch(/\[descriptive only, no mechanical effect\] more international tourists/);
    expect(r.proposal.seed).toBe(current.seed);
    expect(r.proposal.guestCount).toBe(300);
  });

  it('targets, exclusions and guest counts', () => {
    const r = parseCrowdText('mostly families; no teens; 250 guests', current);
    expect(r.proposal.shares.young_family).toBeCloseTo(0.6, 4);
    expect(r.proposal.shares.teens).toBe(0);
    expect(r.proposal.guestCount).toBe(250);
    expect(r.assumptions.join()).toMatch(/guest shares \(not group shares\)/);
    const s = parseCrowdText('20% seniors', current);
    expect(s.proposal.shares.seniors).toBeCloseTo(0.2, 4);
  });

  it('ambiguous, contradictory, impossible and unsupported requests do not fabricate a configuration', () => {
    const none = parseCrowdText('bring some aliens', current);
    expect(none.proposal).toEqual(current);
    expect(none.unsupported.join()).toMatch(/not understood/);
    const conflict = parseCrowdText('more teens, fewer teens', current);
    expect(conflict.proposal.shares.teens).toBeCloseTo(current.shares.teens, 4);
    expect(conflict.unsupported.join()).toMatch(/already adjusted/);
    const over = parseCrowdText('70% teens, 50% seniors', current);
    expect(over.proposal.shares).toEqual(current.shares);
    expect(over.unsupported.join()).toMatch(/more than 100%/);
    expect(parseCrowdText('teens', current).unsupported.join()).toMatch(/no direction/);
    expect(parseCrowdText('5000 guests', current).unsupported.join()).toMatch(/outside 1\.\.1000/);
    expect(parseCrowdText('', current).proposal).toEqual(current);
  });

  it('is deterministic', () => {
    expect(parseCrowdText('more couples and fewer seniors', current)).toEqual(parseCrowdText('more couples and fewer seniors', current));
  });
});
