/* 内容脚本：在 GitHub 发布页右下角挂一个像素风面板
 * 勾选资源 → 交给后台测速选线 → 浏览器原生下载并按 仓库/版本 归档
 */
(function () {
  'use strict';
  if (window.__ghdlInjected) return;
  window.__ghdlInjected = true;

  var state = {
    open: false,
    loading: false,
    repo: '',
    owner: '',
    tag: '',
    assets: [],
    picked: {},
    filter: 'all',
    hist: {},          // url -> 下载完成时间戳
    histVer: -1,
    showRoutes: false,
    settings: null,
    tasks: [],
    probe: null,
    error: '',
    panel: null,
    host: null
  };

  var CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;margin:0;padding:0}',
    '.wrap{position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;color:#1A1E30;line-height:1.45}',
    '.fab{width:56px;height:56px;background:#FF6A3D;border:3px solid #1A1E30;box-shadow:4px 4px 0 #1A1E30;cursor:pointer;display:flex;align-items:center;justify-content:center;position:relative;transition:transform .08s}',
    '.fab:hover{transform:translate(-1px,-1px);box-shadow:5px 5px 0 #1A1E30}',
    '.fab:active{transform:translate(2px,2px);box-shadow:2px 2px 0 #1A1E30}',
    '.fab svg{width:28px;height:28px;display:block}',
    '.fab .dot{position:absolute;right:-6px;top:-8px;background:#2ED3A5;border:2px solid #1A1E30;min-width:22px;height:22px;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px}',
    '.card{width:392px;max-height:min(560px,calc(100vh - 60px));background:#FFFDF6;border:3px solid #1A1E30;box-shadow:6px 6px 0 rgba(26,30,48,.85);display:flex;flex-direction:column;overflow:hidden}',
    '.hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1A1E30;color:#FFF3DC}',
    '.hd .t{font-weight:700;font-size:13.5px;letter-spacing:.3px}',
    '.hd .repo{margin-left:auto;font-size:11.5px;color:#C9CBD8;max-width:170px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.hd .x{width:22px;height:22px;border:2px solid #FFF3DC;background:transparent;color:#FFF3DC;cursor:pointer;font-size:13px;line-height:1;display:flex;align-items:center;justify-content:center}',
    '.hd .x:hover{background:#FF6A3D;border-color:#FF6A3D;color:#fff}',
    '.bar{display:flex;gap:6px;padding:8px 10px;border-bottom:2px solid #1A1E30;background:#FFF3DC;flex-wrap:wrap;align-items:center}',
    '.tg{border:2px solid #1A1E30;background:#FFFDF6;padding:2px 8px;font-size:11.5px;cursor:pointer;font-weight:600;color:#5B5F70}',
    '.tg:hover{background:#fff}',
    '.tg.on{background:#1A1E30;color:#FFF3DC}',
    '.cnt{margin-left:auto;font-size:11.5px;color:#5B5F70}',
    '.list{overflow:auto;flex:1;padding:4px 0}',
    '.row{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-bottom:1px dashed #E6DCC6;cursor:pointer}',
    '.row:hover{background:#FFF7E6}',
    '.row.sel{background:#FFF1DE}',
    '.cb{width:15px;height:15px;min-width:15px;border:2px solid #1A1E30;background:#fff;margin-top:2px;position:relative}',
    '.row.sel .cb{background:#FF6A3D}',
    '.row.sel .cb:after{content:"";position:absolute;left:3px;top:0;width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(42deg)}',
    '.nm{flex:1;font-size:12px;word-break:normal;overflow-wrap:anywhere;line-height:1.4;font-family:ui-monospace,Menlo,Consolas,monospace}',
    '.sz{font-size:11.5px;color:#5B5F70;white-space:nowrap;margin-top:1px}',
    '.bd{font-size:9.5px;font-weight:800;line-height:1.5;padding:0 4px;margin-top:1px;white-space:nowrap;border:1px solid transparent;color:#5B5F70}',
    '.bd:empty{display:none}',
    '.bd.ing{background:#FFECBE;border-color:#965C06;color:#965C06}',
    '.bd.done{background:#CEF5E8;border-color:#087458;color:#087458}',
    '.bd.paused{background:#E7E4DC;border-color:#5B5F70;color:#5B5F70}',
    '.row.st-done{background:#F3FAF5}',
    '.row.st-done:hover{background:#E9F7EE}',
    '.row.st-done .nm{color:#6B7A72}',
    '.row.st-done .cb{border-color:#9BB3A6;background:#F7FBF8}',
    '.row.st-done.sel{background:#E4F5EA}',
    '.row.st-done.sel .cb{background:#2ED3A5;border-color:#087458}',
    '.row.st-ing{background:#FFFBF0}',
    '.row.st-paused{background:#F6F4EE}',
    '.ft{border-top:2px solid #1A1E30;padding:9px 10px;display:flex;flex-direction:column;gap:7px;background:#FFF3DC}',
    '.rt{display:flex;align-items:center;gap:6px;font-size:11.5px;color:#5B5F70}',
    '.pill{border:2px solid #1A1E30;padding:1px 7px;font-weight:700;font-size:11px;background:#CEF5E8;color:#087458}',
    '.pill.bad{background:#FFD6C2;color:#782814}',
    '.pill.wait{background:#FFECBE;color:#965C06}',
    '.lk{margin-left:auto;color:#782814;cursor:pointer;text-decoration:underline;font-size:11px}',
    '.go{width:100%;border:3px solid #1A1E30;background:#FF6A3D;color:#fff;font-weight:800;font-size:13.5px;padding:9px 10px;cursor:pointer;box-shadow:3px 3px 0 #1A1E30;letter-spacing:.5px}',
    '.go:hover{background:#FF7E55}',
    '.go:active{transform:translate(2px,2px);box-shadow:1px 1px 0 #1A1E30}',
    '.go[disabled]{background:#D9D2C2;color:#8A8577;cursor:not-allowed;box-shadow:none}',
    '.msg{padding:14px 12px;font-size:12.5px;color:#5B5F70;text-align:center;line-height:1.7}',
    '.msg b{color:#C63020}',
    '.tip{font-size:11px;color:#5B5F70;padding:0 2px}',
    '.sk{padding:10px 12px;font-size:12.5px;color:#5B5F70}',
    '.qs{border-bottom:2px solid #1A1E30;background:#F7F2E4;max-height:190px;overflow:auto}',
    '.qhd{display:flex;align-items:center;gap:6px;padding:6px 10px;font-size:11.5px;font-weight:700;color:#5B5F70;border-bottom:1px dashed #E0D5BE}',
    '.qhd .spd{margin-left:auto;color:#087458}',
    '.q{padding:7px 10px;border-bottom:1px dashed #E6DCC6}',
    '.q .qn{display:flex;align-items:center;gap:6px;font-size:11.5px;font-family:ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}',
    '.q .qn .nmx{flex:1;min-width:0}',
    '.q .rt2{font-size:10px;color:#5B5F70;background:#EFE7D2;border:1px solid #E0D5BE;padding:0 4px;white-space:nowrap}',
    '.qflag{font-size:9.5px;font-weight:800;padding:0 4px;border:1px solid #1A1E30;background:#EFE7D2;white-space:nowrap}',
    '.qflag.ok{background:#B8E6C8}',
    '.qflag.bad{background:#FFC9B4}',
    '.q .qb{display:flex;align-items:center;gap:8px;margin-top:4px}',
    '.q .qbar{flex:1;height:9px;border:2px solid #1A1E30;background:#fff;overflow:hidden}',
    '.q .qbar i{display:block;height:100%;background:#2ED3A5}',
    '.q .qmeta{font-size:10.5px;color:#5B5F70;white-space:nowrap}',
    '.q .qtact{display:flex;gap:12px;margin-top:3px}',
    '.q .qtact .lk2{font-size:10.5px;color:#782814;cursor:pointer;text-decoration:underline;background:none;border:none;padding:0;font-family:inherit}',
    '.q .qtact .lk2.go2{color:#087458;font-weight:700}',
    '.q.pz{background:#F6F4EE}',
    '.q .qbar.pause i{background:#C9C2B0}',
    '.qflag.pause{background:#E7E4DC}',
    '.promo{display:flex;align-items:center;gap:6px;border-top:2px dashed #E0D5BE;padding-top:6px;font-size:11px;color:#5B5F70}',
    '.promo .pz{color:#FF6A3D;font-size:12px;line-height:1}',
    '.promo .pt2{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.promo .pz2{border:2px solid #1A1E30;background:#FF6A3D;color:#fff;font-size:10px;font-weight:800;padding:1px 6px;cursor:pointer;white-space:nowrap;font-family:inherit}',
    '.promo .pz2.gh{background:#FFFDF6;color:#1A1E30}',
    '.rlist{border:2px solid #1A1E30;background:#FFFDF6;max-height:184px;overflow:auto}',
    '.rline{display:flex;align-items:center;gap:8px;padding:3px 8px;font-size:11px;border-bottom:1px dashed #E6DCC6;cursor:pointer}',
    '.rline:hover{background:#FFF7E6}',
    '.rline .rn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.rline .rs{color:#5B5F70;white-space:nowrap}',
    '.rline.ok .rs{color:#087458;font-weight:700}',
    '.rline.bad{opacity:.6}',
    '.rline.bad .rs{color:#782814}',
    '.rline.pref{background:#FFF1DE}',
    '.rline.rhead{background:#F7F2E4;font-weight:700;color:#5B5F70;cursor:default}',
    '.rfoot{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:10.5px;color:#5B5F70}',
    '.rfoot .lk{margin-left:auto}'
  ].join('');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // 设置异步读一次就够了（线路偏好、归档开关）
  getSettings().then(function (s) { state.settings = s; }).catch(function () {});

  function detect() {
    var m = location.pathname.match(/^\/([^/]+)\/([^/]+)\/releases(?:\/(tag|latest|download)\/?(.*))?\/?$/);
    if (!m) return null;
    if (m[3] === 'download') return null;      // 具体文件页不挂面板
    return { owner: m[1], repo: m[2], tag: m[3] === 'tag' ? decodeURIComponent(m[4] || '') : '' };
  }

  /* 兜底：直接从页面里扒下载链接（API 不通、私有仓库、限流时用） */
  function assetsFromDom() {
    var seen = {};
    var out = [];
    document.querySelectorAll('a[href*="/releases/download/"]').forEach(function (a) {
      var href = a.getAttribute('href') || '';
      var abs = href.indexOf('http') === 0 ? href : location.origin + href;
      var p = parseAssetUrl(abs);
      if (!p || seen[p.asset]) return;
      seen[p.asset] = true;
      var sizeText = '';
      var box = a.closest('div.Box-row') || a.closest('li') || a.parentElement;
      if (box) {
        var sp = box.querySelector('span.color-fg-muted, span.text-sm.color-fg-muted');
        if (sp && /\d/.test(sp.textContent)) sizeText = sp.textContent;
      }
      out.push({ name: p.asset, size: parseSizeText(sizeText), url: abs, type: '', downloads: 0 });
    });
    return out;
  }

  function matchesFilter(a) {
    if (state.filter === 'all') return true;
    return platformOf(a.name) === state.filter;
  }

  /* 每个文件当前处于哪一步：new / ing / paused / done */
  function liveTask(url) {
    return (state.tasks || []).filter(function (t) {
      return t.url === url && (t.status === 'downloading' || t.status === 'probing' ||
        t.status === 'queued' || t.status === 'paused');
    })[0];
  }

  function stateOf(url) {
    var t = liveTask(url);
    if (t) {
      if (t.status === 'paused') return { kind: 'paused', text: '已暂停' };
      var total = t.total || t.size || 0;
      if (t.status === 'downloading' && total > 0) {
        return { kind: 'ing', text: Math.min(99, Math.round(t.received / total * 100)) + '%' };
      }
      return { kind: 'ing', text: t.status === 'queued' ? '排队' : '…' };
    }
    if (state.hist[url]) return { kind: 'done', text: '已下载' };
    return { kind: 'new', text: '' };
  }

  async function refreshHist() {
    if (!state.assets.length) { state.hist = {}; return; }
    var res = await bgSend('history', { urls: state.assets.map(function (a) { return a.url; }) });
    state.hist = (res && res.hist) || {};
    if (res && typeof res.ver === 'number') state.histVer = res.ver;
  }

  function pickedAssets() {
    return state.assets.filter(function (a) { return state.picked[a.name] && matchesFilter(a); });
  }

  async function loadAssets() {
    var d = detect();
    if (!d) return;
    if (state.repo === d.owner + '/' + d.repo && state.assets.length && state.tag === d.tag) return;
    state.owner = d.owner;
    state.repo = d.owner + '/' + d.repo;
    state.tag = d.tag;
    state.loading = true;
    state.error = '';
    state.assets = [];
    state.picked = {};
    render();
    var res = await bgSend('list-assets', { repo: state.repo, tag: d.tag || 'latest' });
    if (res && !res.error && res.release) {
      state.tag = res.release.tag;
      state.assets = res.release.assets || [];
    } else {
      // API 不可用就退回页面 DOM
      var dom = assetsFromDom();
      if (dom.length) {
        state.assets = dom;
        state.tag = d.tag || (location.pathname.match(/\/tag\/(.+)$/) || [])[1] || 'latest';
      } else {
        state.error = (res && res.error) || '没找到这个版本的资源';
      }
    }
    state.loading = false;
    await refreshHist();
    // 默认勾选：小体积优先全选，大仓库只勾 Windows；已经下过的先不勾
    var total = state.assets.length;
    var autoWin = state.assets.some(function (a) { return platformOf(a.name) === 'win'; });
    state.assets.forEach(function (a) {
      var want = autoWin && total > 6 ? platformOf(a.name) === 'win' : true;
      state.picked[a.name] = want && !state.hist[a.url];
    });
    if (!state.assets.some(function (a) { return state.picked[a.name]; })) {
      state.assets.forEach(function (a) {
        state.picked[a.name] = autoWin && total > 6 ? platformOf(a.name) === 'win' : true;
      });
    }
    render();
    if (state.assets.length) probeBest();
  }

  async function probeBest() {
    // 用最小的那个文件测速，代价最低
    var sorted = state.assets.slice().sort(function (a, b) { return (a.size || 0) - (b.size || 0); });
    var target = (sorted.filter(function (a) { return a.size > 0; })[0] || sorted[0]);
    if (!target) return;
    state.probe = { loading: true };
    render();
    var res = await bgSend('probe', { url: target.url, key: state.repo + '@' + state.tag });
    state.probe = res && res.list ? res : { error: (res && res.error) || '测速失败' };
    render();
  }

  /* ---------- 下载队列 ---------- */

  function queueHtml() {
    var list = state.tasks || [];
    var live = list.filter(function (t) {
      return t.status === 'downloading' || t.status === 'probing' ||
        t.status === 'queued' || t.status === 'paused';
    });
    if (!live.length) return '';
    var running = live.filter(function (t) { return t.status !== 'paused'; });
    var pausedN = live.length - running.length;
    var spd = running.reduce(function (s, t) { return s + (t.speed || 0); }, 0);
    var html = '<div class="qs"><div class="qhd">' +
      (running.length ? '正在下载 ' + running.length + ' 个' : '任务已暂停') +
      (pausedN ? ' · ' + pausedN + ' 个已暂停' : '') +
      (spd ? '<span class="spd">共 ' + fmtSpeed(spd) + '</span>' : '') + '</div>';
    live.slice(0, 6).forEach(function (t) {
      var total = t.total || t.size || 0;
      var pct = total > 0 ? Math.min(100, Math.round(t.received / total * 100)) : 0;
      var meta;
      if (t.status === 'paused') meta = '已暂停 · ' + pct + '%';
      else if (t.status === 'probing') meta = '选线中…';
      else if (t.status === 'queued') meta = '排队中';
      else if (t.boosting) meta = '自动提速中…';
      else {
        meta = pct + '%';
        if (t.speed) meta += ' · ' + fmtSpeed(t.speed);
        var eta = (t.speed && total) ? fmtEta((total - t.received) / t.speed) : '';
        if (eta) meta += ' · 剩 ' + eta;
      }
      var flag = '';
      if (t.status === 'paused') flag = '<span class="qflag pause">已暂停</span>';
      else if (t.slow && t.status === 'downloading') flag = '<span class="qflag bad">速度慢</span>';
      else if (t.boosting) flag = '<span class="qflag ok">提速</span>';
      else if (t.segmented && t.status === 'downloading') flag = '<span class="qflag">多线程</span>';

      var acts = '';
      if (t.status === 'paused') {
        acts += '<button class="lk2 go2" data-rs="' + esc(t.id) + '">继续</button>';
      } else {
        acts += '<button class="lk2" data-pz="' + esc(t.id) + '">暂停</button>';
      }
      if (t.status === 'downloading' || t.status === 'queued' || t.status === 'paused') {
        acts += '<button class="lk2" data-sw="' + esc(t.id) + '">换线路</button>';
      }
      acts += '<button class="lk2" data-cx="' + esc(t.id) + '">取消</button>';

      html += '<div class="q' + (t.status === 'paused' ? ' pz' : '') + '">' +
        '<div class="qn"><span class="nmx">' + esc(t.name) + '</span>' +
        (t.route ? '<span class="rt2">' + esc(t.route) + '</span>' : '') + flag + '</div>' +
        '<div class="qb"><div class="qbar' + (t.status === 'paused' ? ' pause' : '') +
        '"><i style="width:' + pct + '%"></i></div>' +
        '<span class="qmeta">' + esc(meta) + '</span></div>' +
        '<div class="qtact">' + acts + '</div>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }

  function wireQueue(root) {
    root.querySelectorAll('[data-pz]').forEach(function (b) {
      b.addEventListener('click', async function () {
        b.textContent = '暂停中…';
        var r = await bgSend('pause-task', { id: b.getAttribute('data-pz') });
        if (r && r.error) {
          b.textContent = '这条线路不支持暂停';
          setTimeout(function () { refreshQueue(); }, 1500);
        } else {
          refreshQueue();
        }
      });
    });
    root.querySelectorAll('[data-rs]').forEach(function (b) {
      b.addEventListener('click', async function () {
        b.textContent = '继续中…';
        await bgSend('resume-task', { id: b.getAttribute('data-rs') });
        refreshQueue();
      });
    });
    root.querySelectorAll('[data-sw]').forEach(function (b) {
      b.addEventListener('click', function () {
        b.textContent = '换线中…';
        bgSend('switch-route', { id: b.getAttribute('data-sw') });
      });
    });
    root.querySelectorAll('[data-cx]').forEach(function (b) {
      b.addEventListener('click', function () {
        bgSend('cancel-task', { id: b.getAttribute('data-cx') });
      });
    });
  }

  /* 队列区和列表角标都只改 DOM，不整块重画（面板滚动位置不会跳） */
  function refreshQueue() {
    var root = state.host && state.host.shadowRoot;
    if (!root) return;
    var q = root.getElementById('qwrap');
    if (q) {
      var next = queueHtml();
      if (q.innerHTML !== next) {
        q.innerHTML = next;
        wireQueue(root);
      }
    }
    root.querySelectorAll('.row').forEach(function (el) {
      var ss = stateOf(el.getAttribute('data-url'));
      el.classList.remove('st-new', 'st-ing', 'st-done', 'st-paused');
      el.classList.add('st-' + ss.kind);
      var bd = el.querySelector('.bd');
      if (bd) { bd.className = 'bd ' + ss.kind; bd.textContent = ss.text; }
    });
  }

  function startPoll() {
    if (state.timer) return;
    state.timer = setInterval(async function () {
      var st = await bgSend('state', {});
      if (!st || !st.tasks) return;
      state.tasks = st.tasks;
      if (typeof st.histVer === 'number' && st.histVer !== state.histVer && state.assets.length) {
        state.histVer = st.histVer;
        await refreshHist();
      }
      refreshQueue();
    }, 1000);
  }

  function stopPoll() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
  }

  function render() {
    if (!state.host) return;
    var root = state.host.shadowRoot;
    var d = detect();
    if (!d) { state.host.style.display = 'none'; return; }
    state.host.style.display = '';

    var picked = pickedAssets();
    var pickedSize = picked.reduce(function (s, a) { return s + (a.size || 0); }, 0);

    var body;
    if (state.loading) {
      body = '<div class="sk">正在读取这个版本的资源…</div>';
    } else if (state.error) {
      body = '<div class="msg"><b>' + esc(state.error) + '</b><br>可以点右下角图标重试，或在设置里填 GitHub Token</div>';
    } else if (!state.assets.length) {
      body = '<div class="msg">这个版本没有可下载的资源</div>';
    } else {
      var rows = state.assets.filter(matchesFilter).map(function (a) {
        var on = !!state.picked[a.name];
        var ss = stateOf(a.url);
        return '<div class="row ' + (on ? 'sel ' : '') + 'st-' + ss.kind +
          '" data-name="' + esc(a.name) + '" data-url="' + esc(a.url) + '">' +
          '<div class="cb"></div>' +
          '<div class="nm">' + esc(a.name) + '</div>' +
          '<span class="bd">' + esc(ss.text) + '</span>' +
          '<div class="sz">' + (a.size ? fmtSize(a.size) : '—') + '</div>' +
          '</div>';
      }).join('');
      body = '<div class="list">' + rows + '</div>';
    }

    var routeHtml = '';
    if (state.probe && state.probe.loading) {
      routeHtml = '<span class="pill wait">测速中…</span><span>正在挑最快的线路</span>';
    } else if (state.probe && state.probe.list) {
      var okList = state.probe.list.filter(function (r) { return r.ok; });
      var top = okList[0];
      if (top) {
        routeHtml = '<span class="pill" id="rtPill">' + esc(top.name) + ' ' + fmtSpeed(top.bps) + '</span>' +
          '<span>' + okList.length + ' 条可测速</span>';
      } else if (state.probe.blocked) {
        routeHtml = '<span class="pill wait" id="rtPill">测速受限</span><span>跨域受限，下载时仍会依次试</span>';
      } else {
        routeHtml = '<span class="pill bad" id="rtPill">线路都不通</span><span>稍后重新测速</span>';
      }
      routeHtml += '<span class="lk" id="reprobe">重新测速</span>' +
        '<span class="lk" id="rtToggle">' + (state.showRoutes ? '收起' : '全部线路') + '</span>';
    } else if (state.probe && state.probe.error) {
      routeHtml = '<span class="pill bad">测速失败</span><span>' + esc(state.probe.error) + '</span>';
    }

    var filters = [
      ['all', '全部'], ['win', 'Windows'], ['mac', 'macOS'], ['linux', 'Linux']
    ].map(function (f) {
      return '<div class="tg ' + (state.filter === f[0] ? 'on' : '') + '" data-filter="' + f[0] + '">' + f[1] + '</div>';
    }).join('');

    var html =
      '<div class="wrap">' +
      (state.open ? (
        '<div class="card">' +
          '<div class="hd">' +
            '<div class="t">Release 下载助手</div>' +
            '<div class="repo">' + esc(state.repo) + (state.tag ? ' · ' + esc(state.tag) : '') + '</div>' +
            '<button class="x" id="close">×</button>' +
          '</div>' +
          '<div class="bar">' + filters +
            '<span class="cnt">' + picked.length + '/' + state.assets.length + ' 已选</span>' +
          '</div>' +
          '<div id="qwrap">' + queueHtml() + '</div>' +
          body +
          '<div class="ft">' +
            '<div class="rt">' + routeHtml + '</div>' +
            (state.showRoutes ? routeListHtml() : '') +
            '<button class="go" id="go"' + (picked.length ? '' : ' disabled') + '>下载 ' + picked.length + ' 个文件' +
              (pickedSize ? '（' + fmtSize(pickedSize) + '）' : '') + '</button>' +
            '<div class="tip">保存到「下载/GitHub/仓库/版本」，可在扩展设置里关掉归档</div>' +
            '<div class="promo">' +
              '<span class="pz">✦</span>' +
              '<span class="pt2">' + esc(PROMO.short) + '</span>' +
              '<button class="pz2" data-url="' + esc(PROMO.url) + '">领取积分</button>' +
              '<button class="pz2 gh" data-url="' + esc(PROMO.more) + '">更多 →</button>' +
            '</div>' +
          '</div>' +
        '</div>'
      ) : (
        '<div class="fab" id="fab">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="#FFF3DC" stroke-width="2.6" stroke-linecap="square">' +
            '<path d="M12 3v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4 19h16"/>' +
          '</svg>' +
          '<span class="dot">' + (state.assets.length || '') + '</span>' +
        '</div>'
      )) +
      '</div>';

    root.innerHTML = '<style>' + CSS + '</style>' + html;
    wire(root);
  }

  /* 线路面板：点「全部线路」展开，把测速结果和线路池状态一次看全 */
  function routeListHtml() {
    var list = (state.probe && state.probe.list) || [];
    if (!list.length) {
      return '<div class="rlist"><div class="rline"><span>还没测速，点「重新测速」看看每条线路的实测速度</span></div></div>';
    }
    var head = '<div class="rline rhead"><span>线路</span><span>实测</span></div>';
    var rows = list.slice(0, 20).map(function (r) {
      var sp = r.ok ? fmtSpeed(r.bps) : (r.err === 'cors' ? '跨域受限' : (r.err === 'timeout' ? '超时' : '不通'));
      var key = prefKey(r.prefix);
      var pref = (state.settings && state.settings.preferRoute) === key;
      return '<div class="rline ' + (r.ok ? 'ok' : 'bad') + (pref ? ' pref' : '') +
        '" data-prefix="' + esc(key) + '" title="点一下固定使用这条线路">' +
        '<span class="rn">' + (pref ? '★ ' : '') + esc(r.name) + '</span>' +
        '<span class="rs">' + esc(sp) + '</span></div>';
    }).join('');
    return '<div class="rlist">' + head + rows +
      '<div class="rfoot"><span>点某条线路可固定使用；再次点击取消</span>' +
      '<span class="lk" id="rtRefresh">更新线路池</span></div></div>';
  }

  function wire(root) {
    wireQueue(root);
    var fab = root.getElementById('fab');
    if (fab) fab.addEventListener('click', function () {
      state.open = true;
      render();
      startPoll();
      if (!state.assets.length && !state.loading) loadAssets(); else if (!state.probe) probeBest();
    });

    var close = root.getElementById('close');
    if (close) close.addEventListener('click', function () { state.open = false; stopPoll(); render(); });

    root.querySelectorAll('[data-filter]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.filter = el.getAttribute('data-filter');
        render();
      });
    });

    root.querySelectorAll('.row').forEach(function (el) {
      el.addEventListener('click', function () {
        var name = el.getAttribute('data-name');
        state.picked[name] = !state.picked[name];
        render();
      });
    });

    var reprobe = root.getElementById('reprobe');
    if (reprobe) reprobe.addEventListener('click', function () { probeBest(); });

    var rtToggle = root.getElementById('rtToggle');
    if (rtToggle) rtToggle.addEventListener('click', function () {
      state.showRoutes = !state.showRoutes;
      render();
    });

    // 点某条线路 = 固定使用它；再点一下取消
    root.querySelectorAll('.rline[data-prefix]').forEach(function (el) {
      el.addEventListener('click', async function () {
        var prefix = el.getAttribute('data-prefix') || '';
        var cur = (state.settings && state.settings.preferRoute) || '';
        var next = cur === prefix ? '' : prefix;
        state.settings = await saveSettings({ preferRoute: next });
        render();
      });
    });

    var rtRefresh = root.getElementById('rtRefresh');
    if (rtRefresh) rtRefresh.addEventListener('click', async function () {
      rtRefresh.textContent = '更新中…';
      await bgSend('refresh-pool');
      await probeBest();
    });

    // 引流按钮：内容脚本够不着 tabs API，交后台开新标签
    root.querySelectorAll('.pz2[data-url]').forEach(function (el) {
      el.addEventListener('click', function () {
        bgSend('open-url', { url: el.getAttribute('data-url') });
      });
    });

    var go = root.getElementById('go');
    if (go) go.addEventListener('click', async function () {
      var list = pickedAssets();
      if (!list.length) return;
      go.disabled = true;
      go.textContent = '正在加入下载队列…';
      var settings = await getSettings();
      var items = list.map(function (a) {
        return {
          url: a.url,
          asset: a.name,
          size: a.size,
          owner: state.owner,
          repo: state.repo.split('/')[1],
          tag: state.tag,
          path: buildPath({ owner: state.owner, repo: state.repo.split('/')[1], tag: state.tag, asset: a.name }, settings)
        };
      });
      var res = await bgSend('enqueue', { items: items });
      if (res && res.error) {
        go.textContent = '加入失败：' + res.error;
        return;
      }
      var extra = res.blocked ? '（' + res.blocked + ' 个已在队列）' : '';
      go.textContent = '已加入 ' + res.added + ' 个' + extra;
      // 面板不关：下载进度就显示在上面的队列里
      startPoll();
      var st0 = await bgSend('state', {});
      if (st0 && st0.tasks) state.tasks = st0.tasks;
      setTimeout(function () { render(); startPoll(); }, 400);
    });
  }

  function mount() {
    if (!detect()) {
      if (state.host) state.host.style.display = 'none';
      return;
    }
    if (state.host && document.documentElement.contains(state.host)) {
      render();
      return;
    }
    state.host = document.createElement('div');
    state.host.id = 'ghdl-host';
    state.host.attachShadow({ mode: 'open' });
    document.documentElement.appendChild(state.host);
    state.assets = [];
    state.probe = null;
    render();
  }

  try {
    EXT.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === 'open-panel') {
        state.open = true;
        render();
        if (!state.assets.length) loadAssets();
      }
    });
  } catch (e) {}

  ['turbo:load', 'pjax:end'].forEach(function (ev) {
    document.addEventListener(ev, function () { setTimeout(mount, 300); });
  });

  var lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      mount();
    }
  }, 1000);

  mount();
})();
