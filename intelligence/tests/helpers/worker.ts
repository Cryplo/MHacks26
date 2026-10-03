import type { RuntimeClient } from '../../contract/behavior-v1.ts';
import type { BehaviorProvider } from '../../src/providers/types.ts';
import { MockProvider } from '../../src/providers/mock.ts';
import { ManualClock, MemoryLogger, SequenceJitter } from '../../src/runtime/clock.ts';
import { CounterIds } from '../../src/runtime/commands.ts';
import { MemoryStore } from '../../src/runtime/store.ts';
import type { CreateWorkerInput } from '../../src/worker/factory.ts';
import { createWorker } from '../../src/worker/factory.ts';

export function buildWorker(client: RuntimeClient, over: Partial<CreateWorkerInput> & { provider?: BehaviorProvider; clock?: ManualClock } = {}) {
  const clock = over.clock ?? new ManualClock();
  const logger = new MemoryLogger();
  const store = over.store ?? new MemoryStore();
  const built = createWorker({
    client, provider: over.provider ?? new MockProvider(), store, clock, jitter: new SequenceJitter([0.5]),
    ids: over.ids ?? new CounterIds('w'), logger, ...over,
  });
  return { ...built, clock, logger, store };
}

/** Let pending microtasks/promises settle (no wall-clock sleeps). */
export async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** Drive a manual clock (wake pending sleeps) until `p` settles. */
export async function pump<T>(clock: ManualClock, p: Promise<T>, maxSteps = 500): Promise<T> {
  let done = false;
  const wrapped = p.finally(() => { done = true; });
  for (let i = 0; i < maxSteps && !done; i++) {
    await settle(5);
    if (!done) clock.advanceToNext();
  }
  if (!done) throw new Error('pump: promise did not settle');
  return wrapped;
}
