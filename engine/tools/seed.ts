import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { localOperator } from "./local-client.js";
import { tinyPark } from "../fixtures/tiny.js";
import { validatePark } from "../src/navigation/grid.js";
const path = process.argv[2];
const park = path ? JSON.parse(await readFile(path, "utf8")) : tinyPark();
validatePark(park);
const client = await localOperator();
try {
  const artifact = await client.putArtifact({
    kind: "park",
    mediaType: "application/json",
    bytes: new TextEncoder().encode(JSON.stringify(park)),
    scope: { runId: null, experimentId: null },
    commandId: randomUUID(),
  });
  const result = await client.command(
    "registerPark",
    { artifact },
    randomUUID(),
  );
  if (!result.ok) throw new Error(result.error.message);
  console.log(JSON.stringify(result.result, null, 2));
} finally {
  await client.close();
}
