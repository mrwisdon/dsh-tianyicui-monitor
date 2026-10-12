/**
 * tianyicui-monitor — pure SVG geometry, framework-free.
 *
 * Hard rules for this file (enforced by test/charts.test.mjs):
 *   - NO React, NO DOM, NO dependencies. The only import allowed is the shared
 *     analytics core, whose `heatmapMatrix()` is reused rather than reimplemented.
 *   - Every function is deterministic and side-effect free, so it can run in Node
 *     under `node --test` and inside the DSH browser bundle unchanged.
 *   - Colors are never invented here, with the single contractual exception of
 *     the green heatmap scale in AREA_COLORS. Everything else is passed in by the
 *     caller from the active `theme`.
 *
 * The caller renders the returned geometry as <svg>; nothing here touches an
 * element, a style sheet or a measurement API.
 */

import { heatmapMatrix } from '../analytics.js';

/* ------------------------------------------------------------------ *
 * palette + constants
 * ------------------------------------------------------------------ */

/**
 * Heatmap scale, light -> dark: index 0 is the "no activity" cell and indices
 * 1..5 are the five intensity levels used by `quantileColor`. This is the only
 * place in the client half where literal colors are permitted (CONTRACTS.md).
 */
export const AREA_COLORS = ['#ebedf0', '#c6e48b', '#7bc96f', '#40c463', '#30a14e', '#216e39'];

/** Number of intensity levels (excludes the empty level at index 0). */
export const HEAT_LEVELS = AREA_COLORS.length - 1;

/** Row order of the GitHub-style heatmap: Monday first. */
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Gauge sweep: starts lower-left, 270 degrees clockwise, gap at the bottom. */
export const GAUGE_START_DEG = 225;
export const GAUGE_SWEEP_DEG = 270;
/** Contractual 90% alert threshold marked on the gauge. */
export const GAUGE_THRESHOLD = 0.9;

const DEFAULT_AREA_PAD = { top: 10, right: 8, bottom: 18, left: 26 };
/** Label gutters for the heatmap: `top` for month labels, `left` for weekdays. */
export const DEFAULT_HEAT_GUTTER = { top: 14, left: 24 };
const DEFAULT_HEAT_RADIUS = 2;

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Round to 2dp for stable, comparable path strings (and no `-0`). */
function r2(value) {
  const v = Math.round(value * 100) / 100;
  return v === 0 ? 0 : v;
}

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/** Point on a circle; 0deg = east, angles increase counter-clockwise (math). */
function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy - r * Math.sin(a) };
}

/**
 * SVG arc path between two math angles. Decreasing angle sweeps clockwise on
 * screen (SVG y grows downward), hence a constant sweep-flag of 1.
 */
function arcPathBetween(cx, cy, r, fromDeg, toDeg) {
  const s = polar(cx, cy, r, fromDeg);
  const e = polar(cx, cy, r, toDeg);
  const largeArc = Math.abs(fromDeg - toDeg) > 180 ? 1 : 0;
  return `M ${r2(s.x)} ${r2(s.y)} A ${r2(r)} ${r2(r)} 0 ${largeArc} 1 ${r2(e.x)} ${r2(e.y)}`;
}

/** "Nice" axis step (1/2/5 * 10^k) for roughly `target` intervals. */
function niceStep(range, target = 3) {
  if (!(range > 0)) return 1;
  const raw = range / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

function fmtTick(v) {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) {
    const k = v / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(abs < 1 ? 2 : 1);
}

/** `YYYY-MM-DD` -> `MM-DD`; anything else is passed through unchanged. */
function shortDay(day) {
  const s = typeof day === 'string' ? day : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : s;
}

/**
 * Normalize the caller's daily points. Accepts both the contract shape
 * (`{day,...}`) and the raw `buildDailySeries` shape (`{key,...}`), and never
 * throws on null entries.
 */
function normalizePoints(dailyPoints) {
  if (!Array.isArray(dailyPoints)) return [];
  const out = [];
  for (const p of dailyPoints) {
    if (!p || typeof p !== 'object') continue;
    const tianyicui = num(p.tianyicui, 0);
    const all = num(p.all, num(p.allCommits, 0));
    out.push({
      day: typeof p.day === 'string' ? p.day : typeof p.key === 'string' ? p.key : '',
      tianyicui: tianyicui > 0 ? tianyicui : 0,
      all: all > 0 ? all : 0,
      isReleaseDay: p.isReleaseDay === true || (Array.isArray(p.releases) && p.releases.length > 0),
    });
  }
  return out;
}

function metricValue(point, series) {
  return series === 'all' ? point.all : point.tianyicui;
}

/**
 * Coerce whatever the caller holds into a heatmap matrix. The contract passes
 * the object returned by `heatmapMatrix()`, but a raw day array (or
 * `{days: [...]}`) is accepted too, and that is where the shared analytics
 * helper is used instead of duplicating the calendar bucketing logic here.
 */
function coerceHeat(heat) {
  const EMPTY = { weeks: [], max: 0, monthLabels: [] };
  if (!heat) return EMPTY;
  if (Array.isArray(heat)) return safeMatrix(heat);
  if (heat && Array.isArray(heat.days)) return safeMatrix(heat.days);
  if (heat && Array.isArray(heat.weeks)) return heat;
  return EMPTY;
}

function safeMatrix(days) {
  try {
    const m = heatmapMatrix(days);
    return m && Array.isArray(m.weeks) ? m : { weeks: [], max: 0, monthLabels: [] };
  } catch (_err) {
    return { weeks: [], max: 0, monthLabels: [] };
  }
}

/* ------------------------------------------------------------------ *
 * color scale
 * ------------------------------------------------------------------ */

/**
 * Map a value onto a linear quantile scale of `colors`.
 * `colors[0]` is the empty level, `colors[colors.length - 1]` the darkest.
 * Null / non-numeric / non-positive values and a non-positive `max` degrade
 * gracefully instead of producing NaN indices.
 *
 * @param {number|null|undefined} value
 * @param {number} max
 * @param {string[]} [colors] defaults to AREA_COLORS
 * @returns {string} a CSS color string
 */
export function quantileColor(value, max, colors) {
  const palette = Array.isArray(colors) && colors.length >= 2 ? colors : AREA_COLORS;
  const empty = palette[0];
  const top = palette[palette.length - 1];
  const levels = palette.length - 1;

  const v = typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (v === null || v <= 0) return empty;

  const m = num(max, 0);
  if (!(m > 0)) return top;

  const ratio = clamp(v / m, 0, 1);
  const idx = clamp(Math.ceil(ratio * levels), 1, levels);
  return palette[idx];
}

/** Intensity level (1..5) implied by `quantileColor`; 0 = empty level. */
export function quantileLevel(value, max, colors) {
  const palette = Array.isArray(colors) && colors.length >= 2 ? colors : AREA_COLORS;
  const fill = quantileColor(value, max, palette);
  const idx = palette.indexOf(fill);
  return idx < 0 ? 0 : idx;
}

/* ------------------------------------------------------------------ *
 * area / line chart
 * ------------------------------------------------------------------ */

/**
 * Area chart layout for the commit series.
 *
 * @param {Array} dailyPoints `{day,tianyicui,all,isReleaseDay}`
 * @param {object} [opts] `{width,height,pad,series,axisColor,gridColor,lineColor,fillFrom,fillTo,idSuffix}`
 *        (colors are accepted for signature compatibility and are applied by the
 *        caller, not by this pure geometry pass)
 * @returns {{width:number,height:number,pad:object,plot:object,series:string,
 *            max:number,niceMax:number,step:number,points:Array,
 *            xTicks:Array,yTicks:Array,gridLines:Array}}
 */
export function buildAreaGeometry(dailyPoints, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const width = Math.max(0, num(o.width, 380));
  const height = Math.max(0, num(o.height, 120));
  const padIn = o.pad && typeof o.pad === 'object' ? o.pad : {};
  const pad = {
    top: num(padIn.top, DEFAULT_AREA_PAD.top),
    right: num(padIn.right, DEFAULT_AREA_PAD.right),
    bottom: num(padIn.bottom, DEFAULT_AREA_PAD.bottom),
    left: num(padIn.left, DEFAULT_AREA_PAD.left),
  };
  const series = o.series === 'all' ? 'all' : 'tianyicui';

  const plot = {
    x0: Math.max(0, pad.left),
    y0: Math.max(0, pad.top),
    x1: Math.max(0, width - pad.right),
    y1: Math.max(0, height - pad.bottom),
  };
  if (plot.x1 < plot.x0) plot.x1 = plot.x0;
  if (plot.y1 < plot.y0) plot.y1 = plot.y0;

  const pts = normalizePoints(dailyPoints);
  const values = pts.map((p) => metricValue(p, series));
  const max = values.reduce((a, b) => (b > a ? b : a), 0);

  // Axis scale: a flat all-zero series still gets a readable 0..1 axis.
  let niceMax;
  let step;
  if (max > 0) {
    step = niceStep(max, 3);
    niceMax = Math.max(step, Math.ceil(max / step) * step);
  } else {
    step = 1;
    niceMax = 1;
  }

  const spanX = plot.x1 - plot.x0;
  const spanY = plot.y1 - plot.y0;
  const n = pts.length;

  const xAt = (i) => {
    if (n <= 1) return plot.x0 + spanX / 2;
    return plot.x0 + (spanX * i) / (n - 1);
  };
  const yAt = (v) => plot.y1 - (clamp(v, 0, niceMax) / niceMax) * spanY;

  const points = pts.map((p, i) => ({
    x: xAt(i),
    y: yAt(values[i]),
    value: values[i],
    day: p.day,
    index: i,
    isReleaseDay: p.isReleaseDay,
    tianyicui: p.tianyicui,
    all: p.all,
  }));

  // Y axis: top (niceMax) -> bottom (0), so screen y ascends while values descend.
  const steps = Math.max(1, Math.round(niceMax / step));
  const yTicks = [];
  const gridLines = [];
  for (let i = 0; i <= steps; i++) {
    const value = r2(niceMax - i * step);
    const y = yAt(value);
    const tick = { y, value, label: fmtTick(value) };
    yTicks.push(tick);
    gridLines.push({ y, value });
  }

  const xTicks = [];
  if (n > 0) {
    const idxs = n === 1 ? [0] : [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
    for (const i of [...new Set(idxs)].sort((a, b) => a - b)) {
      xTicks.push({ x: xAt(i), label: shortDay(pts[i].day), index: i, day: pts[i].day });
    }
  }

  return {
    width,
    height,
    pad,
    plot,
    series,
    max,
    niceMax,
    step,
    points,
    xTicks,
    yTicks,
    gridLines,
    count: n,
  };
}

/**
 * Closed area path (`d`) for the series, ready to fill. Returns '' when there is
 * nothing to draw, and a visible 1.5-unit-wide sliver for a single point.
 */
export function buildAreaPath(dailyPoints, opts) {
  const g = buildAreaGeometry(dailyPoints, opts);
  if (!g.points.length) return '';
  const base = g.plot.y1;

  if (g.points.length === 1) {
    const p = g.points[0];
    const half = Math.max(0.5, Math.min(0.75, (g.plot.x1 - g.plot.x0) / 4 || 0.75));
    const xa = clamp(p.x - half, g.plot.x0, g.plot.x1);
    const xb = clamp(p.x + half, g.plot.x0, g.plot.x1);
    return `M ${r2(xa)} ${r2(base)} L ${r2(xa)} ${r2(p.y)} L ${r2(xb)} ${r2(p.y)} L ${r2(xb)} ${r2(base)} Z`;
  }

  const parts = [`M ${r2(g.points[0].x)} ${r2(base)}`];
  for (const p of g.points) parts.push(`L ${r2(p.x)} ${r2(p.y)}`);
  const last = g.points[g.points.length - 1];
  parts.push(`L ${r2(last.x)} ${r2(base)}`);
  parts.push('Z');
  return parts.join(' ');
}

/** Open polyline path (`d`) for the same series — the stroked line on top. */
export function buildLinePath(dailyPoints, opts) {
  const g = buildAreaGeometry(dailyPoints, opts);
  if (!g.points.length) return '';
  return g.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${r2(p.x)} ${r2(p.y)}`)
    .join(' ');
}

/** Screen x for every release day, for the dashed vertical markers. */
export function releaseMarkers(dailyPoints, opts) {
  const g = buildAreaGeometry(dailyPoints, opts);
  return g.points
    .filter((p) => p.isReleaseDay)
    .map((p) => ({ x: p.x, day: p.day, y0: g.plot.y0, y1: g.plot.y1 }));
}

/* ------------------------------------------------------------------ *
 * heatmap
 * ------------------------------------------------------------------ */

/**
 * GitHub-style contribution grid: 7 rows (Mon..Sun) x one column per week.
 *
 * `opts.corner` as a NUMBER is the cell corner radius (`rx`); as an OBJECT it
 * overrides the label gutters (`{top,left}`). Gutters can also be passed
 * explicitly via `opts.gutter`. Every week always yields exactly 7 cells, even
 * for days outside the tracked range.
 *
 * @param {object|Array} heat `{weeks,max,monthLabels}` from heatmapMatrix()
 * @param {object} [opts] `{cell,gap,corner,gutter,max,colors,emptyColor}`
 * @returns {{width:number,height:number,cells:Array,monthLabels:Array,dayLabels:Array,
 *            max:number,colors:string[],emptyColor:string,rx:number,cell:number,gap:number}}
 */
export function buildHeatmapGeometry(heat, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const h = coerceHeat(heat);
  const weeks = Array.isArray(h.weeks) ? h.weeks : [];

  const colors = Array.isArray(o.colors) && o.colors.length >= 2 ? o.colors : AREA_COLORS;
  const cell = Math.max(1, num(o.cell, 10));
  const gap = Math.max(0, num(o.gap, 2));
  const pitch = cell + gap;

  let gutter = { ...DEFAULT_HEAT_GUTTER };
  if (o.gutter && typeof o.gutter === 'object') {
    gutter = { top: num(o.gutter.top, gutter.top), left: num(o.gutter.left, gutter.left) };
  }
  let rx = num(o.radius, DEFAULT_HEAT_RADIUS);
  if (typeof o.corner === 'number' && Number.isFinite(o.corner)) {
    rx = Math.max(0, o.corner);
  } else if (o.corner && typeof o.corner === 'object') {
    gutter = { top: num(o.corner.top, gutter.top), left: num(o.corner.left, gutter.left) };
  }
  rx = Math.max(0, Math.min(rx, cell / 2));

  const emptyColor = typeof o.emptyColor === 'string' && o.emptyColor ? o.emptyColor : colors[0];
  const max = num(o.max, num(h.max, 0));

  const colCount = weeks.length;
  const width = colCount ? gutter.left + colCount * pitch - gap : gutter.left;
  const height = colCount ? gutter.top + 7 * pitch - gap : gutter.top;

  const cells = [];
  for (let wi = 0; wi < colCount; wi++) {
    const col = Array.isArray(weeks[wi]) ? weeks[wi] : [];
    for (let di = 0; di < 7; di++) {
      const src = col[di] && typeof col[di] === 'object' ? col[di] : {};
      const value = typeof src.value === 'number' && Number.isFinite(src.value) ? src.value : null;
      const inRange = src.inRange === undefined ? value !== null : src.inRange === true;
      const known = inRange && value !== null;
      const key = typeof src.key === 'string' && src.key ? src.key : `${wi}:${di}`;
      const fill = known ? quantileColor(value, max, colors) : emptyColor;
      const level = known ? quantileLevel(value, max, colors) : 0;
      cells.push({
        key,
        value: known ? value : null,
        x: gutter.left + wi * pitch,
        y: gutter.top + di * pitch,
        size: cell,
        rx,
        fill,
        level,
        row: di,
        col: wi,
        inRange,
        title: `${key} · ${known ? value : '–'}`,
      });
    }
  }

  // Month labels: one per month change, derived from the analytics labels when
  // present, else reconstructed from the column's first day.
  const srcLabels = Array.isArray(h.monthLabels) ? h.monthLabels : [];
  const monthLabels = [];
  let prevLabel = null;
  for (let wi = 0; wi < colCount; wi++) {
    let label = srcLabels[wi] && typeof srcLabels[wi].label === 'string' ? srcLabels[wi].label : null;
    if (!label) {
      const col = Array.isArray(weeks[wi]) ? weeks[wi] : [];
      const startMs = col[0] && num(col[0].start, NaN);
      if (Number.isFinite(startMs)) label = `${new Date(startMs).getUTCMonth() + 1}月`;
    }
    if (!label) continue;
    if (wi === 0 || label !== prevLabel) {
      monthLabels.push({ x: gutter.left + wi * pitch, label, col: wi });
    }
    prevLabel = label;
  }

  const dayLabels = DAY_NAMES.map((label, di) => ({
    y: gutter.top + di * pitch + cell / 2,
    label,
    row: di,
  }));

  return {
    width,
    height,
    cells,
    monthLabels,
    dayLabels,
    max,
    colors,
    emptyColor,
    rx,
    cell,
    gap,
    gutter,
    weeks: colCount,
  };
}

/* ------------------------------------------------------------------ *
 * probability gauge
 * ------------------------------------------------------------------ */

/**
 * 270 degree gauge arc for the "new release within 72h" probability.
 *
 * `opts.from`/`opts.to` are overloaded on purpose: numeric values rescale the
 * probability domain (so a 0.9 threshold can be drawn on an axis that starts at
 * a base rate), while strings are treated as the caller's gradient colors and
 * echoed back as `colorFrom`/`colorTo`.
 *
 * @param {number|null} probability 0..1 (clamped)
 * @param {object} [opts] `{size,stroke,from,to}`
 * @returns {{path:string,trackPath:string,angleDeg:number,cx:number,cy:number,r:number,
 *            p:number|null,probability:number|null,startDeg:number,sweepDeg:number,
 *            stroke:number,size:number,threshold:object,colorFrom:string|undefined,
 *            colorTo:string|undefined}}
 */
export function gaugeArc(probability, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const size = Math.max(20, num(o.size, 132));
  const stroke = Math.max(1, num(o.stroke, 10));
  const cx = size / 2;
  const cy = size / 2;
  // Leave room for the threshold tick and its stroke.
  const r = Math.max(1, size / 2 - stroke / 2 - 6);

  const from = o.from;
  const to = o.to;
  const colorFrom = typeof from === 'string' ? from : undefined;
  const colorTo = typeof to === 'string' ? to : undefined;
  const domain =
    typeof from === 'number' && typeof to === 'number' && Number.isFinite(from) && Number.isFinite(to) && to !== from
      ? [from, to]
      : null;

  const raw = typeof probability === 'number' && Number.isFinite(probability) ? probability : null;
  let p = raw;
  if (p !== null && domain) p = (p - domain[0]) / (domain[1] - domain[0]);
  if (p !== null) p = clamp(p, 0, 1);

  const angleDeg = GAUGE_START_DEG - GAUGE_SWEEP_DEG * (p === null ? 0 : p);
  const trackPath = arcPathBetween(cx, cy, r, GAUGE_START_DEG, GAUGE_START_DEG - GAUGE_SWEEP_DEG);
  const path = p === null || p <= 0 ? '' : arcPathBetween(cx, cy, r, GAUGE_START_DEG, angleDeg);

  const tickAngle = GAUGE_START_DEG - GAUGE_SWEEP_DEG * GAUGE_THRESHOLD;
  const rTickOut = r + stroke / 2 + 2;
  const rTickIn = Math.max(2, r - stroke / 2 - 2);
  const tOut = polar(cx, cy, rTickOut, tickAngle);
  const tIn = polar(cx, cy, rTickIn, tickAngle);
  const threshold = {
    value: GAUGE_THRESHOLD,
    angleDeg: tickAngle,
    x1: r2(tIn.x),
    y1: r2(tIn.y),
    x2: r2(tOut.x),
    y2: r2(tOut.y),
    path: `M ${r2(tIn.x)} ${r2(tIn.y)} L ${r2(tOut.x)} ${r2(tOut.y)}`,
  };

  return {
    path,
    trackPath,
    angleDeg,
    cx,
    cy,
    r,
    p,
    probability: raw,
    startDeg: GAUGE_START_DEG,
    sweepDeg: GAUGE_SWEEP_DEG,
    stroke,
    size,
    threshold,
    colorFrom,
    colorTo,
  };
}
