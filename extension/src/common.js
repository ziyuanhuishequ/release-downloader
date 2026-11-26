/* 公共常量与工具
 * 被 bg.js（importScripts）、content.js（manifest 里并列加载）、popup / options 共同使用。
 * 只用经典脚本写法（不能用 import/export），顶层变量加统一前缀避免重复注入时冲突。
 */
var EXT = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;

var APP_INFO = {
  name: 'GitHub Release 下载助手',
  version: '1.1.0',
  repo: 'https://github.com/ziyuanhuishequ/release-downloader'
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
  lowSpeedKB: 40           // 低于这个速度算「慢」，用来提示换线路
};

var MIRROR_TIMEOUT_MS = 8000;
var PROBE_BYTES = 262144;   // 每条线路试拉 256KB 估速度
var PROBE_TTL_MS = 10 * 60 * 1000;
var PROBE_TTL_FAIL_MS = 90 * 1000;   // 全部失败的结果只缓存 90 秒，避免一次抖动长期误导

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

function allRoutes(settings) {
  var list = BUILTIN_ROUTES.slice();
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
