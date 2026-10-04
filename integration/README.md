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

## All-lanes integration (strict mode)

Strict mode now runs end to end: it compiles nothing itself, but expects the Harbor Lights
bundle compiled by Engine's compiler (`npm run content:compile` in `experience/`, written to
`experience/assets/park.bundle.json`), seeds it, then runs `integration/bootstrap-identities.mjs`,
which creates separate worker and coordinator identities, provisions their roles with the
publisher/operator identity, and writes `engine/.local/integration.env` (mode 0600, gitignored,
never printed). Intelligence's `dev:integration` (worker + coordinator) and
`test:integration:engine` (B-18/B-21 on the real Engine) and Experience's `dev:integration`
(live UI with Engine's browser adapter) read that file. Experience's `test:e2e:live` runs the
integrated browser suite when `BEHAVIOR_OPERATOR_TOKEN` is exported from it.

## Local Laya demo

See [installation, startup and evidence notes](../intelligence/local/README.md). After the
one-time Python setup, `BEHAVIOR_PROVIDER=laya node integration/run.mjs` starts the local
MLX service as well as Engine, Intelligence and Experience. The UI then offers Local Laya
as its default, with no Jev API calls.
