# dsh-tianyicui-monitor

[![tests](https://img.shields.io/badge/tests-109%20passing-brightgreen)](#测试)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。在侧栏加一个入口，
显示某位维护者的提交活动，以及一个**经过校准的「未来 72 小时内发布新版本」概率**。

只读取 GitHub 公开数据。不需要凭据，不上报任何信息。

[English](README.md) | 中文

---

## 功能

DSH 侧栏里的一行（和「插件」「MCP 连接器」并排），点开是一份报表：

- **判定** — 一个圆弧仪表，**90% 阈值线画在弧上**，并给出判定档位（很可能发布 / 关注 / 平静）
- **总量** — 主仓库提交数、全部公开仓库提交数、GitHub 贡献图计数
- **折线图** — 每日提交，标出发布日
- **热度图** — GitHub 风格贡献网格
- **模型时间线** — DeepSeek 模型发布与 DSH 发版的对照
- **贡献图** — 每日 GitHub 贡献计数，私有活跃日单独标色
- **判定依据** — Brier / AUC / 校准误差，以及当前数值对应的风险率分桶

点折线图或热度图上的任意一天：两张图会同时高亮那天，并显示当天的提交数、是否发布、发了哪个版本。

## 概率是怎么推导出来的

### 1. 自变量

把每个小时当作一个样本，只用该时刻已知的两个特征：

- **距上次发布多少小时**
- **星期几**

提交量的特征测过并**弃用**了：在 24 小时窗口里它没有信号（0.99 倍基线）。真正有预测力的是
「一个发布周期是否已经超期」。

### 2. 风险率 × 星期

按「距上次发布的小时数」分桶后，经验发布率随周期变长而稳步上升：

| 距上次发布 | P(72h 内发布) |
|---|---|
| 0–6 h | 74.4% |
| 30–36 h | 64.0% |
| 48–60 h | 85.7% |
| 72–96 h | 97.0% |
| 96 h+ | 100% |

同时有很强的星期效应 —— 团队在周中发版，周五几乎不发（周四 95.8% vs 周五 54.7%）。
两者在**几率尺度**上合成：

```
logit P = logit(风险率[距上次发布分桶])
        + log(星期相对风险)
```

### 3. 校准

对模型自己的样本外输出拟合一条单调（isotonic）曲线，让界面显示的数字等于**实际观测频率**，
而不是一个未标定的分数。

```
P_校准后 = isotonic(P_原始)
```

### 4. 为什么用 72 小时窗口

「未来 **24 小时**内发布」的概率上限只有 **77.7%**（Wilson 上限 87.9%），所以 24 小时口径下
90% 这条线**永远不可能跨过**。放到 72 小时后可达 **94.0%**，90% 才是一条真实的、能被越过的线：

| 预测窗口 | 基线概率 | 可达上限 | 能到 90% 吗 |
|---|---|---|---|
| 12 小时 | 24.4% | 54.0% | 不能 |
| 24 小时 | 43.1% | 77.7% | 不能 |
| 48 小时 | 63.5% | 88.8% | 不能 |
| **72 小时** | **78.8%** | **94.0%** | **能** |

（这里的基线概率是同一扫描窗口下的无条件发布率；模型自身在其训练窗口上拟合出的基线率为 82.1%。）

## 验证

采用**滚动起点回测**：每 6 小时重新拟合一次，只用评估时刻之前的数据，共 1,092 个样本外时点。

| 模型 | Brier ↓ | AUC ↑ | Log loss ↓ |
|---|---|---|---|
| 常数基线 | 0.1509 | 0.500 | 0.4819 |
| 风险率 × 星期 | 0.1402 | 0.687 | 0.4451 |
| **＋ isotonic 校准** | **0.1346** | **0.687** | **0.4426** |

校准误差（ECE）从 7.33pp 降到 **4.17pp**。

「≥90%」判定在 49.9% 的时点触发，触发后 72 小时内**确实发版的比例是 92.7%**
（Wilson 95% 区间 90.2–94.6%）。

> **局限**：历史里只有 **37 个独立发布事件**，所以区间很宽。面板底部写明了这一点。
> 请勿据此做重要决策。

## DeepSeek 模型发布

模型发布作为**时间线背景**展示，**不参与**概率模型。范围限定在 DSH 仓库创建之后发布的模型 ——
包含 **V4-Flash-0731** 和 **V4-Pro-0813** —— 日期取 Hugging Face 模型卡的创建时间。

一个值得注意的对应关系：DSH 首个公开版本之后的 **3 次旗舰模型发布**，紧随其后的 DSH 发版
间隔都在 **0.5 天**以内。

| 模型发布 | 后续 DSH 发版 |
|---|---|
| 2026-08-13 · V4-Pro-0813 | +0.2 天 |
| 2026-08-31 · V4-Flash-Vision-Exp | +0.4 天 |
| 2026-09-10 · V4.1-Flash | +0.5 天 |

> 只有 3 个样本，这是**模式而非可测量的效应**，**不构成「模型发布导致 DSH 发版」的因果证据**。
> 更早的 3 次发布发生在 DSH 首个版本之前，根本无法对照。它们被有意排除在概率模型之外 ——
> 既因为 n=3 撑不起一个自变量，也因为基线率已经解释了大部分。

## 安装

```bash
npm test        # 109 个测试
npm run build   # 生成 lib/client.js
```

把包放到你的 DSH profile 的 `node_modules` 下，再在该 profile 的 `cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: tianyicui-monitor
      name: dsh-tianyicui-monitor
```

重启 DSH。`sync.sh` 可以自动完成拷贝：

```bash
DSH_CANON_DIR="$HOME/dsh-plugins/dsh-tianyicui-monitor" \
DSH_PROFILES="$HOME/.dsh/profiles/web" \
  ./sync.sh
```

## 数据来源

| 内容 | 接口 |
|---|---|
| 主仓库提交 | `GET /repos/{owner}/{repo}/commits` |
| 发布版本 | `GET /repos/{owner}/{repo}/releases` |
| 全部公开仓库提交 | `GET /repos/{owner}/{repo}/contributors` |
| 贡献图（含私有） | `https://github.com/users/{u}/contributions` |

插件内置一份离线快照，保证面板一定能渲染出来，然后在线刷新。
GitHub 未认证配额为 60 次/小时，用尽时面板会显示倒计时。

读这些数据有两点要注意：

- **看不到不等于没有。** `GET /user/repos` 未认证返回 **401**，所以私有仓库无法计数。
  面板显示 `可见私有仓库: 0` 并说明原因。
- **贡献图统计的是「贡献」**（commit + PR + issue + review），**不是提交数**，因此单独成行、
  **绝不与提交数相加**。它的每日数字确实包含私有活动（该账号开启了「在个人主页显示私有贡献」），
  但 GitHub 只返回数量，不返回是哪个仓库。

想要**真正的**含私有 commit 数，需要认证后调 GraphQL
（`contributionsCollection.totalCommitContributions`）。

## 测试

```bash
npm test
```

共 109 个测试。`test/render.test.mjs` 会加载构建产物并**实际执行**每个组件；`test/contributions.test.mjs`
用**真实抓取的页面**做夹具，并断言每日之和等于页面头部打印的总数；`test/core.test.mjs` 覆盖统计核心，
并复验模型自己声称的指标。

## 重建数据

```bash
git clone --filter=blob:none --no-checkout --shallow-since=2026-04-01 \
  --single-branch --branch master \
  https://github.com/deepseek-ai/deepseek-harness.git build/dsh-git

npm run data            # 提取 -> 重拟合 -> 打包
npm run repos           # 逐仓库提交扫描
npm run contributions   # 贡献图
```

上面每个数字都可以用 `node build/evaluate3.mjs` 和 `node build/evaluate4.mjs` 复现。

## 声明

与 DeepSeek 及 `tianyicui` 无隶属或背书关系。本插件只读取公开账号的公开 GitHub 数据。
相关商标归各自所有者。

MIT 许可。
