/* 模拟 Firefox 后台（MV3 background.scripts）：
 * - 没有 importScripts
 * - EXT 是 browser.*，API 只返回 Promise，传回调会被忽略
 * 用来验证 bg.js 在 Firefox 里能否正常启动并响应消息。
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('extension/src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

const listeners = [];
const store = { settings: { ghBoost: false }, tasks: [] };
const noop = () => {};

const mem = (bucket) => ({
  get: async (keys) => {
    if (keys == null) return { ...bucket };
    const out = {};
    const list = typeof keys === 'string' ? [keys] : (Array.isArray(keys) ? keys : Object.keys(keys));
    for (const k of list) if (k in bucket) out[k] = bucket[k];
    return out;
  },
  set: async (obj) => { Object.assign(bucket, obj); },
  remove: async (k) => { (Array.isArray(k) ? k : [k]).forEach((x) => delete bucket[x]); },
  clear: async () => { for (const k of Object.keys(bucket)) delete bucket[k]; }
});
const sessionStore = {};

const browser = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener: noop },
    onStartup: { addListener: noop },
    getManifest: () => ({ version: '1.4.3' }),
    getURL: (p) => 'moz-extension://test/' + p,
    sendMessage: async () => ({ ok: true }),
    openOptionsPage: noop
  },
  storage: {
    local: mem(store),
    session: mem(sessionStore),
    onChanged: { addListener: noop }
  },
  downloads: {
    onCreated: { addListener: noop },
    onChanged: { addListener: noop },
    download: async () => 1,
    cancel: noop, erase: noop, search: noop, pause: noop, resume: noop
  },
  tabs: { query: noop, sendMessage: async () => {}, create: noop, update: noop },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
  contextMenus: { removeAll: (cb) => cb && cb(), create: noop, onClicked: { addListener: noop } },
  notifications: { create: noop },
  scripting: {
    registerContentScripts: async () => {},
    getRegisteredContentScripts: async () => [],
    unregisterContentScripts: async () => {}
  },
  declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [] },
  permissions: { contains: async () => true, request: async () => true, remove: async () => true },
  alarms: { create: noop, onAlarm: { addListener: noop } }
};

const ctx = vm.createContext({
  browser,
  chrome: browser,          // Firefox 也提供 chrome.* 别名，但这里故意只测 browser 路径
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async () => ({ ok: true, status: 200, text: async () => '<html>data-color-mode</html>' }),
  URL, TextDecoder, TextEncoder, AbortController
});
ctx.globalThis = ctx;

let fatal = null;
try {
  vm.runInContext(read('common.js'), ctx, { filename: 'common.js' });
} catch (e) {
  fatal = 'common.js: ' + e.message;
}
if (!fatal) {
  try {
    vm.runInContext(read('bg.js'), ctx, { filename: 'bg.js' });
  } catch (e) {
    fatal = 'bg.js: ' + e.message;
  }
}

console.log('【1】后台脚本加载:', fatal ? '失败 —— ' + fatal : '成功');

// 发一条消息给所有监听器（模拟 popup 的 browser.runtime.sendMessage）
function send(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const fin = (v) => { if (!settled) { settled = true; resolve(v); } };
    setTimeout(() => fin({ __noResponse: true }), 4000);
    for (const fn of listeners) {
      const ret = fn(msg, {}, (res) => fin(res));
      if (ret === true) break;
    }
  });
}

if (!fatal) {
  const ping = await send({ type: 'ping' });
  console.log('【2】ping 响应:', JSON.stringify(ping));

  const st = await send({ type: 'boost-state' });
  console.log('【3】boost-state 响应:', JSON.stringify(st).slice(0, 200));
  console.log('    有无 error 字段:', st && st.error ? '有 -> ' + st.error : '没有（正常）');

  const bad = await send({ type: 'not-exist-type' });
  console.log('【4】未知消息:', JSON.stringify(bad).slice(0, 120));
}

setTimeout(() => process.exit(fatal ? 1 : 0), 300);
