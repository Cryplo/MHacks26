import { localOperator } from "./local-client.js";
const [identity, ...roles] = process.argv.slice(2);
if (
  !identity ||
  !roles.length ||
  roles.some((r) => !["operator", "worker", "coordinator"].includes(r))
)
  throw new Error(
    "Usage: npm exec tsx tools/provision.ts -- IDENTITY worker|coordinator|operator",
  );
const client = await localOperator();
try {
  const r = await client.wire("provision", "", { identity, roles });
  if (!r.ok) throw new Error(r.error.message);
  console.log("Provisioned requested identity roles.");
} finally {
  await client.close();
}
