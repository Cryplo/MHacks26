import type * as C from "../../contract/behavior-v1.js";
import { DomainFault, ensure, hash, canonical } from "../domain/primitives.js";
import { validatePortInput } from "../domain/contract-validation.js";
import { get, list, key, readFrames, type Store } from "./store.js";
import type { CoreState, GroupState, PersonState } from "../domain/state.js";
import { decodeFrame } from "../replay/frames.js";
import {
  requireRun,
  authorizeScope,
  type Context,
  type RoleRecord,
  type Grant,
} from "./access.js";
import {
  peekCore,
  CAPABILITIES,
  factBundle,
  type ParkRecord,
  type ExperimentRecord,
} from "./runtime.js";
import { findJob, type Job } from "./work.js";
import { heatmap, agentView } from "../accounting/metrics.js";
import { statusText } from "../sim/status.js";
import { cloneJson } from "../domain/primitives.js";
function page<T>(
  items: T[],
  cursor: string | null,
  filters: unknown,
  limit = 100,
): C.Page<T> {
  const filterHash = hash(filters);
  let offset = 0;
  if (cursor) {
    let c: { offset: number; filterHash: string };
    try {
      c = JSON.parse(cursor);
    } catch {
      throw new DomainFault("INVALID_INPUT", "Malformed cursor");
    }
    ensure(
      c.filterHash === filterHash &&
        Number.isSafeInteger(c.offset) &&
        c.offset >= 0,
      "Cursor/filter mismatch",
    );
    offset = c.offset;
  }
  return {
    items: items.slice(offset, offset + limit),
    nextCursor:
      offset + limit < items.length
        ? canonical({ offset: offset + limit, filterHash })
        : null,
  };
}
export function query<K extends keyof C.Queries>(
  store: Store,
  ctx: Context,
  name: K,
  input: C.Queries[K]["input"],
): C.Queries[K]["output"] {
  validatePortInput("Queries", name, input);
  return dispatchQuery(store, ctx, name, input) as C.Queries[K]["output"];
}
function dispatchQuery(
  store: Store,
  ctx: Context,
  name: keyof C.Queries,
  input: C.Queries[keyof C.Queries]["input"],
): unknown {
  if (name === "capabilities") return CAPABILITIES;
  if (name === "session")
    return {
      identity: ctx.identity,
      roles: get<RoleRecord>(store, "role", ctx.identity)?.roles ?? [],
      runIds: list<Grant>(store, "grant")
        .filter(
          (g) =>
            g.identity === ctx.identity &&
            (g.expiresAt === null || g.expiresAt > ctx.now),
        )
        .filter((g) => {
          try {
            requireRun(store, ctx, g.runId);
            return true;
          } catch {
            return false;
          }
        })
        .map((g) => g.runId),
    };
  if (name === "listParks") {
    const role = get<RoleRecord>(store, "role", ctx.identity);
    ensure(
      role?.roles.some((r) =>
        ["operator", "worker", "coordinator"].includes(r),
      ),
      "Catalog access denied",
    );
    return page(
      list<ParkRecord>(store, "park").map((p) => p.summary),
      (input as C.Queries["listParks"]["input"]).cursor,
      { name },
    );
  }
  if (name === "getWork") {
    const a = input as C.Queries["getWork"]["input"],
      j = findJob(store, a.workId);
    ensure(j, "Unknown work");
    if (
      j.requester !== ctx.identity &&
      j.lease?.ownerIdentity !== ctx.identity
    ) {
      if (j.scope.runId) requireRun(store, ctx, j.scope.runId);
      else throw new DomainFault("FORBIDDEN", "Private work");
      ensure(
        j.kind === "thought" || j.kind === "report",
        "Private work result",
      );
    }
    return {
      workId: j.id,
      kind: j.kind,
      status: j.status,
      result: j.result,
      error: j.error,
    };
  }
  if (name === "getExperiment") {
    const a = input as C.Queries["getExperiment"]["input"];
    authorizeScope(store, ctx, { runId: null, experimentId: a.experimentId });
    const e = get<ExperimentRecord>(store, "experiment", a.experimentId);
    ensure(e, "Unknown experiment");
    return e.report;
  }
  if (name === "getFactBundle")
    return factBundle(store, ctx, input as C.Queries["getFactBundle"]["input"]);
  const a = input as { runId: string };
  requireRun(store, ctx, a.runId);
  if (name === "getRun" || name === "getManifest") {
    const metadata = get<{ view: C.RunView; manifest: C.RunManifest }>(
      store,
      "run",
      a.runId,
      a.runId,
    );
    ensure(metadata, "Run not found");
    return name === "getRun" ? metadata.view : metadata.manifest;
  }
  if (name === "getLiveSnapshot") {
    const publication = get<C.LiveSnapshot>(
      store,
      "publication",
      a.runId,
      a.runId,
    );
    ensure(publication, "Run publication unavailable");
    return publication;
  }
  if (name === "getAgent")
    return agentDetail(
      store,
      a.runId,
      (input as C.Queries["getAgent"]["input"]).agentId,
    );
  const s = peekCore(store, a.runId);
  switch (name) {
    case "getDecision": {
      const { evidenceId } = input as C.Queries["getDecision"]["input"],
        e = s.evidence.find((x) => x.evidenceId === evidenceId);
      ensure(e, "Unknown evidence");
      return e;
    }
    case "getMetrics": {
      const q = input as C.Queries["getMetrics"]["input"];
      ensure(q.toMs >= q.fromMs, "Invalid range");
      return page(
        s.metrics
          .filter((m) => m.simMs >= q.fromMs && m.simMs <= q.toMs)
          .sort((a, b) => a.simMs - b.simMs || a.revision - b.revision),
        q.cursor,
        { name, runId: q.runId, fromMs: q.fromMs, toMs: q.toMs },
      );
    }
    case "getEvents": {
      const q = input as C.Queries["getEvents"]["input"];
      ensure(
        Number.isSafeInteger(q.afterSequence) &&
          q.afterSequence >= 0 &&
          Number.isSafeInteger(q.limit) &&
          q.limit > 0 &&
          q.limit <= 500,
        "Invalid event page",
      );
      const rows = s.events.filter((e) => e.sequence > q.afterSequence),
        items = rows.slice(0, q.limit);
      return {
        items,
        nextAfterSequence:
          rows.length > q.limit ? items.at(-1)!.sequence : null,
      };
    }
    case "getHeatmap": {
      const q = input as C.Queries["getHeatmap"]["input"];
      return heatmap(s, q.layer, q.fromMs, q.toMs);
    }
    case "getFrames": {
      // Compact frames (replay/frames.ts) every frameEveryMs of sim time, expanded on read.
      // Cursor = atMs of the next frame to return; pages of 10.
      const q = input as C.Queries["getFrames"]["input"];
      ensure(q.toMs >= q.fromMs, "Invalid range");
      const filterHash = hash({
        name,
        runId: q.runId,
        fromMs: q.fromMs,
        toMs: q.toMs,
      });
      let from = q.fromMs;
      if (q.cursor) {
        let c: { after: number; filterHash: string };
        try {
          c = JSON.parse(q.cursor);
        } catch {
          throw new DomainFault("INVALID_INPUT", "Malformed cursor");
        }
        ensure(
          c.filterHash === filterHash && Number.isSafeInteger(c.after),
          "Cursor/filter mismatch",
        );
        from = c.after;
      }
      const frames = readFrames(store, s, from, q.toMs, 11),
        items = frames.slice(0, 10).map((f) => decodeFrame(f, s));
      return {
        items,
        nextCursor:
          frames.length > 10
            ? canonical({ after: frames[10]!.atMs, filterHash })
            : null,
      };
    }
  }
}
// Immutable per run (park + population); parsed once per module instance.
const assetCache = new Map<
  string,
  { length: number; assets: Pick<CoreState, "park" | "population"> }
>();
function runAssets(
  store: Store,
  runId: string,
): Pick<CoreState, "park" | "population"> {
  const row = store.get(key("run_assets", runId, runId));
  ensure(row, "Run not found");
  const hit = assetCache.get(runId);
  if (hit && hit.length === row.body.length) return hit.assets;
  const assets = JSON.parse(row.body) as Pick<CoreState, "park" | "population">;
  if (assetCache.size >= 4) assetCache.delete(assetCache.keys().next().value!);
  assetCache.set(runId, { length: row.body.length, assets });
  return assets;
}
/**
 * Inspector detail read by row key (person, facts, group, places, queues, evidence, the
 * group's decision-log and recent-event rows) instead of loading the whole run, so it stays
 * fast for large crowds even when this module instance has no cached run state.
 */
function agentDetail(
  store: Store,
  runId: string,
  agentId: string,
): C.AgentDetail {
  const p = get<PersonState>(store, "person", agentId, runId);
  ensure(p, "Unknown agent");
  const facts = get<{ facts: C.ObservationFact[] }>(
    store,
    "fact",
    agentId,
    runId,
  );
  p.facts = facts?.facts ?? p.facts ?? [];
  const g = get<GroupState>(store, "group", p.groupId, runId)!,
    meta = get<Pick<CoreState, "view">>(store, "run", runId, runId)!,
    assets = runAssets(store, runId);
  const places = Object.fromEntries(
    store
      .list("place", runId)
      .map((r) => [(JSON.parse(r.key) as string[])[2], JSON.parse(r.body)]),
  ) as CoreState["places"];
  const queues = store
    .list("queue", runId)
    .map((r) => JSON.parse(r.body) as CoreState["queues"][number]);
  const partial = {
    ...assets,
    view: meta.view,
    persons: { [agentId]: p },
    groups: { [p.groupId]: g },
    places,
    queues,
  } as unknown as CoreState;
  const evidence = p.latestEvidenceId
    ? (get<C.AppliedDecision>(store, "evidence", p.latestEvidenceId, runId) ??
      null)
    : null;
  const decisions: C.DecisionSummary[] = [];
  for (
    let seq = g.decisionSeq;
    seq > 0 && decisions.length < 12 && seq > g.decisionSeq - 40;
    seq--
  ) {
    const row = get<C.DecisionSummary & { groupId?: string }>(
      store,
      "decision_log",
      `evidence:${g.manifest.groupId}:${seq}`,
      runId,
    );
    if (row) {
      const { groupId: _g, ...entry } = row;
      decisions.push(entry);
    }
  }
  const recentEvents = (g.recentEventIdx ?? [])
    .map((i) => get<C.EventRecord>(store, "event", String(i), runId))
    .filter((e): e is C.EventRecord => !!e && e.agentIds.includes(agentId));
  return cloneJson({
    agent: agentView(p),
    persona: assets.population.personas.find((x) => x.agentId === agentId)!,
    group: g.manifest,
    observedFacts: p.facts,
    evidence,
    recentEvents,
    statusText: statusText(partial, agentId),
    decisions,
  } satisfies C.AgentDetail);
}
export function availableWork(
  store: Store,
  ctx: Context,
): { kind: C.WorkKind; count: number }[] {
  const roles = get<RoleRecord>(store, "role", ctx.identity)?.roles ?? [];
  const counts = new Map<C.WorkKind, number>();
  for (const row of store.list("work")) {
    const [status, encodedKind] = row.status.split(":");
    if (status !== "pending" && status !== "leased") continue;
    const kind = (encodedKind ??
      (JSON.parse(row.body) as Job).kind) as C.WorkKind;
    if (
      kind === "experiment"
        ? !roles.includes("coordinator")
        : !roles.includes("worker")
    )
      continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, count]) => ({ kind, count }));
}
