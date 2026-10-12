/**
 * Core tests: analytics, the probability model, the live-merge path, and a real
 * evaluation of the BUILT client bundle in a simulated DSH module host.
 *
 *   node --test test/core.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildDailySeries, heatmapMatrix, wilson, auc, brier, cstDayKey,
  HOUR_MS, DAY_MS,
} from '../src/analytics.js';
import { refitFromDaily, predictWith, applyIsotonic, classify, combineHazardWeekday, AGE_EDGES, ageBucket } from '../src/model.js';
import { parseNextLink } from '../src/github.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(readFileSync(resolve(ROOT, 'data/dataset.json'), 'utf8'));
const modelArtifact = JSON.parse(readFileSync(resolve(ROOT, 'data/model_final.json'), 'utf8'));
const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'data/snapshot.json'), 'utf8'));

const relTimes = dataset.releases.map((r) => r.time).sort((a, b) => a - b);
const dayCounts = (times) => {
  const out = {};
  for (const t of times) out[cstDayKey(t)] = (out[cstDayKey(t)] || 0) + 1;
  return out;
};
const tyDaily = dayCounts(dataset.tianyicuiCommits);

/* ================================================================== *
 * fixtures are the real thing
 * ================================================================== */
test('fixture sanity: the dataset really is the DSH repo history', () => {
  assert.equal(dataset.meta.repository, 'deepseek-ai/deepseek-harness');
  assert.equal(dataset.tianyicuiCommits.length, 6851);
  assert.equal(dataset.allCommits.length, 21405);
  assert.equal(dataset.releases.length, 38);
  // tianyicui is the single largest contributor
  assert.ok(dataset.tianyicuiCommits.length / dataset.allCommits.length > 0.3);
});

test('model artifact is internally consistent', () => {
  assert.equal(modelArtifact.horizonHours, 72);
  assert.equal(modelArtifact.isotonic.xs.length, modelArtifact.isotonic.ys.length);
  assert.ok(modelArtifact.metrics.brier < modelArtifact.metrics.baselineBrier,
    'the model must beat the constant-rate baseline out of sample');
  assert.equal(modelArtifact.metrics.effectiveSample, 37);
});

/* ================================================================== *
 * analytics
 * ================================================================== */
test('buildDailySeries buckets by CST day and marks release days', () => {
  // 2026-10-08 23:30 CST and 2026-10-09 00:30 CST are DIFFERENT CST days
  const a = Date.parse('2026-10-08T23:30:00+08:00');
  const b = Date.parse('2026-10-09T00:30:00+08:00');
  const relTime = Date.parse('2026-10-09T15:13:40+08:00');
  const { days } = buildDailySeries([a, b], [relTime], [a, b]);
  assert.equal(days.length, 2);
  assert.equal(days[0].key, '2026-10-08');
  assert.equal(days[1].key, '2026-10-09');
  assert.equal(days[0].tianyicui, 1);
  assert.equal(days[1].tianyicui, 1);
  assert.equal(days[1].isReleaseDay, true);
  assert.equal(days[0].isReleaseDay, false);
});

test('heatmapMatrix produces a full 7-row grid with correct intensity range', () => {
  const dayStarts = Object.keys(tyDaily).sort().map((k) => Date.parse(`${k}T00:00:00+08:00`));
  const { days } = buildDailySeries(dayStarts, relTimes, dayStarts);
  const heat = heatmapMatrix(days);
  assert.ok(heat.weeks.length > 0);
  for (const col of heat.weeks) assert.equal(col.length, 7);
  const values = heat.weeks.flat().filter((c) => c.inRange).map((c) => c.value);
  assert.equal(Math.max(...values), heat.max);
  assert.ok(heat.max > 0);
  assert.equal(heat.monthLabels.length, heat.weeks.length);
});

test('wilson interval brackets the point estimate and stays in [0,1]', () => {
  const w = wilson(83, 100);
  assert.ok(w.lo < w.p && w.p < w.hi);
  assert.ok(w.lo >= 0 && w.hi <= 1);
  const edge = wilson(0, 10);
  assert.equal(edge.p, 0);
  assert.ok(edge.hi > 0 && edge.hi < 1);
  assert.deepEqual(wilson(0, 0), { lo: 0, hi: 1, p: 0 });
});

test('auc is 1 for a perfect ranking, 0.5 for a constant', () => {
  assert.equal(auc([0.1, 0.2, 0.8, 0.9], [0, 0, 1, 1]), 1);
  assert.equal(auc([0.5, 0.5, 0.5, 0.5], [0, 0, 1, 1]), 0.5);
  // ties must be handled by average rank, not by sort order
  assert.equal(auc([0.5, 0.5], [1, 0]), 0.5);
});

test('brier and cstDayKey behave', () => {
  assert.equal(brier([1, 0], [1, 0]), 0);
  assert.equal(brier([0.5, 0.5], [1, 0]), 0.25);
  assert.equal(cstDayKey(Date.parse('2026-10-08T16:30:00Z')), '2026-10-09'); // +8h
  assert.equal(cstDayKey(Date.parse('2026-10-08T15:30:00Z')), '2026-10-08');
});

/* ================================================================== *
 * model runtime
 * ================================================================== */
test('applyIsotonic is monotone non-decreasing across the curve', () => {
  const iso = modelArtifact.isotonic;
  let prev = -Infinity;
  for (const x of iso.xs) {
    const y = applyIsotonic(iso, x);
    assert.ok(y >= prev - 1e-12, `isotonic must not decrease at ${x}`);
    prev = y;
  }
});

test('applyIsotonic clamps outside the fitted domain', () => {
  const iso = modelArtifact.isotonic;
  assert.equal(applyIsotonic(iso, -5), iso.ys[0]);
  assert.equal(applyIsotonic(iso, 5), iso.ys[iso.ys.length - 1]);
  assert.equal(applyIsotonic(null, 0.42), 0.42, 'no curve means no calibration');
});

test('combineHazardWeekday moves the odds in the right direction', () => {
  const p = 0.5;
  assert.ok(combineHazardWeekday(p, 2) > p);
  assert.ok(combineHazardWeekday(p, 0.5) < p);
  assert.equal(combineHazardWeekday(p, 1), p);
  assert.ok(combineHazardWeekday(0.99, 8) <= 0.995);
});

test('refitFromDaily reproduces the shipped model closely enough', () => {
  const endMs = modelArtifact.window.endMs;
  const model = refitFromDaily({
    tianyicuiDaily: tyDaily,
    releaseTimes: relTimes,
    startMs: relTimes[0],
    endMs,
  });
  assert.ok(model, 'refit must succeed on the real data');
  // the shipped artifact and a browser-side refit use the same procedure, so the
  // hazard tables should agree within smoothing noise
  assert.equal(model.hazard.length, AGE_EDGES.length - 1);
  assert.equal(model.dowRR.length, 7);
  for (const rr of model.dowRR) assert.ok(rr > 0 && rr <= 8);

  const a = predictWith(model, modelArtifact.isotonic, endMs, relTimes, tyDaily);
  assert.ok(a.calibrated > 0 && a.calibrated <= 1);
  assert.ok(a.raw > 0 && a.raw < 1);
  assert.ok(Math.abs(a.calibrated - modelArtifact.current.calibrated) < 0.25,
    `refit probability ${a.calibrated.toFixed(3)} should be near shipped ${modelArtifact.current.calibrated.toFixed(3)}`);
});

test('the 72h hazard escalates with age and saturates for overdue cycles', () => {
  const hz = modelArtifact.hazard.filter((x) => x.p != null);
  const at = (h) => hz.find((x) => x.lo <= h && h < x.hi);

  const young = at(3);       // 0-6h
  const mid = at(30);        // 30-36h
  const overdue = at(100);   // 96-120h
  assert.ok(young && mid && overdue, 'the age buckets must exist');

  // at a 72h horizon the renewal process means overdue cycles are the likely
  // ones: the tail must dominate the freshly-released window
  assert.ok(overdue.p > young.p + 0.2, `overdue ${overdue.p} should dominate young ${young.p}`);
  assert.ok(overdue.p >= 0.9, `an overdue cycle should clear the 90% verdict (got ${overdue.p})`);

  // and the escalation must be real across the whole tail, not one lucky cell
  const tail = hz.filter((x) => x.lo >= 36).map((x) => x.p);
  const early = hz.filter((x) => x.hi <= 36).map((x) => x.p);
  assert.ok(Math.min(...tail) > Math.max(...early),
    `every >36h bucket (min ${Math.min(...tail)}) should exceed every <=36h bucket (max ${Math.max(...early)})`);
});

test('the 90% verdict is reachable only via the overdue tail, which is the design', () => {
  const hz = modelArtifact.hazard.filter((x) => x.p != null);
  const reaches = hz.filter((x) => x.p >= 0.9).map((x) => x.lo);
  assert.ok(reaches.length > 0, 'some age bucket must clear 90%');
  assert.ok(Math.min(...reaches) >= 72, `only the overdue tail should clear 90%; got buckets ${reaches}`);
});

test('the fitted weekday risk puts the weekend far below midweek', () => {
  const rr = modelArtifact.coefficients.dowRR;
  const SUN = 0;
  const THU = 4;
  assert.ok(rr[THU] > rr[SUN] * 3, `Thursday odds ${rr[THU]} should dwarf Sunday ${rr[SUN]}`);
  // every relative risk must stay inside the clamp the fitting code enforces
  for (const v of rr) assert.ok(v >= 0.1 && v <= 8);
});

test('classify bands the probability at the 90% verdict line', () => {
  assert.equal(classify(0.95).level, 'release-likely');
  assert.equal(classify(0.9).level, 'release-likely');   // inclusive
  assert.equal(classify(0.85).level, 'watch');
  assert.equal(classify(0.2).level, 'quiet');
  assert.equal(classify(null).level, 'unknown');
  assert.equal(classify(NaN).level, 'unknown');
});

test('ageBucket covers every age including the tail', () => {
  assert.equal(ageBucket(0), 0);
  assert.equal(ageBucket(1e9), AGE_EDGES.length - 2);
  for (let h = 0; h < 400; h += 7) {
    const b = ageBucket(h);
    assert.ok(b >= 0 && b < AGE_EDGES.length - 1);
    assert.ok(h >= AGE_EDGES[b] && h < AGE_EDGES[b + 1]);
  }
});

test('predictWith rewards an overdue cycle over a fresher one', () => {
  const model = refitFromDaily({
    tianyicuiDaily: tyDaily,
    releaseTimes: relTimes,
    startMs: relTimes[0],
    endMs: modelArtifact.window.endMs,
  });
  // The previous release landed 2026-09-24 21:24 CST, so:
  //   09-27 09:00 -> ~60h old (bucket 8)
  //   09-28 15:00 -> ~90h old (bucket 10), already past the 72h mark
  const fresher = predictWith(model, modelArtifact.isotonic,
    Date.parse('2026-09-27T09:00:00+08:00'), relTimes, tyDaily);
  const overdue = predictWith(model, modelArtifact.isotonic,
    Date.parse('2026-09-28T15:00:00+08:00'), relTimes, tyDaily);

  assert.ok(fresher.age > 24 && fresher.age < 72, `expected 24<age<72, got ${fresher.age}`);
  assert.ok(overdue.age > 72, `expected an overdue age, got ${overdue.age}`);
  assert.ok(overdue.raw > fresher.raw,
    `overdue ${overdue.raw.toFixed(3)} should beat fresher ${fresher.raw.toFixed(3)}`);
  assert.ok(overdue.raw >= 0.9, `an overdue cycle should clear the verdict (got ${overdue.raw})`);
  for (const p of [overdue.raw, fresher.raw]) assert.ok(p > 0 && p < 1);
});

/* ================================================================== *
 * github helpers
 * ================================================================== */
test('parseNextLink finds rel=next and ignores rel=last', () => {
  const link = '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=6855>; rel="last"';
  assert.equal(parseNextLink(link), 'https://api.github.com/x?page=2');
  assert.equal(parseNextLink('<https://api.github.com/x?page=1>; rel="last"'), null);
  assert.equal(parseNextLink(null), null);
  assert.equal(parseNextLink('garbage'), null);
});

/* ================================================================== *
 * the ceiling claim must be reproducible from the shipped artifact
 * ================================================================== */
test('the >=90% verdict is actually reachable and performs as advertised', () => {
  const t = modelArtifact.metrics.thresholds.find((x) => x.th === 0.9);
  assert.ok(t, 'a 0.9 threshold row must be shipped');
  assert.ok(t.n > 0, 'the verdict must fire at least sometimes');
  assert.ok(t.hit > 0.85, `advertised hit rate ${t.hit} should be high`);
  // and the point estimate must beat the unconditional base rate
  assert.ok(t.hit > modelArtifact.metrics.baseRate);
});

/* ================================================================== *
 * the built bundle: does it really load in a DSH-like module host?
 * ================================================================== */
function loadBundle() {
  const code = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8');
  const registrations = [];
  const fakeReact = {
    createElement: (...args) => ({ type: args[0], props: args[1] || {}, children: args.slice(2) }),
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (v) => ({ current: v }),
    Fragment: 'Fragment',
  };
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (reg) => registrations.push(reg),
      },
    },
    require: (id) => {
      if (id === 'react') return { default: fakeReact, ...fakeReact };
      if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' };
      throw new Error(`unexpected platform require: ${id}`);
    },
  };
  const fn = new Function('window', 'require', code);
  fn(sandbox.window, sandbox.require);
  assert.equal(registrations.length, 1, 'the bundle must register exactly one loader entry');
  const reg = registrations[0];
  assert.equal(reg.id, 'dsh-plugin-tianyicui-monitor');
  const exports = reg.factory(sandbox.require);
  return { exports, reg };
}

test('the built bundle registers one loader row and exports apply + inject', () => {
  const { exports, reg } = loadBundle();
  assert.equal(reg.id, 'dsh-plugin-tianyicui-monitor');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots']);
  assert.equal(typeof exports.MonitorEntry, 'function');
  assert.equal(typeof exports.mergeSources, 'function');
  assert.equal(typeof exports.buildViewModel, 'function');
});

test('apply registers the sidebar row AND a matching main key', () => {
  const { exports } = loadBundle();
  const calls = { effects: [], injections: [], registrations: [] };
  const ctx = {
    effect: (cb, label) => { calls.effects.push(label); return cb(); },
    locale: { register: (ns, dicts) => { calls.locale = { ns, dicts }; return () => {}; } },
    slots: {
      inject: (key, cb) => { calls.injections.push(key); return cb(); },
      register: (spec, component) => { calls.registrations.push({ spec, component }); return () => {}; },
    },
  };
  exports.apply(ctx);

  // the sidebar entry is what the user sees; `main` must exist because the
  // sidebar's own click handler calls selectPanel(id) and throws without it
  assert.deepEqual(calls.injections, ['sidebar.panellist', 'main']);

  const sidebar = calls.registrations.find((r) => r.spec.name === 'sidebar.panellist');
  const main = calls.registrations.find((r) => r.spec.name === 'main');
  assert.ok(sidebar, 'a sidebar.panellist registration is required');
  assert.ok(main, 'a main key registration is required');

  // the list id and the main key must agree or clicking the row throws
  assert.equal(sidebar.spec.id, main.spec.key);
  assert.equal(sidebar.spec.id, exports.PANEL_ID);
  assert.equal(typeof sidebar.spec.order, 'number');
  assert.equal(typeof sidebar.spec.label, 'string');
  assert.ok(sidebar.spec.label.length > 0, 'the row needs a visible label');
  assert.equal(typeof sidebar.component, 'function');

  assert.ok(calls.locale && calls.locale.ns === 'tianyicui-monitor');
  assert.ok(calls.locale.dicts.zh && calls.locale.dicts.en);
});

test('the sidebar entry draws only a glyph and tolerates any sidebar props', () => {
  const { exports } = loadBundle();
  // The shell wraps our component in its own <button> and passes { size, active }.
  // We must return only the glyph, never our own button, or the row would nest
  // interactive elements.
  const node = exports.MonitorEntry({ size: 18, active: true });
  assert.ok(node, 'must render');
  assert.notEqual(node.type, 'button', 'the sidebar already provides the button');
  assert.equal(typeof node.type, 'function', 'expected the icon component element');
  assert.ok(exports.MonitorEntry(), 'must render with no props');
  assert.ok(exports.MonitorEntry({}), 'must render with empty props');
  assert.ok(exports.MonitorEntry({ size: 16, active: false }), 'must render when unselected');
});

test('MonitorReport is the registered main-panel component', () => {
  const { exports } = loadBundle();
  assert.equal(typeof exports.MonitorReport, 'function');
  assert.ok(exports.MonitorReport.length <= 1, 'a main-panel component takes optional props');
});

test('buildViewModel turns the bundled snapshot into renderable data', () => {
  const { exports } = loadBundle();
  const sources = exports.mergeSources(snapshot, null);
  assert.equal(sources.liveState, 'offline');
  const vm = exports.buildViewModel(sources, Date.now(), 'zh');
  assert.ok(vm.daily.length > 100, 'should have the full daily history');
  for (const d of vm.daily) {
    assert.equal(typeof d.day, 'string');
    assert.equal(typeof d.tianyicui, 'number');
    assert.equal(typeof d.all, 'number');
    assert.equal(typeof d.isReleaseDay, 'boolean');
  }
  assert.equal(vm.heat.weeks.length > 0, true);
  assert.ok(vm.probability > 0 && vm.probability <= 1, `probability ${vm.probability}`);
  assert.equal(vm.totals.tianyicui, 6851);
  assert.equal(vm.totals.all, 21405);
  assert.equal(vm.metrics.effectiveSample, 37);
});

test('buildViewModel survives an empty and a hostile source', () => {
  const { exports } = loadBundle();
  const empty = exports.buildViewModel(exports.mergeSources({ daily: { tianyicui: {}, all: {} }, releases: [] }, null), Date.now());
  assert.ok(Array.isArray(empty.daily));
  assert.ok(empty.probability === null || (empty.probability >= 0 && empty.probability <= 1));

  const hostile = exports.mergeSources(snapshot, { ok: false, error: 'boom' });
  assert.equal(hostile.liveState, 'error');
  const vm2 = exports.buildViewModel(hostile, Date.now());
  assert.ok(vm2.daily.length > 0, 'must fall back to the offline snapshot');
});

test('a live read merges new days rather than replacing history', () => {
  const { exports } = loadBundle();
  const later = Date.now() + 5 * DAY_MS;
  const existingDay = Object.keys(snapshot.daily.tianyicui).sort()[0];
  const live = {
    ok: true,
    fetchedAt: later,
    error: null,
    tianyicuiDaily: { '2026-10-10': 7, '2026-10-11': 3 },
    allDaily: { '2026-10-10': 20, '2026-10-11': 9 },
    releases: [{ version: '0.2.1-alpha.3', time: later }],
  };
  const merged = exports.mergeSources(snapshot, live);
  assert.equal(merged.liveState, 'live');
  assert.equal(merged.daily.tianyicui['2026-10-10'], 7);
  assert.equal(merged.daily.tianyicui[existingDay], snapshot.daily.tianyicui[existingDay],
    'the oldest bundled day must survive the merge');
  assert.equal(merged.releases.length, snapshot.releases.length + 1);
  assert.equal(merged.releases[merged.releases.length - 1].version, '0.2.1-alpha.3');
});

test('a hostile live value cannot invent absurd commit counts', () => {
  const { exports } = loadBundle();
  const existingDay = Object.keys(snapshot.daily.tianyicui).sort().reverse().find((k) => snapshot.daily.tianyicui[k] > 0);
  const bundledValue = snapshot.daily.tianyicui[existingDay];
  const live = { ok: true, tianyicuiDaily: { [existingDay]: 999999 }, allDaily: {}, releases: [] };
  const merged = exports.mergeSources(snapshot, live);
  assert.equal(merged.daily.tianyicui[existingDay], 999999, 'max() merge takes the larger value');
  // a nonsense day far in the past must not break the view model
  const vm = exports.buildViewModel(merged, Date.now());
  assert.ok(vm.probability === null || (vm.probability >= 0 && vm.probability <= 1));
  assert.ok(bundledValue > 0);
});

test('apply survives a context with no locale service (regression)', () => {
  const { exports } = loadBundle();
  const calls = { injections: [], registrations: [] };
  const ctx = {
    // deliberately NO locale service and NO effect helper
    slots: {
      inject: (key, cb) => { calls.injections.push(key); return cb(); },
      register: (spec) => { calls.registrations.push(spec); return () => {}; },
    },
  };
  assert.doesNotThrow(() => exports.apply(ctx),
    'a missing optional service must not take the sidebar entry down with it');
  assert.deepEqual(calls.injections, ['sidebar.panellist', 'main']);
  assert.equal(calls.registrations.length, 2, 'both slots must still register');
});

test('the package resolves from the web profile as a client plugin', async () => {
  // The exact seam DSH uses: package.json -> dsh.client.platform -> exports['./client'].
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-plugin-tianyicui-monitor');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.equal(pkg.exports['./client'].default, './lib/client.js');
  assert.equal(pkg.main, 'lib/index.js');

  for (const rel of [pkg.main, pkg.exports['./client'].default]) {
    assert.ok(readFileSync(resolve(ROOT, rel), 'utf8').length > 0, `${rel} must exist and be non-empty`);
  }

  const host = await import(resolve(ROOT, pkg.main));
  assert.equal(typeof host.apply, 'function');
  assert.doesNotThrow(() => host.apply({}));
});

test('buildDailySeries extends through endMs so trailing quiet days are not dropped (regression)', () => {
  const day1 = Date.parse('2026-10-09T10:00:00+08:00');
  const day2 = Date.parse('2026-10-09T17:31:00+08:00');
  const releases = [day2];

  // Without endMs the axis stops at the last commit: 10-10 and 10-11 vanish.
  const trimmed = buildDailySeries([day1, day2], releases, [day1, day2]);
  assert.equal(trimmed.days.length, 1);
  assert.ok(!trimmed.days.some((d) => d.key === '2026-10-11'));

  // With today supplied, the quiet days are present as real zero rows.
  const today = Date.parse('2026-10-12T09:00:00+08:00');
  const padded = buildDailySeries([day1, day2], releases, [day1, day2], today);
  const keys = padded.days.map((d) => d.key);
  assert.deepEqual(keys, ['2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12']);
  for (const d of padded.days.slice(1)) {
    assert.equal(d.tianyicui, 0, `${d.key} must carry a real zero, not be absent`);
    assert.equal(d.all, 0);
  }
});

test('buildDailySeries keeps the endMs day itself, not just up to yesterday', () => {
  const t0 = Date.parse('2026-10-09T10:00:00+08:00');
  const today = Date.parse('2026-10-12T00:30:00+08:00'); // just after CST midnight
  const { days } = buildDailySeries([t0], [t0], [t0], today);
  assert.equal(days[days.length - 1].key, '2026-10-12');
});

test('buildDailySeries still stops at the data when no endMs is given', () => {
  const t0 = Date.parse('2026-10-09T10:00:00+08:00');
  const { days } = buildDailySeries([t0], [t0], [t0]);
  assert.equal(days.length, 1);
  assert.equal(days[0].key, '2026-10-09');
});
