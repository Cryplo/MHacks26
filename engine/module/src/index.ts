import { scheduleLive } from "../../src/runtime/scheduler.js";
import { schema, table, t } from "spacetimedb/server";
import { ScheduleAt } from "spacetimedb";
import type {
  Commands,
  Queries,
  Role,
  ArtifactRef,
} from "../../contract/behavior-v1.js";
import { command, bootstrap, provision } from "../../src/runtime/runtime.js";
import { query, availableWork } from "../../src/runtime/queries.js";
import {
  beginUpload,
  uploadChunk,
  finalizeUpload,
  readArtifact,
  MAX_CHUNK_BYTES,
} from "../../src/runtime/artifacts.js";
import { requireRun, type Context } from "../../src/runtime/access.js";
import {
  TransactionStore,
  get,
  put,
  type Store,
  type RecordRow,
  type Family,
} from "../../src/runtime/store.js";
import {
  canonical,
  hash,
  DomainFault,
  ensure,
} from "../../src/domain/primitives.js";
import { encodeBase64 } from "../../src/navigation/grid.js";
const record = table(
  {
    name: "record",
    indexes: [
      {
        accessor: "byScopeStateDue",
        algorithm: "btree",
        columns: ["familyScope", "status", "due"],
      },
    ],
  },
  {
    key: t.string().primaryKey(),
    family: t.string().index("btree"),
    scope: t.string().index("btree"),
    familyScope: t.string().index("btree"),
    status: t.string().index("btree"),
    due: t.u64().index("btree"),
    sequence: t.f64(),
    body: t.string(),
  },
);
const reply = table(
  { name: "reply" },
  {
    key: t.string().primaryKey(),
    caller: t.identity().index("btree"),
    id: t.string(),
    digest: t.string(),
    body: t.string(),
    atMs: t.f64(),
  },
);
const clock = table(
  { name: "clock" },
  { id: t.u32().primaryKey(), now: t.f64() },
);
const wake = table(
  { name: "wake" },
  { scheduledId: t.u64().primaryKey().autoInc(), scheduledAt: t.scheduleAt() },
);
const db = schema({ record, reply, clock, wake });
export default db;
type Row = Omit<RecordRow, "due" | "family"> & {
  familyScope: string;
  due: bigint;
  family: string;
};
type ReadTable = {
  key: { find(key: string): Row | null };
  family: { filter(value: string): Iterable<Row> };
  familyScope: { filter(value: string): Iterable<Row> };
};
type WriteTable = ReadTable & {
  key: ReadTable["key"] & {
    update(row: Row): unknown;
    delete(key: string): unknown;
  };
  insert(row: Row): unknown;
};
function storeFor(table: ReadTable, write?: WriteTable): Store {
  return {
    get: (key) => {
      const r = table.key.find(key);
      return r
        ? { ...r, family: r.family as Family, due: Number(r.due) }
        : undefined;
    },
    list: (family: Family, scope?: string) =>
      [
        ...(scope === undefined
          ? table.family.filter(family)
          : table.familyScope.filter(canonical([family, scope]))),
      ].map((r) => ({ ...r, family: r.family as Family, due: Number(r.due) })),
    put: (r) => {
      if (!write) throw new Error("Read-only view");
      const row = {
        ...r,
        due: BigInt(r.due),
        familyScope: canonical([r.family, r.scope]),
      };
      if (table.key.find(r.key)) write.key.update(row);
      else write.insert(row);
    },
    delete: (key) => {
      if (!write) throw new Error("Read-only view");
      write.key.delete(key);
    },
  };
}
export const init = db.init((ctx) => {
  bootstrap(storeFor(ctx.db.record, ctx.db.record), ctx.sender.toHexString());
  ctx.db.clock.insert({
    id: 0,
    now: Number(ctx.timestamp.microsSinceUnixEpoch / 1000n),
  });
  ctx.db.wake.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(250000n),
  });
});
export const tick = db.reducer(
  { onSchedule: wake },
  { arg: wake.rowType },
  (ctx, _args) => {
    if (!ctx.sender.isEqual(ctx.identity)) throw new Error("Scheduler only");
    const now = Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
    const previousClock = ctx.db.clock.id.find(0)?.now ?? 0;
    // The view clock is an expiry invalidation marker, not a live timer. A
    // 250ms write otherwise recomputes every viewer projection while idle.
    const expiryCrossed = [...ctx.db.record.family.filter("grant")].some(
      (row) => {
        const grant = JSON.parse(row.body) as { expiresAt: number | null };
        return (
          grant.expiresAt !== null &&
          grant.expiresAt > previousClock &&
          grant.expiresAt <= now
        );
      },
    );
    if (expiryCrossed) ctx.db.clock.id.update({ id: 0, now });
    scheduleLive(storeFor(ctx.db.record, ctx.db.record), {
      identity: ctx.identity.toHexString(),
      now: Number(ctx.timestamp.microsSinceUnixEpoch / 1000n),
      nonce: () => ctx.newUuidV4().toString(),
    });
  },
);
export const invoke = db.reducer(
  { id: t.string(), kind: t.string(), name: t.string(), payload: t.string() },
  (ctx, args) => {
    ensure(
      args.id.length <= 160 && /^[A-Za-z0-9_.:-]+$/.test(args.id),
      "Invalid transport request",
    );
    ensure(args.payload.length <= 2_000_000, "Transport payload limit");
    const store = storeFor(ctx.db.record, ctx.db.record),
      context: Context = {
        identity: ctx.sender.toHexString(),
        now: Number(ctx.timestamp.microsSinceUnixEpoch / 1000n),
        nonce: () => ctx.newUuidV4().toString(),
      };
    const digest = hash({
      kind: args.kind,
      name: args.name,
      payload: args.payload,
    });
    let body: unknown;
    try {
      let input: unknown;
      try {
        input = JSON.parse(args.payload);
      } catch {
        throw new DomainFault("INVALID_INPUT", "Malformed JSON");
      }
      ensure(
        input !== null && typeof input === "object" && !Array.isArray(input),
        "Operation payload must be an object",
      );
      if (args.kind === "command")
        body = command(
          store,
          context,
          args.name as keyof Commands,
          input as Commands[keyof Commands]["input"],
          args.id,
        );
      else if (args.kind === "query")
        body = {
          commandId: args.id,
          ok: true,
          result: query(
            store,
            context,
            args.name as keyof Queries,
            input as Queries[keyof Queries]["input"],
          ),
        };
      else {
        const old = get<{ digest: string; receipt: unknown }>(
          store,
          "receipt",
          `transport:${args.id}`,
          context.identity,
        );
        if (old) {
          ensure(old.digest === digest, "Transport ID conflict");
          body = old.receipt;
        } else {
          const tx = new TransactionStore(store);
          let result: unknown;
          if (args.kind === "upload_begin")
            result = beginUpload(
              tx,
              context,
              input as Parameters<typeof beginUpload>[2],
            );
          else if (args.kind === "upload_chunk") {
            const a = input as { id: string; index: number; base64: string };
            uploadChunk(tx, context, a.id, a.index, a.base64);
            result = { accepted: true };
          } else if (args.kind === "upload_finalize")
            result = finalizeUpload(tx, context, (input as { id: string }).id);
          else if (args.kind === "artifact_chunk") {
            const a = input as { ref: ArtifactRef; index: number };
            const bytes = readArtifact(tx, context, a.ref);
            ensure(
              Number.isSafeInteger(a.index) &&
                a.index >= 0 &&
                a.index < Math.ceil(bytes.length / MAX_CHUNK_BYTES),
              "Invalid chunk",
            );
            result = {
              base64: encodeBase64(
                bytes.slice(
                  a.index * MAX_CHUNK_BYTES,
                  (a.index + 1) * MAX_CHUNK_BYTES,
                ),
              ),
            };
          } else if (args.kind === "provision") {
            const a = input as { identity: string; roles: Role[] };
            provision(tx, context, a.identity, a.roles);
            result = { provisioned: true };
          } else throw new DomainFault("INVALID_INPUT", "Unknown operation");
          body = { commandId: args.id, ok: true, result };
          tx.commit();
          if (args.kind !== "artifact_chunk")
            put(
              store,
              "receipt",
              `transport:${args.id}`,
              { digest, receipt: body },
              context.identity,
            );
        }
      }
    } catch (e) {
      if (!(e instanceof DomainFault)) throw e;
      body = { commandId: args.id, ok: false, error: e.error };
    }
    const row = {
      key: canonical([context.identity, args.id]),
      caller: ctx.sender,
      id: args.id,
      digest,
      body: JSON.stringify(body),
      atMs: context.now,
    };
    if (ctx.db.reply.key.find(row.key)) ctx.db.reply.key.update(row);
    else ctx.db.reply.insert(row);
    const oldReplies = [...ctx.db.reply.caller.filter(ctx.sender)].sort(
      (a, b) => b.atMs - a.atMs || a.id.localeCompare(b.id),
    );
    for (const old of oldReplies.slice(200)) ctx.db.reply.key.delete(old.key);
  },
);
export const myReplies = db.view(
  { name: "my_replies", public: true },
  t.array(reply.rowType),
  (ctx) => [...ctx.db.reply.caller.filter(ctx.sender)],
);
const publication = t.row("Publication", {
  runId: t.string(),
  revision: t.f64(),
  body: t.string(),
});
export const liveRuns = db.view(
  { name: "live_runs", public: true },
  t.array(publication),
  (ctx) => {
    const store = storeFor(ctx.db.record),
      context = {
        identity: ctx.sender.toHexString(),
        now: ctx.db.clock.id.find(0)?.now ?? 0,
        nonce: () => "",
      };
    const output: { runId: string; revision: number; body: string }[] = [];
    for (const row of store.list("publication")) {
      try {
        requireRun(store, context, row.scope);
        output.push({
          runId: row.scope,
          revision: row.sequence,
          body: row.body,
        });
      } catch (e) {
        if (!(e instanceof DomainFault)) throw e;
      }
    }
    return output;
  },
);
const availability = t.row("WorkAvailability", {
  kind: t.string(),
  count: t.u32(),
});
export const workAvailable = db.view(
  { name: "work_available", public: true },
  t.array(availability),
  (ctx) =>
    availableWork(storeFor(ctx.db.record), {
      identity: ctx.sender.toHexString(),
      now: ctx.db.clock.id.find(0)?.now ?? 0,
      nonce: () => "",
    }),
);
