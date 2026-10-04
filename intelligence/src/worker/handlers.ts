import type { Id, ParkBundle, RuntimeClient, Scope, WorkKind, WorkLease, WorkPayloads, WorkResults } from '../../contract/behavior-v1.ts';
import { sha256Hex } from '../core/canonical.ts';
import { generatePopulation } from '../population/index.ts';
import { parkContext } from '../population/park.ts';
import type { ProseProvider } from '../population/prose.ts';
import type { Clock, Logger } from '../runtime/clock.ts';
import type { IdSource } from '../runtime/commands.ts';
import { artifactCommandId } from '../runtime/commands.ts';
import type { InferenceService } from './inference.ts';
import { InvalidRequestError } from './inference.ts';
import type { ExecutorClass } from './ports.ts';

export type HandlerContext = {
  workId: Id; scope: Scope; signal: AbortSignal;
  client: RuntimeClient; inference: InferenceService; clock: Clock; ids: IdSource; logger: Logger;
  onCallStarted: (callId: Id) => Promise<void>;
  /** Current (renewed) lease of this item, for fenced progress commands. */
  lease: () => WorkLease;
  /** Renews owned leases now; false when this item's lease is lost. */
  renewLease: () => Promise<boolean>;
};

export type Handler<K extends WorkKind> = (payload: WorkPayloads[K], ctx: HandlerContext) => Promise<WorkResults[K]>;
export type Handlers = { [K in WorkKind]?: Handler<K> };

export function executorClassOf(kind: WorkKind): ExecutorClass {
  switch (kind) {
    case 'decision': return 'behavior';
    case 'rating': return 'measurement';
    case 'experiment': return 'experiment';
    default: return 'text';
  }
}

export const decisionHandler: Handler<'decision'> = (payload, ctx) =>
  ctx.inference.decide(ctx.workId, ctx.scope, payload, ctx.signal, { onCallStarted: ctx.onCallStarted });

export const ratingHandler: Handler<'rating'> = (payload, ctx) =>
  ctx.inference.rate(ctx.workId, ctx.scope, payload, ctx.signal, { onCallStarted: ctx.onCallStarted });

/** Loads and verifies the park artifact, generates the frozen manifest and uploads it. */
export function populationHandler(opts: { prose?: ProseProvider | null; maxGuests?: number } = {}): Handler<'population'> {
  return async (payload, ctx) => {
    if (payload.park.kind !== 'park') throw new InvalidRequestError('population job park reference is not a park artifact');
    const bytes = await ctx.client.getArtifact(payload.park);
    if (sha256Hex(bytes) !== payload.park.sha256 || bytes.byteLength !== payload.park.byteLength) {
      throw new InvalidRequestError('park artifact hash/length mismatch');
    }
    const bundle = JSON.parse(new TextDecoder().decode(bytes)) as ParkBundle;
    let park;
    try { park = parkContext(bundle, payload.park.sha256); } catch (e) { throw new InvalidRequestError(`invalid park: ${(e as Error).message}`); }
    const r = await generatePopulation({
      crowd: payload.crowd, park, closeAfterMs: payload.closeAfterMs, maxGuests: opts.maxGuests, prose: opts.prose ?? null, signal: ctx.signal,
    });
    if (!r.ok) throw new InvalidRequestError(`population request cannot be satisfied: ${r.errors.map((e) => e.message).join('; ')}`, r.errors);
    const artifact = await ctx.client.putArtifact({
      kind: 'population', mediaType: 'application/json', bytes: r.bytes, scope: ctx.scope, commandId: artifactCommandId('population', r.sha256, ctx.scope),
    });
    return { artifact, guestCount: r.manifest.personas.length, groupCount: r.manifest.groups.length };
  };
}
