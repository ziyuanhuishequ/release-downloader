/* 归档路径 + 体积解析的回归测试
 *
 * 用户截图（qianyiai/KuroCat v5.1.3）暴露了两件事：
 *   1. 面板把 sha256 摘要里的 "…637b…" 当成体积，77.8MB 的 AppImage 显示成 9 KB；
 *   2. 下载后先建 "GitHub/owner/repo/tag/" 四级目录，用户想要「项目名/系统/文件」。
 */
import fs from 'fs';
import vm from 'vm';

const noop = () => {};
const chrome = {
  runtime: {
    onMessage: { addListener: noop }, onInstalled: { addListener: noop },
    onStartup: { addListener: noop }, lastError: null, getManifest: () => ({ version: '1.4.7' }),
    sendMessage: noop, openOptionsPage: noop, getURL: (p) => 'chrome-extension://x/' + p
  },
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    session: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: noop }
  }
};

const ctx = { chrome, console, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, URL, AbortController };
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('extension/src/common.js', 'utf8'), ctx);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 真实资源名（KuroCat v5.1.3） */
const ASSETS = [
  'KuroCat-5.1.3-x64-setup.exe',
  'KuroCat-v5.1.3-android.apk',
  'KuroCat-v5.1.3-linux-amd64.AppImage',
  'KuroCat-v5.1.3-linux-amd64.deb',
  'KuroCat-v5.1.3-linux-arm64.AppImage',
  'KuroCat-v5.1.3-linux-arm64.deb',
  'KuroCat-v5.1.3-macos-universal.app.tar.gz',
  'KuroCat-v5.1.3-macos-universal.dmg',
  'KuroCat-v5.1.3-win7-x64-portable.zip',
  'KuroCat-v5.1.3-win7-x86-portable.zip'
];

console.log('\n[1] 平台识别');
{
  const want = {
    'KuroCat-5.1.3-x64-setup.exe': 'win',
    'KuroCat-v5.1.3-android.apk': 'android',
    'KuroCat-v5.1.3-linux-amd64.AppImage': 'linux',
    'KuroCat-v5.1.3-linux-amd64.deb': 'linux',
    'KuroCat-v5.1.3-linux-arm64.AppImage': 'linux',
    'KuroCat-v5.1.3-linux-arm64.deb': 'linux',
    'KuroCat-v5.1.3-macos-universal.app.tar.gz': 'mac',
    'KuroCat-v5.1.3-macos-universal.dmg': 'mac',
    'KuroCat-v5.1.3-win7-x64-portable.zip': 'win',
    'KuroCat-v5.1.3-win7-x86-portable.zip': 'win'
  };
  Object.keys(want).forEach((n) => {
    const got = ctx.platformOf(n);
    ok(n + ' → ' + want[n], got === want[n], got);
  });
  ok('darwin 不会被认成 win', ctx.platformOf('tool-darwin-arm64.tar.gz') === 'mac', ctx.platformOf('tool-darwin-arm64.tar.gz'));
  ok('源码包单独归为 src（不进系统文件夹）', ctx.platformOf('bat-v0.24.0.tar.gz') === 'src', ctx.platformOf('bat-v0.24.0.tar.gz'));
}

console.log('\n[2] 归档路径：项目名/系统/文件名');
{
  const s = { subfolder: true };
  ASSETS.forEach((name) => {
    const p = ctx.buildPath({ owner: 'qianyiai', repo: 'KuroCat', tag: 'v5.1.3', asset: name }, s);
    const dir = { win: 'Windows', mac: 'macOS', linux: 'Linux', android: 'Android' }[ctx.platformOf(name)];
    const want = 'KuroCat/' + dir + '/' + name;
    ok(p, p === want, p);
  });
  const flat = ctx.buildPath({ owner: 'qianyiai', repo: 'KuroCat', tag: 'v5.1.3', asset: ASSETS[0] }, { subfolder: false });
  ok('关掉归档就平铺', flat === ASSETS[0], flat);
  const noRepo = ctx.buildPath({ asset: 'a.exe' }, { subfolder: true });
  ok('没有仓库名时不至于生成空目录', noRepo === 'GitHub/Windows/a.exe', noRepo);
}

console.log('\n[3] 体积解析：不能把 sha256 摘要当字节数');
{
  const digests = [
    'sha256:aea87e3e7ee0cc8deaafcac2ed9d69c0587d41797f441a2f842724a4e1bb47df',
    'sha256:87594264793c3a37b8bb1f66a7ad8f6c6fc14f0bc0f6f3c9bd0b2cd0e0db9c6a',
    'sha256:62905f1627c86415d3c0e1fbd53032e8c4a6a9c0f5b0a1f7e1c9b2f0d6a4e3c1'
  ];
  digests.forEach((d) => {
    ok('摘要不当体积：' + d.slice(7, 19) + '…', ctx.parseSizeText(d) === 0, ctx.parseSizeText(d) + ' B');
  });
  const cases = [
    ['2.4 MB', 2516582],
    ['77.8 MB', 81579213],
    ['179 MB', 187695104],
    ['5.17 MB', 5421138],
    ['637 B', 637],
    ['1.2GB', 1288490189]
  ];
  cases.forEach(([t, want]) => {
    const got = ctx.parseSizeText(t);
    ok('"' + t + '"', Math.abs(got - want) <= 1, got + ' vs ' + want);
  });
  ok('普通文本不返回垃圾值', ctx.parseSizeText('Source code (zip)') === 0, ctx.parseSizeText('Source code (zip)'));
}

console.log('\n' + (fail ? '❌ ' : '✅ ') + 'pass ' + pass + ' / fail ' + fail);
process.exit(fail ? 1 : 0);
