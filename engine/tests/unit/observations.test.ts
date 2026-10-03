import { it, expect } from "vitest";
import { tinyPark, tinyPopulation, tinyManifest } from "../../fixtures/tiny.js";
import { createCore } from "../../src/domain/state.js";
import { Navigation } from "../../src/navigation/grid.js";
import {
  makeRequest,
  observation,
  observeEntrance,
  checkNeeds,
  observe,
} from "../../src/sim/observations.js";
import { applyAction } from "../../src/sim/actions.js";
import { advanceCore, startCore } from "../../src/sim/engine.js";
function setup() {
  const p = tinyPark(),
    pop = tinyPopulation(p, 3),
    s = createCore("run", tinyManifest(p, pop), p, pop),
    g = s.groups.g0!,
    nav = new Navigation(p.grid);
  for (const person of Object.values(s.persons)) {
    person.state = "deciding";
    person.admittedAtMs = 0;
  }
  return { s, g, nav };
}
it("A-11 hidden closures are absent from observations and cannot filter travel until observed", () => {
  const { s, g, nav } = setup();
  s.places.ride!.closed = true;
  expect(observation(s, g, nav).facts.some((f) => f.kind === "closure")).toBe(
    false,
  );
  expect(
    makeRequest(s, g, nav).options.some((o) => o.id === "travel:ride"),
  ).toBe(true);
  observeEntrance(s, g, "ride");
  const r = makeRequest(s, g, nav);
  expect(r.options.some((o) => o.id === "travel:ride")).toBe(false);
  expect(r.candidateAudit.excluded).toContainEqual({
    id: "ride",
    reason: "observed closure",
  });
});
it("A-11 notice content versions deduplicate member exposure while stale boards remain immutable", () => {
  const { s, g } = setup();
  observeEntrance(s, g, "ride");
  const old = s.persons.a0!.facts[0]!;
  s.places.ride!.definition.board = {
    kind: "fixed",
    text: "Changed",
    lowerMin: 5,
    upperMin: 5,
  };
  observeEntrance(s, g, "ride");
  expect(old.text).toContain("2 minutes");
  expect(s.persons.a0!.facts.filter((f) => f.kind === "board")).toHaveLength(2);
  const f = { ...old, kind: "notice" as const, contentVersion: "notice1" };
  expect(observe(s, s.persons.a0!, f)).toBe(true);
  expect(observe(s, s.persons.a0!, f)).toBe(false);
  expect(observe(s, s.persons.a1!, f)).toBe(true);
});
it("A-12 hunger hysteresis and active service suppression", () => {
  const { s, g } = setup();
  s.view.simMs = 600000;
  g.pendingMoment = null;
  g.needArmed = true;
  s.persons.a0!.needs.hunger = 80;
  checkNeeds(s, g);
  expect(g.pendingMoment).toBe("hungry_tired");
  g.pendingMoment = null;
  s.view.simMs += 600000;
  checkNeeds(s, g);
  expect(g.pendingMoment).toBeNull();
  for (const p of Object.values(s.persons)) {
    p.needs.hunger = 0;
    p.needs.fatigue = 0;
  }
  checkNeeds(s, g);
  expect(g.needArmed).toBe(true);
  s.persons.a0!.state = "riding";
  s.persons.a0!.needs.hunger = 99;
  checkNeeds(s, g);
  expect(g.pendingMoment).toBeNull();
});
it("A-05 stopping at a notice preserves and resumes the physical plan without teleporting", () => {
  const { s, g, nav } = setup();
  applyAction(
    s,
    g,
    { kind: "travel", placeId: "ride", routeProfileId: null },
    nav,
    "travel",
  );
  const target = g.target,
    position = { ...s.persons.a0!.position };
  applyAction(
    s,
    g,
    { kind: "notice_stop", placeId: "food", durationMs: 10000 },
    nav,
    "stop",
  );
  expect(g.target).toEqual(target);
  expect(s.persons.a0!.position).toEqual(position);
  s.view.simMs = 10000;
  g.pendingMoment = null;
  startCore(s);
  advanceCore(s, nav, 1);
  expect(s.persons.a0!.state).toBe("walking");
  expect(g.target).toEqual(target);
});
it("A-03 route choice offers explicit alternatives only when multiple profiles exist", () => {
  const { s, g, nav } = setup();
  s.manifest.config.features.routeChoice = true;
  const base = { destinationId: "ride", via: [{ xM: 5.5, yM: 5.5 }] };
  s.park.routeProfiles = [
    { ...base, id: "one", label: "One" },
    { ...base, id: "two", label: "Two", via: [{ xM: 6.5, yM: 7.5 }] },
  ];
  applyAction(
    s,
    g,
    { kind: "travel", placeId: "ride", routeProfileId: null },
    nav,
    "travel",
  );
  expect(g.pendingMoment).toBe("route_choice");
  expect(
    makeRequest(s, g, nav).options.filter((o) => o.action.kind === "route"),
  ).toHaveLength(2);
});

it("A-02 route alternatives cannot duplicate the same authored geometry", async () => {
  const { validatePark } = await import("../../src/navigation/grid.js");
  const p = tinyPark(),
    r = {
      id: "first",
      label: "First",
      destinationId: "ride",
      via: [{ xM: 5.5, yM: 5.5 }],
    };
  p.routeProfiles = [r, { ...r, id: "second", label: "Second" }];
  expect(() => validatePark(p)).toThrow(/route geometry/);
});
it("A-11 app messages only enter the knowledge of guests whose app is active", () => {
  const { s, g, nav } = setup();
  s.view.simMs = 5000;
  g.pendingMoment = null;
  s.population.personas[0]!.hasApp = true;
  s.population.personas[0]!.phoneActiveUntilMs = 1000;
  s.population.personas[1]!.hasApp = false;
  s.population.personas[2]!.hasApp = true;
  s.manifest.scenario.events = [
    {
      id: "message",
      atMs: 5000,
      order: 0,
      change: {
        kind: "app_message",
        messageId: "greeting",
        text: "Hello",
        expiresAtMs: 10000,
        suggestedPlaceId: "food",
        discount: null,
      },
    },
  ];
  startCore(s);
  advanceCore(s, nav, 1);
  expect(s.persons.a0!.facts.some((f) => f.kind === "message")).toBe(false);
  expect(s.persons.a1!.facts.some((f) => f.kind === "message")).toBe(false);
  expect(s.persons.a2!.facts.some((f) => f.kind === "message")).toBe(true);
});
