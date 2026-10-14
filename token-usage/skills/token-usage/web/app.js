(() => {
'use strict';
// 同一份脚本既跑独立报告页（classic，window.__DATA__ 内联）也跑 MCP Apps 侧栏
// （window.__ZCODE_SIDEBAR__=true，数据由 App 桥 tools/call 拉取）。
// D / GEN 等派生量可被刷新整体替换，所以是 let；事件监听/picker/tabs 只绑定一次，
// 数据更新仅重赋值 + render，保证 range / 展开状态 / 当前 tab 在刷新后保留。
const SIDEBAR = !!window.__ZCODE_SIDEBAR__;
const PANEL = !!window.__ZCODE_DASH_ROOT__;
const ROOT = window.__ZCODE_DASH_ROOT__ || document;

// 空数据集：侧栏首次渲染、刷新失败重试期间都要能安全渲染，不能访问空对象。
const EMPTY = { meta: { generatedAt: 0, providers: {}, models: [], dbPath: '', version: '' }, hourly: [], daily: [], recent: [] };

let D = window.__DATA__ || EMPTY;
let GEN = D.meta?.generatedAt || 0;
let PROVIDERS = D.meta?.providers || {};
let daily = (D.daily || []).map((r) => ({ ...r, t: new Date(r.b + 'T00:00:00').getTime() }));
let recentByModel = new Map();

// 同名模型可能来自不同供应商，聚合主键用 provider|model
const modelKey = (r) => `${r.p}|${r.m}`;
// 最近 5 分钟速率的原料（与查询时刻绑定，不随所选范围变化），按 provider|model 索引
const indexRecent = (data) => new Map((data.recent || []).map((r) => [modelKey(r), r]));
recentByModel = indexRecent(D);
const providerName = (p) => PROVIDERS[p] || String(p).slice(0, 8);
// 模型名单独显示（省空间），供应商只在 title 提示里出现
const modelTip = (p, m) => `${providerName(p)} · ${m}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 工具 ----------
// 同一份脚本既用于独立报告页，也用于客户端里的 hover 面板；面板通过
// __ZCODE_DASH_ROOT__ 把选择器限制在自己那棵子树里，避免误命中宿主页面。
const $ = (s) => ROOT.querySelector(s);
const $$ = (s) => ROOT.querySelectorAll(s);
const pad = (n) => String(n).padStart(2, '0');
const fmtInt = (v) => Math.round(v || 0).toLocaleString('en-US');
const fmtPct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const fmtRate = (v) => (v == null ? '—' : v.toFixed(1) + ' t/s');
const weekday = (d) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtShort(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// 紧凑计量单位（全局统一：列表、副标题、图表刻度都用它，完整数字走 title 提示）
function fmtMB(v) {
  const n = v || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(Math.round(n));
}
const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const toDateKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// ---------- 时间范围 ----------
// 注意：range 全部基于 GEN。GEN=0（空数据）时所有范围都退化成 0~0，
// 但空数据集本身没有桶，渲染只会显示 0 / 「—」，不会崩。
const PRESETS = [
  { id: 'today', label: '今天', range: () => ({ from: startOfDay(GEN), to: GEN }) },
  { id: 'yesterday', label: '昨天', range: () => ({ from: startOfDay(GEN) - 86400e3, to: startOfDay(GEN) - 1 }) },
  { id: '24h', label: '近24小时', range: () => ({ from: GEN - 86400e3, to: GEN }) },
  { id: '7d', label: '近7天', range: () => ({ from: GEN - 7 * 86400e3, to: GEN }) },
  { id: '14d', label: '近14天', range: () => ({ from: GEN - 14 * 86400e3, to: GEN }) },
  { id: '30d', label: '近30天', range: () => ({ from: GEN - 30 * 86400e3, to: GEN }) },
  { id: 'week', label: '本周', range: () => {
      const d = new Date(GEN); d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // 周一起
      return { from: d.getTime(), to: GEN };
    } },
  { id: 'month', label: '本月', range: () => {
      const d = new Date(GEN); d.setHours(0, 0, 0, 0); d.setDate(1);
      return { from: d.getTime(), to: GEN };
    } },
];
// state: {type:'preset', id} | {type:'custom', from, to, label}
// 侧栏是随手瞥一眼的入口，默认「今天」；独立报告页默认「近7天」。
// 侧栏每次刷新只重赋值 + render，不重建 DOM，所以这里的 state 会跨刷新保留。
let state = { type: 'preset', id: SIDEBAR || PANEL ? 'today' : '7d' };
// 用量明细里展开的磁贴：行号 -> 指标 key。每行同时只展开一项，
// 展开的磁贴高亮，所以按模型明细跟随哪一项是一眼能看出来的。
const openByRow = new Map();

function currentRange() {
  if (state.type === 'custom') return { from: state.from, to: state.to };
  const p = PRESETS.find((x) => x.id === state.id) || PRESETS[0];
  return p.range();
}
function rangeLabel() {
  if (state.type === 'custom') return state.label;
  const p = PRESETS.find((x) => x.id === state.id) || PRESETS[0];
  return p.label;
}

// ---------- 聚合 ----------
function blank() { return { i: 0, o: 0, cr: 0, cc: 0, r: 0, n: 0, d: 0, od: 0, dn: 0, lu: 0 }; }
function addInto(a, r) {
  a.i += r.i; a.o += r.o; a.cr += r.cr; a.cc += r.cc; a.r += r.r;
  a.n += r.n; a.d += r.d; a.od += r.od; a.dn += r.dn || 0;
  if (r.lu > a.lu) a.lu = r.lu;
}
function aggregate(from, to) {
  // 统一用日桶 + 日期键比较：from~to 精确到日（起日全天 ~ 止日全天），
  // 滚动窗口（近24小时/近7天等）的起止日只含部分数据，与真实滚动窗口差一个「起日全天」，
  // 但小时桶只有 40 天，且日粒度是本报告的展示口径 —— 换取所有范围单一实现、无边界遗漏。
  // 例外：今天/昨天/本周/本月/自定义 的边界天然是日对齐的，结果完全精确。
  const src = daily;
  const fromKey = toDateKey(from), toKey = toDateKey(to);
  const T = blank();
  const M = new Map();
  for (const r of src) {
    if (r.b < fromKey || r.b > toKey) continue;
    addInto(T, r);
    const key = modelKey(r);
    let m = M.get(key);
    if (!m) { m = blank(); m.p = r.p; m.m = r.m; M.set(key, m); }
    addInto(m, r);
  }
  return { T, M };
}
// 「输入」列是否已含缓存命中，取决于供应商返回的字段：ZCode 归一化时按
// input_tokens → prompt_tokens → promptTokens → inputTokens 取第一个存在的，
// 前三者（Anthropic 式 input_tokens 除外）中 input_tokens/prompt_tokens 都指完整提示词，
// 而 DeepSeek/OpenAI 式接口只给 prompt_tokens（含缓存），没有独立的 input_tokens。
// 两种语义混在一列里，用「报过缓存写入」或「命中量超过输入量」来识别 Anthropic 式：
// 后者不可能出现在「input 含缓存」的数据里，前者是 Anthropic 特有的写入侧字段。
const inputExcludesCache = (s) => s.cc > 0 || s.cr > s.i;
// 完整提示词长度（含命中的缓存部分），两种语义下都成立
const promptOf = (s) => (inputExcludesCache(s) ? s.i + s.cr + s.cc : s.i);
// 缓存命中率：命中量 ÷ 完整提示词。ZCode 客户端自身定义即 cacheReadTokens / inputTokens。
const hitRate = (s) => { const p = promptOf(s); return p > 0 ? s.cr / p : null; };
// 生成速率 = 输出 token ÷ 生成耗时。样本（有耗时的已完成请求）太少时平均值会被单次
// 波动主导，返回 null 让调用方显示「—」，而不是给出一个看着精确其实没意义的数字。
const RATE_MIN_SAMPLES = 10;
const genRate = (s) => (s.d > 0 && (s.dn || 0) >= RATE_MIN_SAMPLES ? s.od / (s.d / 1000) : null);
// 速率的悬停明细：给出精确值、原始分子分母和样本数；样本不足时说明为什么不显示数值
function rateTip(s) {
  if (!(s.d > 0)) return '该范围内没有带耗时的已完成请求';
  const body = `输出 ${fmtInt(s.od)} tokens ÷ 耗时 ${fmtInt(s.d)} ms，样本 ${fmtInt(s.dn)} 次已完成请求`;
  return (s.dn || 0) >= RATE_MIN_SAMPLES
    ? `${(s.od / (s.d / 1000)).toFixed(2)} t/s —— ${body}`
    : `样本只有 ${fmtInt(s.dn)} 次，少于 ${RATE_MIN_SAMPLES} 次不展示速率 —— ${body}`;
}
// 最近 5 分钟速率：窗口本身已经很短，有样本就显示，样本数写在悬停里供判断
const recentRate = (s) => (s && s.d > 0 && s.dn > 0 ? s.od / (s.d / 1000) : null);
// 处理总量 = 完整提示词 + 输出；缓存命中是提示词的子集，不能与输入相加
const totalOf = (s) => promptOf(s) + s.o;
// 真正新增的 token（未被缓存覆盖的输入 + 输出）
const addedOf = (s) => promptOf(s) - s.cr + s.o;

// ---------- 统计列表 ----------
// fmt 用于主值，modelFmt 用于展开后的模型子行；token 量走紧凑单位，完整数字放 title
const ROWS = [
  // 「输入」就是完整提示词，其中命中缓存的量下一行「缓存输入」已有 —— 不在这里重复小字
  { key: 'input',  label: '输入 Token',   get: promptOf, fmt: fmtMB, modelFmt: fmtMB, full: fmtInt, share: promptOf },
  { key: 'output', label: '输出 Token',   get: (s) => s.o,  fmt: fmtMB, modelFmt: fmtMB, full: fmtInt, share: (s) => s.o },
  { key: 'cache',  label: '缓存输入',     get: (s) => s.cr, fmt: fmtMB, modelFmt: fmtMB, full: fmtInt, share: (s) => s.cr,
    sub: (s) => (s.cc > 0 ? `写入 ${fmtMB(s.cc)}` : '') },
  { key: 'hit',    label: '缓存命中率',   get: hitRate, fmt: fmtPct, modelFmt: fmtPct, full: (v) => (v == null ? '—' : (v * 100).toFixed(2) + '%'), share: promptOf },
  { key: 'reason', label: '推理 Token',   get: (s) => s.r,  fmt: fmtMB, modelFmt: fmtMB, full: fmtInt, share: (s) => s.r },
  { key: 'rate',   label: '生成速率',     get: genRate, fmt: fmtRate, modelFmt: fmtRate, full: (v) => (v == null ? '—' : v.toFixed(2) + ' t/s'), tip: rateTip, share: (s) => s.od, digits: 1 },
  { key: 'req',    label: '请求次数',     get: (s) => s.n,  fmt: fmtInt, modelFmt: fmtInt, full: fmtInt, share: (s) => s.n },
  { key: 'last',   label: '最近使用时间', get: (s) => s.lu, fmt: fmtTime, full: fmtTime },
];

// 用量明细的排列：三行磁贴（3/2/2）+ 一整行左右结构的最近使用时间
const STAT_LAYOUT = [
  { tiles: ['input', 'output', 'reason'] },
  { tiles: ['cache', 'hit'] },
  { tiles: ['rate', 'req'] },
  { line: 'last' },
];

// 生成速率的模型明细：两列 —— 最近 5 分钟速度，以及所选范围内的总速度（末尾标「(总)」）；
// 悬浮提示统一为「供应商 · 模型」，与模型卡片的名称提示一致
function rateModelRow(m, total) {
  const recent = recentByModel.get(modelKey(m));
  const tip = esc(modelTip(m.p, m.m));
  const el = document.createElement('div');
  el.className = 'model-row rate-row';
  el.innerHTML =
    `<span class="model-name" title="${tip}">${esc(m.m)}</span>` +
    `<span class="rate-recent" title="${tip}">${fmtRate(recentRate(recent))}</span>` +
    `<span class="rate-total" title="${tip}">${total == null ? '—' : `${fmtRate(total)}<i class="rate-tag">(总)</i>`}</span>`;
  return el;
}

// 某个指标按模型展开的明细：模型名 + 该指标的数值 + 占该指标合计的比例
function modelBreakdown(row, M) {
  const totalShare = [...M.values()].reduce((a, m) => a + (row.share(m) || 0), 0);
  const models = [...M.entries()].filter(([, m]) => totalOf(m) > 0)
    .sort((a, b) => (row.get(b[1]) ?? -1) - (row.get(a[1]) ?? -1));
  const box = document.createElement('div');
  box.className = 'stat-sub';
  if (!models.length) {
    box.innerHTML = '<div class="empty-hint">该时间范围内没有数据</div>';
    return box;
  }
  for (const [, m] of models) {
    const share = totalShare > 0 ? (row.share(m) || 0) / totalShare : 0;
    const mVal = row.get(m);
    if (row.key === 'rate') {
      box.appendChild(rateModelRow(m, mVal));
      continue;
    }
    const mFmt = (row.modelFmt || row.fmt)(mVal);
    const mFull = row.tip ? row.tip(m) : (row.full ? row.full(mVal) : mFmt);
    const el = document.createElement('div');
    el.className = 'model-row';
    el.innerHTML =
      `<span class="model-name" title="${esc(modelTip(m.p, m.m))}">${esc(m.m)}</span>` +
      `<span class="model-val" title="${esc(mFull)}">${mFmt}</span>` +
      `<span class="model-pct">${(share * 100).toFixed(1)}%</span>`;
    box.appendChild(el);
  }
  return box;
}

function renderStats() {
  const { from, to } = currentRange();
  const { T, M } = aggregate(from, to);
  const host = $('#statList');
  const byKey = new Map(ROWS.map((r) => [r.key, r]));
  host.innerHTML = '';

  STAT_LAYOUT.forEach((slot, rowIdx) => {
    if (slot.line) {
      const row = byKey.get(slot.line);
      const val = row.get(T);
      const fmt = row.fmt(val);
      const el = document.createElement('div');
      el.className = 'stat-line';
      el.title = row.full ? row.full(val) : fmt;
      el.innerHTML =
        `<span class="stat-line-name">${row.label}</span>` +
        `<span class="stat-line-val">${fmt}</span>`;
      host.appendChild(el);
      return;
    }

    const tiles = document.createElement('div');
    tiles.className = 'stat-tiles';
    for (const key of slot.tiles) {
      const row = byKey.get(key);
      const val = row.get(T);
      const fmt = row.fmt(val);
      const sub = row.sub ? row.sub(T) : '';
      const tipText = row.tip ? row.tip(T) : (row.full ? row.full(val) : fmt);
      const open = openByRow.get(rowIdx) === key;

      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tile' + (open ? ' open' : '');
      el.setAttribute('aria-expanded', String(open));
      el.title = `${tipText}（点击展开各模型）`;
      el.innerHTML =
        `<span class="tile-value">${fmt}</span>` +
        `<span class="tile-label">${row.label}${sub ? ` · ${sub}` : ''} <i class="tile-caret">▾</i></span>`;
      el.addEventListener('click', () => {
        if (openByRow.get(rowIdx) === key) openByRow.delete(rowIdx);
        else openByRow.set(rowIdx, key);
        renderStats();
      });
      tiles.appendChild(el);
    }
    host.appendChild(tiles);

    const openKey = openByRow.get(rowIdx);
    if (openKey) host.appendChild(modelBreakdown(byKey.get(openKey), M));
  });
}

// ---------- 累计卡片 ----------
function renderCum() {
  const { from, to } = currentRange();
  const { T } = aggregate(from, to);
  $('#cumValue').textContent = fmtInt(totalOf(T));
  // 无数据时不显示 1970 的假日期范围
  $('#cumRange').textContent = GEN ? `${rangeLabel()} · ${fmtShort(from)} ~ ${fmtShort(to)}` : rangeLabel();
  $('#cumSub').textContent = GEN
    ? `缓存命中 ${fmtMB(T.cr)} · 真正新增 ${fmtMB(addedOf(T))} · 请求 ${fmtInt(T.n)} 次`
    : '等待数据…';
  const meta = $('#statMeta');
  meta.innerHTML = `合计 <b>${fmtMB(totalOf(T))}</b>`;
  meta.title = `${fmtInt(totalOf(T))} tokens`;
}

// ---------- 模型卡片 ----------
// 「缓存命中」列展示该模型的命中率（缓存读取 ÷ 完整提示词），原始数字放 title 里。
const hitText = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const hitTip = (cr, prompt) =>
  prompt > 0
    ? `缓存读取 ${fmtInt(cr)} / 完整提示词 ${fmtInt(prompt)} = ${((cr / prompt) * 100).toFixed(1)}%`
    : '该模型没有输入记录';
function renderModels() {
  const { from, to } = currentRange();
  const { T, M } = aggregate(from, to);
  const host = $('#modelList');
  const meta = $('#modelGrid');
  const rows = [...M.values()]
    .map((s) => ({ s, p: s.p, m: s.m, total: totalOf(s), hit: hitRate(s), rate: genRate(s), cr: s.cr, prompt: promptOf(s) }))
    .filter((x) => x.total > 0)
    .sort((a, b) => b.total - a.total);
  const sum = rows.reduce((a, x) => a + x.total, 0) || 1;
  // 卡片标题右侧标出本区间合计，滚过累计卡片后仍能对照
  const total = T.n ? totalOf(T) : 0;
  meta.innerHTML = `<b>${fmtMB(total)}</b>`;
  meta.title = `${fmtInt(total)} tokens（完整提示词 + 输出）`;
  $('#modelCount').textContent = rows.length ? `${rows.length} 个模型` : '';
  if (!rows.length) {
    host.innerHTML = '<div class="empty-hint">该时间范围内没有数据</div>';
    return;
  }
  host.innerHTML = rows
    .map((x) => {
      const pct = (x.total / sum) * 100;
      const share = `占本区间 ${pct.toFixed(pct < 1 ? 1 : 0)}%`;
      return (
        `<div class="ml-row">` +
        `<span class="ml-name" title="${esc(modelTip(x.p, x.m))}">${esc(x.m)}</span>` +
        `<span class="ml-speed" title="${esc(rateTip(x.s))}">${fmtRate(x.rate)}</span>` +
        `<span class="ml-hit" title="${esc(hitTip(x.cr, x.prompt))}">${hitText(x.hit)}</span>` +
        // 占比不再单独占一列，挪进用量的悬停提示里
        `<span class="ml-val" title="${esc(`${fmtInt(x.total)} tokens，${share}`)}">${fmtMB(x.total)}</span>` +
        `</div>`
      );
    })
    .join('');
}

// ---------- 趋势图 ----------
// 图表窗口跟着所选范围走，最少 7 天：
//   今天/昨天/近24小时/近7天/本周 → 固定「近7日」，结束于今天（短区间给足上下文）
//   近14天/近30天 → 对应天数；本月 → 本月 1 号到今天
//   自定义 → 天数 = max(7, 所选跨度)，结束于所选止日（这样任何时候都不会把选中的日子排除在图外）
function chartWindow() {
  const today0 = startOfDay(GEN);
  const id = state.type === 'preset' ? state.id : null;
  if (id === '14d' || id === '30d') {
    const n = id === '14d' ? 14 : 30;
    return { ts: lastDays(today0, n), title: `近${n}天趋势` };
  }
  if (id === 'month') {
    // 本月 1 号到今天：今天几号就是几个点
    return { ts: lastDays(today0, new Date(GEN).getDate()), title: '本月趋势' };
  }
  if (state.type === 'custom') {
    const a = startOfDay(state.from), b = startOfDay(state.to);
    const span = Math.round((b - a) / 86400e3) + 1;
    const n = Math.max(7, span);
    return { ts: lastDays(b, n), title: n === 7 ? '近7日趋势' : `${n} 日趋势` };
  }
  return { ts: lastDays(today0, 7), title: '近7日趋势' };
}

// 以某天结尾、往回数 n 天的连续日期
function lastDays(end0, n) {
  const ts = [];
  for (let k = n - 1; k >= 0; k--) {
    const d = new Date(end0);
    d.setDate(d.getDate() - k);
    ts.push(d.getTime());
  }
  return ts;
}

function chartDays() {
  const win = chartWindow();
  const out = win.ts.map((t) => ({ t, key: toDateKey(t), total: 0, models: new Map() }));
  const idx = new Map(out.map((d, i) => [d.key, i]));
  for (const r of daily) {
    const i = idx.get(r.b);
    if (i == null) continue;
    const tot = totalOf(r);
    out[i].total += tot;
    const key = modelKey(r);
    const cur = out[i].models.get(key);
    if (cur) cur.total += tot;
    else out[i].models.set(key, { p: r.p, m: r.m, total: tot });
  }
  return { days: out, title: win.title };
}

// 图表实际宽度：按 chartWrap 实测宽度出图，窄侧栏里文字/刻度按真实像素排布。
function chartSize() {
  const wrap = $('#chartWrap');
  const measured = wrap ? Math.round(wrap.clientWidth) : 0;
  const W = measured || window.__ZCODE_CHART_W__ || 920;
  const H = window.__ZCODE_CHART_H__ || (SIDEBAR || PANEL ? 170 : 250);
  return { W: Math.max(220, W), H };
}

function renderChart() {
  // 无数据（GEN=0，侧栏初始）时不出图：否则会画出一条基于 1970 的错误日期轴。
  if (!GEN) {
    $('#chartTitle').textContent = '趋势';
    const meta0 = $('#chartMeta');
    meta0.innerHTML = '';
    meta0.removeAttribute('title');
    $('#chartWrap').innerHTML = '<div class="empty-hint">等待数据…</div>';
    return;
  }
  const { days, title } = chartDays();
  const { W, H } = chartSize();
  const compact = H < 200;
  // padR 至少半个日期标签宽（MM-DD ≈ 33），尾标签才不会探出被裁。
  const padL = compact ? 40 : 58, padR = 20, padT = compact ? 10 : 16, padB = compact ? 22 : 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const yMax = Math.max(...days.map((d) => d.total), 1);
  const x = (i) => padL + (days.length === 1 ? plotW / 2 : (i * plotW) / (days.length - 1));
  const y = (v) => padT + plotH - (v / yMax) * plotH;

  // 卡片标题与右侧合计都跟着窗口长度走
  $('#chartTitle').textContent = title;
  const winTotal = days.reduce((a, d) => a + d.total, 0);
  const cmeta = $('#chartMeta');
  cmeta.innerHTML = `${days.length} 日合计 <b>${fmtMB(winTotal)}</b>`;
  cmeta.title = `${fmtInt(winTotal)} tokens`;

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${days.length} 日 token 趋势折线图">`;
  svg += `<defs><linearGradient id="areaG" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.28"/>
    <stop offset="100%" stop-color="var(--accent)" stop-opacity="0.02"/></linearGradient></defs>`;
  // 网格 + y 轴刻度（紧凑高度下减少刻度，避免线挤在一起）。
  // 不写 0 那格的数字：它和 x 轴标签同一行，占着左边的空档，首标签就没法居中往外展开了。
  const ticks = compact ? 2 : 4;
  for (let k = 0; k <= ticks; k++) {
    const v = (yMax * k) / ticks, yy = y(v);
    svg += `<line class="grid-line" x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}"/>`;
    if (k > 0) svg += `<text class="axis-text end" x="${padL - 6}" y="${yy + 4}">${fmtMB(v)}</text>`;
  }
  // 面积 + 折线
  const pts = days.map((d, i) => `${x(i)},${y(d.total)}`);
  svg += `<path d="M${pts.join(' L')} L${x(days.length - 1)},${padT + plotH} L${x(0)},${padT + plotH} Z" fill="url(#areaG)"/>`;
  svg += `<path class="line-path" d="M${pts.join(' L')}"/>`;
  // x 轴标签与节点：日期固定是 MM-DD（tabular-nums）。每个标签都居中在自己的日期上
  // （含首尾 —— 首标签往左探进 y 轴空档、尾标签往右探进 padR），于是相邻间距处处相等；
  // 仍然放不下就均匀抽样（每隔 step 天一个）直到互不重叠。窄侧栏里自然稀疏成少数几个刻度。
  const n = days.length;
  const LABEL_W = 33, MIN_GAP = 4;
  const dotR = n <= 7 ? 4 : n <= 14 ? 3.2 : 2.4;
  const clash = (cand) => cand.some((i, k) => k > 0 && x(i) - x(cand[k - 1]) < LABEL_W + MIN_GAP);
  let labelIdx = [0];
  for (let step = 1; step <= Math.max(1, n); step++) {
    const cand = [];
    for (let i = 0; i < n; i += step) cand.push(i);
    // 末尾抽样点离最后一天太近就丢掉，让尾标签自己覆盖那一段
    if (cand.length > 1 && n - 1 - cand[cand.length - 1] <= step / 2) cand.pop();
    if (cand[cand.length - 1] !== n - 1) cand.push(n - 1);
    if (!clash(cand)) { labelIdx = cand; break; }
  }
  const labelSet = new Set(labelIdx);
  days.forEach((d, i) => {
    if (labelSet.has(i)) {
      const dt = new Date(d.t);
      const label = `${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
      svg += `<text class="axis-text mid" x="${x(i)}" y="${H - 8}">${label}</text>`;
    }
    svg += `<circle class="dot" data-i="${i}" cx="${x(i)}" cy="${y(d.total)}" r="${dotR}"/>`;
  });
  // hover 命中列
  const colW = plotW / days.length;
  days.forEach((_, i) => {
    svg += `<rect class="hit-col" data-i="${i}" x="${x(i) - colW / 2}" y="${padT}" width="${colW}" height="${plotH}"/>`;
  });
  svg += '</svg>';

  const wrap = $('#chartWrap');
  wrap.innerHTML = svg;

  const tip = $('#chartTip');
  const dots = wrap.querySelectorAll('.dot');
  function showTip(i, ev) {
    const d = days[i];
    const dt = new Date(d.t);
    const models = [...d.models.values()].filter((x) => x.total > 0).sort((a, b) => b.total - a.total);
    let html = `<div class="tip-date">${d.key} ${weekday(dt)}</div>`;
    html += `<div class="tip-total"><span>Token 总量</span><b>${fmtMB(d.total)}</b></div>`;
    if (!models.length) html += `<div class="tip-model"><span>无使用记录</span></div>`;
    for (const x of models) {
      html += `<div class="tip-model"><span>${esc(modelTip(x.p, x.m))}</span><b>${fmtMB(x.total)}</b></div>`;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let tx = ev.clientX + 16, ty = ev.clientY + 14;
    if (tx + r.width > innerWidth - 8) tx = ev.clientX - r.width - 14;
    if (ty + r.height > innerHeight - 8) ty = ev.clientY - r.height - 12;
    // 夹进视口，窄侧栏/贴边时也不会跑出屏幕
    tx = Math.max(8, Math.min(tx, innerWidth - r.width - 8));
    ty = Math.max(8, Math.min(ty, innerHeight - r.height - 8));
    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
    dots.forEach((dot) => dot.classList.toggle('hl', +dot.dataset.i === i));
  }
  function hideTip() {
    tip.hidden = true;
    dots.forEach((dot) => dot.classList.remove('hl'));
  }
  wrap.querySelectorAll('.hit-col').forEach((col) => {
    col.addEventListener('mousemove', (ev) => showTip(+col.dataset.i, ev));
    col.addEventListener('mouseleave', hideTip);
  });
}

// ---------- 时间选择器 ----------
function renderPresets() {
  const host = $('#presets');
  host.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.textContent = p.label;
    if (state.type === 'preset' && state.id === p.id) b.classList.add('active');
    b.addEventListener('click', () => {
      state = { type: 'preset', id: p.id };
      closePicker();
      renderAll();
    });
    host.appendChild(b);
  }
}
function closePicker() {
  const pop = $('#pickerPop');
  if (pop) pop.hidden = true;
  const btn = $('#pickerBtn');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
function initPicker() {
  const btn = $('#pickerBtn'), pop = $('#pickerPop');
  if (!btn || !pop) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    btn.setAttribute('aria-expanded', String(!pop.hidden));
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!pop.hidden) closePicker(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });

  const from = $('#dateFrom'), to = $('#dateTo');
  syncDateInputs();
  $('#applyCustom').addEventListener('click', () => {
    if (!from.value || !to.value) return;
    let f = new Date(from.value + 'T00:00:00').getTime();
    let t = new Date(to.value + 'T00:00:00').getTime();
    if (isNaN(f) || isNaN(t)) return;
    if (f > t) [f, t] = [t, f];
    t += 86400e3 - 1; // 止日 23:59:59.999
    const sameYear = new Date(f).getFullYear() === new Date(t).getFullYear();
    const fk = from.value.slice(sameYear ? 5 : 0), tk = to.value.slice(sameYear ? 5 : 0);
    state = { type: 'custom', from: f, to: t, label: `${fk} ~ ${tk}` };
    closePicker();
    renderAll();
  });
}
// 自定义日期输入的上限/默认值跟随 GEN；刷新后重新同步，但不覆盖用户已选的自定义值。
function syncDateInputs() {
  const from = $('#dateFrom'), to = $('#dateTo');
  if (!from || !to) return;
  const todayKey = GEN ? toDateKey(GEN) : '';
  from.max = todayKey; to.max = todayKey;
  if (state.type === 'custom') {
    from.value = toDateKey(state.from); to.value = toDateKey(state.to);
  } else if (todayKey) {
    from.value = toDateKey(GEN - 6 * 86400e3); to.value = todayKey;
  }
}

// ---------- 设置页 ----------
function renderSettings() {
  const first = daily[0]?.b, last = daily[daily.length - 1]?.b;
  const allReqs = daily.reduce((a, r) => a + r.n, 0);
  const kv = (k, v) => `<div class="kv"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`;
  $('#metaList').innerHTML =
    kv('数据生成时间', fmtTime(GEN)) +
    kv('数据库路径', D.meta?.dbPath || '—') +
    kv('数据覆盖', `${first || '—'} ~ ${last || '—'}（本地时区）`) +
    kv('供应商 / 供应商·模型组合', `${Object.keys(PROVIDERS).length} 个 / ${(D.meta?.models || []).length} 组`) +
    kv('总请求数', `${fmtInt(allReqs)} 次`) +
    kv('插件版本', D.meta?.version || '—');
  // 侧栏可点击刷新；独立报告页仍是快照，需重新执行 /token-usage。
  const note = $('#refreshNote');
  if (note) {
    note.innerHTML = SIDEBAR
      ? '点击顶栏「刷新」即可重新查询数据库并更新本页；数据不会在后台自动更新。'
      : '本报告是生成时刻的数据快照，不会自动更新。在 ZCode 会话中重新执行 <code>/token-usage</code> 即可重新查询数据库并生成本页。';
  }
  $('#gaugeList').innerHTML =
    kv('Token 处理总量', '完整提示词 + 输出；缓存命中是提示词的子集，不额外累加') +
    kv('输入 Token', '完整提示词长度；其中被缓存覆盖的部分即「缓存输入」，行内以小字标注') +
    kv('缓存输入', 'cache_read_input_tokens；缓存写入（cache_creation）>0 时在行内以小字标注') +
    kv('缓存命中率', '缓存读取 ÷ 完整提示词（与 ZCode 客户端自身口径 cacheReadTokens/inputTokens 一致）') +
    kv('真正新增', '（完整提示词 − 缓存读取）+ 输出；即未被缓存覆盖的输入加输出') +
    kv('生成速率', `Σ输出 token ÷ Σ请求耗时（t/s），仅统计已完成且耗时 >0 的请求；这类请求不足 ${RATE_MIN_SAMPLES} 次时平均值不可靠，显示「—」。展开后每个模型两列：左为最近 5 分钟速率（按完成时间，不随所选范围变化），右为所选范围的总速率（「(总)」）`) +
    kv('请求次数', 'model_usage 表行数（含重试与失败请求；失败/取消行的 token 均为 0）') +
    kv('最近使用时间', '所选时间范围内最后一次请求的开始时间') +
    kv('趋势图', '按本地日分桶（今天为截至生成时间的部分数据），纵轴为当日 Token 处理总量；窗口跟随所选范围且最少 7 天：短区间固定看近 7 日，近14天/近30天/本月看对应天数，自定义按所选跨度（不足 7 天补足到 7 天，以所选止日结尾）');
}

// ---------- tabs / 主渲染 ----------
function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab.dataset.tab));
      $('#chartTip').hidden = true;
    });
  });
}
function renderGenAt() {
  const genAt = $('#genAt');
  if (!genAt) return;
  // 侧栏顶栏只有一行且很窄，用更短的时间戳写法（完整值在 title 里）
  genAt.textContent = GEN ? (SIDEBAR || PANEL ? `截至 ${fmtShort(GEN)}` : `数据截至 ${fmtTime(GEN)}`) : '等待数据…';
  if (GEN) genAt.title = `数据截至 ${fmtTime(GEN)}`;
  else genAt.removeAttribute('title');
}
function renderAll() {
  $('#pickerLabel').textContent = rangeLabel();
  renderGenAt();
  renderPresets();
  renderCum();
  renderStats();
  renderModels();
  // 趋势图跟着所选范围变（标题 + 天数），所以属于每次重绘的一部分
  renderChart();
}

// 侧栏数据更新：只整体替换派生态 + 重渲染，不动事件绑定、不重置 state/openByRow。
function setData(data) {
  D = data || EMPTY;
  GEN = D.meta?.generatedAt || 0;
  PROVIDERS = D.meta?.providers || {};
  daily = (D.daily || []).map((r) => ({ ...r, t: new Date(r.b + 'T00:00:00').getTime() }));
  recentByModel = indexRecent(D);
  syncDateInputs();
  renderSettings();
  renderAll();
}

// ---------- App 桥（仅侧栏）----------
// 由宿主 iframe 装载，通过 parent.postMessage 走 JSON-RPC 2.0：
//   App→Host ui/initialize → Host 响应 → App notify ui/notifications/initialized
//   → App tools/call token_usage_query
// 安全：只接受 parent 的消息；只 resolve 自己发出的 id；第一次收到自己 initialize
// 的成功响应才锁定 host origin。sandbox 下 origin 为 'null'，此时只能发给 '*'。
function initSidebarBridge() {
  const rootEl = document.documentElement;
  rootEl.classList.add('sidebar');
  const refreshBtn = $('#refreshBtn');
  const statusEl = $('#sidebarStatus');
  const appInfo = { name: 'Token Usage', version: '0.3.0' };
  const PROTOCOL = '2026-01-26';
  const hostContext = {};

  let hostOrigin = null;  // 锁定后为 origin 字符串（含 'null'）；null 表示发送 '*'
  let initialized = false;
  let handshaking = false;
  let busy = false;       // 禁用并发刷新
  let seq = 0;
  const pending = new Map();  // id -> {resolve, reject, timer}
  const RPC_TIMEOUT = 15000;

  function toHost(msg) {
    // sandbox 下 origin 为 'null'（字符串），postMessage 必须用 '*' 目标；
    // ROOT 仍只作 querySelector scope，发送目标永远是 parent。
    parent.postMessage(msg, hostOrigin && hostOrigin !== 'null' ? hostOrigin : '*');
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, RPC_TIMEOUT);
      pending.set(id, { resolve, reject, timer, method });
      toHost({ jsonrpc: '2.0', id, method, params: params || {} });
    });
  }

  function notify(method, params) {
    toHost({ jsonrpc: '2.0', method, params: params || {} });
  }

  function setStatus(kind, text, withRetry) {
    if (!statusEl) return;
    if (!kind) { statusEl.hidden = true; statusEl.className = 'sidebar-status'; statusEl.textContent = ''; return; }
    statusEl.hidden = false;
    statusEl.className = `sidebar-status ${kind}`;
    statusEl.textContent = text;
    if (withRetry) {
      const b = document.createElement('button');
      b.className = 'retry-btn';
      b.type = 'button';
      b.textContent = '重试';
      b.addEventListener('click', () => refresh());
      statusEl.appendChild(b);
    }
  }

  function setBusy(on) {
    busy = on;
    if (!refreshBtn) return;
    refreshBtn.disabled = on;
    refreshBtn.classList.toggle('busy', on);
    const lbl = $('#refreshLabel');
    if (lbl) lbl.textContent = on ? '刷新中' : '刷新';
  }

  // 应用宿主 ctx：theme/styles 有可读支持即可。
  function applyHostContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    Object.assign(hostContext, ctx);
    const theme = ctx.theme;
    if (theme) {
      if (theme === 'light' || theme === 'dark') rootEl.dataset.tuTheme = theme;
      else if (typeof theme === 'object' && theme.mode) rootEl.dataset.tuTheme = theme.mode;
    }
    const vars = ctx.styles?.variables || ctx.variables;
    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) {
        if (typeof v === 'string' && k.startsWith('--')) rootEl.style.setProperty(k, v);
      }
    }
  }

  function removeListeners() {
    window.removeEventListener('message', onMessage);
  }

  function teardown() {
    removeListeners();
    for (const p of pending.values()) clearTimeout(p.timer);
    pending.clear();
  }

  // 拉数据并渲染；失败保留上一次数据 + 时间，并明确提示是旧数据。
  function fetchData() {
    return call('tools/call', { name: 'token_usage_query', arguments: {} })
      .then((res) => {
        // 工具级错误：优先展示 content 里的文本
        if (res && res.isError) {
          const text = (res.content || []).map((c) => c && c.text).filter(Boolean).join(' ');
          throw new Error(text || '工具返回错误');
        }
        const sc = res && res.structuredContent;
        if (!sc || !sc.meta || !Array.isArray(sc.daily) || !Array.isArray(sc.hourly)) {
          throw new Error('返回数据格式不正确');
        }
        setData(sc);
        // 数据缺生成时间仍要提示
        setStatus(sc.meta.generatedAt ? null : 'stale', '数据缺少生成时间，可能已过期。');
      })
      .catch((err) => {
        const msg = (err && err.message) || String(err);
        if (D.meta?.generatedAt) {
          setStatus('stale', `刷新失败：${msg}。当前显示的是上次成功加载的数据（${fmtShort(GEN)}），可能已过期。`, true);
        } else {
          setStatus('error', `加载失败：${msg}。`, true);
        }
      });
  }

  function refresh() {
    if (busy) return;                 // 禁用并发刷新
    // 未握手（首次超时/失败后点重试）先补握手，握手内部会接着拉数据。
    if (!initialized) return handshake();
    setBusy(true);
    if (!D.meta?.generatedAt) setStatus('loading', '正在加载用量数据…');
    fetchData().finally(() => setBusy(false));
  }

  function onMessage(ev) {
    if (ev.source !== window.parent) return;      // 只接受 parent
    // 锁定 origin 后只接受同源宿主消息（sandbox 下 origin 为 'null'）
    if (hostOrigin && ev.origin !== hostOrigin) return;
    const msg = ev.data;
    if (!msg || msg.jsonrpc !== '2.0') return;

    // 宿主通知：ui/notifications/host-context-changed
    if (msg.method === 'ui/notifications/host-context-changed') {
      applyHostContext(msg.params);
      return;
    }
    // 宿主请求 teardown：回空结果并移除监听、清空 pending
    if (msg.method === 'ui/resource-teardown') {
      if (msg.id != null) toHost({ jsonrpc: '2.0', id: msg.id, result: {} });
      teardown();
      return;
    }

    // 只 resolve 自己发出的 id
    if (msg.id != null && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) { p.reject(new Error(msg.error.message || JSON.stringify(msg.error))); return; }
      // 第一次收到自己 initialize 的成功响应才锁定 host origin（'null' 也照存）
      if (p.method === 'ui/initialize' && !hostOrigin) hostOrigin = ev.origin || 'null';
      p.resolve(msg.result);
      return;
    }
  }

  window.addEventListener('message', onMessage);

  function handshake() {
    if (initialized || handshaking) return;   // 握手中/已握手不重入
    handshaking = true;
    setBusy(true);
    if (!D.meta?.generatedAt) setStatus('loading', '正在连接 ZCode 侧栏…');
    call('ui/initialize', { appInfo, appCapabilities: {}, protocolVersion: PROTOCOL })
      .then((res) => {
        // 协议版本必须完全一致；缺失也拒绝
        const pv = res && res.protocolVersion;
        if (pv !== PROTOCOL) {
          throw new Error(`协议版本不匹配（宿主 ${pv || '缺失'}，期望 ${PROTOCOL}）`);
        }
        const serverTools = res && res.hostCapabilities && res.hostCapabilities.serverTools;
        if (!serverTools) {
          throw new Error('宿主未声明 serverTools 能力，无法查询用量');
        }
        applyHostContext(res && res.hostContext);
        initialized = true;
        notify('ui/notifications/initialized', {});
        return fetchData();
      })
      .catch((err) => {
        const msg = (err && err.message) || String(err);
        if (D.meta?.generatedAt) setStatus('stale', `握手失败：${msg}。当前显示的是旧数据。`, true);
        else setStatus('error', `与宿主握手失败：${msg}。`, true);
      })
      .finally(() => { handshaking = false; setBusy(false); });
  }

  if (refreshBtn) refreshBtn.addEventListener('click', () => refresh());
  return { handshake, refresh };
}

// ---------- 启动 ----------
// 初始化只跑一次：事件监听（tabs / picker / 刷新按钮）在此绑定，
// 之后的刷新只调 renderAll/setData，绝不重复绑定。
initTabs();
initPicker();
renderSettings();
renderAll();

// 图表宽度跟随容器：报告页/侧栏都用 ResizeObserver 重绘，
// 窗口 resize 作为兜底（ResizeObserver 不可用时）。
if (typeof ResizeObserver === 'function') {
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => renderChart());
  });
  const wrap = $('#chartWrap');
  if (wrap) ro.observe(wrap);
}
let rz;
addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(renderChart, 150); });

if (SIDEBAR) {
  initSidebarBridge().handshake();
}
})();
