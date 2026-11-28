/* 隐藏文档里的分片下载器（多源并发版）
 *
 * 浏览器自带的下载是单连接，镜像一慢就没辙。这里把一个文件切成 N 片，
 * 同时向「多条镜像线路」并发要 Range：
 *   · 每条线路各有限速时，只有多线路并行才能把带宽叠起来；
 *   · 浏览器对同一个域名最多 6 条连接，所以每条线路最多占 4 条，剩下的配额给别的线；
 *   · 哪条线路/哪一片慢，就把它的「剩余区间」挪到更快的线路上，已经下好的字节一个不丢。
 *
 * 片级调度是这里的核心：所有片共用一个线路池，谁快谁多拿连接，
 * 慢线路会被自动抽走分片，不必等整个任务重来。
 */
(function () {
  'use strict';

  var jobs = new Map();

  var PART_MIN = 512 * 1024;      // 每片最小 512KB，太碎了握手开销占大头
  var PART_MAX = 20;              // 最多切几片
  var LANE_CONC = 4;              // 每条线路默认并发（Chrome 同域上限 6，留余量给别的请求）
  var LANE_MAX_CONC = 6;          // 每条线路并发上限
  var TICK_MS = 1500;             // 调度器节拍：越快发现掉队，越早把带宽抢回来
  var MOVE_AFTER_MS = 1800;       // 一片至少跑这么久才允许被迁走，避免来回抖
  var MOVE_MAX = 6;               // 单片最多迁移次数
  var STALL_MS = 6000;            // 这么久没有新字节 → 换线
  var LANE_DEAD_FAILS = 3;        // 同一线路连续失败几次就判死
  var LANE_DEAD_MS = 90000;       // 判死后冷却多久（线路池由后台轮换）
  var PART_OK_BPS = 320 * 1024;   // 单片的绝对速度门槛，够快就不折腾
  var STARVE_MS = 25000;          // 全线无空位且无进展，这么久就认输交给后台

  function post(payload) {
    var m = Object.assign({ target: 'bg' }, payload);
    try {
      /* Firefox：后台就在本页面里，sendMessage 派发不到自己，直接调入口 */
      if (typeof globalThis !== 'undefined' && typeof globalThis.__bgDispatch === 'function') {
        globalThis.__bgDispatch(m, {}, function () {});
        return;
      }
      /* 不传回调：Chrome 与 Firefox 都会返回 Promise；传回调在 Firefox 里会被当成
       * 非法参数直接抛错（这也是后台版分片在 Firefox 上跑不起来的原因之一）。 */
      var p = chrome.runtime.sendMessage(m);
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* 后台可能刚重启，忽略 */ }
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function isHtml(res) {
    var ct = (res.headers.get('content-type') || '').toLowerCase();
    return ct.indexOf('text/html') >= 0;
  }

  /* 线路既能是字符串（老格式），也能是 {url,name,prefix,bps}。
   * bps 是下载前测速得到的参考值，只用来决定「谁的连接配额多点」。 */
  function normLanes(msg) {
    var raw = msg.urls && msg.urls.length ? msg.urls : (msg.url ? [msg.url] : []);
    var out = [];
    var seen = {};
    for (var i = 0; i < raw.length; i++) {
      var x = raw[i];
      if (!x) continue;
      var o = (typeof x === 'string')
        ? { url: x, name: '', prefix: undefined, hint: 0 }
        : { url: x.url, name: x.name || '', prefix: x.prefix, hint: x.bps || 0 };
      if (!o.url || seen[o.url]) continue;
      seen[o.url] = 1;
      out.push(o);
    }
    return out;
  }

  function newLane(o, i, conc) {
    return {
      i: i, url: o.url, name: o.name, prefix: o.prefix, hint: o.hint || 0,
      active: 0, max: conc, fails: 0, deadUntil: 0, bps: 0, movesOut: 0
    };
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

  /* 片数：每片约 1MB 起步，但不超过「线路数 × 每线并发」，多出来的片只会排队。
   * 片多一点对尾巴更友好：最后剩几 MB 时不会被一片 30MB 的大块拖住。 */
  function partCount(total, lanes, conc) {
    var cap = Math.min(PART_MAX, Math.max(4, lanes * conc));
    var want = Math.ceil(total / (1024 * 1024));
    var n = Math.max(1, Math.min(cap, want));
    while (n > 1 && total / n < PART_MIN) n--;
    return n;
  }

  function makeParts(total, n) {
    var step = Math.floor(total / n);
    var parts = [];
    for (var i = 0; i < n; i++) {
      var start = i * step;
      var end = i === n - 1 ? total - 1 : start + step - 1;
      parts.push({
        i: i, start: start, end: end, need: end - start + 1,
        got: 0, chunks: [],
        curLane: null, lane: -1, wantLane: -1, avoidLane: -1,
        moves: 0, fails: 0, ctrl: null,
        startedAt: 0, lastByteAt: 0, lastT: 0, lastGot: 0, bps: 0, bornAt: Date.now()
      });
    }
    return parts;
  }

  /* ---------------- 线路池调度 ---------------- */

  function laneAlive(lane) {
    return !!lane && lane.deadUntil <= Date.now();
  }

  /* 选线路：优先「指定的」→ 原来的 → 空闲里最快的 → 实在都满就等一会儿。
   * 初始时所有线路速度都是 0，这里退化成「谁空选谁」，天然把分片摊到各条线上，
   * 不会像老版本那样全压在最前面那条（所以不会再出现「只有 gh-proxy.com 在跑」）。 */
  function pickLane(job, part) {
    var lanes = job.lanes;
    if (part.wantLane >= 0) {
      var w = lanes[part.wantLane];
      if (laneAlive(w) && w.active < w.max) return w;
    }
    var cur = part.curLane;
    if (cur && laneAlive(cur) && cur.active < cur.max) return cur;
    var best = null;
    for (var i = 0; i < lanes.length; i++) {
      var l = lanes[i];
      if (!laneAlive(l) || l.active >= l.max) continue;
      if (part.avoidLane === l.i && lanes.length > 1) continue;
      if (!best) { best = l; continue; }
      var d = (l.bps || 0) - (best.bps || 0);
      if (d > 8192) best = l;
      else if (d > -8192 && l.active < best.active) best = l;
    }
    if (best) return best;
    /* 空位都被 avoid 挡住了（比如唯一的另一条线刚失败）→ 放宽，别把任务卡死 */
    for (var j = 0; j < lanes.length; j++) {
      var l2 = lanes[j];
      if (!laneAlive(l2) || l2.active >= l2.max) continue;
      if (!best || (l2.bps || 0) > (best.bps || 0)) best = l2;
    }
    return best;
  }

  /* 把一片的剩余区间挪到别的线路。abort 之后 fetchPart 会按新线路从断点续，
   * 之前 push 进 chunks 的字节原样保留。 */
  function movePart(job, part, laneIdx) {
    if (!part.ctrl || part.got >= part.need) return false;
    if ((part.moves || 0) >= MOVE_MAX) return false;
    part.moves++;
    /* 从哪条线上抽走的，给它记一笔：一条线被抽三次还慢，就只给它一个连接位置。
     * 不然它空出来的位置马上又被派一片，派一片又被抽走，白白折腾。 */
    if (part.curLane && part.curLane.i !== laneIdx) {
      part.curLane.movesOut = (part.curLane.movesOut || 0) + 1;
      if (part.curLane.movesOut >= 3 && part.curLane.max > 1) part.curLane.max = 1;
    }
    if (laneIdx >= 0) part.wantLane = laneIdx;
    else if (part.curLane) part.avoidLane = part.curLane.i;
    part.lastByteAt = Date.now();       // 别让看门狗下个节拍又掐一次
    part.startedAt = Date.now();        // 迁移后重新计冷却，防止来回抖
    try { part.ctrl.abort(); } catch (e) {}
    return true;
  }

  function slowestPartOn(job, lane, exclude) {
    var v = null;
    for (var i = 0; i < job.parts.length; i++) {
      var p = job.parts[i];
      if (p === exclude) continue;
      if (p.curLane !== lane || p.got >= p.need || !p.ctrl) continue;
      if (!v || (p.bps || 0) < (v.bps || 0)) v = p;
    }
    return v;
  }

  /* 线路评分：优先用「当下正在跑的分片速率之和」，
   * 这条线上没有在飞的分片时，退回「最近在这里下完的分片速度」。
   * 少了后半段会出大问题：快的片 0.5 秒就下完了，之后全线只剩慢片在爬，
   * 没有参照就会把最慢的那条当成基准，于是永远不触发换线（实测卡到 28 秒）。 */
  function laneScore(job, lane) {
    if (lane.active > 0 && (lane.bps || 0) > 0) return lane.bps;
    var best = 0;
    for (var i = 0; i < job.parts.length; i++) {
      var p = job.parts[i];
      if (p.lane !== lane.i || !p.doneAt) continue;
      if (Date.now() - p.doneAt > 20000) continue;
      if ((p.doneBps || 0) > best) best = p.doneBps;
    }
    return best;
  }

  /* 每 2.5 秒重排一次：
   *   A. 单片掉队（比最快的参照慢一大截，且绝对值也不快）→ 单片迁到最快线路；
   *   B. 整条线路掉队（吞吐只有最快线路的 30%）→ 抽走它的一片交给最快线路。
   * 两道闸门都要求「已经跑够 MOVE_AFTER_MS」，避免刚连上还没热就误判。 */
  function rebalance(job) {
    var now = Date.now();
    var lanes = [];
    for (var i = 0; i < job.lanes.length; i++) if (laneAlive(job.lanes[i])) lanes.push(job.lanes[i]);
    if (lanes.length < 2) return;

    var topLane = lanes[0], topScore = 0;
    for (var a = 0; a < lanes.length; a++) {
      var s = laneScore(job, lanes[a]);
      if (s > topScore) { topScore = s; topLane = lanes[a]; }
    }
    if (!topScore) return;

    /* A. 单片掉队 */
    if (topScore >= 96 * 1024) {
      for (var c = 0; c < job.parts.length; c++) {
        var p = job.parts[c];
        if (p.got >= p.need || !p.ctrl) continue;
        if (now - (p.startedAt || 0) < MOVE_AFTER_MS) continue;
        if (!p.bps) continue;
        if (p.bps > PART_OK_BPS) continue;
        if (p.bps > topScore * 0.3) continue;
        var tgt = (topLane.i !== p.lane) ? topLane : null;
        if (!tgt) {
          for (var d2 = 0; d2 < lanes.length; d2++) {
            if (lanes[d2].i === p.lane) continue;
            if (!tgt || laneScore(job, lanes[d2]) > laneScore(job, tgt)) tgt = lanes[d2];
          }
        }
        if (!tgt || tgt.i === p.lane) continue;
        movePart(job, p, tgt.i);
      }
    }

    /* B. 整条线路掉队：把它的分片逐个让给更快的线路（每次节拍最多抽一片）。
     * 只抽「有在飞分片」的线路 —— 空闲线路已经在排队等活，不用管。 */
    if (topScore >= 128 * 1024) {
      for (var e = 0; e < lanes.length; e++) {
        var l = lanes[e];
        if (l.i === topLane.i || l.active <= 0) continue;
        if (laneScore(job, l) >= topScore * 0.3) continue;
        if (topLane.active >= topLane.max) break;
        var v = slowestPartOn(job, l, null);
        if (!v || now - (v.startedAt || 0) < MOVE_AFTER_MS) continue;
        movePart(job, v, topLane.i);
        break;
      }
    }
  }

  function startTick(job) {
    stopTick(job);
    job.tick = setInterval(function () {
      if (job.aborted || job.paused || !job.parts) return;
      var now = Date.now();
      /* 算每片的瞬时速率；线路速率 = 它上面所有片之和，用来判断「这条线值不值多给连接」 */
      for (var i = 0; i < job.parts.length; i++) {
        var p = job.parts[i];
        if (!p.lastT) { p.lastT = p.startedAt || job.startedAt || now; p.lastGot = 0; }
        var dt = (now - p.lastT) / 1000;
        if (dt < 0.9) continue;
        p.bps = Math.max(0, (p.got - (p.lastGot || 0)) / dt);
        p.lastGot = p.got;
        p.lastT = now;
      }
      for (var m = 0; m < job.lanes.length; m++) job.lanes[m].bps = 0;
      for (var k = 0; k < job.parts.length; k++) {
        var q = job.parts[k];
        if (q.curLane && q.got < q.need) q.curLane.bps += q.bps || 0;
      }
      /* 全线都慢（总吞吐不到 200KB/s）时，把每线连接数一路顶到浏览器上限 6。
       * 镜像按「每条连接」限速时，这是唯一还能榨的余量；一旦跑起来就不再往上加，
       * 免得正常线路被多余的排队连接拖累。 */
      if (job.perLane < LANE_MAX_CONC && (job.speed || 0) > 0 && job.speed < 200 * 1024) {
        job.slowTicks = (job.slowTicks || 0) + 1;
        if (job.slowTicks >= 4) {
          job.perLane++;
          job.slowTicks = 0;
          for (var v = 0; v < job.lanes.length; v++) {
            if (job.lanes[v].max < job.perLane) job.lanes[v].max = job.perLane;
          }
        }
      } else {
        job.slowTicks = 0;
      }
      rebalance(job);
    }, TICK_MS);
  }

  function stopTick(job) {
    if (job && job.tick) {
      clearInterval(job.tick);
      job.tick = 0;
    }
  }

  /* 卡死看门狗：镜像限速到 0 时连接会一直挂着不报错，速度事件本身也就没了。
   * 这里直接看「多久没有新字节」，比看速度可靠。 */
  var watchdog = setInterval(function () {
    var now = Date.now();
    jobs.forEach(function (job) {
      if (job.aborted || job.paused || !job.parts) return;
      for (var i = 0; i < job.parts.length; i++) {
        var p = job.parts[i];
        if (!p.ctrl || p.got >= p.need) continue;
        if (now - (p.lastByteAt || job.startedAt || now) < STALL_MS) continue;
        movePart(job, p, -1);
      }
    });
  }, 2000);

  function reportSpeed(job) {
    var now = Date.now();
    if (!job.lastT) { job.lastT = now; job.lastB = job.received; return; }
    var dt = (now - job.lastT) / 1000;
    if (dt < 0.8) return;
    job.speed = Math.round(Math.max(0, job.received - job.lastB) / dt);
    job.lastT = now;
    job.lastB = job.received;
  }

  function laneInfo(job) {
    var out = [];
    for (var i = 0; i < job.lanes.length; i++) {
      var l = job.lanes[i];
      out.push({
        n: l.name || l.url,
        p: l.prefix,
        bps: Math.round(l.bps || 0),
        on: l.active,
        dead: l.deadUntil > Date.now()
      });
    }
    return out;
  }

  function flush(job) {
    reportSpeed(job);
    post({
      type: 'seg-progress',
      id: job.id,
      received: job.received,
      total: job.total,
      speed: job.speed || 0,
      paused: !!job.paused,
      lanes: laneInfo(job)
    });
  }

  /* 用户点了暂停：所有在飞的连接已经被 abort，这里原地挂着等继续，
   * 已经下好的 chunks 一个字节都不丢（暂停 ≠ 重来）。 */
  function waitResume(job) {
    if (!job.paused) return Promise.resolve();
    return new Promise(function (resolve) { job.waiters.push(resolve); });
  }

  async function fetchPart(job, part) {
    var need = part.need;
    while (part.got < need) {
      if (job.aborted) return;
      if (job.paused) { await waitResume(job); continue; }
      var lane = pickLane(job, part);
      if (!lane) {
        /* 所有线路都满了（或都在冷却）。全死光且没有在飞的连接就别干等了，
         * 直接报错，让后台退回单连接/换池子。 */
        var alive = 0, flying = 0;
        for (var i = 0; i < job.lanes.length; i++) {
          if (laneAlive(job.lanes[i])) alive++;
          if (job.lanes[i].active > 0) flying++;
        }
        if (!alive && !flying) throw new Error('所有线路都用不了');
        if (!job.starveAt) job.starveAt = Date.now();
        if (Date.now() - job.starveAt > STARVE_MS) throw new Error('线路一直排不上队');
        await sleep(60);
        continue;
      }
      job.starveAt = 0;

      lane.active++;
      part.curLane = lane;
      part.lane = lane.i;
      part.wantLane = -1;
      part.avoidLane = -1;
      part.lastByteAt = Date.now();
      if (!part.startedAt) part.startedAt = Date.now();
      var once = new AbortController();
      part.ctrl = once;
      var onAbort = function () { try { once.abort(); } catch (e) {} };
      job.aborts.push(onAbort);
      try {
        await fetchRange(job, part, part.start + part.got, part.end, once, lane);
        lane.fails = 0;
      } catch (e) {
        if (job.aborted) return;
        if (!e || e.name !== 'AbortError') {
          // 这条线路真的出错了（网页/404/连接重置）：记一笔，换下一条接着要
          lane.fails++;
          if (lane.fails >= LANE_DEAD_FAILS) lane.deadUntil = Date.now() + LANE_DEAD_MS;
          part.fails++;
          part.avoidLane = lane.i;
          if (part.fails > job.lanes.length * 4) throw e;
          part.lastByteAt = Date.now();
        }
      } finally {
        lane.active = Math.max(0, lane.active - 1);
        part.curLane = null;
        part.ctrl = null;
        var idx = job.aborts.indexOf(onAbort);
        if (idx >= 0) job.aborts.splice(idx, 1);
      }
    }
    /* 这一片下完了：记下它跑出多少速度，给「谁在拖后腿」当参照。
     * 没有这个，快的片早下完了、慢的片就成了唯一还在跑的，调度器没有对比对象，
     * 会把最慢的那条线路当成基准，于是永远不换线（实测能卡到 28 秒）。 */
    part.bps = 0;
    part.curLane = null;
    part.doneAt = Date.now();
    part.doneBps = part.got / Math.max(0.15, (part.doneAt - (part.bornAt || part.doneAt)) / 1000);
  }

  /* 拉一段连续区间 */
  async function fetchRange(job, part, start, end, ctrl, lane) {
    var res = await fetch(lane.url, {
      headers: { Range: 'bytes=' + start + '-' + end },
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl.signal
    });
    if (res.status !== 206) {
      try { res.body && res.body.cancel(); } catch (e) {}
      throw new Error(res.status === 200 ? '镜像忽略了分段请求' : 'HTTP ' + res.status);
    }
    if (isHtml(res)) {
      try { res.body && res.body.cancel(); } catch (e) {}
      throw new Error('镜像返回的是网页');
    }
    var reader = res.body.getReader();
    var lastFlush = 0;
    try {
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
        part.lastByteAt = Date.now();
        var now = part.lastByteAt;
        if (now - lastFlush > 400) { lastFlush = now; flush(job); }
      }
    } finally {
      try { reader.releaseLock && reader.releaseLock(); } catch (e) {}
    }
  }

  /* 初始分配：按下载前的测速值，优先把分片摊给快的线路，但每条线至少分到一片
   * （「快」得实测出来，不能凭空相信测速）。有测速就不该把两片塞给最慢的那条 ——
   * 等调度器发现再挪走要白等一两个节拍。没测速时退化成轮询，一样是打散的。 */
  function assignInitial(job) {
    var order = job.lanes.map(function (l) { return l.i; });
    var hasHint = false;
    for (var i = 0; i < job.lanes.length; i++) if ((job.lanes[i].hint || 0) > 0) hasHint = true;
    if (hasHint) {
      order.sort(function (a, b) { return (job.lanes[b].hint || 0) - (job.lanes[a].hint || 0); });
    }
    for (var k = 0; k < job.parts.length; k++) {
      job.parts[k].wantLane = order[k % order.length];
    }
  }

  async function run(job) {
    try {
      var total = job.size || 0;
      if (!total) {
        /* 首选线路可能刚好挂了：挨个问一遍，别因为第一条拉不到大小就整个任务失败。
         * 探通的那条提到最前面，后面的分片也优先用它。 */
        var lastErr = null;
        for (var i = 0; i < job.lanes.length; i++) {
          try {
            total = await probeSize(job.lanes[i].url, job.ctrl.signal);
            if (i > 0) {
              var good = job.lanes.splice(i, 1)[0];
              job.lanes.unshift(good);
              for (var j = 0; j < job.lanes.length; j++) job.lanes[j].i = j;
            }
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
      var n = partCount(total, job.lanes.length, job.perLane);
      job.parts = makeParts(total, n);
      job.startedAt = Date.now();
      assignInitial(job);
      startTick(job);
      await Promise.all(job.parts.map(function (p) { return fetchPart(job, p); }));
      stopTick(job);
      if (job.aborted) return;
      var blobs = job.parts.map(function (p) { return new Blob(p.chunks); });
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

  function startJob(msg) {
    var raw = normLanes(msg);
    if (!raw.length) return;
    var perLane = Math.max(2, Math.min(LANE_MAX_CONC, msg.threads || LANE_CONC));
    var job = {
      id: msg.id, size: msg.size || 0, perLane: perLane,
      lanes: raw.map(function (o, i) { return newLane(o, i, perLane); }),
      ctrl: new AbortController(), received: 0, total: 0, speed: 0,
      lastT: 0, lastB: 0, aborted: false, aborts: [], parts: null, tick: 0,
      paused: false, waiters: [], startedAt: 0, starveAt: 0
    };
    jobs.set(msg.id, job);
    run(job);
  }

  /* 重建线路池（后台发现池子外有更快的线，或当前几条都不行）：
   * 保留所有已下字节，只把「接下来去哪条线要数据」整体换掉。 */
  function rebuildLanes(msg) {
    var job = jobs.get(msg.id);
    if (!job || job.aborted) return;
    var raw = normLanes(msg);
    if (!raw.length) return;
    var perLane = Math.max(2, Math.min(LANE_MAX_CONC, msg.threads || job.perLane || LANE_CONC));
    job.perLane = perLane;
    job.aborts.slice().forEach(function (fn) { try { fn(); } catch (e) {} });
    job.lanes = raw.map(function (o, i) { return newLane(o, i, perLane); });
    for (var i = 0; i < (job.parts || []).length; i++) {
      var p = job.parts[i];
      p.curLane = null;
      p.lane = -1;
      p.wantLane = -1;
      p.avoidLane = -1;
      p.startedAt = 0;      // 新池子重新热身，别拿旧线路的迁移次数卡死
      p.moves = 0;
      if (p.ctrl) { try { p.ctrl.abort(); } catch (e) {} }
    }
    job.lastT = 0;
    job.lastB = job.received;
    job.starveAt = 0;
  }

  function handleMsg(msg) {
    if (!msg) return false;
    if (msg.type === 'seg-start') {
      if (jobs.has(msg.id)) return false;
      startJob(msg);
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
          speed: 0, paused: true, lanes: laneInfo(pj)
        });
      }
    } else if (msg.type === 'seg-resume') {
      var rj = jobs.get(msg.id);
      if (rj && rj.paused) {
        rj.paused = false;
        rj.lastT = 0;
        rj.lastB = rj.received;
        rj.starveAt = 0;
        var ws = rj.waiters;
        rj.waiters = [];
        ws.forEach(function (fn) { try { fn(); } catch (e) {} });
      }
    } else if (msg.type === 'seg-boost') {
      // 自动提速：把慢掉的分片挪到别的线路去（已有字节全部保留）
      var bj = jobs.get(msg.id);
      if (bj) {
        for (var i = 0; i < (bj.parts || []).length; i++) {
          var bp = bj.parts[i];
          if (bp.got >= bp.need || !bp.ctrl) continue;
          if (bp.bps && bp.bps < PART_OK_BPS) movePart(bj, bp, -1);
        }
        bj.lastT = 0;
      }
    } else if (msg.type === 'seg-rotate') {
      /* 兼容老消息：指定某条线路，让所有片改走它。
       * 新版本后台更常用 seg-rebuild（换整池子），这条只在手动「换线路」时兜底。 */
      var rj2 = jobs.get(msg.id);
      if (rj2 && !rj2.aborted && msg.toUrl) {
        var ti = -1;
        for (var k = 0; k < rj2.lanes.length; k++) if (rj2.lanes[k].url === msg.toUrl) ti = k;
        if (ti < 0) {
          rj2.lanes.push(newLane({ url: msg.toUrl, name: '', prefix: undefined, hint: 0 },
            rj2.lanes.length, rj2.perLane));
          ti = rj2.lanes.length - 1;
        }
        for (var m = 0; m < (rj2.parts || []).length; m++) {
          var p2 = rj2.parts[m];
          if (p2.got >= p2.need) continue;
          p2.moves = 0;
          p2.startedAt = 0;
          movePart(rj2, p2, ti);
        }
        rj2.lastT = 0;
        rj2.lastB = rj2.received;
      }
    } else if (msg.type === 'seg-rebuild') {
      rebuildLanes(msg);
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
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
    if (!msg || msg.target !== 'offscreen') return false;
    return handleMsg(msg);
  });

  /* Firefox 的 off.js 与 bg.js 跑在同一个后台页面里，runtime.sendMessage 不会派发给
   * 自己所在的页面 —— 绕消息通道的话分片在 Firefox 上永远启动不了。
   * 所以把入口挂出去，后台发现是同一页面就直接调用。 */
  try { globalThis.__segDispatch = handleMsg; } catch (e) {}
})();
