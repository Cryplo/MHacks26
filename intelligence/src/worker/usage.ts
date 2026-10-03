import type { Id, ProviderAttempt, RuntimeClient } from '../../contract/behavior-v1.ts';
import type { Clock, Jitter, Logger } from '../runtime/clock.ts';
import { runCommand } from '../runtime/commands.ts';
import type { DurableStore } from '../runtime/store.ts';
import { getJson, putJson } from '../runtime/store.ts';

/**
 * Documented price configuration used ONLY for labeled estimates when the provider does not report
 * cost. The per-token rate is derived from the public documentation example (62 input tokens ->
 * $0.000026) and is unverified; actual provider-reported cost always takes precedence.
 */
export const PRICE_CONFIG = {
  version: 'jev-price-estimate-2026-10-v1',
  usdPerInputToken: 0.000026 / 62,
  usdPerOutputToken: 0,
} as const;

export type LedgerRecord = {
  attempt: ProviderAttempt;
  /** Requests that consumed this call's response (coalesced beneficiaries); billed once to the owner. */
  beneficiaries: Id[];
  costBasis: 'provider_reported' | 'estimated' | 'unknown' | 'none';
  telemetry: { started: boolean; finished: boolean };
};

export type UsageTotals = {
  calls: number; finishedCalls: number; unknownCalls: number; failedCalls: number;
  inputTokens: number; outputTokens: number; tokenCoverage: number;
  reportedCostUsd: number; estimatedCostUsd: number; unknownCostCalls: number;
  byRun: Record<string, { calls: number; inputTokens: number; costUsd: number }>;
};

export class UsageLedger {
  constructor(
    private readonly store: DurableStore, private readonly client: RuntimeClient,
    private readonly ops: { clock: Clock; jitter: Jitter; logger?: Logger },
  ) {}

  private key(callId: Id) { return `usage/${callId.replace(/[^A-Za-z0-9_.:-]/g, '_')}`; }

  async get(callId: Id): Promise<LedgerRecord | null> { return getJson<LedgerRecord>(this.store, this.key(callId)); }

  /** Persist locally, then submit the started record. Throws if it cannot be submitted (no billable call then). */
  async started(attempt: ProviderAttempt): Promise<void> {
    if (attempt.phase !== 'started') throw new Error('started() requires phase started');
    const prior = await this.get(attempt.callId);
    if (prior) return;
    const rec: LedgerRecord = { attempt, beneficiaries: [attempt.workId], costBasis: 'unknown', telemetry: { started: false, finished: false } };
    await putJson(this.store, this.key(attempt.callId), rec);
    await this.submit(rec, 'started');
  }

  /** Persist the finished record (never regressing), then try to submit; failures are retried by flush(). */
  async finished(attempt: ProviderAttempt, costBasis: LedgerRecord['costBasis']): Promise<void> {
    const prior = await this.get(attempt.callId);
    const rec: LedgerRecord = {
      attempt: { ...attempt, phase: 'finished' }, beneficiaries: prior?.beneficiaries ?? [attempt.workId], costBasis,
      telemetry: { started: prior?.telemetry.started ?? false, finished: false },
    };
    await putJson(this.store, this.key(attempt.callId), rec);
    try { await this.submit(rec, 'finished'); } catch (e) {
      this.ops.logger?.log('warn', 'usage.telemetry_deferred', { callId: attempt.callId, error: (e as Error).message });
    }
  }

  async addBeneficiary(callId: Id, workId: Id): Promise<void> {
    const rec = await this.get(callId);
    if (!rec || rec.beneficiaries.includes(workId)) return;
    rec.beneficiaries.push(workId);
    await putJson(this.store, this.key(callId), rec);
  }

  private async submit(rec: LedgerRecord, phase: 'started' | 'finished'): Promise<void> {
    if (phase === 'started' && rec.telemetry.started) return;
    if (phase === 'finished' && rec.telemetry.finished) return;
    const attempt: ProviderAttempt = phase === 'started'
      ? { ...rec.attempt, phase: 'started', durationMs: null, outcome: null, modelReturned: null, inputTokens: null, outputTokens: null, estimatedCostUsd: null, priceVersion: null }
      : rec.attempt;
    const receipt = await runCommand(this.client, 'recordProviderAttempt', { attempt }, `attempt:${rec.attempt.callId}:${phase}`, { ...this.ops, maxTransportRetries: 3 });
    if (!receipt.ok) {
      this.ops.logger?.log('error', 'usage.telemetry_rejected', { callId: rec.attempt.callId, phase, code: receipt.error.code });
      if (phase === 'started') throw new Error(`started telemetry rejected: ${receipt.error.code}`);
    }
    const cur = (await this.get(rec.attempt.callId)) ?? rec;
    cur.telemetry[phase] = true;
    await putJson(this.store, this.key(rec.attempt.callId), cur);
  }

  /** Re-submit any telemetry not yet acknowledged (e.g. after reconnect). Started-only calls stay unknown. */
  async flush(): Promise<number> {
    let sent = 0;
    for (const k of await this.store.list('usage/')) {
      const rec = await getJson<LedgerRecord>(this.store, k);
      if (!rec) continue;
      try {
        if (!rec.telemetry.started) { await this.submit(rec, 'started'); sent++; }
        if (rec.attempt.phase === 'finished' && !rec.telemetry.finished) { await this.submit(rec, 'finished'); sent++; }
      } catch (e) {
        this.ops.logger?.log('warn', 'usage.flush_failed', { callId: rec.attempt.callId, error: (e as Error).message });
      }
    }
    return sent;
  }

  async records(): Promise<LedgerRecord[]> {
    const out: LedgerRecord[] = [];
    for (const k of await this.store.list('usage/')) { const r = await getJson<LedgerRecord>(this.store, k); if (r) out.push(r); }
    return out;
  }

  /** Account-wide totals counting each call ID exactly once; unknown usage is never summed as zero. */
  async totals(): Promise<UsageTotals> {
    return summarizeUsage(await this.records());
  }
}

export function summarizeUsage(records: LedgerRecord[]): UsageTotals {
  const t: UsageTotals = {
    calls: 0, finishedCalls: 0, unknownCalls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, tokenCoverage: 0,
    reportedCostUsd: 0, estimatedCostUsd: 0, unknownCostCalls: 0, byRun: {},
  };
  const seen = new Set<string>();
  let withTokens = 0;
  for (const r of records) {
    const a = r.attempt;
    if (seen.has(a.callId)) continue;
    seen.add(a.callId);
    t.calls += 1;
    if (a.phase !== 'finished') { t.unknownCalls += 1; t.unknownCostCalls += 1; continue; }
    t.finishedCalls += 1;
    if (a.outcome !== 'success') t.failedCalls += 1;
    if (a.inputTokens !== null) { t.inputTokens += a.inputTokens; withTokens += 1; }
    if (a.outputTokens !== null) t.outputTokens += a.outputTokens;
    if (a.estimatedCostUsd === null) t.unknownCostCalls += 1;
    else if (r.costBasis === 'provider_reported') t.reportedCostUsd += a.estimatedCostUsd;
    else t.estimatedCostUsd += a.estimatedCostUsd;
    const run = a.billingOwnerRunId ?? 'common';
    const b = (t.byRun[run] ??= { calls: 0, inputTokens: 0, costUsd: 0 });
    b.calls += 1; b.inputTokens += a.inputTokens ?? 0; b.costUsd += a.estimatedCostUsd ?? 0;
  }
  t.tokenCoverage = t.finishedCalls ? withTokens / t.finishedCalls : 0;
  return t;
}

/** Cost for an attempt: provider-reported when present, else a labeled estimate from tokens, else unknown. */
export function costFor(usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }): { usd: number | null; basis: LedgerRecord['costBasis']; priceVersion: string | null } {
  if (usage.costUsd !== null && Number.isFinite(usage.costUsd)) return { usd: usage.costUsd, basis: 'provider_reported', priceVersion: 'provider-reported' };
  if (usage.inputTokens !== null) {
    return { usd: usage.inputTokens * PRICE_CONFIG.usdPerInputToken + (usage.outputTokens ?? 0) * PRICE_CONFIG.usdPerOutputToken, basis: 'estimated', priceVersion: PRICE_CONFIG.version };
  }
  return { usd: null, basis: 'unknown', priceVersion: null };
}
