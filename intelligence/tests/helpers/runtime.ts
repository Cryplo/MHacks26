import { ManualClock } from '../../src/runtime/clock.ts';
import type { FakeRuntimeOptions } from '../../src/runtime/fake-runtime.ts';
import { FakeRuntimeServer } from '../../src/runtime/fake-runtime.ts';

export function fakeServer(extra: Partial<FakeRuntimeOptions> = {}, clock = new ManualClock()) {
  const server = new FakeRuntimeServer({
    clock,
    identities: { worker: ['worker'], worker2: ['worker'], coordinator: ['coordinator'], operator: ['operator'], viewer: ['viewer'] },
    ...extra,
  });
  return { server, clock };
}
