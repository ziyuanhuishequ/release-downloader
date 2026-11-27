/* 后台：GitHub API、线路测速、下载队列、中断自动换线
 * MV3 Service Worker（Firefox 走 background.scripts，同一份代码）。
 */
/* Chrome MV3 的 Service Worker 要自己引入公共脚本；
 * Firefox 走 background.scripts，manifest 里已经把 common.js 排在前面，
 * 而且 Firefox 里没有 importScripts —— 无条件调用会让整个后台脚本在顶层抛错，
 * 表现就是点任何按钮都报「Could not establish connection. Receiving end does not exist.」 */
if (typeof importScripts === 'function' && typeof APP_INFO === 'undefined') {
  importScripts('common.js');
}

/* 最先注册的探活通道：只要后台脚本被执行到，这里的监听器就已经在，
 * popup 至少能拿到明确答复（在线/版本），不会卡在「没有接收端」上。 */
try {
  EXT.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.type !== 'ping') return false;
    respond({ ok: true, ver: (typeof APP_INFO !== 'undefined' ? APP_INFO.version : '') });
    return false;
  });
} catch (e) {}

var tasks = [];              // 全部任务（含已完成，最多保留 50 条）
var activeIds = new Map();   // downloadId -> task
var pumping = false;
var badUntil = new Map();    // routePrefix -> 时间戳，短时间不再用
var probeCache = null;       // {key, ts, list}
var segTasks = new Map();    // taskId -> task，正在分片下载的
var settingsCache = null;    // 事件回调里不反复读 storage

/* 下载历史：url -> {ts, size}，用来在列表里把「已下载」标出来。
 * 只存在本机 storage.local，不上传任何地方；超过 400 条丢最旧的。 */
var dlHist = null;
var histVer = 0;
var HIST_MAX = 400;

async function loadHist() {
  if (dlHist) return dlHist;
  try {
    dlHist = (await EXT.storage.local.get('dlHist')).dlHist || {};
  } catch (e) {
    dlHist = {};
  }
  return dlHist;
}

function markDownloaded(task) {
  loadHist().then(function (h) {
    if (!h || typeof h !== 'object') return;
    h[task.url] = { ts: Date.now(), size: task.total || task.size || 0, name: task.name };
    var keys = Object.keys(h);
    if (keys.length > HIST_MAX) {
      keys.sort(function (a, b) { return (h[a].ts || 0) - (h[b].ts || 0); })
        .slice(0, keys.length - HIST_MAX)
        .forEach(function (k) { delete h[k]; });
    }
    histVer++;
    try { EXT.storage.local.set({ dlHist: h }); } catch (e) {}
  });
}

var SLOW_JUDGE_MS = 9000;    // 速度一直上不去，持续这么久就标记「慢」
var AUTO_SWITCH_MS = 16000;  // 而且几乎没下多少，就自动换一条线重来
var FAST_SWITCH_MS = 5500;   // 一上来就慢得离谱（几十 KB/s）：先给 5.5 秒，不行立刻换线
var MAX_ROUTE_TRIES = 6;     // 单个任务最多自动换 6 次线路，别在 20 条死线里无限绕
var ROUTE_GOOD_BPS = 96 * 1024;   // 实测 ≥96KB/s 才算「快的线路」，低于它的要排到「测不出速度」的后面

/* 事件回调里用缓存，避免每次 onChanged 都读一遍 storage */
async function settingsNow() {
  if (!settingsCache) settingsCache = await getSettings();
  return settingsCache;
}
try {
  EXT.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.settings) return;
    // 直接重建成新值，而不是清空：清空后同步代码会退回默认值，
    // 用户刚改的「慢速阈值」「线程数」在本次下载里就不生效了。
    var raw = changes.settings.newValue || {};
    var next = {};
    Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
      next[k] = (raw[k] === undefined || raw[k] === null) ? DEFAULT_SETTINGS[k] : raw[k];
    });
    settingsCache = next;
  });
} catch (e) {}

/* ---------------- GitHub API ---------------- */

var API_STAGGER_MS = 350;    // 镜像通道相对直连的阶梯延迟

function apiHint(code) {
  if (code === 404) return '仓库或版本不存在，也可能是私有仓库（可在设置里填 Token）';
  if (code === 403) return '请求太频繁（匿名每小时 60 次），可在设置里填 GitHub Token 提额';
  if (code === 401) return 'Token 无效或已过期';
  if (code >= 500) return 'GitHub 服务端异常，稍后再试';
  return 'HTTP ' + code;
}

async function ghFetch(path, settings) {
  var headers = { 'Accept': 'application/vnd.github+json' };
  if (settings && settings.token) headers['Authorization'] = 'Bearer ' + settings.token;
  var list = apiOrder();
  var errs = [];
  var left = list.length;
  var done = false;

  function fetchWithTimeout(url) {
    var c = new AbortController();
    var t = setTimeout(function () { try { c.abort(); } catch (e) {} }, 11000);
    return fetch(url, { headers: headers, cache: 'no-store', signal: c.signal })
      .then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
  }

  return new Promise(function (resolve, reject) {
    function giveUp() {
      if (done) return;
      done = true;
      // 优先报「通道通了但请求本身报错」的原因，比网络错误更有信息量
      var best = errs.filter(function (e) { return e.status >= 400 && e.status < 500; })[0] || errs[errs.length - 1] || {};
      var e2 = new Error(best.msg
        ? ('GitHub API 连不上：' + best.msg + '（直连和镜像都试过了，可在设置里填 Token 或自建节点）')
        : 'GitHub API 连不上：直连和镜像都没通');
      e2.status = best.status || 0;
      reject(e2);
    }

    list.forEach(function (ch, i) {
      // 直连先发，镜像按阶梯延后：直连正常时不会产生多余的镜像请求
      setTimeout(function () {
        if (done) return;
        fetchWithTimeout(ch.base + path).then(function (res) {
          if (done) return;
          if (res.ok) {
            return res.json().then(function (data) {
              if (done) return;
              done = true;
              setApiChan(ch.base);
              resolve(data);
            }, function () {
              errs.push({ msg: '返回内容不是 JSON', status: 0 });
              if (--left <= 0) giveUp();
            });
          }
          // 4xx 说明这条通道是通的，只是这次请求本身有问题，换通道也没用
          if (res.status >= 400 && res.status < 500) {
            done = true;
            var e3 = new Error(apiHint(res.status));
            e3.status = res.status;
            reject(e3);
            return;
          }
          errs.push({ msg: apiHint(res.status), status: res.status });
          if (--left <= 0) giveUp();
        }, function (err) {
          if (done) return;
          errs.push({ msg: (err && err.name === 'AbortError') ? '连接超时' : '网络不可达', status: 0 });
          if (--left <= 0) giveUp();
        });
      }, i * API_STAGGER_MS);
    });
  });
}

/* 记住上次成功的 API 通道：下次同一条先试，省掉一次失败等待 */
var apiChanCache = '';
function setApiChan(base) {
  if (apiChanCache === base) return;
  apiChanCache = base;
  try { EXT.storage.local.set({ apiChan: base }); } catch (e) {}
}
function apiOrder() {
  var list = API_CHANNELS.slice();
  if (!apiChanCache) return list;
  var idx = -1;
  list.forEach(function (c, i) { if (c.base === apiChanCache) idx = i; });
  if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
  return list;
}
/* 给界面用：这次的数据是不是从镜像拿的（直连正常时不需要提示） */
function apiVia() {
  if (!apiChanCache) return '';
  return apiChanCache === API_BASE ? '' : (new URL(apiChanCache).host);
}

function normRelease(r, repo) {
  return {
    tag: r.tag_name,
    name: r.name || r.tag_name,
    prerelease: !!r.prerelease,
    draft: !!r.draft,
    published: r.published_at,
    body: r.body || '',
    assets: (r.assets || []).map(function (a) {
      return {
        name: a.name,
        size: a.size,
        type: a.content_type,
        downloads: a.download_count,
        url: a.browser_download_url || ('https://github.com/' + repo + '/releases/download/' + r.tag_name + '/' + a.name)
      };
    }),
    html: r.html_url
  };
}

async function listReleases(repo, perPage) {
  var settings = await getSettings();
  var clean = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(clean)) {
    throw new Error('仓库地址要写成 owner/repo，例如 sharkdp/bat');
  }
  var arr = await ghFetch('/repos/' + clean + '/releases?per_page=' + (perPage || 20), settings);
  return {
    repo: clean,
    via: apiVia(),
    releases: (arr || []).filter(function (r) { return !r.draft; }).map(function (r) { return normRelease(r, clean); })
  };
}

async function listAssets(repo, tag) {
  var out = await listReleases(repo, 30);
  if (!out.releases.length) {
    // 仓库只有 tag 没有 Release 时，退一步用 tags 列表拼下载地址不现实，直接说明
    throw new Error('这个仓库还没有发布 Release');
  }
  var rel;
  if (tag && tag !== 'latest') {
    rel = out.releases.filter(function (r) { return r.tag === tag; })[0];
    if (!rel) throw new Error('找不到版本 ' + tag);
  } else {
    rel = out.releases.filter(function (r) { return !r.prerelease; })[0] || out.releases[0];
  }
  return { repo: out.repo, via: apiVia(), release: rel, releases: out.releases.map(function (r) { return { tag: r.tag, name: r.name, prerelease: r.prerelease }; }) };
}

/* ---------------- 线路池 + 线路健康度 ---------------- */

var routeStats = null;        // prefix -> {ok, fail, sumBps, last}
var statsDirty = false;
var STATS_VER = 2;            // 1 = 旧版（把「测速失败」也算成一次失败，数据被污染）

async function loadStats() {
  if (routeStats) return routeStats;
  try {
    var got = await EXT.storage.local.get(['routeStats', 'routeStatsVer']);
    if ((got.routeStatsVer || 0) < STATS_VER) {
      /* 旧版每次测速都会给连不上的线路记一次「失败」，于是「3败」其实是 3 次测速，
       * 并不是用户下载失败 3 次，还会把线路一路冷却下去。这里清一次，重新开始记。 */
      routeStats = {};
      try { await EXT.storage.local.set({ routeStats: {}, routeStatsVer: STATS_VER }); } catch (e) {}
      return routeStats;
    }
    routeStats = got.routeStats || {};
  } catch (e) {
    routeStats = {};
  }
  return routeStats;
}

function saveStats() {
  if (!statsDirty) return;
  statsDirty = false;
  try { EXT.storage.local.set({ routeStats: routeStats || {} }); } catch (e) {}
}

/* 成功：记速度，慢速会自然把分数拉下来；失败：记次数，连着失败就冷却一段时间 */
function noteRoute(prefix, ok, bps) {
  if (prefix === undefined) return;
  loadStats().then(function (s) {
    var e = s[prefix] || { ok: 0, fail: 0, sumBps: 0 };
    if (ok) {
      e.ok++;
      e.sumBps += Math.max(0, bps || 0);
      e.failStreak = 0;
      badUntil.delete(prefix);
    } else {
      e.fail++;
      e.failStreak = (e.failStreak || 0) + 1;
      // 真下载连挂两次才冷却：5 分钟起，最多 10 分钟（不会因为几次抖动就把线路锁半天）
      if (e.failStreak >= 2) {
        var ms = Math.min(10 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, e.failStreak - 2));
        badUntil.set(prefix, Date.now() + ms);
      }
    }
    e.last = Date.now();
    s[prefix] = e;
    statsDirty = true;
    setTimeout(saveStats, 1500);
  });
}

var lastSiteSig = '';
async function refreshPool(force) {
  var r = await loadRoutePool(force);
  if (r && r.pool) {
    // 只有镜像名单真的变了才作废探活结果。
    // 原来每次都清，导致 Service Worker 一重启弹窗就显示「检测中」。
    var sig = POOL_SITES.map(function (x) { return x.base; }).join(',');
    if (sig !== lastSiteSig) {
      lastSiteSig = sig;
      probeCache = null;
      siteProbe = null;
      try { await EXT.storage.local.remove('siteProbe'); } catch (e) {}
    }
  }
  return {
    info: POOL_INFO,
    from: r && r.from,
    count: POOL_INFO ? POOL_INFO.count : 0,
    sites: POOL_SITES.length
  };
}

/* 后台刷池：5 分钟内不重复，不挡任何用户操作 */
var refreshingPool = null;
function refreshPoolLazy(force) {
  if (refreshingPool) return refreshingPool;
  refreshingPool = (async function () {
    try {
      var meta = (await EXT.storage.local.get('poolMeta')).poolMeta || {};
      if (!force && meta.lastForce && Date.now() - meta.lastForce < ROUTE_POOL_FORCE_GAP) return null;
      var r = await refreshPool(true);
      await EXT.storage.local.set({ poolMeta: { lastForce: Date.now() } });
      return r;
    } catch (e) {
      return null;
    } finally {
      refreshingPool = null;
    }
  })();
  return refreshingPool;
}

/* ---------------- GitHub 国内访问：整站镜像 ---------------- */

var DNR_REDIRECT_ID = 9101;
var DNR_ALLOW_ID = 9102;
var MIRROR_SCRIPT_ID = 'gh-mirror';
var SITE_PROBE_TTL = 10 * 60 * 1000;
var siteProbe = null;         // {ts, list:[{name,base,ok,ms}]}

/* 怎么判断「这个响应真的是 GitHub 页面」：
 * GitHub 的 HTML 必定带 <html data-color-mode>、fluid-icon 或 octolytics，
 * 而镜像自己的落地页 / Cloudflare 错误页都不带。三个特征里命中一个就算过，
 * 比只看 data-color-mode 少漏判。 */
var LOOKS_GITHUB = /data-color-mode|fluid-icon|octolytics|<title>[^<]*GitHub/i;

/* 这些路径必须留在真 GitHub：镜像没有登录态，跳过去只会白屏。
 * 注意：Chrome 对 DNR 正则有 2KB 编译内存上限，这里不能写太长（写成一大串
 * 可选路径会被整条拒掉，连带另一条重定向规则一起失效）。 */
var BOOST_ALLOW_RE = '^https?://(?:www\\.)?github\\.com/(?:login|logout|signup|join|session|settings|account)(?:/|\\?|$)';

/* 规则只匹配 main_frame（页面导航）：
 * - 页面里点链接、地址栏输入都会跳镜像
 * - 下载请求（扩展发起 / xmlhttprequest / other）完全不受影响，仍走线路池
 */
function boostRules(site) {
  // 裸路径型：镜像域名 + 原路径；前缀型：镜像域名 + 完整 github 地址
  var sub = site.kind === 'prefix'
    ? site.base + 'https://github.com/\\1'
    : site.base + '/\\1';
  return [
    {
      id: DNR_ALLOW_ID,
      priority: 3,
      action: { type: 'allow' },
      condition: { regexFilter: BOOST_ALLOW_RE, resourceTypes: ['main_frame'] }
    },
    {
      id: DNR_REDIRECT_ID,
      priority: 2,
      action: { type: 'redirect', redirect: { regexSubstitution: sub } },
      condition: {
        regexFilter: '^https?://(?:www\\.)?github\\.com/(.*)$',
        resourceTypes: ['main_frame']
      }
    }
  ];
}

async function applyBoost(enabled, site) {
  var api = EXT.declarativeNetRequest;
  if (!api || !api.updateDynamicRules) {
    return { error: '此浏览器不支持请求重定向（Firefox 需 113 以上）' };
  }
  var s = site ? (typeof site === 'string' ? siteOfBase(site, null) : site) : null;
  try {
    await api.updateDynamicRules({
      removeRuleIds: [DNR_REDIRECT_ID, DNR_ALLOW_ID],
      addRules: (enabled && s) ? boostRules(s) : []
    });
    return { ok: true };
  } catch (e) {
    return { error: '规则写入失败：' + ((e && e.message) || e) };
  }
}

/* 镜像域名是动态的，manifest 里的 content_scripts 写不死，注册/换站时动态注入。
 * 注入 content.js 是为了让下载面板在镜像页上照样出现（路径结构和 github.com 一致）。 */
async function syncMirrorScript(site) {
  if (!EXT.scripting || !EXT.scripting.registerContentScripts) return false;
  var reg = function (opt) { return EXT.scripting.registerContentScripts(opt); };
  var base = site ? (typeof site === 'string' ? site : site.base) : '';
  try {
    var cur = await EXT.scripting.getRegisteredContentScripts({ ids: [MIRROR_SCRIPT_ID] });
    if (cur && cur.length) await EXT.scripting.unregisterContentScripts({ ids: [MIRROR_SCRIPT_ID] });
    if (!base) return true;
    var spec = {
      id: MIRROR_SCRIPT_ID,
      matches: [siteBase(base) + '/*'],
      js: ['src/common.js', 'src/content.js', 'src/mirror.js'],
      runAt: 'document_idle'
    };
    try {
      await reg([Object.assign({ persistAcrossSessions: true }, spec)]);
    } catch (e) {
      await reg([spec]);   // 老版本 Firefox 不认 persistAcrossSessions
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* 探活一个镜像：打一个真实仓库页，边读边判定，命中特征就断开。
 * 判定用 GitHub 页面 <html data-color-mode=...> —— 它出现在前 200 字节里，
 * 比找 <title> 稳（GitHub 页面开头有一大段空行和样式，title 可能靠后）。
 * 镜像自己的落地页 / Cloudflare 错误页都不带这个标记，不会误判成可用。 */
async function probeOneSite(site) {
  var t0 = Date.now();
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 4500);
  try {
    var res = await fetch(siteUrl(site, 'https://github.com/octocat/Hello-World'), {
      cache: 'no-store',
      credentials: 'omit',
      signal: ctrl.signal
    });
    var head = '';
    var ok = false;
    if (res.ok) {
      if (res.body && res.body.getReader) {
        var rd = res.body.getReader();
        var dec = new TextDecoder();
        for (var i = 0; i < 3; i++) {            // 最多读 3 块，通常第一块就命中
          var chunk = await rd.read();
          if (!chunk || chunk.done || !chunk.value) break;
          head += dec.decode(chunk.value, { stream: true });
          if (LOOKS_GITHUB.test(head)) { ok = true; break; }
        }
        try { rd.cancel(); } catch (e) {}
      } else {
        head = String(await res.text()).slice(0, 8192);
        ok = LOOKS_GITHUB.test(head);
      }
    }
    clearTimeout(timer);
    return { name: site.name, base: site.base, kind: site.kind, ok: ok, ms: Date.now() - t0 };
  } catch (e) {
    clearTimeout(timer);
    return { name: site.name, base: site.base, kind: site.kind, ok: false, ms: 0 };
  }
}

async function probeSites(force) {
  if (!force) {
    if (!siteProbe) {
      try { siteProbe = (await EXT.storage.local.get('siteProbe')).siteProbe || null; } catch (e) {}
    }
    if (siteProbe && Date.now() - (siteProbe.ts || 0) < SITE_PROBE_TTL) return siteProbe;
  }
  var st = await getSettings();
  var list = allSites(st);
  var res = await Promise.all(list.map(probeOneSite));
  res.sort(function (a, b) {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    return a.ms - b.ms;
  });
  siteProbe = { ts: Date.now(), list: res };
  try { await EXT.storage.local.set({ siteProbe: siteProbe }); } catch (e) {}
  return siteProbe;
}

/* 只读缓存，永不阻塞：界面先拿上次的结论把 UI 画出来 */
async function siteProbeCached() {
  if (siteProbe) return siteProbe;
  try { siteProbe = (await EXT.storage.local.get('siteProbe')).siteProbe || null; } catch (e) {}
  return siteProbe;
}

/* 后台探活，同一时刻只跑一份；完成后顺手把挂掉的镜像换掉 */
var probingSites = null;
function siteProbeLazy(force) {
  if (probingSites) return probingSites;
  probingSites = probeSites(!!force)
    .then(function (p) { healBoost(p); return p; })
    .catch(function () { return null; })
    .then(function (p) { probingSites = null; return p; });
  return probingSites;
}

/* 当前正在用的镜像挂了就静默换一个还能用的。
 * 放在后台做（不是等用户打开弹窗才做），下次开页面就不会白屏。 */
async function healBoost(probe) {
  try {
    var s = await getSettings();
    if (!s.ghBoost) return;
    var raw = s.ghSite || s.ghSiteCache;
    if (!raw) return;
    var cur = siteOfBase(raw, s);
    var list = (probe && probe.list) || [];
    var hit = list.filter(function (x) { return x.base === cur.base; })[0];
    if (!hit || hit.ok) return;                    // 没测到 / 还活着
    var next = list.filter(function (x) { return x.ok && x.base !== cur.base; })[0];
    if (!next) return;                             // 全挂：保持现状，用户至少还能手点
    var site = { name: next.name, base: next.base, kind: next.kind };
    var r = await applyBoost(true, site);
    if (r && r.error) return;
    await syncMirrorScript(site);
    await saveSettings({ ghSiteCache: site.base });
  } catch (e) { /* 静默 */ }
}

/* 首次开启用：谁先探通就用谁，不必等全部 9 个都超时 */
async function pickSiteFast(settings) {
  var sub = settings || await getSettings();
  if (sub.ghSite) {
    var pin = siteOfBase(sub.ghSite, sub);
    if (pin) return { site: pin, pinned: true };
  }
  var list = allSites(sub);
  var cached = sub.ghSiteCache;
  // 上次用过的那台排最前：多数情况下它还活着，能立刻返回
  list = list.slice().sort(function (a, b) {
    return (b.base === cached ? 1 : 0) - (a.base === cached ? 1 : 0);
  });
  return new Promise(function (resolve) {
    var settled = false;
    var left = list.length;
    var results = [];
    if (!left) { resolve({ site: null }); return; }
    list.forEach(function (site) {
      probeOneSite(site).then(function (r) {
        results.push(r);
        if (!settled && r.ok) {
          settled = true;
          resolve({ site: { name: r.name, base: r.base, kind: r.kind }, ms: r.ms });
        }
        if (--left <= 0 && !settled) { settled = true; resolve({ site: null }); }
      }, function () {
        if (--left <= 0 && !settled) { settled = true; resolve({ site: null }); }
      });
    });
  });
}

/* 选镜像：手动固定 > 上次用的（还活着就继续用，避免每次换域名）> 最快可用 */
async function pickSite(settings, force) {
  var s = settings || await getSettings();
  if (s.ghSite) {
    var pin = siteOfBase(s.ghSite, s);
    if (pin) return { site: pin, pinned: true, probe: siteProbe };
  }
  var probe = await probeSites(force);
  var ok = probe.list.filter(function (x) { return x.ok; });
  if (!ok.length) return { site: null, probe: probe };
  var cached = s.ghSiteCache;
  var keep = ok.filter(function (x) { return cached && x.base === cached; })[0];
  var pick = keep || ok[0];
  return { site: { name: pick.name, base: pick.base, kind: pick.kind }, probe: probe };
}

/* 状态面板：只用缓存立刻回，过期就在后台补一次，绝不让弹窗卡在探测上 */
async function boostState() {
  var s = await getSettings();
  var probe = await siteProbeCached();
  if (!probe || Date.now() - (probe.ts || 0) > SITE_PROBE_TTL) siteProbeLazy(false);

  var raw = s.ghSite || s.ghSiteCache;
  var site = null;
  if (raw) {
    var st = siteOfBase(raw, s);
    var hit = ((probe && probe.list) || []).filter(function (x) {
      return x.base === st.base || x.name === st.name;
    })[0];
    site = {
      name: st.name,
      base: st.base,
      kind: st.kind,
      ok: hit ? hit.ok : null,
      ms: hit ? hit.ms : 0
    };
  }
  return {
    on: !!s.ghBoost,
    site: site,
    pinned: s.ghSite || '',
    sites: (probe && probe.list) || [],
    checking: !probe || Date.now() - (probe.ts || 0) > SITE_PROBE_TTL
  };
}

async function setBoost(on) {
  var s = await getSettings();
  if (!on) {
    await applyBoost(false, '');
    await syncMirrorScript('');
    await saveSettings({ ghBoost: false });
    return { on: false };
  }

  // 线路池刷新放后台：等它跑完再开开关，用户会以为按钮坏了
  refreshPoolLazy();

  // 快路径：有上次用过的镜像就直接生效，通常 100ms 内完成，后台再复核换线
  var quick = s.ghSite ? siteOfBase(s.ghSite, s)
    : (s.ghSiteCache ? siteOfBase(s.ghSiteCache, s) : null);
  if (quick) {
    await ensureSitePerms([quick]);
    var rq = await applyBoost(true, quick);
    if (!rq.error) {
      await syncMirrorScript(quick);
      await saveSettings({ ghBoost: true, ghSiteCache: quick.base });
      siteProbeLazy(true);                       // 后台确认它还活着，挂了自动换
      return { on: true, site: quick, quick: true };
    }
  }

  // 首次开启（或上次那个写规则失败）：探到第一个能用的就上
  var picked = await pickSiteFast(s);
  if (!picked.site) {
    await new Promise(function (r) { setTimeout(r, 700); });
    picked = await pickSiteFast(s);
  }
  if (!picked.site) {
    var pr = await siteProbeCached();
    return {
      error: '镜像全部连不上，先保持直连。可在设置里填一个能用的镜像地址，或稍后再试（镜像会随线路池实时更新）。',
      sites: (pr && pr.list) || []
    };
  }
  await ensureSitePerms([picked.site]);
  var r = await applyBoost(true, picked.site);
  if (r && r.error) return r;
  await syncMirrorScript(picked.site);
  await saveSettings({ ghBoost: true, ghSiteCache: picked.site.base });
  siteProbeLazy(true);
  return { on: true, site: picked.site, ms: picked.ms };
}

/* ---------------- 线路测速 ---------------- */

function cacheKeyOf(url) {
  var p = parseAssetUrl(url);
  return p ? p.owner + '/' + p.repo + '@' + p.tag : url;
}

/* fetch 被拦时只会丢一个 TypeError，光凭它分不清两种情况：
 *   ① 镜像没开跨域 —— 只是浏览器不让我们读响应，downloads 下载完全没问题；
 *   ② 域名/网络真不通 —— 下载也一定失败。
 * 用 no-cors 再问一次就能区分：能拿到响应说明网络可达（①），仍失败才是②。
 * 这一步很关键：之前把②也当成①，还让「直连 518B/s」抢在所有镜像前面，
 * 结果一直在最慢的那条线路上硬爬。 */
async function reachableNoCors(url, timeoutMs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 3000);
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store', redirect: 'follow', signal: ctrl.signal });
    try { ctrl.abort(); } catch (e) {}    // 只确认可达，别把整个文件拖下来
    return true;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function probeOne(route, fileUrl, timeoutMs) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || MIRROR_TIMEOUT_MS);
  var t0 = performance.now();
  try {
    var res = await fetch(routeUrl(route, fileUrl), {
      headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) },
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl.signal
    });
    var ttfb = performance.now() - t0;
    if (res.status !== 200 && res.status !== 206) {
      try { res.body && res.body.cancel(); } catch (e) {}
      return { ok: false, code: res.status, ms: Math.round(ttfb) };
    }
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct.indexOf('text/html') >= 0) {
      try { res.body && res.body.cancel(); } catch (e) {}
      return { ok: false, code: 'html', ms: Math.round(ttfb) };
    }
    var buf = await res.arrayBuffer();
    var dt = Math.max(0.05, (performance.now() - t0) / 1000);
    return { ok: true, code: res.status, bytes: buf.byteLength, ms: Math.round(ttfb), bps: Math.round(buf.byteLength / dt) };
  } catch (e) {
    var nm = (e && e.name) || '';
    // AbortError = 超时；TypeError = 可能是跨域被拦，也可能压根连不上，再确认一次
    if (nm === 'AbortError') return { ok: false, err: 'timeout', ms: Math.round(performance.now() - t0) };
    var reach = await reachableNoCors(routeUrl(route, fileUrl), 2500);
    return { ok: false, err: reach ? 'cors' : 'dead', ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
}

/* 全线路并行试拉一小段，按实测速度排好序 */
async function probeRoutes(probeUrl, cacheKey, force) {
  var settings = await getSettings();
  var key = cacheKey || cacheKeyOf(probeUrl);
  if (!force) {
    if (probeCache && probeCache.key === key && Date.now() - probeCache.ts < ttlOf(probeCache)) return probeCache;
    if (!probeCache) {
      var saved = (await EXT.storage.local.get('routeCache')).routeCache;
      if (saved && saved.key === key && Date.now() - saved.ts < ttlOf(saved)) {
        probeCache = saved;
        return saved;
      }
    }
  }
  var routes = allRoutes(settings);
  var list = await Promise.all(routes.map(async function (r) {
    var got = await probeOne(r, probeUrl);
    return Object.assign({ name: r.name, prefix: r.prefix }, got);
  }));
  list.sort(function (a, b) {
    if (a.ok !== b.ok) return a.ok ? -1 : 1;
    if (a.ok) return (b.bps || 0) - (a.bps || 0);
    return (a.ms || 99999) - (b.ms || 99999);
  });
  var okCount = list.filter(function (r) { return r.ok; }).length;
  var blocked = list.filter(function (r) { return !r.ok && r.err === 'cors'; }).length;
  /* 测速结果只用于这一次的排序，不再写进「历史成功率」：
   * 测速失败不等于这条线路下载会失败（比如域名被浏览器拦、或者只是这次超时），
   * 记进去会让「0成/3败」这种数字看起来像用户下载失败了 3 次，还会把线路一路冷却掉。
   * 历史成绩只由真实下载结果（noteRoute）来记。 */
  var out = { key: key, ts: Date.now(), list: list, probeUrl: probeUrl, okCount: okCount, blocked: blocked };
  probeCache = out;
  try { await EXT.storage.local.set({ routeCache: out }); } catch (e) {}
  return out;
}

/* 全失败的结果不长期缓存：镜像抖动/网络抖动过去后能很快重新测到 */
function ttlOf(cached) {
  var ok = typeof cached.okCount === 'number'
    ? cached.okCount
    : (cached.list || []).filter(function (r) { return r.ok; }).length;
  return ok > 0 ? PROBE_TTL_MS : PROBE_TTL_FAIL_MS;
}

/* 给某个文件排好要依次尝试的线路 */
/* 线路分档：决定「先试谁」。这里最容易犯的错是只看「测速成功」——
 * 直连被测到 518B/s 也算成功，于是它排第一，所有镜像永远轮不到。
 *  0 实测够快      → 按速度从高到低
 *  1 测不出速度（跨域/未知）→ 网络可达，下载照样能走，排第二
 *  2 测得出来但很慢（直连 518B/s 这种）→ 排第三
 *  3 连不上/超时/HTTP 错 → 最后才试
 */
function routeTier(p) {
  if (!p) return 1;
  if (p.ok && (p.bps || 0) >= ROUTE_GOOD_BPS) return 0;
  if (!p.ok && p.err === 'cors') return 1;
  if (p.ok) return 2;
  return 3;
}

async function routesForFile(url, settings) {
  var probed = null;
  if (settings.autoProbe) {
    try { probed = await probeRoutes(url); } catch (e) { probed = null; }
  } else {
    probed = probeCache || (await EXT.storage.local.get('routeCache')).routeCache || null;
  }
  var all = allRoutes(settings);
  var stats = await loadStats();
  var pmap = {};
  if (probed && probed.list) probed.list.forEach(function (r) { pmap[r.prefix] = r; });
  var decorated = all.map(function (r) {
    var p = pmap[r.prefix] || null;
    return { name: r.name, prefix: r.prefix, _p: p, _tier: routeTier(p) };
  });
  decorated.sort(function (a, b) {
    if (a._tier !== b._tier) return a._tier - b._tier;
    var ab = (a._p && a._p.ok) ? (a._p.bps || 0) : 0;
    var bb = (b._p && b._p.ok) ? (b._p.bps || 0) : 0;
    if (ab !== bb) return bb - ab;                       // 同档里实测快的在前
    return routeScore(stats, b.prefix) - routeScore(stats, a.prefix);   // 再按历史健康度
  });
  var order = decorated.map(function (r) { return { name: r.name, prefix: r.prefix }; });
  var now = Date.now();
  var fresh = order.filter(function (r) { return (badUntil.get(r.prefix) || 0) < now; });
  var cooling = order.filter(function (r) { return (badUntil.get(r.prefix) || 0) >= now; });
  var list = fresh.concat(cooling);   // 冷却中的排最后，全都在冷却时也还能兜底
  // 手动指定的线路优先（'@direct' 代表直连）
  var want = prefPrefix(settings && settings.preferRoute);
  if (want !== null) {
    var pi = -1;
    list.forEach(function (r, i) { if (r.prefix === want) pi = i; });
    if (pi > 0) {
      var pick = list.splice(pi, 1)[0];
      list.unshift(pick);
    }
  }
  return list;
}

/* 真正开下之前先探一字节：确认这条线路给的是文件而不是错误页 */
async function preflight(route, url) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 10000);
  try {
    var res = await fetch(routeUrl(route, url), {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl.signal
    });
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    try { res.body && res.body.cancel(); } catch (e) {}
    if (res.status !== 200 && res.status !== 206) return { ok: false, code: res.status };
    if (ct.indexOf('text/html') >= 0) return { ok: false, code: 'html' };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: (e && e.name) || 'fail' };
  } finally {
    clearTimeout(timer);
  }
}

/* 从镜像页点文件名、右键菜单进来的任务只有地址、没有大小。
 * 分片判断依赖 size，取不到就会被当成「小文件」直接走单连接 —— 这正是
 * 「开了国内访问后下载反而只有单线程」的原因。这里用 Range 先问一次总大小。 */
async function probeFileSize(route, url) {
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 3500);
  try {
    var res = await fetch(routeUrl(route, url), {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl.signal
    });
    var cr = res.headers.get('content-range') || '';
    var m = cr.match(/\/(\d+)/);
    var total = m ? Number(m[1]) : 0;
    if (!total && res.status === 200) {
      var len = Number(res.headers.get('content-length') || 0);
      if (len > 0) total = len;
    }
    try { res.body && res.body.cancel(); } catch (e) {}
    return total;
  } catch (e) {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 下载队列 ---------------- */

var ERR_TEXT = {
  NETWORK_FAILED: '网络中断',
  NETWORK_TIMEOUT: '连接超时',
  NETWORK_INVALID_REQUEST: '请求被拒绝',
  SERVER_BAD_CONTENT: '线路返回的内容不对',
  SERVER_UNAUTHORIZED: '线路要求鉴权',
  SERVER_FORBIDDEN: '线路返回 403',
  SERVER_UNREACHABLE: '线路连不上',
  FILE_NO_SPACE: '磁盘空间不足',
  FILE_ACCESS_DENIED: '没有写入权限',
  FILE_NAME_TOO_LONG: '文件名太长',
  FILE_TOO_LARGE: '文件超过系统限制',
  USER_CANCELED: '已取消'
};

function badRequest(code) {
  return code === 'html' || code === 404 || code === 403 || code === 410 || code === 429;
}

function notifyDone(title, message) {
  try {
    EXT.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: title,
      message: message
    }, function () { void EXT.runtime.lastError; });
  } catch (e) { /* ignore */ }
}

function pendingCount() {
  return tasks.filter(function (t) { return t.status === 'queued' || t.status === 'downloading' || t.status === 'probing'; }).length;
}

function updateBadge() {
  var n = pendingCount();
  try {
    if (!EXT.action || !EXT.action.setBadgeText) return;   // 老浏览器没有 action 也不该拖垮后台
    EXT.action.setBadgeText({ text: n ? String(n) : '' });
    EXT.action.setBadgeBackgroundColor({ color: '#FF6A3D' });
  } catch (e) {}
}

async function persist() {
  try {
    await EXT.storage.session.set({ tasks: tasks.slice(-50).map(function (t) { return t; }) });
  } catch (e) {}
}

function pushTask(t) {
  tasks.push(t);
  if (tasks.length > 60) tasks = tasks.slice(-60);
}

/* 按两次事件之间的增量算瞬时速度，再做一次平滑，避免数字乱跳 */
function sampleSpeed(task, received) {
  var now = Date.now();
  var prev = task._sp;
  if (!prev) { task._sp = { b: received, t: now }; return; }
  var dt = (now - prev.t) / 1000;
  if (dt < 0.35) return;
  var inst = Math.max(0, (received - prev.b) / dt);
  task.speed = Math.round(task.speed ? task.speed * 0.45 + inst * 0.55 : inst);
  if (!task.bestSpeed || task.speed > task.bestSpeed) task.bestSpeed = task.speed;
  task._sp = { b: received, t: now };
  maybeBoost(task);
  judgeSlow(task);
}

/* 自动「暂停→继续」提速：
 * 单连接靠 downloads 的 pause/resume，等于让浏览器换一条连接重新要剩余字节；
 * 分片下载则把慢掉的分片重连，已经下好的部分不丢。
 * 触发条件跟桌面版一致：掉到本次峰值 45% 以下、连着两次、间隔 25 秒、最多 5 次。 */
function maybeBoost(task) {
  if (task.status !== 'downloading') return false;   // 暂停/排队时别乱重连
  var total = task.total || task.size || 0;
  if (!total) return false;
  if ((task.boostCount || 0) >= 5) return false;
  if (total - task.received < 1024 * 1024) return false;    // 尾巴就不折腾了
  var now = Date.now();
  if (now - (task.lastBoostAt || 0) < 25000) return false;
  var th = Math.max(5, (settingsCache || DEFAULT_SETTINGS).lowSpeedKB || 40) * 1024;
  // 两种情况都值得重连：掉到本次峰值一半以下，或者本身就慢得可怜
  var dip = task.bestSpeed && task.speed < task.bestSpeed * 0.45;
  var absSlow = task.speed > 0 && task.speed < th;
  if (!dip && !absSlow) {
    task.slowStreak = 0;
    return false;
  }
  task.slowStreak = (task.slowStreak || 0) + 1;
  if (task.slowStreak < 2) return false;
  task.slowStreak = 0;
  task.boostCount = (task.boostCount || 0) + 1;
  task.lastBoostAt = now;
  task.boosting = true;
  setTimeout(function () { task.boosting = false; }, 1800);
  if (task.segmented) {
    segSend({ type: 'seg-boost', id: task.id });
  } else if (task.downloadId) {
    try {
      callExt(EXT.downloads.pause, EXT.downloads, [task.downloadId], function () {
        setTimeout(function () {
          callExt(EXT.downloads.resume, EXT.downloads, [task.downloadId]);
        }, 400);
      });
    } catch (e) {}
  }
  return true;
}

/* 慢速判定：连续 SLOW_JUDGE_MS 低于阈值就把任务标成 slow，界面据此提示换线路 */
function judgeSlow(task) {
  if (task.status !== 'downloading') return;         // 暂停时速度本来就是 0，别误判成慢
  var s = settingsCache || DEFAULT_SETTINGS;
  var th = Math.max(5, s.lowSpeedKB || 40) * 1024;
  var total = task.total || task.size || 0;
  var now = Date.now();
  if (!task.speed || task.speed > th * 1.6 || (total && task.received > total * 0.92)) {
    task.slowSince = 0;
    task.slow = false;
    return;
  }
  if (!task.slowSince) { task.slowSince = now; return; }
  var spent = now - task.slowSince;
  if (spent >= SLOW_JUDGE_MS) task.slow = true;

  // 换线次数有上限；已经下了不少也不换（换线等于把这部分白扔）
  if ((task.routeTries || 0) >= MAX_ROUTE_TRIES) return;
  if (total && task.received > total * 0.08) return;
  // 一上来就慢到没救（直连被限成几十 KB/s）：给它 5.5 秒，不行立刻换下一条，
  // 不再等「暂停→继续」折腾两轮 —— 以前要 50 秒以上才换，而且还是只允许换一次。
  var hopeless = spent >= FAST_SWITCH_MS && (task.bestSpeed || 0) < th * 2;
  var overdue = spent >= AUTO_SWITCH_MS;
  if (hopeless || overdue) switchRoute(task, null, true);
}

/* 换线路：停掉当前这条，从下一条（或指定线路）重新开始 */
async function switchRoute(task, prefix, auto) {
  if (!task || task.switching) return false;      // 换线期间别被反复触发
  task.switching = true;
  try {
    return await doSwitchRoute(task, prefix, auto);
  } finally {
    task.switching = false;
  }
}

async function doSwitchRoute(task, prefix, auto) {
  if (!task) return false;
  var settings = await settingsNow();
  var order = await routesForFile(task.url, settings);
  if (!order.length) return false;

  // 记住这个任务试过哪些线路，避免换线绕一圈又回到刚放弃的那条
  var tried = (task.triedRoutes || []).slice();
  if (task.routePrefix !== undefined && tried.indexOf(task.routePrefix) < 0) tried.push(task.routePrefix);
  task.triedRoutes = tried;

  var idx;
  if (prefix) {
    idx = 0;
    order.forEach(function (r, i) { if (r.prefix === prefix) idx = i; });
  } else {
    var start = (Number(task.routeIdx) || 0) + 1;
    idx = -1;
    for (var k = 0; k < order.length; k++) {
      var cand = (start + k) % order.length;
      if (tried.indexOf(order[cand].prefix) < 0) { idx = cand; break; }
    }
    if (idx < 0) idx = start % order.length;      // 兜底：全试过了就从下一条重来
  }

  // 自动换线说明这条线路实际表现不行：扣分 + 冷却，下次别再排它第一
  if (auto && task.routePrefix !== undefined) {
    task.routeTries = (task.routeTries || 0) + 1;
    noteRoute(task.routePrefix, false, 0);
    badUntil.set(task.routePrefix, Date.now() + 3 * 60 * 1000);
  }

  var dlId = task.downloadId;
  if (dlId) {
    activeIds.delete(dlId);          // 先摘掉，cancel 触发的 interrupted 就不会走失败重试
    callExt(EXT.downloads.cancel, EXT.downloads, [dlId]);
  }
  if (task.segmented) abortSeg(task);
  task.downloadId = 0;
  task.segmented = false;
  if (task.blobUrl) { revokeBlob(task.blobUrl); task.blobUrl = ''; }
  // 暂停中的任务换线路：保持暂停，等用户点「继续」再在新线路上重新开始
  var wasPaused = task.status === 'paused';
  task.status = wasPaused ? 'paused' : 'queued';
  task.routeIdx = idx;
  task.received = 0;
  task.speed = 0;
  task.slow = false;
  task.slowSince = 0;
  task._sp = null;
  task.error = '';
  task.bestSpeed = 0;              // 新线路重新计峰值，别拿上一条线的成绩判断它
  task.boostCount = 0;
  task.slowStreak = 0;
  var r = order[idx];
  if (r) task.route = r.name + (r.prefix ? '' : '（直连）');
  persist();
  updateBadge();
  pump();
  return true;
}

function cancelTask(task) {
  if (!task) return;
  var dlId = task.downloadId;
  if (dlId) {
    activeIds.delete(dlId);
    callExt(EXT.downloads.cancel, EXT.downloads, [dlId]);
  }
  if (task.segmented) abortSeg(task);
  task.segmented = false;
  task.downloadId = 0;
  task.status = 'canceled';
  task.error = '已取消';
  task.speed = 0;
  finishOne();
}

/* ---------------- 暂停 / 继续 ----------------
 * 分片下载：掐断在飞连接，chunks 全留着，继续时只补剩余区间（真正的暂停续传）。
 * 单连接：交给 downloads.pause/resume，浏览器自己保住已下的字节。
 * 还没轮到（排队/选线中）的直接挂起，pump 就不会取它。
 */
async function pauseTask(task) {
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.status === 'paused') return { ok: true };
  if (task.status === 'queued' || task.status === 'probing') {
    task.status = 'paused';
    task.speed = 0;
    task.boosting = false;
    persist(); updateBadge(); pump();
    return { ok: true };
  }
  if (task.status !== 'downloading') return { ok: false, error: '这个任务已经结束' };

  if (task.segmented) {
    segSend({ type: 'seg-pause', id: task.id });
    task.status = 'paused';
    task.speed = 0;
    task.boosting = false;
    task.slow = false;
    task.slowSince = 0;
    task._sp = null;
    persist(); updateBadge(); pump();
    return { ok: true };
  }

  var id = task.downloadId;
  if (!id) {
    // downloads.download() 是异步的：刚点下载的那几百毫秒里还没有 downloadId。
    // 先记下「想暂停」，连接一建好马上停，别让用户看到「没有可暂停的连接」。
    task.pauseWanted = true;
    task.status = 'paused';
    task.speed = 0;
    task.boosting = false;
    task.slow = false;
    persist(); updateBadge(); pump();
    return { ok: true, deferred: true };
  }
  return new Promise(function (resolve) {
    callExt(EXT.downloads.pause, EXT.downloads, [id], function (err) {
      if (err) {
        resolve({ ok: false, error: '这条线路不支持暂停，可以「换线路」或「取消」后重来' });
        return;
      }
      task.status = 'paused';
      task.speed = 0;
      task.boosting = false;
      task.slow = false;
      task.slowSince = 0;
      task._sp = null;
      persist(); updateBadge(); pump();
      resolve({ ok: true });
    });
  });
}

async function resumeTask(task) {
  if (!task) return { ok: false, error: '任务不存在' };
  if (task.status !== 'paused') return { ok: false, error: '这个任务没有暂停' };

  if (task.segmented) {
    task.status = 'downloading';
    task.speed = 0;
    task.slow = false;
    task.slowSince = 0;
    task._sp = null;
    segSend({ type: 'seg-resume', id: task.id });
    persist(); updateBadge();
    return { ok: true };
  }

  if (task.downloadId) {
    return new Promise(function (resolve) {
      callExt(EXT.downloads.resume, EXT.downloads, [task.downloadId], function (err) {
        if (err) {
          // 连接已经被浏览器回收，只能重新排一次
          task.status = 'queued';
          task.downloadId = 0;
          task.received = 0;
          task.speed = 0;
          task.error = '';
          persist(); pump();
          resolve({ ok: true, requeued: true });
          return;
        }
        task.status = 'downloading';
        task.speed = 0;
        task.slow = false;
        task.slowSince = 0;
        task._sp = null;
        persist(); updateBadge();
        resolve({ ok: true });
      });
    });
  }

  // 后台被回收过，下载对象已经不在：重新排队，从头要（浏览器那边的临时文件可能也没了）
  task.status = 'queued';
  task.received = 0;
  task.speed = 0;
  task.segmented = false;
  task.error = '';
  persist(); pump();
  return { ok: true, requeued: true };
}

/* ---------------- 分片下载（多线程） ---------------- */

var offCreating = null;

/* Firefox 没有 offscreen 文档，但它本来就有常驻的后台页面：
 * 构建 Firefox 包时把 off.js 一起放进 background.scripts，分片逻辑直接跑在后台里，
 * 两边共用同一套 seg-* 消息。 */
var SEG_INLINE = IS_FF;

async function hasOffscreen() {
  if (SEG_INLINE) return true;
  try {
    if (EXT.offscreen && EXT.offscreen.hasDocument) return await EXT.offscreen.hasDocument();
    var ctxs = await EXT.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return !!(ctxs && ctxs.length);
  } catch (e) {
    return false;
  }
}

async function ensureOffscreen() {
  if (SEG_INLINE) return true;        // Firefox：off.js 已经在后台页里跑着
  if (!EXT.offscreen) return false;
  if (await hasOffscreen()) return true;
  if (!offCreating) {
    offCreating = EXT.offscreen.createDocument({
      url: 'src/off.html',
      reasons: ['BLOBS'],
      justification: '多线程分片下载后拼装成文件，再交给浏览器保存'
    }).catch(function () {}).then(function () { offCreating = null; });
  }
  await offCreating;
  return await hasOffscreen();
}

async function startSegmented(task, route, settings, order) {
  try {
    if (!(await ensureOffscreen())) return false;
    task.segmented = true;
    task.status = 'downloading';
    task.received = 0;
    task.speed = 0;
    task.bestSpeed = 0;
    task.boostCount = 0;
    task.slow = false;
    task._sp = null;
    segTasks.set(task.id, task);
    // 每片换一条线路：同一时刻问不同的镜像要数据，比在一条慢线路上挤快得多
    var urls = [];
    var pool = (order || []).filter(function (r) { return r.prefix === route.prefix; })
      .concat((order || []).filter(function (r) { return r.prefix !== route.prefix; }));
    pool.forEach(function (r) { urls.push(routeUrl(r, task.url)); });
    if (!urls.length) urls = [routeUrl(route, task.url)];
    segSend({
      type: 'seg-start',
      id: task.id,
      url: urls[0],
      urls: urls.slice(0, 6),
      size: task.size || 0,
      threads: Math.max(2, Math.min(6, settings.threads || 4))
    });
    persist();
    return true;
  } catch (e) {
    task.segmented = false;
    return false;
  }
}

function segSend(payload) {
  callExt(EXT.runtime.sendMessage, EXT.runtime,
    [Object.assign({ target: 'offscreen' }, payload)]);
}

function abortSeg(task) {
  segTasks.delete(task.id);
  segSend({ type: 'seg-abort', id: task.id });
}

function revokeBlob(url) {
  segSend({ type: 'seg-revoke', url: url });
}

function onSegProgress(m) {
  var task = segTasks.get(m.id);
  if (!task) return;
  task.received = m.received || 0;
  if (m.total) { task.total = m.total; if (!task.size) task.size = m.total; }
  if (typeof m.speed === 'number' && m.speed > 0) {
    task.speed = m.speed;
    if (!task.bestSpeed || m.speed > task.bestSpeed) task.bestSpeed = m.speed;
  }
  maybeBoost(task);
  judgeSlow(task);
}

async function onSegDone(m) {
  var task = segTasks.get(m.id);
  if (!task) { revokeBlob(m.url); return; }
  segTasks.delete(m.id);
  task.segmented = false;
  task.blobUrl = m.url;
  if (m.total) { task.total = m.total; task.size = task.size || m.total; }
  try {
    markOurDownload(m.url);      // blob: 地址，登记一下更保险
    var id = await extDownload({
      url: m.url,
      filename: task.path,
      conflictAction: task.tries > 0 ? 'overwrite' : 'uniquify',
      saveAs: false
    });
    task.downloadId = id;
    task.received = task.total || task.size || task.received;
    activeIds.set(id, task);
    persist();
  } catch (e) {
    revokeBlob(m.url);
    task.blobUrl = '';
    task.segFailed = true;          // 这个文件以后走单连接，别反复折腾
    task.status = 'queued';
    task.received = 0;
    task.error = '';
    pump();
  }
}

function onSegError(m) {
  var task = segTasks.get(m.id);
  if (!task) return;
  segTasks.delete(m.id);
  task.segmented = false;
  task.segFailed = true;           // 镜像不支持 Range 之类，退回单连接
  noteRoute(task.routePrefix, false, 0);
  task.status = 'queued';
  task.received = 0;
  task.speed = 0;
  task._sp = null;
  task.error = '分片失败，改用单连接';
  pump();
}

/* ---------------- 兜底：下载绝不落到镜像上 ---------------- */

/* 扩展自己发起的下载先登记（地址做一次解码归一，浏览器可能把 %xx 等重新编码），
 * onCreated 里据此跳过，绝不误杀自己的任务。 */
var ourDownloadUrls = new Set();
function normDlUrl(u) {
  try { return decodeURI(new URL(u).href); } catch (e) { return String(u || ''); }
}
function markOurDownload(url) {
  var k = normDlUrl(url);
  if (!k) return;
  ourDownloadUrls.add(k);
  setTimeout(function () { ourDownloadUrls.delete(k); }, 30000);
}
function isOurRouteUrl(u) {
  var key = normDlUrl(u);
  return tasks.some(function (t) {
    if (t.status !== 'downloading' && t.status !== 'probing') return false;
    if (!t.routePrefix) return false;
    return normDlUrl(routeUrl({ prefix: t.routePrefix }, t.url)) === key;
  });
}

/* 镜像域名上的 Release 文件地址 → github.com 原地址（其它地址返回空） */
async function mirrorAssetToGithub(u) {
  try {
    var url = new URL(u);
    if (!/^https?:$/.test(url.protocol)) return '';
    if (!/\/releases\/download\//i.test(url.pathname)) return '';
    var s = await getSettings();
    if (!isMirrorHost(url.host, s)) return '';
    var gh = ghCanonical(url.href);
    if (!gh || gh === url.href) return '';
    return gh;
  } catch (e) {
    return '';
  }
}

/* 通知当前标签的内容脚本：打开面板，并把这个文件直接加进下载队列 */
function notifyAutoDownload(gh) {
  callExt(EXT.tabs.query, EXT.tabs, [{ active: true, currentWindow: true }], function (err, tabs) {
    var t = !err && tabs && tabs[0];
    if (!t || !t.id) return;
    try {
      /* Firefox 的 browser.tabs.sendMessage 只返回 Promise，第三个回调参数会被忽略，
       * 这里统一按返回值处理，两种浏览器都不会漏掉异常。 */
      var ps = EXT.tabs.sendMessage(t.id, { type: 'open-panel', auto: gh });
      if (ps && ps.catch) ps.catch(function () {});
    } catch (e) {}
  });
}

/* 浏览器自己从镜像开始了下载（新标签打开、脚本没拦住、镜像页面的直链等）：
 * 立刻取消，改由扩展按线路池 + 分片重下 —— 镜像直连又慢又不能续传。
 * 只认「镜像域名 + /releases/download/」，扩展自己的下载已在上面登记，不会误伤。 */
try {
  if (EXT.downloads && EXT.downloads.onCreated) {
    EXT.downloads.onCreated.addListener(function (item) {
      if (!item || !item.url || item.id == null) return;
      var key = normDlUrl(item.url);
      if (ourDownloadUrls.has(key)) return;
      if (isOurRouteUrl(item.url)) return;
      mirrorAssetToGithub(item.url).then(function (gh) {
        if (!gh) return;
        callExt(EXT.downloads.cancel, EXT.downloads, [item.id]);
        callExt(EXT.downloads.erase, EXT.downloads, [{ id: item.id }]);
        enqueue([{ url: gh }]);
        notifyAutoDownload(gh);
      }).catch(function () {});
    });
  }
} catch (e) {}

/* Chrome 的 downloads.download() 只给回调、不返回 Promise，
 * 直接 await 拿到的是 undefined，下载编号就丢了（进度、暂停、换线全跟着失效）。
 * 统一走 callExt，两种浏览器都能拿到 id。 */
function extDownload(opts) {
  return new Promise(function (resolve, reject) {
    callExt(EXT.downloads.download, EXT.downloads, [opts], function (err, id) {
      if (err) { reject(err instanceof Error ? err : new Error(String(err))); return; }
      if (id == null) { reject(new Error('浏览器没有返回下载编号')); return; }
      resolve(id);
    });
  });
}

async function enqueue(items) {
  var settings = await getSettings();
  var added = 0;
  items.forEach(function (it) {
    if (!it || !it.url) return;
    /* 队列里的地址一律是 github.com 原地址：
     * 线路池是「前缀 + github 地址」拼出来的，如果这里混进镜像地址，
     * 就会拼成 https://gh-proxy.com/https://gh-proxy.at9.net/... 这种套娃，又慢又容易失败。 */
    var url = ghCanonical(it.url);
    var dup = tasks.some(function (t) {
      return t.url === url && (t.status === 'queued' || t.status === 'downloading' ||
        t.status === 'probing' || t.status === 'paused');
    });
    if (dup) return;
    var p = parseAssetUrl(url) || {};
    pushTask({
      id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      url: url,
      name: it.asset || p.asset || 'download.bin',
      path: it.path || buildPath({
        owner: it.owner || p.owner,
        repo: it.repo || p.repo,
        tag: it.tag || p.tag,
        asset: it.asset || p.asset
      }, settings),
      size: it.size || 0,
      received: 0,
      total: it.size || 0,
      status: 'queued',
      route: '',
      routeIdx: 0,
      tries: 0,
      error: ''
    });
    added++;
  });
  updateBadge();
  persist();
  pump();
  return { added: added, blocked: items.length - added, pending: pendingCount() };
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    var settings = await getSettings();
    var limit = Math.max(1, Math.min(6, settings.concurrency || 2));
    while (true) {
      var running = tasks.filter(function (t) { return t.status === 'downloading' || t.status === 'probing'; }).length;
      if (running >= limit) break;
      var next = tasks.filter(function (t) { return t.status === 'queued'; })[0];
      if (!next) break;
      next.status = 'probing';
      startTask(next, settings);   // 不 await：并发跑
    }
  } finally {
    pumping = false;
    updateBadge();
  }
}

async function startTask(task, settings) {
  try {
    var order = await routesForFile(task.url, settings);
    if (!order.length) throw new Error('没有可用线路');
    // 选线期间用户可能点了暂停/取消：别把它又拽回「下载中」
    if (task.status !== 'probing') { updateBadge(); pump(); return; }
    var route = order[task.routeIdx % order.length];
    // 没有大小就先探一次（镜像页点链接 / 右键菜单 / 老队列），不然多线程永远用不上
    if (!task.size && !task.total) {
      var probed = await probeFileSize(route, task.url);
      if (probed) task.size = probed;
      if (task.status !== 'probing') { updateBadge(); pump(); return; }
    }
    var size0 = task.size || task.total || 0;
    var segCap0 = (settings.segMaxMB || 128) * 1024 * 1024;
    var willSeg = settings.segEnabled !== false && !task.segFailed &&
      size0 > 1024 * 1024 && size0 <= segCap0;
    // 分片下载自带失败回退（发不出 Range 会自动改单连接），不必再单独探一字节；
    // 省掉这次往返，批量下载的启动能快好几百毫秒。
    var check = (settings.autoProbe && !willSeg) ? await preflight(route, task.url) : { ok: true };
    if (task.status !== 'probing') { updateBadge(); pump(); return; }
    if (!check.ok) {
      task.error = '线路 ' + route.name + '：' + (check.code === 'html' ? '返回网页而非文件' : check.code);
      task.routeIdx++;
      task.tries++;
      if (badRequest(check.code)) badUntil.set(route.prefix, Date.now() + 3 * 60 * 1000);
      // 两条不同的线路都说 404，基本可以断定文件真不在，别让用户白等 20 条线路
      if (check.code === 404 || check.code === 410) task.nf404 = (task.nf404 || 0) + 1;
      if (task.nf404 >= 2) {
        task.status = 'failed';
        task.error = '文件不存在（404），确认版本号和文件名仍然有效';
        finishOne();
        return;
      }
      if (task.tries >= (settings.maxRetries || 4)) {
        task.status = 'failed';
        task.error = '所有线路都没能取到文件，稍后再试或换个线路';
        finishOne();
        return;
      }
      task.status = 'queued';
      pump();
      return;
    }
    task.route = route.name + (route.prefix ? '' : '（直连）');
    task.routePrefix = route.prefix;
    task.status = 'downloading';
    task.slow = false;
    task.slowSince = 0;
    task._sp = null;
    // 能分片就分片：多线程拉同一文件，小文件走浏览器单连接就好
    if (willSeg) {
      if (await startSegmented(task, route, settings, order)) {
        if (task.pauseWanted) {
          task.pauseWanted = false;
          task.status = 'downloading';
          pauseTask(task);
        }
        updateBadge();
        return;
      }
    }
    var dlUrl = routeUrl(route, task.url);
    markOurDownload(dlUrl);      // 这条是我们自己发起的：onCreated 兜底千万别拦
    var id = await extDownload({
      url: dlUrl,
      filename: task.path,
      conflictAction: task.tries > 0 ? 'overwrite' : 'uniquify',
      saveAs: false
    });
    task.downloadId = id;
    activeIds.set(id, task);
    // 下载按钮点下后、连接建好前用户就点了暂停：这里补上
    if (task.pauseWanted) {
      task.pauseWanted = false;
      task.status = 'downloading';
      pauseTask(task);
    }
    updateBadge();
    persist();
  } catch (e) {
    task.status = 'failed';
    task.error = (e && e.message) || String(e);
    finishOne();
  }
}

var doneSince = 0;
function finishOne() {
  updateBadge();
  persist();
  var live = pendingCount();
  if (live === 0 && doneSince > 0) {
    getSettings().then(function (s) {
      if (s.notify) notifyDone('下载完成', '本批 ' + doneSince + ' 个文件已交给浏览器下载');
      doneSince = 0;
    });
  }
  pump();
}

/* 单连接下载的进度兜底：onChanged 的 bytesReceived 在部分环境（含无头 Chrome）
 * 给得很稀甚至不给，光靠事件会出现「进度一直 0、结束时突然 100%」。
 * 这里每隔一会儿用 downloads.search 主动同步一次，一次调用覆盖所有在下的任务。 */
function syncProgress() {
  if (!activeIds.size) return;
  callExt(EXT.downloads.search, EXT.downloads, [{ state: 'in_progress' }], function (err, list) {
    if (err) return;
    (list || []).forEach(function (d) {
      var task = activeIds.get(d.id);
      if (!task || task.status !== 'downloading') return;
      if (d.totalBytes > 0) {
        task.total = d.totalBytes;
        if (!task.size) task.size = d.totalBytes;
      }
      if (typeof d.bytesReceived === 'number' && d.bytesReceived !== task.received) {
        task.received = d.bytesReceived;
        sampleSpeed(task, task.received);
      }
    });
  });
}
setInterval(syncProgress, 1200);

function handleChange(delta) {
  var task = activeIds.get(delta.id);
  if (!task) return;
  if (delta.bytesReceived) {
    task.received = delta.bytesReceived.current || 0;
    sampleSpeed(task, task.received);
  }
  if (delta.totalBytes && delta.totalBytes.current > 0) {
    task.total = delta.totalBytes.current;
    if (!task.size) task.size = task.total;
  }
  if (delta.state && delta.state.current === 'complete') {
    activeIds.delete(delta.id);
    task.status = 'done';
    task.received = task.total || task.size;
    noteRoute(task.routePrefix, true, task.bestSpeed || 0);
    task.speed = 0;
    task.slow = false;
    task.downloadId = 0;
    if (task.blobUrl) { revokeBlob(task.blobUrl); task.blobUrl = ''; }
    markDownloaded(task);          // 记进历史，列表里这一行显示「已下载」
    doneSince++;
    finishOne();
    return;
  }
  if (delta.state && delta.state.current === 'interrupted') {
    var err = (delta.error && delta.error.current) || 'NETWORK_FAILED';
    // 用户点暂停时 Chrome 也会报 interrupted(USER_PAUSED)：保留映射，继续时还要用同一个 id
    if (err === 'USER_PAUSED') {
      task.status = 'paused';
      task.speed = 0;
      task.slow = false;
      task._sp = null;
      persist();
      updateBadge();
      return;
    }
    activeIds.delete(delta.id);
    var settingsP = getSettings();
    settingsP.then(function (settings) {
      // 用户主动取消 / 磁盘满，重试没意义
      if (err === 'USER_CANCELED') {
        task.status = 'canceled';
        task.error = '已取消';
        finishOne();
        return;
      }
      if (err === 'FILE_NO_SPACE' || err === 'FILE_ACCESS_DENIED' || err === 'FILE_NAME_TOO_LONG') {
        task.status = 'failed';
        task.error = ERR_TEXT[err] || err;
        finishOne();
        return;
      }
      // 清掉失败的下载记录，否则重试会留下 (1)(2) 副本
      callExt(EXT.downloads.erase, EXT.downloads, [{ id: delta.id }]);
      task.tries++;
      // 把刚才这条线路冷却 3 分钟，下次从下一条开始
      if (task.routePrefix !== undefined) {
        badUntil.set(task.routePrefix, Date.now() + 3 * 60 * 1000);
        noteRoute(task.routePrefix, false, 0);
      }
      task.routeIdx = (task.routeIdx || 0) + 1;
      if (task.tries >= (settings.maxRetries || 4)) {
        task.status = 'failed';
        task.error = (ERR_TEXT[err] || err) + '，已试过 ' + task.tries + ' 条线路';
      } else {
        task.status = 'queued';
        task.error = '';
        task.received = 0;
      }
      finishOne();
    });
  }
}

try {
  EXT.downloads.onChanged.addListener(handleChange);
} catch (e) {}

/* ---------------- 消息路由 ---------------- */

onMessage(function (msg, sender, respond) {
  if (msg && msg.target === 'offscreen') return false;   // 发给隐藏文档的，后台不处理
  (async function () {
    try {
      switch (msg.type) {
        case 'list-releases':
          respond(await listReleases(msg.repo, msg.perPage));
          break;
        case 'list-assets':
          respond(await listAssets(msg.repo, msg.tag));
          break;
        case 'probe':
          respond(await probeRoutes(msg.url, msg.key, msg.force));
          break;
        case 'routes': {
          var s = await getSettings();
          var stats0 = await loadStats();
          var now0 = Date.now();
          respond({
            routes: allRoutes(s).map(function (r) {
              var e = stats0[r.prefix] || {};
              return {
                name: r.name,
                prefix: r.prefix,
                ok: e.ok || 0,
                fail: e.fail || 0,
                score: Math.round(routeScore(stats0, r.prefix)),
                cooling: (badUntil.get(r.prefix) || 0) > now0,
                coolUntil: badUntil.get(r.prefix) || 0,
              };
            }),
            pool: POOL_INFO,
            prefer: s.preferRoute || '',
            cached: probeCache || (await EXT.storage.local.get('routeCache')).routeCache || null
          });
          break;
        }
        case 'refresh-pool': {
          var rp = await refreshPool(msg.force !== false);
          respond(rp);
          break;
        }
        case 'boost-state':
          respond(await boostState());
          break;
        case 'boost-set':
          respond(await setBoost(!!msg.on));
          break;
        case 'boost-probe':
          respond({ list: (await probeSites(true)).list });
          break;
        case 'boost-site': {
          var s3a = await getSettings();
          var want3 = String(msg.base || '').trim();
          var site3 = want3 ? siteOfBase(want3, s3a) : null;
          await saveSettings({ ghSite: site3 ? site3.base : '' });
          var s3 = await getSettings();
          var info = { ok: true };
          if (s3.ghBoost) {
            var p3 = site3 ? { site: site3 } : await pickSite(s3, true);
            if (p3.site) {
              await ensureSitePerms([p3.site]);
              var r3 = await applyBoost(true, p3.site);
              if (r3 && r3.error) info.error = r3.error;
              await syncMirrorScript(p3.site);
              await saveSettings({ ghSiteCache: p3.site.base });
              info.site = p3.site;
            } else {
              info.error = '这个镜像连不上';
            }
          }
          info.state = await boostState();
          respond(info);
          break;
        }
        /* 开关刚打开时，把当前这个 github.com 标签直接换到镜像，用户不用手动刷新 */
        case 'boost-current': {
          var s4 = await getSettings();
          var site4 = s4.ghSiteCache ? siteOfBase(s4.ghSiteCache, s4)
            : (s4.ghSite ? siteOfBase(s4.ghSite, s4) : null);
          if (!s4.ghBoost || !site4) { respond({ ok: false, reason: 'off' }); break; }
          var tabs4 = await EXT.tabs.query({ active: true, lastFocusedWindow: true });
          var t4 = tabs4 && tabs4[0];
          if (!t4 || !t4.url) { respond({ ok: false, reason: 'no-tab' }); break; }
          if (!/^https?:\/\/(www\.)?github\.com\//i.test(t4.url)) {
            respond({ ok: false, reason: 'not-github' });
            break;
          }
          var target = siteUrl(site4, t4.url);
          // 刚注册的镜像 content script 需要一拍才生效，等一下再跳，否则这个标签
          // 会缺右下角面板（新开的标签不受影响）
          await new Promise(function (r) { setTimeout(r, 400); });
          await EXT.tabs.update(t4.id, { url: target });
          respond({ ok: true, url: target, site: site4 });
          break;
        }
        case 'enqueue':
          respond(await enqueue(msg.items || []));
          break;
        case 'state':
          syncProgress();       // 打开界面时顺手刷一次单连接进度
          respond({
            tasks: tasks.slice(-50).map(function (t) {
              return {
                id: t.id, name: t.name, path: t.path, url: t.url, size: t.size, received: t.received,
                total: t.total, status: t.status, route: t.route, error: t.error,
                speed: t.speed || 0, slow: !!t.slow, segmented: !!t.segmented,
                boosting: !!t.boosting, boostCount: t.boostCount || 0,
                paused: t.status === 'paused',
                routePrefix: t.routePrefix || ''
              };
            }),
            histVer: histVer,
            pending: pendingCount(),
            probe: probeCache ? { ts: probeCache.ts, list: probeCache.list.slice(0, 6) } : null
          });
          break;
        case 'history': {
          var hh = await loadHist();
          var sub = {};
          (msg.urls || []).forEach(function (u) {
            if (u && hh[u]) sub[u] = hh[u].ts || 0;
          });
          respond({ hist: sub, ver: histVer, total: Object.keys(hh).length });
          break;
        }
        case 'clear-history':
          dlHist = {};
          histVer++;
          try { await EXT.storage.local.set({ dlHist: {} }); } catch (e) {}
          respond({ ok: true });
          break;
        case 'pause-task': {
          var pt = tasks.filter(function (x) { return x.id === msg.id; })[0];
          respond(await pauseTask(pt));
          break;
        }
        case 'resume-task': {
          var rt = tasks.filter(function (x) { return x.id === msg.id; })[0];
          respond(await resumeTask(rt));
          break;
        }
        case 'switch-route': {
          var st = tasks.filter(function (x) { return x.id === msg.id; })[0];
          respond({ ok: await switchRoute(st, msg.prefix || '', false) });
          break;
        }
        case 'cancel-task': {
          var ct = tasks.filter(function (x) { return x.id === msg.id; })[0];
          cancelTask(ct);
          respond({ ok: !!ct });
          break;
        }
        case 'seg-progress':
          onSegProgress(msg);
          respond({ ok: true });
          break;
        case 'seg-done':
          await onSegDone(msg);
          respond({ ok: true });
          break;
        case 'seg-error':
          onSegError(msg);
          respond({ ok: true });
          break;
        case 'cancel-all':
          tasks.forEach(function (t) {
            if (t.status === 'queued' || t.status === 'probing') { t.status = 'canceled'; t.error = '已取消'; }
            if (t.status === 'downloading' || t.status === 'paused') {
              if (t.segmented) abortSeg(t);
              if (t.downloadId) {
                callExt(EXT.downloads.cancel, EXT.downloads, [t.downloadId]);
                t.downloadId = 0;
              }
              t.status = 'canceled';
              t.error = '已取消';
            }
          });
          updateBadge();
          respond({ ok: true });
          break;
        case 'open-options':
          try { EXT.runtime.openOptionsPage(); } catch (e) {}
          respond({ ok: true });
          break;
        case 'open-url':
          // 内容脚本在页面里够不着 tabs API，跳转统一走后台
          try {
            if (msg.url) EXT.tabs.create({ url: msg.url });
            respond({ ok: true });
          } catch (e) {
            respond({ error: String(e && e.message || e) });
          }
          break;
        case 'notify':
          notifyDone(msg.title || 'GitHub Release 下载助手', msg.message || '');
          respond({ ok: true });
          break;
        default:
          respond({ error: 'unknown message: ' + msg.type });
      }
    } catch (e) {
      respond({ error: (e && e.message) || String(e) });
    }
  })();
  return true;
});

/* ---------------- 右键菜单 ---------------- */

function buildMenus() {
  try {
    callExt(EXT.contextMenus.removeAll, EXT.contextMenus, [], function () {
      EXT.contextMenus.create({
        id: 'ghdl-link',
        title: '用下载助手下载此文件',
        contexts: ['link'],
        targetUrlPatterns: ['*://github.com/*/releases/download/*']
      });
      EXT.contextMenus.create({
        id: 'ghdl-page',
        title: '扫描本页 Release 资源',
        contexts: ['page'],
        documentUrlPatterns: ['*://github.com/*/releases*']
      });
    });
  } catch (e) {}
}

try {
  EXT.runtime.onInstalled.addListener(buildMenus);
  EXT.runtime.onStartup.addListener(buildMenus);
} catch (e) {}

try {
  EXT.contextMenus.onClicked.addListener(function (info, tab) {
    if (info.menuItemId === 'ghdl-link' && info.linkUrl) {
      var p = parseAssetUrl(info.linkUrl);
      getSettings().then(function (s) {
        enqueue([{
          url: info.linkUrl,
          owner: p && p.owner, repo: p && p.repo, tag: p && p.tag,
          asset: p && p.asset,
          path: p ? buildPath(p, s) : undefined
        }]);
      });
    }
    if (info.menuItemId === 'ghdl-page' && tab && tab.id) {
      try {
        var ps2 = EXT.tabs.sendMessage(tab.id, { type: 'open-panel' });
        if (ps2 && ps2.catch) ps2.catch(function () {});
      } catch (e) {}
    }
  });
} catch (e) {}

/* 重启后恢复队列（Service Worker 被回收也尽量不丢） */
(async function restore() {
  try {
    var got = await EXT.storage.session.get('tasks');
    if (got && Array.isArray(got.tasks) && got.tasks.length) {
      tasks = got.tasks;
      tasks.forEach(function (t) {
        // 老版本可能把镜像地址存进了队列（会拼成镜像套镜像），恢复时统一纠正
        if (t && t.url) t.url = ghCanonical(t.url);
        // 暂停的任务也一起重排：downloadId 已经跟 Service Worker 一起丢了，
        // 留着 paused 状态用户点「继续」也只能从头来，不如直接接着下。
        if (t && (t.status === 'downloading' || t.status === 'probing' || t.status === 'paused')) {
          t.status = 'queued';
          t.downloadId = 0;
        }
      });
      updateBadge();
      pump();
    }
  } catch (e) {}
})();

/* 启动时把线路池刷一遍（走缓存，12 小时内不重复请求），顺手恢复线路健康度 */
(async function boot() {
  try {
    var got = await EXT.storage.local.get(['apiChan']);
    if (got && got.apiChan) apiChanCache = got.apiChan;
  } catch (e) {}
  try { await loadStats(); } catch (e) {}
  try { await refreshPool(false); } catch (e) {}
})();

/* GitHub 访问开关状态对齐：动态规则会跟着浏览器留到下次启动，
 * 但用户可能换过镜像、或上次用的镜像已经挂了，这里重新算一次。 */
(async function bootBoost() {
  try {
    var s = await getSettings();
    if (!s.ghBoost) {
      await applyBoost(false, '');
      await syncMirrorScript('');
      return;
    }
    var raw = s.ghSite || s.ghSiteCache;
    var site = raw ? siteOfBase(raw, s) : null;
    if (!site) {
      // 开关是开的但没记住站点（换过配置之类）：重新挑一个
      var pf = await pickSiteFast(s);
      site = pf.site;
      if (!site) return;
      await saveSettings({ ghSiteCache: site.base });
    }
    // 先把规则装上（保证用户立刻能开页面），再后台复核它是否还活着
    await applyBoost(true, site);
    await syncMirrorScript(site);
    siteProbeLazy(true);
  } catch (e) {}
})();

updateBadge();
