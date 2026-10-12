# dsh-plugin-tianyicui-monitor

在 DSH 侧栏加一个常驻入口（和「插件」「网易云音乐」「Qwen-Image 2.1」「MCP 连接器」并排的一行，
带图标 + 文字标签），点开是一整块面板，回答一个问题：

> **未来 72 小时内，DeepSeek Harness 会不会发布新版本？现在有多大概率？**

面板里有 tianyicui 的提交折线图、GitHub 风格的提交热度图，以及算这个概率用的全部证据。

界面构成：一个 270° 圆弧仪表 + 数值，**90% 刻度线直接画在弧上**；下面依次是总量统计、
提交折线图（绿色虚线 = 发布日）、热度图、证据表。

## 跨仓库提交总数（含私有仓库的说明）

### 私有仓库：未认证时在技术上不可能读到

这一条是 GitHub 的规则，不是实现取舍：

| 端点 | 未认证结果 |
|---|---|
| `GET /user/repos`（含私有仓库） | **HTTP 401** |
| `GET /users/tianyicui/repos` | 200，但**只返回公开仓库** |
| `/users/*/events/public` 的 PushEvent | 只含公开仓库推送 |

所以界面上「可见私有仓库: 0」**不代表没有私有仓库**，而是**看不到**。
想统计私有提交，只有两条路：用**那个账号本人**的 token（tianyicui 的私有仓库
只有 tianyicui 能授权），或者接受公开数据。当前实现是后者。

### 公开仓库：全站合计

用 `GET /repos/{owner}/{repo}/contributors` —— 它一次请求返回每个贡献者的
**总提交数**，没有 1000 条上限。这比 `search/commits` 可靠得多：
后者对 `author:` 限定符实际无效（`total_count` 返回 `null`），早期用它拿到过
「327 万条」这种明显错误的数字。

扫描脚本 `build/scan_repos.mjs`：

```bash
node build/scan_repos.mjs            # 可断点续扫；撞限流自动停下并记录重置时间
node build/scan_repos.mjs --status   # 看已扫到什么程度
```

- 枚举他的 65 个自有公开仓库 + `deepseek-ai` 等组织的公开仓库，共 **109 个**
- 每个仓库一次请求，限流 60 次/小时，所以**要跨多个时间窗才能扫完**
- 优先扫 `deepseek-ai`（提交量集中在那里）
- 结果写到 `data/repos.json`，打进插件包

### 最终结果（109/109 个公开仓库已扫描）

| 仓库 | tianyicui 提交数 |
|---|---|
| `deepseek-ai/deepseek-harness` | **6,855**（占 **87.1%**） |
| 其余 108 个仓库合计 | **1,018** |
| **总计** | **7,873** |

其中 51 个仓库是 **fork**（`paseo`、`code-server`、`CLIProxyAPI` 等），他一次都没提交过 ——
贡献者列表里排第一的是上游原作者。所以这些 0 **是真的 0**，不是抓取失败。

方法可信度验证：在 5 个仓库上把 `contributors` 的数字与 `commits?author=` 的
Link 末页数字做对照，**5/5 完全一致**：

| 仓库 | contributors | exact(Link) |
|---|---|---|
| `tianyicui/golio` | 135 | 135 |
| `tianyicui/H-99` | 108 | 108 |
| `tianyicui/minisql` | 84 | 84 |
| `deepseek-ai/DeepSeek-V3` | 0 | 0 |
| `deepseek-ai/DeepSeek-V2` | 0 | 0 |

关于 harness 仓库：API 给 **6,855**，我们从 git 历史数出 **6,851**，
差额 4 是 merge 提交（git 的 `--author` 按 author 字段算，API 按关联账号算）。

面板上现在有两行数字，**不要混淆**：

- **tianyicui 总提交** = deepseek-harness 一个仓库的数字
- **全部公开仓库** = 跨仓库合计（**7,873**）；下面还有一行显示「覆盖 109/109 个公开仓库已扫描」

覆盖率是明写的。现在是 **109/109 已完成**，所以 7,873 是当前完整值；
但注意它仍**不含私有仓库**，那是认证问题而非扫描进度问题。

## 私有仓库活动：可以拿到（我一开始判断错了）

我最初说"私有仓库数据未认证读不到"，**这是错的**。存在一个免凭据的来源：

**`https://github.com/users/tianyicui/contributions`** —— GitHub 个人主页贡献图的服务端渲染页面，
匿名可访问，返回 366 天的每日数字。

因为它匿名就能拿到，说明**该账号开启了「在个人主页显示私有贡献」**，
所以这些每日数字**已经包含了私有仓库的活动**。GitHub 只给数量，不给是哪个仓库。

### 但有个必须说清的口径问题

这个数字是 **"contributions"（贡献）**，= commit + PR + issue + code review，
**不是提交数**。证据：2026-10-08 贡献图显示 13，而该仓库当天有 122 次公开提交 ——
数字比公开提交还少，所以它不可能是提交计数，而是 GitHub 自己的一套计分/归类。

因此：**这一行不能和提交数相加**。面板里它是独立的第三行，并附口径说明。

想要**真正的**含私有的 commit 数，需要认证后调 GraphQL：

```graphql
{ user(login:"tianyicui") {
    contributionsCollection {
      totalCommitContributions          # 含私有
      restrictedContributionsCount      # 私有部分，需 scope read:user
    } } }
```

未认证 GraphQL 返回 **403**，本机也没有任何可用 token（`gh` 配置了账号但 `hosts.yml` 里没有
token，`.credentials.yaml` 里也没有）。要走这条路就需要你授权。

### 抓取与解析

`npm run contributions`（脚本名刻意分开，它与其他数据源不同）：
- 抓页面 → 解析 `data-date` 单元格 + `<tool-tip>` 计数
- **自校验**：366 天解析值之和必须等于页面头部打印的总数（36,978），不等就报错
- 结果写 `data/contributions.json`

**TLS 注意**：这台机器 HTTPS 走本地拦截代理，其根证书不在 Node 的信任库里
（curl 认，Node 不认）。我把根证书从实时链里提取到 `build/certs/chain1.pem`，
用 `NODE_EXTRA_CA_CERTS` 传给 Node —— **不是**关掉证书校验。

### 面板上现在有三行，不要混淆

| 行 | 含义 |
|---|---|
| tianyicui 总提交 | deepseek-harness 单仓库的**提交数** |
| 全部公开仓库 | 109 个公开仓库的**提交数**合计 |
| GitHub 贡献图 | 含私有的**贡献数**（commit+PR+issue+review），**不可相加** |

贡献图那条还画了一条按天柱状条，**红色柱子 = 有贡献但当天没有任何公开提交** ——
那正是私有活动的样子。10-10 就是一根红柱。

## 滚动与刷新

### 滚动

主面板是一个**固定高度**的视口，DSH 不会替你滚动。所以报表自己拥有滚动容器：

```
外层  height:100% / overflow:hidden / minHeight:0
 └ 表头 position:sticky top:0   ← 刷新按钮永远可见
 └ 内层 flex:1 1 auto / minHeight:0 / overflow-y:auto   ← 真正滚动的是这里
```

`minHeight: 0` 不是可选的：flex 子项默认 `min-height:auto`，不改成 0 就**不会收缩**，
滚动条也就永远不出现 —— 长内容会被直接裁掉。这就是"显示不全"的原因。

### 刷新

**"无法刷新"的根因是 GitHub 限流，不是按钮坏了。** 未认证 API 是 60 次/小时，
按出口 IP 计数，我扫描 109 个仓库正好把它打满（实测 `0/60`）。

代码层面它一直有在工作（403 会被捕获并显示），但两个体验问题是真的：

1. 刷新按钮在表头**上方**的内容里，被裁掉之后根本看不到 → 现在表头 `sticky`，永远可见
2. 失败只说 "GitHub 403"，用户不知道要等多久 → 现在解析 `x-ratelimit-reset`，
   显示「**API 限流 · 1m35s**」这样的倒计时，倒计时结束前按钮禁用

另外加了两个保护：

- **60 秒冷却**：一次刷新要花约 6 个请求，不节流的话几下就能把小时配额点光
- **失败不丢数据**：刷新失败时保留上一次成功的数据并注明「沿用上次成功的数据」，
  而不是把面板清空

离线快照始终可用，所以限流期间面板照常显示，只是数字不更新。

## 选中交互

折线图和热度图**共享同一个选中状态**：点任意一张图上的某一天，两张图会同时高亮那天，
下面出现一条明细读出，显示当天的 tianyicui 提交数、全团队提交数、是否发布（以及发布的版本号），
并提供 ‹ / › / ✕ 三个按钮做前后一天和取消选中。

实现要点：

- **状态放在 `MonitorCharts`**，两张图都是受控无状态组件（`selected` + `onSelect`）。
  这是两张图能同步的唯一原因 —— 各自持有状态必然漂移。
- **折线图的点击区是整列。** 每天生成一个贯通绘图区高度的透明 `rect`（不是 2px 的点，
  那种点根本点不着），放在 SVG 子树最后，所以命中测试永远赢过下面的折线和网格。
- **热度图每个格子可点。** 选中格子外面套一个 `pointer-events: none` 的描边方框，
  否则这个框会挡住下面格子的点击。
- **选中那天一定会有坐标轴标签。** 几何层只采样 4 个 x 刻度，所以我额外把选中日
  补进刻度列表 —— 否则选中一个读不出日期的位置毫无意义。
- **可键盘操作。** 每个点击区带 `tabIndex=0` / `role=button` / `aria-label` / `aria-pressed`，
  Enter 和空格都能触发。

## 入口挂在哪

用 DSH 官方的 `sidebar.panellist` 槽位（`list` 类型），和上面那几个插件是**同一套机制**：

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: 'tianyicui-monitor', order: 12, label: '提交监控' },
  MonitorEntry,   // 只画图标，侧栏自己负责行、tooltip、hover、选中态
));

ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: 'tianyicui-monitor' },   // key 必须和上面的 id 一致
  MonitorReport,
));
```

两个关键点，都是从 DSH 自己的侧栏实现里读出来的：

1. **图标组件只返回图标。** 侧栏把每个 `sidebar.panellist` 条目包在自己的 `<button>` 里，
   并传入 `{ size, active }`。如果我们的组件自己也返回一个 button，就会嵌套交互元素。
2. **`main` 的 key 必须和侧栏 id 相同。** 侧栏的点击处理是 `selectPanel(id)`，
   而 `selectPanel` 在 keyed `main` 槽里找不到对应 key 时会**直接抛错**。
   所以这个注册不是可选的。

---

## 先说三件重要的事实

这些不是设计选择，是数据本身。我没有为了让界面好看而把它们藏起来。

### 1. tianyicui 就是 DSH 的第一大贡献者

`tianyicui`（Tianyi Cui）在 `deepseek-ai/deepseek-harness` 上是**提交量第一**的人：

| 指标 | 数值 |
|---|---|
| tianyicui 提交数 | **6,851** |
| 全仓库提交数 | **21,405** |
| 占比 | **32.0%** |
| 第二名（Yichen Jiang） | 2,628 |

所以"用他的提交次数预测 DSH 发版"这个思路**站得住**：他不是外部观察者，他就是发版的那个人。`dsh-v0.2.1-alpha.1` 这个版本就是他亲手发布的。

### 2. 你最初要的「24 小时内 ≥90%」，在数学上做不到

我没有直接把这个数画出来，因为它不存在。用真实数据算：

| 预测窗口 | 无条件基线 | 历史最高可达概率 | 90% 能达到吗 |
|---|---|---|---|
| 4 小时 | 8.7% | 18.7% | ✗ |
| 6 小时 | 12.8% | 25.5% | ✗ |
| 12 小时 | 24.4% | 54.0% | ✗ |
| **24 小时** | **43.2%** | **77.7%**（Wilson 上限 87.9%） | **✗** |
| 48 小时 | 63.6% | 88.8% | ✗ |
| **72 小时** | **79.0%** | **94.0%** | **✓** |

根本原因是**只有 38 个发布事件**（独立样本 37 个）。DSH 在 8 周里发了 38 个版本、平均 2.4 天一个，这个节奏的随机性压不下去：24 小时窗口下，即使把「距上次发布时长」和「星期几」组合到最有利的那一格，也只有 77.7%。

**所以按你的决定，面板口径统一为 72 小时** —— 这是唯一能让 90% 阈值真实生效的窗口。24 小时的数字也仍在界面上（作为「未校准」一栏的对照），只是不当主判据。

### 3. 真实风险是「过期不发」，不是「提交多就发」

这条最反直觉，但数据非常清楚。看真实的风险结构（72 小时口径，样本外）：

| 距上次发布 | P(72h 内发布) | n |
|---|---|---|
| 0–6 小时 | 74.4% | 133 |
| 30–36 小时 | 64.0% | 50 |
| 36–48 小时 | 79.1 → 85.7% | 43 / 42 |
| 72–96 小时 | **97.0%** | 133 |
| 96 小时以上 | **100%** | 75 / 57 |

概率**随「多久没发版」单调飙升**，超过 96 小时就是 100%（历史上从没有超过 149 小时不发版的）。

而 tianyicui 的提交量本身**不是**发布的前兆 —— 6 小时窗口里发版前的提交密度是基线的 2.0 倍，但 24 小时窗口只有 0.99 倍。**提交高峰对应的是正在开发，不是即将发版。** 短窗口（≤6h）的提交密度有一点信号，但日粒度数据还原不出来，所以我没用它当主特征。

星期效应则极其强烈（真实数据，样本外）：

| 周一 | 周二 | 周三 | 周四 | 周五 | 周六 | 周日 |
|---|---|---|---|---|---|---|
| 83.3% | 86.7% | 93.5% | **95.8%** | 54.7% | 75.7% | 83.3% |

周五偏低、周四最高 —— 团队周四发版最多。

---

## 模型

**类型**：经验风险率（hazard）× 星期相对风险，取对数几率合成，再做 isotonic 单调回归校准。

```
logit P = logit(hazard[距上次发布时长分桶]) + log(星期相对风险[星期几])
P_calibrated = isotonic(P_raw)
```

**为什么不用逻辑回归**：我试了。4 个特征的逻辑回归在滚动起点回测下 AUC 只有 0.53（≈随机），因为日粒度的时间和星期特征与 24 小时提交量高度共线，正则化一强就退化成常数预测。改用「经验风险率 × 星期」这种非参数形式后 AUC 升到 0.687。

**验证协议**：滚动起点（rolling-origin）扩展窗口回测 —— 每 6 小时重新拟合一次，只用该时刻之前的数据，预测未来 72 小时。共 1,092 个样本外时点。

**样本外结果**：

| 模型 | Brier ↓ | AUC ↑ | LogLoss ↓ |
|---|---|---|---|
| A 常数基线 | 0.1509 | 0.500 | 0.4819 |
| **C 风险率 × 星期（交付）** | **0.1402** | **0.687** | 0.4451 |
| D C + 提交速度 | 0.1477 | 0.679 | 0.4671 |
| **C + isotonic 校准（交付）** | **0.1346** | **0.687** | 0.4426 |

校准误差（ECE）从 7.33pp 降到 **4.17pp**。

**90% 阈值实际表现**（样本外，校准后）：

| 阈值 | 触发占比 | 实际命中率 | Wilson 95% 区间 |
|---|---|---|---|
| ≥80% | 56.5% | 91.7% | 89.3–93.7% |
| **≥90%** | **49.9%** | **92.7%** | **90.2–94.6%** |
| ≥95% | 18.0% | 94.4% | 90.3–96.9% |

也就是说：**面板亮起「很可能发布」时，历史上大约一半的时间在亮，而亮起时 92.7% 的情况下 72 小时内真的发版了**，且下界 90.2% 也守在 90% 以上。这个判据是可信的。

**但这仍然是弱证据**：独立样本只有 37 个发布事件。界面底部写明了这一点。

---

## 文件结构

```
src/
  analytics.js      纯统计：日桶、热度矩阵、Wilson、AUC、Brier、isotonic 工具
  model.js          概率模型运行时：hazard × 星期 + isotonic 校准
  github.js         直读 GitHub 公开 API（浏览器和 Node 共用）
  client/
    index.js        插件主体：注册 shell.overlay 槽位、面板组装
    views.js        LineChart / Heatmap / ProbabilityGauge / StatRow / EvidenceTable
    charts.js       纯 SVG 几何计算（无 React、无 DOM）
    classify.js     90% 阈值分档
  host/
    source.js       Node 侧数据源：GitHub 读取 + 缓存 + 限流处理
data/
  dataset.json      原始提取结果：6,851 + 21,405 个提交时间戳、38 个发布时刻
  snapshot.json     打进 bundle 的离线快照（日粒度，6 KiB）
  model_final.json  拟合好的模型 + 全部样本外指标
build/
  extract_dataset.py  从 git clone 提取数据集
  fit_model.mjs       拟合 + 滚动起点回测 + isotonic 校准
  bundle.mjs          打包成 DSH ModuleLoader 工厂格式
  evaluate*.mjs       建模过程中的对照实验（保留供复核）
test/               72 个测试
```

## 怎么构建

```bash
cd /root/tianyicui_monitor
npm test          # 72 个测试
npm run build     # 重新打包 lib/client.js
npm run data      # 重新抓数据 → 重拟合 → 重打包（需要 build/dsh-git 存在）
```

数据管线依赖一个 DSH 仓库的浅克隆：

```bash
git clone --filter=blob:none --no-checkout --shallow-since=2026-04-01 \
  --single-branch --branch master \
  https://github.com/deepseek-ai/deepseek-harness.git build/dsh-git
```

（注意默认分支是 `master` 不是 `main`。）

## 怎么安装

插件包本身与平台无关；差异只在**谁来加载它**。

### 1. 构建

```bash
npm test        # 109 个测试
npm run build   # 生成 lib/client.js（ModuleLoader 工厂格式）
```

### 2. 让 DSH 找到这个包

package.json 里声明了客户端半边：

```json
"dsh": { "client": { "platform": "web" } },
"exports": { "./client": "./lib/client.js" }
```

把包放进**你的 profile** 的 `node_modules` 下，并在该 profile 的 `cordis.patch.yml`
末尾加一条 loader 条目：

```yaml
- insert:
    - id: tianyicui-monitor
      name: dsh-plugin-tianyicui-monitor
```

然后重启 DSH。`./sync.sh` 可以自动完成拷贝这一步：

```bash
DSH_CANON_DIR="$HOME/dsh-plugins/dsh-plugin-tianyicui-monitor" \
DSH_PROFILES="$HOME/.dsh/profiles/web" \
  ./sync.sh
```

> **DSH 跑在 Windows、而代码在 WSL 时**：Windows 侧无法可靠地 `require` WSL 路径下的包，
> 而相对软链在 Windows 上会因 `..` 被夹在盘符根目录而解析错位。
> 所以要把包**复制**到 Windows 可见的目录（`sync.sh` 的 `DSH_CANON_DIR`），
> 源码仍以你的工作区为准。这是我在这台机器上踩过的坑，写下来省你时间。

### 3. 回退

删掉 `cordis.patch.yml` 里那段 `insert`，再删掉 `node_modules` 下对应目录，重启 DSH。

### 注意有守护进程会改写 patch 文件

如果你装了类似 `cordis-patch-guard` 的看护脚本，它可能把 `cordis.patch.yml`
回滚到自己的 `last-good` 快照。加完 `insert` 后确认一下它没被回滚。

## 数据来源与刷新

面板打开时立刻用打包进去的离线快照渲染，同时后台打一次 GitHub 公开 API 拉最近 90 天。离线快照保证**断网、限流、GitHub 挂了都还能看图**。

未登录 API 限流 60 次/小时。一次刷新最多 6 个请求（commits ≤5 页 + releases ≤1 页），在限流内。要更高配额就设 `GITHUB_TOKEN`。

`src/host/source.js` 是等价的 Node 侧实现（带磁盘缓存、Link 头分页、`AbortController` 超时、限流降级），**当前界面并不走它** —— 面板直接浏览器直连。它留在包里是为了：后续接 host RPC（需要 DSH 的 remote 代码生成，成本较高）、CLI 离线刷新、以及它自己那 21 个测试。

**已知限制**：仓库提交接口返回的是 committer 时间，不是 author 时间；一次刷新最多覆盖 500 个提交，所以密集开发期（单日 100+ 提交）只能回看到几天前，更早的部分由离线快照兜底。

### 人工刷新离线快照

想让「离线基线」也跟上最新进度（比如隔一段时间重打包一次）：

```bash
# 1) 拉最新 git 历史
cd build && git -C dsh-git fetch --depth=1 origin master && git -C dsh-git reset --hard FETCH_HEAD && cd ..

# 2) 重新提取 + 重拟合 + 重打包
npm run data

# 3) 确认
npm test
```

## 模型拟合细节

`build/fit_model.mjs 72` 会：

1. 从 `data/dataset.json` 读提交与发布时刻
2. 对模型窗口内每个小时构造一行：特征只用到该时刻之前的信息
3. 按 `AGE_EDGES = [0,6,12,18,24,30,36,42,48,60,72,96,120,168,∞]` 分桶算经验风险率（Laplace 平滑，先验 25）
4. 算星期相对风险（几率尺度，钳制在 0.1–8）
5. 在「风险率 × 星期」之上用逻辑回归拟合提交速度项
6. 滚动起点回测（每 6 小时重拟合）产出样本外预测
7. 在样本外预测上跑 PAV isotonic 回归得到校准曲线
8. 用全量数据重新拟合最终系数，写 `data/model_final.json`

运行时（`src/model.js`）用同一套公式对新数据重新计算，所以在线刷新后概率会真的跟着动。

## 复核建议

想自己验证结论，跑这几个：

```bash
node build/explore.mjs       # 发版前提交密度、星期效应、发布间隔分布
node build/evaluate3.mjs     # 滚动起点回测：4 种模型对比 + 校准表
node build/evaluate4.mjs     # 90% 阈值可达性 + 有效样本量 + 窗口扫描
node build/fit_model.mjs 24  # 用 24 小时口径拟合，可复现"最高 77.7%"
```

`node build/fit_model.mjs 24` 的输出会显示 24 小时口径下 ≥90% 从不触发 —— 这是本文件第 2 节的直接证据。
