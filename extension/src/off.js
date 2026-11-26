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
  var STALL_MS = 20000;      // 这么久没有新字节，就认为连接卡死

  function post(payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ target: 'bg' }, payload), function () {
        void chrome.runtime.lastError;
      });
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
      parts.push({ start: start, end: end, got: 0, chunks: [], urlIdx: 0, fails: 0 });
    }
    return parts;
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
      speed: job.speed || 0
    });
  }

  async function fetchPart(job, part) {
    var need = part.end - part.start + 1;
    // 没下完就继续：被「提速」打断时按剩余范围重新要，已经下好的不丢
    while (part.got < need) {
      if (job.aborted) return;
      part.stalled = false;
      var once = new AbortController();
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
        var i = job.aborts.indexOf(onAbort);
        if (i >= 0) job.aborts.splice(i, 1);
      }
    }
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
      var total = job.size || await probeSize(job.urls[0], job.ctrl.signal);
      if (job.aborted) return;
      job.total = total;
      var parts = makeParts(total, job.threads, job.urls.length);
      job.parts = parts;
      await Promise.all(parts.map(function (p) { return fetchPart(job, p); }));
      if (job.aborted) return;
      var blobs = parts.map(function (p) { return new Blob(p.chunks); });
      // 必须带上 octet-stream：Blob 不带类型时 Chrome 会当成文本，存盘会多出 .txt 后缀
      var all = new Blob(blobs, { type: 'application/octet-stream' });
      if (all.size !== total) throw new Error('拼装后大小不对');
      var url = URL.createObjectURL(all);
      jobs.delete(job.id);
      post({ type: 'seg-done', id: job.id, url: url, total: total });
    } catch (e) {
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
        lastT: 0, lastB: 0, aborted: false, aborts: []
      };
      jobs.set(msg.id, job);
      run(job);
    } else if (msg.type === 'seg-boost') {
      // 自动提速：把所有在飞的分片断掉，按剩余范围重新连（已下的部分保留）
      var bj = jobs.get(msg.id);
      if (bj) {
        bj.aborts.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
        bj.lastT = 0;   // 重新算速度，别拿旧基准
      }
    } else if (msg.type === 'seg-abort') {
      var j = jobs.get(msg.id);
      if (j) {
        j.aborted = true;
        try { j.ctrl.abort(); } catch (e) {}
        jobs.delete(msg.id);
      }
    } else if (msg.type === 'seg-revoke') {
      try { URL.revokeObjectURL(msg.url); } catch (e) {}
    }
    return false;
  });
})();
