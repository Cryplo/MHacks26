# Behavior Engine

Deterministic theme-park simulation, private SpacetimeDB runtime, and the frozen `behavior.v1` browser/Node adapter. This lane owns physical state, requests, queues, transactions, measurements, replay and access control. Intelligence owns Jev/personas/narrative; Experience owns the UI and production park. Synthetic fixture distributions are explicitly **Mock**, never behavioral research results.

## Build and test

Use Node 24. From `engine/`:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run test:coverage
npm run benchmark
```

The lockfile pins the SDK to SpacetimeDB 2.10.2. The module uses the same pure mechanics as unit tests. `module/src/index.ts` stores private normalized entity records and exposes caller-authorized views. No reducer fetches a URL, reads a filesystem, or accepts arbitrary action commits.

## Local server

Install SpacetimeDB CLI/server **2.10.2** for your platform. Run from `engine/`:

```sh
spacetime start --listen-addr 127.0.0.1:3000
```

In another terminal, with the intended local publisher identity logged into the CLI:

```sh
npm ci --prefix module
spacetime publish mhacks-engine --server http://127.0.0.1:3000 --module-path module --yes --no-config
npm run dev:seed
npm run test:server
```

The publisher becomes the initial operator. `SPACETIME_CLI`, `SPACETIME_URI`, `SPACETIME_DATABASE`, and optionally `SPACETIME_OPERATOR_TOKEN` override defaults. Tooling captures the CLI's local token in memory without printing it. Keep API keys/tokens out of tracked files. Never use a production database for these fixture tools.

`npm run provision -- IDENTITY worker` grants the separate worker identity; use `coordinator` for experiments. Only the publisher may provision roles. Run owners issue/revoke scoped shares through the frozen contract. Viewers cannot drive runs, schedule events, or delegate their grant.

The repository integration launcher has strict and partial modes; see `../integration/README.md`. Strict mode intentionally fails until the other lanes supply their contracts/packages and integration scripts.

## Adapter

Build outputs are `client/dist/browser.js` (bundled browser module) and `client/dist/node.js` (Node module using pinned package dependencies). Import `createRuntimeClient`; the interface is exactly `contract/behavior-v1.ts`. Generated SDK details stay inside the adapter.

```ts
const client = await createRuntimeClient({
  uri: 'http://127.0.0.1:3000', database: 'mhacks-engine', token,
  onToken: token => persistSessionToken(token),
});
const receipt = await client.command('startRun', { runId }, crypto.randomUUID());
if (!receipt.ok) showDomainError(receipt.error);
```

A new intent needs a new command ID. Retry a transport failure with the same ID and payload. Domain failures are committed rejected receipts; reads and transport failures throw `RuntimeClientError`. Live subscriptions send a snapshot first, contiguous revision patches afterward, and a full snapshot on gaps/reconnect. Always call the returned unsubscribe function and close unused clients.

## Assets, export and timing

`npm run compile:park -- input.png metadata.json output.json` compiles the exact documented palette in `tools/compile-park.ts`. No scale is inferred from the image. Metadata supplies grid dimensions/cell size, places and explicit queue zones. Unknown pixels fail with coordinates/counts. `npm run dev:seed -- /absolute/path/park.bundle.json` imports immutable compiled content without copying C's source. Large registered parks expose `preparing` while scheduled initialization stores destination fields. Run creation requires `ready`.

Five-second logical steps contain twenty simultaneous 250 ms motion substeps. Work can yield between phases/substeps; the barrier cannot apply a response prefix. The scheduler is fenced against explicit drivers. Simulation speed changes wall pacing only. `live_timeout_v1`, when explicitly enabled in live mode, deterministically continues the valid current plan or walks to the exit, records Fallback evidence, and makes the result comparison-ineligible. Experiments forbid fallback. Invalid worker submissions preserve private evidence, fence that attempt, and retry after one second, up to three attempts.

`npm run export:run -- RUN_ID OUTPUT_DIRECTORY` exports a committed checkpoint, frozen manifest and response tape. Restore uses `createRun.initialCheckpoint`; replay uploads the exported response tape and uses replay mode. Checkpoints contain no reusable driver/work tokens. Visual frame cadence is recorded in each run config. Replay verifies every recorded completed-boundary physical hash without inference.

Read `docs/IMPLEMENTATION_STATUS.md` and `docs/HANDOFF.md` for evidence and remaining release gates. Benchmarks distinguish in-process persistence, real server round trips, application bytes, and unmeasured network/CPU quantities.
