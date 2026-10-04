/** Product work requests: request -> poll status -> immutable result. Abortable. */
import type { Id, ProductRequest, RuntimeClient, WorkKind, WorkStatus } from '../../contract/behavior-v1';
import type { CommandOutcome, CommandRunner } from './commands';

export const TERMINAL: WorkStatus['status'][] = ['ready', 'applied', 'failed', 'cancelled', 'superseded'];

export class AbortedError extends Error {
  override name = 'AbortedError';
}

export async function awaitWork<K extends WorkKind>(client: RuntimeClient, workId: Id, opts: {
  signal?: AbortSignal; intervalMs?: number; timeoutMs?: number; onStatus?: (s: WorkStatus) => void;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
} = {}): Promise<Extract<WorkStatus, { kind: K }>> {
  const interval = opts.intervalMs ?? 400;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + (opts.timeoutMs ?? 120_000);
  for (;;) {
    if (opts.signal?.aborted) throw new AbortedError('work polling cancelled');
    const status = await client.query('getWork', { workId });
    if (opts.signal?.aborted) throw new AbortedError('work polling cancelled');
    opts.onStatus?.(status);
    if (TERMINAL.includes(status.status)) return status as Extract<WorkStatus, { kind: K }>;
    if (now() > deadline) throw new Error(`Work ${workId} still ${status.status} after ${Math.round((opts.timeoutMs ?? 120_000) / 1000)}s.`);
    await sleep(interval);
  }
}

export function requestWork(runner: CommandRunner, request: ProductRequest, intentKey: string):
  Promise<CommandOutcome<'requestProductWork'>> {
  return runner.run('requestProductWork', { request }, intentKey);
}
