/* 隐藏文档里的分片下载器
 *
 * 浏览器自带的下载是单连接，镜像一慢就没辙。这里把一个文件切成 N 段，
 * 用 Range 并发拉，最后拼成 Blob 交给后台用 downloads 保存。
 * 只处理「已知大小且不太大」的文件，大文件仍走单连接（拼装要占内存）。
 */
(function () {
  'use strict';

  var jobs = new Map();      // id -> {ctrl, parts, received, total, aborted, chunks}
  var MIN_CHUNK = 256 * 1024;
  var STALL_MS = 6000;       // 这么久没有新字节，就认为连接卡死，立刻换线重连

  function post(payload) {
    try {
      /* 不传回调：Chrome 与 Firefox 都会返回 Promise；传回调在 Firefox 里会被当成
       * 非法参数直接抛错（这也是后台版分片在 Firefox 上跑不起来的原因之一）。 */
      var p = chrome.runtime.sendMessage(Object.assign({ target: 'bg' }, payload));
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* 后台可能刚重启，忽略 */ }
  }

  function isHtml(res) {
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    return ct.indexOf('text/html') >= 0;
  }

  /* 问一下服务器文件多大，顺便确认支不支持 Range */
  async function probeSize(url, signal) {
    var res = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
      redirect: 'follow',
      signal: signal
    });
    if (isHtml(res)) {
      try { res.body && res.body.cancel(); } catch (e) {}
      throw new Error('镜像返回的是网页');
    }
    var cr = res.headers.get('content-range') || '';
    var m = cr.match(/\/(\d+)/);
    var total = m ? Number(m[1]) : 0;
    var ranged = res.status === 206;
    try { res.body && res.body.cancel(); } catch (e) {}
    if (!ranged) throw new Error('镜像不支持分段下载');
    if (!total) throw new Error('拿不到文件大小');
    return total;
  }

  function makeParts(total, threads, urlCount) {
    var n = Math.max(1, Math.min(8, threads || 4));
    // 每片至少 256KB，小文件自动降片数，避免切得稀碎
    while (n > 1 && total / n < MIN_CHUNK) n--;
    var step = Math.floor(total / n);
    var parts = [];
    for (var i = 0; i < n; i++) {
      var start = i * step;
      var end = i === n - 1 ? total - 1 : start + step - 1;
      // 全部片先压在同一条最快的线路上：实测同线路 4 连接 188KB/s，
      // 拆到 4 条线路只有 92KB/s（整体耗时被最慢那条拖住）。
      // 某片出错时 urlIdx 会自增，自动改用下一条线路。
      parts.push({
        idx: i, start: start, end: end, need: end - start + 1,
        got: 0, chunks: [], urlIdx: 0, fails: 0, rescues: 0,
        ctrl: null, lastT: Date.now(), lastGot: 0, lastRate: 0, bornAt: Date.now()
      });
    }
    return parts;
  }

  /* 每 4 秒比一次「哪片明显掉队」。
   * 单连接被限速时不会报错，就是慢慢爬，光看「有没有数据」发现不了；
   * 跟同伴比才知道它是在爬 —— 这时只把这一片的剩余区间换到下一条线路，
   * 其它片继续跑，已经下的字节不丢。桌面版就是靠这一招在限速后拉回速度的。 */
  function startTick(job) {
    stopTick(job);
    job.tick = setInterval(function () {
      if (job.aborted || job.paused || !job.parts || !job.parts.length) return;
      var now = Date.now();
      var maxRate = 0;
      job.parts.forEach(function (p) {
        /* 已经下完的片也是参照物：它证明「这条线刚才能跑多快」。
         * 不然只剩一片在爬时没有对比对象，救援永远不触发。 */
        if (p.got >= p.need) {
          if (!p.doneAt) p.doneAt = now;
          if (now - p.doneAt < 15000 && (p.lastRate || 0) > maxRate) maxRate = p.lastRate;
          return;
        }
        p.doneAt = 0;
        if (!p.lastT) { p.lastT = now; p.lastGot = p.got; return; }
        var dt = (now - p.lastT) / 1000;
        var d = p.got - (p.lastGot || 0);
        p.lastRate = dt > 0.8 ? d / dt : (p.lastRate || 0);
        p.lastGot = p.got;
        p.lastT = now;
        if (p.lastRate > maxRate) maxRate = p.lastRate;
      });
      // 整体就慢：交给后台换线路，这里别乱动
      if (maxRate < 40 * 1024) return;
      job.parts.forEach(function (p) {
        if (p.got >= p.need || !p.lastRate) return;
        if ((p.rescues || 0) >= 5) return;
        /* 既「比同伴慢一大截」又「绝对值也不快」才救：同伴 2MB/s、它 400KB/s 这种
         * 本来就够用，别为了追峰值来回重连。 */
        if (p.lastRate < maxRate * 0.3 && p.lastRate < 320 * 1024) {
          p.rescues = (p.rescues || 0) + 1;
          p.urlIdx++;
          p.stalled = false;
          p.lastT = Date.now();
          p.lastGot = p.got;
          if (p.ctrl) { try { p.ctrl.abort(); } catch (e) {} }
        }
      });
    }, 4000);
  }

  function stopTick(job) {
    if (job && job.tick) {
      clearInterval(job.tick);
      job.tick = 0;
    }
  }

  function reportSpeed(job) {
    var now = Date.now();
    if (!job.lastT) { job.lastT = now; job.lastB = job.received; return; }
    var dt = (now - job.lastT) / 1000;
    if (dt < 0.8) return;
    job.speed = Math.round(Math.max(0, job.received - job.lastB) / dt);
    job.lastT = now;
    job.lastB = job.received;
  }

  function flush(job) {
    reportSpeed(job);
    post({
      type: 'seg-progress',
      id: job.id,
      received: job.received,
      total: job.total,
      speed: job.speed || 0,
      paused: !!job.paused
    });
  }

  /* 用户点了暂停：所有在飞的连接已经被 abort，这里原地挂着等继续，
   * 已经下好的 chunks 一个字节都不丢（暂停 ≠ 重来）。 */
  function waitResume(job) {
    if (!job.paused) return Promise.resolve();
    return new Promise(function (resolve) { job.waiters.push(resolve); });
  }

  async function fetchPart(job, part) {
    var need = part.need || (part.end - part.start + 1);
    // 没下完就继续：被「提速」打断时按剩余范围重新要，已经下好的不丢
    while (part.got < need) {
      if (job.aborted) return;
      if (job.paused) { await waitResume(job); continue; }
      part.stalled = false;
      var once = new AbortController();
      part.ctrl = once;               // 让「掉队救援 / 整体换线」能精确掐断这一片
      var onAbort = function () { try { once.abort(); } catch (e) {} };
      job.aborts.push(onAbort);
      try {
        await fetchRange(job, part, part.start + part.got, part.end, once);
      } catch (e) {
        if (job.aborted) return;
        if (e && e.name === 'AbortError') {
          // 提速打断就原样接着要；如果是「半天没动静」被看门狗掐掉，就换条线路
          if (part.stalled) { part.stalled = false; part.urlIdx++; }
          continue;
        }
        // 这条线路不行了，换下一条镜像接着要剩下那段
        part.fails++;
        if (part.fails > job.urls.length * 2) throw e;
        part.urlIdx++;
        continue;
      } finally {
        part.ctrl = null;
        var i = job.aborts.indexOf(onAbort);
        if (i >= 0) job.aborts.splice(i, 1);
      }
    }
    /* 这一片下完了：记下它的平均速度，给「谁在拖后腿」当参照。
     * 没有这个，快的片早就下完、慢的片就成了唯一在飞的，救援永远比不出来。 */
    part.lastRate = part.got / Math.max(0.2, (Date.now() - (part.bornAt || Date.now())) / 1000);
  }

  /* 拉一段连续区间。带看门狗：镜像限速到 0 时连接会一直挂着不报错，
   * 超过 STALL_MS 没有新字节就主动掐断，由上层换线重连。 */
  async function fetchRange(job, part, start, end, ctrl) {
    var url = job.urls[part.urlIdx % job.urls.length];
    var lastByte = Date.now();
    var wd = setInterval(function () {
      if (Date.now() - lastByte > STALL_MS) {
        part.stalled = true;
        try { ctrl.abort(); } catch (e) {}
      }
    }, 4000);
    try {
      var res = await fetch(url, {
        headers: { Range: 'bytes=' + start + '-' + end },
        cache: 'no-store',
        redirect: 'follow',
        signal: ctrl.signal
      });
      if (res.status !== 206) {
        try { res.body && res.body.cancel(); } catch (e) {}
        throw new Error(res.status === 200 ? '镜像忽略了分段请求' : 'HTTP ' + res.status);
      }
      var ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('text/html') >= 0) {
        try { res.body && res.body.cancel(); } catch (e) {}
        throw new Error('镜像返回的是网页');
      }
      var reader = res.body.getReader();
      var lastFlush = 0;
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        if (job.aborted) {
          try { await reader.cancel(); } catch (e) {}
          return;
        }
        part.chunks.push(r.value);
        part.got += r.value.byteLength;
        job.received += r.value.byteLength;
        lastByte = Date.now();
        var now = lastByte;
        if (now - lastFlush > 400) { lastFlush = now; flush(job); }
      }
    } finally {
      clearInterval(wd);
    }
  }

  async function run(job) {
    try {
      var total = job.size || 0;
      if (!total) {
        /* 首选线路可能刚好挂了：挨个问一遍，别因为第一条拉不到大小就整个任务失败。
         * 探通的那条会挪到最前面，后面所有分片也优先用它。 */
        var lastErr = null;
        for (var i = 0; i < job.urls.length; i++) {
          try {
            total = await probeSize(job.urls[i], job.ctrl.signal);
            if (i > 0) { var good = job.urls.splice(i, 1)[0]; job.urls.unshift(good); }
            break;
          } catch (e) {
            lastErr = e;
            if (job.aborted) return;
          }
        }
        if (!total) throw lastErr || new Error('所有线路都拿不到文件大小');
      }
      if (job.aborted) return;
      job.total = total;
      var parts = makeParts(total, job.threads, job.urls.length);
      job.parts = parts;
      startTick(job);
      await Promise.all(parts.map(function (p) { return fetchPart(job, p); }));
      stopTick(job);
      if (job.aborted) return;
      var blobs = parts.map(function (p) { return new Blob(p.chunks); });
      // 必须带上 octet-stream：Blob 不带类型时 Chrome 会当成文本，存盘会多出 .txt 后缀
      var all = new Blob(blobs, { type: 'application/octet-stream' });
      if (all.size !== total) throw new Error('拼装后大小不对');
      var url = URL.createObjectURL(all);
      jobs.delete(job.id);
      post({ type: 'seg-done', id: job.id, url: url, total: total });
    } catch (e) {
      stopTick(job);
      if (job.aborted) return;
      jobs.delete(job.id);
      post({ type: 'seg-error', id: job.id, message: (e && e.message) || String(e) });
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.target !== 'offscreen') return false;
    if (msg.type === 'seg-start') {
      if (jobs.has(msg.id)) return false;
      var urls = (msg.urls && msg.urls.length) ? msg.urls.slice(0, 6) : [msg.url];
      var job = {
        id: msg.id, url: urls[0], urls: urls, size: msg.size || 0, threads: msg.threads || 4,
        ctrl: new AbortController(), received: 0, total: 0, speed: 0,
        lastT: 0, lastB: 0, aborted: false, aborts: [], parts: null, tick: 0,
        paused: false, waiters: []
      };
      jobs.set(msg.id, job);
      run(job);
    } else if (msg.type === 'seg-pause') {
      // 暂停：掐断在飞的连接，保留 parts/chunks，等 seg-resume 接着要剩余区间
      var pj = jobs.get(msg.id);
      if (pj && !pj.paused) {
        pj.paused = true;
        pj.aborts.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
        pj.speed = 0;
        pj.lastT = 0;
        post({
          type: 'seg-progress', id: pj.id, received: pj.received, total: pj.total,
          speed: 0, paused: true
        });
      }
    } else if (msg.type === 'seg-resume') {
      var rj = jobs.get(msg.id);
      if (rj && rj.paused) {
        rj.paused = false;
        rj.lastT = 0;
        rj.lastB = rj.received;
        var ws = rj.waiters;
        rj.waiters = [];
        ws.forEach(function (fn) { try { fn(); } catch (e) {} });
      }
    } else if (msg.type === 'seg-boost') {
      // 自动提速：把所有在飞的分片断掉，按剩余范围重新连（已下的部分保留）
      var bj = jobs.get(msg.id);
      if (bj) {
        bj.aborts.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
        bj.lastT = 0;   // 重新算速度，别拿旧基准
      }
    } else if (msg.type === 'seg-rotate') {
      /* 整体换线：把每一片的剩余区间挪到下一条线路。
       * 关键点是「不重来」—— chunks 一律保留，只换接下来要数据的那条线。
       * toUrl 指定就跳到那条，没指定就各自往后挪一条。 */
      var rj2 = jobs.get(msg.id);
      if (rj2 && !rj2.aborted) {
        var target = msg.toUrl ? rj2.urls.indexOf(msg.toUrl) : -1;
        (rj2.parts || []).forEach(function (p) {
          if (p.got >= p.need) return;
          if (target >= 0) p.urlIdx = target;
          else p.urlIdx = (p.urlIdx + 1) % rj2.urls.length;
          p.stalled = false;
          p.rescues = 0;
          p.lastT = Date.now();
          p.lastGot = p.got;
          if (p.ctrl) { try { p.ctrl.abort(); } catch (e) {} }
        });
        rj2.lastT = 0;
        rj2.lastB = rj2.received;
      }
    } else if (msg.type === 'seg-abort') {
      var j = jobs.get(msg.id);
      if (j) {
        j.aborted = true;
        stopTick(j);
        try { j.ctrl.abort(); } catch (e) {}
        var w = j.waiters;          // 暂停中又被取消：把等待中的分片叫醒，让它们自己退出
        j.waiters = [];
        w.forEach(function (fn) { try { fn(); } catch (e) {} });
        jobs.delete(msg.id);
      }
    } else if (msg.type === 'seg-revoke') {
      try { URL.revokeObjectURL(msg.url); } catch (e) {}
    }
    return false;
  });
})();
