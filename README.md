# ZCode Token 用量（token-usage）

一个 ZCode 插件：在侧栏实时查看本机 ZCode 的 token 用量——消耗明细、生成速率、缓存命中率、近 7 日走势，完全本地只读，不占端口、不联网。

## 功能

- **右上方侧栏面板**（日常首选）：打开/刷新都不经过模型，无需运行任何命令。展示输入 / 输出 / 推理 / 缓存读 / 缓存写 token、缓存命中率、生成速率（**近 5 分钟** + **所选范围总速率**）、请求次数、最近使用时间，支持点击磁贴按模型展开。
- **趋势折线图**：近 7 日起走势，hover 显示每日总量与各模型明细；时间快捷选择（今天 / 昨天 / 近 24 小时 / 近 7 天 / 近 14 天 / 近 30 天 / 本周 / 本月）与自定义日期区间。
- **独立报告页**：`/token-usage` 命令生成一份自包含 HTML 报告（可脱离 UI 单独运行 `report.mjs`），适合无活动会话时留档。
- **`/token-usage` 命令**：默认生成报告；数据按需查询，无常驻服务。

## 支持平台与依赖

- 平台：**macOS** 与 **Windows 11**。
- ZCode **3.15+**。
- **PATH 里有 Node.js（建议 22.5+）**——正式入口是清单里的 `command: "node"`，两端都依赖它。
  - macOS/Linux 自带 `sqlite3` 命令行时走它（行为与旧版一致）。
  - Windows 没有 `sqlite3` 命令行，自动回退到 Node 内置的 `node:sqlite`（故需要 Node 22.5+）。

## 安装

1. ZCode → 设置 → 插件管理 → **Discover** → 点 **＋**。
2. 填入 `用户名/仓库名`（本仓库路径）。
3. 安装 `token-usage` 并**启用**。
4. 日常从右侧栏「＋」打开「**Token 用量**」。

## 更新

改版本号（`marketplace.json` 与 `plugin.json`）→ push → 在市场里**刷新** → 点更新。插件按版本号安装到本地缓存，靠版本号变化触发更新。

## 数据来源与只读声明

- 数据源：本机 ZCode 用量数据库 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表（每次模型请求一行）。
- **全程只读**：不写文件、不建库、不 mkdir、不联网；数据库不存在时报错而不是创建空库。
- 查询引擎按「显式 `ZCODE_USAGE_SQLITE` > 可用的 sqlite3 CLI > Node 内置 `node:sqlite`」回退，两种引擎结果一致。

## 指标口径

- **Token 处理总量** = 完整提示词 + output。**不要**盲目写成 `input + output + cache_read + cache_creation`——`input_tokens` 是否已含缓存随供应商而异。
- **缓存命中率** = `cache_read ÷ 完整提示词`（ZCode 客户端自身口径）。
- **完整提示词**：DeepSeek/OpenAI 式（`prompt_tokens` 含缓存）取 `input_tokens`；Anthropic 式（`input_tokens` 不含缓存）取 `input + cache_read + cache_creation`。逐行按判据还原，绝不无条件相加。
- **生成速率** = Σoutput ÷ Σduration/1000（t/s），仅统计 `status='completed'` 且 `duration_ms>0` 的行；样本不足 10 次显示 `—`。

## 目录结构

```
token-usage/                      插件本体（市场安装的就是它）
├─ .zcode-plugin/plugin.json      插件清单（版本、MCP 服务、UI 入口）
├─ mcp/
│  ├─ server.mjs                  正式入口：本地 stdio MCP server
│  └─ run.sh                      手动/调试兜底启动器（清单不引用）
├─ skills/token-usage/
│  ├─ usage-data.mjs              只读数据层 + 查询引擎回退（核心）
│  ├─ report.mjs                  独立报告生成
│  ├─ ui-resource.mjs             UI 入口资源
│  ├─ SKILL.md                    技能说明
│  └─ web/                        前端（模板 / 样式 / app.js）
├─ commands/token-usage.md        /token-usage 命令
└─ hooks/                         legacy 自动补丁钩子（已停用）
tools/                            macOS-only legacy asar 补丁（见下）
.claude-plugin/marketplace.json   市场清单
```

## `tools/` 说明

`tools/` 是 **macOS-only 的 legacy asar 补丁工具**，用于给旧版 ZCode 注入悬浮面板，保留仅供历史参考，**Windows 不需要、也不会用到**。当前正式方案是上面描述的侧栏面板 + MCP server，自动注入已关闭。

## 许可

MIT
