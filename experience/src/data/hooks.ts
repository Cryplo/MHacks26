import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { ArtifactRef, Id, ParkBundle, RunManifest, RuntimeClient } from '../../contract/behavior-v1';
import { sha256Hex } from '../domain/canonical';
import { parkBundleSchema, validate } from '../domain/schemas';
import { decodeGrid } from '../renderer/parkCanvas';
import { useRuntime } from '../runtime/RuntimeProvider';
import { LiveConnection } from './liveConnection';
import type { LiveState, LiveStore } from './liveStore';
import { useAsync } from './useAsync';

/** Subscribe to a slice of the live store; re-renders only when the selected value changes. */
export function useLiveSelector<T>(store: LiveStore, selector: (s: LiveState) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const last = useRef<{ state: LiveState; value: T } | null>(null);
  const get = () => {
    const state = store.getState();
    if (last.current && last.current.state === state) return last.current.value;
    const value = selector(state);
    if (last.current && isEqual(last.current.value, value)) {
      last.current = { state, value: last.current.value };
      return last.current.value;
    }
    last.current = { state, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}

/** One live connection per (client, run). Old subscriptions are torn down before switching. */
export function useLiveRun(runId: Id): LiveConnection {
  const { client } = useRuntime();
  const conn = useMemo(() => new LiveConnection(client), [client]);
  useEffect(() => {
    conn.connect(runId);
    return () => conn.disconnect();
  }, [conn, runId]);
  return conn;
}

export class ArtifactIntegrityError extends Error {
  override name = 'ArtifactIntegrityError';
}

/** Fetch an immutable artifact and verify byte length + SHA-256 against its reference. */
export async function fetchVerifiedJson(client: RuntimeClient, ref: ArtifactRef): Promise<unknown> {
  const bytes = await client.getArtifact(ref);
  if (bytes.length !== ref.byteLength) throw new ArtifactIntegrityError(`Artifact ${ref.artifactId} has ${bytes.length} bytes; reference says ${ref.byteLength}.`);
  const sha = await sha256Hex(bytes);
  if (sha !== ref.sha256) throw new ArtifactIntegrityError(`Artifact ${ref.artifactId} hash mismatch (expected ${ref.sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…).`);
  return JSON.parse(new TextDecoder().decode(bytes));
}

export type LoadedPark = { park: ParkBundle; codes: Uint8Array };
const parkCache = new Map<string, Promise<LoadedPark>>();

export function loadPark(client: RuntimeClient, ref: ArtifactRef): Promise<LoadedPark> {
  const key = `${ref.artifactId}:${ref.sha256}`;
  let p = parkCache.get(key);
  if (!p) {
    p = (async () => {
      const json = await fetchVerifiedJson(client, ref);
      const v = validate<ParkBundle>(parkBundleSchema, json);
      if (!v.ok) throw new ArtifactIntegrityError(`Park bundle failed validation: ${v.issues.join('; ')}`);
      const codes = decodeGrid(v.value);
      if (codes.length !== v.value.grid.width * v.value.grid.height) throw new ArtifactIntegrityError('Grid byte length does not match width x height.');
      if ((await sha256Hex(codes)) !== v.value.grid.cellsSha256) throw new ArtifactIntegrityError('Grid cells hash mismatch.');
      return { park: v.value, codes };
    })();
    p.catch(() => parkCache.delete(key));
    parkCache.set(key, p);
  }
  return p;
}

export function useRunManifestAndPark(runId: Id) {
  const { client } = useRuntime();
  return useAsync(async () => {
    const manifest: RunManifest = await client.query('getManifest', { runId });
    const park = await loadPark(client, manifest.park);
    return { manifest, ...park };
  }, [client, runId]);
}
