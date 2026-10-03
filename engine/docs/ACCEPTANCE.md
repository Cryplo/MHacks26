# Acceptance evidence

Tests are engine-owned unless explicitly called server-backed. An ID in a test name identifies the behavior it exercises; it does not imply every clause of that acceptance group has been demonstrated.

| IDs | Evidence |
|---|---|
| A-01/A-02 | validation, compiler and staged park initialization suites: malformed manifests, identities, membership/units, palette/dimensions/topology/queue ownership |
| A-03/A-04/A-05 | navigation and motion properties, swept exposure, reversed row order, individual poses, 400-person finite/walkable run, authored route choices and notice-plan resumption |
| A-06/A-07 | blocked barrier immutability; reordered responses/work budgets; restart through every phase/substep cursor in initial steps; complete checkpoint replay |
| A-08/A-09/A-10 | driver/work leases, claim race, durable retry/conflict, invalid-response error records, live timeout fencing; scheduler external-owner and pause behavior |
| A-11/A-12 | hidden closure separation, stale board retention, member notice deduplication, hunger hysteresis and active-service suppression |
| A-13/A-14 | whole-party FIFO/three-miss loading guard, multi-vehicle cycles, exactly-once completion, closure finish behavior and horizon censorship |
| A-15/A-16/A-17 | checked cents goldens, missing-beneficiary pass purchase, stale quote atomicity, upgrade wait preservation, food service-start charge, linked refunds, conservation |
| A-18/A-19 | individual frozen rating evidence and coverage/no feedback; exact queue person-minutes and heat reconciliation |
| A-20/A-21 | scoped reads/writes/artifacts/shares and worker-to-requester attachment; multipart hash/size/partial/duplicate checks; experiment ownership and metric provenance |
| A-22 | adapter unit transport faults: revision gaps/stale duplicates/deletes/listener cleanup; same-ID lost-acknowledgement retry. Server reconnect included in latest smoke tool |
| A-23 | full logical checkpoint clone/remap and replay boundary hashes with no inference |
| A-24 | actual local SpacetimeDB 2.10.2 + generated adapter, private receipts, rejected commands, real subscriptions and multipart artifacts |
| A-25 | pure 12-person visit; actual server eight-hour horizon with 3 scripted visitors; 200/300/400 in-process load and separate real-server multi-viewer harness |

Important test limits:

- The 400-person invariant test covers ten simulated minutes. Long occupied-day crowd stability is not established by the early-departure eight-hour smoke.
- The real-server load harness covers ten simulated seconds with coincident entrance arrivals. It reports application round-trip latency, not isolated reducer CPU duration, and received application bytes, not transport egress.
- In-process benchmark positions are deliberately spread across the grid. Do not compare those timings directly with coincident server arrivals.
- No Jev API calls or costs have been measured. No B/C strict end-to-end A/A comparison or production park/UI test has run because those lanes are absent.
- Model behavior and satisfaction remain synthetic, uncalibrated outputs.
