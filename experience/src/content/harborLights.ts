/**
 * Authored Harbor Lights content for display: scenario presets, place descriptions, decor
 * footprints. Geometry and services shown in the product always come from the runtime's
 * ParkBundle; this module only adds descriptive text keyed by stable place IDs.
 */
import type { Scenario } from '../../contract/behavior-v1';
import layoutJson from '../../content/harbor-lights/layout.json';
import placesJson from '../../content/harbor-lights/places.json';
import baseline from '../../content/harbor-lights/scenarios/baseline.json';
import priceOnly from '../../content/harbor-lights/scenarios/price-only.json';
import boardOnly from '../../content/harbor-lights/scenarios/board-only.json';
import noticeOnly from '../../content/harbor-lights/scenarios/notice-only.json';
import appMessage from '../../content/harbor-lights/scenarios/app-message.json';
import closure from '../../content/harbor-lights/scenarios/closure.json';
import type { Layout } from '../../content/harbor-lights/tools/layout-lib';

export type PresetMeta = { presetId: string; kind: string; primaryAB: 'A' | 'B' | null; stage: 1 | 2; summary: string; authoredHypothesis: string | null };
export type ScenarioPreset = { meta: PresetMeta; scenario: Scenario };

export const SCENARIO_PRESETS: ScenarioPreset[] = [baseline, priceOnly, boardOnly, noticeOnly, appMessage, closure] as unknown as ScenarioPreset[];
export const HARBOR_LIGHTS_PARK_ID = 'harbor-lights';

type PlaceContent = { id: string; name: string; kind: string; stage: number; attraction: boolean; description: string; restrictions: string[]; authoredHypothesis?: string; noticeVersion?: string };
const places = (placesJson as unknown as { places: PlaceContent[] }).places;
export const PLACE_CONTENT = new Map(places.map((p) => [p.id, p]));
export const LAYOUT = layoutJson as unknown as Layout;

export type Decor = { id: string; kind: string; x: number; y: number; w: number; h: number; placeId: string | null };
/** Display-only decor drawn over blocked cells (footprints, water). Never over walkways. */
export function decorFor(placeIds: Set<string>): Decor[] {
  const out: Decor[] = [];
  for (const b of LAYOUT.blocked) out.push({ id: b.id, kind: b.decor ?? 'blocked', x: b.x, y: b.y, w: b.w, h: b.h, placeId: null });
  for (const p of LAYOUT.places) {
    if (!p.footprint || !placeIds.has(p.id)) continue;
    out.push({ id: p.id, kind: p.decor ?? 'roof', ...p.footprint, placeId: p.id });
  }
  return out;
}
