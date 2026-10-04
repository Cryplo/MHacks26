import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { localOperator } from "./local-client.js";
import { tinyPark } from "../fixtures/tiny.js";
import { validatePark } from "../src/navigation/grid.js";
import { hash } from "../src/domain/primitives.js";
const path = process.argv[2];
const park = path ? JSON.parse(await readFile(path, "utf8")) : tinyPark();
validatePark(park);
const client = await localOperator();
try {
  // Idempotent: a registration of the same parkId+revision is reused when its content is
  // canonically identical (it may have been uploaded with different JSON serialization).
  const existing = (await client.query("listParks", { cursor: null })).items.find(
    (p) => p.parkId === park.parkId && p.revision === park.revision,
  );
  if (existing) {
    const stored = JSON.parse(
      new TextDecoder().decode(await client.getArtifact(existing.artifact)),
    );
    if (hash(stored) !== hash(park))
      throw new Error(
        `Park ${park.parkId}@${park.revision} is already registered with different content; bump the revision.`,
      );
    console.log(JSON.stringify({ reused: true, ...existing }, null, 2));
  } else {
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
  }
} finally {
  await client.close();
}
