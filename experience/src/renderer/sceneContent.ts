/** Park-specific static content for the iso scene (structures, decor, gate), shared by the live map and previews. */
import type { ParkBundle, Vec2 } from '../../contract/behavior-v1';
import { decorFor, HARBOR_LIGHTS_PARK_ID, LAYOUT } from '../content/harborLights';
import type { SceneInit } from './ParkScene';

export type SceneContent = Pick<SceneInit, 'codes' | 'grid' | 'openLocal' | 'places' | 'queueZones' | 'decor' | 'structures' | 'gate' | 'walkable'>;

export function walkableFor(park: Pick<ParkBundle, 'grid'>, codes: Uint8Array) {
  const w = park.grid.width;
  return (p: Vec2) => {
    const x = Math.floor(p.xM / park.grid.cellM); const y = Math.floor(p.yM / park.grid.cellM);
    if (x < 0 || y < 0 || x >= w || y >= park.grid.height) return false;
    const c = codes[y * w + x];
    return c === 1 || c === 2 || c === 4 || (c === 3 && park.grid.grassWalkable);
  };
}

export function sceneContentFor(park: ParkBundle, codes: Uint8Array, walkable = walkableFor(park, codes)): SceneContent {
  const placeIds = new Set(park.places.map((p) => p.id));
  const harbor = park.parkId === HARBOR_LIGHTS_PARK_ID;
  const decor = harbor ? decorFor(placeIds) : [];
  const kinds = new Map(park.places.map((p) => [p.id, p.kind]));
  const structures: SceneInit['structures'] = harbor
    ? LAYOUT.places.filter((p) => p.footprint && placeIds.has(p.id)).map((p) => ({ id: p.id, kind: kinds.get(p.id) ?? 'scenery', footprint: p.footprint!, decor: p.decor ?? 'roof' }))
    : [];
  const gatePlaza = harbor && park.places.some((p) => p.kind === 'entrance') ? LAYOUT.plazas.find((p) => p.id === 'gate_plaza') : undefined;
  const gate = gatePlaza ? { x0: gatePlaza.x - 1, x1: gatePlaza.x + gatePlaza.w + 1, y: gatePlaza.y + gatePlaza.h + 0.5 } : null;
  return { codes, grid: park.grid, openLocal: park.openLocal, places: park.places, queueZones: park.queueZones, decor, structures, gate, walkable };
}
