/* 后台：GitHub API、线路测速、下载队列、中断自动换线
 * MV3 Service Worker（Firefox 走 background.scripts，同一份代码）。
 */
importScripts('common.js');

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
  var res = await fetch('https://api.github.com' + path, { headers: headers, cache: 'no-store' });
  if (!res.ok) {
    var err = new Error(apiHint(res.status));
    err.status = res.status;
    throw err;
  }
  return res.json();
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
  return { repo: out.repo, release: rel, releases: out.releases.map(function (r) { return { tag: r.tag, name: r.name, prerelease: r.prerelease }; }) };
}

/* ---------------- 线路池 + 线路健康度 ---------------- */

var routeStats = null;        // prefix -> {ok, fail, sumBps, last}
var statsDirty = false;

async function loadStats() {
  if (routeStats) return routeStats;
  try {
    routeStats = (await EXT.storage.local.get('routeStats')).routeStats || {};
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
      // 连挂两次就先别用它，10 分钟后再给机会（比原来 3 分钟更容易筛掉死线路）
      if (e.failStreak >= 2) {
        var ms = Math.min(30 * 60 * 1000, 5 * 60 * 1000 * Math.pow(2, e.failStreak - 2));
        badUntil.set(prefix, Date.now() + ms);
      }
    }
    e.last = Date.now();
    s[prefix] = e;
    statsDirty = true;
    setTimeout(saveStats, 1500);
  });
}

async function refreshPool(force) {
  var r = await loadRoutePool(force);
  if (r && r.pool) probeCache = null;   // 线路变了，旧的测速结果作废
  return {
    info: POOL_INFO,
    from: r && r.from,
    count: POOL_INFO ? POOL_INFO.count : 0
  };
}

/* ---------------- 线路测速 ---------------- */

function cacheKeyOf(url) {
  var p = parseAssetUrl(url);
  return p ? p.owner + '/' + p.repo + '@' + p.tag : url;
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
    // AbortError = 超时；TypeError = 被浏览器拦下（多为镜像没开 CORS），两者性质不同
    var kind = nm === 'AbortError' ? 'timeout' : 'cors';
    return { ok: false, err: kind, ms: Math.round(performance.now() - t0) };
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
  // 测速结果顺手记进线路健康度：跨文件复用，下次没测速也知道该先试哪条
  list.forEach(function (r) {
    if (r.ok) noteRoute(r.prefix, true, r.bps);
    else if (r.err !== 'cors') noteRoute(r.prefix, false, 0);   // 跨域受限不代表线路差，不扣分
  });
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
async function routesForFile(url, settings) {
  var probed = null;
  if (settings.autoProbe) {
    try { probed = await probeRoutes(url); } catch (e) { probed = null; }
  } else {
    probed = probeCache || (await EXT.storage.local.get('routeCache')).routeCache || null;
  }
  var all = allRoutes(settings);
  var order = [];
  if (probed && probed.list && probed.list.length) {
    probed.list.forEach(function (r) {
      var hit = all.filter(function (x) { return x.prefix === r.prefix; })[0];
      if (hit && r.ok) order.push({ name: hit.name, prefix: hit.prefix });
    });
  }
  all.forEach(function (r) {
    if (!order.some(function (x) { return x.prefix === r.prefix; })) order.push(r);
  });
  // 没有本次测速数据的线路，按历史健康度排（下过 500KB/s 的线路自然排前面）
  if (!probed || !probed.list || !probed.list.length) {
    var stats = await loadStats();
    order = sortByScore(order, stats);
  }
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
      EXT.downloads.pause(task.downloadId, function () {
        void EXT.runtime.lastError;
        setTimeout(function () {
          try {
            EXT.downloads.resume(task.downloadId, function () { void EXT.runtime.lastError; });
          } catch (e) {}
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
  if (now - task.slowSince >= SLOW_JUDGE_MS) task.slow = true;
  // 自动提速都救不回来、而且几乎没下多少，才换线路重来
  if (now - task.slowSince >= AUTO_SWITCH_MS && !task.autoSwitched &&
      (task.boostCount || 0) >= 2 &&
      (!total || task.received < total * 0.08)) {
    task.autoSwitched = true;
    switchRoute(task, null, true);
  }
}

/* 换线路：停掉当前这条，从下一条（或指定线路）重新开始 */
async function switchRoute(task, prefix, auto) {
  if (!task) return false;
  var settings = await settingsNow();
  var order = await routesForFile(task.url, settings);
  if (!order.length) return false;
  var idx;
  if (prefix) {
    idx = 0;
    order.forEach(function (r, i) { if (r.prefix === prefix) idx = i; });
  } else {
    idx = (Number(task.routeIdx) || 0) + 1;
    if (idx >= order.length) idx = 0;
  }
  var dlId = task.downloadId;
  if (dlId) {
    activeIds.delete(dlId);          // 先摘掉，cancel 触发的 interrupted 就不会走失败重试
    try { EXT.downloads.cancel(dlId, function () { void EXT.runtime.lastError; }); } catch (e) {}
  }
  if (task.segmented) abortSeg(task);
  task.downloadId = 0;
  task.segmented = false;
  if (task.blobUrl) { revokeBlob(task.blobUrl); task.blobUrl = ''; }
  task.status = 'queued';
  task.routeIdx = idx;
  task.received = 0;
  task.speed = 0;
  task.slow = false;
  task.slowSince = 0;
  task._sp = null;
  task.error = '';
  task.autoSwitched = !!auto;
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
    try { EXT.downloads.cancel(dlId, function () { void EXT.runtime.lastError; }); } catch (e) {}
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
    try {
      EXT.downloads.pause(id, function () {
        var le = EXT.runtime.lastError;
        if (le) {
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
    } catch (e) {
      resolve({ ok: false, error: (e && e.message) || String(e) });
    }
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
      try {
        EXT.downloads.resume(task.downloadId, function () {
          var le = EXT.runtime.lastError;
          if (le) {
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
      } catch (e) {
        resolve({ ok: false, error: (e && e.message) || String(e) });
      }
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

async function hasOffscreen() {
  try {
    if (EXT.offscreen && EXT.offscreen.hasDocument) return await EXT.offscreen.hasDocument();
    var ctxs = await EXT.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return !!(ctxs && ctxs.length);
  } catch (e) {
    return false;
  }
}

async function ensureOffscreen() {
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
  try {
    EXT.runtime.sendMessage(Object.assign({ target: 'offscreen' }, payload),
      function () { void EXT.runtime.lastError; });
  } catch (e) {}
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
    var id = await EXT.downloads.download({
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

async function enqueue(items) {
  var settings = await getSettings();
  var added = 0;
  items.forEach(function (it) {
    if (!it || !it.url) return;
    var dup = tasks.some(function (t) {
      return t.url === it.url && (t.status === 'queued' || t.status === 'downloading' ||
        t.status === 'probing' || t.status === 'paused');
    });
    if (dup) return;
    var p = parseAssetUrl(it.url) || {};
    pushTask({
      id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      url: it.url,
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
    var check = settings.autoProbe ? await preflight(route, task.url) : { ok: true };
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
    var size = task.size || task.total || 0;
    var segCap = (settings.segMaxMB || 128) * 1024 * 1024;
    if (settings.segEnabled !== false && !task.segFailed && size > 1024 * 1024 && size <= segCap) {
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
    var id = await EXT.downloads.download({
      url: routeUrl(route, task.url),
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
  try {
    EXT.downloads.search({ state: 'in_progress' }, function (list) {
      void EXT.runtime.lastError;
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
  } catch (e) {}
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
      try { EXT.downloads.erase({ id: delta.id }, function () { void EXT.runtime.lastError; }); } catch (e) {}
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
                cooling: (badUntil.get(r.prefix) || 0) > now0
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
                try { EXT.downloads.cancel(t.downloadId, function () { void EXT.runtime.lastError; }); } catch (e) {}
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
    EXT.contextMenus.removeAll(function () {
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
      try { EXT.tabs.sendMessage(tab.id, { type: 'open-panel' }, function () { void EXT.runtime.lastError; }); } catch (e) {}
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
        // 暂停的任务也一起重排：downloadId 已经跟 Service Worker 一起丢了，
        // 留着 paused 状态用户点「继续」也只能从头来，不如直接接着下。
        if (t.status === 'downloading' || t.status === 'probing' || t.status === 'paused') {
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
  try { await loadStats(); } catch (e) {}
  try { await refreshPool(false); } catch (e) {}
})();

updateBadge();
