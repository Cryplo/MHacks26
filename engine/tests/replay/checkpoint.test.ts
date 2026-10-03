import { it, expect } from "vitest";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import {
  runMock,
  mockResponse,
  scriptedChoice,
} from "../../fixtures/mock-driver.js";
import { createCore } from "../../src/domain/state.js";
import {
  startCore,
  advanceCore,
  acceptDecision,
} from "../../src/sim/engine.js";
import { Navigation } from "../../src/navigation/grid.js";
import { checkpoint, restore } from "../../src/replay/checkpoint.js";
import { physicalHash } from "../../src/replay/physical.js";
import { makeTape, validateTape } from "../../src/replay/tape.js";
import { MemoryStore, saveCore, loadCore } from "../../src/runtime/store.js";
function setup() {
  const p = tinyPark(),
    pop = tinyPopulation(p),
    m = tinyManifest(p, pop);
  m.config.horizonMs = 600000;
  return createCore("run", m, p, pop);
}
it("A-06 A-23 restart at all seven phases and twenty movement substeps preserves execution", () => {
  const expected = setup();
  runMock(expected);
  let actual = setup();
  startCore(actual);
  const nav = new Navigation(actual.park.grid),
    store = new MemoryStore();
  let count = 0;
  const phases = new Set<string>(),
    substeps = new Set<number>();
  while (actual.view.simMs < 10000) {
    phases.add(actual.view.phase);
    if (actual.view.phase === "integrate") substeps.add(actual.movementSubstep);
    expect(count++).toBeLessThan(10000);
    advanceCore(actual, nav, 1);
    if (actual.view.status === "blocked")
      for (const id of actual.view.blockedWorkIds) {
        const r = actual.decisions[id]!.request;
        acceptDecision(actual, mockResponse(r, scriptedChoice(actual, r)));
      }
    saveCore(store, actual);
    actual = loadCore(store, "run")!;
  }
  expect(phases.size).toBe(7);
  expect(substeps.size).toBe(21);
  runMock(actual);
  expect(physicalHash(actual)).toBe(physicalHash(expected));
}, 30000);
it("A-23 committed checkpoint restores identical physics under a new run scope", () => {
  const original = setup(),
    nav = new Navigation(original.park.grid);
  startCore(original);
  while (original.view.simMs < 150000 || original.view.phase !== "prepare") {
    advanceCore(original, nav, 1);
    if (original.view.status === "blocked")
      for (const id of original.view.blockedWorkIds) {
        const r = original.decisions[id]!.request;
        acceptDecision(original, mockResponse(r, scriptedChoice(original, r)));
      }
  }
  const c = checkpoint(original),
    branch = restore(c, "branch");
  expect(physicalHash(branch)).toBe(physicalHash(original));
  runMock(original);
  runMock(branch);
  expect(physicalHash(branch)).toBe(physicalHash(original));
  c.state.groups.g0!.balanceCents++;
  expect(() => restore(c, "tampered")).toThrow();
});
it("A-23 exact response tape replays every committed hash without inference", () => {
  const original = setup();
  runMock(original);
  const tape = makeTape(original),
    replayed = setup();
  validateTape(tape, replayed);
  startCore(replayed);
  const nav = new Navigation(replayed.park.grid);
  while (replayed.view.status !== "completed") {
    advanceCore(replayed, nav, 100, 1);
    if (replayed.view.status === "blocked")
      for (const id of replayed.view.blockedWorkIds) {
        const r = tape.responses.find((r) => r.requestId === id);
        expect(r).toBeDefined();
        acceptDecision(replayed, r!);
      }
  }
  expect(replayed.boundaries).toEqual(tape.boundaries);
  expect(physicalHash(replayed)).toBe(physicalHash(original));
});
