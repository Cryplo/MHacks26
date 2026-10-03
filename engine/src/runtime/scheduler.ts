import type { CoreState } from "../domain/state.js";
import type { Context, Grant } from "./access.js";
import type { Store } from "./store.js";
import { list, get, put } from "./store.js";
import { command } from "./runtime.js";
import type { DriverRecord } from "./driver.js";
export function scheduleLive(store: Store, ctx: Context): void {
  // This entry is called only by the module's authenticated scheduled reducer.
  // A coordinator-owned run is never eligible for scheduler ownership.
  const active = list<CoreState>(store, "run").filter(
    (s) =>
      !s.manifest.experiment &&
      ["running", "blocked", "draining"].includes(s.view.status),
  );
  for (const s of active.slice(0, 4)) {
    const d = get<DriverRecord>(store, "driver", s.runId);
    if (
      d &&
      !d.released &&
      d.lease.expiresAtEpochMs > ctx.now &&
      d.owner !== ctx.identity
    )
      continue;
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
    if (!d || d.released || d.lease.expiresAtEpochMs <= ctx.now) {
      const r = command(
        store,
        ctx,
        "acquireDriver",
        { runId: s.runId, leaseMs: 1000 },
        `scheduler:${s.runId}:${ctx.now}:acquire`,
      );
      if (!r.ok) continue;
      lease = r.result;
    } else {
      const r = command(
        store,
        ctx,
        "renewDriver",
        { lease: d.lease, leaseMs: 1000 },
        `scheduler:${s.runId}:${ctx.now}:renew`,
      );
      if (!r.ok) continue;
      lease = r.result;
    }
    if (!lease) continue;
    const old = get<{ wallMs: number; credit: number }>(
      store,
      "rate",
      `pacing:${s.runId}`,
    ) ?? { wallMs: ctx.now, credit: 0 };
    const elapsed = Math.max(0, Math.min(1000, ctx.now - old.wallMs)),
      credit = Math.min(20000, old.credit + elapsed * s.view.requestedSpeed);
    let consumed = 0;
    if (credit >= 5000 || s.view.phase !== "prepare") {
      const r = command(
        store,
        ctx,
        "advanceRun",
        {
          lease,
          expectedStep: s.view.stepIndex,
          expectedPhase: s.view.phase,
          maxSteps: Math.max(1, Math.min(4, Math.floor(credit / 5000))),
        },
        `scheduler:${s.runId}:${ctx.now}:advance`,
      );
      if (r.ok) consumed = r.result.completedSteps * 5000;
    }
    put(store, "rate", `pacing:${s.runId}`, {
      wallMs: ctx.now,
      credit: Math.max(0, credit - consumed),
    });
  }
}
