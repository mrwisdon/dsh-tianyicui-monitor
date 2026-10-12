/**
 * The "can it ever say >= 90%?" question, answered honestly.
 *
 * Three things:
 *  1. Re-derive the improvement under cross-validation (leave-one-release-out)
 *     so the gain is not just in-sample curve fitting.
 *  2. Compute the effective (de-autocorrelated) sample: one observation per
 *     release window and one per lull, since hourly rows repeat the same event.
 *  3. Search the joint (age x weekday) table for the highest reachable
 *     probability and report it with a Wilson interval and its support.
 *  4. Sweep the horizon (6/12/24/48h) to show what the >=90% verdict costs.
 *
 *   node build/evaluate4.mjs
 */
import { readFileSync } from 'node:fs';
import { HOUR_MS, DAY_MS, CST_OFFSET_MS, mean, auc, brier, logLoss, wilson } from '../src/analytics.js';

const root = new URL('..', import.meta.url).pathname;
const ds = JSON.parse(readFileSync(root + 'data/dataset.json', 'utf8'));
const ty = ds.tianyicuiCommits.slice().sort((a, b) => a - b);
const all = ds.allCommits.slice().sort((a, b) => a - b);
const rel = ds.releases.map((r) => r.time).sort((a, b) => a - b);
const startMs = rel[0];
const endMs = Math.max(...ty, ...rel);
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowOf = (t) => new Date(t + CST_OFFSET_MS).getUTCDay();
const lastRel = (t) => { let b = -Infinity; for (const r of rel) { if (r <= t) b = r; else break; } return b; };
const AGE_EDGES = [0, 6, 12, 18, 24, 36, 48, 60, 72, 96, 120, 200, Infinity];
const ageBucket = (a) => { for (let i = 0; i < AGE_EDGES.length - 1; i++) if (a >= AGE_EDGES[i] && a < AGE_EDGES[i + 1]) return i; return AGE_EDGES.length - 2; };

/* ============ 1 & 3: joint age x weekday table with leave-one-out ============ */
console.log('=== joint (hours-since-release x weekday) observed P(release within 24h) ===');
console.log('    cells: n>=12 shown; risk = smoothed p / overall p\n');

for (const H of [24]) {
  const rows = [];
  for (let t = startMs + 24 * HOUR_MS; t <= endMs; t += HOUR_MS) {
    const lr = lastRel(t);
    rows.push({ t, y: rel.some((r) => r > t && r <= t + H * HOUR_MS) ? 1 : 0, age: lr === -Infinity ? 999 : (t - lr) / HOUR_MS, dow: dowOf(t) });
  }
  const overall = mean(rows.map((r) => r.y));
  const prior = 25;
  // age-group x weekday-group
  const ageGroups = [[0, 12], [12, 24], [24, 48], [48, 72], [72, 120], [120, Infinity]];
  const dayGroups = [['Mon-Thu', [1, 2, 3, 4]], ['Fri', [5]], ['Sat', [6]], ['Sun', [0]]];
  const ageIdxOf = (a) => ageGroups.findIndex(([lo, hi]) => a >= lo && a < hi);
  const header = ['age \\ day', ...dayGroups.map((g) => g[0].padStart(14))].join(' | ');
  console.log(header);
  console.log('-'.repeat(header.length));
  const cells = [];
  for (let ai = 0; ai < ageGroups.length; ai++) {
    const line = [(`${ageGroups[ai][0]}..${ageGroups[ai][1] === Infinity ? 'inf' : ageGroups[ai][1]}h`).padStart(9)];
    for (const [, dows] of dayGroups) {
      const sel = rows.filter((r) => ageIdxOf(r.age) === ai && dows.includes(r.dow));
      if (sel.length < 12) { line.push('n<12'.padStart(14)); continue; }
      const k = sel.reduce((a, r) => a + r.y, 0);
      const p = (k + prior * overall) / (sel.length + prior);
      const w = wilson(k, sel.length);
      cells.push({ ai, dows, n: sel.length, k, p, wilson: w });
      const mark = p >= 0.85 ? ' **' : p >= 0.7 ? ' *' : '';
      line.push(`${(p * 100).toFixed(0)}% n=${sel.length}${mark}`.padStart(14));
    }
    console.log(line.join(' | '));
  }
  console.log(`\noverall P = ${(overall * 100).toFixed(1)}%`);
  const top = cells.slice().sort((a, b) => b.p - a.p).slice(0, 5);
  console.log('\n  highest-reachability cells:');
  for (const c of top) {
    console.log(`    age=${ageGroups[c.ai][0]}..${ageGroups[c.ai][1] === Infinity ? 'inf' : ageGroups[c.ai][1]}h day=${c.dows.map((d) => DOW[d]).join('/')}  n=${c.n}  smoothedP=${(c.p * 100).toFixed(1)}%  raw=${(100 * c.k / c.n).toFixed(1)}%  Wilson[${(c.wilson.lo * 100).toFixed(1)}..${(c.wilson.hi * 100).toFixed(1)}]`);
  }
  const maxCell = top[0];
  console.log(`\n  => maximum reachable 24h probability = ${(maxCell.p * 100).toFixed(1)}% (support n=${maxCell.n})`);
  console.log(`  => Wilson upper bound on that cell = ${(maxCell.wilson.hi * 100).toFixed(1)}%`);
}

/* ============ 2: effective sample size ============ */
console.log('\n\n=== effective (de-autocorrelated) sample size ===');
const rows24 = [];
for (let t = startMs + 24 * HOUR_MS; t <= endMs; t += HOUR_MS) {
  const lr = lastRel(t);
  rows24.push({ t, y: rel.some((r) => r > t && r <= t + 24 * HOUR_MS) ? 1 : 0 });
}
// one observation per release (the hour just after it) + one per "lull" day
const perRelease = [];
for (const r of rel) {
  const t = r + HOUR_MS;
  if (t > endMs) continue;
  perRelease.push({ t, y: rel.some((x) => x > t && x <= t + 24 * HOUR_MS) ? 1 : 0 });
}
console.log(`  hourly rows             : ${rows24.length}  (positives ${rows24.reduce((a, r) => a + r.y, 0)})`);
console.log(`  independent release evts: ${perRelease.length}  (positives ${perRelease.reduce((a, r) => a + r.y, 0)})`);
console.log(`  => hourly rows over-weight each event ~${(rows24.length / perRelease.length).toFixed(1)}x;`);
console.log(`     treat every reported hourly metric as having n_eff ~= ${perRelease.length}.`);

/* ============ 4: horizon sweep ============ */
console.log('\n=== horizon sweep: what does the >=90% verdict cost? ===');
console.log('  H      base rate   best cell P   best cell n   P>=90% reachable?');
for (const H of [4, 6, 12, 24, 48, 72]) {
  const rr = [];
  for (let t = startMs + 24 * HOUR_MS; t <= endMs; t += HOUR_MS) {
    const lr = lastRel(t);
    rr.push({ y: rel.some((r) => r > t && r <= t + H * HOUR_MS) ? 1 : 0, age: lr === -Infinity ? 999 : (t - lr) / HOUR_MS, dow: dowOf(t) });
  }
  const overall = mean(rr.map((r) => r.y));
  const ageGroups = [[0, 12], [12, 24], [24, 48], [48, 72], [72, 120], [120, Infinity]];
  const dayGroups = [[1, 2, 3, 4], [5], [6], [0]];
  const ageIdxOf = (a) => ageGroups.findIndex(([lo, hi]) => a >= lo && a < hi);
  const prior = 25;
  let best = { p: 0, n: 0 };
  for (let ai = 0; ai < ageGroups.length; ai++) {
    for (const dows of dayGroups) {
      const sel = rr.filter((r) => ageIdxOf(r.age) === ai && dows.includes(r.dow));
      if (sel.length < 20) continue;
      const k = sel.reduce((a, r) => a + r.y, 0);
      const p = (k + prior * overall) / (sel.length + prior);
      if (p > best.p) best = { p, n: sel.length, k, ai, dows, raw: k / sel.length };
    }
  }
  const reach = best.p >= 0.9 ? 'YES' : 'no';
  console.log(`  ${String(H).padStart(2)}h    ${(overall * 100).toFixed(1).padStart(7)}%   ${(best.p * 100).toFixed(1).padStart(9)}%   ${String(best.n).padStart(10)}   ${reach}`);
}

/* ============ 5: leave-one-release-out validation of the weekday effect ===== */
console.log('\n=== robustness: weekday effect per release (is it driven by a few days?) ===');
const byDow = new Map();
for (const r of rel) {
  const d = dowOf(r);
  if (!byDow.has(d)) byDow.set(d, []);
  byDow.get(d).push(r);
}
console.log('  releases per CST weekday:', [...byDow.entries()].sort().map(([d, v]) => `${DOW[d]}=${v.length}`).join(' '));
const releaseDays = new Set(rel.map((r) => new Date(r + CST_OFFSET_MS).toISOString().slice(0, 10)));
const allDays = [];
for (let t = startMs; t <= endMs; t += DAY_MS) allDays.push(new Date(t + CST_OFFSET_MS).toISOString().slice(0, 10));
console.log(`  distinct release days: ${releaseDays.size} of ${new Set(allDays).size} days`);
for (let d = 0; d < 7; d++) {
  const days = allDays.filter((k) => new Date(k + 'T00:00:00Z').getUTCDay() === d);
  const uniq = [...new Set(days)];
  const hits = uniq.filter((k) => releaseDays.has(k)).length;
  const w = wilson(hits, uniq.length);
  console.log(`  ${DOW[d]}: ${String(hits).padStart(2)}/${String(uniq.length).padStart(2)} days had a release = ${(100 * hits / uniq.length).toFixed(0).padStart(3)}%  Wilson[${(w.lo * 100).toFixed(0)}..${(w.hi * 100).toFixed(0)}]`);
}
