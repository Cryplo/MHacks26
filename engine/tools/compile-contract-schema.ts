import { createGenerator } from "ts-json-schema-generator";
import { writeFileSync } from "node:fs";
const generator = createGenerator({
  path: "contract/behavior-v1.ts",
  tsconfig: "tsconfig.json",
  type: "Commands",
  skipTypeCheck: true,
  expose: "all",
});
const roots = [
  "Commands",
  "Queries",
  "CompletedWork",
  "DecisionRequest",
  "DecisionResult",
  "RatingResult",
  "MetricSnapshot",
  "RunManifest",
  "ExperimentReport",
  "PopulationManifest",
  "ParkBundle",
  "ScenarioDraft",
  "Narrative",
];
const definitions: Record<string, unknown> = {};
for (const type of roots)
  Object.assign(definitions, generator.createSchema(type).definitions);
writeFileSync(
  "src/domain/contract-schema.json",
  JSON.stringify({ definitions }, null, 2) + "\n",
);
