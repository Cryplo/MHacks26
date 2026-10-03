/**
 * Assembles a contract ParkBundle from authored content for the FIXTURE runtime and for
 * tests. Engine's compiler produces the authoritative bundle (and validates reachability /
 * flow fields); this assembly only joins painted cells with authored place content.
 */
import type { ParkBundle, Place, RouteProfile } from '../../../contract/behavior-v1';
import { CONTRACT_VERSION } from '../../../contract/behavior-v1';
import { paintStage, inStage, type Layout, type Stage } from './layout-lib';

export type PlaceContent = Omit<Place, 'entrance' | 'queueZoneId'> & {
  stage: Stage; attraction: boolean; description: string; restrictions: string[];
  noticeVersion?: string; authoredHypothesis?: string;
};
export type ParkContent = {
  parkId: string; label: string; contentVersion: string; openLocal: string; closeAfterMs: number;
  stages: Record<'1' | '2', { revision: string; label: string }>;
  pass: ParkBundle['pass'] & { label: string };
  routeProfiles: (RouteProfile & { stage: Stage })[];
};

export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function assembleBundle(
  layout: Layout, places: PlaceContent[], park: ParkContent, stage: Stage,
  sha256Hex: (bytes: Uint8Array) => Promise<string>,
): Promise<{ bundle: ParkBundle; errors: string[] }> {
  const painted = paintStage(layout, stage);
  const errors = [...painted.errors];
  const zonesByPlace = new Map(painted.queueZones.map((z) => [z.placeId, z]));
  const out: Place[] = [];
  for (const p of places.filter((p) => inStage(p, stage))) {
    const entrance = painted.entrances[p.id];
    if (!entrance) { errors.push(`place ${p.id} has no painted entrance in stage ${stage}`); continue; }
    out.push({
      id: p.id, name: p.name, kind: p.kind, entrance, queueZoneId: zonesByPlace.get(p.id)?.id ?? null,
      service: p.service, minHeightCm: p.minHeightCm, thrill: p.thrill, board: p.board, notice: p.notice,
    });
  }
  for (const lp of layout.places.filter((lp) => inStage(lp, stage))) {
    if (!out.some((p) => p.id === lp.id)) errors.push(`layout place ${lp.id} has no content in places.json`);
  }
  const st = park.stages[String(stage) as '1' | '2'];
  const bundle: ParkBundle = {
    contractVersion: CONTRACT_VERSION,
    parkId: park.parkId,
    revision: st.revision,
    label: st.label,
    openLocal: park.openLocal,
    closeAfterMs: park.closeAfterMs,
    grid: {
      width: painted.width, height: painted.height, cellM: layout.cellM, encoding: 'u8-row-major-v1',
      cellsBase64: toBase64(painted.codes), cellsSha256: await sha256Hex(painted.codes), grassWalkable: false,
    },
    places: out,
    queueZones: painted.queueZones,
    routeProfiles: park.routeProfiles.filter((r) => inStage(r, stage)).map(({ stage: _s, ...r }) => r),
    pass: { productId: park.pass.productId, unitPriceCents: park.pass.unitPriceCents, unit: park.pass.unit, validity: park.pass.validity },
  };
  return { bundle, errors };
}
