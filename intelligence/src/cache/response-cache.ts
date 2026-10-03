import type { Hash, Id } from '../../contract/behavior-v1.ts';
import { canonicalBytes, sha256Hex } from '../core/canonical.ts';
import type { DurableStore } from '../runtime/store.ts';
import { getJson, jsonBytes, parseJson } from '../runtime/store.ts';
import type { CacheEntry, CoalescerPort, ResponseCachePort } from '../worker/ports.ts';

export const CACHE_SCHEMA_VERSION = 'response-cache-v1';

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.:-]/g, '_');

/**
 * Durable exact-response cache. Layout (schema response-cache-v1):
 *   cache/<namespace>/<key>                 write-once CacheEntry JSON (first accepted value wins)
 *   cache-links/<namespace>/<key>/<request> write-once marker linking consuming decision/rating IDs
 *   raw/<sha256>                            raw provider bytes (written by the inference layer)
 * There is no TTL: an entry never changes or expires while its namespace (experiment) exists.
 */
export class ResponseCache implements ResponseCachePort {
  constructor(private readonly store: DurableStore) {}

  private entryKey(ns: string, key: Hash) { return `cache/${ns}/${key}`; }

  async get(ns: string, key: Hash): Promise<CacheEntry | null> {
    const e = await getJson<CacheEntry>(this.store, this.entryKey(ns, key));
    if (!e) return null;
    if (e.key !== key || e.namespace !== ns || e.schema !== 'response-cache-entry.v1') throw new Error(`corrupt cache entry ${ns}/${key}`);
    return e;
  }

  async putIfAbsent(entry: CacheEntry): Promise<{ entry: CacheEntry; created: boolean }> {
    const r = await this.store.putIfAbsent(this.entryKey(entry.namespace, entry.key), jsonBytes(entry));
    return { entry: parseJson<CacheEntry>(r.value), created: r.created };
  }

  async link(ns: string, key: Hash, requestId: Id): Promise<void> {
    await this.store.putIfAbsent(`cache-links/${ns}/${key}/${safe(requestId)}`, new TextEncoder().encode(requestId));
  }

  async entries(ns: string): Promise<CacheEntry[]> {
    const out: CacheEntry[] = [];
    for (const k of await this.store.list(`cache/${ns}/`)) {
      const e = await getJson<CacheEntry>(this.store, k);
      if (e) out.push(e);
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async links(ns: string, key: Hash): Promise<Id[]> {
    const prefix = `cache-links/${ns}/${key}/`;
    const out: Id[] = [];
    for (const k of await this.store.list(prefix)) {
      const v = await this.store.get(k);
      if (v) out.push(new TextDecoder().decode(v));
    }
    return out.sort();
  }

  async raw(sha: string): Promise<Uint8Array | null> { return this.store.get(`raw/${sha}`); }
}

export type ResponseTapeEntry = {
  key: Hash; kind: CacheEntry['kind']; modelRequested: string; modelReturned: string; policyVersion: string;
  instructionsVersion: string; originalSource: CacheEntry['originalSource'];
  probabilities: CacheEntry['probabilities']; score: number | null; confidence: number | null;
  normalization: CacheEntry['normalization']; responseArtifact: CacheEntry['responseArtifact'];
  rawSha256: string; rawPresent: boolean; callId: Id | null; consumers: Id[];
};

export type ResponseTape = {
  schema: 'response-tape.v1'; cacheSchema: string; namespace: string;
  entries: ResponseTapeEntry[]; sourceCounts: Record<string, number>;
};

/** Exports every frozen response in a namespace with its raw-bytes hash and consuming request IDs. */
export async function exportResponseTape(cache: ResponseCache, ns: string): Promise<{ tape: ResponseTape; bytes: Uint8Array; sha256: string }> {
  const entries: ResponseTapeEntry[] = [];
  const sourceCounts: Record<string, number> = {};
  for (const e of await cache.entries(ns)) {
    const raw = await cache.raw(e.responseArtifact.sha256);
    sourceCounts[e.originalSource] = (sourceCounts[e.originalSource] ?? 0) + 1;
    entries.push({
      key: e.key, kind: e.kind, modelRequested: e.modelRequested, modelReturned: e.modelReturned, policyVersion: e.policyVersion,
      instructionsVersion: e.instructionsVersion, originalSource: e.originalSource, probabilities: e.probabilities, score: e.score,
      confidence: e.confidence, normalization: e.normalization, responseArtifact: e.responseArtifact,
      rawSha256: e.responseArtifact.sha256, rawPresent: raw !== null && sha256Hex(raw) === e.responseArtifact.sha256,
      callId: e.callId, consumers: await cache.links(ns, e.key),
    });
  }
  const tape: ResponseTape = { schema: 'response-tape.v1', cacheSchema: CACHE_SCHEMA_VERSION, namespace: ns, entries, sourceCounts };
  const bytes = canonicalBytes(tape);
  return { tape, bytes, sha256: sha256Hex(bytes) };
}

/** Process-local in-flight deduplication. It does NOT coordinate separate worker processes. */
export class InflightCoalescer implements CoalescerPort {
  private readonly inflight = new Map<string, Promise<unknown>>();

  get size(): number { return this.inflight.size; }

  async run<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; owner: boolean }> {
    const existing = this.inflight.get(key) as Promise<T> | undefined;
    if (existing) return { value: await existing, owner: false };
    const p = fn();
    this.inflight.set(key, p);
    try {
      return { value: await p, owner: true };
    } finally {
      this.inflight.delete(key);
    }
  }
}
