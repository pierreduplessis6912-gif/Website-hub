// ============================================================
// ADD TO build-worker.js
// ============================================================
//
// 1. In the fetch() route handler, add:
//
//    if (path === '/start') return handleStart(request, url, env);
//
// 2. Add this function to build-worker.js:
// ============================================================

async function handleStart(request, url, env) {
  let html = await env.SITES.get('app:intake-experience');
  if (!html) {
    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px;background:#0a0a0a;color:#f0ede8">
      <h2>Intake form not yet loaded</h2>
      <p style="color:#666;margin-top:12px">Run /bootstrap-intake to load it.</p>
    </body></html>`, 503);
  }

  // Replace Turnstile site key
  const siteKey = env.TURNSTILE_SITE_KEY || '';
  html = html.replace('__TURNSTILE_SITE_KEY__', siteKey);

  // Mode 2 — prospect upgrade
  const clientId = url.searchParams.get('id');
  let intakeDataJson = 'null';

  if (clientId) {
    try {
      const client = await getClientById(env, clientId);
      if (client) {
        const slug        = client.slug || slugify(client.business_name);
        const previewHtml = await env.SITES.get(`preview:${slug}`).catch(() => null);

        intakeDataJson = JSON.stringify({
          clientId:      client.id,
          business_name: client.business_name,
          client_name:   client.client_name,
          phone:         client.phone,
          industry:      client.industry,
          area:          client.area,
          vibe:          client.vibe,
          previewHtml:   previewHtml || null,
        });
      }
    } catch (e) {
      console.warn('Mode 2 client lookup failed:', e?.message || e);
    }
  }

  html = html.replace('__INTAKE_DATA_JSON__', intakeDataJson);
  return htmlResponse(html, 200);
}

// ============================================================
// Also add to build-worker.js — bootstrap route:
//
//   if (path === '/bootstrap-intake') return handleBootstrapIntake(request, env);
// ============================================================

async function handleBootstrapIntake(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  const html = await request.text();
  if (!html || !html.includes('<!DOCTYPE')) return jsonResponse({ error: 'Invalid HTML' }, 400);

  await env.SITES.put('app:intake-experience', html);
  return jsonResponse({ success: true, size: html.length });
}
