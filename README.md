# dsh-tianyicui-monitor

[![tests](https://img.shields.io/badge/tests-109%20passing-brightgreen)](#tests)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![topic](https://img.shields.io/badge/topic-dsh--plugin-6f42c1)](#)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that adds a
sidebar entry showing a maintainer's commit activity — and a **calibrated probability that a new
DSH version ships within 72 hours**.

It reads public data only. No credentials, no telemetry, no writes outside a local cache.

English | [中文](README.zh.md)

---

## What it shows

A row in the DSH sidebar, next to Plugins / MCP, opening a full report:

| Section | Contents |
|---|---|
| **Verdict** | a 270° gauge with the **90% threshold drawn on the arc**, plus the verdict band |
| **Totals** | commits in the main repo · commits across all public repos · GitHub contribution count |
| **Timeline** | daily commits with release markers — **click a day to select it** |
| **Heatmap** | GitHub-style contribution grid, **selection shared with the timeline** |
| **Contributions** | daily GitHub contribution counts, with private-activity days flagged |
| **Evidence** | Brier / AUC / calibration error, and the hazard bucket behind the current number |

Selecting a day on either chart highlights it on both and opens a readout with that day's commit
counts, whether a release landed, and which version.

---

## Three findings that shaped the design

Two of these contradict the obvious approach.

### 1. The subject really is the top contributor

`tianyicui` has **6,855 of 21,405 commits (32%)** in `deepseek-ai/deepseek-harness` and authored the
`dsh-v0.2.1-alpha.1` release himself. Predicting releases from his activity is not a proxy for
something else — he is the person who ships.

### 2. A 24-hour "≥90%" verdict is arithmetically impossible

Measured honestly, on the real history:

| Horizon | Base rate | Best achievable | Can it reach 90%? |
|---|---|---|---|
| 12 h | 24.4% | 54.0% | no |
| **24 h** | **43.2%** | **77.7%** (Wilson upper bound 87.9%) | **no** |
| 48 h | 63.6% | 88.8% | no |
| **72 h** | **79.0%** | **94.0%** | **yes** |

The cause is sample size: 38 releases in 8 weeks means only **37 independent release events**. Rather
than draw a 90% line the data can never cross, the panel uses a **72-hour horizon** — the only window
where the verdict is real — and keeps the 24h figure visible solely as an uncalibrated comparison.

### 3. The signal is "overdue", not "busy"

Commit volume in the 24h window is **not predictive** (0.99× the baseline). How long it has been
*since* the last release is:

| Hours since last release | P(release within 72h) |
|---|---|
| 0–6 h | 74.4% |
| 30–36 h | 64.0% |
| 48–60 h | 85.7% |
| **72–96 h** | **97.0%** |
| **96 h+** | **100%** |

With a strong weekday effect on top (Thursday 95.8% vs Friday 54.7%). A first attempt using logistic
regression over commit-velocity features scored **AUC 0.53 — indistinguishable from chance**; an
empirical hazard × weekday model reached **0.687**.

---

## Model

```
logit P = logit(hazard[hours-since-last-release bucket])
        + log(weekday relative risk)
P_calibrated = isotonic(P_raw)
```

Validated by **rolling-origin backtesting**: refit every 6 hours on everything strictly before the
evaluation instant, across 1,092 out-of-sample instants.

| Model | Brier ↓ | AUC ↑ | Log loss ↓ |
|---|---|---|---|
| Constant base rate | 0.1509 | 0.500 | 0.4819 |
| hazard × weekday | 0.1402 | 0.687 | 0.4451 |
| **+ isotonic calibration** | **0.1346** | **0.687** | **0.4426** |

Calibration error (ECE) falls from 7.33 pp to **4.17 pp**.

**The ≥90% verdict in practice:** it fires on 49.9% of hours and is followed by a release within 72
hours **92.7%** of the time (Wilson 95% CI 90.2–94.6%) — the lower bound still clears 90%.

> **Honest limitation:** only 37 independent release events. The intervals are wide, the model can be
> wrong, and the panel says so in its footer. Do not make important decisions from this.

---

## Data sources

All public. The plugin bundles an offline snapshot so the panel always renders, then refreshes live.

| What | Endpoint | Note |
|---|---|---|
| Commits in the main repo | `GET /repos/{owner}/{repo}/commits` | paginated via the `Link` header |
| Releases | `GET /repos/{owner}/{repo}/releases` | tag prefix stripped |
| Commits across all public repos | `GET /repos/{owner}/{repo}/contributors` | **one call per repo**, no 1000-result cap |
| Contribution graph (incl. private) | `https://github.com/users/{u}/contributions` | server-rendered, parsed |

### Three gotchas worth knowing

**`search/commits` is a trap.** It ignores the `author:` qualifier — it returned `total_count: null`
and, on another query, 3,278,595 results that were plainly unrelated. `contributors` gives an exact
per-repo count in a single request instead.

**Unreadable ≠ zero.** `GET /user/repos` is **HTTP 401** unauthenticated, so private repositories
cannot be listed or counted. The panel reports `private repos visible: 0` and says *why*, rather than
implying none exist.

**Private activity *is* readable — from exactly one place.** The profile contribution graph is served
to anonymous callers, and because the account enables "include private contributions on my profile",
its daily numbers already fold in private work. GitHub returns only the count, never the repository.

> Those are **"contributions"** (commits + PRs + issues + reviews), **not commits**. Evidence: on
> 2026-10-08 the graph shows 13 while the repo has 122 public commits — fewer than the commit count,
> so it cannot be a commit count. The panel therefore keeps it as a **separate row that is never
> summed** with the commit totals.

A true commit count *including* private repos needs an authenticated GraphQL query
(`contributionsCollection.totalCommitContributions`); unauthenticated GraphQL returns 403.

---

## Install

The package is platform-independent; the difference is only *who* loads it.

```bash
npm test        # 109 tests
npm run build   # emits lib/client.js (DSH ModuleLoader factory format)
```

The client half is declared in `package.json`:

```json
"dsh": { "client": { "platform": "web" } },
"exports": { "./client": "./lib/client.js" }
```

Place the package under your profile's `node_modules`, then append a loader entry to that profile's
`cordis.patch.yml`:

```yaml
- insert:
    - id: tianyicui-monitor
      name: dsh-tianyicui-monitor
```

Restart DSH. `sync.sh` automates the copy step:

```bash
DSH_CANON_DIR="$HOME/dsh-plugins/dsh-tianyicui-monitor" \
DSH_PROFILES="$HOME/.dsh/profiles/web" \
  ./sync.sh
```

> **If DSH runs on Windows while the code lives in WSL:** Windows Node cannot reliably `require` a
> package inside WSL, and a relative symlink resolves wrongly there because `..` clamps at the drive
> root. Copy the package to a Windows-visible directory (`DSH_CANON_DIR`) and keep your workspace as
> the source of truth.

### Slot registration

Two slots — and the second is **not optional**:

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'tianyicui-monitor', order: 12, label: '提交监控' },
  SidebarGlyph,          // the shell supplies the <button>; return ONLY the icon
));
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'tianyicui-monitor' },   // key MUST equal the panellist id
  MonitorReport,
));
```

The sidebar's own click handler calls `selectPanel(id)`, which **throws** when the keyed `main` slot
has no matching key. The glyph must not render its own `<button>`, or interactive elements nest.

---

## Tests

```bash
npm test
```

109 tests across six files. The ones that earn their keep:

- **`test/render.test.mjs`** evaluates the *built* bundle and **executes every component body** against
  real data through a walking React stub, asserting that no element has an undefined type and that no
  `undefined`/`NaN` leaks into either locale. This is what caught a variable shadowing
  `React.createElement`, and a label added to only one language dictionary.
- **`test/contributions.test.mjs`** parses a **real captured page** and asserts that the per-day sum
  equals the total GitHub prints in the header — a drift detector for markup changes.
- **`test/core.test.mjs`** checks the analysis core and re-verifies the model's own claims (that the
  ≥90% verdict is reachable and performs as advertised).

---

## Layout

```
src/
  analytics.js        pure stats: day buckets, heatmap matrix, Wilson, AUC, Brier
  model.js            probability runtime: hazard × weekday + isotonic calibration
  github.js           public GitHub readers (shared by browser and Node)
  client/
    index.js          plugin body: slot registration, panel assembly, refresh
    views.js          LineChart, Heatmap, ProbabilityGauge, StatRow, EvidenceTable, …
    charts.js         pure SVG geometry (no React, no DOM)
    classify.js       90% threshold banding
  host/source.js      Node-side reader with disk cache and rate-limit handling
build/
  extract_dataset.py      derive data/dataset.json from a git clone
  fit_model.mjs           fit + rolling-origin backtest + isotonic calibration
  scan_repos.mjs          per-repo contributor scan (resumable, rate-limit aware)
  scan_contributions.mjs  parse the contribution graph
  setup-ca.sh             extract a local proxy root CA, for machines that need it
  evaluate*.mjs           the comparisons behind the model choices, kept for review
data/                 derived artifacts (offline snapshot + fitted model)
test/                 109 tests
```

## Rebuilding the data

```bash
# the only input is a shallow clone of the upstream repository
git clone --filter=blob:none --no-checkout --shallow-since=2026-04-01 \
  --single-branch --branch master \
  https://github.com/deepseek-ai/deepseek-harness.git build/dsh-git

npm run data            # extract -> refit -> bundle
npm run repos           # per-repo commit scan (resumes across rate-limit windows)
npm run contributions   # contribution graph (see build/setup-ca.sh if TLS fails)
```

Re-running the evaluation scripts reproduces every number above:

```bash
node build/evaluate3.mjs     # rolling-origin backtest, model comparison, calibration table
node build/evaluate4.mjs     # 90% reachability, effective sample size, horizon sweep
node build/fit_model.mjs 24  # the 24h fit, which never reaches 90%
```

## Credits and disclaimer

Not affiliated with or endorsed by DeepSeek or by `tianyicui`. It reads public GitHub data about a
public account. All trademarks belong to their owners.

The probability is a statistical estimate from **37 independent events**, presented with its
uncertainty. It can be wrong.

MIT licensed.
