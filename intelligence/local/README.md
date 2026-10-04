# Local Laya demo

Local Laya runs decision and satisfaction inference on Apple Silicon. The simulation,
movement, queues, spending and action sampling remain in Engine. Narration uses existing
evidence-based templates, not Laya-generated reasoning. No Jev API key is needed for this mode.

## Install once

From the repository root, with Node 24, SpacetimeDB 2.10.2 and `uv` installed:

```sh
uv venv --python 3.12 intelligence/.venv
uv pip install --python intelligence/.venv/bin/python -r intelligence/local/requirements.txt
```

The port and model revision are pinned. First startup downloads approximately 614 MiB of
model weights plus tokenizer files to the Hugging Face cache. Subsequent inference is local.
The service performs a warmup before its health endpoint becomes ready.

## Run

```sh
BEHAVIOR_PROVIDER=laya node integration/run.mjs
```

Or set `BEHAVIOR_PROVIDER=laya` in the gitignored `intelligence/.env.local` and run:

```sh
node --env-file=intelligence/.env.local integration/run.mjs
```

The launcher starts or reuses a healthy loopback service on port 4318. A reused external
service is not stopped with the launcher. The UI at http://127.0.0.1:4317 defaults to Local
Laya and 300 guests, at requested speed 5x. In Advanced settings, Mock remains available;
Live Jev is disabled while this stack uses Laya. Restart with `BEHAVIOR_PROVIDER=jev` to
switch back. Do not run workers for different providers against the shared queue at once.
Existing mock/replay runs remain readable. Local Laya paired experiments are not exposed
in this demo; the Compare A/B page supports mock, or Jev when that worker is configured.

Stage 2 registration (while the stack runs):

```sh
npm --prefix engine run dev:seed -- ../experience/assets/harbor-lights-stage2.bundle.json
```

Optional settings: `LAYA_ENDPOINT` (loopback HTTP, default http://127.0.0.1:4318),
`LAYA_BATCH_SIZE` (1–16, default 8), `LAYA_PYTHON` (launcher executable override).
Changing the endpoint port causes the managed service to bind to that port.

## Evidence and limits

- New contract mode `local` and source `laya` distinguish this model from Jev and mock.
  All three contract mirrors and structural schemas are updated together. Deploy all lanes
  together; old clients do not understand the added enum values.
- Checkpoint: `aac6fef/laya-multilingual-mlx`, revision
  `f2b4faf51023039425946074e2cf1361d2db11d5`, FP16.
- Stable evidence model ID: `laya-multilingual-mlx-f2b4faf5`; prompt version `laya-compact-v1`.
- The compact prompt retains selected observed needs, guest profiles, budget, remaining
  time, must-do destinations, recent facts and events. It deliberately omits some details
  and clips text; inspect the stored exact input in the response artifact. It is not the full
  guest observation. Engine retains the original observation alongside it.
- Different guest states are prepared independently, then batched through one GPU forward
  pass. A lock prevents competing inference calls. No shared multi-guest prompt.
- The service rejects context overflow and option-token collisions. Probability validation,
  caching, leases, retries and raw artifact persistence remain in the existing worker.
- The service returns probabilities, not an action or prose. Engine samples the action.
- Local inference has zero provider charges; energy and hardware costs are not estimated.
- Small synthetic model benchmarks do not predict complete simulation throughput. Model
  behavior is not calibrated to real visitors. Large crowds may run below requested speed.
- The current local setup is for one developer machine, not a public inference service.

## Verify

```sh
intelligence/.venv/bin/python intelligence/local/smoke.py
npm --prefix intelligence run test:providers
npm --prefix experience run test:unit
cd engine
LOAD_MODE=local LOAD_GUESTS=50 LOAD_WALL_S=30 LOAD_SPEED=20 LOAD_PARK_REVISION=harbor-lights-s2-v1 npm exec -- tsx tools/live-load.ts
```

The real-model smoke compares separate calls with the independent-state batched bridge,
checks context rejection, and prints measured throughput. The Engine load tool creates a
real run, exercises inspector and replay queries, reports provenance, and cancels its test
run afterward. It does not imply every generated guest arrived during the measurement.

The batching bridge uses prepare/collate/forward and calibration from the pinned
[Apache-2.0 laya-mlx port](https://github.com/mizorewww/laya-mlx). Original model weights are
from Convai Innovations; this is an independent MLX port, not the Jev cloud model.
