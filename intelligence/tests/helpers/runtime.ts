import type { Clock } from '../../src/runtime/clock.ts';
import { ManualClock } from '../../src/runtime/clock.ts';
import type { FakeRuntimeOptions } from '../../src/runtime/fake-runtime.ts';
import { FakeRuntimeServer } from '../../src/runtime/fake-runtime.ts';

export function fakeServer<C extends Clock = ManualClock>(extra: Partial<FakeRuntimeOptions> = {}, clock: C = new ManualClock() as unknown as C) {
  const server = new FakeRuntimeServer({
    clock,
    identities: { worker: ['worker'], worker2: ['worker'], coordinator: ['coordinator'], operator: ['operator'], viewer: ['viewer'] },
    ...extra,
  });
  return { server, clock };
}
