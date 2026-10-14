// Injected into ZCode's main process (out/main/token-usage-main.js inside app.asar).
// Exposes one IPC channel that reads ZCode's local usage database on demand.
// No resident service, no listening port: nothing runs until the panel asks.
import { ipcMain } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CHANNEL = 'zcode-token-usage:query';
const VERSION = '0.1.0';
// sqlite3 CLI 默认候选路径（macOS 自带）；Windows 无此文件时回退到 node:sqlite。
const SQLITE = process.env.ZCODE_USAGE_SQLITE || '/usr/bin/sqlite3';
const DB = process.env.ZCODE_USAGE_DB || join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const CONFIG = join(homedir(), '.zcode', 'v2', 'config.json');
const RULES = join(homedir(), '.zcode', 'v2', 'provider_config.json');
const CACHE_MS = 3000;

// d/od/dn 是「生成速率」的三个原料：只有 status='completed' 且 duration_ms>0 的请求
// 才计入，dn 是这类请求的条数 —— 前端用它在样本太少时把速率显示成「—」。
const AGG = `
  SUM(input_tokens) AS i,
  SUM(output_tokens) AS o,
  SUM(cache_read_input_tokens) AS cr,
  SUM(cache_creation_input_tokens) AS cc,
  SUM(reasoning_tokens) AS r,
  COUNT(*) AS n,
  SUM(CASE WHEN status='completed' AND duration_ms>0 THEN duration_ms ELSE 0 END) AS d,
  SUM(CASE WHEN status='completed' AND duration_ms>0 THEN output_tokens ELSE 0 END) AS od,
  SUM(CASE WHEN status='completed' AND duration_ms>0 THEN 1 ELSE 0 END) AS dn,
  MAX(started_at) AS lu`;

// 引擎解析：显式 ZCODE_USAGE_SQLITE > 可用的 sqlite3 CLI > Node 内置 node:sqlite。
// 与 usage-data.mjs 同策略：mac 走 CLI 行为不变，Windows 自动回退。
let engine = null;
function resolveEngine() {
  if (engine) return engine;
  const explicit = process.env.ZCODE_USAGE_SQLITE;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`ZCODE_USAGE_SQLITE 指向的 sqlite3 不存在: ${explicit}`);
    }
    engine = { kind: 'cli', bin: explicit };
  } else if (existsSync(SQLITE)) {
    engine = { kind: 'cli', bin: SQLITE };
  } else {
    engine = { kind: 'node' };
  }
  return engine;
}

const require = createRequire(import.meta.url);
let DatabaseSync = null;
function loadNodeSqlite() {
  if (DatabaseSync) return DatabaseSync;
  const origEmit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (msg && String(msg).includes('SQLite is an experimental feature')) return;
    return origEmit.call(process, warning, ...rest);
  };
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } finally {
    process.emitWarning = origEmit;
  }
  return DatabaseSync;
}

// 只读查询：按引擎分派，统一返回 Promise<普通对象数组>。不写文件、不建库。
function sqlite(sql) {
  const eng = resolveEngine();
  if (eng.kind === 'cli') {
    return new Promise((resolve, reject) => {
      execFile(
        eng.bin,
        ['-readonly', '-json', '-cmd', '.timeout 5000', DB, sql],
        { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error((stderr || err.message || '').toString().trim() || 'sqlite3 执行失败'));
          const text = (stdout || '').trim();
          if (!text) return resolve([]);
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('sqlite3 输出不是合法 JSON'));
          }
        },
      );
    });
  }
  // kind === 'node'：node:sqlite 同步打开，包成 Promise 以保持调用方结构不变。
  return new Promise((resolve, reject) => {
    let db;
    try {
      const DS = loadNodeSqlite();
      db = new DS(DB, { readOnly: true });
      db.exec('PRAGMA busy_timeout = 5000');
      resolve(db.prepare(sql).all());
    } catch (e) {
      reject(new Error((e && e.message) || String(e)));
    } finally {
      if (db) db.close();
    }
  });
}

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

// provider id → 展示名：provider_config.json 的 providerRules 打底，config.json 覆盖；同名模型靠 provider 区分
async function providerNames() {
  const out = {};
  const rules = (await readJson(RULES))?.config?.providerConfigRules?.providerRules || [];
  for (const r of rules) if (r?.providerId && r.providerName) out[r.providerId] = r.providerName;
  const providers = (await readJson(CONFIG))?.provider || {};
  for (const [id, p] of Object.entries(providers)) if (p?.name) out[id] = p.name;
  return out;
}

async function collect() {
  const [hourly, daily, models, providers] = await Promise.all([
    sqlite(`
      SELECT strftime('%Y-%m-%dT%H', started_at/1000, 'unixepoch', 'localtime') AS b,
             provider_id AS p, model_id AS m, ${AGG}
      FROM model_usage
      WHERE started_at >= (strftime('%s','now') - 40*86400) * 1000
      GROUP BY b, p, m ORDER BY b`),
    sqlite(`
      SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime') AS b,
             provider_id AS p, model_id AS m, ${AGG}
      FROM model_usage GROUP BY b, p, m ORDER BY b`),
    sqlite(`
      SELECT provider_id AS p, model_id AS m, COUNT(*) AS n, MAX(started_at) AS lu
      FROM model_usage GROUP BY p, m ORDER BY n DESC`),
    providerNames(),
  ]);
  const recent = await sqlite(`
      SELECT provider_id AS p, model_id AS m,
             SUM(duration_ms) AS d, SUM(output_tokens) AS od, COUNT(*) AS dn
      FROM model_usage
      WHERE status='completed' AND duration_ms>0
        AND completed_at >= (strftime('%s','now') - 300) * 1000
      GROUP BY p, m`);
  return {
    meta: { generatedAt: Date.now(), dbPath: DB, version: VERSION, models, providers },
    hourly,
    daily,
    recent,
  };
}

let cache = null;
let cacheAt = 0;

export function install() {
  ipcMain.handle(CHANNEL, async () => {
    const now = Date.now();
    if (cache && now - cacheAt < CACHE_MS) return { ok: true, data: cache, cached: true };
    try {
      const data = await collect();
      cache = data;
      cacheAt = now;
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}
