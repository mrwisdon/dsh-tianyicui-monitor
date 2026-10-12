/**
 * Browser half of dsh-tianyicui-monitor.
 *
 * Registers ONE entry in the frame-wide `shell.overlay` slot, pinned to the
 * window's top-left corner. Opening it reveals:
 *   - the calibrated probability that a new DSH version ships within 72 hours,
 *     with the 90% verdict line drawn on the gauge
 *   - a commit timeline with release markers
 *   - a GitHub-style contribution heatmap
 *   - the evidence tables the probability is built from
 *
 * Data: the bundled offline snapshot renders instantly; a refresh reads the
 * public GitHub API directly (it sends `Access-Control-Allow-Origin: *`).
 */
import React from 'react';
import snapshotJson from '../../data/snapshot.json';
import modelJson from '../../data/model_final.json';
import repoScan from '../../data/repos.json';
import contributions from '../../data/contributions.json';
import modelReleases from '../../data/models.json';
import { buildDailySeries, heatmapMatrix } from '../analytics.js';
import { refitFromDaily, predictWith, HORIZON_HOURS, LIKELY_THRESHOLD } from '../model.js';
import { refresh as refreshUpstream } from '../github.js';
import { ProbabilityGauge, StatRow, EvidenceTable, IconMonitor, MonitorCharts, ContributionStrip, ModelTimeline } from './views.js';
import { classifyProbability } from './classify.js';

export const NS = 'tianyicui-monitor';

/** Required client services. */
export const inject = ['slots'];

/**
 * Theme built from DSH's own design tokens, so the panel follows light/dark and
 * the user's accent without hardcoding a single colour.
 */
export const THEME = {
  label: 'var(--dsw-alias-label-primary)',
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  labelTertiary: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
  border: 'var(--dsw-alias-border-l2)',
  borderStrong: 'var(--dsw-alias-border-l1)',
  bg1: 'var(--dsw-alias-bg-layer-1)',
  bg2: 'var(--dsw-alias-bg-layer-2)',
  bgOverlay: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1))',
  accent: 'var(--dsw-alias-brand-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  danger: 'var(--dsw-alias-state-error-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  neutral: 'var(--dsw-alias-state-idle-primary)',
  font: 'inherit',
};

const zh = {
  trigger: '提交监控',
  title: 'tianyicui 提交监控',
  subtitle: 'DSH 新版本发布概率',
  refresh: '刷新',
  refreshing: '刷新中…',
  close: '关闭',
  offline: '离线快照',
  live: '已联网',
  partial: '部分数据',
  degraded: '显示缓存',
  failed: '联网失败',
  timeline: '提交折线图（绿虚线 = 发布日）',
  heatmap: '提交热度图',
  evidence: '判定依据',
  totals: '总量',
  statTotal: 'tianyicui 总提交',
  statTeam: '全团队总提交',
  statRecent: '近 7 天',
  statAge: '距上次发布',
  statReleases: '发布总数',
  statSample: '独立发布事件',
  statAllRepos: '全部公开仓库',
  allReposNote: '跨仓库公开提交合计',
  coverage: '覆盖',
  contribStat: 'GitHub 贡献图',
  contribNote: '含私有；commit+PR+issue+review 合计，非提交数',
  rateLimited: 'API 限流',
  rateLimitedBody: 'GitHub 未认证 API 限制 60 次/小时，当前显示的是离线快照，稍后可重试。',
  cooldown: '稍候',
  keptLastGood: '沿用上次成功的数据',
  brier: 'Brier 分数',
  brierNote: '越低越好；基线为常数概率',
  auc: 'AUC',
  aucNote: '0.5 = 无区分度',
  ece: '校准误差 ECE',
  eceNote: '等频分箱后 |预测-实际| 的加权均值',
  hit: '命中率',
  hitNote: '样本内表现；仅 37 个独立发布事件，区间很宽',
  bucket: '力竭度分桶',
  rawVsCal: '未校准 / 校准后',
  disclaimer: '数据源：GitHub 公开 API（deepseek-ai/deepseek-harness 提交 + 全部公开仓库贡献合计）。样本仅 37 个独立发布事件，概率区间较宽，请勿据此做重要决策。私有仓库提交未认证时不可见，因此不计入。',
  metricTy: 'tianyicui',
  metricAll: '全团队',
};

const en = {
  trigger: 'Commit monitor',
  title: 'tianyicui commit monitor',
  subtitle: 'DSH release probability',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  close: 'Close',
  offline: 'Offline snapshot',
  live: 'Live',
  partial: 'Partial',
  degraded: 'Cached',
  failed: 'Refresh failed',
  timeline: 'Commits over time (green dashes = releases)',
  heatmap: 'Commit heatmap',
  evidence: 'Evidence',
  totals: 'Totals',
  statTotal: 'tianyicui commits',
  statTeam: 'Team commits',
  statRecent: 'Last 7 days',
  statAge: 'Since last release',
  statReleases: 'Releases',
  statSample: 'Independent release events',
  statAllRepos: 'All public repos',
  allReposNote: 'public commits summed across repos',
  coverage: 'coverage',
  contribStat: 'GitHub contributions',
  contribNote: 'includes private; commits+PRs+issues+reviews, not commits',
  rateLimited: 'Rate limited',
  rateLimitedBody: 'The unauthenticated GitHub API allows 60 requests/hour. Showing the offline snapshot; try again later.',
  cooldown: 'wait',
  keptLastGood: 'kept the last successful data',
  brier: 'Brier score',
  brierNote: 'lower is better; baseline is a constant rate',
  auc: 'AUC',
  aucNote: '0.5 = no discrimination',
  ece: 'Calibration error',
  eceNote: 'count-weighted |predicted − observed| over deciles',
  hit: 'Hit rate',
  hitNote: 'in-sample; only 37 independent release events, so very wide',
  bucket: 'Hazard bucket',
  rawVsCal: 'raw / calibrated',
  disclaimer: 'Sources: the GitHub public API — deepseek-ai/deepseek-harness commits plus contributions summed across public repos. Only 37 independent release events, so the intervals are wide — do not make important decisions from this. Private-repo commits are invisible without a token and are therefore excluded.',
  metricTy: 'tianyicui',
  metricAll: 'Whole team',
};

/* ------------------------------------------------------------------ *
 * data assembly
 * ------------------------------------------------------------------ */

/** Merge the bundled offline snapshot with a live GitHub read. */
export function mergeSources(bundled, live) {
  const daily = {
    tianyicui: { ...bundled.daily.tianyicui },
    all: { ...bundled.daily.all },
  };
  let releases = bundled.releases.slice();
  let liveState = 'offline';

  if (live && live.ok) {
    liveState = live.degraded ? 'degraded' : live.error ? 'partial' : 'live';
    for (const [k, v] of Object.entries(live.tianyicuiDaily || {})) {
      daily.tianyicui[k] = Math.max(daily.tianyicui[k] || 0, v);
    }
    for (const [k, v] of Object.entries(live.allDaily || {})) {
      daily.all[k] = Math.max(daily.all[k] || 0, v);
    }
    if (Array.isArray(live.releases) && live.releases.length) {
      const byVersion = new Map(releases.map((r) => [r.version, r]));
      for (const r of live.releases) byVersion.set(r.version, r);
      releases = [...byVersion.values()].sort((a, b) => a.time - b.time);
    }
  } else if (live && live.ok === false) {
    liveState = 'error';
  }
  return { daily, releases, liveState, live };
}

/** Turn the daily maps + releases into everything the components render. */
export function buildViewModel(sources, nowMs, locale = 'zh') {
  const dayKeys = Object.keys(sources.daily.tianyicui).sort();
  const releaseTimes = sources.releases.map((r) => r.time).sort((a, b) => a - b);
  const dayStarts = dayKeys.map((k) => Date.parse(`${k}T00:00:00+08:00`)).filter((n) => Number.isFinite(n));
  // `nowMs` extends the axis through today: without it a quiet stretch shows no
  // cells at all, which reads as a data gap instead of "no commits".
  const { days } = buildDailySeries(dayStarts, releaseTimes, dayStarts, nowMs);

  const daily = days.map((d) => ({
    day: d.key,
    tianyicui: sources.daily.tianyicui[d.key] || 0,
    all: sources.daily.all[d.key] || 0,
    isReleaseDay: d.isReleaseDay,
  }));

  const heat = heatmapMatrix(days);

  // Refit on the merged history, so a live refresh actually moves the number.
  const windowStart = releaseTimes.length ? releaseTimes[0] : (dayStarts[0] ?? nowMs);
  let model = null;
  try {
    model = refitFromDaily({
      tianyicuiDaily: sources.daily.tianyicui,
      releaseTimes,
      startMs: windowStart,
      endMs: nowMs,
    });
  } catch {
    model = null;
  }
  const prediction = model
    ? predictWith(model, modelJson.isotonic, nowMs, releaseTimes, sources.daily.tianyicui)
    : { calibrated: null, raw: null, age: null, parts: {} };

  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  // Window over the days that actually carry data. Padding the axis with zero
  // days must not shrink this window, or "last 7 days" would silently become
  // "last 4 days of data" during a quiet stretch.
  const posted = daily.filter((d) => d.tianyicui > 0 || d.all > 0);
  const recent7 = posted.slice(-7).reduce((a, d) => a + d.tianyicui, 0);

  return {
    daily,
    heat,
    releases: sources.releases,
    probability: prediction.calibrated,
    rawProbability: prediction.raw,
    age: prediction.age,
    parts: prediction.parts,
    totals: {
      tianyicui: sum(sources.daily.tianyicui),
      all: sum(sources.daily.all),
      recent7,
      releases: sources.releases.length,
      days: daily.length,
    },
    metrics: modelJson.metrics,
    // Cross-repo public total. The bundled scan covers the repos we could reach
    // unauthenticated; the harness count is refreshed live, so prefer whichever
    // is larger for that repo rather than double counting.
    repoScan: (() => {
      const byRepo = { ...(repoScan && repoScan.byRepo ? repoScan.byRepo : {}) };
      const harness = 'deepseek-ai/deepseek-harness';
      if (byRepo[harness] != null) byRepo[harness] = Math.max(byRepo[harness], sum(sources.daily.tianyicui));
      const total = Object.values(byRepo).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      return {
        total,
        scanned: Object.keys(byRepo).length,
        known: (repoScan && repoScan.reposKnown) || Object.keys(byRepo).length,
        privateVisible: (repoScan && repoScan.privateReposVisible) || 0,
        generatedAt: repoScan && repoScan.generatedAt,
      };
    })(),
    contributions: (() => {
      const byDay = (contributions && contributions.byDay) || {};
      const keys = Object.keys(byDay);
      if (!keys.length) return null;
      // Days where the contribution graph shows activity but the public repo has
      // no commit at all: that gap is private activity.
      const privateActiveDays = keys.filter((k) => (byDay[k] || 0) > 0 && !(sources.daily.tianyicui[k] > 0));
      const total = keys.reduce((a, k) => a + byDay[k], 0);
      return {
        byDay,
        total,
        days: keys.length,
        firstDay: contributions.firstDay,
        lastDay: contributions.lastDay,
        declaredTotal: contributions.declaredTotal,
        totalsMatch: contributions.totalsMatch,
        generatedAt: contributions.generatedAt,
        privateActiveDays: privateActiveDays.length,
        privateActiveRecent: privateActiveDays.filter((k) => k >= '2026-10-10').length,
      };
    })(),
    // DeepSeek model launches, shown as timeline context only — they are not a
    // model input (too few fall inside the window to support one).
    modelReleases: (modelReleases && Array.isArray(modelReleases.releases))
      ? modelReleases.releases
      : [],
    liveState: sources.liveState,
    live: sources.live,
    locale,
  };
}

/* ------------------------------------------------------------------ *
 * small presentational helpers
 * ------------------------------------------------------------------ */

const TONE_VAR = {
  danger: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
  calm: 'var(--dsw-alias-state-success-primary)',
  neutral: 'var(--dsw-alias-state-idle-primary)',
};

/** `90s` -> `1m30s`, `3700s` -> `1h2m`. */
function fmtWait(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s2 = total % 60;
  if (m < 60) return s2 ? `${m}m${s2}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const m2 = m % 60;
  return m2 ? `${h}h${m2}m` : `${h}h`;
}

function hitRowText(metrics, labels) {
  const t = (metrics.thresholds || []).find((x) => Math.abs(x.th - LIKELY_THRESHOLD) < 1e-9);
  if (!t) return '—';
  return `${(t.hit * 100).toFixed(1)}% (n=${t.n})`;
}

function hazardBucketText(parts) {
  if (!parts || !parts.ageRange) return '—';
  const [lo, hi] = parts.ageRange;
  return `${lo}–${hi == null || hi === Infinity ? '∞' : hi} h`;
}

/* ------------------------------------------------------------------ *
 * the entry component
 * ------------------------------------------------------------------ */

/**
 * Sidebar glyph.
 *
 * Registered in `sidebar.panellist`, so DSH renders it as an ordinary sidebar
 * row beside Plugins / Qwen-Image / MCP. The shell owns the row, tooltip, hover
 * and selected state and passes `{ size, active }`; this component draws ONLY the
 * glyph. Selecting the row switches the main panel to `MonitorReport`.
 */
export function MonitorEntry() {
  return React.createElement(IconMonitor, { size: 18 });
}

/**
 * Shared data hook: bundled snapshot first, live GitHub read on demand.
 */
function useMonitorViewModel() {
  const [live, setLive] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  // a refresh costs several unauthenticated requests out of a 60/hour budget, so
  // throttle the button rather than letting a user drain the quota in seconds
  const [lastAttempt, setLastAttempt] = React.useState(0);
  const COOLDOWN_MS = 60_000;

  const refresh = React.useCallback(async () => {
    setBusy(true);
    setLastAttempt(Date.now());
    let result;
    try {
      result = await refreshUpstream({ sinceDays: 90 });
    } catch (err) {
      result = { ok: false, error: String((err && err.message) || err), rateLimited: false, rateLimit: null };
    } finally {
      setBusy(false);
      setNow(Date.now());
    }
    // Keep the previous good data when the new attempt failed outright, so a
    // transient 403 never blanks the panel.
    setLive((prev) => {
      const failedHard = !result.ok && !result.error;
      if (failedHard) return prev;
      if (!result.ok && prev && prev.ok) {
        return { ...prev, error: result.error, rateLimited: result.rateLimited, rateLimit: result.rateLimit || prev.rateLimit, lastAttemptFailed: true };
      }
      return result;
    });
  }, []);

  // a ticking clock so a rate-limit countdown actually counts down
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const vm = React.useMemo(() => {
    const locale = typeof navigator !== 'undefined' && /^en\b/i.test(navigator.language || '') ? 'en' : 'zh';
    // `now` participates so the day axis (and any countdown) stays current
    return buildViewModel(mergeSources(snapshotJson, live), now, locale);
  }, [live, now]);

  const cooldownLeft = Math.max(0, COOLDOWN_MS - (now - lastAttempt));
  const resetAt = live && live.rateLimit && Number.isFinite(live.rateLimit.resetAt) ? live.rateLimit.resetAt : null;
  const rateLimitLeft = live && live.rateLimited && resetAt ? Math.max(0, resetAt - now) : 0;
  const canRefresh = !busy && cooldownLeft <= 0 && rateLimitLeft <= 0;

  return { vm, live, busy, refresh, canRefresh, cooldownLeft, rateLimitLeft, now };
}

/**
 * The report, rendered in the main panel area after the sidebar row is selected.
 *
 * A main panel is the idiomatic DSH extension point (and the reason the sidebar's
 * click can call `selectPanel('tianyicui-monitor')` without throwing), and it
 * gives the charts far more room than a floating card would.
 */
export function MonitorReport() {
  const state = useMonitorViewModel();
  React.useEffect(() => { state.refresh(); }, []);   // one live read per mount
  return renderReport(state.vm, state.live, state, { wide: true });
}

/**
 * The report body. Rendered by MonitorReport (the `main` panel) and reusable
 * inside any container.
 *
 * @param {object} vm       view model from buildViewModel
 * @param {object|null} live last live GitHub read (or null)
 * @param {boolean} busy    a refresh is in flight
 * @param {Function} refresh trigger a live read
 * @param {{wide?:boolean}} [opts] `wide` uses the extra room of a main panel
 */
export function renderReport(vm, live, state, opts = {}) {
  const wide = !!opts.wide;
  const busy = !!(state && state.busy);
  const refresh = state && typeof state.refresh === 'function' ? state.refresh : () => {};
  const canRefresh = !state || state.canRefresh !== false;
  const rateLimitLeft = (state && state.rateLimitLeft) || 0;
  const cooldownLeft = (state && state.cooldownLeft) || 0;
  const L = vm.locale === 'en' ? en : zh;
  const verdict = classifyProbability(vm.probability);
  const tone = TONE_VAR[verdict.tone] || TONE_VAR.neutral;
  const stateLabel =
    vm.liveState === 'live' ? L.live
      : vm.liveState === 'partial' ? L.partial
        : vm.liveState === 'degraded' ? L.degraded
          : vm.liveState === 'error' ? L.failed
            : L.offline;

  const buttonStyle = {
    background: 'transparent',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 6,
    color: 'var(--dsw-alias-label-secondary)',
    cursor: busy ? 'default' : 'pointer',
    fontSize: 11,
    padding: '3px 8px',
  };

  const sectionTitle = {
    margin: '14px 0 5px',
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--dsw-alias-label-secondary)',
  };

  const statItems = [
    { label: L.statTotal, value: vm.totals.tianyicui.toLocaleString(), note: 'deepseek-harness' },
    { label: L.statAllRepos, value: vm.repoScan.total.toLocaleString(), note: L.allReposNote },
    ...(vm.contributions ? [{
      label: L.contribStat,
      value: vm.contributions.total.toLocaleString(),
      note: L.contribNote,
    }] : []),
    { label: L.statTeam, value: vm.totals.all.toLocaleString() },
    { label: L.statRecent, value: vm.totals.recent7.toLocaleString() },
    { label: L.statAge, value: vm.age == null ? '—' : `${vm.age.toFixed(1)} h` },
    { label: L.statReleases, value: String(vm.totals.releases) },
    { label: L.statSample, value: String(vm.metrics.effectiveSample) },
  ];

  const evidenceRows = [
    { label: L.brier, value: vm.metrics.brier.toFixed(4), note: `${L.brierNote} (${vm.metrics.baselineBrier.toFixed(4)})` },
    { label: L.auc, value: vm.metrics.auc.toFixed(3), note: L.aucNote },
    { label: L.ece, value: `${(vm.metrics.ece * 100).toFixed(2)} pp`, note: L.eceNote },
    { label: `${L.hit} ≥${LIKELY_THRESHOLD * 100}%`, value: hitRowText(vm.metrics, L), note: L.hitNote },
    { label: L.bucket, value: hazardBucketText(vm.parts), note: `${L.rawVsCal} ${vm.rawProbability == null ? '—' : (vm.rawProbability * 100).toFixed(1)}% / ${vm.probability == null ? '—' : (vm.probability * 100).toFixed(1)}%` },
  ];

  const header = React.createElement('div', {
    style: {
      display: 'flex', alignItems: 'center', gap: 8,
      // stays put while the report scrolls, so the refresh control is always reachable
      position: 'sticky', top: 0, zIndex: 2,
      padding: wide ? '10px 0 8px' : '0 0 6px',
      marginBottom: 6,
      background: 'var(--dsw-alias-bg-base, transparent)',
      borderBottom: `1px solid var(--dsw-alias-border-l1)`,
    },
  },
    React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0 } },
      React.createElement('div', { style: { fontSize: 15, fontWeight: 600 } }, L.title),
      React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
        `${L.subtitle} · ${stateLabel}`,
        live && live.fetchedAt ? ` · ${new Date(live.fetchedAt).toLocaleTimeString()}` : ''),
    ),
    React.createElement('button', {
      type: 'button',
      onClick: refresh,
      disabled: !canRefresh,
      title: busy ? L.refreshing
        : rateLimitLeft > 0 ? L.rateLimited
          : cooldownLeft > 0 ? L.cooldown
            : L.refresh,
      'aria-busy': busy ? 'true' : 'false',
      style: {
        ...buttonStyle,
        cursor: canRefresh ? 'pointer' : 'default',
        opacity: canRefresh ? 1 : 0.55,
      },
    },
      busy ? L.refreshing
        : rateLimitLeft > 0 ? `${L.rateLimited} ${fmtWait(rateLimitLeft)}`
          : cooldownLeft > 0 ? `${L.cooldown} ${Math.ceil(cooldownLeft / 1000)}s`
            : L.refresh),
  );

  const headline = React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' } },
    React.createElement(ProbabilityGauge, {
      probability: vm.probability, level: verdict.level, theme: THEME, locale: vm.locale, size: wide ? 172 : 150,
    }),
    React.createElement('div', { style: { minWidth: 200 } },
      React.createElement('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
        vm.locale === 'en' ? `New DSH version within ${HORIZON_HOURS}h` : `未来 ${HORIZON_HOURS} 小时内发布新版本`),
      React.createElement('div', { style: { fontSize: 20, fontWeight: 600, color: tone, marginTop: 2 } },
        vm.locale === 'en' ? verdict.labelEn : verdict.label),
      React.createElement('div', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6, lineHeight: 1.6 } },
        `${L.rawVsCal}: ${vm.rawProbability == null ? '—' : (vm.rawProbability * 100).toFixed(1)}% / ${vm.probability == null ? '—' : (vm.probability * 100).toFixed(1)}%`),
    ),
  );

  // The line chart and the heatmap share one selection, so clicking either
  // highlights both and fills in the detail readout underneath.
  const charts = React.createElement(MonitorCharts, {
    daily: vm.daily,
    heat: vm.heat,
    releases: vm.releases,
    theme: THEME,
    locale: vm.locale,
    wide,
  });

  const errorNote = live && live.error
    ? React.createElement('div', {
        style: {
          fontSize: 10, lineHeight: 1.5, marginBottom: 8, padding: '6px 8px',
          borderRadius: 6,
          color: 'var(--dsw-alias-state-warn-primary)',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
        },
      },
      rateLimitLeft > 0
        ? `${L.rateLimited} · ${fmtWait(rateLimitLeft)} — ${L.rateLimitedBody}`
        : live.error,
      live.lastAttemptFailed ? ` · ${L.keptLastGood}` : '')
    : null;

  // The main panel is a fixed viewport, so the report owns its own scrolling
  // container: a long report must never be clipped with no way to reach the rest.
  const body = React.createElement('div', {
    style: {
      padding: wide ? '0 22px 32px' : '0 0 8px',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 12,
      fontFamily: 'inherit',
      maxWidth: wide ? 1100 : undefined,
    },
  },
    errorNote,
    headline,
    React.createElement('div', { style: sectionTitle }, L.totals),
    React.createElement(StatRow, { items: statItems, theme: THEME }),
    charts,
    vm.modelReleases && vm.modelReleases.some((m) => m.flagship) ? React.createElement(React.Fragment, null,
      React.createElement('div', { style: sectionTitle }, L.modelTimeline),
      React.createElement(ModelTimeline, {
        models: vm.modelReleases,
        dshReleases: vm.releases,
        theme: THEME,
        locale: vm.locale,
        wide,
      }),
    ) : null,

    vm.contributions ? React.createElement(React.Fragment, null,
      React.createElement('div', { style: sectionTitle }, `${L.contribStat} · ${L.contribNote}`),
      React.createElement(ContributionStrip, {
        contributions: vm.contributions,
        publicDays: new Set(vm.daily.filter((d) => d.all > 0).map((d) => d.day)),
        theme: THEME,
        locale: vm.locale,
        wide,
      }),
    ) : null,

    React.createElement('div', { style: sectionTitle }, L.evidence),
    React.createElement(EvidenceTable, { rows: evidenceRows, theme: THEME }),
    React.createElement('div', { style: { marginTop: 10, fontSize: 10, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 } },
      React.createElement('div', null,
        `${L.coverage}: ${vm.repoScan.scanned}/${vm.repoScan.known} ${vm.locale === 'en' ? 'public repos scanned' : '个公开仓库已扫描'}`
        + ` · ${vm.locale === 'en' ? 'private repos visible' : '可见私有仓库'}: ${vm.repoScan.privateVisible}`
        + (vm.repoScan.generatedAt ? ` · ${new Date(vm.repoScan.generatedAt).toLocaleDateString()}` : '')),
      React.createElement('div', { style: { marginTop: 4 } }, L.disclaimer),
    ),
  );

  return React.createElement('div', {
    style: {
      height: '100%',
      maxHeight: '100%',
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      overflow: 'hidden',
      boxSizing: 'border-box',
      paddingTop: wide ? 'calc(var(--dsh-frame-top-clearance, 48px) + 6px)' : 0,
    },
  },
    header,
    React.createElement('div', {
      style: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        overscrollBehavior: 'contain',
        // keep the scrollbar clear of the panel edge
        scrollbarGutter: 'stable',
        paddingRight: wide ? 6 : 0,
      },
    }, body),
  );
}

/* ------------------------------------------------------------------ *
 * plugin body
 * ------------------------------------------------------------------ */

/** Panel id; the sidebar list id and the `main` key must match it. */
export const PANEL_ID = 'tianyicui-monitor';

export function apply(ctx) {
  // `locale` is not a baseline module and this package declares no ordering
  // against it, so treat it as optional: the panel already ships its own zh/en
  // strings and picks between them from `navigator.language`. Registering the
  // dictionaries is a nicety for other consumers, never a prerequisite for the
  // slot, so a missing service must not take the entry down with it.
  try {
    if (ctx.locale && typeof ctx.locale.register === 'function') {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tianyicui-monitor: dictionaries');
    }
  } catch {
    /* locale unavailable — the panel still renders with its built-in strings */
  }

  // Sidebar row (icon + label), exactly like Plugins / Qwen-Image / MCP.
  // The sidebar owns the row, tooltip, hover and selected state; our component
  // receives `{ size, active }` and draws only the glyph.
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: '提交监控' },
      MonitorEntry,
    ),
  );

  // The report itself. The sidebar's own click handler calls
  // `selectPanel(PANEL_ID)`, which throws when the `main` keyed slot has no
  // matching key — this registration is both that key and the actual UI.
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_ID },
      MonitorReport,
    ),
  );
}
