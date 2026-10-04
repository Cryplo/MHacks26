import type { FakeRuntimeServer } from '../../src/runtime/fake-runtime.ts';
import { InstantClock, MemoryLogger } from '../../src/runtime/clock.ts';
import { createOrchestrationWorld } from '../../src/fixtures/orchestration.ts';
import type { OrchestrationWorldOptions } from '../../src/fixtures/orchestration.ts';

export { experimentConfig } from '../../src/fixtures/orchestration.ts';

export type WorldOptions = Omit<OrchestrationWorldOptions, 'clock'>;

/** ORCHESTRATION-ONLY world on an instant clock (see src/fixtures/orchestration.ts). */
export function experimentWorld(o: WorldOptions = {}) {
  const logger = new MemoryLogger();
  const w = createOrchestrationWorld({ ...o, clock: new InstantClock(), logger });
  return { ...w, clock: w.clock as InstantClock, logger };
}

/** Sum of completed steps per run over every APPLIED advanceRun receipt (detects double advancing). */
export function appliedAdvanceSteps(server: FakeRuntimeServer): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, v] of server.receipts) {
    if (!key.startsWith('coordinator\u0000') || !v.receipt.ok) continue;
    const r = v.receipt.result as { run?: { runId: string }; completedSteps?: number };
    if (!r.run || r.completedSteps === undefined || !key.includes(':advance:')) continue;
    out.set(r.run.runId, (out.get(r.run.runId) ?? 0) + r.completedSteps);
  }
  return out;
}
