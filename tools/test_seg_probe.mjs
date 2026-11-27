/* 验证「从镜像页点文件名」这类只有 URL、没有 size 的任务：
 * 后台应自己探出大小，并切换到分片（多线程）下载，而不是单连接。 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve('extension');
const exe = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghdl-seg-'));

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

// 和 mirror.js 拦截后入队的形状完全一致：只有 url + asset，没有 size
const url = 'https://github.com/sharkdp/bat/releases/download/v0.26.1/bat-v0.26.1-x86_64-pc-windows-msvc.zip';
console.log('入队（不带 size）…');
console.log('enqueue =>', JSON.stringify(await send({ type: 'enqueue', items: [{ url, asset: 'seg-probe-test.zip' }] })));

let snap = null;
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1000);
  const st = await send({ type: 'state' });
  const t = (st.tasks || [])[0];
  if (!t) { console.log('任务丢了？'); break; }
  console.log(`[${i + 1}s] status=${t.status} size=${t.size || 0} segmented=${!!t.segmented} route=${t.route || '-'} recv=${t.received || 0}`);
  snap = t;
  if (t.segmented && t.received > 0) break;
  if (t.status === 'failed' || t.status === 'done') break;
}

const sizeOK = snap && (snap.size || 0) > 1024 * 1024;
const segOK = snap && !!snap.segmented;
console.log('\n结论：大小探测', sizeOK ? '成功' : '失败', '| 多线程分片', segOK ? '已启用' : '仍是单线程');

if (snap) { await send({ type: 'cancel-task', id: snap.id }); }
await page.waitForTimeout(800);

// 清理测试产生的文件
const dl = path.join(os.homedir(), 'Downloads', 'GitHub');
if (fs.existsSync(dl)) {
  for (const walk of fs.readdirSync(dl)) {
    const p = path.join(dl, walk);
    if (p.toLowerCase().includes('bat')) {
      try { fs.rmSync(p, { recursive: true, force: true }); console.log('已清理测试文件:', p); } catch (e) {}
    }
  }
}

await ctx.close();
process.exit(sizeOK && segOK ? 0 : 1);
