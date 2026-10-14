#!/usr/bin/env node
// 按需查询本地用量库，生成自包含 HTML 报告（无常驻服务）。
// 用法: node report.mjs [--no-open] [--out <path>]
// 环境变量: ZCODE_USAGE_DB（默认 ~/.zcode/cli/db/db.sqlite）、ZCODE_USAGE_OUT（默认 ~/.zcode/token-usage-report.html）
// 数据/口径全部来自 usage-data.mjs（与 MCP server 共用同一份 SQL）。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { readUsage, UsageDataError, promptOf, addedOf, totalOf } from './usage-data.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.ZCODE_USAGE_OUT || join(homedir(), '.zcode', 'token-usage-report.html');
const noOpen = process.argv.includes('--no-open');
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : OUT;

function fail(msg) {
  console.error(`[token-usage] ${msg}`);
  process.exit(1);
}

let data;
try {
  data = readUsage();
} catch (e) {
  fail(e instanceof UsageDataError ? e.message : `读取用量数据失败: ${e.message}`);
}
const { meta, hourly, daily } = data;

const read = (p) => readFileSync(join(here, 'web', p), 'utf8');
const json = JSON.stringify(data).replace(/</g, '\\u003c');

let html;
try {
  html = read('template.html')
    .replace('<!--__STYLE__-->', () => `<style>\n${read('style.css')}\n</style>`)
    .replace('<!--__DATA__-->', () => `<script>window.__DATA__ = ${json};</script>`)
    .replace('<!--__APP__-->', () => `<script>\n${read('app.js')}\n</script>`);
} catch (e) {
  fail(`读取模板失败: ${e.message}`);
}
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, html);

// ---- stdout 摘要（供 agent 转述）----
const sum = (rows) =>
  rows.reduce(
    (a, r) => ({
      i: a.i + r.i, o: a.o + r.o, cr: a.cr + r.cr, cc: a.cc + r.cc,
      r: a.r + r.r, n: a.n + r.n, lu: Math.max(a.lu, r.lu || 0),
    }),
    { i: 0, o: 0, cr: 0, cc: 0, r: 0, n: 0, lu: 0 },
  );
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const pct = (s) => {
  const p = promptOf(s);
  return p > 0 ? ((s.cr / p) * 100).toFixed(1) + '%' : '—';
};
const line = (label, s) =>
  `${label}: 处理 ${fmt(totalOf(s))}（输入 ${fmt(promptOf(s))} 含缓存命中 ${fmt(s.cr)} / 输出 ${fmt(s.o)}），` +
  `真正新增 ${fmt(addedOf(s))}，请求 ${fmt(s.n)} 次，缓存命中率 ${pct(s)}`;

const all = sum(daily);
const dayAgo = Date.now() - 24 * 3600 * 1000;
// 与页面「近24小时」同口径：小时桶起点落在窗口内才计入（±1h 粒度误差）
const last24 = sum(hourly.filter((r) => new Date(r.b + ':00:00').getTime() >= dayAgo));

// 用量前三的「供应商 · 模型」（按 provider_id 区分同名模型）
const provName = meta.providers;
const combos = new Map();
for (const r of daily) {
  const key = `${r.p}|${r.m}`;
  combos.set(key, (combos.get(key) || 0) + promptOf(r) + r.o);
}
const top3 = [...combos.entries()]
  .sort((a, b) => b[1] - a[1])
  .slice(0, 3)
  .map(([k, v]) => {
    const [p, m] = k.split('|');
    return `${provName[p] || p.slice(0, 8)}·${m}(${fmt(v)})`;
  });

if (all.n === 0) {
  console.log(`报告已生成: ${outPath}（数据库中没有用量记录）`);
} else {
  console.log(`报告已生成: ${outPath}`);
  console.log(line(`全部历史（自 ${daily[0]?.b || '?'}，最近使用 ${new Date(all.lu).toLocaleString('zh-CN')}）`, all));
  console.log(line('近24小时', last24));
  console.log(`用量前三（供应商·模型）: ${top3.join('，')}`);
}

if (!noOpen) {
  try {
    const opener =
      process.platform === 'darwin' ? ['open', [outPath]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', outPath]]
      : ['xdg-open', [outPath]];
    execFileSync(opener[0], opener[1]);
  } catch {
    console.log(`（自动打开失败，请手动打开 ${outPath}）`);
  }
}
