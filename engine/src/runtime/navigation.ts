import type { Grid, Vec2 } from "../../contract/behavior-v1.js";
import { hash } from "../domain/primitives.js";
import { Navigation } from "../navigation/grid.js";
import type { ParkRecord } from "./runtime.js";
import { get, put, list, type Store } from "./store.js";
const topology = (grid: Grid) =>
  hash({
    width: grid.width,
    height: grid.height,
    cellM: grid.cellM,
    cellsSha256: grid.cellsSha256,
    grassWalkable: grid.grassWalkable,
  });
export function runtimeNavigation(store: Store, grid: Grid) {
  const scope = topology(grid);
  return new Navigation(grid, (cell) =>
    get<number[]>(store, "navigation", String(cell), scope),
  );
}
export function prepareFields(store: Store, p: ParkRecord, budget = 1) {
  if (p.summary.status !== "preparing") return;
  const nav = runtimeNavigation(store, p.park.grid),
    scope = topology(p.park.grid);
  const destinations = [
    ...new Map(
      [
        ...p.park.places.map((x) => x.entrance),
        ...p.park.routeProfiles.flatMap((r) => r.via),
      ].map((pos) => [nav.cell(pos), pos]),
    ).entries(),
  ].sort((a, b) => a[0] - b[0]);
  let cursor = p.fieldCursor ?? 0;
  for (
    let work = 0;
    work < budget && cursor < destinations.length;
    work++, cursor++
  ) {
    const [cell, pos] = destinations[cursor]! as [number, Vec2];
    if (!get(store, "navigation", String(cell), scope))
      put(store, "navigation", String(cell), Array.from(nav.field(pos)), scope);
  }
  p.fieldCursor = cursor;
  if (cursor === destinations.length) p.summary.status = "ready";
  put(store, "park", `${p.park.parkId}:${p.park.revision}`, p);
}
export function initializeParks(store: Store) {
  const p = list<ParkRecord>(store, "park").find(
    (p) => p.summary.status === "preparing",
  );
  if (p) prepareFields(store, p, 1);
}
