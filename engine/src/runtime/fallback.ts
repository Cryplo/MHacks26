import type { CoreState } from "../domain/state.js";
import { ensure } from "../domain/primitives.js";
import { acceptDecision } from "../sim/engine.js";
import type { Store } from "./store.js";
import type { Context } from "./access.js";
import { findJob, saveJob } from "./work.js";
import { writeJSON } from "./artifacts.js";
// Explicit operational policy, enabled only by live_timeout_v1. This is never
// represented as a learned probability distribution or permitted in experiments.
export function resolveLiveTimeouts(store: Store, ctx: Context, s: CoreState) {
  if (
    (s.manifest.config.mode !== "live" && s.manifest.config.mode !== "local") ||
    s.manifest.config.fallback !== "live_timeout_v1"
  )
    return;
  for (const id of s.barrierIds) {
    const slot = s.decisions[id]!;
    if (slot.status !== "pending") continue;
    const job = findJob(store, `${s.runId}:${id}`);
    if (!job || ctx.now - job.createdAt < s.manifest.config.liveTimeoutMs)
      continue;
    const r = slot.request,
      choice =
        r.options.find((o) => o.action.kind === "continue") ??
        r.options.find((o) => o.action.kind === "leave_park");
    ensure(choice, "No safe live timeout option");
    const probabilities = r.options.map((o) => ({
      optionId: o.id,
      probability: o.id === choice.id ? 1 : 0,
    }));
    const responseArtifact = writeJSON(
      store,
      ctx,
      "model_response",
      job.scope,
      {
        policy: "live_timeout_v1",
        reason: "Wall-clock work deadline elapsed",
        probabilities,
      },
    );
    const result = {
      requestId: r.requestId,
      observationHash: r.observationHash,
      optionsHash: r.optionsHash,
      modelRequested: s.manifest.config.versions.requestedModel,
      modelReturned: "live_timeout_v1",
      source: "fallback" as const,
      probabilities,
      confidence: null,
      responseArtifact,
      usage: {
        callId: null,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        priceVersion: null,
        queueMs: ctx.now - job.createdAt,
        httpMs: 0,
        attemptCount: job.attempt,
      },
      cacheKey: null,
      originalSource: "fallback" as const,
    };
    acceptDecision(s, result);
    job.result = result;
    job.status = "ready";
    job.lease = null;
    saveJob(store, job);
  }
}
