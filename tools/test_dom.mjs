/* 用 jsdom 真跑一遍「镜像页点下载」的完整链路：
 *   mirror.js 的点击拦截 → content.js 的事件接收 → 归一化成 github 地址入队
 * 这一步没法用纯逻辑测试覆盖（涉及事件传递顺序、shadow DOM、ack 握手），
 * 也是这次「点下载还是走镜像慢速直连」的直接现场。
 */
import fs from 'fs';
import { JSDOM } from 'jsdom';

const SRC = (f) => fs.readFileSync('extension/src/' + f, 'utf8');

const HTML = `<!doctype html><html data-color-mode="light"><head><title>Release · octocat/Hello-World</title></head><body>
  <div class="Box-row"><a class="a1" href="/octocat/Hello-World/releases/download/v1.0.0/app.zip">app.zip</a></div>
  <div class="Box-row"><a class="a2" href="https://github.com/octocat/Hello-World/releases/download/v1.0.0/tool.tar.gz">tool.tar.gz</a></div>
  <a class="other" href="/octocat/Hello-World/issues">Issues</a>
</body></html>`;

function boot(url, withContent) {
  const dom = new JSDOM(HTML, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const w = dom.window;
  const calls = { enqueue: [] };
  const store = { settings: { ghBoost: true, ghSite: 'https://gh-proxy.at9.net', subfolder: true, threads: 4 } };
  w.chrome = {
    runtime: {
      lastError: null,
      id: 'x',
      onMessage: { addListener: () => {} },
      getManifest: () => ({ version: '1.4.1' }),
      sendMessage: (msg, cb) => {
        if (msg.type === 'enqueue') calls.enqueue.push(msg.items);
        const res =
          msg.type === 'enqueue' ? { added: (msg.items || []).length, blocked: 0, pending: 1 }
            : msg.type === 'state' ? { tasks: [], histVer: 0 }
              : msg.type === 'history' ? { hist: {}, ver: 0 }
                : msg.type === 'probe' ? { list: [] }
                  : { ok: true };
        setTimeout(() => cb && cb(res), 0);
      }
    },
    storage: {
      local: {
        get: async (k) => (typeof k === 'string' ? { [k]: store[k] } : {}),
        set: async (o) => { Object.assign(store, o); }
      }
    }
  };
  w.eval(SRC('common.js'));
  if (withContent) w.eval(SRC('content.js'));
  w.eval(SRC('mirror.js'));
  return { dom, w, calls };
}

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 60));

/* ---------- 1. path 型镜像（at9）：点相对路径的下载链接 ---------- */
console.log('\n[1] path 型镜像 · 点 release 文件');
{
  const { w, calls } = boot('https://gh-proxy.at9.net/octocat/Hello-World/releases/tag/v1.0.0', true);
  const a = w.document.querySelector('a.a1');
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  const notPrevented = a.dispatchEvent(ev);
  ok('拦下了默认跳转（不会落到镜像直连）', ev.defaultPrevented && notPrevented === false, 'defaultPrevented=' + ev.defaultPrevented);
  await tick();
  const item = calls.enqueue[0] && calls.enqueue[0][0];
  ok('自动入队，且地址换回 github.com',
    item && item.url === 'https://github.com/octocat/Hello-World/releases/download/v1.0.0/app.zip',
    item && item.url);
  ok('带上 owner/repo/tag/文件名', item && item.owner === 'octocat' && item.repo === 'Hello-World' &&
    item.tag === 'v1.0.0' && item.asset === 'app.zip', JSON.stringify(item));
  const sr = w.document.getElementById('ghdl-host').shadowRoot;
  ok('面板打开并给出提示', /已交给加速线路下载/.test(sr.textContent), (sr.textContent || '').slice(0, 80));
  w.close();
}

/* ---------- 2. path 型镜像：写死成 github.com 的绝对链接 ---------- */
console.log('\n[2] path 型镜像 · 绝对链接');
{
  const { w, calls } = boot('https://gh-proxy.at9.net/octocat/Hello-World/releases/tag/v1.0.0', true);
  const a = w.document.querySelector('a.a2');
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  a.dispatchEvent(ev);
  await tick();
  const item = calls.enqueue[0] && calls.enqueue[0][0];
  ok('绝对链接被改写成镜像路径后仍拦得住', ev.defaultPrevented, 'defaultPrevented=' + ev.defaultPrevented);
  ok('地址仍是 github.com（没有套娃）',
    item && item.url === 'https://github.com/octocat/Hello-World/releases/download/v1.0.0/tool.tar.gz',
    item && item.url);
  w.close();
}

/* ---------- 3. 前缀型镜像（cors.isteed） ---------- */
console.log('\n[3] prefix 型镜像');
{
  const { w, calls } = boot('https://cors.isteed.cc/https://github.com/octocat/Hello-World/releases/tag/v1.0.0', true);
  const a = w.document.querySelector('a.a1');
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  a.dispatchEvent(ev);
  await tick();
  const item = calls.enqueue[0] && calls.enqueue[0][0];
  ok('前缀型镜像上也能拦下', ev.defaultPrevented, 'defaultPrevented=' + ev.defaultPrevented);
  ok('前缀型地址还原成 github.com',
    item && item.url === 'https://github.com/octocat/Hello-World/releases/download/v1.0.0/app.zip',
    item && item.url);
  w.close();
}

/* ---------- 4. 中键 ---------- */
console.log('\n[4] 中键点文件');
{
  const { w, calls } = boot('https://gh-proxy.at9.net/octocat/Hello-World/releases/tag/v1.0.0', true);
  const a = w.document.querySelector('a.a1');
  const ev = new w.MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
  a.dispatchEvent(ev);
  await tick();
  ok('中键也被接管（不新开标签慢慢下）', ev.defaultPrevented, 'defaultPrevented=' + ev.defaultPrevented);
  ok('中键同样入队', calls.enqueue.length === 1, JSON.stringify(calls.enqueue));
  w.close();
}

/* ---------- 5. 带修饰键：保留浏览器行为 ---------- */
console.log('\n[5] Ctrl+点击');
{
  const { w, calls } = boot('https://gh-proxy.at9.net/octocat/Hello-World/releases/tag/v1.0.0', true);
  const a = w.document.querySelector('a.a1');
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
  a.dispatchEvent(ev);
  await tick();
  ok('Ctrl+点击 不拦（用户想自己处理）', !ev.defaultPrevented);
  ok('也没有偷偷入队', calls.enqueue.length === 0, JSON.stringify(calls.enqueue));
  w.close();
}

/* ---------- 6. 非 release 链接不受影响 ---------- */
console.log('\n[6] 普通链接');
{
  const { w, calls } = boot('https://gh-proxy.at9.net/octocat/Hello-World/releases/tag/v1.0.0', true);
  const a = w.document.querySelector('a.other');
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  a.dispatchEvent(ev);
  await tick();
  ok('普通链接正常跳转', !ev.defaultPrevented && calls.enqueue.length === 0);
  w.close();
}

/* ---------- 7. 内容脚本没注入时不能把用户点死 ---------- */
console.log('\n[7] 面板不在时的兜底');
{
  const { w, calls } = boot('https://gh-proxy.at9.net/octocat/Hello-World/releases/tag/v1.0.0', false);
  const a = w.document.querySelector('a.a1');
  const ev = new w.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  a.dispatchEvent(ev);
  await tick();
  ok('没人接住就不拦，退回原来的跳转', !ev.defaultPrevented);
  ok('也不会重复入队', calls.enqueue.length === 0);
  w.close();
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
