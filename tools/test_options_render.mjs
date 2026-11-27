/* 打开设置页，确认线路列表能正常渲染（含「冷却 X 分」文案）且没有报错 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXT = path.resolve('extension');
const exe = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1255/chrome-win64/chrome.exe');
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ghdl-opt-'));

const ctx = await chromium.launchPersistentContext(userDir, {
  executablePath: exe, headless: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run']
});
const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
const extId = new URL(sw.url()).host;
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto(`chrome-extension://${extId}/src/options.html`);
await page.waitForTimeout(2500);

const rows = await page.evaluate(() => {
  const box = document.getElementById('routeList');
  if (!box) return null;
  return Array.from(box.querySelectorAll('.rline')).slice(0, 6).map((el) => el.textContent.replace(/\s+/g, ' ').trim());
});
console.log('线路列表前几行：');
(rows || []).forEach((r) => console.log('  ' + r));
console.log('页面报错：', errs.length ? errs.join(' | ') : '无');
const ver = await page.evaluate(() => chrome.runtime.getManifest().version);
console.log('清单版本：', ver);
await ctx.close();
process.exit(errs.length ? 1 : 0);
