import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve('extension');
const exe = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghdl-prof-'));

const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: exe,
  headless: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check'
  ]
});

let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
console.log('ext id', extId);

sw.on('console', (m) => console.log('[sw]', m.type(), m.text().slice(0, 300)));
sw.on('close', () => console.log('!! service worker 关闭了'));

const page = await ctx.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() !== 'log') logs.push(m.type() + ': ' + m.text().slice(0, 200)); });

await page.goto(`chrome-extension://${extId}/src/popup.html`);
await page.waitForTimeout(1500);

// 1) 点「GitHub 国内访问」开关
console.log('--- 点开关 ---');
await page.click('#btnBoost');
await page.waitForTimeout(6000);
console.log('开关后 boostTip:', await page.textContent('#boostTip').catch(() => '(无)'));
console.log('开关后 boost 行文本:', (await page.textContent('#boost').catch(() => '')).replace(/\s+/g, ' '));

// 2) 检查 SW 是否还活着
console.log('SW 仍存活:', ctx.serviceWorkers().length > 0);

// 3) 输入仓库并扫描
console.log('--- 扫描 ---');
const input = await page.$('input[type="text"]');
if (input) {
  await input.fill('sharkdp/bat');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(15000);
}
const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
console.log('扫描后文本前 500:', body.slice(0, 500));
console.log('页面是否有连接错误:', /Could not establish|Receiving end/i.test(body) ? '有' : '没有');
console.log('是否误报后台未启动横幅:', await page.$('#bgBanner') ? '误报了（不该出现）' : '没有（正常）');
console.log('后台探活:', JSON.stringify(await page.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: 'ping' }, r)))));
console.log('错误日志:', logs.length ? logs.slice(0, 10) : '无');

await ctx.close();
