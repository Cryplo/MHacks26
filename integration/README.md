# Integration runner

Node 24 and SpacetimeDB CLI/server **2.10.2** are required. Install the official CLI for your platform and authenticate its local publisher identity before publishing. Keep tokens in environment variables, never URL query strings or tracked files.

From this repository root:

```sh
node integration/run.mjs --partial --check
node integration/run.mjs --partial --external-db --smoke
node integration/run.mjs --partial
node integration/run.mjs --check
node integration/run.mjs --smoke
```

`--partial` explicitly uses only Engine and its synthetic park/mock worker. Strict mode requires all three byte-identical contracts and all three packages. It fails when a lane or integration entry point is missing. `--check` checks prerequisites without installing or starting anything. The runner uses `npm ci`/`build` inside each selected lane, publishes Engine's module, registers the immutable compiled park, then starts the configured services. Repeated registration reuses matching park revisions. Child processes receive TERM and then KILL on failure/signals.

Configuration (passed explicitly as environment variables):

- `SPACETIME_URI`: defaults to `http://127.0.0.1:3000`.
- `SPACETIME_DATABASE`: defaults to `mhacks-engine`.
- `SPACETIME_CLI`: CLI executable, defaults to `spacetime`.
- `SPACETIME_SERVER`: optional standalone server executable.
- `SPACETIME_OPERATOR_TOKEN`: optional publisher token; tools otherwise read the local CLI login without printing it.
- `PARK_BUNDLE_PATH`: strict mode's compiled C artifact; defaults to `experience/assets/park.bundle.json`.

B/C entry points are explicit integration requirements, not implemented lane code: each supplies `build` and `dev:integration`. B supplies `test:integration:engine` to run its mock provider through setup, scenario, final metrics and paired comparison. These must consume Engine's `client/dist/node.js` or `browser.js` and the environment above. C owns its UI/Playwright entry point. Engine's partial smoke does not substitute for that gate.

`SMOKE_HORIZON_MS`, `SMOKE_FRAME_MS`, and `SMOKE_MAX_STEPS` configure Engine's server-backed mock smoke. Default is six simulated minutes, five-second visual frames and one completed step per command. Use `28800000`, `60000`, and `100` for an eight-hour conservation run. The scripted guests exit early; this exercises a complete clock horizon, not eight hours of occupied-park load.
