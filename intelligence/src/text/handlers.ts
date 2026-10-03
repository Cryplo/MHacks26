import type { Narrative, ParkBundle } from '../../contract/behavior-v1.ts';
import { sha256Hex } from '../core/canonical.ts';
import { composeReport, validateFactBundle } from '../reports/narrative.ts';
import type { ReportProseProvider } from '../reports/narrative.ts';
import type { DurableStore } from '../runtime/store.ts';
import { getJson, jsonBytes } from '../runtime/store.ts';
import type { Handler } from '../worker/handlers.ts';
import { InvalidRequestError } from '../worker/inference.ts';
import { parseCrowdText } from './crowd.ts';
import type { NarrationProvider } from './narration.ts';
import { narrateDecision, narrationId, validateEvidence } from './narration.ts';
import { ScenarioContextError, parseScenarioText } from './scenario.ts';

export function parseCrowdHandler(opts: { maxGuests?: number } = {}): Handler<'parse_crowd'> {
  return async (payload) => {
    if (typeof payload.text !== 'string') throw new InvalidRequestError('parse_crowd text must be a string');
    return parseCrowdText(payload.text, payload.current, opts);
  };
}

/** Grounds the parse in the verified park artifact named by the context. Never schedules anything. */
export const parseScenarioHandler: Handler<'parse_scenario'> = async (payload, ctx) => {
  const ref = payload.context.park.artifact;
  if (ref.kind !== 'park') throw new InvalidRequestError('scenario context park artifact is not a park');
  const bytes = await ctx.client.getArtifact(ref);
  if (sha256Hex(bytes) !== ref.sha256 || bytes.byteLength !== ref.byteLength) throw new InvalidRequestError('park artifact hash/length mismatch');
  const park = JSON.parse(new TextDecoder().decode(bytes)) as ParkBundle;
  try {
    return parseScenarioText(payload.text, payload.context, park);
  } catch (e) {
    if (e instanceof ScenarioContextError) throw new InvalidRequestError(`stale or invalid scenario context: ${e.message}`);
    throw e;
  }
};

/** Narration is deduplicated by evidence/member/version; a stored narrative stays with its original evidence. */
export function thoughtHandler(opts: { store: DurableStore; provider?: NarrationProvider | null }): Handler<'thought'> {
  return async (payload, ctx) => {
    const errs = validateEvidence(payload.evidence, payload.agentId);
    if (errs.length) throw new InvalidRequestError(`invalid decision evidence: ${errs.join('; ')}`);
    const key = `narration/${narrationId(payload.evidence, payload.agentId)}`;
    const existing = await getJson<Narrative>(opts.store, key);
    if (existing) return existing;
    const { narrative, fallbackReason } = await narrateDecision(payload.evidence, payload.agentId, opts.provider ?? null, ctx.signal);
    if (fallbackReason) ctx.logger.log('warn', 'narration.fallback', { evidenceId: payload.evidence.evidenceId, reason: fallbackReason });
    const stored = await opts.store.putIfAbsent(key, jsonBytes(narrative));
    return JSON.parse(new TextDecoder().decode(stored.value)) as Narrative;
  };
}

export function reportHandler(opts: { provider?: ReportProseProvider | null } = {}): Handler<'report'> {
  return async (payload, ctx) => {
    const errs = validateFactBundle(payload.facts);
    if (errs.length) throw new InvalidRequestError(`invalid fact bundle: ${errs.join('; ')}`);
    const { narrative, fallbackReason } = await composeReport(payload.facts, opts.provider ?? null, ctx.signal);
    if (fallbackReason) ctx.logger.log('warn', 'report.fallback', { bundleId: payload.facts.id, reason: fallbackReason });
    return narrative;
  };
}
