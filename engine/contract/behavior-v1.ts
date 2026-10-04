/** Frozen application contract, behavior.v1. Not a vendor SDK or implementation. */
export const CONTRACT_VERSION = 'behavior.v1' as const;
export type ContractVersion = typeof CONTRACT_VERSION;
export type Id = string; // ASCII [A-Za-z0-9_.:-], 1..160 chars; always scope by run.
export type Hash = string; // Lowercase SHA-256 hex.
export type SimMs = number; // Nonnegative safe integer milliseconds from park opening.
export type Cents = number; // Safe integer USD cents; no floating-point money.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Mode = 'mock' | 'live' | 'experiment' | 'replay';
export type Source = 'jev' | 'cache' | 'mock' | 'fallback';
export type Role = 'viewer' | 'operator' | 'worker' | 'coordinator';
export type Vec2 = { xM: number; yM: number };
export type Velocity = { xMps: number; yMps: number };
export type Scope = { runId: Id | null; experimentId: Id | null };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type SequencePage<T> = { items: T[]; nextAfterSequence: number | null };
export type ArtifactKind = 'park' | 'population' | 'model_response' | 'checkpoint'
  | 'response_tape' | 'fact_bundle' | 'experiment_report' | 'narrative' | 'frames';
export type ArtifactRef = {
  artifactId: Id; kind: ArtifactKind; sha256: Hash; byteLength: number;
  mediaType: string; contractVersion: ContractVersion;
};
export type DomainError = {
  code: 'INVALID_INPUT' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT'
    | 'STALE_REVISION' | 'STALE_LEASE' | 'INVALID_STATE' | 'UNSUPPORTED'
    | 'RATE_LIMITED' | 'DEPENDENCY_UNAVAILABLE' | 'INCOMPLETE' | 'INTERNAL';
  message: string; retryable: boolean; fieldErrors: { path: string; message: string }[];
};
export interface RuntimeClientError extends Error {
  name: 'RuntimeClientError'; error: DomainError; transport: boolean;
}
export type Receipt<T> =
  | { commandId: Id; ok: true; result: T }
  | { commandId: Id; ok: false; error: DomainError };
export type VersionSet = {
  engine: string; observation: string; options: string; random: string;
  persona: string; prompt: string; requestedModel: string; meter: string;
  loading: string; metrics: string; rubric: string; replay: string; sourceCommit: string;
};
export type FeatureFlags = {
  routeChoice: boolean; bumpReactions: boolean; splitGroups: boolean;
  speechBubbles: boolean; discountMessages: boolean;
};
export type Capabilities = {
  contractVersion: ContractVersion; eventKinds: ScenarioEvent['change']['kind'][];
  workKinds: ProductRequest['kind'][]; features: FeatureFlags;
  maxGuests: number; maxArtifactBytes: number; maxChunkBytes: number;
};

// PARK. PNG is an authoring format. This is the validated, portable runtime payload.
export type CellCode = 0 | 1 | 2 | 3 | 4; // blocked,path,plaza,grass,queue
export type Grid = {
  width: number; height: number; cellM: number; encoding: 'u8-row-major-v1';
  cellsBase64: string; cellsSha256: Hash; grassWalkable: boolean;
};
export type QueueZone = { id: Id; placeId: Id; cellIndices: number[]; entry: Vec2; exit: Vec2 };
export type WaitDisplay =
  | { kind: 'rounded_estimate'; roundToMin: number; template: string }
  | { kind: 'range_estimate'; roundToMin: number; spreadMin: number; template: string }
  | { kind: 'fixed'; lowerMin: number | null; upperMin: number | null; text: string };
export type Service =
  | { kind: 'ride'; seats: number; vehicles: number; dispatchMs: SimMs;
      durationMs: SimMs; turnaroundMs: SimMs; passShareBps: number; passEnabled: boolean }
  | { kind: 'counter'; servers: number; serviceMs: SimMs; activityMs: SimMs;
      products: { id: Id; label: string; unitPriceCents: Cents }[] }
  | { kind: 'show'; seats: number; startsAtMs: SimMs[]; durationMs: SimMs }
  | { kind: 'rest'; durationMs: SimMs }
  | { kind: 'none' };
export type Notice = { text: string; channel: 'visual' | 'aroma'; radiusM: number; cooldownMs: SimMs };
export type Place = {
  id: Id; name: string; kind: 'ride' | 'food' | 'shop' | 'restroom' | 'show'
    | 'scenery' | 'entrance' | 'exit'; entrance: Vec2; queueZoneId: Id | null;
  service: Service; minHeightCm: number | null; thrill: number;
  board: WaitDisplay | null; notice: Notice | null;
};
export type RouteProfile = { id: Id; destinationId: Id; via: Vec2[]; label: string };
export type ParkBundle = {
  contractVersion: ContractVersion; parkId: Id; revision: string; label: string;
  openLocal: string; closeAfterMs: SimMs; grid: Grid; places: Place[];
  queueZones: QueueZone[]; routeProfiles: RouteProfile[];
  pass: { productId: Id; unitPriceCents: Cents; unit: 'per_guest'; validity: 'remaining_day' };
};
export type ParkSummary = {
  parkId: Id; revision: string; label: string; artifact: ArtifactRef;
  status: 'preparing' | 'ready' | 'invalid'; issues: string[];
};

// POPULATION. All behavioral traits/goals/hooks are sampled in code, then frozen.
export type Archetype = 'young_family' | 'teens' | 'couple' | 'thrill_seekers' | 'seniors' | 'solo';
export type CrowdSpec = {
  guestCount: number; seed: string; shares: Record<Archetype, number>;
  contextNotes: string; generatorVersion: string;
};
export type Needs = { hunger: number; fatigue: number; patience: number; fun: number };
export type Persona = {
  agentId: Id; groupId: Id; archetype: Archetype; role: 'parent' | 'child' | 'teen' | 'adult' | 'senior';
  ageYears: number; heightCm: number; walkSpeedMps: number; thrillPreference: number;
  initialNeeds: Needs; hungerPerHour: number; fatiguePerKm: number; patiencePerMinute: number;
  familiarity: number; hasApp: boolean; language: string;
  phoneActiveUntilMs: SimMs | null; stroller: boolean; mobilityRestricted: boolean;
  occasion: string; mustDoPlaceIds: Id[]; backstory: string;
};
export type GroupManifest = {
  groupId: Id; memberIds: Id[]; leaderId: Id; guardianIds: Id[]; rallyPlaceId: Id;
  walletId: Id; startingBalanceCents: Cents; arrivalMs: SimMs; plannedDepartureMs: SimMs;
};
export type PopulationManifest = {
  contractVersion: ContractVersion; populationId: Id; crowd: CrowdSpec;
  parkHash: Hash; personas: Persona[]; groups: GroupManifest[];
  proseVersion: string; randomVersion: string;
  diversity: { key: string; counts: Record<string, number> }[];
};

// SCENARIOS. Geometry mutation is deliberately not an MVP event.
export type ScenarioChange =
  | { kind: 'pass_price'; unitPriceCents: Cents }
  | { kind: 'pass_share'; placeId: Id; shareBps: number }
  | { kind: 'board'; placeId: Id; display: WaitDisplay }
  | { kind: 'notice'; placeId: Id; notice: Notice }
  | { kind: 'closure'; placeId: Id; closed: boolean }
  | { kind: 'show_schedule'; placeId: Id; startsAtMs: SimMs[] }
  | { kind: 'app_message'; messageId: Id; text: string; expiresAtMs: SimMs;
      suggestedPlaceId: Id | null; discount: null | {
        productIds: Id[]; discountBps: number; maxUsesPerGroup: number;
      } };
export type ScenarioEvent = { id: Id; atMs: SimMs; order: number; change: ScenarioChange };
export type Scenario = { id: Id; revision: string; label: string; events: ScenarioEvent[] };
export type ScenarioContext = {
  runId: Id | null; currentSimMs: SimMs; earliestSchedulableMs: SimMs;
  scenarioRevision: string; park: ParkSummary; places: Pick<Place, 'id' | 'name' | 'kind'>[];
  capabilities: Capabilities;
};
export type ScenarioDraft = {
  draftId: Id; contextRevision: string; events: ScenarioEvent[];
  assumptions: string[]; unsupported: string[]; requiresConfirmation: true;
};
export type RunConfig = {
  mode: Mode; horizonMs: SimMs; logicalStepMs: 5000; movementStepMs: 250;
  requestedSpeed: number; temperature: 1; earlyDepartureThresholdMs: SimMs;
  ratingEveryMs: SimMs | null; visualFrameEveryMs: SimMs; checkpointEveryMs: SimMs;
  fallback: 'forbidden' | 'live_timeout_v1'; liveTimeoutMs: number;
  features: FeatureFlags; versions: VersionSet;
  /** Additive (optional), mock mode only: 'engine' (default) evaluates the deterministic mock
   * policy inside Engine with no worker round trip; 'worker' queues decisions for a worker. */
  mockResolution?: 'engine' | 'worker';
};
export type RunManifest = {
  contractVersion: ContractVersion; park: ArtifactRef; population: ArtifactRef;
  scenario: Scenario; replicateSeed: string; config: RunConfig;
  experiment: null | { experimentId: Id; pairId: Id; arm: 'A' | 'B' };
  initialCheckpoint: ArtifactRef | null; replayTape: ArtifactRef | null;
};
export type BoundaryPhase = 'prepare' | 'requests' | 'barrier' | 'apply'
  | 'dispatch' | 'integrate' | 'persist';
export type RunStatus = 'preparing' | 'ready' | 'running' | 'paused' | 'blocked'
  | 'draining' | 'completed' | 'failed' | 'cancelled';
export type Quality = {
  comparisonEligible: boolean; reasons: string[]; behaviorCounts: Record<Source, number>;
  invalidAttempts: number; staleAttempts: number; pendingRatings: number;
  terminalRatingsExpected: number; terminalRatingsComplete: number;
};
export type RunView = {
  runId: Id; revision: number; controlRevision: number; manifestHash: Hash; mode: Mode; status: RunStatus;
  simMs: SimMs; stepIndex: number; phase: BoundaryPhase; scenarioRevision: string;
  earliestSchedulableMs: SimMs; requestedSpeed: number; achievedSpeed: number;
  blockedWorkIds: Id[]; quality: Quality;
};

// OBSERVATION AND DECISION. Runtime owns these snapshots and executable actions.
export type ObservationFact = {
  id: Id; kind: 'board' | 'notice' | 'message' | 'price' | 'crowd' | 'closure' | 'experience';
  placeId: Id | null; source: 'sight' | 'aroma' | 'app' | 'memory' | 'static_map' | 'self';
  observedAtMs: SimMs; contentVersion: string; text: string;
  waitLowerMs: SimMs | null; waitUpperMs: SimMs | null; priceCents: Cents | null;
};
export type KnownDestination = {
  placeId: Id; name: string; walkEstimateMs: SimMs | null;
  lastObservedFactIds: Id[]; knownRestrictions: string[];
};
export type GuestObservation = {
  schema: 'observation.v1'; groupId: Id; leaderId: Id; atMs: SimMs;
  members: { persona: Persona; needs: Needs }[];
  wallet: { walletId: Id; balanceCents: Cents };
  facts: ObservationFact[]; knownDestinations: KnownDestination[];
  recentEventSummaries: { eventId: Id; atMs: SimMs; text: string }[];
  currentActivity: string; plannedDepartureMs: SimMs;
};
export type Quote = {
  quoteId: Id; revision: string; productId: Id; unitPriceCents: Cents;
  quantity: number; totalCents: Cents; beneficiaryIds: Id[]; validUntilMs: SimMs;
  discountMessageId: Id | null;
};
export type Action =
  | { kind: 'travel'; placeId: Id; routeProfileId: Id | null }
  | { kind: 'browse'; durationMs: SimMs }
  | { kind: 'rest'; placeId: Id; durationMs: SimMs }
  | { kind: 'join_queue'; placeId: Id; lane: 'standard' | 'pass'; riderIds: Id[] }
  | { kind: 'leave_queue'; queueEntryId: Id }
  | { kind: 'buy_pass_and_join'; placeId: Id; riderIds: Id[]; quote: Quote }
  | { kind: 'order'; placeId: Id; cart: Quote[] }
  | { kind: 'leave_park' }
  | { kind: 'continue' }
  | { kind: 'notice_stop'; placeId: Id; durationMs: SimMs }
  | { kind: 'notice_enter'; placeId: Id }
  | { kind: 'route'; profileId: Id }
  | { kind: 'bump_response'; response: 'continue' | 'step_aside'; durationMs: SimMs }
  | { kind: 'regroup'; rallyPlaceId: Id };
export type ActionOption = { id: Id; label: string; description: string; action: Action };
export type Moment = 'forced_replan' | 'what_next' | 'noticed' | 'join_line' | 'stay_line'
  | 'hungry_tired' | 'message_seen' | 'closing_soon' | 'route_choice' | 'bumped' | 'separated';
export type DecisionRequest = {
  contractVersion: ContractVersion; requestId: Id; runId: Id; groupId: Id;
  agentIds: Id[]; moment: Moment; decisionSeq: number; momentSeq: number; requestRevision: number;
  createdAtMs: SimMs; applyAtMs: SimMs; planRevision: number;
  dependencyRevisions: Record<string, string>; observationHash: Hash; optionsHash: Hash;
  policyVersion: string; observation: GuestObservation; options: ActionOption[];
  promptOptionOrder: Id[];
  candidateAudit: { considered: Id[]; excluded: { id: Id; reason: string }[] };
};
export type Distribution = { optionId: Id; probability: number }[];
export type Usage = {
  callId: Id | null; inputTokens: number | null; outputTokens: number | null;
  estimatedCostUsd: number | null; priceVersion: string | null;
  queueMs: number; httpMs: number; attemptCount: number;
};
export type ProviderAttempt = {
  callId: Id; workId: Id; phase: 'started' | 'finished'; provider: 'jev' | 'prose';
  modelRequested: string; modelReturned: string | null; startedAtEpochMs: number;
  durationMs: number | null; outcome: null | 'success' | 'timeout' | 'rate_limited' | 'invalid' | 'error';
  inputTokens: number | null; outputTokens: number | null;
  estimatedCostUsd: number | null; priceVersion: string | null; billingOwnerRunId: Id | null;
};
export type DecisionResult = {
  requestId: Id; observationHash: Hash; optionsHash: Hash; modelRequested: string;
  modelReturned: string; source: Source; probabilities: Distribution;
  confidence: number | null; responseArtifact: ArtifactRef; usage: Usage;
  cacheKey: Hash | null; originalSource: Exclude<Source, 'cache'>;
  /** Additive (optional): reasoning text the behavior model returned, if any. Never parsed. */
  reasoning?: string | null;
};
/** Additive: a short, human-readable account of one applied decision, built by Engine from
 * the frozen observation, the offered options and the applied distribution (deterministic). */
export type DecisionRationale = {
  /** One line, e.g. "Hungry (72/100); Harbor Grill board: 4 min; $38.00 left -> chose ... (p=0.61) over ... (p=0.22)". */
  summary: string;
  /** What the group noticed or felt, as short factual phrases (needs, wallet, time, waits). */
  drivers: string[];
  chosen: { optionId: Id; label: string; probability: number };
  /** Up to three most likely other options, most likely first. */
  alternatives: { optionId: Id; label: string; probability: number }[];
  /** The behavior model's own reasoning text when it returned one; otherwise null. */
  modelReasoning: string | null;
};
export type AppliedDecision = {
  evidenceId: Id; request: DecisionRequest; response: DecisionResult;
  appliedProbabilities: Distribution; draw: number; chosenOptionId: Id;
  outcome: 'committed' | 'failed_precondition'; failureReason: string | null;
  committedAtMs: SimMs; causedEventIds: Id[];
  /** Additive (optional): Engine's deterministic explanation of this decision. */
  rationale?: DecisionRationale;
};
/** Additive: compact history row for the agent inspector (newest first in AgentDetail). */
export type DecisionSummary = {
  evidenceId: Id; atMs: SimMs; moment: Moment; chosenOptionId: Id; chosenLabel: string;
  outcome: AppliedDecision['outcome']; source: Source; rationale: DecisionRationale;
};

// MEASUREMENTS ARE FROZEN JOBS, NOT BEHAVIORAL DEPENDENCIES.
export type RatingRequest = {
  ratingId: Id; runId: Id; agentId: Id; atMs: SimMs;
  endpoint: 'periodic' | 'departure' | 'horizon'; evidenceHash: Hash;
  observation: GuestObservation; rubricVersion: string; levels: string[];
};
export type RatingResult = {
  ratingId: Id; evidenceHash: Hash; rubricVersion: string; scoreIndex: number;
  probabilities: number[]; source: Source; modelReturned: string;
  responseArtifact: ArtifactRef; usage: Usage;
};
export type MetricId = 'net_revenue_cents' | 'revenue_per_guest_cents'
  | 'satisfaction_0_100' | 'queue_minutes_per_guest' | 'completed_ride_wait_minutes'
  | 'rides_per_guest' | 'abandonment_rate' | 'queue_time_share'
  | 'early_departures' | 'ride_seat_utilization' | 'server_utilization';
export type MetricValue = {
  id: MetricId; value: number | null; unit: 'cents' | 'score' | 'minutes' | 'ratio' | 'guests';
  numerator: number; denominator: number | null; n: number; coverage: number;
  complete: boolean; missingReason: string | null;
};
export type MetricSnapshot = {
  runId: Id; simMs: SimMs; revision: number; definitionVersion: string;
  admittedGuests: number; guestsInPark: number; measures: Record<MetricId, MetricValue>;
  /** Additive (optional): per-place and per-state detail at this instant, for dashboards. */
  breakdown?: MetricBreakdown;
};
/** Additive: dashboard detail carried by each MetricSnapshot (getMetrics series, live metrics). */
export type MetricBreakdown = {
  /** Guests currently in each activity state (states with zero guests are omitted). */
  states: Partial<Record<AgentView['state'], number>>;
  places: {
    placeId: Id; standardPersons: number; passPersons: number; predictedWaitMs: SimMs | null;
    /** Cumulative net ancillary revenue attributed to this place (passes count at the ride). */
    revenueCents: Cents;
    /** Cumulative guests who finished service here (rides, shows, counters). */
    servedGuests: number;
  }[];
  /** Admitted guests by latest satisfaction rating level (index 0..levels-1; unrated excluded). */
  satisfactionLevels: number[];
};
export type EventKind = 'arrived' | 'observed' | 'queue_joined' | 'queue_left'
  | 'closure_release' | 'service_started' | 'service_completed' | 'purchase' | 'refund'
  | 'experience' | 'departed' | 'action_failed' | 'scenario_applied' | 'bump' | 'regrouped';
export type EventRecord = {
  eventId: Id; runId: Id; sequence: number; atMs: SimMs; kind: EventKind;
  groupId: Id | null; agentIds: Id[]; placeId: Id | null; position: Vec2 | null;
  causationId: Id | null; amountCents: Cents | null; experienceDelta: number | null;
  reason: string | null; details: Json; // kind-specific validated event schemas owned by Engine.
};
export type Health = {
  queuedWork: number; leasedWork: number; oldestRequestAgeMs: number;
  httpP95Ms: number | null; reducerP95Ms: number | null;
  calls: number; inputTokens: number; estimatedCostUsd: number | null;
  tokenCoverage: number; warnings: string[];
};
export type AgentView = {
  agentId: Id; groupId: Id; position: Vec2; velocity: Velocity;
  state: 'not_arrived' | 'walking' | 'browsing' | 'queueing' | 'riding' | 'eating'
    | 'shopping' | 'resting' | 'watching' | 'deciding' | 'left';
  targetPlaceId: Id | null; needs: Needs; experienceValue: number;
  rating: null | { value: number; atMs: SimMs; source: Source };
  latestEvidenceId: Id | null;
};
export type PlaceView = {
  placeId: Id; closed: boolean; boardText: string | null; boardVersion: string;
  noticeVersion: string; predictedWaitMs: SimMs | null; // operator truth; not guest knowledge
};
export type QueueView = {
  placeId: Id; standardPersons: number; passPersons: number;
  entries: { entryId: Id; agentIds: Id[]; lane: 'standard' | 'pass'; sequence: number;
    joinedAtMs: SimMs; positions: { agentId: Id; position: Vec2 }[] }[];
};
export type LiveSnapshot = {
  contractVersion: ContractVersion; run: RunView; agents: AgentView[]; places: PlaceView[];
  queues: QueueView[]; metrics: MetricSnapshot; health: Health; recentEvents: EventRecord[];
};
export type LivePatch = {
  runId: Id; fromRevision: number; toRevision: number; run: RunView;
  agents: { upsert: AgentView[]; removeIds: Id[] };
  places: PlaceView[]; queues: QueueView[]; metrics: MetricSnapshot | null;
  health: Health | null; appendedEvents: EventRecord[];
};
export type HeatLayer = 'waiting_person_minutes' | 'negative_experience'
  | 'spending_cents' | 'early_departures' | 'bump_episodes';
export type Heatmap = {
  runId: Id; layer: HeatLayer; fromMs: SimMs; toMs: SimMs; cellM: number;
  width: number; height: number; values: number[]; total: number;
  unit: string; denominator: string; complete: boolean;
};
export type ReplayFrame = { atMs: SimMs; frameSchema: string; snapshot: LiveSnapshot };
export type AgentDetail = {
  agent: AgentView; persona: Persona; group: GroupManifest;
  observedFacts: ObservationFact[]; evidence: AppliedDecision | null; recentEvents: EventRecord[];
  /** Additive (optional): plain-language current status, e.g. "Queueing for Sky Coaster (6 min so far)". */
  statusText?: string;
  /** Additive (optional): the group's most recent applied decisions (newest first, up to 12). */
  decisions?: DecisionSummary[];
};

// EXPERIMENTS AND REPORTS. No aggregate is allowed to hide an incomplete pair.
export type ExperimentSpec = {
  contractVersion: ContractVersion; experimentId: Id; park: ArtifactRef;
  crowd: Omit<CrowdSpec, 'seed'>; seeds: string[]; baseline: Scenario; variant: Scenario;
  config: RunConfig; interventionLabel: string; changedLever: string;
  analysis: 'paired_descriptive' | 'paired_t'; alpha: 0.05;
  operationBudgetMs: number; maxConcurrentArms: 1 | 2;
  start: { kind: 'opening' } | { kind: 'warmup'; toMs: SimMs; warmupScenario: Scenario };
};
export type PairResult = {
  pairId: Id; seed: string; populationHash: Hash; initialStateHash: Hash | null;
  aRunId: Id | null; bRunId: Id | null;
  status: 'pending' | 'running' | 'complete' | 'incomplete' | 'degraded' | 'failed';
  reasons: string[]; a: MetricSnapshot | null; b: MetricSnapshot | null;
  deltas: Partial<Record<MetricId, number>>;
};
export type PairedSummary = {
  metricId: MetricId; pairCount: number; differences: number[];
  mean: number | null; min: number | null; max: number | null; sampleSd: number | null;
  interval: null | { kind: 'paired_t_mean'; lower: number; upper: number; level: 0.95 };
};
export type ExperimentReport = {
  spec: ExperimentSpec; revision: number; status: 'running' | 'complete' | 'incomplete';
  pairs: PairResult[]; summaries: PairedSummary[]; requestedPairs: number; completePairs: number;
  exploratory: boolean; limitations: string[]; facts: ArtifactRef | null; responseTape: ArtifactRef | null;
};
export type Fact = {
  id: Id; label: string; value: number | string; unit: string; denominator: string;
  scope: Scope; sourceEventIds: Id[]; metricId: MetricId | null; limitations: string[];
};
export type FactBundle = {
  contractVersion: ContractVersion; id: Id; asOfMs: SimMs; sourceHash: Hash;
  facts: Fact[]; quality: Quality | null; scope: Scope;
};
export type Narrative = {
  id: Id; evidenceHash: Hash; origin: 'template' | 'llm';
  label: 'narrated from state' | 'modeled-results report';
  sections: { heading: string; segments: ({ kind: 'text'; text: string }
    | { kind: 'fact'; factId: Id })[] }[];
  limitations: string[];
};

// JOBS. Only Engine creates behavior/rating jobs from authoritative snapshots.
export type WorkPayloads = {
  decision: DecisionRequest;
  rating: RatingRequest;
  population: { crowd: CrowdSpec; park: ArtifactRef; closeAfterMs: SimMs };
  parse_crowd: { text: string; current: CrowdSpec };
  parse_scenario: { text: string; context: ScenarioContext };
  thought: { evidence: AppliedDecision; agentId: Id };
  experiment: ExperimentSpec;
  report: { facts: FactBundle };
};
export type WorkResults = {
  decision: DecisionResult; rating: RatingResult;
  population: { artifact: ArtifactRef; guestCount: number; groupCount: number };
  parse_crowd: { proposal: CrowdSpec; assumptions: string[]; unsupported: string[] };
  parse_scenario: ScenarioDraft; thought: Narrative;
  experiment: { report: ArtifactRef }; report: Narrative;
};
export type WorkKind = keyof WorkPayloads;
export type WorkLease = {
  workId: Id; attempt: number; leaseToken: string; expiresAtEpochMs: number; ownerIdentity: string;
};
export type LeasedWork = { [K in WorkKind]: {
  kind: K; scope: Scope; lease: WorkLease; payload: WorkPayloads[K];
} }[WorkKind];
export type CompletedWork = { [K in WorkKind]: {
  kind: K; lease: WorkLease; result: WorkResults[K];
} }[WorkKind];
export type WorkStatus = { [K in WorkKind]: {
  workId: Id; kind: K; status: 'pending' | 'leased' | 'ready' | 'applied'
    | 'failed' | 'cancelled' | 'superseded';
  result: WorkResults[K] | null; error: DomainError | null;
} }[WorkKind];
export type ProductRequest =
  | { kind: 'population'; crowd: CrowdSpec; park: ArtifactRef }
  | { kind: 'parse_crowd'; text: string; current: CrowdSpec }
  | { kind: 'parse_scenario'; text: string; runId: Id | null; park: ArtifactRef;
      expectedScenarioRevision: string }
  | { kind: 'thought'; runId: Id; evidenceId: Id; agentId: Id }
  | { kind: 'report'; runId: Id | null; experimentId: Id | null };
export type DriverLease = { runId: Id; epoch: number; token: string; expiresAtEpochMs: number };
export type AdvanceResult = {
  run: RunView; completedSteps: number; physicalStateHash: Hash | null; blockedWorkIds: Id[];
};

// COMMANDS USE PRIVATE DURABLE RECEIPTS. A reducer's void return is not a result DTO.
export type Commands = {
  registerPark: { input: { artifact: ArtifactRef }; output: ParkSummary };
  requestProductWork: { input: { request: ProductRequest }; output: { workId: Id } };
  createRun: { input: { manifest: RunManifest }; output: { runId: Id } };
  startRun: { input: { runId: Id }; output: RunView };
  pauseRun: { input: { runId: Id; expectedControlRevision: number }; output: RunView };
  resumeRun: { input: { runId: Id; expectedControlRevision: number }; output: RunView };
  setSpeed: { input: { runId: Id; requestedSpeed: number; expectedControlRevision: number }; output: RunView };
  cancelRun: { input: { runId: Id; expectedControlRevision: number }; output: RunView };
  scheduleEvents: { input: { runId: Id; expectedScenarioRevision: string;
    draftId: Id | null; events: ScenarioEvent[] }; output: { scenarioRevision: string; events: ScenarioEvent[] } };
  claimWork: { input: { kinds: WorkKind[]; limit: number; workerNonce: string;
    leaseMs: number }; output: { items: LeasedWork[] } };
  renewWork: { input: { leases: WorkLease[]; leaseMs: number }; output: { leases: WorkLease[] } };
  completeWork: { input: { item: CompletedWork }; output: { workId: Id; status: WorkStatus['status'] } };
  recordProviderAttempt: { input: { attempt: ProviderAttempt }; output: { callId: Id; phase: 'started' | 'finished' } };
  failWork: { input: { lease: WorkLease; error: DomainError; retryAtEpochMs: number | null };
    output: { workId: Id; status: WorkStatus['status'] } };
  acquireDriver: { input: { runId: Id; leaseMs: number }; output: DriverLease };
  renewDriver: { input: { lease: DriverLease; leaseMs: number }; output: DriverLease };
  advanceRun: { input: { lease: DriverLease; expectedStep: number; expectedPhase: BoundaryPhase;
    maxSteps: number }; output: AdvanceResult };
  releaseDriver: { input: { lease: DriverLease }; output: { released: boolean } };
  checkpointRun: { input: { runId: Id }; output: { checkpoint: ArtifactRef; physicalStateHash: Hash } };
  createExperiment: { input: { spec: ExperimentSpec }; output: { experimentId: Id; workId: Id } };
  recordExperimentProgress: { input: { experimentId: Id; lease: WorkLease;
    report: ExperimentReport }; output: { revision: number } };
  issueShare: { input: { runId: Id; access: 'viewer' | 'operator'; tokenHash: Hash;
    expiresAtEpochMs: number }; output: { grantId: Id } };
  redeemShare: { input: { token: string }; output: { runId: Id; role: 'viewer' | 'operator' } };
  revokeShare: { input: { grantId: Id }; output: { revoked: boolean } };
};
export type Queries = {
  capabilities: { input: Record<string, never>; output: Capabilities };
  session: { input: Record<string, never>; output: { identity: string; roles: Role[]; runIds: Id[] } };
  listParks: { input: { cursor: string | null }; output: Page<ParkSummary> };
  getRun: { input: { runId: Id }; output: RunView };
  getManifest: { input: { runId: Id }; output: RunManifest };
  getLiveSnapshot: { input: { runId: Id }; output: LiveSnapshot };
  getAgent: { input: { runId: Id; agentId: Id }; output: AgentDetail };
  getDecision: { input: { runId: Id; evidenceId: Id }; output: AppliedDecision };
  getWork: { input: { workId: Id }; output: WorkStatus };
  getMetrics: { input: { runId: Id; fromMs: SimMs; toMs: SimMs; cursor: string | null };
    output: Page<MetricSnapshot> };
  getEvents: { input: { runId: Id; afterSequence: number; limit: number }; output: SequencePage<EventRecord> };
  getHeatmap: { input: { runId: Id; layer: HeatLayer; fromMs: SimMs; toMs: SimMs }; output: Heatmap };
  getFrames: { input: { runId: Id; fromMs: SimMs; toMs: SimMs; cursor: string | null };
    output: Page<ReplayFrame> };
  getExperiment: { input: { experimentId: Id }; output: ExperimentReport };
  getFactBundle: { input: { runId: Id | null; experimentId: Id | null }; output: FactBundle };
};
export type RuntimeConfig = {
  uri: string; database: string; token: string | null;
  onToken?: (token: string) => void;
};
export interface RuntimeClient {
  readonly contractVersion: ContractVersion;
  command<K extends keyof Commands>(name: K, input: Commands[K]['input'],
    commandId: Id): Promise<Receipt<Commands[K]['output']>>;
  query<K extends keyof Queries>(name: K, input: Queries[K]['input']): Promise<Queries[K]['output']>;
  subscribeLive(runId: Id, handlers: {
    snapshot: (value: LiveSnapshot) => void; patch: (value: LivePatch) => void;
    status: (value: 'connecting' | 'live' | 'reconnecting' | 'closed') => void;
    error: (value: DomainError) => void;
  }): () => void;
  subscribeWorkAvailable(kinds: WorkKind[], wake: () => void): () => void;
  putArtifact(input: { kind: ArtifactKind; mediaType: string; bytes: Uint8Array;
    scope: Scope; commandId: Id }): Promise<ArtifactRef>;
  getArtifact(ref: ArtifactRef): Promise<Uint8Array>;
  close(): Promise<void>;
}
export type CreateRuntimeClient = (config: RuntimeConfig) => Promise<RuntimeClient>;
