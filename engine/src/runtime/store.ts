import type { CoreState, DecisionLog, PersonState } from "../domain/state.js";
import type * as C from "../../contract/behavior-v1.js";
import { HEAT_WINDOW_MS } from "../sim/motion.js";
import { frameEveryMs, type CompactFrame } from "../replay/frames.js";
import { canonical, hash, asciiCompare } from "../domain/primitives.js";
export type Family =
  | "owner"
  | "role"
  | "grant"
  | "share"
  | "navigation"
  | "park"
  | "artifact"
  | "upload"
  | "chunk"
  | "work_locator"
  | "work_error"
  | "work"
  | "attempt"
  | "driver"
  | "receipt"
  | "experiment"
  | "run_assets"
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
  | "rate"
  | "boundary"
  | "fact"
  | "decision_log"
  | "tape";
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
  coreCache?: Map<string, CacheEntry>;
  constructor(options: { cache?: boolean } = {}) {
    if (options.cache) this.coreCache = new Map();
  }
  get(key: string) {
    return this.rows.get(key);
  }
  list(family: Family, scope?: string) {
    return [...this.rows.values()]
      .filter(
        (x) =>
          x.family === family && (scope === undefined || x.scope === scope),
      )
      .sort((a, b) => a.sequence - b.sequence || asciiCompare(a.key, b.key));
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
  readonly coreCache?: Map<string, CacheEntry>;
  readonly stamp?: () => string;
  constructor(private parent: Store) {
    // Writes stay in this overlay until commit; cache validity is still decided by the
    // stamp actually committed to the parent, so sharing the parent's cache is safe.
    this.coreCache = (parent as CachingStore).coreCache;
    this.stamp = (parent as CachingStore).stamp;
  }
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
      (a, b) => a.sequence - b.sequence || asciiCompare(a.key, b.key),
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
/**
 * How each CoreState collection is persisted:
 * - map: one row per record key, rewritten when its canonical body changes;
 * - frozen: map whose records never change once `frozenWhen` holds (written once more, then skipped);
 * - list: small index-keyed array, fully compared each save;
 * - append: index-keyed append-only array (only new indices are written);
 * - tail: append-only array whose recent tail may still change (heat coalescing);
 * - byId: immutable records keyed by their own id (records may be removed).
 * Persons are stored without their remembered facts; facts live in the "fact" family and are
 * rewritten only when the person's fact counter changes. Decision logs carry a revision.
 */
type Kind = "map" | "frozen" | "list" | "append" | "tail" | "byId";
const collections = {
  persons: ["person", "map"],
  groups: ["group", "map"],
  places: ["place", "map"],
  queues: ["queue", "list"],
  sessions: ["session", "list"],
  sales: ["sale", "list"],
  decisions: ["decision", "frozen"],
  evidence: ["evidence", "byId"],
  events: ["event", "append"],
  ratings: ["rating", "frozen"],
  metrics: ["metric", "append"],
  heat: ["heat", "tail"],
  boundaries: ["boundary", "append"],
  decisionLog: ["decision_log", "byId"],
  tapeResponses: ["tape", "append"],
} as const satisfies Record<string, readonly [Family, Kind]>;
export type Collection = keyof typeof collections;
const ARRAYS: Collection[] = [
  "queues",
  "sessions",
  "sales",
  "evidence",
  "events",
  "metrics",
  "heat",
  "boundaries",
  "tapeResponses",
];
const FROZEN = "\u0000frozen";
function frozen(collection: Collection, value: unknown): boolean {
  if (collection === "decisions") {
    const status = (value as { status: string }).status;
    return (
      status === "applied" || status === "superseded" || status === "cancelled"
    );
  }
  if (collection === "ratings")
    return (value as { result: unknown }).result !== null;
  return false;
}
/** What this process last wrote for one run (lets saves skip unchanged history). */
type WriteState = {
  /** Per family: row key -> last written body (or a FROZEN / revision marker). */
  bodies: Map<Family, Map<string, string>>;
  counts: Map<Collection, number>;
  factSeqs: Map<string, number>;
  savedSimMs: number;
};
const writeStates = new WeakMap<CoreState, WriteState>();
function bodiesOf(w: WriteState, family: Family): Map<string, string> {
  let m = w.bodies.get(family);
  if (!m) w.bodies.set(family, (m = new Map()));
  return m;
}
type CacheEntry = { stamp: string; state: CoreState };
/**
 * Optional cross-command cache of loaded run states. A Store that provides `coreCache` and
 * `stamp` lets Engine keep a run's state in memory between reducer calls: every save writes a
 * fresh unique stamp into the run row, and a cached state is reused only while the row still
 * carries the stamp written with it. A rolled-back transaction leaves the old stamp in the
 * database, so its (possibly half-mutated) cached state is discarded. Mutating commands check
 * the state out of the cache, so a command that fails after mutating never leaks its changes.
 */
export interface CachingStore extends Store {
  coreCache?: Map<string, CacheEntry>;
  stamp?: () => string;
}
const cacheOf = (store: Store) => (store as CachingStore).coreCache;
let stampCounter = 0;
function newStamp(store: Store): string {
  const s = (store as CachingStore).stamp;
  return s ? s() : `local:${++stampCounter}`;
}
function rowValue(
  family: Family,
  v: Record<string, unknown>,
): { status: string; due: number } {
  const status =
    (v.status as string | undefined) ??
    (v.state as string | undefined) ??
    (family === "queue" ? canonical([v.placeId, v.lane]) : "");
  const due =
    family === "queue"
      ? (v.sequence as number)
      : ((v.endMs ?? v.atMs ?? v.simMs ?? v.committedAtMs ?? 0) as number);
  return { status, due };
}
function writeRow(
  store: Store,
  family: Family,
  id: string,
  body: string,
  runId: string,
  value: Record<string, unknown>,
  sequence: number,
) {
  const { status, due } = rowValue(family, value);
  store.put({
    key: key(family, id, runId),
    family,
    scope: runId,
    status: typeof status === "string" ? status : "",
    due: Number.isFinite(due) ? due : 0,
    sequence,
    body,
  });
}
function entriesOf(
  collection: Collection,
  source: unknown,
): [string, Record<string, unknown>, number][] {
  if (collection === "decisionLog")
    // One immutable row per logged decision (pruned rows are deleted).
    return Object.entries(
      (source ?? {}) as Record<string, DecisionLog>,
    ).flatMap(([groupId, log]) =>
      log.entries.map(
        (e) =>
          [e.evidenceId, { ...e, groupId }, e.atMs] as [
            string,
            Record<string, unknown>,
            number,
          ],
      ),
    );
  if (collection === "evidence")
    return (source as C.AppliedDecision[]).map((e) => [
      e.evidenceId,
      e as unknown as Record<string, unknown>,
      e.committedAtMs,
    ]);
  if (Array.isArray(source))
    return source.map((v, i) => {
      const value = v as Record<string, unknown>;
      return [String(i), value, (value.sequence as number | undefined) ?? i];
    });
  return Object.entries(
    (source ?? {}) as Record<string, Record<string, unknown>>,
  ).map(([id, value]) => [
    id,
    value,
    (value.sequence as number | undefined) ?? 0,
  ]);
}
function decisionLogFrom(
  rows: (C.DecisionSummary & { groupId: string })[],
): Record<string, DecisionLog> {
  const logs: Record<string, DecisionLog> = {};
  for (const { groupId, ...entry } of rows)
    (logs[groupId] ??= { rev: 0, entries: [] }).entries.push(entry);
  for (const log of Object.values(logs)) {
    log.entries.sort((a, b) => a.atMs - b.atMs);
    log.rev = log.entries.length;
  }
  return logs;
}
function personBody(p: PersonState): string {
  return canonical({ ...p, facts: undefined });
}
/**
 * Persists a run state. `only` names the collections a command mutated (metadata is always
 * written); other collections are skipped when this process already knows their stored form,
 * which keeps per-response commands (e.g. completeWork) from re-serializing a whole crowd.
 */
/** Frames are stored one row per frame, keyed by time (the frame interval is a run constant). */
const frameKey = (state: CoreState, atMs: number) =>
  key("frame", `t:${atMs}`, state.runId);
/** Writes pending frames and clears them from the hot state. */
function saveFrames(store: Store, state: CoreState) {
  for (const f of state.frames)
    store.put({
      key: frameKey(state, f.atMs),
      family: "frame",
      scope: state.runId,
      status: "",
      due: f.atMs,
      sequence: f.atMs,
      body: canonical(f),
    });
  state.frames.length = 0;
}
/** Frames with fromMs <= atMs <= toMs (oldest first, at most `limit`), read by key. */
export function readFrames(
  store: Store,
  state: CoreState,
  fromMs: number,
  toMs: number,
  limit: number,
): (C.ReplayFrame | CompactFrame)[] {
  const every = frameEveryMs(state),
    pending = new Map(state.frames.map((f) => [f.atMs, f])),
    out: (C.ReplayFrame | CompactFrame)[] = [];
  const end = Math.min(toMs, state.view.simMs);
  for (
    let t = Math.ceil(Math.max(0, fromMs) / every) * every;
    t <= end && out.length < limit;
    t += every
  ) {
    const f =
      pending.get(t) ??
      (() => {
        const row = store.get(frameKey(state, t));
        return row
          ? (JSON.parse(row.body) as C.ReplayFrame | CompactFrame)
          : undefined;
      })();
    if (f) out.push(f);
  }
  return out;
}
export function saveCore(
  store: Store,
  state: CoreState,
  options: { only?: Collection[] } = {},
) {
  const metadata = { ...state } as Partial<CoreState> & {
    persistStamp?: string;
  };
  // Park/population are immutable inputs, not hot phase/cursor payloads.
  if (!store.get(key("run_assets", state.runId, state.runId)))
    put(
      store,
      "run_assets",
      state.runId,
      { park: state.park, population: state.population },
      state.runId,
    );
  delete metadata.park;
  delete metadata.population;
  delete metadata.frames;
  const runId = state.runId,
    previous = writeStates.get(state),
    w: WriteState = previous ?? {
      bodies: new Map(),
      counts: new Map(),
      factSeqs: new Map(),
      savedSimMs: 0,
    };
  for (const [property, [family, kind]] of Object.entries(collections) as [
    Collection,
    readonly [Family, Kind],
  ][]) {
    delete metadata[property];
    if (previous && options.only && !options.only.includes(property)) continue;
    const source = state[property as keyof CoreState] as unknown;
    if (!previous) {
      // Cold save: compare against the stored rows and delete rows no longer present.
      const current = new Set<string>();
      for (const [id, value, sequence] of entriesOf(property, source)) {
        const k = key(family, id, runId),
          body =
            property === "persons"
              ? personBody(value as PersonState)
              : canonical(value);
        current.add(k);
        if (store.get(k)?.body !== body)
          writeRow(store, family, id, body, runId, value, sequence);
        if (kind !== "append" && kind !== "tail")
          bodiesOf(w, family).set(
            k,
            frozen(property, value) || kind === "byId" ? FROZEN : body,
          );
      }
      for (const row of store.list(family, runId))
        if (!current.has(row.key)) store.delete(row.key);
      if (Array.isArray(source)) w.counts.set(property, source.length);
      continue;
    }
    if (kind === "append" || kind === "tail") {
      const list = (source ?? []) as Record<string, unknown>[],
        done = Math.min(w.counts.get(property) ?? 0, list.length);
      let from = done;
      if (kind === "tail")
        while (
          from > 0 &&
          ((list[from - 1] as { fromMs?: number }).fromMs ?? 0) >=
            w.savedSimMs - HEAT_WINDOW_MS - 5000
        )
          from--;
      for (let i = from; i < list.length; i++) {
        const value = list[i]!,
          body = canonical(value),
          k = key(family, String(i), runId);
        if (i < done && store.get(k)?.body === body) continue;
        writeRow(
          store,
          family,
          String(i),
          body,
          runId,
          value,
          (value.sequence as number | undefined) ?? i,
        );
      }
      for (let i = list.length; i < (w.counts.get(property) ?? 0); i++)
        store.delete(key(family, String(i), runId));
      w.counts.set(property, list.length);
      continue;
    }
    const current = new Set<string>(),
      bodies = bodiesOf(w, family);
    for (const [id, value, sequence] of entriesOf(property, source)) {
      const k = key(family, id, runId);
      current.add(k);
      const old = bodies.get(k);
      if (old === FROZEN) continue;
      if (kind === "byId") {
        writeRow(store, family, id, canonical(value), runId, value, sequence);
        bodies.set(k, FROZEN);
        continue;
      }
      const body =
        property === "persons"
          ? personBody(value as PersonState)
          : canonical(value);
      if (old !== body)
        writeRow(store, family, id, body, runId, value, sequence);
      bodies.set(k, frozen(property, value) ? FROZEN : body);
    }
    if (bodies.size > current.size)
      for (const k of [...bodies.keys()])
        if (!current.has(k)) {
          store.delete(k);
          bodies.delete(k);
        }
    if (kind === "list") w.counts.set(property, (source as unknown[]).length);
  }
  // Remembered facts: one row per person, rewritten only when its fact counter moved.
  if (!previous || !options.only || options.only.includes("persons"))
    for (const p of Object.values(state.persons)) {
      const seq = p.factSeq ?? p.facts.length;
      if (previous && w.factSeqs.get(p.agentId) === seq) continue;
      const body = canonical({ factSeq: seq, facts: p.facts }),
        k = key("fact", p.agentId, runId);
      if (previous || store.get(k)?.body !== body)
        store.put({
          key: k,
          family: "fact",
          scope: runId,
          status: "",
          due: 0,
          sequence: 0,
          body,
        });
      w.factSeqs.set(p.agentId, seq);
    }
  if (!options.only) saveFrames(store, state);
  w.savedSimMs = state.view.simMs;
  const stamp = newStamp(store);
  metadata.persistStamp = stamp;
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
  writeStates.set(state, w);
  const cache = cacheOf(store);
  if (cache) cache.set(state.runId, { stamp, state });
}
function storedStamp(store: Store, runId: string): string | undefined {
  const row = store.get(key("run", runId, runId));
  if (!row) return undefined;
  // The stamp is the last top-level key of the canonical metadata body only by accident of
  // naming, so read it structurally (cheap relative to loading every collection).
  const m = /"persistStamp":"([^"]*)"/.exec(row.body);
  return m?.[1];
}
/**
 * Loads a run's state. Mutating callers get exclusive ownership (the cached copy is checked
 * out); `readOnly` callers may share the cached object and must not mutate it.
 */
export function loadCore(
  store: Store,
  runId: string,
  options: { readOnly?: boolean } = {},
): CoreState | undefined {
  const cache = cacheOf(store);
  if (cache) {
    const entry = cache.get(runId);
    if (entry) {
      if (entry.stamp === storedStamp(store, runId)) {
        if (!options.readOnly) cache.delete(runId);
        return entry.state;
      }
      cache.delete(runId);
    }
  }
  const state = loadCold(store, runId);
  if (state && cache && options.readOnly) {
    const stamp = (state as { persistStamp?: string }).persistStamp;
    if (stamp) cache.set(runId, { stamp, state });
  }
  return state;
}
function loadCold(store: Store, runId: string): CoreState | undefined {
  const metadata = get<CoreState>(store, "run", runId, runId);
  if (!metadata) return;
  if (!metadata.park || !metadata.population) {
    const assets = get<Pick<CoreState, "park" | "population">>(
      store,
      "run_assets",
      runId,
      runId,
    );
    if (!assets) throw new Error("Run assets missing");
    Object.assign(metadata, assets);
  }
  const w: WriteState = {
    bodies: new Map(),
    counts: new Map(),
    factSeqs: new Map(),
    savedSimMs: metadata.view.simMs,
  };
  for (const [property, [family, kind]] of Object.entries(collections) as [
    Collection,
    readonly [Family, Kind],
  ][]) {
    const rows = store.list(family, runId);
    if (ARRAYS.includes(property))
      rows.sort(
        (a, b) => a.sequence - b.sequence || asciiCompare(a.key, b.key),
      );
    const parsed = rows.map((r) => JSON.parse(r.body) as unknown);
    rows.forEach((r, i) => {
      if (kind !== "append" && kind !== "tail")
        bodiesOf(w, family).set(
          r.key,
          kind === "byId" || frozen(property, parsed[i]) ? FROZEN : r.body,
        );
    });
    const value =
      property === "decisionLog"
        ? decisionLogFrom(parsed as (C.DecisionSummary & { groupId: string })[])
        : ARRAYS.includes(property)
          ? parsed
          : Object.fromEntries(
              rows.map((r, i) => [
                (JSON.parse(r.key) as string[])[2],
                parsed[i],
              ]),
            );
    if (ARRAYS.includes(property)) w.counts.set(property, rows.length);
    if (
      (property === "decisionLog" || property === "tapeResponses") &&
      !rows.length
    )
      continue;
    Object.assign(metadata, { [property]: value });
  }
  metadata.frames = [];
  for (const p of Object.values(metadata.persons)) {
    const row = get<{ factSeq: number; facts: C.ObservationFact[] }>(
      store,
      "fact",
      p.agentId,
      runId,
    );
    if (row) {
      p.facts = row.facts;
      w.factSeqs.set(p.agentId, row.factSeq);
    } else p.facts ??= [];
  }
  writeStates.set(metadata, w);
  return metadata;
}
export const payloadHash = (name: string, input: unknown) =>
  hash({ name, input });
