// ZCode token 用量：纯数据模块。只读本地 model_usage 表，返回 {meta,hourly,daily,recent}。
// 只读：不写文件、不 mkdir、不开浏览器；库不存在时抛 UsageDataError，绝不建空库。
// 环境变量 ZCODE_USAGE_DB 可覆盖数据库路径（测试 fixture 用）。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.3.0';

export const DEFAULT_DB = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
export const CONFIG_PATH = join(homedir(), '.zcode', 'v2', 'config.json');
export const PROVIDER_RULES_PATH = join(homedir(), '.zcode', 'v2', 'provider_config.json');
// sqlite3 CLI 的默认候选路径（macOS 自带）；Windows 无此文件，会回退到 node:sqlite。
export const SQLITE = process.env.ZCODE_USAGE_SQLITE || '/usr/bin/sqlite3';

export class UsageDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageDataError';
  }
}

// 解析数据库路径：显式参数 > 环境变量 > 默认位置。
export function resolveDbPath(explicit) {
  return explicit || process.env.ZCODE_USAGE_DB || DEFAULT_DB;
}

// d/od/dn 是「生成速率」的原料：只统计 status='completed' 且 duration_ms>0 的请求，
// dn 是这类请求条数——前端在样本太少时把速率显示成「—」。
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

// 小时桶：近 40 天（供 今天/昨天/近24小时/近N天/本周/本月 精确计算）
const HOURLY_SQL = `
  SELECT strftime('%Y-%m-%dT%H', started_at/1000, 'unixepoch', 'localtime') AS b,
         provider_id AS p, model_id AS m, ${AGG}
  FROM model_usage
  WHERE started_at >= (strftime('%s','now') - 40*86400) * 1000
  GROUP BY b, p, m ORDER BY b`;

// 日桶：全部历史（供 自定义日期区间 与 近7日趋势图）
const DAILY_SQL = `
  SELECT strftime('%Y-%m-%d', started_at/1000, 'unixepoch', 'localtime') AS b,
         provider_id AS p, model_id AS m, ${AGG}
  FROM model_usage GROUP BY b, p, m ORDER BY b`;

// 最近 5 分钟速率：按完成时间落在窗口内的已完成请求聚合（d/od/dn 口径同 AGG），
// 窗口相对查询时刻计算，不随所选时间范围变化。
const RECENT_SQL = `
  SELECT provider_id AS p, model_id AS m,
         SUM(duration_ms) AS d,
         SUM(output_tokens) AS od,
         COUNT(*) AS dn
  FROM model_usage
  WHERE status='completed' AND duration_ms>0
    AND completed_at >= (strftime('%s','now') - 300) * 1000
  GROUP BY p, m`;

const MODELS_SQL = `
  SELECT provider_id AS p, model_id AS m, COUNT(*) AS n, MAX(started_at) AS lu
  FROM model_usage GROUP BY p, m ORDER BY n DESC`;

// 查询引擎解析：显式 ZCODE_USAGE_SQLITE > 可用的 sqlite3 CLI > Node 内置 node:sqlite。
// macOS/Linux 有 /usr/bin/sqlite3 时行为与旧版一致（走 CLI）；Windows 无 CLI 时自动回退。
let engine = null;
function resolveEngine() {
  if (engine) return engine;
  const explicit = process.env.ZCODE_USAGE_SQLITE;
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new UsageDataError(`ZCODE_USAGE_SQLITE 指向的 sqlite3 不存在: ${explicit}`);
    }
    engine = { kind: 'cli', bin: explicit };
  } else if (existsSync(SQLITE)) {
    engine = { kind: 'cli', bin: SQLITE };
  } else {
    engine = { kind: 'node' };
  }
  return engine;
}

// 懒加载 node:sqlite。Node 22.5+ 才有；首次 require 会发一条 ExperimentalWarning，
// 窄过滤掉它以免污染 stdio MCP 的 stderr，其余 warning 照常。
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

// 只读查询：按引擎分派。两种引擎都不写文件、不建库，结果都是普通对象数组。
function query(dbPath, sql) {
  const eng = resolveEngine();
  if (eng.kind === 'cli') {
    let out;
    try {
      out = execFileSync(eng.bin, ['-readonly', '-json', '-cmd', '.timeout 5000', dbPath, sql], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
    } catch (e) {
      const err = (e.stderr || e.message || '').toString().trim();
      throw new UsageDataError(`查询失败: ${err}`);
    }
    const t = out.trim();
    if (!t) return [];
    try {
      return JSON.parse(t);
    } catch {
      throw new UsageDataError('sqlite3 输出解析失败（非 JSON）');
    }
  }
  // kind === 'node'：node:sqlite 只读打开，空结果返回 []，与 CLI 一致。
  let db;
  try {
    const DS = loadNodeSqlite();
    db = new DS(dbPath, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000');
    return db.prepare(sql).all();
  } catch (e) {
    throw new UsageDataError(`查询失败: ${(e && e.message) || e}`);
  } finally {
    if (db) db.close();
  }
}

const readJson = (path) => {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  } catch {
    return null;
  }
};

// 供应商 id → 展示名。config.json 里没有的供应商（如新加的中转站）从 provider_config.json 的
// providerRules 补全；两处都有时以 config.json 为准。只导出 provider 名称，忽略其余字段。
export function providerNames(configPath = CONFIG_PATH, rulesPath = PROVIDER_RULES_PATH) {
  const out = {};
  const rules = readJson(rulesPath)?.config?.providerConfigRules?.providerRules || [];
  for (const r of rules) if (r?.providerId && r.providerName) out[r.providerId] = r.providerName;
  const providers = readJson(configPath)?.provider || {};
  for (const [id, p] of Object.entries(providers)) if (p?.name) out[id] = p.name;
  return out;
}

// 读取用量数据。dbPath 缺省时按 resolveDbPath 解析；库不存在抛 UsageDataError，不写入。
export function readUsage({ dbPath, configPath = CONFIG_PATH } = {}) {
  const db = resolveDbPath(dbPath);
  if (!existsSync(db)) {
    throw new UsageDataError(`找不到 ZCode 用量数据库: ${db}`);
  }
  resolveEngine();
  const hourly = query(db, HOURLY_SQL);
  const daily = query(db, DAILY_SQL);
  const recent = query(db, RECENT_SQL);
  const models = query(db, MODELS_SQL);
  const meta = {
    generatedAt: Date.now(),
    dbPath: db,
    version: VERSION,
    models,
    providers: providerNames(configPath),
  };
  return { meta, hourly, daily, recent };
}

// ---- 与前端一致的 token 口径（供 stdout 摘要用；前端另有一份等价实现）----
// 「输入」列是否已含缓存命中：Anthropic 式 input_tokens 不含缓存（报过缓存写入，
// 或命中量超过输入量），DeepSeek/OpenAI 式 prompt_tokens 已含缓存。
const inputExcludesCache = (s) => s.cc > 0 || s.cr > s.i;
export const promptOf = (s) => (inputExcludesCache(s) ? s.i + s.cr + s.cc : s.i);
export const addedOf = (s) => promptOf(s) - s.cr + s.o;
export const totalOf = (s) => promptOf(s) + s.o;
export const hitRateOf = (s) => {
  const p = promptOf(s);
  return p > 0 ? s.cr / p : null;
};
