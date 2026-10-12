# dsh-tianyicui-monitor

[![tests](https://img.shields.io/badge/tests-109%20passing-brightgreen)](#tests)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin. It adds a
sidebar entry showing a maintainer's commit activity and a **calibrated probability that a new DSH
version ships within 72 hours**.

Reads public GitHub data only. No credentials, no telemetry.

English | [中文](README.zh.md)

---

## What it does

A row in the DSH sidebar, next to Plugins / MCP, opening a report:

- **Verdict** — a gauge with the 90% threshold drawn on the arc, and a verdict band
  (`release likely` / `watch` / `quiet`)
- **Totals** — commits in the main repo, commits across all public repos, GitHub contribution count
- **Timeline** — daily commits with release markers
- **Heatmap** — GitHub-style contribution grid
- **Contributions** — daily GitHub contribution counts, private-activity days flagged
- **Evidence** — Brier / AUC / calibration error, and the hazard bucket behind the current number

Click any day on the timeline or the heatmap: both charts highlight it and a readout shows that
day's commit counts, whether a release landed, and which version.

## How the probability is derived

### 1. Predictors

Each hour is a sample. Two features are used, both known at that moment:

- **hours since the last release**
- **day of week**

Commit volume was tested and dropped: in a 24-hour window it carries no signal (0.99× the baseline).
Whether a release is *overdue* is what matters.

### 2. Hazard × weekday

Bucketed by hours since the last release, the empirical release rate rises steadily as a cycle ages:

| Hours since last release | P(release within 72h) |
|---|---|
| 0–6 h | 74.4% |
| 30–36 h | 64.0% |
| 48–60 h | 85.7% |
| 72–96 h | 97.0% |
| 96 h+ | 100% |

There is also a strong weekday effect — the team ships midweek, not on Fridays (Thursday 95.8% vs
Friday 54.7%). The two are combined on the odds scale:

```
logit P = logit(hazard[hours-since-last-release bucket])
        + log(weekday relative risk)
```

### 3. Calibration

A monotone (isotonic) curve is fitted to the model's own out-of-sample output, so the number shown
is the observed frequency rather than a raw score.

```
P_calibrated = isotonic(P_raw)
```

### 4. Why a 72-hour window

The probability that a release lands in the next **24 hours** tops out at **77.7%** (Wilson upper
bound 87.9%), so a 90% verdict is unreachable in that window. Over 72 hours it reaches **94.0%**,
which makes 90% a real, crossable line:

| Horizon | Base rate | Best achievable | Reaches 90%? |
|---|---|---|---|
| 12 h | 24.4% | 54.0% | no |
| 24 h | 43.1% | 77.7% | no |
| 48 h | 63.5% | 88.8% | no |
| **72 h** | **78.8%** | **94.0%** | **yes** |

(Base rate here is the unconditional release rate over the same window used for the horizon sweep;
the calibrated model's own fitted base rate over its training window is 82.1%.)

## Validation

Rolling-origin backtesting: refit every 6 hours on data strictly before the evaluation instant,
across 1,092 out-of-sample hours.

| Model | Brier ↓ | AUC ↑ | Log loss ↓ |
|---|---|---|---|
| Constant base rate | 0.1509 | 0.500 | 0.4819 |
| hazard × weekday | 0.1402 | 0.687 | 0.4451 |
| **+ isotonic calibration** | **0.1346** | **0.687** | **0.4426** |

Calibration error falls from 7.33 pp to **4.17 pp**.

The ≥90% verdict fires on 49.9% of hours and is followed by a release within 72 hours **92.7%** of
the time (Wilson 95% CI 90.2–94.6%).

> **Limitation:** the history contains only 37 independent release events, so the intervals are
> wide. The panel states this in its footer. Do not make important decisions from it.

## Install

```bash
npm test        # 109 tests
npm run build   # emits lib/client.js
```

Place the package under your DSH profile's `node_modules`, then append a loader entry to that
profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: tianyicui-monitor
      name: dsh-tianyicui-monitor
```

Restart DSH. `sync.sh` automates the copy:

```bash
DSH_CANON_DIR="$HOME/dsh-plugins/dsh-tianyicui-monitor" \
DSH_PROFILES="$HOME/.dsh/profiles/web" \
  ./sync.sh
```

## Data sources

| What | Endpoint |
|---|---|
| Commits in the main repo | `GET /repos/{owner}/{repo}/commits` |
| Releases | `GET /repos/{owner}/{repo}/releases` |
| Commits across all public repos | `GET /repos/{owner}/{repo}/contributors` |
| Contribution graph (includes private) | `https://github.com/users/{u}/contributions` |

An offline snapshot ships with the plugin so the panel always renders, then refreshes live.
Unauthenticated GitHub allows 60 requests/hour; the panel shows a countdown when that runs out.

Two notes on reading this data:

- **Unreadable is not zero.** `GET /user/repos` returns **401** unauthenticated, so private
  repositories cannot be counted. The panel reports `private repos visible: 0` and says why.
- **The contribution graph counts "contributions"** (commits + PRs + issues + reviews), **not
  commits**, so it is shown as a separate row and never summed with the commit totals. Its daily
  numbers do include private activity, because the account enables "include private contributions on
  my profile". GitHub returns only the count, never the repository.

A true commit count including private repos needs an authenticated GraphQL query
(`contributionsCollection.totalCommitContributions`).

## Tests

```bash
npm test
```

109 tests. `test/render.test.mjs` evaluates the built bundle and executes every component body
against real data; `test/contributions.test.mjs` parses a real captured page and asserts its daily
sum matches the total GitHub prints; `test/core.test.mjs` covers the analysis core and re-verifies
the model's own claims.

## Rebuilding the data

```bash
git clone --filter=blob:none --no-checkout --shallow-since=2026-04-01 \
  --single-branch --branch master \
  https://github.com/deepseek-ai/deepseek-harness.git build/dsh-git

npm run data            # extract -> refit -> bundle
npm run repos           # per-repo commit scan
npm run contributions   # contribution graph
```

Every number above is reproducible with `node build/evaluate3.mjs` and
`node build/evaluate4.mjs`.

## Disclaimer

Not affiliated with or endorsed by DeepSeek or by `tianyicui`. It reads public GitHub data about a
public account. All trademarks belong to their owners.

MIT licensed.
