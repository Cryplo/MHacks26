/**
 * Command service. Every user intent gets ONE caller-generated commandId that is reused for
 * duplicate clicks, transport retries after a lost acknowledgement and (for durable intents
 * such as createRun/startRun) page reloads. Success is reported only from an accepted receipt.
 */
import type { Commands, DomainError, Id, RuntimeClient } from '../../contract/behavior-v1';
import { canonicalJson } from '../domain/canonical';
import { classifyError, domainError } from './errors';

export type CommandName = keyof Commands;
export type CommandOutcome<K extends CommandName> =
  | { kind: 'accepted'; commandId: Id; result: Commands[K]['output'] }
  | { kind: 'rejected'; commandId: Id; error: DomainError }
  | { kind: 'transport'; commandId: Id; error: DomainError };

export type PendingCommand = {
  intentKey: string; name: CommandName; commandId: Id; attempts: number;
  state: 'sending' | 'retrying' | 'transport_failed'; lastError: string | null;
};

type IntentRecord = { commandId: Id; payload: string };
export type IntentStore = {
  get(key: string): IntentRecord | null; set(key: string, rec: IntentRecord): void; delete(key: string): void;
};

export function memoryIntentStore(): IntentStore {
  const m = new Map<string, IntentRecord>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k) };
}

/** Durable intents survive reload (sessionStorage). Holds command IDs only, never secrets. */
export function sessionIntentStore(prefix = 'behavior-engine.intent.'): IntentStore {
  const s = () => window.sessionStorage;
  return {
    get: (k) => { try { const v = s().getItem(prefix + k); return v ? (JSON.parse(v) as IntentRecord) : null; } catch { return null; } },
    set: (k, v) => { try { s().setItem(prefix + k, JSON.stringify(v)); } catch { /* ignore */ } },
    delete: (k) => { try { s().removeItem(prefix + k); } catch { /* ignore */ } },
  };
}

export type RunnerOptions = {
  newId?: () => Id;
  maxAttempts?: number;
  retryDelayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  durable?: IntentStore;
};

export class CommandRunner {
  private readonly transient = memoryIntentStore();
  private readonly durable: IntentStore;
  private readonly inflight = new Map<string, Promise<CommandOutcome<CommandName>>>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly listeners = new Set<() => void>();
  private snapshot: PendingCommand[] = [];
  private readonly newId: () => Id;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly client: RuntimeClient, opts: RunnerOptions = {}) {
    this.newId = opts.newId ?? (() => `cmd-${crypto.randomUUID()}`);
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.retryDelayMs = opts.retryDelayMs ?? ((a) => Math.min(4000, 250 * 2 ** (a - 1)));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.durable = opts.durable ?? memoryIntentStore();
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  getPending = (): PendingCommand[] => this.snapshot;
  isPending = (intentKey: string) => this.pending.has(intentKey) && this.pending.get(intentKey)!.state !== 'transport_failed';

  private emit() {
    this.snapshot = [...this.pending.values()];
    this.listeners.forEach((l) => l());
  }

  /** The commandId currently bound to an intent (for display/tests). */
  commandIdFor(intentKey: string, durable = false): Id | null {
    return (durable ? this.durable : this.transient).get(intentKey)?.commandId ?? null;
  }

  run<K extends CommandName>(name: K, input: Commands[K]['input'], intentKey: string,
    opts: { durable?: boolean } = {}): Promise<CommandOutcome<K>> {
    const existing = this.inflight.get(intentKey);
    if (existing) return existing as Promise<CommandOutcome<K>>;
    const store = opts.durable ? this.durable : this.transient;
    const payload = canonicalJson({ name, input });
    let rec = store.get(intentKey);
    if (!rec || rec.payload !== payload) {
      rec = { commandId: this.newId(), payload }; // a changed payload is a new intent
      store.set(intentKey, rec);
    }
    const commandId = rec.commandId;
    const p = this.execute(name, input, intentKey, commandId).then((outcome) => {
      this.inflight.delete(intentKey);
      if (outcome.kind === 'transport') {
        this.pending.set(intentKey, { ...this.pending.get(intentKey)!, state: 'transport_failed' });
      } else {
        this.pending.delete(intentKey);
        if (!opts.durable) store.delete(intentKey); // the next user intent gets a fresh ID
      }
      this.emit();
      return outcome;
    });
    this.inflight.set(intentKey, p as Promise<CommandOutcome<CommandName>>);
    return p;
  }

  private async execute<K extends CommandName>(name: K, input: Commands[K]['input'], intentKey: string, commandId: Id): Promise<CommandOutcome<K>> {
    let lastError: DomainError = domainError('INTERNAL', 'not attempted');
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      this.pending.set(intentKey, { intentKey, name, commandId, attempts: attempt, state: attempt === 1 ? 'sending' : 'retrying', lastError: attempt === 1 ? null : lastError.message });
      this.emit();
      try {
        const receipt = await this.client.command(name, input, commandId);
        if (receipt.commandId !== commandId) {
          return { kind: 'rejected', commandId, error: domainError('INTERNAL', `Receipt for ${receipt.commandId} does not match command ${commandId}.`) };
        }
        return receipt.ok ? { kind: 'accepted', commandId, result: receipt.result } : { kind: 'rejected', commandId, error: receipt.error };
      } catch (e) {
        const c = classifyError(e);
        lastError = c.error;
        if (!c.transport) return { kind: 'rejected', commandId, error: c.error };
        if (attempt < this.maxAttempts) await this.sleep(this.retryDelayMs(attempt));
      }
    }
    return { kind: 'transport', commandId, error: lastError };
  }
}
