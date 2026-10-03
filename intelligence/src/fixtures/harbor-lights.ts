/**
 * FIXTURE park for Intelligence development only. Engine/Experience own the authored park and its
 * compiled ParkBundle; this stand-in exists so population hooks can be validated offline.
 */
import type { ArtifactRef, ParkBundle, Place, QueueZone } from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { canonicalBytes, sha256Hex } from '../core/canonical.ts';

const W = 60;
const H = 40;
const CELL_M = 2;

type Spec = { id: string; name: string; kind: Place['kind']; col: number; row: number; minHeightCm?: number; thrill?: number; service?: Place['service']; queue?: boolean };

const SPECS: Spec[] = [
  { id: 'gate', name: 'Harbor Gate', kind: 'entrance', col: 2, row: 20 },
  { id: 'gate-exit', name: 'Harbor Gate Exit', kind: 'exit', col: 2, row: 21 },
  { id: 'splash', name: 'Splash Falls', kind: 'ride', col: 10, row: 6, minHeightCm: 100, thrill: 0.5, queue: true },
  { id: 'carousel', name: 'Lantern Carousel', kind: 'ride', col: 20, row: 6, thrill: 0.1, queue: true },
  { id: 'drop', name: 'Lighthouse Drop', kind: 'ride', col: 40, row: 6, minHeightCm: 112, thrill: 0.8, queue: true },
  { id: 'comet', name: 'Harbor Comet', kind: 'ride', col: 50, row: 6, minHeightCm: 122, thrill: 0.9, queue: true },
  { id: 'teacups', name: 'Tide Pool Teacups', kind: 'ride', col: 20, row: 34, thrill: 0.3, queue: true },
  { id: 'bumpers', name: 'Buoy Bumpers', kind: 'ride', col: 40, row: 34, minHeightCm: 107, thrill: 0.4, queue: true },
  { id: 'cove-show', name: "Smugglers' Cove Show", kind: 'show', col: 50, row: 34, service: { kind: 'show', seats: 120, startsAtMs: [3_600_000, 10_800_000, 18_000_000, 25_200_000], durationMs: 1_200_000 } },
  { id: 'tacos', name: 'Dockside Tacos', kind: 'food', col: 30, row: 18, service: { kind: 'counter', servers: 3, serviceMs: 60_000, activityMs: 900_000, products: [{ id: 'taco-plate', label: 'Taco plate', unitPriceCents: 1200 }, { id: 'lemonade', label: 'Lemonade', unitPriceCents: 450 }] } },
  { id: 'cones', name: 'Fog Cones', kind: 'food', col: 10, row: 34, service: { kind: 'counter', servers: 2, serviceMs: 30_000, activityMs: 600_000, products: [{ id: 'cone', label: 'Ice cream cone', unitPriceCents: 550 }] } },
  { id: 'gifts', name: 'Harbor Gifts', kind: 'shop', col: 32, row: 22, service: { kind: 'counter', servers: 2, serviceMs: 45_000, activityMs: 600_000, products: [{ id: 'plush', label: 'Seal plush', unitPriceCents: 1800 }] } },
  { id: 'restroom', name: 'Restrooms', kind: 'restroom', col: 28, row: 22, service: { kind: 'rest', durationMs: 300_000 } },
  { id: 'pier', name: 'Lantern Pier', kind: 'scenery', col: 57, row: 20 },
];

function buildGrid(): Uint8Array {
  const g = new Uint8Array(W * H).fill(3);
  const set = (c: number, r: number, v: number) => { g[r * W + c] = v; };
  for (let c = 0; c < W; c++) { set(c, 0, 0); set(c, H - 1, 0); }
  for (let r = 0; r < H; r++) { set(0, r, 0); set(W - 1, r, 0); }
  for (let c = 2; c <= 57; c++) { set(c, 20, 1); set(c, 21, 1); }
  for (let r = 18; r <= 22; r++) for (let c = 28; c <= 32; c++) set(c, r, 2);
  for (const col of [10, 20, 40, 50]) for (let r = 6; r <= 34; r++) set(col, r, 1);
  for (let c = 10; c <= 50; c++) { set(c, 6, 1); set(c, 34, 1); }
  for (const s of SPECS) if (s.queue) for (let k = 1; k <= 3; k++) set(s.col + k, s.row - 1, 4);
  return g;
}

function rideService(): Place['service'] {
  return { kind: 'ride', seats: 4, vehicles: 6, dispatchMs: 60_000, durationMs: 180_000, turnaroundMs: 30_000, passShareBps: 3000, passEnabled: true };
}

export function harborLightsFixturePark(): ParkBundle {
  const cells = buildGrid();
  const queueZones: QueueZone[] = SPECS.filter((s) => s.queue).map((s) => ({
    id: `q-${s.id}`, placeId: s.id,
    cellIndices: [1, 2, 3].map((k) => (s.row - 1) * W + s.col + k),
    entry: { xM: (s.col + 1.5) * CELL_M, yM: (s.row - 0.5) * CELL_M },
    exit: { xM: (s.col + 3.5) * CELL_M, yM: (s.row - 0.5) * CELL_M },
  }));
  const places: Place[] = SPECS.map((s) => ({
    id: s.id, name: s.name, kind: s.kind,
    entrance: { xM: (s.col + 0.5) * CELL_M, yM: (s.row + 0.5) * CELL_M },
    queueZoneId: s.queue ? `q-${s.id}` : null,
    service: s.service ?? (s.kind === 'ride' ? rideService() : { kind: 'none' }),
    minHeightCm: s.minHeightCm ?? null, thrill: s.thrill ?? 0,
    board: s.kind === 'ride' ? { kind: 'rounded_estimate', roundToMin: 5, template: `${s.name} - {minutes} minutes` } : null,
    notice: s.kind === 'food' ? { text: `${s.name} - fresh and hot`, channel: 'aroma', radiusM: 12, cooldownMs: 600_000 } : null,
  }));
  return {
    contractVersion: CONTRACT_VERSION, parkId: 'harbor-lights', revision: 'fixture-1', label: 'Harbor Lights (Intelligence fixture)',
    openLocal: '09:00', closeAfterMs: 36_000_000,
    grid: { width: W, height: H, cellM: CELL_M, encoding: 'u8-row-major-v1', cellsBase64: Buffer.from(cells).toString('base64'), cellsSha256: sha256Hex(cells), grassWalkable: false },
    places, queueZones, routeProfiles: [],
    pass: { productId: 'pass', unitPriceCents: 1500, unit: 'per_guest', validity: 'remaining_day' },
  };
}

export function parkArtifact(bundle: ParkBundle): { bytes: Uint8Array; ref: ArtifactRef } {
  const bytes = canonicalBytes(bundle);
  const sha = sha256Hex(bytes);
  return {
    bytes,
    ref: { artifactId: `park-${bundle.parkId}-${sha.slice(0, 16)}`, kind: 'park', sha256: sha, byteLength: bytes.byteLength, mediaType: 'application/json', contractVersion: CONTRACT_VERSION },
  };
}
