import type {
  ArtifactKind,
  ArtifactRef,
  Scope,
} from "../../contract/behavior-v1.js";
import {
  DomainFault,
  ensure,
  hashBytes,
  canonical,
} from "../domain/primitives.js";
import { encodeBase64, decodeBase64 } from "../navigation/grid.js";
import { get, put, key, type Store, list } from "./store.js";
import {
  authorizeScope,
  requireRun,
  rateLimit,
  type Context,
} from "./access.js";
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024,
  MAX_CHUNK_BYTES = 48 * 1024;
const kinds: ArtifactKind[] = [
  "park",
  "population",
  "model_response",
  "checkpoint",
  "response_tape",
  "fact_bundle",
  "experiment_report",
  "narrative",
  "frames",
];
export type ArtifactRecord = {
  ref: ArtifactRef;
  scope: Scope;
  owner: string;
  readers?: string[];
  chunks: number;
  complete: boolean;
};
type Upload = {
  id: string;
  kind: ArtifactKind;
  mediaType: string;
  scope: Scope;
  owner: string;
  byteLength: number;
  sha256: string;
  chunks: number;
};
function canUpload(store: Store, ctx: Context, scope: Scope) {
  const assigned = list<{
    scope: Scope;
    lease: { ownerIdentity: string; expiresAtEpochMs: number } | null;
  }>(store, "work").some(
    (w) =>
      w.scope.runId === scope.runId &&
      w.scope.experimentId === scope.experimentId &&
      w.lease?.ownerIdentity === ctx.identity &&
      w.lease.expiresAtEpochMs > ctx.now,
  );
  if (!assigned) authorizeScope(store, ctx, scope, true);
}
export function beginUpload(
  store: Store,
  ctx: Context,
  input: Omit<Upload, "owner" | "chunks">,
) {
  ensure(kinds.includes(input.kind), "Invalid artifact kind");
  ensure(
    typeof input.id === "string" &&
      input.id.length <= 160 &&
      /^[A-Za-z0-9_.:-]+$/.test(input.id),
    "Invalid upload ID",
  );
  ensure(
    Number.isSafeInteger(input.byteLength) &&
      input.byteLength > 0 &&
      input.byteLength <= MAX_ARTIFACT_BYTES,
    "Artifact size limit",
  );
  ensure(/^[0-9a-f]{64}$/.test(input.sha256), "Invalid artifact hash");
  ensure(
    input.mediaType === "application/json" ||
      input.mediaType === "application/octet-stream",
    "Unsupported artifact media",
  );
  ensure(
    input.scope &&
      typeof input.scope === "object" &&
      (input.scope.runId === null || typeof input.scope.runId === "string") &&
      (input.scope.experimentId === null ||
        typeof input.scope.experimentId === "string"),
    "Invalid artifact scope",
  );
  canUpload(store, ctx, input.scope);
  const existing = get<Upload>(store, "upload", input.id, ctx.identity);
  const u = {
    ...input,
    owner: ctx.identity,
    chunks: Math.ceil(input.byteLength / MAX_CHUNK_BYTES),
  };
  if (existing) {
    ensure(canonical(existing) === canonical(u), "Upload ID conflict");
    return { uploadId: input.id };
  }
  const worker = get<{ roles: string[] }>(
    store,
    "role",
    ctx.identity,
  )?.roles.includes("worker");
  rateLimit(store, ctx, "artifact", worker ? 3000 : 30);
  put(store, "upload", input.id, u, ctx.identity);
  return { uploadId: input.id };
}
export function uploadChunk(
  store: Store,
  ctx: Context,
  id: string,
  index: number,
  base64: string,
) {
  const u = get<Upload>(store, "upload", id, ctx.identity);
  ensure(u, "Unknown upload");
  ensure(
    Number.isInteger(index) && index >= 0 && index < u.chunks,
    "Chunk index out of range",
  );
  const bytes = decodeBase64(base64),
    expected =
      index === u.chunks - 1
        ? u.byteLength - index * MAX_CHUNK_BYTES
        : MAX_CHUNK_BYTES;
  ensure(bytes.length === expected, "Chunk length mismatch");
  const chunkId = `${id}:${index}`,
    existing = get<{ base64: string }>(store, "chunk", chunkId, ctx.identity);
  if (existing) {
    ensure(existing.base64 === base64, "Chunk conflicts with existing bytes");
    return;
  }
  put(store, "chunk", chunkId, { base64 }, ctx.identity);
}
export function finalizeUpload(
  store: Store,
  ctx: Context,
  id: string,
): ArtifactRef {
  const u = get<Upload>(store, "upload", id, ctx.identity);
  ensure(u, "Unknown upload");
  canUpload(store, ctx, u.scope);
  const artifactId = `artifact:${hashBytes(new TextEncoder().encode(`${ctx.identity}:${id}`)).slice(0, 40)}`,
    existing = get<ArtifactRecord>(store, "artifact", artifactId);
  if (existing) return existing.ref;
  const bytes = new Uint8Array(u.byteLength);
  for (let i = 0; i < u.chunks; i++) {
    const c = get<{ base64: string }>(
      store,
      "chunk",
      `${id}:${i}`,
      ctx.identity,
    );
    if (!c) throw new DomainFault("INCOMPLETE", "Missing artifact chunk");
    bytes.set(decodeBase64(c.base64), i * MAX_CHUNK_BYTES);
  }
  ensure(hashBytes(bytes) === u.sha256, "Artifact hash mismatch");
  const ref: ArtifactRef = {
    artifactId,
    kind: u.kind,
    sha256: u.sha256,
    byteLength: u.byteLength,
    mediaType: u.mediaType,
    contractVersion: "behavior.v1",
  };
  put(store, "artifact", artifactId, {
    ref,
    scope: u.scope,
    owner: ctx.identity,
    chunks: u.chunks,
    complete: true,
  } satisfies ArtifactRecord);
  for (let i = 0; i < u.chunks; i++) {
    const c = get<{ base64: string }>(
      store,
      "chunk",
      `${id}:${i}`,
      ctx.identity,
    )!;
    put(store, "chunk", String(i), c, artifactId);
    store.delete(key("chunk", `${id}:${i}`, ctx.identity));
  }
  return ref;
}
export function readArtifact(
  store: Store,
  ctx: Context,
  ref: ArtifactRef,
  internal = false,
): Uint8Array {
  const a = get<ArtifactRecord>(store, "artifact", ref.artifactId);
  ensure(
    a && a.complete && canonical(a.ref) === canonical(ref),
    "Artifact missing or reference mismatch",
  );
  if (
    !internal &&
    a.owner !== ctx.identity &&
    !a.readers?.includes(ctx.identity)
  ) {
    if (a.ref.kind === "model_response")
      throw new DomainFault("FORBIDDEN", "Raw provider artifact is private");
    const references = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false;
      if ("artifactId" in value && value.artifactId === ref.artifactId)
        return true;
      return Object.values(value).some(references);
    };
    const assigned = list<{
      payload: unknown;
      lease: { ownerIdentity: string; expiresAtEpochMs: number } | null;
    }>(store, "work").some(
      (w) =>
        w.lease?.ownerIdentity === ctx.identity &&
        w.lease.expiresAtEpochMs > ctx.now &&
        references(w.payload),
    );
    if (!assigned) {
      if (a.scope.runId) requireRun(store, ctx, a.scope.runId);
      else if (a.scope.experimentId) authorizeScope(store, ctx, a.scope);
      else throw new DomainFault("FORBIDDEN", "Artifact access denied");
    }
  }
  const bytes = new Uint8Array(ref.byteLength);
  for (let i = 0; i < a.chunks; i++) {
    const c = get<{ base64: string }>(
      store,
      "chunk",
      String(i),
      ref.artifactId,
    );
    ensure(c, "Corrupt artifact storage");
    bytes.set(decodeBase64(c.base64), i * MAX_CHUNK_BYTES);
  }
  ensure(hashBytes(bytes) === ref.sha256, "Corrupt artifact bytes");
  return bytes;
}
export function readJSON<T>(
  store: Store,
  ctx: Context,
  ref: ArtifactRef,
  kind: ArtifactKind,
  internal = false,
): T {
  ensure(
    ref.kind === kind && ref.mediaType === "application/json",
    "Wrong artifact type",
  );
  return JSON.parse(
    new TextDecoder().decode(readArtifact(store, ctx, ref, internal)),
  ) as T;
}
export function writeJSON(
  store: Store,
  ctx: Context,
  kind: ArtifactKind,
  scope: Scope,
  value: unknown,
): ArtifactRef {
  const bytes = new TextEncoder().encode(canonical(value));
  ensure(bytes.length <= MAX_ARTIFACT_BYTES, "Generated artifact too large");
  const sha256 = hashBytes(bytes),
    artifactId = `artifact:${ctx.nonce()}`,
    ref: ArtifactRef = {
      artifactId,
      kind,
      sha256,
      byteLength: bytes.length,
      mediaType: "application/json",
      contractVersion: "behavior.v1",
    };
  const chunks = Math.ceil(bytes.length / MAX_CHUNK_BYTES);
  put(store, "artifact", artifactId, {
    ref,
    scope,
    owner: ctx.identity,
    chunks,
    complete: true,
  } satisfies ArtifactRecord);
  for (let i = 0; i < chunks; i++)
    put(
      store,
      "chunk",
      String(i),
      {
        base64: encodeBase64(
          bytes.slice(i * MAX_CHUNK_BYTES, (i + 1) * MAX_CHUNK_BYTES),
        ),
      },
      artifactId,
    );
  return ref;
}

export function attachArtifactReader(
  store: Store,
  ctx: Context,
  ref: ArtifactRef,
  identity: string,
) {
  readArtifact(store, ctx, ref);
  const a = get<ArtifactRecord>(store, "artifact", ref.artifactId)!;
  ensure(a.owner === ctx.identity, "Only artifact owner may attach a result");
  ensure(a.ref.kind !== "model_response", "Raw responses stay private");
  a.readers = [...new Set([...(a.readers ?? []), identity])];
  put(store, "artifact", ref.artifactId, a);
}
