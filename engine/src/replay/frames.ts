/**
 * Compact replay frames for time scrubbing.
 *
 * A frame stores every guest as a short integer tuple (positions/velocities in cm, meters in
 * tenths) instead of a full AgentView, which is ~5x smaller; `getFrames` expands it back into a
 * contract `ReplayFrame` (`frameSchema: "frame-v2"`). Guests who have not arrived or have left
 * are stored as a state code only and expanded at the park entrance / exit with their initial
 * needs. Queue positions are the guests' own positions. Frames are persisted one row per frame
 * keyed by time (see runtime/store.ts) and are not part of the hot run state.
 */
import type * as C from "../../contract/behavior-v1.js";
import type { CoreState } from "../domain/state.js";
import { personsInOrder } from "../sim/common.js";
import { metrics } from "../accounting/metrics.js";
import { board, predictedWait } from "../sim/observations.js";
import { asciiCompare } from "../domain/primitives.js";

/** Target total stored frame bytes per run (bounds memory for long, large runs). */
export const FRAME_BUDGET_BYTES = 64 * 1024 * 1024;
const BYTES_PER_GUEST = 75;
/** Densest frame interval used for scrubbing. */
export const MIN_FRAME_MS = 15000;

const STATES: C.AgentView["state"][] = [
  "not_arrived",
  "walking",
  "browsing",
  "queueing",
  "riding",
  "eating",
  "shopping",
  "resting",
  "watching",
  "deciding",
  "left",
];
const SOURCES: C.Source[] = ["jev", "cache", "mock", "fallback", "laya"];

/** [stateCode] for absent guests, else
 * [state, x, y, vx, vy, target+1, hunger, fatigue, patience, fun, experience, evidenceSeq,
 *  ratingValue*10 | -1, ratingAtMs, ratingSource] */
export type CompactAgent = number[];
export type CompactFrame = {
  atMs: number;
  frameSchema: "frame-v2-compact";
  run: C.RunView;
  agents: CompactAgent[];
  places: C.PlaceView[];
  queues: (Omit<C.QueueView, "entries"> & {
    entries: Omit<C.QueueView["entries"][number], "positions">[];
  })[];
  metrics: C.MetricSnapshot;
};

/**
 * Effective frame interval: MIN_FRAME_MS (or the configured interval when it is denser),
 * stretched in 5 s steps only when the run's horizon and crowd would exceed FRAME_BUDGET_BYTES.
 * 1000 guests: 15 s up to a ~3.5 h horizon, 30 s for 8 h.
 */
export function frameEveryMs(s: CoreState): number {
  const guests = s.population.personas.length,
    frameBytes = guests * BYTES_PER_GUEST + 6000,
    frames = Math.max(1, Math.floor(FRAME_BUDGET_BYTES / frameBytes)),
    budget = Math.ceil(s.manifest.config.horizonMs / frames / 5000) * 5000;
  return Math.max(
    Math.min(s.manifest.config.visualFrameEveryMs, MIN_FRAME_MS),
    budget,
    5000,
  );
}

const cm = (v: number) => Math.round(v * 100);
const tenth = (v: number) => Math.round(v * 10);

export function encodeFrame(s: CoreState): CompactFrame {
  const placeIndex = new Map(s.park.places.map((p, i) => [p.id, i]));
  const agents = personsInOrder(s).map((p): CompactAgent => {
    const st = STATES.indexOf(p.state);
    if (p.state === "not_arrived" || p.state === "left") return [st];
    const seq = p.latestEvidenceId
      ? Number(
          p.latestEvidenceId.slice(p.latestEvidenceId.lastIndexOf(":") + 1),
        )
      : 0;
    return [
      st,
      cm(p.position.xM),
      cm(p.position.yM),
      cm(p.velocity.xMps),
      cm(p.velocity.yMps),
      p.targetPlaceId ? placeIndex.get(p.targetPlaceId)! + 1 : 0,
      tenth(p.needs.hunger),
      tenth(p.needs.fatigue),
      tenth(p.needs.patience),
      tenth(p.needs.fun),
      tenth(p.experienceValue),
      seq,
      p.rating ? tenth(p.rating.value) : -1,
      p.rating?.atMs ?? 0,
      p.rating ? SOURCES.indexOf(p.rating.source) : 0,
    ];
  });
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
    const count = (lane: "standard" | "pass") =>
      entries
        .filter((q) => q.lane === lane)
        .reduce((n, q) => n + q.agentIds.length, 0);
    return {
      placeId: p.placeId,
      standardPersons: count("standard"),
      passPersons: count("pass"),
      entries: entries.map((q) => ({
        entryId: q.id,
        agentIds: [...q.agentIds],
        lane: q.lane,
        sequence: q.sequence,
        joinedAtMs: q.joinedAtMs,
      })),
    };
  });
  return {
    atMs: s.view.simMs,
    frameSchema: "frame-v2-compact",
    run: JSON.parse(JSON.stringify(s.view)) as C.RunView,
    agents,
    places,
    queues,
    metrics: metrics(s),
  };
}

const EMPTY_HEALTH: C.Health = {
  queuedWork: 0,
  leasedWork: 0,
  oldestRequestAgeMs: 0,
  httpP95Ms: null,
  reducerP95Ms: null,
  calls: 0,
  inputTokens: 0,
  estimatedCostUsd: null,
  tokenCoverage: 0,
  warnings: ["Replay frame: live telemetry is not recorded"],
};

export function decodeFrame(
  f: CompactFrame | C.ReplayFrame,
  s: Pick<CoreState, "park" | "population">,
): C.ReplayFrame {
  if (f.frameSchema !== "frame-v2-compact") return f as C.ReplayFrame;
  const cf = f as CompactFrame;
  const personas = [...s.population.personas].sort((a, b) =>
    asciiCompare(a.agentId, b.agentId),
  );
  const entrance = s.park.places.find((p) => p.kind === "entrance")!.entrance,
    exit = (s.park.places.find((p) => p.kind === "exit") ?? s.park.places[0]!)
      .entrance;
  const agents: C.AgentView[] = cf.agents.map((a, i) => {
    const persona = personas[i]!,
      state = STATES[a[0]!]!;
    if (a.length === 1)
      return {
        agentId: persona.agentId,
        groupId: persona.groupId,
        position: { ...(state === "left" ? exit : entrance) },
        velocity: { xMps: 0, yMps: 0 },
        state,
        targetPlaceId: null,
        needs: { ...persona.initialNeeds },
        experienceValue: 50,
        rating: null,
        latestEvidenceId: null,
      };
    return {
      agentId: persona.agentId,
      groupId: persona.groupId,
      position: { xM: a[1]! / 100, yM: a[2]! / 100 },
      velocity: { xMps: a[3]! / 100, yMps: a[4]! / 100 },
      state,
      targetPlaceId: a[5] ? s.park.places[a[5] - 1]!.id : null,
      needs: {
        hunger: a[6]! / 10,
        fatigue: a[7]! / 10,
        patience: a[8]! / 10,
        fun: a[9]! / 10,
      },
      experienceValue: a[10]! / 10,
      rating:
        a[12]! >= 0
          ? { value: a[12]! / 10, atMs: a[13]!, source: SOURCES[a[14]!]! }
          : null,
      latestEvidenceId: a[11] ? `evidence:${persona.groupId}:${a[11]}` : null,
    };
  });
  const position = new Map(agents.map((a) => [a.agentId, a.position]));
  return {
    atMs: cf.atMs,
    frameSchema: "frame-v2",
    snapshot: {
      contractVersion: "behavior.v1",
      run: cf.run,
      agents,
      places: cf.places,
      queues: cf.queues.map((q) => ({
        ...q,
        entries: q.entries.map((e) => ({
          ...e,
          positions: e.agentIds.map((agentId) => ({
            agentId,
            position: position.get(agentId) ?? { ...entrance },
          })),
        })),
      })),
      metrics: cf.metrics,
      health: EMPTY_HEALTH,
      recentEvents: [],
    },
  };
}
