/* 弹窗逻辑：扫描仓库 → 选版本 → 勾资源 → 交给后台下载 */
(function () {
  'use strict';

  var st = {
    repo: '',
    releases: [],
    release: null,
    assets: [],
    picked: {},
    filter: 'all',
    probe: null,
    settings: null,
    tasks: [],
    busy: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var bodyEl = $('body');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function visibleAssets() {
    return st.assets.filter(function (a) {
      if (st.filter === 'all') return true;
      if (st.filter === 'other') return platformOf(a.name) === 'other';
      return platformOf(a.name) === st.filter;
    });
  }

  function pickedList() {
    return st.assets.filter(function (a) { return st.picked[a.name]; });
  }

  /* ---------- 渲染 ---------- */

  function renderRoute() {
    var el = $('route');
    var p = st.probe;
    if (!p) {
      el.innerHTML = '<span class="pill wait">未测速</span><span class="rt-txt">下载前会自动挑最快的线路</span><button class="lnk" id="btnProbe">测速</button>';
    } else if (p.loading) {
      el.innerHTML = '<span class="pill wait">测速中…</span><span class="rt-txt">正在并发测试各条镜像</span>';
    } else if (p.list) {
      var ok = p.list.filter(function (r) { return r.ok; });
      var best = ok[0];
      var blocked = p.blocked || 0;
      if (best) {
        el.innerHTML = '<span class="pill ok">' + esc(best.name) + '</span><span class="rt-txt">' + fmtSpeed(best.bps) + ' · ' + ok.length + ' 条可测速</span><button class="lnk" id="btnProbe">重测</button>';
      } else if (blocked) {
        el.innerHTML = '<span class="pill wait">测速受限</span><span class="rt-txt" title="镜像没有开放跨域读取，浏览器测不了速度，但不影响下载：下载时会按顺序自动尝试">跨域受限，下载时仍会依次试</span><button class="lnk" id="btnProbe">重测</button>';
      } else {
        el.innerHTML = '<span class="pill bad">线路都不通</span><span class="rt-txt">稍后重测，或先在设置里加自定义线路</span><button class="lnk" id="btnProbe">重测</button>';
      }
    } else {
      el.innerHTML = '<span class="pill bad">测速失败</span><span class="rt-txt">' + esc(p.error || '') + '</span><button class="lnk" id="btnProbe">重试</button>';
    }
    var b = $('btnProbe');
    if (b) b.onclick = function () { doProbe(); };
  }

  /* 任务条：百分比 + 实时速度 + 剩余时间 + 生效线路，慢了给一键换线路 */
  function taskStripHtml() {
    var live = st.tasks.filter(function (t) {
      return t.status === 'downloading' || t.status === 'probing' || t.status === 'queued';
    });
    var recent = st.tasks.filter(function (t) {
      return t.status === 'done' || t.status === 'failed';
    }).slice(-1);
    if (!live.length && !recent.length) return '';

    var totalSpeed = live.reduce(function (s, t) { return s + (t.speed || 0); }, 0);
    var html = '';
    if (live.length) {
      html += '<div class="sec-title">正在下载 ' + live.length + ' 个' +
        (totalSpeed ? ' · 共 ' + fmtSpeed(totalSpeed) : '') + '</div>';
      live.slice(0, 3).forEach(function (t) {
        var total = t.total || t.size || 0;
        var pct = total > 0 ? Math.min(100, Math.round(t.received / total * 100)) : 0;
        var eta = (t.speed && total) ? fmtEta((total - t.received) / t.speed) : '';
        var meta;
        if (t.status === 'probing') meta = '选线中…';
        else if (t.status === 'queued') meta = '排队中';
        else if (t.boosting) meta = '自动提速中…';
        else {
          meta = pct + '%';
          if (t.speed) meta += ' · ' + fmtSpeed(t.speed);
          if (eta) meta += ' · 剩 ' + eta;
        }
        var tag = '';
        if (t.slow && t.status === 'downloading') tag = '<span class="tflag bad">速度慢</span>';
        else if (t.boosting) tag = '<span class="tflag ok">提速</span>';
        else if (t.segmented && t.status === 'downloading') tag = '<span class="tflag">多线程</span>';
        html += '<div class="task">' +
          '<div class="tn"><span class="tname">' + esc(t.name) + '</span>' +
          (t.route ? '<span class="trt">' + esc(t.route) + '</span>' : '') + tag + '</div>' +
          '<div class="tb"><div class="bar"><i style="width:' + pct + '%"></i></div>' +
          '<span class="tm">' + esc(meta) + '</span></div>' +
          (t.status === 'downloading' || t.status === 'queued'
            ? '<div class="tact"><button class="lnk" data-sw="' + esc(t.id) + '">换线路</button>' +
              '<button class="lnk" data-cx="' + esc(t.id) + '">取消</button></div>'
            : '') +
          '</div>';
      });
    }
    if (recent.length && !live.length) {
      var r = recent[0];
      html += '<div class="tlast ' + (r.status === 'failed' ? 'bad' : 'ok') + '">' +
        (r.status === 'failed' ? '刚才失败：' : '刚完成：') + esc(r.name) +
        (r.error ? '（' + esc(r.error) + '）' : '') + '</div>';
    }
    return html;
  }

  /* 只刷新队列区，避免每次轮询把资源列表重画一遍（会丢失滚动位置） */
  function renderTasks() {
    var wrap = $('taskWrap');
    if (!wrap) return;
    var keep = wrap.innerHTML;
    var next = taskStripHtml();
    if (keep === next) return;
    wrap.innerHTML = next;
    wrap.querySelectorAll('[data-sw]').forEach(function (b) {
      b.onclick = function () {
        b.textContent = '换线中…';
        b.disabled = true;
        bgSend('switch-route', { id: b.getAttribute('data-sw') });
      };
    });
    wrap.querySelectorAll('[data-cx]').forEach(function (b) {
      b.onclick = function () {
        b.disabled = true;
        bgSend('cancel-task', { id: b.getAttribute('data-cx') });
      };
    });
  }

  function renderBody() {
    var html = '<div id="taskWrap">' + taskStripHtml() + '</div>';

    if (st.error) {
      html += '<div id="assetWrap"><div class="msg"><b>' + esc(st.error) + '</b>检查仓库地址是否正确；私有仓库需要在设置里填 GitHub Token。</div></div>';
      bodyEl.innerHTML = html;
      return;
    }

    if (!st.assets.length) {
      html += '<div id="assetWrap"><div class="hint"><div class="big">粘贴仓库地址就能下</div>' +
        '<div>例如 <b style="color:#1A1E30">sharkdp/bat</b>，或在 GitHub 的 Release 页面看右下角面板。</div>' +
        '<div style="margin-top:8px;color:#8A8577">全部在浏览器里完成，不用装桌面软件。</div></div></div>';
      bodyEl.innerHTML = html;
      return;
    }

    var list = visibleAssets();
    var rows = list.length
      ? list.map(function (a) {
          var on = !!st.picked[a.name];
          return '<div class="row ' + (on ? 'sel' : '') + '" data-name="' + esc(a.name) + '">' +
            '<div class="cb"></div>' +
            '<div class="nm">' + esc(a.name) + '</div>' +
            '<div class="sz">' + (a.size ? fmtSize(a.size) : '—') + '</div></div>';
        }).join('')
      : '<div class="msg">这个筛选下没有文件，换个分类看看。</div>';

    html += '<div id="assetWrap">' + rows + '</div>';
    bodyEl.innerHTML = html;

    bodyEl.querySelectorAll('.row').forEach(function (el) {
      el.onclick = function () {
        var n = el.getAttribute('data-name');
        st.picked[n] = !st.picked[n];
        el.classList.toggle('sel', !!st.picked[n]);
        renderFooter();
      };
    });
  }

  function renderFooter() {
    var picked = pickedList();
    var size = picked.reduce(function (s, a) { return s + (a.size || 0); }, 0);
    var go = $('btnGo');
    go.disabled = !picked.length || st.busy;
    go.textContent = picked.length
      ? '下载 ' + picked.length + ' 个文件' + (size ? '（' + fmtSize(size) + '）' : '')
      : '选择文件后下载';

    var live = st.tasks.filter(function (t) { return t.status === 'downloading' || t.status === 'probing' || t.status === 'queued'; });
    var failed = st.tasks.filter(function (t) { return t.status === 'failed'; });
    $('queue').textContent = live.length
      ? '队列 ' + live.length + ' 个进行中'
      : (failed.length ? failed.length + ' 个失败（详见浏览器下载列表）' : '队列空闲');

    var cnt = $('rel');
    if (st.assets.length) cnt.title = st.assets.length + ' 个资源';
  }

  /* ---------- 数据 ---------- */

  async function scan() {
    var repo = $('repo').value.trim();
    if (!repo) return;
    st.busy = true;
    $('btnScan').disabled = true;
    $('btnScan').textContent = '…';
    st.error = '';
    var res = await bgSend('list-releases', { repo: repo });
    st.busy = false;
    $('btnScan').disabled = false;
    $('btnScan').textContent = '扫描';
    if (res.error) {
      st.error = res.error;
      st.releases = [];
      st.assets = [];
      $('rel').innerHTML = '';
      $('relbar').classList.add('hide');
      renderBody();
      renderFooter();
      return;
    }
    st.repo = res.repo;
    st.releases = res.releases || [];
    if (!st.releases.length) {
      st.error = '这个仓库还没有发布 Release';
      st.assets = [];
      $('rel').innerHTML = '';
      $('relbar').classList.add('hide');
      renderBody();
      renderFooter();
      return;
    }
    $('relbar').classList.remove('hide');
    $('rel').innerHTML = st.releases.map(function (r, i) {
      return '<option value="' + i + '">' + esc(r.tag) + (r.prerelease ? '（预发布）' : '') + '</option>';
    }).join('');
    await pickRelease(0);
  }

  async function pickRelease(idx) {
    var r = st.releases[idx];
    if (!r) return;
    $('rel').value = String(idx);
    st.assets = [];
    st.picked = {};
    st.probe = null;
    renderRoute();
    bodyEl.innerHTML = '<div class="hint">正在读取 ' + esc(r.tag) + ' 的文件列表…</div>';
    var res = await bgSend('list-assets', { repo: st.repo, tag: r.tag });
    if (res.error) {
      st.error = res.error;
      renderBody();
      return;
    }
    st.error = '';
    st.release = res.release;
    st.assets = res.release.assets || [];
    var win = st.assets.some(function (a) { return platformOf(a.name) === 'win'; });
    var autoWin = win && st.assets.length > 6;
    st.assets.forEach(function (a) {
      st.picked[a.name] = autoWin ? platformOf(a.name) === 'win' : true;
    });
    st.filter = autoWin ? 'win' : 'all';
    document.querySelectorAll('.tg[data-filter]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-filter') === st.filter);
    });
    renderBody();
    renderFooter();
    if (st.settings && st.settings.autoProbe && st.assets.length) doProbe();
  }

  async function doProbe() {
    if (!st.assets.length) return;
    var sorted = st.assets.slice().sort(function (a, b) { return (a.size || 0) - (b.size || 0); });
    var target = sorted.filter(function (a) { return a.size > 0; })[0] || sorted[0];
    st.probe = { loading: true };
    renderRoute();
    var res = await bgSend('probe', { url: target.url, key: st.repo + '@' + (st.release ? st.release.tag : '') });
    st.probe = res.list ? res : { error: res.error || '测速失败' };
    renderRoute();
  }

  async function download() {
    var picked = pickedList();
    if (!picked.length || !st.release) return;
    st.busy = true;
    renderFooter();
    var s = st.settings || {};
    var owner = st.repo.split('/')[0];
    var repoName = st.repo.split('/')[1];
    var items = picked.map(function (a) {
      return {
        url: a.url,
        asset: a.name,
        size: a.size,
        owner: owner,
        repo: repoName,
        tag: st.release.tag,
        path: buildPath({ owner: owner, repo: repoName, tag: st.release.tag, asset: a.name }, s)
      };
    });
    var res = await bgSend('enqueue', { items: items });
    st.busy = false;
    if (res.error) {
      st.error = res.error;
      renderBody();
      renderFooter();
      return;
    }
    await poll();
    renderFooter();
  }

  async function poll() {
    var res = await bgSend('state', {});
    if (!res || !res.tasks) return;
    var sig = res.tasks.map(function (t) { return t.id + t.status + t.received + '/' + t.total; }).join('|');
    if (sig === st.taskSig) return;
    st.taskSig = sig;
    st.tasks = res.tasks;
    renderTasks();
    renderFooter();
  }

  /* ---------- 装配 ---------- */

  async function init() {
    st.settings = await getSettings();

    $('btnScan').onclick = scan;
    $('btnRe').onclick = function () { scan(); };
    $('btnGo').onclick = download;
    $('rel').onchange = function () { pickRelease(parseInt($('rel').value, 10) || 0); };
    $('repo').addEventListener('keydown', function (e) { if (e.key === 'Enter') scan(); });
    $('btnOptions').onclick = function () { bgSend('open-options'); };
    $('btnAll').onclick = function () {
      var list = visibleAssets();
      var allOn = list.every(function (a) { return st.picked[a.name]; });
      list.forEach(function (a) { st.picked[a.name] = !allOn; });
      renderBody();
      renderFooter();
    };
    $('lnkHelp').onclick = function (e) {
      e.preventDefault();
      bgSend('open-options');
    };
    document.querySelectorAll('.tg[data-filter]').forEach(function (b) {
      b.onclick = function () {
        st.filter = b.getAttribute('data-filter');
        document.querySelectorAll('.tg[data-filter]').forEach(function (x) { x.classList.toggle('on', x === b); });
        renderBody();
      };
    });

    renderRoute();
    renderBody();
    renderFooter();

    // 从当前标签页猜仓库
    try {
      var tabs = await EXT.tabs.query({ active: true, currentWindow: true });
      var url = tabs && tabs[0] && tabs[0].url;
      if (url && /^https:\/\/github\.com\//.test(url)) {
        var m = url.match(/github\.com\/([^/]+)\/([^/?#]+)/);
        if (m && m[1] !== 'orgs' && m[1] !== 'settings' && m[1] !== 'marketplace') {
          $('repo').value = m[1] + '/' + m[2];
        }
      }
    } catch (e) { /* 没有 tabs 权限也没关系 */ }

    poll();
    setInterval(poll, 800);
    setInterval(renderRoute, 1500);
  }

  init();
})();
