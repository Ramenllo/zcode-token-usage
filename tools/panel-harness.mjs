#!/usr/bin/env node
// 面板渲染验证 harness：不开客户端也能验「图标挂不挂得上、面板长什么样」。
//
// 为什么需要它：面板是注入进 app.asar 的，改一行 CSS 就要 ⌘Q 重开客户端才能看到效果，
// 而且升级后「图标不见了」既可能是注入失败、也可能是被注入的界面锚点变了。
// 这个脚本把**真正被注入的那份** token-usage-panel.js 从 asar 里取出来，配上一份按
// 当前客户端 JSX 还原的 header 结构 + 真实数据集，做成一个静态页面，用浏览器打开即可。
//
// 用法：
//   node tools/panel-harness.mjs                 # 生成到 /tmp/ztu-panel-harness 并启动本地服务
//   node tools/panel-harness.mjs --port 8791
//   node tools/panel-harness.mjs --out <dir>     # 只生成，不起服务
//   node tools/panel-harness.mjs --source build  # 用 tools/build 的构建件而不是 asar 里的（还没打补丁时用）
//
// 验什么：
//   1. 图标是否出现在右侧按钮组的最左端（findRow 的锚点逻辑）；
//   2. 悬停是否弹出面板、毛玻璃是否透出背景（背后那层浅色文字）；
//   3. 磁贴排布 / 模型四列（名称、t/s、缓存命中、用量）/ 折线图坐标轴标签是否重叠。
// 注意：这里只验渲染层。IPC 查询、preload 桥、主进程 handler 属于打补丁的验证范围（见 README）。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAsar } from './asar-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const appAsar = '/Applications/ZCode.app/Contents/Resources/app.asar';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const outDir = arg('out', '/tmp/ztu-panel-harness');
const port = Number(arg('port', 8791));
const useBuild = arg('source', 'asar') === 'build';

// header 结构照 out/renderer/assets/styles-*.js 里 header / m5t 的 JSX 还原：
// header > [ (draft&&active ? 遮罩 : null), div.flex.h-12.flex-1… > [左侧, div.flex.shrink-0.items-center…] ]
const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Token 用量面板 — 渲染验证</title>
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #17191c; color: #e6e7e9;
    font: 13px -apple-system, "Helvetica Neue", sans-serif; }
  header { position: relative; display: flex; width: 100%; height: 48px; flex-shrink: 0;
    border-bottom: 1px solid rgba(255,255,255,.08); background: #1d2024; }
  .row { display: flex; height: 48px; flex: 1 1 0%; min-width: 0; align-items: center;
    justify-content: space-between; gap: 8px; overflow: hidden; padding: 8px; }
  .left { min-width: 0; flex: 1 1 0%; color: #9aa0a6; }
  .group { display: flex; flex-shrink: 0; align-items: center; gap: 2px; }
  .group button { height: 28px; padding: 0 8px; border: 0; border-radius: 6px;
    background: transparent; color: #b9bec4; font: inherit; cursor: pointer; }
  .group button:hover { background: rgba(255,255,255,.08); }
  .behind { position: fixed; inset: 0; display: flex; flex-direction: column; gap: 14px;
    padding: 78px 40px; color: #2b3036; background:
      linear-gradient(120deg, #f5f6f8 0%, #e7ecf3 40%, #f7f2ea 100%); }
  .behind h2 { margin: 0; font-size: 22px; color: #1b1f24; }
  .behind p { margin: 0; font-size: 14px; line-height: 1.7; max-width: 560px; }
</style>
</head>
<body>
<div class="behind">
  <h2>面板背后应当是能透出内容的毛玻璃</h2>
  <p>这一层模拟客户端主界面。面板若是不透明的深色块，说明 backdrop-filter 没生效；
     应当能看出这里的浅色文字与渐变被模糊后透过来。</p>
  <p>右上角按钮排是重点：面板图标应当出现在「编辑器 / 终端 / 侧栏 / ?」这组按钮的最左边。</p>
</div>

<div id="root"></div>

<header data-workspace-header-variant="task" data-testid="workspace-header">
  <div class="row">
    <div class="left">任务标题 · zcode-token-usage</div>
    <div class="group">
      <div><button type="button" aria-label="选择编辑器">编辑器</button></div>
      <div><button type="button" aria-label="终端">终端</button></div>
      <div><button type="button" aria-label="侧栏">侧栏</button></div>
      <div><button type="button" aria-label="帮助">?</button></div>
    </div>
  </div>
</header>

<script src="./data.js"></script>
<script>
  // preload contextBridge 的替身：返回真实数据集
  window.__zcodeTokenUsage = {
    version: '0.1.0',
    query: async () => ({ ok: true, data: window.__REAL_DATA__ }),
  };
</script>
<script type="module" crossorigin src="./token-usage-panel.js"></script>
</body>
</html>
`;

// ---------- 1) 取面板脚本 ----------
let panelJs;
if (useBuild) {
  const p = join(HERE, 'build', 'token-usage-panel.js');
  if (!existsSync(p)) throw new Error(`没有构建件：${p}，先跑 node tools/build-panel.mjs`);
  panelJs = readFileSync(p);
  console.log(`面板脚本：${p}（本地构建件）`);
} else {
  const a = openAsar(appAsar);
  const entry = a.entry('out/renderer/token-usage-panel.js');
  if (!entry) throw new Error('asar 里没有注入的面板脚本 —— 先打补丁，或用 --source build');
  panelJs = a.read(entry);
  console.log(`面板脚本：${appAsar} 里的 out/renderer/token-usage-panel.js`);
}

// ---------- 2) 取真实数据集 ----------
const reportHtml = join(homedir(), '.zcode', 'token-usage-report.html');
try {
  execFileSync(process.execPath, [join(HERE, '..', 'token-usage', 'skills', 'token-usage', 'report.mjs'), '--no-open'], { stdio: 'ignore' });
} catch (e) {
  console.log(`重新生成报告失败（改用已有文件）：${e.message.split('\n')[0]}`);
}
const html = readFileSync(reportHtml, 'utf8');
const m = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
if (!m) throw new Error(`没能从 ${reportHtml} 里取出数据集`);
const data = JSON.parse(m[1]);
console.log(`数据集：小时桶 ${data.hourly.length} / 日桶 ${data.daily.length} / 模型 ${new Set(data.daily.map((r) => r.m)).size}`);

// ---------- 3) 写 harness ----------
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'token-usage-panel.js'), panelJs);
writeFileSync(join(outDir, 'data.js'), `window.__REAL_DATA__ = ${JSON.stringify(data)};\n`);
writeFileSync(join(outDir, 'index.html'), INDEX_HTML);

console.log(`\n已生成 ${outDir}`);
if (argv.includes('--out')) process.exit(0);
const { spawn } = await import('node:child_process');
spawn('/usr/bin/python3', ['-m', 'http.server', String(port), '--directory', outDir], { detached: true, stdio: 'ignore' }).unref();
console.log(`打开 http://127.0.0.1:${port}/index.html —— 图标应在右侧「编辑器/终端/侧栏/?」那组的最左边，悬停弹面板。`);
console.log('背景那层浅色文字若被模糊透出，说明毛玻璃生效。验完直接 Ctrl-C 关掉 python3 -m http.server 即可。');
