/**
 * Exploratory diagnostics: what does the commit signal actually look like in the
 * hours BEFORE a release? This decides feature design before modelling.
 *
 *   node build/explore.mjs
 */
import { readFileSync } from 'node:fs';
import { HOUR_MS, mean, cstDayKey } from '../src/analytics.js';

const root = new URL('..', import.meta.url).pathname;
const ds = JSON.parse(readFileSync(root + 'data/dataset.json', 'utf8'));
const ty = ds.tianyicuiCommits.slice().sort((a, b) => a - b);
const all = ds.allCommits.slice().sort((a, b) => a - b);
const rel = ds.releases.map((r) => r.time).sort((a, b) => a - b);

const countIn = (arr, from, to) => {
  let n = 0;
  for (const t of arr) if (t > from && t <= to) n++;
  return n;
};

/** hours-since-last-release -> commits per hour, for many windows */
const windows = [1, 3, 6, 12, 24, 48];
console.log('=== mean commits per hour in the N hours BEFORE each release (tianyicui) ===');
console.log('N(h)   release-pre   baseline    ratio');
for (const w of windows) {
  let preSum = 0, preN = 0, baseSum = 0, baseN = 0;
  // baseline: same window, sampled at every hour across the model window
  const start = rel[0], end = Math.max(...ty);
  for (const r of rel) {
    preSum += countIn(ty, r - w * HOUR_MS, r);
    preN += w;
  }
  for (let t = start; t <= end; t += HOUR_MS) {
    baseSum += countIn(ty, t - w * HOUR_MS, t);
    baseN += w;
  }
  const pre = preSum / preN, base = baseSum / baseN;
  console.log(`${String(w).padStart(3)}   ${pre.toFixed(2).padStart(10)}   ${base.toFixed(2).padStart(8)}   ${(pre / base).toFixed(2)}x`);
}

console.log('\n=== same, whole team ===');
console.log('N(h)   release-pre   baseline    ratio');
for (const w of windows) {
  let preSum = 0, preN = 0, baseSum = 0, baseN = 0;
  const start = rel[0], end = Math.max(...all);
  for (const r of rel) { preSum += countIn(all, r - w * HOUR_MS, r); preN += w; }
  for (let t = start; t <= end; t += HOUR_MS) { baseSum += countIn(all, t - w * HOUR_MS, t); baseN += w; }
  const pre = preSum / preN, base = baseSum / baseN;
  console.log(`${String(w).padStart(3)}   ${pre.toFixed(2).padStart(10)}   ${base.toFixed(2).padStart(8)}   ${(pre / base).toFixed(2)}x`);
}

// ---- is the hazard time-dependent? (days since last release) --------------
console.log('\n=== hazard by hours-since-last-release (all hours in model window) ===');
const start = rel[0], end = Math.max(...ty, ...rel);
const boundaries = [0, 6, 12, 24, 36, 48, 72, 96, 144, 100000];
for (let b = 0; b < boundaries.length - 1; b++) {
  const lo = boundaries[b], hi = boundaries[b + 1];
  let n = 0, k = 0;
  for (let t = start; t + HOUR_MS <= end; t += HOUR_MS) {
    // hours since the most recent release at t
    let last = -Infinity;
    for (const r of rel) { if (r <= t) last = r; else break; }
    const h = (t - last) / HOUR_MS;
    if (h >= lo && h < hi) {
      n++;
      if (rel.some((r) => r > t && r <= t + 24 * HOUR_MS)) k++;
    }
  }
  if (n) console.log(`  ${String(lo).padStart(4)}..${String(hi === 100000 ? 'inf' : hi).padStart(4)}h  n=${String(n).padStart(5)}  P(release<24h)=${(100 * k / n).toFixed(1)}%`);
}

console.log('\n=== hazard by day-of-week (CST) / hour-of-day (CST) ===');
const dowName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowN = new Array(7).fill(0), dowK = new Array(7).fill(0);
const hodN = new Array(24).fill(0), hodK = new Array(24).fill(0);
for (let t = start; t + HOUR_MS <= end; t += HOUR_MS) {
  const d = new Date(t + 8 * HOUR_MS);
  const dow = d.getUTCDay(), hod = d.getUTCHours();
  const hit = rel.some((r) => r > t && r <= t + 24 * HOUR_MS) ? 1 : 0;
  dowN[dow]++; dowK[dow] += hit;
  hodN[hod]++; hodK[hod] += hit;
}
console.log('  ' + dowName.map((n, i) => `${n}=${dowN[i] ? (100 * dowK[i] / dowN[i]).toFixed(0) : '-'}%`).join(' '));
console.log('  hour: ' + hodN.map((n, i) => (n ? `${String(i).padStart(2, '0')}:${(100 * hodK[i] / n).toFixed(0)}%` : '')).filter(Boolean).join(' '));

// ---- releases per day: are release days clustered? ------------------------
console.log('\n=== releases per CST day (distribution) ===');
const perDay = new Map();
for (const r of rel) {
  const k = cstDayKey(r);
  perDay.set(k, (perDay.get(k) || 0) + 1);
}
const dist = new Map();
for (const v of perDay.values()) dist.set(v, (dist.get(v) || 0) + 1);
for (const [k, v] of [...dist].sort((a, b) => a[0] - b[0])) console.log(`  ${k} release(s) on a day: ${v} day(s)`);
console.log(`  distinct release days: ${perDay.size} / ${Math.round((end - start) / (24 * HOUR_MS))} days`);

// ---- consecutive-release gap distribution --------------------------------
console.log('\n=== gap between consecutive releases (hours) ===');
const gaps = [];
for (let i = 1; i < rel.length; i++) gaps.push((rel[i] - rel[i - 1]) / HOUR_MS);
gaps.sort((a, b) => a - b);
const q = (p) => gaps[Math.round(p * (gaps.length - 1))];
console.log(`  n=${gaps.length} min=${q(0).toFixed(1)} p25=${q(0.25).toFixed(1)} med=${q(0.5).toFixed(1)} p75=${q(0.75).toFixed(1)} max=${q(1).toFixed(1)}`);
console.log(`  mean=${mean(gaps).toFixed(1)}h`);
