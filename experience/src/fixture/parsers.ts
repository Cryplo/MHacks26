/**
 * FIXTURE stand-ins for Intelligence's parse_crowd / parse_scenario text jobs. Simple
 * keyword parsers, deterministic, labeled fixture. They only PROPOSE drafts; nothing here
 * mutates a run (the server applies events only via scheduleEvents after confirmation).
 */
import type { Archetype, CrowdSpec, ScenarioContext, ScenarioDraft, ScenarioEvent, ScenarioChange } from '../../contract/behavior-v1';
import { canonicalJson } from '../domain/canonical';
import { parseParkLocalTime } from '../ui/format';
import { ARCHETYPES } from './population';
import { sha256Sync } from './sha256';

const ARCH_WORDS: [RegExp, Archetype][] = [
  [/\b(famil(y|ies)|kids|children|parents)\b/i, 'young_family'],
  [/\bteen(s|agers?)?\b/i, 'teens'],
  [/\bcouples?\b/i, 'couple'],
  [/\b(thrill(-| )?seekers?|coaster fans?|adrenaline)\b/i, 'thrill_seekers'],
  [/\b(seniors?|retirees?|older (guests|visitors))\b/i, 'seniors'],
  [/\b(solo|single visitors?|alone)\b/i, 'solo'],
];
const CONTEXT_ONLY = /\b(hot|cold|rain(y)?|sunny|weather|heat|saturday|sunday|weekend|holiday|temperature)\b/i;

export function parseCrowdText(text: string, current: CrowdSpec, maxGuests: number):
  { proposal: CrowdSpec; assumptions: string[]; unsupported: string[] } {
  const shares = { ...current.shares };
  const assumptions: string[] = ['Fixture keyword parser: proposals are approximate and must be reviewed.'];
  const unsupported: string[] = [];
  let guestCount = current.guestCount;
  const count = /\b(\d{1,4})\s*(guests|people|visitors)\b/i.exec(text);
  if (count) {
    const n = Number(count[1]);
    if (n < 1 || n > maxGuests) unsupported.push(`"${count[0]}" - this server supports 1-${maxGuests} guests`);
    else { guestCount = n; assumptions.push(`Crowd size set to ${n} guests.`); }
  }
  for (const clause of text.split(/[,.;]|\band\b/i).map((c) => c.trim()).filter(Boolean)) {
    for (const [re, arch] of ARCH_WORDS) {
      if (!re.test(clause)) continue;
      if (/\b(no|without)\b/i.test(clause)) { shares[arch] = 0; assumptions.push(`No ${label(arch)}.`); }
      else if (/\b(fewer|less|few)\b/i.test(clause)) { shares[arch] = (shares[arch] ?? 0) * 0.5; assumptions.push(`Halved the ${label(arch)} share.`); }
      else if (/\b(more|lots|many|mostly|heavy)\b/i.test(clause)) { shares[arch] = (shares[arch] ?? 0) * 1.6 + 0.05; assumptions.push(`Increased the ${label(arch)} share.`); }
    }
    if (CONTEXT_ONLY.test(clause)) {
      unsupported.push(`"${clause}" - weather/day context has no mechanic in v1; kept only as a context note, not as an effect on behavior`);
    }
  }
  const total = ARCHETYPES.reduce((s, a) => s + (shares[a] ?? 0), 0);
  for (const a of ARCHETYPES) shares[a] = total > 0 ? Math.round(((shares[a] ?? 0) / total) * 1000) / 1000 : 0;
  return { proposal: { ...current, guestCount, shares, contextNotes: text.slice(0, 500) }, assumptions, unsupported };
}
const label = (a: Archetype) => a.replace('_', ' ');

const PLACE_WORDS: [RegExp, string][] = [
  [/\b(tempest|coaster|roller ?coaster)\b/i, 'coaster_tempest'],
  [/\b(splash|flume|water ride|log)\b/i, 'splash_falls'],
  [/\bcarousel\b/i, 'harbor_carousel'],
  [/\b(teacups?|tea cups?)\b/i, 'tidepool_teacups'],
  [/\b(theatre|theater|lantern|show)\b/i, 'lantern_theatre'],
  [/\bchurros?\b/i, 'churro_cart'],
  [/\b(snacks|harbor snacks|food counter)\b/i, 'harbor_snacks'],
  [/\b(gift|gifts|shop)\b/i, 'lighthouse_gifts'],
  [/\b(quay|garden)\b/i, 'quay_garden'],
];

export function parseScenarioText(text: string, ctx: ScenarioContext, openLocal: string, closeAfterMs: number): ScenarioDraft {
  const events: ScenarioEvent[] = [];
  const assumptions: string[] = ['Fixture keyword parser: review every field before confirming.'];
  const unsupported: string[] = [];
  const supported = new Set(ctx.capabilities.eventKinds);
  const placeIn = (s: string) => {
    for (const [re, id] of PLACE_WORDS) if (re.test(s) && ctx.places.some((p) => p.id === id)) return id;
    return null;
  };
  const timeIn = (s: string): { ms: number; note: string | null } | { error: string } => {
    const rel = /\bin (\d+) (minutes?|mins?|hours?)\b/i.exec(s);
    if (rel) {
      const ms = Number(rel[1]) * (rel[2]!.startsWith('h') ? 3600_000 : 60_000);
      const at = Math.ceil((ctx.currentSimMs + ms) / 5000) * 5000;
      return { ms: at, note: `"${rel[0]}" measured from the current simulated time.` };
    }
    if (/\bnoon\b/i.test(s)) {
      const r = parseParkLocalTime('12:00', openLocal, closeAfterMs);
      return r.ok ? { ms: r.simMs, note: null } : { error: r.message };
    }
    const abs = /\b(?:at|from|by)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(s);
    if (abs) {
      const r = parseParkLocalTime(abs[1]!, openLocal, closeAfterMs);
      return r.ok ? { ms: r.simMs, note: `"${abs[1]}" read as park-local time (opening ${openLocal}), not the device timezone.` } : { error: r.message };
    }
    const soon = Math.ceil((ctx.earliestSchedulableMs + 300_000) / 5000) * 5000;
    return { ms: soon, note: 'No time given: proposed 5 simulated minutes after the earliest schedulable boundary, to leave time for review.' };
  };
  const clauses = text.split(/;|\.\s|\band then\b|\balso\b/i).map((c) => c.trim()).filter(Boolean);
  let order = 0;
  for (const clause of clauses) {
    let change: ScenarioChange | null = null;
    const place = placeIn(clause);
    const price = /\$\s?(\d+(?:\.\d{1,2})?)/.exec(clause);
    const quoted = /["“](.+?)["”]/.exec(clause);
    const discount = /(\d{1,2})\s?%\s*off/i.exec(clause);
    if (/\b(re-?open)\b/i.test(clause) && place) change = { kind: 'closure', placeId: place, closed: false };
    else if (/\b(close|shut)\b/i.test(clause) && place) change = { kind: 'closure', placeId: place, closed: true };
    else if (/\bpass\b/i.test(clause) && price) {
      const cents = Math.round(Number(price[1]) * 100);
      change = { kind: 'pass_price', unitPriceCents: cents };
      assumptions.push(`Pass price ${price[0]} interpreted as ${cents} cents per guest.`);
    } else if (/\bboard\b/i.test(clause) && place) {
      const range = /(\d+)\s*(?:-|to)\s*(\d+)\s*min/i.exec(clause);
      if (range) change = { kind: 'board', placeId: place, display: { kind: 'fixed', lowerMin: Number(range[1]), upperMin: Number(range[2]), text: `${range[1]}-${range[2]} min` } };
      else if (quoted) change = { kind: 'board', placeId: place, display: { kind: 'fixed', lowerMin: null, upperMin: null, text: quoted[1]! } };
    } else if (/\b(notice|sign)\b/i.test(clause) && place && quoted) {
      change = { kind: 'notice', placeId: place, notice: { text: quoted[1]!, channel: place === 'churro_cart' ? 'aroma' : 'visual', radiusM: 15, cooldownMs: 1800000 } };
      assumptions.push('Notice channel/radius copied from the place type; check them.');
    } else if (/\b(app|message|push)\b/i.test(clause) && quoted) {
      change = { kind: 'app_message', messageId: `msg-${sha256Sync(clause).slice(0, 8)}`, text: quoted[1]!, expiresAtMs: 0, suggestedPlaceId: place, discount: null };
      if (discount) {
        if (ctx.capabilities.features.discountMessages && place) {
          unsupported.push(`"${discount[0]}" - discount products must be chosen in the structured editor`);
        } else {
          unsupported.push(`"${discount[0]}" - discount messages are not supported by this server; the message would be text only and would not change any price`);
        }
      }
    }
    if (!change) { unsupported.push(`"${clause}" - not understood`); continue; }
    if (!supported.has(change.kind)) { unsupported.push(`"${clause}" - ${change.kind} events are not supported by this server`); continue; }
    const when = timeIn(clause);
    if ('error' in when) { unsupported.push(`"${clause}" - ${when.error}`); continue; }
    if (when.note) assumptions.push(when.note);
    if (change.kind === 'app_message') change.expiresAtMs = Math.min(closeAfterMs, when.ms + 3600_000);
    events.push({ id: `draft-ev-${order}-${sha256Sync(canonicalJson(change)).slice(0, 8)}`, atMs: when.ms, order: order++, change });
  }
  return {
    draftId: `draft-${sha256Sync(canonicalJson({ text, rev: ctx.scenarioRevision })).slice(0, 12)}`,
    contextRevision: ctx.scenarioRevision, events, assumptions, unsupported, requiresConfirmation: true,
  };
}
