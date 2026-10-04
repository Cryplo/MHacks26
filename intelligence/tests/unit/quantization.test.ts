import { describe, expect, it } from 'vitest';
import { dequantize } from '../../src/providers/quantization.ts';
import { validateDistribution } from '../../src/core/validate.ts';

describe('Jev two-decimal quantization (adapter-level, explicit)', () => {
  it('renormalizes an on-grid vector whose sum is within the rounding bound', () => {
    const r = dequantize([0.6, 0.39, 0]); // real jev-1.13.0 output shape, sum 0.99
    expect(r?.rawSum).toBeCloseTo(0.99, 12);
    expect(validateDistribution(['a', 'b', 'c'], r!.values.map((p, i) => ({ optionId: ['a', 'b', 'c'][i]!, probability: p }))).ok).toBe(true);
    expect(dequantize([0.34, 0.34, 0.33, 0.01])?.rawSum).toBeCloseTo(1.02, 12); // 4 options: bound 0.02
  });
  it('leaves exact vectors alone and refuses everything else', () => {
    expect(dequantize([0.2, 0.1, 0.7])).toBeNull(); // already sums to 1
    expect(dequantize([0.3333, 0.3333, 0.3])).toBeNull(); // not on the 0.01 grid
    expect(dequantize([0.5, 0.4])).toBeNull(); // 2 options: bound 0.01, deviation 0.1
    expect(dequantize([0.5, 0.48])).toBeNull(); // deviation 0.02 > 0.01 bound for 2 options
    expect(dequantize([0, 0])).toBeNull();
    expect(dequantize([-0.01, 1])).toBeNull();
    expect(dequantize(['0.5', 0.49])).toBeNull();
  });
});
