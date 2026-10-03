import type { Health, ProviderAttempt } from "../../contract/behavior-v1.js";
import type { Store } from "./store.js";
import { list } from "./store.js";
import type { Job } from "./work.js";
export function health(store: Store, runId: string, now: number): Health {
  const jobs = list<Job>(store, "work", runId),
    pending = jobs.filter((j) => ["pending", "leased"].includes(j.status));
  const attempts = list<{ attempt: ProviderAttempt }>(store, "attempt")
    .map((x) => x.attempt)
    .filter((a) => a.billingOwnerRunId === runId);
  const finished = attempts.filter((a) => a.phase === "finished"),
    durations = finished
      .filter((a) => a.durationMs !== null)
      .map((a) => a.durationMs!)
      .sort((a, b) => a - b);
  const knownTokens = finished.filter(
      (a) => a.inputTokens !== null && a.outputTokens !== null,
    ),
    knownCost = finished.filter((a) => a.estimatedCostUsd !== null);
  return {
    queuedWork: pending.filter((j) => j.status === "pending").length,
    leasedWork: pending.filter((j) => j.status === "leased").length,
    oldestRequestAgeMs: pending.length
      ? Math.max(...pending.map((j) => Math.max(0, now - j.createdAt)))
      : 0,
    httpP95Ms: durations.length
      ? durations[
          Math.min(durations.length - 1, Math.floor(durations.length * 0.95))
        ]!
      : null,
    reducerP95Ms: null,
    calls: attempts.length,
    inputTokens: knownTokens.reduce((n, a) => n + a.inputTokens!, 0),
    estimatedCostUsd:
      knownCost.length === attempts.length && attempts.length > 0
        ? knownCost.reduce((n, a) => n + a.estimatedCostUsd!, 0)
        : null,
    tokenCoverage: attempts.length ? knownTokens.length / attempts.length : 0,
    warnings: [
      ...(knownTokens.length < attempts.length
        ? ["Provider usage incomplete"]
        : []),
      "Reducer latency requires external benchmark",
    ],
  };
}
