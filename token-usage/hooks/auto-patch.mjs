#!/usr/bin/env node
// ZCode 版本变化后自动重新注入用量面板（右上角图标 + 悬浮面板）。
//
// 为什么需要它：图标和面板是注入进 /Applications/ZCode.app/Contents/Resources/app.asar 的，
// 客户端每次升级都会把 asar 换成新版本，注入随之消失。这个脚本由插件的 SessionStart hook 调用，
// 检测「当前客户端版本 != 上次注入时的版本」就重打一次补丁。
//
// 三条设计原则：
//   1. 永远不阻塞会话 —— 无论发生什么都以 0 退出（非 0 会被 hook 当成错误）；
//      正常情况几毫秒就返回，只有真的需要重注入时才花几秒。
//   2. 不确定就不动手 —— asar 完整性校验若被打开、疑似正在升级、找不到补丁工具，
//      一律跳过并记录原因，绝不用 --force 硬上（打坏客户端比没有图标严重得多）。
//   3. 说清楚做了什么 —— 结果写日志、写状态文件，需要用户操作（重启）时通过 hook 输出告知。
//
// 用法：
//   node auto-patch.mjs            正常检查（hook 调用的就是这个）
//   node auto-patch.mjs --dry-run  只打印将要做什么，不修改任何东西
//   node auto-patch.mjs --self-test 跑纯函数自测（不碰客户端）
//   node auto-patch.mjs --app <dir> 对指定的 .app 目录操作（测试用）
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync, rmSync, openSync, closeSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const STATE_DIR = join(HOME, '.zcode', 'token-usage-panel');
const STATE_FILE = join(STATE_DIR, 'state.json');
const LOG_FILE = join(STATE_DIR, 'auto.log');
const LOCK_FILE = join(STATE_DIR, 'auto.lock');
const TOOLS_POINTER = join(STATE_DIR, 'tools-path');
const PATCH_MARKER = 'zcode-token-usage.patch.json';
// asar 头部是嵌套树、按文件名（basename）作键，所以这里必须用文件名而不是完整路径
const PANEL_ENTRY = 'token-usage-panel.js';
const KEEP_BACKUPS = Number(process.env.ZCODE_TU_KEEP_BACKUPS || 2);
// 只挡「刚刚几秒内写过」的文件：升级后第一次会话就必须能补上，不能用长时间窗把这一刻挡掉。
// 真正防并发写入的是 asarStable()（采样两次看文件是否还在变），不是这个时间窗。
const FRESH_UPDATE_MS = 3_000;
const RETRY_MS = 30 * 60_000;      // 失败后的重试间隔

// ---------------------------------------------------------------- 纯函数（便于自测）
const PLIST_KEYS = {
  sentinel: 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX',
  /** Electron fuse wire：哨兵 + 版本(1B) + 开关数(1B) + 状态字节(N)
   *  状态字节 0x30='0' 关闭 / 0x31='1' 开启 / 0x72='r' 已移除 */
  asarIntegrityIndex: 4,
};

export function decodeFuses(buf) {
  const at = buf.indexOf(PLIST_KEYS.sentinel);
  if (at < 0) return null;
  const p = at + PLIST_KEYS.sentinel.length;
  const version = buf[p];
  const count = buf[p + 1];
  if (!count || count > 32 || p + 2 + count > buf.length) return null;
  const states = [];
  for (let i = 0; i < count; i++) {
    const b = buf[p + 2 + i];
    states.push(b === 0x31 ? 'enabled' : b === 0x30 ? 'disabled' : b === 0x72 ? 'removed' : `0x${b.toString(16)}`);
  }
  return { version, count, states };
}

/** 只有「嵌入式 asar 完整性校验」关着，改过的 asar 才会被接受 —— 这是一切的前提 */
export function fuseAllowsPatching(decoded) {
  if (!decoded) return { ok: false, reason: '在 Electron Framework 里找不到 fuse 哨兵，无法确认完整性校验状态' };
  const state = decoded.states[PLIST_KEYS.asarIntegrityIndex];
  if (state === 'disabled') return { ok: true };
  return { ok: false, reason: `EnableEmbeddedAsarIntegrityValidation = ${state}，此时替换 asar 会被拒绝` };
}

/** 决策：这一轮到底要不要重打补丁。
 *  state.result 为 ok/already-patched 且版本、大小、mtime 三者都没变 → 静默跳过（最常见路径）；
 *  上次失败则 30 分钟内不重试，避免每个会话都弹通知。 */
export function decide({ state, version, size, mtimeMs, hasPatch, freshMs, now }) {
  if (!version) return { action: 'skip', reason: '读不到客户端版本号' };
  const done = state && (state.result === 'ok' || state.result === 'already-patched');
  if (done && state.version === version && state.size === size && state.mtimeMs === mtimeMs) {
    return { action: 'skip', reason: '本轮已检查过（版本/大小/时间都未变）', silent: true };
  }
  if (freshMs != null && freshMs < FRESH_UPDATE_MS) {
    return { action: 'skip', reason: `app.asar 在 ${Math.round(freshMs / 1000)} 秒前刚被写过，疑似正在升级，本轮不动手` };
  }
  if (state && state.result === 'failed' && now - (state.at || 0) < RETRY_MS) {
    return { action: 'skip', reason: '上次注入失败，半小时内不重试', silent: true };
  }
  if (hasPatch) return { action: 'record', reason: 'asar 里已有补丁，只更新状态记录' };
  return { action: 'patch', reason: '客户端版本变了且 asar 里没有补丁' };
}

// ---------------------------------------------------------------- 小工具
/** quiet=true 只写日志文件不写 stderr —— 每次会话都会跑一遍，静默跳过不该刷屏，
 *  但必须留一行凭证，否则「升级后 hook 到底有没有触发」无从查起。 */
function log(msg, quiet) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // 超过 256KB 就裁到最近 500 行，避免无限增长
    if (existsSync(LOG_FILE) && statSync(LOG_FILE).size > 256 * 1024) {
      const kept = readFileSync(LOG_FILE, 'utf8').split('\n').slice(-500).join('\n');
      writeFileSync(LOG_FILE, kept);
    }
    writeFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`, { flag: 'a' });
  } catch {}
  if (!quiet) process.stderr.write(`[token-usage] ${msg}\n`);
}
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
function writeJson(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj, null, 2));
  } catch (e) { log(`写状态文件失败: ${e.message}`); }
}
function appVersion(appDir) {
  try {
    const out = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(appDir, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    return out || null;
  } catch { return null; }
}
/** asar 头部里有没有我们的补丁条目（只读头部，不读整包）。
 *  注意用 readSync 做定位读：Node 20 起 readFileSync 已不再接受 offset/length/position 位置参数。 */
function asarHasPatch(asarPath) {
  let fd = null;
  try {
    fd = openSync(asarPath, 'r');
    const head = Buffer.alloc(16);
    if (readSync(fd, head, 0, 16, 0) !== 16) return false;
    const jsonLen = head.readUInt32LE(12);
    if (jsonLen <= 0 || jsonLen > 64 * 1024 * 1024) return false;
    const json = Buffer.alloc(jsonLen);
    let got = 0;
    while (got < jsonLen) {
      const n = readSync(fd, json, got, jsonLen - got, 16 + got);
      if (n <= 0) break;
      got += n;
    }
    if (got !== jsonLen) return false;
    const text = json.toString('utf8');
    return text.includes(PATCH_MARKER) && text.includes(PANEL_ENTRY);
  } catch (e) {
    log(`读 asar 头部失败: ${e.message}`);
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
/** 找补丁工具目录：环境变量 → 指针文件 → 常见位置 */
function findToolsDir() {
  const candidates = [];
  if (process.env.ZCODE_TU_TOOLS) candidates.push(process.env.ZCODE_TU_TOOLS);
  try { candidates.push(readFileSync(TOOLS_POINTER, 'utf8').trim()); } catch {}
  candidates.push(join(HOME, 'Code', 'mine', 'plugin', 'zcode-token-usage', 'tools'));
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, 'patch-client.mjs'))) return dir;
  }
  // 兜底：在 workspace 根下面浅搜一层
  try {
    for (const base of [join(HOME, 'Code'), join(HOME, 'Projects'), join(HOME, 'workspace')]) {
      if (!existsSync(base)) continue;
      for (const name of readdirSync(base)) {
        const dir = join(base, name, 'zcode-token-usage', 'tools');
        if (existsSync(join(dir, 'patch-client.mjs'))) return dir;
      }
    }
  } catch {}
  return null;
}
/** 备份保留策略：只留最新的 N 份（每次升级都会生成一份 ~300MB） */
function pruneBackups() {
  const removed = [];
  try {
    const files = readdirSync(STATE_DIR).filter((f) => /^app\.asar\..+\.backup$/.test(f));
    const withTime = files.map((f) => ({ f, t: statSync(join(STATE_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f } of withTime.slice(KEEP_BACKUPS)) {
      rmSync(join(STATE_DIR, f), { force: true });
      rmSync(join(STATE_DIR, f.replace(/\.backup$/, '.backup.json')), { force: true });
      removed.push(f);
    }
  } catch (e) { log(`清理旧备份失败: ${e.message}`); }
  return removed;
}
function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const info = readJson(LOCK_FILE);
      if (info && Date.now() - (info.at || 0) < 10 * 60_000) return false;
    }
    mkdirSync(STATE_DIR, { recursive: true });
    writeJson(LOCK_FILE, { pid: process.pid, at: Date.now() });
    return true;
  } catch { return false; }
}
/** 动手前确认 asar 不在被写：隔 400ms 采两次 (size, mtime)，还在变就不碰。
 *  升级器换包是「写临时文件再替换」，所以正常情况下这里只会看到稳定的成品。 */
async function asarStable(asarPath) {
  const sample = () => { const s = statSync(asarPath); return `${s.size}:${s.mtimeMs}`; };
  try {
    const a = sample();
    await new Promise((r) => setTimeout(r, 400));
    return a === sample();
  } catch { return false; }
}
const releaseLock = () => { try { rmSync(LOCK_FILE, { force: true }); } catch {} };

/** 客户端是不是正开着。
 *  这决定了提示措辞：正在运行的那个窗口加载的是升级前的旧代码（asar 在进程启动时就映射好了，
 *  换文件不会热更新），所以「已重新注入」不等于「现在就能看到图标」—— 必须真⌘Q重开。
 *  用户最容易误解的就是这一点，直接把原因说进提示里。 */
export function clientRunning(appDir) {
  try {
    // 用 args 而不是 comm 判断：macOS 上主进程的 comm 只是 "ZCode"（不带路径），
    // 而 args 里含完整的 .app 路径 —— 也顺便能区分「跑的是不是我们刚打补丁的这份拷贝」。
    const needle = join(appDir, 'Contents');
    const out = execFileSync('/bin/ps', ['-Ao', 'args='], { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').some((l) => l.includes(needle));
  } catch { return false; }
}

/** 当前客户端**主进程**是什么时候启动的（毫秒，多个实例取最新），拿不到就 null。
 *  用途：补丁是在进程启动之后才写进 asar 的 —— 那个进程用的一直是旧代码，
 *  必须重启才生效。知道启动时间才能判断「补丁已就位但还没生效」这个状态。
 *  只认主进程：helper/renderer 的 args 带 --type= 之类的参数，而上一版安装残留的
 *  crashpad handler 可能已经活了好几天，把它算进来会让判断完全失真；
 *  同理也不能取"最新"的任意 app 内进程（补丁打完后 spawn 的 ugrep 之类会更晚）。 */
export function appStartMs(appDir) {
  try {
    const appName = basename(appDir).replace(/\.app$/i, '');
    const out = execFileSync('/bin/ps', ['-Ao', 'lstart=,args='], { encoding: 'utf8', timeout: 5000 });
    let latest = null;
    for (const raw of out.split('\n')) {
      // lstart 形如 "Mon Sep 21 09:29:35 2026"，其后是 args
      const m = raw.trim().match(/^([A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ \d\d:\d\d:\d\d \d{4}) (.*)$/);
      if (!m) continue;
      const cmd = m[2].trim();
      if (cmd !== appName && !cmd.endsWith(`/${appName}`)) continue;
      const t = Date.parse(m[1]);
      if (Number.isFinite(t) && (latest === null || t > latest)) latest = t;
    }
    return latest;
  } catch { return null; }
}

/** 补丁已就位，但客户端还是「打补丁之前启动的那个进程」→ 该提醒重启。
 *  节流：同一个待重启状态每小时最多念一次，免得每个会话都刷。 */
export function shouldRemindRestart({ state, appStartMs: start, now, intervalMs = 60 * 60_000 }) {
  if (!state) return false;
  if (state.result !== 'ok' && state.result !== 'already-patched') return false;
  if (start == null) return false;
  if (!(state.at > start)) return false;            // 补丁写在全进程启动之前 → 已经是新代码，无需重启
  return now - (state.restartNoticedAt || 0) >= intervalMs;
}

/** 唯一对外的输出通道：hook 会把它当作 JSON 解析并展示给用户 */
function notify(message) {
  if (process.env.ZCODE_TU_NO_NOTIFY) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
    systemMessage: message,
  }));
}

// ---------------------------------------------------------------- 自测
function selfTest() {
  const ok = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); return cond; };
  const sentinel = Buffer.from(PLIST_KEYS.sentinel, 'utf8');
  const wire = (states) => Buffer.concat([sentinel, Buffer.from([1, states.length]), Buffer.from(states, 'ascii')]);
  let pass = true;
  // fuse 解码与判定
  pass &= ok('fuse: 关闭完整性校验 → 允许打补丁', fuseAllowsPatching(decodeFuses(wire('101100011'))).ok === true);
  pass &= ok('fuse: 打开完整性校验 → 拒绝', fuseAllowsPatching(decodeFuses(wire('101110011'))).ok === false);
  pass &= ok('fuse: 状态被移除(removed) → 拒绝', fuseAllowsPatching(decodeFuses(wire('1011r0011'))).ok === false);
  pass &= ok('fuse: 找不到哨兵 → 拒绝', fuseAllowsPatching(decodeFuses(Buffer.from('nope'))).ok === false);
  pass &= ok('fuse: 开关数为 0 的坏数据 → 拒绝', fuseAllowsPatching(decodeFuses(Buffer.concat([sentinel, Buffer.from([1, 0])]))).ok === false);
  // 决策
  const base = { version: '3.14.0', size: 326_900_000, mtimeMs: 1000, hasPatch: false, freshMs: 999_999, now: 10_000_000 };
  const done = { version: '3.14.0', size: base.size, mtimeMs: 1000, result: 'ok', at: 1 };
  pass &= ok('决策: 已打过且版本/大小/时间未变 → 静默跳过', decide({ ...base, state: done }).action === 'skip' && decide({ ...base, state: done }).silent === true);
  pass &= ok('决策: 版本变了且无补丁 → 打补丁', decide({ ...base, state: { ...done, version: '3.12.3' } }).action === 'patch');
  pass &= ok('决策: 版本变了但已有补丁 → 只记录', decide({ ...base, state: { ...done, version: '3.12.3' }, hasPatch: true }).action === 'record');
  pass &= ok('决策: asar 刚被写过（1 秒前）→ 跳过（疑似正在写）', decide({ ...base, state: null, freshMs: 1_000 }).action === 'skip');
  pass &= ok('决策: 升级完 1 分钟后 → 照常补（不会被时间窗挡住）', decide({ ...base, state: null, freshMs: 60_000 }).action === 'patch');
  pass &= ok('决策: 读不到版本 → 跳过', decide({ ...base, state: null, version: null }).action === 'skip');
  pass &= ok('决策: 上次失败但已过 30 分钟 → 重试', decide({ ...base, state: { version: '3.14.0', result: 'failed', at: base.now - 31 * 60_000 } }).action === 'patch');
  pass &= ok('决策: 上次失败且在 30 分钟内 → 不重试', decide({ ...base, state: { version: '3.14.0', result: 'failed', at: base.now - 60_000 } }).action === 'skip');
  pass &= ok('决策: 只记录了 already-patched 且文件未变 → 静默跳过', decide({ ...base, state: { ...done, result: 'already-patched' } }).silent === true);
  // 「补丁已就位但还没重启」的提醒节流
  const rr = { state: { ...done, at: 5_000_000, result: 'ok' }, now: 10_000_000 };
  pass &= ok('重启提醒: 补丁晚于进程启动 → 要提醒', shouldRemindRestart({ ...rr, appStartMs: 4_000_000 }) === true);
  pass &= ok('重启提醒: 补丁早于进程启动（已是新代码）→ 不提醒', shouldRemindRestart({ ...rr, appStartMs: 6_000_000 }) === false);
  pass &= ok('重启提醒: 拿不到进程启动时间 → 不提醒', shouldRemindRestart({ ...rr, appStartMs: null }) === false);
  pass &= ok('重启提醒: 一小时内已提醒过 → 不重复', shouldRemindRestart({ ...rr, appStartMs: 4_000_000, state: { ...rr.state, restartNoticedAt: 9_500_000 } }) === false);
  pass &= ok('重启提醒: 距上次提醒超过一小时 → 再提醒', shouldRemindRestart({ ...rr, appStartMs: 4_000_000, state: { ...rr.state, restartNoticedAt: 6_000_000 } }) === true);
  pass &= ok('重启提醒: 上次结果是失败/拒绝 → 不提醒', shouldRemindRestart({ ...rr, appStartMs: 4_000_000, state: { ...rr.state, result: 'failed' } }) === false);
  console.log(pass ? '\n自测全部通过' : '\n有失败项');
  process.exitCode = pass ? 0 : 1;
}

// ---------------------------------------------------------------- 主流程
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const dryRun = argv.includes('--dry-run');
  const appIdx = argv.indexOf('--app');
  const appDir = appIdx >= 0 && argv[appIdx + 1] ? resolve(argv[appIdx + 1]) : '/Applications/ZCode.app';
  const asar = join(appDir, 'Contents/Resources/app.asar');
  const fuseBin = join(appDir, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework');

  if (!existsSync(asar)) { log(`找不到 ${asar}，跳过`); return; }
  const version = appVersion(appDir);
  const st = statSync(asar);
  const state = readJson(STATE_FILE);
  const hasPatch = asarHasPatch(asar);
  const d = decide({ state, version, size: st.size, mtimeMs: st.mtimeMs, hasPatch, freshMs: Date.now() - st.mtimeMs, now: Date.now() });

  if (d.action === 'skip') {
    log(`跳过：${d.reason}`, d.silent && !dryRun);
    if (dryRun) console.log(`[dry-run] 结论：跳过（${d.reason}）`);
    // 补丁在磁盘上是好的，但当前进程是打补丁之前启动的：面板不会突然出现，
    // 用户很容易以为「自动注入没生效」。这个状态下每次会话再提醒一遍（每小时最多一次）。
    if (shouldRemindRestart({ state, appStartMs: appStartMs(appDir), now: Date.now() })) {
      writeJson(STATE_FILE, { ...state, restartNoticedAt: Date.now() });
      log('补丁已就位但客户端尚未重启，已再次提示');
      notify('Token 用量面板的补丁已经就位，但 ZCode 还是上次启动的那个进程 —— 图标不会自己出现。请 ⌘Q 完全退出 ZCode（不是关窗口）后重新打开。');
    }
    return;
  }
  // 该动手了 —— 先过安全闸门
  let fuses = null;
  try { fuses = decodeFuses(readFileSync(fuseBin)); } catch (e) { log(`读 fuse 失败: ${e.message}`); }
  const gate = fuseAllowsPatching(fuses);
  if (!gate.ok) {
    log(`拒绝打补丁：${gate.reason}`);
    notify(`Token 用量面板未重新注入：${gate.reason}。这是安全保护 —— 请手动运行 tools/patch-client.mjs 前先确认。`);
    writeJson(STATE_FILE, { version, size: st.size, mtimeMs: st.mtimeMs, result: 'refused', reason: gate.reason, at: Date.now() });
    return;
  }
  if (d.action === 'record') {
    log(`asar 已有补丁（${version}），更新状态`);
    writeJson(STATE_FILE, { version, size: st.size, mtimeMs: st.mtimeMs, result: 'already-patched', at: Date.now() });
    return;
  }  // 真的要重注入
  if (dryRun) {
    console.log(`[dry-run] 结论：需要为 ${version} 重新注入（asar ${st.size} 字节，无补丁，fuse 已放开）`);
    return;
  }
  // 真正动手前再确认一次文件稳定（防和升级器抢写）
  if (!(await asarStable(asar))) { log('asar 正在变化（疑似升级器在换包），本轮跳过'); return; }
  if (!acquireLock()) { log('已有另一个实例在跑，跳过'); return; }
  try {
    const toolsDir = findToolsDir();
    if (!toolsDir) {
      log('找不到补丁工具目录（patch-client.mjs），请设置 ZCODE_TU_TOOLS 或写 ~/.zcode/token-usage-panel/tools-path');
      notify('检测到 ZCode 已升级，但没找到补丁工具目录，无法自动重新注入用量面板。请手动运行 patch-client.mjs。');
      return;
    }
    log(`客户端升到 ${version}，用 ${toolsDir} 重新注入…`);
    const started = Date.now();
    let out = '';
    let failed = null;
    try {
      out = execFileSync(process.execPath, [join(toolsDir, 'patch-client.mjs')], { encoding: 'utf8', timeout: 300_000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      failed = (e.stderr || e.stdout || e.message || '未知错误').toString().trim().slice(0, 600);
    }
    const took = ((Date.now() - started) / 1000).toFixed(1);
    // 补丁工具在「已存在补丁」时会拒绝执行，这不是失败：再确认一次头部即可
    const alreadyByTool = !!failed && /补丁已存在/.test(failed);
    const patchedNow = asarHasPatch(asar);
    const okNow = patchedNow && (!failed || alreadyByTool);
    if (okNow) {
      const st2 = statSync(asar);
      const pruned = pruneBackups();
      if (pruned.length) log(`清理旧备份：${pruned.join(', ')}`);
      writeJson(STATE_FILE, {
        version, size: st2.size, mtimeMs: st2.mtimeMs, at: Date.now(),
        tookSec: Number(took), result: alreadyByTool ? 'already-patched' : 'ok',
      });
      const running = clientRunning(appDir);
      log(`已为 ${version} 重新注入（${took}s）${pruned.length ? `，清理旧备份 ${pruned.length} 份` : ''}${running ? '；客户端正在运行，需 ⌘Q 重开才生效' : ''}`);
      notify(
        `检测到 ZCode 已升级到 ${version}，用量面板（右上角图标）已自动重新注入。` +
        (running
          ? '但当前这个窗口加载的还是升级前的旧界面（补丁不会热更新）—— 必须按 ⌘Q 完全退出 ZCode（不是关窗口），再重新打开，图标才会出现。'
          : '重新打开 ZCode 即可看到图标。'),
      );
      return;
    }
    // 失败：不写 size/mtime，好让下一轮（30 分钟后）重新尝试
    const why = (failed || '注入后校验未通过').split('\n').filter(Boolean).slice(-1)[0] || '未知原因';
    writeJson(STATE_FILE, { version, at: Date.now(), result: 'failed', error: why });
    log(`注入失败（${took}s）：${why}`);
    notify(`ZCode 升级到 ${version}，但自动重新注入用量面板失败：${why}`);
  } finally {
    releaseLock();
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => { log(`异常：${e && e.stack ? e.stack.split('\n')[0] : e}`); });
}
