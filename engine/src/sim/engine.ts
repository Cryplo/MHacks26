import { cloneJson } from "../domain/primitives.js";
import type * as C from "../../contract/behavior-v1.js";
import type { CoreState, GroupState } from "../domain/state.js";
import { MOMENT_PRIORITY } from "../domain/state.js";
import {
  ensure,
  hash,
  distribution,
  sample,
  random,
  asciiCompare,
  DomainFault,
} from "../domain/primitives.js";
import { Navigation } from "../navigation/grid.js";
import {
  event,
  groups,
  members,
  trigger,
  setActivity,
  releaseQueue,
} from "./common.js";
import {
  makeRequest,
  observe,
  observeEntrance,
  checkNeeds,
} from "./observations.js";
import { applyAction } from "./actions.js";
import {
  completeSession,
  dispatch,
  queueCheck,
  sortedPlaces,
} from "./services.js";
import { moveSubstep } from "./motion.js";
import { freezeRating, metrics, snapshot } from "../accounting/metrics.js";
import { physicalHash } from "../replay/physical.js";
export function acceptDecision(s: CoreState, result: C.DecisionResult) {
  const slot = s.decisions[result.requestId];
  ensure(slot, "Unknown request");
  ensure(
    !["cancelled", "completed", "failed"].includes(s.view.status),
    "Run no longer accepting behavior",
  );
  ensure(
    slot.status === "pending" || slot.status === "ready",
    "Request no longer open",
  );
  const r = slot.request;
  ensure(
    result.observationHash === r.observationHash &&
      result.optionsHash === r.optionsHash,
    "Request hash mismatch",
  );
  distribution(
    result.probabilities,
    r.options.map((o) => o.id),
  );
  if (
    s.manifest.config.mode === "experiment" &&
    s.manifest.config.versions.requestedModel !== "mock-policy-v1"
  )
    ensure(
      result.originalSource === "jev" &&
        (result.source === "jev" || result.source === "cache"),
      "Real experiment rejects mock/fallback",
    );
  if (slot.response) {
    ensure(hash(slot.response) === hash(result), "Conflicting response");
    return;
  }
  slot.response = cloneJson(result);
  slot.status = "ready";
}
function scenario(s: CoreState, e: C.ScenarioEvent) {
  const c = e.change;
  if (c.kind === "pass_price") {
    s.passPriceCents = c.unitPriceCents;
    s.passRevision++;
  } else if (c.kind === "app_message") {
    for (const p of Object.values(s.persons).sort((a, b) =>
      asciiCompare(a.agentId, b.agentId),
    )) {
      const trait = s.population.personas.find((x) => x.agentId === p.agentId)!;
      if (
        p.state === "not_arrived" ||
        p.state === "left" ||
        !trait.hasApp ||
        (trait.phoneActiveUntilMs !== null &&
          trait.phoneActiveUntilMs < s.view.simMs)
      )
        continue;
      if (
        observe(s, p, {
          kind: "message",
          placeId: c.suggestedPlaceId,
          source: "app",
          observedAtMs: s.view.simMs,
          contentVersion: `message:${c.messageId}`,
          text: c.text,
          waitLowerMs: null,
          waitUpperMs: null,
          priceCents: null,
        })
      )
        trigger(s.groups[p.groupId]!, "message_seen");
    }
  } else {
    const p = s.places[c.placeId]!;
    p.revision++;
    if (c.kind === "closure") {
      p.closed = c.closed;
      if (c.closed)
        for (const q of [...s.queues].filter((q) => q.placeId === c.placeId))
          releaseQueue(s, q.id, "closure");
    }
    if (c.kind === "board") {
      p.definition.board = c.display;
      p.boardVersion = `board:${p.revision}`;
    }
    if (c.kind === "notice") {
      p.definition.notice = c.notice;
      p.noticeVersion = `notice:${p.revision}`;
    }
    if (c.kind === "pass_share" && p.definition.service.kind === "ride")
      p.definition.service.passShareBps = c.shareBps;
    if (c.kind === "show_schedule" && p.definition.service.kind === "show")
      p.definition.service.startsAtMs = [...c.startsAtMs];
  }
  s.scenarioApplied.push(e.id);
  event(s, "scenario_applied", null, "placeId" in c ? c.placeId : null, {
    scenarioEventId: e.id,
    change: c,
  });
}
function depart(s: CoreState, g: GroupState, nav: Navigation) {
  for (const p of members(s, g)) {
    if (p.departedAtMs !== null) continue;
    freezeRating(s, p.agentId, "departure", nav);
    p.departedAtMs = s.view.simMs;
    p.state = "left";
    p.velocity = { xMps: 0, yMps: 0 };
    s.totals.departed++;
    if (
      g.manifest.plannedDepartureMs - s.view.simMs >=
      s.manifest.config.earlyDepartureThresholdMs
    ) {
      s.totals.earlyDepartures++;
      s.heat.push({
        atMs: s.view.simMs,
        fromMs: s.view.simMs,
        toMs: s.view.simMs,
        cell: nav.cell(p.position),
        layer: "early_departures",
        value: 1,
      });
    }
  }
  g.pendingMoment = null;
  g.target = null;
  event(s, "departed", g, s.persons[g.manifest.leaderId]!.targetPlaceId);
}
function prepare(s: CoreState, nav: Navigation) {
  for (const e of [...s.manifest.scenario.events].sort(
    (a, b) => a.atMs - b.atMs || a.order - b.order || asciiCompare(a.id, b.id),
  ))
    if (e.atMs === s.view.simMs && !s.scenarioApplied.includes(e.id))
      scenario(s, e);
  for (const session of [...s.sessions].sort(
    (a, b) => a.endMs - b.endMs || asciiCompare(a.id, b.id),
  ))
    if (session.endMs <= s.view.simMs) completeSession(s, session);
  if (!s.closing && s.view.simMs >= s.park.closeAfterMs) {
    s.closing = true;
    for (const q of [...s.queues]) releaseQueue(s, q.id, "closure");
  }
  for (const g of groups(s)) {
    const people = members(s, g),
      first = people[0]!;
    if (first.state === "not_arrived" && g.manifest.arrivalMs <= s.view.simMs) {
      for (const p of people) {
        p.state = "deciding";
        p.admittedAtMs = s.view.simMs;
        s.totals.admitted++;
      }
      trigger(g, "what_next");
      event(s, "arrived", g, null);
    }
    if (first.state === "not_arrived" || first.state === "left") continue;
    if (
      g.leaving &&
      g.target === null &&
      people.every((p) => p.state === "deciding")
    ) {
      depart(s, g, nav);
      continue;
    }
    if (g.activityUntilMs !== null && g.activityUntilMs <= s.view.simMs) {
      g.activityUntilMs = null;
      setActivity(s, g, "deciding");
      trigger(g, "what_next");
    }
    if (
      first.state === "deciding" &&
      g.pendingMoment === "join_line" &&
      first.targetPlaceId
    )
      observeEntrance(s, g, first.targetPlaceId);
    if (
      !s.sessions.some((x) => x.groupIds.includes(g.manifest.groupId)) &&
      !g.leaving &&
      (s.closing || s.view.simMs >= g.manifest.plannedDepartureMs)
    )
      trigger(g, "closing_soon");
    if (
      g.pendingMoment === "join_line" &&
      first.targetPlaceId &&
      s.places[first.targetPlaceId]!.closed
    )
      trigger(g, "forced_replan");
    checkNeeds(s, g);
    queueCheck(s, g);
    if (
      s.manifest.config.ratingEveryMs &&
      s.view.simMs > 0 &&
      s.view.simMs % s.manifest.config.ratingEveryMs === 0
    )
      for (const p of people) freezeRating(s, p.agentId, "periodic", nav);
  }
}
export function startCore(s: CoreState) {
  ensure(s.view.status === "ready", "Run not ready");
  s.view.status = "running";
  s.view.controlRevision++;
}
export function advanceCore(
  s: CoreState,
  nav: Navigation,
  maxWork = 100,
  maxCompletedSteps = Number.POSITIVE_INFINITY,
): { completedSteps: number; neighborChecks: number; work: number } {
  ensure(
    Number.isSafeInteger(maxWork) && maxWork > 0 && maxWork <= 10000,
    "Invalid work budget",
  );
  let completedSteps = 0,
    neighborChecks = 0,
    work = 0;
  if (!["running", "blocked", "draining"].includes(s.view.status))
    return { completedSteps, neighborChecks, work };
  while (work < maxWork) {
    work++;
    const v = s.view;
    if (v.phase === "prepare") {
      if (s.pauseRequested) {
        v.status = "paused";
        s.pauseRequested = false;
        break;
      }
      if (v.simMs >= s.manifest.config.horizonMs) {
        for (const p of Object.values(s.persons))
          if (p.admittedAtMs !== null && p.departedAtMs === null) {
            p.censored = true;
            freezeRating(s, p.agentId, "horizon", nav);
          }
        v.status = "completed";
        s.lastCompletedHash = physicalHash(s);
        s.metrics.push(metrics(s));
        break;
      }
      prepare(s, nav);
      v.phase = "requests";
      v.earliestSchedulableMs = v.simMs + 5000;
      s.phaseCursor = 0;
    } else if (v.phase === "requests") {
      const list = groups(s);
      const g = list[s.phaseCursor++];
      if (g) {
        if (
          g.pendingMoment &&
          g.nextDecisionAtMs <= v.simMs &&
          !g.requestId &&
          !members(s, g).some((p) =>
            [
              "not_arrived",
              "left",
              "riding",
              "watching",
              "eating",
              "shopping",
            ].includes(p.state),
          )
        ) {
          const r = makeRequest(s, g, nav);
          s.decisions[r.requestId] = {
            request: r,
            response: null,
            status: "pending",
          };
        }
      } else {
        s.barrierIds = Object.values(s.decisions)
          .filter((d) => d.status === "pending" || d.status === "ready")
          .map((d) => d.request.requestId)
          .sort((a, b) => {
            const x = s.decisions[a]!.request,
              y = s.decisions[b]!.request;
            return (
              MOMENT_PRIORITY[x.moment] - MOMENT_PRIORITY[y.moment] ||
              asciiCompare(x.groupId, y.groupId) ||
              x.decisionSeq - y.decisionSeq
            );
          });
        v.phase = "barrier";
      }
    } else if (v.phase === "barrier") {
      v.blockedWorkIds = s.barrierIds.filter(
        (id) => s.decisions[id]!.status === "pending",
      );
      if (v.blockedWorkIds.length) {
        v.status = "blocked";
        break;
      }
      v.status = "running";
      v.phase = "apply";
      s.phaseCursor = 0;
    } else if (v.phase === "apply") {
      const id = s.barrierIds[s.phaseCursor++];
      if (id) {
        const slot = s.decisions[id]!,
          r = slot.request,
          response = slot.response!,
          g = s.groups[r.groupId]!;
        const probabilities = distribution(
            response.probabilities,
            r.options.map((o) => o.id),
          ),
          draw = random(
            s.manifest.replicateSeed,
            "behavior",
            r.groupId,
            r.moment,
            r.momentSeq,
          ),
          chosenOptionId = sample(probabilities, draw),
          action = r.options.find((o) => o.id === chosenOptionId)!.action;
        const before = s.events.length,
          evidenceId = `evidence:${r.groupId}:${r.decisionSeq}`;
        let outcome: C.AppliedDecision["outcome"] = "committed",
          failureReason: string | null = null;
        try {
          ensure(g.planRevision === r.planRevision, "Stale plan");
          applyAction(s, g, action, nav, evidenceId);
        } catch (error) {
          if (!(error instanceof DomainFault)) throw error;
          outcome = "failed_precondition";
          failureReason = error.message;
          event(s, "action_failed", g, null, null, {
            reason: error.message,
            causationId: evidenceId,
          });
          trigger(g, "forced_replan");
          g.nextDecisionAtMs = v.simMs + 5000;
        }
        slot.status = "applied";
        g.requestId = null;
        s.view.quality.behaviorCounts[response.source]++;
        if (response.source === "fallback") {
          s.view.quality.comparisonEligible = false;
          s.view.quality.reasons.push("live fallback");
        }
        const evidence: C.AppliedDecision = {
          evidenceId,
          request: r,
          response,
          appliedProbabilities: probabilities,
          draw,
          chosenOptionId,
          outcome,
          failureReason,
          committedAtMs: v.simMs,
          causedEventIds: s.events.slice(before).map((e) => e.eventId),
        };
        s.evidence.push(evidence);
        for (const p of members(s, g)) p.latestEvidenceId = evidenceId;
      } else {
        v.phase = "dispatch";
        s.phaseCursor = 0;
      }
    } else if (v.phase === "dispatch") {
      const place = sortedPlaces(s)[s.phaseCursor++];
      if (place) dispatch(s, place);
      else {
        v.phase = "integrate";
        s.movementSubstep = 0;
      }
    } else if (v.phase === "integrate") {
      if (s.movementSubstep < 20) {
        neighborChecks += moveSubstep(s, nav).neighborChecks;
        s.movementSubstep++;
      } else v.phase = "persist";
    } else {
      v.simMs += 5000;
      v.stepIndex++;
      v.revision++;
      v.phase = "prepare";
      v.earliestSchedulableMs = v.simMs;
      s.phaseCursor = 0;
      s.barrierIds = [];
      v.blockedWorkIds = [];
      s.lastCompletedHash = physicalHash(s);
      s.boundaries.push({ atMs: v.simMs, hash: s.lastCompletedHash });
      completedSteps++;
      if (v.simMs % s.manifest.config.visualFrameEveryMs === 0) {
        s.metrics.push(metrics(s));
        s.frames.push({
          atMs: v.simMs,
          frameSchema: "frame-v1",
          snapshot: snapshot(s),
        });
      }
      if (s.pauseRequested) {
        v.status = "paused";
        s.pauseRequested = false;
        break;
      }
      if (completedSteps >= maxCompletedSteps) break;
    }
  }
  return { completedSteps, neighborChecks, work };
}
