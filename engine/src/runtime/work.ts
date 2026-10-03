import { cloneJson } from "../domain/primitives.js";
import type * as C from "../../contract/behavior-v1.js";
import {
  DomainFault,
  ensure,
  hash,
  asciiCompare,
} from "../domain/primitives.js";
import { get, put, list, type Store } from "./store.js";
import { requireRole, type Context } from "./access.js";
export type Job = {
  id: string;
  kind: C.WorkKind;
  scope: C.Scope;
  payload: C.WorkPayloads[C.WorkKind];
  status: C.WorkStatus["status"];
  requester: string;
  lease: C.WorkLease | null;
  attempt: number;
  result: C.WorkResults[C.WorkKind] | null;
  error: C.DomainError | null;
  retryAt: number;
  createdAt: number;
  attemptOwners: string[];
};
export function enqueue(
  store: Store,
  ctx: Context,
  id: string,
  kind: C.WorkKind,
  scope: C.Scope,
  payload: Job["payload"],
): Job {
  const existing = findJob(store, id);
  if (existing) {
    ensure(
      hash(existing.payload) === hash(payload),
      "Work ID payload conflict",
    );
    return existing;
  }
  const job: Job = {
    id,
    kind,
    scope,
    payload,
    status: "pending",
    requester: ctx.identity,
    lease: null,
    attempt: 0,
    result: null,
    error: null,
    retryAt: 0,
    createdAt: ctx.now,
    attemptOwners: [],
  };
  saveJob(store, job);
  return job;
}
export function saveJob(store: Store, j: Job) {
  put(store, "work_locator", j.id, {
    scope: j.scope.runId ?? j.scope.experimentId ?? "",
  });
  put(
    store,
    "work",
    j.id,
    j,
    j.scope.runId ?? j.scope.experimentId ?? "",
    j.status,
    j.lease?.expiresAtEpochMs ?? j.retryAt,
  );
}
export function findJob(store: Store, id: string): Job | undefined {
  const locator = get<{ scope: string }>(store, "work_locator", id);
  return locator
    ? get<Job>(store, "work", id, locator.scope)
    : list<Job>(store, "work").find((x) => x.id === id);
}
export function leaseMs(ms: number) {
  ensure(
    Number.isSafeInteger(ms) && ms >= 1000 && ms <= 120000,
    "Lease duration out of bounds",
  );
}
export function claim(
  store: Store,
  ctx: Context,
  kinds: C.WorkKind[],
  limit: number,
  ms: number,
  workerNonce: string,
): C.LeasedWork[] {
  leaseMs(ms);
  ensure(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= 32,
    "Claim limit",
  );
  ensure(
    workerNonce.length >= 16 && workerNonce.length <= 256,
    "Worker nonce invalid",
  );
  const supported: C.WorkKind[] = [
    "decision",
    "rating",
    "population",
    "parse_crowd",
    "parse_scenario",
    "thought",
    "experiment",
    "report",
  ];
  ensure(
    kinds.length > 0 && kinds.every((k) => supported.includes(k)),
    "Unknown work kind",
  );
  if (kinds.includes("experiment")) requireRole(store, ctx, ["coordinator"]);
  if (kinds.some((k) => k !== "experiment"))
    requireRole(store, ctx, ["worker"]);
  const jobs = list<Job>(store, "work")
    .filter(
      (j) =>
        kinds.includes(j.kind) &&
        ((j.status === "pending" && j.retryAt <= ctx.now) ||
          (j.status === "leased" && j.lease!.expiresAtEpochMs <= ctx.now)),
    )
    .sort((a, b) => a.createdAt - b.createdAt || asciiCompare(a.id, b.id))
    .slice(0, limit);
  return jobs.map((j) => {
    j.attempt++;
    j.status = "leased";
    j.lease = {
      workId: j.id,
      attempt: j.attempt,
      leaseToken: hash([
        ctx.nonce(),
        workerNonce,
        ctx.identity,
        j.id,
        j.attempt,
      ]),
      expiresAtEpochMs: ctx.now + ms,
      ownerIdentity: ctx.identity,
    };
    j.attemptOwners.push(ctx.identity);
    saveJob(store, j);
    return {
      kind: j.kind,
      scope: j.scope,
      lease: j.lease,
      payload: j.payload,
    } as C.LeasedWork;
  });
}
export function validateLease(
  store: Store,
  ctx: Context,
  lease: C.WorkLease,
  allowReady = false,
): Job {
  const j = findJob(store, lease.workId);
  if (
    !j ||
    !j.lease ||
    j.lease.ownerIdentity !== ctx.identity ||
    lease.ownerIdentity !== ctx.identity ||
    j.lease.attempt !== lease.attempt ||
    j.lease.leaseToken !== lease.leaseToken ||
    j.lease.expiresAtEpochMs <= ctx.now ||
    (!allowReady && j.status !== "leased") ||
    (allowReady && !["leased", "ready", "applied"].includes(j.status))
  )
    throw new DomainFault("STALE_LEASE", "Work lease expired or replaced");
  return j;
}
export function renew(
  store: Store,
  ctx: Context,
  leases: C.WorkLease[],
  ms: number,
): C.WorkLease[] {
  leaseMs(ms);
  ensure(leases.length <= 32, "Renewal limit");
  return leases.map((l) => {
    const j = validateLease(store, ctx, l);
    j.lease!.expiresAtEpochMs = ctx.now + ms;
    saveJob(store, j);
    return j.lease!;
  });
}
export function finishJob(
  store: Store,
  ctx: Context,
  item: C.CompletedWork,
  validate: (j: Job) => void,
) {
  const j = validateLease(store, ctx, item.lease, true);
  ensure(j.kind === item.kind, "Work kind mismatch");
  if (j.status === "ready" || j.status === "applied") {
    ensure(hash(j.result) === hash(item.result), "Conflicting completion");
    return { workId: j.id, status: j.status };
  }
  validate(j);
  j.result = cloneJson(item.result);
  j.status = "ready";
  j.error = null;
  saveJob(store, j);
  return { workId: j.id, status: j.status };
}
export function providerAttempt(
  store: Store,
  ctx: Context,
  a: C.ProviderAttempt,
) {
  const j = findJob(store, a.workId);
  ensure(
    j && j.attemptOwners.includes(ctx.identity),
    "No historical work ownership",
  );
  ensure(
    a.billingOwnerRunId === null || a.billingOwnerRunId === j.scope.runId,
    "Billing scope mismatch",
  );
  ensure(
    a.phase === "started" || a.phase === "finished",
    "Invalid attempt phase",
  );
  ensure(a.provider === "jev" || a.provider === "prose", "Invalid provider");
  for (const n of [a.inputTokens, a.outputTokens])
    ensure(
      n === null || (Number.isSafeInteger(n) && n >= 0),
      "Invalid token usage",
    );
  ensure(
    a.estimatedCostUsd === null ||
      (Number.isFinite(a.estimatedCostUsd) && a.estimatedCostUsd >= 0),
    "Invalid provider cost",
  );
  ensure(
    Number.isSafeInteger(a.startedAtEpochMs) && a.startedAtEpochMs >= 0,
    "Invalid provider time",
  );
  const old = get<{ owner: string; attempt: C.ProviderAttempt }>(
    store,
    "attempt",
    a.callId,
  );
  if (old) {
    ensure(
      old.owner === ctx.identity &&
        old.attempt.workId === a.workId &&
        old.attempt.startedAtEpochMs === a.startedAtEpochMs,
      "Attempt ownership conflict",
    );
    if (old.attempt.phase === "finished") {
      if (a.phase === "finished")
        ensure(hash(old.attempt) === hash(a), "Conflicting usage");
      return { callId: a.callId, phase: "finished" as const };
    }
  } else ensure(a.phase === "started", "Attempt must start first");
  if (a.phase === "finished")
    ensure(
      a.durationMs !== null && a.durationMs >= 0 && a.outcome !== null,
      "Incomplete finished telemetry",
    );
  put(store, "attempt", a.callId, { owner: ctx.identity, attempt: a });
  return { callId: a.callId, phase: a.phase };
}
