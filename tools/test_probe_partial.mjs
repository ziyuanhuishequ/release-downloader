/* 测速策略回归：镜像「首包爆发、随后限速」和「慢但能下」两种情况不能再判错。
 *
 * 现场：早上第一次下载很快，用了一上午之后每条线路都慢，面板只剩 5 条「可测速」。
 * 原因之一是测速只读 96KB 且到点即判超时：
 *   - 首包爆发 → 测出几 MB/s，实际下起来被限速到几十 KB/s；
 *   - 真的慢（30KB/s）→ 6 秒读不完 96KB，被判「测不出速度」，排到最后没人用。
 */
import fs from 'fs';
import vm from 'vm';

const noop = () => {};
const store = {};
const chrome = {
  runtime: {
    onMessage: { addListener: noop }, onInstalled: { addListener: noop },
    onStartup: { addListener: noop }, lastError: null, getManifest: () => ({ version: '1.4.8' }),
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
    onChanged: { addListener: noop }, onCreated: { addListener: noop },
    search: noop, download: async () => 1, cancel: noop, pause: noop, resume: noop,
    erase: (q, cb) => { if (cb) cb(); }
  },
  notifications: { create: noop },
  permissions: { contains: async () => true, request: async () => true },
  tabs: { query: async () => [], create: noop, update: noop },
  contextMenus: { removeAll: noop, create: noop, onClicked: { addListener: noop } },
  declarativeNetRequest: { updateDynamicRules: async () => ({}) },
  scripting: { getRegisteredContentScripts: async () => [], unregisterContentScripts: async () => {}, registerContentScripts: async () => {} }
};

const ctx = {
  chrome, console,
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  AbortController, TextDecoder, Response, Headers, Request, Blob, URL, performance,
  ReadableStream, DOMException,
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

/* 造一个「按计划吐字节」的响应：首包 burst，然后每 period 毫秒给 chunk 字节。
 * 被 abort / cancel 时立刻停，模拟真实连接。 */
function body(signal, plan) {
  const { burst = 0, chunk = 0, period = 1000, cap = 64 * 1024 * 1024 } = plan;
  let timer = null, done = false, sent = 0;
  return new ReadableStream({
    start(c) {
      const stop = (err) => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        try { err ? c.error(err) : c.close(); } catch (e) {}
      };
      if (signal) signal.addEventListener('abort', () => stop(new DOMException('Aborted', 'AbortError')));
      if (burst) { c.enqueue(new Uint8Array(burst)); sent = burst; }
      if (!chunk) { timer = setTimeout(() => stop(), 60000); return; }
      timer = setInterval(() => {
        if (done) return;
        if (sent >= cap) { stop(); return; }
        c.enqueue(new Uint8Array(Math.min(chunk, cap - sent)));
        sent += chunk;
      }, period);
    },
    cancel() { done = true; if (timer) clearInterval(timer); }
  });
}

function serve(plan) {
  return async (url, opt) => new Response(body(opt && opt.signal, plan), {
    status: 206,
    headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-99/999999' }
  });
}

const route = { name: 'm', prefix: 'https://gh-proxy.test/' };
const file = 'https://github.com/a/b/releases/download/v1/x.bin';

/* ---------- 1. 慢但能下：不能判成「超时 / 测不出速度」 ---------- */
console.log('\n[1] 30KB/s 左右的线路（6 秒读不满 256KB）');
{
  // 首包 32KB，之后每 1 秒 4KB ≈ 4KB/s 的尾巴 → 真实感受就是「被限速了」
  ctx.fetch = serve({ burst: 32 * 1024, chunk: 4096, period: 1000 });
  const r = await ctx.probeOne(route, file);
  ok('判为可用（ok=true），而不是 timeout', r.ok === true && !r.err, JSON.stringify(r));
  ok('速度按尾窗算（< 20KB/s），不会被首包爆发骗成 MB/s', r.bps < 20 * 1024, r.bps + ' B/s');
  ok('标了 partial', r.partial === true, JSON.stringify(r));
}

/* ---------- 2. 首包爆发、随后掉速：不能按爆发速度排序 ---------- */
console.log('\n[2] 先给 200KB，然后掉到 10KB/s');
{
  ctx.fetch = serve({ burst: 200 * 1024, chunk: 10 * 1024, period: 1000 });
  const r = await ctx.probeOne(route, file);
  ok('能拿到数据', r.ok === true, JSON.stringify(r));
  ok('测出来的不是「首包 2MB/s」，而是限速后的真实速度', r.bps < 120 * 1024, r.bps + ' B/s');
}

/* ---------- 3. 真的快：速度照常给高分 ---------- */
console.log('\n[3] 直接给满 256KB');
{
  ctx.fetch = serve({ burst: 256 * 1024 });
  const r = await ctx.probeOne(route, file);
  ok('ok=true', r.ok === true, JSON.stringify(r));
  ok('速度很高（> 500KB/s）', r.bps > 500 * 1024, r.bps + ' B/s');
  ok('不算 partial', !r.partial, JSON.stringify(r));
}

/* ---------- 4. 一个字节都不给：还是 timeout ---------- */
console.log('\n[4] 连接建上但一直不吐数据');
{
  ctx.fetch = serve({ burst: 0, chunk: 0 });
  const t0 = Date.now();
  const r = await ctx.probeOne(route, file, 1200);
  ok('超时不算可用', r.ok === false && r.err === 'timeout', JSON.stringify(r));
  ok('1.2 秒的超时就按时返回，没拖满', Date.now() - t0 < 3000, (Date.now() - t0) + 'ms');
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
