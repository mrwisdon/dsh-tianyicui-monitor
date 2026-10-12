/**
 * Model v3: rolling-origin (expanding-window) backtest.
 *
 * Why this protocol: the release process is a renewal process with a bimodal
 * inter-release gap, and serial correlation is extreme. Five fixed folds waste
 * data and swing wildly; rolling-origin refits every 6h on everything up to that
 * point and predicts the next 24h, which is both honest and data-efficient.
 *
 * We compare, on identical out-of-sample instants:
 *   A. constant base rate            (the "you can't beat the average" test)
 *   B. empirical hazard              (bucketed P(release within 24h | age bucket))
 *   C. hazard x weekday              (same, rescaled by weekday relative risk)
 *   D. hazard x weekday + commit velocity (daily-resolution velocity)
 *
 *   node build/evaluate3.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { HOUR_MS, DAY_MS, CST_OFFSET_MS, mean, auc, brier, logLoss, wilson, cstDayStart } from '../src/analytics.js';

const root = new URL('..', import.meta.url).pathname;
const ds = JSON.parse(readFileSync(root + 'data/dataset.json', 'utf8'));
const ty = ds.tianyicuiCommits.slice().sort((a, b) => a - b);
const all = ds.allCommits.slice().sort((a, b) => a - b);
const rel = ds.releases.map((r) => r.time).sort((a, b) => a - b);

const startMs = rel[0];
const endMs = Math.max(...ty, ...rel);
const H = 24;                                  // prediction horizon, hours
const REFIT_EVERY = 6 * HOUR_MS;               // rolling-origin cadence
const MIN_TRAIN = 14 * DAY_MS;                 // first prediction leaves 14d of history

/* ---------------- helpers ---------------- */
function countRange(arr, from, to) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= from) lo = m + 1; else hi = m; }
  let n = 0;
  for (let i = lo; i < arr.length && arr[i] < to; i++) n++;
  return n;
}
function lastReleaseAt(t) {
  let lo = 0, hi = rel.length - 1, best = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (rel[m] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best < 0 ? null : rel[best];
}
function hit(t) { return rel.some((r) => r > t && r <= t + H * HOUR_MS) ? 1 : 0; }
const dowOf = (t) => new Date(t + CST_OFFSET_MS).getUTCDay();

// daily commit buckets for velocity at daily resolution
const day0 = cstDayStart(Math.min(...all));
const dayIdxOf = (t) => Math.floor((cstDayStart(t) - day0) / DAY_MS);
const nDays = dayIdxOf(endMs) + 2;
const tyDay = new Array(nDays).fill(0), allDay = new Array(nDays).fill(0);
for (const t of ty) tyDay[dayIdxOf(t)]++;
for (const t of all) allDay[dayIdxOf(t)]++;
const trailingDay = (arr, i, k) => { let s = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) s += arr[j]; return s; };

/* ---------------- feature snapshot at t (causal) ---------------- */
function snap(t) {
  const last = lastReleaseAt(t);
  const age = last == null ? 999 : (t - last) / HOUR_MS;
  const i = dayIdxOf(t);
  return {
    t, hit: hit(t), age, dow: dowOf(t),
    tyToday: i >= 0 && i < nDays ? tyDay[i] : 0,
    tyLag1: trailingDay(tyDay, i - 1, 1),
    allToday: i >= 0 && i < nDays ? allDay[i] : 0,
    allLag1: trailingDay(allDay, i - 1, 1),
    allLast3: trailingDay(allDay, i, 3),
  };
}

/* ---------------- A. constant base rate ---------------- */
/* ---------------- B. empirical hazard by age bucket ---------------- */
const AGE_EDGES = [0, 6, 12, 18, 24, 36, 48, 60, 72, 96, 120, 200, Infinity];
function ageBucket(age) {
  for (let i = 0; i < AGE_EDGES.length - 1; i++) if (age >= AGE_EDGES[i] && age < AGE_EDGES[i + 1]) return i;
  return AGE_EDGES.length - 2;
}
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Fit all variants on history strictly before `tCut`, return predictor fns. */
function fitAt(tCut) {
  const hist = [];
  for (let t = startMs; t < tCut; t += HOUR_MS) hist.push(snap(t));

  // A: constant rate
  const pConst = mean(hist.map((h) => h.hit));

  // B: empirical hazard per age bucket (Laplace-smoothed toward pConst)
  const bN = new Array(AGE_EDGES.length - 1).fill(0), bK = new Array(AGE_EDGES.length - 1).fill(0);
  for (const h of hist) { const b = ageBucket(h.age); bN[b]++; bK[b] += h.hit; }
  const prior = 20;
  const haz = bN.map((n, i) => (bK[i] + prior * pConst) / (n + prior));

  // C: weekday relative risk on the odds scale
  const dN = new Array(7).fill(0), dK = new Array(7).fill(0);
  for (const h of hist) { dN[h.dow]++; dK[h.dow] += h.hit; }
  const dowRR = dN.map((n, i) => {
    const cell = (dK[i] + prior * pConst) / (n + prior);
    const oddsCell = cell / Math.max(1e-6, 1 - cell);
    const oddsBase = pConst / Math.max(1e-6, 1 - pConst);
    return Math.max(0.15, Math.min(6, oddsCell / oddsBase));
  });

  // D: velocity coefficient on top of C, fitted by logistic regression
  const muTy = mean(hist.map((h) => h.tyLag1));
  const sdTy = Math.sqrt(mean(hist.map((h) => (h.tyLag1 - muTy) ** 2))) || 1;
  let beta = 0;
  {
    const lr = 0.4;
    for (let it = 0; it < 2500; it++) {
      let g = 0;
      for (const h of hist) {
        const x = (h.tyLag1 - muTy) / sdTy;
        const pHaz = applyC(haz, dowRR, h, pConst);
        const z = Math.log(pHaz / (1 - pHaz)) + beta * x;
        const p = 1 / (1 + Math.exp(-z));
        g += (p - h.hit) * x;
      }
      g = g / hist.length + 0.05 * beta;
      beta -= lr * g;
    }
  }
  return { pConst, haz, dowRR, muTy, sdTy, beta, trainN: hist.length };
}

function applyC(haz, dowRR, h, pConst) {
  const cell = haz[ageBucket(h.age)];
  const cellOdds = cell / Math.max(1e-6, 1 - cell);
  const odds = cellOdds * (dowRR[h.dow] ?? 1);
  const p = odds / (1 + odds);
  return Math.max(0.01, Math.min(0.99, p));
}
function applyD(model, h) {
  const pC = applyC(model.haz, model.dowRR, h, model.pConst);
  const x = (h.tyLag1 - model.muTy) / model.sdTy;
  const z = Math.log(pC / (1 - pC)) + model.beta * x;
  return Math.max(0.01, Math.min(0.99, 1 / (1 + Math.exp(-z))));
}

/* ---------------- rolling-origin backtest ---------------- */
console.log(`rolling-origin: horizon=${H}h refit every ${REFIT_EVERY / HOUR_MS}h`);
const records = [];
let model = null, nextFit = startMs + MIN_TRAIN;
for (let t = startMs + MIN_TRAIN; t <= endMs; t += HOUR_MS) {
  if (t >= nextFit) { model = fitAt(t); nextFit = t + REFIT_EVERY; }
  if (!model) continue;
  const h = snap(t);
  records.push({
    t, y: h.hit, age: h.age, dow: h.dow,
    pA: model.pConst,
    pB: model.haz[ageBucket(h.age)],
    pC: applyC(model.haz, model.dowRR, h, model.pConst),
    pD: applyD(model, h),
  });
}
console.log(`out-of-sample instants: ${records.length}  positives: ${records.reduce((a, r) => a + r.y, 0)} (${(100 * mean(records.map((r) => r.y))).toFixed(1)}%)`);

console.log('\n=== out-of-sample comparison ===');
const variants = [['A constant rate', 'pA'], ['B empirical hazard', 'pB'], ['C hazard x weekday', 'pC'], ['D C + commit velocity', 'pD']];
const ys = records.map((r) => r.y);
for (const [label, key] of variants) {
  const ps = records.map((r) => r[key]);
  console.log(`  ${label.padEnd(24)} Brier=${brier(ps, ys).toFixed(4)}  AUC=${auc(ps, ys).toFixed(3)}  LL=${logLoss(ps, ys).toFixed(4)}`);
}
const pMax = records.map((r) => Math.max(r.pC, r.pD));
console.log(`  ${'C/D oracle (max)'.padEnd(24)} Brier=${brier(pMax, ys).toFixed(4)}  AUC=${auc(pMax, ys).toFixed(3)}`);

/* ---------------- calibration of the best variant ---------------- */
for (const key of ['pC', 'pD']) {
  const pairs = records.map((r) => ({ p: r[key], y: r.y })).sort((a, b) => a.p - b.p);
  const BINS = 10, bs = Math.floor(pairs.length / BINS);
  let ece = 0;
  const lines = [];
  for (let b = 0; b < BINS; b++) {
    const lo = b * bs, hi = b === BINS - 1 ? pairs.length : lo + bs;
    const seg = pairs.slice(lo, hi);
    if (!seg.length) continue;
    const pred = mean(seg.map((s) => s.p)), obs = mean(seg.map((s) => s.y));
    ece += (seg.length / pairs.length) * Math.abs(pred - obs);
    lines.push(`    pred=${(pred * 100).toFixed(1).padStart(5)}%  obs=${(obs * 100).toFixed(1).padStart(5)}%  n=${String(seg.length).padStart(4)} ${'#'.repeat(Math.round(obs * 40))}`);
  }
  console.log(`\n=== calibration of ${key} ===`);
  console.log(lines.join('\n'));
  console.log(`    ECE=${(ece * 100).toFixed(2)} pp`);
}

/* ---------------- threshold behaviour ---------------- */
for (const key of ['pC', 'pD']) {
  console.log(`\n=== threshold behaviour (${key}) ===`);
  for (const th of [0.5, 0.6, 0.7, 0.8, 0.9]) {
    const sel = records.filter((r) => r[key] >= th);
    if (!sel.length) { console.log(`  p>=${(th * 100).toFixed(0)}%: never fires`); continue; }
    const k = sel.reduce((a, r) => a + r.y, 0);
    const w = wilson(k, sel.length);
    console.log(`  p>=${(th * 100).toFixed(0)}%: ${String(sel.length).padStart(4)}/${records.length} hrs (${(100 * sel.length / records.length).toFixed(1)}%) hit ${(100 * k / sel.length).toFixed(1)}% [${(w.lo * 100).toFixed(1)}..${(w.hi * 100).toFixed(1)}]`);
  }
}

/* ---------------- per-weekday observed rate (for the UI evidence table) ---- */
console.log('\n=== observed P(release within 24h) by CST weekday ===');
for (let d = 0; d < 7; d++) {
  const sel = records.filter((r) => r.dow === d);
  if (!sel.length) continue;
  const k = sel.reduce((a, r) => a + r.y, 0);
  const w = wilson(k, sel.length);
  console.log(`  ${DOW_NAMES[d]}  n=${String(sel.length).padStart(4)}  P=${(100 * k / sel.length).toFixed(1).padStart(5)}%  [${(w.lo * 100).toFixed(1)}..${(w.hi * 100).toFixed(1)}]`);
}

/* ---------------- hazard curve for the UI ---------------- */
console.log('\n=== observed P(release within 24h) by hours-since-last-release ===');
const hazTable = [];
for (let i = 0; i < AGE_EDGES.length - 1; i++) {
  const sel = records.filter((r) => ageBucket(r.age) === i);
  if (!sel.length) continue;
  const k = sel.reduce((a, r) => a + r.y, 0);
  const w = wilson(k, sel.length);
  hazTable.push({ lo: AGE_EDGES[i], hi: AGE_EDGES[i + 1], n: sel.length, k, p: k / sel.length, wilson: w });
  console.log(`  ${String(AGE_EDGES[i]).padStart(4)}..${String(AGE_EDGES[i + 1] === Infinity ? 'inf' : AGE_EDGES[i + 1]).padStart(5)}h  n=${String(sel.length).padStart(4)}  P=${(100 * k / sel.length).toFixed(1).padStart(5)}%  [${(w.lo * 100).toFixed(0)}..${(w.hi * 100).toFixed(0)}]`);
}

/* ---------------- final fit + current state ---------------- */
const finalModel = fitAt(endMs);
const nowSnap = snap(endMs);
console.log('\n=== final model fitted at snapshot end ===');
console.log(`  trained on ${finalModel.trainN} hourly instants`);
console.log(`  weekday relative risk (odds scale): ${finalModel.dowRR.map((v, i) => `${DOW_NAMES[i]}=${v.toFixed(2)}`).join(' ')}`);
console.log(`  velocity beta=${finalModel.beta.toFixed(4)} (per SD of tyLag1)`);
console.log(`  current age=${nowSnap.age.toFixed(1)}h dow=${DOW_NAMES[nowSnap.dow]} tyLag1=${nowSnap.tyLag1} allLag1=${nowSnap.allLag1}`);
console.log(`  P_C=${(applyC(finalModel.haz, finalModel.dowRR, nowSnap, finalModel.pConst) * 100).toFixed(1)}%  P_D=${(applyD(finalModel, nowSnap) * 100).toFixed(1)}%`);

writeFileSync(root + 'data/model3.json', JSON.stringify({
  fittedAt: Date.now(), horizonHours: H,
  ageEdges: AGE_EDGES,
  hazard: hazTable,
  weekdayRisk: finalModel.dowRR,
  velocity: { mu: finalModel.muTy, sd: finalModel.sdTy, beta: finalModel.beta },
  baseRate: finalModel.pConst,
  outOfSample: Object.fromEntries(variants.map(([l, k]) => [k, {
    brier: brier(records.map((r) => r[k]), ys), auc: auc(records.map((r) => r[k]), ys), logLoss: logLoss(records.map((r) => r[k]), ys),
  }])),
  records: records.length,
  window: { startMs, endMs },
}, null, 2));
console.log('\nwrote data/model3.json');
