/* 面板体积显示 + 下载路径的现场复现（qianyiai/KuroCat v5.1.3）
 *
 * 现场：API 被限流 → 退回读页面 DOM；页面每行第一个 .color-fg-muted 是
 * sha256 摘要，旧代码把它当体积，77.8MB 的 AppImage 显示成 9 KB。
 * 同时确认下载路径是「项目名/系统/文件名」，不再建 GitHub/owner/repo/tag。
 */
import fs from 'fs';
import { JSDOM } from 'jsdom';

const SRC = (f) => fs.readFileSync('extension/src/' + f, 'utf8');

/* 照 GitHub 现在的资源行结构写：链接 → 摘要 → 体积 */
function row(name, digest, size) {
  return `<div class="Box-row d-flex">
    <div class="col-12 col-lg-6"><span class="d-flex">
      <a href="/qianyiai/KuroCat/releases/download/v5.1.3/${name}"><span class="text-bold">${name}</span></a>
    </span></div>
    <div class="col-md-6">
      <span class="Truncate text-mono text-small color-fg-muted"><span class="Truncate-text">sha256:${digest}</span></span>
      <span class="color-fg-muted text-right flex-shrink-0">${size}</span>
    </div>
  </div>`;
}

const HTML = `<!doctype html><html><head><title>Release · qianyiai/KuroCat</title></head><body>
${row('KuroCat-v5.1.3-linux-amd64.AppImage', 'aea87e3e7ee0cc8deaafcac2ed9d69c0587d41797f441a2f842724a4e1bb47df', '77.8 MB')}
${row('KuroCat-v5.1.3-win7-x64-portable.zip', 'af9848cd0d108cd6e97f735f883e0e6c1f9b2b0f7d3f4c4e2d1a6f7a8b9c0d1e', '179 MB')}
${row('KuroCat-v5.1.3-android.apk', '87594264793c3a37b8bd1f66a7ad8f6c6fc14f0bc0f6f3c9bd0b2cd0e0db9c6a', '5.17 MB')}
${row('KuroCat-v5.1.3-macos-universal.dmg', '2e42bb1f2701725a93b1e74bb66e5a1c0b6b4d3b0d9e0b8c1e7f2a3d4c5b6a7f', '6.57 MB')}
</body></html>`;

const dom = new JSDOM(HTML, { url: 'https://github.com/qianyiai/KuroCat/releases/tag/v5.1.3', pretendToBeVisual: true, runScripts: 'outside-only' });
const w = dom.window;
const calls = { enqueue: [] };
w.chrome = {
  runtime: {
    lastError: null, id: 'x',
    onMessage: { addListener: () => {} },
    getManifest: () => ({ version: '1.4.7' }),
    sendMessage: (msg, cb) => {
      if (msg.type === 'enqueue') calls.enqueue.push(msg.items);
      // list-assets 故意不回 release：模拟匿名额度用完，走 DOM 兜底
      const res = msg.type === 'enqueue' ? { added: (msg.items || []).length, blocked: 0, pending: 1 }
        : msg.type === 'state' ? { tasks: [], histVer: 0 }
          : msg.type === 'history' ? { hist: {}, ver: 0 }
            : msg.type === 'probe' ? { blocked: true, list: [] }
              : { ok: true };
      setTimeout(() => cb && cb(res), 0);
    }
  },
  storage: {
    local: {
      get: async (k) => (typeof k === 'string' ? { [k]: { subfolder: true } } : {}),
      set: async () => {}
    }
  }
};
w.eval(SRC('common.js'));
w.eval(SRC('content.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 120));

await tick(300);
const sr = w.document.getElementById('ghdl-host').shadowRoot;
const fab = sr.getElementById('fab');
if (fab) { fab.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await tick(200); }
const text = sr.textContent || '';

console.log('\n[1] 体积显示（API 限流，走页面兜底）');
ok('77.8 MB 的 AppImage 显示 77.8 MB', /77\.8 MB/.test(text), text.slice(0, 120));
ok('179 MB 的便携包里显示 179 MB', /179 MB/.test(text));
ok('5.17 MB 的 apk 显示 5.2 MB', /5\.2 MB/.test(text));
ok('6.57 MB 的 dmg 显示 6.6 MB', /6\.6 MB/.test(text));
ok('不再出现「1 B / 637 B / 9 KB」这种摘要残渣', !/\b(1 B|637 B|9 KB|148 B|42 B)\b/.test(text), text.slice(0, 200));

console.log('\n[2] 下载路径');
const go = sr.getElementById('go');
go.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await tick(250);
const items = calls.enqueue[0] || [];
const byName = {};
items.forEach((it) => { byName[it.asset] = it.path; });
ok('拿到 4 个任务', items.length === 4, String(items.length));
ok('Linux 装进 KuroCat/Linux/', byName['KuroCat-v5.1.3-linux-amd64.AppImage'] === 'KuroCat/Linux/KuroCat-v5.1.3-linux-amd64.AppImage',
  byName['KuroCat-v5.1.3-linux-amd64.AppImage']);
ok('Windows 装进 KuroCat/Windows/', byName['KuroCat-v5.1.3-win7-x64-portable.zip'] === 'KuroCat/Windows/KuroCat-v5.1.3-win7-x64-portable.zip',
  byName['KuroCat-v5.1.3-win7-x64-portable.zip']);
ok('安卓装进 KuroCat/Android/', byName['KuroCat-v5.1.3-android.apk'] === 'KuroCat/Android/KuroCat-v5.1.3-android.apk',
  byName['KuroCat-v5.1.3-android.apk']);
ok('macOS 装进 KuroCat/macOS/', byName['KuroCat-v5.1.3-macos-universal.dmg'] === 'KuroCat/macOS/KuroCat-v5.1.3-macos-universal.dmg',
  byName['KuroCat-v5.1.3-macos-universal.dmg']);
ok('不再有 GitHub/owner/repo/tag 四级目录', items.every((it) => !/^GitHub\//.test(it.path || '')), JSON.stringify(byName));
ok('体积一起带给后台（不用重新探）', items.every((it) => it.size > 4 * 1024 * 1024), JSON.stringify(items.map((i) => i.size)));

console.log('\n' + (fail ? '❌ ' : '✅ ') + 'pass ' + pass + ' / fail ' + fail);
w.close();
process.exit(fail ? 1 : 0);
