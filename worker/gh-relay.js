/**
 * GitHub 加速中转 · Cloudflare Worker
 * ------------------------------------------------------------------
 * 一个 Worker 同时干三件事，扩展里只填一个地址就够了：
 *   网页   https://你的域名/https://github.com/owner/repo
 *   API    https://你的域名/https://api.github.com/repos/owner/repo/releases
 *   下载   https://你的域名/https://github.com/owner/repo/releases/download/v1/x.zip
 *
 * 部署（免费额度每天 10 万次请求，个人用绰绰有余）：
 *   1. 打开 https://dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. 把本文件全部内容粘贴进去，Deploy
 *   3. 把生成的地址（形如 https://xxx.yyy.workers.dev）填到扩展设置页的
 *      「GitHub 国内访问 → 自定义镜像」，扩展会按 prefix 型镜像来用它
 *
 * 重要：workers.dev 这个二级域名在国内并不稳定。要让它在墙内真正好用，
 * 请在 Worker 的 Settings → Domains & Routes 里绑定一个自己的域名
 * （域名可以托管在 Cloudflare，也可以在别处只加一条 CNAME）。
 * 有自己域名时，这是目前最稳、最可控的免梯子方案：没有人限你的流，
 * 也不会因为别人的公益镜像关站而失效。
 */

// 只允许中转这些域名，避免被当成公开代理白嫖
const ALLOW = new Set([
  'github.com',
  'www.github.com',
  'gist.github.com',
  'api.github.com',
  'codeload.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'github.githubassets.com',
  'collector.github.com'
]);

const USAGE = `GitHub 加速中转已就绪。

用法：在本域名后面接完整的目标地址，例如
  /https://github.com/owner/repo
  /https://api.github.com/repos/owner/repo/releases
  /https://raw.githubusercontent.com/owner/repo/main/README.md

把这个域名填进「GitHub Release 下载助手」设置页即可。`;

export default {
  async fetch(request) {
    const u = new URL(request.url);

    // 预检请求直接放行，省一次上游往返
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,HEAD,POST,OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-max-age': '86400'
        }
      });
    }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      return new Response(USAGE, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    // /https://github.com/xxx  ->  目标地址
    const m = u.pathname.match(/^\/(https?:\/\/[^/]+)(\/.*)?$/);
    if (!m) {
      return new Response('地址格式不对。应该是 /https://github.com/owner/repo\n\n' + USAGE,
        { status: 400, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    let target;
    try {
      target = new URL(m[1] + (m[2] || '/') + u.search);
    } catch (e) {
      return new Response('目标地址不合法', { status: 400 });
    }

    if (!ALLOW.has(target.hostname)) {
      return new Response('不允许中转这个域名：' + target.hostname, { status: 403 });
    }

    const h = new Headers(request.headers);
    // Cloudflare 自己的头和原 Host 必须去掉，否则上游会按错的域名回应
    ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'x-forwarded-proto', 'x-real-ip']
      .forEach(function (k) { h.delete(k); });
    h.set('host', target.hostname);

    const isBodyless = request.method === 'GET' || request.method === 'HEAD';
    let res;
    try {
      res = await fetch(target.toString(), {
        method: request.method,
        headers: h,
        redirect: 'manual',          // 自己处理跳转，才能把 github.com 换成本域名
        body: isBodyless ? undefined : request.body
      });
    } catch (e) {
      return new Response('上游连接失败：' + (e && e.message), { status: 502 });
    }

    const rh = new Headers(res.headers);

    // GitHub 的 CSP 会拦住从本域名加载的脚本和样式，页面会变成白板，必须摘掉
    rh.delete('content-security-policy');
    rh.delete('content-security-policy-report-only');
    rh.delete('strict-transport-security');
    rh.delete('alt-svc');
    // 镜像没有登录态，带着 GitHub 的 cookie 只会串味
    rh.delete('set-cookie');

    // Workers 会自动解压上游内容，这时原始长度就对不上了
    if (res.headers.get('content-encoding')) {
      rh.delete('content-encoding');
      rh.delete('content-length');
    }

    // 跳到 github.com / api.github.com 的地址，改写成 /https://... 形式，
    // 否则浏览器一跳就跳出了加速通道
    const loc = rh.get('location');
    if (loc) {
      try {
        const abs = new URL(loc, target);
        if (ALLOW.has(abs.hostname)) rh.set('location', '/' + abs.toString());
      } catch (e) { /* 保持原样 */ }
    }

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: rh
    });
  }
};
