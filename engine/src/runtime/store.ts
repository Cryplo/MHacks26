import type { CoreState } from "../domain/state.js";
import { canonical, hash } from "../domain/primitives.js";
export type Family =
  | "owner"
  | "role"
  | "grant"
  | "share"
  | "park"
  | "artifact"
  | "upload"
  | "chunk"
  | "work"
  | "attempt"
  | "driver"
  | "receipt"
  | "experiment"
  | "run"
  | "person"
  | "group"
  | "place"
  | "queue"
  | "session"
  | "sale"
  | "decision"
  | "evidence"
  | "event"
  | "rating"
  | "metric"
  | "frame"
  | "heat"
  | "publication"
  | "rate";
export type RecordRow = {
  key: string;
  family: Family;
  scope: string;
  status: string;
  due: number;
  sequence: number;
  body: string;
};
export interface Store {
  get(key: string): RecordRow | undefined;
  list(family: Family, scope?: string): RecordRow[];
  put(row: RecordRow): void;
  delete(key: string): void;
}
export class MemoryStore implements Store {
  rows = new Map<string, RecordRow>();
  get(key: string) {
    return this.rows.get(key);
  }
  list(family: Family, scope?: string) {
    return [...this.rows.values()]
      .filter(
        (x) =>
          x.family === family && (scope === undefined || x.scope === scope),
      )
      .sort(
        (a, b) => a.sequence - b.sequence || a.key.localeCompare(b.key, "en"),
      );
  }
  put(row: RecordRow) {
    this.rows.set(row.key, { ...row });
  }
  delete(key: string) {
    this.rows.delete(key);
  }
}
export class TransactionStore implements Store {
  private changes = new Map<string, RecordRow | null>();
  constructor(private parent: Store) {}
  get(key: string) {
    return this.changes.has(key)
      ? (this.changes.get(key) ?? undefined)
      : this.parent.get(key);
  }
  list(family: Family, scope?: string) {
    const base = new Map(
      this.parent.list(family, scope).map((x) => [x.key, x]),
    );
    for (const [key, row] of this.changes) {
      base.delete(key);
      if (
        row &&
        row.family === family &&
        (scope === undefined || scope === row.scope)
      )
        base.set(key, row);
    }
    return [...base.values()].sort(
      (a, b) => a.sequence - b.sequence || a.key.localeCompare(b.key, "en"),
    );
  }
  put(row: RecordRow) {
    this.changes.set(row.key, row);
  }
  delete(key: string) {
    this.changes.set(key, null);
  }
  commit() {
    for (const [key, row] of this.changes) {
      if (row) this.parent.put(row);
      else this.parent.delete(key);
    }
  }
}
export const key = (family: Family, id: string, scope = "") =>
  canonical([family, scope, id]);
export function get<T>(
  store: Store,
  family: Family,
  id: string,
  scope = "",
): T | undefined {
  const row = store.get(key(family, id, scope));
  return row ? (JSON.parse(row.body) as T) : undefined;
}
export function put(
  store: Store,
  family: Family,
  id: string,
  value: unknown,
  scope = "",
  status = "",
  due = 0,
  sequence = 0,
) {
  const row = {
    key: key(family, id, scope),
    family,
    scope,
    status,
    due,
    sequence,
    body: canonical(value),
  };
  if (store.get(row.key)?.body !== row.body) store.put(row);
}
export function list<T>(store: Store, family: Family, scope?: string): T[] {
  return store.list(family, scope).map((x) => JSON.parse(x.body) as T);
}
const collections = {
  persons: "person",
  groups: "group",
  places: "place",
  queues: "queue",
  sessions: "session",
  sales: "sale",
  decisions: "decision",
  evidence: "evidence",
  events: "event",
  ratings: "rating",
  metrics: "metric",
  frames: "frame",
  heat: "heat",
} as const;
type Collection = keyof typeof collections;
export function saveCore(store: Store, state: CoreState) {
  const metadata = { ...state } as Partial<CoreState>;
  for (const [property, family] of Object.entries(collections) as [
    Collection,
    Family,
  ][]) {
    delete metadata[property];
    const source = state[property];
    const entries = Array.isArray(source)
      ? source.map((v, i) => [String(i), v] as const)
      : Object.entries(source);
    const current = new Set<string>();
    for (const [id, value] of entries) {
      current.add(key(family, id, state.runId));
      const v = value as unknown as {
        status?: string;
        state?: string;
        endMs?: number;
        atMs?: number;
        simMs?: number;
        sequence?: number;
      };
      put(
        store,
        family,
        id,
        value,
        state.runId,
        v.status ?? v.state ?? "",
        v.endMs ?? v.atMs ?? v.simMs ?? 0,
        v.sequence ?? (Number.isFinite(Number(id)) ? Number(id) : 0),
      );
    }
    for (const row of store.list(family, state.runId))
      if (!current.has(row.key)) store.delete(row.key);
  }
  put(
    store,
    "run",
    state.runId,
    metadata,
    state.runId,
    state.view.status,
    state.view.simMs,
    state.view.revision,
  );
}
export function loadCore(store: Store, runId: string): CoreState | undefined {
  const metadata = get<CoreState>(store, "run", runId, runId);
  if (!metadata) return;
  for (const [property, family] of Object.entries(collections) as [
    Collection,
    Family,
  ][]) {
    const rows = store.list(family, runId),
      isArray = [
        "queues",
        "sessions",
        "sales",
        "evidence",
        "events",
        "metrics",
        "frames",
        "heat",
      ].includes(property);
    const value = isArray
      ? rows
          .sort((a, b) => a.sequence - b.sequence)
          .map((r) => JSON.parse(r.body))
      : Object.fromEntries(
          rows.map((r) => [
            (JSON.parse(r.key) as string[])[2],
            JSON.parse(r.body),
          ]),
        );
    Object.assign(metadata, { [property]: value });
  }
  return metadata;
}
export const payloadHash = (name: string, input: unknown) =>
  hash({ name, input });
