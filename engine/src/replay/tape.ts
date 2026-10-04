import type {
  DecisionResult,
  RunManifest,
} from "../../contract/behavior-v1.js";
import type { CoreState } from "../domain/state.js";
import { ensure, hash, cloneJson } from "../domain/primitives.js";
import { validateContract } from "../domain/contract-validation.js";
export type ResponseTape = {
  schema: "response-tape-v1";
  engineVersion: string;
  parkHash: string;
  populationHash: string;
  scenarioHash: string;
  replicateSeed: string;
  responses: DecisionResult[];
  boundaries: { atMs: number; hash: string }[];
};
export function makeTape(s: CoreState): ResponseTape {
  return {
    schema: "response-tape-v1",
    engineVersion: s.manifest.config.versions.engine,
    parkHash: hash(s.park),
    populationHash: hash(s.population),
    scenarioHash: hash(s.manifest.scenario),
    replicateSeed: s.manifest.replicateSeed,
    responses: (s.tapeResponses ?? s.evidence.map((e) => e.response)).map((r) =>
      cloneJson(r),
    ),
    boundaries: cloneJson(s.boundaries),
  };
}
export function validateTape(
  tape: ResponseTape,
  s: CoreState,
  manifest: RunManifest = s.manifest,
) {
  ensure(
    tape.schema === "response-tape-v1" &&
      tape.engineVersion === manifest.config.versions.engine,
    "Tape engine mismatch",
  );
  ensure(
    tape.parkHash === hash(s.park) &&
      tape.populationHash === hash(s.population) &&
      tape.scenarioHash === hash(manifest.scenario) &&
      tape.replicateSeed === manifest.replicateSeed,
    "Tape input mismatch",
  );
  ensure(
    Array.isArray(tape.responses) && Array.isArray(tape.boundaries),
    "Malformed tape",
  );
  ensure(
    new Set(tape.responses.map((r) => r.requestId)).size ===
      tape.responses.length,
    "Duplicate tape request",
  );
  for (const r of tape.responses) validateContract("DecisionResult", r);
  ensure(
    new Set(tape.boundaries.map((b) => b.atMs)).size === tape.boundaries.length,
    "Duplicate tape boundary",
  );
  for (const b of tape.boundaries)
    ensure(
      Number.isSafeInteger(b.atMs) &&
        b.atMs >= 0 &&
        b.atMs % 5000 === 0 &&
        /^[0-9a-f]{64}$/.test(b.hash),
      "Invalid tape boundary",
    );
}
