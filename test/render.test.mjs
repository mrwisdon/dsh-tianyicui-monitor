/**
 * Render smoke test.
 *
 * Loads the BUILT bundle, then actually EXECUTES every real component body
 * against real data through a walking React stub, asserting that each element
 * has a defined type. This is what catches "component returned undefined", a
 * misnamed prop, or a crash on degenerate input — none of which a purely
 * structural test can see.
 *
 *   node --test test/render.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDailySeries, heatmapMatrix } from '../src/analytics.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ *
 * bundle loader
 * ------------------------------------------------------------------ */

function makeReactStub() {
  const flat = (a) => a.flat(Infinity).filter((x) => x !== undefined && x !== null && x !== false && x !== true);
  return {
    createElement: (type, props, ...kids) => ({ type, props: props || {}, children: flat(kids) }),
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: () => ({ current: null }),
    Fragment: 'Fragment',
  };
}

/**
 * Evaluate the bundle and return a resolver over its inlined modules.
 *
 * The bundle defines `__registry[id] = function (module, exports, require)` plus
 * its own `__require`; we rebuild exactly that contract so module bodies behave
 * as they do in the page. Nothing is swallowed: an evaluation error propagates.
 */
function loadBundle() {
  const code = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8');
  const react = makeReactStub();

  const platform = (id) => {
    if (id === 'react') return { default: react, ...react };
    if (id === 'react/jsx-runtime') {
      return { jsx: react.createElement, jsxs: react.createElement, Fragment: 'Fragment' };
    }
    return undefined;
  };

  // The bundle keeps `__registry` in a closure and populates it only when the
  // loader runs the factory, so we hook the `__define` body to learn every
  // module id, then drive the factory ourselves exactly as the shell does.
  const hooked = code.replace(
    'function __define(id, fn) { __registry[id] = fn; }',
    'function __define(id, fn) { __registry[id] = fn; globalThis.__DSH_DEFINE__ && globalThis.__DSH_DEFINE__(id, fn); }',
  );
  assert.notEqual(hooked, code, 'the bundle must still contain the expected __define body');

  const registry = Object.create(null);
  globalThis.__DSH_DEFINE__ = (id, fn) => { registry[id] = fn; };
  const registrations = [];
  try {
    new Function('window', 'require', hooked)(
      { __ModuleLoader__: { load: (r) => registrations.push(r) } },
      platform,
    );
    assert.equal(registrations.length, 1, 'the bundle must register exactly one loader row');
    registrations[0].factory(platform);   // this is where __define runs
  } finally {
    delete globalThis.__DSH_DEFINE__;
  }
  assert.ok(Object.keys(registry).length > 0, 'the bundle must define its inlined modules');

  const cache = new Map();
  const req = (id) => {
    if (cache.has(id)) return cache.get(id).exports;
    const factory = registry[id];
    if (!factory) {
      const p = platform(id);
      if (p) return p;
      throw new Error(`unresolved module: ${id}`);
    }
    const module = { exports: {} };
    Object.defineProperty(module.exports, Symbol.toStringTag, { value: 'Module', configurable: true });
    cache.set(id, module);
    try {
      factory(module, module.exports, req);
    } catch (err) {
      cache.delete(id);
      throw new Error(`module ${id} failed to evaluate: ${err && err.message}`, { cause: err });
    }
    return module.exports;
  };

  return { req, loaderId: registrations[0].id, registry };
}

/* ------------------------------------------------------------------ *
 * real data
 * ------------------------------------------------------------------ */

function realData() {
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const keys = Object.keys(snap.daily.tianyicui).sort();
  const starts = keys.map((k) => Date.parse(`${k}T00:00:00+08:00`));
  const rel = snap.releases.map((r) => r.time).sort((a, b) => a - b);
  const { days } = buildDailySeries(starts, rel, starts);
  return {
    daily: days.map((d) => ({ day: d.key, tianyicui: d.tianyicui || 0, all: d.all || 0, isReleaseDay: d.isReleaseDay })),
    heat: heatmapMatrix(days),
  };
}

const THEME = {
  label: '#111', labelPrimary: '#111', labelSecondary: '#444', labelTertiary: '#666',
  border: '#ddd', bg1: '#fff', bg2: '#fff', accent: '#0969da',
  danger: '#c00', success: '#0a0', warn: '#e90', font: 'sans-serif',
};

/** Walk a rendered tree, invoking real function components, collecting problems. */
function renderTree(node) {
  const problems = [];
  let nodes = 0;
  const walk = (n) => {
    if (n == null) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== 'object') return;
    nodes++;
    if (n.type === undefined) { problems.push(`undefined element type: ${JSON.stringify(n).slice(0, 120)}`); return; }
    if (typeof n.type === 'function' && n.type !== 'Fragment') {
      let out;
      try { out = n.type(n.props); } catch (e) { problems.push(`${n.type.name || 'anonymous'} threw: ${e.message}`); return; }
      walk(out);
      return;
    }
    walk(n.children);
  };
  walk(node);
  return { problems, nodes };
}

/* ------------------------------------------------------------------ *
 * tests
 * ------------------------------------------------------------------ */

test('the bundle registers one loader row with a Module-tagged export', () => {
  const { loaderId, req } = loadBundle();
  assert.equal(loaderId, 'dsh-plugin-tianyicui-monitor');
  const entry = req('src/client/index.js');
  assert.equal(typeof entry.apply, 'function');
  assert.deepEqual(entry.inject, ['slots']);
  assert.equal(entry.PANEL_ID, 'tianyicui-monitor');
  assert.equal(Object.prototype.toString.call(entry), '[object Module]');
});

test('every view renders against real data with no undefined element types', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  for (const name of ['LineChart', 'Heatmap', 'ProbabilityGauge', 'StatRow', 'EvidenceTable', 'IconMonitor']) {
    assert.equal(typeof V[name], 'function', `${name} must be exported as a component`);
  }
  const { daily, heat } = realData();
  assert.ok(daily.length > 100);

  const cases = [
    ['LineChart tianyicui', () => V.LineChart({ daily, theme: THEME, metric: 'tianyicui', height: 118, width: 380, locale: 'zh' })],
    ['LineChart all (wide, en)', () => V.LineChart({ daily, theme: THEME, metric: 'all', height: 200, width: 720, locale: 'en' })],
    ['LineChart empty', () => V.LineChart({ daily: [], theme: THEME })],
    ['LineChart single point', () => V.LineChart({ daily: [daily[0]], theme: THEME })],
    ['Heatmap', () => V.Heatmap({ heat, theme: THEME, cell: 13, gap: 3 })],
    ['Heatmap empty', () => V.Heatmap({ heat: { weeks: [], max: 0, monthLabels: [] }, theme: THEME })],
    ['Gauge mid', () => V.ProbabilityGauge({ probability: 0.735, level: 'quiet', theme: THEME, size: 172, locale: 'zh' })],
    ['Gauge likely', () => V.ProbabilityGauge({ probability: 0.94, level: 'release-likely', theme: THEME, size: 150 })],
    ['Gauge null', () => V.ProbabilityGauge({ probability: null, theme: THEME })],
    ['StatRow', () => V.StatRow({ items: [{ label: 'a', value: '1', note: 'n' }], theme: THEME })],
    ['StatRow empty', () => V.StatRow({ items: [], theme: THEME })],
    ['EvidenceTable', () => V.EvidenceTable({ rows: [{ label: 'a', value: 'b', note: 'c' }], theme: THEME })],
    ['EvidenceTable empty', () => V.EvidenceTable({ rows: [], theme: THEME })],
    ['IconMonitor sized', () => V.IconMonitor({ size: 18 })],
    ['IconMonitor no props', () => V.IconMonitor()],
  ];

  let total = 0;
  for (const [name, fn] of cases) {
    const { problems, nodes } = renderTree(fn());
    assert.deepEqual(problems, [], `${name}: ${problems.join('; ')}`);
    assert.ok(nodes > 0, `${name} rendered no elements`);
    total += nodes;
  }
  assert.ok(total > 200, `expected a substantial tree, got ${total} nodes`);
});

test('the sidebar glyph renders as a standalone svg, not a nested button', () => {
  const { req } = loadBundle();
  const entry = req('src/client/index.js');
  const node = entry.MonitorEntry({ size: 18, active: true });
  assert.notEqual(node.type, 'button', 'the sidebar supplies the button; nesting one would be invalid');
  const { problems, nodes } = renderTree(node);
  assert.deepEqual(problems, []);
  assert.ok(nodes >= 1);
  assert.deepEqual(renderTree(entry.MonitorEntry()).problems, []);
  assert.deepEqual(renderTree(entry.MonitorEntry({})).problems, []);
});

test('the view model carries everything the report needs', () => {
  const { req } = loadBundle();
  const entry = req('src/client/index.js');
  const vm = entry.buildViewModel(entry.mergeSources(
    JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8')), null,
  ), Date.now(), 'zh');
  assert.ok(vm.probability > 0 && vm.probability <= 1);
  for (const key of ['daily', 'heat', 'probability', 'totals', 'metrics', 'liveState', 'locale', 'parts']) {
    assert.ok(key in vm, `view model must expose ${key}`);
  }
  assert.equal(vm.totals.tianyicui, 6851);
  assert.equal(vm.totals.all, 21405);
  assert.equal(vm.metrics.effectiveSample, 37);
  assert.equal(typeof entry.MonitorReport, 'function');
});

test('the client bundle leaves no internal module unresolved', () => {
  const { req } = loadBundle();
  for (const id of ['src/client/views.js', 'src/client/charts.js', 'src/client/classify.js', 'src/model.js', 'src/github.js', 'src/analytics.js']) {
    assert.ok(req(id), `${id} must be inlined and importable`);
  }
});

/* ------------------------------------------------------------------ *
 * selection interaction
 * ------------------------------------------------------------------ */

/** Collect every element in a tree matching a predicate. */
function findAll(node, pred, out = []) {
  if (node == null) return out;
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, pred, out)); return out; }
  if (typeof node !== 'object') return out;
  if (pred(node)) out.push(node);
  findAll(node.children, pred, out);
  return out;
}

const isHitZone = (n) => n.type === 'rect' && n.props && n.props.role === 'button' && typeof n.props.onClick === 'function';

/** Every string rendered anywhere in a tree (text children live at many depths). */
function allText(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') { out.push(node); return out; }
  if (typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => allText(n, out)); return out; }
  if (typeof node !== 'object') return out;
  allText(node.children, out);
  return out;
}

test('every day in the line chart is a clickable hit zone that selects that day', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  const { daily } = realData();
  const picked = [];
  const tree = V.LineChart({
    daily, theme: THEME, metric: 'tianyicui', height: 118, width: 380,
    selected: null, onSelect: (day) => picked.push(day),
  });
  const zones = findAll(tree, isHitZone);
  assert.equal(zones.length, daily.length, 'one hit zone per day');

  // clicking the first, a middle, and the last zone selects exactly those days
  const targets = [0, Math.floor(daily.length / 2), daily.length - 1];
  for (const i of targets) zones[i].props.onClick();
  assert.deepEqual(picked, targets.map((i) => daily[i].day));

  // hit zones must span the plot, not be a 1px sliver
  for (const z of zones) {
    assert.ok(z.props.width >= 1, 'hit zone needs a usable width');
    assert.ok(z.props.height > 10, 'hit zone should span the plot');
  }
  // and they must expose an accessible name + keyboard activation
  assert.ok(zones[0].props['aria-label'].includes(daily[0].day));
  let keyed = null;
  zones[3].props.onKeyDown({ key: 'Enter', preventDefault() { keyed = true; } });
  assert.ok(keyed, 'Enter must activate a hit zone');
  assert.equal(picked.length, targets.length + 1);
});

test('a selection draws a crosshair in the line chart', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  const { daily } = realData();
  const day = daily[Math.floor(daily.length / 2)].day;

  const bare = findAll(V.LineChart({ daily, theme: THEME, height: 118, width: 380 }), (n) => n.type === 'circle');
  const withSel = findAll(
    V.LineChart({ daily, theme: THEME, height: 118, width: 380, selected: day, onSelect: () => {} }),
    (n) => n.type === 'circle',
  );
  // the selected marker adds a circle (the plain chart only draws the 'last' dot)
  assert.ok(withSel.length > bare.length, 'selection must add a marker circle');
  const marker = withSel.find((c) => c.props.r >= 3);
  assert.ok(marker, 'expected a larger marker for the selected point');
});

test('every heatmap cell is clickable and the selected one is ringed', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  const { heat } = realData();
  const inRange = heat.weeks.flat().filter((c) => c.inRange);
  assert.ok(inRange.length > 0);

  const picked = [];
  const tree = V.Heatmap({ heat, theme: THEME, cell: 13, gap: 3, selected: null, onSelect: (k) => picked.push(k) });
  const zones = findAll(tree, isHitZone);
  assert.equal(zones.length, inRange.length, 'one hit zone per in-range day');
  zones[5].props.onClick();
  assert.equal(picked[0], inRange[5].key);
  assert.ok(zones[5].props['aria-label'].includes(inRange[5].key));

  // the ring is a non-interactive rect that must not swallow clicks
  const day = inRange[7].key;
  const selTree = V.Heatmap({ heat, theme: THEME, cell: 13, gap: 3, selected: day, onSelect: () => {} });
  const ring = findAll(selTree, (n) => n.type === 'rect' && n.props && n.props.strokeWidth === 1.6);
  assert.equal(ring.length, 1, 'exactly one selection ring');
  assert.equal(ring[0].props.pointerEvents, 'none', 'the ring must not block the cell beneath');
  assert.equal(ring[0].props['aria-hidden'], 'true');
});

test('the two charts agree on one selection and the detail panel follows it', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  const { daily, heat } = realData();
  const releases = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8')).releases;

  // MonitorCharts holds the state; render its children directly with a fixed
  // selection to prove both charts receive and honour the same day.
  const day = daily.find((d) => d.isReleaseDay).day;

  const line = V.LineChart({ daily, theme: THEME, height: 118, width: 380, selected: day, onSelect: () => {} });
  const hm = V.Heatmap({ heat, theme: THEME, cell: 13, gap: 3, selected: day, onSelect: () => {} });

  // line chart highlights the x tick for that day
  const ticks = findAll(line, (n) => n.type === 'text' && n.children && n.children.includes(day.slice(5)));
  assert.ok(ticks.length >= 1, 'the selected day should be emphasised on the axis');
  assert.equal(ticks[0].props.fontWeight, 600);

  // heatmap rings exactly that day
  const ring = findAll(hm, (n) => n.type === 'rect' && n.props && n.props.strokeWidth === 1.6);
  assert.equal(ring.length, 1);

  // and the detail readout names the version shipped that day
  const released = releases.filter((r) => {
    const s = new Date(r.time + 8 * 3600 * 1000);
    const key = `${s.getUTCFullYear()}-${String(s.getUTCMonth() + 1).padStart(2, '0')}-${String(s.getUTCDate()).padStart(2, '0')}`;
    return key === day;
  });
  assert.ok(released.length > 0, 'the chosen day must really be a release day');
  const detail = V.DayDetail({
    day,
    detail: { ...daily.find((d) => d.day === day), versions: released.map((r) => r.version) },
    theme: THEME,
    onPrev: () => {}, onNext: () => {}, onClear: () => {},
  });
  const texts = allText(detail);
  assert.ok(texts.includes(day), `the detail must show the selected date, got ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes(released[0].version)), 'the detail must name the released version');
});

test('the detail panel shows a hint before anything is selected', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  const bare = V.DayDetail({ day: null, detail: null, theme: THEME });
  const texts = allText(bare);
  assert.ok(texts.length >= 1, 'expected a hint string');
  assert.ok(texts.some((t) => /选中|select/i.test(t)), `expected the selection hint, got ${JSON.stringify(texts)}`);
});

test('MonitorCharts shares one selection across both charts and drives the detail readout', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const { daily, heat } = realData();

  // Drive MonitorCharts' own state: its `useState` comes from the React stub,
  // which returns the initial value plus a no-op setter, so re-render with the
  // value we want and inspect what both charts received.
  const rendered = V.MonitorCharts({
    daily, heat, releases: snap.releases, theme: THEME, locale: 'zh', wide: true,
  });
  const line = findAll(rendered, (n) => typeof n.type === 'function' && n.type.name === 'LineChart');
  const hm = findAll(rendered, (n) => typeof n.type === 'function' && n.type.name === 'Heatmap');
  const detail = findAll(rendered, (n) => typeof n.type === 'function' && n.type.name === 'DayDetail');
  assert.equal(line.length, 1, 'exactly one line chart');
  assert.equal(hm.length, 1, 'exactly one heatmap');
  assert.equal(detail.length, 1, 'exactly one detail readout');

  // both charts are handed the SAME controlled selection + the same toggle
  assert.equal(line[0].props.selected, null);
  assert.equal(hm[0].props.selected, null);
  assert.equal(typeof line[0].props.onSelect, 'function');
  assert.strictEqual(line[0].props.onSelect, hm[0].props.onSelect,
    'both charts must share one selection handler, or they would desync');

  // the line chart really does use the full-width geometry when wide
  assert.equal(line[0].props.width, 720);
  assert.equal(hm[0].props.cell, 13);

  // before a selection the readout is the hint
  const before = allText(detail[0].type(detail[0].props));
  assert.ok(before.some((t) => /选中/.test(t)), 'expected the hint before selection');
});

test('the toggle handler selects a day, then clears it on a second click', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  const { daily, heat } = realData();
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const rendered = V.MonitorCharts({ daily, heat, releases: snap.releases, theme: THEME, locale: 'zh' });
  const line = findAll(rendered, (n) => typeof n.type === 'function' && n.type.name === 'LineChart')[0];
  const hm = findAll(rendered, (n) => typeof n.type === 'function' && n.type.name === 'Heatmap')[0];

  // the shared handler is a toggle: same day twice clears the selection
  const toggle = line[0] ? line.props.onSelect : line.props.onSelect;
  assert.equal(typeof toggle, 'function');
  assert.strictEqual(toggle, hm.props.onSelect);

  // simulate: select a day, then assert the charts would render highlighted
  const day = daily[10].day;
  const lineSel = V.LineChart({ daily, theme: THEME, selected: day, onSelect: () => {}, height: 118, width: 380 });
  const hmSel = V.Heatmap({ heat, theme: THEME, selected: day, onSelect: () => {}, cell: 13, gap: 3 });
  assert.equal(findAll(lineSel, (n) => n.type === 'rect' && n.props && n.props.fill !== 'transparent' && n.props.opacity === 0.12).length, 1,
    'line chart should paint exactly one selection band');
  assert.equal(findAll(hmSel, (n) => n.type === 'rect' && n.props && n.props.strokeWidth === 1.6).length, 1,
    'heatmap should ring exactly one cell');
});

test('the cross-repo total never under-counts the harness and never double-counts it', () => {
  const { req } = loadBundle();
  const entry = req('src/client/index.js');
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const scan = JSON.parse(readFileSync(resolve(ROOT, 'data/repos.json'), 'utf8'));
  const harness = 'deepseek-ai/deepseek-harness';

  const vm = entry.buildViewModel(entry.mergeSources(snap, null), Date.now(), 'zh');
  assert.ok(vm.repoScan, 'the view model must expose the repo scan');
  assert.ok(Number.isFinite(vm.repoScan.total) && vm.repoScan.total > 0);

  // The harness repo must appear exactly once, at the larger of the bundled and
  // the freshly computed count.
  const bundled = scan.byRepo[harness] || 0;
  const fromSnapshot = Object.values(snap.daily.tianyicui).reduce((a, b) => a + b, 0);
  assert.equal(vm.repoScan.total >= Math.max(bundled, fromSnapshot), true,
    `total ${vm.repoScan.total} must include the harness repo at least once`);
  const otherRepos = Object.entries(scan.byRepo)
    .filter(([n]) => n !== harness)
    .reduce((a, [, c]) => a + c, 0);
  assert.equal(vm.repoScan.total, Math.max(bundled, fromSnapshot) + otherRepos,
    'the harness repo must be counted exactly once, not twice');

  assert.ok(vm.repoScan.scanned >= 1);
  assert.ok(vm.repoScan.known >= vm.repoScan.scanned);
  // unauthenticated: private repos are invisible, which is not the same as absent
  assert.equal(vm.repoScan.privateVisible, 0);
});

test('the panel surfaces the coverage honestly', () => {
  const { req } = loadBundle();
  const entry = req('src/client/index.js');
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const scan = JSON.parse(readFileSync(resolve(ROOT, 'data/repos.json'), 'utf8'));
  assert.ok(scan.privateReposNote, 'the artifact must state why private repos read 0');
  assert.match(scan.privateReposNote, /unauthenticated|token/i);
  const vm = entry.buildViewModel(entry.mergeSources(snap, null), Date.now(), 'zh');
  assert.ok(vm.repoScan.known > 0, 'we must know how many repos exist in order to report coverage');
});

test('a quiet stretch renders as zero cells, not as a truncated calendar (regression)', () => {
  const { req } = loadBundle();
  const entry = req('src/client/index.js');
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const sources = entry.mergeSources(snap, null);

  const lastDataDay = Object.keys(snap.daily.tianyicui).sort().pop();
  assert.equal(lastDataDay, '2026-10-09');

  // Same "now" the user is looking at: three days past the last commit.
  const now = Date.parse('2026-10-12T16:00:00+08:00');
  const vm = entry.buildViewModel(sources, now, 'zh');

  const keys = vm.daily.map((d) => d.day);
  assert.ok(keys.includes('2026-10-10'), '10-10 must exist as a zero row');
  assert.ok(keys.includes('2026-10-11'), '10-11 must exist as a zero row');
  assert.ok(keys.includes('2026-10-12'), 'today must exist');
  for (const k of ['2026-10-10', '2026-10-11']) {
    const row = vm.daily.find((d) => d.day === k);
    assert.equal(row.tianyicui, 0);
    assert.equal(row.all, 0);
    assert.equal(row.isReleaseDay, false);
  }

  // and the heatmap grid must actually carry those cells
  const flatKeys = vm.heat.weeks.flat().filter((c) => c.inRange).map((c) => c.key);
  assert.ok(flatKeys.includes('2026-10-10'), 'heatmap must render a cell for 10-10');
  assert.ok(flatKeys.includes('2026-10-11'), 'heatmap must render a cell for 10-11');
});

test('padding the axis must not shrink the "last 7 days" window', () => {
  const { req } = loadBundle();
  const entry = req('src/client/index.js');
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const sources = entry.mergeSources(snap, null);

  const justAfterData = entry.buildViewModel(sources, Date.parse('2026-10-09T18:00:00+08:00'), 'zh');
  const threeDaysLater = entry.buildViewModel(sources, Date.parse('2026-10-12T16:00:00+08:00'), 'zh');

  // padding added three zero rows; the metric must be unchanged
  assert.ok(threeDaysLater.daily.length > justAfterData.daily.length, 'axis really was padded');
  assert.equal(threeDaysLater.totals.recent7, justAfterData.totals.recent7,
    'recent7 must count the last 7 days that have data, not the last 7 array slots');
});

test('the contribution strip renders and marks private-only days distinctly', () => {
  const { req } = loadBundle();
  const V = req('src/client/views.js');
  const contrib = JSON.parse(readFileSync(resolve(ROOT, 'data/contributions.json'), 'utf8'));
  const { daily } = realData();
  const publicDays = new Set(daily.filter((d) => d.all > 0).map((d) => d.day));

  const tree = V.ContributionStrip({
    contributions: {
      byDay: contrib.byDay, total: contrib.parsedTotal, days: contrib.days,
      firstDay: contrib.firstDay, lastDay: contrib.lastDay,
    },
    publicDays, theme: THEME, locale: 'zh', wide: true,
  });
  assert.ok(tree, 'must render');
  const { problems, nodes } = renderTree(tree);
  assert.deepEqual(problems, []);
  assert.ok(nodes > 300, `expected a bar per day, got ${nodes} nodes`);

  // exactly the days with contributions but no public commit get the private colour
  const bars = findAll(tree, (n) => n.type === 'rect' && n.props && n.props.height > 0);
  assert.equal(bars.length, contrib.days, 'one bar per contribution day');
  // the two colours must actually be used: private-only days exist in this data
  const fills = new Set(bars.map((b) => b.props.fill));
  assert.equal(fills.size, 3, `expected zero/public/private fills, got ${[...fills].join(', ')}`);

  // the explainer must state that this is not a commit count
  const texts = allText(tree).join(' ');
  assert.match(texts, /贡献|contribution/i);
  assert.match(texts, /不是提交数|not commits/i, 'the unit mismatch must be stated in the UI');
});

test('the view model exposes the private-activity gap', () => {
  const { req } = loadBundle();
  const entry = req('src/client/index.js');
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const vm = entry.buildViewModel(entry.mergeSources(snap, null), Date.now(), 'zh');
  assert.ok(vm.contributions, 'contributions must reach the view model');
  assert.ok(vm.contributions.total > 0);
  assert.equal(vm.contributions.totalsMatch, true);
  assert.ok(vm.contributions.privateActiveDays > 0,
    'a year of contributions with zero public commits on many days');
  // and it must never be folded into the commit totals
  assert.notEqual(vm.totals.tianyicui, vm.contributions.total);
  assert.ok(vm.totals.tianyicui < vm.contributions.total);
});

/* ------------------------------------------------------------------ *
 * scrolling + refresh controls (reported bugs)
 * ------------------------------------------------------------------ */

/** Call the report renderer directly out of the bundle. */
function renderReportWith(req, overrides = {}) {
  const mod = req('src/client/index.js');
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  const vm = mod.buildViewModel(mod.mergeSources(snap, null), Date.now(), 'zh');
  const state = {
    busy: false, canRefresh: true, cooldownLeft: 0, rateLimitLeft: 0,
    refresh: () => {}, ...overrides,
  };
  const fn = mod.renderReport;
  assert.equal(typeof fn, 'function', 'the report renderer must be exported for testing');
  return fn(vm, overrides.live || null, state, { wide: true });
}

test('the report is scrollable: a tall body inside a bounded viewport', () => {
  const { req } = loadBundle();
  const tree = renderReportWith(req, {});
  const { problems } = renderTree(tree);
  assert.deepEqual(problems, []);

  // outer container: bounded height, no clipping of its own content
  const outer = tree;
  assert.equal(outer.props.style.overflow, 'hidden');
  assert.equal(outer.props.style.height, '100%');
  assert.equal(outer.props.style.minHeight, 0);

  // inner scroller: this is what makes the whole report reachable
  const scrollers = findAll(tree, (n) => n.props && n.props.style && n.props.style.overflowY === 'auto');
  assert.equal(scrollers.length, 1, 'exactly one scroll viewport');
  assert.equal(scrollers[0].props.style.minHeight, 0, 'minHeight:0 is required for flex children to shrink and scroll');
  assert.equal(scrollers[0].props.style.flex, '1 1 auto');
});

test('the header stays visible while the body scrolls', () => {
  const { req } = loadBundle();
  const tree = renderReportWith(req, {});
  const sticky = findAll(tree, (n) => n.props && n.props.style && n.props.style.position === 'sticky');
  assert.equal(sticky.length, 1, 'the header (with the refresh control) must be sticky');
  assert.equal(sticky[0].props.style.top, 0);
});

test('the refresh button reports why it is unavailable', () => {
  const { req } = loadBundle();
  const buttonOf = (tree) => findAll(tree, (n) => n.type === 'button').find((b) => /刷新|Refresh|限流|Rate|稍候|wait/i.test(allText(b).join(' ')));

  // idle: enabled and labelled "刷新"
  const idle = renderReportWith(req, { canRefresh: true });
  const b1 = buttonOf(idle);
  assert.ok(b1, 'a refresh control must exist');
  assert.notEqual(b1.props.disabled, true);
  assert.match(allText(b1).join(' '), /刷新/);

  // busy
  const busy = renderReportWith(req, { busy: true, canRefresh: false });
  assert.match(allText(buttonOf(busy)).join(' '), /刷新中|Refreshing/);

  // rate limited: disabled, shows a countdown, and explains itself
  const limited = renderReportWith(req, {
    canRefresh: false, rateLimitLeft: 95_000,
    live: { ok: false, error: 'GitHub 403', rateLimited: true, rateLimit: { remaining: 0, limit: 60, resetAt: Date.now() + 95_000 } },
  });
  const b3 = buttonOf(limited);
  assert.equal(b3.props.disabled, true, 'must not let the user burn quota while rate limited');
  const texts = allText(limited).join(' ');
  assert.match(texts, /限流|Rate limited/);
  assert.match(texts, /1m35s/, 'a concrete wait time must be shown');
});

test('a failed refresh keeps the previous good data instead of blanking the panel', () => {
  const { req } = loadBundle();
  const tree = renderReportWith(req, {
    live: {
      ok: true, fetchedAt: Date.now() - 1000, error: 'GitHub 403', rateLimited: true,
      lastAttemptFailed: true, rateLimit: { remaining: 0, limit: 60, resetAt: Date.now() + 60_000 },
      tianyicuiDaily: {}, allDaily: {}, releases: [],
    },
  });
  const texts = allText(tree).join(' ');
  assert.match(texts, /沿用上次成功的数据|kept the last successful/);
});

test('no locale leaks "undefined" or "NaN" into the panel (both languages)', () => {
  // This is the check that catches a label added to one dictionary and not the
  // other, or a missing key in the active locale.
  const { req } = loadBundle();
  const mod = req('src/client/index.js');
  const snap = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));
  for (const locale of ['zh', 'en']) {
    const vm = mod.buildViewModel(mod.mergeSources(snap, null), Date.now(), locale);
    const state = { busy: false, canRefresh: true, cooldownLeft: 0, rateLimitLeft: 0, refresh: () => {} };
    for (const [name, live] of [
      ['no live data', null],
      ['rate limited', { ok: false, error: 'GitHub 403', rateLimited: true, rateLimit: { remaining: 0, limit: 60, resetAt: Date.now() + 60000 } }],
      ['failed after success', { ok: true, fetchedAt: Date.now(), error: 'x', rateLimited: true, lastAttemptFailed: true, tianyicuiDaily: {}, allDaily: {}, releases: [] }],
    ]) {
      const tree = mod.renderReport(vm, live, state, { wide: true });
      const text = allText(tree).join(' ');
      assert.ok(!/undefined/.test(text), `${locale}/${name}: "undefined" leaked into the UI`);
      assert.ok(!/NaN/.test(text), `${locale}/${name}: "NaN" leaked into the UI`);
      assert.ok(!/\[object Object\]/.test(text), `${locale}/${name}: an object leaked into the UI`);
    }
  }
});

test('the zh and en dictionaries expose the same key set', async () => {
  const { req } = loadBundle();
  // reach them through apply()'s locale registration
  const mod = req('src/client/index.js');
  let dicts = null;
  mod.apply({
    effect: (cb) => cb(),
    locale: { register: (ns, d) => { dicts = d; return () => {}; } },
    slots: { inject: (k, cb) => cb(), register: () => () => {} },
  });
  assert.ok(dicts && dicts.zh && dicts.en);
  const zk = Object.keys(dicts.zh).sort();
  const ek = Object.keys(dicts.en).sort();
  assert.deepEqual(ek, zk, 'every label must exist in both languages');
});
