---
description: 生成并打开 ZCode token 用量独立报告（token 消耗、生成速率、缓存命中、近7日走势）。
argument-hint: "[--no-open]"
skills: token-usage
---

Use the `token-usage` skill for this request:

$ARGUMENTS

生成 token 用量**独立报告**并在浏览器打开，然后把脚本 stdout 的摘要转述给用户。

说明：日常看用量请直接打开右上方侧栏的「Token 用量」面板——它由本地 MCP server 提供，打开/刷新都不经过模型，无需运行本命令；侧栏在无活动会话时不可用。本命令 `/token-usage` 必须在一个任务（会话）里执行，别在没有会话时发它；无活动会话又想要数据时，可直接命令行运行报告脚本 `node <base>/report.mjs`（脱离 UI 独立运行），或新建一个任务再发本命令。
