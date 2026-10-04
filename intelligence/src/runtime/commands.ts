import { randomUUID } from 'node:crypto';
import type { Commands, Id, Receipt, RuntimeClient } from '../../contract/behavior-v1.ts';
import { isRuntimeClientError } from '../core/errors.ts';
import type { Clock, Jitter, Logger } from './clock.ts';
import { backoffDelayMs } from '../worker/backoff.ts';

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
