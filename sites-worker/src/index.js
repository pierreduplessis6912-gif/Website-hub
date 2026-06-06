// wh-sites — Client site serving worker
// Serves live client sites from KV by hostname.
// Wildcard: *.websitehub.co.za/* and custom domains via CF Custom Hostnames
// Zero platform logic. One job: read KV, serve HTML.

export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const hostname = url.hostname;
    const path     = url.pathname;

    // System subdomains — pass through to origin, don't serve from KV
    const SYSTEM_SUBDOMAINS = ['evolution', 'preview', 'www', 'mail', 'smtp', 'imap', 'ftp', 'cpanel', 'whm', 'webmail', 'admin', 'api', 'places-proxy'];
    const subdomain = hostname.split('.')[0];
    if (SYSTEM_SUBDOMAINS.includes(subdomain)) {
      return fetch(request);
    }

    // Health check
    if (path === '/health') {
      return new Response(JSON.stringify({ status: 'ok', worker: 'wh-sites', ts: new Date().toISOString() }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Try page-specific key first (for multi-page sites)
    // live:{hostname}:{page} e.g. live:eastcoast.websitehub.co.za:services
    const page = path.replace(/^\//, '').replace(/\/$/, '') || 'index';
    const pageKey = `live:${hostname}:${page}`;
    const rootKey = `live:${hostname}`;

    let html = await env.SITES.get(pageKey);
    if (!html) html = await env.SITES.get(rootKey);

    if (!html) {
      return new Response(notFoundHtml(hostname), {
        status: 404,
        headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' }
      });
    }

    return new Response(html, {
      headers: {
        'Content-Type':  'text/html;charset=UTF-8',
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
        'X-Served-By':   'wh-sites',
      }
    });
  }
};

function notFoundHtml(hostname) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Site not found</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#f0ede8;font-family:-apple-system,sans-serif;text-align:center;padding:40px}
h1{font-size:22px;font-weight:600;margin-bottom:8px}
p{font-size:14px;opacity:.5;margin-bottom:24px}
a{color:#00f0ff;text-decoration:none;font-size:13px}
</style>
</head>
<body>
<div>
<h1>Site not found</h1>
<p>This site hasn't launched yet or the address is incorrect.</p>
<a href="https://websitehub.co.za">← Website Hub</a>
</div>
</body>
</html>`;
}
