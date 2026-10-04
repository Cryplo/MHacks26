import { cloneJson } from "./primitives.js";
import type * as C from "../../contract/behavior-v1.js";
import type { CompactFrame } from "../replay/frames.js";
import { hash } from "./primitives.js";
import {
  validateConfig,
  validatePopulation,
  validateScenario,
} from "./schemas.js";
import { validatePark } from "../navigation/grid.js";
export const ENGINE_VERSION = "engine-v1";
export const PHASES: C.BoundaryPhase[] = [
  "prepare",
  "requests",
  "barrier",
  "apply",
  "dispatch",
  "integrate",
  "persist",
];
export const MOMENT_PRIORITY: Record<C.Moment, number> = {
  forced_replan: 0,
  join_line: 1,
  stay_line: 2,
  hungry_tired: 3,
  closing_soon: 4,
  what_next: 5,
  route_choice: 6,
  separated: 7,
  bumped: 8,
  message_seen: 9,
  noticed: 10,
};
export type PersonState = C.AgentView & {
  admittedAtMs: number | null;
  departedAtMs: number | null;
  censored: boolean;
  facts: C.ObservationFact[];
  /** Observation counter (fact ids stay unique after old facts roll out of memory). */
  factSeq?: number;
  /** Hash chain over every observed fact; "" before the first. Absent in legacy states. */
  factDigest?: string;
  /** Arc-length position along the current queue line (null/absent when not on a line). */
  queueU?: number | null;
  distanceM: number;
  queueMs: number;
  parkMs: number;
  terminalRatingId: string | null;
};
export type GroupState = {
  manifest: C.GroupManifest;
  balanceCents: number;
  planRevision: number;
  decisionSeq: number;
  momentSeq: Partial<Record<C.Moment, number>>;
  pendingMoment: C.Moment | null;
  requestId: string | null;
  target: C.Vec2 | null;
  route: C.Vec2[];
  activityUntilMs: number | null;
  resumeAfterNotice?: "walking" | "browsing" | null;
  lastQueueCheckMs: number;
  needArmed: boolean;
  lastNeedMs: number;
  noticePlaceId: string | null;
  deferredNoticeId: string | null;
  nextDecisionAtMs: number;
  leaving: boolean;
  /** Indices (into events) of this group's latest events, oldest first. */
  recentEventIdx?: number[];
};
export type PlaceState = {
  definition: C.Place;
  closed: boolean;
  revision: number;
  boardVersion: string;
  noticeVersion: string;
  nextDispatchMs: number;
  vehicleReadyMs: number[];
  /** Cumulative guests who finished service here (absent in legacy states). */
  servedGuests?: number;
};
export type QueueEntry = {
  id: string;
  groupId: string;
  placeId: string;
  agentIds: string[];
  lane: "standard" | "pass";
  sequence: number;
  joinedAtMs: number;
  originalJoinedAtMs: number;
  promiseMs: number | null;
  missed: number;
  cart: C.Quote[] | null;
  waitMs: number;
};
export type Session = {
  id: string;
  placeId: string;
  groupIds: string[];
  agentIds: string[];
  startMs: number;
  endMs: number;
  releaseMs: number;
  vehicle: number | null;
  waitPersonMs: number;
  kind: C.Service["kind"];
  saleIds: string[];
};
export type Sale = {
  id: string;
  groupId: string;
  placeId: string;
  amountCents: number;
  refundCents: number;
  beneficiaryIds: string[];
  atMs: number;
};
export type DecisionSlot = {
  request: C.DecisionRequest;
  response: C.DecisionResult | null;
  status: "pending" | "ready" | "applied" | "superseded" | "cancelled";
};
export type HeatContribution = {
  atMs: number;
  fromMs: number;
  toMs: number;
  cell: number;
  layer: C.HeatLayer;
  value: number;
};
export type CoreState = {
  schema: "engine-state-v1";
  runId: string;
  manifest: C.RunManifest;
  park: C.ParkBundle;
  population: C.PopulationManifest;
  view: C.RunView;
  persons: Record<string, PersonState>;
  groups: Record<string, GroupState>;
  places: Record<string, PlaceState>;
  queues: QueueEntry[];
  sessions: Session[];
  sales: Sale[];
  entitlements: string[];
  decisions: Record<string, DecisionSlot>;
  evidence: C.AppliedDecision[];
  events: C.EventRecord[];
  ratings: Record<
    string,
    { request: C.RatingRequest; result: C.RatingResult | null }
  >;
  metrics: C.MetricSnapshot[];
  /** Frames not yet persisted (saved one row per frame, then cleared; see replay/frames.ts). */
  frames: (C.ReplayFrame | CompactFrame)[];
  heat: HeatContribution[];
  scenarioApplied: string[];
  passPriceCents: number;
  passRevision: number;
  nextQueueSequence: number;
  nextSessionSequence: number;
  barrierIds: string[];
  /** Decision ids that may still be pending/ready (pruned lazily). Absent in legacy states. */
  openDecisionIds?: string[];
  /** Rating ids that may still lack a result (pruned lazily). Absent in legacy states. */
  openRatingIds?: string[];
  phaseCursor: number;
  movementSubstep: number;
  motionPending?: {
    cursor: number;
    proposed: Record<string, C.Vec2>;
    ties: Record<string, { x: number; y: number }>;
  };
  pauseRequested: boolean;
  closing: boolean;
  totals: {
    admitted: number;
    departed: number;
    queuePersonMs: number;
    parkPersonMs: number;
    joinedEpisodes: number;
    abandonedEpisodes: number;
    completedRiders: number;
    completedRideWaitMs: number;
    usedSeats: number;
    dispatchedSeats: number;
    busyServerMs: number;
    availableServerMs: number;
    earlyDepartures: number;
  };
  boundaries: { atMs: number; hash: string }[];
  lastCompletedHash: string | null;
  /** Inspector history: each group's latest applied decisions (newest last), with a revision. */
  decisionLog?: Record<string, DecisionLog>;
  /** Responses applied in a bounded-history run whose behavior came from outside Engine. */
  tapeResponses?: C.DecisionResult[];
  /** Unique token of the last save (see runtime/store.ts cache validation). */
  persistStamp?: string;
};
export type DecisionLog = { rev: number; entries: C.DecisionSummary[] };
export function createCore(
  runId: string,
  manifest: C.RunManifest,
  parkInput: unknown,
  populationInput: unknown,
): CoreState {
  const { park } = validatePark(parkInput),
    population = validatePopulation(populationInput, park);
  validateConfig(manifest.config);
  validateScenario(manifest.scenario, park);
  const quality: C.Quality = {
    comparisonEligible: true,
    reasons: [],
    behaviorCounts: { jev: 0, cache: 0, mock: 0, fallback: 0 },
    invalidAttempts: 0,
    staleAttempts: 0,
    pendingRatings: 0,
    terminalRatingsExpected: 0,
    terminalRatingsComplete: 0,
  };
  const state: CoreState = {
    schema: "engine-state-v1",
    runId,
    manifest: cloneJson(manifest),
    park,
    population,
    view: {
      runId,
      revision: 0,
      controlRevision: 0,
      manifestHash: hash(manifest),
      mode: manifest.config.mode,
      status: "ready",
      simMs: 0,
      stepIndex: 0,
      phase: "prepare",
      scenarioRevision: manifest.scenario.revision,
      earliestSchedulableMs: 0,
      requestedSpeed: manifest.config.requestedSpeed,
      achievedSpeed: 0,
      blockedWorkIds: [],
      quality,
    },
    persons: {},
    groups: {},
    places: {},
    queues: [],
    sessions: [],
    sales: [],
    entitlements: [],
    decisions: {},
    evidence: [],
    events: [],
    ratings: {},
    metrics: [],
    frames: [],
    heat: [],
    scenarioApplied: [],
    passPriceCents: park.pass.unitPriceCents,
    passRevision: 0,
    nextQueueSequence: 0,
    nextSessionSequence: 0,
    barrierIds: [],
    openDecisionIds: [],
    openRatingIds: [],
    phaseCursor: 0,
    movementSubstep: 0,
    pauseRequested: false,
    closing: false,
    totals: {
      admitted: 0,
      departed: 0,
      queuePersonMs: 0,
      parkPersonMs: 0,
      joinedEpisodes: 0,
      abandonedEpisodes: 0,
      completedRiders: 0,
      completedRideWaitMs: 0,
      usedSeats: 0,
      dispatchedSeats: 0,
      busyServerMs: 0,
      availableServerMs: 0,
      earlyDepartures: 0,
    },
    boundaries: [],
    lastCompletedHash: null,
    decisionLog: {},
  };
  const entrance = park.places.find((p) => p.kind === "entrance")!.entrance;
  for (const p of population.personas)
    state.persons[p.agentId] = {
      agentId: p.agentId,
      groupId: p.groupId,
      position: { ...entrance },
      velocity: { xMps: 0, yMps: 0 },
      state: "not_arrived",
      targetPlaceId: null,
      needs: { ...p.initialNeeds },
      experienceValue: 50,
      rating: null,
      latestEvidenceId: null,
      admittedAtMs: null,
      departedAtMs: null,
      censored: false,
      facts: [],
      factSeq: 0,
      factDigest: "",
      distanceM: 0,
      queueMs: 0,
      parkMs: 0,
      terminalRatingId: null,
    };
  for (const g of population.groups)
    state.groups[g.groupId] = {
      manifest: g,
      balanceCents: g.startingBalanceCents,
      planRevision: 0,
      decisionSeq: 0,
      momentSeq: {},
      pendingMoment: null,
      requestId: null,
      target: null,
      route: [],
      activityUntilMs: null,
      lastQueueCheckMs: 0,
      needArmed: true,
      lastNeedMs: -600000,
      noticePlaceId: null,
      deferredNoticeId: null,
      nextDecisionAtMs: 0,
      leaving: false,
    };
  for (const p of park.places)
    state.places[p.id] = {
      definition: cloneJson(p),
      closed: false,
      revision: 0,
      boardVersion: "board:0",
      noticeVersion: "notice:0",
      nextDispatchMs: 0,
      vehicleReadyMs:
        p.service.kind === "ride" ? Array(p.service.vehicles).fill(0) : [],
    };
  return state;
}
