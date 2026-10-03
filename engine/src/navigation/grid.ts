import type { Grid, ParkBundle, Vec2 } from "../../contract/behavior-v1.js";
import { ensure, hashBytes, asciiCompare } from "../domain/primitives.js";
import { parkSchema, parse, unique } from "../domain/schemas.js";
const alphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function encodeBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!,
      b = bytes[i + 1] ?? 0,
      c = bytes[i + 2] ?? 0;
    s +=
      alphabet[a >> 2]! +
      alphabet[((a & 3) << 4) | (b >> 4)]! +
      (i + 1 < bytes.length ? alphabet[((b & 15) << 2) | (c >> 6)]! : "=") +
      (i + 2 < bytes.length ? alphabet[c & 63]! : "=");
  }
  return s;
}
export function decodeBase64(s: string): Uint8Array {
  ensure(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s),
    "Invalid base64",
  );
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const a = alphabet.indexOf(s[i]!),
      b = alphabet.indexOf(s[i + 1]!),
      c = alphabet.indexOf(s[i + 2]!),
      d = alphabet.indexOf(s[i + 3]!);
    bytes.push((a << 2) | (b >> 4));
    if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0) bytes.push(((c & 3) << 6) | d);
  }
  const result = Uint8Array.from(bytes);
  ensure(encodeBase64(result) === s, "Noncanonical base64");
  return result;
}
export const UNREACHABLE = -1;
export class Navigation {
  readonly cells: Uint8Array;
  private fields = new Map<string, Float64Array>();
  constructor(
    readonly grid: Grid,
    private readonly loadField?: (cell: number) => number[] | undefined,
  ) {
    this.cells = decodeBase64(grid.cellsBase64);
    ensure(
      this.cells.length === grid.width * grid.height,
      "Grid byte count mismatch",
    );
    ensure(hashBytes(this.cells) === grid.cellsSha256, "Grid hash mismatch");
    ensure(
      this.cells.every((c) => c <= 4),
      "Unknown cell code",
    );
  }
  cell(p: Vec2): number {
    if (
      !Number.isFinite(p.xM) ||
      !Number.isFinite(p.yM) ||
      p.xM < 0 ||
      p.yM < 0
    )
      return -1;
    const x = Math.floor(p.xM / this.grid.cellM),
      y = Math.floor(p.yM / this.grid.cellM);
    return x < this.grid.width && y < this.grid.height
      ? y * this.grid.width + x
      : -1;
  }
  center(i: number): Vec2 {
    return {
      xM: ((i % this.grid.width) + 0.5) * this.grid.cellM,
      yM: (Math.floor(i / this.grid.width) + 0.5) * this.grid.cellM,
    };
  }
  walkable(i: number, queue?: ReadonlySet<number>): boolean {
    return (
      i >= 0 &&
      i < this.cells.length &&
      (this.cells[i] === 1 ||
        this.cells[i] === 2 ||
        (this.cells[i] === 4 && !!queue?.has(i)))
    );
  }
  neighbors(
    i: number,
    queue?: ReadonlySet<number>,
  ): { index: number; cost: number }[] {
    const x = i % this.grid.width,
      y = Math.floor(i / this.grid.width),
      out: { index: number; cost: number }[] = [];
    for (const [dx, dy] of [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as const) {
      const nx = x + dx,
        ny = y + dy,
        j = ny * this.grid.width + nx;
      if (
        nx < 0 ||
        ny < 0 ||
        nx >= this.grid.width ||
        ny >= this.grid.height ||
        !this.walkable(j, queue)
      )
        continue;
      if (
        dx &&
        dy &&
        (!this.walkable(y * this.grid.width + nx, queue) ||
          !this.walkable(ny * this.grid.width + x, queue))
      )
        continue;
      out.push({ index: j, cost: dx && dy ? Math.SQRT2 : 1 });
    }
    return out.sort((a, b) => a.index - b.index);
  }
  field(destination: Vec2, queue?: ReadonlySet<number>): Float64Array {
    const target = this.cell(destination),
      key = `${target}:${queue ? [...queue].sort((a, b) => a - b).join(",") : ""}`;
    const cached = this.fields.get(key);
    if (cached) return cached;
    ensure(this.walkable(target, queue), "Destination is not walkable");
    if (!queue && this.loadField) {
      const loaded = this.loadField(target);
      if (loaded) {
        ensure(
          loaded.length === this.cells.length,
          "Stored field dimensions mismatch",
        );
        const field = Float64Array.from(loaded);
        this.fields.set(key, field);
        return field;
      }
    }
    const distances = new Float64Array(this.cells.length).fill(UNREACHABLE);
    distances[target] = 0;
    const heap = new MinHeap();
    heap.push(target, 0);
    for (let item = heap.pop(); item; item = heap.pop()) {
      if (distances[item.index] !== item.cost) continue;
      for (const n of this.neighbors(item.index, queue)) {
        const cost = item.cost + n.cost;
        if (distances[n.index] === UNREACHABLE || cost < distances[n.index]!) {
          distances[n.index] = cost;
          heap.push(n.index, cost);
        }
      }
    }
    if (this.fields.size >= 64)
      this.fields.delete(this.fields.keys().next().value!);
    this.fields.set(key, distances);
    return distances;
  }
  seedField(cell: number, values: number[]) {
    ensure(
      values.length === this.cells.length && values[cell] === 0,
      "Invalid stored destination field",
    );
    this.fields.set(`${cell}:`, Float64Array.from(values));
  }
  next(position: Vec2, destination: Vec2): Vec2 | null {
    const from = this.cell(position),
      to = this.cell(destination),
      field = this.field(destination);
    if (from < 0 || field[from] === UNREACHABLE) return null;
    if (from === to) return destination;
    const options = this.neighbors(from)
      .filter((n) => field[n.index] !== UNREACHABLE)
      .sort(
        (a, b) =>
          a.cost + field[a.index]! - (b.cost + field[b.index]!) ||
          a.index - b.index,
      );
    return options.length ? this.center(options[0]!.index) : null;
  }
  // Supercover grid traversal: exact segment crossings, including both cells at corners.
  clearSegment(a: Vec2, b: Vec2, queue?: ReadonlySet<number>): boolean {
    const start = this.cell(a),
      end = this.cell(b);
    if (!this.walkable(start, queue) || !this.walkable(end, queue))
      return false;
    const scale = this.grid.cellM,
      ax = a.xM / scale,
      ay = a.yM / scale,
      bx = b.xM / scale,
      by = b.yM / scale;
    let x = Math.floor(ax),
      y = Math.floor(ay);
    const tx = Math.floor(bx),
      ty = Math.floor(by),
      dx = bx - ax,
      dy = by - ay;
    const sx = Math.sign(dx),
      sy = Math.sign(dy),
      ddx = dx ? Math.abs(1 / dx) : Infinity,
      ddy = dy ? Math.abs(1 / dy) : Infinity;
    let mx = dx ? ((sx > 0 ? x + 1 : x) - ax) / dx : Infinity,
      my = dy ? ((sy > 0 ? y + 1 : y) - ay) / dy : Infinity;
    const legal = (cx: number, cy: number) =>
      cx >= 0 &&
      cy >= 0 &&
      cx < this.grid.width &&
      cy < this.grid.height &&
      this.walkable(cy * this.grid.width + cx, queue);
    while (x !== tx || y !== ty) {
      if (Math.abs(mx - my) < 1e-12) {
        if (!legal(x + sx, y) || !legal(x, y + sy)) return false;
        x += sx;
        y += sy;
        mx += ddx;
        my += ddy;
      } else if (mx < my) {
        x += sx;
        mx += ddx;
      } else {
        y += sy;
        my += ddy;
      }
      if (!legal(x, y)) return false;
    }
    return true;
  }
}
class MinHeap {
  private values: { index: number; cost: number }[] = [];
  private less(
    a: { index: number; cost: number },
    b: { index: number; cost: number },
  ) {
    return a.cost < b.cost || (a.cost === b.cost && a.index < b.index);
  }
  push(index: number, cost: number) {
    const v = { index, cost },
      h = this.values;
    h.push(v);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(v, h[p]!)) break;
      h[i] = h[p]!;
      i = p;
    }
    h[i] = v;
  }
  pop() {
    const h = this.values,
      first = h[0],
      last = h.pop();
    if (h.length && last) {
      let i = 0;
      while (2 * i + 1 < h.length) {
        let c = 2 * i + 1;
        if (c + 1 < h.length && this.less(h[c + 1]!, h[c]!)) c++;
        if (!this.less(h[c]!, last)) break;
        h[i] = h[c]!;
        i = c;
      }
      h[i] = last;
    }
    return first;
  }
}
export function validatePark(input: unknown): {
  park: ParkBundle;
  navigation: Navigation;
} {
  const park = parse(parkSchema, input),
    nav = new Navigation(park.grid);
  unique(
    park.places.map((p) => p.id),
    "place",
  );
  unique(
    park.queueZones.map((q) => q.id),
    "queue zone",
  );
  unique(
    park.routeProfiles.map((r) => r.id),
    "route",
  );
  const entrances = park.places.filter((p) => p.kind === "entrance"),
    exits = park.places.filter((p) => p.kind === "exit");
  ensure(
    entrances.length > 0 && exits.length > 0,
    "Park needs entrance and exit",
  );
  const connected = nav.field(entrances[0]!.entrance),
    ownership = new Map<number, string>();
  for (const p of park.places) {
    ensure(
      nav.walkable(nav.cell(p.entrance)) &&
        connected[nav.cell(p.entrance)] !== UNREACHABLE,
      `Unreachable entrance: ${p.id}`,
    );
    const s = p.service;
    ensure(
      p.queueZoneId === null ||
        park.queueZones.some(
          (q) => q.id === p.queueZoneId && q.placeId === p.id,
        ),
      "Invalid queue reference",
    );
    if (s.kind === "ride")
      ensure(
        s.dispatchMs * s.vehicles >= s.durationMs + s.turnaroundMs,
        "Vehicles overlap duration/turnaround",
      );
    if (s.kind === "counter")
      unique(
        s.products.map((x) => x.id),
        "product",
      );
    if (s.kind === "show") {
      const times = [...s.startsAtMs].sort((a, b) => a - b);
      for (let i = 0; i < times.length; i++)
        ensure(
          times[i]! < park.closeAfterMs &&
            (i === 0 || times[i]! - times[i - 1]! >= s.durationMs),
          "Overlapping/out-of-day show",
        );
    }
    ensure(
      (p.kind !== "ride" || s.kind === "ride") &&
        (p.kind !== "show" || s.kind === "show"),
      "Place/service kind mismatch",
    );
  }
  for (const q of park.queueZones) {
    const p = park.places.find((p) => p.id === q.placeId);
    ensure(p && p.queueZoneId === q.id, "Orphan queue zone");
    const allowed = new Set(q.cellIndices);
    ensure(allowed.size === q.cellIndices.length, "Duplicate queue cell");
    for (const i of q.cellIndices) {
      ensure(
        nav.cells[i] === 4 && !ownership.has(i),
        "Overlapping or non-queue zone cell",
      );
      ownership.set(i, q.id);
    }
    const f = nav.field(p.entrance, allowed);
    for (const pos of [q.entry, q.exit])
      ensure(
        nav.walkable(nav.cell(pos), allowed) &&
          f[nav.cell(pos)] !== UNREACHABLE,
        "Disconnected queue portal",
      );
    for (const i of q.cellIndices)
      ensure(f[i] !== UNREACHABLE, "Disconnected queue cell");
  }
  nav.cells.forEach((code, i) =>
    ensure(code !== 4 || ownership.has(i), "Unowned queue cell"),
  );
  for (const r of [...park.routeProfiles].sort((a, b) =>
    asciiCompare(a.id, b.id),
  )) {
    ensure(
      park.places.some((p) => p.id === r.destinationId),
      "Unknown route destination",
    );
    for (const p of r.via)
      ensure(
        nav.walkable(nav.cell(p)) && connected[nav.cell(p)] !== UNREACHABLE,
        "Unreachable route waypoint",
      );
  }
  return { park, navigation: nav };
}
