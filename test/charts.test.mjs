/**
 * tianyicui-monitor — geometry contract tests.
 *
 *   node --test test/charts.test.mjs
 *
 * Only the pure modules are exercised (no DOM, no React renderer): the geometry
 * functions must produce valid, finite SVG paths and sane layouts for real and
 * degenerate input. views.js is syntax-checked and its export surface asserted,
 * because `react` is supplied by the DSH module system and is not installed here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { heatmapMatrix, cstDayKey, DAY_MS, CST_OFFSET_MS } from '../src/analytics.js';
import {
  AREA_COLORS,
  HEAT_LEVELS,
  GAUGE_START_DEG,
  GAUGE_SWEEP_DEG,
  GAUGE_THRESHOLD,
  buildAreaGeometry,
  buildAreaPath,
  buildLinePath,
  buildHeatmapGeometry,
  gaugeArc,
  quantileColor,
  releaseMarkers,
} from '../src/client/charts.js';
import { LIKELY_THRESHOLD, TONES, classifyProbability, toneColor } from '../src/client/classify.js';

const CHARTS_PATH = fileURLToPath(new URL('../src/client/charts.js', import.meta.url));
const VIEWS_PATH = fileURLToPath(new URL('../src/client/views.js', import.meta.url));
const CLASSIFY_PATH = fileURLToPath(new URL('../src/client/classify.js', import.meta.url));

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */

/** Contiguous CST calendar days, integer counts, a release every 9th day. */
function mkDays(n) {
  const start = Date.UTC(2026, 5, 10) - CST_OFFSET_MS; // 2026-06-10 00:00 CST
  const days = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * DAY_MS;
    const rel = i % 9 === 0;
    days.push({
      key: cstDayKey(t),
      start: t,
      tianyicui: (i * 7) % 13,
      all: (i * 11) % 17,
      isReleaseDay: rel,
      releases: rel ? [t] : [],
    });
  }
  return days;
}

function pointsFrom(days) {
  return days.map((d) => ({ day: d.key, tianyicui: d.tianyicui, all: d.all, isReleaseDay: d.isReleaseDay }));
}

const AREA_OPTS = { width: 380, height: 120, series: 'tianyicui' };

/** Every number in an SVG `d` string must be finite. */
function numsInPath(d) {
  const m = typeof d === 'string' ? d.match(/-?\d+(?:\.\d+)?/g) : null;
  return m ? m.map(Number) : [];
}

function lastPointOfPath(d) {
  const m = d.match(/-?\d+(?:\.\d+)?/g) || [];
  const nums = m.map(Number);
  return { x: nums[nums.length - 2], y: nums[nums.length - 1] };
}

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}

function near(a, b, tol = 0.15) {
  return Math.abs(a - b) <= tol;
}

/* ------------------------------------------------------------------ *
 * palette + color scale
 * ------------------------------------------------------------------ */

test('AREA_COLORS is a 6-stop light->dark green scale', () => {
  assert.equal(AREA_COLORS.length, 6);
  assert.equal(HEAT_LEVELS, 5);
  assert.equal(AREA_COLORS[0], '#ebedf0');
  assert.equal(AREA_COLORS[AREA_COLORS.length - 1], '#216e39');
  for (const c of AREA_COLORS) assert.match(c, /^#[0-9a-f]{6}$/i);
});

test('quantileColor maps into the palette and degrades safely', () => {
  assert.equal(quantileColor(0, 10, AREA_COLORS), AREA_COLORS[0]);
  assert.equal(quantileColor(10, 10, AREA_COLORS), AREA_COLORS[5]);
  for (const bad of [null, undefined, NaN, 'x', {}, [], -3]) {
    assert.equal(quantileColor(bad, 10, AREA_COLORS), AREA_COLORS[0], `value=${String(bad)}`);
  }
  assert.equal(quantileColor(5, 0, AREA_COLORS), AREA_COLORS[5], 'no scale info -> darkest for a positive value');
  assert.equal(quantileColor(0, 0, AREA_COLORS), AREA_COLORS[0]);
  assert.equal(quantileColor(50, 10, AREA_COLORS), AREA_COLORS[5], 'clamps above max');
  assert.equal(quantileColor(1, 10, undefined), quantileColor(1, 10, AREA_COLORS), 'defaults to AREA_COLORS');
});

test('quantileColor is monotone non-decreasing across the scale', () => {
  let prev = -1;
  for (let v = 0; v <= 12; v += 0.25) {
    const idx = AREA_COLORS.indexOf(quantileColor(v, 12, AREA_COLORS));
    assert.ok(idx >= 0, `fill for ${v} came from the palette`);
    assert.ok(idx >= prev, `index must not decrease at v=${v}`);
    prev = idx;
  }
  const custom = ['#000000', '#111111', '#222222'];
  assert.equal(quantileColor(9, 10, custom), '#222222');
  assert.equal(quantileColor(0.1, 10, custom), '#111111');
});

/* ------------------------------------------------------------------ *
 * area / line chart geometry
 * ------------------------------------------------------------------ */

test('buildAreaGeometry handles empty, null and malformed input', () => {
  for (const input of [[], null, undefined, 'nope', 42, [null, {}, 'x']]) {
    const g = buildAreaGeometry(input, AREA_OPTS);
    assert.equal(g.width, 380);
    assert.equal(g.height, 120);
    assert.ok(Array.isArray(g.xTicks));
    assert.ok(Array.isArray(g.yTicks));
    assert.ok(Array.isArray(g.gridLines));
    assert.ok(Array.isArray(g.points));
    for (const t of [...g.xTicks, ...g.yTicks, ...g.gridLines]) {
      assert.ok(Number.isFinite(t.x ?? t.y), 'no NaN in tick geometry');
    }
  }
  assert.equal(buildAreaGeometry([], AREA_OPTS).points.length, 0);
  assert.equal(buildAreaPath([], AREA_OPTS), '');
  assert.equal(buildLinePath([], AREA_OPTS), '');
  assert.deepEqual(releaseMarkers([], AREA_OPTS), []);

  // degenerate canvas size must not produce NaN geometry
  const pts = pointsFrom(mkDays(5));
  const flat = buildAreaGeometry(pts, { width: 0, height: 0 });
  assert.ok(Number.isFinite(flat.plot.x0) && Number.isFinite(flat.plot.x1));
  assert.ok(Number.isFinite(flat.plot.y0) && Number.isFinite(flat.plot.y1));
  for (const p of flat.points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  assert.ok(numsInPath(buildAreaPath(pts, { width: 0, height: 0 })).every(Number.isFinite));
  assert.ok(numsInPath(buildLinePath(pts, { width: 0, height: 0 })).every(Number.isFinite));
});

test('buildAreaGeometry lays out points inside the plot rect', () => {
  const days = mkDays(40);
  const g = buildAreaGeometry(pointsFrom(days), AREA_OPTS);
  assert.equal(g.points.length, 40);
  assert.equal(g.count, 40);
  assert.equal(g.series, 'tianyicui');
  assert.ok(g.max > 0);

  for (let i = 1; i < g.points.length; i++) {
    assert.ok(g.points[i].x > g.points[i - 1].x, 'x strictly increases');
  }
  for (const p of g.points) {
    assert.ok(p.x >= g.plot.x0 - 1e-9 && p.x <= g.plot.x1 + 1e-9, 'x inside plot');
    assert.ok(p.y >= g.plot.y0 - 1e-9 && p.y <= g.plot.y1 + 1e-9, 'y inside plot');
    assert.ok(Number.isFinite(p.value) && p.value >= 0);
    assert.equal(typeof p.day, 'string');
    assert.equal(typeof p.isReleaseDay, 'boolean');
  }
  // value and screen-y must move in opposite directions
  const sorted = [...g.points].sort((a, b) => a.value - b.value);
  assert.ok(sorted[0].y >= sorted[sorted.length - 1].y, 'higher value sits higher on screen');
});

test('y-axis ticks are monotone and anchored at zero', () => {
  const g = buildAreaGeometry(pointsFrom(mkDays(60)), AREA_OPTS);
  assert.ok(g.yTicks.length >= 2);
  for (let i = 1; i < g.yTicks.length; i++) {
    assert.ok(g.yTicks[i].y > g.yTicks[i - 1].y, 'screen y ascends top->bottom');
    assert.ok(g.yTicks[i].value < g.yTicks[i - 1].value, 'values descend top->bottom');
  }
  assert.equal(g.yTicks[g.yTicks.length - 1].value, 0);
  assert.ok(g.yTicks[0].value >= g.max, 'axis top covers the data max');
  assert.ok(g.niceMax >= g.max && g.step > 0);
  assert.equal(g.gridLines.length, g.yTicks.length);
  for (let i = 0; i < g.gridLines.length; i++) {
    assert.equal(g.gridLines[i].value, g.yTicks[i].value);
    assert.equal(g.gridLines[i].y, g.yTicks[i].y);
    assert.equal(typeof g.yTicks[i].label, 'string');
    assert.ok(g.yTicks[i].label.length > 0);
  }
});

test('x-axis ticks stay inside the plot and are ordered', () => {
  const g = buildAreaGeometry(pointsFrom(mkDays(40)), AREA_OPTS);
  assert.ok(g.xTicks.length >= 2 && g.xTicks.length <= 4);
  for (let i = 1; i < g.xTicks.length; i++) {
    assert.ok(g.xTicks[i].x > g.xTicks[i - 1].x);
  }
  for (const t of g.xTicks) {
    assert.ok(t.x >= g.plot.x0 - 1e-9 && t.x <= g.plot.x1 + 1e-9);
    assert.match(t.label, /^\d{2}-\d{2}$/);
  }
  assert.equal(g.xTicks[0].index, 0);
  assert.equal(g.xTicks[g.xTicks.length - 1].index, 39);
});

test('series switch changes the value source', () => {
  const pts = pointsFrom(mkDays(40));
  const ty = buildAreaGeometry(pts, { ...AREA_OPTS, series: 'tianyicui' });
  const all = buildAreaGeometry(pts, { ...AREA_OPTS, series: 'all' });
  assert.equal(ty.series, 'tianyicui');
  assert.equal(all.series, 'all');
  assert.equal(ty.points[5].value, pts[5].tianyicui);
  assert.equal(all.points[5].value, pts[5].all);
  assert.ok(all.max > ty.max, 'team series peaks higher in this fixture');
  assert.equal(buildAreaGeometry(pts, { ...AREA_OPTS, series: 'bogus' }).series, 'tianyicui');
});

test('all-zero and single-point series still produce valid paths', () => {
  const zeros = mkDays(10).map((d) => ({ day: d.key, tianyicui: 0, all: 0, isReleaseDay: false }));
  const gz = buildAreaGeometry(zeros, AREA_OPTS);
  assert.equal(gz.max, 0);
  assert.ok(gz.points.every((p) => Number.isFinite(p.y)));
  assert.ok(gz.points.every((p) => near(p.y, gz.plot.y1, 1e-9)), 'zero line hugs the baseline');
  const areaZ = buildAreaPath(zeros, AREA_OPTS);
  assert.match(areaZ, /^M /);
  assert.match(areaZ, /Z$/);
  assert.ok(numsInPath(areaZ).every(Number.isFinite));

  const single = buildAreaGeometry([{ day: '2026-06-10', tianyicui: 5, all: 9, isReleaseDay: true }], AREA_OPTS);
  assert.equal(single.points.length, 1);
  assert.equal(single.xTicks.length, 1);
  const area1 = buildAreaPath([{ day: '2026-06-10', tianyicui: 5, all: 9, isReleaseDay: true }], AREA_OPTS);
  assert.match(area1, /^M /);
  assert.match(area1, /Z$/);
  assert.ok(numsInPath(area1).every(Number.isFinite));
});

test('buildAreaPath returns a closed, finite area; buildLinePath an open polyline', () => {
  const pts = pointsFrom(mkDays(40));
  const area = buildAreaPath(pts, AREA_OPTS);
  assert.match(area, /^M /);
  assert.match(area, /Z$/);
  assert.ok(!area.includes('NaN'));
  assert.ok(numsInPath(area).every(Number.isFinite));
  const segs = (area.match(/L /g) || []).length;
  assert.equal(segs, 41, 'one L per point plus the closing baseline');

  const line = buildLinePath(pts, AREA_OPTS);
  assert.match(line, /^M /);
  assert.ok(!line.includes('Z'));
  assert.equal((line.match(/L /g) || []).length, 39);
  assert.ok(numsInPath(line).every(Number.isFinite));

  const noPad = buildAreaGeometry(pts, { width: 380, height: 120 });
  assert.ok(noPad.pad.left > 0 && noPad.pad.bottom > 0, 'default padding applied');
  assert.equal(buildAreaGeometry(pts, { width: 380, height: 120, pad: { left: 5 } }).pad.left, 5);
  assert.equal(buildAreaGeometry(pts, { width: 380, height: 120, pad: { left: 5 } }).pad.top, 10);
});

test('releaseMarkers points at release days only', () => {
  const pts = pointsFrom(mkDays(36));
  const markers = releaseMarkers(pts, AREA_OPTS);
  const expected = pts.filter((d) => d.isReleaseDay).length;
  assert.equal(markers.length, expected);
  assert.ok(expected >= 4);
  for (const m of markers) {
    assert.ok(Number.isFinite(m.x) && Number.isFinite(m.y0) && Number.isFinite(m.y1));
    assert.match(m.day, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('geometry accepts the raw buildDailySeries shape (key/releases)', () => {
  const days = mkDays(20);
  const g = buildAreaGeometry(days, AREA_OPTS);
  assert.equal(g.points.length, 20);
  assert.equal(g.points[0].day, days[0].key);
  assert.equal(g.points[9].isReleaseDay, true, 'releases[] implies a release marker');
  assert.equal(g.points[10].isReleaseDay, false);
});

/* ------------------------------------------------------------------ *
 * heatmap geometry
 * ------------------------------------------------------------------ */

test('heatmap geometry always yields 7 cells per week', () => {
  const days = mkDays(120);
  const heat = heatmapMatrix(days);
  assert.ok(heat.weeks.length >= 17, 'sanity: 120 days span at least 17 weeks');

  const g = buildHeatmapGeometry(heat, { cell: 10, gap: 2, corner: 2, gutter: { top: 14, left: 24 }, emptyColor: '#000000' });
  assert.equal(g.cells.length, 7 * heat.weeks.length);
  assert.equal(g.weeks, heat.weeks.length);
  assert.equal(g.width, 24 + heat.weeks.length * 12 - 2);
  assert.equal(g.height, 14 + 7 * 12 - 2);
  assert.ok(g.width > 0 && g.height > 0);

  for (const cell of g.cells) {
    assert.ok(Number.isFinite(cell.x) && Number.isFinite(cell.y));
    assert.equal(cell.size, 10);
    assert.equal(cell.rx, 2);
    assert.equal(typeof cell.key, 'string');
    assert.equal(typeof cell.fill, 'string');
    assert.ok(cell.fill.length > 0);
    assert.equal(typeof cell.title, 'string');
    assert.ok(cell.title.includes(cell.key));
    assert.ok(cell.x >= 24 && cell.y >= 14);
    assert.ok(cell.x + cell.size <= g.width + 1e-9);
    assert.ok(cell.y + cell.size <= g.height + 1e-9);
  }

  // one column per week: same x inside a column, +pitch across columns
  const byCol = new Map();
  for (const c of g.cells) {
    if (!byCol.has(c.col)) byCol.set(c.col, c.x);
    assert.equal(byCol.get(c.col), c.x, 'column x is uniform');
  }
  for (let w = 1; w < heat.weeks.length; w++) {
    assert.equal(byCol.get(w) - byCol.get(w - 1), 12);
  }
  const rows = new Map();
  for (const c of g.cells) rows.set(c.row, c.y);
  assert.equal(rows.size, 7);
  for (let d = 1; d < 7; d++) assert.equal(rows.get(d) - rows.get(d - 1), 12);
});

test('heatmap month + day labels and level scale', () => {
  const heat = heatmapMatrix(mkDays(120));
  const g = buildHeatmapGeometry(heat, { cell: 10, gap: 2, corner: 2, emptyColor: '#000000' });

  assert.equal(g.dayLabels.length, 7);
  assert.deepEqual(g.dayLabels.map((d) => d.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  for (const d of g.dayLabels) assert.ok(Number.isFinite(d.y));

  assert.ok(g.monthLabels.length >= 3, 'multi-month span gets several labels');
  for (const m of g.monthLabels) {
    assert.match(m.label, /月$/);
    assert.ok(m.x >= 0 && m.x <= g.width);
  }
  for (let i = 1; i < g.monthLabels.length; i++) {
    assert.ok(g.monthLabels[i].col > g.monthLabels[i - 1].col, 'labels run left to right');
    assert.notEqual(g.monthLabels[i].label, g.monthLabels[i - 1].label, 'deduped per month');
  }

  const busiest = g.cells.filter((c) => c.value !== null).sort((a, b) => b.value - a.value)[0];
  assert.equal(busiest.value, g.max);
  assert.equal(busiest.fill, AREA_COLORS[5]);
  assert.equal(busiest.level, 5);
  const positive = g.cells.filter((c) => c.value !== null && c.value > 0);
  assert.ok(positive.every((c) => AREA_COLORS.includes(c.fill) && c.fill !== g.emptyColor));

  // an explicit max compresses the scale
  const clamped = buildHeatmapGeometry(heat, { max: 1000, emptyColor: '#000000' });
  const c1 = clamped.cells.filter((c) => c.value !== null && c.value > 0)[0];
  assert.equal(c1.level, 1, 'tiny values against a big max stay at level 1');
});

test('heatmap handles empty, null and out-of-range cells', () => {
  for (const input of [null, undefined, {}, { weeks: [] }, [], { days: [] }]) {
    const g = buildHeatmapGeometry(input, { cell: 10, gap: 2 });
    assert.ok(Array.isArray(g.cells) && g.cells.length === 0);
    assert.ok(Number.isFinite(g.width) && Number.isFinite(g.height));
    assert.equal(g.dayLabels.length, 7, 'weekday gutter survives an empty matrix');
    assert.ok(Array.isArray(g.monthLabels));
  }

  const heat = heatmapMatrix(mkDays(30));
  const g = buildHeatmapGeometry(heat, { cell: 10, gap: 2, emptyColor: '#000000' });
  const outside = g.cells.filter((c) => !c.inRange);
  assert.ok(outside.length > 0, 'the first/last grid weeks pad with out-of-range days');
  for (const c of outside) {
    assert.equal(c.fill, '#000000');
    assert.equal(c.value, null);
    assert.equal(c.level, 0);
    assert.ok(c.title.includes('–'));
  }
  // every week still contributes exactly 7 cells even when padded
  const byCol = new Map();
  for (const c of g.cells) byCol.set(c.col, (byCol.get(c.col) || 0) + 1);
  assert.equal(byCol.size, heat.weeks.length);
  for (const n of byCol.values()) assert.equal(n, 7);
});

test('heatmap reuses heatmapMatrix for raw day arrays', () => {
  const days = mkDays(45);
  const viaHelper = buildHeatmapGeometry(heatmapMatrix(days), { cell: 10, gap: 2 });
  const viaRaw = buildHeatmapGeometry(days, { cell: 10, gap: 2 });
  const viaDaysKey = buildHeatmapGeometry({ days }, { cell: 10, gap: 2 });
  assert.equal(viaRaw.cells.length, viaHelper.cells.length);
  assert.equal(viaDaysKey.cells.length, viaHelper.cells.length);
  assert.equal(viaRaw.max, viaHelper.max);
  assert.equal(viaRaw.max, heatmapMatrix(days).max);
  assert.deepEqual(
    viaRaw.cells.map((c) => c.fill),
    viaHelper.cells.map((c) => c.fill),
  );
});

test('heatmap corner/gutter options are accepted in both forms', () => {
  const heat = heatmapMatrix(mkDays(30));
  const asNumber = buildHeatmapGeometry(heat, { cell: 10, gap: 2, corner: 4 });
  assert.equal(asNumber.rx, 4, 'numeric corner = cell rounding');
  assert.equal(asNumber.cells[0].x, 24, 'default gutter kept');

  const asObject = buildHeatmapGeometry(heat, { cell: 10, gap: 2, corner: { top: 20, left: 40 } });
  assert.equal(asObject.cells[0].x, 40);
  assert.equal(asObject.cells[0].y, 20);
  assert.equal(asObject.monthLabels[0].x, 40);

  const explicit = buildHeatmapGeometry(heat, { cell: 8, gap: 1, radius: 3, gutter: { top: 12, left: 18 } });
  assert.equal(explicit.rx, 3);
  assert.equal(explicit.cells[1].x - explicit.cells[0].x, 0, 'row 0 untouched');
  assert.equal(explicit.width, 18 + heat.weeks.length * 9 - 1);
});

/* ------------------------------------------------------------------ *
 * gauge
 * ------------------------------------------------------------------ */

test('gaugeArc draws a 270 degree track and marks the 90% threshold', () => {
  const g = gaugeArc(0.42, { size: 132, stroke: 10 });
  assert.equal(g.cx, 66);
  assert.equal(g.cy, 66);
  assert.ok(g.r > 0 && g.r < 66);
  assert.equal(g.startDeg, 225);
  assert.equal(g.sweepDeg, 270);
  assert.match(g.trackPath, /^M /);
  assert.ok(g.trackPath.includes('A'));
  assert.ok(numsInPath(g.trackPath).every(Number.isFinite));
  assert.ok(!g.trackPath.includes('NaN'));

  assert.equal(g.threshold.value, 0.9);
  assert.equal(g.threshold.value, GAUGE_THRESHOLD);
  assert.ok(near(g.threshold.angleDeg, GAUGE_START_DEG - GAUGE_SWEEP_DEG * 0.9), 'tick sits at 90% of the sweep');
  assert.ok(numsInPath(g.threshold.path).every(Number.isFinite));
  // the tick crosses the arc: one foot inside the band, one outside
  const rOut = Math.hypot(g.threshold.x2 - g.cx, g.threshold.y2 - g.cy);
  const rIn = Math.hypot(g.threshold.x1 - g.cx, g.threshold.y1 - g.cy);
  assert.ok(rOut > g.r && rIn < g.r, 'tick straddles the stroke');

  const atThreshold = gaugeArc(0.9, { size: 132, stroke: 10 });
  assert.ok(near(atThreshold.angleDeg, atThreshold.threshold.angleDeg), 'p=0.9 lands on the tick angle');
  const expected = polar(atThreshold.cx, atThreshold.cy, atThreshold.r, atThreshold.threshold.angleDeg);
  const end = lastPointOfPath(atThreshold.path);
  assert.ok(near(end.x, expected.x) && near(end.y, expected.y), 'the arc ends exactly at the threshold');
});

test('gaugeArc angle tracks probability and clamps', () => {
  const size = { size: 100, stroke: 8 };
  assert.equal(gaugeArc(0, size).angleDeg, GAUGE_START_DEG);
  assert.equal(gaugeArc(0, size).path, '');
  assert.equal(gaugeArc(1, size).angleDeg, GAUGE_START_DEG - GAUGE_SWEEP_DEG);
  assert.equal(gaugeArc(0.5, size).angleDeg, 90);

  const half = gaugeArc(0.5, size);
  const top = polar(half.cx, half.cy, half.r, 90);
  const endHalf = lastPointOfPath(half.path);
  assert.ok(near(endHalf.x, top.x) && near(endHalf.y, top.y), 'p=0.5 ends at the top of the arc');

  assert.equal(gaugeArc(1.4, size).angleDeg, GAUGE_START_DEG - GAUGE_SWEEP_DEG, 'clamps above 1');
  assert.equal(gaugeArc(-0.4, size).path, '');
  assert.equal(gaugeArc(-0.4, size).angleDeg, GAUGE_START_DEG, 'clamps below 0');
  assert.match(gaugeArc(1, size).path, /A [\d.]+ [\d.]+ 0 1 1 /, '270 degree fill uses the large-arc flag');
});

test('gaugeArc survives null/garbage input and tiny sizes', () => {
  for (const bad of [null, undefined, NaN, 'x', {}, []]) {
    const g = gaugeArc(bad, { size: 120, stroke: 10 });
    assert.equal(g.path, '');
    assert.equal(g.p, null);
    assert.equal(g.probability, null);
    assert.equal(g.angleDeg, GAUGE_START_DEG);
    assert.ok(Number.isFinite(g.r) && g.r > 0);
    assert.ok(numsInPath(g.trackPath).every(Number.isFinite));
    assert.ok(Number.isFinite(g.threshold.x1) && Number.isFinite(g.threshold.y2));
  }
  const tiny = gaugeArc(0.5, { size: 2, stroke: 500 });
  assert.ok(Number.isFinite(tiny.r) && tiny.r >= 1);
  assert.ok(numsInPath(tiny.path).every(Number.isFinite));
  assert.ok(numsInPath(tiny.trackPath).every(Number.isFinite));
  const noOpts = gaugeArc(0.5);
  assert.equal(noOpts.size, 132);
  assert.ok(numsInPath(noOpts.path).every(Number.isFinite));
});

test('gaugeArc numeric from/to rescales, string from/to are echoed as colors', () => {
  const rescaled = gaugeArc(1.5, { size: 100, from: 1, to: 2 });
  assert.equal(rescaled.p, 0.5);
  assert.equal(rescaled.angleDeg, 90);

  const colored = gaugeArc(0.5, { size: 100, from: '#111', to: '#222' });
  assert.equal(colored.colorFrom, '#111');
  assert.equal(colored.colorTo, '#222');
  assert.equal(colored.angleDeg, 90, 'color strings must not be used as a domain');
  assert.equal(gaugeArc(0.5, { size: 100, from: 1, to: 1 }).p, 0.5, 'degenerate domain ignored');
});

/* ------------------------------------------------------------------ *
 * classify
 * ------------------------------------------------------------------ */

test('classifyProbability bands match the contract', () => {
  assert.equal(LIKELY_THRESHOLD, 0.9);
  for (const bad of [null, undefined, NaN, 'x', {}, [], Infinity]) {
    const r = classifyProbability(bad);
    assert.equal(r.level, 'unknown');
    assert.equal(r.tone, 'neutral');
    assert.equal(r.probability, null);
    assert.equal(typeof r.label, 'string');
  }

  const cases = [
    [0, 'quiet', 'calm'],
    [0.5, 'quiet', 'calm'],
    [0.7999, 'quiet', 'calm'],
    [0.8, 'watch', 'warn'],
    [0.85, 'watch', 'warn'],
    [0.8999, 'watch', 'warn'],
    [0.9, 'release-likely', 'danger'],
    [0.95, 'release-likely', 'danger'],
    [1, 'release-likely', 'danger'],
  ];
  for (const [p, level, tone] of cases) {
    const r = classifyProbability(p);
    assert.equal(r.level, level, `p=${p}`);
    assert.equal(r.tone, tone, `p=${p}`);
    assert.ok(TONES.includes(r.tone));
    assert.ok(r.label.length > 0 && r.labelEn.length > 0);
    assert.equal(r.probability, p);
  }
  assert.equal(classifyProbability('0.95').level, 'release-likely', 'numeric strings coerce');
});

test('toneColor resolves through the theme and never invents a color', () => {
  const theme = {
    label: '#aaaaaa',
    labelSecondary: '#bbbbbb',
    labelTertiary: '#cccccc',
    border: '#dddddd',
    accent: '#eeeeee',
    danger: '#ff0000',
    font: 'x',
  };
  assert.equal(toneColor('danger', theme), '#ff0000');
  assert.equal(toneColor('warn', theme), '#eeeeee');
  assert.equal(toneColor('calm', theme), '#bbbbbb');
  assert.equal(toneColor('neutral', theme), '#dddddd');
  assert.equal(toneColor('bogus', theme), '#dddddd');
  assert.equal(toneColor('danger', null), 'currentColor');
  assert.equal(toneColor('danger', {}), 'currentColor');
});

/* ------------------------------------------------------------------ *
 * frozen structural contracts
 * ------------------------------------------------------------------ */

test('charts.js imports nothing but the shared analytics core', () => {
  const src = readFileSync(CHARTS_PATH, 'utf8');
  const specs = [...src.matchAll(/^\s*import\s[\s\S]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(specs, ['../analytics.js']);
  assert.ok(!/from\s*['"]react['"]/.test(src), 'charts.js must not import react');
  assert.ok(!/\bdocument\.|\bwindow\./.test(src), 'charts.js must not touch the DOM');
  assert.ok(!/createElement/.test(src), 'charts.js stays framework-free');
});

test('classify.js is dependency free and importable', () => {
  const src = readFileSync(CLASSIFY_PATH, 'utf8');
  const specs = [...src.matchAll(/^\s*import\s[\s\S]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(specs, []);
  assert.equal(typeof classifyProbability, 'function');
});

test('views.js parses and exports the frozen components', () => {
  execFileSync(process.execPath, ['--check', VIEWS_PATH], { stdio: 'pipe' });
  const src = readFileSync(VIEWS_PATH, 'utf8');
  const names = [...src.matchAll(/export\s+function\s+([A-Za-z0-9_$]+)/g)].map((m) => m[1]);
  for (const want of [
    'LineChart', 'Heatmap', 'ProbabilityGauge', 'StatRow', 'EvidenceTable',
    'IconMonitor', 'DayDetail', 'MonitorCharts',
  ]) {
    assert.ok(names.includes(want), `views.js must export ${want}`);
  }
  assert.deepEqual(
    [...new Set([...src.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]))].sort(),
    ['./charts.js', './classify.js', 'react'],
  );
  assert.ok(!/from\s*['"][^'"]*\.css['"]/.test(src), 'no external CSS');
});
