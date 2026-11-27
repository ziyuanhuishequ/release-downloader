/* 线路挑选 & 换线的回归测试
 *
 * 复现用户截图里的场景：直连被测到 518 B/s，19 条镜像全部「测不出速度」。
 * 旧逻辑只把「测速成功」的线路放前面 → 直连永远第一 → 一直卡在 30KB/s。
 */
import fs from 'fs';
import vm from 'vm';

const noop = () => {};
const store = {};
const canceled = [];
const chrome = {
  runtime: {
    onMessage: { addListener: noop }, onInstalled: { addListener: noop },
    onStartup: { addListener: noop }, lastError: null, getManifest: () => ({ version: '1.4.5' }),
    sendMessage: noop, openOptionsPage: noop, getURL: (p) => 'chrome-extension://x/' + p
  },
  storage: {
    local: {
      get: async (k) => {
        if (typeof k === 'string') return { [k]: store[k] };
        const out = {};
        (Array.isArray(k) ? k : Object.keys(k || {})).forEach((x) => { if (store[x] !== undefined) out[x] = store[x]; });
        return out;
      },
      set: async (o) => { Object.assign(store, o); },
      remove: async (k) => { delete store[k]; }
    },
    session: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: noop }
  },
  action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
  downloads: {
    onChanged: { addListener: noop }, onCreated: { addListener: noop },
    search: noop, download: async () => 1,
    cancel: (id, cb) => { canceled.push(id); if (cb) cb(); },
    pause: noop, resume: noop, erase: (q, cb) => { if (cb) cb(); }
  },
  notifications: { create: noop },
  permissions: { contains: async () => true, request: async () => true },
  tabs: { query: async () => [], create: noop, update: noop },
  contextMenus: { removeAll: noop, create: noop, onClicked: { addListener: noop } },
  declarativeNetRequest: { updateDynamicRules: async () => ({}) },
  scripting: { getRegisteredContentScripts: async () => [], unregisterContentScripts: async () => {}, registerContentScripts: async () => {} }
};

const ctx = {
  chrome, console,
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
  setInterval: () => 0, clearInterval: noop,
  AbortController, TextDecoder, Response, Headers, Request, URL, performance,
  importScripts: noop
};
ctx.globalThis = ctx;
ctx.self = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync('extension/src/common.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync('extension/src/bg.js', 'utf8'), ctx);

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

const settings = Object.assign({}, ctx.DEFAULT_SETTINGS, { autoProbe: false, extraRoutes: [] });
ctx.settingsCache = settings;
const all = ctx.allRoutes(settings);
const mirrors = all.filter((r) => r.prefix);
const DIRECT = '';

/* 把「这次的测速结果」塞进缓存：routesForFile 在 autoProbe=false 时读它 */
function setProbe(list) {
  ctx.probeCache = { key: 'test', ts: Date.now(), list, probeUrl: '', okCount: list.filter((r) => r.ok).length,
    blocked: list.filter((r) => !r.ok && r.err === 'cors').length };
}
const okRoute = (r, bps) => ({ name: r.name, prefix: r.prefix, ok: true, bps, ms: 100, code: 206, bytes: 98304 });
const badRoute = (r, err) => ({ name: r.name, prefix: r.prefix, ok: false, err, ms: 60 });

/* ---------- 1. 直连很慢 + 镜像测不出速度 ---------- */
console.log('\n[1] 直连 518B/s、镜像测不出速度（用户截图场景）');
{
  const list = all.map((r) => (r.prefix ? badRoute(r, 'cors') : okRoute(r, 518)));
  setProbe(list);
  const order = await ctx.routesForFile('https://github.com/a/b/releases/download/v1/x.bin', settings);
  ok('第一条不再是「直连」', order[0].prefix !== DIRECT, '第一条=' + order[0].name);
  ok('先试镜像', order[0].prefix === 'https://gh-proxy.com/', order[0].prefix);
  const di = order.findIndex((r) => r.prefix === DIRECT);
  ok('直连被排到所有镜像之后', di >= mirrors.length, '直连位置=' + di + ' / 镜像数=' + mirrors.length);
  ok('线路总数没丢', order.length === all.length, order.length + ' vs ' + all.length);
}

/* ---------- 2. 直连真的快 ---------- */
console.log('\n[2] 直连 3MB/s（境外/代理环境）');
{
  const list = all.map((r) => (r.prefix ? badRoute(r, 'cors') : okRoute(r, 3 * 1024 * 1024)));
  setProbe(list);
  const order = await ctx.routesForFile('https://github.com/a/b/releases/download/v1/x.bin', settings);
  ok('直连仍然排第一（不该为了镜像牺牲本来就快的直连）', order[0].prefix === DIRECT, order[0].name);
}

/* ---------- 3. 镜像确实连不上 ---------- */
console.log('\n[3] 镜像全是「连不上」，直连虽慢但能用');
{
  const list = all.map((r) => (r.prefix ? badRoute(r, 'dead') : okRoute(r, 518)));
  setProbe(list);
  const order = await ctx.routesForFile('https://github.com/a/b/releases/download/v1/x.bin', settings);
  ok('直连排第一，不去挨个撞死掉的镜像', order[0].prefix === DIRECT, order[0].name);
  ok('连不上的排最后', order[order.length - 1].prefix !== DIRECT, order[order.length - 1].name);
}

/* ---------- 4. 测速失败的两种含义 ---------- */
console.log('\n[4] 区分「跨域受限」和「域名真连不上」');
{
  // ① fetch(TypeError) → no-cors 能拿到响应：镜像没开跨域，但网络可达
  ctx.fetch = async (url, opt) => {
    if (opt && opt.mode === 'no-cors') return new Response('', { status: 200 });
    throw new TypeError('Failed to fetch');
  };
  const r1 = await ctx.probeOne({ name: 'm', prefix: 'https://gh-proxy.com/' }, 'https://github.com/a/x');
  ok('no-cors 能通 → 记为 cors（下载仍可用）', r1.err === 'cors', JSON.stringify(r1));

  // ② 两种都失败：域名/DNS 层就不通
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const r2 = await ctx.probeOne({ name: 'm', prefix: 'https://gh.hk/' }, 'https://github.com/a/x');
  ok('两种都不通 → 记为 dead（连不上）', r2.err === 'dead', JSON.stringify(r2));

  // ③ 能读到字节就正常算速度
  ctx.fetch = async () => new Response(new Uint8Array(98304), { status: 206, headers: { 'content-type': 'application/octet-stream' } });
  const r3 = await ctx.probeOne({ name: 'm', prefix: 'https://gh-proxy.org/' }, 'https://github.com/a/x');
  ok('读得到数据就按实测速度返回', r3.ok && r3.bps > 0, JSON.stringify(r3));
}

/* ---------- 5. 慢线自动换线（而且是连续换，不只换一次） ---------- */
console.log('\n[5] 慢线自动换线');
{
  const list = all.map((r) => (r.prefix ? badRoute(r, 'cors') : okRoute(r, 518)));
  setProbe(list);
  const task = {
    id: 't1', url: 'https://github.com/a/b/releases/download/v1/x.bin', path: 'x.bin',
    status: 'downloading', speed: 20 * 1024, bestSpeed: 22 * 1024, received: 200 * 1024,
    total: 40 * 1024 * 1024, size: 40 * 1024 * 1024,
    routePrefix: DIRECT, routeIdx: 0, routeTries: 0, slowSince: Date.now() - 6000
  };
  ctx.tasks.length = 0;
  ctx.tasks.push(task);
  ctx.judgeSlow(task);
  await new Promise((r) => globalThis.setTimeout(r, 60));
  ok('5.5 秒没起色就换线（不用再等 50 秒）', task.routeTries === 1, 'routeTries=' + task.routeTries);
  ok('换到的是下一条没试过的线路', task.routeIdx === 1, 'routeIdx=' + task.routeIdx);
  ok('任务换到新线路上重新开始', task.routePrefix !== DIRECT, '当前线路=' + (task.routePrefix || '直连'));
  ok('任务没有失败', task.status !== 'failed', task.status);
  ok('没停错下载（本来就没有 downloadId）', canceled.length === 0, canceled.join());

  // 换满 6 次后不再无限换（20 条死线也不会绕一整天）
  task.routeTries = 6;
  task.status = 'downloading';
  task.slowSince = Date.now() - 30000;
  ctx.judgeSlow(task);
  await new Promise((r) => globalThis.setTimeout(r, 40));
  ok('换满 6 次后收手', task.routeTries === 6, 'routeTries=' + task.routeTries);
}

/* ---------- 6. 手工指定线路仍然优先 ---------- */
console.log('\n[6] 手动固定线路优先');
{
  const list = all.map((r) => (r.prefix ? okRoute(r, 200 * 1024) : okRoute(r, 518)));
  setProbe(list);
  const s2 = Object.assign({}, settings, { preferRoute: '@direct' });
  const order = await ctx.routesForFile('https://github.com/a/b/releases/download/v1/x.bin', s2);
  ok('用户固定直连时直连第一', order[0].prefix === DIRECT, order[0].name);
}

/* ---------- 7. 冷却与历史统计 ---------- */
console.log('\n[7] 冷却时长与历史统计');
{
  const tick = () => new Promise((r) => globalThis.setTimeout(r, 30));

  // 7.1 测速失败不该记进「历史失败」
  store.routeStats = {}; store.routeStatsVer = 2; ctx.routeStats = {};
  ctx.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await ctx.probeRoutes('https://github.com/a/b/releases/download/v1/p.bin', 'pick-1', true);
  const st = await ctx.loadStats();
  ok('测速失败不再写进历史', Object.keys(st).length === 0, JSON.stringify(st));

  // 7.2 真下载失败：第一次不冷却，连续两次才冷却 5 分钟
  const P = 'https://gh-proxy.com/';
  ctx.badUntil.delete(P);
  ctx.routeStats[P] = { ok: 0, fail: 0, sumBps: 0 };
  ctx.noteRoute(P, false, 0); await tick();
  ok('失败 1 次不冷却（偶发抖动不锁线路）', !ctx.badUntil.get(P), String(ctx.badUntil.get(P) || 0));
  ctx.noteRoute(P, false, 0); await tick();
  const left1 = (ctx.badUntil.get(P) - Date.now()) / 60000;
  ok('连续失败 2 次冷却 5 分钟', left1 > 4.4 && left1 <= 5.1, left1.toFixed(2) + ' 分');

  // 7.3 失败越多冷却越久，但最多 10 分钟
  ctx.routeStats[P] = { ok: 0, fail: 4, sumBps: 0, failStreak: 4 };
  ctx.noteRoute(P, false, 0); await tick();
  const left2 = (ctx.badUntil.get(P) - Date.now()) / 60000;
  ok('冷却封顶 10 分钟', left2 <= 10.1, left2.toFixed(2) + ' 分');

  // 7.4 成功一次立刻解除冷却
  ctx.noteRoute(P, true, 300 * 1024); await tick();
  ok('成功一次即解除冷却', !ctx.badUntil.get(P), String(ctx.badUntil.get(P) || 0));

  // 7.5 旧版被污染的数据自动清一次（「3败」其实是 3 次测速）
  store.routeStats = { 'https://ghfast.top/': { ok: 0, fail: 3, sumBps: 0 } };
  delete store.routeStatsVer;
  ctx.routeStats = null;
  const migrated = await ctx.loadStats();
  ok('旧统计自动清空', Object.keys(migrated).length === 0, JSON.stringify(migrated));
  ok('清空后写入新版本号', store.routeStatsVer === 2, String(store.routeStatsVer));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
