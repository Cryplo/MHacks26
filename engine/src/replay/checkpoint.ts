import type { CoreState } from "../domain/state.js";
import { ensure, hash, canonical } from "../domain/primitives.js";
import { physicalHash } from "./physical.js";
export type Checkpoint = {
  schema: "checkpoint-v1";
  engineVersion: string;
  parkHash: string;
  populationHash: string;
  physicalStateHash: string;
  state: CoreState;
  integrityHash: string;
};
export function checkpoint(s: CoreState): Checkpoint {
  ensure(
    s.view.phase === "prepare" && s.barrierIds.length === 0,
    "Checkpoint requires committed boundary",
  );
  const state = JSON.parse(canonical(s)) as CoreState;
  state.frames = [];
  const body = {
    schema: "checkpoint-v1" as const,
    engineVersion: s.manifest.config.versions.engine,
    parkHash: hash(s.park),
    populationHash: hash(s.population),
    physicalStateHash: physicalHash(s),
    state,
  };
  return { ...body, integrityHash: hash(body) };
}
export function restore(value: Checkpoint, runId: string): CoreState {
  const { integrityHash, ...body } = value;
  ensure(hash(body) === integrityHash, "Checkpoint integrity failure");
  ensure(
    value.schema === "checkpoint-v1" && value.engineVersion === "engine-v1",
    "Unsupported checkpoint",
  );
  ensure(
    hash(value.state.park) === value.parkHash &&
      hash(value.state.population) === value.populationHash,
    "Checkpoint input mismatch",
  );
  ensure(
    value.state.view.phase === "prepare" && value.state.barrierIds.length === 0,
    "Checkpoint phase unsupported",
  );
  ensure(
    physicalHash(value.state) === value.physicalStateHash,
    "Checkpoint physical mismatch",
  );
  const s = JSON.parse(canonical(value.state)) as CoreState;
  s.runId = runId;
  s.view.runId = runId;
  s.view.controlRevision = 0;
  s.view.status = "ready";
  s.pauseRequested = false;
  for (const d of Object.values(s.decisions)) d.request.runId = runId;
  for (const e of s.events) e.runId = runId;
  for (const e of s.evidence) e.request.runId = runId;
  for (const r of Object.values(s.ratings)) r.request.runId = runId;
  for (const m of s.metrics) m.runId = runId;
  s.frames = [];
  ensure(
    physicalHash(s) === value.physicalStateHash,
    "Scope remap altered physics",
  );
  return s;
}
