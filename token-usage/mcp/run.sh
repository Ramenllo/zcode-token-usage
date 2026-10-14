#!/bin/sh
# Token 用量 MCP server 启动器：探测可用的 node 并 exec server.mjs。
# 这是手动/调试兜底启动器（会探测 node，必要时用 ZCode 自带 Electron）。
# 正式入口是 plugin.json 里的 `command: "node"` + `mcp/server.mjs`，本脚本已不再被清单引用。
# 顺序 ZCODE_TU_NODE > PATH node > Homebrew/系统路径 > ZCode 自带 Electron(RUN_AS_NODE)。
# 失败只写 stderr，stdout 不留非协议内容。
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER="$SCRIPT_DIR/server.mjs"

is_exec() { [ -x "$1" ] 2>/dev/null; }

run_node() {
  # $1 = node 可执行文件；其余参数来自调用方
  exec "$@"
}

# 1) 显式指定（测试用）
if [ -n "${ZCODE_TU_NODE:-}" ]; then
  if is_exec "$ZCODE_TU_NODE"; then
    run_node "$ZCODE_TU_NODE" "$SERVER"
  fi
  echo "[token-usage-mcp] ZCODE_TU_NODE 不可执行: $ZCODE_TU_NODE" >&2
  exit 127
fi

# 2) PATH 里的 node
if command -v node >/dev/null 2>&1; then
  run_node node "$SERVER"
fi

# 3) 常见安装路径
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if is_exec "$candidate"; then
    run_node "$candidate" "$SERVER"
  fi
done

# 4) 用 ZCode 自带的 Electron 二进制当 node
ZCODE_BIN="/Applications/ZCode.app/Contents/MacOS/ZCode"
if is_exec "$ZCODE_BIN"; then
  export ELECTRON_RUN_AS_NODE=1
  run_node "$ZCODE_BIN" "$SERVER"
fi

echo "[token-usage-mcp] 找不到可用的 node：请安装 Node，或设置 ZCODE_TU_NODE 指向 node 可执行文件" >&2
exit 127
