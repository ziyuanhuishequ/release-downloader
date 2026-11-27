/* 镜像页提示（只在整站镜像域名上跑，github.com 原站不加载）
 * 做三件事：
 *   1. 打开时顶部飘一条「你正在通过国内镜像访问」，几秒后自动消失，不长期占位
 *   2. 镜像被限流（429）时给一个「换个镜像」的按钮，一键换到其它可用镜像
 *   3. 把页面里写死成 https://github.com/... 的链接改成本站路径，避免点一下就卡住
 * 不碰 GitHub 自己的 DOM 结构，样式全在 shadow DOM 里。
 */
(function () {
  'use strict';
  var host = location.host;
  if (/(^|\.)github\.com$/i.test(host)) return;   // 原站不需要
  if (window.__ghdlMirrorUi) return;
  window.__ghdlMirrorUi = true;

  var CSS = [
    ':host{all:initial}',
    /* 靠右下角、贴在下载面板上面：原来的顶部居中条会盖住 GitHub 自己的搜索框 */
    '.wrap{position:fixed;right:20px;bottom:88px;z-index:2147483600;display:flex;flex-direction:column;align-items:flex-end;gap:8px;pointer-events:none;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}',
    '.toast{display:flex;align-items:center;gap:8px;max-width:min(430px,86vw);background:#FFFDF6;border:3px solid #1A1E30;box-shadow:5px 5px 0 rgba(26,30,48,.85);padding:8px 10px;font-size:12.5px;color:#1A1E30;pointer-events:auto;transition:opacity .45s,transform .45s}',
    '.toast.off{opacity:0;transform:translateY(-10px);pointer-events:none}',
    '.dot{width:9px;height:9px;background:#2ED3A5;border:2px solid #1A1E30;flex:none}',
    '.tx{flex:1;line-height:1.35}',
    '.tx b{font-weight:800}',
    '.tx i{font-style:normal;color:#5B5F70}',
    '.btn{border:2px solid #1A1E30;background:#FFF3DC;color:#1A1E30;font-size:11.5px;font-weight:700;padding:2px 8px;cursor:pointer;white-space:nowrap}',
    '.btn:hover{background:#FFC94D}',
    '.btn.p{background:#FF6A3D;color:#fff}',
    '.btn.p:hover{background:#FF7E55}',
    '.card{max-width:min(430px,86vw);background:#FFFDF6;border:3px solid #1A1E30;box-shadow:6px 6px 0 rgba(26,30,48,.85);padding:12px 14px;pointer-events:auto;font-size:13px;color:#1A1E30}',
    '.card h4{font-size:13.5px;font-weight:800;margin-bottom:6px}',
    '.card p{font-size:12px;color:#5B5F70;line-height:1.5;margin-bottom:9px}',
    '.row{display:flex;gap:8px;flex-wrap:wrap}'
  ].join('');

  var wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483600;';
  var shadow = wrap.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>' + CSS + '</style><div class="wrap" id="slot"></div>';
  document.documentElement.appendChild(wrap);

  var slot = shadow.getElementById('slot');

  function siteBaseNow() {
    return location.protocol + '//' + location.host;
  }

  function goOriginal(keepBoost) {
    var target = originalUrlOf(location.href);
    if (keepBoost) {
      location.href = target;
      return;
    }
    bgSend('boost-set', { on: false }).then(function () { location.href = target; });
  }

  function switchSite() {
    bgSend('boost-probe').then(function (res) {
      var list = (res && res.list) || [];
      var now = siteBaseNow();
      var next = list.filter(function (x) { return x.ok && x.base !== now; })[0];
      if (!next) {
        alert('暂时没有别的可用镜像，已帮你切回 GitHub 原站。');
        goOriginal(false);
        return;
      }
      var target = mirrorUrlOf(next.base, originalUrlOf(location.href));
      bgSend('boost-site', { base: next.base }).then(function () {
        location.replace(target);
      });
    });
  }

  /* 1) 右下角飘一条提示，6 秒后自己消失。
   *    同一个镜像在本次浏览会话里只提示一次：镜像站是整页加载，每次都弹会很烦。 */
  var toast = null;
  var toastTimer = 0;
  function hideToast() {
    if (!toast) return;
    var t = toast;
    toast = null;
    t.classList.add('off');
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 500);
  }
  function showToast() {
    if (toast) return;
    toast = document.createElement('div');
    toast.className = 'toast';
    toast.innerHTML =
      '<span class="dot"></span>' +
      '<span class="tx">已通过国内镜像 <b>' + location.host + '</b> 打开 GitHub<i> · 下载文件会自动走加速线路，不经过镜像</i></span>' +
      '<button class="btn" data-act="back">切回原站</button>' +
      '<button class="btn" data-act="close">知道了</button>';
    slot.appendChild(toast);
    toast.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b) return;
      clearTimeout(toastTimer);
      if (b.getAttribute('data-act') === 'back') { goOriginal(false); return; }
      hideToast();
    });
    toastTimer = setTimeout(hideToast, 6000);
  }

  var TOAST_KEY = 'ghdlMirrorToast:' + location.host;
  var toastSeen = false;
  try { toastSeen = sessionStorage.getItem(TOAST_KEY) === '1'; } catch (e) {}
  if (!toastSeen) {
    showToast();
    try { sessionStorage.setItem(TOAST_KEY, '1'); } catch (e) {}
  }

  /* 2) 限流/异常页：给一个换镜像的出口 */
  function looksLimited() {
    var title = document.title || '';
    if (/^\s*429|too many requests|rate limit/i.test(title)) return true;
    var txt = ((document.body && document.body.innerText) || '').slice(0, 600);
    return /too many requests|rate limit exceeded|请求过于频繁|访问过于频繁/i.test(txt);
  }

  if (looksLimited() && document.body && document.body.innerText.trim().length < 1200) {
    hideToast();
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h4>这个镜像暂时被限流了</h4>' +
      '<p>镜像站被访问太频繁时会短暂拒绝（HTTP 429）。换一个镜像通常立刻就好，也可以先切回 GitHub 原站。</p>' +
      '<div class="row">' +
      '<button class="btn p" data-act="switch">换个镜像再试</button>' +
      '<button class="btn" data-act="back">切回原站</button>' +
      '<button class="btn" data-act="retry">刷新本页</button>' +
      '</div>';
    slot.appendChild(card);
    card.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-act]');
      if (!b) return;
      var act = b.getAttribute('data-act');
      if (act === 'switch') switchSite();
      else if (act === 'back') goOriginal(false);
      else location.reload();
    });
  }

  /* 3) 镜像页上点 Release 资源：一律交给扩展的加速通道
   *    镜像站下大文件通常只有一条连接、还常被限速，很慢；扩展这边是线路池 + 分片 + 换线。
   *    拦下来后由 content.js 直接把这个文件丢进下载队列（地址会先归一化回 github.com），
   *    用户不用再在面板里点一次「下载」。
   *    万一面板没接住（内容脚本还没注入/刚更新没重载），就退回原来的跳转，
   *    宁可慢一点，也不能让用户点了没反应。 */
  function takeDownload(e) {
    if (e.defaultPrevented) return;
    // 带修饰键的保留浏览器自己的行为（Ctrl+点击 = 新标签）
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href*="/releases/download/"]');
    if (!a || !a.href) return;
    window.__ghdlAck = 0;
    try {
      window.dispatchEvent(new CustomEvent('ghdl-open-panel', {
        detail: { href: a.href, auto: true }
      }));
    } catch (err) {}
    if (!window.__ghdlAck) return;       // 面板没接住 → 走原跳转
    e.preventDefault();
    e.stopPropagation();
    hideToast();
  }
  document.addEventListener('click', function (e) {
    if (e.button === 0) takeDownload(e);
  }, true);
  // 中键也算「我要下这个文件」，别让它开一个新标签慢慢下
  document.addEventListener('auxclick', function (e) {
    if (e.button === 1) takeDownload(e);
  }, true);

  /* 4) 页内链接改写
   * 两类镜像的链接形态不一样：
   *   裸路径型（at9）：地址就是 /owner/repo，相对链接天然能用，只需把写死成
   *                    https://github.com/xxx 的绝对链接改成 /xxx
   *   前缀型（cors.isteed）：地址是 /https://github.com/owner/repo，相对链接会被
   *                    解析成 /owner/repo（少了前缀），必须补成完整形式
   * 开关打开时浏览器本身也会把 github.com 重定向回镜像，但关闭瞬间 / 规则未生效时
   * 这一层能避免点到就卡在白屏。只改 a 和 form，不动脚本和 XHR。 */
  var PREFIX_MODE = /^\/https?:\/\//i.test(location.pathname);
  var ORIGIN = location.protocol + '//' + location.host;

  function ghOf(u) {
    if (!u) return '';
    if (/(^|\.)github\.com$/i.test(u.host)) return 'https://github.com' + u.pathname + u.search + u.hash;
    return '';
  }

  function mapHref(href) {
    if (!href || /^(#|mailto:|javascript:|data:|blob:)/i.test(href)) return null;
    var abs;
    try { abs = new URL(href, location.href); } catch (e) { return null; }
    var gh = ghOf(abs);
    if (!gh && PREFIX_MODE && abs.host === location.host) {
      // 前缀型页面上被解析坏的相对链接
      if (!/^\/(https?:\/\/)/i.test(abs.pathname)) {
        gh = 'https://github.com' + abs.pathname + abs.search + abs.hash;
      }
    }
    if (!gh) return null;
    // 登录/账号类页面镜像没有登录态，一律留在真 GitHub（DNR 的 allow 规则会放行）
    if (/^https:\/\/github\.com\/(login|logout|signup|join|session|settings|account|upload|new)(\/|\?|$)/.test(gh)) {
      return gh;
    }
    return PREFIX_MODE ? (ORIGIN + '/' + gh) : gh.replace(/^https:\/\/github\.com/, '');
  }

  function rewrite() {
    var links = document.querySelectorAll('a[href]');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var next = mapHref(a.getAttribute('href'));
      if (next && next !== a.getAttribute('href')) a.setAttribute('href', next);
    }
    var forms = document.querySelectorAll('form[action]');
    for (var j = 0; j < forms.length; j++) {
      var f = forms[j];
      var act = f.getAttribute('action') || '';
      var nextAct = mapHref(act);
      if (nextAct) f.setAttribute('action', nextAct);
    }
  }
  try { rewrite(); } catch (e) {}
  try {
    var mo = new MutationObserver(function () { try { rewrite(); } catch (e) {} });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { mo.disconnect(); }, 20000);
  } catch (e) {}
})();
