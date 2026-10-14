# ZCode Token 用量 插件（0.2.0）—— 当前正式入口

**当前 0.2.0 的正式用法是「本地 MCP server + 右上方侧栏面板」**，本目录下的 asar 补丁工具是 **legacy**，正常情况下**不需要**。侧栏打开/刷新都不经过模型；本地 stdio MCP 服务由宿主（客户端）管理生命周期、数据按需查询，不占 HTTP 端口。相关文件：

| 文件 | 作用 |
| --- | --- |
| `token-usage/.zcode-plugin/plugin.json` | 插件清单：`mcpServers.usage`（stdio 启动 `mcp/run.sh`）+ `ui.surfaces`（侧栏入口资源） |
| `token-usage/mcp/server.mjs` | MCP server：唯一只读无参工具 `token_usage_query` + 固定入口资源 |
| `token-usage/mcp/run.sh` | 启动器：自动探测 node（`ZCODE_TU_NODE` → PATH → Homebrew/系统路径 → ZCode 自带 Electron） |
| `token-usage/skills/token-usage/` | 数据/报告逻辑、`/token-usage` 命令、SKILL 文档 |

**市场更新步骤**（源码改完，要让客户端生效）：`token-usage` 的 source 目录就是 `/Users/mac/Code/mine/plugin/zcode-token-usage`，插件目录是其中的 `token-usage/`，catalog 是仓库根的 `.claude-plugin/marketplace.json`（`name: local-token-usage` / `source: ./token-usage` / `version: 0.2.0`）。在客户端里走：**插件市场 → 齿轮/市场源 → 刷新 `local-token-usage` → 「个人」分类 → 打开 `token-usage` 详情 → 更新 → 确认版本为 0.2.0 → 新建任务 → 在右侧栏的面板菜单里打开「Token 用量」**。市场源已添加过就不要重复添加。真实客户端试用要等用户更新后再验收；本仓库当前只覆盖 source 内容、清单 schema 与 MCP 协议测试。

---

## Legacy：app.asar 补丁（旧悬浮面板，一般不需要）

> **这是被 0.2.0 侧栏取代的旧方案。** 旧方案给客户端 `app.asar` 打补丁、在右上角按钮排注入柱状图图标。补丁工具（`patch-client.mjs` / `unpatch-client.mjs` / `hooks/auto-patch.mjs`）与说明都保留为 legacy；`hooks/hooks.json` 已置为 `{"hooks":{}}`、**自动注入已关闭**。对仍打过旧补丁的客户端，迁移时**不主动 unpatch、不主动重启**，让它自然老去（升级 ZCode 覆盖 asar 后即消失）；确实想立即清掉再手动跑 `unpatch-client.mjs`。

给 ZCode 桌面客户端的**右上角按钮排最左侧**加一个柱状图图标，鼠标悬停弹出用量面板；面板与 `/token-usage` 报告共用同一套前端逻辑和同一份查询 SQL。

## Legacy：手动打补丁

> 仅在你还想给旧客户端手动注入悬浮面板时使用；正常情况忽略本节。

> ZCode 插件机制本身无法向封闭的 Electron 客户端 UI 注入按钮，所以这里直接修改客户端的 `app.asar`。**每次 ZCode 升级后需要重新应用一次补丁** —— 这是本方案被正式侧栏取代的原因。

## 用法

```bash
cd /Users/mac/Code/mine/plugin/zcode-token-usage

# 1) 先看要改什么（不写任何文件）
node tools/patch-client.mjs --dry-run

# 2) 应用补丁
node tools/patch-client.mjs                  # 默认 /Applications/ZCode.app
node tools/patch-client.mjs --app /path/to/ZCode.app

# 3) 完全退出 ZCode（⌘Q）再重新打开
```

重新打开后，右上角按钮排最左侧出现柱状图图标：悬停展开面板，点「固定」可钉住，面板内「刷新」重新查库（主进程侧有 3 秒缓存）。若图标没出现，多半是客户端里仍有旧的渲染进程，退出干净重开一次。

还原（一键）：

```bash
node tools/unpatch-client.mjs
```

## 备份与还原

补丁前会把原始 asar 完整复制到：

```
~/.zcode/token-usage-panel/app.asar.<ZCode 版本>.backup      # 原文件（约 293 MB）
~/.zcode/token-usage-panel/app.asar.<ZCode 版本>.backup.json # 版本、sha256、来源 app 路径
```

- 备份默认**保留最新 2 份**（每次升级都会生成一份约 300 MB 的文件，不宜无限堆积），更旧的由自动注入器在成功注入后清掉。想改保留份数：`ZCODE_TU_KEEP_BACKUPS=3`。
- `unpatch-client.mjs` 用**版本匹配**的备份还原；当前客户端版本与备份不一致时它会拒绝执行（可用 `--force` 强行还原，但那只在确认过 asar 同源时才有意义）。
- 若同一 ZCode 版本下重复打补丁，脚本会校验 sha256：备份与当前 asar 不一致时会报错并停止，避免把「已打补丁的 asar」当成原始文件备份下来。
- 手动兜底：备份文件就是普通 asar，直接复制回 `Contents/Resources/app.asar` 也等效于还原。

## 补丁改了什么

只在 `Contents/Resources/app.asar` 内增删这 5 个文件，不动磁盘上任何其它文件：

| 路径 | 操作 |
| --- | --- |
| `out/main/index.js` | 末尾追加约 3 行：动态 `import('./token-usage-main.js')` 并调用 `install()` |
| `out/main/token-usage-main.js` | 新增：`ipcMain.handle('zcode-token-usage:query')`，用 `/usr/bin/sqlite3 -readonly` 聚合 `~/.zcode/cli/db/db.sqlite` |
| `out/preload/index.cjs` | 末尾追加 `contextBridge.exposeInMainWorld('__zcodeTokenUsage', { query })` |
| `out/renderer/token-usage-panel.js` | 新增：图标 + 悬停面板（渲染层注入，不依赖 React 内部状态） |
| `out/renderer/index.html` | 在应用自身 module script 之后加一行 `<script type="module" src="./token-usage-panel.js">` |
| `zcode-token-usage.patch.json` | 新增：补丁清单（版本、时间、原 asar sha256、改动文件列表） |

写入方式：在临时文件 `app.asar.new-<时间戳>` 上重打包 → 逐文件校验 asar integrity 哈希 + 5 个内容标记 → 全部通过后原子 `rename` 覆盖。任何一步失败都不会动到原文件。

### 为什么不重新签名

补丁**刻意不重新签名** `ZCode.app`。重签会改变 app 的身份，导致 macOS 已授予的 TCC 权限（屏幕录制、辅助功能等）全部失效，需要用户重新授权一遍。这一步之所以不需要重签，是因为客户端 Electron fuse 里 `EnableEmbeddedAsarIntegrityValidation` 是 **disabled** 的——asar 内容的完整性不由签名校验（asar header 里仍带 integrity 字段，脚本会自己校验，见下），所以未签名的修改可以正常启动。

如果将来 ZCode 把这个 fuse 改成 enabled，就必须连带重签（届时 TCC 授权会重置）。

## 升级 ZCode 之后：自动重新注入（legacy，已停用）

> `hooks/hooks.json` 现在是 `{"hooks": {}}`，SessionStart hook 不会运行，**当年那套「升级后自动重打补丁」的行为已停用**，现在不会自动重打。本节仅描述 legacy 自动注入器的历史行为，脚本 `hooks/auto-patch.mjs` 仍可手动运行。

插件曾带一个 **SessionStart hook**（`token-usage/hooks/hooks.json` → `hooks/run.sh` → `hooks/auto-patch.mjs`），会在升级 ZCode 后第一次打开会话时发现客户端版本变了、自动重新打补丁并弹一句提示。**该 hook 已停用，不再自动重打补丁。**

```bash
# 手动查当前状态（不改任何东西）
node token-usage/hooks/auto-patch.mjs --dry-run

# 不看客户端，只跑纯函数自测（13 项：fuse 解码/判定、决策规则）
node token-usage/hooks/auto-patch.mjs --self-test

# 对指定的 .app 目录操作（测试用，配合 ZCODE_TU_TOOLS 指向补丁工具目录）
node token-usage/hooks/auto-patch.mjs --app /path/to/ZCode.app
```

运行痕迹都在 `~/.zcode/token-usage-panel/`：

| 文件 | 内容 |
| --- | --- |
| `auto.log` | 每次会话一行：跳过原因 / 重新注入耗时 / 失败原因（超过 256 KB 自动裁到最近 500 行）|
| `state.json` | 上次结果：`ok` / `already-patched` / `failed` / `refused`，含版本、asar 大小与 mtime |
| `auto.lock` | 防并发（10 分钟后自动失效）|
| `tools-path` | 补丁工具目录指针，找不到时会读它 |

**它什么时候动手**：客户端版本、asar 大小、mtime 三者之一和上次记录不符，且 asar 里确实没有补丁。三者都没变就静默跳过（最常见路径，几毫秒返回）。

**打完补丁为什么还要你手动重启**：补丁改的是磁盘上的 `app.asar`，而正在运行的那个进程在启动时就已经把 asar 映射好了，换文件不会热更新 —— 所以「已重新注入」只是说磁盘上准备好了，当前窗口里永远不会冒出图标。这个状态下每次会话（每小时最多一次）hook 都会再提醒一句「补丁已就位但还没重启」，直到你真的 ⌘Q 重开：重开后主进程启动时间晚于补丁时间，提醒自动停止。判定用的是 `ps` 里主进程的启动时间，不是任意进程 —— 升级残留的 crashpad handler 能活好几天，拿它对比会一直误判。

**它什么时候拒绝动手**（宁可不打，也不能把客户端弄坏）：

| 情况 | 行为 |
| --- | --- |
| Electron fuse `EnableEmbeddedAsarIntegrityValidation` 不是 disabled | 拒绝，并提示原因 —— 改过的 asar 会被客户端拒绝加载，这是安全闸门 |
| asar 在 3 秒内刚被写过，或隔 400ms 两次采样还在变 | 跳过本轮（疑似升级器正在换包） |
| 找不到 `patch-client.mjs` | 只提示，不动手（用 `ZCODE_TU_TOOLS` 或 `tools-path` 指定） |
| 上次失败 | 30 分钟内不重试，避免每个会话都弹通知 |

任何情况下都以 **exit 0** 结束（非 0 会被 hook 当成错误），诊断信息走 stderr、结构化提示走 stdout 的 hook JSON。

环境变量：`ZCODE_TU_TOOLS`（补丁工具目录）、`ZCODE_TU_NODE`（node 绝对路径，hook 由 Finder 启动时 PATH 里常常没有 node）、`ZCODE_TU_KEEP_BACKUPS`（备份保留份数，默认 2）、`ZCODE_TU_NO_NOTIFY=1`（不弹提示）。

**关掉自动注入**：删掉或清空 `token-usage/hooks/hooks.json` 后重新同步插件缓存即可（`hooks/hooks.json` 是客户端唯一的 hook 发现路径）：

```json
{ "hooks": {} }
```

### 手动重新注入（不想要自动逻辑时）

```bash
node tools/patch-client.mjs
```

若是**降级/版本回退**导致备份与当前版本不匹配，`unpatch-client.mjs` 会提示；确认后加 `--force`。版本号变化时旧备份仍然保留在原处（文件名带版本号），不会被新版本覆盖。

## 数据通路

```
renderer 面板  --window.__zcodeTokenUsage.query()-->  preload contextBridge
               --ipcRenderer.invoke('zcode-token-usage:query')-->  main ipcMain.handle
               --/usr/bin/sqlite3 -readonly -json-->  ~/.zcode/cli/db/db.sqlite (model_usage)
```

主进程返回的结构与 `skills/token-usage/report.mjs` 完全一致（`meta` / `hourly` / `daily`），前端也共用 `skills/token-usage/web/app.js`，所以面板数字与报告页面必然一致。口径定义见 `SKILL.md`；模型一律按 `provider_id|model_id` 分组，以区分不同供应商的同名模型。

渲染层面板用 `MutationObserver` + 2 秒轮询把图标插到 `header[data-workspace-header-variant]` 内右侧按钮组的最左端（找不到锚点就不显示，不会报错）。所有 CSS 选择器在构建时都被限定在 `#zcode-tu-root` 内，不会污染客户端样式。

## 开发

```bash
# 只重新构建渲染层面板脚本（不需要客户端）
node tools/build-panel.mjs
# → tools/build/token-usage-panel.js，并打印选择器限定检查结果

# 不开客户端验渲染层：把注入进 asar 的那份面板脚本 + 真实数据集 + 还原的 header 结构
# 拼成一个静态页，浏览器打开就能看「图标挂不挂得上、面板长什么样」
node tools/panel-harness.mjs            # 默认 http://127.0.0.1:8791
node tools/panel-harness.mjs --source build   # 还没打补丁时用构建件

# 修改面板外观：tools/payload/panel.css（面板局部样式）
#                  tools/payload/panel-shell.js（图标、定位、显隐、挂载）
# 修改查询逻辑：    tools/payload/main-token-usage.js
# 修改共用 UI 逻辑：token-usage/skills/token-usage/web/{app.js,style.css,template.html}
# 修改自动注入规则：token-usage/hooks/auto-patch.mjs（改完必须跑 --self-test；
#                  legacy，自动注入已停用，仅供手动运行时参考）
```

`panel-harness.mjs` 只覆盖渲染层（挂载 + 视觉）。IPC 查询、preload 桥、主进程 handler 仍然只能在真客户端里验；升级后「图标不见了」先用它排除渲染层，再去看 `auto.log` 判断补丁有没有打上。

改完 payload 后重新 `patch-client.mjs`（补丁已存在时先 `unpatch-client.mjs`，或加 `--force`）。

`tools/asar-lib.mjs` 是手写的 asar 读写实现（`openAsar` / `repack` / `verify`）。关键约定：header 里前 4 个 u32 分别是 `4`、`base-8`、`base-12`、未补齐的 JSON 长度；**数据区起点 `base = align4(16 + JSON 长度)`**（用 `16 + u32[8]` 会整体错开 4 字节，拿到的所有文件内容与 integrity 校验值都会对不上）。`verify()` 按「整文件 SHA256 + 每 4 MiB 一个块哈希」重算并逐个比对，重打包后必跑。对未修改的文件做一次空重打包可得到与原始 asar **逐字节相同**的结果——这是这套实现正确性的基准检查。

## 风险与兜底

- **客户端起不来**：`node tools/unpatch-client.mjs` 还原后重开。或手动把 `~/.zcode/token-usage-panel/app.asar.<版本>.backup` 复制回 `Contents/Resources/app.asar`。
- **图标不出现**：先看 `~/.zcode/token-usage-panel/auto.log` 判断补丁到底有没有打上（升级后没打上会写明原因）。若日志显示注入成功但图标仍然没有，多半是客户端内部 DOM 结构变化（升级后常见）导致锚点失配。面板本身不会报错，只是不显示；报告页 `/token-usage` 不受影响。此时需要按新的 DOM 结构更新 `panel-shell.js` 里的 `findRow()`。
- **ZCode 升级会使补丁失效**，需要重新应用：现已不再自动重打，手动跑 `patch-client.mjs` 即可。升级前后先 `unpatch` 再升级是更稳妥的顺序（其实升级会直接覆盖 asar，`unpatch` 主要用于「当前版本不想再用了」）。
- 补丁只读用户自己的本地数据库，不联网、不上传任何数据。

## 已验证环境

| ZCode 版本 | app.asar 大小 | `EnableEmbeddedAsarIntegrityValidation` | 结果 |
| --- | --- | --- | --- |
| 3.11.2 | 307,138,363 | disabled | 补丁可用（27,285 个条目）|
| 3.12.3 | — | disabled | 补丁可用；自动注入路径首次跑通 |
| 3.14.0 | 326,957,158 | disabled | 补丁可用；unpatch → hook → 1.8 秒重注入并校验通过 |

`contextIsolation: true`、`nodeIntegration: false`、sandboxed preload。其他版本请先 `--dry-run` 检查结构假设（`out/main/index.js`、`out/preload/index.cjs`、`out/renderer/index.html` 必须存在）。
