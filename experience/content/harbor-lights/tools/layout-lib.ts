/**
 * Programmatic palette painting for Harbor Lights. Pure functions (no Node APIs) so the
 * same code paints the PNG source, validates content in tests and assembles the fixture
 * bundle. This is NOT the Engine navigation compiler: it paints categories and derives the
 * explicit queue cell sets; reachability/flow fields remain Engine's responsibility.
 */
import type { CellCode, QueueZone, Vec2 } from '../../../contract/behavior-v1';

export const CELL = { blocked: 0, path: 1, plaza: 2, grass: 3, queue: 4 } as const satisfies Record<string, CellCode>;

/** Exact categorical palette. Every PNG pixel must be one of these RGB triples (alpha 255). */
export const PALETTE: Record<CellCode, readonly [number, number, number]> = {
  0: [31, 41, 51], // blocked: buildings, ride footprints, water, fence
  1: [217, 200, 169], // path
  2: [242, 230, 207], // plaza
  3: [90, 155, 90], // grass (not walkable in the initial park)
  4: [224, 123, 57], // queue (entry controlled; ownership in queue-zones.json)
};

export type Stage = 1 | 2;
export type Rect = { x: number; y: number; w: number; h: number };
export type LayoutNode = { id: string; x: number; y: number; stage: Stage };
export type LayoutEdge = { id: string; from: string; to: string; width: number; stage: Stage };
export type QueueSpec = Rect & { id: string; entryCorner: 'nw' | 'ne' | 'sw' | 'se'; laneAxis: 'x' | 'y' };
export type LayoutPlace = {
  id: string; stage: Stage; footprint?: Rect; decor?: string; queue?: QueueSpec; entrance?: { x: number; y: number };
};
export type Layout = {
  width: number; height: number; cellM: number; fence: boolean;
  nodes: LayoutNode[]; edges: LayoutEdge[];
  plazas: (Rect & { id: string; stage: Stage })[];
  blocked: (Rect & { id: string; stage: Stage; decor?: string })[];
  places: LayoutPlace[];
};

export type PaintedStage = {
  stage: Stage;
  width: number;
  height: number;
  codes: Uint8Array;
  queueZones: QueueZone[];
  /** Serpentine order head -> tail, matching queueZones[i].cellIndices. */
  entrances: Record<string, Vec2>;
  footprints: Record<string, Rect>;
  errors: string[];
};

export const inStage = (el: { stage: Stage }, stage: Stage) => el.stage <= stage;
export const cellCenter = (index: number, width: number, cellM = 1): Vec2 => ({
  xM: ((index % width) + 0.5) * cellM,
  yM: (Math.floor(index / width) + 0.5) * cellM,
});

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Serpentine cell order for a queue rect, starting at the entry (tail) corner. */
export function serpentine(q: QueueSpec): { x: number; y: number }[] {
  const startX = q.entryCorner.endsWith('w') ? q.x : q.x + q.w - 1;
  const startY = q.entryCorner.startsWith('n') ? q.y : q.y + q.h - 1;
  const stepX = startX === q.x ? 1 : -1;
  const stepY = startY === q.y ? 1 : -1;
  const out: { x: number; y: number }[] = [];
  if (q.laneAxis === 'x') {
    for (let lane = 0; lane < q.h; lane++) {
      const y = startY + lane * stepY;
      const forward = lane % 2 === 0;
      for (let i = 0; i < q.w; i++) out.push({ x: forward ? startX + i * stepX : startX + (q.w - 1 - i) * stepX, y });
    }
  } else {
    for (let lane = 0; lane < q.w; lane++) {
      const x = startX + lane * stepX;
      const forward = lane % 2 === 0;
      for (let i = 0; i < q.h; i++) out.push({ x, y: forward ? startY + i * stepY : startY + (q.h - 1 - i) * stepY });
    }
  }
  return out;
}

const walkable = (c: number | undefined) => c === CELL.path || c === CELL.plaza;

export function paintStage(layout: Layout, stage: Stage): PaintedStage {
  const { width, height } = layout;
  const codes = new Uint8Array(width * height).fill(CELL.grass);
  const errors: string[] = [];
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? undefined : codes[y * width + x]);
  const set = (x: number, y: number, c: CellCode) => {
    if (x < 0 || y < 0 || x >= width || y >= height) errors.push(`cell (${x},${y}) outside grid`);
    else codes[y * width + x] = c;
  };
  const fillRect = (r: Rect, c: CellCode) => {
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) set(x, y, c);
  };

  for (const b of layout.blocked.filter((b) => inStage(b, stage))) fillRect(b, CELL.blocked);
  if (layout.fence) {
    for (let x = 0; x < width; x++) { set(x, 0, CELL.blocked); set(x, height - 1, CELL.blocked); }
    for (let y = 0; y < height; y++) { set(0, y, CELL.blocked); set(width - 1, y, CELL.blocked); }
  }

  const nodes = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const e of layout.edges.filter((e) => inStage(e, stage))) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) { errors.push(`edge ${e.id} references missing node`); continue; }
    if (!inStage(a, stage) || !inStage(b, stage)) errors.push(`edge ${e.id} uses a node from a later stage`);
    const pad = Math.ceil(e.width);
    for (let y = Math.min(a.y, b.y) - pad; y <= Math.max(a.y, b.y) + pad; y++) {
      for (let x = Math.min(a.x, b.x) - pad; x <= Math.max(a.x, b.x) + pad; x++) {
        // Nodes name cells; the centre line runs through node cell centres.
        if (distToSegment(x + 0.5, y + 0.5, a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5) < e.width / 2 && at(x, y) !== CELL.blocked) set(x, y, CELL.path);
      }
    }
  }
  for (const p of layout.plazas.filter((p) => inStage(p, stage))) fillRect(p, CELL.plaza);

  const places = layout.places.filter((p) => inStage(p, stage));
  const footprints: Record<string, Rect> = {};
  const queueZones: QueueZone[] = [];
  const entrances: Record<string, Vec2> = {};

  for (const p of places) {
    if (!p.queue) continue;
    for (let y = p.queue.y; y < p.queue.y + p.queue.h; y++) {
      for (let x = p.queue.x; x < p.queue.x + p.queue.w; x++) {
        if (walkable(at(x, y))) errors.push(`queue ${p.queue.id} overlaps walkway at (${x},${y})`);
        if (at(x, y) === CELL.blocked) errors.push(`queue ${p.queue.id} overlaps blocked cell at (${x},${y})`);
        set(x, y, CELL.queue);
      }
    }
  }
  for (const p of places) {
    if (!p.footprint) continue;
    footprints[p.id] = p.footprint;
    const r = p.footprint;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const c = at(x, y);
        if (c === CELL.path || c === CELL.plaza || c === CELL.queue) errors.push(`footprint ${p.id} overlaps walkable/queue cell (${x},${y})`);
        set(x, y, CELL.blocked);
      }
    }
  }

  for (const p of places) {
    if (p.queue) {
      const order = serpentine(p.queue); // tail (entry) first
      const tail = order[0]!;
      const head = order[order.length - 1]!;
      const neighbours = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
      const outside = (cx: number, cy: number) =>
        cx < p.queue!.x || cy < p.queue!.y || cx >= p.queue!.x + p.queue!.w || cy >= p.queue!.y + p.queue!.h;
      const entryWalk = neighbours.map(([dx, dy]) => ({ x: tail.x + dx, y: tail.y + dy }))
        .find((n) => outside(n.x, n.y) && walkable(at(n.x, n.y)));
      if (!entryWalk) errors.push(`queue ${p.queue.id} entry (${tail.x},${tail.y}) is not adjacent to a path/plaza cell`);
      const fp = p.footprint;
      const headTouches = fp && neighbours.some(([dx, dy]) => {
        const x = head.x + dx; const y = head.y + dy;
        return x >= fp.x && y >= fp.y && x < fp.x + fp.w && y < fp.y + fp.h;
      });
      if (!headTouches) errors.push(`queue ${p.queue.id} head (${head.x},${head.y}) does not touch ${p.id} footprint`);
      const headFirst = [...order].reverse();
      queueZones.push({
        id: p.queue.id,
        placeId: p.id,
        cellIndices: headFirst.map((c) => c.y * width + c.x),
        entry: { xM: tail.x + 0.5, yM: tail.y + 0.5 },
        exit: { xM: head.x + 0.5, yM: head.y + 0.5 },
      });
      if (entryWalk) entrances[p.id] = { xM: entryWalk.x + 0.5, yM: entryWalk.y + 0.5 };
    } else if (p.entrance) {
      entrances[p.id] = { xM: p.entrance.x + 0.5, yM: p.entrance.y + 0.5 };
      if (!walkable(at(p.entrance.x, p.entrance.y))) errors.push(`entrance of ${p.id} at (${p.entrance.x},${p.entrance.y}) is not on a path/plaza cell`);
    } else {
      errors.push(`place ${p.id} has neither queue nor entrance`);
    }
  }
  return { stage, width, height, codes, queueZones, entrances, footprints, errors };
}

/** Downsampled ASCII preview for authoring review (one char per `scale` cells). */
export function asciiPreview(p: PaintedStage, scale = 2): string {
  const chars = ['#', '.', ':', ' ', 'q'];
  const lines: string[] = [];
  for (let y = 0; y < p.height; y += scale) {
    let line = '';
    for (let x = 0; x < p.width; x += scale) {
      // Prefer the most "important" category in the block so thin paths remain visible.
      let best = 3;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const c = p.codes[(y + dy) * p.width + (x + dx)];
        if (c === undefined) continue;
        const rank = (v: number) => (v === 4 ? 5 : v === 1 ? 4 : v === 2 ? 3 : v === 0 ? 2 : 1);
        if (rank(c) > rank(best)) best = c;
      }
      line += chars[best];
    }
    lines.push(line);
  }
  return lines.join('\n');
}
