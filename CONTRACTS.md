# tianyicui-monitor — frozen interfaces (v1)

DO NOT change anything in this file. If you believe an interface is wrong,
report it to the Lead instead of editing. These contracts are consumed by
`src/client/index.js`, the host half, and the test suite.

## Package

* Package name: `dsh-plugin-tianyicui-monitor`
* `type: "module"`, ESM only.
* Host half entry: `lib/index.js` — exports `apply(ctx)` and `inject`.
* Client half entry: `lib/client.js` — built by `build/bundle.mjs` into the
  DSH ModuleLoader factory format. Never hand-edit `lib/client.js`.
* Client source entry: `src/client/index.js`.

## Client plugin shape (already frozen by DSH, for reference only)

```js
export const inject = ['slots', 'locale'];
export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'tianyicui-monitor: dictionaries');
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'tianyicui-monitor', order: 30, locale: NS }, Entry));
}
```

## Chart module — `src/client/charts.js`

Pure functions. No React import, no DOM. The caller wraps results in `<svg>`.
All colors are plain CSS color strings passed in via `theme`.

```js
export const AREA_COLORS = ['#ebedf0', /* ...5 levels..., */'#216e39'];
export function buildAreaPath(dailyPoints, opts) -> string
export function buildAreaGeometry(dailyPoints, opts) -> {
  width, height, xTicks: {x,label}[], yTicks: {y,label}[], gridLines: {y,value}[]
}
export function buildHeatmapGeometry(heat, opts) -> {
  width, height, cells: {key,value,x,y,size,fill,title}[], monthLabels: {x,label}[], dayLabels: {y,label}[]
}
export function gaugeArc(probability, opts) -> { path, angleDeg, cx, cy, r }
export function quantileColor(value, max, colors) -> string
```

### Required signatures in detail

* `dailyPoints`: `Array<{ day: string, tianyicui: number, all: number, isReleaseDay: boolean }>`
* `opts` for the area chart: `{ width, height, pad: {top,right,bottom,left}, series: 'tianyicui'|'all', axisColor, gridColor, lineColor, fillFrom, fillTo, idSuffix }`
* `opts` for the heatmap: `{ cell, gap, corner, max, colors, emptyColor }`
* `opts` for the gauge: `{ size, stroke, from, to }`
* `buildAreaPath` returns an SVG path `d` string (closed area, ready to fill).
* `heat` is the object returned by `heatmapMatrix()` in `src/analytics.js`
  (`{ weeks, max, monthLabels }`), already available — import it from
  `'../analytics.js'` (charts.js lives in `src/client/`).

## View module — `src/client/views.js`

React components. Imports React from the module system (`require('react')` is
handled by the bundler; in source, use `import React from 'react'`).

```js
export function LineChart({ daily, theme, metric, height }) -> ReactElement
export function Heatmap({ heat, theme }) -> ReactElement
export function ProbabilityGauge({ probability, level, theme }) -> ReactElement
export function StatRow({ items, theme }) -> ReactElement
export function EvidenceTable({ rows, theme }) -> ReactElement
```

* `metric` is `'tianyicui' | 'all'`.
* `level` is `'release-likely' | 'watch' | 'quiet'` (see `classifyProbability`).
* `rows` for `EvidenceTable`: `Array<{label:string, value:string, note?:string}>`.
* Every component must render correctly for empty/degenerate input
  (`daily.length === 0`, `heat.weeks.length === 0`, `probability === null`).
* No component may crash on `null` props; render an em dash instead.

## Classification helper — `src/client/classify.js`

```js
export const LIKELY_THRESHOLD = 0.90;
export function classifyProbability(p) -> { level, label, tone }
```

* `p == null` -> `{ level: 'unknown', tone: 'neutral' }`
* `p >= 0.90` -> `'release-likely'`
* `p >= 0.80` -> `'watch'`
* otherwise -> `'quiet'`

## Theme object passed to components

```js
{
  label: string, labelSecondary: string, labelTertiary: string,
  border: string, bg1: string, bg2: string, accent: string, danger: string,
  font: string,
}
```
