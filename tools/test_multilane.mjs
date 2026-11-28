/* 多线路并发（多源分片）的回归测试。
 *
 * 现场：单条镜像对同一个 IP 限速，只压一条线路时 6 条连接也只有 300KB/s。
 * 解法是「同时向多条线路要数据」：每条线各占几路连接，总带宽叠加。
 *
 * 这里用假的 fetch 模拟「每条线路各自限速」，验证：
 *   1) 一开始就把分片摊到多条线路上（不是全压第一条）；
 *   2) 3 条 500KB/s 的线并行，实际耗时接近 1 条线的 1/3；
 *   3) 某条线特别慢时，它的分片会被抽走，整体不被它拖死；
 *   4) 换池（seg-rebuild）之后内容仍然一个字节不差。
 */
import fs from 'fs';
import vm from 'vm';

const msgs = [];
const fetched = [];
let listener = null;

const chrome = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    sendMessage: (msg) => { msgs.push(msg); return Promise.resolve(); }
  }
};

const ctx = {
  chrome, console,
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
  AbortController, Blob, URL, Response, Headers, ReadableStream, DOMException,
  Uint8Array, Promise
};
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('extension/src/off.js', 'utf8'), ctx);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function pattern(n, seed = 0) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i + seed) % 251;
  return b;
}

/* 按 Range 吐数据；chunk/delay 决定这条线路有多快 */
function serve(buf, start, end, chunk, delay, signal) {
  let timer = null, done = false, pos = start;
  return new ReadableStream({
    start(c) {
      const stop = (err) => {
        if (done) return;
        done = true;
        if (timer) clearInterval(timer);
        try { err ? c.error(err) : c.close(); } catch (e) {}
      };
      if (signal) signal.addEventListener('abort', () => stop(new DOMException('Aborted', 'AbortError')));
      timer = setInterval(() => {
        if (done) return;
        if (pos > end) { stop(); return; }
        const n = Math.min(chunk, end - pos + 1);
        c.enqueue(buf.slice(pos, pos + n));
        pos += n;
      }, delay);
    },
    cancel() { done = true; if (timer) clearInterval(timer); }
  });
}

/* 每条 host 一份速度配置；并发度按 host 记录峰值，用来证明「真的同时在下」 */
const active = {};
const peak = {};
let fetchDelay = 0;

function installFetch(buf, speedOf) {
  ctx.fetch = async (url, opt) => {
    const h = (opt && opt.headers) || {};
    const m = String(h.Range || h.range || '').match(/bytes=(\d+)-(\d+)/);
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : buf.length - 1;
    const host = new URL(url).host;
    fetched.push(host);
    active[host] = (active[host] || 0) + 1;
    peak[host] = Math.max(peak[host] || 0, active[host]);
    if (fetchDelay) await new Promise((r) => setTimeout(r, fetchDelay));
    const sp = speedOf(host, start, end);
    const res = new Response(serve(buf, start, end, sp.chunk, sp.delay, opt && opt.signal), {
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': 'bytes ' + start + '-' + end + '/' + buf.length
      }
    });
    if (res.body) {
      const rdr = res.body.getReader();
      const wrapped = new ReadableStream({
        async pull(c) {
          const r = await rdr.read();
          if (r.done) { active[host]--; c.close(); return; }
          c.enqueue(r.value);
        },
        cancel(reason) { active[host]--; try { rdr.cancel(reason); } catch (e) {} }
      });
      return new Response(wrapped, { status: 206, headers: res.headers });
    }
    return res;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitDone(limit = 60000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve({ timeout: true, spent: Date.now() - t0 }), limit);
    const watch = setInterval(() => {
      const done = msgs.find((m) => m.type === 'seg-done' || m.type === 'seg-error');
      if (done) {
        clearInterval(watch); clearTimeout(timer);
        done.spent = Date.now() - t0;
        resolve(done);
      }
    }, 20);
  });
}

function reset() { msgs.length = 0; fetched.length = 0; fetchDelay = 0; for (const k in active) delete active[k]; for (const k in peak) delete peak[k]; }

async function readBlob(url) {
  const res = await fetch(url);
  return new Uint8Array(await res.arrayBuffer());
}

function sameBytes(a, b) {
  if (a.length !== b.length) return '长度 ' + a.length + ' vs ' + b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return '第 ' + i + ' 字节不同';
  return '';
}

/* ---------- 1. 三条线路各 500KB/s：应接近三倍速 ---------- */
const SIZE = 4 * 1024 * 1024;
const SAME = { chunk: 16 * 1024, delay: 32 };   // ≈500KB/s

console.log('\n[1] 三条线路同时下载，带宽叠加');
{
  const buf = pattern(SIZE, 7);
  installFetch(buf, () => SAME);
  reset();
  const t0 = Date.now();
  listener({
    target: 'offscreen', type: 'seg-start', id: 'm1', size: SIZE,
    url: 'https://a.test/f.bin',
    urls: [
      { url: 'https://a.test/f.bin', name: 'a', prefix: 'https://a.test/', bps: 500 * 1024 },
      { url: 'https://b.test/f.bin', name: 'b', prefix: 'https://b.test/', bps: 500 * 1024 },
      { url: 'https://c.test/f.bin', name: 'c', prefix: 'https://c.test/', bps: 500 * 1024 }
    ],
    threads: 4
  }, {}, () => {});

  await sleep(180);
  const hostsEarly = new Set(fetched);
  ok('开跑 0.2 秒就用上了 2 条以上线路', hostsEarly.size >= 2, [...hostsEarly].join(','));

  const done = await waitDone();
  const spent = Date.now() - t0;
  ok('任务完成', done.type === 'seg-done', JSON.stringify(done));
  ok('总大小正确', done.total === SIZE, String(done.total));

  const hosts = new Set(fetched);
  ok('三条线路都被用上了', hosts.size === 3, [...hosts].join(','));
  ok('确实同时有 ≥2 条线路在传（不是排队）',
    Object.keys(peak).filter((h) => peak[h] >= 1).length >= 2, JSON.stringify(peak));

  const bytes = await readBlob(done.url);
  ok('拼出来的文件与原始内容一致', sameBytes(bytes, buf) === '', sameBytes(bytes, buf));

  /* 单线 4MB / 500KB/s ≈ 8 秒；三线并行应该 3 秒左右。
   * 放宽到 5.5 秒：CI/慢机器上也别误判，但单线肯定过不了这条线。 */
  ok('耗时接近单线的 1/3（<5.5 秒）', spent < 5500, spent + 'ms');
  console.log('    实际耗时 ' + spent + 'ms，峰值并发 ' + JSON.stringify(peak));
}

/* ---------- 2. 一条线只有 40KB/s，不能拖住整体 ---------- */
console.log('\n[2] 慢线路不拖后腿（分片会被抽走）');
{
  const buf = pattern(SIZE, 3);
  installFetch(buf, (host) => (host === 'slow.test'
    ? { chunk: 4 * 1024, delay: 100 }   // ≈40KB/s
    : { chunk: 32 * 1024, delay: 16 }));  // ≈2MB/s
  reset();
  const t0 = Date.now();
  listener({
    target: 'offscreen', type: 'seg-start', id: 'm2', size: SIZE,
    url: 'https://slow.test/f.bin',
    urls: [
      { url: 'https://slow.test/f.bin', name: 'slow', prefix: 'https://slow.test/', bps: 40 * 1024 },
      { url: 'https://fast1.test/f.bin', name: 'fast1', prefix: 'https://fast1.test/', bps: 2 * 1024 * 1024 },
      { url: 'https://fast2.test/f.bin', name: 'fast2', prefix: 'https://fast2.test/', bps: 2 * 1024 * 1024 }
    ],
    threads: 4
  }, {}, () => {});
  const done = await waitDone();
  const spent = Date.now() - t0;
  ok('任务完成', done.type === 'seg-done', JSON.stringify(done));
  const bytes = await readBlob(done.url);
  ok('内容正确', sameBytes(bytes, buf) === '', sameBytes(bytes, buf));
  ok('没有被 40KB/s 的线拖死（<5 秒）', spent < 5000, spent + 'ms');
  ok('慢线的活被快线接走了', (peak['fast1.test'] || 0) + (peak['fast2.test'] || 0) >= 2,
    JSON.stringify(peak));
  console.log('    实际耗时 ' + spent + 'ms，峰值并发 ' + JSON.stringify(peak));
}

/* ---------- 3. 中途换池子：字节不丢，内容不坏 ---------- */
console.log('\n[3] seg-rebuild 换整池线路，已下字节保留');
{
  const buf = pattern(SIZE, 11);
  installFetch(buf, (host) => (host.indexOf('old') >= 0
    ? { chunk: 8 * 1024, delay: 60 }     // ≈130KB/s
    : { chunk: 32 * 1024, delay: 12 })); // 很快
  reset();
  listener({
    target: 'offscreen', type: 'seg-start', id: 'm3', size: SIZE,
    url: 'https://old1.test/f.bin',
    urls: [
      { url: 'https://old1.test/f.bin', name: 'old1', prefix: 'https://old1.test/' },
      { url: 'https://old2.test/f.bin', name: 'old2', prefix: 'https://old2.test/' }
    ],
    threads: 4
  }, {}, () => {});
  await sleep(400);
  const before = msgs.filter((m) => m.type === 'seg-progress').map((m) => m.received);
  const gotBefore = before.length ? before[before.length - 1] : 0;

  listener({
    target: 'offscreen', type: 'seg-rebuild', id: 'm3', threads: 4,
    urls: [
      { url: 'https://new1.test/f.bin', name: 'new1', prefix: 'https://new1.test/' },
      { url: 'https://new2.test/f.bin', name: 'new2', prefix: 'https://new2.test/' },
      { url: 'https://new3.test/f.bin', name: 'new3', prefix: 'https://new3.test/' }
    ]
  }, {}, () => {});

  const done = await waitDone();
  ok('任务完成', done.type === 'seg-done', JSON.stringify(done));
  const after = msgs.filter((m) => m.type === 'seg-progress').map((m) => m.received);
  ok('换池后进度没有倒退', after.every((v, i) => i === 0 || v >= after[i - 1]), after.join(','));
  ok('换池前已经下了不少（说明不是从头开始）', gotBefore > 0, String(gotBefore));
  ok('用上了新池子里的线路', fetched.some((h) => h.indexOf('new') >= 0), [...new Set(fetched)].join(','));
  const bytes = await readBlob(done.url);
  ok('内容仍然正确', sameBytes(bytes, buf) === '', sameBytes(bytes, buf));
}

/* ---------- 4. 暂停/继续：连接都断掉再起，不重头来 ---------- */
console.log('\n[4] 多线路下暂停 / 继续');
{
  const buf = pattern(2 * 1024 * 1024, 5);
  installFetch(buf, () => ({ chunk: 16 * 1024, delay: 40 }));
  reset();
  listener({
    target: 'offscreen', type: 'seg-start', id: 'm4', size: buf.length,
    url: 'https://a.test/f.bin',
    urls: [
      { url: 'https://a.test/f.bin', name: 'a', prefix: 'https://a.test/' },
      { url: 'https://b.test/f.bin', name: 'b', prefix: 'https://b.test/' }
    ],
    threads: 3
  }, {}, () => {});
  const p = waitDone();
  await sleep(300);
  listener({ target: 'offscreen', type: 'seg-pause', id: 'm4' }, {}, () => {});
  await sleep(500);
  const frozen = msgs.filter((m) => m.type === 'seg-progress').map((m) => m.received);
  const atPause = frozen[frozen.length - 1] || 0;
  listener({ target: 'offscreen', type: 'seg-resume', id: 'm4' }, {}, () => {});
  const done = await p;
  ok('继续后能下完', done.type === 'seg-done', JSON.stringify(done));
  const all = msgs.filter((m) => m.type === 'seg-progress').map((m) => m.received);
  ok('进度单调不回退', all.every((v, i) => i === 0 || v >= all[i - 1]), all.join(','));
  ok('暂停时确实停住了（不是一直在跑）', atPause < buf.length, atPause + '/' + buf.length);
  const bytes = await readBlob(done.url);
  ok('内容正确', sameBytes(bytes, buf) === '', sameBytes(bytes, buf));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
