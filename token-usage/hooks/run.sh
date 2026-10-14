#!/bin/sh
# 插件 hook 的入口：先定位 node，再交给 auto-patch.mjs。
# 为什么要这层壳：ZCode 由 Finder/launchd 启动时 PATH 往往只有 /usr/bin:/bin，
# 那时 `node` 不在 PATH 里（nvm 装的更不在），直接写 "command": "node xxx.mjs" 会静默失败。
# 诊断信息走 stderr（客户端日志会显示），stdout 留给 auto-patch.mjs 的 JSON。
for n in "$ZCODE_TU_NODE" "$(command -v node 2>/dev/null)" /usr/local/bin/node /opt/homebrew/bin/node \
         "$HOME"/.nvm/versions/node/*/bin/node /usr/local/opt/node/bin/node; do
  if [ -n "$n" ] && [ -x "$n" ]; then
    exec "$n" "$(dirname "$0")/auto-patch.mjs"
  fi
done
echo "[token-usage] 找不到可用的 node，跳过自动注入（可用 ZCODE_TU_NODE 指定绝对路径）" >&2
exit 0
