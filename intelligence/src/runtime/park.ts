import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ArtifactRef, ParkBundle, RuntimeClient } from '../../contract/behavior-v1.ts';
import { harborLightsFixturePark, parkArtifact } from '../fixtures/harbor-lights.ts';
import { systemClock } from './clock.ts';

/**
 * Park for real-Engine runs: the authored Harbor Lights compiled by Engine
 * (BEHAVIOR_PARK_BUNDLE, default ../experience/assets/park.bundle.json). The lane's own
 * fixture park is only a fallback for orchestration without that file and is not guaranteed
 * to pass Engine's navigation validator.
 */
export function realEnginePark(env: NodeJS.ProcessEnv = process.env): ParkBundle {
  const path = env.BEHAVIOR_PARK_BUNDLE ? resolve(env.BEHAVIOR_PARK_BUNDLE) : resolve(import.meta.dirname, '../../../experience/assets/park.bundle.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ParkBundle) : harborLightsFixturePark();
}

/** Uploads + registers a park, then waits for Engine's preparing -> ready transition. */
export async function registerParkAndWait(operator: RuntimeClient, bundle: ParkBundle, timeoutMs = 300_000): Promise<ArtifactRef> {
  const art = parkArtifact(bundle);
  const park = await operator.putArtifact({ kind: 'park', mediaType: 'application/json', bytes: art.bytes, scope: { runId: null, experimentId: null }, commandId: `artifact:park:${art.ref.sha256}` });
  const reg = await operator.command('registerPark', { artifact: park }, `register:${park.sha256}`);
  if (!reg.ok && reg.error.code !== 'CONFLICT') throw new Error(`registerPark ${reg.error.code}: ${reg.error.message}`);
  const deadline = systemClock.nowEpochMs() + timeoutMs;
  for (;;) {
    const listed = (await operator.query('listParks', { cursor: null })).items.find((p) => p.artifact.sha256 === park.sha256);
    if (listed?.status === 'ready') return listed.artifact;
    if (listed?.status === 'invalid') throw new Error(`park invalid: ${listed.issues.join('; ')}`);
    if (systemClock.nowEpochMs() > deadline) throw new Error(`park still ${listed?.status ?? 'unlisted'} after ${timeoutMs} ms`);
    await systemClock.sleep(500);
  }
}
