import { it, expect } from "vitest";
import fc from "fast-check";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import { createCore } from "../../src/domain/state.js";
import { moveSubstep, segmentDistance } from "../../src/sim/motion.js";
import { Navigation } from "../../src/navigation/grid.js";
import { physicalHash } from "../../src/replay/physical.js";
it("A-04 A-05 reversing person/group insertion preserves simultaneous motion and own poses", () => {
  fc.assert(
    fc.property(fc.integer({ min: 3, max: 30 }), (count) => {
      const park = tinyPark(),
        population = tinyPopulation(park, count),
        a = createCore("a", tinyManifest(park, population), park, population),
        b = structuredClone(a);
      b.runId = "b";
      for (const s of [a, b]) {
        for (const p of Object.values(s.persons)) {
          p.state = "walking";
          p.admittedAtMs = 0;
        }
        for (const g of Object.values(s.groups))
          g.target = { xM: 10.5, yM: 10.5 };
      }
      b.persons = Object.fromEntries(Object.entries(b.persons).reverse());
      b.groups = Object.fromEntries(Object.entries(b.groups).reverse());
      const nav = new Navigation(park.grid);
      for (let i = 0; i < 30; i++) {
        moveSubstep(a, nav);
        moveSubstep(b, nav);
      }
      expect(physicalHash(a)).toBe(physicalHash(b));
      const points = Object.values(a.persons).map(
        (p) => `${p.position.xM},${p.position.yM}`,
      );
      expect(new Set(points).size).toBeGreaterThan(1);
      for (const p of Object.values(a.persons)) {
        expect(
          Number.isFinite(p.position.xM) && Number.isFinite(p.position.yM),
        ).toBe(true);
        expect(nav.walkable(nav.cell(p.position))).toBe(true);
      }
    }),
    { numRuns: 10, seed: 413 },
  );
});
it("A-03 swept notice distance catches a crossed region even with both endpoints outside", () => {
  expect(
    segmentDistance({ xM: 0, yM: 0 }, { xM: 10, yM: 0 }, { xM: 5, yM: 1 }),
  ).toBe(1);
});
it("A-04 400 initially coincident guests remain finite and on walkable cells over 240 substeps", () => {
  const p = tinyPark(),
    pop = tinyPopulation(p, 400),
    s = createCore("load", tinyManifest(p, pop), p, pop),
    nav = new Navigation(p.grid);
  for (const person of Object.values(s.persons)) {
    person.state = "walking";
    person.admittedAtMs = 0;
  }
  for (const g of Object.values(s.groups)) g.target = { xM: 10.5, yM: 10.5 };
  for (let i = 0; i < 240; i++) {
    s.movementSubstep = i % 20;
    moveSubstep(s, nav);
  }
  for (const person of Object.values(s.persons)) {
    expect(
      Number.isFinite(person.position.xM) &&
        Number.isFinite(person.position.yM),
    ).toBe(true);
    expect(nav.walkable(nav.cell(person.position))).toBe(true);
  }
}, 20000);
