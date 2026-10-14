// Renderer-side shell for the ZCode Token 用量 panel (out/renderer/token-usage-panel.js).
// Installs the header icon, owns the hover/pin behaviour, fetches the dataset over the
// preload bridge and then hands the panel body to the shared dashboard script.
// Built by tools/build-panel.mjs — CSS/HTML/APP below are substituted as JSON literals.
(() => {
'use strict';
const CSS = /*__CSS__*/;
const HTML = /*__HTML__*/;
const APP = /*__APP__*/;
// 面板宽 400px，减去 main/card 的内边距后图表可用宽度约 340；高度压到 140 免得趋势图喧宾夺主
const CHART_W = 340;
const CHART_H = 140;
const ROOT_ID = 'zcode-tu-root';
const ICON_ATTR = 'data-zcode-token-usage';

const API = window.__zcodeTokenUsage;
if (!API) {
  console.warn('[token-usage] preload bridge missing — panel not installed');
  return;
}
if (document.getElementById(ROOT_ID) || document.querySelector(`button[${ICON_ATTR}="icon"]`)) return;

const msg = (e) => String((e && e.message) || e);

// ---------- 样式 ----------
const styleEl = document.createElement('style');
styleEl.id = `${ROOT_ID}-style`;
styleEl.textContent = CSS;
document.head.appendChild(styleEl);

// ---------- 图标 ----------
const icon = document.createElement('button');
icon.type = 'button';
icon.setAttribute(ICON_ATTR, 'icon');
icon.setAttribute('aria-label', 'Token 用量');
icon.title = 'Token 用量';
icon.innerHTML =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<path d="M4 20h16M7.5 20v-8M12 20V4.5M16.5 20v-5" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round"/></svg>';

// ---------- 面板 ----------
const host = document.createElement('div');
host.id = ROOT_ID;
host.hidden = true;
document.body.appendChild(host);

let bodyEl = null, statusEl = null, actionsEl = null;
let data = null, errText = '', loading = false, lastFetchAt = 0;

function setStatus(text, isErr) {
  if (!statusEl) return;
  statusEl.textContent = text || '';
  statusEl.hidden = !text;
  statusEl.classList.toggle('err', !!isErr);
}

function paint() {
  host.innerHTML = '';
  host.insertAdjacentHTML('afterbegin', HTML);
  bodyEl = host;

  const topbar = host.querySelector('.topbar');
  if (topbar) {
    actionsEl = document.createElement('div');
    actionsEl.className = 'ztu-actions';
    actionsEl.innerHTML =
      '<button type="button" class="ztu-act" data-act="refresh" title="重新查询数据库">刷新</button>' +
      '<button type="button" class="ztu-act" data-act="pin" title="固定面板（鼠标移开不关闭）">固定</button>' +
      '<button type="button" class="ztu-act" data-act="close" title="关闭">✕</button>';
    topbar.appendChild(actionsEl);
    actionsEl.addEventListener('click', (e) => {
      const act = e.target.closest('.ztu-act');
      if (!act) return;
      e.preventDefault();
      e.stopPropagation();
      if (act.dataset.act === 'refresh') load(true);
      else if (act.dataset.act === 'pin') { pinned = !pinned; syncChrome(); if (!pinned) scheduleHide(); }
      else { pinned = false; hide(); }
    });
  }

  statusEl = document.createElement('div');
  statusEl.className = 'ztu-status';
  const main = host.querySelector('main');
  if (main && main.parentNode) main.parentNode.insertBefore(statusEl, main);

  if (data) {
    window.__DATA__ = data;
    window.__ZCODE_DASH_ROOT__ = host;
    window.__ZCODE_CHART_W__ = CHART_W;
    window.__ZCODE_CHART_H__ = CHART_H;
    try {
      new Function(APP)();
    } catch (e) {
      setStatus(`渲染失败：${msg(e)}`, true);
      return;
    }
  }
  if (errText) setStatus(`查询失败：${errText}`, true);
  else if (loading) setStatus('正在查询本地用量数据库…');
  else setStatus('');
  syncChrome();
}

function syncChrome() {
  if (actionsEl) actionsEl.querySelector('[data-act="pin"]').dataset.on = String(pinned);
}

async function load(force) {
  if (loading) return;
  if (!force && data && Date.now() - lastFetchAt < 2000) return;
  loading = true;
  setStatus('正在查询本地用量数据库…');
  try {
    const res = await API.query();
    lastFetchAt = Date.now();
    if (res && res.ok) {
      data = res.data;
      errText = '';
    } else {
      errText = (res && res.error) || '未知错误';
    }
  } catch (e) {
    errText = msg(e);
  } finally {
    loading = false;
    paint();
    position();
  }
}

// ---------- 显示 / 定位 / hover ----------
// 收起与否用「指针当前位置」判断，而不是 enter/leave 标志位：面板每次渲染都会重建
// DOM，靠标志位会因为丢事件而卡住不收起。
let pinned = false;
let hideTimer = null;
let pointer = { x: -1, y: -1 };

function insideBox(el) {
  if (!el || pointer.x < 0) return false;
  const r = el.getBoundingClientRect();
  return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
}

function position() {
  if (host.hidden) return;
  const r = icon.getBoundingClientRect();
  const w = host.offsetWidth, h = host.offsetHeight;
  let left = Math.round(r.right - w);
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = Math.round(r.bottom + 8);
  if (top + h > innerHeight - 8) top = Math.max(8, Math.round(r.top - h - 8));
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

function show() {
  clearTimeout(hideTimer);
  if (!host.hidden) { position(); return; }
  host.hidden = false;
  icon.dataset.active = 'true';
  position();
  load(false);
  requestAnimationFrame(position);
}

function hide() {
  host.hidden = true;
  icon.dataset.active = 'false';
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (pinned) return;
    if (insideBox(icon) || insideBox(host)) return;
    hide();
  }, 260);
}

// 每次指针移动都重新评估一次，而不是只依赖某个 enter/leave 事件触发的那一次定时器：
// 指针若停在图标与面板之外，260ms 后必定收起。
document.addEventListener('pointermove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (!host.hidden && !pinned) scheduleHide();
}, true);

icon.addEventListener('mouseenter', () => { icon.dataset.active = 'true'; show(); });
icon.addEventListener('mouseleave', scheduleHide);
icon.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  pinned = !pinned;
  if (pinned) show();
  else hide();
  syncChrome();
});

host.addEventListener('mouseenter', () => clearTimeout(hideTimer));
host.addEventListener('mouseleave', scheduleHide);
host.addEventListener('pointerdown', () => { pinned = true; syncChrome(); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !host.hidden) { pinned = false; hide(); syncChrome(); }
}, true);
document.addEventListener('pointerdown', (e) => {
  if (host.hidden || host.contains(e.target) || icon.contains(e.target)) return;
  pinned = false;
  hide();
}, true);

// ---------- 挂到 header 的右上角按钮排 ----------
function findRow() {
  const header = document.querySelector('header[data-workspace-header-variant]');
  if (!header) return null;
  const inner = header.querySelector(':scope > div');
  if (!inner) return null;
  const kids = [...inner.children];
  for (let i = kids.length - 1; i >= 0; i--) {
    const el = kids[i];
    if (el === icon) continue;
    if (el.querySelector('button,[role="button"]')) return el;
  }
  return null;
}

function ensureIcon() {
  const row = findRow();
  if (!row) {
    if (icon.parentElement) icon.remove();
    if (!host.hidden) hide();
    return;
  }
  if (icon.parentElement !== row || row.firstElementChild !== icon) {
    row.insertBefore(icon, row.firstChild);
  }
  if (!host.hidden) position();
}

let scheduled = false;
function scheduleEnsure() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    try { ensureIcon(); } catch (e) { console.warn('[token-usage]', msg(e)); }
  });
}

ensureIcon();
new MutationObserver(scheduleEnsure).observe(document.documentElement, { childList: true, subtree: true });
addEventListener('resize', () => { scheduleEnsure(); if (!host.hidden) position(); });
setInterval(scheduleEnsure, 2000);
})();
