/**
 * tianyicui-monitor — panel views.
 *
 * React components for the compact top-left panel. They are deliberately thin:
 * all geometry comes from ./charts.js (pure) and every color/font comes from the
 * `theme` prop, so the same element looks native in light and dark mode.
 *
 * Written with React.createElement (no JSX) so the source needs no transform
 * step. `react` is supplied by the DSH module system at runtime.
 *
 * Robustness contract: null props, empty arrays and degenerate input must never
 * throw — an em dash is rendered instead.
 */

import React from 'react';
import {
  AREA_COLORS,
  DEFAULT_HEAT_GUTTER,
  GAUGE_THRESHOLD,
  buildAreaGeometry,
  buildAreaPath,
  buildLinePath,
  buildHeatmapGeometry,
  gaugeArc,
} from './charts.js';
import { classifyProbability, toneColor } from './classify.js';

const h = React.createElement;

/* ------------------------------------------------------------------ *
 * theme + i18n helpers
 * ------------------------------------------------------------------ */

const FALLBACK_COLOR = 'currentColor';

function themeOf(theme) {
  return theme && typeof theme === 'object' ? theme : {};
}

/** Read a theme color; never originate a literal color here. */
function colorOf(theme, key, fallback) {
  const v = themeOf(theme)[key];
  if (typeof v === 'string' && v) return v;
  return fallback === undefined ? FALLBACK_COLOR : fallback;
}

function fontOf(theme) {
  return colorOf(theme, 'font', 'inherit');
}

function numProp(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function textOf(value) {
  if (value === null || value === undefined) return '—';
  const s = String(value);
  return s === '' ? '—' : s;
}

const LABELS_ZH = {
  empty: '—',
  noData: '暂无数据',
  trend: '提交趋势',
  release: '发布',
  threshold: '阈值',
  less: '少',
  more: '多',
  peak: '峰值',
  selected: '已选',
  clearSelection: '取消选中',
  prev: '前一天',
  next: '后一天',
  hint: '点击折线图或热度图选中某一天',
  commitUnit: '次提交',
  releaseDay: '当天发布了版本',
  noRelease: '当天未发布',
  team: '全团队',
  heatLabel: '提交热度图',
  contribStat: 'GitHub 贡献图',
  contribPrivate: '私有活跃',
  contribPublic: '有公开提交',
  contribPrivateOnly: '有贡献但无公开提交',
  modelTimeline: 'DeepSeek 模型发布',
  modelLaunch: '模型发布',
  dshRelease: 'DSH 发版',
  models: '个模型',
  modelNearest: '最近 DSH 发版',
  modelNote: '模型发布日期取 Hugging Face 模型卡创建时间。仅作时间线参考 —— '
    + '窗口内模型发布太少，不足以作为预测变量，因此不参与概率计算。',
  modelObserve: (n, lag) => `DSH 首个版本之后的 ${n} 次旗舰模型发布，紧随其后的 DSH 发版间隔为 ${lag} 天。`
    + '样本仅 3 次，是模式而非可测量的效应；不构成「模型发布导致 DSH 发版」的因果证据。',
  modelLegacy: (n) => `更早的 ${n} 次模型发布发生在 DSH 首个公开版本之前，无法与发版节奏对照。`,
  contribExplain: 'GitHub 贡献图统计的是「贡献」（commit + PR + issue + review），不是提交数；'
    + '该账号开启了「在个人主页显示私有贡献」，所以这些数字已包含私有仓库的活动。'
    + 'GitHub 只返回数量，不返回是哪个仓库，因此这一行不能和提交数相加。',
};

const LABELS_EN = {
  empty: '—',
  noData: 'no data',
  trend: 'Commit trend',
  release: 'release',
  threshold: 'threshold',
  less: 'less',
  more: 'more',
  peak: 'peak',
  selected: 'selected',
  clearSelection: 'Clear selection',
  prev: 'Previous day',
  next: 'Next day',
  hint: 'Click the line chart or the heatmap to select a day',
  commitUnit: 'commits',
  releaseDay: 'a version shipped that day',
  noRelease: 'no release that day',
  team: 'whole team',
  heatLabel: 'Commit heatmap',
  contribStat: 'GitHub contributions',
  contribPrivate: 'private activity',
  contribPublic: 'has public commits',
  contribPrivateOnly: 'contributions but no public commit',
  modelTimeline: 'DeepSeek model releases',
  modelLaunch: 'model launch',
  dshRelease: 'DSH release',
  models: 'models',
  modelNearest: 'nearest DSH release',
  modelNote: 'Model dates come from Hugging Face model-card creation time. Timeline context only — '
    + 'too few model launches fall inside the window to be a predictor, so they do not enter the probability.',
  modelObserve: (n, lag) => `Each of the ${n} flagship launches after DSH's first release was followed by a DSH release within ${lag} days. `
    + 'With only 3 observations that is a pattern, not a measurable effect, and it is not evidence that a model launch causes a DSH release.',
  modelLegacy: (n) => `The earlier ${n} launches predate DSH's first public release, so they cannot be compared against its cadence.`,
  contribExplain: 'GitHub\'s contribution graph counts "contributions" (commits + pull requests + issues + code reviews), not commits. '
    + 'This account has "include private contributions on my profile" enabled, so these daily numbers already fold in private work. '
    + 'GitHub returns only the count, never the repository, so this row must not be added to the commit totals.',
};

/** Per-component strings for a level, so `level` ot `probability` agree. */
const LEVEL_TEXT = {
  'release-likely': { zh: '很可能发布', en: 'release likely' },
  watch: { zh: '关注', en: 'watch' },
  quiet: { zh: '平静', en: 'quiet' },
  unknown: { zh: '暂无数据', en: 'no data' },
};

/**
 * Built-in strings are Chinese by default (the locale this panel ships for);
 * pass `locale="en"` for English, and/or `labels={{...}}` to override any key.
 */
function labelsOf(props) {
  const base = props && props.locale === 'en' ? LABELS_EN : LABELS_ZH;
  const custom = props && props.labels && typeof props.labels === 'object' ? props.labels : null;
  return custom ? { ...base, ...custom } : base;
}

/** `YYYY-MM-DD` -> `MM-DD`, matching the axis labels the geometry emits. */
function shortDayLabel(day) {
  const s = typeof day === 'string' ? day : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.slice(5) : s;
}

function isEn(props) {
  return !!(props && props.locale === 'en');
}

function emptyBox(theme, text, note) {
  return h(
    'div',
    {
      title: note || (typeof text === 'string' ? text : 'no data'),
      style: {
        fontFamily: fontOf(theme),
        fontSize: 11,
        lineHeight: 1.6,
        color: colorOf(theme, 'labelTertiary', FALLBACK_COLOR),
        padding: '10px 0',
        textAlign: 'center',
      },
    },
    textOf(text),
  );
}

const TONE_BY_LEVEL = {
  'release-likely': 'danger',
  watch: 'warn',
  quiet: 'calm',
  unknown: 'neutral',
};

/* ------------------------------------------------------------------ *
 * LineChart — commits over time with release markers
 * ------------------------------------------------------------------ */

/**
 * @param {{daily:Array,theme:object,metric:'tianyicui'|'all',height?:number,width?:number}} props
 */
export function LineChart(props) {
  const p = props || {};
  const theme = p.theme;
  const L = labelsOf(p);
  const metric = p.metric === 'all' ? 'all' : 'tianyicui';
  const daily = Array.isArray(p.daily) ? p.daily : [];
  const width = numProp(p.width, 380);
  const height = numProp(p.height, 120);
  const onSelect = typeof p.onSelect === 'function' ? p.onSelect : null;
  const selected = typeof p.selected === 'string' && p.selected ? p.selected : null;
  const interactive = !!(onSelect && daily.length);

  if (!daily.length) return emptyBox(theme, L.empty, L.noData);

  const geomOpts = {
    width,
    height,
    pad: { top: 10, right: 10, bottom: 18, left: 28 },
    series: metric,
  };

  let geom;
  try {
    geom = buildAreaGeometry(daily, geomOpts);
  } catch (err) {
    return emptyBox(theme, L.empty, String((err && err.message) || err));
  }
  if (!geom.points.length) return emptyBox(theme, L.empty, L.noData);

  const gridColor = colorOf(theme, 'border');
  const axisColor = colorOf(theme, 'labelTertiary');
  const lineColor = metric === 'all' ? colorOf(theme, 'labelSecondary') : colorOf(theme, 'accent');
  const releaseColor = colorOf(theme, 'danger');
  const selectColor = colorOf(theme, 'accent');
  const { plot } = geom;
  const gradId = `tcm-area-${metric}${p.idSuffix ? `-${p.idSuffix}` : ''}`;

  const areaD = buildAreaPath(daily, geomOpts);
  const lineD = buildLinePath(daily, geomOpts);

  // One hit zone per day, spanning the full plot height so the whole column is
  // clickable — a 2px dot would be unusable.
  const seg = geom.points.length > 1
    ? (plot.x1 - plot.x0) / (geom.points.length - 1)
    : (plot.x1 - plot.x0);
  const hitW = Math.max(4, seg);
  const selectedPt = selected ? geom.points.find((pt) => pt.day === selected) : null;

  const children = [];
  children.push(
    h(
      'title',
      { key: 'title' },
      `${L.trend} · ${metric} · ${geom.count} · ${L.peak} ${geom.max}`,
    ),
  );
  children.push(
    h(
      'defs',
      { key: 'defs' },
      h(
        'linearGradient',
        { id: gradId, x1: 0, y1: 0, x2: 0, y2: 1 },
        h('stop', { key: 's0', offset: '0%', stopColor: lineColor, stopOpacity: 0.32 }),
        h('stop', { key: 's1', offset: '100%', stopColor: lineColor, stopOpacity: 0.02 }),
      ),
    ),
  );

  // selected column highlight sits UNDER the data so it reads as a backdrop
  if (selectedPt) {
    children.push(
      h('rect', {
        key: 'sel-band',
        x: Math.max(plot.x0, selectedPt.x - hitW / 2),
        y: plot.y0,
        width: Math.min(hitW, plot.x1 - Math.max(plot.x0, selectedPt.x - hitW / 2)),
        height: plot.y1 - plot.y0,
        fill: selectColor,
        opacity: 0.12,
        'aria-hidden': 'true',
      }),
    );
  }

  geom.gridLines.forEach((g, i) => {
    children.push(
      h('line', {
        key: `grid-${i}`,
        x1: plot.x0,
        x2: plot.x1,
        y1: g.y,
        y2: g.y,
        stroke: gridColor,
        strokeWidth: 1,
        opacity: 0.55,
        'aria-hidden': 'true',
      }),
    );
  });

  if (areaD) {
    children.push(h('path', { key: 'area', d: areaD, fill: `url(#${gradId})`, stroke: 'none', 'aria-hidden': 'true' }));
  }
  if (lineD) {
    children.push(
      h(
        'path',
        {
          key: 'line',
          d: lineD,
          fill: 'none',
          stroke: lineColor,
          strokeWidth: 1.5,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        },
        h('title', { key: 't' }, `${L.trend} · ${metric} · ${L.peak} ${geom.max}`),
      ),
    );
  }

  geom.points.forEach((pt, i) => {
    if (!pt.isReleaseDay && pt.day !== selected) return;
    if (pt.isReleaseDay) {
      children.push(
        h(
          'line',
          {
            key: `rel-${i}`,
            x1: pt.x,
            x2: pt.x,
            y1: plot.y0,
            y2: plot.y1,
            stroke: releaseColor,
            strokeWidth: 1,
            strokeDasharray: '3 3',
            opacity: 0.55,
          },
          h('title', { key: 't' }, `${pt.day} · ${L.release}`),
        ),
      );
    }
  });

  // selection crosshair + marker, above the data
  if (selectedPt) {
    children.push(
      h('line', {
        key: 'sel-line',
        x1: selectedPt.x,
        x2: selectedPt.x,
        y1: plot.y0,
        y2: plot.y1,
        stroke: selectColor,
        strokeWidth: 1,
        'aria-hidden': 'true',
      }),
      h('circle', {
        key: 'sel-dot',
        cx: selectedPt.x,
        cy: selectedPt.y,
        r: 3.6,
        fill: selectColor,
        stroke: colorOf(theme, 'bg2', '#fff'),
        strokeWidth: 1.5,
      },
      h('title', { key: 'sel-t' }, `${selectedPt.day} · ${selectedPt.value}`)),
    );
  }

  geom.yTicks.forEach((t, i) => {
    children.push(
      h(
        'text',
        {
          key: `yt-${i}`,
          x: plot.x0 - 4,
          y: t.y + 3,
          textAnchor: 'end',
          fontSize: 9,
          fill: axisColor,
          fontFamily: fontOf(theme),
        },
        t.label,
      ),
    );
  });

  // The geometry only samples a few x ticks, so the selected day always gets its
  // own label on top — otherwise selecting a day you cannot read is useless.
  const xTicks = geom.xTicks.slice();
  if (selectedPt && !xTicks.some((t) => t.day === selectedPt.day)) {
    xTicks.push({
      x: selectedPt.x,
      label: shortDayLabel(selectedPt.day),
      index: selectedPt.index,
      day: selectedPt.day,
    });
    xTicks.sort((a, b) => a.x - b.x);
  }

  xTicks.forEach((t, i) => {
    const isSel = t.day === selected;
    const anchor = i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle';
    children.push(
      h(
        'text',
        {
          key: `xt-${i}`,
          x: t.x,
          y: height - 5,
          textAnchor: anchor,
          fontSize: 9,
          fill: isSel ? selectColor : axisColor,
          fontWeight: isSel ? 600 : 400,
          fontFamily: fontOf(theme),
        },
        t.label,
      ),
    );
  });

  const last = geom.points[geom.points.length - 1];
  if (last && last.day !== selected) {
    children.push(
      h(
        'circle',
        { key: 'last', cx: last.x, cy: last.y, r: 2.2, fill: lineColor },
        h('title', { key: 't' }, `${last.day} · ${last.value}`),
      ),
    );
  }

  // interactive layer: full-height hit zones, last so they win every hit test
  if (interactive) {
    geom.points.forEach((pt, i) => {
      const isSel = pt.day === selected;
      const x0 = Math.max(plot.x0, pt.x - hitW / 2);
      const x1 = Math.min(plot.x1, pt.x + hitW / 2);
      children.push(
        h('rect', {
          key: `hit-${i}`,
          x: x0,
          y: plot.y0,
          width: Math.max(1, x1 - x0),
          height: plot.y1 - plot.y0,
          fill: 'transparent',
          tabIndex: 0,
          role: 'button',
          'aria-label': `${pt.day}: ${pt.value} ${L.commitUnit}`,
          'aria-pressed': isSel ? 'true' : 'false',
          style: { cursor: 'pointer', outline: 'none' },
          onClick: () => onSelect(pt.day),
          onKeyDown: (e) => {
            if (e && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              onSelect(pt.day);
            }
          },
        }),
      );
    });
  }

  return h(
    'svg',
    {
      viewBox: `0 0 ${geom.width} ${geom.height}`,
      width: '100%',
      height: geom.height,
      role: 'img',
      'aria-label': `${L.trend} (${metric}): n=${geom.count}, ${L.peak} ${geom.max}`,
      style: { display: 'block', maxWidth: '100%', height: 'auto', overflow: 'visible' },
    },
    children,
  );
}
/* ------------------------------------------------------------------ *
 * Heatmap — GitHub-style contribution grid
 * ------------------------------------------------------------------ */

/**
 * @param {{heat:object,theme:object,cell?:number,gap?:number,max?:number}} props
 */
export function Heatmap(props) {
  const p = props || {};
  const theme = p.theme;
  const L = labelsOf(p);
  const onSelect = typeof p.onSelect === 'function' ? p.onSelect : null;
  const selected = typeof p.selected === 'string' && p.selected ? p.selected : null;

  let geom;
  try {
    geom = buildHeatmapGeometry(p.heat, {
      cell: numProp(p.cell, 10),
      gap: numProp(p.gap, 2),
      corner: 2,
      gutter: DEFAULT_HEAT_GUTTER,
      max: p.max,
      colors: AREA_COLORS,
      emptyColor: colorOf(theme, 'bg2', 'transparent'),
    });
  } catch (err) {
    return emptyBox(theme, L.empty, String((err && err.message) || err));
  }
  if (!geom.cells.length) return emptyBox(theme, L.empty, L.noData);

  const labelColor = colorOf(theme, 'labelTertiary');
  const selectColor = colorOf(theme, 'accent');
  const children = [];
  children.push(
    h('title', { key: 'title' }, `${L.trend} · ${geom.weeks}w · max ${geom.max}`),
  );

  geom.cells.forEach((cell) => {
    const isSel = cell.key === selected;
    const rectProps = {
      key: cell.key,
      x: cell.x,
      y: cell.y,
      width: cell.size,
      height: cell.size,
      rx: cell.rx,
      ry: cell.rx,
      fill: cell.fill,
    };
    if (onSelect && cell.inRange) {
      rectProps.tabIndex = 0;
      rectProps.role = 'button';
      rectProps['aria-label'] = `${cell.key}: ${cell.value == null ? 0 : cell.value} ${L.commitUnit}${isSel ? ` (${L.selected})` : ''}`;
      rectProps['aria-pressed'] = isSel ? 'true' : 'false';
      rectProps.style = { cursor: 'pointer', outline: 'none' };
      rectProps.onClick = () => onSelect(cell.key);
      rectProps.onKeyDown = (e) => {
        if (e && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect(cell.key);
        }
      };
    }
    children.push(h('rect', rectProps, h('title', { key: 't' }, cell.title)));
    if (isSel) {
      children.push(
        h('rect', {
          key: `sel-${cell.key}`,
          x: cell.x - 1,
          y: cell.y - 1,
          width: cell.size + 2,
          height: cell.size + 2,
          rx: cell.rx + 1,
          ry: cell.rx + 1,
          fill: 'none',
          stroke: selectColor,
          strokeWidth: 1.6,
          'aria-hidden': 'true',
          pointerEvents: 'none',
        }),
      );
    }
  });

  geom.monthLabels.forEach((m, i) => {
    children.push(
      h(
        'text',
        {
          key: `m-${i}`,
          x: m.x,
          y: Math.max(9, geom.gutter.top - 4),
          fontSize: 9,
          fill: labelColor,
          fontFamily: fontOf(theme),
        },
        m.label,
      ),
    );
  });

  // Only Mon / Wed / Fri are labelled: at 10px cells seven labels would collide.
  geom.dayLabels.forEach((d, i) => {
    if (i % 2 !== 0) return;
    children.push(
      h(
        'text',
        {
          key: `d-${i}`,
          x: Math.max(0, geom.gutter.left - 5),
          y: d.y + 3,
          textAnchor: 'end',
          fontSize: 9,
          fill: labelColor,
          fontFamily: fontOf(theme),
        },
        d.label,
      ),
    );
  });

  const legend = h(
    'div',
    {
      key: 'legend',
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        marginTop: 4,
        fontFamily: fontOf(theme),
        fontSize: 9,
        color: labelColor,
      },
    },
    [h('span', { key: 'less' }, L.less)].concat(
      AREA_COLORS.slice(1).map((c, i) =>
        h('span', {
          key: `sw-${i}`,
          title: `level ${i + 1}`,
          style: { width: 9, height: 9, borderRadius: 2, background: c, display: 'inline-block' },
        }),
      ),
      [h('span', { key: 'more' }, L.more)],
    ),
  );

  const svg = h(
    'svg',
    {
      viewBox: `0 0 ${geom.width} ${geom.height}`,
      width: geom.width,
      height: geom.height,
      role: 'img',
      'aria-label': `${L.trend}: ${geom.weeks} weeks, ${L.peak} ${geom.max}`,
      style: { display: 'block', maxWidth: '100%', height: 'auto' },
    },
    children,
  );

  return h('div', { style: { display: 'flex', flexDirection: 'column' } }, [svg, legend]);
}
/* ------------------------------------------------------------------ *
 * ProbabilityGauge — 270 degree arc with the 90% threshold tick
 * ------------------------------------------------------------------ */

/**
 * @param {{probability:number|null,level?:string,theme:object,size?:number,stroke?:number}} props
 */
export function ProbabilityGauge(props) {
  const p = props || {};
  const theme = p.theme;
  const L = labelsOf(p);

  const raw = typeof p.probability === 'number' && Number.isFinite(p.probability) ? p.probability : null;
  const info = classifyProbability(raw);
  const level = typeof p.level === 'string' && TONE_BY_LEVEL[p.level] ? p.level : info.level;
  const tone = TONE_BY_LEVEL[level] || 'neutral';
  const color = toneColor(tone, theme);

  const size = numProp(p.size, 132);
  const stroke = numProp(p.stroke, 10);

  let g;
  try {
    g = gaugeArc(raw, { size, stroke });
  } catch (err) {
    return emptyBox(theme, L.empty, String((err && err.message) || err));
  }

  const pct = raw === null ? '—' : `${Math.round(raw * 100)}%`;
  const thresholdPct = `${Math.round(GAUGE_THRESHOLD * 100)}%`;
  const levelText = LEVEL_TEXT[level] || LEVEL_TEXT.unknown;
  const label = levelText[isEn(p) ? 'en' : 'zh'];

  const captionY = g.cy + g.r - 6;

  const children = [
    h(
      'title',
      { key: 'title' },
      `${pct} · ${L.threshold} ${thresholdPct}`,
    ),
    h('path', {
      key: 'track',
      d: g.trackPath,
      fill: 'none',
      stroke: colorOf(theme, 'border'),
      strokeWidth: stroke,
      strokeLinecap: 'round',
      'aria-hidden': 'true',
    }),
  ];

  if (g.path) {
    children.push(
      h(
        'path',
        {
          key: 'value',
          d: g.path,
          fill: 'none',
          stroke: color,
          strokeWidth: stroke,
          strokeLinecap: 'round',
        },
        h('title', { key: 't' }, `${pct} · ${label}`),
      ),
    );
  }

  children.push(
    h(
      'line',
      {
        key: 'threshold',
        x1: g.threshold.x1,
        y1: g.threshold.y1,
        x2: g.threshold.x2,
        y2: g.threshold.y2,
        stroke: colorOf(theme, 'labelSecondary'),
        strokeWidth: 1.5,
        strokeDasharray: '2 2',
      },
      h('title', { key: 't' }, `${L.threshold} ${thresholdPct}`),
    ),
  );

  children.push(
    h(
      'text',
      {
        key: 'value-text',
        x: g.cx,
        y: g.cy - 4,
        textAnchor: 'middle',
        dominantBaseline: 'middle',
        fontSize: 26,
        fontWeight: 600,
        fill: colorOf(theme, 'label'),
        fontFamily: fontOf(theme),
      },
      pct,
    ),
  );
  children.push(
    h(
      'text',
      {
        key: 'level-text',
        x: g.cx,
        y: g.cy + 18,
        textAnchor: 'middle',
        fontSize: 11,
        fill: color,
        fontFamily: fontOf(theme),
      },
      label,
    ),
  );
  children.push(
    h(
      'text',
      {
        key: 'threshold-text',
        x: g.cx,
        y: captionY,
        textAnchor: 'middle',
        fontSize: 9,
        fill: colorOf(theme, 'labelTertiary'),
        fontFamily: fontOf(theme),
      },
      `${L.threshold} ${thresholdPct}`,
    ),
  );

  return h(
    'svg',
    {
      viewBox: `0 0 ${g.size} ${g.size}`,
      width: g.size,
      height: g.size,
      role: 'img',
      'aria-label': `${pct} (${label}), ${L.threshold} ${thresholdPct}`,
      style: { display: 'block', maxWidth: '100%', height: 'auto' },
    },
    children,
  );
}

/* ------------------------------------------------------------------ *
 * StatRow — compact metric strip
 * ------------------------------------------------------------------ */

/**
 * @param {{items:Array<{label:string,value:string|number,note?:string}>,theme:object}} props
 */
export function StatRow(props) {
  const p = props || {};
  const theme = p.theme;
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) return emptyBox(theme, '—', 'no stats');

  const blocks = items.map((item, i) => {
    const it = item && typeof item === 'object' ? item : {};
    const label = textOf(it.label);
    const value = textOf(it.value);
    const note = it.note === null || it.note === undefined || it.note === '' ? null : String(it.note);
    return h(
      'div',
      {
        key: `${label}-${i}`,
        title: note ? `${label}: ${value} (${note})` : `${label}: ${value}`,
        style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 56 },
      },
      h(
        'div',
        {
          style: {
            fontSize: 15,
            fontWeight: 600,
            lineHeight: 1.15,
            color: colorOf(theme, 'label'),
            fontVariantNumeric: 'tabular-nums',
            fontFamily: fontOf(theme),
          },
        },
        value,
      ),
      h(
        'div',
        {
          style: {
            fontSize: 10,
            lineHeight: 1.3,
            color: colorOf(theme, 'labelTertiary'),
            fontFamily: fontOf(theme),
            whiteSpace: 'nowrap',
          },
        },
        label,
      ),
      note
        ? h(
            'div',
            {
              style: {
                fontSize: 9,
                lineHeight: 1.3,
                color: colorOf(theme, 'labelSecondary'),
                fontFamily: fontOf(theme),
                whiteSpace: 'nowrap',
              },
            },
            note,
          )
        : null,
    );
  });

  return h(
    'div',
    {
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px 14px',
        padding: '2px 0',
        fontFamily: fontOf(theme),
      },
    },
    blocks,
  );
}

/* ------------------------------------------------------------------ *
 * EvidenceTable — label / value / note rows
 * ------------------------------------------------------------------ */

/**
 * @param {{rows:Array<{label:string,value:string,note?:string}>,theme:object}} props
 */
export function EvidenceTable(props) {
  const p = props || {};
  const theme = p.theme;
  const rows = Array.isArray(p.rows) ? p.rows : [];
  const data = rows.length ? rows : [{ label: '—', value: '—' }];
  const border = colorOf(theme, 'border', 'transparent');

  const body = data.map((row, i) => {
    const r = row && typeof row === 'object' ? row : {};
    const label = textOf(r.label);
    const value = textOf(r.value);
    const note = r.note === null || r.note === undefined || r.note === '' ? null : String(r.note);
    return h(
      'tr',
      {
        key: `${label}-${i}`,
        title: note ? `${label}: ${value} (${note})` : `${label}: ${value}`,
        style: { borderTop: i === 0 ? 'none' : `1px solid ${border}` },
      },
      h(
        'td',
        {
          style: {
            padding: '3px 0',
            color: colorOf(theme, 'labelSecondary'),
            whiteSpace: 'nowrap',
            verticalAlign: 'top',
          },
        },
        label,
      ),
      h(
        'td',
        {
          style: {
            padding: '3px 8px',
            textAlign: 'right',
            color: colorOf(theme, 'label'),
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            verticalAlign: 'top',
          },
        },
        value,
      ),
      h(
        'td',
        {
          style: {
            padding: '3px 0',
            fontSize: 10,
            color: colorOf(theme, 'labelTertiary'),
            verticalAlign: 'top',
          },
        },
        note || '',
      ),
    );
  });

  return h(
    'table',
    {
      style: {
        width: '100%',
        borderCollapse: 'collapse',
        fontFamily: fontOf(theme),
        fontSize: 11,
        lineHeight: 1.5,
      },
    },
    h('tbody', null, body),
  );
}

/* ------------------------------------------------------------------ *
 * IconMonitor — sidebar panellist glyph
 *
 * A commit graph: two branch rails meeting at a node, with commits hanging off
 * them. Drawn with `currentColor` and an 18px default so the sidebar owns the
 * colour and hover state, exactly like the sibling panel icons.
 * ------------------------------------------------------------------ */

/**
 * @param {{size?:number}} props
 */
export function IconMonitor(props) {
  const size = numProp((props || {}).size, 18);
  return h(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('path', {
      d: 'M5 3.5v17M12 3.5v17M12 10.2a5.4 5.4 0 0 1 5.4 5.4v4.9',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    h('circle', { cx: 5, cy: 7.4, r: 2.1, fill: 'currentColor' }),
    h('circle', { cx: 12, cy: 14.6, r: 2.1, fill: 'currentColor' }),
    h('circle', { cx: 17.4, cy: 18.4, r: 2.1, fill: 'currentColor' }),
  );
}

/* ------------------------------------------------------------------ *
 * DayDetail — the readout for whatever the charts have selected
 * ------------------------------------------------------------------ */

/**
 * @param {{day:string|null, detail:object|null, theme:object, locale?:string,
 *          onPrev?:Function, onNext?:Function, onClear?:Function}} props
 */
export function DayDetail(props) {
  const p = props || {};
  const theme = p.theme;
  const L = labelsOf(p);
  const day = typeof p.day === 'string' && p.day ? p.day : null;
  const d = p.detail && typeof p.detail === 'object' ? p.detail : null;

  if (!day || !d) {
    return h(
      'div',
      {
        style: {
          fontFamily: fontOf(theme), fontSize: 11, lineHeight: 1.6,
          color: colorOf(theme, 'labelTertiary'), padding: '8px 0',
        },
      },
      L.hint,
    );
  }

  const chip = (label, value, tone) =>
    h(
      'div',
      { key: label, style: { display: 'flex', flexDirection: 'column', gap: 1, minWidth: 62 } },
      h('span', { style: { fontSize: 9, color: colorOf(theme, 'labelTertiary') } }, label),
      h(
        'span',
        {
          style: {
            fontSize: 14, fontVariantNumeric: 'tabular-nums',
            color: tone || colorOf(theme, 'label'),
          },
        },
        String(value),
      ),
    );

  const navBtn = (key, label, handler, disabled) =>
    h(
      'button',
      {
        key,
        type: 'button',
        title: label,
        'aria-label': label,
        disabled: !!disabled,
        onClick: handler,
        style: {
          background: 'transparent',
          border: `1px solid ${colorOf(theme, 'border')}`,
          borderRadius: 5,
          color: colorOf(theme, 'labelSecondary'),
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.4 : 1,
          fontSize: 11,
          lineHeight: 1,
          padding: '3px 7px',
          fontFamily: fontOf(theme),
        },
      },
      label,
    );

  return h(
    'div',
    {
      style: {
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '10px 16px',
        border: `1px solid ${colorOf(theme, 'border')}`,
        borderRadius: 8,
        padding: '8px 11px',
        marginTop: 6,
        fontFamily: fontOf(theme),
        background: colorOf(theme, 'bg2', 'transparent'),
      },
    },
    h(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 96 } },
      h('span', { style: { fontSize: 9, color: colorOf(theme, 'labelTertiary') } }, L.selected),
      h('span', { style: { fontSize: 13, fontWeight: 600, color: colorOf(theme, 'label') } }, day),
    ),
    chip('tianyicui', `${d.tianyicui}`, d.tianyicui > 0 ? colorOf(theme, 'accent') : colorOf(theme, 'labelTertiary')),
    chip(L.team, `${d.all}`),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 } },
      h('span', {
        style: {
          width: 8, height: 8, borderRadius: 99, flex: 'none',
          background: d.isReleaseDay ? colorOf(theme, 'danger') : colorOf(theme, 'border'),
        },
      }),
      h(
        'span',
        { style: { color: d.isReleaseDay ? colorOf(theme, 'danger') : colorOf(theme, 'labelTertiary') } },
        d.isReleaseDay && d.versions && d.versions.length
          ? `${L.release}: ${d.versions.join(', ')}`
          : L.noRelease,
      ),
    ),
    h(
      'div',
      { style: { display: 'flex', gap: 4, marginLeft: 'auto' } },
      navBtn('prev', '‹', p.onPrev, !p.onPrev),
      navBtn('next', '›', p.onNext, !p.onNext),
      navBtn('clear', '✕', p.onClear),
    ),
  );
}

/* ------------------------------------------------------------------ *
 * MonitorCharts — line chart + heatmap sharing one selection
 *
 * Selection lives here so clicking either chart highlights BOTH and updates the
 * detail readout; each chart stays a controlled, stateless component.
 * ------------------------------------------------------------------ */

/**
 * @param {{daily:Array,heat:object,releases?:Array,theme:object,locale?:string,
 *          wide?:boolean}} props
 */
export function MonitorCharts(props) {
  const p = props || {};
  const theme = p.theme;
  const L = labelsOf(p);
  const wide = !!p.wide;
  const daily = Array.isArray(p.daily) ? p.daily : [];
  const heat = p.heat && typeof p.heat === 'object' ? p.heat : { weeks: [], max: 0, monthLabels: [] };
  // release instants, used to name the versions shipped on a selected day
  const releases = Array.isArray(p.releases) ? p.releases : [];
  const [selected, setSelected] = React.useState(null);

  const indexOf = (day) => daily.findIndex((d) => d.day === day);
  const toggle = (day) => setSelected((cur) => (cur === day ? null : day));
  const step = (delta) => {
    const i = selected ? indexOf(selected) : -1;
    if (i < 0) {
      if (daily.length) setSelected(daily[daily.length - 1].day);
      return;
    }
    const j = Math.min(daily.length - 1, Math.max(0, i + delta));
    setSelected(daily[j].day);
  };

  const detail = (() => {
    if (!selected) return null;
    const row = daily.find((d) => d.day === selected);
    if (!row) return null;
    const versions = releases
      .filter((r) => {
        if (!r || typeof r.time !== 'number') return false;
        // release instants are epoch ms; compare on the same CST day key
        const shifted = new Date(r.time + 8 * 3600 * 1000);
        const key = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
        return key === selected;
      })
      .map((r) => r.version);
    return { ...row, versions };
  })();

  const i = selected ? indexOf(selected) : -1;
  const sectionTitle = {
    margin: '14px 0 5px',
    fontSize: 11,
    fontWeight: 500,
    color: colorOf(theme, 'labelSecondary'),
    fontFamily: fontOf(theme),
  };

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column' } },
    h('div', { style: sectionTitle }, `${L.trend} · ${L.hint}`),
    h(LineChart, {
      daily, theme, metric: 'tianyicui', locale: p.locale,
      height: wide ? 200 : 118,
      width: wide ? 720 : 380,
      selected,
      onSelect: toggle,
    }),
    h('div', { style: sectionTitle }, L.heatLabel),
    h(Heatmap, { heat, theme, cell: wide ? 13 : 10, gap: wide ? 3 : 2, selected, onSelect: toggle }),
    h(DayDetail, {
      day: selected,
      detail,
      theme,
      locale: p.locale,
      onPrev: i > 0 ? () => step(-1) : null,
      onNext: i >= 0 && i < daily.length - 1 ? () => step(1) : null,
      onClear: selected ? () => setSelected(null) : null,
    }),
  );
}

/* ------------------------------------------------------------------ *
 * ContributionStrip — GitHub contribution counts, incl. private activity
 *
 * These are "contributions" (commits + PRs + issues + reviews), NOT commits, so
 * this renders as its own strip and is never summed with the commit series.
 * Days that have contributions but zero PUBLIC commits are marked: that gap is
 * what private activity looks like from the outside.
 * ------------------------------------------------------------------ */

/**
 * @param {{contributions:object, locale?:string, wide?:boolean}} props
 */
export function ContributionStrip(props) {
  const p = props || {};
  const c = p.contributions && typeof p.contributions === 'object' ? p.contributions : null;
  const L = labelsOf(p);
  const wide = !!p.wide;
  if (!c || !c.byDay) return null;

  const keys = Object.keys(c.byDay).sort();
  if (!keys.length) return null;
  const values = keys.map((k) => c.byDay[k] || 0);
  const max = Math.max(1, ...values);

  const width = wide ? 720 : 380;
  const height = 76;
  const pad = { top: 6, right: 4, bottom: 16, left: 4 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const bw = plotW / keys.length;
  const barW = Math.max(1, bw - (bw > 2.5 ? 1 : 0));

  const marks = [];
  keys.forEach((k, i) => {
    const v = c.byDay[k] || 0;
    const barH = v === 0 ? 0.6 : Math.max(1, (v / max) * plotH);
    const x = pad.left + i * bw;
    const y = pad.top + plotH - barH;
    // a day with contributions but no public commit == private-only activity
    const privateOnly = v > 0 && !(p.publicDays && p.publicDays.has(k));
    marks.push(h('rect', {
      key: k,
      x,
      y,
      width: barW,
      height: barH,
      rx: 0.5,
      fill: v === 0
        ? colorOf(p.theme, 'border')
        : privateOnly ? colorOf(p.theme, 'danger') : colorOf(p.theme, 'accent'),
      opacity: v === 0 ? 0.5 : 1,
    }, h('title', { key: 't' }, `${k} · ${v} ${L.contribStat}${privateOnly ? ` (${L.contribPrivate})` : ''}`)));
  });

  // month gridlines
  let lastMonth = null;
  keys.forEach((k, i) => {
    const mo = k.slice(0, 7);
    if (mo !== lastMonth) {
      lastMonth = mo;
      if (i > 0) {
        marks.push(h('line', {
          key: `m-${mo}`,
          x1: pad.left + i * bw, x2: pad.left + i * bw,
          y1: pad.top, y2: pad.top + plotH,
          stroke: colorOf(p.theme, 'border'), strokeWidth: 0.5, opacity: 0.6,
        }));
      }
    }
  });

  const swatch = (color, label) => h('span', {
    key: label,
    style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  },
    h('span', { style: { width: 8, height: 8, borderRadius: 2, background: color, display: 'inline-block' } }),
    h('span', null, label),
  );

  return h('div', { style: { display: 'flex', flexDirection: 'column', fontFamily: fontOf(p.theme) } },
    h('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%',
      height,
      role: 'img',
      'aria-label': `${L.contribStat}: ${c.total} ${L.contribNote}`,
      style: { display: 'block', maxWidth: '100%', height: 'auto' },
    }, marks),
    h('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 4,
        fontSize: 9, color: colorOf(p.theme, 'labelTertiary'),
      },
    },
      swatch(colorOf(p.theme, 'accent'), L.contribPublic),
      swatch(colorOf(p.theme, 'danger'), L.contribPrivateOnly),
      h('span', { key: 'sum', style: { marginLeft: 'auto' } },
        `${c.firstDay} → ${c.lastDay} · ${c.days} ${p.locale === 'en' ? 'days' : '天'} · Σ ${c.total.toLocaleString()}`),
    ),
    h('div', { style: { fontSize: 9, lineHeight: 1.6, color: colorOf(p.theme, 'labelTertiary'), marginTop: 3 } }, L.contribExplain),
  );
}

/* ------------------------------------------------------------------ *
 * ModelTimeline — DeepSeek model launches alongside DSH releases
 *
 * Context, not a predictor. It shows how the two cadences line up: often the
 * model ships and the DSH version that supports it follows within days.
 * ------------------------------------------------------------------ */

/**
 * @param {{models:Array, dshReleases:Array, theme:object, locale?:string, wide?:boolean}} props
 */
export function ModelTimeline(props) {
  const p = props || {};
  const theme = p.theme;
  const L = labelsOf(p);
  const wide = !!p.wide;
  const models = (Array.isArray(p.models) ? p.models : []).filter((m) => m && m.flagship);
  const dsh = (Array.isArray(p.dshReleases) ? p.dshReleases : []).filter((r) => r && typeof r.time === 'number');
  if (!models.length) return null;

  const DAY = 864e5;
  const t0 = Math.min(...models.map((m) => m.time));
  const t1 = Math.max(
    ...models.map((m) => m.time),
    ...dsh.map((r) => r.time),
  );
  const span = Math.max(DAY, t1 - t0);

  // for each model, the nearest DSH release and how many days after it landed
  const rows = models.map((m) => {
    let best = null;
    for (const r of dsh) {
      const d = (r.time - m.time) / DAY;
      if (!best || Math.abs(d) < Math.abs(best.days)) best = { version: r.version, days: d };
    }
    return { ...m, nearest: best };
  });

  const width = wide ? 720 : 380;
  const height = 66;
  const pad = { top: 22, right: 8, bottom: 16, left: 8 };
  const plotW = width - pad.left - pad.right;
  const xAt = (t) => pad.left + ((t - t0) / span) * plotW;

  const children = [];
  children.push(h('line', {
    key: 'axis',
    x1: pad.left, x2: pad.left + plotW, y1: height - pad.bottom, y2: height - pad.bottom,
    stroke: colorOf(theme, 'border'), strokeWidth: 1,
  }));

  // DSH releases as small ticks under the axis, for cadence comparison
  dsh.forEach((r, i) => {
    const x = xAt(r.time);
    if (x < pad.left || x > pad.left + plotW) return;
    children.push(h('line', {
      key: `dsh-${i}`,
      x1: x, x2: x, y1: height - pad.bottom, y2: height - pad.bottom + 5,
      stroke: colorOf(theme, 'labelTertiary'), strokeWidth: 1, opacity: 0.7,
    }));
  });

  // model launches as diamonds above the axis, labelled
  models.forEach((m, i) => {
    const x = xAt(m.time);
    const y = pad.top + 8;
    children.push(h('path', {
      key: `m-${i}`,
      d: `M ${x} ${y - 5} L ${x + 5} ${y} L ${x} ${y + 5} L ${x - 5} ${y} Z`,
      fill: colorOf(theme, 'accent'),
      stroke: colorOf(theme, 'bg2', '#fff'),
      strokeWidth: 1,
    }, h('title', { key: 't' },
      `${m.day} · ${m.name}` +
      (m.nearest ? ` · ${L.modelNearest} ${m.nearest.version} ${m.nearest.days >= 0 ? '+' : ''}${m.nearest.days.toFixed(1)}d` : ''))));
    children.push(h('line', {
      key: `ml-${i}`,
      x1: x, x2: x, y1: y + 5, y2: height - pad.bottom,
      stroke: colorOf(theme, 'accent'), strokeWidth: 1, strokeDasharray: '2 2', opacity: 0.5,
    }));
    // stagger labels so adjacent launches do not collide
    children.push(h('text', {
      key: `mt-${i}`,
      x, y: y - 9 - (i % 2) * 9, textAnchor: 'middle', fontSize: 8,
      fill: colorOf(theme, 'labelSecondary'), fontFamily: fontOf(theme),
    }, m.name.replace(/^DeepSeek-/, '')));
  });

  children.push(h('text', {
    key: 'from', x: pad.left, y: height - 3, fontSize: 8,
    fill: colorOf(theme, 'labelTertiary'), fontFamily: fontOf(theme),
  }, models[0].day));
  children.push(h('text', {
    key: 'to', x: pad.left + plotW, y: height - 3, textAnchor: 'end', fontSize: 8,
    fill: colorOf(theme, 'labelTertiary'), fontFamily: fontOf(theme),
  }, new Date(t1).toISOString().slice(0, 10)));

  // Observation, clearly labelled as non-causal: among launches that happened after
  // DSH started publishing, how long until the next DSH release?
  const firstDsh = dsh.length ? Math.min(...dsh.map((r) => r.time)) : null;
  const launcherAfter = firstDsh == null ? [] : models.filter((m) => m.time >= firstDsh);
  const legacyCount = models.length - launcherAfter.length;
  let observation = null;
  if (launcherAfter.length) {
    const lags = launcherAfter.map((m) => {
      const after = dsh.filter((r) => r.time >= m.time).sort((a, b) => a.time - b.time);
      return after.length ? (after[0].time - m.time) / DAY : null;
    }).filter((v) => v != null);
    if (lags.length) {
      const maxLag = Math.max(...lags);
      observation = L.modelObserve(lags.length, maxLag.toFixed(1));
    }
  }

  const swatch = (color, label, diamond) => h('span', {
    key: label, style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  },
    diamond
      ? h('span', { style: { width: 7, height: 7, background: color, transform: 'rotate(45deg)', display: 'inline-block' } })
      : h('span', { style: { width: 2, height: 9, background: color, display: 'inline-block' } }),
    h('span', null, label));

  return h('div', { style: { display: 'flex', flexDirection: 'column', fontFamily: fontOf(theme) } },
    h('svg', {
      viewBox: `0 0 ${width} ${height}`,
      width: '100%', height,
      role: 'img',
      'aria-label': `${L.modelTimeline}: ${models.length} launches`,
      style: { display: 'block', maxWidth: '100%', height: 'auto' },
    }, children),
    h('div', {
      style: {
        display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 2,
        fontSize: 9, color: colorOf(theme, 'labelTertiary'),
      },
    },
      swatch(colorOf(theme, 'accent'), L.modelLaunch, true),
      swatch(colorOf(theme, 'labelTertiary'), L.dshRelease, false),
      h('span', { key: 'n', style: { marginLeft: 'auto' } }, `${models.length} ${L.models}`)),
    h('div', { style: { fontSize: 9, lineHeight: 1.6, color: colorOf(theme, 'labelTertiary'), marginTop: 2 } }, L.modelNote),
    observation
      ? h('div', { style: { fontSize: 9, lineHeight: 1.6, color: colorOf(theme, 'labelSecondary'), marginTop: 3 } }, observation)
      : null,
    legacyCount > 0
      ? h('div', { style: { fontSize: 9, lineHeight: 1.6, color: colorOf(theme, 'labelTertiary'), marginTop: 2 } }, L.modelLegacy(legacyCount))
      : null,
  );
}
