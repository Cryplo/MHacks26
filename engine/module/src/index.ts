import { schema, table, t } from "spacetimedb/server";
import { hash } from "../../src/domain/primitives.js";
const owner = table(
  { name: "owner" },
  { id: t.u32().primaryKey(), identity: t.identity() },
);
const receipt = table(
  { name: "receipt" },
  {
    id: t.string().primaryKey(),
    caller: t.identity().index("btree"),
    commandId: t.string(),
    payloadHash: t.string(),
    body: t.string(),
  },
);
const db = schema({ owner, receipt });
export default db;
export const init = db.init((ctx) => {
  ctx.db.owner.insert({ id: 0, identity: ctx.sender });
});
export const probe = db.reducer(
  { commandId: t.string(), payload: t.string() },
  (ctx, { commandId, payload }) => {
    const id = `${ctx.sender.toHexString()}:${commandId}`,
      payloadHash = hash(payload),
      existing = ctx.db.receipt.id.find(id);
    if (existing) return;
    const allowed = ctx.db.owner.id.find(0)?.identity.isEqual(ctx.sender);
    const body = allowed
      ? {
          commandId,
          ok: true,
          result: { hash: hash(JSON.parse(payload)), sdk: "2.10.2" },
        }
      : {
          commandId,
          ok: false,
          error: {
            code: "FORBIDDEN",
            message: "Operator required",
            retryable: false,
            fieldErrors: [],
          },
        };
    ctx.db.receipt.insert({
      id,
      caller: ctx.sender,
      commandId,
      payloadHash,
      body: JSON.stringify(body),
    });
  },
);
export const myReceipts = db.view(
  { name: "my_receipts", public: true },
  t.array(receipt.rowType),
  (ctx) => [...ctx.db.receipt.caller.filter(ctx.sender)],
);
