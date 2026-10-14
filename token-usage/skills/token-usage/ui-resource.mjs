// MCP Apps 侧栏界面：生成宿主 resources/read 返回的 HTML 资源。
//
// 前端页面（template.html/style.css/app.js）与独立报告页共用同一份源码；
// 侧栏模式通过 window.__ZCODE_SIDEBAR__ 与 App 桥（见 web/app.js）走 MCP Apps。
//
// 这里产出的是**完全自包含**的单文件 HTML：CSS 与 JS 全部内联，唯一入口资源
// 就是 dashboard.html。前端不 fetch 任何 ui:// 资源，也不访问外网 —— 宿主只需要
// 读这一个资源即可把界面渲染出来，避免宿主 CSP / 相对路径 / autoResize 之外的分裂。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, 'web');

const read = (p) => readFileSync(join(WEB, p), 'utf8');

export const UI_URI = 'ui://token-usage/dashboard.html';
export const UI_MIME = 'text/html;profile=mcp-app';

// 只声明入口资源：CSS/JS 都内联在这一份 HTML 里，宿主读它就够了。
export const RESOURCES = [{ uri: UI_URI, name: 'Token 用量面板', mimeType: UI_MIME }];

const ALLOWED = new Set(RESOURCES.map((r) => r.uri));

export function isAllowedResource(uri) {
  return ALLOWED.has(uri);
}

// 内联脚本：把 </script 之类的序列打断，避免提前闭合宿主文档里的 <script> 标签。
const safeJs = (js) => js.replace(/<\/script/gi, '<\\/script');

// 返回资源的文本内容；未知 URI 抛错（调用方转成 JSON-RPC 错误）。
export function readResource(uri) {
  if (!isAllowedResource(uri)) {
    throw new Error(`未知资源 URI: ${uri}`);
  }
  // 侧栏初始数据为空：真正的数据在 App 握手后通过 tools/call token_usage_query 拉取。
  // classic script（非 module）以兼容宿主沙箱；主题/尺寸由 App 桥在运行时注入。
  const html = read('template.html')
    .replace('<!--__STYLE__-->', () => `<style>\n${read('style.css')}\n</style>`)
    .replace('<!--__DATA__-->', () => '<script>window.__DATA__ = null; window.__ZCODE_SIDEBAR__ = true;</script>')
    .replace('<!--__APP__-->', () => `<script>\n${safeJs(read('app.js'))}\n</script>`);
  return { uri, mimeType: UI_MIME, text: html };
}
