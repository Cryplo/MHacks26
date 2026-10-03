import type {
  CoreState,
  GroupState,
  QueueEntry,
  Session,
} from "../domain/state.js";
import {
  asciiCompare,
  clampMeter,
  DomainFault,
  addCents,
  debit,
} from "../domain/primitives.js";
import { charge, validateQuote } from "./actions.js";
import { event, members, setActivity, trigger, experience } from "./common.js";
export const LOADING_POLICY =
  "loading-v1: FIFO per lane; guard >=3 misses by descending misses then sequence; pass target rounded down, standard remainder; borrow oldest fitting lane head; never skip a lane head";
export function loadVehicle(
  entries: QueueEntry[],
  seats: number,
  passShareBps: number,
): QueueEntry[] {
  const lanes = {
    standard: entries
      .filter((q) => q.lane === "standard")
      .sort((a, b) => a.sequence - b.sequence),
    pass: entries
      .filter((q) => q.lane === "pass")
      .sort((a, b) => a.sequence - b.sequence),
  };
  const selected: QueueEntry[] = [],
    used = { standard: 0, pass: 0 };
  let free = seats;
  const take = (q: QueueEntry) => {
    selected.push(q);
    free -= q.agentIds.length;
    used[q.lane] += q.agentIds.length;
    lanes[q.lane].shift();
  };
  const guarded = [lanes.standard[0], lanes.pass[0]]
    .filter((q): q is QueueEntry => !!q && q.missed >= 3)
    .sort((a, b) => b.missed - a.missed || a.sequence - b.sequence);
  for (const q of guarded) if (q.agentIds.length <= free) take(q);
  const targetPass = Math.floor((seats * passShareBps) / 10000),
    targets = { pass: targetPass, standard: seats - targetPass };
  for (const lane of ["pass", "standard"] as const) {
    let head = lanes[lane][0];
    while (
      head &&
      head.agentIds.length <= free &&
      used[lane] + head.agentIds.length <= targets[lane]
    ) {
      take(head);
      head = lanes[lane][0];
    }
  }
  while (free > 0) {
    const heads = [lanes.standard[0], lanes.pass[0]]
      .filter((q): q is QueueEntry => !!q && q.agentIds.length <= free)
      .sort((a, b) => a.sequence - b.sequence);
    if (!heads.length) break;
    take(heads[0]!);
  }
  for (const q of entries) if (!selected.includes(q)) q.missed++;
  return selected;
}
function start(
  s: CoreState,
  placeId: string,
  entries: QueueEntry[],
  endMs: number,
  vehicle: number | null,
  saleIds: string[] = [],
) {
  const place = s.places[placeId]!,
    service = place.definition.service,
    id = `service:${++s.nextSessionSequence}`;
  const session: Session = {
    id,
    placeId,
    groupIds: entries.map((q) => q.groupId),
    agentIds: entries.flatMap((q) => q.agentIds),
    startMs: s.view.simMs,
    endMs,
    releaseMs: endMs + (service.kind === "ride" ? service.turnaroundMs : 0),
    vehicle,
    waitPersonMs: entries.reduce((n, q) => n + q.waitMs, 0),
    kind: service.kind,
    saleIds,
  };
  s.sessions.push(session);
  const ids = new Set(entries.map((q) => q.id));
  s.queues = s.queues.filter((q) => !ids.has(q.id));
  for (const q of entries) {
    const g = s.groups[q.groupId]!;
    setActivity(
      s,
      g,
      service.kind === "ride"
        ? "riding"
        : service.kind === "show"
          ? "watching"
          : place.definition.kind === "shop"
            ? "shopping"
            : "eating",
    );
    g.pendingMoment = null;
    event(s, "service_started", g, placeId, {
      serviceId: id,
      queueEntryId: q.id,
      waitPersonMs: q.waitMs,
    });
  }
  if (vehicle !== null) place.vehicleReadyMs[vehicle] = session.releaseMs;
}
export function dispatch(s: CoreState, placeId: string) {
  const place = s.places[placeId]!,
    service = place.definition.service;
  if (place.closed || s.closing) return;
  const entries = s.queues
    .filter((q) => q.placeId === placeId)
    .sort((a, b) => a.sequence - b.sequence);
  if (service.kind === "ride" && s.view.simMs >= place.nextDispatchMs) {
    const vehicle = place.vehicleReadyMs.findIndex((t) => t <= s.view.simMs);
    if (vehicle < 0) return;
    place.nextDispatchMs = s.view.simMs + service.dispatchMs;
    const load = loadVehicle(entries, service.seats, service.passShareBps);
    s.totals.dispatchedSeats += service.seats;
    s.totals.usedSeats += load.reduce((n, q) => n + q.agentIds.length, 0);
    // Empty dispatches still consume the same vehicle cycle and offered seat capacity.
    start(s, placeId, load, s.view.simMs + service.durationMs, vehicle);
  } else if (service.kind === "counter") {
    let free =
      service.servers - s.sessions.filter((x) => x.placeId === placeId).length;
    for (const q of entries) {
      if (free <= 0) break;
      const g = s.groups[q.groupId]!,
        cart = q.cart ?? [];
      try {
        let cost = 0;
        for (const quote of cart) {
          const product = service.products.find(
            (x) => x.id === quote.productId,
          );
          if (!product)
            throw new DomainFault("INVALID_INPUT", "Product removed");
          validateQuote(
            s,
            g,
            quote,
            product.unitPriceCents,
            String(place.revision),
            q.agentIds,
          );
          cost = addCents(cost, quote.totalCents);
        }
        debit(g.balanceCents, cost);
        const saleIds = cost
          ? [charge(s, g, placeId, cost, q.agentIds, `order:${q.id}`)]
          : [];
        start(s, placeId, [q], s.view.simMs + service.serviceMs, null, saleIds);
        free--;
      } catch (error) {
        if (!(error instanceof DomainFault)) throw error;
        s.queues = s.queues.filter((x) => x.id !== q.id);
        setActivity(s, g, "deciding");
        trigger(g, "forced_replan");
        g.nextDecisionAtMs = s.view.simMs + 5000;
        event(
          s,
          "action_failed",
          g,
          placeId,
          { orderId: q.id },
          { reason: error.message },
        );
      }
    }
  } else if (
    service.kind === "show" &&
    service.startsAtMs.includes(s.view.simMs) &&
    !s.sessions.some((x) => x.placeId === placeId)
  ) {
    const selected: QueueEntry[] = [];
    let seats = service.seats;
    for (const q of entries) {
      if (q.agentIds.length > seats) break;
      selected.push(q);
      seats -= q.agentIds.length;
    }
    start(s, placeId, selected, s.view.simMs + service.durationMs, null);
  }
}
export function completeSession(s: CoreState, session: Session) {
  // A replayed completion has no effect once the occupied session is removed.
  if (!s.sessions.some((active) => active.id === session.id) || session.endMs > s.view.simMs) return;
  const place = s.places[session.placeId]!,
    service = place.definition.service;
  for (const groupId of session.groupIds) {
    const g = s.groups[groupId]!;
    setActivity(s, g, "deciding");
    if (session.kind === "ride") {
      s.totals.completedRiders += g.manifest.memberIds.length;
      for (const p of members(s, g)) p.needs.fun = clampMeter(p.needs.fun + 15);
      experience(s, g, 5, "completed ride", session.placeId);
    }
    if (session.kind === "counter" && place.definition.kind === "food") {
      for (const p of members(s, g))
        p.needs.hunger = clampMeter(p.needs.hunger - 50);
      experience(s, g, 3, "completed food service", session.placeId);
    }
    if (service.kind === "counter" && service.activityMs > 0) {
      g.activityUntilMs = s.view.simMs + service.activityMs;
      setActivity(
        s,
        g,
        place.definition.kind === "shop" ? "shopping" : "eating",
      );
    } else trigger(g, s.closing ? "closing_soon" : "what_next");
    event(s, "service_completed", g, session.placeId, {
      serviceId: session.id,
      saleIds: session.saleIds,
    });
  }
  if (session.kind === "ride")
    s.totals.completedRideWaitMs += session.waitPersonMs;
  s.sessions = s.sessions.filter((x) => x.id !== session.id);
}
export const sortedPlaces = (s: CoreState) =>
  Object.keys(s.places).sort(asciiCompare);
export function queueCheck(s: CoreState, g: GroupState) {
  const q = s.queues.find((q) => q.groupId === g.manifest.groupId);
  if (!q) return;
  const elapsed = s.view.simMs - q.originalJoinedAtMs;
  if (
    s.view.simMs - g.lastQueueCheckMs >= 600000 ||
    (q.promiseMs !== null &&
      elapsed > q.promiseMs &&
      g.lastQueueCheckMs <= q.originalJoinedAtMs + q.promiseMs)
  )
    trigger(g, "stay_line");
}
