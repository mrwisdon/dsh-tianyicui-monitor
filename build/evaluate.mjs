/**
 * Offline evaluation of the 24h release-probability model against real data.
 *
 * Reports walk-forward (out-of-sample) metrics for the model and for the
 * constant-base-rate baseline, plus a calibration table, so the plugin can be
 * honest about how much the tianyicui commit signal actually buys.
 *
 *   node build/evaluate.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildTrainingRows, walkForward, baselineScores, trainModel, mean, wilson,
  empiricalCurve, FEATURE_NAMES, bootstrapProbability, auc, brier, logLoss,
  buildDailySeries, rollingFn, rollingAllFn, HOUR_MS, DAY_MS,
} from '../src/analytics.js';

const root = new URL('..', import.meta.url).pathname;
const ds = JSON.parse(readFileSync(root + 'data/dataset.json', 'utf8'));

const commitTimes = ds.tianyicuiCommits;
const allTimes = ds.allCommits;
const releaseTimes = ds.releases.map((r) => r.time);

console.log('=== dataset ===');
console.log('tianyicui commits:', commitTimes.length, '| team:', allTimes.length, '| releases:', releaseTimes.length);
const first = Math.min(...commitTimes);
const last = Math.max(...commitTimes);
console.log('span:', new Date(first).toISOString().slice(0, 10), '->', new Date(last).toISOString().slice(0, 10));

// Model window: from the first release (before that there is nothing to predict)
const startMs = Math.min(...releaseTimes);
const endMs = Math.max(...commitTimes, ...releaseTimes);
console.log('model window:', new Date(startMs).toISOString().slice(0, 16), '->', new Date(endMs).toISOString().slice(0, 16));

const rows = buildTrainingRows({ commitTimes, allTimes, releaseTimes, startMs, endMs, stepHours: 1 });
console.log('training rows (hourly):', rows.length, '| positive (release within 24h):', rows.reduce((a, r) => a + r.y, 0),
            `(${(100 * mean(rows.map((r) => r.y))).toFixed(1)}%)`);

console.log('\n=== feature summary (raw) ===');
for (const n of FEATURE_NAMES) {
  const col = rows.map((r) => r.f[n]);
  const sorted = [...col].sort((a, b) => a - b);
  const q = (p) => sorted[Math.round(p * (sorted.length - 1))];
  console.log(`  ${n.padEnd(13)} min=${q(0).toFixed(2).padStart(7)} p25=${q(0.25).toFixed(2).padStart(7)} med=${q(0.5).toFixed(2).padStart(7)} p75=${q(0.75).toFixed(2).padStart(7)} max=${q(1).toFixed(2).padStart(7)}`);
}

console.log('\n=== lambda sweep (walk-forward, 5 contiguous folds) ===');
const results = [];
for (const lambda of [0.0, 0.005, 0.02, 0.05, 0.1, 0.3, 1.0]) {
  const wf = walkForward(rows, { folds: 5, fitOpts: { lambda, lr: 0.5, iters: 4000 } });
  results.push({ lambda, ...wf });
  console.log(`  lambda=${String(lambda).padEnd(6)} Brier=${wf.brier.toFixed(4)}  AUC=${wf.auc.toFixed(3)}  LogLoss=${wf.logLoss.toFixed(4)}`);
}
const base = baselineScores(rows, { folds: 5 });
console.log(`  BASELINE (constant rate)  Brier=${base.brier.toFixed(4)}  AUC=0.500  LogLoss=${base.logLoss.toFixed(4)}`);

const best = results.reduce((a, b) => (b.brier < a.brier ? b : a));
console.log(`\nbest lambda by Brier: ${best.lambda}`);
console.log('per-fold (best):');
for (const f of best.folds) {
  console.log(`  test n=${String(f.testN).padStart(4)} ${new Date(f.from).toISOString().slice(0, 10)}..${new Date(f.to).toISOString().slice(0, 10)}  AUC=${f.auc.toFixed(3)} Brier=${f.brier.toFixed(4)}`);
}

// ---- calibration of the walk-forward predictions --------------------------
console.log('\n=== calibration (out-of-sample, 10 equal-count bins) ===');
const pairs = best.preds.map((p, i) => ({ p, y: best.ys[i] })).sort((a, b) => a.p - b.p);
const BINS = 10;
const binSize = Math.floor(pairs.length / BINS);
let ece = 0;
for (let b = 0; b < BINS; b++) {
  const lo = b * binSize;
  const hi = b === BINS - 1 ? pairs.length : lo + binSize;
  const seg = pairs.slice(lo, hi);
  if (!seg.length) continue;
  const pred = mean(seg.map((s) => s.p));
  const obs = mean(seg.map((s) => s.y));
  ece += (seg.length / pairs.length) * Math.abs(pred - obs);
  const bar = '#'.repeat(Math.round(obs * 40));
  console.log(`  pred=${(pred * 100).toFixed(1).padStart(5)}%  obs=${(obs * 100).toFixed(1).padStart(5)}%  n=${String(seg.length).padStart(4)}  ${bar}`);
}
console.log(`  ECE (mean |pred-obs|, count-weighted) = ${(ece * 100).toFixed(2)} pp`);

// ---- how often does the >=90% verdict fire, and is it right? --------------
console.log('\n=== the >=90% verdict ===');
const hi = pairs.filter((p) => p.p >= 0.9);
if (!hi.length) {
  console.log('  never fires out-of-sample');
} else {
  const k = hi.reduce((a, s) => a + s.y, 0);
  const w = wilson(k, hi.length);
  console.log(`  fires on ${hi.length}/${pairs.length} hours (${(100 * hi.length / pairs.length).toFixed(1)}%)`);
  console.log(`  releases did follow in 24h: ${k}/${hi.length} = ${(100 * k / hi.length).toFixed(1)}%  (Wilson 95% CI ${(w.lo * 100).toFixed(1)}%..${(w.hi * 100).toFixed(1)}%)`);
}
const lo = pairs.filter((p) => p.p < 0.2);
if (lo.length) {
  const k = lo.reduce((a, s) => a + s.y, 0);
  console.log(`  p<20% on ${lo.length} hours, release followed ${(100 * k / lo.length).toFixed(1)}% of the time (specificity)`);
}

// ---- empirical evidence curves -------------------------------------------
console.log('\n=== empirical P(release within 24h | tianyicui commits in last 24h) ===');
for (const c of empiricalCurve(rows, 'ty24', 6)) {
  console.log(`  ty24 ${c.lo.toFixed(0).padStart(4)}..${c.hi.toFixed(0).padStart(4)}  n=${String(c.n).padStart(4)}  P=${(c.p * 100).toFixed(1).padStart(5)}%  (Wilson ${(c.wilson.lo * 100).toFixed(0)}..${(c.wilson.hi * 100).toFixed(0)}%)`);
}
console.log('\n=== empirical P(release within 24h | hours since last tianyicui commit) ===');
for (const c of empiricalCurve(rows, 'sinceCommit', 6)) {
  console.log(`  h ${c.lo.toFixed(0).padStart(4)}..${c.hi.toFixed(0).padStart(4)}  n=${String(c.n).padStart(4)}  P=${(c.p * 100).toFixed(1).padStart(5)}%`);
}

// ---- final model on all data + "now" state -------------------------------
const nowMs = endMs;
const lastRelease = Math.max(...releaseTimes.filter((r) => r <= nowMs));
const hoursSince = (nowMs - lastRelease) / HOUR_MS;
console.log('\n=== current state (snapshot end) ===');
console.log('  now (last commit):', new Date(nowMs).toISOString());
console.log('  last release:', new Date(lastRelease).toISOString(), '->', hoursSince.toFixed(1), 'h ago');
const { days } = buildDailySeries(commitTimes, releaseTimes, allTimes);
const nowFeatures = {
  ty24: rollingFn(days, 24)(nowMs),
  all24: rollingAllFn(days, 24)(nowMs),
  sinceCommit: 0,
  sinceRelease: Math.min(hoursSince / 24, 60),
};
console.log('  features:', JSON.stringify(Object.fromEntries(Object.entries(nowFeatures).map(([k, v]) => [k, +v.toFixed(2)]))));

const finalModel = trainModel(rows, { lambda: best.lambda, lr: 0.5, iters: 6000 }, nowFeatures);
console.log('  coefficients (standardized):', finalModel.w.map((w, i) => `${FEATURE_NAMES[i]}=${w.toFixed(3)}`).join(' '), 'b=', finalModel.b.toFixed(3));
console.log('  P(release within 24h) =', (finalModel.current * 100).toFixed(1) + '%');

// ---- sensitivity: which features carry the signal? ------------------------
console.log('\n=== leave-one-feature-out (walk-forward Brier / AUC) ===');
for (let drop = -1; drop < FEATURE_NAMES.length; drop++) {
  const sub = rows.map((r) => {
    const f = { ...r.f };
    if (drop >= 0) delete f[FEATURE_NAMES[drop]];
    return { ...r, f };
  });
  // reuse walkForward but with a restricted feature list
  const wf = walkForwardSubset(sub, drop >= 0 ? FEATURE_NAMES.filter((_, i) => i !== drop) : FEATURE_NAMES, { folds: 5, fitOpts: { lambda: best.lambda, lr: 0.5, iters: 4000 } });
  const label = drop < 0 ? 'all features' : `without ${FEATURE_NAMES[drop]}`;
  console.log(`  ${label.padEnd(22)} Brier=${wf.brier.toFixed(4)}  AUC=${wf.auc.toFixed(3)}`);
}

function walkForwardSubset(rowsIn, names, { folds = 5, fitOpts = {} } = {}) {
  const n = rowsIn.length;
  const firstTest = Math.floor(n / (folds + 1));
  const blockSize = Math.floor((n - firstTest) / folds);
  const preds = [], ys = [];
  for (let k = 0; k < folds; k++) {
    const testStart = firstTest + k * blockSize;
    const testEnd = k === folds - 1 ? n : testStart + blockSize;
    const train = rowsIn.slice(0, testStart), test = rowsIn.slice(testStart, testEnd);
    if (!test.length || !train.length) continue;
    const mu = names.map((nm) => mean(train.map((r) => r.f[nm])));
    const sd = names.map((nm, j) => {
      const c = train.map((r) => r.f[nm]);
      const m = mean(c);
      return Math.sqrt(mean(c.map((x) => (x - m) ** 2))) || 1;
    });
    const X = train.map((r) => names.map((nm, j) => (r.f[nm] - mu[j]) / sd[j]));
    const { w, b } = fitLogisticLocal(X, train.map((r) => r.y), fitOpts);
    for (const r of test) {
      const x = names.map((nm, j) => (r.f[nm] - mu[j]) / sd[j]);
      let z = b;
      for (let j = 0; j < x.length; j++) z += w[j] * x[j];
      preds.push(1 / (1 + Math.exp(-z)));
      ys.push(r.y);
    }
  }
  return { brier: brier(preds, ys), auc: auc(preds, ys) };
}

function fitLogisticLocal(X, y, { lambda = 0.05, lr = 0.5, iters = 4000 } = {}) {
  const d = X[0].length;
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < X.length; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * X[i][j];
      const e = 1 / (1 + Math.exp(-z)) - y[i];
      for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
      gb += e;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / X.length + lambda * w[j]);
    b -= lr * (gb / X.length);
  }
  return { w, b };
}

// ---- persist the fitted model for the plugin ------------------------------
const artifact = {
  fittedAt: Date.now(),
  modelWindow: { startMs, endMs },
  lambda: best.lambda,
  metrics: {
    rows: rows.length,
    positives: rows.reduce((a, r) => a + r.y, 0),
    baseRate: mean(rows.map((r) => r.y)),
    modelBrier: best.brier,
    modelAuc: best.auc,
    modelLogLoss: best.logLoss,
    baselineBrier: base.brier,
    baselineLogLoss: base.logLoss,
    ece,
    verdictFires: hi.length,
    verdictHits: hi.length ? hi.reduce((a, s) => a + s.y, 0) : 0,
  },
  coefficients: { mu: finalModel.mu, sd: finalModel.sd, w: finalModel.w, b: finalModel.b },
  currentState: { nowMs, hoursSinceRelease: hoursSince, features: nowFeatures, probability: finalModel.current },
};
writeFileSync(root + 'data/model.json', JSON.stringify(artifact, null, 2));
console.log('\nwrote data/model.json');
