/**
 * SCRIPTED PROTOCOL FIXTURE - orchestration-only.
 *
 * Implements the RuntimeClient port with durable receipts, leases, roles and scripted run
 * barriers so Intelligence can test retries, recovery and orchestration offline. It is NOT a
 * simulation: it never samples actions, moves guests or computes behavioral outcomes. Metric
 * snapshots come from the script supplied by the test. Any report produced against this port
 * is labeled orchestration-only.
 */
import type {
  AdvanceResult, ArtifactKind, ArtifactRef, Capabilities, Commands, CompletedWork, DecisionRequest, DecisionResult,
  DomainError, DriverLease, ExperimentReport, FactBundle, Id, LeasedWork, LiveSnapshot, MetricSnapshot, ProviderAttempt,
  Queries, RatingRequest, RatingResult, Receipt, Role, RunManifest, RunView, RuntimeClient, Scope, Source,
  WorkKind, WorkLease, WorkPayloads, WorkStatus,
} from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { hashCanonical, sha256Hex } from '../core/canonical.ts';
import { domainError, runtimeClientError } from '../core/errors.ts';
import type { Clock } from './clock.ts';

export const WORKER_KINDS: readonly WorkKind[] = ['decision', 'rating', 'population', 'parse_crowd', 'parse_scenario', 'thought', 'report'];
export const COORDINATOR_KINDS: readonly WorkKind[] = ['experiment'];

type WorkRecord = {
  workId: Id; kind: WorkKind; scope: Scope; payload: WorkPayloads[WorkKind];
  status: WorkStatus['status']; attempt: number; lease: WorkLease | null;
  result: unknown; error: DomainError | null; retryAtEpochMs: number | null;
  completions: { attempt: number; leaseToken: string }[];
};

/** Scripted run behaviour. Barriers and metrics are inputs from the test, not simulated. */
export type RunScript = {
  totalSteps: number;
  /** Decision requests that form a barrier before `step` can be advanced. */
  barriers?: Record<number, (runId: Id) => DecisionRequest[]>;
  /** Terminal rating requests enqueued once the physical horizon completes. */
  terminalRatings?: (runId: Id) => RatingRequest[];
  /** Metric snapshot from applied decision results and completed ratings. */
  metrics: (ctx: { runId: Id; manifest: RunManifest; decisions: DecisionResult[]; ratings: RatingResult[]; terminalExpected: number }) => MetricSnapshot;
};

type RunRecord = {
  runId: Id; manifest: RunManifest; script: RunScript; owner: string;
  view: RunView; step: number; startStep: number; driver: DriverLease | null; driverEpoch: number;
  barrierWork: Map<number, Id[]>; appliedDecisions: DecisionResult[]; ratingWork: Id[];
  stateHash: string; advances: number;
};

type ExperimentRecord = { experimentId: Id; workId: Id; reports: ExperimentReport[]; owner: string };

export type FaultPlan = {
  /** Apply the command but lose the acknowledgement (transport error) this many times. */
  dropAck?: Partial<Record<keyof Commands, number>>;
  /** Fail before applying (transport error) this many times. */
  failBefore?: Partial<Record<keyof Commands, number>>;
  /** Drop work-available notifications. */
  dropNotifications?: boolean;
};

export type FakeRuntimeOptions = {
  clock: Clock;
  capabilities?: Partial<Capabilities>;
  runScript?: (manifest: RunManifest) => RunScript;
  identities: Record<string, Role[]>;
};

export class FakeRuntimeServer {
  readonly receipts = new Map<string, { payloadHash: string; receipt: Receipt<unknown> }>();
  readonly work = new Map<Id, WorkRecord>();
  readonly attempts = new Map<Id, ProviderAttempt>();
  readonly attemptLog: ProviderAttempt[] = [];
  readonly artifacts = new Map<Id, { ref: ArtifactRef; bytes: Uint8Array; owner: string; scope: Scope }>();
  readonly runs = new Map<Id, RunRecord>();
  readonly experiments = new Map<Id, ExperimentRecord>();
  readonly commandLog: { identity: string; name: string; commandId: Id; applied: boolean }[] = [];
  faults: FaultPlan = {};
  private seq = 0;
  private listeners = new Set<{ kinds: WorkKind[]; wake: () => void }>();
  readonly capabilities: Capabilities;

  constructor(readonly options: FakeRuntimeOptions) {
    this.capabilities = {
      contractVersion: CONTRACT_VERSION,
      eventKinds: ['pass_price', 'pass_share', 'board', 'notice', 'closure', 'show_schedule', 'app_message'],
      workKinds: ['population', 'parse_crowd', 'parse_scenario', 'thought', 'report'],
      features: { routeChoice: false, bumpReactions: false, splitGroups: false, speechBubbles: false, discountMessages: false },
      maxGuests: 400, maxArtifactBytes: 32 * 1024 * 1024, maxChunkBytes: 1024 * 1024,
      ...options.capabilities,
    };
  }

  private nextId(prefix: string): Id { return `${prefix}-${++this.seq}`; }
  private now(): number { return this.options.clock.nowEpochMs(); }

  client(identity: string): FakeRuntimeClient {
    if (!this.options.identities[identity]) throw new Error(`unknown fixture identity ${identity}`);
    return new FakeRuntimeClient(this, identity);
  }

  roles(identity: string): Role[] { return this.options.identities[identity] ?? []; }

  // ---------- test controls (not part of the port) ----------

  enqueueWork<K extends WorkKind>(kind: K, payload: WorkPayloads[K], scope: Scope = { runId: null, experimentId: null }, workId?: Id): Id {
    const id = workId ?? this.nextId(`work-${kind}`);
    this.work.set(id, {
      workId: id, kind, scope, payload, status: 'pending', attempt: 0, lease: null,
      result: null, error: null, retryAtEpochMs: null, completions: [],
    });
    this.notify(kind);
    return id;
  }

  setStatus(workId: Id, status: WorkStatus['status']): void {
    const w = this.mustWork(workId);
    w.status = status;
    if (status === 'pending') w.lease = null;
  }

  /** Expire every outstanding lease immediately (simulates lease timeout). */
  expireLease(workId: Id): void {
    const w = this.mustWork(workId);
    if (w.lease) w.lease = { ...w.lease, expiresAtEpochMs: this.now() - 1 };
  }

  private mustWork(id: Id): WorkRecord {
    const w = this.work.get(id);
    if (!w) throw new Error(`no work ${id}`);
    return w;
  }

  private notify(kind: WorkKind): void {
    if (this.faults.dropNotifications) return;
    for (const l of this.listeners) if (l.kinds.includes(kind)) queueMicrotask(l.wake);
  }

  subscribe(kinds: WorkKind[], wake: () => void): () => void {
    const entry = { kinds, wake };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  // ---------- command dispatch with durable receipts ----------

  async command<K extends keyof Commands>(identity: string, name: K, input: Commands[K]['input'], commandId: Id): Promise<Receipt<Commands[K]['output']>> {
    const failBefore = this.faults.failBefore?.[name] ?? 0;
    if (failBefore > 0) {
      this.faults.failBefore![name] = failBefore - 1;
      throw runtimeClientError(domainError('DEPENDENCY_UNAVAILABLE', `transport failure before ${name}`, true), true);
    }
    const key = `${identity}\u0000${commandId}`;
    const payloadHash = hashCanonical({ name, input });
    const prior = this.receipts.get(key);
    let receipt: Receipt<Commands[K]['output']>;
    if (prior) {
      receipt = prior.payloadHash === payloadHash
        ? prior.receipt as Receipt<Commands[K]['output']>
        : { commandId, ok: false, error: domainError('CONFLICT', 'command id reused with a different payload') };
      this.commandLog.push({ identity, name, commandId, applied: false });
    } else {
      let result: Commands[K]['output'] | DomainError;
      try {
        result = this.apply(identity, name, input);
      } catch (e) {
        // Unexpected internal failure: surfaced as a non-transport error, no receipt stored.
        throw runtimeClientError(domainError('INTERNAL', (e as Error).message), false);
      }
      receipt = isDomainError(result) ? { commandId, ok: false, error: result } : { commandId, ok: true, result };
      this.receipts.set(key, { payloadHash, receipt });
      this.commandLog.push({ identity, name, commandId, applied: true });
    }
    const drop = this.faults.dropAck?.[name] ?? 0;
    if (drop > 0) {
      this.faults.dropAck![name] = drop - 1;
      throw runtimeClientError(domainError('DEPENDENCY_UNAVAILABLE', `acknowledgement lost for ${name}`, true), true);
    }
    return structuredClone(receipt);
  }

  private apply<K extends keyof Commands>(identity: string, name: K, input: Commands[K]['input']): Commands[K]['output'] | DomainError {
    const roles = this.roles(identity);
    const has = (...r: Role[]) => r.some((x) => roles.includes(x));
    const forbidden = () => domainError('FORBIDDEN', `${identity} may not call ${name}`);
    const i = input as never as Record<string, never>;
    switch (name) {
      case 'claimWork': return this.claim(identity, roles, i as unknown as Commands['claimWork']['input']) as never;
      case 'renewWork': return this.renew(identity, i as unknown as Commands['renewWork']['input']) as never;
      case 'completeWork': return this.complete(identity, (i as unknown as Commands['completeWork']['input']).item) as never;
      case 'failWork': return this.failWork(identity, i as unknown as Commands['failWork']['input']) as never;
      case 'recordProviderAttempt': {
        if (!has('worker', 'coordinator')) return forbidden();
        return this.recordAttempt((i as unknown as Commands['recordProviderAttempt']['input']).attempt) as never;
      }
      case 'createRun': {
        if (!has('operator', 'coordinator')) return forbidden();
        return this.createRun(identity, roles, (i as unknown as Commands['createRun']['input']).manifest) as never;
      }
      case 'startRun': {
        if (!has('operator', 'coordinator')) return forbidden();
        const run = this.runs.get((i as unknown as { runId: Id }).runId);
        if (!run) return domainError('NOT_FOUND', 'run not found');
        if (run.view.status === 'ready') run.view = { ...run.view, status: 'running', revision: run.view.revision + 1, controlRevision: run.view.controlRevision + 1 };
        return structuredClone(run.view) as never;
      }
      case 'cancelRun': {
        if (!has('operator', 'coordinator')) return forbidden();
        const { runId, expectedControlRevision } = i as unknown as Commands['cancelRun']['input'];
        const run = this.runs.get(runId);
        if (!run) return domainError('NOT_FOUND', 'run not found');
        if (run.view.controlRevision !== expectedControlRevision) return domainError('STALE_REVISION', 'control revision changed');
        run.view = { ...run.view, status: 'cancelled', revision: run.view.revision + 1, controlRevision: run.view.controlRevision + 1 };
        run.driver = null;
        return structuredClone(run.view) as never;
      }
      case 'acquireDriver': return this.acquireDriver(identity, roles, i as unknown as Commands['acquireDriver']['input']) as never;
      case 'renewDriver': return this.renewDriver(i as unknown as Commands['renewDriver']['input']) as never;
      case 'releaseDriver': {
        const { lease } = i as unknown as Commands['releaseDriver']['input'];
        const run = this.runs.get(lease.runId);
        if (!run || !run.driver || run.driver.token !== lease.token) return { released: false } as never;
        run.driver = null;
        return { released: true } as never;
      }
      case 'advanceRun': return this.advance(i as unknown as Commands['advanceRun']['input']) as never;
      case 'checkpointRun': {
        if (!has('coordinator', 'operator')) return forbidden();
        const run = this.runs.get((i as unknown as { runId: Id }).runId);
        if (!run) return domainError('NOT_FOUND', 'run not found');
        const body = new TextEncoder().encode(JSON.stringify({ fixture: 'orchestration-only checkpoint', runId: run.runId, step: run.step, stateHash: run.stateHash }));
        const ref = this.storeArtifact(identity, 'checkpoint', 'application/json', body, { runId: run.runId, experimentId: null });
        return { checkpoint: ref, physicalStateHash: run.stateHash } as never;
      }
      case 'createExperiment': {
        if (!has('operator')) return forbidden();
        const { spec } = i as unknown as Commands['createExperiment']['input'];
        if (this.experiments.has(spec.experimentId)) return domainError('CONFLICT', 'experiment exists');
        const workId = this.enqueueWork('experiment', spec, { runId: null, experimentId: spec.experimentId });
        this.experiments.set(spec.experimentId, { experimentId: spec.experimentId, workId, reports: [], owner: identity });
        return { experimentId: spec.experimentId, workId } as never;
      }
      case 'recordExperimentProgress': {
        if (!has('coordinator')) return forbidden();
        const { experimentId, lease, report } = i as unknown as Commands['recordExperimentProgress']['input'];
        const exp = this.experiments.get(experimentId);
        if (!exp) return domainError('NOT_FOUND', 'experiment not found');
        const check = this.checkLease(identity, lease);
        if (check) return check;
        if (lease.workId !== exp.workId) return domainError('FORBIDDEN', 'lease is not for this experiment');
        const revision = exp.reports.length + 1;
        exp.reports.push({ ...structuredClone(report), revision });
        return { revision } as never;
      }
      case 'requestProductWork': {
        if (!has('operator', 'viewer')) return forbidden();
        const { request } = i as unknown as Commands['requestProductWork']['input'];
        if (request.kind === 'thought' && !has('operator', 'viewer')) return forbidden();
        if (request.kind !== 'thought' && !has('operator')) return forbidden();
        return { workId: this.enqueueProductWork(request) } as never;
      }
      case 'scheduleEvents': case 'pauseRun': case 'resumeRun': case 'setSpeed': case 'registerPark':
      case 'issueShare': case 'redeemShare': case 'revokeShare':
        if (!has('operator')) return forbidden();
        return domainError('UNSUPPORTED', `${name} is outside the fixture's scripted surface`);
    }
    return domainError('UNSUPPORTED', `unknown command ${String(name)}`);
  }

  private enqueueProductWork(request: Commands['requestProductWork']['input']['request']): Id {
    switch (request.kind) {
      case 'population': return this.enqueueWork('population', { crowd: request.crowd, park: request.park, closeAfterMs: 8 * 3_600_000 });
      case 'parse_crowd': return this.enqueueWork('parse_crowd', { text: request.text, current: request.current });
      default: throw new Error(`fixture does not script product work ${request.kind}`);
    }
  }

  private claim(identity: string, roles: Role[], input: Commands['claimWork']['input']): Commands['claimWork']['output'] | DomainError {
    const allowed = new Set<WorkKind>([
      ...(roles.includes('worker') ? WORKER_KINDS : []),
      ...(roles.includes('coordinator') ? COORDINATOR_KINDS : []),
    ]);
    const bad = input.kinds.filter((k) => !allowed.has(k));
    if (bad.length) return domainError('FORBIDDEN', `identity may not claim ${bad.join(',')}`);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 64) return domainError('INVALID_INPUT', 'limit out of range');
    if (!(input.leaseMs >= 1000 && input.leaseMs <= 600_000)) return domainError('INVALID_INPUT', 'leaseMs out of range');
    const now = this.now();
    const items: LeasedWork[] = [];
    for (const w of this.work.values()) {
      if (items.length >= input.limit) break;
      if (!input.kinds.includes(w.kind)) continue;
      const expired = w.status === 'leased' && w.lease !== null && w.lease.expiresAtEpochMs <= now;
      const claimable = (w.status === 'pending' && (w.retryAtEpochMs === null || w.retryAtEpochMs <= now)) || expired;
      if (!claimable) continue;
      w.attempt += 1;
      w.status = 'leased';
      w.lease = {
        workId: w.workId, attempt: w.attempt, leaseToken: sha256Hex(`${w.workId}:${w.attempt}:${input.workerNonce}`).slice(0, 32),
        expiresAtEpochMs: now + input.leaseMs, ownerIdentity: identity,
      };
      items.push({ kind: w.kind, scope: w.scope, lease: { ...w.lease }, payload: structuredClone(w.payload) } as LeasedWork);
    }
    return { items };
  }

  private checkLease(identity: string, lease: WorkLease): DomainError | null {
    const w = this.work.get(lease.workId);
    if (!w) return domainError('NOT_FOUND', 'work not found');
    if (w.status === 'superseded' || w.status === 'cancelled') return domainError('INVALID_STATE', `work is ${w.status}`);
    if (!w.lease || w.lease.leaseToken !== lease.leaseToken || w.lease.attempt !== lease.attempt || w.lease.ownerIdentity !== identity) {
      return domainError('STALE_LEASE', 'The work lease was replaced.');
    }
    if (w.status !== 'leased') return domainError('INVALID_STATE', `work is ${w.status}`);
    if (w.lease.expiresAtEpochMs <= this.now()) return domainError('STALE_LEASE', 'lease expired');
    return null;
  }

  private renew(identity: string, input: Commands['renewWork']['input']): Commands['renewWork']['output'] {
    const leases: WorkLease[] = [];
    for (const l of input.leases) {
      if (this.checkLease(identity, l)) continue;
      const w = this.work.get(l.workId)!;
      w.lease = { ...w.lease!, expiresAtEpochMs: this.now() + input.leaseMs };
      leases.push({ ...w.lease });
    }
    return { leases };
  }

  private complete(identity: string, item: CompletedWork): Commands['completeWork']['output'] | DomainError {
    const err = this.checkLease(identity, item.lease);
    if (err) return err;
    const w = this.work.get(item.lease.workId)!;
    if (item.kind !== w.kind) return domainError('INVALID_INPUT', 'kind mismatch');
    if (w.kind === 'decision') {
      const req = w.payload as DecisionRequest; const res = item.result as DecisionResult;
      if (res.requestId !== req.requestId || res.observationHash !== req.observationHash || res.optionsHash !== req.optionsHash) {
        return domainError('INVALID_INPUT', 'decision result identity does not match request');
      }
    }
    if (w.kind === 'rating') {
      const req = w.payload as RatingRequest; const res = item.result as RatingResult;
      if (res.ratingId !== req.ratingId || res.evidenceHash !== req.evidenceHash || res.rubricVersion !== req.rubricVersion) {
        return domainError('INVALID_INPUT', 'rating result identity does not match request');
      }
    }
    w.status = 'ready';
    w.result = structuredClone(item.result);
    w.completions.push({ attempt: item.lease.attempt, leaseToken: item.lease.leaseToken });
    return { workId: w.workId, status: w.status };
  }

  private failWork(identity: string, input: Commands['failWork']['input']): Commands['failWork']['output'] | DomainError {
    const err = this.checkLease(identity, input.lease);
    if (err) return err;
    const w = this.work.get(input.lease.workId)!;
    w.error = input.error;
    w.lease = null;
    if (input.error.retryable && input.retryAtEpochMs !== null) { w.status = 'pending'; w.retryAtEpochMs = input.retryAtEpochMs; }
    else w.status = 'failed';
    return { workId: w.workId, status: w.status };
  }

  private recordAttempt(a: ProviderAttempt): Commands['recordProviderAttempt']['output'] | DomainError {
    const prior = this.attempts.get(a.callId);
    if (prior?.phase === 'finished' && a.phase === 'started') return { callId: a.callId, phase: 'finished' };
    if (prior && prior.phase === a.phase) return { callId: a.callId, phase: a.phase };
    this.attempts.set(a.callId, structuredClone(a));
    this.attemptLog.push(structuredClone(a));
    return { callId: a.callId, phase: a.phase };
  }

  // ---------- runs and drivers (scripted, not simulated) ----------

  private createRun(identity: string, roles: Role[], manifest: RunManifest): Commands['createRun']['output'] | DomainError {
    if (roles.includes('coordinator') && !roles.includes('operator') && !manifest.experiment) {
      return domainError('FORBIDDEN', 'coordinator may only create experiment child runs');
    }
    if (manifest.contractVersion !== CONTRACT_VERSION) return domainError('INVALID_INPUT', 'contract version');
    if (!this.artifacts.has(manifest.population.artifactId)) return domainError('NOT_FOUND', 'population artifact not found');
    const script = this.options.runScript?.(manifest);
    if (!script) return domainError('UNSUPPORTED', 'no run script configured for this fixture');
    const runId = this.nextId('run');
    let startStep = 0;
    let stateHash = hashCanonical({ fixture: 'state', population: manifest.population.sha256, step: 0, applied: [] });
    if (manifest.initialCheckpoint) {
      const cp = this.artifacts.get(manifest.initialCheckpoint.artifactId);
      if (!cp) return domainError('NOT_FOUND', 'checkpoint not found');
      const parsed = JSON.parse(new TextDecoder().decode(cp.bytes)) as { step: number; stateHash: string; runId: Id };
      const source = this.runs.get(parsed.runId);
      if (source && source.manifest.population.sha256 !== manifest.population.sha256) return domainError('INVALID_INPUT', 'checkpoint population differs');
      startStep = parsed.step; stateHash = parsed.stateHash;
    }
    const view: RunView = {
      runId, revision: 1, controlRevision: 1, manifestHash: hashCanonical(manifest), mode: manifest.config.mode,
      status: 'ready', simMs: startStep * 5000, stepIndex: startStep, phase: 'prepare', scenarioRevision: manifest.scenario.revision,
      earliestSchedulableMs: (startStep + 1) * 5000, requestedSpeed: manifest.config.requestedSpeed, achievedSpeed: 0,
      blockedWorkIds: [], quality: this.quality([], [], 0, 0),
    };
    this.runs.set(runId, {
      runId, manifest: structuredClone(manifest), script, owner: identity, view, step: startStep, startStep,
      driver: null, driverEpoch: 0, barrierWork: new Map(), appliedDecisions: [], ratingWork: [], stateHash, advances: 0,
    });
    return { runId };
  }

  private quality(decisions: DecisionResult[], ratings: RatingResult[], expected: number, pendingRatings: number) {
    const behaviorCounts: Record<Source, number> = { jev: 0, cache: 0, mock: 0, fallback: 0 };
    for (const d of decisions) behaviorCounts[d.source] += 1;
    const reasons = behaviorCounts.fallback > 0 ? ['fallback decisions applied'] : [];
    return {
      comparisonEligible: reasons.length === 0, reasons, behaviorCounts, invalidAttempts: 0, staleAttempts: 0,
      pendingRatings, terminalRatingsExpected: expected, terminalRatingsComplete: ratings.length,
    };
  }

  private acquireDriver(identity: string, roles: Role[], input: Commands['acquireDriver']['input']): DriverLease | DomainError {
    if (!roles.includes('coordinator') && !roles.includes('operator')) return domainError('FORBIDDEN', 'not a driver role');
    const run = this.runs.get(input.runId);
    if (!run) return domainError('NOT_FOUND', 'run not found');
    if (run.driver && run.driver.expiresAtEpochMs > this.now()) return domainError('CONFLICT', 'run already has an active driver');
    run.driverEpoch += 1;
    run.driver = { runId: run.runId, epoch: run.driverEpoch, token: sha256Hex(`${run.runId}:driver:${run.driverEpoch}:${identity}`).slice(0, 32), expiresAtEpochMs: this.now() + input.leaseMs };
    return { ...run.driver };
  }

  private renewDriver(input: Commands['renewDriver']['input']): DriverLease | DomainError {
    const run = this.runs.get(input.lease.runId);
    if (!run?.driver || run.driver.token !== input.lease.token || run.driver.epoch !== input.lease.epoch) return domainError('STALE_LEASE', 'driver lease replaced');
    if (run.driver.expiresAtEpochMs <= this.now()) return domainError('STALE_LEASE', 'driver lease expired');
    run.driver = { ...run.driver, expiresAtEpochMs: this.now() + input.leaseMs };
    return { ...run.driver };
  }

  private advance(input: Commands['advanceRun']['input']): AdvanceResult | DomainError {
    const run = this.runs.get(input.lease.runId);
    if (!run) return domainError('NOT_FOUND', 'run not found');
    if (!run.driver || run.driver.token !== input.lease.token || run.driver.epoch !== input.lease.epoch || run.driver.expiresAtEpochMs <= this.now()) {
      return domainError('STALE_LEASE', 'driver lease is not current');
    }
    if (['cancelled', 'failed', 'completed'].includes(run.view.status)) return domainError('INVALID_STATE', `run is ${run.view.status}`);
    if (run.step !== input.expectedStep || run.view.phase !== input.expectedPhase) return domainError('STALE_REVISION', `run is at step ${run.step}/${run.view.phase}`);
    run.advances += 1;
    let completed = 0;
    while (completed < input.maxSteps && run.step < run.script.totalSteps) {
      const barrier = run.script.barriers?.[run.step];
      if (barrier) {
        let ids = run.barrierWork.get(run.step);
        if (!ids) {
          ids = barrier(run.runId).map((req) => this.enqueueWork('decision', req, { runId: run.runId, experimentId: run.manifest.experiment?.experimentId ?? null }));
          run.barrierWork.set(run.step, ids);
        }
        const waiting = ids.filter((id) => this.work.get(id)!.status !== 'ready' && this.work.get(id)!.status !== 'applied');
        const failed = ids.filter((id) => this.work.get(id)!.status === 'failed');
        if (failed.length) {
          run.view = { ...run.view, status: 'failed', revision: run.view.revision + 1 };
          return this.advanceResult(run, completed, failed);
        }
        if (waiting.length) {
          run.view = { ...run.view, status: 'blocked', phase: 'prepare', blockedWorkIds: waiting, revision: run.view.revision + 1 };
          return this.advanceResult(run, completed, waiting);
        }
        for (const id of ids) {
          const w = this.work.get(id)!;
          if (w.status === 'ready') { w.status = 'applied'; run.appliedDecisions.push(w.result as DecisionResult); }
        }
      }
      run.step += 1;
      completed += 1;
      run.stateHash = hashCanonical({
        fixture: 'state', population: run.manifest.population.sha256, step: run.step,
        applied: run.appliedDecisions.map((d) => [d.requestId, d.probabilities]),
      });
    }
    if (run.step >= run.script.totalSteps && run.view.status !== 'completed') {
      const ratings = run.script.terminalRatings?.(run.runId) ?? [];
      run.ratingWork = ratings.map((r) => this.enqueueWork('rating', r, { runId: run.runId, experimentId: run.manifest.experiment?.experimentId ?? null }));
      run.view = { ...run.view, status: 'completed', phase: 'persist' };
    } else if (run.view.status !== 'completed') {
      run.view = { ...run.view, status: 'running', phase: 'prepare', blockedWorkIds: [] };
    }
    run.view = { ...run.view, revision: run.view.revision + 1, simMs: run.step * 5000, stepIndex: run.step };
    return this.advanceResult(run, completed, []);
  }

  private advanceResult(run: RunRecord, completedSteps: number, blocked: Id[]): AdvanceResult {
    run.view = { ...run.view, simMs: run.step * 5000, stepIndex: run.step, earliestSchedulableMs: (run.step + 1) * 5000 };
    this.refreshQuality(run);
    return { run: structuredClone(run.view), completedSteps, physicalStateHash: run.stateHash, blockedWorkIds: blocked };
  }

  private refreshQuality(run: RunRecord): void {
    const ratings = run.ratingWork.map((id) => this.work.get(id)!).filter((w) => w.status === 'ready').map((w) => w.result as RatingResult);
    const pending = run.ratingWork.length - ratings.length;
    run.view = { ...run.view, quality: this.quality(run.appliedDecisions, ratings, run.ratingWork.length, pending) };
  }

  metricsFor(runId: Id): MetricSnapshot {
    const run = this.runs.get(runId);
    if (!run) throw runtimeClientError(domainError('NOT_FOUND', 'run not found'), false);
    const ratings = run.ratingWork.map((id) => this.work.get(id)!).filter((w) => w.status === 'ready').map((w) => w.result as RatingResult);
    return run.script.metrics({ runId, manifest: run.manifest, decisions: run.appliedDecisions, ratings, terminalExpected: run.ratingWork.length });
  }

  // ---------- artifacts ----------

  storeArtifact(owner: string, kind: ArtifactKind, mediaType: string, bytes: Uint8Array, scope: Scope): ArtifactRef {
    const sha = sha256Hex(bytes);
    if (bytes.byteLength > this.capabilities.maxArtifactBytes) throw runtimeClientError(domainError('INVALID_INPUT', 'artifact too large'), false);
    const ref: ArtifactRef = { artifactId: `art-${kind}-${sha.slice(0, 24)}`, kind, sha256: sha, byteLength: bytes.byteLength, mediaType, contractVersion: CONTRACT_VERSION };
    if (!this.artifacts.has(ref.artifactId)) this.artifacts.set(ref.artifactId, { ref, bytes: new Uint8Array(bytes), owner, scope });
    return ref;
  }

  // ---------- queries ----------

  query<K extends keyof Queries>(identity: string, name: K, input: Queries[K]['input']): Queries[K]['output'] {
    const i = input as Record<string, unknown>;
    switch (name) {
      case 'capabilities': return structuredClone(this.capabilities) as never;
      case 'session': return { identity, roles: this.roles(identity), runIds: [...this.runs.keys()] } as never;
      case 'getRun': {
        const run = this.runs.get(i.runId as Id);
        if (!run) throw runtimeClientError(domainError('NOT_FOUND', 'run not found'), false);
        this.refreshQuality(run);
        return structuredClone(run.view) as never;
      }
      case 'getManifest': {
        const run = this.runs.get(i.runId as Id);
        if (!run) throw runtimeClientError(domainError('NOT_FOUND', 'run not found'), false);
        return structuredClone(run.manifest) as never;
      }
      case 'getWork': {
        const w = this.work.get(i.workId as Id);
        if (!w) throw runtimeClientError(domainError('NOT_FOUND', 'work not found'), false);
        return { workId: w.workId, kind: w.kind, status: w.status, result: structuredClone(w.result) ?? null, error: w.error } as never;
      }
      case 'getMetrics': {
        const snap = this.metricsFor(i.runId as Id);
        return { items: [snap], nextCursor: null } as never;
      }
      case 'getExperiment': {
        const exp = this.experiments.get(i.experimentId as Id);
        const last = exp?.reports.at(-1);
        if (!last) throw runtimeClientError(domainError('NOT_FOUND', 'experiment has no progress'), false);
        return structuredClone(last) as never;
      }
      case 'getFactBundle': {
        const runId = i.runId as Id | null;
        if (!runId) throw runtimeClientError(domainError('UNSUPPORTED', 'experiment fact bundles are owned by Intelligence'), false);
        const snap = this.metricsFor(runId);
        const bundle: FactBundle = {
          contractVersion: CONTRACT_VERSION, id: `facts-${runId}`, asOfMs: snap.simMs, sourceHash: hashCanonical(snap),
          facts: Object.values(snap.measures).map((m) => ({
            id: `run.${runId}.${m.id}`, label: m.id, value: m.value ?? 'unavailable', unit: m.unit,
            denominator: m.denominator === null ? 'none' : String(m.denominator), scope: { runId, experimentId: null },
            sourceEventIds: [], metricId: m.id, limitations: ['orchestration-only fixture metric'],
          })),
          quality: this.runs.get(runId)!.view.quality, scope: { runId, experimentId: null },
        };
        return bundle as never;
      }
      case 'getLiveSnapshot': case 'getAgent': case 'getDecision': case 'getEvents': case 'getHeatmap':
      case 'getFrames': case 'listParks':
        throw runtimeClientError(domainError('UNSUPPORTED', `${name} is outside the fixture's scripted surface`), false);
    }
    throw runtimeClientError(domainError('UNSUPPORTED', `unknown query ${String(name)}`), false);
  }
}

function isDomainError(v: unknown): v is DomainError {
  return typeof v === 'object' && v !== null && 'code' in v && 'retryable' in v && 'fieldErrors' in v && 'message' in v;
}

export class FakeRuntimeClient implements RuntimeClient {
  readonly contractVersion = CONTRACT_VERSION;
  private closed = false;
  constructor(readonly server: FakeRuntimeServer, readonly identity: string) {}

  private guard(): void {
    if (this.closed) throw runtimeClientError(domainError('DEPENDENCY_UNAVAILABLE', 'client closed', false), true);
  }

  async command<K extends keyof Commands>(name: K, input: Commands[K]['input'], commandId: Id): Promise<Receipt<Commands[K]['output']>> {
    this.guard();
    await Promise.resolve();
    return this.server.command(this.identity, name, structuredClone(input), commandId);
  }

  async query<K extends keyof Queries>(name: K, input: Queries[K]['input']): Promise<Queries[K]['output']> {
    this.guard();
    await Promise.resolve();
    return this.server.query(this.identity, name, input);
  }

  subscribeLive(_runId: Id, handlers: { status: (v: 'connecting' | 'live' | 'reconnecting' | 'closed') => void; snapshot: (v: LiveSnapshot) => void }): () => void {
    handlers.status('closed');
    return () => undefined;
  }

  subscribeWorkAvailable(kinds: WorkKind[], wake: () => void): () => void {
    this.guard();
    return this.server.subscribe(kinds, wake);
  }

  private artifactCommands = new Map<Id, ArtifactRef>();
  async putArtifact(input: { kind: ArtifactKind; mediaType: string; bytes: Uint8Array; scope: Scope; commandId: Id }): Promise<ArtifactRef> {
    this.guard();
    await Promise.resolve();
    const prior = this.artifactCommands.get(input.commandId);
    if (prior) return prior;
    const ref = this.server.storeArtifact(this.identity, input.kind, input.mediaType, input.bytes, input.scope);
    this.artifactCommands.set(input.commandId, ref);
    return ref;
  }

  async getArtifact(ref: ArtifactRef): Promise<Uint8Array> {
    this.guard();
    await Promise.resolve();
    const a = this.server.artifacts.get(ref.artifactId);
    if (!a || a.ref.sha256 !== ref.sha256) throw runtimeClientError(domainError('NOT_FOUND', 'artifact not found'), false);
    const roles = this.server.roles(this.identity);
    if (a.ref.kind === 'model_response' && !roles.includes('worker') && !roles.includes('coordinator') && a.owner !== this.identity) {
      throw runtimeClientError(domainError('FORBIDDEN', 'private response artifact'), false);
    }
    return new Uint8Array(a.bytes);
  }

  async close(): Promise<void> { this.closed = true; }
}
