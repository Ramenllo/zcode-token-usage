#!/usr/bin/env node
// ZCode Token 用量 MCP server（本地 stdio，newline-delimited JSON-RPC 2.0）。
//
// 只暴露一个固定查询工具 token_usage_query（空 schema，故客户端无法传路径/SQL/命令），
// 以及 ui-resource.mjs 里声明的固定自包含入口资源；stdout 只写协议，日志一律走 stderr。
import { createInterface } from 'node:readline';
import { readUsage, UsageDataError } from '../skills/token-usage/usage-data.mjs';
import {
  readResource,
  isAllowedResource,
  RESOURCES,
  UI_URI,
} from '../skills/token-usage/ui-resource.mjs';

const SERVER_NAME = 'token-usage';
const SERVER_VERSION = '0.3.0';
const QUERY_TOOL = 'token_usage_query';
const SUPPORTED_PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const DEFAULT_PROTOCOL = '2025-11-25';

// 结果里回给模型的状态摘要文案（structuredContent 才是原始数据）。
function summarize(data) {
  const sum = (rows) =>
    rows.reduce(
      (a, r) => ({
        i: a.i + (r.i || 0),
        o: a.o + (r.o || 0),
        cr: a.cr + (r.cr || 0),
        cc: a.cc + (r.cc || 0),
        n: a.n + (r.n || 0),
      }),
      { i: 0, o: 0, cr: 0, cc: 0, n: 0 },
    );
  const all = sum(data.daily || []);
  const hourly = data.hourly || [];
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const last24 = sum(hourly.filter((r) => new Date(`${r.b}:00:00`).getTime() >= dayAgo));
  return (
    `已读取本地用量库：全部历史请求 ${all.n.toLocaleString('en-US')} 次，` +
    `输入 ${all.i.toLocaleString('en-US')} + 输出 ${all.o.toLocaleString('en-US')} tokens；` +
    `近24小时请求 ${last24.n.toLocaleString('en-US')} 次。` +
    `完整数据在 structuredContent 中（hourly/daily/meta），数值为生成时刻快照。`
  );
}

// tools/list 里的唯一工具：空参数对象，readOnly，并声明 MCP Apps UI 资源。
const TOOL_DEF = {
  name: QUERY_TOOL,
  description:
    '读取 ZCode 本地 token 用量数据库（只读），返回全部历史与近 40 天的聚合用量数据。' +
    '不需要参数；不接受路径或 SQL。',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
  },
  _meta: {
    ui: {
      resourceUri: UI_URI,
      visibility: ['app'],
    },
  },
};

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

// tools/call 参数：仅允许 undefined 或空 object；null 及任何字段都被拒绝。
function validateArgs(args) {
  if (args === undefined) return;
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('arguments 必须是空对象');
  }
  const keys = Object.keys(args);
  if (keys.length > 0) {
    throw new Error(`本工具不接受任何参数，收到: ${keys.join(', ')}`);
  }
}

function handleToolCall(id, params) {
  const name = params && params.name;
  if (name !== QUERY_TOOL) {
    replyError(id, -32602, `未知工具: ${name}`);
    return;
  }
  try {
    validateArgs(params.arguments);
  } catch (e) {
    replyError(id, -32602, e.message);
    return;
  }
  let data;
  try {
    data = readUsage();
  } catch (e) {
    const msg = e instanceof UsageDataError ? e.message : `读取用量数据失败: ${e.message}`;
    reply(id, { isError: true, content: [{ type: 'text', text: msg }] });
    return;
  }
  reply(id, {
    content: [{ type: 'text', text: summarize(data) }],
    structuredContent: data,
  });
}

function handleResourcesRead(id, params) {
  const uri = params && params.uri;
  if (!uri || !isAllowedResource(uri)) {
    replyError(id, -32602, `未知或不允许的资源 URI: ${uri}`);
    return;
  }
  try {
    const r = readResource(uri);
    reply(id, { contents: [r] });
  } catch (e) {
    replyError(id, -32602, e.message);
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  // 通知（无 id）不需要回复。
  switch (method) {
    case 'initialize': {
      // 协议协商：客户端请求的版本受支持则回显，否则回本 server 的当前版本，不盲 echo。
      const requested = params && params.protocolVersion;
      const negotiated = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL;
      reply(id, {
        protocolVersion: negotiated,
        capabilities: {
          tools: {},
          resources: {},
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    }
    case 'ping':
      reply(id, {});
      return;
    case 'notifications/initialized':
      return;
    case 'tools/list':
      reply(id, { tools: [TOOL_DEF] });
      return;
    case 'tools/call':
      handleToolCall(id, params);
      return;
    case 'resources/list':
      reply(id, { resources: RESOURCES });
      return;
    case 'resources/read':
      handleResourcesRead(id, params);
      return;
    default:
      if (id !== undefined && id !== null) {
        replyError(id, -32601, `未知方法: ${method}`);
      }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    replyError(null, -32700, 'JSON 解析失败');
    return;
  }
  // JSON-RPC 2.0 请求校验：必须是 object，jsonrpc 为 '2.0'，method 为 string，id（若有）为 string/number/null。
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    replyError(null, -32600, '无效请求');
    return;
  }
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    replyError(msg.id !== undefined ? msg.id : null, -32600, '无效请求');
    return;
  }
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id');
  const idType = msg.id === null ? 'null' : typeof msg.id;
  const validId = !hasId || idType === 'string' || idType === 'number' || idType === 'null';
  if (!validId) {
    replyError(null, -32600, '无效请求');
    return;
  }
  // notifications/initialized（无 id）忽略；其他通知不执行、不回 response。
  if (!hasId) return;
  try {
    handle(msg);
  } catch (e) {
    replyError(msg.id, -32603, `内部错误: ${e.message}`);
  }
});
rl.on('close', () => process.exit(0));
