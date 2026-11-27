/* 用 vm 把 common.js + bg.js 跑起来，验证这次改的关键逻辑：
 *  1. ghFetch 直连失败后自动走镜像并记住通道
 *  2. 404 这类业务错误不会被误当成"通道不通"而反复重试
 *  3. setBoost / boostState 不再阻塞
 *  4. 镜像地址换算（path / prefix 两种）
 */
import fs from 'fs';
import vm from 'vm';

const store = {};
const noop = () => {};
const canceledIds = [];
let onCreatedFn = null;
const chrome = {
  runtime: {
    onMessage: { addListener: noop }, onInstalled: { addListener: noop },
    onStartup: { addListener: noop }, lastError: null, getManifest: () => ({ version: '1.4.1' }),
    sendMessage: noop, openOptionsPage: noop, getURL: (p) => 'chrome-extension://x/' + p
  },
  storage: {
    local: {
      get: async (k) => {
        if (typeof k === 'string') return { [k]: store[k] };
        const out = {};
        (Array.isArray(k) ? k : Object.keys(k || {})).forEach((x) => { if (store[x] !== undefined) out[x] = store[x]; });
        return out;
      },
      set: async (o) => { Object.assign(store, o); },
      remove: async (k) => { delete store[k]; }
    },
    session: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: noop }
  },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  downloads: {
    onChanged: { addListener: noop },
    onCreated: { addListener: (fn) => { onCreatedFn = fn; } },
    search: noop, download: async () => 1,
    cancel: (id, cb) => { canceledIds.push(id); if (cb) cb(); },
    pause: noop, resume: noop,
    erase: (q, cb) => { if (cb) cb(); }
  },
  notifications: { create: noop },
  permissions: { contains: async () => true, request: async () => true },
  tabs: { query: async () => [], create: noop, update: noop },
  contextMenus: { removeAll: noop, create: noop, onClicked: { addListener: noop } },
  declarativeNetRequest: { updateDynamicRules: async () => ({}) },
  scripting: { getRegisteredContentScripts: async () => [], unregisterContentScripts: async () => {}, registerContentScripts: async () => {} }
};

const timers = [];
const ctx = {
  chrome, console,
  setTimeout: (fn, ms) => { const t = globalThis.setTimeout(fn, ms); timers.push(t); return t; },
  clearTimeout: globalThis.clearTimeout,
  setInterval: () => 0,
  clearInterval: noop,
  AbortController, TextDecoder, Response, Headers, Request, URL, performance,
  importScripts: noop
};
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('extension/src/common.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('extension/src/bg.js', 'utf8'), ctx);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---------- 1. 镜像地址换算 ---------- */
console.log('\n[1] 镜像地址换算');
const pathSite = { name: 'at9', base: 'https://gh-proxy.at9.net', kind: 'path' };
const prefixSite = { name: 'isteed', base: 'https://cors.isteed.cc/', kind: 'prefix' };
ok('path 型拼出裸路径', ctx.siteUrl(pathSite, 'https://github.com/a/b/releases/tag/v1') === 'https://gh-proxy.at9.net/a/b/releases/tag/v1',
  ctx.siteUrl(pathSite, 'https://github.com/a/b/releases/tag/v1'));
ok('prefix 型拼出完整地址', ctx.siteUrl(prefixSite, 'https://github.com/a/b') === 'https://cors.isteed.cc/https://github.com/a/b',
  ctx.siteUrl(prefixSite, 'https://github.com/a/b'));
ok('prefix 型地址能还原回 github',
  ctx.ghCanonical('https://cors.isteed.cc/https://github.com/a/b?x=1') === 'https://github.com/a/b?x=1',
  ctx.ghCanonical('https://cors.isteed.cc/https://github.com/a/b?x=1'));
ok('没有 kind 时按结尾斜杠猜类型', ctx.siteKindOf('https://x.com/') === 'prefix' && ctx.siteKindOf('https://x.com') === 'path');

const norm = ctx.normalizeSites({ sites: [{ base: 'https://a.com/' }, { base: 'https://b.com', kind: 'path' }, { base: 'https://a.com/' }] });
ok('sites 去重且归一', norm.length === 2 && norm[0].kind === 'prefix' && norm[1].base === 'https://b.com', JSON.stringify(norm));

/* ---------- 2. DNR 规则 ---------- */
console.log('\n[2] 重定向规则');
const rulesP = ctx.boostRules(pathSite);
const rulesX = ctx.boostRules(prefixSite);
ok('path 型 substitution 用 /\\1', rulesP[1].action.redirect.regexSubstitution === 'https://gh-proxy.at9.net/\\1',
  rulesP[1].action.redirect.regexSubstitution);
ok('prefix 型 substitution 带完整地址', rulesX[1].action.redirect.regexSubstitution === 'https://cors.isteed.cc/https://github.com/\\1',
  rulesX[1].action.redirect.regexSubstitution);
ok('登录页 allow 优先级高于 redirect', rulesP[0].priority > rulesP[1].priority);
ok('只拦 main_frame（下载不受影响）', rulesP[1].condition.resourceTypes.join() === 'main_frame');
const reLen = rulesP[0].condition.regexFilter.length + rulesP[1].condition.regexFilter.length;
ok('正则总长在 Chrome 2KB 限制内（' + reLen + ' 字节）', reLen < 400);

/* ---------- 3. ghFetch 多通道 ---------- */
console.log('\n[3] API 多通道兜底');
const tried = [];
ctx.fetch = async (url) => {
  tried.push(url);
  if (url.startsWith('https://api.github.com')) throw new TypeError('Failed to fetch');   // 模拟被墙
  if (url.startsWith('https://gh-proxy.org/https://api.github.com')) {
    return new Response(JSON.stringify([{ tag_name: 'v1.0.0' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.startsWith('https://gh-proxy.com/https://api.github.com')) {
    return new Response(JSON.stringify([{ tag_name: 'v1.0.0' }]), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  throw new TypeError('nope');
};
const t0 = Date.now();
const data = await ctx.ghFetch('/repos/a/b/releases?per_page=1', {});
ok('直连失败后由镜像返回数据', Array.isArray(data) && data[0].tag_name === 'v1.0.0', JSON.stringify(data));
ok('确实尝试过直连和镜像', tried.some((u) => u.startsWith('https://api.github.com')) && tried.some((u) => u.includes('gh-proxy')),
  tried.join(' , '));
ok('耗时没被串行拖长（<3s）', Date.now() - t0 < 3000, (Date.now() - t0) + 'ms');
ok('记住了成功的通道', ctx.apiVia() === 'gh-proxy.org', ctx.apiVia());

// 第二次应该优先走记住的通道（不再等直连失败）
tried.length = 0;
await ctx.ghFetch('/repos/a/b', {});
ok('第二次优先用上次成功的通道', tried[0].includes('gh-proxy.org'), tried[0]);

/* ---------- 4. 4xx 不重试 ---------- */
console.log('\n[4] 业务错误不误判');
tried.length = 0;
ctx.fetch = async (url) => {
  tried.push(url);
  return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
};
let err404 = null;
try { await ctx.ghFetch('/repos/no/such', {}); } catch (e) { err404 = e; }
ok('404 直接抛业务错误', err404 && err404.status === 404, err404 && err404.message);
ok('404 只请求一次，没有挨个通道重试', tried.length === 1, tried.length + ' 次');

/* ---------- 5. 全挂时报错 ---------- */
console.log('\n[5] 全部通道不可用');
ctx.fetch = async () => { throw new TypeError('blocked'); };
let errAll = null;
try { await ctx.ghFetch('/repos/a/b', {}); } catch (e) { errAll = e; }
ok('给出可读错误而不是崩掉', !!errAll && /连不上|不可达|超时/.test(errAll.message), errAll && errAll.message);

/* ---------- 6. boostState 不阻塞 ---------- */
console.log('\n[6] 开关状态不阻塞');
ctx.fetch = async (url) => {
  // 所有镜像都超时（模拟全挂），验证 boostState 不会卡在这里
  await new Promise((r) => globalThis.setTimeout(r, 60_000));
  return new Response('', { status: 200 });
};
store.settings = { ghBoost: false, ghSiteCache: 'https://gh-proxy.at9.net' };
const b0 = Date.now();
const bs = await ctx.boostState();
const bms = Date.now() - b0;
ok('boostState 不等待探活（<800ms）', bms < 800, bms + 'ms');
ok('返回上次用过的镜像', bs.site && bs.site.base === 'https://gh-proxy.at9.net', JSON.stringify(bs.site));
ok('标记 checking 让界面稍后再刷', bs.checking === true);

/* ---------- 7. 开关快路径 ---------- */
console.log('\n[7] 开开关的响应速度');
store.settings = { ghBoost: false, ghSiteCache: 'https://gh-proxy.at9.net', ghSite: '' };
// 镜像探活全都很慢：有缓存时不该等它们
ctx.fetch = async () => { await new Promise((r) => globalThis.setTimeout(r, 60_000)); return new Response('', { status: 200 }); };
const s0 = Date.now();
const setRes = await ctx.setBoost(true);
const sms = Date.now() - s0;
ok('有上次用过的镜像时立刻开启（<600ms）', sms < 600, sms + 'ms');
ok('返回的站点就是缓存那台', setRes.site && setRes.site.base === 'https://gh-proxy.at9.net', JSON.stringify(setRes.site));
ok('写入了开关状态', store.settings.ghBoost === true);

/* 首次开启：第一个探通的就该用，不等后面的超时 */
console.log('\n[8] 首次开启取最快可用');
store.settings = { ghBoost: false, ghSiteCache: '', ghSite: '' };
ctx.siteProbe = null;
let probes = 0;
ctx.fetch = async (url) => {
  probes++;
  if (url.includes('gh-proxy.at9.net')) {
    return new Response('<html data-color-mode="light"><title>GitHub</title></html>',
      { status: 200, headers: { 'content-type': 'text/html' } });
  }
  await new Promise((r) => globalThis.setTimeout(r, 60_000));     // 其余全部超时
  return new Response('', { status: 200 });
};
const f0 = Date.now();
const fast = await ctx.pickSiteFast(store.settings);
const fms = Date.now() - f0;
ok('探到第一个可用就返回（<1.5s）', fms < 1500, fms + 'ms');
ok('选中的是能用的那台', fast.site && fast.site.base === 'https://gh-proxy.at9.net', JSON.stringify(fast.site));

/* ---------- 9. 下载永远不落到镜像上 ---------- */
console.log('\n[9] 镜像页下载自动切快速方案');
ctx.fetch = async () => { await new Promise((r) => globalThis.setTimeout(r, 60_000)); return new Response('', { status: 200 }); };
ctx.tasks.length = 0;
const mirrorAsset = 'https://gh-proxy.at9.net/a/b/releases/download/v1.0.0/x.zip';
const q1 = await ctx.enqueue([{ url: mirrorAsset }]);
const t1 = ctx.tasks[0];
ok('入队时把镜像地址归一化回 github.com', t1 && t1.url === 'https://github.com/a/b/releases/download/v1.0.0/x.zip', t1 && t1.url);
ok('文件名和版本从地址里解析出来了', t1 && t1.name === 'x.zip', t1 && t1.name);
ok('确实加进了队列', q1.added === 1, JSON.stringify(q1));

ctx.tasks.length = 0;
canceledIds.length = 0;
onCreatedFn({
  id: 77,
  url: 'https://cors.isteed.cc/https://github.com/a/b/releases/download/v1.0.0/y.tar.gz',
  finalUrl: ''
});
await new Promise((r) => globalThis.setTimeout(r, 120));
ok('浏览器自己从镜像开始的下载被取消', canceledIds.indexOf(77) >= 0, canceledIds.join());
ok('改由扩展重新入队（github 地址）',
  ctx.tasks.some((t) => t.url === 'https://github.com/a/b/releases/download/v1.0.0/y.tar.gz'),
  ctx.tasks.map((t) => t.url).join(' | '));

// 扩展自己发起的下载（线路池也会用到同一批镜像域名）不能被误杀
canceledIds.length = 0;
const ourUrl = 'https://cors.isteed.cc/https://github.com/a/b/releases/download/v1.0.0/z.zip';
ctx.markOurDownload(ourUrl);
onCreatedFn({ id: 88, url: ourUrl });
await new Promise((r) => globalThis.setTimeout(r, 80));
ok('扩展自己发起的下载不会被误取消', canceledIds.indexOf(88) < 0, canceledIds.join());

// 非 Release 文件（比如镜像页面上的头像、css）一概不碰
canceledIds.length = 0;
onCreatedFn({ id: 99, url: 'https://gh-proxy.at9.net/a/b/archive/refs/heads/main.zip' });
await new Promise((r) => globalThis.setTimeout(r, 80));
ok('非 release 资源的下载不干预', canceledIds.indexOf(99) < 0, canceledIds.join());

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
