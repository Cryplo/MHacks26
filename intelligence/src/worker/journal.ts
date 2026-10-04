import type { Id, WorkKind, WorkLease } from '../../contract/behavior-v1.ts';
import type { DurableStore } from '../runtime/store.ts';
import { getJson, putJson } from '../runtime/store.ts';

export type JournalState =
  | 'claimed'      // lease received, nothing external done yet
  | 'calling'      // a provider attempt was started (billing may have occurred)
  | 'response'     // a validated result is persisted locally
  | 'submitting'   // completeWork sent with completeCommandId (may need same-ID retry)
  | 'done' | 'lost' | 'failed' | 'relinquished';

export type JournalEntry = {
  workId: Id; kind: WorkKind; lease: WorkLease; payloadHash: string;
  state: JournalState; callIds: Id[]; result: unknown | null;
  completeCommandId: Id | null; note: string | null; updatedAtEpochMs: number;
};

const TERMINAL: ReadonlySet<JournalState> = new Set(['done', 'lost', 'failed', 'relinquished']);
export const isTerminal = (s: JournalState) => TERMINAL.has(s);

/**
 * Durable per-work processing journal, written before and after each external call/submission.
 * A write from an older attempt never overwrites a newer attempt's entry.
 */
export class Journal {
  constructor(private readonly store: DurableStore) {}

  private key(workId: Id) { return `journal/${workId.replace(/[^A-Za-z0-9_.:-]/g, '_')}`; }

  get(workId: Id): Promise<JournalEntry | null> { return getJson<JournalEntry>(this.store, this.key(workId)); }

  /** Returns false (and writes nothing) when a newer attempt already owns the entry. */
  async write(entry: JournalEntry): Promise<boolean> {
    const prior = await this.get(entry.workId);
    if (prior && prior.lease.attempt > entry.lease.attempt) return false;
    await putJson(this.store, this.key(entry.workId), entry);
    return true;
  }

  async update(workId: Id, attempt: number, patch: Partial<JournalEntry>, now: number): Promise<JournalEntry | null> {
    const prior = await this.get(workId);
    if (!prior || prior.lease.attempt !== attempt) return null;
    const next = { ...prior, ...patch, updatedAtEpochMs: now };
    await putJson(this.store, this.key(workId), next);
    return next;
  }

  async open(): Promise<JournalEntry[]> {
    const out: JournalEntry[] = [];
    for (const k of await this.store.list('journal/')) {
      const e = await getJson<JournalEntry>(this.store, k);
      if (e && !isTerminal(e.state)) out.push(e);
    }
    return out;
  }
}
