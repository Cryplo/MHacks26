import { expect, it } from 'vitest';
import { mockDistribution } from '../../src/providers/mock.ts';
import { conformance } from '../helpers/fixtures.ts';

// Pinned in BOTH lanes (engine/tests/unit/mock-policy.test.ts): Engine evaluates this same
// policy in-process for mock runs, so any change here must be mirrored in engine/src/sim/mock-policy.ts.
it('mock-policy-v1 distribution for the conformance request is pinned', () => {
  expect(mockDistribution(conformance().decisionRequest)).toEqual([
    { optionId: 'browse', probability: 0.23470734685509148 },
    { optionId: 'leave', probability: 0.0031673232835691873 },
    { optionId: 'travel_splash', probability: 0.7621253298613393 },
  ]);
});
