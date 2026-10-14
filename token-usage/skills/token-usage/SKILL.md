---
name: token-usage
description: 生成并打开 ZCode token 用量仪表盘报告（token 消耗、生成速率、缓存命中、近7日走势），或不打开页面直接查询数据回答，或维护 ZCode 右上角侧栏的用量面板。当用户执行 /token-usage、想查看 token 用量报告、询问「用了多少 token / 缓存命中率多少 / 哪个模型用得多 / token 使用趋势」，或提到「右上角图标 / 用量面板不见了」时使用。
---

# ZCode Token 用量

数据源是 ZCode 本地用量数据库 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表（每次模型请求一行）。本技能**只读**该数据库，不写入；本地 stdio MCP 服务由宿主（客户端）管理生命周期，数据按需查询，不占 HTTP 端口。

两种呈现方式共用同一份查询与同一套口径：

1. **右上方侧栏面板**（正式方案，日常首选）——客户端直接打开，**打开/刷新都不经过模型**，无需运行任何命令。插件通过本地 stdio MCP server 提供只读查询工具 `token_usage_query` 与固定的自包含入口资源 `ui://token-usage/dashboard.html`，声明在 `token-usage/.zcode-plugin/plugin.json` 的 `mcpServers.usage` 与 `ui.surfaces` 里；server 代码在 `token-usage/mcp/server.mjs`。正式入口就是清单里的 `command: "node"` + `mcp/server.mjs`——**macOS 与 Windows 两端都要求 PATH 里有 Node.js（建议 22.5+，`node:sqlite` 需要）**；`token-usage/mcp/run.sh` 仅作手动/调试兜底启动器，清单已不再引用它。面板通过 `tools/call` 拉取数据并自行刷新。**无活动会话时侧栏不可用** —— 此时改用下面的独立报告。
   - 迁移说明：该侧栏**取代**了旧的 asar 补丁悬浮面板。旧补丁工具（`tools/patch-client.mjs` / `unpatch-client.mjs` / `hooks/auto-patch.mjs`）保留为 legacy，`hooks/hooks.json` 已置空 `{"hooks":{}}`、**自动注入已关闭**；对仍打过旧补丁的客户端**不主动 unpatch、不主动重启**，升级覆盖 asar 后自然失效。如需 legacy 手动处置，请自行运行对应工具，不要重新开启自动注入。详见 `tools/README.md`。
2. **独立报告页**（`/token-usage` 的默认动作）—— 生成一份自包含 HTML 报告（支持自定义日期区间），报告脚本可在 UI 之外独立运行；斜杠命令本身仍需在一个会话里执行。

## 生成仪表盘报告（/token-usage 的默认动作）

> 日常看用量直接开右上角侧栏即可（无需模型、无需命令）。`/token-usage` 在一个任务（会话）里执行，生成一份独立自包含报告；报告脚本 `report.mjs` 也可脱离 UI 直接运行（适合无活动会话时手动补一份）。

运行本技能基目录下的生成器（基目录即本 SKILL.md 所在目录，下称 `<base>`）：

```bash
node "<base>/report.mjs"
```

- 脚本查询数据库、把聚合数据内嵌进一个自包含 HTML，写到 `~/.zcode/token-usage-report.html` 并自动在浏览器打开。
- 加 `--no-open` 只生成不打开（用户传了该参数时）。
- 脚本 stdout 会打印报告路径和摘要行（全部历史 + 近24小时：总 tokens、输入/输出/缓存读、请求次数、缓存命中率）。**把摘要转述给用户**，并告知页面已打开、数据为生成时刻快照。
- 可选环境变量：`ZCODE_USAGE_DB`（数据库路径）、`ZCODE_USAGE_OUT`（输出 HTML 路径）。
- 报告页面支持：Token 用量/设置两个 tab；时间快捷选择（今天、昨天、近24小时、近7天、近14天、近30天、本周、本月）与自定义日期区间（起日 00:00:00 ~ 止日 23:59:59）；用量明细为磁贴网格（3/2/2 排布 + 整行最近使用时间，点磁贴按模型展开）；「模型」卡片列出本区间各「供应商·模型」的速度/缓存命中/处理总量；趋势折线图（hover 显示日期+周几、总量、各模型明细），标题与天数跟随所选范围（短区间固定近 7 日，近14天/近30天/本月对应天数，自定义按所选跨度且最少 7 天）。
- 列表里 token 量一律用紧凑单位（`K`/`M`/`B`），**完整数字在 `title` 提示里**（鼠标悬停可见）；模型卡片每行四列：**模型名 / 速度 / 缓存命中 / 处理总量**，模型名只显示名称（同名模型可能来自不同供应商）并把供应商放在 `title` 提示里（`供应商 · 模型`），速度与缓存命中都是弱化色的辅助指标（`title` 里分别给出样本数与缓存读取 ÷ 完整提示词的原始数字），占比不单独占列、放在处理总量的 `title` 里。回答用户时用完整数字，别把 `915.7M` 当成精确值。
- 面板与报告页共用同一份 `web/app.js`。**侧栏面板**（`window.__ZCODE_SIDEBAR__` 为真）实测容器宽度决定图表尺寸，默认时间范围是**今天**；点「刷新」重新拉数时**保留当前时间范围**，也保留各模型卡片的展开状态与当前 tab，默认值只在每次重新打开面板时才是初始状态。**报告页**默认**近7天**。（`__ZCODE_DASH_ROOT__` / `__ZCODE_CHART_W__` / `__ZCODE_CHART_H__` 那套是 legacy asar 面板的限定方式，正式侧栏不再使用。）

## 直接查询回答（用户随口问，不需要页面时）

用 sqlite3 只读查询现查现答。产品内的聚合 SQL 在 `usage-data.mjs`（`HOURLY_SQL` / `DAILY_SQL`）；下面只是给口头提问用的简版模板（时间条件按需替换）。

**平台差异**：下面两个 `sqlite3` 模板适用于 macOS/Linux（系统自带 `sqlite3` 命令行）。**Windows 没有 sqlite3 命令行**，改用 `node` 一次性查询（`usage-data.mjs` 在 Windows 上已自动回退到内置 `node:sqlite`），或直接用侧栏面板/报告页。查询引擎走的是「显式 `ZCODE_USAGE_SQLITE` > 可用的 sqlite3 CLI > Node 内置 `node:sqlite`」回退链。

```bash
# macOS/Linux：今天（本地时区）总体
sqlite3 -readonly ~/.zcode/cli/db/db.sqlite "
SELECT SUM(input_tokens), SUM(output_tokens), SUM(cache_read_input_tokens),
       SUM(cache_creation_input_tokens), SUM(reasoning_tokens), COUNT(*)
FROM model_usage
WHERE started_at >= strftime('%s', strftime('%Y-%m-%d','now','localtime') || ' 00:00:00', 'utc')*1000;"

# macOS/Linux：近7天按「供应商 · 模型」的处理总量（同名模型可能来自不同供应商，必须带 provider_id）
sqlite3 -readonly -header ~/.zcode/cli/db/db.sqlite "
SELECT provider_id, model_id,
       SUM(CASE WHEN cache_creation_input_tokens>0 OR cache_read_input_tokens>input_tokens
                THEN input_tokens+cache_read_input_tokens+cache_creation_input_tokens
                ELSE input_tokens END + output_tokens) total,
       COUNT(*) requests
FROM model_usage
WHERE started_at >= (strftime('%s','now') - 7*86400)*1000
GROUP BY provider_id, model_id ORDER BY total DESC;"
```

Windows（或任何没有 sqlite3 CLI 的环境）用 Node 内置 `node:sqlite` 只读打开同一个库（同样只读、不建库；下面以「今天总体」为例，SQL 与上面第一条一致）：

```bash
node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
const db = new DatabaseSync(join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite'), { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000');
console.log(db.prepare(\`SELECT SUM(input_tokens) i, SUM(output_tokens) o, SUM(cache_read_input_tokens) cr,
       SUM(cache_creation_input_tokens) cc, SUM(reasoning_tokens) r, COUNT(*) n
FROM model_usage
WHERE started_at >= strftime('%s', strftime('%Y-%m-%d','now','localtime') || ' 00:00:00', 'utc')*1000\`).all());
db.close();
"
```

> 第二条的 `CASE` 是必须的：`input_tokens` 是否已含缓存取决于供应商（见下方口径）。直接写 `input+output+cache_read+cache_creation` 会把缓存读/写**双计**，数字虚高。

> 模型维度**必须**用 `provider_id + model_id` 组合：不同供应商会提供同名模型（例如 openCode go 与 DeepSeek 各自的 `deepseek-flash`）。`provider_id` 可用 `~/.zcode/v2/config.json` 的 `provider.<id>.name` 映射成展示名。

> 时区注意（本机 sqlite 3.43 实测）：`started_at >= strftime('%s','now','localtime','start of day')` 这类写法**边界错误**——`'now'` 经 `localtime` 后再被 `%s` 当 UTC 解释，结果比本地 0 点早 8 小时。正确的本地 0 点 epoch 写法是上面的 `strftime('%s', strftime('%Y-%m-%d','now','localtime') || ' 00:00:00', 'utc')`。而**分桶**（`strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime')`，epoch 进 localtime 出）是正确的，`report.mjs` 即采用此写法。

## 指标口径（回答时必须一致）

**先记住一条：`input_tokens` 的语义随供应商而异**——是否已包含缓存读/写并不统一（见下）。所以能不能把「缓存读」与「输入」相加，取决于 `input_tokens` 是否已含缓存，不能一概而论；命中率的分母始终是「完整提示词」。

- **Token 处理总量** = 完整提示词 + output。**不要**盲目写成 `input + output + cache_read + cache_creation`：当 `input_tokens` 已含缓存（DeepSeek/OpenAI 式）时，那会把命中缓存的输入重复计一遍；只有当 `input_tokens` 不含缓存（Anthropic 式）时才需要加上缓存读/写。
- **缓存命中率** = cache_read ÷ 完整提示词。此为 ZCode 客户端自身口径：客户端 bundle `/out/host/index.js` 里 `contextCacheUsageFromPayload` 明确写 `cacheHitRate = cacheReadTokens / inputTokens`，另有 `contextUsageTokensFromPayload` 写 `inputTokens !== undefined ? inputTokens + outputTokens : cacheRead + cacheWrite + output`（只有在没有 inputTokens 时才回退成把缓存加上去，反证有 input 时它已含缓存）。
- **「完整提示词」怎么取**——`input_tokens` 的语义跟供应商返回的字段有关，ZCode 归一化时按 `input_tokens → prompt_tokens → promptTokens → inputTokens` 取第一个存在的（见 `/node_modules/@tokenlens/helpers/dist/context.js`）：
  - DeepSeek / OpenAI 式接口只返回 `prompt_tokens`（**含**缓存部分）→ 完整提示词 = `input_tokens`，命中率 = `cache_read / input`。
  - Anthropic 式接口返回 `input_tokens`（**不含**缓存读与缓存写）→ 完整提示词 = `input_tokens + cache_read + cache_creation`。
  - 判据：`cache_creation_input_tokens > 0`（Anthropic 特有的写入侧字段）或 `cache_read_input_tokens > input_tokens`（命中量不可能超过总提示词）出现任一，即按 Anthropic 式还原；两者都不成立时按含缓存式，`cache_read / input` 即正确。
  - **永远按判据（逐行/逐模型）还原，绝不无条件地把 cache_read/cache_creation 加到 input 上**：那样在含缓存式数据上会双计。
- **真正新增 token** =（完整提示词 − cache_read）+ output。这是「缓存省下了多少」的直接答案。
- **生成速率** = Σoutput_tokens ÷ Σduration_ms/1000，单位 **t/s**，仅统计 `status='completed'` 且 `duration_ms>0` 的行。这类「有耗时的已完成请求」不足 **10 次**时平均值会被单次波动主导，此时显示 `—` 而不是给出一个看着精确的数字（阈值是 `web/app.js` 里的 `RATE_MIN_SAMPLES`）。
  - 点开「生成速率」的模型明细时，每个模型两列：**最近 5 分钟**（按 `completed_at` 落在查询时刻前 300 秒内的已完成请求，不套用 10 次门槛，样本数见悬停；无样本显示 `—`）与**所选范围总速率**（即上面的口径，末尾带「(总)」）。最近 5 分钟的原料由 `usage-data.mjs` 的 `RECENT_SQL` 返回为 `recent`。
- **请求次数** = `model_usage` 行数（含重试；失败/取消行 token 均为 0，计入次数不影响 token 量）。
- `started_at` 是 epoch 毫秒；日期分桶一律按本地时区。
- **已知限制**：数据桶按供应商·模型分别保存；整体累计先合并各桶，再用缓存判据还原提示词，混合供应商语义时可能与逐模型还原后相加不同。这沿用原版计算行为。

## 故障排查

- `找不到 sqlite3`：已内置回退到 Node 的 `node:sqlite`（Node 22.5+），一般无需处理——macOS/Linux 有 `/usr/bin/sqlite3` 时走 CLI，Windows 自动回退。**仅当显式设置了 `ZCODE_USAGE_SQLITE` 且路径无效时才会报错**（此时清掉该变量或指向有效的 sqlite3 二进制即可）。
- `查询失败` 且提示缺列：ZCode 升级后 `model_usage` schema 可能变化，用 `PRAGMA table_info(model_usage)` 对照后调整 `usage-data.mjs` 里的 SQL（`HOURLY_SQL` / `DAILY_SQL` / `MODELS_SQL`）。
- 页面数字与预期不符：先确认口径（见上），再确认是否需要重新生成（数据是快照）。
- 右上角侧栏图标/面板不见了：正式侧栏由本地 MCP server 提供，先确认客户端已启用本插件、且是**活动会话**（无活动会话时侧栏本就不可用）。无活动会话又想要数据时，直接命令行跑报告脚本 `node <base>/report.mjs`（不经过会话），或新建一个任务再发 `/token-usage`。若客户端升级后出现异常，检查 `mcpServers.usage` 能否启动：手动跑 `/bin/sh <plugin>/mcp/run.sh` 看 stderr 是否报「找不到可用的 node」，必要时用 `ZCODE_TU_NODE` 指向 node 绝对路径。旧的 asar 补丁属 legacy、已停用自动注入，无需再为它排查。
