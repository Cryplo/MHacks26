import type { Hash, Id, ParkBundle, Place } from '../../contract/behavior-v1.ts';
import { sha256Hex } from '../core/canonical.ts';

export type ParkContext = {
  bundle: ParkBundle;
  parkHash: Hash;
  places: Map<Id, Place>;
  /** Places whose entrance cell is reachable from the park entrance over ordinary walkable cells. */
  reachable: Set<Id>;
  entranceId: Id;
  rides: Place[];
};

export class ParkValidationError extends Error {
  override name = 'ParkValidationError';
}

export function decodeGrid(bundle: ParkBundle): Uint8Array {
  const { grid } = bundle;
  const bytes = new Uint8Array(Buffer.from(grid.cellsBase64, 'base64'));
  if (bytes.length !== grid.width * grid.height) throw new ParkValidationError('grid byte length does not match width*height');
  if (sha256Hex(bytes) !== grid.cellsSha256) throw new ParkValidationError('grid cellsSha256 mismatch');
  for (const b of bytes) if (b > 4) throw new ParkValidationError(`invalid cell code ${b}`);
  return bytes;
}

/** Builds the population-side view of a validated park. `parkHash` is the park artifact SHA-256. */
export function parkContext(bundle: ParkBundle, parkHash: Hash): ParkContext {
  const cells = decodeGrid(bundle);
  const { width, height, cellM, grassWalkable } = bundle.grid;
  const walkable = (code: number) => code === 1 || code === 2 || code === 4 || (code === 3 && grassWalkable);
  const places = new Map(bundle.places.map((p) => [p.id, p]));
  if (places.size !== bundle.places.length) throw new ParkValidationError('duplicate place ids');
  const entrance = bundle.places.find((p) => p.kind === 'entrance');
  if (!entrance) throw new ParkValidationError('park has no entrance');
  const cellOf = (x: number, y: number) => {
    const col = Math.floor(x / cellM); const row = Math.floor(y / cellM);
    return col >= 0 && row >= 0 && col < width && row < height ? row * width + col : -1;
  };
  const start = cellOf(entrance.entrance.xM, entrance.entrance.yM);
  if (start < 0 || !walkable(cells[start]!)) throw new ParkValidationError('entrance is not on a walkable cell');
  const seen = new Uint8Array(cells.length);
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const c = queue.pop()!;
    const col = c % width; const row = (c - col) / width;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nc = col + dc; const nr = row + dr;
      if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
      const n = nr * width + nc;
      if (!seen[n] && walkable(cells[n]!)) { seen[n] = 1; queue.push(n); }
    }
  }
  const reachable = new Set<Id>();
  for (const p of bundle.places) {
    const c = cellOf(p.entrance.xM, p.entrance.yM);
    if (c >= 0 && seen[c]) reachable.add(p.id);
  }
  return {
    bundle, parkHash, places, reachable, entranceId: entrance.id,
    rides: bundle.places.filter((p) => p.kind === 'ride' && reachable.has(p.id)),
  };
}
