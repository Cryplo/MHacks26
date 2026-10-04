/**
 * Jev reports probabilities rounded to two decimals (observed on jev-1.13.0, 2026-10-04), so a
 * valid distribution over n options can sum to 1 +/- up to n * 0.005. This ADAPTER-LEVEL step
 * renormalizes such a vector only when every value lies on the 0.01 grid and the deviation is
 * within that worst-case rounding bound. The vendor's raw bytes are kept unchanged as the
 * response artifact; any other deviation still fails the 1e-6 validation downstream.
 */
export const JEV_PROBABILITY_STEP = 0.01;

export function dequantize(values: readonly unknown[], step = JEV_PROBABILITY_STEP): { values: number[]; rawSum: number } | null {
  if (!values.length || !values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)) return null;
  const nums = values as number[];
  if (!nums.every((v) => Math.abs(v / step - Math.round(v / step)) < 1e-6)) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  const dev = Math.abs(sum - 1);
  if (dev <= 1e-9 || dev > (step / 2) * nums.length + 1e-9) return null;
  return { values: nums.map((v) => v / sum), rawSum: sum };
}
