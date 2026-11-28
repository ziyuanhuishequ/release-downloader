/* 分片下载「不丢字节换线路」的回归测试。
 *
 * 现场：早上很快，用一阵变慢。扩展原来是「慢就 abortSeg 重下」，
 * 已经下好的几 MB 全扔掉，所以只敢在下到 8% 前换线；下到一半被限速就只能硬爬。
 * 现在改成 seg-rotate：只把剩余区间换到别的线路，chunks 全部保留。
 *
 * 这里用假的 fetch 直接跑 off.js，验证两件事：
 *   1) 收到 seg-rotate 后，后续区间走新线路，最终文件内容一个字节都没错；
 *   2) 某一片明显比同伴慢时，它自己会换线路（不用等整条任务换线）。
 */
import fs from 'fs';
import vm from 'vm';

const SIZE_A = 3 * 1024 * 1024;   // 用例 1
const SIZE_B = 2 * 1024 * 1024;   // 用例 2

function pattern(n) {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
}

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

/* 按 Range 从内存里吐数据；chunk/delay 决定这条线路有多快 */
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

/* 每个用例自己装一套 fetch：
 * plan(url, start, end) -> {chunk, delay} */
function installFetch(buf, plan) {
  ctx.fetch = async (url, opt) => {
    const h = (opt && opt.headers) || {};
    const m = String(h.Range || h.range || '').match(/bytes=(\d+)-(\d+)/);
    const start = m ? Number(m[1]) : 0;
    const end = m ? Number(m[2]) : buf.length - 1;
    fetched.push(url);
    const p = plan(url, start, end);
    return new Response(serve(buf, start, end, p.chunk, p.delay, opt && opt.signal), {
      status: 206,
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': 'bytes ' + start + '-' + end + '/' + buf.length
      }
    });
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitDone(limit = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve({ timeout: true }), limit);
    const watch = setInterval(() => {
      const done = msgs.find((m) => m.type === 'seg-done' || m.type === 'seg-error');
      if (done) { clearInterval(watch); clearTimeout(timer); resolve(done); }
    }, 20);
  });
}

function reset() { msgs.length = 0; fetched.length = 0; }

function send(msg) {
  reset();
  listener(msg, {}, () => {});
  return waitDone();
}

async function readBlob(url) {
  const res = await fetch(url);
  return new Uint8Array(await res.arrayBuffer());
}

function sameBytes(a, b) {
  if (a.length !== b.length) return '长度 ' + a.length + ' vs ' + b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return '第 ' + i + ' 字节不同';
  return '';
}

/* ---------- 1. 整体换线：下到一半切到另一条线路，内容不能坏 ---------- */
console.log('\n[1] seg-rotate：慢线换到快线，已下字节保留');
{
  const buf = pattern(SIZE_A);
  installFetch(buf, (url, s, e) => (url.includes('slow')
    ? { chunk: 16 * 1024, delay: 40 }     // ≈400KB/s
    : { chunk: 64 * 1024, delay: 3 }));
  reset();
  listener({
    target: 'offscreen', type: 'seg-start', id: 'job1', size: SIZE_A,
    url: 'https://slow.test/f.bin',
    urls: ['https://slow.test/f.bin', 'https://fast.test/f.bin'],
    threads: 3
  }, {}, () => {});
  await sleep(250);
  listener({ target: 'offscreen', type: 'seg-rotate', id: 'job1', toUrl: 'https://fast.test/f.bin' }, {}, () => {});
  const done = await waitDone();
  ok('任务完成（没报错）', done.type === 'seg-done', JSON.stringify(done));
  ok('总大小正确', done.total === SIZE_A, String(done.total));

  const before = msgs.filter((m) => m.type === 'seg-progress').map((m) => m.received);
  ok('进度没有倒退', before.every((v, i) => i === 0 || v >= before[i - 1]), before.join(','));

  const bytes = await readBlob(done.url);
  ok('拼出来的文件与原始内容一致', sameBytes(bytes, buf) === '', sameBytes(bytes, buf));
  ok('确实用到了两条线路', new Set(fetched).size >= 2, [...new Set(fetched)].join(' '));
}

/* ---------- 2. 掉队救援：只有一片慢，它自己换线 ---------- */
console.log('\n[2] 落后分片单独换线（不用整条任务重来）');
{
  const buf = pattern(SIZE_B);
  const SLOW_FROM = 1536 * 1024;   // 最后一片的起点
  installFetch(buf, (url, s) => {
    if (url.includes('mix') && s >= SLOW_FROM) return { chunk: 4096, delay: 60 };  // ≈68KB/s
    return { chunk: 64 * 1024, delay: 3 };
  });
  const t0 = Date.now();
  const done = await send({
    target: 'offscreen', type: 'seg-start', id: 'job2', size: SIZE_B,
    url: 'https://mix.test/f.bin',
    urls: ['https://mix.test/f.bin', 'https://fast.test/f.bin'],
    threads: 4
  });
  const spent = Date.now() - t0;
  ok('任务完成', done.type === 'seg-done', JSON.stringify(done));
  const bytes = await readBlob(done.url);
  ok('内容仍然正确（换线没丢字节）', sameBytes(bytes, buf) === '', sameBytes(bytes, buf));
  ok('确实换到了第二条线路', fetched.some((u) => u.includes('fast.test')), [...new Set(fetched)].join(' '));
  ok('没有死等慢片（20 秒内完成）', spent < 20000, spent + 'ms');
}

/* ---------- 3. seg-rotate 不该影响已暂停的任务 ---------- */
console.log('\n[3] 暂停/继续之后仍能换线');
{
  const buf = pattern(1024 * 1024);
  installFetch(buf, (url) => (url.includes('slow')
    ? { chunk: 16 * 1024, delay: 30 }
    : { chunk: 64 * 1024, delay: 3 }));
  const id = 'job3';
  reset();
  listener({
    target: 'offscreen', type: 'seg-start', id, size: buf.length,
    url: 'https://slow.test/f.bin',
    urls: ['https://slow.test/f.bin', 'https://fast.test/f.bin'],
    threads: 2
  }, {}, () => {});
  const p = waitDone();
  await new Promise((r) => setTimeout(r, 150));
  listener({ target: 'offscreen', type: 'seg-pause', id }, {}, () => {});
  await new Promise((r) => setTimeout(r, 300));
  listener({ target: 'offscreen', type: 'seg-resume', id }, {}, () => {});
  listener({ target: 'offscreen', type: 'seg-rotate', id, toUrl: 'https://fast.test/f.bin' }, {}, () => {});
  const done = await p;
  ok('恢复后完成', done.type === 'seg-done', JSON.stringify(done));
  const bytes = await readBlob(done.url);
  ok('内容正确', sameBytes(bytes, buf) === '', sameBytes(bytes, buf));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
