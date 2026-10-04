import { sanitize } from '../core/errors.ts';

/** Operational (wall-time) ports. Simulation time never comes from here. */
export interface Clock {
  nowEpochMs(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Jitter {
  /** Operational jitter in [0, 1). Not simulation randomness. */
  next(): number;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface Logger {
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void;
}

export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export const systemClock: Clock = {
  nowEpochMs: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = () => { clearTimeout(t); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  }),
};

export const systemJitter: Jitter = { next: () => Math.random() };

/** Manual clock for deterministic tests: sleeps resolve only when time is advanced. */
export class ManualClock implements Clock {
  private waiters: { at: number; resolve: () => void; reject: (e: Error) => void; signal?: AbortSignal; onAbort?: () => void }[] = [];
  constructor(private now = 1_700_000_000_000) {}

  nowEpochMs(): number { return this.now; }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const w: (typeof this.waiters)[number] = { at: this.now + Math.max(0, ms), resolve, reject };
      if (signal) {
        w.signal = signal;
        w.onAbort = () => { this.waiters = this.waiters.filter((x) => x !== w); reject(abortError()); };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.push(w);
      if (ms <= 0) this.flush();
    });
  }

  get pendingSleeps(): number { return this.waiters.length; }

  advance(ms: number): void {
    this.now += ms;
    this.flush();
  }

  /** Advance to the next pending wake-up, if any. */
  advanceToNext(): boolean {
    if (this.waiters.length === 0) return false;
    const next = Math.min(...this.waiters.map((w) => w.at));
    this.now = Math.max(this.now, next);
    this.flush();
    return true;
  }

  private flush(): void {
    const due = this.waiters.filter((w) => w.at <= this.now);
    this.waiters = this.waiters.filter((w) => w.at > this.now);
    for (const w of due) {
      if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
      w.resolve();
    }
  }
}

/** Test clock whose sleeps complete immediately while advancing virtual time and recording durations. */
export class InstantClock implements Clock {
  readonly sleeps: number[] = [];
  constructor(private now = 1_700_000_000_000) {}
  nowEpochMs(): number { return this.now; }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError();
    this.sleeps.push(ms);
    this.now += Math.max(0, ms);
  }
}

export class SequenceJitter implements Jitter {
  private i = 0;
  constructor(private readonly values: number[] = [0.5]) {}
  next(): number { return this.values[this.i++ % this.values.length]!; }
}

export class MemoryLogger implements Logger {
  readonly entries: { level: LogLevel; event: string; fields: Record<string, unknown> }[] = [];
  log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    this.entries.push({ level, event, fields });
  }
  text(): string { return this.entries.map((e) => `${e.level} ${e.event} ${JSON.stringify(e.fields)}`).join('\n'); }
}

/** Machine-readable JSON-lines logger; every line is passed through `sanitize` before it is written. */
export function jsonLineLogger(
  write: (line: string) => void = (l) => process.stderr.write(`${l}\n`),
  clock: Clock = systemClock,
  secrets: readonly string[] = [],
): Logger {
  return {
    log(level, event, fields = {}) {
      write(sanitize(JSON.stringify({ t: new Date(clock.nowEpochMs()).toISOString(), level, event, ...fields }), secrets));
    },
  };
}
