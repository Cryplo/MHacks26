import { cloneJson } from "../domain/primitives.js";
import type * as C from "../../contract/behavior-v1.js";
import type { CoreState } from "../domain/state.js";
import { asciiCompare, ensure, hash } from "../domain/primitives.js";
import { board, predictedWait, observation } from "../sim/observations.js";
import { Navigation } from "../navigation/grid.js";
export function metrics(s: CoreState): C.MetricSnapshot {
  const t = s.totals,
    revenue = s.sales.reduce((n, x) => n + x.amountCents - x.refundCents, 0),
    people = Object.values(s.persons).filter((p) => p.admittedAtMs !== null);
  const terminal = people.flatMap((p) =>
    p.terminalRatingId && s.ratings[p.terminalRatingId]?.result
      ? [s.ratings[p.terminalRatingId]!]
      : [],
  );
  const ratingSum = terminal.reduce(
    (n, r) => n + (100 * r.result!.scoreIndex) / (r.request.levels.length - 1),
    0,
  );
  const value = (
    id: C.MetricId,
    unit: C.MetricValue["unit"],
    numerator: number,
    denominator: number | null,
    n: number,
    coverage = 1,
    complete = true,
  ): C.MetricValue => ({
    id,
    unit,
    numerator,
    denominator,
    n,
    coverage,
    complete,
    value:
      denominator === null
        ? numerator
        : denominator > 0
          ? numerator / denominator
          : null,
    missingReason: denominator === 0 ? "No eligible denominator" : null,
  });
  const m: C.MetricSnapshot = {
    runId: s.runId,
    simMs: s.view.simMs,
    revision: s.view.revision,
    definitionVersion: s.manifest.config.versions.metrics,
    admittedGuests: t.admitted,
    guestsInPark: t.admitted - t.departed,
    measures: {
      net_revenue_cents: value(
        "net_revenue_cents",
        "cents",
        revenue,
        null,
        s.sales.length,
      ),
      revenue_per_guest_cents: value(
        "revenue_per_guest_cents",
        "cents",
        revenue,
        t.admitted,
        t.admitted,
      ),
      satisfaction_0_100: value(
        "satisfaction_0_100",
        "score",
        ratingSum,
        terminal.length,
        terminal.length,
        t.admitted ? terminal.length / t.admitted : 0,
        terminal.length === t.admitted,
      ),
      queue_minutes_per_guest: value(
        "queue_minutes_per_guest",
        "minutes",
        t.queuePersonMs / 60000,
        t.admitted,
        t.admitted,
      ),
      completed_ride_wait_minutes: value(
        "completed_ride_wait_minutes",
        "minutes",
        t.completedRideWaitMs / 60000,
        t.completedRiders,
        t.completedRiders,
      ),
      rides_per_guest: value(
        "rides_per_guest",
        "ratio",
        t.completedRiders,
        t.admitted,
        t.admitted,
      ),
      abandonment_rate: value(
        "abandonment_rate",
        "ratio",
        t.abandonedEpisodes,
        t.joinedEpisodes,
        t.joinedEpisodes,
      ),
      queue_time_share: value(
        "queue_time_share",
        "ratio",
        t.queuePersonMs,
        t.parkPersonMs,
        t.admitted,
      ),
      early_departures: value(
        "early_departures",
        "guests",
        t.earlyDepartures,
        null,
        t.admitted,
      ),
      ride_seat_utilization: value(
        "ride_seat_utilization",
        "ratio",
        t.usedSeats,
        t.dispatchedSeats,
        t.dispatchedSeats,
      ),
      server_utilization: value(
        "server_utilization",
        "ratio",
        t.busyServerMs,
        t.availableServerMs,
        Object.values(s.places).filter(
          (p) => p.definition.service.kind === "counter",
        ).length,
      ),
    },
  };
  return m;
}
export function snapshot(s: CoreState): C.LiveSnapshot {
  const agents = Object.values(s.persons)
    .sort((a, b) => asciiCompare(a.agentId, b.agentId))
    .map((p) => ({
      agentId: p.agentId,
      groupId: p.groupId,
      position: p.position,
      velocity: p.velocity,
      state: p.state,
      targetPlaceId: p.targetPlaceId,
      needs: p.needs,
      experienceValue: p.experienceValue,
      rating: p.rating,
      latestEvidenceId: p.latestEvidenceId,
    }));
  const places = Object.values(s.places)
    .sort((a, b) => asciiCompare(a.definition.id, b.definition.id))
    .map((p) => ({
      placeId: p.definition.id,
      closed: p.closed,
      boardText: board(s, p.definition.id)?.text ?? null,
      boardVersion: p.boardVersion,
      noticeVersion: p.noticeVersion,
      predictedWaitMs: predictedWait(s, p.definition.id),
    }));
  const queues = places.map((p) => {
    const entries = s.queues
      .filter((q) => q.placeId === p.placeId)
      .sort((a, b) => a.sequence - b.sequence);
    return {
      placeId: p.placeId,
      standardPersons: entries
        .filter((q) => q.lane === "standard")
        .reduce((n, q) => n + q.agentIds.length, 0),
      passPersons: entries
        .filter((q) => q.lane === "pass")
        .reduce((n, q) => n + q.agentIds.length, 0),
      entries: entries.map((q) => ({
        entryId: q.id,
        agentIds: q.agentIds,
        lane: q.lane,
        sequence: q.sequence,
        joinedAtMs: q.joinedAtMs,
        positions: q.agentIds.map((id) => ({
          agentId: id,
          position: s.persons[id]!.position,
        })),
      })),
    };
  });
  return cloneJson({
    contractVersion: "behavior.v1",
    run: s.view,
    agents,
    places,
    queues,
    metrics: metrics(s),
    health: {
      queuedWork: Object.values(s.decisions).filter(
        (x) => x.status === "pending",
      ).length,
      leasedWork: 0,
      oldestRequestAgeMs: 0,
      httpP95Ms: null,
      reducerP95Ms: null,
      calls: 0,
      inputTokens: 0,
      estimatedCostUsd: null,
      tokenCoverage: 0,
      warnings: ["Provider and reducer telemetry populated by runtime"],
    },
    recentEvents: s.events.slice(-50),
  });
}
export function freezeRating(
  s: CoreState,
  agentId: string,
  endpoint: C.RatingRequest["endpoint"],
  nav: Navigation,
) {
  const p = s.persons[agentId]!;
  if (endpoint !== "periodic" && p.terminalRatingId) return;
  const ratingId = `rating:${agentId}:${endpoint}:${s.view.simMs}`;
  if (s.ratings[ratingId]) return;
  const obs = observation(s, s.groups[p.groupId]!, nav),
    request: C.RatingRequest = {
      ratingId,
      runId: s.runId,
      agentId,
      atMs: s.view.simMs,
      endpoint,
      evidenceHash: hash({
        agentId,
        endpoint,
        atMs: s.view.simMs,
        observation: obs,
      }),
      observation: obs,
      rubricVersion: s.manifest.config.versions.rubric,
      levels: ratingLevels(s.manifest.config.versions.rubric),
    };
  s.ratings[ratingId] = { request, result: null };
  s.view.quality.pendingRatings++;
  if (endpoint !== "periodic") {
    p.terminalRatingId = ratingId;
    s.view.quality.terminalRatingsExpected++;
  }
}
/**
 * Rating level labels for the declared rubric version. The rubric is owned by Intelligence,
 * which validates labels exactly; metrics only use the level count (100 * index / (K - 1)).
 */
const RUBRIC_LEVELS: Record<string, string[]> = {
  "satisfaction-rubric-v1": ["very dissatisfied", "dissatisfied", "neutral", "satisfied", "very satisfied"],
};
export function ratingLevels(rubric: string): string[] {
  return RUBRIC_LEVELS[rubric] ?? ["Very poor", "Poor", "Neutral", "Good", "Excellent"];
}
export function acceptRating(s: CoreState, result: C.RatingResult) {
  const rating = s.ratings[result.ratingId];
  ensure(rating, "Unknown rating");
  const n = rating.request.levels.length;
  ensure(
    result.evidenceHash === rating.request.evidenceHash &&
      result.rubricVersion === rating.request.rubricVersion,
    "Rating evidence mismatch",
  );
  ensure(
    Number.isFinite(result.scoreIndex) &&
      result.scoreIndex >= 0 &&
      result.scoreIndex <= n - 1,
    "Rating score out of range",
  );
  ensure(
    result.probabilities.length === n &&
      result.probabilities.every((p) => Number.isFinite(p) && p >= 0) &&
      Math.abs(result.probabilities.reduce((a, b) => a + b, 0) - 1) <= 1e-6,
    "Invalid rating distribution",
  );
  if (rating.result) {
    ensure(hash(rating.result) === hash(result), "Conflicting rating");
    return;
  }
  rating.result = cloneJson(result);
  s.view.quality.pendingRatings--;
  if (rating.request.endpoint !== "periodic")
    s.view.quality.terminalRatingsComplete++;
  const person = s.persons[rating.request.agentId]!;
  if (!person.rating || rating.request.atMs >= person.rating.atMs)
    person.rating = {
      value: (100 * result.scoreIndex) / (n - 1),
      atMs: rating.request.atMs,
      source: result.source,
    };
}
export function heatmap(
  s: CoreState,
  layer: C.HeatLayer,
  fromMs: number,
  toMs: number,
): C.Heatmap {
  ensure(
    fromMs >= 0 && toMs >= fromMs && toMs <= s.view.simMs,
    "Invalid heat range",
  );
  const values = Array<number>(s.park.grid.width * s.park.grid.height).fill(0);
  for (const c of s.heat) {
    if (c.layer !== layer) continue;
    const duration = c.toMs - c.fromMs;
    const amount = duration
      ? (c.value *
          Math.max(0, Math.min(toMs, c.toMs) - Math.max(fromMs, c.fromMs))) /
        duration
      : c.atMs >= fromMs && c.atMs <= toMs
        ? c.value
        : 0;
    values[c.cell] = (values[c.cell] ?? 0) + amount;
  }
  return {
    runId: s.runId,
    layer,
    fromMs,
    toMs,
    cellM: s.park.grid.cellM,
    width: s.park.grid.width,
    height: s.park.grid.height,
    values,
    total: values.reduce((a, b) => a + b, 0),
    unit:
      layer === "waiting_person_minutes"
        ? "person-minutes"
        : layer === "spending_cents"
          ? "cents"
          : layer === "negative_experience"
            ? "signed modeled points"
            : "episodes",
    denominator: "sum of ledger contributions",
    complete: true,
  };
}
