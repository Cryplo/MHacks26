import type { Job } from "./work.js";
import { initializeParks } from "./navigation.js";
import type { CoreState } from "../domain/state.js";
import type { Context, Grant } from "./access.js";
import type { Store } from "./store.js";
import { get, put } from "./store.js";
import { command } from "./runtime.js";
import type { DriverRecord } from "./driver.js";
const STEP_MS = 5000;
/** Upper bound on steps one scheduler tick may complete (bounds a single reducer's work). */
export const MAX_STEPS_PER_TICK = 8;
type Pacing = {
  wallMs: number;
  credit: number;
  speed: number;
  lastSimMs?: number;
};
export function scheduleLive(store: Store, ctx: Context): void {
  initializeParks(store);
  // This entry is called only by the module's authenticated scheduled reducer.
  // A coordinator-owned run is never eligible for scheduler ownership.
  // The run row's status column mirrors view.status: parse only active runs' metadata.
  const active = store
    .list("run")
    .filter((r) => ["running", "blocked", "draining"].includes(r.status))
    .map((r) => JSON.parse(r.body) as CoreState)
    .filter((s) => !s.manifest.experiment);
  const cursor =
    get<{ offset: number }>(store, "rate", "scheduler-cursor")?.offset ?? 0;
  const selected = Array.from(
    { length: Math.min(4, active.length) },
    (_, i) => active[(cursor + i) % active.length]!,
  );
  put(store, "rate", "scheduler-cursor", {
    offset: active.length ? (cursor + selected.length) % active.length : 0,
  });
  for (const s of selected) {
    const d = get<DriverRecord>(store, "driver", s.runId);
    if (
      d &&
      !d.released &&
      d.lease.expiresAtEpochMs > ctx.now &&
      d.owner !== ctx.identity
    )
      continue;
    if (s.view.status === "blocked") {
      const unresolved = s.view.blockedWorkIds
        .map((id) => get<Job>(store, "work", `${s.runId}:${id}`, s.runId))
        .filter((j) => j && !["ready", "applied"].includes(j.status));
      const dueFallback =
        s.manifest.config.mode === "live" &&
        s.manifest.config.fallback === "live_timeout_v1" &&
        unresolved.some(
          (j) => ctx.now - j!.createdAt >= s.manifest.config.liveTimeoutMs,
        );
      if (unresolved.length && !dueFallback) continue;
    }
    const grantId = `scheduler:${s.runId}`;
    if (!get(store, "grant", grantId, s.runId))
      put(
        store,
        "grant",
        grantId,
        {
          id: grantId,
          identity: ctx.identity,
          runId: s.runId,
          role: "operator",
          expiresAt: null,
          shareId: null,
          delegable: false,
        } satisfies Grant,
        s.runId,
      );
    let lease: DriverRecord["lease"];
    const internal = { recordReceipt: false };
    if (!d || d.released || d.lease.expiresAtEpochMs <= ctx.now) {
      const r = command(
        store,
        ctx,
        "acquireDriver",
        { runId: s.runId, leaseMs: 3000 },
        `scheduler:${s.runId}:${ctx.now}:acquire`,
        internal,
      );
      if (!r.ok) continue;
      lease = r.result;
    } else if (d.lease.expiresAtEpochMs - ctx.now < 1500) {
      const r = command(
        store,
        ctx,
        "renewDriver",
        { lease: d.lease, leaseMs: 3000 },
        `scheduler:${s.runId}:${ctx.now}:renew`,
        internal,
      );
      if (!r.ok) continue;
      lease = r.result;
    } else lease = d.lease;
    if (!lease) continue;
    // Pacing: simulated-time credit accrues at the requested speed (wall time per tick is
    // capped so a stall never turns into a burst); each tick completes whole 5 s steps.
    const old = get<Pacing>(store, "rate", `pacing:${s.runId}`) ?? {
      wallMs: ctx.now,
      credit: 0,
      speed: 0,
    };
    const elapsed = Math.max(0, Math.min(1000, ctx.now - old.wallMs)),
      credit = Math.min(
        Math.max(STEP_MS, s.view.requestedSpeed * 1000),
        old.credit + elapsed * s.view.requestedSpeed,
      );
    let consumed = 0;
    if (credit >= STEP_MS || s.view.phase !== "prepare") {
      const r = command(
        store,
        { ...ctx, achievedSpeed: Math.round(10 * old.speed) / 10 },
        "advanceRun",
        {
          lease,
          expectedStep: s.view.stepIndex,
          expectedPhase: s.view.phase,
          maxSteps: Math.max(
            1,
            Math.min(MAX_STEPS_PER_TICK, Math.floor(credit / STEP_MS)),
          ),
        },
        `scheduler:${s.runId}:${ctx.now}:advance`,
        internal,
      );
      if (r.ok) consumed = r.result.completedSteps * STEP_MS;
    }
    // Achieved speed: exponential moving average of simulated ms per wall ms.
    const measured =
      old.lastSimMs === undefined || ctx.now <= old.wallMs
        ? old.speed
        : (s.view.simMs + consumed - old.lastSimMs) / (ctx.now - old.wallMs);
    put(store, "rate", `pacing:${s.runId}`, {
      wallMs: ctx.now,
      credit: Math.max(0, credit - consumed),
      speed: Math.round(100 * (0.7 * old.speed + 0.3 * measured)) / 100,
      lastSimMs: s.view.simMs + consumed,
    } satisfies Pacing);
  }
}
