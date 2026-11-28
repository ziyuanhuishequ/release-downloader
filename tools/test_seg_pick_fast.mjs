/* 换线路 = 选「实测最快」的那条，不是按名单轮着试
 *
 * 旧逻辑（轮换）的问题：管你哪条快，反正按 pool 顺序 next++。
 * 结果 A(2MB/s) 跑几秒就被切到 B(80KB/s)、再切到 C，平均速度被慢线拖死，
 * 而且每条线刚热起来的连接都被打断 —— 用户感受就是「越用越慢」。
 *
 * 这里锁死两条规则：
 *   1) 永远选 segScore 最高的；试过的线路只要实测更快，照样能再次被选中；
 *   2) 没有明显更快的就不换（opt.beat），避免在慢线之间来回跳。
 */
import fs from 'fs';
import vm from 'vm';

const noop = () => {};
const store = {};
const msgs = [];
const chrome = {
  runtime: {
    onMessage: { addListener: noop }, onInstalled: { addListener: noop },
    onStartup: { addListener: noop }, lastError: null, getManifest: () => ({ version: '1.5.1' }),
    sendMessage: (m, cb) => { msgs.push(m); if (cb) cb(); },
    openOptionsPage: noop, getURL: (p) => 'chrome-extension://x/' + p
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
    search: noop, download: async () => 1, cancel: noop, pause: noop, resume: noop, erase: noop
  },
  notifications: { create: noop },
  permissions: { contains: async () => true, request: async () => true },
  tabs: { query: async () => [], create: noop, update: noop },
  contextMenus: { removeAll: noop, create: noop, onClicked: { addListener: noop } },
  declarativeNetRequest: { updateDynamicRules: async () => ({}) },
  scripting: { getRegisteredScripts: async () => [], unregisterContentScripts: async () => {}, registerContentScripts: async () => {} }
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

const KB = 1024;
const mk = (name, prefix, bps) => ({ name, prefix, url: 'https://x.test/' + name });
/* 每条线路的「探测速度」清零，只让 segLive（真实下载表现）说话 */
ctx.probeCache = { key: 't', ts: Date.now(), list: [], probeUrl: '', okCount: 0, blocked: 0 };

function taskWith(pool, cur, live, tried) {
  return {
    id: 't', segmented: true, url: 'https://github.com/a/b/releases/download/v1/x.bin',
    segPool: pool, routePrefix: cur, segLive: live || {}, segTried: tried || [],
    segThreads: 4, routeRotations: 0, speed: 0, bestSpeed: 0
  };
}

/* ---------- 1. 选最快的那条，而不是按顺序下一个 ---------- */
console.log('\n[1] 池子里 A 慢、B 中、C 最快');
{
  const A = mk('A', 'https://a.test/', 80 * KB);
  const B = mk('B', 'https://b.test/', 900 * KB);
  const C = mk('C', 'https://c.test/', 2 * 1024 * KB);
  // 注意 pool 顺序是 A→B→C，轮换逻辑会选 B，最优逻辑必须选 C
  const t = taskWith([A, B, C], A.prefix, { [A.prefix]: 80 * KB, [B.prefix]: 900 * KB, [C.prefix]: 2 * 1024 * KB });
  const next = ctx.pickSegNext(t, null);
  ok('选中实测最快的 C', next && next.prefix === C.prefix, next && next.name);
  ok('没有被顺序带偏选 B', !(next && next.prefix === B.prefix), next && next.name);
}

/* ---------- 2. 试过的线路只要更快，仍然会再被选中 ---------- */
console.log('\n[2] C 之前试过，但它实测仍然最快');
{
  const A = mk('A', 'https://a.test/', 120 * KB);
  const B = mk('B', 'https://b.test/', 300 * KB);
  const C = mk('C', 'https://c.test/', 1.6 * 1024 * KB);
  const t = taskWith([A, B, C], A.prefix,
    { [A.prefix]: 120 * KB, [B.prefix]: 300 * KB, [C.prefix]: 1.6 * 1024 * KB },
    [C.prefix, B.prefix]);   // C 是「试过又放弃」的
  const next = ctx.pickSegNext(t, null);
  ok('不怕回头选试过的快线', next && next.prefix === C.prefix, next && next.name);
}

/* ---------- 3. 没有明显更快的就不折腾 ---------- */
console.log('\n[3] opt.beat：候选都不够快');
{
  const A = mk('A', 'https://a.test/', 1 * 1024 * KB);
  const B = mk('B', 'https://b.test/', 700 * KB);
  const C = mk('C', 'https://c.test/', 500 * KB);
  const t = taskWith([A, B, C], A.prefix, { [A.prefix]: 1024 * KB, [B.prefix]: 700 * KB, [C.prefix]: 500 * KB });
  const next = ctx.pickSegNext(t, null, { beat: 1400 * KB });
  ok('没有达到门槛 → 返回 null（原地重连）', next === null, next && next.name);
  const next2 = ctx.pickSegNext(t, null, { beat: 600 * KB });
  ok('门槛够得着 → 选最快的 B', next2 && next2.prefix === B.prefix, next2 && next2.name);
}

/* ---------- 4. 全都没测过时别原地卡死 ---------- */
console.log('\n[4] 所有线路都没有速度数据');
{
  const A = mk('A', 'https://a.test/', 0);
  const B = mk('B', 'https://b.test/', 0);
  const t = taskWith([A, B], A.prefix, {});
  const next = ctx.pickSegNext(t, null);
  ok('仍然愿意换一条（不是 null）', !!next, next && next.name);
  const gated = ctx.pickSegNext(t, null, { beat: 500 * KB });
  ok('但「要求更快」时没有依据就不换', gated === null, gated && gated.name);
}

/* ---------- 5. 重排泳道：按速度从快到慢 ---------- */
console.log('\n[5] 换线后的泳道顺序');
{
  const A = mk('A', 'https://a.test/', 60 * KB);
  const B = mk('B', 'https://b.test/', 1.2 * 1024 * KB);
  const C = mk('C', 'https://c.test/', 400 * KB);
  const t = taskWith([A, B, C], A.prefix, { [A.prefix]: 60 * KB, [B.prefix]: 1.2 * 1024 * KB, [C.prefix]: 400 * KB });
  const lanes = ctx.laneSetFor(t, B, 5);
  ok('第一条是本次要换到的 B', lanes[0] && lanes[0].prefix === B.prefix, lanes[0] && lanes[0].name);
  let sorted = true;
  for (let i = 1; i < lanes.length; i++) if (lanes[i].bps > lanes[i - 1].bps) sorted = false;
  ok('后面的泳道按实测速度降序（没有「轮流照顾」）',
    sorted, lanes.map((l) => (l.name || '') + ':' + Math.round(l.bps / 1024) + 'K').join(' > '));
  ok('最慢的 A 不会被排到 C 前面', lanes.findIndex((l) => l.prefix === A.prefix) > lanes.findIndex((l) => l.prefix === C.prefix),
    lanes.map((l) => l.name).join(','));
}

/* ---------- 6. 换线不重下：走 seg-rebuild，已下内容保留 ---------- */
console.log('\n[6] rotateSeg 的动作类型');
{
  const A = mk('A', 'https://a.test/', 50 * KB);
  const B = mk('B', 'https://b.test/', 2 * 1024 * KB);
  const t = taskWith([A, B], A.prefix, { [A.prefix]: 50 * KB, [B.prefix]: 2 * 1024 * KB });
  msgs.length = 0;
  const done = ctx.rotateSeg(t, null);
  ok('换线成功', done === true);
  const m = msgs.find((x) => x && x.id === 't');
  ok('发的是 seg-rebuild（保留进度），不是 seg-start（重下）', m && m.type === 'seg-rebuild', m && m.type);
  ok('新泳道第一条是快线 B', m && m.urls && m.urls[0].prefix === B.prefix, m && m.urls && m.urls[0].name);
  ok('任务当前线路已更新', t.routePrefix === B.prefix, t.routePrefix);
  ok('换线计数 +1', t.routeRotations === 1, t.routeRotations);
}

/* ---------- 7. 手动指定线路仍然优先 ---------- */
console.log('\n[7] 手动点某条线路');
{
  const A = mk('A', 'https://a.test/', 2 * 1024 * KB);
  const B = mk('B', 'https://b.test/', 30 * KB);
  const t = taskWith([A, B], A.prefix, { [A.prefix]: 2 * 1024 * KB, [B.prefix]: 30 * KB });
  const next = ctx.pickSegNext(t, B.prefix);
  ok('指定 B 就返回 B（不看快慢）', next && next.prefix === B.prefix, next && next.name);
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
