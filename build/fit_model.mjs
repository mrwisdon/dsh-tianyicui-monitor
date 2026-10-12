/**
 * Final model fit at an arbitrary horizon (used for the shipped 72h metric).
 *
 * Same rolling-origin protocol as evaluate3, but parametrised by horizon, with a
 * finer age grid and an isotonic-style post-calibration pass so the numbers the
 * UI shows are trustworthy rather than optimistic.
 *
 *   node build/fit_model.mjs [horizonHours]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { HOUR_MS, DAY_MS, CST_OFFSET_MS, mean, auc, brier, logLoss, wilson, cstDayStart } from '../src/analytics.js';

const H = Number(process.argv[2] || 72);
const root = new URL('..', import.meta.url).pathname;
const ds = JSON.parse(readFileSync(root + 'data/dataset.json', 'utf8'));
const ty = ds.tianyicuiCommits.slice().sort((a, b) => a - b);
const all = ds.allCommits.slice().sort((a, b) => a - b);
const rel = ds.releases.map((r) => r.time).sort((a, b) => a - b);
const startMs = rel[0];
const endMs = Math.max(...ty, ...rel);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowOf = (t) => new Date(t + CST_OFFSET_MS).getUTCDay();
const REFIT = 6 * HOUR_MS;
const MIN_TRAIN = 14 * DAY_MS;

/* --- fine age grid: keeps the bimodal shape without overfitting cells --- */
const AGE_EDGES = [0, 6, 12, 18, 24, 30, 36, 42, 48, 60, 72, 96, 120, 168, Infinity];
const ageBucket = (a) => { for (let i = 0; i < AGE_EDGES.length - 1; i++) if (a >= AGE_EDGES[i] && a < AGE_EDGES[i + 1]) return i; return AGE_EDGES.length - 2; };

function countRange(arr, from, to) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= from) lo = m + 1; else hi = m; }
  let n = 0;
  for (let i = lo; i < arr.length && arr[i] < to; i++) n++;
  return n;
}
function lastRel(t) { let b = -Infinity; for (const r of rel) { if (r <= t) b = r; else break; } return b; }
const hitOf = (t) => (rel.some((r) => r > t && r <= t + H * HOUR_MS) ? 1 : 0);

const day0 = cstDayStart(Math.min(...all));
const dayIdxOf = (t) => Math.floor((cstDayStart(t) - day0) / DAY_MS);
const nDays = dayIdxOf(endMs) + 2;
const tyDay = new Array(nDays).fill(0), allDay = new Array(nDays).fill(0);
for (const t of ty) tyDay[dayIdxOf(t)]++;
for (const t of all) allDay[dayIdxOf(t)]++;
const trailing = (arr, i, k) => { let s = 0; for (let j = Math.max(0, i - k + 1); j <= i; j++) s += arr[j]; return s; };

function snap(t) {
  const lr = lastRel(t);
  const i = dayIdxOf(t);
  return {
    t, hit: hitOf(t), dow: dowOf(t),
    age: lr === -Infinity ? 999 : (t - lr) / HOUR_MS,
    tyLag1: trailing(tyDay, i - 1, 1),
    allLag1: trailing(allDay, i - 1, 1),
    allLast3: trailing(allDay, i, 3),
  };
}

/* --- fit at a cut point --- */
function fitAt(tCut) {
  const hist = [];
  for (let t = startMs; t < tCut; t += HOUR_MS) hist.push(snap(t));
  const pConst = mean(hist.map((h) => h.hit));
  const prior = 25;

  const bN = new Array(AGE_EDGES.length - 1).fill(0), bK = new Array(AGE_EDGES.length - 1).fill(0);
  for (const h of hist) { const b = ageBucket(h.age); bN[b]++; bK[b] += h.hit; }
  const haz = bN.map((n, i) => (bK[i] + prior * pConst) / (n + prior));

  const dN = new Array(7).fill(0), dK = new Array(7).fill(0);
  for (const h of hist) { dN[h.dow]++; dK[h.dow] += h.hit; }
  const baseOdds = pConst / Math.max(1e-9, 1 - pConst);
  const dowRR = dN.map((n, i) => {
    const cell = (dK[i] + prior * pConst) / (n + prior);
    return Math.max(0.1, Math.min(8, (cell / Math.max(1e-9, 1 - cell)) / baseOdds));
  });

  // velocity term: tyLag1 (yesterday's tianyicui commits), logistic on top of C
  const muTy = mean(hist.map((h) => h.tyLag1));
  const sdTy = Math.sqrt(mean(hist.map((h) => (h.tyLag1 - muTy) ** 2))) || 1;
  let beta = 0;
  const lr = 0.4;
  for (let it = 0; it < 3000; it++) {
    let g = 0;
    for (const h of hist) {
      const pc = predictC(haz, dowRR, h, pConst);
      const x = (h.tyLag1 - muTy) / sdTy;
      const p = 1 / (1 + Math.exp(-(Math.log(pc / (1 - pc)) + beta * x)));
      g += (p - h.hit) * x;
    }
    beta -= lr * (g / hist.length + 0.05 * beta);
  }
  return { pConst, haz, dowRR, muTy, sdTy, beta, trainN: hist.length };
}
const clamp = (p) => Math.max(0.005, Math.min(0.995, p));
function predictC(haz, dowRR, h, pConst) {
  const cell = haz[ageBucket(h.age)];
  const odds = (cell / Math.max(1e-9, 1 - cell)) * (dowRR[h.dow] ?? 1);
  return clamp(odds / (1 + odds));
}
function predictAll(m, h) {
  return { pC: predictC(m.haz, m.dowRR, h, m.pConst), pD: clamp(1 / (1 + Math.exp(-(Math.log(predictC(m.haz, m.dowRR, h, m.pConst) / (1 - predictC(m.haz, m.dowRR, h, m.pConst))) + m.beta * ((h.tyLag1 - m.muTy) / m.sdTy))))) };
}

/* --- rolling-origin backtest --- */
const recs = [];
let model = null, nextFit = startMs + MIN_TRAIN;
for (let t = startMs + MIN_TRAIN; t <= endMs; t += HOUR_MS) {
  if (t >= nextFit) { model = fitAt(t); nextFit = t + REFIT; }
  if (!model) continue;
  const h = snap(t);
  const { pC, pD } = predictAll(model, h);
  recs.push({ t, y: h.hit, age: h.age, dow: h.dow, pA: model.pConst, pC, pD });
}
const ys = recs.map((r) => r.y);
console.log(`H=${H}h  rolling-origin instants=${recs.length}  positives=${ys.reduce((a, b) => a + b, 0)} (${(100 * mean(ys)).toFixed(1)}%)  base=${(100 * mean(recs.map((r) => r.pA))).toFixed(1)}%`);

console.log('\n=== out-of-sample (rolling-origin, 6h refit) ===');
const variants = [['A constant', 'pA'], ['C hazard x weekday', 'pC'], ['D C + velocity', 'pD']];
for (const [l, k] of variants) {
  const ps = recs.map((r) => r[k]);
  console.log(`  ${l.padEnd(20)} Brier=${brier(ps, ys).toFixed(4)}  AUC=${auc(ps, ys).toFixed(3)}  LogLoss=${logLoss(ps, ys).toFixed(4)}`);
}
const bestKey = brier(recs.map((r) => r.pD), ys) <= brier(recs.map((r) => r.pC), ys) ? 'pD' : 'pC';
console.log(`  => shipping variant: ${bestKey}`);

/* --- isotonic post-calibration (PAV on out-of-sample preds) --- */
const iso = fitIsotonic(recs.map((r) => r[bestKey]), ys);
console.log(`\n=== post-calibration (isotonic, ${iso.xs.length} knots) ===`);
const cal = recs.map((r) => applyIsotonic(iso, r[bestKey]));
console.log(`  before: Brier=${brier(recs.map((r) => r[bestKey]), ys).toFixed(4)}  ECE=${(eceOf(recs.map((r) => r[bestKey]), ys) * 100).toFixed(2)}pp`);
console.log(`  after : Brier=${brier(cal, ys).toFixed(4)}  ECE=${(eceOf(cal, ys) * 100).toFixed(2)}pp`);

/* --- calibration table after isotonic --- */
console.log('\n=== calibration table (after isotonic) ===');
const pairs = cal.map((p, i) => ({ p, y: ys[i] })).sort((a, b) => a.p - b.p);
const BINS = 10, bs = Math.floor(pairs.length / BINS);
for (let b = 0; b < BINS; b++) {
  const lo = b * bs, hi = b === BINS - 1 ? pairs.length : lo + bs;
  const seg = pairs.slice(lo, hi);
  if (!seg.length) continue;
  const pred = mean(seg.map((s) => s.p)), obs = mean(seg.map((s) => s.y));
  console.log(`  pred=${(pred * 100).toFixed(1).padStart(5)}%  obs=${(obs * 100).toFixed(1).padStart(5)}%  n=${String(seg.length).padStart(4)} ${'#'.repeat(Math.round(obs * 40))}`);
}

/* --- threshold table --- */
console.log('\n=== threshold behaviour (after isotonic) ===');
const thTable = [];
for (const th of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
  const idx = cal.map((p, i) => [p, ys[i]]).filter(([p]) => p >= th);
  if (!idx.length) { console.log(`  p>=${(th * 100).toFixed(0)}%: never fires`); continue; }
  const k = idx.reduce((a, [p, y]) => a + y, 0);
  const w = wilson(k, idx.length);
  thTable.push({ th, n: idx.length, k, hit: k / idx.length, wilson: w });
  console.log(`  p>=${(th * 100).toFixed(0)}%: ${String(idx.length).padStart(4)}/${cal.length} (${(100 * idx.length / cal.length).toFixed(1)}%) hit ${(100 * k / idx.length).toFixed(1)}% [${(w.lo * 100).toFixed(1)}..${(w.hi * 100).toFixed(1)}]`);
}

/* --- hazard + weekday tables for the UI --- */
const hazTable = [];
for (let i = 0; i < AGE_EDGES.length - 1; i++) {
  const sel = recs.filter((r) => ageBucket(r.age) === i);
  if (sel.length < 8) { hazTable.push({ lo: AGE_EDGES[i], hi: AGE_EDGES[i + 1], n: sel.length, p: null }); continue; }
  const k = sel.reduce((a, r) => a + r.y, 0);
  hazTable.push({ lo: AGE_EDGES[i], hi: AGE_EDGES[i + 1], n: sel.length, k, p: k / sel.length, wilson: wilson(k, sel.length) });
}
console.log('\n=== observed P(release within horizon) by hours-since-last-release ===');
for (const h of hazTable) {
  if (h.p == null) { console.log(`  ${String(h.lo).padStart(4)}..${String(h.hi === Infinity ? 'inf' : h.hi).padStart(5)}h  n=${h.n} (sparse)`); continue; }
  console.log(`  ${String(h.lo).padStart(4)}..${String(h.hi === Infinity ? 'inf' : h.hi).padStart(5)}h  n=${String(h.n).padStart(4)}  P=${(h.p * 100).toFixed(1).padStart(5)}%  [${(h.wilson.lo * 100).toFixed(0)}..${(h.wilson.hi * 100).toFixed(0)}]`);
}
const dowTable = [];
console.log('\n=== observed P by CST weekday ===');
for (let d = 0; d < 7; d++) {
  const sel = recs.filter((r) => r.dow === d);
  if (!sel.length) continue;
  const k = sel.reduce((a, r) => a + r.y, 0);
  const w = wilson(k, sel.length);
  dowTable.push({ dow: d, n: sel.length, k, p: k / sel.length, wilson: w });
  console.log(`  ${DOW[d]}  n=${String(sel.length).padStart(4)}  P=${(100 * k / sel.length).toFixed(1).padStart(5)}%  [${(w.lo * 100).toFixed(0)}..${(w.hi * 100).toFixed(0)}]`);
}

/* --- final model on everything --- */
const finalModel = fitAt(endMs);
const nowSnap = snap(endMs);
const nowPred = predictAll(finalModel, nowSnap);
console.log('\n=== final model fitted at snapshot end ===');
console.log(`  weekday risk (odds): ${finalModel.dowRR.map((v, i) => `${DOW[i]}=${v.toFixed(2)}`).join(' ')}`);
console.log(`  velocity beta=${finalModel.beta.toFixed(4)}`);
console.log(`  now: age=${nowSnap.age.toFixed(1)}h dow=${DOW[nowSnap.dow]} tyLag1=${nowSnap.tyLag1}`);
console.log(`  P_C=${(nowPred.pC * 100).toFixed(1)}%  P_D=${(nowPred.pD * 100).toFixed(1)}%`);

/* --- independent support count --- */
const indepN = rel.filter((r) => r + HOUR_MS <= endMs).length;

writeFileSync(root + 'data/model_final.json', JSON.stringify({
  fittedAt: Date.now(),
  horizonHours: H,
  ageEdges: AGE_EDGES,
  hazard: hazTable,
  weekday: dowTable,
  coefficients: {
    pConst: finalModel.pConst,
    hazard: finalModel.haz,
    dowRR: finalModel.dowRR,
    velocity: { mu: finalModel.muTy, sd: finalModel.sdTy, beta: finalModel.beta },
  },
  isotonic: iso,
  metrics: {
    instants: recs.length, positives: ys.reduce((a, b) => a + b, 0), baseRate: mean(ys),
    effectiveSample: indepN,
    variant: bestKey,
    brier: brier(cal, ys), auc: auc(cal, ys), logLoss: logLoss(cal, ys),
    brierBeforeIso: brier(recs.map((r) => r[bestKey]), ys),
    ece: eceOf(cal, ys),
    baselineBrier: brier(recs.map((r) => r.pA), ys),
    baselineLogLoss: logLoss(recs.map((r) => r.pA), ys),
    thresholds: thTable,
  },
  current: { nowMs: endMs, age: nowSnap.age, dow: nowSnap.dow, pC: nowPred.pC, pD: nowPred.pD, calibrated: applyIsotonic(iso, nowPred[bestKey]) },
  window: { startMs, endMs },
}, null, 2));
console.log('\nwrote data/model_final.json');

/* ---------------- isotonic regression (PAV) ---------------- */
function fitIsotonic(xs, ysIn) {
  const idx = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b]);
  const sx = idx.map((i) => xs[i]), sy = idx.map((i) => ysIn[i]);
  const w = new Array(sx.length).fill(1);
  const yv = sy.slice();
  let i = 0;
  while (i < yv.length - 1) {
    if (yv[i] > yv[i + 1] + 1e-12) {
      const wSum = w[i] + w[i + 1];
      yv[i] = (yv[i] * w[i] + yv[i + 1] * w[i + 1]) / wSum;
      w[i] = wSum;
      yv.splice(i + 1, 1); w.splice(i + 1, 1); sx.splice(i + 1, 1);
      if (i > 0) i--;
    } else i++;
  }
  return { xs: sx, ys: yv };
}
function applyIsotonic(iso, x) {
  const { xs, ys } = iso;
  if (!xs.length) return x;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0, hi = xs.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m + 1; else hi = m; }
  const x0 = xs[lo - 1], x1 = xs[lo], y0 = ys[lo - 1], y1 = ys[lo];
  const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
  return y0 + t * (y1 - y0);
}
function eceOf(ps, ysIn) {
  const p = ps.map((x, i) => ({ p: x, y: ysIn[i] })).sort((a, b) => a.p - b.p);
  const B = 10, s = Math.floor(p.length / B), out = [];
  let e = 0;
  for (let b = 0; b < B; b++) {
    const lo = b * s, hi = b === B - 1 ? p.length : lo + s;
    const seg = p.slice(lo, hi);
    if (!seg.length) continue;
    const pred = mean(seg.map((q) => q.p)), obs = mean(seg.map((q) => q.y));
    e += (seg.length / p.length) * Math.abs(pred - obs);
  }
  return e;
}
