import type {
  AdvanceResult, ArtifactRef, DriverLease, ExperimentReport, ExperimentSpec, Hash, Id, MetricSnapshot, PairResult,
  ParkBundle, Quality, Receipt, RunManifest, RunView, RuntimeClient, Source,
} from '../../contract/behavior-v1.ts';
import { CONTRACT_VERSION } from '../../contract/behavior-v1.ts';
import { canonicalBytes, hashCanonical, sha256Hex } from '../core/canonical.ts';
import { validateMetricSnapshot } from '../core/validate.ts';
import { exportResponseTape } from '../cache/response-cache.ts';
import type { ResponseCache, ResponseTape } from '../cache/response-cache.ts';
import { generatePopulation } from '../population/index.ts';
import { parkContext } from '../population/park.ts';
import type { ProseProvider } from '../population/prose.ts';
import { composeReport } from '../reports/narrative.ts';
import type { Clock, Jitter, Logger } from '../runtime/clock.ts';
import { runCommand, artifactCommandId } from '../runtime/commands.ts';
import type { DurableStore } from '../runtime/store.ts';
import { getJson, putJson } from '../runtime/store.ts';
import type { Handler, HandlerContext } from '../worker/handlers.ts';
import { InvalidRequestError } from '../worker/inference.ts';
import type { UsageLedger } from '../worker/usage.ts';
import { preflightExperiment } from './preflight.ts';
import { buildExperimentFacts, buildReport, experimentNarrative, pairDeltas, validateReportShape } from './report.ts';
import type { ReportContext } from './report.ts';

export const COORDINATOR_VERSION = 'paired-coordinator-v1';

type ArmId = 'A' | 'B';
type ArmStatus = 'pending' | 'created' | 'started' | 'driven' | 'measured' | 'failed' | 'incomplete';
type ArmState = {
  runId: Id | null; status: ArmStatus; driver: DriverLease | null; startedAtEpochMs: number | null;
  initialHash: Hash | null; finalHash: Hash | null; metrics: MetricSnapshot | null; quality: Quality | null; reasons: string[];
};
type PairState = {
  pairId: Id; seed: string; status: PairResult['status']; reasons: string[];
  population: ArtifactRef | null; populationHash: Hash | null;
  warmup: null | { run: ArmState; checkpoint: ArtifactRef | null; hash: Hash | null };
  initialStateHash: Hash | null; arms: Record<ArmId, ArmState>;
};
export type ExperimentState = {
  schema: 'experiment-state.v1'; version: string; experimentId: Id; specHash: Hash;
  /** Work-lease attempt of the session that last took ownership (write fence). */
  ownerAttempt: number;
  pairs: PairState[]; progressSeq: number; phase: 'pairs' | 'aggregate' | 'done';
  artifacts: { report: ArtifactRef | null; facts: ArtifactRef | null; tape: ArtifactRef | null; narrative: ArtifactRef | null };
};

export type CoordinatorDeps = {
  client: RuntimeClient; store: DurableStore; clock: Clock; jitter: Jitter; logger: Logger;
  /** Shared response cache of co-located workers, used to export the experiment's response tape. */
  cache?: ResponseCache | null;
  /** Usage ledger of co-located workers (actual usage facts); null when not co-located. */
  ledger?: UsageLedger | null;
  prose?: ProseProvider | null;
  runtime: ReportContext['runtime'];
  /** Called while an arm is blocked, so a co-located worker can make progress (single-process mode). */
  waitHook?: () => Promise<void>;
  /** Test-only fault injection: throw to simulate a crash at a named phase. */
  faultAt?: (phase: string) => void | Promise<void>;
};

export type CoordinatorOptions = {
  driverLeaseMs: number; maxStepsPerAdvance: number; pollBaseMs: number; pollMaxMs: number; maxGuests: number;
};

export const DEFAULT_COORDINATOR_OPTIONS: CoordinatorOptions = { driverLeaseMs: 60_000, maxStepsPerAdvance: 24, pollBaseMs: 250, pollMaxMs: 5_000, maxGuests: 2000 };

class LeaseLost extends Error { override name = 'LeaseLost'; }

const newArm = (): ArmState => ({ runId: null, status: 'pending', driver: null, startedAtEpochMs: null, initialHash: null, finalHash: null, metrics: null, quality: null, reasons: [] });

export function experimentHandler(deps: CoordinatorDeps, options: Partial<CoordinatorOptions> = {}): Handler<'experiment'> {
  const opts = { ...DEFAULT_COORDINATOR_OPTIONS, ...options };
  return (spec, ctx) => new Session(deps, opts, spec, ctx).run();
}

/** One claim of an experiment job. All Engine commands use IDs derived from durable state. */
class Session {
  private state!: ExperimentState;
  private park!: ParkBundle;
  private readonly key: string;

  constructor(private readonly deps: CoordinatorDeps, private readonly opts: CoordinatorOptions, private readonly spec: ExperimentSpec, private readonly ctx: HandlerContext) {
    this.key = `experiments/${spec.experimentId}/state`;
  }

  private now() { return this.deps.clock.nowEpochMs(); }
  private async fault(phase: string) { await this.deps.faultAt?.(phase); }
  /** Fenced write: a session whose work lease was taken over must never overwrite the newer owner's state. */
  private async persist() {
    this.checkAlive();
    const stored = await getJson<ExperimentState>(this.deps.store, this.key);
    if (stored && stored.ownerAttempt > this.state.ownerAttempt) throw new LeaseLost(`state owned by newer attempt ${stored.ownerAttempt}`);
    await putJson(this.deps.store, this.key, this.state);
  }
  /** Revision of the runtime's published report when this coordinator first started. */
  private publishedRevision = 0;

  private cmdBase(pair: PairState, arm: string) { return `exp:${this.spec.experimentId}:${pair.pairId}:${arm}`; }

  private async command<K extends Parameters<RuntimeClient['command']>[0]>(name: K, input: Parameters<RuntimeClient['command']>[1] & object, commandId: Id) {
    this.checkAlive();
    return runCommand(this.deps.client, name, input as never, commandId, { clock: this.deps.clock, jitter: this.deps.jitter, logger: this.deps.logger, maxTransportRetries: 6 }) as Promise<Receipt<never>>;
  }

  private checkAlive() { if (this.ctx.signal.aborted) throw new LeaseLost(`experiment lease lost (${String(this.ctx.signal.reason ?? 'aborted')})`); }

  private async keepLease() {
    if (!(await this.ctx.renewLease())) throw new LeaseLost('experiment work lease was not renewed');
  }

  async run(): Promise<{ report: ArtifactRef }> {
    const caps = await this.deps.client.query('capabilities', {});
    const parkBytes = await this.deps.client.getArtifact(this.spec.park);
    if (sha256Hex(parkBytes) !== this.spec.park.sha256) throw new InvalidRequestError('park artifact hash mismatch');
    this.park = JSON.parse(new TextDecoder().decode(parkBytes)) as ParkBundle;
    const pf = preflightExperiment(this.spec, caps, this.park);
    for (const w of pf.warnings) this.ctx.logger.log('info', 'experiment.preflight_warning', { experimentId: this.spec.experimentId, warning: w });
    await this.loadState();
    if (!pf.ok) {
      for (const p of this.state.pairs) { p.status = 'failed'; p.reasons = ['preflight failed']; }
      await this.progress(false, pf.errors);
      throw new InvalidRequestError(`experiment preflight failed: ${pf.errors.join('; ')}`);
    }
    const parkCtx = parkContext(this.park, this.spec.park.sha256);
    for (const pair of this.state.pairs) {
      if (['complete', 'incomplete', 'degraded', 'failed'].includes(pair.status)) continue;
      await this.runPair(pair, parkCtx);
      await this.fault(`pair-stored:${pair.pairId}`);
    }
    this.state.phase = 'aggregate';
    await this.persist();
    await this.fault('aggregate');
    const ref = await this.finalize();
    this.state.phase = 'done';
    await this.persist();
    return { report: ref };
  }

  private async loadState() {
    const specHash = hashCanonical(this.spec);
    const prior = await getJson<ExperimentState>(this.deps.store, this.key);
    if (prior) {
      if (prior.specHash !== specHash) throw new InvalidRequestError('stored experiment state belongs to a different spec');
      if (prior.ownerAttempt > this.ctx.lease().attempt) throw new LeaseLost(`state owned by newer attempt ${prior.ownerAttempt}`);
      const takeover = prior.ownerAttempt !== this.ctx.lease().attempt;
      this.state = { ...prior, ownerAttempt: this.ctx.lease().attempt };
      await this.persist();
      if (takeover) {
        // A new session never shares a driver token with an earlier one: release so the next acquire bumps the epoch.
        for (const p of this.state.pairs) for (const a of [p.arms.A, p.arms.B, ...(p.warmup ? [p.warmup.run] : [])]) await this.release(p, a);
      }
      this.ctx.logger.log('info', 'experiment.resume', { experimentId: this.spec.experimentId, phase: prior.phase, pairs: prior.pairs.map((p) => p.status) });
      return;
    }
    // Adopt the pair inventory the runtime already published for this experiment (Engine
    // pre-creates pairs and rejects progress for any other pair IDs); fall back to seed IDs.
    const published = new Map<string, Id>();
    try {
      const current = await this.deps.client.query('getExperiment', { experimentId: this.spec.experimentId });
      for (const p of current.pairs) published.set(p.seed, p.pairId);
      this.publishedRevision = current.revision;
    } catch { /* runtime without a published inventory: use seed-derived IDs */ }
    this.state = {
      schema: 'experiment-state.v1', version: COORDINATOR_VERSION, experimentId: this.spec.experimentId, specHash,
      ownerAttempt: this.ctx.lease().attempt,
      pairs: this.spec.seeds.map((seed) => ({
        pairId: published.get(seed) ?? `pair-${seed}`, seed, status: 'pending', reasons: [], population: null, populationHash: null,
        warmup: this.spec.start.kind === 'warmup' ? { run: newArm(), checkpoint: null, hash: null } : null,
        initialStateHash: null, arms: { A: newArm(), B: newArm() },
      })),
      progressSeq: this.publishedRevision, phase: 'pairs', artifacts: { report: null, facts: null, tape: null, narrative: null },
    };
    await this.persist();
  }

  // ---------------------------------------------------------------- pairs

  private async runPair(pair: PairState, parkCtx: ReturnType<typeof parkContext>) {
    pair.status = 'running';
    if (!pair.population) {
      const gen = await generatePopulation({
        crowd: { ...this.spec.crowd, seed: pair.seed }, park: parkCtx, closeAfterMs: this.park.closeAfterMs,
        maxGuests: this.opts.maxGuests, prose: this.deps.prose ?? null, signal: this.ctx.signal,
      });
      if (!gen.ok) return this.closePair(pair, 'failed', [`population: ${gen.errors.map((e) => e.message).join('; ')}`]);
      pair.population = await this.deps.client.putArtifact({
        kind: 'population', mediaType: 'application/json', bytes: gen.bytes,
        scope: { runId: null, experimentId: this.spec.experimentId }, commandId: artifactCommandId('population', gen.sha256, { runId: null, experimentId: this.spec.experimentId }),
      });
      pair.populationHash = gen.sha256;
      await this.persist();
      await this.progress();
    }
    await this.fault(`population:${pair.pairId}`);

    if (pair.warmup && !pair.warmup.checkpoint) {
      const w = pair.warmup;
      const start = this.spec.start as Extract<ExperimentSpec['start'], { kind: 'warmup' }>;
      const ok = await this.createAndStart(pair, 'warmup', w.run, this.manifest(pair, 'A', start.warmupScenario, null, `${pair.pairId}.warmup`, start.toMs));
      if (!ok) return this.closePair(pair, 'failed', ['warmup run could not be created']);
      const driven = await this.drive(pair, 'warmup', w.run);
      if (driven !== 'completed') return this.closePair(pair, driven === 'failed' ? 'failed' : 'incomplete', [`warmup ${driven}: ${w.run.reasons.join('; ')}`]);
      const cp = await this.command('checkpointRun', { runId: w.run.runId! }, `${this.cmdBase(pair, 'warmup')}:checkpoint`) as Receipt<{ checkpoint: ArtifactRef; physicalStateHash: Hash }>;
      if (!cp.ok) return this.closePair(pair, 'failed', [`warmup checkpoint: ${cp.error.code} ${cp.error.message}`]);
      w.checkpoint = cp.result.checkpoint;
      w.hash = cp.result.physicalStateHash;
      await this.persist();
      await this.fault(`warmup:${pair.pairId}`);
    }

    for (const arm of ['A', 'B'] as const) {
      const scenario = arm === 'A' ? this.spec.baseline : this.spec.variant;
      const a = pair.arms[arm];
      if (a.status === 'pending') {
        const ok = await this.createAndStart(pair, arm, a, this.manifest(pair, arm, scenario, pair.warmup?.checkpoint ?? null, pair.pairId, this.spec.config.horizonMs));
        if (!ok) return this.closePair(pair, 'failed', [`arm ${arm} could not be created: ${a.reasons.join('; ')}`]);
        await this.fault(`created:${pair.pairId}:${arm}`);
      }
    }

    if (!pair.initialStateHash) {
      const mismatch = await this.verifyCommonStart(pair);
      if (mismatch) return this.closePair(pair, 'failed', [mismatch]);
      await this.fault(`initial-hash:${pair.pairId}`);
    }

    const arms: ArmId[] = ['A', 'B'];
    const driveArm = async (arm: ArmId) => {
      const a = pair.arms[arm];
      if (a.status === 'created' || a.status === 'started') {
        const r = await this.drive(pair, arm, a);
        if (r === 'completed') { a.status = 'driven'; await this.persist(); }
        else { a.status = r === 'failed' ? 'failed' : 'incomplete'; await this.persist(); return; }
      }
      if (a.status === 'driven') await this.measure(pair, arm, a);
    };
    if (this.spec.maxConcurrentArms === 2) await Promise.all(arms.map(driveArm));
    else for (const arm of arms) await driveArm(arm);

    const reasons: string[] = [];
    let status: PairResult['status'] = 'complete';
    for (const arm of arms) {
      const a = pair.arms[arm];
      reasons.push(...a.reasons.map((r) => `${arm}: ${r}`));
      if (a.status === 'failed') status = 'failed';
      else if (a.status !== 'measured' && status !== 'failed') status = 'incomplete';
    }
    if (status === 'complete') {
      for (const arm of arms) {
        const q = pair.arms[arm].quality!;
        const m = pair.arms[arm].metrics!;
        const incompleteMetrics = Object.values(m.measures).filter((v) => !v.complete).map((v) => v.id);
        if (incompleteMetrics.length) reasons.push(`${arm}: incomplete metrics ${incompleteMetrics.join(', ')} (excluded per metric)`);
        if (!q.comparisonEligible) { status = 'degraded'; reasons.push(`${arm}: not comparison-eligible (${q.reasons.join('; ')})`); }
        if (this.spec.config.mode === 'experiment' && (q.behaviorCounts.mock > 0 || q.behaviorCounts.fallback > 0)) {
          status = 'degraded'; reasons.push(`${arm}: mock/fallback provenance in a real-provider experiment`);
        }
        if (q.terminalRatingsComplete < q.terminalRatingsExpected) reasons.push(`${arm}: ${q.terminalRatingsExpected - q.terminalRatingsComplete} terminal ratings missing`);
      }
    }
    await this.closePair(pair, status, reasons);
  }

  private async closePair(pair: PairState, status: PairResult['status'], reasons: string[]) {
    pair.status = status;
    pair.reasons = [...new Set([...pair.reasons.filter((r) => r !== 'preflight failed'), ...reasons])];
    for (const a of Object.values(pair.arms)) if (a.driver) await this.release(pair, a);
    await this.persist();
    await this.progress();
  }

  private manifest(pair: PairState, arm: ArmId, scenario: ExperimentSpec['baseline'], checkpoint: ArtifactRef | null, pairId: Id, horizonMs: number): RunManifest {
    return {
      contractVersion: CONTRACT_VERSION, park: this.spec.park, population: pair.population!, scenario,
      replicateSeed: pair.seed, config: { ...this.spec.config, horizonMs },
      experiment: { experimentId: this.spec.experimentId, pairId, arm }, initialCheckpoint: checkpoint, replayTape: null,
    };
  }

  private async createAndStart(pair: PairState, label: string, a: ArmState, manifest: RunManifest): Promise<boolean> {
    if (!a.runId) {
      const r = await this.command('createRun', { manifest }, `${this.cmdBase(pair, label)}:create`) as Receipt<{ runId: Id }>;
      if (!r.ok) { a.status = 'failed'; a.reasons.push(`createRun ${r.error.code}: ${r.error.message}`); await this.persist(); return false; }
      a.runId = r.result.runId;
      a.status = 'created';
      await this.persist();
    }
    const got = await this.deps.client.query('getManifest', { runId: a.runId });
    if (got.population.sha256 !== manifest.population.sha256 || hashCanonical(got.config) !== hashCanonical(manifest.config)
      || hashCanonical(got.scenario) !== hashCanonical(manifest.scenario) || (got.initialCheckpoint?.sha256 ?? null) !== (manifest.initialCheckpoint?.sha256 ?? null)) {
      a.status = 'failed'; a.reasons.push('Engine manifest does not match the requested manifest');
      await this.persist();
      return false;
    }
    const s = await this.command('startRun', { runId: a.runId }, `${this.cmdBase(pair, label)}:start`) as Receipt<RunView>;
    if (!s.ok && s.error.code !== 'INVALID_STATE') { a.status = 'failed'; a.reasons.push(`startRun ${s.error.code}`); await this.persist(); return false; }
    if (a.startedAtEpochMs === null) a.startedAtEpochMs = this.now();
    a.status = a.status === 'created' ? 'started' : a.status;
    await this.persist();
    return true;
  }

  /** Both arms must share the population, config and seed, and start from the same physical state. */
  private async verifyCommonStart(pair: PairState): Promise<string | null> {
    const [ma, mb] = await Promise.all([pair.arms.A, pair.arms.B].map((a) => this.deps.client.query('getManifest', { runId: a.runId! })));
    const common = (m: RunManifest) => hashCanonical({ park: m.park, population: m.population, config: m.config, seed: m.replicateSeed, cp: m.initialCheckpoint, replay: m.replayTape });
    if (common(ma!) !== common(mb!)) return 'arms differ in a common manifest field';
    for (const arm of ['A', 'B'] as const) {
      const a = pair.arms[arm];
      if (a.initialHash) continue;
      const r = await this.command('checkpointRun', { runId: a.runId! }, `${this.cmdBase(pair, arm)}:initial-checkpoint`) as Receipt<{ physicalStateHash: Hash }>;
      if (!r.ok) return `initial checkpoint of arm ${arm} failed: ${r.error.code}`;
      a.initialHash = r.result.physicalStateHash;
      await this.persist();
    }
    if (pair.arms.A.initialHash !== pair.arms.B.initialHash) return `initial state hashes differ (${pair.arms.A.initialHash} vs ${pair.arms.B.initialHash})`;
    if (pair.warmup && pair.warmup.hash !== pair.arms.A.initialHash) return 'cloned arms do not match the warmup checkpoint hash';
    pair.initialStateHash = pair.arms.A.initialHash;
    await this.persist();
    return null;
  }

  // ---------------------------------------------------------------- driving

  private async acquire(pair: PairState, label: string, a: ArmState, deadline: number): Promise<DriverLease | null> {
    let delay = this.opts.pollBaseMs;
    for (let n = 0; ; n++) {
      const r = await this.command('acquireDriver', { runId: a.runId!, leaseMs: this.opts.driverLeaseMs }, `${this.cmdBase(pair, label)}:driver:${this.ctx.lease().attempt}:${n}:${this.now()}`) as Receipt<DriverLease>;
      if (r.ok) { a.driver = r.result; await this.persist(); return r.result; }
      if (r.error.code !== 'CONFLICT') { a.reasons.push(`acquireDriver ${r.error.code}: ${r.error.message}`); return null; }
      if (this.now() >= deadline) { a.reasons.push('another driver held the run until the operation budget expired'); return null; }
      await this.wait(delay);
      delay = Math.min(this.opts.pollMaxMs, delay * 2);
    }
  }

  private async release(pair: PairState, a: ArmState) {
    if (!a.driver) return;
    try { await this.command('releaseDriver', { lease: a.driver }, `${this.cmdBase(pair, a.runId ?? 'x')}:release:${a.driver.epoch}`); } catch (e) {
      this.ctx.logger.log('warn', 'experiment.release_failed', { runId: a.runId, error: (e as Error).message });
    }
    a.driver = null;
    await this.persist();
  }

  /**
   * Drives a child run through Engine's own advance path. A blocked result means waiting for work,
   * never incrementing time locally. Returns the terminal outcome for this arm.
   */
  private async drive(pair: PairState, label: string, a: ArmState): Promise<'completed' | 'failed' | 'incomplete'> {
    const deadline = (a.startedAtEpochMs ?? this.now()) + this.spec.operationBudgetMs;
    let lease = a.driver ?? (await this.acquire(pair, label, a, deadline));
    if (!lease) return 'incomplete';
    let delay = this.opts.pollBaseMs;
    let renewedAt = this.now();
    let staleInRow = 0;
    let advanceSeq = 0;
    for (;;) {
      await this.keepLease();
      const view = await this.deps.client.query('getRun', { runId: a.runId! });
      if (view.status === 'completed') break;
      if (view.status === 'failed' || view.status === 'cancelled') { a.reasons.push(`run ${view.status}`); await this.release(pair, a); return 'failed'; }
      if (this.now() >= deadline) {
        a.reasons.push(`operation budget ${this.spec.operationBudgetMs} ms exceeded at step ${view.stepIndex}`);
        await this.command('cancelRun', { runId: a.runId!, expectedControlRevision: view.controlRevision }, `${this.cmdBase(pair, label)}:cancel:${view.controlRevision}`);
        await this.release(pair, a);
        return 'incomplete';
      }
      if (this.now() - renewedAt >= this.opts.driverLeaseMs / 3) {
        const rr = await this.command('renewDriver', { lease, leaseMs: this.opts.driverLeaseMs }, `${this.cmdBase(pair, label)}:renew:${lease.epoch}:${this.now()}`) as Receipt<DriverLease>;
        if (rr.ok) { lease = rr.result; a.driver = lease; renewedAt = this.now(); await this.persist(); }
      }
      const r = await this.command('advanceRun', { lease, expectedStep: view.stepIndex, expectedPhase: view.phase, maxSteps: this.opts.maxStepsPerAdvance },
        // Each call is a new intent: a bounded advance can make progress inside a step without
        // changing the published revision/step/phase, so those alone would replay the old receipt.
        `${this.cmdBase(pair, label)}:advance:e${lease.epoch}:x${lease.expiresAtEpochMs}:r${view.revision}:s${view.stepIndex}:${view.phase}:n${++advanceSeq}`) as Receipt<AdvanceResult>;
      if (!r.ok) {
        if (r.error.code === 'STALE_REVISION') {
          if (++staleInRow > 20) { a.reasons.push('run position never matched getRun (STALE_REVISION loop)'); await this.release(pair, a); return 'failed'; }
          await this.wait(this.opts.pollBaseMs);
          continue;
        }
        if (r.error.code === 'STALE_LEASE') {
          a.driver = null;
          await this.persist();
          const re = await this.acquire(pair, label, a, deadline);
          if (!re) return 'incomplete';
          lease = re; renewedAt = this.now();
          continue;
        }
        if (r.error.code === 'INVALID_STATE') continue;
        a.reasons.push(`advanceRun ${r.error.code}: ${r.error.message}`);
        if (!r.error.retryable) { await this.release(pair, a); return 'failed'; }
        await this.wait(delay);
        continue;
      }
      staleInRow = 0;
      a.finalHash = r.result.physicalStateHash;
      await this.persist();
      await this.fault(`advance:${pair.pairId}:${label}:${r.result.run.stepIndex}`);
      if (r.result.run.status === 'completed') break;
      if (r.result.run.status === 'failed') { a.reasons.push(`run failed (blocked work ${r.result.blockedWorkIds.join(',')})`); await this.release(pair, a); return 'failed'; }
      if (r.result.blockedWorkIds.length) { await this.wait(delay); delay = Math.min(this.opts.pollMaxMs, delay * 2); }
      else delay = this.opts.pollBaseMs;
    }
    if (label === 'warmup') await this.release(pair, a);
    return 'completed';
  }

  /** Waits for declared terminal ratings within the budget, then freezes metrics and quality. */
  private async measure(pair: PairState, arm: ArmId, a: ArmState) {
    const deadline = (a.startedAtEpochMs ?? this.now()) + this.spec.operationBudgetMs;
    let delay = this.opts.pollBaseMs;
    let view = await this.deps.client.query('getRun', { runId: a.runId! });
    while (view.quality.terminalRatingsComplete < view.quality.terminalRatingsExpected && this.now() < deadline) {
      await this.keepLease();
      await this.wait(delay);
      delay = Math.min(this.opts.pollMaxMs, delay * 2);
      view = await this.deps.client.query('getRun', { runId: a.runId! });
    }
    if (view.quality.terminalRatingsComplete < view.quality.terminalRatingsExpected) a.reasons.push('terminal ratings incomplete when the operation budget expired');
    let last: MetricSnapshot | null = null;
    let cursor: string | null = null;
    do {
      const page: { items: MetricSnapshot[]; nextCursor: string | null } = await this.deps.client.query('getMetrics', { runId: a.runId!, fromMs: 0, toMs: this.spec.config.horizonMs, cursor });
      for (const m of page.items) if (!last || m.revision >= last.revision) last = m;
      cursor = page.nextCursor;
    } while (cursor);
    if (!last) { a.status = 'incomplete'; a.reasons.push('no metric snapshot'); await this.persist(); return; }
    const bad = validateMetricSnapshot(last);
    if (bad.length) { a.status = 'incomplete'; a.reasons.push(`invalid metric snapshot: ${bad.map((e) => e.path).join(', ')}`); await this.persist(); return; }
    a.metrics = last;
    a.quality = view.quality;
    a.status = 'measured';
    await this.release(pair, a);
    await this.persist();
    await this.progress();
    await this.fault(`measured:${pair.pairId}:${arm}`);
  }

  private async wait(ms: number) {
    await this.deps.waitHook?.();
    await this.deps.clock.sleep(ms, this.ctx.signal).catch(() => { throw new LeaseLost('aborted while waiting'); });
  }

  // ---------------------------------------------------------------- reporting

  private pairResults(): PairResult[] {
    return this.state.pairs.map((p) => ({
      pairId: p.pairId, seed: p.seed, populationHash: p.populationHash ?? '0'.repeat(64) /* runtime placeholder until sampled */, initialStateHash: p.initialStateHash,
      aRunId: p.arms.A.runId, bRunId: p.arms.B.runId, status: p.status, reasons: p.reasons,
      a: p.arms.A.metrics, b: p.arms.B.metrics, deltas: p.status === 'pending' ? {} : pairDeltas(p.arms.A.metrics, p.arms.B.metrics),
    }));
  }

  private sources(): Record<Source, number> {
    const s: Record<Source, number> = { jev: 0, cache: 0, mock: 0, fallback: 0 };
    for (const p of this.state.pairs) for (const a of Object.values(p.arms)) if (a.quality) for (const k of Object.keys(s) as Source[]) s[k] += a.quality.behaviorCounts[k];
    return s;
  }

  private async reportContext(): Promise<ReportContext> {
    return { runtime: this.deps.runtime, sources: this.sources(), usage: this.deps.ledger ? await this.deps.ledger.totals() : null };
  }

  /** Records progress with the coordinator's work lease. Command IDs are durable; a reused ID with a new payload advances the sequence. */
  private async progress(final = false, extraLimitations: string[] = []) {
    const report = buildReport(this.spec, this.pairResults(), this.state.progressSeq + 1, await this.reportContext(), {
      facts: this.state.artifacts.facts, responseTape: this.state.artifacts.tape,
    }, final);
    if (extraLimitations.length) report.limitations.push(...extraLimitations.map((e) => `Preflight: ${e}`));
    for (let tries = 0; tries < 3; tries++) {
      if (tries > 0) await this.syncRevision();
      this.state.progressSeq += 1;
      report.revision = this.state.progressSeq;
      await this.persist();
      const r = await this.command('recordExperimentProgress', { experimentId: this.spec.experimentId, lease: this.ctx.lease(), report }, `exp:${this.spec.experimentId}:progress:${this.state.progressSeq}`) as Receipt<{ revision: number }>;
      if (r.ok) return report;
      if (r.error.code === 'STALE_LEASE' || r.error.code === 'INVALID_STATE') throw new LeaseLost(`progress rejected: ${r.error.code}`);
      this.ctx.logger.log('warn', 'experiment.progress_rejected', { code: r.error.code, message: r.error.message, attempt: tries + 1 });
    }
    return report;
  }

  private async finalize(): Promise<ArtifactRef> {
    const scope = { runId: null, experimentId: this.spec.experimentId };
    const ctx = await this.reportContext();
    if (!this.state.artifacts.tape && this.deps.cache) {
      const tape = await exportResponseTape(this.deps.cache, `exp/${this.spec.experimentId}`);
      this.state.artifacts.tape = await this.deps.client.putArtifact({ kind: 'response_tape', mediaType: 'application/json', bytes: tape.bytes, scope, commandId: artifactCommandId('response_tape', tape.sha256, scope) });
      await this.persist();
    }
    const extra: string[] = [];
    if (this.spec.config.mode === 'experiment') {
      if (this.state.artifacts.tape) {
        const tape = JSON.parse(new TextDecoder().decode(await this.deps.client.getArtifact(this.state.artifacts.tape))) as ResponseTape;
        const leaked = (tape.sourceCounts.mock ?? 0) + (tape.sourceCounts.fallback ?? 0);
        if (leaked > 0) {
          for (const p of this.state.pairs) {
            if (p.status !== 'complete') continue;
            p.status = 'degraded';
            p.reasons = [...p.reasons, `response tape holds ${leaked} mock/fallback-origin responses (possibly served as cache hits) in a real-provider experiment`];
          }
          await this.persist();
        }
      } else {
        extra.push('Original provenance of cache hits was not verified: no response tape was available to the coordinator.');
      }
    }
    const pairs = this.pairResults();
    const pre = buildReport(this.spec, pairs, this.state.progressSeq + 1, ctx, { facts: null, responseTape: this.state.artifacts.tape }, true);
    pre.limitations.push(...extra);
    const facts = buildExperimentFacts(pre, { ...ctx, responseTapeSha256: this.state.artifacts.tape?.sha256 ?? null });
    const factBytes = canonicalBytes(facts);
    this.state.artifacts.facts = await this.deps.client.putArtifact({ kind: 'fact_bundle', mediaType: 'application/json', bytes: factBytes, scope, commandId: artifactCommandId('fact_bundle', sha256Hex(factBytes), scope) });
    const { narrative } = await composeReport(facts, null, this.ctx.signal, experimentNarrative);
    const nBytes = canonicalBytes(narrative);
    this.state.artifacts.narrative = await this.deps.client.putArtifact({ kind: 'narrative', mediaType: 'application/json', bytes: nBytes, scope, commandId: artifactCommandId('narrative', sha256Hex(nBytes), scope) });
    const report: ExperimentReport = { ...pre, facts: this.state.artifacts.facts };
    const shape = validateReportShape(report);
    if (shape.length) throw new Error(`report shape invalid: ${shape.join('; ')}`);
    const bytes = canonicalBytes(report);
    this.state.artifacts.report = await this.deps.client.putArtifact({ kind: 'experiment_report', mediaType: 'application/json', bytes, scope, commandId: artifactCommandId('experiment_report', sha256Hex(bytes), scope) });
    await this.persist();
    await this.progressFinal(report);
    return this.state.artifacts.report;
  }

  private async progressFinal(report: ExperimentReport) {
    let last = '';
    for (let tries = 0; tries < 3; tries++) {
      if (tries > 0) await this.syncRevision();
      this.state.progressSeq += 1;
      await this.persist();
      const r = await this.command('recordExperimentProgress', { experimentId: this.spec.experimentId, lease: this.ctx.lease(), report: { ...report, revision: this.state.progressSeq } }, `exp:${this.spec.experimentId}:progress:${this.state.progressSeq}`) as Receipt<{ revision: number }>;
      if (r.ok) return;
      if (r.error.code === 'STALE_LEASE' || r.error.code === 'INVALID_STATE') throw new LeaseLost(`final progress rejected: ${r.error.code}`);
      last = `${r.error.code}: ${r.error.message}`;
      this.ctx.logger.log('warn', 'experiment.final_progress_rejected', { code: r.error.code, message: r.error.message, attempt: tries + 1 });
    }
    // Never report a finished experiment the runtime refused to record.
    throw new Error(`final experiment report rejected by runtime (${last})`);
  }

  /** Re-reads the runtime's published report revision after a rejected progress write. */
  private async syncRevision() {
    try {
      const current = await this.deps.client.query('getExperiment', { experimentId: this.spec.experimentId });
      this.state.progressSeq = current.revision;
    } catch { /* keep the local sequence */ }
  }
}

export async function readExperimentState(store: DurableStore, experimentId: Id): Promise<ExperimentState | null> {
  return getJson<ExperimentState>(store, `experiments/${experimentId}/state`);
}
