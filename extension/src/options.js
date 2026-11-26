/* 设置页 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

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
    updatePreview();
    $('routeInfo').textContent = '当前生效 ' + allRoutes(s).length + ' 条线路';
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

  (async function init() {
    $('ver').textContent = curVer;
    $('btnCheck').onclick = checkUpdate;
    var s = await getSettings();
    fill(s);
    $('subfolder').addEventListener('change', updatePreview);
    $('btnSave').onclick = save;
    $('btnReset').onclick = reset;
    $('btnSaveRoutes').onclick = save;
  })();
})();
