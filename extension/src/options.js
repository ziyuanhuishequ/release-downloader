/* 设置页 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var EFFECTIVE_COUNT = 0;
  var BASE_COUNT = 0;

  function parseRoutes(text) {
    var out = [];
    String(text || '').split(/\r?\n/).forEach(function (line) {
      var s = line.trim();
      if (!s || s.charAt(0) === '#') return;
      var name = '';
      var prefix = s;
      var bar = s.indexOf('|');
      if (bar > 0) {
        name = s.slice(0, bar).trim();
        prefix = s.slice(bar + 1).trim();
      }
      if (!/^https?:\/\//i.test(prefix)) return;
      if (!/\/$/.test(prefix)) prefix += '/';
      out.push({ name: name || prefix.replace(/^https?:\/\//, '').replace(/\/$/, ''), prefix: prefix });
    });
    return out;
  }

  function routesToText(list) {
    return (list || []).map(function (r) { return r.name + '|' + r.prefix; }).join('\n');
  }

  function updatePreview() {
    var on = $('subfolder').checked;
    $('pathPreview').textContent = buildPath({
      owner: 'sharkdp', repo: 'bat', tag: 'v0.24.0', asset: 'bat-v0.24.0-x86_64-pc-windows-msvc.zip'
    }, { subfolder: on });
  }

  function fill(s) {
    $('subfolder').checked = !!s.subfolder;
    $('concurrency').value = String(s.concurrency || 2);
    $('autoProbe').checked = !!s.autoProbe;
    $('maxRetries').value = String(s.maxRetries || 4);
    $('notify').checked = !!s.notify;
    $('segEnabled').checked = s.segEnabled !== false;
    $('threads').value = String(s.threads || 4);
    $('segMaxMB').value = String(s.segMaxMB || 128);
    $('lowSpeedKB').value = String(s.lowSpeedKB || 40);
    $('token').value = s.token || '';
    $('extraRoutes').value = routesToText(s.extraRoutes);
    if ($('siteCustom')) $('siteCustom').value = s.ghSiteCustom || '';
    updatePreview();
    EFFECTIVE_COUNT = (BASE_COUNT || allRoutes(s).length) + (s.extraRoutes || []).length;
    $('routeInfo').textContent = '当前生效 ' + EFFECTIVE_COUNT + ' 条线路';
  }

  async function ensureHostPermission(list) {
    if (!list.length) return true;
    var origins = {};
    BUILTIN_ROUTES.forEach(function (r) { if (r.prefix) origins[r.prefix] = true; });
    var need = [];
    list.forEach(function (r) {
      if (!origins[r.prefix]) need.push(r.prefix + '*');
    });
    if (!need.length) return true;
    try {
      var granted = await EXT.permissions.request({ origins: need });
      return !!granted;
    } catch (e) {
      return false;
    }
  }

  async function save() {
    var saveBtn = $('btnSave');
    saveBtn.disabled = true;
    var extra = parseRoutes($('extraRoutes').value);
    var ok = await ensureHostPermission(extra);
    var s = await saveSettings({
      subfolder: $('subfolder').checked,
      concurrency: parseInt($('concurrency').value, 10) || 2,
      autoProbe: $('autoProbe').checked,
      maxRetries: parseInt($('maxRetries').value, 10) || 4,
      notify: $('notify').checked,
      segEnabled: $('segEnabled').checked,
      threads: parseInt($('threads').value, 10) || 4,
      segMaxMB: parseInt($('segMaxMB').value, 10) || 128,
      lowSpeedKB: parseInt($('lowSpeedKB').value, 10) || 40,
      token: $('token').value.trim(),
      extraRoutes: extra
    });
    fill(s);
    saveBtn.disabled = false;
    var tip = $('saved');
    tip.textContent = ok ? '已保存' : '已保存（自定义线路缺少授权，可能不可用）';
    tip.style.color = ok ? '#087458' : '#C63020';
    setTimeout(function () { tip.textContent = ''; }, 2600);
  }

  async function reset() {
    var s = await saveSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    fill(s);
    var tip = $('saved');
    tip.textContent = '已恢复默认';
    tip.style.color = '#087458';
    setTimeout(function () { tip.textContent = ''; }, 2000);
  }

  function verNum(v) {
    return String(v).replace(/^v/i, '').split('.').map(function (x) { return parseInt(x, 10) || 0; });
  }
  function cmpVer(a, b) {
    for (var i = 0; i < 3; i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
    }
    return 0;
  }

  /* 检查扩展自身的更新：只认 ext-v 开头的标签，避免把桌面版 exe 当成扩展新版 */
  async function checkUpdate() {
    var el = $('updInfo');
    el.textContent = '检测中…';
    el.style.color = '#8A7A64';
    try {
      var res = await fetch('https://api.github.com/repos/ziyuanhuishequ/release-downloader/releases?per_page=30',
        { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var list = await res.json();
      var best = null;
      list.forEach(function (x) {
        var tag = x.tag_name || '';
        if (tag.indexOf('ext-v') !== 0) return;
        var v = verNum(tag.slice(5));
        if (!best || cmpVer(v, best.v) > 0) best = { v: v, tag: tag, url: x.html_url };
      });
      if (!best) throw new Error('Release 里还没有扩展版本');
      if (cmpVer(best.v, verNum(curVer)) > 0) {
        el.innerHTML = '发现新版 ' + best.tag + '，<a href="' + best.url +
          '" target="_blank" rel="noreferrer">前往下载</a>';
        el.style.color = '#B0241C';
      } else {
        el.textContent = '已是最新（v' + curVer + '）';
        el.style.color = '#087458';
      }
    } catch (e) {
      el.textContent = '检测失败：' + ((e && e.message) || e);
      el.style.color = '#C63020';
    }
  }

  var curVer = (chrome.runtime.getManifest ? chrome.runtime.getManifest().version : APP_INFO.version);

  /* ---------- 线路池 ---------- */

  var poolState = { routes: [], pool: null, prefer: '', probe: null };

  function renderRouteList() {
    var box = $('routeList');
    if (!box) return;
    var pmap = {};
    ((poolState.probe && poolState.probe.list) || []).forEach(function (r) { pmap[r.prefix] = r; });
    var best = 0;
    poolState.routes.forEach(function (r) {
      var pb = pmap[r.prefix];
      if (pb && pb.ok && pb.bps > best) best = pb.bps;
    });
    /* 冷却剩多久要写清楚，只写「冷却中」用户会以为是自己用太多被限流了 */
    function coolTxt(until) {
      var left = Math.ceil(((until || 0) - Date.now()) / 60000);
      return left > 0 ? '冷却 ' + left + ' 分' : '冷却中';
    }
    var rows = poolState.routes.map(function (r) {
      var pb = pmap[r.prefix];
      var txt;
      if (pb && pb.ok) txt = fmtSpeed(pb.bps);
      else if (pb && pb.err === 'cors') txt = '测速受限';
      else if (pb && pb.err === 'dead') txt = '连不上';
      else if (pb && pb.err === 'timeout') txt = '超时';
      else if (pb && !pb.ok) txt = '不通';
      else if (r.score > 0) txt = '≈' + fmtSpeed(r.score);
      else txt = '未测';
      var cls = (pb && pb.ok) || r.score > 0 ? 'ok' : (pb && !pb.ok ? 'bad' : '');
      if (r.cooling) cls = 'bad';
      var w = 0;
      if (pb && pb.ok && best) w = Math.max(6, Math.round(pb.bps / best * 100));
      else if (!pb && r.score > 0) w = 20;
      var star = poolState.prefer === prefKey(r.prefix);
      var okN = r.ok || 0;
      var failN = r.fail || 0;
      return '<div class="rline ' + cls + (star ? ' pref' : '') + '" data-prefix="' + esc(prefKey(r.prefix)) + '">' +
        '<span class="rn">' + (star ? '★ ' : '') + esc(r.name || '直连') + '</span>' +
        '<span class="bar2"><i style="width:' + w + '%"></i></span>' +
        '<span class="rs">' + esc(r.cooling ? coolTxt(r.coolUntil) : txt) + '</span>' +
        '<span class="rk">' + (okN || failN ? okN + '成/' + failN + '败' : '—') + '</span>' +
        '</div>';
    }).join('') || '<div class="rline"><span class="rn">线路池是空的，点「更新线路池」重新拉一次</span></div>';

    var head = '<div class="rline rhead"><span class="rn">线路</span><span class="bar2" style="visibility:hidden"></span>' +
      '<span class="rs">实测</span><span class="rk">历史</span></div>';
    var pool = poolState.pool;
    var info = pool
      ? '线路池 v' + (pool.ver || 1) + ' · ' + pool.count + ' 条 · 更新于 ' + (pool.updated || '未知')
      : '线路池还没拉到，正在用内置表';
    $('poolInfo').textContent = info;
    $('prefInfo').textContent = poolState.prefer ? '已固定线路：' + poolState.prefer : '当前为自动挑线';

    if (box.dataset.sig === head + rows) return;
    box.dataset.sig = head + rows;
    box.innerHTML = head + rows;
    box.querySelectorAll('.rline[data-prefix]').forEach(function (el) {
      el.onclick = async function () {
        var prefix = el.getAttribute('data-prefix') || '';
        poolState.prefer = poolState.prefer === prefix ? '' : prefix;
        await saveSettings({ preferRoute: poolState.prefer });
        renderRouteList();
      };
    });
  }

  async function loadRoutes(force) {
    if (force) {
      $('poolInfo').textContent = '正在更新线路池…';
      await bgSend('refresh-pool', { force: true });
      // 池子里可能有新域名，趁这次点击把授权补上
      var pr = await bgSend('routes', {});
      if (pr && pr.routes) await ensureRoutePerms(pr.routes);
    }
    var res = await bgSend('routes', {});
    if (res && res.routes) {
      poolState.routes = res.routes;
      poolState.pool = res.pool || null;
      poolState.prefer = res.prefer || '';
      poolState.probe = res.cached || null;
      renderRouteList();
    }
    var s = await getSettings();
    BASE_COUNT = poolState.routes.length || BUILTIN_ROUTES.length;
    EFFECTIVE_COUNT = BASE_COUNT + (s.extraRoutes || []).length;
    $('routeInfo').textContent = '当前生效 ' + EFFECTIVE_COUNT + ' 条线路';
  }

  /* ---------- GitHub 国内访问（整站镜像） ---------- */

  var SITE_STATE = { on: false, pinned: '', site: null, list: [] };

  function paintSiteSwitch() {
    var b = $('btnBoostSw');
    if (!b) return;
    b.textContent = SITE_STATE.on ? '已开启' : '未开启';
    b.style.background = SITE_STATE.on ? '#2ED3A5' : '';
    b.style.color = SITE_STATE.on ? '#0B3B2E' : '';
  }

  function renderSiteList() {
    var box = $('siteList');
    if (!box) return;
    var list = SITE_STATE.list || [];
    if (!list.length) {
      box.innerHTML = '<div class="rline"><span class="rn">还没有镜像数据，点上面「重新探测镜像」</span></div>';
      return;
    }
    box.innerHTML = list.map(function (x) {
      var cls = 'rline' + (x.ok ? ' ok' : ' bad');
      var star = (SITE_STATE.pinned && SITE_STATE.pinned === x.base) ? '★ ' : '';
      var state = x.ok ? (x.ms + ' ms') : '连不上';
      var kind = x.kind === 'prefix' ? '前缀型' : '路径型';
      return '<div class="' + cls + '" data-base="' + esc(x.base) + '">' +
        '<span class="rn">' + star + esc(x.name) + '</span>' +
        '<span class="rk">' + kind + '</span>' +
        '<span class="rs">' + state + '</span></div>';
    }).join('');
    box.querySelectorAll('.rline[data-base]').forEach(function (el) {
      el.onclick = async function () {
        var base = el.getAttribute('data-base');
        SITE_STATE.pinned = (SITE_STATE.pinned === base) ? '' : base;
        renderSiteList();
        var r = await bgSend('boost-site', { base: SITE_STATE.pinned });
        if (r && r.state) SITE_STATE = Object.assign(SITE_STATE, r.state);
        paintSiteSwitch();
        renderSiteList();
        $('siteInfo').textContent = SITE_STATE.pinned
          ? '已固定使用 ' + SITE_STATE.pinned.replace(/^https?:\/\//, '')
          : '已恢复自动挑选';
      };
    });
  }

  async function loadBoost() {
    var res = await bgSend('boost-state');
    if (res && !res.error) {
      SITE_STATE = {
        on: !!res.on,
        pinned: res.pinned || '',
        site: res.site || null,
        list: res.sites || []
      };
    }
    paintSiteSwitch();
    renderSiteList();
    var list = SITE_STATE.list || [];
    var okN = list.filter(function (x) { return x.ok; }).length;
    if ($('siteInfo')) {
      if (!list.length) {
        $('siteInfo').textContent = (res && res.checking) ? '正在后台探测镜像…' : '还没有镜像数据';
        if (res && res.checking) setTimeout(loadBoost, 2500);
      } else {
        $('siteInfo').textContent = okN + '/' + list.length + ' 个镜像可用' +
          ((res && res.checking) ? '（后台还在复核）' : '');
      }
    }
  }

  async function toggleBoost() {
    var b = $('btnBoostSw');
    if (!b) return;
    b.disabled = true;
    $('siteInfo').textContent = SITE_STATE.on ? '正在关闭…' : '正在探测可用镜像…';
    var res = await bgSend('boost-set', { on: !SITE_STATE.on });
    b.disabled = false;
    if (res && res.error) {
      $('siteInfo').textContent = res.error;
      return;
    }
    await loadBoost();
    $('siteInfo').textContent = SITE_STATE.on
      ? '已开启，之后打开的 github.com 页面会走镜像'
      : '已关闭，恢复直连 github.com';
  }

  async function probeSiteList() {
    // 先强制拉一次远程池（镜像域名随时在变），再逐个探活
    $('siteInfo').textContent = '正在更新镜像池…';
    await bgSend('refresh-pool', { force: true });
    $('siteInfo').textContent = '正在探测…（每个镜像最多等 4.5 秒）';
    var res = await bgSend('boost-probe');
    SITE_STATE.list = (res && res.list) || [];
    renderSiteList();
    var okN = SITE_STATE.list.filter(function (x) { return x.ok; }).length;
    $('siteInfo').textContent = okN + '/' + SITE_STATE.list.length + ' 个镜像可用';
  }

  async function saveCustomSite() {
    var raw = ($('siteCustom').value || '').trim();
    if (raw && !/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    raw = raw.replace(/\/+$/, '');
    var msg = $('siteMsg');
    if (raw && !/^https?:\/\/[^/\s]+$/i.test(raw)) {
      msg.textContent = '地址要写成 https://域名 的形式，不要带路径';
      return;
    }
    if (raw) {
      var ok = await ensureSitePerms([{ base: raw }]);
      if (!ok) { msg.textContent = '没拿到这个域名的访问权限，浏览器可能拦住了'; return; }
    }
    await saveSettings({ ghSiteCustom: raw, ghSite: raw });
    msg.textContent = raw ? '已保存并固定使用，正在测试…' : '已清除自定义镜像';
    await loadBoost();
    if (!raw) return;
    var r = await bgSend('boost-site', { base: raw });
    msg.textContent = (r && r.error) ? ('保存了，但这个地址现在连不上：' + r.error) : '已保存，镜像可用';
  }

  async function clearHist() {
    await bgSend('clear-history');
    $('histInfo').textContent = '已清除，下次打开列表就不再显示「已下载」';
    setTimeout(function () { $('histInfo').textContent = ''; }, 4000);
  }

  /* ---------- 自建加速节点（Cloudflare Worker） ---------- */

  var WORKER_CODE = '';

  async function loadWorkerCode() {
    var ta = $('workerCode');
    var btn = $('btnCopyWorker');
    try {
      var res = await fetch(EXT.runtime.getURL('src/relay-worker.txt'));
      WORKER_CODE = await res.text();
    } catch (e) {
      WORKER_CODE = '';
    }
    if (!WORKER_CODE) {
      if (ta) ta.placeholder = '内置代码读取失败，请去仓库 worker/gh-relay.js 复制';
      if (btn) btn.disabled = true;
      return;
    }
    if (ta) ta.value = WORKER_CODE;
    if (btn) btn.onclick = async function () {
      var msg = $('workerMsg');
      try {
        await navigator.clipboard.writeText(WORKER_CODE);
        if (msg) msg.textContent = '已复制，粘到 Cloudflare 的编辑器里即可';
      } catch (e) {
        // 剪贴板被拒时退化成全选，用户按 Ctrl+C 也能拿走
        if (ta) { ta.focus(); ta.select(); }
        if (msg) msg.textContent = '已全选，按 Ctrl+C 复制';
      }
      setTimeout(function () { if (msg) msg.textContent = ''; }, 5000);
    };
  }

  (async function init() {
    $('ver').textContent = curVer;
    $('btnCheck').onclick = checkUpdate;
    var s = await getSettings();
    fill(s);
    $('subfolder').addEventListener('change', updatePreview);
    $('btnSave').onclick = save;
    $('btnReset').onclick = reset;
    $('btnSaveRoutes').onclick = save;
    $('btnPool').onclick = function () { loadRoutes(true); };
    $('btnClearHist').onclick = clearHist;
    $('btnBoostSw').onclick = toggleBoost;
    $('btnSiteProbe').onclick = probeSiteList;
    $('btnSiteSave').onclick = saveCustomSite;
    loadBoost();
    loadWorkerCode();
    var pn = $('promoNote');
    if (pn) pn.textContent = PROMO.title + '，' + PROMO.desc + '。';
    var lp = $('lnkPromo');
    if (lp) lp.href = PROMO.url;
    var lm = $('lnkMore');
    if (lm) lm.href = PROMO.more;
    loadRoutes(false);
  })();
})();
