import type {
  Id, Notice, ParkBundle, Place, ScenarioChange, ScenarioContext, ScenarioDraft, ScenarioEvent, SimMs, WaitDisplay,
} from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../core/canonical.ts';
import { SIM_STEP_MS, isSimMs } from '../core/validate.ts';

export const SCENARIO_PARSER_VERSION = 'scenario-parser-v1';
export const DEFAULT_MESSAGE_EXPIRY_MS = 30 * 60_000;
export const DEFAULT_NOTICE: Omit<Notice, 'text'> = { channel: 'visual', radiusM: 12, cooldownMs: 600_000 };

export class ScenarioContextError extends Error {
  override name = 'ScenarioContextError';
}

type PlaceRef = Pick<Place, 'id' | 'name' | 'kind'>;
type Ctx = { context: ScenarioContext; park: ParkBundle; openMin: number; assumptions: string[]; unsupported: string[] };
type Pending = { atMs: SimMs; change: ScenarioChange };

const VERB_START = /^(?:close|shut|reopen|open|raise|increase|lower|reduce|drop|set|change|make|cut|send|push|post|broadcast|schedule|update|rewrite|replace|move|relocate|build|add|remove|demolish|put|show|offer)\b/i;

/** Splits into declared-order clauses; "and" or "," splits only when the next word starts a new command. */
export function splitScenarioClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/[;\n]|\.(?=\s+[A-Za-z]|$)|,?\s+then\s+/i)) {
    let rest = sentence.trim();
    outer: for (;;) {
      for (let re = /\s*,\s*(?:and\s+)?|\s+and\s+/gi, m = re.exec(rest); m; m = re.exec(rest)) {
        const tail = rest.slice(m.index + m[0].length);
        if (VERB_START.test(tail) && !insideQuotes(rest, m.index)) {
          out.push(rest.slice(0, m.index).trim());
          rest = tail.trim();
          continue outer;
        }
      }
      break;
    }
    if (rest) out.push(rest);
  }
  return out.filter(Boolean);
}

function insideQuotes(s: string, idx: number): boolean {
  const before = s.slice(0, idx);
  return ((before.match(/"/g)?.length ?? 0) + (before.match(/[“”]/g)?.length ?? 0)) % 2 === 1;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function formatLocal(openMin: number, simMs: SimMs): string {
  const total = openMin + Math.floor(simMs / 60_000);
  return `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`;
}

function parseOpen(openLocal: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(openLocal);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new ScenarioContextError(`park openLocal "${openLocal}" is not HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Parses dollar amounts exactly into integer cents (no floating-point money). */
export function parseMoneyCents(s: string): { cents: number } | { error: string } | null {
  const m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?|\b(\d+)(?:\.(\d+))?\s*(dollars?|usd|bucks)\b|\b(\d+)\s*cents?\b/i.exec(s);
  if (!m) return null;
  if (m[6] !== undefined) return { cents: Number(m[6]) };
  const whole = (m[1] ?? m[3])!.replace(/,/g, '');
  const frac = m[2] ?? m[4] ?? '';
  if (frac.length > 2) return { error: `amount "${m[0]}" has more than two decimal places` };
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(cents)) return { error: `amount "${m[0]}" is too large` };
  return { cents };
}

type TimeParse = { atMs: SimMs; phrase: string; note?: string } | { error: string; phrase: string } | null;

function parseTime(clause: string, c: Ctx, kind: 'at' | 'until' = 'at'): TimeParse {
  const lead = kind === 'at' ? '(?:at|from|starting(?: at)?|beginning(?: at)?|by)' : '(?:until|till|to)';
  const re = new RegExp(`\\b${lead}\\s+(noon|midday|midnight|(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?(?![\\d%$]))`, 'i');
  const m = re.exec(clause);
  if (m) {
    const phrase = m[0];
    let hour: number; const minute = m[3] ? Number(m[3]) : 0;
    const word = m[1]!.toLowerCase();
    if (word === 'noon' || word === 'midday') hour = 12;
    else if (word === 'midnight') hour = 0;
    else hour = Number(m[2]);
    const mer = m[4]?.toLowerCase().replace(/\./g, '');
    if (minute > 59 || hour > 23 || (mer && (hour < 1 || hour > 12))) return { error: `"${phrase}" is not a valid clock time`, phrase };
    let candidates: number[];
    if (mer === 'am') candidates = [(hour % 12) * 60 + minute];
    else if (mer === 'pm') candidates = [((hour % 12) + 12) * 60 + minute];
    else if (/^\d/.test(word) && hour <= 12 && !m[3] && hour !== 0) candidates = [hour * 60 + minute, ((hour % 12) + 12) * 60 + minute];
    else candidates = [hour * 60 + minute];
    candidates = [...new Set(candidates)];
    const closeMin = c.openMin + c.park.closeAfterMs / 60_000;
    const inHours = candidates.filter((t) => t >= c.openMin && t <= closeMin);
    if (inHours.length === 0) return { error: `"${phrase}" is outside park hours ${formatLocal(c.openMin, 0)}-${formatLocal(c.openMin, c.park.closeAfterMs)}`, phrase };
    if (inHours.length > 1) return { error: `"${phrase}" is ambiguous (${inHours.map((t) => `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`).join(' or ')}); add am/pm`, phrase };
    const t = inHours[0]!;
    const note = candidates.length > 1 ? `interpreted "${phrase.trim()}" as ${pad2(Math.floor(t / 60))}:${pad2(t % 60)} park local time` : undefined;
    return { atMs: (t - c.openMin) * 60_000, phrase, note };
  }
  if (kind === 'at') {
    const rel = /\bin\s+(\d{1,3})\s*(minutes?|mins?|hours?|hrs?)\b/i.exec(clause);
    if (rel) {
      const ms = Number(rel[1]) * (/^h/i.test(rel[2]!) ? 3_600_000 : 60_000);
      return { atMs: c.context.currentSimMs + ms, phrase: rel[0], note: `"${rel[0]}" measured from the current simulation time ${formatLocal(c.openMin, c.context.currentSimMs)}` };
    }
    const now = /\b(now|immediately|right away|asap)\b/i.exec(clause);
    if (now) return { atMs: c.context.earliestSchedulableMs, phrase: now[0], note: `"${now[0]}" means the earliest schedulable boundary ${formatLocal(c.openMin, c.context.earliestSchedulableMs)}` };
  }
  return null;
}

function parseDuration(clause: string): { ms: number; phrase: string } | null {
  const m = /\bfor\s+(?:(an?|one|two|three|\d{1,3})\s*(minutes?|mins?|hours?|hrs?)|(half an hour))\b/i.exec(clause);
  if (!m) return null;
  if (m[3]) return { ms: 30 * 60_000, phrase: m[0] };
  const nWord = m[1]!.toLowerCase();
  const n = nWord === 'a' || nWord === 'an' || nWord === 'one' ? 1 : nWord === 'two' ? 2 : nWord === 'three' ? 3 : Number(nWord);
  return { ms: n * (/^h/i.test(m[2]!) ? 3_600_000 : 60_000), phrase: m[0] };
}

const STOP = new Set(['the', 'a', 'an', 'at', 'of', 'and', 'park', 'ride', 'show', 'harbor', 'lantern', 'to', 'for', 'on']);
const KIND_WORDS: Record<string, Place['kind']> = {
  ride: 'ride', rides: 'ride', show: 'show', shows: 'show', restroom: 'restroom', restrooms: 'restroom', toilets: 'restroom', bathroom: 'restroom', bathrooms: 'restroom',
  shop: 'shop', store: 'shop', 'gift shop': 'shop', entrance: 'entrance', gate: 'entrance', exit: 'exit',
};

/** Resolves a phrase to exactly one place by name, id, distinctive name word, or unique kind word. */
export function resolvePlace(phrase: string, places: PlaceRef[]): { place: PlaceRef } | { error: string } {
  const p = ` ${phrase.toLowerCase().replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const byName = places.filter((pl) => p.includes(` ${pl.name.toLowerCase()} `) || p.includes(` ${pl.name.toLowerCase().replace(/'/g, '')} `));
  if (byName.length === 1) return { place: byName[0]! };
  if (byName.length > 1) {
    const longest = byName.reduce((a, b) => (b.name.length > a.name.length ? b : a));
    if (byName.every((b) => b === longest || longest.name.toLowerCase().includes(b.name.toLowerCase()))) return { place: longest };
    return { error: `"${phrase.trim()}" matches several places: ${byName.map((x) => x.name).join(', ')}` };
  }
  const byId = places.filter((pl) => p.includes(` ${pl.id.toLowerCase()} `));
  if (byId.length === 1) return { place: byId[0]! };
  const words = p.trim().split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
  const byWord = new Map<Id, PlaceRef>();
  for (const w of words) {
    for (const pl of places) {
      const nameWords = pl.name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/);
      if (nameWords.some((nw) => nw === w || nw === `${w}s` || `${nw}s` === w)) byWord.set(pl.id, pl);
    }
  }
  if (byWord.size === 1) return { place: [...byWord.values()][0]! };
  if (byWord.size > 1) return { error: `"${phrase.trim()}" matches several places: ${[...byWord.values()].map((x) => x.name).join(', ')}` };
  for (const [w, kind] of Object.entries(KIND_WORDS)) {
    if (p.includes(` ${w} `)) {
      const ofKind = places.filter((pl) => pl.kind === kind);
      if (ofKind.length === 1) return { place: ofKind[0]! };
      if (ofKind.length > 1) return { error: `"${phrase.trim()}" could be any of ${ofKind.map((x) => x.name).join(', ')}; name one` };
    }
  }
  return { error: `"${phrase.trim()}" does not name a known place` };
}

function quoted(clause: string): string | null {
  const m = /["“]([^"”]{1,500})["”]/.exec(clause);
  return m ? m[1]!.trim() : null;
}

function checkTime(atMs: SimMs, c: Ctx, raw: string): string | null {
  if (!isSimMs(atMs) || atMs % SIM_STEP_MS !== 0) return `"${raw}": time is not a ${SIM_STEP_MS} ms boundary`;
  if (atMs < c.context.earliestSchedulableMs) {
    return `"${raw}": ${formatLocal(c.openMin, atMs)} is before the earliest schedulable boundary ${formatLocal(c.openMin, c.context.earliestSchedulableMs)} (context at ${formatLocal(c.openMin, c.context.currentSimMs)}); the moment has passed or the context is stale`;
  }
  if (atMs > c.park.closeAfterMs) return `"${raw}": ${formatLocal(c.openMin, atMs)} is after park close`;
  return null;
}

function timeFor(clause: string, raw: string, c: Ctx, what: string): SimMs | null {
  const t = parseTime(clause, c);
  if (t && 'error' in t) { c.unsupported.push(`"${raw}": ${t.error}`); return null; }
  if (!t) {
    c.assumptions.push(`"${raw}": no time given; ${what} at the earliest schedulable boundary ${formatLocal(c.openMin, c.context.earliestSchedulableMs)} (confirm)`);
    return c.context.earliestSchedulableMs;
  }
  if (t.note) c.assumptions.push(`"${raw}": ${t.note}`);
  const bad = checkTime(t.atMs, c, raw);
  if (bad) { c.unsupported.push(bad); return null; }
  return t.atMs;
}

function stripTimes(s: string): string {
  return s
    .replace(/\b(?:at|from|starting(?: at)?|beginning(?: at)?|by|until|till)\s+(?:noon|midday|midnight|\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/gi, ' ')
    .replace(/\bin\s+\d{1,3}\s*(?:minutes?|mins?|hours?|hrs?)\b/gi, ' ')
    .replace(/\bfor\s+(?:an?|one|two|three|\d{1,3})\s*(?:minutes?|mins?|hours?|hrs?)\b|\bfor half an hour\b/gi, ' ')
    .replace(/\b(now|immediately|right away|asap|today)\b/gi, ' ');
}

function parseClause(raw: string, c: Ctx): Pending[] {
  const clause = raw.toLowerCase();
  const kinds = new Set(c.context.capabilities.eventKinds);
  const gate = (kind: ScenarioChange['kind']): boolean => {
    if (kinds.has(kind)) return true;
    c.unsupported.push(`"${raw}": event kind ${kind} is not supported by the current Engine capabilities`);
    return false;
  };
  const place = (phrase: string): PlaceRef | null => {
    const r = resolvePlace(phrase, c.context.places);
    if ('error' in r) { c.unsupported.push(`"${raw}": ${r.error}`); return null; }
    return r.place;
  };

  if (/\b(move|relocate|build|construct|demolish|widen|expand|add|remove)\b.*\b(stall|stand|cart|kiosk|ride|path|building|shop|attraction|queue|wall|fence|bench|restroom)s?\b/.test(clause)) {
    c.unsupported.push(`"${raw}": geometry or stall/attraction placement changes are not MVP scenario events`);
    return [];
  }

  if (/\b(message|notification|push|alert|text)\b/.test(clause) && /\b(send|push|post|broadcast|notify|blast)\b/.test(clause)) {
    if (!gate('app_message')) return [];
    const pct = /(\d{1,2}(?:\.\d{1,2})?)\s*(%|percent)\s*(off|discount)?|\b(discount|coupon|promo|deal|off)\b/.exec(clause);
    let discount: Extract<ScenarioChange, { kind: 'app_message' }>['discount'] = null;
    if (pct) {
      if (!c.context.capabilities.features.discountMessages) {
        c.unsupported.push(`"${raw}": discount messages are not enabled in Engine capabilities; a text-only "% off" message would not change any quote, so the discount push is rejected`);
        return [];
      }
      if (!pct[1]) { c.unsupported.push(`"${raw}": discount amount not stated; give a percentage`); return []; }
      const bps = Math.round(Number(pct[1]) * 100);
      if (!(bps > 0 && bps <= 9_000)) { c.unsupported.push(`"${raw}": discount ${pct[1]}% outside 0-90%`); return []; }
      const productIds: Id[] = [];
      if (/\bpass(es)?\b/.test(clause)) productIds.push(c.park.pass.productId);
      for (const pl of c.park.places) {
        if (pl.service.kind !== 'counter') continue;
        for (const prod of pl.service.products) if (clause.includes(prod.label.toLowerCase()) || new RegExp(`\\b${prod.id}\\b`).test(clause)) productIds.push(prod.id);
        if (clause.includes(pl.name.toLowerCase())) for (const prod of pl.service.products) productIds.push(prod.id);
      }
      if (!productIds.length) { c.unsupported.push(`"${raw}": discount does not say which product (passes or a named food/shop item)`); return []; }
      discount = { productIds: [...new Set(productIds)].sort(), discountBps: bps, maxUsesPerGroup: 1 };
      c.assumptions.push(`"${raw}": discount limited to 1 use per group (default; confirm)`);
    }
    let text = quoted(raw);
    if (!text) {
      if (!discount) { c.unsupported.push(`"${raw}": message text not given; put it in quotes`); return []; }
      text = `${Number(pct![1])}% off ${discount.productIds.includes(c.park.pass.productId) ? 'passes' : 'selected items'} today`;
      c.assumptions.push(`"${raw}": message text not given; using "${text}" (confirm)`);
    }
    const sugg = /\b(?:suggesting|pointing to|promoting|about|to visit|for)\s+(.+?)(?:\s+(?:at|from|in|for|until)\b|$)/i.exec(stripTimes(raw.replace(/["“][^"”]*["”]/g, ' ')));
    let suggestedPlaceId: Id | null = null;
    if (sugg && !/\b(passes?|minutes?|hours?|\d+%)/i.test(sugg[1]!)) {
      const r = resolvePlace(sugg[1]!, c.context.places);
      if ('place' in r) suggestedPlaceId = r.place.id;
    }
    const atMs = timeFor(clause, raw, c, 'sent');
    if (atMs === null) return [];
    const dur = parseDuration(clause);
    const expiresAtMs = atMs + (dur?.ms ?? DEFAULT_MESSAGE_EXPIRY_MS);
    if (!dur) c.assumptions.push(`"${raw}": message expires after ${DEFAULT_MESSAGE_EXPIRY_MS / 60_000} minutes (default; confirm)`);
    if (expiresAtMs > c.park.closeAfterMs) { c.unsupported.push(`"${raw}": message would expire after park close`); return []; }
    const messageId = `msg-${hashCanonical({ raw, atMs }).slice(0, 12)}`;
    return [{ atMs, change: { kind: 'app_message', messageId, text, expiresAtMs, suggestedPlaceId, discount } }];
  }

  if (/\bpass(es)?\b/.test(clause) && /\bshare\b|\blane\b.*%|%.*\blane\b/.test(clause)) {
    if (!gate('pass_share')) return [];
    const pct = /(\d{1,3})\s*(%|percent)/.exec(clause);
    if (!pct || Number(pct[1]) > 100) { c.unsupported.push(`"${raw}": pass share needs a percentage 0-100`); return []; }
    const target = /\b(?:at|for|on)\s+(.+?)\s+(?:to|at)\s+\d/.exec(stripTimes(raw));
    const pl = place(target?.[1] ?? raw);
    if (!pl) return [];
    if (pl.kind !== 'ride') { c.unsupported.push(`"${raw}": ${pl.name} is not a ride with a pass lane`); return []; }
    const atMs = timeFor(clause, raw, c, 'applied');
    if (atMs === null) return [];
    return [{ atMs, change: { kind: 'pass_share', placeId: pl.id, shareBps: Number(pct[1]) * 100 } }];
  }

  if (/\bpass(es)?\b|\bfast ?pass\b|\blightning lane\b/.test(clause) && /\b(price|cost|raise|increase|lower|reduce|drop|set|change|make|cut|charge)\b/.test(clause)) {
    if (!gate('pass_price')) return [];
    if (/\bby\b\s*(\$|\d)/.test(clause) || /%/.test(clause)) {
      c.unsupported.push(`"${raw}": relative price changes need the current scenario price; state the new price (e.g. "set passes to $25")`);
      return [];
    }
    if (/\bper (group|family|party)\b/.test(clause)) { c.unsupported.push(`"${raw}": passes are priced per guest; a per-group price is not supported`); return []; }
    const money = parseMoneyCents(stripTimes(raw));
    if (!money) { c.unsupported.push(`"${raw}": new pass price not stated`); return []; }
    if ('error' in money) { c.unsupported.push(`"${raw}": ${money.error}`); return []; }
    if (money.cents <= 0 || money.cents > 100_000) { c.unsupported.push(`"${raw}": pass price ${money.cents} cents is outside 1..100000`); return []; }
    c.assumptions.push(`"${raw}": price is per guest, ${money.cents} cents`);
    const atMs = timeFor(clause, raw, c, 'applied');
    if (atMs === null) return [];
    return [{ atMs, change: { kind: 'pass_price', unitPriceCents: money.cents } }];
  }

  if (/\bnotice\b|\bsign\b|\bsignage\b/.test(clause) && /\b(change|set|rewrite|update|replace|put|make)\b/.test(clause)) {
    if (!gate('notice')) return [];
    const text = quoted(raw);
    if (!text) { c.unsupported.push(`"${raw}": new notice text not given; put it in quotes`); return []; }
    const where = /\b(?:at|for|on|outside|near|by)\s+(.+?)\s+(?:to|with|saying|reading)\b/i.exec(stripTimes(raw.replace(/["“][^"”]*["”]/g, ' ')));
    const pl = place(where?.[1] ?? raw.replace(/["“][^"”]*["”]/g, ' '));
    if (!pl) return [];
    const existing = c.park.places.find((p) => p.id === pl.id)?.notice;
    const base = existing ? { channel: existing.channel, radiusM: existing.radiusM, cooldownMs: existing.cooldownMs } : DEFAULT_NOTICE;
    c.assumptions.push(existing
      ? `"${raw}": keeps ${pl.name}'s notice channel ${base.channel}, radius ${base.radiusM} m and cooldown ${base.cooldownMs / 60_000} min`
      : `"${raw}": ${pl.name} has no notice yet; using defaults channel ${base.channel}, radius ${base.radiusM} m, cooldown ${base.cooldownMs / 60_000} min (confirm)`);
    const atMs = timeFor(clause, raw, c, 'changed');
    if (atMs === null) return [];
    return [{ atMs, change: { kind: 'notice', placeId: pl.id, notice: { ...base, text } } }];
  }

  if (/\bboard\b|\bwait (time )?(sign|display)\b/.test(clause) && /\b(change|set|show|update|display|post|make)\b/.test(clause)) {
    if (!gate('board')) return [];
    const q = quoted(raw);
    const mins = /(\d{1,3})\s*(minutes?|mins?)\b/i.exec(q ?? stripTimes(raw));
    const scrubbed = stripTimes(raw.replace(/["“][^"”]*["”]/g, ' ')).replace(/\b\d{1,3}\s*(minutes?|mins?)\b/gi, ' ');
    const pl = place(scrubbed);
    if (!pl) return [];
    if (pl.kind !== 'ride' && pl.kind !== 'food' && pl.kind !== 'show') { c.unsupported.push(`"${raw}": ${pl.name} has no wait board`); return []; }
    const text = q ?? (mins ? `${pl.name} - ${mins[1]} minutes` : null);
    if (!text) { c.unsupported.push(`"${raw}": board text or minutes not given`); return []; }
    const n = mins ? Number(mins[1]) : null;
    const display: WaitDisplay = { kind: 'fixed', lowerMin: n, upperMin: n, text };
    c.assumptions.push(`"${raw}": board shows fixed text "${text}" regardless of the actual queue until changed again`);
    const atMs = timeFor(clause, raw, c, 'changed');
    if (atMs === null) return [];
    return [{ atMs, change: { kind: 'board', placeId: pl.id, display } }];
  }

  if (/\bshows?\b/.test(clause) && /\b(schedule|set|run|hold|move)\b/.test(clause)) {
    if (!gate('show_schedule')) return [];
    const pl = place(stripTimes(raw).replace(/\b(schedule|set|run|hold|move|times?)\b/gi, ' '));
    if (!pl) return [];
    if (pl.kind !== 'show') { c.unsupported.push(`"${raw}": ${pl.name} is not a show`); return []; }
    const times: SimMs[] = [];
    for (const m of raw.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/gi)) {
      const t = parseTime(`at ${m[0]}`, c);
      if (!t || 'error' in t) { c.unsupported.push(`"${raw}": ${t && 'error' in t ? t.error : 'bad show time'}`); return []; }
      const bad = checkTime(t.atMs, c, raw);
      if (bad) { c.unsupported.push(bad); return []; }
      times.push(t.atMs);
    }
    if (!times.length) { c.unsupported.push(`"${raw}": show times not given with am/pm`); return []; }
    c.assumptions.push(`"${raw}": replaces ${pl.name}'s remaining schedule with ${times.map((t) => formatLocal(c.openMin, t)).join(', ')}; takes effect at the earliest schedulable boundary`);
    return [{ atMs: c.context.earliestSchedulableMs, change: { kind: 'show_schedule', placeId: pl.id, startsAtMs: [...new Set(times)].sort((a, b) => a - b) } }];
  }

  const closure = /\b(close|shut(?:\s+down)?|reopen|re-open|open)\b\s+(.*)$/i.exec(raw);
  if (closure) {
    if (!gate('closure')) return [];
    const closed = !/^(re-?open|open)$/i.test(closure[1]!);
    const pl = place(stripTimes(closure[2]!));
    if (!pl) return [];
    const atMs = timeFor(clause, raw, c, closed ? 'closed' : 'reopened');
    if (atMs === null) return [];
    const out: Pending[] = [{ atMs, change: { kind: 'closure', placeId: pl.id, closed } }];
    if (closed) {
      const dur = parseDuration(clause);
      const until = parseTime(clause, c, 'until');
      let reopenAt: SimMs | null = null;
      if (dur) reopenAt = atMs + dur.ms;
      else if (until && 'atMs' in until) reopenAt = until.atMs;
      else if (until && 'error' in until) { c.unsupported.push(`"${raw}": ${until.error}`); return []; }
      if (reopenAt !== null) {
        if (reopenAt <= atMs || reopenAt > c.park.closeAfterMs || reopenAt % SIM_STEP_MS !== 0) { c.unsupported.push(`"${raw}": reopening time is invalid`); return []; }
        out.push({ atMs: reopenAt, change: { kind: 'closure', placeId: pl.id, closed: false } });
        c.assumptions.push(`"${raw}": ${pl.name} reopens at ${formatLocal(c.openMin, reopenAt)}`);
      } else {
        c.assumptions.push(`"${raw}": no duration given; ${pl.name} stays closed until another event reopens it (confirm)`);
      }
    }
    return out;
  }

  c.unsupported.push(`"${raw}": not understood as a supported scenario change`);
  return [];
}

/**
 * Deterministic scenario parser. Produces a typed, never auto-applied draft. Mixed requests keep
 * both their supported events and the unsupported/ambiguous portions for operator review.
 */
export function parseScenarioText(text: string, context: ScenarioContext, park: ParkBundle): ScenarioDraft {
  if (context.park.status !== 'ready') throw new ScenarioContextError(`park ${context.park.parkId} is ${context.park.status}`);
  if (park.parkId !== context.park.parkId || park.revision !== context.park.revision) {
    throw new ScenarioContextError(`park artifact ${park.parkId}@${park.revision} does not match context ${context.park.parkId}@${context.park.revision}`);
  }
  if (!isSimMs(context.currentSimMs) || !isSimMs(context.earliestSchedulableMs) || context.earliestSchedulableMs % SIM_STEP_MS !== 0
    || context.earliestSchedulableMs < context.currentSimMs) {
    throw new ScenarioContextError('scenario context has an invalid current time or earliest schedulable boundary');
  }
  const c: Ctx = { context, park, openMin: parseOpen(park.openLocal), assumptions: [], unsupported: [] };
  const trimmed = text.trim();
  const pending: Pending[] = [];
  if (!trimmed) c.unsupported.push('empty scenario request');
  else if (trimmed.length > 4000) c.unsupported.push('scenario request longer than 4000 characters');
  else for (const clause of splitScenarioClauses(trimmed)) pending.push(...parseClause(clause, c));

  const draftId = `draft-${hashCanonical({ v: SCENARIO_PARSER_VERSION, text: trimmed, contextRevision: context.scenarioRevision, runId: context.runId, park: context.park.revision }).slice(0, 24)}`;
  const events: ScenarioEvent[] = pending.map((p, i) => ({ id: `${draftId}-e${i}`, atMs: p.atMs, order: i, change: p.change }));
  const assumptions = [...c.assumptions];
  assumptions.push(`Times are park local time relative to opening ${park.openLocal}; context scenario revision ${context.scenarioRevision}`);
  if (events.length && c.unsupported.length) {
    assumptions.push(`Partial draft: ${c.unsupported.length} portion(s) unsupported or ambiguous. Applying only the supported events changes the request; review explicitly.`);
  }
  return { draftId, contextRevision: context.scenarioRevision, events, assumptions, unsupported: c.unsupported, requiresConfirmation: true };
}

export function parkOpenMinutes(park: ParkBundle): number { return parseOpen(park.openLocal); }
