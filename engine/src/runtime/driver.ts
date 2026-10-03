import type { DriverLease, BoundaryPhase } from "../../contract/behavior-v1.js";
import { DomainFault, ensure, hash } from "../domain/primitives.js";
import { get, put, type Store } from "./store.js";
import { requireRun, type Context } from "./access.js";
import { leaseMs } from "./work.js";
export type DriverRecord = {
  owner: string;
  lease: DriverLease;
  released: boolean;
};
export function acquire(
  store: Store,
  ctx: Context,
  runId: string,
  ms: number,
): DriverLease {
  requireRun(store, ctx, runId, true);
  leaseMs(ms);
  const old = get<DriverRecord>(store, "driver", runId);
  if (old && !old.released && old.lease.expiresAtEpochMs > ctx.now)
    throw new DomainFault("CONFLICT", "Run already has a driver");
  const lease = {
    runId,
    epoch: (old?.lease.epoch ?? 0) + 1,
    token: hash([ctx.nonce(), ctx.identity, runId]),
    expiresAtEpochMs: ctx.now + ms,
  };
  put(store, "driver", runId, {
    owner: ctx.identity,
    lease,
    released: false,
  } satisfies DriverRecord);
  return lease;
}
export function validateDriver(
  store: Store,
  ctx: Context,
  lease: DriverLease,
): DriverRecord {
  requireRun(store, ctx, lease.runId, true);
  const d = get<DriverRecord>(store, "driver", lease.runId);
  if (
    !d ||
    d.owner !== ctx.identity ||
    d.released ||
    d.lease.epoch !== lease.epoch ||
    d.lease.token !== lease.token ||
    d.lease.expiresAtEpochMs <= ctx.now
  )
    throw new DomainFault("STALE_LEASE", "Driver fence rejected");
  return d;
}
export function expectedBoundary(
  actual: { stepIndex: number; phase: BoundaryPhase },
  step: number,
  phase: BoundaryPhase,
) {
  ensure(
    actual.stepIndex === step && actual.phase === phase,
    "Expected boundary does not match",
  );
}
