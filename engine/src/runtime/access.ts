import type { Role, Scope } from "../../contract/behavior-v1.js";
import { DomainFault, ensure, hash } from "../domain/primitives.js";
import { get, list, put, type Store } from "./store.js";
export type Context = { identity: string; now: number; nonce: () => string };
export type Grant = {
  id: string;
  identity: string;
  runId: string;
  role: Role;
  expiresAt: number | null;
  shareId: string | null;
  delegable: boolean;
};
export type Share = {
  id: string;
  owner: string;
  runId: string;
  role: "viewer" | "operator";
  tokenHash: string;
  expiresAt: number;
  revoked: boolean;
};
export type RoleRecord = { identity: string; roles: Role[] };
export function requireRole(store: Store, ctx: Context, roles: Role[]) {
  const r = get<RoleRecord>(store, "role", ctx.identity);
  if (!r?.roles.some((x) => roles.includes(x)))
    throw new DomainFault("FORBIDDEN", `Requires ${roles.join(" or ")}`);
}
export function grantFor(
  store: Store,
  ctx: Context,
  runId: string,
): Grant | undefined {
  return list<Grant>(store, "grant", runId).find(
    (g) =>
      g.identity === ctx.identity &&
      (g.expiresAt === null || g.expiresAt > ctx.now) &&
      (!g.shareId || !get<Share>(store, "share", g.shareId)?.revoked),
  );
}
export function requireRun(
  store: Store,
  ctx: Context,
  runId: string,
  write = false,
): Grant {
  const grant = grantFor(store, ctx, runId);
  if (!grant || (write && !["operator", "coordinator"].includes(grant.role)))
    throw new DomainFault("FORBIDDEN", "Run access denied");
  return grant;
}
export function authorizeScope(
  store: Store,
  ctx: Context,
  scope: Scope,
  write = false,
) {
  if (scope.runId) requireRun(store, ctx, scope.runId, write);
  if (scope.experimentId) {
    const x = get<{ owner: string }>(store, "experiment", scope.experimentId);
    if (x?.owner !== ctx.identity) {
      const lease = list<{
        scope: Scope;
        lease: { ownerIdentity: string; expiresAtEpochMs: number } | null;
      }>(store, "work").find(
        (w) =>
          w.scope.experimentId === scope.experimentId &&
          w.lease?.ownerIdentity === ctx.identity &&
          w.lease.expiresAtEpochMs > ctx.now,
      );
      if (!lease)
        throw new DomainFault("FORBIDDEN", "Experiment access denied");
    }
  }
  if (!scope.runId && !scope.experimentId)
    requireRole(store, ctx, ["operator", "worker", "coordinator"]);
}
export function rateLimit(
  store: Store,
  ctx: Context,
  bucket: string,
  limit: number,
  windowMs = 60000,
) {
  const id = `${ctx.identity}:${bucket}`,
    old = get<{ start: number; count: number }>(store, "rate", id),
    r =
      old && ctx.now - old.start < windowMs
        ? old
        : { start: ctx.now, count: 0 };
  if (r.count >= limit)
    throw new DomainFault("RATE_LIMITED", `${bucket} rate exceeded`);
  r.count++;
  put(store, "rate", id, r);
}
export function issueShare(
  store: Store,
  ctx: Context,
  runId: string,
  role: "viewer" | "operator",
  tokenHash: string,
  expiresAt: number,
) {
  const grant = requireRun(store, ctx, runId, true);
  ensure(grant.delegable, "Delegation forbidden");
  ensure(/^[0-9a-f]{64}$/.test(tokenHash), "Invalid token hash");
  ensure(
    expiresAt > ctx.now && expiresAt <= ctx.now + 7 * 86400000,
    "Invalid share expiry",
  );
  ensure(
    !list<Share>(store, "share").some((s) => s.tokenHash === tokenHash),
    "Token already issued",
  );
  const id = `share:${ctx.nonce()}`;
  put(store, "share", id, {
    id,
    owner: ctx.identity,
    runId,
    role,
    tokenHash,
    expiresAt,
    revoked: false,
  } satisfies Share);
  return { grantId: id };
}
export function redeemShare(store: Store, ctx: Context, token: string) {
  ensure(
    typeof token === "string" && token.length >= 32 && token.length <= 256,
    "Invalid share material",
  );
  const tokenHash = hash(token);
  const share = list<Share>(store, "share").find(
    (s) => s.tokenHash === tokenHash && !s.revoked && s.expiresAt > ctx.now,
  );
  if (!share) throw new DomainFault("FORBIDDEN", "Share invalid or expired");
  const id = `${share.id}:${ctx.identity}`;
  put(
    store,
    "grant",
    id,
    {
      id,
      identity: ctx.identity,
      runId: share.runId,
      role: share.role,
      expiresAt: share.expiresAt,
      shareId: share.id,
      delegable: false,
    } satisfies Grant,
    share.runId,
  );
  return { runId: share.runId, role: share.role };
}
