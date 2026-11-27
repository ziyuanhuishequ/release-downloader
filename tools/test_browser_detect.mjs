/* 验证浏览器识别与消息层：
 * 1) 新版 Chrome（158）也带全局 browser，必须仍然认成 Chrome，用 chrome.* 的回调风格；
 * 2) Firefox 必须认成 Firefox，用 browser.* 的 Promise 风格；
 * 3) bgSend 在「sendMessage 返回 Promise」和「只支持回调」两种实现下都要能拿到结果。
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('extension/src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (extra ? ' -> ' + extra : '')); } };

const noop = () => {};
const mem = () => ({ get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} });

function makeApi({ mode, withGetBrowserInfo }) {   // mode: 'chrome' | 'firefox'
  const api = {
    runtime: {
      lastError: null,
      onMessage: { addListener: noop },
      onInstalled: { addListener: noop },
      onStartup: { addListener: noop },
      getManifest: () => ({ version: '1.4.4' }),
      getURL: (p) => 'x://' + p,
      openOptionsPage: noop,
      sendMessage: (msg, cb) => {
        const res = { ok: true, echo: msg && msg.type };
        if (mode === 'firefox') {
          // Firefox：只认 Promise，多传一个回调会被判成非法参数
          if (typeof cb === 'function') throw new TypeError('Incorrect argument types for runtime.sendMessage');
          return Promise.resolve(res);
        }
        // Chrome：回调可用
        if (typeof cb === 'function') { cb(res); return undefined; }
        return undefined;
      }
    },
    storage: { local: mem(), session: mem(), onChanged: { addListener: noop } },
    downloads: {
      onCreated: { addListener: noop }, onChanged: { addListener: noop },
      download: (o, cb) => { if (cb) { cb(7); return 7; } return Promise.resolve(7); },
      cancel: noop, erase: noop, search: (q, cb) => { if (cb) { cb([]); } return Promise.resolve([]); },
      pause: noop, resume: noop
    },
    tabs: { query: (q, cb) => { if (cb) cb([]); return Promise.resolve([]); }, sendMessage: () => Promise.resolve(), create: noop },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    contextMenus: { removeAll: (cb) => { if (cb) cb(); return Promise.resolve(); }, create: noop, onClicked: { addListener: noop } },
    notifications: { create: noop },
    scripting: { registerContentScripts: async () => {}, getRegisteredContentScripts: async () => [], unregisterContentScripts: async () => {} },
    declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [] },
    permissions: { contains: async () => true, request: async () => true }
  };
  if (withGetBrowserInfo) api.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
  return api;
}

function makeCtx({ ua, browserApi, chromeApi }) {
  const ctx = vm.createContext({
    navigator: { userAgent: ua },
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async () => ({ ok: true, status: 200, text: async () => '<html>data-color-mode</html>' }),
    URL, TextDecoder, TextEncoder, AbortController
  });
  if (browserApi) ctx.browser = browserApi;
  if (chromeApi) ctx.chrome = chromeApi;
  ctx.globalThis = ctx;
  return ctx;
}

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.38 Safari/537.36';
const UA_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';

console.log('场景 1：Chrome 158（有 browser 全局，Promise 风格 sendMessage）');
{
  const chromeApi = makeApi({ mode: 'chrome', withGetBrowserInfo: false });
  // Chrome 的 browser 若是同一个对象的别名
  const ctx = makeCtx({ ua: UA_CHROME, browserApi: chromeApi, chromeApi });
  vm.runInContext(read('common.js'), ctx, { filename: 'common.js' });
  ok(vm.runInContext('IS_FF', ctx) === false, 'IS_FF 判定为 false（没有误判成 Firefox）');
  ok(vm.runInContext('EXT === chrome', ctx) === true, 'EXT 选用 chrome 命名空间');
  ok(vm.runInContext('EXT_MANAGER', ctx) === 'chrome://extensions', '错误提示指向 chrome://extensions');
  const r = await vm.runInContext('bgSend("ping")', ctx);
  ok(r && !r.error, 'Chrome 下 bgSend 能拿到响应', JSON.stringify(r));
  const d = await vm.runInContext('new Promise(function(res){ callExt(EXT.downloads.download, EXT.downloads, [{url:"https://x/1"}], function(err,id){ res({err:err,id:id}); }); })', ctx);
  ok(d && !d.err && d.id === 7, 'callExt 能拿到下载编号（不再丢 id）', JSON.stringify(d));
}

console.log('场景 2：Chrome 158，browser 是独立对象且只认 Promise');
{
  const chromeApi = makeApi({ mode: 'chrome', withGetBrowserInfo: false });   // chrome 走回调
  const browserApi = makeApi({ mode: 'chrome', withGetBrowserInfo: false });   // browser 只认 Promise
  const ctx = makeCtx({ ua: UA_CHROME, browserApi, chromeApi });
  vm.runInContext(read('common.js'), ctx, { filename: 'common.js' });
  ok(vm.runInContext('IS_FF', ctx) === false, 'IS_FF 仍为 false');
  ok(vm.runInContext('EXT === chrome', ctx) === true, 'EXT 仍用 chrome（回调可用）');
  const r = await vm.runInContext('bgSend("ping")', ctx);
  ok(r && !r.error, 'bgSend 正常返回', JSON.stringify(r));
}

console.log('场景 3：Firefox（browser 有 getBrowserInfo，Promise 风格）');
{
  const browserApi = makeApi({ mode: 'firefox', withGetBrowserInfo: true });
  const chromeApi = makeApi({ mode: 'chrome', withGetBrowserInfo: false });
  const ctx = makeCtx({ ua: UA_FIREFOX, browserApi, chromeApi });
  vm.runInContext(read('common.js'), ctx, { filename: 'common.js' });
  ok(vm.runInContext('IS_FF', ctx) === true, 'IS_FF 判定为 true');
  ok(vm.runInContext('EXT === browser', ctx) === true, 'EXT 选用 browser 命名空间');
  ok(vm.runInContext('EXT_MANAGER', ctx) === 'about:debugging', '错误提示指向 about:debugging');
  const r = await vm.runInContext('bgSend("ping")', ctx);
  ok(r && !r.error, 'Firefox 下 bgSend 能拿到响应（不再超时）', JSON.stringify(r));
  const d = await vm.runInContext('new Promise(function(res){ callExt(EXT.downloads.download, EXT.downloads, [{url:"https://x/1"}], function(err,id){ res({err:err,id:id}); }); })', ctx);
  ok(d && !d.err && d.id === 7, 'callExt 在 Firefox 下拿到编号', JSON.stringify(d));
}

console.log('场景 4：一次 sendMessage 只发一次（避免重复入队）');
{
  let seen = 0;
  const chromeApi = makeApi({ mode: 'chrome', withGetBrowserInfo: false });
  const orig = chromeApi.runtime.sendMessage;
  chromeApi.runtime.sendMessage = (m, cb) => { seen++; return orig(m, cb); };
  const ctx = makeCtx({ ua: UA_CHROME, chromeApi });
  vm.runInContext(read('common.js'), ctx, { filename: 'common.js' });
  const r = await vm.runInContext('bgSend("ping")', ctx);
  ok(r && !r.error, 'Chrome 下能拿到响应', JSON.stringify(r));
  ok(seen === 1, '只投递一次（不会因为重试逻辑重复执行）', '实际 ' + seen + ' 次');
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
