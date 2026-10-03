import type * as C from "../../contract/behavior-v1.js";
import { DomainFault, ensure, hash, canonical } from "../domain/primitives.js";
import { validatePortInput } from "../domain/contract-validation.js";
import { get, list, type Store } from "./store.js";
import {
  requireRun,
  authorizeScope,
  type Context,
  type RoleRecord,
  type Grant,
} from "./access.js";
import {
  core,
  CAPABILITIES,
  factBundle,
  type ParkRecord,
  type ExperimentRecord,
} from "./runtime.js";
import { findJob, type Job } from "./work.js";
import { heatmap, snapshot } from "../accounting/metrics.js";
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
  const s = core(store, a.runId);
  switch (name) {
    case "getRun":
      return s.view;
    case "getManifest":
      return s.manifest;
    case "getLiveSnapshot": {
      const p = get<C.LiveSnapshot>(store, "publication", a.runId, a.runId);
      ensure(p, "Run publication unavailable");
      return p;
    }
    case "getAgent": {
      const { agentId } = input as C.Queries["getAgent"]["input"],
        p = s.persons[agentId];
      ensure(p, "Unknown agent");
      return {
        agent: snapshot(s).agents.find((x) => x.agentId === agentId)!,
        persona: s.population.personas.find((x) => x.agentId === agentId)!,
        group: s.groups[p.groupId]!.manifest,
        observedFacts: p.facts,
        evidence:
          s.evidence.find((x) => x.evidenceId === p.latestEvidenceId) ?? null,
        recentEvents: s.events
          .filter((x) => x.agentIds.includes(agentId))
          .slice(-50),
      };
    }
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
      const q = input as C.Queries["getFrames"]["input"];
      ensure(q.toMs >= q.fromMs, "Invalid range");
      return page(
        s.frames.filter((f) => f.atMs >= q.fromMs && f.atMs <= q.toMs),
        q.cursor,
        { name, runId: q.runId, fromMs: q.fromMs, toMs: q.toMs },
        10,
      );
    }
  }
}
export function availableWork(
  store: Store,
  ctx: Context,
): { kind: C.WorkKind; count: number }[] {
  const roles = get<RoleRecord>(store, "role", ctx.identity)?.roles ?? [];
  const jobs = list<Job>(store, "work").filter(
    (j) =>
      (j.status === "pending" || j.status === "leased") &&
      (j.kind === "experiment"
        ? roles.includes("coordinator")
        : roles.includes("worker")),
  );
  const counts = new Map<C.WorkKind, number>();
  for (const j of jobs) counts.set(j.kind, (counts.get(j.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => ({ kind, count }));
}
