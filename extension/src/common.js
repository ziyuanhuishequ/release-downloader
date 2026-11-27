/* 公共常量与工具
 * 被 bg.js（importScripts）、content.js（manifest 里并列加载）、popup / options 共同使用。
 * 只用经典脚本写法（不能用 import/export），顶层变量加统一前缀避免重复注入时冲突。
 */
/* 判断当前是不是 Firefox，以及该用哪套 API。
 *
 * 注意：新版 Chrome（158 实测）也提供了全局 browser 对象，所以「有 browser 就是 Firefox」
 * 这种判断在 Chrome 上会误判成 Firefox，从而用了只认 Promise 的 browser.* 调用方式，
 * 所有回调写法全部失效 —— 表现就是 popup 里点任何按钮都提示「后台没有启动」。
 * 这里改用 UA + Firefox 专有的 runtime.getBrowserInfo 双重判断。 */
var IS_FF = (typeof navigator !== 'undefined' && /firefox\//i.test(navigator.userAgent || '')) ||
  (typeof browser !== 'undefined' && !!browser && !!browser.runtime &&
    typeof browser.runtime.getBrowserInfo === 'function');

var EXT = (IS_FF && typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;

var APP_INFO = {
  name: 'GitHub Release 下载助手',
  version: '1.4.4',
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

/* GitHub 整站镜像（国内免梯子打开 github.com）
 *
 * 两类，靠 kind 区分：
 *   path   —— 裸路径型：https://镜像域名/<owner>/<repo>/...（相对链接天然能用）
 *   prefix —— 前缀型：https://镜像域名/https://github.com/<owner>/<repo>/...
 *             （像 cors.isteed.cc 这种通用反代；页内链接要靠 mirror.js 改写）
 *
 * 能真正代理「网页」的镜像很少，绝大多数 gh-proxy 只代理文件和 API，把它们放进
 * 来只会白屏。所以这张表只收实测能出 GitHub 页面的；失效的靠探活自动排到后面，
 * 恢复了又会被自动用起来。远程 routes.json 的 sites 会整份覆盖这张表。
 */
var BUILTIN_SITES = [
  { name: 'gh-proxy.at9.net', base: 'https://gh-proxy.at9.net', kind: 'path' },
  { name: 'cors.isteed.cc', base: 'https://cors.isteed.cc/', kind: 'prefix' },
  { name: 'cors.eu.org', base: 'https://cors.eu.org/', kind: 'prefix' },
  { name: 'kkgithub', base: 'https://kkgithub.com', kind: 'path' },
  { name: 'bgithub', base: 'https://bgithub.xyz', kind: 'path' },
  { name: 'hub.fgit.cf', base: 'https://hub.fgit.cf', kind: 'path' },
  { name: 'hub.fastgit.xyz', base: 'https://hub.fastgit.xyz', kind: 'path' },
  { name: 'dgithub.xyz', base: 'https://dgithub.xyz', kind: 'path' },
  { name: 'github.abskoop', base: 'https://github.abskoop.workers.dev', kind: 'path' }
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
  preferRoute: '',         // 手动固定使用的线路前缀（空 = 自动挑）
  ghBoost: false,          // GitHub 国内访问总开关
  ghSite: '',              // 手动固定的镜像 base（空 = 自动探活选最快的）
  ghSiteCache: '',         // 上次探活选中的镜像，重启后先用它，失败再重探
  ghSiteCustom: ''         // 用户自建/自填的镜像 base
};

/* GitHub API 的多条通路。
 * api.github.com 在国内同样被污染，只走直连等于把「粘贴仓库地址就能下」这条
 * 最核心的能力废掉。实测 gh-proxy.org / gh-proxy.com 能完整代理 API 并回 JSON，
 * 所以 API 也做成和下载一样的多通道：直连优先，不通就换镜像，并记住上次成功的。
 * 注意：走镜像时额度算在镜像服务器 IP 上，更容易撞匿名限额——填 Token 可以绕开。 */
var API_BASE = 'https://api.github.com';
var API_CHANNELS = [
  { name: '直连', base: API_BASE },
  { name: 'gh-proxy.org', base: 'https://gh-proxy.org/' + API_BASE },
  { name: 'gh-proxy.com', base: 'https://gh-proxy.com/' + API_BASE },
  { name: 'ghproxy.net', base: 'https://ghproxy.net/' + API_BASE }
];

var MIRROR_TIMEOUT_MS = 8000;
/* 每条线路试拉 96KB 估速度。原来 256KB × 20 条 = 一次测速吃掉 5MB 流量，
 * 换到手机热点或按流量计费的网络上很难受；96KB 已经足够区分快慢。 */
var PROBE_BYTES = 98304;
var PROBE_TTL_MS = 10 * 60 * 1000;
var PROBE_TTL_FAIL_MS = 90 * 1000;   // 全部失败的结果只缓存 90 秒，避免一次抖动长期误导

/* ---------- 线路池（可动态更新） ----------
 * 官方仓库里的 routes.json 是线路池的唯一来源：加线路、下线失效镜像都改那个文件，
 * 客户端 12 小时内自己拉一次，用户在界面上也能点「更新线路池」立刻拉。
 * 拉不到（断网/被墙）就退回内置表，下载不会因此不可用。
 */
var ROUTE_POOL_URL = 'https://raw.githubusercontent.com/ziyuanhuishequ/release-downloader/main/routes.json';
var ROUTE_POOL_TTL = 2 * 60 * 60 * 1000;          // 2 小时自动更新一次
var ROUTE_POOL_FORCE_GAP = 5 * 60 * 1000;         // 用户手动刷新/开开关的节流
/* 多通道拉池：直连不行就走反代，反代不行就用「镜像自己拉自己的仓库」。
 * 镜像能打开网页，就必然能读 raw，这条自举通道在墙内特别有用。 */
var ROUTE_POOL_CHANNELS = [
  ROUTE_POOL_URL,
  'https://cdn.jsdmirror.com/gh/ziyuanhuishequ/release-downloader@main/routes.json',
  'https://gh-proxy.com/' + ROUTE_POOL_URL,
  'https://gh-proxy.org/' + ROUTE_POOL_URL,
  'https://gh-proxy.at9.net/ziyuanhuishequ/release-downloader/raw/main/routes.json',
  'https://cors.isteed.cc/' + ROUTE_POOL_URL
];

var POOL_ROUTES = [];       // 远程池生效时替换内置表
var POOL_SITES = [];        // 远程池里的整站镜像（GitHub 国内访问用）
var POOL_INFO = null;       // {ver, updated, ts, count}

/* 镜像 base 归一：path 型去掉结尾斜杠，prefix 型补成以 / 结尾 */
function siteBase(b) {
  return String(b == null ? '' : b).trim().replace(/\/+$/, '');
}

function normSiteBase(b, kind) {
  var s = String(b == null ? '' : b).trim();
  if (!s) return '';
  return kind === 'prefix' ? s.replace(/\/*$/, '/') : s.replace(/\/+$/, '');
}

/* 没写 kind 时按结尾斜杠猜：以 / 结尾的是前缀型，否则是裸路径型 */
function siteKindOf(base, kind) {
  if (kind === 'prefix' || kind === 'path') return kind;
  return /\/$/.test(String(base || '')) ? 'prefix' : 'path';
}

function normalizeSites(data) {
  var arr = (data && data.sites) || [];
  var seen = {};
  var out = [];
  arr.forEach(function (s) {
    if (!s) return;
    var raw = typeof s === 'string' ? s : s.base;
    var kind = siteKindOf(raw, typeof s === 'object' ? s.kind : '');
    var base = normSiteBase(raw, kind);
    var ok = kind === 'prefix' ? /^https?:\/\/[^/\s]+\/$/i.test(base) : /^https?:\/\/[^/\s]+$/i.test(base);
    if (!ok) return;
    if (seen[base]) return;
    seen[base] = true;
    out.push({
      name: String((typeof s === 'object' && s.name) || base.replace(/^https?:\/\//, '').replace(/\/$/, '')),
      base: base,
      kind: kind
    });
  });
  return out;
}

/* 全部可用镜像：远程池 > 内置兜底，再并上用户自填 */
function allSites(settings) {
  var base = (POOL_SITES && POOL_SITES.length) ? POOL_SITES : BUILTIN_SITES;
  var list = base.slice();
  var custom = normSiteBase(settings && settings.ghSiteCustom, siteKindOf(settings && settings.ghSiteCustom));
  if (custom) {
    var has = list.some(function (x) { return x.base === custom; });
    if (!has) {
      list.push({
        name: custom.replace(/^https?:\/\//, '').replace(/\/$/, ''),
        base: custom,
        kind: siteKindOf(custom)
      });
    }
  }
  return list;
}

/* 按 base 找站点；找不到就按结尾斜杠猜类型，保证用户自填的也能用 */
function siteOfBase(base, settings) {
  var b = String(base || '').trim();
  if (!b) return null;
  var hit = allSites(settings).filter(function (x) { return x.base === b || x.base === b + '/'; })[0];
  if (hit) return hit;
  var kind = siteKindOf(b);
  return { name: b.replace(/^https?:\/\//, '').replace(/\/$/, ''), base: normSiteBase(b, kind), kind: kind };
}

/* github.com URL -> 镜像 URL */
function siteUrl(site, ghUrl) {
  if (!site || !site.base) return ghUrl;
  if (site.kind === 'prefix') return site.base + ghUrl;
  try {
    var u = new URL(ghUrl);
    if (!/(^|\.)github\.com$/i.test(u.host)) return ghUrl;
    return site.base + u.pathname + u.search + u.hash;
  } catch (e) {
    return ghUrl;
  }
}

/* 兼容旧调用：传 base 也能拼出镜像地址 */
function mirrorUrlOf(base, ghUrl) {
  return siteUrl(siteOfBase(base, null), ghUrl);
}

/* 任意地址 -> 它对应的 github.com 地址。
 * 依次认：前缀型镜像（/https://github.com/...）、原站、裸路径型镜像。 */
function ghCanonical(u) {
  try {
    var url = new URL(u, 'https://github.com');
    var m = url.pathname.match(/^\/(https?:\/\/[^/]+)(\/.*)?$/);
    if (m && /(^|\.)github\.com$/i.test(new URL(m[1]).host)) {
      return 'https://github.com' + (m[2] || '/') + url.search;
    }
    if (/(^|\.)github\.com$/i.test(url.host)) {
      return 'https://github.com' + url.pathname + url.search;
    }
    if (/^\/[^/\s]+\/[^/\s]+\/(?:releases|tree|blob|issues|pull|raw|archive)(?:\/|$)/.test(url.pathname)) {
      return 'https://github.com' + url.pathname + url.search;
    }
  } catch (e) { /* ignore */ }
  return u;
}

/* 这个域名是不是我们池子里的镜像（用来判断当前标签要不要做地址换算） */
function isMirrorHost(host, settings) {
  var h = String(host || '').toLowerCase();
  if (!h) return false;
  return allSites(settings).some(function (s) {
    try { return new URL(s.base).host.toLowerCase() === h; } catch (e) { return false; }
  });
}

/* 镜像 URL -> 它在 github.com 上的原地址（用于「切回原站」） */
function originalUrlOf(u) {
  try {
    var url = new URL(u);
    var m = url.pathname.match(/^\/(https?:\/\/[^/]+)(\/.*)?$/);
    if (m && /(^|\.)github\.com$/i.test(new URL(m[1]).host)) {
      return 'https://github.com' + (m[2] || '/') + url.search + url.hash;
    }
    if (/(^|\.)github\.com$/i.test(url.host)) return url.href;
    return 'https://github.com' + url.pathname + url.search + url.hash;
  } catch (e) {
    return u;
  }
}

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
  POOL_SITES = normalizeSites(pool);
  POOL_INFO = {
    ver: pool.ver || 0,
    updated: pool.updated || '',
    ts: pool.ts || 0,
    count: POOL_ROUTES.length,
    sites: POOL_SITES.length
  };
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
  for (var i = 0; i < ROUTE_POOL_CHANNELS.length; i++) {
    var url = ROUTE_POOL_CHANNELS[i];
    try {
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 9000);
      var res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      var data = await res.json();
      var routes = normalizePool(data);
      if (!routes.length) continue;
      var next = {
        ver: data.version || 0,
        updated: data.updated || '',
        ts: Date.now(),
        routes: routes,
        sites: normalizeSites(data)
      };
      try { await EXT.storage.local.set({ routePool: next }); } catch (e) {}
      applyPool(next);
      return { pool: next, from: i === 0 ? 'remote' : 'mirror', channel: url.split('/')[2] };
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

/* 镜像域名同理：远程池随时可能加新站，授权跟不上就在用户开开关时补要一次。
 * 必须在用户点击的回调里调用（浏览器只认用户手势）。 */
async function ensureSitePerms(sites) {
  var origins = (sites || [])
    .map(function (s) { return siteBase(s && s.base); })
    .filter(Boolean)
    .map(function (b) { return b + '/*'; });
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

/* Chrome 用回调风格（sendMessage 返回 undefined），Firefox 的 browser.* 只认 Promise、
 * 传进去的回调会被当成 options 忽略。所以两种都得接住，否则在 Firefox 里每次调用都石沉大海。 */
var BG_RETRY_RE = /Receiving end does not exist|Could not establish connection|message port closed|Extension context invalidated|background service worker/i;

function bgSendOnce(msg, timeoutMs) {
  return new Promise(function (resolve) {
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      done = true;
      resolve({ error: '__timeout__' });
    }, timeoutMs || 20000);

    function fin(v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    }

    var p;
    if (IS_FF) {
      /* Firefox：只认 Promise。传回调会被当成非法参数直接抛错，
       * 而且不能「发两次」——那会让下载任务被入队两遍。 */
      try {
        p = EXT.runtime.sendMessage(msg);
      } catch (e) {
        fin({ error: String((e && e.message) || e) });
        return;
      }
      if (p && typeof p.then === 'function') {
        p.then(function (res) { fin(res || {}); },
          function (e) { fin({ error: String((e && e.message) || e) }); });
      } else {
        fin({ error: 'Receiving end does not exist' });
      }
      return;
    }
    /* Chrome / Edge：回调风格最稳（从 MV3 早期到现在都支持），
     * 不传回调的 Promise 形态在新版本才有。 */
    try {
      EXT.runtime.sendMessage(msg, function (res) {
        if (EXT.runtime.lastError) {
          fin({ error: EXT.runtime.lastError.message });
          return;
        }
        fin(res || {});
      });
    } catch (e) {
      fin({ error: String((e && e.message) || e) });
    }
  });
}

/* 后台刚被浏览器唤醒、或扩展刚重载时，前一两百毫秒发消息会报「没有接收端」。
 * 这类错误一律重试；业务错误（404、镜像全挂）不重试，避免重复提交。 */
function bgSend(type, payload) {
  var msg = Object.assign({ type: type }, payload || {});
  return (async function () {
    var res = null;
    for (var i = 0; i < 4; i++) {
      res = await bgSendOnce(msg, i === 0 ? 15000 : 8000);
      if (!res || !res.error) return res || {};
      if (!BG_RETRY_RE.test(res.error)) return res;
      await new Promise(function (r) { setTimeout(r, 150 + i * 400); });
    }
    // 还是连不上：再单独探一下后台是不是真的没起来，好给出准确的下一步
    var ping = await bgSendOnce({ type: 'ping' }, 3000);
    if (ping && !ping.error) {
      return { error: '后台在线，但这条请求没有响应。请关掉这个窗口重新打开；如果一直这样，点「设置」把版本号发我。' };
    }
    return {
      error: EXT_MANAGER === 'about:debugging'
        ? '扩展后台没有启动。请到 about:debugging#/runtime/this-firefox 点「重新载入」，再重开这个窗口。'
        : '扩展后台没有启动。请到扩展管理页点本扩展的「重新加载」，再重开这个窗口。'
    };
  })();
}

/* 各浏览器的扩展管理页地址，报错时直接告诉用户去哪儿点「重新加载」 */
var EXT_MANAGER = IS_FF ? 'about:debugging' : 'chrome://extensions';

/* 判断一条错误是不是「后台没起来/连不上」，这类错误要给出重载扩展的指引，
 * 而不是像业务错误那样让用户去查仓库地址。 */
function isBgDownError(msg) {
  return /后台没有启动|后台在线|重新加载|重新载入|Receiving end|Could not establish|message port closed|__timeout__/i.test(String(msg || ''));
}

/* 跨浏览器的浏览器 API 调用。
 * Chrome 的 chrome.* 主要靠回调（downloads 系列至今没有 Promise 版）；
 * Firefox 的 browser.* 反过来，多传一个回调会被判成非法参数直接抛错。
 * 统一成 cb(err, result)：Firefox 走 Promise，其它走回调。 */
function callExt(fn, thisObj, args, cb) {
  var called = false;
  function done(err, r) {
    if (called) return;
    called = true;
    if (cb) cb(err, r);
  }
  if (IS_FF) {
    var p;
    try { p = fn.apply(thisObj, args); } catch (e) { done(e); return; }
    if (p && typeof p.then === 'function') {
      p.then(function (r) { done(null, r); }, function (e) { done(e); });
    } else done(null, p);
    return;
  }
  try {
    fn.apply(thisObj, args.concat([function (r) {
      var le = EXT.runtime && EXT.runtime.lastError;
      done(le ? (le.message || 'failed') : null, r);
    }]));
  } catch (e) { done(e); }
}

/* 事件订阅兼容层：
 * Chrome 回调风格里必须「同步返回 true」才允许稍后 respond；
 * Firefox 更严格，返回 false/undefined 会立刻关掉端口，后台就永远答不上话。
 * keepAlive=true 用于后台：只要不是明确「这条不是给我的」，都把端口留着。 */
function onMessage(handler, keepAlive) {
  EXT.runtime.onMessage.addListener(function (msg, sender, respond) {
    var replied = false;
    function reply(v) {
      if (replied) return;          // 重复 respond 会抛「already responded」，直接吞掉
      replied = true;
      try { respond(v); } catch (e) {}
    }
    var ret;
    try {
      ret = handler(msg, sender, reply);
    } catch (e) {
      reply({ error: String((e && e.message) || e) });
      return false;
    }
    if (ret === false) return false;          // 明确表示「不是发给我的」，交给别的监听器
    if (ret === true || keepAlive) return true;
    return false;
  });
}
