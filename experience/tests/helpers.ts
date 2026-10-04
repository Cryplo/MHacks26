import type { AgentView, EventRecord, LivePatch, LiveSnapshot, MetricSnapshot, RunView } from '../contract/behavior-v1';
import conformance from '../fixtures/conformance-fixtures.json';

export const metrics = (runId = 'r1', simMs = 0, revision = 1): MetricSnapshot => ({ ...(conformance.metricSnapshot as MetricSnapshot), runId, simMs, revision });

export const run = (revision: number, over: Partial<RunView> = {}): RunView => ({
  runId: 'r1', revision, controlRevision: 0, manifestHash: 'a'.repeat(64), mode: 'mock', status: 'running', simMs: revision * 5000,
  stepIndex: revision, phase: 'persist', scenarioRevision: '1', earliestSchedulableMs: revision * 5000 + 5000, requestedSpeed: 10, achievedSpeed: 10,
  blockedWorkIds: [], quality: { comparisonEligible: true, reasons: [], behaviorCounts: { jev: 0, cache: 0, mock: 1, fallback: 0 }, invalidAttempts: 0, staleAttempts: 0, pendingRatings: 0, terminalRatingsExpected: 0, terminalRatingsComplete: 0 },
  ...over,
});

export const agent = (id: string, x: number, y = 10, over: Partial<AgentView> = {}): AgentView => ({
  agentId: id, groupId: 'g1', position: { xM: x, yM: y }, velocity: { xMps: 0, yMps: 0 }, state: 'walking', targetPlaceId: null,
  needs: { hunger: 10, fatigue: 10, patience: 80, fun: 50 }, experienceValue: 0, rating: null, latestEvidenceId: null, ...over,
});

export const event = (sequence: number, over: Partial<EventRecord> = {}): EventRecord => ({
  eventId: `e${sequence}`, runId: 'r1', sequence, atMs: sequence * 1000, kind: 'arrived', groupId: 'g1', agentIds: ['a1'], placeId: null, position: null,
  causationId: null, amountCents: null, experienceDelta: null, reason: null, details: {}, ...over,
});

export const snapshot = (revision: number, agents: AgentView[], over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  contractVersion: 'behavior.v1', run: run(revision), agents, places: [], queues: [], metrics: metrics('r1', revision * 5000, revision),
  health: { queuedWork: 0, leasedWork: 0, oldestRequestAgeMs: 0, httpP95Ms: null, reducerP95Ms: null, calls: 0, inputTokens: 0, estimatedCostUsd: null, tokenCoverage: 1, warnings: [] },
  recentEvents: [], ...over,
});

export const patch = (from: number, to: number, upsert: AgentView[] = [], over: Partial<LivePatch> = {}): LivePatch => ({
  runId: 'r1', fromRevision: from, toRevision: to, run: run(to), agents: { upsert, removeIds: [] }, places: [], queues: [], metrics: null, health: null, appendedEvents: [], ...over,
});
