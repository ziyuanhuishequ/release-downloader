/* 公共常量与工具
 * 被 bg.js（importScripts）、content.js（manifest 里并列加载）、popup / options 共同使用。
 * 只用经典脚本写法（不能用 import/export），顶层变量加统一前缀避免重复注入时冲突。
 */
var EXT = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;

var APP_INFO = {
  name: 'GitHub Release 下载助手',
  version: '1.2.1',
  repo: 'https://github.com/ziyuanhuishequ/release-downloader'
};

/* 引流入口：和桌面版小卡片同一套地址，改这里三处（弹窗/页面面板/设置页）一起生效 */
var PROMO = {
  url: 'https://loomy.cgref.cn/qinxi',
  more: 'https://sucaizy.com',
  title: '本软件由 AI 工具免费制作',
  desc: '每日可领 5000 积分，同款工具自己也能做',
  short: 'AI 免费制作 · 每日领 5000 积分'
};

/* 加速线路：与桌面版同一套，prefix 为空表示直连 */
var BUILTIN_ROUTES = [
  { name: '直连', prefix: '' },
  { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { name: 'gh-proxy.org', prefix: 'https://gh-proxy.org/' },
  { name: 'moeyy', prefix: 'https://github.moeyy.xyz/' },
  { name: 'ghproxy.cc', prefix: 'https://ghproxy.cc/' },
  { name: 'gh.llkk.cc', prefix: 'https://gh.llkk.cc/' },
  { name: 'gitmirror', prefix: 'https://hub.gitmirror.com/' },
  { name: 'cors.isteed', prefix: 'https://cors.isteed.cc/' },
  { name: 'gh-proxy.net', prefix: 'https://gh-proxy.net/' },
  { name: 'ghproxy.cfd', prefix: 'https://ghproxy.cfd/' },
  { name: 'ghproxy.homeboyc', prefix: 'https://ghproxy.homeboyc.cn/' },
  { name: 'gh.xxooo.cf', prefix: 'https://gh.xxooo.cf/' },
  { name: 'gitproxy.click', prefix: 'https://gitproxy.click/' },
  { name: 'ghp.ci', prefix: 'https://ghp.ci/' },
  { name: 'ghfile.geek', prefix: 'https://ghfile.geekbang.fun/' },
  { name: 'gh.api.99988866', prefix: 'https://gh.api.99988866.xyz/' },
  { name: 'gh.ddlc.top', prefix: 'https://gh.ddlc.top/' },
  { name: 'ghproxy.markxu', prefix: 'https://ghproxy.markxu.icu/' }
];

var DEFAULT_SETTINGS = {
  concurrency: 2,          // 同时下载几个文件
  subfolder: true,         // 按 仓库/版本 归档
  autoProbe: true,         // 下载前先测速选线
  maxRetries: 4,           // 单文件换线路重试上限
  extraRoutes: [],         // 自定义线路 [{name, prefix}]
  token: '',               // GitHub Token（可选，提高 API 额度、支持私有仓库）
  notify: true,            // 批量完成后系统通知
  preferWindows: false,    // 默认只勾选 Windows 资源
  segEnabled: true,        // 分片并发下载（多线程）
  threads: 4,              // 每个文件切几片
  segMaxMB: 128,           // 超过这个大小改走浏览器单连接（拼装要占内存）
  lowSpeedKB: 40,          // 低于这个速度算「慢」，用来提示换线路
  preferRoute: ''          // 手动固定使用的线路前缀（空 = 自动挑）
};

var MIRROR_TIMEOUT_MS = 8000;
var PROBE_BYTES = 262144;   // 每条线路试拉 256KB 估速度
var PROBE_TTL_MS = 10 * 60 * 1000;
var PROBE_TTL_FAIL_MS = 90 * 1000;   // 全部失败的结果只缓存 90 秒，避免一次抖动长期误导

/* ---------- 线路池（可动态更新） ----------
 * 官方仓库里的 routes.json 是线路池的唯一来源：加线路、下线失效镜像都改那个文件，
 * 客户端 12 小时内自己拉一次，用户在界面上也能点「更新线路池」立刻拉。
 * 拉不到（断网/被墙）就退回内置表，下载不会因此不可用。
 */
var ROUTE_POOL_URL = 'https://raw.githubusercontent.com/ziyuanhuishequ/release-downloader/main/routes.json';
var ROUTE_POOL_TTL = 12 * 60 * 60 * 1000;
var ROUTE_POOL_TRY = [
  '',
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://ghproxy.net/',
  'https://gh.llkk.cc/'
];

var POOL_ROUTES = [];       // 远程池生效时替换内置表
var POOL_INFO = null;       // {ver, updated, ts, count}

function normalizePool(data) {
  var arr = (data && data.routes) || [];
  var seen = {};
  var out = [];
  arr.forEach(function (r) {
    if (!r) return;
    var prefix = String(r.prefix || '').trim();
    if (prefix && !/^https?:\/\/.+\/$/.test(prefix)) return;   // 前缀必须带结尾斜杠
    if (seen[prefix]) return;
    seen[prefix] = true;
    out.push({ name: String(r.name || prefix.replace(/^https?:\/\//, '') || '直连'), prefix: prefix });
  });
  return out;
}

function applyPool(pool) {
  if (!pool || !pool.routes || !pool.routes.length) return false;
  POOL_ROUTES = pool.routes.slice();
  POOL_INFO = { ver: pool.ver || 0, updated: pool.updated || '', ts: pool.ts || 0, count: POOL_ROUTES.length };
  return true;
}

/* 拉线路池：force=true 无视缓存（用户点了「更新线路池」） */
async function loadRoutePool(force) {
  var pool = null;
  try {
    pool = (await EXT.storage.local.get('routePool')).routePool || null;
  } catch (e) {}
  if (pool && !force && Date.now() - (pool.ts || 0) < ROUTE_POOL_TTL) {
    applyPool(pool);
    return { pool: pool, from: 'cache' };
  }
  for (var i = 0; i < ROUTE_POOL_TRY.length; i++) {
    var url = ROUTE_POOL_TRY[i] + ROUTE_POOL_URL;
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 9000);
      var res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      var data = await res.json();
      var routes = normalizePool(data);
      if (!routes.length) continue;
      var next = { ver: data.version || 0, updated: data.updated || '', ts: Date.now(), routes: routes };
      try { await EXT.storage.local.set({ routePool: next }); } catch (e) {}
      applyPool(next);
      return { pool: next, from: url === ROUTE_POOL_URL ? 'remote' : 'mirror' };
    } catch (e) { /* 换下一条通道再试 */ }
  }
  if (pool) { applyPool(pool); return { pool: pool, from: 'stale' }; }
  return { pool: null, from: 'fail' };
}

/* 线路池会随时加新域名，manifest 里的授权跟不上：拉到新线路后在这里补授权。
 * 必须在用户点击的回调里调用（浏览器只认用户手势）。 */
async function ensureRoutePerms(routes) {
  var origins = (routes || [])
    .filter(function (r) { return r && r.prefix; })
    .map(function (r) { return r.prefix + '*'; });
  if (!origins.length || !EXT.permissions) return true;
  try {
    if (await EXT.permissions.contains({ origins: origins })) return true;
    return !!(await EXT.permissions.request({ origins: origins }));
  } catch (e) {
    return false;
  }
}

/* 固定线路用 '@direct' 表示直连：prefix 是空串，跟「自动」没法区分，所以单独给个标记 */
var PREF_DIRECT = '@direct';
function prefPrefix(pref) {
  if (!pref) return null;             // 空 = 自动挑
  return pref === PREF_DIRECT ? '' : pref;
}
function prefKey(prefix) {
  return prefix ? prefix : PREF_DIRECT;
}

/* 线路健康度：跨文件累计，用来在没测速数据时也优先挑历史上靠谱的线路 */
function routeScore(stats, prefix) {
  var s = stats && stats[prefix];
  if (!s) return -1;                       // 没数据：排在有数据的后面
  var uses = (s.ok || 0) + (s.fail || 0);
  if (!uses) return -1;
  var speed = s.ok ? (s.sumBps || 0) / s.ok : 0;
  var rate = (s.ok || 0) / uses;
  return speed * (0.25 + 0.75 * rate);     // 速度 × 成功率
}

function sortByScore(list, stats) {
  return list.slice().sort(function (a, b) {
    return routeScore(stats, b.prefix) - routeScore(stats, a.prefix);
  });
}

/* ---------- 小工具 ---------- */

function fmtSize(n) {
  if (!n || n < 0) return '—';
  var u = ['B', 'KB', 'MB', 'GB', 'TB'];
  var i = 0;
  var v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + u[i];
}

function fmtSpeed(bps) {
  if (!bps || bps <= 0) return '—';
  return fmtSize(bps) + '/s';
}

/* 剩余时间，粗到「分」就够用 */
function fmtEta(seconds) {
  if (!seconds || seconds < 0 || !isFinite(seconds)) return '';
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + ' 秒';
  if (seconds < 3600) return Math.round(seconds / 60) + ' 分';
  return (seconds / 3600).toFixed(1) + ' 小时';
}

/* "2.37 MB" -> 字节数 */
function parseSizeText(text) {
  if (!text) return 0;
  var m = String(text).match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!m) return 0;
  var n = parseFloat(m[1]);
  var unit = m[2].toUpperCase();
  var mul = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 }[unit] || 1;
  return Math.round(n * mul);
}

function sanitizeSeg(s) {
  return String(s == null ? '' : s)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+$/, '_')
    .trim() || '_';
}

/* 下载路径：GitHub/仓库/版本/文件名（可在设置里关掉归档） */
function buildPath(info, settings) {
  var asset = sanitizeSeg(info.asset);
  if (!settings || !settings.subfolder) return asset;
  var parts = ['GitHub', sanitizeSeg(info.owner), sanitizeSeg(info.repo), sanitizeSeg(info.tag || 'latest'), asset];
  var path = parts.join('/');
  if (path.length > 200) path = parts.slice(0, 3).join('/') + '/' + parts[3].slice(-120);
  return path;
}

/* 从文件名猜平台，用于筛选和默认勾选 */
function platformOf(name) {
  var n = String(name || '').toLowerCase();
  if (/\.(exe|msi|msix|appx)$/.test(n)) return 'win';
  if (/windows|win64|win32|win_x64|_win|\bwin\b/.test(n)) return 'win';
  if (/\.(dmg|pkg)$/.test(n) || /darwin|macos|osx|apple|_mac|universal/.test(n)) return 'mac';
  if (/\.(deb|rpm|appimage|snap|flatpak)$/.test(n) || /linux|ubuntu|debian|fedora|musl|gnu/.test(n)) return 'linux';
  if (/\.(tar\.gz|tgz|zip|7z|tar\.xz|tar\.bz2)$/.test(n) && /source|src|code|\.tar\./.test(n) && !/win|linux|mac|darwin/.test(n)) return 'src';
  return 'other';
}

function routeUrl(route, fileUrl) {
  return (route && route.prefix ? route.prefix : '') + fileUrl;
}

function routeKey(route) {
  return (route && route.prefix) || 'direct';
}

/* 全部可用线路：远程池 > 内置兜底，再并上用户自定义 */
function allRoutes(settings) {
  var base = (POOL_ROUTES && POOL_ROUTES.length) ? POOL_ROUTES : BUILTIN_ROUTES;
  var list = base.slice();
  var extra = (settings && settings.extraRoutes) || [];
  var seen = {};
  list.forEach(function (r) { seen[r.prefix] = true; });
  extra.forEach(function (r) {
    if (!r || !r.prefix || seen[r.prefix]) return;
    seen[r.prefix] = true;
    list.push({ name: r.name || r.prefix.replace(/^https?:\/\//, ''), prefix: r.prefix });
  });
  return list;
}

/* 从 GitHub 资源地址里拆出 owner/repo/tag/文件名 */
function parseAssetUrl(url) {
  try {
    var u = new URL(url);
    var m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/releases\/download\/(.+)$/);
    if (m) {
      var rest = m[3];
      var idx = rest.lastIndexOf('/');
      if (idx > 0) {
        return {
          owner: decodeURIComponent(m[1]),
          repo: decodeURIComponent(m[2]),
          tag: decodeURIComponent(rest.slice(0, idx)),
          asset: decodeURIComponent(rest.slice(idx + 1))
        };
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function releaseUrl(owner, repo, tag, asset) {
  return 'https://github.com/' + owner + '/' + repo + '/releases/download/' +
    encodeURIComponent(tag) + '/' + encodeURIComponent(asset);
}

/* ---------- 设置读写 ---------- */

async function getSettings() {
  var got = await EXT.storage.local.get('settings');
  var s = got && got.settings ? got.settings : {};
  var out = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    out[k] = (s[k] === undefined || s[k] === null) ? DEFAULT_SETTINGS[k] : s[k];
  });
  return out;
}

async function saveSettings(patch) {
  var cur = await getSettings();
  var next = Object.assign(cur, patch || {});
  await EXT.storage.local.set({ settings: next });
  return next;
}

/* ---------- 与后台通信 ---------- */

function bgSend(type, payload) {
  return new Promise(function (resolve) {
    var msg = Object.assign({ type: type }, payload || {});
    try {
      EXT.runtime.sendMessage(msg, function (res) {
        if (EXT.runtime.lastError) {
          resolve({ error: EXT.runtime.lastError.message });
          return;
        }
        resolve(res || {});
      });
    } catch (e) {
      resolve({ error: String(e && e.message || e) });
    }
  });
}

/* 事件订阅兼容层：Chrome/Firefox 都支持 onX.addListener */
function onMessage(handler) {
  EXT.runtime.onMessage.addListener(function (msg, sender, respond) {
    var ret = handler(msg, sender, respond);
    if (ret === true) return true;
    return false;
  });
}
