/**
 * Probability model runtime.
 *
 * Reimplements EXACTLY the fitting procedure in `build/fit_model.mjs` so that a
 * model trained offline can be re-evaluated in the browser against live data
 * without shipping a training loop:
 *
 *   1. base hazard per "hours since last release" bucket
 *   2. x weekday relative risk, combined on the odds scale
 *   3. optional log-odds velocity term on yesterday's commit count
 *   4. isotonic (PAV) post-calibration to fix the model's own miscalibration
 *
 * The artifact's own `coefficients` are used whenever present; the fitted tables
 * are only recomputed when live data has moved far enough to justify it.
 */
import { HOUR_MS, DAY_MS, CST_OFFSET_MS, mean } from './analytics.js';

export const HORIZON_HOURS = 72;
export const LIKELY_THRESHOLD = 0.9;

/** default age bucket edges, matching the training grid */
export const AGE_EDGES = [0, 6, 12, 18, 24, 30, 36, 42, 48, 60, 72, 96, 120, 168, Infinity];

export function ageBucket(ageHours, edges = AGE_EDGES) {
  for (let i = 0; i < edges.length - 1; i++) {
    if (ageHours >= edges[i] && ageHours < edges[i + 1]) return i;
  }
  return edges.length - 2;
}

export function lastAtOrBefore(sortedTimes, t) {
  let lo = 0;
  let hi = sortedTimes.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid] <= t) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best < 0 ? null : sortedTimes[best];
}

export function cstDow(ms) {
  return new Date(ms + CST_OFFSET_MS).getUTCDay();
}

const clamp = (p, lo = 0.005, hi = 0.995) => Math.max(lo, Math.min(hi, p));

/** Combine base hazard and weekday risk on the odds scale. */
export function combineHazardWeekday(hazardCell, weekdayRR) {
  const cell = clamp(hazardCell, 0.005, 0.995);
  const odds = (cell / (1 - cell)) * (weekdayRR || 1);
  return clamp(odds / (1 + odds));
}

/** Apply the isotonic calibration curve. */
export function applyIsotonic(iso, p) {
  if (!iso || !iso.xs || !iso.xs.length) return p;
  const { xs, ys } = iso;
  if (p <= xs[0]) return ys[0];
  if (p >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= p) lo = m + 1; else hi = m;
  }
  const x0 = xs[lo - 1];
  const x1 = xs[lo];
  const y0 = ys[lo - 1];
  const y1 = ys[lo];
  const t = x1 === x0 ? 0 : (p - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}

/**
 * Recompute the model's fitted tables from daily aggregates.
 *
 * This mirrors fitAt(): Laplace-smoothed hazard per age bucket, weekday odds
 * ratio, and a logistic velocity coefficient on yesterday's commit count.
 *
 * @param {object} input
 * @param {Record<string,number>} input.tianyicuiDaily day key -> count
 * @param {number[]} input.releaseTimes epoch ms, ascending
 * @param {number} input.startMs  earliest instant to consider
 * @param {number} input.endMs    last instant to consider (the "now" of the fit)
 * @param {number} [input.prior]  Laplace prior strength
 * @param {number[]} [input.ageEdges]
 */
export function refitFromDaily(input) {
  const {
    tianyicuiDaily,
    releaseTimes,
    startMs,
    endMs,
    prior = 25,
    ageEdges = AGE_EDGES,
    horizon = HORIZON_HOURS,
  } = input;

  const rel = [...releaseTimes].sort((a, b) => a - b);
  const keys = Object.keys(tianyicuiDaily).sort();
  const dailyCount = (dayKey) => tianyicuiDaily[dayKey] || 0;
  const dayOf = (ms) => new Date(ms + CST_OFFSET_MS).toISOString().slice(0, 10);

  // build hourly observations exactly like training
  const hist = [];
  for (let t = startMs; t < endMs; t += HOUR_MS) {
    const last = lastAtOrBefore(rel, t);
    const age = last == null ? 999 : (t - last) / HOUR_MS;
    const hit = rel.some((r) => r > t && r <= t + horizon * HOUR_MS) ? 1 : 0;
    hist.push({ t, age, dow: cstDow(t), hit, tyLag1: dailyCount(dayOf(t - DAY_MS)) });
  }
  if (!hist.length) return null;

  const pConst = mean(hist.map((h) => h.hit));
  const nB = ageEdges.length - 1;
  const bN = new Array(nB).fill(0);
  const bK = new Array(nB).fill(0);
  for (const h of hist) {
    const b = ageBucket(h.age, ageEdges);
    bN[b]++;
    bK[b] += h.hit;
  }
  const hazard = bN.map((n, i) => (bK[i] + prior * pConst) / (n + prior));

  const dN = new Array(7).fill(0);
  const dK = new Array(7).fill(0);
  for (const h of hist) {
    dN[h.dow]++;
    dK[h.dow] += h.hit;
  }
  const baseOdds = pConst / Math.max(1e-9, 1 - pConst);
  const dowRR = dN.map((n, i) => {
    const cell = (dK[i] + prior * pConst) / (n + prior);
    return clamp((cell / Math.max(1e-9, 1 - cell)) / baseOdds, 0.1, 8);
  });

  const muTy = mean(hist.map((h) => h.tyLag1));
  const sdTy = Math.sqrt(mean(hist.map((h) => (h.tyLag1 - muTy) ** 2))) || 1;
  let beta = 0;
  for (let it = 0; it < 3000; it++) {
    let g = 0;
    for (const h of hist) {
      const pc = combineHazardWeekday(hazard[ageBucket(h.age, ageEdges)], dowRR[h.dow]);
      const x = (h.tyLag1 - muTy) / sdTy;
      const p = 1 / (1 + Math.exp(-(Math.log(pc / (1 - pc)) + beta * x)));
      g += (p - h.hit) * x;
    }
    beta -= 0.4 * (g / hist.length + 0.05 * beta);
  }

  return { pConst, hazard, dowRR, muTy, sdTy, beta, ageEdges, horizon, observations: hist.length };
}

/**
 * Predict with a freshly fitted model.
 * @returns {{raw:number, calibrated:number, age:number, dow:number, parts:object}}
 */
export function predictWith(model, iso, atMs, releaseTimes, tianyicuiDaily, opts = {}) {
  const rel = [...releaseTimes].sort((a, b) => a - b);
  const last = lastAtOrBefore(rel, atMs);
  const age = last == null ? 999 : (atMs - last) / HOUR_MS;
  const dow = cstDow(atMs);
  const dayOf = (ms) => new Date(ms + CST_OFFSET_MS).toISOString().slice(0, 10);
  const tyLag1 = tianyicuiDaily ? (tianyicuiDaily[dayOf(atMs - DAY_MS)] || 0) : 0;

  const edges = model.ageEdges || AGE_EDGES;
  const bucket = ageBucket(age, edges);
  const base = model.hazard[bucket] ?? model.pConst;
  const rr = model.dowRR[dow] ?? 1;
  let raw = combineHazardWeekday(base, rr);
  if (opts.useVelocity !== false && model.sdTy) {
    const x = (tyLag1 - model.muTy) / model.sdTy;
    raw = clamp(1 / (1 + Math.exp(-(Math.log(raw / (1 - raw)) + model.beta * x))));
  }
  return {
    raw,
    calibrated: applyIsotonic(iso, raw),
    age,
    dow,
    tyLag1,
    parts: { bucket, base, weekdayRR: rr, ageRange: [edges[bucket], edges[bucket + 1]] },
  };
}

/** Verdict banding used by the panel. */
export function classify(probability) {
  if (probability == null || Number.isNaN(probability)) {
    return { level: 'unknown', label: '暂无数据', tone: 'neutral' };
  }
  if (probability >= LIKELY_THRESHOLD) return { level: 'release-likely', label: '很可能发布', tone: 'success' };
  if (probability >= 0.8) return { level: 'watch', label: '接近阈值', tone: 'warn' };
  return { level: 'quiet', label: '平静期', tone: 'idle' };
}
