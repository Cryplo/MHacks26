import type { CrowdSpec } from '../../contract/behavior-v1.ts';

/** Default realistic 300-guest synthetic crowd (shares are guest shares, not group shares). */
export const DEFAULT_CROWD_300: CrowdSpec = {
  guestCount: 300, seed: 'seed-001',
  shares: { young_family: 0.35, teens: 0.1, couple: 0.15, thrill_seekers: 0.15, seniors: 0.1, solo: 0.15 },
  contextNotes: '', generatorVersion: 'population-v1',
};

/** Tiny valid population for fast tests. */
export const TINY_CROWD: CrowdSpec = {
  guestCount: 8, seed: 'tiny-001',
  shares: { young_family: 0.5, teens: 0, couple: 0.25, thrill_seekers: 0, seniors: 0, solo: 0.25 },
  contextNotes: '', generatorVersion: 'population-v1',
};
