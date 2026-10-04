/**
 * Standalone content validation: metadata, references, palette coverage, queue ownership,
 * service consistency and schema shape. The reachability check below is an AUTHORING
 * SANITY flood fill only; Engine's navigation compiler is the authoritative validator.
 */
import type { CellCode, Scenario } from '../../../contract/behavior-v1';
import { CELL, PALETTE, inStage, paintStage, type Layout, type Stage } from './layout-lib';
import type { ParkContent, PlaceContent } from './assemble';

export type ScenarioPreset = {
  meta: { presetId: string; kind: string; primaryAB: 'A' | 'B' | null; stage: Stage; summary: string; authoredHypothesis: string | null };
  scenario: Scenario;
};
export type ContentInput = {
  layout: Layout; places: PlaceContent[]; park: ParkContent; presets: ScenarioPreset[];
  /** Decoded RGBA pixels of generated/stage{n}/grid.png keyed by stage. */
  pngs: Partial<Record<Stage, { width: number; height: number; rgba: Uint8Array }>>;
};

const STEP = 5000;
const ID = /^[A-Za-z0-9_.:-]{1,160}$/;

export function validateContent(input: ContentInput): string[] {
  const errors: string[] = [];
  const { layout, places, park, presets } = input;
  const err = (m: string) => errors.push(m);

  // IDs and cross-references.
  const ids = new Set<string>();
  for (const p of places) {
    if (!ID.test(p.id)) err(`invalid place id ${p.id}`);
    if (ids.has(p.id)) err(`duplicate place id ${p.id}`);
    ids.add(p.id);
  }
  const layoutIds = new Set(layout.places.map((p) => p.id));
  for (const id of ids) if (!layoutIds.has(id)) err(`places.json ${id} missing from layout.json`);
  for (const id of layoutIds) if (!ids.has(id)) err(`layout.json ${id} missing from places.json`);
  for (const lp of layout.places) {
    const content = places.find((p) => p.id === lp.id);
    if (content && content.stage !== lp.stage) err(`stage mismatch for ${lp.id}`);
  }

  // Service consistency (synthetic inputs, but internally consistent).
  for (const p of places) {
    const s = p.service;
    const mult = (v: number, label: string) => {
      if (!Number.isSafeInteger(v) || v < 0 || v % STEP !== 0) err(`${p.id}: ${label}=${v} must be a nonnegative multiple of ${STEP} ms`);
    };
    if (p.thrill < 0 || p.thrill > 1) err(`${p.id}: thrill outside 0..1`);
    if (p.kind === 'ride' && s.kind !== 'ride') err(`${p.id}: ride must have ride service`);
    if (p.kind === 'show' && s.kind !== 'show') err(`${p.id}: show must have show service`);
    if ((p.kind === 'food' || p.kind === 'shop') && s.kind !== 'counter') err(`${p.id}: ${p.kind} must have counter service`);
    if (s.kind === 'ride') {
      mult(s.dispatchMs, 'dispatchMs'); mult(s.durationMs, 'durationMs'); mult(s.turnaroundMs, 'turnaroundMs');
      if (s.seats < 1 || s.vehicles < 1) err(`${p.id}: seats/vehicles must be positive`);
      if (s.vehicles * s.dispatchMs < s.durationMs + s.turnaroundMs) {
        err(`${p.id}: ${s.vehicles} vehicle(s) x ${s.dispatchMs} ms dispatch cannot cover a ${s.durationMs + s.turnaroundMs} ms cycle`);
      }
      if (s.passShareBps < 0 || s.passShareBps > 10000) err(`${p.id}: passShareBps outside 0..10000`);
      if (s.passEnabled !== s.passShareBps > 0) err(`${p.id}: passEnabled must match a nonzero pass share`);
      if (!p.board) err(`${p.id}: rides publish a wait board`);
    }
    if (s.kind === 'show') {
      mult(s.durationMs, 'durationMs');
      s.startsAtMs.forEach((t) => mult(t, 'startsAtMs'));
      if (s.startsAtMs.some((t, i) => i > 0 && t <= s.startsAtMs[i - 1]!)) err(`${p.id}: show times must increase`);
      if (s.startsAtMs.some((t) => t + s.durationMs > park.closeAfterMs)) err(`${p.id}: show runs past closing`);
    }
    if (s.kind === 'counter') {
      mult(s.serviceMs, 'serviceMs'); mult(s.activityMs, 'activityMs');
      if (s.servers < 1) err(`${p.id}: servers must be positive`);
      const pids = new Set<string>();
      for (const pr of s.products) {
        if (!Number.isSafeInteger(pr.unitPriceCents) || pr.unitPriceCents <= 0) err(`${p.id}/${pr.id}: price must be positive integer cents`);
        if (pids.has(pr.id)) err(`${p.id}: duplicate product ${pr.id}`);
        pids.add(pr.id);
      }
    }
    if (s.kind === 'rest') mult(s.durationMs, 'durationMs');
    if (p.notice) {
      mult(p.notice.cooldownMs, 'notice.cooldownMs');
      if (!p.notice.text.trim()) err(`${p.id}: empty notice`);
      if (!p.noticeVersion) err(`${p.id}: notice needs a content version`);
    }
  }
  if (!Number.isSafeInteger(park.pass.unitPriceCents) || park.pass.unitPriceCents !== 1500) err('baseline pass price must be 1500 cents');
  if (!/^\d{2}:\d{2}$/.test(park.openLocal)) err('openLocal must be HH:MM');

  // Required notice coverage.
  const notices = places.filter((p) => p.notice && p.stage === 1);
  const need: [string, (p: PlaceContent) => boolean][] = [
    ['visible shop sign', (p) => p.kind === 'shop' && p.notice?.channel === 'visual'],
    ['aroma food notice', (p) => p.kind === 'food' && p.notice?.channel === 'aroma'],
    ['scenic resting place', (p) => p.kind === 'scenery' && p.notice?.channel === 'visual'],
    ['show notice', (p) => p.kind === 'show' && p.notice?.channel === 'visual'],
  ];
  for (const [label, test] of need) if (!notices.some(test)) err(`stage 1 is missing a ${label}`);

  // Stage attraction counts (rides + shows only; restrooms/gates/benches do not count).
  const attractions = (stage: Stage) => places.filter((p) => inStage(p, stage) && (p.kind === 'ride' || p.kind === 'show'));
  const s1 = attractions(1).length;
  const s2 = attractions(2).length;
  if (s1 < 4 || s1 > 6) err(`stage 1 must have 4-6 attractions, has ${s1}`);
  if (s2 < 15) err(`stage 2 target must have at least 15 attractions, has ${s2}`);
  for (const p of places) if (p.attraction !== (p.kind === 'ride' || p.kind === 'show')) err(`${p.id}: attraction flag must equal ride/show kind`);
  const familyFriendly = attractions(1).filter((p) => p.minHeightCm === null || p.minHeightCm <= 100);
  if (familyFriendly.length < 3) err('stage 1 needs at least 3 attractions open to small children');
  for (const kind of ['food', 'shop', 'restroom', 'scenery', 'entrance', 'exit'] as const) {
    if (!places.some((p) => p.stage === 1 && p.kind === kind)) err(`stage 1 is missing a ${kind}`);
  }

  // Geometry, palette and queue ownership per stage.
  for (const stage of [1, 2] as Stage[]) {
    const painted = paintStage(layout, stage);
    painted.errors.forEach((e) => err(`stage ${stage}: ${e}`));
    const png = input.pngs[stage];
    if (!png) { err(`stage ${stage}: grid.png missing`); continue; }
    if (png.width !== layout.width || png.height !== layout.height) err(`stage ${stage}: PNG size ${png.width}x${png.height} != layout`);
    const lookup = new Map<string, CellCode>();
    for (const [code, rgb] of Object.entries(PALETTE)) lookup.set(rgb.join(','), Number(code) as CellCode);
    const seen = new Set<number>();
    let drift = 0;
    for (let i = 0; i < png.width * png.height; i++) {
      const a = png.rgba[i * 4 + 3];
      const key = `${png.rgba[i * 4]},${png.rgba[i * 4 + 1]},${png.rgba[i * 4 + 2]}`;
      const code = lookup.get(key);
      if (code === undefined || a !== 255) { err(`stage ${stage}: pixel ${i} (${key},${a}) is not in the categorical palette`); break; }
      seen.add(code);
      if (painted.codes[i] !== code) drift++;
    }
    if (drift) err(`stage ${stage}: PNG differs from layout.json in ${drift} cells; run npm run content:paint`);
    for (const c of [0, 1, 2, 3, 4]) if (!seen.has(c)) err(`stage ${stage}: palette code ${c} unused`);

    const owner = new Map<number, string>();
    for (const z of painted.queueZones) {
      for (const idx of z.cellIndices) {
        if (owner.has(idx)) err(`stage ${stage}: cell ${idx} owned by ${owner.get(idx)} and ${z.id}`);
        owner.set(idx, z.id);
        if (painted.codes[idx] !== CELL.queue) err(`stage ${stage}: ${z.id} cell ${idx} is not queue-coloured`);
      }
    }
    painted.codes.forEach((c, i) => { if (c === CELL.queue && !owner.has(i)) err(`stage ${stage}: queue cell ${i} has no owning zone`); });

    // Authoring sanity: every entrance reachable from the main gate over path/plaza cells.
    const gate = painted.entrances.main_gate;
    if (!gate) { err(`stage ${stage}: main_gate missing`); continue; }
    const w = painted.width;
    const reach = new Uint8Array(painted.codes.length);
    const start = Math.floor(gate.yM) * w + Math.floor(gate.xM);
    const stack = [start];
    reach[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      for (const n of [i - 1, i + 1, i - w, i + w]) {
        if (n < 0 || n >= painted.codes.length || reach[n]) continue;
        if ((n === i - 1 && x === 0) || (n === i + 1 && x === w - 1)) continue;
        const c = painted.codes[n];
        if (c === CELL.path || c === CELL.plaza) { reach[n] = 1; stack.push(n); }
      }
    }
    for (const [id, e] of Object.entries(painted.entrances)) {
      if (!reach[Math.floor(e.yM) * w + Math.floor(e.xM)]) err(`stage ${stage}: entrance of ${id} unreachable from main gate`);
    }
  }

  // Scenario presets.
  const presetIds = new Set<string>();
  for (const pr of presets) {
    const sc = pr.scenario;
    if (presetIds.has(sc.id)) err(`duplicate scenario ${sc.id}`);
    presetIds.add(sc.id);
    const stagePlaces = new Map(places.filter((p) => inStage(p, pr.meta.stage)).map((p) => [p.id, p]));
    const evIds = new Set<string>();
    for (const ev of sc.events) {
      if (evIds.has(ev.id)) err(`${sc.id}: duplicate event ${ev.id}`);
      evIds.add(ev.id);
      if (!Number.isSafeInteger(ev.atMs) || ev.atMs % STEP !== 0 || ev.atMs < 0 || ev.atMs >= park.closeAfterMs) err(`${sc.id}/${ev.id}: atMs must be a multiple of ${STEP} within hours`);
      const ch = ev.change;
      if ('placeId' in ch && ch.placeId !== undefined && !stagePlaces.has(ch.placeId)) err(`${sc.id}/${ev.id}: unknown place ${ch.placeId}`);
      if (ch.kind === 'notice' && stagePlaces.get(ch.placeId)?.notice?.channel !== ch.notice.channel) err(`${sc.id}/${ev.id}: notice channel differs from authored channel`);
      if (ch.kind === 'app_message' && ch.suggestedPlaceId && !stagePlaces.has(ch.suggestedPlaceId)) err(`${sc.id}/${ev.id}: unknown suggested place`);
      if (ch.kind === 'app_message' && ch.discount !== null) err(`${sc.id}/${ev.id}: presets do not claim discounts`);
      if (ch.kind === 'pass_price' && (!Number.isSafeInteger(ch.unitPriceCents) || ch.unitPriceCents <= 0)) err(`${sc.id}/${ev.id}: invalid pass price`);
    }
  }
  const baseline = presets.find((p) => p.meta.primaryAB === 'A');
  const variant = presets.find((p) => p.meta.primaryAB === 'B');
  if (!baseline || baseline.scenario.events.length !== 0) err('primary A/B baseline must have no events');
  if (!variant || variant.scenario.events.length !== 1 || variant.scenario.events[0]!.change.kind !== 'pass_price'
    || (variant.scenario.events[0]!.change as { unitPriceCents: number }).unitPriceCents !== 2500) {
    err('primary A/B variant must change ONLY the pass price to 2500 cents');
  }
  if (!presets.some((p) => p.scenario.events.some((e) => e.change.kind === 'closure'))) err('a closure preset is required');
  for (const kind of ['board', 'notice', 'app_message']) {
    if (!presets.some((p) => p.scenario.events.length > 0 && p.scenario.events.every((e) => e.change.kind === kind))) err(`missing ${kind}-only preset`);
  }
  return errors;
}
