import type * as C from "../../contract/behavior-v1.js";
import type { CoreState, GroupState, PersonState } from "../domain/state.js";
import { asciiCompare, hash, total } from "../domain/primitives.js";
import { Navigation, UNREACHABLE } from "../navigation/grid.js";
import {
  event,
  members,
  trigger,
  persona,
  recentGroupEvents,
} from "./common.js";
/** Facts each guest remembers (most recent). Observations use the group's latest 64. */
export const FACT_MEMORY = 32;
export function observe(
  s: CoreState,
  p: PersonState,
  fact: Omit<C.ObservationFact, "id">,
): boolean {
  if (
    p.facts.some(
      (f) =>
        f.placeId === fact.placeId &&
        f.kind === fact.kind &&
        f.contentVersion === fact.contentVersion,
    )
  )
    return false;
  const seq = (p.factSeq ?? p.facts.length) + 1,
    f = { ...fact, id: `obs:${p.agentId}:${seq}` };
  p.factSeq = seq;
  // The digest chains every fact ever observed, so the physical hash still covers memory
  // that has rolled out of the bounded recent-fact window.
  if (p.factDigest !== undefined) p.factDigest = hash([p.factDigest, f]);
  p.facts.push(f);
  if (p.facts.length > FACT_MEMORY)
    p.facts.splice(0, p.facts.length - FACT_MEMORY);
  event(
    s,
    "observed",
    s.groups[p.groupId]!,
    f.placeId,
    { fact: f },
    { agentIds: [p.agentId], position: { ...p.position } },
  );
  return true;
}
export function predictedWait(s: CoreState, placeId: string): number | null {
  const place = s.places[placeId]!,
    service = place.definition.service,
    n = s.queues
      .filter((q) => q.placeId === placeId)
      .reduce((n, q) => n + q.agentIds.length, 0);
  if (service.kind === "ride")
    return Math.ceil(n / service.seats) * service.dispatchMs;
  if (service.kind === "counter")
    return (
      Math.ceil(
        s.queues.filter((q) => q.placeId === placeId).length / service.servers,
      ) * service.serviceMs
    );
  return null;
}
export function board(
  s: CoreState,
  placeId: string,
): { text: string; lower: number | null; upper: number | null } | null {
  const b = s.places[placeId]!.definition.board;
  if (!b) return null;
  if (b.kind === "fixed")
    return {
      text: b.text,
      lower: b.lowerMin === null ? null : b.lowerMin * 60000,
      upper: b.upperMin === null ? null : b.upperMin * 60000,
    };
  const min =
    Math.ceil((predictedWait(s, placeId) ?? 0) / (60000 * b.roundToMin)) *
    b.roundToMin;
  const lower =
      b.kind === "range_estimate" ? Math.max(0, min - b.spreadMin) : min,
    upper = b.kind === "range_estimate" ? min + b.spreadMin : min;
  return {
    text: b.template
      .replaceAll("{minutes}", String(min))
      .replaceAll("{lower}", String(lower))
      .replaceAll("{upper}", String(upper)),
    lower: lower * 60000,
    upper: upper * 60000,
  };
}
export function observeEntrance(s: CoreState, g: GroupState, placeId: string) {
  const place = s.places[placeId]!,
    b = board(s, placeId);
  for (const p of members(s, g)) {
    if (b)
      observe(s, p, {
        kind: "board",
        placeId,
        source: "sight",
        observedAtMs: s.view.simMs,
        contentVersion: `${place.boardVersion}:${hash(b).slice(0, 12)}`,
        text: b.text,
        waitLowerMs: b.lower,
        waitUpperMs: b.upper,
        priceCents: null,
      });
    observe(s, p, {
      kind: "closure",
      placeId,
      source: "sight",
      observedAtMs: s.view.simMs,
      contentVersion: `closure:${place.revision}`,
      text: place.closed ? "Closed" : "Open",
      waitLowerMs: null,
      waitUpperMs: null,
      priceCents: null,
    });
  }
}
export function observation(
  s: CoreState,
  g: GroupState,
  nav: Navigation,
): C.GuestObservation {
  const people = members(s, g),
    leader = s.persons[g.manifest.leaderId]!,
    // Guests standing in a queue zone (or inside a ride) measure walks from the entrance.
    position =
      !nav.walkable(nav.cell(leader.position)) && leader.targetPlaceId
        ? s.places[leader.targetPlaceId]!.definition.entrance
        : leader.position,
    cell = nav.cell(position);
  const facts = people
    .flatMap((p) => p.facts)
    .sort((a, b) => a.observedAtMs - b.observedAtMs || asciiCompare(a.id, b.id))
    .slice(-64);
  const speed = Math.min(
    ...people.map((p) => persona(s, p.agentId).walkSpeedMps),
  );
  const known = s.park.places
    .filter((p) => p.kind !== "entrance")
    .map((p) => {
      const d = nav.field(p.entrance)[cell] ?? UNREACHABLE;
      return {
        placeId: p.id,
        name: p.name,
        walkEstimateMs:
          d === UNREACHABLE
            ? null
            : Math.ceil(((d * s.park.grid.cellM) / speed) * 1000),
        lastObservedFactIds: facts
          .filter((f) => f.placeId === p.id)
          .map((f) => f.id),
        knownRestrictions:
          p.minHeightCm === null ? [] : [`Minimum height ${p.minHeightCm} cm`],
      };
    });
  return {
    schema: "observation.v1",
    groupId: g.manifest.groupId,
    leaderId: g.manifest.leaderId,
    atMs: s.view.simMs,
    members: people.map((p) => ({
      persona: persona(s, p.agentId),
      needs: { ...p.needs },
    })),
    wallet: { walletId: g.manifest.walletId, balanceCents: g.balanceCents },
    facts,
    knownDestinations: known,
    recentEventSummaries: recentGroupEvents(s, g.manifest.groupId, 8).map(
      (e) => ({
        eventId: e.eventId,
        atMs: e.atMs,
        text: e.reason ?? e.kind,
      }),
    ),
    currentActivity: people[0]!.state,
    plannedDepartureMs: g.manifest.plannedDepartureMs,
  };
}
function option(id: string, label: string, action: C.Action): C.ActionOption {
  return { id, label, description: label, action };
}
export function quote(
  s: CoreState,
  g: GroupState,
  productId: string,
  unitPriceCents: number,
  beneficiaries: string[],
  revision: string,
): C.Quote {
  return {
    quoteId: `quote:${g.manifest.groupId}:${g.decisionSeq}:${productId}`,
    revision,
    productId,
    unitPriceCents,
    quantity: beneficiaries.length,
    totalCents: total(unitPriceCents, beneficiaries.length),
    beneficiaryIds: [...beneficiaries],
    validUntilMs: s.view.simMs + 300000,
    discountMessageId: null,
  };
}
export function makeRequest(
  s: CoreState,
  g: GroupState,
  nav: Navigation,
): C.DecisionRequest {
  const moment = g.pendingMoment ?? "what_next";
  g.pendingMoment = null;
  g.decisionSeq++;
  g.momentSeq[moment] = (g.momentSeq[moment] ?? 0) + 1;
  const obs = observation(s, g, nav),
    options: C.ActionOption[] = [],
    considered: string[] = [],
    excluded: { id: string; reason: string }[] = [];
  const people = members(s, g),
    current = people[0]!,
    queue = s.queues.find((q) => q.groupId === g.manifest.groupId),
    place = current.targetPlaceId ? s.places[current.targetPlaceId] : null;
  const pass = (placeId: string) => {
    const missing = g.manifest.memberIds.filter(
      (id) => !s.entitlements.includes(id),
    );
    if (
      missing.length &&
      total(s.passPriceCents, missing.length) <= g.balanceCents
    )
      options.push(
        option("buy_pass", "Buy missing day passes and join pass queue", {
          kind: "buy_pass_and_join",
          placeId,
          riderIds: [...g.manifest.memberIds],
          quote: quote(
            s,
            g,
            s.park.pass.productId,
            s.passPriceCents,
            missing,
            String(s.passRevision),
          ),
        }),
      );
  };
  if (
    moment === "route_choice" &&
    place &&
    s.manifest.config.features.routeChoice
  ) {
    const routes = s.park.routeProfiles
      .filter((r) => r.destinationId === place.definition.id)
      .sort((a, b) => asciiCompare(a.id, b.id));
    if (routes.length > 1)
      for (const r of routes)
        options.push(
          option(`route:${r.id}`, r.label, { kind: "route", profileId: r.id }),
        );
    options.push(
      option("continue", "Continue current route", { kind: "continue" }),
    );
  } else if (queue) {
    options.push(
      option("continue", "Stay in queue", { kind: "continue" }),
      option("leave_queue", "Leave this queue", {
        kind: "leave_queue",
        queueEntryId: queue.id,
      }),
    );
    const service = s.places[queue.placeId]!.definition.service;
    if (
      queue.lane === "standard" &&
      service.kind === "ride" &&
      service.passEnabled
    ) {
      if (g.manifest.memberIds.every((id) => s.entitlements.includes(id)))
        options.push(
          option("upgrade", "Use owned passes", {
            kind: "join_queue",
            placeId: queue.placeId,
            lane: "pass",
            riderIds: [...g.manifest.memberIds],
          }),
        );
      else pass(queue.placeId);
    }
  } else if (moment === "noticed" && g.noticePlaceId) {
    options.push(
      option("continue", "Continue current plan", { kind: "continue" }),
      option("stop", "Stop to look", {
        kind: "notice_stop",
        placeId: g.noticePlaceId,
        durationMs: 10000,
      }),
      option("enter", "Walk to this entrance", {
        kind: "notice_enter",
        placeId: g.noticePlaceId,
      }),
    );
  } else {
    if (moment === "join_line" && place && !place.closed && !s.closing) {
      const service = place.definition.service,
        riders = [...g.manifest.memberIds];
      const eligible = people.every(
        (p) =>
          persona(s, p.agentId).heightCm >= (place.definition.minHeightCm ?? 0),
      );
      if (
        (service.kind === "ride" || service.kind === "show") &&
        eligible &&
        riders.length <= service.seats
      ) {
        options.push(
          option("join_standard", "Join standard queue", {
            kind: "join_queue",
            placeId: place.definition.id,
            lane: "standard",
            riderIds: riders,
          }),
        );
        if (service.kind === "ride" && service.passEnabled) {
          if (riders.every((id) => s.entitlements.includes(id)))
            options.push(
              option("join_pass", "Join pass queue", {
                kind: "join_queue",
                placeId: place.definition.id,
                lane: "pass",
                riderIds: riders,
              }),
            );
          else pass(place.definition.id);
        }
      }
      if (service.kind === "counter") {
        if (service.products.length) {
          for (const product of service.products) {
            const q = quote(
              s,
              g,
              product.id,
              product.unitPriceCents,
              riders,
              String(place.revision),
            );
            if (q.totalCents <= g.balanceCents)
              options.push(
                option(`order:${product.id}`, `Order ${product.label}`, {
                  kind: "order",
                  placeId: place.definition.id,
                  cart: [q],
                }),
              );
          }
        } else
          options.push(
            option("service", "Join service queue", {
              kind: "order",
              placeId: place.definition.id,
              cart: [],
            }),
          );
      }
      if (service.kind === "rest")
        options.push(
          option("rest", "Rest here", {
            kind: "rest",
            placeId: place.definition.id,
            durationMs: service.durationMs,
          }),
        );
    }
    const candidates = [...obs.knownDestinations]
      .filter((p) => s.places[p.placeId]!.definition.kind !== "exit")
      .sort(
        (a, b) =>
          (a.walkEstimateMs ?? Infinity) - (b.walkEstimateMs ?? Infinity) ||
          asciiCompare(a.placeId, b.placeId),
      );
    for (const c of candidates) {
      considered.push(c.placeId);
      const knownClosed = [...obs.facts]
        .reverse()
        .find((f) => f.placeId === c.placeId && f.kind === "closure");
      if (
        c.walkEstimateMs === null ||
        s.closing ||
        knownClosed?.text === "Closed"
      ) {
        excluded.push({
          id: c.placeId,
          reason: s.closing
            ? "park closing"
            : knownClosed?.text === "Closed"
              ? "observed closure"
              : "unreachable",
        });
        continue;
      }
      if (options.filter((o) => o.action.kind === "travel").length >= 8) {
        excluded.push({
          id: c.placeId,
          reason: "logged distance candidate cap: 8",
        });
        continue;
      }
      if (moment === "join_line" && c.placeId === place?.definition.id)
        continue;
      options.push(
        option(`travel:${c.placeId}`, `Walk to ${c.name}`, {
          kind: "travel",
          placeId: c.placeId,
          routeProfileId: null,
        }),
      );
    }
    if (!s.closing)
      options.push(
        option("browse", "Browse nearby", {
          kind: "browse",
          durationMs: 30000,
        }),
      );
    options.push(option("leave", "Walk to exit", { kind: "leave_park" }));
  }
  const requestId = `decision:${g.manifest.groupId}:${g.decisionSeq}:r0`,
    promptOptionOrder = options.map((o) => o.id).sort(asciiCompare);
  const request: C.DecisionRequest = {
    contractVersion: "behavior.v1",
    requestId,
    runId: s.runId,
    groupId: g.manifest.groupId,
    agentIds: [...g.manifest.memberIds],
    moment,
    decisionSeq: g.decisionSeq,
    momentSeq: g.momentSeq[moment]!,
    requestRevision: 0,
    createdAtMs: s.view.simMs,
    applyAtMs: s.view.simMs,
    planRevision: g.planRevision,
    dependencyRevisions: {
      [`plan:${g.manifest.groupId}`]: String(g.planRevision),
    },
    observationHash: hash(obs),
    optionsHash: hash({ options, promptOptionOrder }),
    policyVersion: s.manifest.config.versions.options,
    observation: obs,
    options,
    promptOptionOrder,
    candidateAudit: { considered, excluded },
  };
  g.requestId = requestId;
  return request;
}
export function checkNeeds(s: CoreState, g: GroupState) {
  const people = members(s, g);
  if (
    people.some((p) =>
      [
        "riding",
        "watching",
        "eating",
        "shopping",
        "not_arrived",
        "left",
      ].includes(p.state),
    )
  )
    return;
  if (people.every((p) => p.needs.hunger < 55 && p.needs.fatigue < 55))
    g.needArmed = true;
  if (
    g.needArmed &&
    s.view.simMs - g.lastNeedMs >= 600000 &&
    people.some((p) => p.needs.hunger >= 75 || p.needs.fatigue >= 80)
  ) {
    trigger(g, "hungry_tired");
    g.needArmed = false;
    g.lastNeedMs = s.view.simMs;
  }
}
