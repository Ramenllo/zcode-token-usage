#!/usr/bin/env node
// Removes the Token 用量 panel from an installed ZCode desktop app by restoring the
// app.asar backup taken by tools/patch-client.mjs.
//
//   node tools/unpatch-client.mjs [--app /Applications/ZCode.app] [--from <backup>] [--force]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { openAsar } from './asar-lib.mjs';

const BACKUP_DIR = path.join(homedir(), '.zcode', 'token-usage-panel');
const MARKER = 'zcode-token-usage.patch.json';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const APP = path.resolve(opt('app', '/Applications/ZCode.app'));
const ASAR = path.join(APP, 'Contents', 'Resources', 'app.asar');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
if (!fs.existsSync(ASAR)) die(`找不到 ${ASAR}`);

const archive = openAsar(ASAR);
const marker = archive.entry(MARKER) ? JSON.parse(archive.readPath(MARKER).toString('utf8')) : null;
const currentVersion = (() => {
  try {
    return JSON.parse(archive.readPath('package.json').toString('utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
archive.close();

if (!marker) {
  console.log('当前 app.asar 没有 Token 用量补丁的标记，无需还原。');
  process.exit(0);
}

const explicit = opt('from', '');
const backup = explicit || path.join(BACKUP_DIR, `app.asar.${marker.zcodeVersion}.backup`);
if (!fs.existsSync(backup)) {
  die(
    `找不到备份文件：${backup}\n` +
      `若备份已随应用更新被清理，请从官网重新安装 ZCode —— 补丁只改了 app.asar，重装即可完全复原。`,
  );
}

if (marker.zcodeVersion !== currentVersion && !flag('force')) {
  die(
    `ZCode 版本已从 ${marker.zcodeVersion} 变为 ${currentVersion}，用旧备份还原会把客户端降级。\n` +
      `请重新安装 ZCode（推荐），或确认风险后加 --force 继续。`,
  );
}

const backupSha = sha256(fs.readFileSync(backup));
if (marker.originalSha256 && backupSha !== marker.originalSha256) {
  die(`备份文件与打补丁时记录的不一致：\n  ${backupSha}\n  ${marker.originalSha256}`);
}

const restored = openAsar(backup);
if (restored.entry(MARKER) || restored.entry('out/main/token-usage-main.js')) {
  restored.close();
  die('备份文件里已包含补丁代码，拒绝用它覆盖 —— 请从官网重装 ZCode。');
}
restored.close();

fs.copyFileSync(backup, `${ASAR}.restoring-${process.pid}`);
fs.renameSync(`${ASAR}.restoring-${process.pid}`, ASAR);
console.log(`✓ 已还原 ${ASAR}（来自 ${backup}）`);
console.log('完全退出 ZCode（⌘Q）后重新打开即可。备份文件仍保留，可自行删除。');
