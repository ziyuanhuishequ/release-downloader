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
    onlyNew: false,      // 只看未下载
    hist: {},            // url -> 上次下载完成的时间戳
    histVer: -1,
    probe: null,
    settings: null,
    tasks: [],
    routes: [],
    pool: null,
    via: '',             // 这次 API 数据是经哪个镜像拿的（直连为空）
    prefer: '',
    showRoutes: false,
    busy: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var bodyEl = $('body');

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 每个文件当前处于哪一步：new 没下过 / ing 正在下 / paused 暂停 / done 已下载 */
  function liveTask(url) {
    return st.tasks.filter(function (t) {
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
    if (st.hist[url]) return { kind: 'done', text: '已下载' };
    return { kind: 'new', text: '' };
  }

  function visibleAssets() {
    return st.assets.filter(function (a) {
      if (st.onlyNew && stateOf(a.url).kind === 'done') return false;
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
    var html;
    if (!p) {
      html = '<span class="pill wait">未测速</span><span class="rt-txt">下载前会自动挑最快的线路</span><button class="lnk" id="btnProbe">测速</button>';
    } else if (p.loading) {
      html = '<span class="pill wait">测速中…</span><span class="rt-txt">正在并发测试各条镜像</span>';
    } else if (p.list) {
      var ok = p.list.filter(function (r) { return r.ok; });
      var best = ok[0];
      var blocked = p.blocked || 0;
      if (best) {
        html = '<span class="pill ok">' + esc(best.name) + '</span><span class="rt-txt">' + fmtSpeed(best.bps) + ' · ' + ok.length + ' 条可测速</span><button class="lnk" id="btnProbe">重测</button>';
      } else if (blocked) {
        html = '<span class="pill wait">测速受限</span><span class="rt-txt" title="镜像没有开放跨域读取，浏览器测不了速度，但不影响下载：下载时会按顺序自动尝试">跨域受限，下载时仍会依次试</span><button class="lnk" id="btnProbe">重测</button>';
      } else {
        html = '<span class="pill bad">线路都不通</span><span class="rt-txt">稍后重测，或先在设置里加自定义线路</span><button class="lnk" id="btnProbe">重测</button>';
      }
    } else {
      html = '<span class="pill bad">测速失败</span><span class="rt-txt">' + esc(p.error || '') + '</span><button class="lnk" id="btnProbe">重试</button>';
    }
    html += '<button class="lnk" id="btnRoutes">' + (st.showRoutes ? '收起' : '线路') + '</button>';
    if (el.innerHTML !== html) {
      el.innerHTML = html;
      var b = $('btnProbe');
      if (b) b.onclick = function () { doProbe(); };
      var rb = $('btnRoutes');
      if (rb) rb.onclick = function () { toggleRoutes(); };
    }
    renderRouteList();
  }

  /* 线路面板：点开就能看每条线路的实测速度、历史健康度、是否在冷却 */
  async function toggleRoutes() {
    st.showRoutes = !st.showRoutes;
    if (st.showRoutes) await loadRouteList();
    renderRoute();
  }

  async function loadRouteList() {
    var res = await bgSend('routes', {});
    st.routes = (res && res.routes) || [];
    st.pool = (res && res.pool) || null;
    st.prefer = (res && res.prefer) || '';
  }

  function renderRouteList() {
    var box = $('rlist');
    if (!box) return;
    if (!st.showRoutes) {
      box.classList.add('hide');
      box.innerHTML = '';
      box.dataset.sig = '';
      return;
    }
    box.classList.remove('hide');
    var probeMap = {};
    ((st.probe && st.probe.list) || []).forEach(function (r) { probeMap[r.prefix] = r; });
    var rows = st.routes.map(function (r) {
      var pb = probeMap[r.prefix];
      var speed;
      if (pb && pb.ok) speed = fmtSpeed(pb.bps);
      else if (pb && pb.err === 'cors') speed = '跨域受限';
      else if (pb && pb.err === 'timeout') speed = '超时';
      else if (pb && !pb.ok) speed = '不通';
      else if (r.score > 0) speed = '≈' + fmtSpeed(r.score);
      else speed = '未测';
      var cls = (pb && pb.ok) || r.score > 0 ? 'ok' : (pb && !pb.ok ? 'bad' : '');
      if (r.cooling) cls = 'bad';
      var star = !!st.prefer && st.prefer === prefKey(r.prefix);
      return '<div class="rline ' + cls + (star ? ' pref' : '') + '" data-prefix="' + esc(prefKey(r.prefix)) +
        '" title="点一下固定用这条线路，再点取消">' +
        '<span class="rn">' + (star ? '★ ' : '') + esc(r.name || '直连') + '</span>' +
        '<span class="rs">' + esc(r.cooling ? '冷却中' : speed) + '</span></div>';
    }).join('') || '<div class="rline"><span class="rn">线路池还没加载，点下面「更新线路池」</span></div>';
    var pool = st.pool;
    var poolTxt = pool
      ? 'v' + esc(String(pool.ver || 1)) + ' · ' + pool.count + ' 条 · ' + esc(pool.updated || '')
      : '用内置线路表';
    var head = '<div class="rline rhead"><span class="rn">线路</span><span class="rs">实测</span></div>';
    var foot = '<div class="rfoot"><span>' + poolTxt + '</span>' +
      '<button class="lnk" id="btnPool">更新线路池</button></div>';
    if (box.dataset.sig === head + rows + foot) return;   // 没变就别重建，免得点一次就被刷掉
    box.dataset.sig = head + rows + foot;
    box.innerHTML = head + rows + foot;    box.querySelectorAll('.rline[data-prefix]').forEach(function (el) {
      el.onclick = async function () {
        var prefix = el.getAttribute('data-prefix') || '';
        st.prefer = st.prefer === prefix ? '' : prefix;
        await saveSettings({ preferRoute: st.prefer });
        renderRouteList();
      };
    });
    var bp = $('btnPool');
    if (bp) bp.onclick = async function () {
      bp.textContent = '更新中…';
      bp.disabled = true;
      await bgSend('refresh-pool', { force: true });
      await loadRouteList();
      // 线路池可能加了新域名，这里补一次授权（必须是点击回调里）
      await ensureRoutePerms(st.routes);
      st.probe = null;
      renderRoute();
      doProbe();
    };
  }

  /* 任务条：百分比 + 实时速度 + 剩余时间 + 生效线路，可暂停/换线路/取消 */
  function taskStripHtml() {
    var live = st.tasks.filter(function (t) {
      return t.status === 'downloading' || t.status === 'probing' ||
        t.status === 'queued' || t.status === 'paused';
    });
    var recent = st.tasks.filter(function (t) {
      return t.status === 'done' || t.status === 'failed';
    }).slice(-1);
    if (!live.length && !recent.length) return '';

    var running = live.filter(function (t) { return t.status !== 'paused'; });
    var paused = live.length - running.length;
    var totalSpeed = running.reduce(function (s, t) { return s + (t.speed || 0); }, 0);
    var html = '';
    if (live.length) {
      html += '<div class="sec-title">' +
        (running.length ? '正在下载 ' + running.length + ' 个' : '任务已暂停') +
        (paused ? ' · ' + paused + ' 个已暂停' : '') +
        (totalSpeed ? ' · 共 ' + fmtSpeed(totalSpeed) : '') + '</div>';
      live.slice(0, 4).forEach(function (t) {
        var total = t.total || t.size || 0;
        var pct = total > 0 ? Math.min(100, Math.round(t.received / total * 100)) : 0;
        var eta = (t.speed && total) ? fmtEta((total - t.received) / t.speed) : '';
        var meta;
        if (t.status === 'paused') meta = pct + '%';   // 「已暂停」由角标显示，这里不重复
        else if (t.status === 'probing') meta = '选线中…';
        else if (t.status === 'queued') meta = '排队中';
        else if (t.boosting) meta = '自动提速中…';
        else {
          meta = pct + '%';
          if (t.speed) meta += ' · ' + fmtSpeed(t.speed);
          if (eta) meta += ' · 剩 ' + eta;
        }
        var tag = '';
        if (t.status === 'paused') tag = '<span class="tflag pause">已暂停</span>';
        else if (t.slow && t.status === 'downloading') tag = '<span class="tflag bad">速度慢</span>';
        else if (t.boosting) tag = '<span class="tflag ok">提速</span>';
        else if (t.segmented && t.status === 'downloading') tag = '<span class="tflag">多线程</span>';

        var acts = '';
        if (t.status === 'paused') {
          acts += '<button class="lnk go2" data-rs="' + esc(t.id) + '">继续</button>';
        } else {
          acts += '<button class="lnk" data-pz="' + esc(t.id) + '">暂停</button>';
        }
        if (t.status === 'downloading' || t.status === 'queued' || t.status === 'paused') {
          acts += '<button class="lnk" data-sw="' + esc(t.id) + '">换线路</button>';
        }
        acts += '<button class="lnk" data-cx="' + esc(t.id) + '">取消</button>';

        html += '<div class="task' + (t.status === 'paused' ? ' is-pause' : '') + '">' +
          '<div class="tn"><span class="tname">' + esc(t.name) + '</span>' +
          (t.route ? '<span class="trt">' + esc(t.route) + '</span>' : '') + tag + '</div>' +
          '<div class="tb"><div class="bar' + (t.status === 'paused' ? ' pause' : '') +
            '"><i style="width:' + pct + '%"></i></div>' +
          '<span class="tm">' + esc(meta) + '</span></div>' +
          '<div class="tact">' + acts + '</div>' +
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
    wrap.querySelectorAll('[data-pz]').forEach(function (b) {
      b.onclick = async function () {
        b.disabled = true;
        b.textContent = '暂停中…';
        var r = await bgSend('pause-task', { id: b.getAttribute('data-pz') });
        if (r && r.error) {
          b.textContent = '暂停失败';
          b.title = r.error;
          setTimeout(function () { b.disabled = false; b.textContent = '暂停'; }, 1600);
        }
        await poll();
      };
    });
    wrap.querySelectorAll('[data-rs]').forEach(function (b) {
      b.onclick = async function () {
        b.disabled = true;
        b.textContent = '继续中…';
        var r = await bgSend('resume-task', { id: b.getAttribute('data-rs') });
        if (r && r.error) {
          b.textContent = '继续失败';
          b.title = r.error;
          setTimeout(function () { b.disabled = false; b.textContent = '继续'; }, 1600);
        }
        await poll();
      };
    });
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
    if (st.via) {
      html += '<div class="via">直连 GitHub API 不通，已自动经 <b>' + esc(st.via) + '</b> 读取</div>';
    }

    if (st.error) {
      var bgDown = typeof isBgDownError === 'function' && isBgDownError(st.error);
      html += bgDown
        ? '<div id="assetWrap"><div class="msg"><b>' + esc(st.error) + '</b>' +
          '<br><span class="tiny2">这不是仓库名的问题：扩展的后台脚本没跑起来，所以读不了 Release 列表。</span></div></div>'
        : '<div id="assetWrap"><div class="msg"><b>' + esc(st.error) + '</b>检查仓库地址是否正确；私有仓库需要在设置里填 GitHub Token。' +
          '<br><span class="tiny2">直连和镜像都试过了。仍然不行的话，多半是仓库名写错或这个仓库确实不存在。</span></div></div>';
      bodyEl.innerHTML = html;
      if (bgDown) showBgBanner();
      return;
    }

    if (!st.assets.length) {
      html += '<div id="assetWrap"><div class="hint"><div class="big">粘贴仓库地址就能下</div>' +
        '<div>例如 <b style="color:#1A1E30">sharkdp/bat</b>，或在 GitHub 的 Release 页面看右下角面板。</div>' +
        '<div style="margin-top:8px;color:#8A8577">github.com 打不开也能用：这里读的是 GitHub API，走的是独立的多条通道。</div></div></div>';
      bodyEl.innerHTML = html;
      return;
    }

    var list = visibleAssets();
    var rows = list.length
      ? list.map(function (a) {
          var on = !!st.picked[a.name];
          var ss = stateOf(a.url);
          return '<div class="row ' + (on ? 'sel ' : '') + 'st-' + ss.kind +
            '" data-name="' + esc(a.name) + '" data-url="' + esc(a.url) + '">' +
            '<div class="cb"></div>' +
            '<div class="nm">' + esc(a.name) + '</div>' +
            '<span class="bd">' + esc(ss.text) + '</span>' +
            '<div class="sz">' + (a.size ? fmtSize(a.size) : '—') + '</div></div>';
        }).join('')
      : '<div class="msg">' + (st.onlyNew && st.assets.length
          ? '这个版本的文件都下过了，取消「只看未下载」就能再下一次。'
          : '这个筛选下没有文件，换个分类看看。') + '</div>';

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

  /* 只改行的角标和底色，不重建 DOM：轮询刷新时滚动位置不会跳 */
  function paintRows() {
    bodyEl.querySelectorAll('.row').forEach(function (el) {
      var ss = stateOf(el.getAttribute('data-url'));
      el.classList.remove('st-new', 'st-ing', 'st-done', 'st-paused');
      el.classList.add('st-' + ss.kind);
      var bd = el.querySelector('.bd');
      if (bd) { bd.className = 'bd ' + ss.kind; bd.textContent = ss.text; }
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

    var running = st.tasks.filter(function (t) {
      return t.status === 'downloading' || t.status === 'probing' || t.status === 'queued';
    }).length;
    var paused = st.tasks.filter(function (t) { return t.status === 'paused'; }).length;
    var failed = st.tasks.filter(function (t) { return t.status === 'failed'; }).length;
    var bits = [];
    if (running) bits.push('队列 ' + running + ' 个进行中');
    if (paused) bits.push(paused + ' 个已暂停');
    if (!bits.length) bits.push(failed ? failed + ' 个失败（详见浏览器下载列表）' : '队列空闲');
    $('queue').textContent = bits.join(' · ');

    var cnt = $('rel');
    if (st.assets.length) cnt.title = st.assets.length + ' 个资源';

    // 已下载计数：一眼看出这个版本还剩几个没下
    var doneN = st.assets.filter(function (a) { return !!st.hist[a.url]; }).length;
    var mark = $('dlCount');
    if (mark) mark.textContent = st.assets.length ? doneN + '/' + st.assets.length + ' 已下载' : '';
    var on = $('btnOnlyNew');
    if (on) on.classList.toggle('on', st.onlyNew);
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
    st.via = res.via || '';
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
    st.via = res.via || st.via;
    st.release = res.release;
    st.assets = res.release.assets || [];
    await refreshHist();
    var win = st.assets.some(function (a) { return platformOf(a.name) === 'win'; });
    var autoWin = win && st.assets.length > 6;
    var pickedAny = 0;
    st.assets.forEach(function (a) {
      // 已经下过的默认不勾：避免每次扫描都把整个版本重下一遍
      var pick = (autoWin ? platformOf(a.name) === 'win' : true) && !st.hist[a.url];
      st.picked[a.name] = pick;
      if (pick) pickedAny++;
    });
    // 全都下过（或都被过滤掉）时退一步：全勾上，否则按钮点不动
    if (!pickedAny) {
      st.assets.forEach(function (a) {
        st.picked[a.name] = autoWin ? platformOf(a.name) === 'win' : true;
      });
    }
    st.filter = autoWin ? 'win' : 'all';
    document.querySelectorAll('.tg[data-filter]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-filter') === st.filter);
    });
    renderBody();
    renderFooter();
    if (st.settings && st.settings.autoProbe && st.assets.length) doProbe();
  }

  /* 查这一版哪些文件下过了；历史只查当前列表，几百条也不会拖慢弹窗 */
  async function refreshHist() {
    if (!st.assets.length) { st.hist = {}; return; }
    var res = await bgSend('history', {
      urls: st.assets.map(function (a) { return a.url; })
    });
    st.hist = (res && res.hist) || {};
    if (res && typeof res.ver === 'number') st.histVer = res.ver;
    paintRows();
    renderFooter();
  }

  async function doProbe() {
    if (!st.assets.length) return;
    var sorted = st.assets.slice().sort(function (a, b) { return (a.size || 0) - (b.size || 0); });
    var target = sorted.filter(function (a) { return a.size > 0; })[0] || sorted[0];
    st.probe = { loading: true };
    renderRoute();
    var res = await bgSend('probe', { url: target.url, key: st.repo + '@' + (st.release ? st.release.tag : '') });
    st.probe = res.list ? res : { error: res.error || '测速失败' };
    await loadRouteList();     // 测速结果会更新线路健康度
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
    showPromo();
  }

  /* 引流浮层：下载开始时右下角出现，8 秒后自动收起（不再常驻底部） */
  var promoTimer = 0;
  function showPromo(ms) {
    var el = $('promoToast');
    if (!el) return;
    el.classList.add('on');
    clearTimeout(promoTimer);
    promoTimer = setTimeout(function () {
      el.classList.remove('on');
    }, ms || 8000);
  }

  async function poll() {
    var res = await bgSend('state', {});
    if (!res || !res.tasks) return;
    var sig = res.tasks.map(function (t) { return t.id + t.status + t.received + '/' + t.total; }).join('|');
    var changed = sig !== st.taskSig;
    if (changed) {
      st.taskSig = sig;
      st.tasks = res.tasks;
      renderTasks();
    }
    // 有任务下完了（histVer 变了）就重查一遍列表角标
    var histChanged = typeof res.histVer === 'number' && res.histVer !== st.histVer;
    if (histChanged) {
      st.histVer = res.histVer;
      if (st.assets.length) { await refreshHist(); return; }
    }
    // 每次轮询都重画一次角标（只改 class 和文字，不动 DOM 结构，不会跳滚动条）
    if (changed) paintRows();
    renderFooter();
  }

  /* ---------- GitHub 国内访问（整站镜像开关） ---------- */

  var boostOn = false;
  var boostSite = null;

  function paintBoost(res) {
    boostOn = !!(res && res.on);
    boostSite = (res && res.site) || null;
    var sw = $('btnBoost');
    if (!sw) return;
    sw.classList.toggle('on', boostOn);
    sw.setAttribute('aria-checked', boostOn ? 'true' : 'false');
    var tip = $('boostTip');
    if (!tip) return;
    tip.className = 'bt2';
    tip.title = '';
    if (boostOn && boostSite) {
      tip.className = 'bt2 ok';
      tip.textContent = '已开启 · ' + boostSite.name + (boostSite.ms ? ' · ' + boostSite.ms + 'ms' : '') +
        (boostSite.ok === false ? '（正在换线）' : '');
    } else if (res && res.sites && res.sites.length) {
      var ok = res.sites.filter(function (x) { return x.ok; }).length;
      if (ok) {
        tip.textContent = '未开启 · 直连（' + ok + '/' + res.sites.length + ' 个镜像可用）';
        tip.title = '开启后 github.com 的页面会走镜像打开；下载不受影响。';
      } else {
        // 整站镜像本来就稀缺，0 个可用是常态。别让用户以为功能坏了——
        // 重点说明「下载和扫描仓库照样能用」。
        tip.textContent = '未开启 · 直连（镜像暂时都不通）';
        tip.className = 'bt2 bad';
        tip.title = '能打开 GitHub 网页的整站镜像本来就很少，暂时都不通。' +
          '下载文件、以及粘贴 owner/repo 扫描版本都不受影响。';
      }
    } else {
      tip.textContent = '未开启 · 直连 github.com';
    }
  }

  /* 后台连不上时在顶上挂一条红色说明：用户至少知道该去哪儿点「重新加载」，
   * 而不是看着每个按钮都弹一句英文的 Receiving end does not exist。 */
  function showBgBanner(detail) {
    if (document.getElementById('bgBanner')) return;
    var firefox = typeof EXT_MANAGER === 'string' && EXT_MANAGER.indexOf('debugging') >= 0;
    var where = firefox ? 'about:debugging' : 'chrome://extensions';
    var verb = firefox ? '重新载入' : '重新加载';
    var d = document.createElement('div');
    d.id = 'bgBanner';
    d.className = 'bgbanner';
    d.innerHTML = '<b>扩展后台没有启动，按钮点不动就是这个原因</b>' +
      '<div class="bgfix"><span>' + (detail ? esc(detail) : '') +
      '到 ' + where + ' 点「' + verb + '」即可</span>' +
      '<button id="bgRetry">重试</button></div>';
    document.body.insertBefore(d, document.body.firstChild);
    d.querySelector('#bgRetry').onclick = function () { location.reload(); };
  }

  /* 打开弹窗先探一下后台在不在（1.5 秒够唤醒冷启动的 Service Worker） */
  async function checkBg() {
    var p = await bgSendOnce({ type: 'ping' }, 3000);
    if (p && !p.error) return true;
    showBgBanner('');
    return false;
  }

  async function initBoost() {
    var res = await bgSend('boost-state');
    paintBoost(res);
    // 缓存过期时后台正在重新探测，等一下再取一次，用户不用手动刷新
    if (res && res.checking) {
      setTimeout(async function () { paintBoost(await bgSend('boost-state')); }, 900);
      setTimeout(async function () { paintBoost(await bgSend('boost-state')); }, 2600);
    }
  }

  async function toggleBoost() {
    var sw = $('btnBoost');
    var tip = $('boostTip');
    var want = !boostOn;
    sw.disabled = true;
    tip.className = 'bt2';
    tip.textContent = want ? '正在探测可用镜像…' : '正在关闭…';
    var res = await bgSend('boost-set', { on: want });
    sw.disabled = false;
    if (res && res.error) {
      tip.className = 'bt2 bad';
      tip.textContent = res.error;
      if (typeof isBgDownError === 'function' && isBgDownError(res.error)) showBgBanner();
      return;
    }
    paintBoost(res);
    if (want) {
      // 当前标签就是 github.com 的话直接导过去，不用用户手动刷新
      await bgSend('boost-current');
    } else {
      initBoost();   // 关掉后补一次「x/y 个镜像可用」的统计
    }
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
    $('btnBoost').onclick = toggleBoost;
    // 先确认后台在不在：不在就直接挂提示，也不再去探测镜像白等
    checkBg().then(function (ok) { if (ok) initBoost(); });
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
    var onlyNew = $('btnOnlyNew');
    if (onlyNew) onlyNew.onclick = function () {
      st.onlyNew = !st.onlyNew;
      renderBody();
      renderFooter();
    };
    // 引流入口：新标签打开，不打断当前操作
    ['lnkPromo', 'lnkMore'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.onclick = function (e) {
        e.preventDefault();
        var u = id === 'lnkPromo' ? PROMO.url : PROMO.more;
        try { EXT.tabs.create({ url: u }); } catch (err) { window.open(u, '_blank'); }
      };
    });
    var pmTitle = $('promoTitle');
    if (pmTitle) { pmTitle.textContent = PROMO.short; }
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
    loadRouteList().then(renderRoute);   // 线路面板点开就有内容

    // 从当前标签页猜仓库
    try {
      var tabs = await EXT.tabs.query({ active: true, currentWindow: true });
      var url = tabs && tabs[0] && tabs[0].url;
      // 镜像页也能猜：先换成 github.com 上的原地址再解析（只对本插件认的镜像域做换算）
      var ghUrl = url ? originalUrlOf(url) : '';
      if (url) {
        try {
          if (!isMirrorHost(new URL(url).host, st.settings)) ghUrl = url;
        } catch (e) { ghUrl = url; }
      }
      if (ghUrl && /^https:\/\/github\.com\//.test(ghUrl)) {
        var m = ghUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
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
