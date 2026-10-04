import type {
  CompletedWork, DomainError, Id, LeasedWork, RuntimeClient, WorkKind, WorkLease,
} from '../../contract/behavior-v1.ts';
import { hashCanonical } from '../core/canonical.ts';
import { domainError, isRuntimeClientError } from '../core/errors.ts';
import type { Clock, Jitter, Logger } from '../runtime/clock.ts';
import type { IdSource } from '../runtime/commands.ts';
import { runCommand } from '../runtime/commands.ts';
import { ProviderError } from '../providers/types.ts';
import { backoffDelayMs } from './backoff.ts';
import type { Handlers } from './handlers.ts';
import { executorClassOf } from './handlers.ts';
import type { InferenceService } from './inference.ts';
import { InvalidRequestError } from './inference.ts';
import type { JournalEntry, Journal } from './journal.ts';
import type { ExecutorClass, LimiterPort } from './ports.ts';
import type { UsageLedger } from './usage.ts';

export type WorkerOptions = {
  kinds: WorkKind[];
  leaseMs: number; renewEveryMs: number; reconcileEveryMs: number;
  /** Max in-flight items per executor class; also bounds the local queue. */
  capacity: Record<ExecutorClass, number>;
  shutdownDeadlineMs: number;
  workerNonce: string;
};

export type WorkerDeps = {
  client: RuntimeClient; inference: InferenceService; handlers: Handlers; journal: Journal; ledger: UsageLedger;
  clock: Clock; jitter: Jitter; ids: IdSource; logger: Logger; limiter?: LimiterPort;
};

type Inflight = {
  item: LeasedWork; lease: WorkLease; ac: AbortController; cls: ExecutorClass; claimedAt: number; done: Promise<void>;
};

export type WorkerStatus = {
  schema: 'worker-status.v1'; stopping: boolean; disabledKinds: WorkKind[];
  inflight: Record<ExecutorClass, number>; capacity: Record<ExecutorClass, number>; oldestInflightAgeMs: number;
  outcomes: Record<string, number>; latencyMs: Record<ExecutorClass, { n: number; p50: number | null; p95: number | null }>;
  inference: { providerCalls: number; cacheHits: number; coalesced: number; invalidOutputs: number; retries: number; errors: Record<string, number>; httpP95Ms: number | null };
  limiter: Record<string, unknown> | null;
};

export type ShutdownReport = { completedDuringDrain: number; relinquished: Id[]; stillInflight: Id[] };

const CLASSES: ExecutorClass[] = ['behavior', 'measurement', 'text', 'experiment'];
const MAX_CLAIM = 32;

function percentile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/**
 * Ordinary worker: claims only its authorized kinds, never calls world-mutation or scenario
 * commands, and never samples an action. Lifecycle per item:
 * claim -> journal -> handler (snapshot validation, cache, limiter, provider, raw persistence,
 * validation) -> journal result -> completeWork with a stable command ID.
 */
export class Worker {
  private readonly inflight = new Map<Id, Inflight>();
  private readonly disabled = new Set<WorkKind>();
  private readonly outcomes: Record<string, number> = {};
  private readonly latencies: Record<ExecutorClass, number[]> = { behavior: [], measurement: [], text: [], experiment: [] };
  private stopping = false;
  private wakeResolve: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private loopDone: Promise<void> | null = null;
  private readonly stopAc = new AbortController();

  constructor(private readonly deps: WorkerDeps, private readonly opts: WorkerOptions) {}

  private count(outcome: string) { this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1; }
  private now() { return this.deps.clock.nowEpochMs(); }

  /** Recover persisted state, subscribe to hints and start the claim/renew loop. */
  async start(): Promise<void> {
    await this.recover();
    this.unsubscribe = this.deps.client.subscribeWorkAvailable(this.opts.kinds, () => this.wake());
    this.loopDone = this.loop();
  }

  private wake() { this.wakeResolve?.(); }

  private async loop(): Promise<void> {
    let lastRenew = this.now();
    while (!this.stopping) {
      try {
        await this.runOnce();
        if (this.now() - lastRenew >= this.opts.renewEveryMs) { await this.renewNow(); lastRenew = this.now(); }
      } catch (e) {
        this.deps.logger.log('error', 'worker.loop_error', { error: (e as Error).message });
      }
      const wait = new Promise<void>((r) => { this.wakeResolve = r; });
      await Promise.race([wait, this.deps.clock.sleep(Math.min(this.opts.reconcileEveryMs, this.opts.renewEveryMs), this.stopAc.signal).catch(() => undefined)]);
      this.wakeResolve = null;
    }
  }

  private free(cls: ExecutorClass): number {
    let used = 0;
    for (const f of this.inflight.values()) if (f.cls === cls) used++;
    return Math.max(0, this.opts.capacity[cls] - used);
  }

  /** One reconcile pass: claim per executor class up to its free capacity and dispatch. */
  async runOnce(): Promise<number> {
    if (this.stopping) return 0;
    let claimed = 0;
    for (const cls of CLASSES) {
      const kinds = this.opts.kinds.filter((k) => executorClassOf(k) === cls && !this.disabled.has(k) && this.deps.handlers[k]);
      // Engine accepts at most 32 items per claim; larger capacities claim repeatedly while
      // full pages keep coming back.
      for (let page = 0; page < 8 && !this.stopping; page++) {
        const free = this.free(cls);
        if (!kinds.length || free === 0) break;
        const limit = Math.min(free, MAX_CLAIM);
        let receipt;
        try {
          receipt = await runCommand(this.deps.client, 'claimWork', { kinds, limit, workerNonce: this.opts.workerNonce, leaseMs: this.opts.leaseMs }, this.deps.ids.next('claim'), { clock: this.deps.clock, jitter: this.deps.jitter, logger: this.deps.logger, signal: this.stopAc.signal });
        } catch (e) {
          this.deps.logger.log('warn', 'worker.claim_failed', { cls, error: (e as Error).message });
          break;
        }
        if (!receipt.ok) { this.deps.logger.log('error', 'worker.claim_rejected', { cls, code: receipt.error.code, message: receipt.error.message }); break; }
        for (const item of receipt.result.items) { this.dispatch(item); claimed++; }
        if (receipt.result.items.length < limit) break;
      }
    }
    return claimed;
  }

  private dispatch(item: LeasedWork): void {
    const ac = new AbortController();
    const rec: Inflight = { item, lease: item.lease, ac, cls: executorClassOf(item.kind), claimedAt: this.now(), done: Promise.resolve() };
    this.inflight.set(item.lease.workId, rec);
    rec.done = this.process(rec).finally(() => {
      this.inflight.delete(item.lease.workId);
      this.latencies[rec.cls].push(this.now() - rec.claimedAt);
      if (this.latencies[rec.cls].length > 1000) this.latencies[rec.cls].shift();
      this.wake();
    });
  }

  private async process(rec: Inflight): Promise<void> {
    const { item } = rec;
    const workId = item.lease.workId;
    const entry: JournalEntry = {
      workId, kind: item.kind, lease: item.lease, payloadHash: hashCanonical(item.payload), state: 'claimed',
      callIds: [], result: null, completeCommandId: null, note: null, updatedAtEpochMs: this.now(),
    };
    if (!(await this.deps.journal.write(entry))) { this.count('skipped_newer_attempt'); return; }
    const handler = this.deps.handlers[item.kind] as ((p: unknown, c: Parameters<NonNullable<Handlers['decision']>>[1]) => Promise<unknown>) | undefined;
    try {
      if (!handler) throw new InvalidRequestError(`unsupported work kind ${item.kind}`);
      const result = await handler(item.payload, {
        workId, scope: item.scope, signal: rec.ac.signal, client: this.deps.client, inference: this.deps.inference,
        clock: this.deps.clock, ids: this.deps.ids, logger: this.deps.logger,
        lease: () => rec.lease,
        renewLease: async () => { await this.renewNow(); return !rec.ac.signal.aborted; },
        onCallStarted: async (callId) => {
          const cur = await this.deps.journal.get(workId);
          await this.deps.journal.update(workId, item.lease.attempt, { state: 'calling', callIds: [...(cur?.callIds ?? []), callId] }, this.now());
        },
      });
      if (rec.ac.signal.aborted) throw new ProviderError('aborted', String(rec.ac.signal.reason ?? 'aborted'));
      const persisted = await this.deps.journal.update(workId, item.lease.attempt, { state: 'response', result, completeCommandId: this.deps.ids.next('complete') }, this.now());
      if (!persisted) { this.count('lost'); return; }
      await this.submit(persisted, () => rec.lease);
    } catch (e) {
      await this.handleFailure(rec, e);
    }
  }

  /** Sends completeWork; transport failures are retried with the SAME command ID. */
  private async submit(entry: JournalEntry, currentLease: () => WorkLease = () => entry.lease): Promise<void> {
    const lease = currentLease();
    await this.deps.journal.update(entry.workId, entry.lease.attempt, { state: 'submitting' }, this.now());
    const item = { kind: entry.kind, lease, result: entry.result } as CompletedWork;
    let receipt;
    try {
      receipt = await runCommand(this.deps.client, 'completeWork', { item }, entry.completeCommandId!, { clock: this.deps.clock, jitter: this.deps.jitter, logger: this.deps.logger });
    } catch (e) {
      this.deps.logger.log('warn', 'worker.submit_deferred', { workId: entry.workId, commandId: entry.completeCommandId, error: (e as Error).message });
      this.count('submit_deferred');
      return;
    }
    if (receipt.ok) {
      await this.deps.journal.update(entry.workId, entry.lease.attempt, { state: 'done' }, this.now());
      this.count(`completed:${entry.kind}`);
      return;
    }
    const lost = ['STALE_LEASE', 'INVALID_STATE', 'NOT_FOUND', 'CONFLICT'].includes(receipt.error.code);
    await this.deps.journal.update(entry.workId, entry.lease.attempt, { state: lost ? 'lost' : 'failed', note: `${receipt.error.code}: ${receipt.error.message}` }, this.now());
    this.count(lost ? 'lost' : 'complete_rejected');
    this.deps.logger.log(lost ? 'info' : 'error', 'worker.complete_rejected', { workId: entry.workId, code: receipt.error.code, message: receipt.error.message });
  }

  private async fail(rec: { lease: WorkLease; workId: Id }, error: DomainError, retryAtEpochMs: number | null, commandId: Id): Promise<'failed' | 'lost'> {
    try {
      const r = await runCommand(this.deps.client, 'failWork', { lease: rec.lease, error, retryAtEpochMs }, commandId, { clock: this.deps.clock, jitter: this.deps.jitter, logger: this.deps.logger });
      return r.ok ? 'failed' : 'lost';
    } catch {
      return 'lost';
    }
  }

  private async handleFailure(rec: Inflight, e: unknown): Promise<void> {
    const workId = rec.item.lease.workId;
    const attempt = rec.item.lease.attempt;
    const reason = rec.ac.signal.aborted ? String(rec.ac.signal.reason ?? 'aborted') : null;
    const cmd = `fail:${workId}:${attempt}`;
    if (reason === 'lease_lost') {
      await this.deps.journal.update(workId, attempt, { state: 'lost', note: 'lease lost; in-flight result discarded' }, this.now());
      this.count('lease_lost');
      return;
    }
    if (reason === 'shutdown') {
      await this.fail({ lease: rec.lease, workId }, domainError('DEPENDENCY_UNAVAILABLE', 'worker shutting down; relinquished', true), this.now(), cmd);
      await this.deps.journal.update(workId, attempt, { state: 'relinquished', note: 'shutdown' }, this.now());
      this.count('relinquished');
      return;
    }
    if (e instanceof InvalidRequestError) {
      await this.fail({ lease: rec.lease, workId }, domainError('INVALID_INPUT', e.message, false, e.fieldErrors), null, cmd);
      await this.deps.journal.update(workId, attempt, { state: 'failed', note: e.message }, this.now());
      this.count(`invalid_request:${rec.item.kind}`);
      this.deps.logger.log('warn', 'worker.invalid_request', { workId, kind: rec.item.kind, message: e.message });
      return;
    }
    if (e instanceof ProviderError && e.permanent) {
      const code: DomainError['code'] = e.kind === 'unsupported_model' ? 'UNSUPPORTED' : e.kind === 'schema' ? 'INTERNAL' : e.kind === 'budget' ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE';
      await this.fail({ lease: rec.lease, workId }, domainError(code, `provider ${e.kind}: ${e.message}`, false), null, cmd);
      await this.deps.journal.update(workId, attempt, { state: 'failed', note: e.kind }, this.now());
      this.count(`provider_permanent:${e.kind}`);
      if (e.kind === 'auth' || e.kind === 'payment' || e.kind === 'unsupported_model') {
        for (const k of ['decision', 'rating'] as const) this.disabled.add(k);
        this.deps.logger.log('error', 'worker.provider_disabled', { kind: e.kind, message: e.message, note: 'stopped claiming provider-backed work; operator action required' });
      }
      return;
    }
    const retryable = e instanceof ProviderError ? e.retryable : !(isRuntimeClientError(e) && !e.transport);
    const retryAt = this.now() + backoffDelayMs(attempt, { baseMs: 1000, maxMs: 60_000 }, this.deps.jitter);
    const code: DomainError['code'] = e instanceof ProviderError && e.kind === 'rate_limited' ? 'RATE_LIMITED' : 'DEPENDENCY_UNAVAILABLE';
    const message = e instanceof Error ? e.message : String(e);
    const outcome = await this.fail({ lease: rec.lease, workId }, domainError(code, message, retryable), retryable ? retryAt : null, cmd);
    await this.deps.journal.update(workId, attempt, { state: outcome === 'lost' ? 'lost' : 'relinquished', note: message }, this.now());
    this.count(`retry_later:${rec.item.kind}`);
    this.deps.logger.log('warn', 'worker.attempt_failed', { workId, kind: rec.item.kind, message, retryable });
  }

  /** Renew all owned leases; any lease missing from the reply (or locally expired) is aborted. */
  async renewNow(): Promise<void> {
    const active = [...this.inflight.values()].filter((f) => !f.ac.signal.aborted);
    if (!active.length) return;
    try {
      const r = await runCommand(this.deps.client, 'renewWork', { leases: active.map((a) => a.lease), leaseMs: this.opts.leaseMs }, this.deps.ids.next('renew'), { clock: this.deps.clock, jitter: this.deps.jitter, maxTransportRetries: 1 });
      const renewed = new Map((r.ok ? r.result.leases : []).map((l) => [`${l.workId}#${l.attempt}`, l]));
      for (const a of active) {
        const l = renewed.get(`${a.lease.workId}#${a.lease.attempt}`);
        if (l && l.leaseToken === a.lease.leaseToken) a.lease = l;
        else a.ac.abort('lease_lost');
      }
    } catch {
      for (const a of active) if (a.lease.expiresAtEpochMs <= this.now()) a.ac.abort('lease_lost');
    }
  }

  /** Resubmit persisted results (same command ID) and relinquish interrupted claims. */
  async recover(): Promise<{ resubmitted: number; relinquished: number }> {
    let resubmitted = 0; let relinquished = 0;
    for (const e of await this.deps.journal.open()) {
      if ((e.state === 'response' || e.state === 'submitting') && e.result !== null && e.completeCommandId) {
        await this.submit(e); resubmitted++;
        continue;
      }
      const outcome = await this.fail({ lease: e.lease, workId: e.workId }, domainError('DEPENDENCY_UNAVAILABLE', 'worker restarted before completion', true), this.now(), `relinquish:${e.workId}:${e.lease.attempt}`);
      await this.deps.journal.update(e.workId, e.lease.attempt, { state: outcome === 'lost' ? 'lost' : 'relinquished', note: e.state === 'calling' ? 'interrupted during provider call; started-only attempts remain unknown usage' : 'restart' }, this.now());
      relinquished++;
    }
    await this.deps.ledger.flush();
    if (resubmitted || relinquished) this.deps.logger.log('info', 'worker.recovered', { resubmitted, relinquished });
    return { resubmitted, relinquished };
  }

  /** Wait until no work is in flight. */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()].map((f) => f.done));
  }

  /** Stop claiming, let in-flight work finish within the deadline, relinquish the rest, flush and close. */
  async shutdown(): Promise<ShutdownReport> {
    this.stopping = true;
    this.unsubscribe?.();
    this.stopAc.abort();
    this.wake();
    const before = new Set(this.inflight.keys());
    const all = Promise.allSettled([...this.inflight.values()].map((f) => f.done));
    const deadline = new AbortController();
    await Promise.race([all, this.deps.clock.sleep(this.opts.shutdownDeadlineMs, deadline.signal).catch(() => undefined)]);
    deadline.abort();
    const remaining = [...this.inflight.values()];
    for (const f of remaining) f.ac.abort('shutdown');
    const grace = new AbortController();
    await Promise.race([
      Promise.allSettled(remaining.map((f) => f.done)),
      this.deps.clock.sleep(Math.min(1000, this.opts.shutdownDeadlineMs), grace.signal).catch(() => undefined),
    ]);
    grace.abort();
    // Handlers that ignore abort are relinquished directly; their eventual completion is fenced by the lease.
    for (const f of remaining) {
      if (!this.inflight.has(f.item.lease.workId)) continue;
      const workId = f.item.lease.workId;
      await this.fail({ lease: f.lease, workId }, domainError('DEPENDENCY_UNAVAILABLE', 'worker shutting down; relinquished', true), this.now(), `fail:${workId}:${f.item.lease.attempt}`);
      await this.deps.journal.update(workId, f.item.lease.attempt, { state: 'relinquished', note: 'shutdown (handler did not stop)' }, this.now());
      this.inflight.delete(workId);
    }
    await this.loopDone?.catch(() => undefined);
    await this.deps.ledger.flush();
    await this.deps.client.close();
    const relinquished = remaining.map((f) => f.item.lease.workId);
    return { completedDuringDrain: before.size - relinquished.length, relinquished, stillInflight: [...this.inflight.keys()] };
  }

  status(): WorkerStatus {
    const inflight = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<ExecutorClass, number>;
    let oldest = 0;
    for (const f of this.inflight.values()) { inflight[f.cls] += 1; oldest = Math.max(oldest, this.now() - f.claimedAt); }
    const s = this.deps.inference.stats;
    return {
      schema: 'worker-status.v1', stopping: this.stopping, disabledKinds: [...this.disabled],
      inflight, capacity: this.opts.capacity, oldestInflightAgeMs: oldest, outcomes: { ...this.outcomes },
      latencyMs: Object.fromEntries(CLASSES.map((c) => [c, { n: this.latencies[c].length, p50: percentile(this.latencies[c], 0.5), p95: percentile(this.latencies[c], 0.95) }])) as WorkerStatus['latencyMs'],
      inference: { providerCalls: s.providerCalls, cacheHits: s.cacheHits, coalesced: s.coalesced, invalidOutputs: s.invalidOutputs, retries: s.retries, errors: { ...s.errors }, httpP95Ms: percentile(s.httpMs, 0.95) },
      limiter: this.deps.limiter?.snapshot() ?? null,
    };
  }
}
