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

  (async function init() {
    $('ver').textContent = APP_INFO.version;
    var s = await getSettings();
    fill(s);
    $('subfolder').addEventListener('change', updatePreview);
    $('btnSave').onclick = save;
    $('btnReset').onclick = reset;
    $('btnSaveRoutes').onclick = save;
  })();
})();
