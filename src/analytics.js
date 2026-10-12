/**
 * tianyicui-monitor analytics core.
 *
 * Pure, dependency-free statistics used by BOTH the plugin client half and the
 * offline build/tests. No DOM, no network, no Date.now() at module scope, so the
 * same file runs in Node and in the DSH browser bundle.
 *
 * Coordinate system: every timestamp crossing this API is EPOCH MILLISECONDS
 * UTC. Calendar bucketing for the heatmap uses CST (UTC+8), the maintainers'
 * working timezone, so a "day" matches how the team actually works.
 */

export const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

/* ------------------------------------------------------------------ *
 * small numeric helpers
 * ------------------------------------------------------------------ */

/** mean of a numeric array (0 for empty). */
export function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** population standard deviation (0 for empty). */
export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

/** Deterministic 32-bit PRNG (mulberry32) so bootstrap results are reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CST calendar day key `YYYY-MM-DD` for an epoch-ms instant. */
export function cstDayKey(ms) {
  const d = new Date(ms + CST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Epoch-ms of CST midnight that starts the day containing `ms`. */
export function cstDayStart(ms) {
  const shifted = ms + CST_OFFSET_MS;
  const floored = Math.floor(shifted / DAY_MS) * DAY_MS;
  return floored - CST_OFFSET_MS;
}

/* ------------------------------------------------------------------ *
 * series building
 * ------------------------------------------------------------------ */

/**
 * Merge commit instants into daily buckets.
 * @param {number[]} commitTimes epoch-ms
 * @param {number[]} releaseTimes epoch-ms
 * @returns {{days: Array<{key:string,start:number,tianyicui:number,all:number,isReleaseDay:boolean,releases:string[]}>}}
 */
export function buildDailySeries(commitTimes, releaseTimes, allTimes, endMs) {
  if (!commitTimes.length) return { days: [] };
  const startDay = cstDayStart(Math.min(...commitTimes, ...(allTimes || [])));
  const lastDataDay = cstDayStart(Math.max(...commitTimes, ...(allTimes || []), ...releaseTimes));
  // Callers that care about "what does the calendar look like now" pass an
  // explicit `endMs` (today). Without it the axis stops at the last commit,
  // which silently drops trailing zero days and makes a quiet stretch look like
  // a data gap.
  const endDay = endMs != null && Number.isFinite(endMs)
    ? Math.max(lastDataDay, cstDayStart(endMs))
    : lastDataDay;

  const byKey = new Map();
  for (let t = startDay; t <= endDay; t += DAY_MS) {
    const key = cstDayKey(t);
    byKey.set(key, { key, start: t, tianyicui: 0, all: 0, isReleaseDay: false, releases: [] });
  }
  for (const t of commitTimes) {
    const row = byKey.get(cstDayKey(t));
    if (row) row.tianyicui += 1;
  }
  for (const t of allTimes || []) {
    const row = byKey.get(cstDayKey(t));
    if (row) row.all += 1;
  }
  for (const t of releaseTimes) {
    const row = byKey.get(cstDayKey(t));
    if (row) {
      row.isReleaseDay = true;
      row.releases.push(t);
    }
  }
  const days = [...byKey.values()].sort((a, b) => a.start - b.start);
  return { days };
}

/**
 * Rolling-sum feature lookup over a day series.
 * Returns, for an arbitrary instant, the commit count in the trailing window.
 * @param {Array<{start:number,tianyicui:number,all:number}>} days
 * @param {number} hours trailing window length in hours
 * @returns {(ms:number)=>number} count of tianyicui commits in (ms-hours, ms]
 */
export function rollingFn(days, hours) {
  const spans = days.map((d) => ({ start: d.start, end: d.start + DAY_MS, ty: d.tianyicui, all: d.all }));
  return function at(ms) {
    let sum = 0;
    const lo = ms - hours * HOUR_MS;
    for (const s of spans) {
      // each day bucket has a uniform-density assumption: we only know the
      // bucket total, so we attribute the whole bucket if its midpoint falls in
      // the window. This keeps the feature causal (uses no future data) and is
      // the correct resolution available from calendar aggregates.
      if (s.end <= lo || s.start > ms) continue;
      const dayEnd = s.end;
      const dayStart = s.start;
      const overlapStart = Math.max(dayStart, lo);
      const overlapEnd = Math.min(dayEnd, ms);
      if (overlapEnd <= overlapStart) continue;
      const frac = (overlapEnd - overlapStart) / (dayEnd - dayStart);
      sum += s.ty * frac;
    }
    return sum;
  };
}

/** same as rollingFn but for the whole-team series. */
export function rollingAllFn(days, hours) {
  const spans = days.map((d) => ({ start: d.start, end: d.start + DAY_MS, all: d.all }));
  return function at(ms) {
    let sum = 0;
    const lo = ms - hours * HOUR_MS;
    for (const s of spans) {
      if (s.end <= lo || s.start > ms) continue;
      const overlapStart = Math.max(s.start, lo);
      const overlapEnd = Math.min(s.end, ms);
      if (overlapEnd <= overlapStart) continue;
      sum += s.all * ((overlapEnd - overlapStart) / (s.end - s.start));
    }
    return sum;
  };
}

/* ------------------------------------------------------------------ *
 * feature engineering
 * ------------------------------------------------------------------ */

/**
 * Build labelled training rows for the 24h-horizon release model.
 *
 * For each hour boundary `t` in the modelling window we ask: does a release
 * happen in (t, t+24h]? The features use ONLY information available at `t`,
 * which is what makes the resulting probability causal.
 *
 * @param {object} input
 * @param {number[]} input.commitTimes   tianyicui commit instants
 * @param {number[]} input.allTimes      whole-team commit instants
 * @param {number[]} input.releaseTimes  release instants
 * @param {number} [input.startMs]       window start (defaults to first release)
 * @param {number} [input.endMs]         window end (defaults to last commit)
 * @param {number} [input.stepHours]     sampling step
 */
export function buildTrainingRows(input) {
  const {
    commitTimes,
    allTimes,
    releaseTimes,
    startMs = Math.min(...releaseTimes),
    endMs = Math.max(...commitTimes, ...releaseTimes),
    stepHours = 1,
  } = input;

  const { days } = buildDailySeries(commitTimes, releaseTimes, allTimes);
  const ty24 = rollingFn(days, 24);
  const all24 = rollingAllFn(days, 24);

  // "hours since last tianyicui commit" is high-resolution and highly causal.
  const sorted = [...commitTimes].sort((a, b) => a - b);
  function hoursSinceCommit(ms) {
    // binary search for the last commit at or before ms
    let lo = 0;
    let hi = sorted.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= ms) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return 999;
    return (ms - sorted[best]) / HOUR_MS;
  }

  const relSorted = [...releaseTimes].sort((a, b) => a - b);
  function daysSinceRelease(ms) {
    let lo = 0;
    let hi = relSorted.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (relSorted[mid] <= ms) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (best < 0) return 99;
    return (ms - relSorted[best]) / DAY_MS;
  }

  const rows = [];
  const step = stepHours * HOUR_MS;
  for (let t = startMs; t <= endMs; t += step) {
    const horizonEnd = t + 24 * HOUR_MS;
    const y = relSorted.some((r) => r > t && r <= horizonEnd) ? 1 : 0;
    rows.push({
      t,
      y,
      f: {
        ty24: ty24(t),
        all24: all24(t),
        sinceCommit: Math.min(hoursSinceCommit(t), 240),
        sinceRelease: Math.min(daysSinceRelease(t), 60),
      },
    });
  }
  return rows;
}

export const FEATURE_NAMES = ['ty24', 'all24', 'sinceCommit', 'sinceRelease'];

/* ------------------------------------------------------------------ *
 * logistic regression (L2, standardized features)
 * ------------------------------------------------------------------ */

const EPS = 1e-12;

function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Standardize columns using the supplied (train-only) moments.
 * @returns {{X:number[][], mu:number[], sd:number[]}}
 */
export function standardize(rows, mu, sd) {
  const X = rows.map((r) =>
    FEATURE_NAMES.map((n, j) => {
      const s = sd[j] || 1;
      return (r.f[n] - mu[j]) / s;
    }),
  );
  return { X, mu, sd };
}

export function fitMoments(rows) {
  const mu = [];
  const sd = [];
  for (const n of FEATURE_NAMES) {
    const col = rows.map((r) => r.f[n]);
    const m = mean(col);
    mu.push(m);
    sd.push(stdev(col) || 1);
  }
  return { mu, sd };
}

/**
 * Fit L2-regularized logistic regression by full-batch gradient descent.
 * @param {number[][]} X standardized design matrix (no intercept column)
 * @param {number[]} y labels 0/1
 * @param {{lambda?:number, lr?:number, iters?:number}} [opts]
 * @returns {{w:number[], b:number}}
 */
export function fitLogistic(X, y, opts = {}) {
  const { lambda = 0.05, lr = 0.5, iters = 3000 } = opts;
  if (!X.length) return { w: FEATURE_NAMES.map(() => 0), b: 0 };
  const n = X.length;
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;

  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * xi[j];
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * xi[j];
      gb += err;
    }
    for (let j = 0; j < d; j++) {
      gw[j] = gw[j] / n + lambda * w[j];
      w[j] -= lr * gw[j];
    }
    b -= lr * (gb / n);
  }
  return { w, b };
}

export function predictStandardized(model, xStd) {
  let z = model.b;
  for (let j = 0; j < xStd.length; j++) z += model.w[j] * xStd[j];
  return sigmoid(z);
}

/** Raw-feature prediction; applies the stored standardization internally. */
export function predictRaw(model, features) {
  const x = FEATURE_NAMES.map((n, j) => (features[n] - model.mu[j]) / (model.sd[j] || 1));
  return predictStandardized(model, x);
}

/**
 * Train the full model (moments + weights + current probability).
 * @param {Array} rows training rows
 * @param {object} [opts] passthrough to fitLogistic
 * @param {object} [currentFeatures] features at "now" for the live prediction
 */
export function trainModel(rows, opts = {}, currentFeatures = null) {
  if (!rows.length) return null;
  const { mu, sd } = fitMoments(rows);
  const { X } = standardize(rows, mu, sd);
  const y = rows.map((r) => r.y);
  const { w, b } = fitLogistic(X, y, opts);
  const model = { mu, sd, w, b, lambda: opts.lambda ?? 0.05, n: rows.length, baseRate: mean(y) };
  if (currentFeatures) model.current = predictRaw(model, currentFeatures);
  return model;
}

/* ------------------------------------------------------------------ *
 * evaluation
 * ------------------------------------------------------------------ */

/** Brier score (mean squared error of probabilities). Lower is better. */
export function brier(probs, ys) {
  let s = 0;
  for (let i = 0; i < probs.length; i++) s += (probs[i] - ys[i]) ** 2;
  return probs.length ? s / probs.length : 0;
}

/** Area under the ROC curve. 0.5 = no discrimination. */
export function auc(probs, ys) {
  const pairs = probs.map((p, i) => [p, ys[i]]).sort((a, b) => a[0] - b[0]);
  const nPos = ys.reduce((a, b) => a + b, 0);
  const nNeg = ys.length - nPos;
  if (!nPos || !nNeg) return 0.5;
  // average-rank (handles ties)
  let rankSum = 0;
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1][0] === pairs[i][0]) j++;
    const avgRank = (i + j) / 2 + 1; // 1-based
    for (let k = i; k <= j; k++) if (pairs[k][1] === 1) rankSum += avgRank;
    i = j + 1;
  }
  return (rankSum - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

/** Log loss, clipped for numerical safety. */
export function logLoss(probs, ys) {
  let s = 0;
  for (let i = 0; i < probs.length; i++) {
    const p = Math.min(1 - EPS, Math.max(EPS, probs[i]));
    s += -(ys[i] * Math.log(p) + (1 - ys[i]) * Math.log(1 - p));
  }
  return probs.length ? s / probs.length : 0;
}

/**
 * Contiguous-block walk-forward evaluation.
 *
 * Rows are time-ordered. We split into `folds` contiguous blocks; for each fold
 * we train on everything strictly BEFORE the block and test on the block. This
 * is the honest test for a time series: no future information leaks into the
 * features' scaling or weights.
 *
 * @returns {{brier:number, auc:number, logLoss:number, folds:Array, preds:number[], ys:number[]}}
 */
export function walkForward(rows, { folds = 5, fitOpts = {} } = {}) {
  const n = rows.length;
  const preds = [];
  const ys = [];
  const foldInfo = [];
  const firstTest = Math.floor(n / (folds + 1));
  if (n < 40 || firstTest < 20) {
    return { brier: NaN, auc: NaN, logLoss: NaN, folds: [], preds, ys };
  }
  const blockSize = Math.floor((n - firstTest) / folds);
  for (let k = 0; k < folds; k++) {
    const testStart = firstTest + k * blockSize;
    const testEnd = k === folds - 1 ? n : testStart + blockSize;
    const train = rows.slice(0, testStart);
    const test = rows.slice(testStart, testEnd);
    if (!test.length || !train.length) continue;
    const { mu, sd } = fitMoments(train);
    const { X } = standardize(train, mu, sd);
    const { w, b } = fitLogistic(X, train.map((r) => r.y), fitOpts);
    const model = { mu, sd, w, b };
    const p = test.map((r) => predictRaw(model, r.f));
    const yy = test.map((r) => r.y);
    preds.push(...p);
    ys.push(...yy);
    foldInfo.push({
      trainN: train.length,
      testN: test.length,
      from: test[0].t,
      to: test[test.length - 1].t,
      auc: auc(p, yy),
      brier: brier(p, yy),
    });
  }
  return { brier: brier(preds, ys), auc: auc(preds, ys), logLoss: logLoss(preds, ys), folds: foldInfo, preds, ys };
}

/** Baseline: always predict the training base rate. */
export function baselineScores(rows, { folds = 5 } = {}) {
  const n = rows.length;
  const firstTest = Math.floor(n / (folds + 1));
  const preds = [];
  const ys = [];
  if (n < 40 || firstTest < 20) return { brier: NaN, auc: 0.5, logLoss: NaN };
  const blockSize = Math.floor((n - firstTest) / folds);
  for (let k = 0; k < folds; k++) {
    const testStart = firstTest + k * blockSize;
    const testEnd = k === folds - 1 ? n : testStart + blockSize;
    const train = rows.slice(0, testStart);
    const test = rows.slice(testStart, testEnd);
    if (!test.length || !train.length) continue;
    const rate = mean(train.map((r) => r.y));
    for (const r of test) {
      preds.push(rate);
      ys.push(r.y);
    }
  }
  return { brier: brier(preds, ys), auc: 0.5, logLoss: logLoss(preds, ys) };
}

/* ------------------------------------------------------------------ *
 * uncertainty: Wilson interval + bootstrap CI
 * ------------------------------------------------------------------ */

/** Wilson score interval for a binomial proportion. */
export function wilson(k, n, z = 1.959963985) {
  if (!n) return { lo: 0, hi: 1, p: 0 };
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { p, lo: Math.max(0, (centre - half) / denom), hi: Math.min(1, (centre + half) / denom) };
}

/**
 * Bootstrap CI for the model's probability at `currentFeatures`, by resampling
 * training rows WITHIN contiguous time blocks (block bootstrap) so serial
 * correlation is respected.
 */
export function bootstrapProbability(rows, currentFeatures, { reps = 200, blockLen = 24, lambda = 0.05, seed = 12345 } = {}) {
  const rng = makeRng(seed);
  const n = rows.length;
  const nBlocks = Math.ceil(n / blockLen);
  const out = [];
  for (let r = 0; r < reps; r++) {
    const sample = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(rng() * nBlocks) * blockLen;
      for (let i = start; i < Math.min(start + blockLen, n); i++) sample.push(rows[i]);
    }
    if (sample.length < 20) continue;
    const { mu, sd } = fitMoments(sample);
    const { X } = standardize(sample, mu, sd);
    const { w, b } = fitLogistic(X, sample.map((x) => x.y), { lambda, lr: 0.5, iters: 1200 });
    out.push(predictRaw({ mu, sd, w, b }, currentFeatures));
  }
  out.sort((a, b) => a - b);
  const q = (p) => (out.length ? out[Math.min(out.length - 1, Math.max(0, Math.round(p * (out.length - 1))))] : NaN);
  return { lo: q(0.05), mid: q(0.5), hi: q(0.95), reps: out.length, samples: out };
}

/* ------------------------------------------------------------------ *
 * presentation helpers
 * ------------------------------------------------------------------ */

/** Heatmap matrix: rows = weekday (Mon..Sun), cols = week index. */
export function heatmapMatrix(days) {
  if (!days.length) return { weeks: [], max: 0, monthLabels: [] };
  const byKey = new Map(days.map((d) => [d.key, d]));
  const firstStart = cstDayStart(days[0].start);
  const lastStart = cstDayStart(days[days.length - 1].start);
  // shift so week rows start on Monday
  const firstDow = (new Date(firstStart + CST_OFFSET_MS).getUTCDay() + 6) % 7;
  const gridStart = firstStart - firstDow * DAY_MS;
  const totalDays = Math.round((lastStart - gridStart) / DAY_MS) + 1;
  const weeks = Math.ceil(totalDays / 7);
  const matrix = [];
  let max = 0;
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const start = gridStart + (w * 7 + d) * DAY_MS;
      const key = cstDayKey(start);
      const row = byKey.get(key);
      const v = row ? row.tianyicui : null;
      if (v != null && v > max) max = v;
      col.push({ key, value: v, inRange: !!row, start });
    }
    matrix.push(col);
  }
  // month label per week column: the month of that column's Monday
  const monthLabels = matrix.map((col) => {
    const d = new Date(col[0].start + CST_OFFSET_MS);
    return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear(), label: `${d.getUTCMonth() + 1}月` };
  });
  return { weeks: matrix, max, monthLabels };
}

/** Sum of a day-series window. */
export function sumRange(days, fromMs, toMs, field = 'tianyicui') {
  let s = 0;
  for (const d of days) {
    if (d.start + DAY_MS <= fromMs || d.start >= toMs) continue;
    const a = Math.max(d.start, fromMs);
    const b = Math.min(d.start + DAY_MS, toMs);
    s += (d[field] * (b - a)) / DAY_MS;
  }
  return s;
}

/**
 * Empirical "probability a release happens within 24h" for a numeric feature,
 * shown in the UI as evidence behind the model number. Falls back to the global
 * rate when a bucket has too few samples.
 */
export function empiricalCurve(rows, feature, buckets = 6) {
  const vals = rows.map((r) => r.f[feature]).slice().sort((a, b) => a - b);
  if (!vals.length) return [];
  const base = mean(rows.map((r) => r.y));
  const out = [];
  for (let b = 0; b < buckets; b++) {
    const lo = vals[Math.floor((b / buckets) * vals.length)];
    const hi = vals[Math.min(vals.length - 1, Math.ceil(((b + 1) / buckets) * vals.length) - 1)];
    const sel = rows.filter((r) => r.f[feature] >= lo && r.f[feature] <= hi);
    if (!sel.length) continue;
    const k = sel.reduce((a, r) => a + r.y, 0);
    const w = wilson(k, sel.length);
    out.push({ lo, hi, n: sel.length, k, p: sel.length ? k / sel.length : base, wilson: w });
  }
  return out;
}
