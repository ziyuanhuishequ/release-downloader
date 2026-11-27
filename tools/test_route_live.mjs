/* 真机端到端：测速分类 → 选线 → 实际下载速度
 * 关注两件事：① 慢的直连不会再把镜像顶掉；② 分片/换线确实在跑。 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve('extension');
const exe = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghdl-live-'));

const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: exe, headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/src/popup.html`);
await page.waitForTimeout(1200);
const send = (msg) => page.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, (res) => r(res))), msg);

const url = 'https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-musl_0.26.1_arm64.deb';

console.log('=== 测速（真实网络） ===');
const pr = await send({ type: 'probe', url, force: true });
const list = (pr && pr.list) || [];
const fmt = (n) => (n > 1024 * 1024 ? (n / 1048576).toFixed(1) + 'MB/s' : Math.round(n / 1024) + 'KB/s');
list.forEach((r) => {
  const txt = r.ok ? fmt(r.bps) : (r.err === 'cors' ? '测速受限(可达)' : r.err === 'dead' ? '连不上' : r.err === 'timeout' ? '超时' : 'HTTP ' + r.code);
  console.log('  ' + (r.name || '直连').padEnd(18) + txt);
});
console.log('可测速 ' + (pr.okCount || 0) + ' 条 / 测速受限 ' + (pr.blocked || 0) + ' 条');

console.log('\n=== 入队并按新逻辑选线 ===');
await send({ type: 'enqueue', items: [{ url, asset: 'live-route-test.deb' }] });
let snap = null;
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(1000);
  const st = await send({ type: 'state' });
  const t = (st.tasks || [])[0];
  if (!t) { console.log('任务不见了'); break; }
  console.log(`[${i + 1}s] ${t.status} route=${t.route || '-'} segmented=${!!t.segmented} recv=${t.received || 0} speed=${fmt(t.speed || 0)}`);
  snap = t;
  if (t.status === 'failed' || t.status === 'done') break;
}
if (snap) await send({ type: 'cancel-task', id: snap.id });
await page.waitForTimeout(600);

// 清理
const dl = path.join(os.homedir(), 'Downloads');
if (fs.existsSync(dl)) {
  for (const f of fs.readdirSync(dl)) {
    if (f.toLowerCase().includes('live-route-test')) {
      try { fs.rmSync(path.join(dl, f), { force: true }); } catch (e) {}
    }
  }
}
await ctx.close();
