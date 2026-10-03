import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { DbConnection } from "../client/generated/index.js";
import { hash } from "../src/domain/primitives.js";
const cli =
  process.env.SPACETIME_CLI ?? "/tmp/mhacks-spacetime-2.10.2/spacetimedb-cli";
// Capture token in memory only. Never echo CLI output or include token in argv/URLs.
const output = execFileSync(cli, ["login", "show", "--token"], {
  encoding: "utf8",
});
const token = output.match(
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
)?.[0];
assert(token, "Local CLI identity unavailable");
const uri = process.env.SPACETIME_URI ?? "http://127.0.0.1:3099",
  database = process.env.SPACETIME_DATABASE ?? "mhacks-engine-sdk-probe";
async function connect(token?: string): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    let builder = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(database)
      .onConnect((c) => resolve(c))
      .onConnectError((_c, e) => reject(e));
    if (token) builder = builder.withToken(token);
    builder.build();
  });
}
async function subscribe(c: DbConnection) {
  await new Promise<void>((resolve, reject) => {
    c.subscriptionBuilder()
      .onApplied(() => resolve())
      .onError((ctx) => reject(ctx.event))
      .subscribe("SELECT * FROM my_receipts");
  });
}
async function probe(c: DbConnection, commandId: string) {
  return new Promise<{
    ok: boolean;
    result?: { hash: string };
    error?: { code: string };
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Receipt deadline exceeded"));
    }, 5000);
    const insert = () => {
      for (const r of c.db.myReceipts.iter())
        if (r.commandId === commandId) {
          cleanup();
          resolve(JSON.parse(r.body));
        }
    };
    const cleanup = () => {
      clearTimeout(timer);
      c.db.myReceipts.removeOnInsert(insert);
    };
    c.db.myReceipts.onInsert(insert);
    void c.reducers
      .probe({ commandId, payload: '{"b":2,"a":1}' })
      .catch((e) => {
        cleanup();
        reject(e);
      });
    insert();
  });
}
const owner = await connect(token),
  viewer = await connect();
try {
  await subscribe(owner);
  await subscribe(viewer);
  const id = randomUUID(),
    accepted = await probe(owner, id);
  assert(accepted.ok);
  assert.equal(accepted.result?.hash, hash({ b: 2, a: 1 }));
  assert.equal(
    [...viewer.db.myReceipts.iter()].length,
    0,
    "Private receipts leaked",
  );
  const rejected = await probe(viewer, randomUUID());
  assert(!rejected.ok);
  assert.equal(rejected.error?.code, "FORBIDDEN");
  const repeated = await probe(owner, id);
  assert.deepEqual(repeated, accepted);
  assert.equal(
    [...owner.db.myReceipts.iter()].filter((r) => r.commandId === id).length,
    1,
  );
  console.log(
    "PASS real SpacetimeDB 2.10.2: shared SHA-256, caller-private receipts, domain rejection, duplicate retry",
  );
} finally {
  owner.disconnect();
  viewer.disconnect();
}
