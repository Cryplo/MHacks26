/**
 * Frozen run plan -> RunManifest. The browser only assembles references to immutable
 * artifacts and declared settings; Engine validates everything again at createRun.
 */
import type { ArtifactRef, FeatureFlags, Mode, RunConfig, RunManifest, Scenario, VersionSet } from '../../../contract/behavior-v1';
import { CONTRACT_VERSION } from '../../../contract/behavior-v1';

export const NO_FEATURES: FeatureFlags = { routeChoice: false, bumpReactions: false, splitGroups: false, speechBubbles: false, discountMessages: false };

/**
 * Versions REQUESTED by the operator UI. v1 has no capability that reports server versions,
 * so these are declared labels that Engine validates or rejects (see
 * docs/integration-proposals/0001-server-version-set.md).
 */
export const REQUESTED_VERSIONS: VersionSet = {
  engine: 'engine-v1', observation: 'observation.v1', options: 'options.v1', random: 'behavior-rng-v1', persona: 'population-v1',
  prompt: 'jev-instructions-v1', requestedModel: 'mock-policy-v1', meter: 'meter.v1', loading: 'loading.v1', metrics: 'metrics-v1',
  rubric: 'satisfaction-rubric-v1', replay: 'replay.v1', sourceCommit: 'unknown',
};
/** Model requested for behavior: Intelligence's mock policy, or Jev for live runs. */
export const REQUESTED_MODEL: Record<Mode, string> = { mock: 'mock-policy-v1', live: 'jev-1.13.0', local: 'laya-multilingual-mlx-f2b4faf5', experiment: 'mock-policy-v1', replay: 'mock-policy-v1' };

export function defaultRunConfig(mode: Mode, features: FeatureFlags = NO_FEATURES): RunConfig {
  return {
    mode, horizonMs: 10 * 3600_000, logicalStepMs: 5000, movementStepMs: 250, requestedSpeed: mode === 'local' ? 5 : 20, temperature: 1,
    earlyDepartureThresholdMs: 30 * 60_000, ratingEveryMs: 30 * 60_000, visualFrameEveryMs: 30_000, checkpointEveryMs: 30 * 60_000,
    fallback: (mode === 'live' || mode === 'local') ? 'live_timeout_v1' : 'forbidden', liveTimeoutMs: 20_000, features, versions: { ...REQUESTED_VERSIONS, prompt: mode === 'local' ? 'laya-compact-v1' : REQUESTED_VERSIONS.prompt, requestedModel: REQUESTED_MODEL[mode] },
  };
}

export function buildManifest(input: {
  park: ArtifactRef; population: ArtifactRef; scenario: Scenario; seed: string; config: RunConfig;
  experiment?: RunManifest['experiment'];
}): RunManifest {
  return {
    contractVersion: CONTRACT_VERSION, park: input.park, population: input.population, scenario: input.scenario,
    replicateSeed: input.seed, config: input.config, experiment: input.experiment ?? null, initialCheckpoint: null, replayTape: null,
  };
}

export const HORIZON_OPTIONS_MS = [3600_000, 2 * 3600_000, 3 * 3600_000, 4 * 3600_000, 10 * 3600_000];
