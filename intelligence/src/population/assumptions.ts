import type { Archetype } from '../../contract/behavior-v1.ts';

/**
 * ILLUSTRATIVE, VERSIONED SYNTHETIC ASSUMPTIONS (assumptions-v1). These are engineering defaults
 * for a demo crowd, not empirical estimates of any real population. Distributions are wide and
 * overlap across archetypes on purpose: an archetype describes visit composition, not a fixed
 * trait profile, and no trait is deterministic for any age or group.
 */
export const ASSUMPTIONS_VERSION = 'assumptions-v1';

export const ARCHETYPES: readonly Archetype[] = ['young_family', 'teens', 'couple', 'thrill_seekers', 'seniors', 'solo'];

export type GroupShape = { minSize: number; maxSize: number; sizeWeights: readonly (readonly [string, number])[]; evenOnly?: boolean };

export const GROUP_SHAPES: Record<Archetype, GroupShape> = {
  young_family: { minSize: 2, maxSize: 5, sizeWeights: [['2', 1], ['3', 3], ['4', 4], ['5', 2]] },
  teens: { minSize: 2, maxSize: 4, sizeWeights: [['2', 3], ['3', 4], ['4', 3]] },
  couple: { minSize: 2, maxSize: 2, sizeWeights: [['2', 1]], evenOnly: true },
  thrill_seekers: { minSize: 1, maxSize: 4, sizeWeights: [['1', 2], ['2', 4], ['3', 3], ['4', 2]] },
  seniors: { minSize: 1, maxSize: 3, sizeWeights: [['1', 2], ['2', 6], ['3', 2]] },
  solo: { minSize: 1, maxSize: 1, sizeWeights: [['1', 1]] },
};

/** Mean of a wide (sd 0.22) thrill-preference distribution; individuals span the full range. */
export const THRILL_MEAN: Record<Archetype, number> = {
  young_family: 0.45, teens: 0.65, couple: 0.55, thrill_seekers: 0.8, seniors: 0.45, solo: 0.55,
};

/** Per-guest starting budget range in cents for the group wallet (group total = sum over members). */
export const BUDGET_PER_GUEST_CENTS: Record<Archetype, readonly [number, number]> = {
  young_family: [1500, 6000], teens: [1000, 4500], couple: [2500, 9000],
  thrill_seekers: [2000, 8000], seniors: [2000, 8000], solo: [1500, 7500],
};

export const AGE_RANGE = {
  parent: [24, 52], child: [2, 12], teen: [13, 17], couple: [20, 70], thrill: [18, 45], senior: [62, 85], solo: [18, 75],
} as const;

export const OCCASIONS: Record<Archetype, readonly string[]> = {
  young_family: ['birthday', 'school_break', 'vacation', 'local_day_out'],
  teens: ['school_break', 'birthday', 'local_day_out'],
  couple: ['anniversary', 'vacation', 'date_day', 'local_day_out'],
  thrill_seekers: ['vacation', 'season_opener', 'local_day_out', 'birthday'],
  seniors: ['reunion', 'vacation', 'local_day_out', 'grandchild_free_day'],
  solo: ['local_day_out', 'vacation', 'season_opener'],
};

/** Group language: same weights for every archetype (no archetype-specific assumption). */
export const LANGUAGES: readonly (readonly [string, number])[] = [['en', 80], ['es', 10], ['zh', 4], ['fr', 3], ['de', 3]];

export const APP_PROBABILITY_AGE_13_PLUS = 0.6;
export const PHONE_BATTERY_LIMIT_PROBABILITY = 0.2;
export const MOBILITY_RESTRICTED_PROBABILITY = 0.06;
export const STROLLER_MAX_AGE = 3;
export const MUST_DO_PROBABILITY = 0.5;
export const MIN_UNSUPERVISED_AGE = 13;
export const MIN_STAY_MS = 3_600_000;
