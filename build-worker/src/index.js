// ============================================================
// WH-BUILD — Website Hub Build Worker
// Clean rewrite — Session D10 2026-05-27
// ============================================================
// Bindings (wrangler.toml):
//   DB           — D1 database (all client data, 12 tables)
//   SITES        — KV (HTML blobs, PWA, config)
//   ASSETS       — R2 (photos, logos, gallery)
//   BUILD_QUEUE  — Queue (pre-build + substance build jobs)
// Secrets (GH Actions):
//   ANTHROPIC_KEY, UNSPLASH_ACCESS_KEY, WH_PHONE,
//   CLOUDFLARE_API_TOKEN, ADMIN_KEY, RESEND_API_KEY
// Route: preview.websitehub.co.za/*
// ============================================================

import { callClaudeInternal, sendWhatsApp, isTestMode, normaliseSaPhone, PRICING, PACKAGE_CAPS } from './shared-services.js';
import { getDesignBrief, buildCssVariables, UX_RULES } from '../../design-db.js';

// ── CONSTANTS ─────────────────────────────────────────────────

const PREVIEW_DOMAIN   = 'preview.websitehub.co.za';
const FALLBACK_HERO    = 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&q=80';
const PREVIEW_TTL      = 60 * 60 * 24 * 35; // 35 days
const CONFIG_CACHE_TTL = 300;               // 5 min browser cache

const PASS_TOKENS = {
  pre_1: 1200, pre_2: 1500, pre_3: 800,
  sub_1: 2000, sub_3: 1500,
};

// Structural CSS — fixed for all sites. Design tokens come from buildCssVariables.
const STRUCTURAL_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--bg);color:var(--fg);overflow-x:hidden}
.nav{position:fixed;top:0;left:0;right:0;height:52px;background:rgba(10,10,10,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:space-between;padding:0 20px;z-index:50;border-bottom:1px solid var(--border)}
.nav-brand{font-family:var(--font-heading);font-size:15px;font-weight:700;color:var(--fg);text-decoration:none}
.nav-links{display:flex;gap:20px}
.nav-link{font-size:13px;color:var(--muted-fg);text-decoration:none}
.section-hero{min-height:100svh;background-size:cover;background-position:center;background-attachment:scroll;display:flex;flex-direction:column;justify-content:flex-end;padding:52px 0 48px;position:relative}
.section-hero::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0.25) 0%,rgba(0,0,0,0.80) 100%)}
.hero-content{position:relative;z-index:1;padding:0 24px}
.hero-h1{font-family:var(--font-heading);font-size:clamp(32px,9vw,56px);font-weight:800;line-height:1.1;letter-spacing:-0.02em;color:#fff;margin-bottom:12px}
.hero-sub{font-size:16px;color:rgba(255,255,255,0.8);margin-bottom:8px;line-height:1.5}
.trust-line{font-size:13px;color:rgba(255,255,255,0.55);margin-bottom:24px;letter-spacing:0.5px}
.section{background:var(--bg);padding:72px 24px;border-top:1px solid var(--border)}
.section.surface{background:var(--surface)}
.section-bleed{background:var(--surface);border-radius:24px 24px 0 0;margin-top:-32px;position:relative;z-index:2;padding:56px 24px 72px}
.label{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--label-color);margin-bottom:14px;display:block}
.section-h2{font-family:var(--font-heading);font-size:clamp(24px,6vw,40px);font-weight:800;line-height:1.15;margin-bottom:20px}
.pull-quote{font-family:var(--font-heading);font-size:clamp(18px,5vw,26px);font-style:italic;line-height:1.4;color:var(--fg);margin-bottom:24px;padding-left:16px;border-left:3px solid var(--accent)}
.body-text{font-size:15px;line-height:1.7;color:var(--muted-fg);margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:28px 24px}
.services-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:28px}
.service-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px 20px}
.service-icon{font-size:28px;margin-bottom:10px;display:block}
.service-name{font-family:var(--font-heading);font-size:15px;font-weight:700;margin-bottom:6px;color:var(--fg)}
.service-desc{font-size:13px;color:var(--muted-fg);line-height:1.5}
.diff-stack{display:flex;flex-direction:column;gap:12px;margin-top:28px}
.diff-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px 20px}
.diff-title{font-family:var(--font-heading);font-size:16px;font-weight:700;margin-bottom:8px;color:var(--fg)}
.diff-body{font-size:14px;color:var(--muted-fg);line-height:1.6}
.testimonial-wrap{display:flex;justify-content:center}
.testimonial-card{background:var(--card);border:1px solid var(--border);border-radius:24px;padding:32px 24px;text-align:center;width:100%}
.stars{font-size:18px;letter-spacing:2px;margin-bottom:20px;color:#FFB800}
.testimonial-quote{font-size:16px;line-height:1.7;font-style:italic;color:var(--fg);margin-bottom:20px}
.testimonial-quote strong{font-style:normal;font-weight:700}
.testimonial-attr{font-size:13px;color:var(--muted-fg)}
.cta-wa{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:56px;border-radius:14px;background:#25D366;color:#fff;font-size:16px;font-weight:700;text-decoration:none;margin-top:28px}
.wa-fab{position:fixed;bottom:calc(24px + env(safe-area-inset-bottom));right:20px;width:56px;height:56px;border-radius:50%;background:#25D366;display:flex;align-items:center;justify-content:center;z-index:100;box-shadow:0 4px 20px rgba(37,211,102,0.4);text-decoration:none;font-size:24px}
.footer{background:var(--bg);border-top:1px solid var(--border);padding:32px 24px;text-align:center}
.footer-brand{font-family:var(--font-heading);font-size:16px;font-weight:700;margin-bottom:6px}
.footer-meta{font-size:12px;color:var(--muted-fg);line-height:1.8}
.footer-credit{font-size:11px;color:var(--muted-fg);opacity:0.4;margin-top:16px}
.watermark-strip{position:fixed;bottom:0;left:0;right:0;background:rgba(10,10,10,0.95);border-top:1px solid rgba(255,255,255,0.08);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;z-index:200;backdrop-filter:blur(12px)}
.watermark-text{font-size:12px;color:rgba(255,255,255,0.6)}
.watermark-cta{font-size:12px;font-weight:700;color:var(--accent);text-decoration:none}
`;

// ── DEFAULT CONFIG (written to KV on first boot if missing) ───

const DEFAULT_CONFIG = {
  pricing: {
    express:  { retainer: 299 },
    standard: { retainer: 699 },
    premium:  { retainer: 999 },
  },
  addons:  { extraPage: 300, revision: 500 },
  upgrades: {
    expressToStandard: 400,
    expressToPremium:  700,
    standardToPremium: 300,
  },
  tiers: {
    express: {
      name: 'Express', badge: 'Get online fast',
      features: ['Single-page website','Free .co.za domain','WhatsApp CTA','1 revision/month'],
    },
    standard: {
      name: 'Standard', badge: 'Most popular',
      features: ['Single-page website','Free .co.za domain','WhatsApp CTA','2 revisions/month','Analytics','Referral rewards','Extra pages available'],
    },
    premium: {
      name: 'Premium', badge: 'Maximum impact',
      features: ['Single-page website','Free .co.za domain','WhatsApp CTA','Unlimited revisions','Analytics','Photo gallery','Referral rewards','Extra pages available'],
    },
  },
  upsells: {
    expressToStandard: { headline: 'Add analytics and referral rewards', delta: 400 },
    standardToPremium: { headline: 'Add gallery and unlimited revisions', delta: 300 },
    extraPage:         { headline: 'Add a dedicated page', price: 300 },
    revision:          { headline: 'Request an extra revision', price: 500 },
  },
  support: { whatsapp: '' },
  flags: {
    emailProductLive:   false,
    galleryAddonLive:   false,
    referralSystemLive: true,
  },
  announcements: [],
};

// ── MAIN FETCH HANDLER ────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    try {
      // ── ADMIN ROUTES (checked first — before slug serving) ──
      if (path.startsWith('/admin/')) {
        const adminKey = request.headers.get('x-admin-key');
        if (adminKey !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);
        if (path === '/admin/health')          return handleAdminHealth(env);
        if (path === '/admin/clients')         return handleAdminClients(env);
        if (path === '/admin/set-config'  && method === 'POST') return handleAdminSetConfig(request, env);
        if (path === '/admin/bootstrap-pwa'   && method === 'POST') return handleAdminBootstrapPwa(request, env);
        if (path === '/admin/bootstrap-start' && method === 'POST') return handleAdminBootstrapStart(request, env);
        if (path === '/admin/reset-test'      && method === 'POST') return handleAdminResetTest(env);
        if (path === '/admin/prospects'        && method === 'GET')  return handleAdminProspects(url, env);
        return jsonResponse({ error: 'Unknown admin route' }, 404);
      }

      // ── DOMAIN CHECK ─────────────────────────────────────────
      if (path === '/domain-check' && method === 'GET') return handleDomainCheck(url, env);

      // ── PUBLIC CONFIG ────────────────────────────────────────
      if (path === '/config' && method === 'GET') return handleConfig(env);

      // ── INTAKE ───────────────────────────────────────────────
      if (path === '/intake' && method === 'POST') return handleIntake(request, env);

      // ── BUILD STATUS (polling) ───────────────────────────────
      if (path === '/build-status'  && method === 'GET') return handleBuildStatus(url, env);
      if (path === '/client-status' && method === 'GET') return handleClientStatus(url, env);

      // ── PREVIEW META (prefetch for intake screen) ────────────
      if (path === '/preview-meta' && method === 'GET') return handlePreviewMeta(url, env);

      // ── INTAKE PREVIEW (cosmetic, per card) ─────────────────
      if (path === '/intake-preview'  && method === 'POST') return handleIntakePreview(request, env);

      // ── PREVIEW CHOICES (palette / font / tagline) ───────────
      if (path === '/preview-choices' && method === 'POST') return handlePreviewChoices(request, env);

      // ── TRIGGER SUBSTANCE BUILD ──────────────────────────────
      if (path === '/trigger-rebuild' && method === 'POST') return handleTriggerRebuild(request, env);

      // ── PWA SHELL ────────────────────────────────────────────
      if (path === '/start') return servePwa(env, 'app:start-v2');
      if (path.startsWith('/manage/'))     return servePwa(env, 'app:pwa');
      if (path.startsWith('/experience/')) return servePwa(env, 'app:pwa');
      if (path.startsWith('/verify/'))     return servePwa(env, 'app:pwa');

      // ── BUILT SITE SERVING ───────────────────────────────────
      return serveBuiltSite(url, path, request, env);

    } catch (err) {
      console.error('Unhandled error:', err);
      return jsonResponse({ error: 'Internal server error', message: err.message }, 500);
    }
  },

  // ── QUEUE CONSUMER ─────────────────────────────────────────
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const { type, clientId, cardPayload, isOutbound } = msg.body;
        if (type === 'pre_build')       await triggerPreBuild(clientId, env, isOutbound);
        if (type === 'substance_build') await triggerSubstanceBuild(clientId, cardPayload, env);
        msg.ack();
      } catch (err) {
        console.error('Queue message failed:', err);
        msg.retry();
      }
    }
  },

  // ── CRON ────────────────────────────────────────────────────
  async scheduled(event, env) {
    await handleCron(env);
  },
};

// ── ADMIN HANDLERS ────────────────────────────────────────────

async function handleAdminHealth(env) {
  let d1 = 'unknown';
  try { await env.DB.prepare('SELECT 1').first(); d1 = 'ok'; } catch { d1 = 'error'; }

  const recentEvents = await env.DB.prepare(
    `SELECT worker, event_type, status, created_at FROM events ORDER BY created_at DESC LIMIT 20`
  ).all().then(r => r.results).catch(() => []);

  const recentBuilds = await env.DB.prepare(
    `SELECT c.business_name, b.status, b.build_time_ms, b.created_at
     FROM builds b JOIN clients c ON c.id = b.client_id
     ORDER BY b.created_at DESC LIMIT 5`
  ).all().then(r => r.results).catch(() => []);

  return jsonResponse({ d1, recentEvents, recentBuilds, timestamp: new Date().toISOString(), testMode: isTestMode(env) });
}

async function handleAdminClients(env) {
  const rows = await env.DB.prepare(
    `SELECT id, business_name, slug, status, package, domain, created_at
     FROM clients ORDER BY created_at DESC LIMIT 20`
  ).all();
  return jsonResponse({ clients: rows.results });
}

async function handleAdminSetConfig(request, env) {
  const patch  = await request.json();
  const stored = await env.SITES.get('app:config', 'json') || DEFAULT_CONFIG;
  const merged = deepMerge(stored, patch);
  await env.SITES.put('app:config', JSON.stringify(merged));
  return jsonResponse({ success: true, config: merged });
}

async function handleAdminBootstrapPwa(request, env) {
  const html = await request.text();
  if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
  await env.SITES.put('app:pwa', html);
  return jsonResponse({ success: true, size: html.length });
}

async function handleAdminBootstrapStart(request, env) {
  const html = await request.text();
  if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
  await env.SITES.put('app:start-v2', html);
  return jsonResponse({ success: true, size: html.length });
}

async function handleAdminResetTest(env) {
  if (!isTestMode(env)) return jsonResponse({ error: 'Only in test mode' }, 403);
  await env.DB.prepare(`DELETE FROM events`).run();
  await env.DB.prepare(`DELETE FROM builds`).run();
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM visits`).run();
  await env.DB.prepare(`DELETE FROM revisions`).run();
  await env.DB.prepare(`DELETE FROM invoices`).run();
  await env.DB.prepare(`DELETE FROM referrals`).run();
  await env.DB.prepare(`DELETE FROM clients WHERE status != 'live'`).run();
  return jsonResponse({ success: true });
}

async function handleAdminProspects(url, env) {
  const status = url.searchParams.get('status') || 'pending';
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const rows = await env.DB.prepare(
    `SELECT id, business_name, phone, industry, area, status,
            contacted_at, cooldown_until, created_at
     FROM prospects
     WHERE status = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(status, limit).all();
  return jsonResponse({ prospects: rows.results, count: rows.results?.length || 0, status });
}

// ── PREVIEW CHOICES ───────────────────────────────────────────

async function handlePreviewChoices(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { token, palette, font, tagline, logo_url, photo } = body;
  if (!token) return jsonResponse({ error: 'token required' }, 400);

  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not found' }, 404);

  // Update client fields — only the ones provided
  const updates = {};
  if (palette)  updates.palette   = palette;
  if (logo_url) updates.logo_url  = logo_url;

  // Store font + tagline + photo in voice_profile JSON
  const profile = safeJson(client.voice_profile) || {};
  if (font)    profile._font    = font;
  if (tagline) profile.tagline  = tagline;
  if (photo)   profile._photo   = photo;
  updates.voice_profile = JSON.stringify(profile);

  await updateClient(env, client.id, updates);
  return jsonResponse({ success: true });
}

// ── DOMAIN CHECK ─────────────────────────────────────────────

async function handleDomainCheck(url, env) {
  let rawName = url.searchParams.get('name') || '';
  // Strip .co.za if caller passed full domain instead of business name
  if (rawName.toLowerCase().endsWith('.co.za')) rawName = rawName.slice(0, -6);
  const slug   = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const domain = slug + '.co.za';

  if (!slug) return jsonResponse({ available: false, domain, error: 'Invalid name' }, 400);

  // CORS — landing page is on a different origin
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };

  // Check against D1 first — if a client already has this slug, it's taken
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM clients WHERE slug = ? LIMIT 1`
    ).bind(slug).first();
    if (existing) {
      return new Response(JSON.stringify({
        available:   false,
        domain,
        suggestions: generateSuggestions(slug),
      }), { headers });
    }
  } catch {}

  // Call RegisterDomain API
  if (!env.REGISTERDOMAIN_API_KEY || !env.REGISTERDOMAIN_EMAIL) {
    // No credentials — assume available (dev/test mode)
    return new Response(JSON.stringify({ available: true, domain }), { headers });
  }

  try {
    const params = new URLSearchParams({
      username:     env.REGISTERDOMAIN_EMAIL,
      password:     env.REGISTERDOMAIN_API_KEY,
      action:       'CheckAvailability',
      responsetype: 'json',
    });
    // WHMCS expects domains as array
    params.append('domains[0]', domain);

    const res  = await fetch('https://www.registerdomain.co.za/includes/api.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();

    // Log raw response for debugging
    console.log('RegisterDomain response:', JSON.stringify(data));

    // WHMCS response: { domains: [{ domain, status }] }
    const domainResult = data?.domains?.[0];
    const status       = (domainResult?.status || data?.result || '').toLowerCase();
    const available    = status === 'available' || status === 'free';

    return new Response(JSON.stringify({
      available,
      domain,
      suggestions: available ? [] : generateSuggestions(slug),
      _debug: { status, raw: data?.domains?.[0] },
    }), { headers });

  } catch (err) {
    console.error('Domain check failed:', err.message);
    // Fail open — let them proceed, backend will catch duplicates at intake
    return new Response(JSON.stringify({ available: true, domain, _fallback: true }), { headers });
  }
}

function generateSuggestions(slug) {
  return [
    slug + 'sa.co.za',
    slug + 'kzn.co.za',
    'my' + slug + '.co.za',
  ];
}

// ── PUBLIC CONFIG ─────────────────────────────────────────────

async function handleConfig(env) {
  let config = await env.SITES.get('app:config', 'json');
  if (!config) {
    config = DEFAULT_CONFIG;
    await env.SITES.put('app:config', JSON.stringify(config));
  }
  return new Response(JSON.stringify(config), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CONFIG_CACHE_TTL}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── INTAKE ────────────────────────────────────────────────────

async function handleIntake(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { business_name, client_name, phone, email, package: pkg, area, industry } = body;
  if (!business_name || !phone)
    return jsonResponse({ error: 'business_name and phone required' }, 400);

  const id            = generateUUID();
  const slug          = await uniqueSlug(business_name, env);
  const manage_token  = generateUUID();
  const referral_slug = slug.slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6);
  const normPhone     = normaliseSaPhone(phone);
  const packageKey    = pkgKey(pkg);

  await env.DB.prepare(`
    INSERT INTO clients
      (id, business_name, client_name, slug, phone, email, package, retainer,
       industry, area, vibe, manage_token, referral_slug, status, source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'lead','website')
  `).bind(
    id, business_name, client_name || null, slug, normPhone, email || null,
    packageKey, PRICING[packageKey]?.retainer || 699,
    industry || null, area || null, 'professional', manage_token, referral_slug
  ).run();

  await logEvent(env, null, 'build', 'intake_received', 'success', { metadata: { business_name, slug, pkg: packageKey } });

  // Queue pre-build
  await env.BUILD_QUEUE.send({ type: 'pre_build', clientId: id, isOutbound: false });

  return jsonResponse({ slug, manage_token, clientId: id });
}

// ── BUILD STATUS ──────────────────────────────────────────────

async function handleBuildStatus(url, env) {
  const token = url.searchParams.get('token');
  const slug  = url.searchParams.get('slug');

  let client;
  if (token) client = await getClientByToken(token, env);
  else if (slug) client = await getClientBySlug(slug, env);
  if (!client) return jsonResponse({ status: 'not_found' }, 404);

  return jsonResponse({
    status:     client.status,
    slug:       client.slug,
    previewUrl: client.preview_url || null,
    domain:     client.domain || null,
  });
}

async function handleClientStatus(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'token required' }, 400);
  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ status: 'not_found' }, 404);
  return jsonResponse({ status: client.status, liveUrl: client.live_url || null });
}

// ── PREVIEW META ──────────────────────────────────────────────

async function handlePreviewMeta(url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'slug required' }, 400);
  const client = await getClientBySlug(slug, env);
  if (!client) return jsonResponse({ error: 'not found' }, 404);
  return jsonResponse({
    business_name: client.business_name,
    area:          client.area,
    industry:      client.industry,
    package:       client.package,
    domain:        client.domain || `${slug}.co.za`,
    slug,
  });
}

// ── INTAKE PREVIEW (cosmetic per-card update) ─────────────────

async function handleIntakePreview(request, env) {
  // Cosmetic only — returns updated copy tokens without triggering a rebuild
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { token, field, value } = body;
  if (!token) return jsonResponse({ error: 'token required' }, 400);
  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not found' }, 404);
  // Store the update in voice_profile JSON
  const profile = safeJson(client.voice_profile) || {};
  profile[field] = value;
  await env.DB.prepare(`UPDATE clients SET voice_profile=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(JSON.stringify(profile), client.id).run();
  return jsonResponse({ success: true });
}

// ── TRIGGER SUBSTANCE BUILD ────────────────────────────────────

async function handleTriggerRebuild(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { token, package: pkg, cards } = body;
  if (!token || !cards) return jsonResponse({ error: 'token and cards required' }, 400);
  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not found' }, 404);

  // Update package + card fields
  const packageKey = pkgKey(pkg || client.package);
  const differentiator = [cards.diff1, cards.diff2, cards.diff3].filter(Boolean).join(' | ');
  await env.DB.prepare(`
    UPDATE clients SET
      package=?, retainer=?, industry=?, area=?, vibe=?,
      services=?, primary_cta=?, target_audience=?, testimonial=?,
      logo_url=?, palette=?, differentiator=?, status='building',
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(
    packageKey, PRICING[packageKey]?.retainer || 699,
    cards.industry || client.industry,
    cards.area     || client.area,
    cards.vibe     || client.vibe,
    JSON.stringify(cards.services || []),
    cards.cta      || null,
    cards.audience || null,
    cards.testimonial || null,
    cards.logo     || null,
    cards.palette  || null,
    differentiator || null,
    client.id
  ).run();

  await env.BUILD_QUEUE.send({ type: 'substance_build', clientId: client.id, cardPayload: cards });
  return jsonResponse({ success: true, status: 'building' });
}

// ── PWA / SITE SERVING ────────────────────────────────────────

async function servePwa(env, kvKey) {
  const html = await env.SITES.get(kvKey);
  if (!html) return new Response('PWA not bootstrapped', { status: 503 });
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache' } });
}

async function serveBuiltSite(url, path, request, env) {
  // Paths: /{slug} or /{slug}/{page}
  const parts = path.replace(/^\//, '').split('/');
  const slug  = parts[0];
  const page  = parts[1] || 'index';

  if (!slug) return servePwa(env, 'app:start-v2');

  // Record visit (fire and forget)
  const client = await getClientBySlug(slug, env).catch(() => null);
  if (client?.id) fireAndForget(() => recordVisit(env, client.id, page));

  // Try specific page key first, then fall back to index
  let html = await env.SITES.get(`preview:${slug}:${page}`) ||
             await env.SITES.get(`preview:${slug}`);

  if (!html) {
    return new Response(siteNotFound(slug), {
      status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=300',
      'X-Robots-Tag': client?.status === 'live' ? 'index, follow' : 'noindex',
    },
  });
}

// ── PRE-BUILD PIPELINE ────────────────────────────────────────

async function triggerPreBuild(clientId, env, isOutbound = false) {
  const client = await getClientById(clientId, env);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const slug   = client.slug;
  const pkg    = pkgKey(client.package);
  const brief  = getDesignBrief(client.industry, client.vibe);
  const buildId = await createBuild(env, clientId, { template_id: pkg, palette: client.vibe });
  const buildStart = Date.now();

  await updateClient(env, clientId, { status: 'building' });
  await logEvent(env, clientId, 'build', 'pre_build_started', 'success', {
    metadata: { business: client.business_name, pkg, palette: brief.palette.notes }
  });

  // ── PASS 1: Brand Intelligence ─────────────────────────────
  let brandBrief;
  try {
    const raw = await callClaudeInternal(
      preBuildPass1System(brief),
      [{ role: 'user', content: preBuildPass1User(client, brief) }],
      env, { maxTokens: PASS_TOKENS.pre_1 }
    );
    brandBrief = parseJson(raw);
    await logEvent(env, clientId, 'build', 'pre_pass1_complete', 'success', {});
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pre-build Pass 1 failed: ${e.message}`);
  }

  // ── PASS 2: Skeleton Content ───────────────────────────────
  let contentTokens;
  try {
    const raw = await callClaudeInternal(
      preBuildPass2System(),
      [{ role: 'user', content: preBuildPass2User(client, brief, brandBrief) }],
      env, { maxTokens: PASS_TOKENS.pre_2 }
    );
    contentTokens = parseJson(raw);
    await logEvent(env, clientId, 'build', 'pre_pass2_complete', 'success', {});
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pre-build Pass 2 failed: ${e.message}`);
  }

  // ── PASS 3: Mobile UX Check (non-fatal) ────────────────────
  try {
    const raw = await callClaudeInternal(
      preBuildPass3System(),
      [{ role: 'user', content: preBuildPass3User(contentTokens, brief) }],
      env, { maxTokens: PASS_TOKENS.pre_3 }
    );
    const refined = parseJson(raw);
    if (refined && Object.keys(refined).length > 0) {
      contentTokens = { ...contentTokens, ...refined };
    }
    await logEvent(env, clientId, 'build', 'pre_pass3_complete', 'success', {});
  } catch (e) {
    console.warn('Pre-build Pass 3 failed (non-fatal):', e.message);
  }

  // ── PHOTO ──────────────────────────────────────────────────
  const heroUrl = await fetchHeroPhoto(brief, brandBrief, env);

  // ── CSS ────────────────────────────────────────────────────
  const cssBlock = buildCssVariables(brief.palette, brief.typography);

  // ── HTML ───────────────────────────────────────────────────
  const html = generateSkeletonHTML(contentTokens, cssBlock, heroUrl, client);
  const finalHtml = isOutbound ? addWatermark(html, client, env) : html;

  // ── STORE ──────────────────────────────────────────────────
  await env.SITES.put(`preview:${slug}`, finalHtml, { expirationTtl: PREVIEW_TTL });
  await env.SITES.put(`content:${slug}`, JSON.stringify(contentTokens), { expirationTtl: PREVIEW_TTL });

  const buildMs = Date.now() - buildStart;
  await updateBuild(env, buildId, {
    status: 'complete',
    build_time_ms: buildMs,
    voice_profile: JSON.stringify(contentTokens),
    unsplash_queries: JSON.stringify([brandBrief.unsplash_query || brief.unsplashQuery]),
  });

  const previewUrl = `https://${PREVIEW_DOMAIN}/${slug}`;
  await updateClient(env, clientId, { status: 'preview_ready', preview_url: previewUrl });

  await logEvent(env, clientId, 'build', 'pre_build_complete', 'success', {
    durationMs: buildMs,
    metadata: { business: client.business_name, pkg },
  });

  // ── NOTIFY ─────────────────────────────────────────────────
  if (!isTestMode(env)) {
    await sendWhatsApp(env.WH_PHONE,
      `✅ PRE-BUILD: ${client.business_name}\nPreview: ${previewUrl}\n${buildMs}ms`,
      env, { skipTestRedirect: true }
    ).catch(() => {});

    if (!isOutbound) {
      await sendWhatsApp(client.phone,
        `🎉 Your website preview is ready!\n\nTap here to personalise it:\nhttps://${PREVIEW_DOMAIN}/manage/${client.manage_token}`,
        env
      ).catch(() => {});
    }
  }

  return slug;
}

// ── SUBSTANCE BUILD PIPELINE ──────────────────────────────────

async function triggerSubstanceBuild(clientId, cards, env) {
  const client = await getClientById(clientId, env);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const slug  = client.slug;
  const pkg   = pkgKey(client.package);
  const brief = getDesignBrief(client.industry, cards?.vibe || client.vibe);

  // Load pre-build voice profile as anchor
  const previewProfile = await env.SITES.get(`content:${slug}`, 'json').catch(() => null);

  const buildId    = await createBuild(env, clientId, { template_id: pkg, palette: cards?.palette || client.vibe });
  const buildStart = Date.now();

  await updateClient(env, clientId, { status: 'building' });
  await logEvent(env, clientId, 'build', 'substance_build_started', 'success', {
    metadata: { business: client.business_name, pkg },
  });

  // ── PASS 1: Rich Brand Intelligence ────────────────────────
  let brandBrief;
  try {
    const raw = await callClaudeInternal(
      substancePass1System(brief),
      [{ role: 'user', content: substancePass1User(client, cards, brief, previewProfile) }],
      env, { maxTokens: PASS_TOKENS.sub_1 }
    );
    brandBrief = parseJson(raw);
    await logEvent(env, clientId, 'build', 'sub_pass1_complete', 'success', {});
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Substance Pass 1 failed: ${e.message}`);
  }

  // ── PASS 2: Full Content Generation ────────────────────────
  const pass2Budget = PACKAGE_CAPS[pkg]?.pass3TokenBudget || 7500;
  let contentTokens;
  try {
    const raw = await callClaudeInternal(
      substancePass2System(),
      [{ role: 'user', content: substancePass2User(client, cards, brief, brandBrief, previewProfile) }],
      env, { maxTokens: pass2Budget }
    );
    contentTokens = parseJson(raw);
    await logEvent(env, clientId, 'build', 'sub_pass2_complete', 'success', {});
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Substance Pass 2 failed: ${e.message}`);
  }

  // ── PASS 3: Mobile UX + Quality Gate (non-fatal) ────────────
  try {
    const raw = await callClaudeInternal(
      substancePass3System(),
      [{ role: 'user', content: substancePass3User(contentTokens, cards, brief) }],
      env, { maxTokens: PASS_TOKENS.sub_3 }
    );
    const refined = parseJson(raw);
    if (refined && Object.keys(refined).length > 0) {
      contentTokens = { ...contentTokens, ...refined };
    }
    await logEvent(env, clientId, 'build', 'sub_pass3_complete', 'success', {});
  } catch (e) {
    console.warn('Substance Pass 3 failed (non-fatal):', e.message);
  }

  // ── PHOTO ──────────────────────────────────────────────────
  const heroUrl = await fetchHeroPhoto(brief, brandBrief, env);

  // ── CSS ────────────────────────────────────────────────────
  const cssBlock = buildCssVariables(brief.palette, brief.typography);

  // ── HTML ───────────────────────────────────────────────────
  const hasgallery = PACKAGE_CAPS[pkg]?.gallery && (cards?.photos?.length > 0);
  const html       = generateFullHTML(contentTokens, cssBlock, heroUrl, client, cards, hasgallery);

  // ── STORE ──────────────────────────────────────────────────
  await env.SITES.put(`preview:${slug}`, html, { expirationTtl: PREVIEW_TTL });
  await env.SITES.put(`content:${slug}`, JSON.stringify(contentTokens), { expirationTtl: PREVIEW_TTL });

  const buildMs = Date.now() - buildStart;
  await updateBuild(env, buildId, {
    status: 'complete',
    build_time_ms: buildMs,
    voice_profile: JSON.stringify(contentTokens),
    unsplash_queries: JSON.stringify([brandBrief.unsplash_query || brief.unsplashQuery]),
  });

  await updateClient(env, clientId, {
    status:        'preview_ready',
    voice_profile: JSON.stringify(contentTokens),
  });

  await logEvent(env, clientId, 'build', 'substance_build_complete', 'success', {
    durationMs: buildMs,
    metadata: { business: client.business_name, pkg },
  });

  if (!isTestMode(env)) {
    await sendWhatsApp(env.WH_PHONE,
      `✅ SUBSTANCE BUILD: ${client.business_name}\nSlug: ${slug}\n${buildMs}ms`,
      env, { skipTestRedirect: true }
    ).catch(() => {});
  }

  return slug;
}

// ── PASS PROMPTS: PRE-BUILD ───────────────────────────────────

function preBuildPass1System(brief) {
  return `You are a South African brand strategist. You have minimal information about a business — a name, area, and industry. The design system is already chosen (${brief.palette.notes}, ${brief.typography.name} typography). Read between the lines. Infer personality. Find the story angle that makes this business feel specific and real. SA context always. Output only valid JSON — no markdown, no explanation.`;
}

function preBuildPass1User(client, brief) {
  return `Business: ${client.business_name}
Area: ${client.area}
Industry: ${client.industry}
Design palette: ${brief.palette.notes}
Typography: ${brief.typography.name}
Brand accent colour: ${brief.palette.primary}

Output this JSON exactly:
{
  "inferred_tone": "2-4 words describing the brand voice",
  "hero_angle": "the specific angle that makes this business feel real",
  "tagline_candidates": ["option 1", "option 2", "option 3"],
  "trust_signals": ["signal 1", "signal 2", "signal 3"],
  "unsplash_query": "specific Unsplash search — industry + mood + south africa"
}`;
}

function preBuildPass2System() {
  return `You are a South African copywriter building a skeleton website — the customer's first impression. Write short, punchy, and real. Every word earns its place. No filler. No corporate language. No generic phrases. Stay strictly within the word count limits. SA tone throughout. Output only valid JSON — no markdown.`;
}

function preBuildPass2User(client, brief, brandBrief) {
  return `Business: ${client.business_name}
Area: ${client.area}
Industry: ${client.industry}
Brand tone: ${brandBrief.inferred_tone}
Hero angle: ${brandBrief.hero_angle}
Trust signals: ${brandBrief.trust_signals?.join(', ')}
Tagline options: ${brandBrief.tagline_candidates?.join(' / ')}

Word limits are HARD — do not exceed them.

Output this JSON exactly:
{
  "hero_h1": "max 5 words",
  "hero_subline": "max 10 words",
  "tagline": "max 6 words — choose from candidates or write better",
  "cta_primary": "max 4 words — WhatsApp action",
  "trust_line": "max 8 words — one trust signal below hero",
  "services": [
    {"name": "2-3 words", "icon": "single emoji"},
    {"name": "2-3 words", "icon": "single emoji"},
    {"name": "2-3 words", "icon": "single emoji"},
    {"name": "2-3 words", "icon": "single emoji"}
  ],
  "section_label_services": "max 3 words — uppercase label",
  "contact_headline": "max 5 words",
  "contact_subline": "max 8 words",
  "section_label_contact": "max 3 words — uppercase label"
}`;
}

function preBuildPass3System() {
  return `You are testing a mobile website on a Samsung Galaxy A15 in Durban. One hand. 1.5 second first paint. You are NOT an editor — do not rewrite for style. Only fix functional failures: headline too long, CTA not action-oriented, copy sounds like a template. Check against these UX rules: ${UX_RULES.map(r => r.rule + ': ' + r.do).join(' | ')}. Return ONLY the failing fields as a partial JSON object. If everything passes return {}.`;
}

function preBuildPass3User(contentTokens, brief) {
  return `Content to check:
${JSON.stringify(contentTokens, null, 2)}

Return only failing fields. Empty object {} if all pass.`;
}

// ── PASS PROMPTS: SUBSTANCE BUILD ─────────────────────────────

function substancePass1System(brief) {
  return `You are a South African brand strategist. A business owner has told you everything about their business — their vibe, who they serve, what makes them different, what a happy customer says. Your job is to find the one story thread running through all of it and articulate their specific voice. Do not categorise them. Do not fit them into an industry mould. The design system is already chosen (${brief.palette.notes}, ${brief.typography.name}). Output only valid JSON — no markdown.`;
}

function substancePass1User(client, cards, brief, previewProfile) {
  return `Business: ${client.business_name}
Area: ${client.area}
Industry: ${cards?.industry || client.industry}
Audience: ${cards?.audience || 'general'}
Vibe: ${cards?.vibe || client.vibe}
Services: ${(cards?.services || []).join(', ')}
Main CTA: ${cards?.cta || 'Get in touch'}
Differentiator 1: ${cards?.diff1 || ''}
Differentiator 2: ${cards?.diff2 || ''}
Differentiator 3: ${cards?.diff3 || ''}
Testimonial seed: ${cards?.testimonial || ''}
Tagline choice: ${cards?.tagline || ''}
${previewProfile ? `\nExisting skeleton content (build forward from this, don't contradict):\nHero: ${previewProfile.hero_h1 || ''} — ${previewProfile.hero_subline || ''}` : ''}

Output this JSON exactly:
{
  "brand_voice": "one sentence — their specific voice, not a category",
  "story_angle": "the narrative thread tying their differentiators together",
  "emotional_core": "what the customer feels after reading this site",
  "hero_angle": "specific and informed by their actual data",
  "differentiator_narrative": "one paragraph weaving diff1 + diff2 + diff3 into one story",
  "testimonial_frame": "how to present the testimonial seed most powerfully",
  "unsplash_query": "hero image search — specific to their industry + vibe + area"
}`;
}

function substancePass2System() {
  return `You are a South African brand copywriter. You know this business personally — their story, their voice, their differentiators, what their happiest customer said. Write every section of their website in that voice. Not a generic trade voice. Not a template. Their specific voice. Every headline should be something only this business could say. Obey all word limits — the design containers are fixed. SA tone throughout. No stock phrases. Output only valid JSON — no markdown.`;
}

function substancePass2User(client, cards, brief, brandBrief, previewProfile) {
  const pkg  = pkgKey(client.package);
  const caps = PACKAGE_CAPS[pkg] || PACKAGE_CAPS.standard;
  const svcs = cards?.services || [];

  return `Business: ${client.business_name}
Area: ${client.area}
Phone: ${client.phone}
Domain: ${client.domain || client.slug + '.co.za'}
Brand voice: ${brandBrief.brand_voice}
Story angle: ${brandBrief.story_angle}
Emotional core: ${brandBrief.emotional_core}
Hero angle: ${brandBrief.hero_angle}
Differentiator narrative: ${brandBrief.differentiator_narrative}
Testimonial frame: ${brandBrief.testimonial_frame}
Raw testimonial: ${cards?.testimonial || ''}
Services (${svcs.length}): ${svcs.join(', ')}
Main CTA: ${cards?.cta || 'Get in touch'}
Audience: ${cards?.audience || 'local community'}
Package: ${pkg} (${caps.pass3TokenBudget} token budget — ${pkg === 'premium' ? 'maximum depth' : pkg === 'standard' ? 'full detail' : 'solid foundation'})

WORD LIMITS — hard limits, do not exceed:
hero_h1_line1/2: 4 words each | hero_subline: 12 words | hero_cta: 4 words | hero_trust_line: 8 words
about_headline: 8 words | about_pull_quote: 12 words | about_p1/p2: 45 words each
services_headline: 6 words | each service name: 3 words | each service desc: 12 words
whyus_headline: 6 words | each diff title: 4 words | each diff body: 15 words
testimonial_quote: 35 words | testimonial_context: 4 words
contact_headline: 6 words | contact_subline: 12 words | contact_cta: 4 words
All section labels: 3 words, UPPERCASE

Output this JSON exactly:
{
  "page_title": "${client.business_name} | ${client.industry} | ${client.area}",
  "meta_description": "max 155 chars",
  "hero_h1_line1": "max 4 words",
  "hero_h1_line2": "max 4 words",
  "hero_subline": "max 12 words",
  "hero_cta": "max 4 words",
  "hero_trust_line": "max 8 words",
  "section_label_about": "UPPERCASE MAX 3 WORDS",
  "about_headline": "max 8 words — specific to their story",
  "about_pull_quote": "max 12 words — only this business would say this",
  "about_p1": "max 45 words — origin story",
  "about_p2": "max 45 words — what makes them different in ${client.area}",
  "section_label_services": "UPPERCASE MAX 3 WORDS",
  "services_headline": "max 6 words",
  "services": [${svcs.map(s => `{"name":"3 words max","desc":"12 words max","icon":"emoji"}`).join(',')}],
  "section_label_whyus": "UPPERCASE MAX 3 WORDS",
  "whyus_headline": "max 6 words",
  "diff1_title": "max 4 words", "diff1_body": "max 15 words",
  "diff2_title": "max 4 words", "diff2_body": "max 15 words",
  "diff3_title": "max 4 words", "diff3_body": "max 15 words",
  "testimonial_quote": "max 35 words",
  "testimonial_name": "first name or initial only",
  "testimonial_context": "max 4 words e.g. Homeowner KZN",
  "section_label_contact": "UPPERCASE MAX 3 WORDS",
  "contact_headline": "max 6 words",
  "contact_subline": "max 12 words",
  "contact_cta": "max 4 words"
}`;
}

function substancePass3System() {
  return `Two tests only. TEST 1 — MOBILE: Load on a mid-range Android phone, one hand. Is the hero one clear message? Is the CTA thumb-reachable (check word count)? Does any section feel like a wall of text? UX rules: ${UX_RULES.map(r => r.rule + ': ' + r.do).join(' | ')}. TEST 2 — SPECIFICITY: Could a competitor copy-paste the differentiators? Does the about section sound like a real person or a press release? Does the testimonial sound like a real SA customer? Fix failing fields only. Return partial JSON. If all pass return {}.`;
}

function substancePass3User(contentTokens, cards, brief) {
  return `Content to check:
${JSON.stringify(contentTokens, null, 2)}

Original client differentiators for comparison:
diff1: ${cards?.diff1 || ''} | diff2: ${cards?.diff2 || ''} | diff3: ${cards?.diff3 || ''}

Return only failing fields. Empty {} if all pass.`;
}

// ── HTML GENERATORS ───────────────────────────────────────────

function generateSkeletonHTML(t, cssBlock, heroUrl, client) {
  const phone  = client.phone?.replace(/\D/g, '');
  const domain = client.domain || `${client.slug}.co.za`;
  const waLink = `https://wa.me/${phone}`;
  const svcs   = t.services || [];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.hero_h1 || client.business_name)} | ${esc(client.area)}</title>
<meta name="description" content="${esc(t.hero_subline || '')}">
<meta name="robots" content="noindex">
${cssBlock}
<style>${STRUCTURAL_CSS}</style>
</head>
<body>

<nav class="nav">
  <a href="/" class="nav-brand">${esc(client.business_name)}</a>
  <div class="nav-links">
    <a href="#services" class="nav-link">Services</a>
    <a href="#contact" class="nav-link">Contact</a>
    <a href="${waLink}" class="nav-link" style="color:var(--accent)">WhatsApp</a>
  </div>
</nav>

<section class="section-hero" style="background-image:url('${heroUrl}')">
  <div class="hero-content">
    <p class="trust-line">${esc(t.trust_line || '')}</p>
    <h1 class="hero-h1">${esc(t.hero_h1 || client.business_name)}</h1>
    <p class="hero-sub">${esc(t.hero_subline || '')}</p>
    <a href="${waLink}" class="cta-wa">💬 ${esc(t.cta_primary || 'WhatsApp Us')}</a>
  </div>
</section>

<section id="services" class="section-bleed">
  <span class="label">${esc(t.section_label_services || 'WHAT WE DO')}</span>
  <div class="services-grid">
    ${svcs.map(s => `
    <div class="service-card">
      <span class="service-icon">${s.icon || '⚡'}</span>
      <div class="service-name">${esc(s.name || '')}</div>
    </div>`).join('')}
  </div>
</section>

<section id="contact" class="section">
  <span class="label">${esc(t.section_label_contact || 'GET IN TOUCH')}</span>
  <h2 class="section-h2">${esc(t.contact_headline || 'Ready to start?')}</h2>
  <p class="body-text">${esc(t.contact_subline || '')}</p>
  <a href="${waLink}" class="cta-wa">💬 ${esc(t.cta_primary || 'WhatsApp Us')}</a>
</section>

<footer class="footer">
  <div class="footer-brand">${esc(client.business_name)}</div>
  <div class="footer-meta">${esc(client.area)} · ${esc(domain)}</div>
  <div class="footer-credit">Built by Website Hub</div>
</footer>

<a href="${waLink}" class="wa-fab" aria-label="WhatsApp">💬</a>

</body>
</html>`;
}

function generateFullHTML(t, cssBlock, heroUrl, client, cards, hasGallery) {
  const phone  = client.phone?.replace(/\D/g, '');
  const domain = client.domain || `${client.slug}.co.za`;
  const waLink = `https://wa.me/${phone}`;
  const svcs   = t.services || [];
  const photos  = cards?.photos || [];

  const gallerySection = hasGallery && photos.length > 0 ? `
<section id="gallery" class="section">
  <span class="label">OUR WORK</span>
  <h2 class="section-h2">See it for yourself</h2>
  <div class="services-grid" style="grid-template-columns:1fr 1fr;gap:8px;margin-top:24px">
    ${photos.slice(0, 6).map(url => `<img src="${url}" alt="Our work" style="width:100%;border-radius:12px;aspect-ratio:1;object-fit:cover">`).join('')}
  </div>
</section>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.page_title || client.business_name)}</title>
<meta name="description" content="${esc(t.meta_description || '')}">
${cssBlock}
<style>${STRUCTURAL_CSS}</style>
</head>
<body>

<nav class="nav">
  <a href="/" class="nav-brand">${esc(client.business_name)}</a>
  <div class="nav-links">
    <a href="#about"    class="nav-link">About</a>
    <a href="#services" class="nav-link">Services</a>
    <a href="#contact"  class="nav-link">Contact</a>
    <a href="${waLink}" class="nav-link" style="color:var(--accent)">WhatsApp</a>
  </div>
</nav>

<!-- HERO -->
<section class="section-hero" style="background-image:url('${heroUrl}')">
  <div class="hero-content">
    <p class="trust-line">${esc(t.hero_trust_line || '')}</p>
    <h1 class="hero-h1">${esc(t.hero_h1_line1 || '')}${t.hero_h1_line2 ? '<br>' + esc(t.hero_h1_line2) : ''}</h1>
    <p class="hero-sub">${esc(t.hero_subline || '')}</p>
    <a href="${waLink}" class="cta-wa">💬 ${esc(t.hero_cta || 'WhatsApp Us')}</a>
  </div>
</section>

<!-- ABOUT -->
<section id="about" class="section-bleed">
  <span class="label">${esc(t.section_label_about || 'OUR STORY')}</span>
  <h2 class="section-h2">${esc(t.about_headline || '')}</h2>
  <div class="card" style="margin-bottom:24px">
    <p class="pull-quote">${esc(t.about_pull_quote || '')}</p>
  </div>
  <p class="body-text">${esc(t.about_p1 || '')}</p>
  <p class="body-text">${esc(t.about_p2 || '')}</p>
</section>

<!-- SERVICES -->
<section id="services" class="section">
  <span class="label">${esc(t.section_label_services || 'WHAT WE DO')}</span>
  <h2 class="section-h2">${esc(t.services_headline || '')}</h2>
  <div class="services-grid">
    ${svcs.map(s => `
    <div class="service-card">
      <span class="service-icon">${s.icon || '⚡'}</span>
      <div class="service-name">${esc(s.name || '')}</div>
      <div class="service-desc">${esc(s.desc || '')}</div>
    </div>`).join('')}
  </div>
</section>

${gallerySection}

<!-- WHY US -->
<section id="why-us" class="section-bleed">
  <span class="label">${esc(t.section_label_whyus || 'WHY US')}</span>
  <h2 class="section-h2">${esc(t.whyus_headline || '')}</h2>
  <div class="diff-stack">
    <div class="diff-card">
      <div class="diff-title">${esc(t.diff1_title || '')}</div>
      <div class="diff-body">${esc(t.diff1_body || '')}</div>
    </div>
    <div class="diff-card">
      <div class="diff-title">${esc(t.diff2_title || '')}</div>
      <div class="diff-body">${esc(t.diff2_body || '')}</div>
    </div>
    <div class="diff-card">
      <div class="diff-title">${esc(t.diff3_title || '')}</div>
      <div class="diff-body">${esc(t.diff3_body || '')}</div>
    </div>
  </div>
</section>

<!-- TESTIMONIAL -->
<section class="section">
  <div class="testimonial-wrap">
    <div class="testimonial-card">
      <div class="stars">★★★★★</div>
      <p class="testimonial-quote">${esc(t.testimonial_quote || '')}</p>
      <div class="testimonial-attr">${esc(t.testimonial_name || '')} · ${esc(t.testimonial_context || '')}</div>
    </div>
  </div>
</section>

<!-- CONTACT -->
<section id="contact" class="section-bleed">
  <span class="label">${esc(t.section_label_contact || 'GET IN TOUCH')}</span>
  <h2 class="section-h2">${esc(t.contact_headline || '')}</h2>
  <p class="body-text">${esc(t.contact_subline || '')}</p>
  <a href="${waLink}" class="cta-wa">💬 ${esc(t.contact_cta || 'WhatsApp Us')}</a>
</section>

<footer class="footer">
  <div class="footer-brand">${esc(client.business_name)}</div>
  <div class="footer-meta">${esc(client.area)} · ${esc(domain)}</div>
  <div class="footer-credit">Built by Website Hub</div>
</footer>

<a href="${waLink}" class="wa-fab" aria-label="WhatsApp">💬</a>

</body>
</html>`;
}

function addWatermark(html, client, env) {
  const waLink = `https://wa.me/${(client.phone||'').replace(/\D/g,'')}`;
  const claimLink = `https://${PREVIEW_DOMAIN}/start`;
  const strip = `
<div class="watermark-strip">
  <span class="watermark-text">Preview — ${esc(client.business_name)}</span>
  <a href="${claimLink}" class="watermark-cta">Claim this site →</a>
</div>`;
  return html.replace('</body>', strip + '\n</body>');
}

// ── PHOTO FETCHING ────────────────────────────────────────────

async function fetchHeroPhoto(brief, brandBrief, env) {
  if (!env.UNSPLASH_ACCESS_KEY) return FALLBACK_HERO;

  const query    = brandBrief?.unsplash_query || brief.unsplashQuery;
  const industry = brief._source?.split(':')[1]?.trim() || '';
  const vibe     = '';

  // Check D1 library first
  try {
    const cached = await env.DB.prepare(
      `SELECT url FROM photos WHERE industry=? AND slot='hero' ORDER BY usage_count DESC LIMIT 3`
    ).bind(industry).all();
    if (cached.results?.length >= 1) {
      const chosen = cached.results[Math.floor(Math.random() * cached.results.length)];
      await env.DB.prepare(`UPDATE photos SET usage_count=usage_count+1, last_used_at=CURRENT_TIMESTAMP WHERE url=?`)
        .bind(chosen.url).run().catch(() => {});
      return chosen.url;
    }
  } catch {}

  // Fetch from Unsplash
  try {
    const endpoint = `https://api.unsplash.com/photos/random`
      + `?query=${encodeURIComponent(query.slice(0, 100))}`
      + `&orientation=landscape&content_filter=high`;
    const res  = await fetch(endpoint, {
      headers: { 'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' }
    });
    if (!res.ok) return FALLBACK_HERO;
    const data = await res.json();
    const url  = data.urls?.regular || data.urls?.full;
    if (!url) return FALLBACK_HERO;

    // Cache in D1 library
    await env.DB.prepare(
      `INSERT OR IGNORE INTO photos (unsplash_id, url, thumb_url, query_used, industry, vibe, slot)
       VALUES (?,?,?,?,?,?,'hero')`
    ).bind(data.id, url, data.urls?.thumb || url, query, industry, vibe).run().catch(() => {});

    return url;
  } catch {
    return FALLBACK_HERO;
  }
}

// ── CRON — OUTBOUND PROSPECTING ───────────────────────────────

async function handleCron(env) {
  if (isTestMode(env)) return;
  await logEvent(env, null, 'build', 'cron_run', 'success', { metadata: { trigger: 'scheduled' } });

  // Get approved prospects not yet contacted and not on cooldown
  const prospects = await env.DB.prepare(
    `SELECT * FROM prospects
     WHERE status = 'approved'
       AND (cooldown_until IS NULL OR cooldown_until < CURRENT_TIMESTAMP)
       AND contacted_at IS NULL
     LIMIT 10`
  ).all();

  for (const p of (prospects.results || [])) {
    try {
      // Create client record from prospect
      const id           = generateUUID();
      const slug         = await uniqueSlug(p.business_name, env);
      const manage_token = generateUUID();
      const referral_slug = slug.slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6);

      await env.DB.prepare(`
        INSERT INTO clients
          (id, business_name, slug, phone, industry, area, vibe, manage_token,
           referral_slug, status, source, package, retainer)
        VALUES (?,?,?,?,?,?,?,?,?,'lead','outbound','standard',?)
      `).bind(id, p.business_name, slug, p.phone || '', p.industry || '', p.area || '',
          'professional', manage_token, referral_slug, PRICING.standard.retainer).run();

      await env.DB.prepare(`UPDATE prospects SET status='built', client_id=?, contacted_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(id, p.id).run();

      // Queue outbound pre-build (with watermark)
      await env.BUILD_QUEUE.send({ type: 'pre_build', clientId: id, isOutbound: true });

    } catch (err) {
      console.error(`Cron: failed for prospect ${p.id}:`, err.message);
      await env.DB.prepare(`UPDATE prospects SET cooldown_until=datetime('now','+7 days') WHERE id=?`)
        .bind(p.id).run().catch(() => {});
    }
  }

  await logEvent(env, null, 'build', 'cron_complete', 'success', {
    metadata: { processed: prospects.results?.length || 0 }
  });
}

// ── D1 HELPERS ────────────────────────────────────────────────

async function getClientById(id, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE id=? LIMIT 1`).bind(id).first();
}

async function getClientByToken(token, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE manage_token=? LIMIT 1`).bind(token).first();
}

async function getClientBySlug(slug, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE slug=? LIMIT 1`).bind(slug).first();
}

async function updateClient(env, id, fields) {
  const cols = Object.keys(fields).map(k => `${k}=?`).join(',');
  const vals = Object.values(fields);
  await env.DB.prepare(`UPDATE clients SET ${cols}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(...vals, id).run();
}

async function createBuild(env, clientId, fields) {
  const result = await env.DB.prepare(
    `INSERT INTO builds (client_id, template_id, palette, status) VALUES (?,?,?,'building')`
  ).bind(clientId, fields.template_id || null, fields.palette || null).run();
  return result.meta?.last_row_id;
}

async function updateBuild(env, buildId, fields) {
  const cols = Object.keys(fields).map(k => `${k}=?`).join(',');
  const vals = Object.values(fields);
  await env.DB.prepare(`UPDATE builds SET ${cols} WHERE id=?`).bind(...vals, buildId).run();
}

async function logEvent(env, clientId, worker, eventType, status, opts = {}) {
  await env.DB.prepare(
    `INSERT INTO events (client_id, worker, event_type, status, duration_ms, error, metadata)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(
    clientId || null, worker, eventType, status,
    opts.durationMs || null, opts.error || null,
    opts.metadata ? JSON.stringify(opts.metadata) : null
  ).run().catch(e => console.warn('logEvent failed:', e.message));
}

async function recordVisit(env, clientId, page) {
  await env.DB.prepare(
    `INSERT INTO visits (client_id, date, page, count) VALUES (?,date('now'),?,1)
     ON CONFLICT(client_id, date, page) DO UPDATE SET count=count+1`
  ).bind(clientId, page).run().catch(() => {});
}

// ── UTILITIES ─────────────────────────────────────────────────

function generateUUID() {
  return crypto.randomUUID();
}

function slugify(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')  // remove special chars
    .trim()
    .replace(/\s+/g, '')           // join words — no hyphens
    .slice(0, 63);
}

async function uniqueSlug(name, env) {
  let slug = slugify(name);
  const existing = await env.DB.prepare(`SELECT slug FROM clients WHERE slug LIKE ? LIMIT 5`)
    .bind(slug + '%').all();
  if (!existing.results?.some(r => r.slug === slug)) return slug;
  return slug + '-' + Math.random().toString(36).slice(2, 6);
}

function pkgKey(pkg) {
  const p = (pkg || 'standard').toLowerCase().trim();
  if (p === 'express' || p === 'standard' || p === 'premium') return p;
  return 'standard';
}

function parseJson(raw) {
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return {};
  }
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function fireAndForget(fn) {
  fn().catch(e => console.warn('fireAndForget error:', e));
}

function siteNotFound(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0a0a0a;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.box{max-width:400px}h1{font-size:22px;margin-bottom:12px}p{color:rgba(240,237,232,0.55);line-height:1.6}a{color:#25D366;font-weight:700;text-decoration:none}</style></head><body><div class="box"><h1>Site not found</h1><p>The site <strong>${slug}</strong> doesn't exist yet.<br><br><a href="https://websitehub.co.za">Visit Website Hub →</a></p></div></body></html>`;
}
