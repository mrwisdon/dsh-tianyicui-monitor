/**
 * Model v2 evaluation with hazard + calendar + velocity features.
 *
 * Everything is causal: `orig(t)` returns features computed from data at or
 * before `t` only. Validation is contiguous-block walk-forward, which respects
 * the strong serial correlation in release timing.
 *
 *   node build/evaluate2.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  HOUR_MS, DAY_MS, CST_OFFSET_MS, mean, stdev, auc, brier, logLoss, wilson,
  makeRng, cstDayStart, cstDayKey,
} from '../src/analytics.js';

const root = new URL('..', import.meta.url).pathname;
const ds = JSON.parse(readFileSync(root + 'data/dataset.json', 'utf8'));
const ty = ds.tianyicuiCommits.slice().sort((a, b) => a - b);
const all = ds.allCommits.slice().sort((a, b) => a - b);
const rel = ds.releases.map((r) => r.time).sort((a, b) => a - b);

/* ---------- daily buckets (available from a calendar aggregate) ---------- */
const dayStart0 = cstDayStart(Math.min(...all));
const dayEnd = cstDayStart(Math.max(...all));
const dayList = [];
for (let t = dayStart0; t <= dayEnd; t += DAY_MS) dayList.push(t);
const tyDay = dayList.map((s) => countRange(ty, s, s + DAY_MS));
const allDay = dayList.map((s) => countRange(all, s, s + DAY_MS));

function countRange(arr, from, to) {
  // arr sorted
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= from) lo = m + 1; else hi = m; }
  let n = 0;
  for (let i = lo; i < arr.length && arr[i] < to; i++) n++;
  return n;
}
function trailing(arr, dayIdx, days) {
  let s = 0;
  for (let i = Math.max(0, dayIdx - days + 1); i <= dayIdx; i++) s += arr[i];
  return s;
}

/* ---------- causal feature computation ---------- */
const BIN11_15 = 12 * HOUR_MS;   // 11:00..15:00 CST peak band
function featuresAt(t) {
  const d = new Date(t + CST_OFFSET_MS);
  const dow = d.getUTCDay();
  const hour = d.getUTCHours();
  const idx = Math.floor((cstDayStart(t) - dayStart0) / DAY_MS);

  let last = -Infinity;
  for (let i = rel.length - 1; i >= 0; i--) if (rel[i] <= t) { last = rel[i]; break; }
  const sinceRelease = last === -Infinity ? 999 : (t - last) / HOUR_MS;

  // tianyicui "thought about it today" indicator (zero time-of-day risk)
  const tyToday = idx >= 0 && idx < tyDay.length ? tyDay[idx] : 0;
  // 3-day release rhythm
  let rel3 = 0;
  for (const r of rel) if (r <= t && r > t - 3 * DAY_MS) rel3++;
  let rel7 = 0;
  for (const r of rel) if (r <= t && r > t - 7 * DAY_MS) rel7++;

  // hour-of-day is a release-time predictor; use distance to the 13:00 CST peak
  const hourDist = Math.min(Math.abs(hour - 13), 24 - Math.abs(hour - 13)) / 12;

  return {
    sinceRelease: Math.min(sinceRelease, 200) / 24,   // in days
    rel3,
    rel7,
    ty12: idx >= 0 && idx < tyDay.length ? trailing(tyDay, idx, 1) : 0,   // today so far
    tyDayLag1: trailing(tyDay, idx - 1, 1),
    all12: idx >= 0 && idx < allDay.length ? trailing(allDay, idx, 1) : 0,
    allDayLag1: trailing(allDay, idx - 1, 1),
    isMon: dow === 1 ? 1 : 0,
    isTueWedThu: dow >= 2 && dow <= 4 ? 1 : 0,
    isFri: dow === 5 ? 1 : 0,
    isWeekend: dow === 0 || dow === 6 ? 1 : 0,
    hourDist,
    peak: hour >= 11 && hour < 16 ? 1 : 0,
  };
}
const NAMES = Object.keys(featuresAt(rel[0] + 3600e3));
const orig = NAMES.map((n) => (t) => featuresAt(t)[n]);

/* ---------- rows ---------- */
const startMs = rel[0] + 24 * HOUR_MS;   // need one day of history for features
const endMs = Math.max(...ty, ...rel);
const rows = [];
for (let t = startMs; t <= endMs; t += HOUR_MS) {
  const f = featuresAt(t);
  rows.push({ t, y: rel.some((r) => r > t && r <= t + 24 * HOUR_MS) ? 1 : 0, f: NAMES.map((n) => f[n]) });
}
const yAll = rows.map((r) => r.y);
console.log(`rows=${rows.length}  base rate=${(100 * mean(yAll)).toFixed(1)}%`);

/* ---------- small logistic helpers ---------- */
const sig = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

function fit(X, y, { lambda = 0.1, lr = 0.5, iters = 4000, w0 = null } = {}) {
  const d = X[0].length;
  const w = w0 ? w0.slice() : new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const e = sig(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / X.length + lambda * w[j]);
    b -= lr * (gb / X.length);
  }
  return { w, b };
}
function moments(rowsIn, cols) {
  const mu = cols.map((j) => mean(rowsIn.map((r) => r.f[j])));
  const sd = cols.map((j) => stdev(rowsIn.map((r) => r.f[j])) || 1);
  return { mu, sd };
}
function design(rowsIn, cols, mu, sd) {
  return rowsIn.map((r) => cols.map((j, k) => (r.f[j] - mu[k]) / sd[k]));
}
function probs(X, m) {
  return X.map((x) => {
    let z = m.b;
    for (let j = 0; j < x.length; j++) z += m.w[j] * x[j];
    return sig(z);
  });
}

/** walk-forward with feature pre-origination (for time-derived features) */
function walkForward({ cols = null, folds = 5, lambda = 0.1, fitOpts = {} } = {}) {
  const useCols = cols ?? NAMES.map((_, i) => i);
  const n = rows.length;
  const firstTest = Math.floor(n / (folds + 1));
  const blockSize = Math.floor((n - firstTest) / folds);
  const preds = [], ys = [], foldInfo = [];
  for (let k = 0; k < folds; k++) {
    const testStart = firstTest + k * blockSize;
    const testEnd = k === folds - 1 ? n : testStart + blockSize;
    const train = rows.slice(0, testStart), test = rows.slice(testStart, testEnd);
    const { mu, sd } = moments(train, useCols);
    const m = fit(design(train, useCols, mu, sd), train.map((r) => r.y), { lambda, ...fitOpts });
    const p = probs(design(test, useCols, mu, sd), m);
    preds.push(...p); ys.push(...test.map((r) => r.y));
    foldInfo.push({ from: test[0].t, to: test[test.length - 1].t, n: test.length, auc: auc(p, test.map((r) => r.y)), brier: brier(p, test.map((r) => r.y)) });
  }
  return { brier: brier(preds, ys), auc: auc(preds, ys), logLoss: logLoss(preds, ys), preds, ys, folds: foldInfo };
}

/* ---------- univariate discrimination ---------- */
console.log('\n=== univariate AUC (full sample, causal feature) ===');
const uni = [];
for (let j = 0; j < NAMES.length; j++) {
  const col = rows.map((r) => r.f[j]);
  const a = auc(col, yAll);
  uni.push({ name: NAMES[j], auc: a });
}
uni.sort((a, b) => Math.abs(b.auc - 0.5) - Math.abs(a.auc - 0.5));
for (const u of uni) console.log(`  ${u.name.padEnd(14)} AUC=${u.auc.toFixed(3)}`);

/* ---------- lambda sweep on the full feature set ---------- */
console.log('\n=== lambda sweep, all features (walk-forward) ===');
const sweep = [];
for (const lambda of [0.01, 0.03, 0.1, 0.3, 1.0, 3.0]) {
  const wf = walkForward({ lambda });
  sweep.push({ lambda, ...wf });
  console.log(`  lambda=${String(lambda).padEnd(5)} Brier=${wf.brier.toFixed(4)} AUC=${wf.auc.toFixed(3)} LL=${wf.logLoss.toFixed(4)}`);
}
const best = sweep.reduce((a, b) => (b.brier < a.brier ? b : a));
console.log(`best lambda = ${best.lambda}`);

/* ---------- feature-subset search (greedy forward selection) ---------- */
console.log('\n=== greedy forward selection (walk-forward Brier) ===');
let chosen = [];
let bestScore = Infinity;
let improved = true;
while (improved && chosen.length < 8) {
  improved = false;
  let candBest = null;
  for (let j = 0; j < NAMES.length; j++) {
    if (chosen.includes(j)) continue;
    const cols = [...chosen, j];
    const wf = walkForward({ cols, lambda: best.lambda });
    if (wf.brier < bestScore - 1e-5) {
      bestScore = wf.brier;
      candBest = { j, wf };
    }
  }
  if (candBest) {
    chosen.push(candBest.j);
    improved = true;
    console.log(`  + ${NAMES[candBest.j].padEnd(14)} Brier=${candBest.wf.brier.toFixed(4)} AUC=${candBest.wf.auc.toFixed(3)}`);
  }
}
console.log('chosen:', chosen.map((j) => NAMES[j]).join(', '));

/* ---------- baseline ---------- */
const nBase = rows.length;
const firstTest = Math.floor(nBase / 6);
const blockSize = Math.floor((nBase - firstTest) / 5);
const bp = [], by = [];
for (let k = 0; k < 5; k++) {
  const ts = firstTest + k * blockSize, te = k === 4 ? nBase : ts + blockSize;
  const rate = mean(rows.slice(0, ts).map((r) => r.y));
  for (const r of rows.slice(ts, te)) { bp.push(rate); by.push(r.y); }
}
console.log(`\nBASELINE constant-rate: Brier=${brier(bp, by).toFixed(4)} AUC=0.500 LL=${logLoss(bp, by).toFixed(4)}`);

/* ---------- final model on selected features ---------- */
const selCols = chosen.length ? chosen : NAMES.map((_, i) => i);
const { mu, sd } = moments(rows, selCols);
const finalFit = fit(design(rows, selCols, mu, sd), yAll, { lambda: best.lambda, iters: 8000 });
console.log('\n=== final coefficients (standardized space) ===');
selCols.forEach((j, k) => console.log(`  ${NAMES[j].padEnd(14)} w=${finalFit.w[k].toFixed(4)}`));
console.log(`  intercept b=${finalFit.b.toFixed(4)}`);

/* ---------- calibration ---------- */
const wfBest = walkForward({ cols: selCols, lambda: best.lambda });
console.log(`\nselected-subset walk-forward: Brier=${wfBest.brier.toFixed(4)} AUC=${wfBest.auc.toFixed(3)} LL=${wfBest.logLoss.toFixed(4)}`);
wfBest.folds.forEach((f) => console.log(`  fold ${new Date(f.from).toISOString().slice(0, 10)}..${new Date(f.to).toISOString().slice(0, 10)} n=${f.n} AUC=${f.auc.toFixed(3)}`));

console.log('\n=== calibration (out-of-sample) ===');
const pairs = wfBest.preds.map((p, i) => ({ p, y: wfBest.ys[i] })).sort((a, b) => a.p - b.p);
const BINS = 10, bs = Math.floor(pairs.length / BINS);
let ece = 0;
for (let b = 0; b < BINS; b++) {
  const lo = b * bs, hi = b === BINS - 1 ? pairs.length : lo + bs;
  const seg = pairs.slice(lo, hi);
  if (!seg.length) continue;
  const pred = mean(seg.map((s) => s.p)), obs = mean(seg.map((s) => s.y));
  ece += (seg.length / pairs.length) * Math.abs(pred - obs);
  console.log(`  pred=${(pred * 100).toFixed(1).padStart(5)}%  obs=${(obs * 100).toFixed(1).padStart(5)}%  n=${String(seg.length).padStart(4)} ${'#'.repeat(Math.round(obs * 40))}`);
}
console.log(`  ECE=${(ece * 100).toFixed(2)} pp`);

console.log('\n=== threshold behaviour (out-of-sample) ===');
for (const th of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const sel = pairs.filter((p) => p.p >= th);
  if (!sel.length) { console.log(`  p>=${(th * 100).toFixed(0)}%: never fires`); continue; }
  const k = sel.reduce((a, s) => a + s.y, 0);
  const w = wilson(k, sel.length);
  console.log(`  p>=${(th * 100).toFixed(0)}%: fires ${String(sel.length).padStart(4)}/${pairs.length} hours (${(100 * sel.length / pairs.length).toFixed(1)}%), hit rate ${(100 * k / sel.length).toFixed(1)}% [${(w.lo * 100).toFixed(1)}..${(w.hi * 100).toFixed(1)}]`);
}

/* ---------- persist ---------- */
writeFileSync(root + 'data/model2.json', JSON.stringify({
  fittedAt: Date.now(),
  featureNames: selCols.map((j) => NAMES[j]),
  coefficients: {
    mu: selCols.map((j) => mu[selCols.indexOf(j)] ?? moments(rows, selCols).mu[selCols.indexOf(j)]),
    sd: selCols.map((j) => sd[selCols.indexOf(j)] ?? moments(rows, selCols).sd[selCols.indexOf(j)]),
    w: finalFit.w, b: finalFit.b,
  },
  standardization: moments(rows, selCols),
  allFeatureNames: NAMES,
  metrics: {
    rows: rows.length, baseRate: mean(yAll),
    modelBrier: wfBest.brier, modelAuc: wfBest.auc, modelLogLoss: wfBest.logLoss,
    baselineBrier: brier(bp, by), baselineLogLoss: logLoss(bp, by), ece,
  },
  univariate: uni,
  lambda: best.lambda,
}, null, 2), );
console.log('\nwrote data/model2.json');
