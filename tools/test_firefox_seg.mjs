/* Firefox 后台（MV3 background.scripts）里的分片下载链路。
 *
 * Firefox 没有 offscreen 文档，构建时把 off.js 直接塞进 background.scripts，
 * 于是 off.js 和 bg.js 跑在**同一个后台页面**里。
 * 关键坑：runtime.sendMessage 不会派发给发送者自己所在的页面 ——
 * 后台发 seg-start 给自己收不到，分片器永远启动不了（v1.4.x 一直如此）。
 * 现在改成同页面直接调用入口函数，这个测试就是钉住这条链路。
 */
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve('extension/src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const noop = () => {};

const listeners = [];
const store = { settings: {} };

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

const browser = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onInstalled: { addListener: noop },
    onStartup: { addListener: noop },
    getManifest: () => ({ version: '1.5.0' }),
    getURL: (p) => 'moz-extension://test/' + p,
    // 关键点：真实 Firefox 里发给自己收不到，这里刻意什么都不做
    sendMessage: async () => { throw new Error('sendMessage 不该被用到'); },
    openOptionsPage: noop
  },
  storage: { local: mem(store), session: mem({}), onChanged: { addListener: noop } },
  downloads: {
    onCreated: { addListener: noop }, onChanged: { addListener: noop },
    download: async () => 1, cancel: noop, erase: noop, search: noop, pause: noop, resume: noop
  },
  tabs: { query: noop, sendMessage: async () => {}, create: noop, update: noop },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop, setTitle: noop },
  contextMenus: { removeAll: (cb) => cb && cb(), create: noop, onClicked: { addListener: noop } },
  notifications: { create: noop },
  scripting: {
    registerContentScripts: async () => {}, getRegisteredContentScripts: async () => [],
    unregisterContentScripts: async () => {}
  },
  declarativeNetRequest: { updateDynamicRules: async () => {}, getDynamicRules: async () => [] },
  permissions: { contains: async () => true, request: async () => true, remove: async () => true },
  alarms: { create: noop, onAlarm: { addListener: noop } }
};

/* 假的 Range 服务：按请求区间吐数据 */
const SIZE = 1024 * 1024;
const buf = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i++) buf[i] = i % 251;

function serve(start, end, signal) {
  let pos = start, done = false, timer = null;
  return new ReadableStream({
    start(c) {
      const stop = (err) => {
        if (done) return; done = true;
        if (timer) clearInterval(timer);
        try { err ? c.error(err) : c.close(); } catch (e) {}
      };
      if (signal) signal.addEventListener('abort', () => stop(new DOMException('Aborted', 'AbortError')));
      timer = setInterval(() => {
        if (done) return;
        if (pos > end) { stop(); return; }
        const n = Math.min(32 * 1024, end - pos + 1);
        c.enqueue(buf.slice(pos, pos + n));
        pos += n;
      }, 5);
    },
    cancel() { done = true; if (timer) clearInterval(timer); }
  });
}

const got = [];

const ctx = vm.createContext({
  browser,
  chrome: browser,
  console,
  /* common.js 靠 UA 判断是不是 Firefox（决定 EXT 用 browser.* 还是 chrome.*，
   * 以及分片走同页面直连还是消息通道），所以这里得给个真的 UA */
  navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0' },
  setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async (url, opt) => {
    const h = (opt && opt.headers) || {};
    const m = String(h.Range || h.range || '').match(/bytes=(\d+)-(\d+)/);
    const s = m ? Number(m[1]) : 0;
    const e = m ? Number(m[2]) : SIZE - 1;
    got.push(new URL(String(url)).host);
    return new Response(serve(s, e, opt && opt.signal), {
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': 'bytes ' + s + '-' + e + '/' + SIZE
      }
    });
  },
  URL, TextDecoder, TextEncoder, AbortController, Blob, Response, Headers,
  ReadableStream, DOMException, Uint8Array, Promise
});
ctx.globalThis = ctx;

/* 顺序和 build.py 里的 background.scripts 保持一致 */
let fatal = null;
for (const f of ['common.js', 'off.js', 'bg.js']) {
  try {
    vm.runInContext(read(f), ctx, { filename: f });
  } catch (e) {
    fatal = f + ': ' + e.message;
    break;
  }
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

console.log('\n[1] 同页面入口是否暴露');
ok('三个脚本都能在同一个后台页里加载', !fatal, fatal || '');
if (fatal) { console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }
ok('off.js 暴露了 __segDispatch', typeof ctx.__segDispatch === 'function');
ok('bg.js 暴露了 __bgDispatch', typeof ctx.__bgDispatch === 'function');

console.log('\n[2] 后台 → 分片器（不能依赖 sendMessage）');
{
  /* 把 bg 的入口包一层，方便观察分片器回报的消息 */
  const origBg = ctx.__bgDispatch;
  const seen = [];
  ctx.__bgDispatch = function (m, s, r) {
    seen.push(m.type);
    return origBg(m, s, r);
  };

  ctx.__segDispatch({
    target: 'offscreen', type: 'seg-start', id: 'ff1', size: SIZE,
    url: 'https://a.test/f.bin',
    urls: [
      { url: 'https://a.test/f.bin', name: 'a', prefix: 'https://a.test/' },
      { url: 'https://b.test/f.bin', name: 'b', prefix: 'https://b.test/' }
    ],
    threads: 2
  });

  const done = await new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (seen.indexOf('seg-done') >= 0 || seen.indexOf('seg-error') >= 0) {
        clearInterval(timer);
        resolve(seen[seen.length - 1]);
      } else if (Date.now() - t0 > 15000) {
        clearInterval(timer);
        resolve('timeout');
      }
    }, 20);
  });
  ok('分片任务在 Firefox 后台里跑完了', done === 'seg-done', String(done));
  ok('过程中有进度回报（走的是同页面直连）', seen.indexOf('seg-progress') >= 0, seen.join(','));
  ok('两条线路都被用上（多源并发）', new Set(got).size >= 2, [...new Set(got)].join(','));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
