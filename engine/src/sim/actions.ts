import { cloneJson } from "../domain/primitives.js";
import type * as C from "../../contract/behavior-v1.js";
import type { CoreState, GroupState, QueueEntry } from "../domain/state.js";
import {
  ensure,
  total,
  debit,
  addCents,
  random,
  asciiCompare,
} from "../domain/primitives.js";
import { Navigation } from "../navigation/grid.js";
import {
  event,
  members,
  setActivity,
  releaseQueue,
  trigger,
} from "./common.js";

export function validateQuote(
  s: CoreState,
  g: GroupState,
  q: C.Quote,
  price: number,
  revision: string,
  beneficiaries: string[],
) {
  ensure(
    q.revision === revision && q.validUntilMs >= s.view.simMs,
    "Stale quote",
  );
  ensure(
    q.unitPriceCents === price &&
      q.quantity === beneficiaries.length &&
      q.totalCents === total(price, beneficiaries.length),
    "Incorrect quote total",
  );
  ensure(q.discountMessageId === null, "Unsupported discount");
  ensure(
    q.beneficiaryIds.length === beneficiaries.length &&
      [...q.beneficiaryIds].sort().join(",") ===
        [...beneficiaries].sort().join(","),
    "Incorrect beneficiaries",
  );
}
export function charge(
  s: CoreState,
  g: GroupState,
  placeId: string,
  amount: number,
  beneficiaries: string[],
  causationId: string,
): string {
  const balance = debit(g.balanceCents, amount),
    id = `sale:${s.sales.length + 1}`;
  const previous = s.sales.reduce(
    (n, x) => addCents(n, x.amountCents - x.refundCents),
    0,
  );
  addCents(previous, amount);
  g.balanceCents = balance;
  s.sales.push({
    id,
    groupId: g.manifest.groupId,
    placeId,
    amountCents: amount,
    refundCents: 0,
    beneficiaryIds: [...beneficiaries],
    atMs: s.view.simMs,
  });
  const each = Math.floor(amount / beneficiaries.length),
    remainder = amount % beneficiaries.length;
  event(
    s,
    "purchase",
    g,
    placeId,
    {
      saleId: id,
      allocation: [...beneficiaries].sort().map((agentId, i) => ({
        agentId,
        amountCents: each + (i < remainder ? 1 : 0),
      })),
    },
    { amountCents: amount, causationId },
  );
  const p = s.places[placeId]!.definition.entrance,
    grid = s.park.grid;
  s.heat.push({
    atMs: s.view.simMs,
    fromMs: s.view.simMs,
    toMs: s.view.simMs,
    cell:
      Math.floor(p.yM / grid.cellM) * grid.width +
      Math.floor(p.xM / grid.cellM),
    layer: "spending_cents",
    value: amount,
  });
  return id;
}
export function refund(s: CoreState, saleId: string, amount: number) {
  const sale = s.sales.find((x) => x.id === saleId);
  ensure(sale, "Sale missing");
  const remaining = sale.amountCents - sale.refundCents;
  debit(remaining, amount);
  const g = s.groups[sale.groupId]!;
  const balance = addCents(g.balanceCents, amount);
  sale.refundCents += amount;
  g.balanceCents = balance;
  event(s, "refund", g, sale.placeId, { saleId }, { amountCents: -amount });
  const p = s.places[sale.placeId]!.definition.entrance,
    grid = s.park.grid;
  s.heat.push({
    atMs: s.view.simMs,
    fromMs: s.view.simMs,
    toMs: s.view.simMs,
    cell:
      Math.floor(p.yM / grid.cellM) * grid.width +
      Math.floor(p.xM / grid.cellM),
    layer: "spending_cents",
    value: -amount,
  });
}
function checkAdmission(
  s: CoreState,
  g: GroupState,
  placeId: string,
  riders: string[],
  lane: "standard" | "pass",
  allowMissingPass = false,
) {
  const p = s.places[placeId];
  ensure(p && !p.closed && !s.closing, "Admissions closed");
  const service = p.definition.service;
  ensure(service.kind === "ride" || service.kind === "show", "Not a ride/show");
  ensure(riders.length <= service.seats, "Party exceeds vehicle capacity");
  ensure(
    [...riders].sort().join(",") === [...g.manifest.memberIds].sort().join(","),
    "Must admit whole party",
  );
  ensure(
    members(s, g).every(
      (p) =>
        p.targetPlaceId === placeId &&
        Math.hypot(
          p.position.xM - s.places[placeId]!.definition.entrance.xM,
          p.position.yM - s.places[placeId]!.definition.entrance.yM,
        ) < 1.25,
    ),
    "Party is not at entrance",
  );
  ensure(
    riders.every(
      (id) =>
        s.population.personas.find((p) => p.agentId === id)!.heightCm >=
        (p.definition.minHeightCm ?? 0),
    ),
    "Height restriction",
  );
  ensure(
    !s.sessions.some((x) => x.agentIds.some((id) => riders.includes(id))),
    "Already in service",
  );
  const existing = s.queues.find((q) => q.groupId === g.manifest.groupId);
  ensure(
    !existing ||
      (existing.placeId === placeId &&
        existing.lane === "standard" &&
        lane === "pass"),
    "Already in queue",
  );
  if (lane === "pass")
    ensure(
      service.kind === "ride" &&
        service.passEnabled &&
        (allowMissingPass || riders.every((id) => s.entitlements.includes(id))),
      "Pass entitlement required",
    );
  return existing;
}
function enqueue(
  s: CoreState,
  g: GroupState,
  placeId: string,
  lane: "standard" | "pass",
  cart: C.Quote[] | null,
  existing?: QueueEntry,
) {
  if (existing) releaseQueue(s, existing.id, "upgrade");
  const sequence = ++s.nextQueueSequence,
    people = members(s, g);
  const facts = people
    .flatMap((p) => p.facts)
    .filter((f) => f.placeId === placeId && f.kind === "board")
    .sort(
      (a, b) => b.observedAtMs - a.observedAtMs || asciiCompare(a.id, b.id),
    );
  const q: QueueEntry = {
    id: `queue:${sequence}`,
    groupId: g.manifest.groupId,
    placeId,
    agentIds: [...g.manifest.memberIds],
    lane,
    sequence,
    joinedAtMs: s.view.simMs,
    originalJoinedAtMs: existing?.originalJoinedAtMs ?? s.view.simMs,
    promiseMs: existing?.promiseMs ?? facts[0]?.waitUpperMs ?? null,
    missed: 0,
    cart,
    waitMs: existing?.waitMs ?? 0,
  };
  s.queues.push(q);
  setActivity(s, g, "queueing");
  g.lastQueueCheckMs = s.view.simMs;
  if (!existing) s.totals.joinedEpisodes += people.length;
  event(s, "queue_joined", g, placeId, {
    entryId: q.id,
    lane,
    upgrade: !!existing,
    originalJoinedAtMs: q.originalJoinedAtMs,
    promiseMs: q.promiseMs,
  });
}
export function applyAction(
  s: CoreState,
  g: GroupState,
  action: C.Action,
  nav: Navigation,
  causationId: string,
) {
  const travel = (placeId: string, via: C.Vec2[] = []) => {
    ensure(
      !s.queues.some((q) => q.groupId === g.manifest.groupId),
      "Leave queue before travelling",
    );
    const place = s.places[placeId];
    ensure(place, "Unknown destination");
    const target = via[0] ?? place.definition.entrance;
    ensure(
      members(s, g).every(
        (p) => nav.field(target)[nav.cell(p.position)] !== -1,
      ),
      "Unreachable destination",
    );
    g.target = { ...target };
    g.route = [
      ...via.slice(1),
      ...(via.length ? [place.definition.entrance] : []),
    ];
    g.activityUntilMs = null;
    for (const p of members(s, g)) p.targetPlaceId = placeId;
    setActivity(s, g, "walking");
  };
  switch (action.kind) {
    case "travel": {
      const route = action.routeProfileId
        ? s.park.routeProfiles.find(
            (r) =>
              r.id === action.routeProfileId &&
              r.destinationId === action.placeId,
          )
        : null;
      ensure(!action.routeProfileId || route, "Invalid route");
      travel(action.placeId, route?.via);
      g.leaving = false;
      break;
    }
    case "notice_enter":
      travel(action.placeId);
      g.leaving = false;
      break;
    case "leave_park": {
      const q = s.queues.find((q) => q.groupId === g.manifest.groupId);
      if (q) releaseQueue(s, q.id, "abandonment");
      const exits = s.park.places
        .filter((p) => p.kind === "exit")
        .sort((a, b) => asciiCompare(a.id, b.id));
      travel(exits[0]!.id);
      g.leaving = true;
      break;
    }
    case "join_queue": {
      const existing = checkAdmission(
        s,
        g,
        action.placeId,
        action.riderIds,
        action.lane,
      );
      enqueue(s, g, action.placeId, action.lane, null, existing);
      break;
    }
    case "buy_pass_and_join": {
      const existing = checkAdmission(
          s,
          g,
          action.placeId,
          action.riderIds,
          "pass",
          true,
        ),
        missing = action.riderIds.filter((id) => !s.entitlements.includes(id));
      ensure(
        missing.length > 0 && action.quote.productId === s.park.pass.productId,
        "Invalid pass purchase",
      );
      validateQuote(
        s,
        g,
        action.quote,
        s.passPriceCents,
        String(s.passRevision),
        missing,
      );
      debit(g.balanceCents, action.quote.totalCents);
      charge(
        s,
        g,
        action.placeId,
        action.quote.totalCents,
        missing,
        causationId,
      );
      s.entitlements.push(...missing);
      s.entitlements.sort(asciiCompare);
      enqueue(s, g, action.placeId, "pass", null, existing);
      break;
    }
    case "leave_queue":
      ensure(
        s.queues.some(
          (q) =>
            q.id === action.queueEntryId && q.groupId === g.manifest.groupId,
        ),
        "Queue entry missing",
      );
      releaseQueue(s, action.queueEntryId, "abandonment");
      g.nextDecisionAtMs = s.view.simMs + 5000;
      break;
    case "order": {
      const p = s.places[action.placeId];
      ensure(
        p && !p.closed && !s.closing && p.definition.service.kind === "counter",
        "Counter unavailable",
      );
      ensure(
        !s.queues.some((q) => q.groupId === g.manifest.groupId) &&
          !s.sessions.some((x) => x.groupIds.includes(g.manifest.groupId)),
        "Already queued/in service",
      );
      ensure(
        members(s, g).every(
          (person) =>
            person.targetPlaceId === action.placeId &&
            Math.hypot(
              person.position.xM - p.definition.entrance.xM,
              person.position.yM - p.definition.entrance.yM,
            ) < 1.25,
        ),
        "Not at counter",
      );
      ensure(
        action.cart.length > 0 || p.definition.kind === "restroom",
        "Empty cart",
      );
      const products = p.definition.service.products;
      for (const q of action.cart) {
        const product = products.find((x) => x.id === q.productId);
        ensure(product, "Unknown product");
        validateQuote(
          s,
          g,
          q,
          product.unitPriceCents,
          String(p.revision),
          g.manifest.memberIds,
        );
      }
      ensure(
        new Set(action.cart.map((q) => q.productId)).size ===
          action.cart.length,
        "Duplicate product",
      );
      enqueue(s, g, action.placeId, "standard", cloneJson(action.cart));
      break;
    }
    case "rest": {
      const p = s.places[action.placeId];
      ensure(
        p && !p.closed && p.definition.service.kind === "rest",
        "Rest unavailable",
      );
      ensure(
        members(s, g).every(
          (x) =>
            Math.hypot(
              x.position.xM - p.definition.entrance.xM,
              x.position.yM - p.definition.entrance.yM,
            ) < 1.25,
        ),
        "Not at rest place",
      );
      g.target = null;
      g.activityUntilMs = s.view.simMs + action.durationMs;
      setActivity(s, g, "resting");
      break;
    }
    case "browse": {
      ensure(
        !s.queues.some((q) => q.groupId === g.manifest.groupId),
        "Already queued",
      );
      const p = s.persons[g.manifest.leaderId]!,
        c = nav.cell(p.position),
        neighbors = nav.neighbors(c);
      const i = Math.floor(
        random(
          s.manifest.replicateSeed,
          "movement",
          g.manifest.groupId,
          g.decisionSeq,
        ) * neighbors.length,
      );
      g.target = nav.center(neighbors[i]?.index ?? c);
      g.activityUntilMs = s.view.simMs + action.durationMs;
      g.leaving = false;
      setActivity(s, g, "browsing");
      for (const p of members(s, g)) p.targetPlaceId = null;
      break;
    }
    case "continue":
      g.lastQueueCheckMs = s.view.simMs;
      break;
    case "notice_stop":
      g.activityUntilMs = s.view.simMs + action.durationMs;
      setActivity(s, g, "resting");
      break;
    case "route": {
      const r = s.park.routeProfiles.find((r) => r.id === action.profileId);
      ensure(r && s.manifest.config.features.routeChoice, "Route unavailable");
      travel(r.destinationId, r.via);
      break;
    }
    case "regroup":
      travel(action.rallyPlaceId);
      break;
    case "bump_response":
      throw new Error("Bump actions are capability-gated");
  }
  g.planRevision++;
  if (g.deferredNoticeId) {
    g.noticePlaceId = g.deferredNoticeId;
    g.deferredNoticeId = null;
    trigger(g, "noticed");
    g.nextDecisionAtMs = s.view.simMs + 5000;
  }
}
