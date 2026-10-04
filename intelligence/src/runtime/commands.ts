import { randomUUID } from 'node:crypto';
import type { Commands, Id, Receipt, RuntimeClient } from '../../contract/behavior-v1.ts';
import { isRuntimeClientError } from '../core/errors.ts';
import type { Clock, Jitter, Logger } from './clock.ts';
import { backoffDelayMs } from '../worker/backoff.ts';
import { canonicalJson, sha256Hex } from '../core/canonical.ts';

/** Operational identifiers (command IDs, call IDs, nonces). Never used for simulation randomness. */
export interface IdSource {
  next(prefix: string): Id;
}

export const uuidIds: IdSource = { next: (prefix) => `${prefix}:${randomUUID()}` };

export class CounterIds implements IdSource {
  private n = 0;
  constructor(private readonly namespace = 't') {}
  next(prefix: string): Id { return `${prefix}:${this.namespace}${++this.n}`; }
}

export type CommandRunnerOptions = {
  clock: Clock; jitter: Jitter; logger?: Logger;
  maxTransportRetries?: number; baseDelayMs?: number; maxDelayMs?: number;
  signal?: AbortSignal;
};

/**
 * Sends a command and retries ONLY transport failures, always with the same command ID,
 * so a lost acknowledgement resolves to the original durable receipt.
 */
export async function runCommand<K extends keyof Commands>(
  client: RuntimeClient, name: K, input: Commands[K]['input'], commandId: Id, opts: CommandRunnerOptions,
): Promise<Receipt<Commands[K]['output']>> {
  const max = opts.maxTransportRetries ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.command(name, input, commandId);
    } catch (e) {
      if (!isRuntimeClientError(e) || !e.transport || attempt >= max || opts.signal?.aborted) throw e;
      const delay = backoffDelayMs(attempt, { baseMs: opts.baseDelayMs ?? 200, maxMs: opts.maxDelayMs ?? 5000 }, opts.jitter);
      opts.logger?.log('warn', 'command.transport_retry', { name, commandId, attempt: attempt + 1, delayMs: delay });
      await opts.clock.sleep(delay, opts.signal);
    }
  }
}

/**
 * Command ID for uploading an immutable artifact. Content-addressed AND scope-bound: the same
 * bytes uploaded into a different run/experiment scope are a different intent, so they need a
 * different ID (Engine digests the whole payload, including scope, per receipt ID).
 */
export function artifactCommandId(kind: string, sha256: string, scope: { runId: string | null; experimentId: string | null }): Id {
  return `artifact:${kind}:${sha256.slice(0, 40)}:${sha256Hex(canonicalJson(scope)).slice(0, 16)}`;
}
