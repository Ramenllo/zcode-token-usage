#!/usr/bin/env node
// Applies the Token 用量 panel to an installed ZCode desktop app.
//
//   node tools/patch-client.mjs [--app /Applications/ZCode.app] [--dry-run] [--force]
//
// What it changes — five files inside Contents/Resources/app.asar, nothing else:
//   out/main/index.js               +1 line: dynamic import of the query module
//   out/main/token-usage-main.js    new: on-demand sqlite3 reader behind one IPC channel
//   out/preload/index.cjs           +bridge: contextBridge.exposeInMainWorld('__zcodeTokenUsage')
//   out/renderer/token-usage-panel.js  new: header icon + hover panel (dashboard shared with the report)
//   out/renderer/index.html         +1 line: loads that panel script
// The app bundle's code signature is left untouched on purpose: re-signing would change the
// app's identity and would reset its macOS TCC grants (Screen Recording / Accessibility).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openAsar, repack, verify } from './asar-lib.mjs';
import { buildPanelSource } from './build-panel.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.1.0';
const MARKER = 'zcode-token-usage.patch.json';
const BACKUP_DIR = path.join(homedir(), '.zcode', 'token-usage-panel');
const BOOTSTRAP =
  '\n// --- zcode-token-usage panel (appended by tools/patch-client.mjs) ---\n' +
  'import("./token-usage-main.js")\n' +
  '  .then((m) => m.install())\n' +
  '  .catch((e) => console.error("[token-usage] install failed:", e));\n';
const SCRIPT_TAG = '    <script type="module" crossorigin src="./token-usage-panel.js"></script>\n';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const APP = path.resolve(opt('app', '/Applications/ZCode.app'));
const ASAR = path.join(APP, 'Contents', 'Resources', 'app.asar');
const dryRun = flag('dry-run');
const force = flag('force');

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

if (!fs.existsSync(ASAR)) die(`找不到 ${ASAR}（用 --app 指定 ZCode.app 路径）`);

const archive = openAsar(ASAR);
const zcodeVersion = (() => {
  try {
    return JSON.parse(archive.readPath('package.json').toString('utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
const originalSha = sha256(fs.readFileSync(ASAR));

if (archive.entry('out/main/token-usage-main.js')) {
  console.log(`! 补丁已存在（ZCode ${zcodeVersion}）。要重新应用请先运行 unpatch-client.mjs，或加 --force。`);
  if (!force) {
    archive.close();
    process.exit(0);
  }
}
for (const p of ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) {
  if (!archive.entry(p)) die(`app.asar 结构不符合预期：缺少 ${p}`);
}

// ---- 组装注入内容 ----
const mainOrig = archive.readPath('out/main/index.js').toString('utf8');
const preloadOrig = archive.readPath('out/preload/index.cjs').toString('utf8');
const rendererHtml = archive.readPath('out/renderer/index.html').toString('utf8');

const payloadMain = fs
  .readFileSync(path.join(here, 'payload', 'main-token-usage.js'), 'utf8')
  .replace('const VERSION = \'0.1.0\';', `const VERSION = '${VERSION}';`);
const payloadPreload = fs
  .readFileSync(path.join(here, 'payload', 'preload-token-usage.js'), 'utf8')
  .replace(/__TOKEN_USAGE_VERSION__/g, VERSION);
const panelScript = buildPanelSource();

if (mainOrig.includes(BOOTSTRAP.trim().split('\n')[1])) die('out/main/index.js 已有引导代码，请先 unpatch');
if (preloadOrig.includes('__zcodeTokenUsage')) die('out/preload/index.cjs 已有桥接代码，请先 unpatch');

const mainNext = mainOrig + BOOTSTRAP;
const preloadNext = `${preloadOrig}\n;${payloadPreload}\n`;

const anchorRe = /<script type="module"[^>]*src="\.\/assets\/index-[^"]+"><\/script>\n?/;
if (rendererHtml.includes('token-usage-panel.js')) die('out/renderer/index.html 已引用面板脚本，请先 unpatch');
const htmlNext = anchorRe.test(rendererHtml)
  ? rendererHtml.replace(anchorRe, (m) => m + SCRIPT_TAG)
  : rendererHtml.replace('</head>', `${SCRIPT_TAG}  </head>`);

const manifest = {
  name: 'zcode-token-usage-panel',
  version: VERSION,
  appliedAt: new Date().toISOString(),
  zcodeVersion,
  originalSha256: originalSha,
  files: {
    set: ['out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html'],
    add: ['out/main/token-usage-main.js', 'out/renderer/token-usage-panel.js', MARKER],
  },
};

const changes = {
  set: {
    'out/main/index.js': Buffer.from(mainNext),
    'out/preload/index.cjs': Buffer.from(preloadNext),
    'out/renderer/index.html': Buffer.from(htmlNext),
  },
  add: {
    'out/main/token-usage-main.js': Buffer.from(payloadMain),
    'out/renderer/token-usage-panel.js': Buffer.from(panelScript),
    [MARKER]: Buffer.from(JSON.stringify(manifest, null, 2)),
  },
};

console.log(`ZCode ${zcodeVersion} — ${APP}`);
console.log(`  app.asar   ${(fs.statSync(ASAR).size / 1048576).toFixed(1)} MB  sha256 ${originalSha.slice(0, 12)}…`);
console.log(`  注入       ${Object.keys(changes.add).join(', ')}`);
console.log(`  修改       ${Object.keys(changes.set).join(', ')}`);
console.log(`  面板脚本   ${(panelScript.length / 1024).toFixed(1)} KB`);

if (dryRun) {
  archive.close();
  console.log('\n--dry-run：未写入任何文件。');
  process.exit(0);
}

// ---- 备份 ----
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const backup = path.join(BACKUP_DIR, `app.asar.${zcodeVersion}.backup`);
const backupMeta = `${backup}.json`;
if (!fs.existsSync(backup)) {
  console.log(`\n备份原 asar → ${backup}`);
  fs.copyFileSync(ASAR, backup);
  fs.writeFileSync(
    backupMeta,
    JSON.stringify({ zcodeVersion, sha256: originalSha, app: APP, createdAt: new Date().toISOString(), appAsar: ASAR }, null, 2),
  );
} else {
  const known = fs.existsSync(backupMeta) ? JSON.parse(fs.readFileSync(backupMeta, 'utf8')) : null;
  if (known && known.sha256 !== originalSha) {
    die(
      `已有同版本备份但内容不同：\n  ${backup}\n  备份 ${known.sha256.slice(0, 12)}… ≠ 当前 ${originalSha.slice(0, 12)}…\n` +
        `当前 asar 可能已经是打过补丁的版本。请先 unpatch，或手动移动该备份后重试。`,
    );
  }
}

// ---- 重打包（先写临时文件，校验通过再原子替换）----
const tmp = `${ASAR}.new-${stamp()}`;
const t0 = Date.now();
const result = repack(archive, tmp, changes);
archive.close();
console.log(`重打包完成：${result.files} 个文件 / ${(result.bytes / 1048576).toFixed(1)} MB（${Date.now() - t0} ms）`);

const check = openAsar(tmp);
const v = verify(check);
for (const p of [...manifest.files.set, ...manifest.files.add]) {
  if (!check.entry(p)) die(`校验失败：新 asar 缺少 ${p}`);
}
const markerOk = JSON.parse(check.readPath(MARKER).toString('utf8')).version === VERSION;
const bridgeOk = check.readPath('out/preload/index.cjs').toString('utf8').includes('__zcodeTokenUsage');
const bootOk = check.readPath('out/main/index.js').toString('utf8').includes('token-usage-main.js');
const panelOk = check.readPath('out/renderer/token-usage-panel.js').toString('utf8').includes('zcode-tu-root');
const htmlOk = check.readPath('out/renderer/index.html').toString('utf8').includes('token-usage-panel.js');
check.close();
if (v.bad.length || !markerOk || !bridgeOk || !bootOk || !panelOk || !htmlOk) {
  fs.rmSync(tmp, { force: true });
  die(`校验失败：integrity ${v.bad.length} 个不匹配，标记 ${markerOk}，桥接 ${bridgeOk}，引导 ${bootOk}，面板 ${panelOk}，html ${htmlOk}`);
}
console.log(`校验通过：${v.checked} 个文件的 integrity 哈希全部匹配`);

fs.renameSync(tmp, ASAR);
console.log(`\n✓ 补丁已应用：${ASAR}`);
console.log('\n下一步：完全退出 ZCode（⌘Q）再重新打开。右上角按钮排最左侧会出现一个柱状图图标，');
console.log('鼠标悬停即可看到用量面板。若客户端起不来，运行 node tools/unpatch-client.mjs 一键还原。');
