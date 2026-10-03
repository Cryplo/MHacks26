import type { Clock } from '../runtime/clock.ts';
import { ProviderError } from '../providers/types.ts';
import type { ExecutorClass, LimiterPort, Permit } from './ports.ts';

export type LimiterConfig = {
  /** Account-wide request rate; more workers do NOT raise it. Start conservatively. */
  requestsPerSecond: number; requestBurst: number;
  inputTokensPerMinute: number; tokenBurst: number;
  maxConcurrency: number;
  /** Concurrency slots usable only by barrier-critical behavior work. */
  reservedForBehavior: number;
  maxQueue: number;
  /** After this many consecutive behavior grants, a waiting non-behavior request is served next. */
  fairnessEvery: number;
  /** Optional per-class operational budgets (calls / input tokens); exceeding one is a visible stop. */
  budgets?: Partial<Record<ExecutorClass, { maxCalls?: number; maxInputTokens?: number }>>;
};

export const CONSERVATIVE_LIMITS: LimiterConfig = {
  requestsPerSecond: 2, requestBurst: 2, inputTokensPerMinute: 60_000, tokenBurst: 20_000,
  maxConcurrency: 4, reservedForBehavior: 1, maxQueue: 256, fairnessEvery: 4,
};

type Waiter = { cls: ExecutorClass; tokens: number; resolve: (p: Permit) => void; reject: (e: Error) => void; signal: AbortSignal; onAbort: () => void; seq: number };

/** Token buckets for requests and input tokens, bounded concurrency with behavior reservation, fair queueing. */
export class ProviderLimiter implements LimiterPort {
  private reqTokens: number;
  private inTokens: number;
  private last: number;
  private inUse = 0;
  private otherInUse = 0;
  private waiters: Waiter[] = [];
  private pausedUntil = 0;
  private behaviorStreak = 0;
  private timer: AbortController | null = null;
  private seq = 0;
  private stopped: string | null = null;
  readonly granted: Record<ExecutorClass, number> = { behavior: 0, measurement: 0, text: 0, experiment: 0 };
  readonly usedTokens: Record<ExecutorClass, number> = { behavior: 0, measurement: 0, text: 0, experiment: 0 };
  rejected = 0;

  constructor(private readonly cfg: LimiterConfig, private readonly clock: Clock) {
    if (cfg.reservedForBehavior >= cfg.maxConcurrency && cfg.maxConcurrency > 1) throw new Error('reservation must leave capacity for other classes');
    this.reqTokens = cfg.requestBurst;
    this.inTokens = cfg.tokenBurst;
    this.last = clock.nowEpochMs();
  }

  /** Operator stop: every pending and future acquisition fails visibly. */
  stop(reason: string): void {
    this.stopped = reason;
    for (const w of this.waiters.splice(0)) { w.signal.removeEventListener('abort', w.onAbort); w.reject(new ProviderError('budget', `operator stop: ${reason}`)); }
  }

  pauseUntil(epochMs: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, epochMs);
    this.schedule();
  }

  private refill(): void {
    const now = this.clock.nowEpochMs();
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.reqTokens = Math.min(this.cfg.requestBurst, this.reqTokens + dt * this.cfg.requestsPerSecond);
    this.inTokens = Math.min(this.cfg.tokenBurst, this.inTokens + (dt * this.cfg.inputTokensPerMinute) / 60);
  }

  acquire(cls: ExecutorClass, estimatedInputTokens: number, signal: AbortSignal): Promise<Permit> {
    if (this.stopped) return Promise.reject(new ProviderError('budget', `operator stop: ${this.stopped}`));
    if (signal.aborted) return Promise.reject(new ProviderError('aborted', 'aborted'));
    const budget = this.cfg.budgets?.[cls];
    if (budget?.maxCalls !== undefined && this.granted[cls] >= budget.maxCalls) return Promise.reject(new ProviderError('budget', `${cls} call budget ${budget.maxCalls} exhausted`));
    if (budget?.maxInputTokens !== undefined && this.usedTokens[cls] + estimatedInputTokens > budget.maxInputTokens) return Promise.reject(new ProviderError('budget', `${cls} token budget ${budget.maxInputTokens} exhausted`));
    if (this.waiters.length >= this.cfg.maxQueue) { this.rejected++; return Promise.reject(new ProviderError('rate_limited', 'local provider queue is full')); }
    return new Promise<Permit>((resolve, reject) => {
      const w: Waiter = {
        cls, tokens: Math.max(0, estimatedInputTokens), resolve, reject, signal, seq: ++this.seq,
        onAbort: () => { this.waiters = this.waiters.filter((x) => x !== w); reject(new ProviderError('aborted', 'aborted while queued')); },
      };
      signal.addEventListener('abort', w.onAbort, { once: true });
      this.waiters.push(w);
      this.pump();
    });
  }

  /** Behavior may use every slot; other classes together never occupy the reserved slots. */
  private fits(cls: ExecutorClass): boolean {
    if (this.inUse >= this.cfg.maxConcurrency) return false;
    return cls === 'behavior' || this.otherInUse < Math.max(1, this.cfg.maxConcurrency - this.cfg.reservedForBehavior);
  }

  private next(): Waiter | null {
    const behavior = this.waiters.filter((w) => w.cls === 'behavior');
    const others = this.waiters.filter((w) => w.cls !== 'behavior').sort((a, b) => a.seq - b.seq);
    const otherFits = others.find((w) => this.fits(w.cls));
    if (otherFits && (behavior.length === 0 || this.behaviorStreak >= this.cfg.fairnessEvery)) return otherFits;
    if (behavior.length && this.fits('behavior')) return behavior.sort((a, b) => a.seq - b.seq)[0]!;
    return otherFits ?? null;
  }

  private pump(): void {
    for (;;) {
      if (!this.waiters.length) return;
      const now = this.clock.nowEpochMs();
      if (now < this.pausedUntil) { this.schedule(); return; }
      this.refill();
      const w = this.next();
      if (!w) return;
      const needTokens = Math.min(w.tokens, this.cfg.tokenBurst);
      if (this.reqTokens < 1 || this.inTokens < needTokens) { this.schedule(); return; }
      this.reqTokens -= 1;
      this.inTokens -= needTokens;
      this.inUse += 1;
      if (w.cls !== 'behavior') this.otherInUse += 1;
      this.granted[w.cls] += 1;
      this.usedTokens[w.cls] += w.tokens;
      this.behaviorStreak = w.cls === 'behavior' ? this.behaviorStreak + 1 : 0;
      this.waiters = this.waiters.filter((x) => x !== w);
      w.signal.removeEventListener('abort', w.onAbort);
      let released = false;
      w.resolve({
        release: (actual) => {
          if (released) return;
          released = true;
          this.inUse -= 1;
          if (w.cls !== 'behavior') this.otherInUse -= 1;
          if (actual?.inputTokens != null) {
            const delta = actual.inputTokens - w.tokens;
            this.inTokens -= delta;
            this.usedTokens[w.cls] += delta;
          }
          this.pump();
        },
      });
    }
  }

  private schedule(): void {
    if (this.timer) return;
    const now = this.clock.nowEpochMs();
    this.refill();
    let wait = 0;
    if (now < this.pausedUntil) wait = this.pausedUntil - now;
    else {
      const w = this.next();
      if (!w) return;
      const needReq = Math.max(0, 1 - this.reqTokens) / this.cfg.requestsPerSecond;
      const needTok = Math.max(0, Math.min(w.tokens, this.cfg.tokenBurst) - this.inTokens) / (this.cfg.inputTokensPerMinute / 60);
      wait = Math.ceil(Math.max(needReq, needTok) * 1000);
    }
    const t = new AbortController();
    this.timer = t;
    this.clock.sleep(Math.max(1, wait), t.signal).then(() => { this.timer = null; this.pump(); }, () => { this.timer = null; });
  }

  /** Release timers (shutdown). */
  close(): void { this.timer?.abort(); this.timer = null; }

  snapshot(): Record<string, unknown> {
    const queued: Record<string, number> = {};
    for (const w of this.waiters) queued[w.cls] = (queued[w.cls] ?? 0) + 1;
    return {
      kind: 'provider-limiter', config: this.cfg, inUse: this.inUse, nonBehaviorInUse: this.otherInUse, queued, requestTokens: this.reqTokens, inputTokens: this.inTokens,
      pausedUntil: this.pausedUntil || null, granted: { ...this.granted }, usedTokens: { ...this.usedTokens }, rejected: this.rejected, stopped: this.stopped,
    };
  }
}
