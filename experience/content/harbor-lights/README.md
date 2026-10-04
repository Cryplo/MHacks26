# Harbor Lights — authored park content

Synthetic theme park for the Behavior Engine. **All capacities, prices and schedules are
internally consistent synthetic inputs, not measured facts about any real park.** Authored
expectations are labeled *authored hypothesis*; nothing here is a measured outcome.

## Units and coordinates

- 1 cell = 1 metre (`cellM = 1`); grid 200 x 150 cells.
- Origin top-left, x right, y down. Cell centre = `(col + 0.5, row + 0.5) * cellM`.
- Grid bytes are row-major `row * width + col`.
- Time: integer ms since park opening (09:00 local; closes after 10 h). All service/dispatch/show times are multiples of 5,000 ms.
- Money: integer USD cents. Harbor Pass baseline 1500 cents per guest, valid for the remaining day.

## Files

| Path | Role |
|---|---|
| `layout.json` | **Geometry source of truth**: path graph (nodes/edges with widths), plazas, blocked areas, footprints, queue rectangles (entry corner + lane axis), stage tags. |
| `places.json` | Names, kinds, services/capacities, height minimums, thrill, wait boards, notices (+ content versions), descriptions, restrictions. |
| `park.json` | Park ID, stage revisions, hours, pass product, route profiles. |
| `scenarios/*.json` | Typed scenario presets (`meta` + contract `Scenario`). |
| `generated/stage{1,2}/grid.png` | Categorical PNG painted programmatically (`npm run content:paint`). Never hand-edit, never antialias. |
| `generated/stage{1,2}/queue-zones.json` | Explicit queue cell sets (row-major indices, head to tail), entry and exit points. |
| `generated/stage{1,2}/metadata.json` | Engine compiler metadata (ParkBundle without cell bytes). |
| `tools/` | Painter (`paint.ts`), validator (`validate.ts`), fixture bundle assembly (`assemble.ts`). |

Fixture-assembled `ParkBundle`s are written to `experience/fixtures/parks/` for the fixture
runtime only. Engine's compiler produces the authoritative bundle and validates navigation.

## Categorical palette (exact RGB, alpha 255)

| Code | Meaning | RGB |
|---|---|---|
| 0 | blocked (fence, water, buildings, ride footprints) | 0, 0, 0 |
| 1 | path | 255, 255, 255 |
| 2 | plaza | 128, 128, 128 |
| 3 | grass (not walkable in the initial park) | 0, 255, 0 |
| 4 | queue (entry controlled; ownership via queue-zones.json) | 255, 255, 0 |

This is exactly Engine's compiler palette (`engine/tools/compile-park.ts`), so the source PNG
compiles without conversion. The display map in the app uses its own softer colours.

Queue ownership is explicit: every queue-coloured cell belongs to exactly one zone, checked
by the validator. A shared colour alone never implies ownership.

## Stages

- **Stage 1 (starter, `harbor-lights-s1-v1`)**: 5 attractions — Tempest Coaster (thrill, 122 cm),
  Splash Falls (family water ride, 100 cm), Harbor Carousel (gentle, no minimum), Tide Pool
  Teacups (no minimum) and Lantern Theatre (show) — plus a churro cart (aroma notice), Harbor
  Snacks, Lighthouse Gifts (visible sign), gate restrooms, Quay Garden (scenic rest) and the
  gate/exit. Families with small children have three rides plus the show.
- **Stage 2 (target, `harbor-lights-s2-v1`)**: 15 attractions (rides and shows only; restrooms,
  gates, gardens and food are not counted) plus extra food, a shop, restrooms and a lookout.
  Stage-1 place IDs and positions are unchanged.

## Places

| ID | Name | Kind | Stage | Queue zone | Service (synthetic) | Min height cm | Thrill |
|---|---|---|---|---|---|---|---|
| `main_gate` | Main Gate | entrance | 1 | — | none | — | 0 |
| `main_exit` | Exit Turnstiles | exit | 1 | — | none | — | 0 |
| `coaster_tempest` | Tempest Coaster | ride | 1 | `q_coaster_tempest` | ride: 8 seats x 2 vehicle(s), dispatch 120s, ride 180s + turnaround 60s (~240/h); pass on, target 30% | 122 | 0.95 |
| `splash_falls` | Splash Falls | ride | 1 | `q_splash_falls` | ride: 4 seats x 3 vehicle(s), dispatch 80s, ride 180s + turnaround 60s (~180/h); pass on, target 25% | 100 | 0.45 |
| `harbor_carousel` | Harbor Carousel | ride | 1 | `q_harbor_carousel` | ride: 16 seats x 1 vehicle(s), dispatch 300s, ride 240s + turnaround 60s (~192/h); pass off | — | 0.1 |
| `tidepool_teacups` | Tide Pool Teacups | ride | 1 | `q_tidepool_teacups` | ride: 12 seats x 1 vehicle(s), dispatch 180s, ride 120s + turnaround 60s (~240/h); pass off | — | 0.3 |
| `lantern_theatre` | Lantern Theatre | show | 1 | `q_lantern_theatre` | show: 120 seats, 20 min, 12 performances | — | 0.05 |
| `churro_cart` | Churro Cart | food | 1 | `q_churro_cart` | counter: 1 server(s), service 60s, activity 5 min; Cinnamon churro $4.50, Lemonade $3.75 | — | 0 |
| `harbor_snacks` | Harbor Snacks | food | 1 | `q_harbor_snacks` | counter: 3 server(s), service 120s, activity 15 min; Fish and chips $12.95, Chicken tenders $11.50, Fountain soda $3.99 | — | 0 |
| `lighthouse_gifts` | Lighthouse Gifts | shop | 1 | `q_lighthouse_gifts` | counter: 2 server(s), service 90s, activity 5 min; Glow harbor lantern $18.00, Puffin plush $22.00, Postcard set $3.00 | — | 0 |
| `restrooms_gate` | Restrooms (Gate) | restroom | 1 | — | rest 3 min | — | 0 |
| `quay_garden` | Quay Garden | scenery | 1 | — | rest 10 min | — | 0 |
| `river_rapids` | River Rapids | ride | 2 | `q_river_rapids` | ride: 8 seats x 6 vehicle(s), dispatch 60s, ride 300s + turnaround 60s (~480/h); pass on, target 25% | 107 | 0.55 |
| `ghost_lighthouse` | Ghost Lighthouse | ride | 2 | `q_ghost_lighthouse` | ride: 4 seats x 12 vehicle(s), dispatch 30s, ride 300s + turnaround 60s (~480/h); pass on, target 20% | — | 0.4 |
| `harbor_eye` | Harbor Eye | ride | 2 | `q_harbor_eye` | ride: 6 seats x 16 vehicle(s), dispatch 30s, ride 420s + turnaround 60s (~720/h); pass off | — | 0.2 |
| `mariner_drop` | Mariner Drop | ride | 2 | `q_mariner_drop` | ride: 12 seats x 1 vehicle(s), dispatch 150s, ride 90s + turnaround 60s (~288/h); pass on, target 30% | 122 | 0.9 |
| `wild_mouse` | Wild Mouse | ride | 2 | `q_wild_mouse` | ride: 4 seats x 4 vehicle(s), dispatch 60s, ride 180s + turnaround 60s (~240/h); pass on, target 30% | 107 | 0.75 |
| `bumper_boats` | Bumper Boats | ride | 2 | `q_bumper_boats` | ride: 10 seats x 1 vehicle(s), dispatch 300s, ride 240s + turnaround 60s (~120/h); pass off | 100 | 0.35 |
| `pirate_swing` | Pirate Swing | ride | 2 | `q_pirate_swing` | ride: 40 seats x 1 vehicle(s), dispatch 240s, ride 180s + turnaround 60s (~600/h); pass off | 112 | 0.6 |
| `seafarer_scrambler` | Seafarer Scrambler | ride | 2 | `q_seafarer_scrambler` | ride: 30 seats x 1 vehicle(s), dispatch 180s, ride 120s + turnaround 60s (~600/h); pass off | 107 | 0.5 |
| `lighthouse_railway` | Lighthouse Railway | ride | 2 | `q_lighthouse_railway` | ride: 20 seats x 1 vehicle(s), dispatch 300s, ride 240s + turnaround 60s (~240/h); pass off | — | 0.05 |
| `pier_stage` | Pier Stage | show | 2 | `q_pier_stage` | show: 200 seats, 25 min, 9 performances | — | 0.05 |
| `fish_shack` | Fish Shack | food | 2 | `q_fish_shack` | counter: 2 server(s), service 120s, activity 15 min; Clam chowder $8.95, Fish tacos $10.95, Iced tea $3.50 | — | 0 |
| `ice_cream_float` | Ice Cream Float | food | 2 | `q_ice_cream_float` | counter: 1 server(s), service 60s, activity 10 min; Ice cream cone $5.50, Harbor sundae $7.95 | — | 0 |
| `harbor_outfitters` | Harbor Outfitters | shop | 2 | `q_harbor_outfitters` | counter: 2 server(s), service 90s, activity 5 min; Harbor Lights hoodie $48.00, Captain cap $24.00 | — | 0 |
| `restrooms_east` | Restrooms (East) | restroom | 2 | — | rest 3 min | — | 0 |
| `lookout_point` | Lookout Point | scenery | 2 | — | rest 10 min | — | 0 |

The Tempest Coaster uses the v3 eight-seat / 120-second dispatch starting configuration with
two trains so that a 180 s ride + 60 s turnaround cycle is consistent (2 x 120 s = 240 s).

## Notices (exact text is versioned)

| Place | Channel | Radius | Version | Text |
|---|---|---|---|---|
| `lantern_theatre` | visual | 25 m | v1 | LANTERN THEATRE - "Songs of the Harbor", a 20-minute musical show. Performances every 45 minutes from 9:30 AM; doors open 10 minutes before. |
| `churro_cart` | aroma | 12 m | v1 | The smell of warm cinnamon sugar drifts from a small churro cart at the corner of the central plaza. |
| `lighthouse_gifts` | visual | 18 m | v1 | LIGHTHOUSE GIFTS - glow-in-the-dark harbor lanterns, puffin plush toys and postcards. Open until close. |
| `quay_garden` | visual | 20 m | v1 | QUAY GARDEN - shaded benches facing the harbor. Quiet seating; no rides. |
| `pier_stage` | visual | 25 m | v1 | PIER STAGE - "Lighthouse Keepers" acrobatics show on the hour, 25 minutes, open-air seating. |
| `lookout_point` | visual | 20 m | v1 | LOOKOUT POINT - telescope and benches over the harbor mouth. |

The `notice-only` preset publishes churro notice **v2** at 11:00; guests who observed v1 keep
their v1 observation.

## Scenario presets

| Preset | Changes | Notes |
|---|---|---|
| `baseline` | none | Primary A/B arm A (pass $15.00). |
| `price-only` | `pass_price` 1500 -> 2500 cents at 0 ms | Primary A/B arm B; changes ONLY the pass price. |
| `board-only` | coaster board shows a 10-minute range | Separate information experiment. |
| `notice-only` | churro notice v2 at 11:00 | Separate notice experiment. |
| `app-message` | informational app message at 12:00, no discount | Text-only; not a price change. |
| `closure` | coaster closed 14:00-15:00 | Fault/demo; queued parties released (not abandonment). |

Boards in the baseline are runtime estimates (`rounded_estimate`); presets never set
dishonest board times to manufacture an A/B result. Geometry relocation is not offered.

## Route profiles

`rp_coaster_avenue` and `rp_coaster_westloop` are genuinely different walkable routes to the
coaster. They are authored content only; the route-choice feature is shown only when the
server capability `features.routeChoice` is true.

## Commands

```bash
npm run content:paint      # repaint PNGs, queue masks and fixture bundles (deterministic)
npm run content:validate   # metadata, references, palette coverage, ownership, services, presets
npm run content:compile    # Engine's compiler -> experience/assets/*.bundle.json (NOT RUN without engine/)
```

`dev:seed`/integration tooling (Engine lane) imports the validated bundle through authorized
`registerPark`; the product waits for `preparing -> ready` and shows `invalid` issues.

## Licenses

All assets in this directory are original work generated by the tools in `tools/` for this
repository; no third-party images, fonts or textures are used. Display decoration in the app
is drawn procedurally from `layout.json` footprints.
