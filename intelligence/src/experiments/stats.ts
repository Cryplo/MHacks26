import type { MetricId, PairedSummary } from '../../contract/behavior-v1.ts';

export const ANALYSIS_VERSION = 'paired-analysis-v1';

/** ln Gamma(x) for x > 0 (Lanczos, g = 7, n = 9); relative error below 1e-14 in the range used here. */
function lnGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const xx = x - 1;
  let a = c[0]!;
  const t = xx + 7.5;
  for (let i = 1; i < 9; i++) a += c[i]! / (xx + i);
  return 0.5 * Math.log(2 * Math.PI) + (xx + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betacf(a: number, b: number, x: number): number {
  const FPMIN = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 10_000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) return h;
  }
  throw new Error('incomplete beta continued fraction did not converge');
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student t CDF with `df` degrees of freedom. */
export function studentTCdf(t: number, df: number): number {
  if (!(df > 0)) throw new Error('df must be positive');
  const tail = 0.5 * regularizedBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Quantile of the Student t distribution (bisection on the exact CDF to ~1e-12). */
export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) throw new Error('p must be in (0, 1)');
  if (!(Number.isFinite(df) && df > 0)) throw new Error('df must be a positive finite number');
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (studentTCdf(hi, df) < p) { lo = hi; hi *= 2; if (hi > 1e12) break; }
  for (let i = 0; i < 300 && hi - lo > 1e-13 * Math.max(1, hi); i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Paired summary for B - A differences of complete eligible pairs. n=0 -> all null; n=1 -> mean/min/max
 * only. The paired-t interval is produced ONLY when explicitly requested and n >= 2; min/max is never an
 * interval. Zero differences are real values, not missing.
 */
export function pairedSummary(metricId: MetricId, differences: readonly number[], analysis: 'paired_descriptive' | 'paired_t', alpha = 0.05): PairedSummary {
  for (const d of differences) if (typeof d !== 'number' || !Number.isFinite(d)) throw new Error(`non-finite difference for ${metricId}`);
  if (alpha !== 0.05) throw new Error('only alpha 0.05 (level 0.95) is supported by the contract');
  const n = differences.length;
  if (n === 0) return { metricId, pairCount: 0, differences: [], mean: null, min: null, max: null, sampleSd: null, interval: null };
  const mean = differences.reduce((s, d) => s + d, 0) / n;
  const min = Math.min(...differences);
  const max = Math.max(...differences);
  if (n === 1) return { metricId, pairCount: 1, differences: [...differences], mean, min, max, sampleSd: null, interval: null };
  const ss = differences.reduce((s, d) => s + (d - mean) ** 2, 0);
  const sampleSd = Math.sqrt(ss / (n - 1));
  let interval: PairedSummary['interval'] = null;
  if (analysis === 'paired_t') {
    const half = studentTQuantile(1 - alpha / 2, n - 1) * (sampleSd / Math.sqrt(n));
    interval = { kind: 'paired_t_mean', lower: mean - half, upper: mean + half, level: 0.95 };
  }
  return { metricId, pairCount: n, differences: [...differences], mean, min, max, sampleSd, interval };
}

export const PAIRED_T_ASSUMPTIONS = [
  'Paired-t interval assumes pair differences are independent draws from an approximately normal distribution.',
  'It quantifies conditional simulation variability of the mean B - A difference only; it excludes calibration, structural and model-policy uncertainty and does not validate the behavioral model.',
];
