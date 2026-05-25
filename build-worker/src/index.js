// ============================================================
// WEBSITE HUB — build-worker.js
// Owns the build pipeline, preview/live serving, outbound prospecting,
// admin endpoints, Unsplash fetching, QA, watermarking.
//
// ROUTES OWNED:
//   GET  /                          — serves preview SPA or landing
//   GET  preview.* / *              — site serving (hostname-routed)
//   POST /dropbox                   — cached Dropbox asset extraction
//   POST /claude                    — Claude API proxy
//   POST /intake                    — inbound lead → queued build (replaces /formspree-webhook)
//   POST /verify-pin                — PIN verification (kept for SPA compat)
//   GET  /build-status              — polling endpoint for verify page
//   POST /preview-choices           — save palette/photo/logo choices to D1
//   GET  /preview-meta              — preview panel data from D1
//   POST /bootstrap-preview-app     — push SPA HTML into KV
//   POST /bootstrap-templates       — load template HTML files into KV
//   POST /trigger-build             — admin manual trigger
//   POST /update-status             — admin status patch
//   POST /update-config             — admin flag/prospecting toggles
//   POST /outbound-prospect         — manual outbound trigger
//   POST /preview-revert            — restore preview from snapshot
//   GET  /check-domain              — registerdomain.co.za availability
//   GET  /domain-check              — alias kept for SPA backward compat
//   GET  /clients                   — admin dashboard data
//   GET  /health                    — service health JSON
//   GET  /analytics                 — manage panel analytics
//   GET  /referral-stats            — manage panel referral data
//   GET  /leaderboard               — live D1 leaderboard query
//   POST /admin/purge-test-data     — system reset
//
// HANDLERS:
//   fetch     — all routes above
//   scheduled — outbound prospecting cron at 11pm SAST (9pm UTC)
//   queue     — consumes BUILD_QUEUE; calls triggerBuildInternal
//
// SECRETS REQUIRED:
//   ANTHROPIC_KEY, META_WA_TOKEN, META_PHONE_NUMBER_ID, WH_PHONE,
//   ADMIN_KEY, UNSPLASH_ACCESS_KEY, GOOGLE_PLACES_API_KEY,
//   REGISTERDOMAIN_API_KEY, TURNSTILE_SECRET_KEY,
//   PAYFAST_MERCHANT_ID, PAYFAST_SANDBOX_MERCHANT_ID, RESEND_API_KEY
//
// REGISTERDOMAIN GAP (TODO):
//   Domain registration, hosting provisioning, and email account
//   creation are NOT yet implemented — RegisterDomain.co.za API
//   details are pending (see launch-worker). D1 fields are ready.
// ============================================================

import {
  PRICING, PACKAGE_CAPS, PREVIEW_EXPIRY_DAYS, PROSPECT_COOLDOWN_DAYS,
  isTestMode, packageKey, getPricingTier, getPackageCaps, buildPayFastLink,
  jsonResponse, corsResponse, htmlResponse,
  slugify, escapeHtml, uint8ArrayToBase64, getMime,
  safeInflate, currentMonthKey, todayDateString,
  resolveClaudeModel, callClaudeInternal,
  sendWhatsApp, queueScheduledMessage, normaliseSaPhone,
  logEvent, getFlag,
  detectArchetype, fetchTemplates, tokenReplace, buildExpressPage,
  createClient, getClientById, getClientBySlug, getClientByDomain, updateClient, queryClients,
  logMessage, hasMessageBeenSent,
  createBuild, updateBuild,
  getPhotosByIndustryVibe, savePhoto,
  recordVisit as d1RecordVisit, getMonthlyVisits,
  createReferral,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const MAX_ZIP_SIZE   = 25 * 1024 * 1024;
const MAX_IMAGES     = 12;
const PREVIEW_DOMAIN = 'preview.websitehub.co.za';
const WORKER_DOMAIN  = 'wh-build.pierreduplessis6912.workers.dev';

const PASS_1_MAX_TOKENS = 1500; // Brand intelligence — voice, mood, brief
const PASS_2_MAX_TOKENS = 3500; // Content generation — all template tokens
const PASS_3_MAX_TOKENS = 2000; // Quality review — refine and tighten

// Industry → vibe mapping (Layer 1 template selection)
const INDUSTRY_VIBE_MAP = {
  'Plumbing':             { default_vibe: 'bold_confident' },
  'Electrical':           { default_vibe: 'bold_confident' },
  'Construction':         { default_vibe: 'bold_confident' },
  'Cleaning':             { default_vibe: 'warm_friendly'  },
  'Beauty & Salon':       { default_vibe: 'warm_friendly'  },
  'Health & Wellness':    { default_vibe: 'earthy_natural' },
  'Food & Restaurant':    { default_vibe: 'warm_friendly'  },
  'Retail':               { default_vibe: 'bold_confident' },
  'Legal & Professional': { default_vibe: 'premium_minimal'},
  'Accounting':           { default_vibe: 'premium_minimal'},
  'Automotive':           { default_vibe: 'bold_confident' },
  'Real Estate':          { default_vibe: 'premium_minimal'},
  'Faith & Community':    { default_vibe: 'earthy_natural' },
  'Tech & IT':            { default_vibe: 'modern_tech'    },
  'Other':                { default_vibe: 'warm_friendly'  },
};

// ────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────

async function handleBootstrapStart(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);
  const html = await request.text();
  if (!html || html.length < 100) return jsonResponse({ error: 'Empty body' }, 400);
  await env.SITES.put('app:start-v2', html);
  return jsonResponse({ success: true, size: html.length });
}

export default {

  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const hostname = url.hostname;

    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    // API routes FIRST — before any hostname/site-serving logic
    const path = url.pathname;
    if (path === '/start')               return handleStart(request, url, env);
    if (path === '/health')              return handleHealth(env);
    if (path === '/intake' || path === '/formspree-webhook') return handleIntake(request, env, ctx);
    if (path === '/build-status')        return handleBuildStatus(request, url, env);
    if (path === '/verify-pin')          return handleVerifyPin(request, env, ctx);
    if (path === '/preview-choices')     return handlePreviewChoices(request, env);
    if (path === '/preview-meta')        return handlePreviewMeta(request, url, env);
    if (path === '/bootstrap-preview-app') return handleBootstrapPreviewApp(request, env);
    if (path === '/bootstrap-templates') return handleBootstrapTemplates(request, env);
    if (path === '/bootstrap-intake')    return handleBootstrapIntake(request, env);
  if (path === '/bootstrap-start') {
    try {
      if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
      if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);
      const html = await request.text();
      if (!html || html.length < 100) return jsonResponse({ error: 'Empty body' }, 400);
      await env.SITES.put('app:start-v2', html);
      return jsonResponse({ success: true, size: html.length });
    } catch(e) { return jsonResponse({ error: String(e), where: 'bootstrap-start' }, 500); }
  }

async function handleBootstrapIntake(request, env) {
  if (request.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const html = await request.text();
  if (!html || !html.includes('<!DOCTYPE'))
    return Response.json({ error: 'Invalid HTML — must be a full DOCTYPE document' }, { status: 400 });
  await env.SITES.put('app:intake-experience', html);
  return Response.json({ success: true, size: html.length });
}
    if (path === '/trigger-build')       return handleTriggerBuild(request, env, ctx);
    if (path === '/update-status')       return handleUpdateStatus(request, env);
    if (path === '/update-config')       return handleUpdateConfig(request, env);
    if (path === '/outbound-prospect')   return handleOutboundProspect(request, env, ctx);
    if (path === '/preview-revert')      return handlePreviewRevert(request, env);
    if (path === '/check-domain')        return handleCheckDomain(url, env);
    if (path === '/domain-check')        return handleDomainCheck(url, env);
    if (path === '/clients')             return handleListClients(request, env);
    if (path === '/analytics')           return handleAnalytics(request, url, env);
    if (path === '/referral-stats')      return handleReferralStats(request, url, env);
    if (path === '/leaderboard')         return handleLeaderboard(request, env);
    if (path === '/log-error')             return handleLogError(request, env);
    if (path === '/admin/purge-test-data') return handleAdminPurge(request, env);
    if (path === '/admin/reset-clients')   return handleResetClients(request, env);
    if (path === '/claude')              return handleClaude(request, env);
    if (path.startsWith('/dropbox'))     return handleDropbox(request, url, env, ctx);

    // Site serving — AFTER all API routes
    if (hostname === PREVIEW_DOMAIN) {
      if (url.pathname.endsWith('/raw/') || url.pathname.endsWith('/raw')) {
        return servePreviewRaw(url, env);
      }
      return servePreview(url, env);
    }
    if (hostname !== WORKER_DOMAIN && !hostname.endsWith('.workers.dev')) {
      return serveLiveSite(url, hostname, env);
    }

    // Remaining routes (duplicate checks removed — handled above)
    const _unused = path;

    if (path === '/dropbox')                return handleDropbox(request, url, env, ctx);
    if (path === '/claude')                 return handleClaude(request, env);
    if (path === '/intake')                 return handleIntake(request, env, ctx);
    if (path === '/formspree-webhook')      return handleIntake(request, env, ctx); // legacy alias
    if (path === '/verify-pin')             return handleVerifyPin(request, env, ctx);
    if (path === '/build-status')           return handleBuildStatus(request, url, env);
    if (path === '/preview-choices')        return handlePreviewChoices(request, env);
    if (path === '/preview-meta')           return handlePreviewMeta(request, url, env);
    if (path === '/bootstrap-preview-app')  return handleBootstrapPreviewApp(request, env);
    if (path === '/bootstrap-templates')    return handleBootstrapTemplates(request, env);
    if (path === '/trigger-build')          return handleTriggerBuild(request, env, ctx);
    if (path === '/update-status')          return handleUpdateStatus(request, env);
    if (path === '/update-config')          return handleUpdateConfig(request, env);
    if (path === '/outbound-prospect')      return handleOutboundProspect(request, env, ctx);
    if (path === '/preview-revert')         return handlePreviewRevert(request, env);
    if (path === '/check-domain')           return handleCheckDomain(url, env);
    if (path === '/domain-check')           return handleDomainCheck(url, env);
    if (path === '/clients')                return handleListClients(request, env);
    if (path === '/health')                 return handleHealth(env);
    if (path === '/analytics')              return handleAnalytics(request, url, env);
    if (path === '/referral-stats')         return handleReferralStats(request, url, env);
    if (path === '/leaderboard')            return handleLeaderboard(request, env);
    if (path === '/admin/purge-test-data')  return handleAdminPurge(request, env);

    return jsonResponse({ error: 'Not found', path }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledBuildCron(env));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const { clientId, paymentId, isOutbound, buildToken } = message.body;
      try {
        const slug = await triggerBuildInternal(clientId, paymentId, env, isOutbound);

        message.ack();
        await logEvent(env, 'build', 'build_complete', 'success', { clientId });

        if (buildToken) {
          await env.SITES.put(`build_status:${buildToken}`, JSON.stringify({
            status:     'ready',
            slug,
            previewUrl: `https://${PREVIEW_DOMAIN}/${slug}`,
          }), { expirationTtl: 3600 });
        }

      } catch (err) {
        console.error('Queue build failed:', err);

        await logEvent(env, 'build', 'build_failed', 'failure', {
          clientId,
          error: err.message,
        });

        if (buildToken) {
          await env.SITES.put(`build_status:${buildToken}`, JSON.stringify({
            status: 'error', error: err.message,
          }), { expirationTtl: 3600 });
        }

        // Reset client status to lead so they can retry
        if (clientId) {
          await updateClient(env, clientId, { status: 'lead' }).catch(() => {});
        }

        await sendWhatsApp(env.WH_PHONE,
          `❌ BUILD FAILED\nClient: ${clientId}\nError: ${err.message}`,
          env, { skipTestRedirect: true },
        ).catch(() => {});

        message.retry();
      }
    }
  },
};

// ============================================================
// SCHEDULED — outbound prospecting cron
// ============================================================

async function runScheduledBuildCron(env) {
  if (isTestMode(env)) {
    await logEvent(env, 'build', 'outbound_skipped', 'warning', { metadata: { reason: 'TEST_MODE' } });
    return;
  }
  if (!(await getFlag(env, 'OUTBOUND_ENABLED'))) {
    await logEvent(env, 'build', 'outbound_skipped', 'warning', { metadata: { reason: 'OUTBOUND_ENABLED=false' } });
    return;
  }
  await runOutboundCron(env, todayDateString());
}

// ============================================================
// SITE SERVING — KV-backed HTML hosting
// ============================================================

const VALID_PAGES = ['index', 'services', 'about', 'contact', 'gallery'];

async function servePreview(url, env) {
  const rawPath = url.pathname.replace(/^\//, '');
  const segment = rawPath.split('/')[0];

  // Serve the SPA for app entry points
  if (segment === 'experience') {
    const html = await env.SITES.get('app:intake-experience');
    if (html) return htmlResponse(html, 200);
    return htmlResponse('Phase 3 not bootstrapped', 404);
  }
  if (!rawPath || segment === 'verify' || segment === 'manage' || segment === 'build') {
    const appHtml = await env.SITES.get('app:preview-manage');
    if (appHtml) return htmlResponse(appHtml, 200);
    return htmlResponse(landingPage(), 200);
  }

  const slug     = segment;
  const subPath  = rawPath.split('/').slice(1).join('/');
  const pageName = VALID_PAGES.includes(subPath) ? subPath : 'index';

  // Preview expiry check
  const expiry = await env.SITES.get(`preview_expiry:${slug}`);
  if (expiry && new Date(expiry) < new Date()) {
    await env.SITES.put(`portfolio_candidate:${slug}`, expiry);
    await env.SITES.delete(`preview:${slug}`);
    for (const p of VALID_PAGES) {
      await env.SITES.delete(`preview:${slug}:${p}`).catch(() => {});
    }
    return htmlResponse(expiredPreviewPage(slug), 410);
  }

  let html = await env.SITES.get(`preview:${slug}:${pageName}`);
  if (!html && pageName === 'index') html = await env.SITES.get(`preview:${slug}`);

  if (!html && pageName === 'gallery') return htmlResponse(galleryUpgradePromptPage(slug, env), 200);
  if (!html) return htmlResponse(notFoundPage(slug), 404);

  // Fire-and-forget D1 visit record
  fireAndForget(() => recordVisitD1(env, slug, pageName));

  return htmlResponse(html, 200);
}

async function serveLiveSite(url, hostname, env) {
  // D1 suspended check — replaces old KV `suspended:${hostname}` key
  const client = await getClientByDomain(env, hostname).catch(() => null);
  if (client?.status === 'suspended') return htmlResponse(suspendedPage(hostname), 402);

  const rawPath  = url.pathname.replace(/^\//, '');
  const subPath  = rawPath.split('/')[0] || '';
  const pageName = VALID_PAGES.includes(subPath) ? subPath : 'index';

  let html = await env.SITES.get(`live:${hostname}:${pageName}`);
  if (!html && pageName === 'index') html = await env.SITES.get(`live:${hostname}`);

  if (!html && pageName === 'gallery') return htmlResponse(galleryUpgradePromptPage(hostname, env), 200);
  if (!html) return htmlResponse(notFoundPage(hostname), 404);

  // Fire-and-forget D1 visit record
  if (client?.id) fireAndForget(() => d1RecordVisit(env, client.id, pageName));

  return htmlResponse(html, 200);
}

/** Background D1 visit record by slug (for preview serving where we may not have clientId). */
async function recordVisitD1(env, slug, pageName) {
  try {
    const client = await getClientBySlug(env, slug);
    if (client?.id) await d1RecordVisit(env, client.id, pageName);
  } catch { /* non-fatal */ }
}

/** Fire-and-forget wrapper — swallows errors, doesn't block response. */
function fireAndForget(fn) {
  fn().catch(e => console.warn('fireAndForget error:', e?.message || e));
}

async function servePreviewRaw(url, env) {
  const parts = url.pathname.replace(/\/raw\/?$/, '').split('/').filter(Boolean);
  const slug  = parts[0];
  if (!slug) return htmlResponse('<p>No slug</p>', 400);

  const page = url.searchParams.get('page') || 'index';
  let html   = await env.SITES.get(`preview:${slug}:${page}`);
  if (!html) html = await env.SITES.get(`preview:${slug}`);
  if (!html) return htmlResponse('<p>Preview not found</p>', 404);

  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'X-Frame-Options': 'SAMEORIGIN' },
  });
}

// ============================================================
// ROUTE: /dropbox — cached Dropbox asset extraction
// ============================================================

async function handleDropbox(request, url, env, ctx) {
  const dropboxUrl = url.searchParams.get('url');
  if (!dropboxUrl || !dropboxUrl.includes('dropbox.com')) {
    return jsonResponse({ error: 'Missing or invalid Dropbox URL' }, 400);
  }

  const cache    = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const cached   = await cache.match(cacheKey);
  if (cached) return cached;

  const dlUrl = dropboxUrl
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    .replace('?dl=0', '').replace('?dl=1', '');

  let arrayBuffer;
  try {
    const res = await fetch(dlUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return jsonResponse({ error: `Dropbox fetch failed: ${res.status}` }, 502);
    const contentLength = parseInt(res.headers.get('Content-Length') || '0', 10);
    if (contentLength > MAX_ZIP_SIZE) return jsonResponse({ error: 'File too large (max 25MB)' }, 413);
    arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_ZIP_SIZE) return jsonResponse({ error: 'File too large (max 25MB)' }, 413);
  } catch (e) {
    return jsonResponse({ error: `Network error: ${e.message}` }, 502);
  }

  let images = [];
  try { images = await extractImagesFromZip(arrayBuffer); } catch (e) { console.warn('ZIP extraction failed:', e); }

  const payload  = JSON.stringify({ images, count: images.length });
  const response = new Response(payload, {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':               'public, max-age=3600',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// ROUTE: /claude — Claude API proxy
// ============================================================

async function handleClaude(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return jsonResponse(data, res.status);
}

// ============================================================
// ROUTE: /intake — inbound lead → D1 → queued build
// Replaces /formspree-webhook. Direct POST with Turnstile protection.
// ============================================================

async function handleIntake(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  // Turnstile spam protection
  const turnstileToken = body['cf-turnstile-response'] || body['turnstile_token'];
  if (turnstileToken && env.TURNSTILE_SECRET_KEY) {
    try {
      const tv = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret:   env.TURNSTILE_SECRET_KEY,
          response: turnstileToken,
        }),
      });
      const td = await tv.json();
      if (!td.success) {
        await logEvent(env, 'build', 'intake_blocked', 'warning', { metadata: { reason: 'turnstile_failed' } });
        return jsonResponse({ error: 'Spam check failed. Please try again.' }, 400);
      }
    } catch (e) {
      console.warn('Turnstile check failed (non-fatal):', e?.message);
      // Fail open — don't block legitimate users if Turnstile is down
    }
  }

  // Map intake form fields to D1 schema
  const pkgRaw  = body['package'] || body['Package'] || 'standard';
  const pkg     = packageKey(pkgRaw);
  const tier    = PRICING[pkg];

  const clientFields = {
    business_name:      body['business_name']  || body['Business Name'] || '',
    client_name:        body['client_name']    || body['Client Name']   || '',
    phone:              normaliseSaPhone(body['phone'] || body['WhatsApp'] || ''),
    email:              body['email']          || body['Email']         || '',
    industry:           body['industry']       || body['Industry']      || 'Other',
    area:               body['area']           || body['Area']          || '',
    vibe:               body['vibe']           || body['Vibe']          || 'bold_confident',
    services:           typeof body['services'] === 'object'
                          ? JSON.stringify(body['services'])
                          : (body['services'] || body['Services'] || ''),
    primary_cta:        body['primary_cta']    || 'whatsapp_us',
    target_audience:    body['target_audience'] || 'everyone',
    about:              (body['about']         || body['About']         || '').slice(0, 200),
    differentiator:     (body['differentiator'] || '').slice(0, 150),
    testimonial:        body['testimonial']    || '',
    instagram:          body['instagram']      || '',
    facebook:           body['facebook']       || '',
    tiktok:             body['tiktok']         || '',
    referral_code_used: body['referral_code']  || body['referral'] || '',
    status:             'lead',
    source:             'website',
    package:            pkg,
    retainer:           tier.retainer,
  };

  if (!clientFields.business_name || !clientFields.phone) {
    return jsonResponse({ error: 'Missing required fields: business_name, phone' }, 400);
  }

  let clientId, slug;
  try {
    const result = await createClient(env, clientFields);
    clientId = result.id;
    slug     = result.slug;
  } catch (err) {
    await logEvent(env, 'build', 'intake_failed', 'failure', { error: err.message });
    return jsonResponse({ error: `Client creation failed: ${err.message}` }, 500);
  }

  // Referral attribution
  if (clientFields.referral_code_used) {
    try {
      const referrer = await getClientBySlug(env, clientFields.referral_code_used);
      if (referrer?.id) await createReferral(env, referrer.id, clientId);
    } catch { /* non-fatal */ }
  }

  await logEvent(env, 'build', 'lead_created', 'success', { clientId, metadata: { business: clientFields.business_name } });

  const token    = crypto.randomUUID().replace(/-/g, '');
  const name     = clientFields.client_name?.split(' ')[0] || 'there';
  const buildUrl = `https://${PREVIEW_DOMAIN}/build/${token}`;

  await env.SITES.put(`build_status:${token}`, JSON.stringify({ status: 'building', slug }), { expirationTtl: 3600 });

  await env.SITES.put(`build_status:${token}`, JSON.stringify({ status: 'building', slug }));
  await env.BUILD_QUEUE.send({ clientId, paymentId: null, isOutbound: false, buildToken: token });

  await sendWhatsApp(clientFields.phone,
    `🔨 Hi ${name}! We're building your *${clientFields.business_name}* website right now.\n\nWe'll send you the link the moment it's ready — usually about 2 minutes. Sit tight!\n\n_Watch it build: ${buildUrl}_\n— Website Hub`,
    env);

  await sendEmail({
    to: clientFields.email,
    subject: `Your ${clientFields.business_name} website is being built ✓`,
    touchpoint: 'intake_confirmation',
    clientSlug: slug,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#111">Building your website now 🔨</h2>
      <p>Hi ${name},</p>
      <p>We've received your details for <strong>${clientFields.business_name}</strong> and the build has started. You'll get a link to your preview the moment it's ready — usually about 2 minutes.</p>
      <p style="margin:24px 0"><a href="${buildUrl}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Watch Your Build</a></p>
      <p style="color:#888;font-size:12px">— Website Hub</p>
    </div>`,
  }, env).catch(() => {});

  await sendWhatsApp(env.WH_PHONE,
    `🆕 INBOUND LEAD: ${clientFields.business_name}\nPackage: ${pkg}\nClient: ${clientFields.client_name}\nReferral: ${clientFields.referral_code_used || 'None'}\nID: ${clientId}\nBuild: ${buildUrl}`,
    env, { skipTestRedirect: true });

  return jsonResponse({ success: true, token, redirectUrl: `https://preview.websitehub.co.za/manage/${token}`, redirect: buildUrl, clientId });
}

// ============================================================
// ROUTE: /verify-pin — kept for SPA backward compat
// ============================================================

async function handleVerifyPin(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { token, pin } = body;
  if (!token || !pin) return jsonResponse({ error: 'Missing token or pin' }, 400);

  const raw = await env.SITES.get(`session:${token}`);
  if (!raw) return jsonResponse({ error: 'Session expired or not found' }, 404);

  const session = JSON.parse(raw);
  if (Date.now() > session.expires) {
    await env.SITES.delete(`session:${token}`);
    return jsonResponse({ error: 'PIN expired — please request a new one' }, 410);
  }
  if (String(pin).trim() !== String(session.pin)) {
    return jsonResponse({ error: 'Incorrect PIN' }, 401);
  }

  await env.SITES.delete(`session:${token}`);
  const slug = slugify(session.clientId || session.business_name || 'site');

  await env.SITES.put(`build_status:${token}`, JSON.stringify({ status: 'building', slug }), { expirationTtl: 3600 });

  await env.BUILD_QUEUE.send({
    clientId:   session.clientId,
    paymentId:  null,
    isOutbound: false,
    buildToken: token,
  });

  return jsonResponse({ success: true, slug });
}

// ============================================================
// ROUTE: /build-status — polling endpoint for SPA build screen
// ============================================================

async function handleBuildStatus(request, url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);
  const raw = await env.SITES.get(`build_status:${token}`);
  const data = raw ? JSON.parse(raw) : {};
  if (data.status === 'ready') return jsonResponse(data);
  // Fallback: check D1 directly
  if (data.slug) {
    try {
      const client = await env.DB.prepare('SELECT status, slug FROM clients WHERE slug = ? LIMIT 1').bind(data.slug).first();
      if (client?.status === 'preview_ready') {
        const result = { status: 'ready', slug: data.slug, previewUrl: `https://preview.websitehub.co.za/${data.slug}` };
        await env.SITES.put(`build_status:${token}`, JSON.stringify(result), { expirationTtl: 3600 });
        return jsonResponse(result);
      }
    } catch(e) {}
  }
  return raw ? jsonResponse(data) : jsonResponse({ status: 'building' });
}

// ============================================================
// ROUTE: /preview-choices — save SPA panel selections to D1
// ============================================================

async function handlePreviewChoices(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { slug, palette, logo_url, clientId } = body;
  if (!slug && !clientId) return jsonResponse({ error: 'Missing slug or clientId' }, 400);

  // Resolve clientId from slug if not provided
  let id = clientId;
  if (!id && slug) {
    const client = await getClientBySlug(env, slug).catch(() => null);
    id = client?.id;
  }

  const updates = {};
  if (palette)  updates.palette  = palette;
  if (logo_url) updates.logo_url = logo_url;

  if (id && Object.keys(updates).length > 0) {
    await updateClient(env, id, updates);
  }

  return jsonResponse({ success: true, slug });
}

// ============================================================
// ROUTE: /preview-meta — preview panel data for SPA
// ============================================================

async function handlePreviewMeta(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const client = await getClientBySlug(env, slug).catch(() => null);
  if (!client) return jsonResponse({ error: 'Not found' }, 404);

  const pkg  = client.package || 'standard';
  const tier = PRICING[packageKey(pkg)];

  // Extract hero photos from current draft for the panel's photo picker
  const draft = await env.SITES.get(`draft:${slug}`).catch(() => null);
  const heroPhotoUrls = [];
  if (draft) {
    const matches = draft.matchAll(/<img[^>]+src="(https:\/\/images\.unsplash\.com[^"]+)"/gi);
    for (const m of matches) {
      const u = m[1].split('?')[0] + '?w=400&q=60&auto=format';
      if (!heroPhotoUrls.includes(u)) heroPhotoUrls.push(u);
      if (heroPhotoUrls.length >= 5) break;
    }
  }

  const TAGLINES = {
    restaurant:   ['Real food. Real people.', 'Made fresh, every day.', 'Your table is waiting.'],
    cleaning:     ['Spotless every time.', 'Clean spaces, clear minds.', 'We take the mess off your hands.'],
    construction: ['Built to last.', 'Quality work, on time.', 'From foundation to finish.'],
    automotive:   ['Your car, our craft.', 'Expert care every time.', 'We keep you moving.'],
    hair:         ['Look good, feel great.', 'Style that speaks for itself.', 'Your look, perfected.'],
    salon:        ['Beauty done right.', 'Where confidence begins.', 'You deserve the best.'],
    fitness:      ['Train hard. Live better.', 'Your strongest self starts here.', 'Results that last.'],
    medical:      ['Your health, our priority.', 'Caring for the community.', 'Professional care, personal touch.'],
    dental:       ['Healthy smiles, happy lives.', 'Your smile is our business.', 'Gentle care, great results.'],
    estate:       ['Find your perfect home.', 'Property done properly.', 'Your next chapter starts here.'],
    plumbing:     ['We fix it right, first time.', 'Fast, reliable, professional.', 'No job too big or small.'],
    electrical:   ['Wired for excellence.', 'Safe, certified, reliable.', 'Powering your home right.'],
    default:      ['Built for your community.', 'Serving you with pride.', 'Quality you can trust.'],
  };
  const industry     = (client.industry || 'default').toLowerCase();
  const taglineKey   = Object.keys(TAGLINES).find(k => industry.includes(k)) || 'default';

  return jsonResponse({
    clientId:     client.id,
    slug,
    package:      pkg,
    buildFee:     tier.build,
    retainer:     tier.retainer,
    businessName: client.business_name || '',
    industry:     client.industry      || '',
    area:         client.area          || '',
    domain:       client.domain        || `${slug}.co.za`,
    heroPhotos:   heroPhotoUrls,
    taglines:     TAGLINES[taglineKey],
    manageToken:  client.manage_token  || null,
  });
}

// ============================================================
// ROUTE: /bootstrap-templates
// ============================================================

async function handleBootstrapTemplates(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { archetype, page, html } = body;
  const validArchetypes = ['emergency', 'trust', 'experience', 'local', 'results'];
  const validPages      = ['css', 'index', 'services', 'about', 'contact', 'p5'];

  if (!validArchetypes.includes(archetype))
    return jsonResponse({ error: `Invalid archetype. Must be one of: ${validArchetypes.join(', ')}` }, 400);
  if (!validPages.includes(page))
    return jsonResponse({ error: `Invalid page. Must be one of: ${validPages.join(', ')}` }, 400);
  if (!html || typeof html !== 'string')
    return jsonResponse({ error: 'Missing or invalid html field' }, 400);

  const key = `template:${archetype}:${page}`;
  await env.SITES.put(key, html);
  await logEvent(env, 'build', 'template_bootstrapped', 'success', { metadata: { archetype, page, key, size: html.length } });

  return jsonResponse({ success: true, key, archetype, page, size: html.length });
}

// ============================================================
// ROUTE: /bootstrap-preview-app
// ============================================================

async function handleBootstrapPreviewApp(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  const html = await request.text();
  if (!html || !html.includes('<!DOCTYPE'))
    return jsonResponse({ error: 'Invalid HTML — must be a full DOCTYPE document' }, 400);

  await env.SITES.put('app:preview-manage', html);
  await logEvent(env, 'build', 'spa_bootstrapped', 'success', { metadata: { size: html.length } });
  return jsonResponse({ success: true, size: html.length });
}

// ============================================================
// ROUTE: /trigger-build — admin manual trigger
// ============================================================

async function handleTriggerBuild(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const allowedStatuses = ['lead', 'building', 'preview_ready', 'qa_ready', 'live'];
  if (!allowedStatuses.includes(client.status)) {
    return jsonResponse({ error: `Build blocked — status is "${client.status}"` }, 403);
  }

  await updateClient(env, clientId, { status: 'building' });
  await logEvent(env, 'build', 'build_triggered', 'success', { clientId, metadata: { source: 'admin' } });
  await sendWhatsApp(env.WH_PHONE,
    `🔨 BUILD STARTED: ${client.business_name} (${client.package})`,
    env, { skipTestRedirect: true });

  await env.BUILD_QUEUE.send({ clientId, paymentId: null, isOutbound: false });
  return jsonResponse({ success: true, clientId });
}

// ============================================================
// ROUTE: /update-status — admin status patch
// ============================================================

async function handleUpdateStatus(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, status, ...extra } = body;
  if (!clientId || !status) return jsonResponse({ error: 'Missing clientId or status' }, 400);

  await updateClient(env, clientId, { status, ...extra });
  return jsonResponse({ success: true });
}

// ============================================================
// ROUTE: /update-config — feature flags + prospecting config
// ============================================================

async function handleUpdateConfig(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const flagMap = {
    outbound_enabled:                 'config:outbound_enabled',
    referral_enabled:                 'config:referral_enabled',
    vision_enabled:                   'config:vision_enabled',
    'flag:outbound_enabled':          'config:outbound_enabled',
    'flag:referral_enabled':          'config:referral_enabled',
    'flag:vision_enabled':            'config:vision_enabled',
    'flag:vision_validation_enabled': 'config:vision_enabled',
  };
  for (const [bodyKey, kvKey] of Object.entries(flagMap)) {
    if (body[bodyKey] !== undefined) await env.SITES.put(kvKey, String(body[bodyKey]));
  }

  const existing = JSON.parse(await env.SITES.get('config:outbound').catch(() => null) || '{}');
  const merged = {
    daily_volume: body.daily_volume ?? existing.daily_volume ?? 10,
    mode:         body.mode         ?? existing.mode         ?? 'manual',
    provinces:    body.provinces    ?? existing.provinces    ?? [],
    industries:   body.industries   ?? existing.industries   ?? [],
  };
  if (merged.provinces && !Array.isArray(merged.provinces)) {
    merged.provinces = Object.entries(merged.provinces).filter(([, v]) => v === true).map(([k]) => k);
  }
  if (merged.industries && !Array.isArray(merged.industries)) {
    merged.industries = Object.entries(merged.industries).filter(([, v]) => v === true).map(([k]) => k);
  }

  await env.SITES.put('config:outbound', JSON.stringify(merged));
  await logEvent(env, 'build', 'config_updated', 'success', { metadata: merged });
  return jsonResponse({ success: true, config: merged });
}

// ============================================================
// ROUTE: /outbound-prospect — manual outbound trigger
// ============================================================

async function handleOutboundProspect(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  if (isTestMode(env)) return jsonResponse({ error: 'Outbound disabled in TEST_MODE' }, 403);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { businessName, phone, industry, area, about, services } = body;
  if (!businessName || !phone) return jsonResponse({ error: 'Missing businessName or phone' }, 400);

  const intl = normaliseSaPhone(phone);

  // Opt-out check via D1
  const existing = await env.DB.prepare(
    `SELECT id, opted_out, status FROM clients WHERE phone = ? LIMIT 1`
  ).bind(intl).first().catch(() => null);

  if (existing?.opted_out) return jsonResponse({ error: 'Number opted out' }, 403);

  // Cooldown check via D1 prospects table
  const cooldownProspect = await env.DB.prepare(
    `SELECT cooldown_until FROM prospects WHERE phone = ? AND cooldown_until > datetime('now') LIMIT 1`
  ).bind(intl).first().catch(() => null);

  if (cooldownProspect) return jsonResponse({ error: 'In cooldown period' }, 403);

  const slug   = slugify(businessName);
  const domain = `${slug}.co.za`;
  const domainStatus = await checkDomainAvailabilityInternal(domain, env);

  // Insert prospect record
  await env.DB.prepare(
    `INSERT INTO prospects (business_name, slug, phone, industry, area, about, services, status, contacted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
  ).bind(businessName, slug, intl, industry || '', area || '', about || '', services || '').run().catch(() => {});

  await env.BUILD_QUEUE.send({
    clientId:   null,
    paymentId:  null,
    isOutbound: true,
    outboundFields: {
      business_name: businessName, phone: intl, industry: industry || '',
      area: area || '', about: about || '', services: services || '',
      package: 'standard', retainer: PRICING.standard.retainer,
      status: 'lead', source: 'outbound', domain, slug,
    },
  });

  await logEvent(env, 'build', 'prospect_contacted', 'success', { metadata: { business: businessName, phone: intl } });
  return jsonResponse({ success: true, domain, domainStatus });
}

// ============================================================
// ROUTE: /preview-revert
// ============================================================

async function handlePreviewRevert(request, env) {
  const { slug } = await request.json().catch(() => ({}));
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const original = await env.SITES.get(`preview-original:${slug}`);
  if (!original) return jsonResponse({ error: 'No original found' }, 404);

  await env.SITES.put(`preview:${slug}`, original);
  return jsonResponse({ success: true });
}

// ============================================================
// ROUTE: /check-domain + /domain-check
// ============================================================

  async function handleCheckDomain(url, env) {
  const domain = url.searchParams.get('domain')?.toLowerCase().trim();
  if (!domain) return jsonResponse({ error: 'Missing domain' }, 400);

  const slug = domain.replace(/\.co\.za$/, '');

  if (env.REGISTERDOMAIN_API_KEY) {
    try {
      const res = await fetch(
        `https://api.registerdomain.co.za/v2/domain/check?domain=${encodeURIComponent(domain)}&apikey=${env.REGISTERDOMAIN_API_KEY}`,
        { headers: { 'Accept': 'application/json' } },
      );
      if (res.ok) {
        const data      = await res.json();
        const available = data.available === true || data.status === 'available';
        const alternatives = available ? [] : [`${slug}-pta.co.za`, `${slug}-sa.co.za`, `${slug}online.co.za`];
        return jsonResponse({ available, domain, alternatives });
      }
    } catch { /* fall through to WHOIS */ }
  }

  const result = await checkDomainAvailabilityWhois(domain);
  return jsonResponse({ ...result, alternatives: result.available === false
    ? [`${slug}-pta.co.za`, `${slug}-sa.co.za`, `${slug}online.co.za`]
    : [], fallback: true });
}

async function handleDomainCheck(url, env) {
  const name = url.searchParams.get('name') || '';
  const sld  = name.replace(/\.co\.za$/i,'').replace(/[^a-z0-9-]/gi,'-').toLowerCase().replace(/^-+|-+$/g,'');
  if (!sld) return jsonResponse({ error: 'Invalid domain name' }, 400);
  const domain = sld + '.co.za';
  const secret = env.DOMAIN_PROXY_SECRET || '';
  try {
    const res  = await fetch('https://websitehub.co.za/domain-proxy.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': secret },
      body: JSON.stringify({ action: 'CheckAvailability', sld, tld: 'co.za' }),
    });
    const data = await res.json();
    const available = data.available === true || data.result === 'available' || data.status === 'available';
    const taken     = data.available === false || data.result === 'taken' || data.result === 'registered';
    const suggestions = available || taken ? [] : [];
    if (taken) {
      const alts = [sld+'-sa', sld+'-za', 'my-'+sld];
      return jsonResponse({ domain, available: false, suggestions: alts });
    }
    if (available) return jsonResponse({ domain, available: true, suggestions: [] });
    return jsonResponse({ domain, available: null, raw: data });
  } catch(e) {
    return jsonResponse({ domain, available: null, error: e.message });
  }
}

async function checkDomainAvailabilityWhois(domain) {
  try {
    const res  = await fetch(`https://www.whois.com/whois/${domain}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
    const text = await res.text();
    const taken = text.includes('Domain Name:') || text.includes('Registrant');
    const avail = text.includes('No match for') || text.includes('NOT FOUND') || text.includes('is available');
    if (taken) return { domain, available: false };
    if (avail) return { domain, available: true };
    return { domain, available: null, error: 'Could not determine' };
  } catch (e) {
    return { domain, available: null, error: e.message };
  }
}

async function checkDomainAvailabilityInternal(domain, env) {
  if (env.REGISTERDOMAIN_API_KEY) {
    try {
      const res = await fetch(
        `https://api.registerdomain.co.za/v2/domain/check?domain=${encodeURIComponent(domain)}&apikey=${env.REGISTERDOMAIN_API_KEY}`,
      );
      if (res.ok) {
        const data = await res.json();
        return { available: data.available === true || data.status === 'available' };
      }
    } catch { /* fall through */ }
  }
  return checkDomainAvailabilityWhois(domain);
}

const DOMAIN_PROXY_URL = 'https://websitehub.co.za/domain-proxy.php';

async function callDomainProxy(action, sld, tld = 'co.za', extra = {}, env) {
  const secret = env.DOMAIN_PROXY_SECRET || '';
  try {
    const res  = await fetch(DOMAIN_PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': secret },
      body:    JSON.stringify({ action, sld, tld, ...extra }),
    });
    const data = await res.json();
    await logEvent(env, 'build', 'domain_proxy', res.ok ? 'success' : 'failure', { error: data?.error });
    return data;
  } catch (e) {
    await logEvent(env, 'build', 'domain_proxy', 'failure', { error: e.message });
    throw e;
  }
}

// ============================================================
// ROUTE: /clients — admin dashboard data
// ============================================================

async function handleListClients(request, env) {
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  try {
    const result = await env.DB.prepare(
      `SELECT id, business_name, slug, package, status, retainer, go_live_date,
          next_invoice_date, domain, phone, channel, created_at, manage_token
    FROM clients ORDER BY created_at DESC LIMIT 200`
    ).all();

    const clients = result?.results || [];

    // Recent events as health proxy
    const recentEvents = await env.DB.prepare(
      `SELECT worker, event_type, status, created_at, metadata FROM events
       ORDER BY created_at DESC LIMIT 50`
    ).all().then(r => r?.results || []).catch(() => []);

    return jsonResponse({ clients, recentEvents, testMode: isTestMode(env) });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ============================================================
// ROUTE: /health
// ============================================================

async function handleHealth(env) {
  // Check D1 connectivity
  let d1Status = 'unknown';
  try {
    await env.DB.prepare('SELECT 1').first();
    d1Status = 'ok';
  } catch { d1Status = 'error'; }

  const recentEvents = await env.DB.prepare(
    `SELECT worker, event_type, status, created_at, metadata FROM events
     ORDER BY created_at DESC LIMIT 10`
  ).all().then(r => r?.results || []).catch(() => []);

  return jsonResponse({ d1: d1Status, recentEvents, timestamp: new Date().toISOString(), testMode: isTestMode(env) });
}

// ============================================================
// ROUTE: /analytics — manage panel analytics from D1
// ============================================================

async function handleAnalytics(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const client = await getClientBySlug(env, slug).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const monthStr     = currentMonthKey();
  const prevDate     = new Date(); prevDate.setMonth(prevDate.getMonth() - 1);
  const prevMonthStr = prevDate.toISOString().slice(0, 7);

  const [thisMonthRows, lastMonthRows] = await Promise.all([
    getMonthlyVisits(env, client.id, monthStr),
    getMonthlyVisits(env, client.id, prevMonthStr),
  ]);

  const thisMonth = thisMonthRows.reduce((sum, r) => sum + (r.total || 0), 0);
  const lastMonth = lastMonthRows.reduce((sum, r) => sum + (r.total || 0), 0);

  const perPage = {};
  for (const row of thisMonthRows) {
    perPage[row.page] = row.total || 0;
  }

  const topPage = Object.entries(perPage).sort(([, a], [, b]) => b - a)[0]?.[0] || 'index';

  return jsonResponse({
    views_this_month: thisMonth,
    views_last_month: lastMonth,
    top_page:         topPage,
    per_page:         perPage,
    whatsapp_taps:    client.monthly_wa_taps || 0,
  });
}

// ============================================================
// ROUTE: /referral-stats — from D1 referrals table
// ============================================================

async function handleReferralStats(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const client = await getClientBySlug(env, slug).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const stats = await env.DB.prepare(
    `SELECT
       COUNT(*) as total_referrals,
       SUM(CASE WHEN status = 'vested' THEN 1 ELSE 0 END) as vested,
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending
     FROM referrals WHERE referrer_client_id = ?`
  ).bind(client.id).first().catch(() => ({ total_referrals: 0, vested: 0, pending: 0 }));

  // Leaderboard position via live query
  let position = null;
  try {
    const board = await env.DB.prepare(
      `SELECT referrer_client_id, COUNT(*) as conversions
       FROM referrals WHERE status = 'vested'
       GROUP BY referrer_client_id ORDER BY conversions DESC LIMIT 10`
    ).all();
    const idx = (board?.results || []).findIndex(r => r.referrer_client_id === client.id);
    if (idx >= 0) position = idx + 1;
  } catch { /* leave as null */ }

  return jsonResponse({
    total_referrals:  stats?.total_referrals || 0,
    vested:           stats?.vested          || 0,
    pending:          stats?.pending         || 0,
    position,
    reward_months:    stats?.vested          || 0,
  });
}

// ============================================================
// ROUTE: /leaderboard — live D1 query (no KV cache needed)
// ============================================================

async function handleLeaderboard(request, env) {
  try {
    const board = await env.DB.prepare(
      `SELECT r.referrer_client_id, COUNT(*) as conversions, c.referral_display_name
       FROM referrals r
       LEFT JOIN clients c ON c.id = r.referrer_client_id
       WHERE r.status = 'vested'
       GROUP BY r.referrer_client_id
       ORDER BY conversions DESC LIMIT 10`
    ).all();

    const results = (board?.results || []).map((r, i) => ({
      position:  i + 1,
      slug:      (r.referral_display_name || r.referrer_client_id.slice(0, 6) + '***'),
      referrals: r.conversions,
    }));
    return jsonResponse(results);
  } catch {
    return jsonResponse([]);
  }
}

// ============================================================
// ROUTE: /admin/reset-clients
async function handleResetClients(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);
  const result = await env.DB.prepare('DELETE FROM clients').run();
  await env.DB.prepare('DELETE FROM events').run();
  await env.DB.prepare('DELETE FROM builds').run();
  await env.DB.prepare('DELETE FROM messages').run();
  await logEvent(env, 'build', 'admin_reset_clients', 'success', { metadata: { deleted: result.changes } });
  return jsonResponse({ success: true, message: 'clients, events, builds, messages cleared' });
}

// ROUTE: /admin/purge-test-data
// ============================================================

async function handleAdminPurge(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  // KV cleanup — delete all non-live preview/draft/content keys
  const liveClients = await env.DB.prepare(
    `SELECT slug FROM clients WHERE status = 'live'`
  ).all().then(r => r?.results || []).catch(() => []);

  const keepSlugs = new Set(liveClients.map(r => r.slug).filter(Boolean));

  const slugPrefixes = [
    'preview:', 'preview-original:', 'preview_expiry:',
    'draft:', 'content:', 'visits:', 'portfolio_candidate:',
  ];

  let scanned = 0, deleted = 0, kept = 0;

  for (const prefix of slugPrefixes) {
    let cursor;
    do {
      const page = await env.SITES.list({ prefix, cursor }).catch(() => ({ keys: [] }));
      for (const k of page.keys) {
        scanned++;
        const slug = k.name.slice(prefix.length).split(':')[0];
        if (keepSlugs.has(slug)) { kept++; continue; }
        await env.SITES.delete(k.name).catch(() => {});
        deleted++;
      }
      cursor = page.cursor;
      if (page.list_complete) break;
    } while (cursor);
  }

  // Clear test logs
  let testCursor;
  do {
    const page = await env.SITES.list({ prefix: 'test_log:', cursor: testCursor }).catch(() => ({ keys: [] }));
    for (const k of page.keys) { await env.SITES.delete(k.name).catch(() => {}); deleted++; }
    testCursor = page.cursor;
    if (page.list_complete) break;
  } while (testCursor);

  // Force fresh model resolution
  await env.SITES.delete('system:claude_model').catch(() => {});
  deleted++;

  await logEvent(env, 'build', 'admin_purge', 'success', {
    metadata: { scanned, deleted, kept, liveCount: keepSlugs.size },
  });
  return jsonResponse({ success: true, scanned, deleted, kept, liveSlugs: [...keepSlugs] });
}

// ============================================================
// INDUSTRY MATRIX — creative brief lookup
// ============================================================

const INDUSTRY_MATRIX = {
  plumbing: {
    aesthetic: 'bold_modern',
    palette: { bg: '#0d1117', surface: '#161b22', accent: '#f97316', text: '#f0f0f0', muted: '#8b949e' },
    fonts: { display: 'Syne', body: 'DM Sans' },
    mood: 'reliable, urgent, no-nonsense',
    copyStyle: 'Direct. Short sentences. Strong action verbs. Urgency without panic. SA working-class warmth.',
    vibeWords: ['Fast', 'Reliable', 'Licensed', 'Emergency', 'Trusted'],
    heroImage: 'plumber pipes tools professional south africa',
    trustSignals: ['Licensed & Insured', '24/7 Emergency', 'Upfront Quotes', 'Local & Trusted'],
    emotionalRegister: 'Calm confidence. We fix problems fast. No drama.',
  },
  electrical: {
    aesthetic: 'bold_modern',
    palette: { bg: '#0a0e1a', surface: '#111827', accent: '#eab308', text: '#f9fafb', muted: '#9ca3af' },
    fonts: { display: 'Bebas Neue', body: 'Inter' },
    mood: 'precise, safety-first, authoritative',
    copyStyle: 'Technical credibility made simple. Safety without fear. Certifications mentioned naturally.',
    vibeWords: ['Certified', 'Safe', 'Precise', 'Compliant', 'Professional'],
    heroImage: 'electrician work south africa electrical panel',
    trustSignals: ['COC Certified', 'Fully Insured', 'SANS Compliant', 'Free Inspection'],
    emotionalRegister: "Expert and calm. We know what we're doing so you don't have to worry.",
  },
  cleaning: {
    aesthetic: 'soft_organic',
    palette: { bg: '#f8fafc', surface: '#ffffff', accent: '#06b6d4', text: '#1e293b', muted: '#64748b' },
    fonts: { display: 'Playfair Display', body: 'Lato' },
    mood: 'fresh, reliable, inviting, homely',
    copyStyle: 'Warm and reassuring. Before/after language. Clean imagery. Light and airy tone.',
    vibeWords: ['Spotless', 'Fresh', 'Reliable', 'Thorough', 'Trusted'],
    heroImage: 'cleaning service south africa professional home',
    trustSignals: ['Police Cleared Staff', 'Insured', 'Eco-Friendly Products', 'Satisfaction Guarantee'],
    emotionalRegister: 'Warm and welcoming. Your home in safe hands.',
  },
  construction: {
    aesthetic: 'raw_editorial',
    palette: { bg: '#111111', surface: '#1a1a1a', accent: '#f59e0b', text: '#fafafa', muted: '#a3a3a3' },
    fonts: { display: 'Barlow Condensed', body: 'Barlow' },
    mood: 'strong, skilled, serious, built-to-last',
    copyStyle: 'Masculine confidence. Specific about materials and timelines. SA township-to-suburb credibility.',
    vibeWords: ['Built Right', 'On Time', 'Quality Materials', 'Experienced', 'Guaranteed'],
    heroImage: 'construction building south africa workers professional',
    trustSignals: ['NHBRC Registered', '10+ Year Guarantee', 'CIDB Graded', 'Free Quote'],
    emotionalRegister: 'Solid. No fluff. We build things that last.',
  },
  beauty: {
    aesthetic: 'refined_luxury',
    palette: { bg: '#1a0a0a', surface: '#2d1515', accent: '#e879a0', text: '#fdf2f8', muted: '#c084a8' },
    fonts: { display: 'Cormorant Garamond', body: 'Nunito' },
    mood: 'luxurious, empowering, feminine, confidence-giving',
    copyStyle: 'Aspirational but accessible. SA beauty culture references. Empowerment language. Glow-up energy.',
    vibeWords: ['Flawless', 'Confident', 'Luxurious', 'Transformative', 'You Deserve This'],
    heroImage: 'beauty salon south africa hair makeup professional',
    trustSignals: ['Qualified Beauticians', 'Premium Products', 'Hygiene Certified', 'By Appointment'],
    emotionalRegister: 'Empowering. You walk in ordinary, you walk out extraordinary.',
  },
  automotive: {
    aesthetic: 'bold_modern',
    palette: { bg: '#0a0a0a', surface: '#1a1a2e', accent: '#ef4444', text: '#ffffff', muted: '#9ca3af' },
    fonts: { display: 'Rajdhani', body: 'Roboto' },
    mood: 'precise, mechanically capable, masculine pride',
    copyStyle: 'Tech-speak made accessible. Specific about brands and models serviced. SA petrolhead culture.',
    vibeWords: ['Expert', 'Fast Turnaround', 'Warranted Work', 'All Makes', 'Trusted'],
    heroImage: 'auto repair mechanic south africa workshop professional',
    trustSignals: ['MIWA Member', 'Manufacturer Approved', 'Lifetime Warranty Parts', '6-Month Labour Guarantee'],
    emotionalRegister: 'Competent confidence. Your car is in expert hands.',
  },
  food: {
    aesthetic: 'warm_artisan',
    palette: { bg: '#1c0f05', surface: '#2d1a0e', accent: '#f97316', text: '#fef3c7', muted: '#d97706' },
    fonts: { display: 'Playfair Display', body: 'Merriweather Sans' },
    mood: 'warm, indulgent, homemade, community',
    copyStyle: 'Sensory language. Smell, taste, texture words. SA flavour culture — braai, bunny chow, koeksister energy.',
    vibeWords: ['Fresh', 'Homemade', 'Authentic', 'Flavourful', 'Made with Love'],
    heroImage: 'food restaurant catering south africa traditional',
    trustSignals: ['Halaal Certified', 'Fresh Daily', 'Local Ingredients', 'Family Recipe'],
    emotionalRegister: 'Warm and hungry. Food is love made edible.',
  },
  legal: {
    aesthetic: 'refined_luxury',
    palette: { bg: '#0f0f0f', surface: '#1a1a1a', accent: '#c9a84c', text: '#f5f5f5', muted: '#a3a3a3' },
    fonts: { display: 'EB Garamond', body: 'Libre Baskerville' },
    mood: 'authoritative, discreet, trustworthy, experienced',
    copyStyle: 'Dignified and precise. Plain language explanations. SA legal landscape awareness.',
    vibeWords: ['Experienced', 'Trusted', 'Discreet', 'Results-Driven', 'Expert Counsel'],
    heroImage: 'lawyer attorney south africa legal office professional',
    trustSignals: ['Admitted Attorney', '15+ Years Experience', 'Free Consultation', 'Confidential'],
    emotionalRegister: 'Authoritative and reassuring. Your rights are our priority.',
  },
  realestate: {
    aesthetic: 'refined_luxury',
    palette: { bg: '#0a0a0a', surface: '#1a1a1a', accent: '#d4af37', text: '#ffffff', muted: '#9ca3af' },
    fonts: { display: 'Cormorant Garamond', body: 'Montserrat' },
    mood: 'aspirational, trustworthy, knowledgeable, premium',
    copyStyle: 'Location-specific. SA property market language. Aspirational without being unattainable.',
    vibeWords: ['Prime Location', 'Experienced', 'Trusted', 'Results', 'Your Dream Home'],
    heroImage: 'real estate property south africa homes luxury',
    trustSignals: ['Registered Estate Agent', 'PropStats Verified', 'FFC Certificate', 'Free Valuation'],
    emotionalRegister: 'Premium and knowledgeable. We find the right property at the right price.',
  },
};

function getIndustryBrief(industry) {
  if (!industry) return INDUSTRY_MATRIX.plumbing;
  const key = industry.toLowerCase().replace(/[^a-z]/g, '');
  if (key.includes('plumb')) return INDUSTRY_MATRIX.plumbing;
  if (key.includes('electr')) return INDUSTRY_MATRIX.electrical;
  if (key.includes('clean') || key.includes('maid') || key.includes('domestic')) return INDUSTRY_MATRIX.cleaning;
  if (key.includes('build') || key.includes('construct') || key.includes('renovate') || key.includes('paint')) return INDUSTRY_MATRIX.construction;
  if (key.includes('beauty') || key.includes('hair') || key.includes('nail') || key.includes('salon') || key.includes('spa')) return INDUSTRY_MATRIX.beauty;
  if (key.includes('auto') || key.includes('car') || key.includes('mech') || key.includes('panel') || key.includes('tyre')) return INDUSTRY_MATRIX.automotive;
  if (key.includes('food') || key.includes('cater') || key.includes('restaurant') || key.includes('bakery') || key.includes('cook')) return INDUSTRY_MATRIX.food;
  if (key.includes('legal') || key.includes('law') || key.includes('attorn') || key.includes('advocate')) return INDUSTRY_MATRIX.legal;
  if (key.includes('property') || key.includes('estate') || key.includes('realty')) return INDUSTRY_MATRIX.realestate;
  return {
    aesthetic: 'bold_modern',
    palette: { bg: '#0a0a0f', surface: '#111118', accent: '#6ee7b7', text: '#f0f0f5', muted: '#6b7280' },
    fonts: { display: 'Syne', body: 'DM Sans' },
    mood: 'professional, trustworthy, local',
    copyStyle: 'Warm and direct. South African tone. No corporate jargon.',
    vibeWords: ['Professional', 'Trusted', 'Local', 'Experienced', 'Reliable'],
    heroImage: `${industry} professional south africa business`,
    trustSignals: ['Experienced Team', 'Fully Insured', 'Local Business', 'Free Quote'],
    emotionalRegister: 'Trustworthy and approachable. Local experts who care.',
  };
}

// ============================================================
// BUILD PIPELINE — Three-layer architecture
// Layer 1: Template selection (instant, no Claude)
// Layer 2: Voice extraction (Claude Pass 1 → voice_profile JSON + unsplash_queries)
// Layer 3: Token replacement into template (no Claude)
// Photo pulling: D1 library first → Unsplash fallback → savePhoto to D1
// ============================================================

async function triggerBuildInternal(clientId, paymentId, env, isOutbound = false, outboundFields = null) {
  // Fetch client from D1 (or use pre-loaded outbound fields to create one)
  let client;
  if (outboundFields && !clientId) {
    // Outbound: create client record first
    const result = await createClient(env, outboundFields);
    clientId = result.id;
  }

  client = await getClientById(env, clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const slug    = client.slug    || slugify(client.business_name);
  const domain  = client.domain  || `${slug}.co.za`;
  const pkg     = packageKey(client.package);

  // ── LAYER 1: Template selection ───────────────────────────
  // template_id = package tier. palette = client's vibe (overrides industry default).
  const industryEntry = Object.entries(INDUSTRY_VIBE_MAP)
    .find(([k]) => (client.industry || '').toLowerCase().includes(k.toLowerCase()));
  const defaultVibe = industryEntry?.[1]?.default_vibe || 'warm_friendly';
  const effectiveVibe = client.vibe || defaultVibe;
  const archetype    = detectArchetype(client.industry || '');
  const templateId   = pkg; // express | standard | premium

  // Update client with resolved slug, domain, template info
  await updateClient(env, clientId, {
    slug,
    domain,
    status:      'building',
    template_id: templateId,
    palette:     client.palette || effectiveVibe,
  });

  // Create build record
  const buildId = await createBuild(env, clientId, { template_id: templateId, palette: effectiveVibe });

  await logEvent(env, 'build', 'build_started', 'success', { clientId, metadata: { business: client.business_name, pkg, archetype } });

  // ── LAYER 2: Three-pass Claude pipeline ───────────────────
  // Pass 1 — Brand Intelligence (~1500 tokens, fast)
  // Pass 2 — Content Generation (~3500 tokens, all tokens)
  // Pass 3 — Quality Review    (~2000 tokens, refine)
  let voiceProfile;
  const buildStart = Date.now();
  const industryBrief = getIndustryBrief(client.industry || '');

  // ── PASS 1: Brand Intelligence ─────────────────────────────
  let brandBrief;
  try {
    const p1Raw = await callClaudeInternal(
      buildPass1SystemPrompt(archetype, industryBrief),
      [{ role: 'user', content: buildPass1UserPrompt(client, archetype, industryBrief) }],
      env,
      { maxTokens: PASS_1_MAX_TOKENS },
    );
    brandBrief = JSON.parse(p1Raw.replace(/```json|```/g, '').trim());
    await logEvent(env, 'build', 'pass1_complete', 'success', { clientId, metadata: { archetype } });
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pass 1 (Brand Intelligence) failed: ${e.message}`);
  }

  // ── PASS 2: Content Generation ─────────────────────────────
  let contentTokens;
  try {
    const p2Raw = await callClaudeInternal(
      buildPass2SystemPrompt(archetype, industryBrief),
      [{ role: 'user', content: buildPass2UserPrompt(client, archetype, brandBrief, pkg) }],
      env,
      { maxTokens: PASS_2_MAX_TOKENS },
    );
    contentTokens = JSON.parse(p2Raw.replace(/```json|```/g, '').trim());
    await logEvent(env, 'build', 'pass2_complete', 'success', { clientId, metadata: { archetype } });
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pass 2 (Content Generation) failed: ${e.message}`);
  }

  // ── PASS 3: Quality Review ─────────────────────────────────
  try {
    const p3Raw = await callClaudeInternal(
      buildPass3SystemPrompt(archetype, industryBrief),
      [{ role: 'user', content: buildPass3UserPrompt(client, archetype, contentTokens) }],
      env,
      { maxTokens: PASS_3_MAX_TOKENS },
    );
    const refined = JSON.parse(p3Raw.replace(/```json|```/g, '').trim());
    // Merge refined tokens over content tokens — refined wins on any key it touches
    voiceProfile = { ...contentTokens, ...refined, unsplash_queries: contentTokens.unsplash_queries };
    await logEvent(env, 'build', 'pass3_complete', 'success', { clientId, metadata: { archetype } });
  } catch (e) {
    // Pass 3 failure is non-fatal — fall back to Pass 2 output
    console.warn('Pass 3 (Quality Review) failed — using Pass 2 output:', e.message);
    voiceProfile = contentTokens;
  }

  // Store final voice profile
  await updateClient(env, clientId, { voice_profile: JSON.stringify(voiceProfile) });
  await updateBuild(env, buildId, {
    voice_profile:    JSON.stringify(voiceProfile),
    unsplash_queries: JSON.stringify(voiceProfile.unsplash_queries || []),
  });
  await env.SITES.put(`content:${slug}`, JSON.stringify(voiceProfile), { expirationTtl: 60 * 60 * 24 * 35 });

  // ── PHOTO PULLING ─────────────────────────────────────────
  // Check D1 library first; hit Unsplash only if fewer than 3 cached results.
  let ogImage = 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&q=80';

  try {
    const cachedPhotos = await getPhotosByIndustryVibe(env, client.industry || '', effectiveVibe, 'hero', 3);
    if (cachedPhotos.length >= 1) {
      ogImage = cachedPhotos[0].url;
    } else {
      // Hit Unsplash using voice_profile.unsplash_queries if available
      const unsplashQuery = (voiceProfile.unsplash_queries?.hero)
        || `${client.industry} professional south africa`;
      const unsplashPhotos = await fetchUnsplashWithLibrary(client, voiceProfile, env);
      if (unsplashPhotos.length > 0) ogImage = unsplashPhotos[0].url;
    }

    // Also check R2 for client-uploaded photos
    if (env.ASSETS) {
      const r2List = await env.ASSETS.list({ prefix: `${slug}/gallery/` }).catch(() => ({ objects: [] }));
      if (r2List.objects?.length > 0) {
        ogImage = `https://assets.websitehub.co.za/${r2List.objects[0].key}`;
      }
    }
  } catch (e) {
    console.warn('Photo pulling failed (non-fatal):', e?.message);
  }

  // ── LAYER 3: Token replacement into templates ─────────────
  let css = '', pages = {};
  try {
    const t = await fetchTemplates(archetype, pkg, env);
    css = t.css; pages = t.pages;
  } catch(e) {
    console.warn('Templates not loaded — using placeholder');
    const biz = client.business_name || '';
    const area = client.area || 'South Africa';
    const phone = client.phone || '';
    pages = { index: `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${biz}</title><style>body{background:#0a0a0f;color:#e8e8f0;font-family:Inter,Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:24px}.c{max-width:500px}h1{font-size:32px;font-weight:800;margin-bottom:12px}p{color:#8b8b9e;margin-bottom:24px}a{display:inline-block;background:linear-gradient(135deg,#00f0ff,#b829dd);color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:700}</style></head><body><div class="c"><h1>${biz}</h1><p>Proudly serving ${area}</p><a href="https://wa.me/${phone}">💬 WhatsApp Us</a></div></body></html>` };
  }

  const businessFields = {
    name:            client.business_name || '',
    phone:           normaliseSaPhone(client.phone || ''),
    area:            client.area          || '',
    email:           client.email         || '',
    address_line1:   client.area          || '',
    address_line2:   '',
    hours_weekday:   'Mon–Fri: 8am–5pm',
    hours_saturday:  'Saturday: 8am–1pm',
    hours_sunday:    'Sunday: Closed',
    hours_emergency: '24/7 for emergencies',
  };

  const builtPages = {};

  if (pkg === 'express') {
    const replaced = {};
    for (const [pg, tmpl] of Object.entries(pages)) {
      if (tmpl) replaced[pg] = tokenReplace(tmpl, voiceProfile, businessFields, ogImage);
    }
    const expressBase = {
      index:    replaced.index,
      services: replaced.services || await env.SITES.get(`template:${archetype}:services`).then(t => t ? tokenReplace(t, voiceProfile, businessFields, ogImage) : null).catch(() => null),
      about:    replaced.about    || await env.SITES.get(`template:${archetype}:about`).then(t => t ? tokenReplace(t, voiceProfile, businessFields, ogImage) : null).catch(() => null),
      contact:  replaced.contact  || await env.SITES.get(`template:${archetype}:contact`).then(t => t ? tokenReplace(t, voiceProfile, businessFields, ogImage) : null).catch(() => null),
    };
    let html = buildExpressPage(expressBase);
    html = injectCss(html, css, 'index');
    builtPages['index'] = html;
  } else {
    for (const [pageName, template] of Object.entries(pages)) {
      if (!template) { console.warn(`Template missing for ${archetype}:${pageName}`); continue; }
      let html = tokenReplace(template, voiceProfile, businessFields, ogImage);
      html = injectCss(html, css, pageName);

      // QA
      const qaResult = runQAChecks(html, client, pageName, voiceProfile);
      if (!qaResult.passed) {
        console.warn(`QA issues on "${pageName}":`, qaResult.failures.join(', '));
        await sendWhatsApp(env.WH_PHONE,
          `⚠️ QA issues on "${pageName}": ${client.business_name}\n${qaResult.failures.join(', ')}`,
          env, { skipTestRedirect: true }).catch(() => {});
        await updateClient(env, clientId, { qa_status: 'failed' }).catch(() => {});
      } else {
        await updateClient(env, clientId, { qa_status: 'passed' }).catch(() => {});
      }

      builtPages[pageName] = html;
    }
  }

  if (!builtPages['index']) {
    await updateBuild(env, buildId, { status: 'failed', error: 'Home page (index) failed to build' });
    throw new Error('Home page (index) failed to build — aborting');
  }

  // ── STORE PAGES IN KV ─────────────────────────────────────
  const previewUrl = `https://${PREVIEW_DOMAIN}/${slug}`;

  for (const [pageName, html] of Object.entries(builtPages)) {
    const withWatermark = isOutbound ? addWatermark(html, client, domain, clientId, env) : html;
    await env.SITES.put(`preview:${slug}:${pageName}`, withWatermark, { expirationTtl: 60 * 60 * 24 * 35 });
    await env.SITES.put(`draft:${slug}:${pageName}`,   html,          { expirationTtl: 60 * 60 * 24 * 35 });
  }

  const homeWithWatermark = isOutbound ? addWatermark(builtPages['index'], client, domain, clientId, env) : builtPages['index'];
  await env.SITES.put(`preview:${slug}`,          homeWithWatermark, { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`preview-original:${slug}`, homeWithWatermark, { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`draft:${slug}`,            builtPages['index'], { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`preview_expiry:${slug}`, new Date(Date.now() + PREVIEW_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString());

  const buildMs = Date.now() - buildStart;
  await updateBuild(env, buildId, { status: 'complete', build_time_ms: buildMs });

  // Update client to preview_ready
  await updateClient(env, clientId, {
    status:      'preview_ready',
    preview_url: previewUrl,
    ...(paymentId ? { /* payfast_payment_id stored in invoices table */ } : {}),
  });

  await logEvent(env, 'build', 'build_complete', 'success', {
    clientId, durationMs: buildMs,
    metadata: { business: client.business_name, archetype, pkg, pages: Object.keys(builtPages).length },
  });

  // Send preview messages
  if (isOutbound) {
    await sendOutboundPreviewMessage(client, previewUrl, domain, clientId, env);
  } else {
    await sendInboundPreviewMessage(client, previewUrl, domain, clientId, env);
  }

  await sendWhatsApp(env.WH_PHONE,
    `✅ BUILD COMPLETE: ${client.business_name}\nArchetype: ${archetype}\nPreview: ${previewUrl}\nPackage: ${pkg}\nPages: ${Object.keys(builtPages).length}\n${buildMs}ms`,
    env, { skipTestRedirect: true },
  );

  return slug;
}

function injectCss(html, cssBlock, pageName) {
  if (html.includes('<!--WH_CSS_INJECT-->')) return html.replace('<!--WH_CSS_INJECT-->', cssBlock);
  console.warn(`Page "${pageName}" missing WH_CSS_INJECT marker — using fallback`);
  if (html.includes('</head>')) return html.replace('</head>', `${cssBlock}\n</head>`);
  if (/<body\b/i.test(html))   return html.replace(/<body\b/i, `${cssBlock}\n<body`);
  return cssBlock + '\n' + html;
}

// ============================================================
// PREVIEW MESSAGES
// ============================================================

async function sendInboundPreviewMessage(client, previewUrl, domain, clientId, env) {
  const name = (client.client_name || '').split(' ')[0] || 'there';
  await sendWhatsApp(client.phone,
    `🎉 Hi ${name}! Your *${client.business_name}* website is ready!\n\n👀 See it here:\n${previewUrl}\n\nTap *Go Live* on the page to publish it. ⚡\n\n🌐 Your site will be live at *${domain}*\n\nWant changes? Just reply here.\n— Website Hub`,
    env);
  await logMessage(env, clientId, 'build_complete', 'whatsapp');

  const inbName = (client.client_name || '').split(' ')[0] || 'there';
  const manageUrl = `https://preview.websitehub.co.za/manage/${client.manage_token}`;
  await sendEmail({
    to: client.email,
    subject: `Your ${client.business_name} website preview is ready 👀`,
    touchpoint: 'preview_ready',
    clientSlug: client.slug,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#111">Your preview is live 🎉</h2>
      <p>Hi ${inbName},</p>
      <p>Your <strong>${client.business_name}</strong> website preview is ready. Click below to see it — and when you're happy, tap <strong>Go Live</strong> to publish it.</p>
      <p style="margin:24px 0">
        <a href="${previewUrl}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">View My Preview</a>
      </p>
      <p>Your site will go live at <strong>${domain}</strong> once activated.</p>
      <p>Want changes? Just reply to this email or message us on WhatsApp.</p>
      <p style="color:#888;font-size:12px">— Website Hub · <a href="${manageUrl}" style="color:#888">Manage my site</a></p>
    </div>`,
  }, env).catch(() => {});
}

async function sendOutboundPreviewMessage(client, previewUrl, domain, clientId, env) {
  const tier = PRICING[packageKey(client.package || 'standard')];
  try {
    const prompt = `Write a WhatsApp message to a South African small business owner. Maximum 4 lines. Warm and direct — SA tone.

Business name: ${client.business_name}
Town/Area: ${client.area || 'South Africa'}
Industry: ${client.industry || 'small business'}

Line 1: Start with their business name and town — something specific and personal.
Line 2: Say our team built them a free website preview — no obligation, no catch.
Line 3: Preview link: ${previewUrl}
Line 4: Single action — tap the link to see it, then tap *Go Live* to publish for R${tier.retainer}/month.
Final line must always be: "_Reply STOP to opt out._"

Write only the message. No labels. No intro. No explanation.`;

    const message = await callClaudeInternal(
      'You write short, warm, direct WhatsApp messages for a South African web agency. Human tone. Never corporate. 4 lines maximum.',
      [{ role: 'user', content: prompt }],
      env,
    );
    await sendWhatsApp(client.phone, message.trim(), env);
  } catch {
    await sendWhatsApp(client.phone,
      `Hi *${client.business_name}* in ${client.area || 'South Africa'} 👋\n\nOur team built your business a free website — no strings attached.\n\n👀 ${previewUrl}\n\nTap *Go Live* on the page to publish it for R${tier.retainer}/month.\n\n_Reply STOP to opt out._`,
      env);
  }
  await logMessage(env, clientId, 'prospect_initial', 'whatsapp');

  if (client.email) {
    const outbName = (client.client_name || '').split(' ')[0] || 'there';
    const tier = PRICING[packageKey(client.package || 'standard')];
    await sendEmail({
      to: client.email,
      subject: `We built ${client.business_name} a free website preview`,
      touchpoint: 'prospect_preview',
      clientSlug: client.slug,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#111">Your free website is ready 🌐</h2>
        <p>Hi ${outbName},</p>
        <p>Our team built <strong>${client.business_name}</strong> in ${client.area || 'South Africa'} a free website preview — no obligation, no catch.</p>
        <p style="margin:24px 0">
          <a href="${previewUrl}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">See My Free Preview</a>
        </p>
        <p>If you love it, go live for just <strong>R${tier?.retainer || 699}/month</strong>.</p>
        <p style="color:#888;font-size:12px">— Website Hub · <a href="mailto:hello@websitehub.co.za" style="color:#888">Unsubscribe</a></p>
      </div>`,
    }, env).catch(() => {});
  }
}

// ============================================================
// UNSPLASH — stock photo fetching with D1 library cache
// Checks D1 photos table first. Saves new photos to D1.
// ============================================================

async function fetchUnsplashWithLibrary(client, voiceProfile, env) {
  if (!env.UNSPLASH_ACCESS_KEY) return [];

  const industry = client.industry || '';
  const vibe     = client.vibe     || 'warm_friendly';

  // Slots to fetch — use voice_profile queries if available, else default queries
  const slots = [
    { slot: 'hero',     query: voiceProfile.unsplash_queries?.hero     || `${industry} hero South Africa` },
    { slot: 'about',    query: voiceProfile.unsplash_queries?.about    || `${industry} people team South Africa` },
    { slot: 'services', query: voiceProfile.unsplash_queries?.services || `${industry} professional workspace` },
  ];

  const photos = [];

  for (const { slot, query } of slots) {
    // Check D1 library first
    const cached = await getPhotosByIndustryVibe(env, industry, vibe, slot, 1);
    if (cached.length > 0) {
      photos.push({ slot, url: cached[0].url });
      continue;
    }

    // Hit Unsplash — editorial queries, no collection codes per spec
    try {
      const endpoint = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query.slice(0, 100))}&orientation=landscape&content_filter=high`;
      const res = await fetch(endpoint, {
        headers: { 'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const url  = data.urls?.regular || data.urls?.full;
      if (!url) continue;

      photos.push({ slot, url });

      // Save to D1 library
      await savePhoto(env, {
        unsplash_id: data.id,
        url,
        thumb_url:   data.urls?.thumb,
        query_used:  query,
        industry,
        vibe,
        slot,
        market:      'africa',
      }).catch(() => {});

    } catch (e) {
      console.warn(`Unsplash error for "${slot}":`, e?.message);
    }
  }

  await logEvent(env, 'build', 'unsplash_fetch', photos.length > 0 ? 'success' : 'warning', {
    metadata: { count: photos.length, industry },
  });
  return photos;
}

// ============================================================
// OUTBOUND PROSPECTING — Google Places + D1 prospects table
// ============================================================

async function runOutboundCron(env, todayStr) {
  const configStr = await env.SITES.get('config:outbound').catch(() => null);
  const config    = configStr ? JSON.parse(configStr) : {};

  const dailyVolume = parseInt(config.daily_volume || '10');
  const provinces   = config.provinces  || [];
  const industries  = config.industries || [];
  const mode        = config.mode       || 'manual';

  if (provinces.length === 0 || industries.length === 0) {
    await logEvent(env, 'build', 'outbound_skipped', 'warning', { metadata: { reason: 'No provinces or industries configured' } });
    return;
  }

  const province = provinces[Math.floor(Math.random() * provinces.length)];
  const industry = industries[Math.floor(Math.random() * industries.length)];

  let prospects = [];
  try { prospects = await fetchGooglePlacesProspects(province, industry, dailyVolume, env); }
  catch (e) {
    await logEvent(env, 'build', 'outbound_places_error', 'failure', { error: e.message });
    return;
  }

  let found = 0, queued = 0, skipped = 0, failed = 0;

  for (const prospect of prospects) {
    found++;
    if (!prospect.phone) { skipped++; continue; }

    const intl = normaliseSaPhone(prospect.phone);
    const slug = slugify(prospect.name);

    // Check D1 for existing client or opted-out number
    const existing = await env.DB.prepare(
      `SELECT id FROM clients WHERE phone = ? LIMIT 1`
    ).bind(intl).first().catch(() => null);

    if (existing) { skipped++; continue; }

    // Check cooldown in prospects table
    const cooldown = await env.DB.prepare(
      `SELECT cooldown_until FROM prospects WHERE phone = ? AND cooldown_until > datetime('now') LIMIT 1`
    ).bind(intl).first().catch(() => null);

    if (cooldown) { skipped++; continue; }

    try {
      if (mode === 'auto') {
        // Create prospect record in D1
        await env.DB.prepare(
          `INSERT OR IGNORE INTO prospects
           (business_name, slug, phone, industry, area, about, services, status, contacted_at, province_scraped, scrape_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), ?, ?)`
        ).bind(prospect.name, slug, intl, industry, prospect.area || province,
               prospect.about || '', prospect.services || '', province, todayStr).run();

        await queueScheduledMessage(null, intl,
          `Hi *${prospect.name}* 👋\n\nWe build free website previews for SA businesses — no payment needed to see yours.\n\nReply with your *first name* and we'll build it now.\n\n_Reply STOP to opt out._`,
          env, { respectDayOfWeek: false },
        );
        queued++;
      } else {
        // Manual mode: log to D1 prospects as pending
        await env.DB.prepare(
          `INSERT OR IGNORE INTO prospects
           (business_name, slug, phone, industry, area, about, services, status, province_scraped, scrape_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        ).bind(prospect.name, slug, intl, industry, prospect.area || province,
               prospect.about || '', prospect.services || '', province, todayStr).run();
        queued++;
      }
    } catch { failed++; }
  }

  const runLog = { date: todayStr, province, industry, found, queued, skipped, failed, mode };
  await logEvent(env, 'build', 'outbound_run', 'success', { metadata: runLog });
}

async function fetchGooglePlacesProspects(province, industry, limit, env) {
  if (!env.GOOGLE_PLACES_API_KEY) return [];

  const query = `${industry} in ${province}, South Africa`;
  const url   = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${env.GOOGLE_PLACES_API_KEY}`;
  const res   = await fetch(url);
  const data  = await res.json();
  const results = (data.results || []).slice(0, limit);

  const prospects = [];
  for (const place of results) {
    let phone = null, website = null;
    try {
      const detailRes  = await fetch(
        `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=formatted_phone_number,website,name,vicinity&key=${env.GOOGLE_PLACES_API_KEY}`,
      );
      const detailData = await detailRes.json();
      phone   = detailData.result?.formatted_phone_number;
      website = detailData.result?.website;
    } catch { /* skip */ }

    if (website && !website.includes('facebook') && !website.includes('instagram')) continue;

    prospects.push({
      name:     place.name,
      phone:    phone ? phone.replace(/\D/g, '') : null,
      area:     place.vicinity,
      about:    `${industry} business in ${place.vicinity}`,
      services: industry,
    });
  }

  return prospects.filter(p => p.phone);
}

// ============================================================
// BUILD PROMPTS — Pass 1 voice extraction
// ============================================================

function buildPass1SystemPrompt(archetype, brief) {
  const archetypeContext = {
    emergency:  'emergency trades business. Someone is stressed, something is broken — they need help NOW. Be urgent, confident, reassuring. Speed and reliability above all.',
    trust:      'professional services business. Client is handing over a serious problem — they need to feel completely SAFE. Authoritative, calm, credentialed, never salesy.',
    experience: 'experience-based business. The client is buying a feeling, not just a service. Make them imagine being there — sensory, warm, aspirational.',
    local:      'local community business. Beat chains on trust and relationship. Personal, neighbourhood-feel, owner-forward. Community is the product.',
    results:    'results-driven business. Show the work and let it sell itself. Transformation narrative, outcome-focused, bold proof points.',
  }[archetype] || 'South African small business';

  return `You are a senior South African brand strategist. Your job is to extract a brand intelligence brief for a ${archetypeContext}

INDUSTRY CREATIVE BRIEF:
Mood: ${brief.mood}
Copy style: ${brief.copyStyle}
Vibe words: ${brief.vibeWords.join(', ')}
Trust signals: ${brief.trustSignals.join(', ')}
Emotional register: ${brief.emotionalRegister}

YOUR JOB — Output a brand brief JSON with these exact fields:
{
  "voice": "2-3 sentences describing this specific business's personality and tone",
  "headline_direction": "what the hero headline should communicate — the core promise",
  "tagline": "short punchy brand tagline — max 6 words",
  "differentiator": "what genuinely sets them apart in their area",
  "trust_signals": ["signal1", "signal2", "signal3", "signal4"],
  "vibe_words": ["word1", "word2", "word3", "word4"],
  "emotional_hook": "the emotional need this business solves for the customer",
  "copy_notes": "specific guidance on tone, language, what to avoid",
  "unsplash_queries": {
    "hero": "specific editorial search query",
    "about": "specific editorial search query",
    "services": "specific editorial search query"
  }
}

OUTPUT RULES:
→ Output ONLY valid JSON. No preamble, no backticks, no markdown.
→ Be specific to this business and area — never generic.
→ South African voice throughout — warm, direct, no corporate jargon.
→ Never use: "passionate", "dedicated", "committed", "excellence", "solution".`;
}

function buildPass1UserPrompt(client, archetype, brief) {
  const bizName  = client.business_name || '';
  const industry = client.industry      || '';
  const area     = client.area          || '';
  const about    = client.about         || '';
  const services = typeof client.services === 'string'
    ? (() => { try { return JSON.parse(client.services).join(', '); } catch { return client.services; } })()
    : (Array.isArray(client.services) ? client.services.join(', ') : '');
  const vibe = client.vibe || '';

  return `Business name: ${bizName}
Industry: ${industry}
Area: ${area}
Vibe chosen: ${vibe || 'not specified'}
About (client's own words): ${about || 'not provided'}
Services: ${services || 'not provided'}

Build the brand brief for this specific business. Be concrete and local.`;
}

function buildPass2SystemPrompt(archetype, brief) {
  return `You are a South African website copywriter. You have been given a brand brief and must populate every content token for a ${archetype} archetype website.

BRAND BRIEF CONTEXT:
Mood: ${brief.mood}
Copy style: ${brief.copyStyle}
Vibe words: ${brief.vibeWords.join(', ')}
Trust signals: ${brief.trustSignals.join(', ')}
Emotional register: ${brief.emotionalRegister}

OUTPUT RULES — non-negotiable:
→ Output ONLY valid JSON. Start with { and end with }. No preamble, no backticks, no markdown.
→ Every field must be populated — no empty strings, no nulls unless field genuinely does not apply.
→ Headlines: short, punchy, specific — built around the actual business story.
→ Copy: warm, direct, South African — not corporate, not American.
→ NEVER use: "passionate", "dedicated", "committed to excellence", "solution", "journey", "leverage".
→ Phone tokens must NOT appear in JSON — phone is injected from the database.
→ Make every word earn its place. If it sounds like AI wrote it, rewrite it.`;
}

function buildPass2UserPrompt(client, archetype, brandBrief, pkg) {
  const bizName  = client.business_name || '';
  const industry = client.industry      || '';
  const area     = client.area          || '';
  const about    = client.about         || '';
  const services = typeof client.services === 'string'
    ? (() => { try { return JSON.parse(client.services).join(', '); } catch { return client.services; } })()
    : (Array.isArray(client.services) ? client.services.join(', ') : '');

  const pages = {
    express:  ['index only'],
    standard: ['index', 'services', 'about', 'contact'],
    premium:  ['index', 'services', 'about', 'contact', 'gallery'],
  }[pkg] || ['index', 'services', 'about', 'contact'];

  const schemas = {
    emergency: `{
  "page_title": "${bizName} | Emergency ${industry} | ${area}",
  "og_title": "${bizName} | ${area}'s Trusted ${industry}",
  "og_description": "one sentence — specific, urgent, local",
  "hero_badge": "location + trust line, max 8 words",
  "hero_h1_line1": "the problem or question — punchy",
  "hero_h1_line2": "the solution line",
  "hero_h1_line3": "the proof or speed promise",
  "hero_accent_word": "one word from line2 or line3 to highlight",
  "hero_copy": "2 sentences — business story, warm, specific to ${area}",
  "cta_primary": "urgent WhatsApp CTA e.g. Get Emergency Help",
  "cta_secondary": "call CTA e.g. Call Now",
  "stat1_num": "e.g. 15+", "stat1_lbl": "Years in ${area}",
  "stat2_num": "e.g. 24/7", "stat2_lbl": "Emergency Response",
  "stat3_num": "e.g. 100%", "stat3_lbl": "Workmanship Guaranteed",
  "services_section_tag": "e.g. What We Fix",
  "services_h2": "e.g. Our Services",
  "services": [
    {"icon": "emoji", "name": "service", "desc": "one sentence specific to ${industry} in ${area}"},
    {"icon": "emoji", "name": "service", "desc": "one sentence"},
    {"icon": "emoji", "name": "service", "desc": "one sentence"},
    {"icon": "emoji", "name": "service", "desc": "one sentence"},
    {"icon": "emoji", "name": "service", "desc": "one sentence"}
  ],
  "about_section_tag": "e.g. Our Story",
  "about_headline": "specific e.g. 15 Years Keeping ${area} Running",
  "about_pull_quote": "one memorable line capturing their brand promise",
  "about_p1": "paragraph — their story and why they started",
  "about_p2": "paragraph — what makes them different in ${area}",
  "owner_name": "infer from business name or use Owner",
  "trust_point1": "${brandBrief.trust_signals[0] || 'Licensed & Insured'}",
  "trust_point2": "${brandBrief.trust_signals[1] || '24/7 Emergency'}",
  "trust_point3": "${brandBrief.trust_signals[2] || 'Upfront Quotes'}",
  "contact_section_tag": "e.g. Get In Touch",
  "contact_h2_line1": "e.g. Got a problem?",
  "contact_h2_line2": "e.g. Let's sort it out.",
  "contact_copy": "one line — warm, direct, specific to response time",
  "hours_emergency": "e.g. 24/7 for emergencies",
  "coverage_intro": "one sentence intro to coverage area",
  "coverage_response_time": "e.g. 30–60 minutes",
  "coverage_areas": ["${area}", "nearby area", "nearby area", "nearby area", "nearby area", "nearby area"],
  "unsplash_queries": {
    "hero": "${brandBrief.unsplash_queries?.hero || industry + ' professional south africa action'}",
    "about": "${brandBrief.unsplash_queries?.about || industry + ' team south africa'}",
    "services": "${brandBrief.unsplash_queries?.services || industry + ' work detail south africa'}"
  }
}`,

    trust: `{
  "page_title": "${bizName} | ${industry} | ${area}",
  "og_title": "${bizName} | Trusted ${industry} in ${area}",
  "og_description": "one sentence — authority, area, reassurance",
  "hero_badge": "credential + area e.g. Admitted Attorneys · ${area}",
  "hero_h1_line1": "what they protect or resolve",
  "hero_h1_line2": "the emotional promise",
  "hero_h1_line3": "the credibility anchor",
  "hero_accent_word": "one word to highlight",
  "hero_copy": "2 sentences — specific, calm, authoritative",
  "cta_primary": "e.g. Book a Consultation",
  "cta_secondary": "e.g. Our Practice Areas",
  "profession": "e.g. Attorney | Accountant | Doctor",
  "founding_year": "infer or use plausible year",
  "credential1": "e.g. Law Society of SA", "credential2": "e.g. 20+ Years Experience",
  "credential3": "e.g. 500+ Matters", "credential4": "e.g. Free Consultation",
  "about_philosophy": "one sentence — their professional philosophy",
  "owner_name": "inferred from business name",
  "owner_title": "e.g. Managing Attorney | Senior Partner",
  "trust_point1": "${brandBrief.trust_signals[0] || 'Registered Professional'}",
  "trust_point2": "${brandBrief.trust_signals[1] || 'Years of Experience'}",
  "trust_point3": "${brandBrief.trust_signals[2] || 'Free Consultation'}",
  "trust_point4": "${brandBrief.trust_signals[3] || 'Confidential'}",
  "services_section_tag": "e.g. Our Practice Areas",
  "services_h2": "e.g. How We Can Help",
  "services": [
    {"icon": "emoji", "name": "area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "area", "desc": "one sentence", "outcome": "client outcome"}
  ],
  "process_step1_title": "e.g. Initial Consultation", "process_step1_desc": "one sentence",
  "process_step2_title": "e.g. We Review Your Matter", "process_step2_desc": "one sentence",
  "process_step3_title": "e.g. We Act on Your Behalf", "process_step3_desc": "one sentence",
  "about_section_tag": "e.g. Our Firm",
  "about_headline": "specific — protecting ${area} since YEAR",
  "about_pull_quote": "one memorable line about their approach",
  "about_p1": "paragraph — founding story",
  "about_p2": "paragraph — approach and values",
  "about_p3": "paragraph — why clients choose them",
  "testimonials": [
    {"name": "Initial only e.g. T.M.", "quote": "authentic SA testimonial", "matter": "practice area"},
    {"name": "Initial only", "quote": "authentic SA testimonial", "matter": "practice area"},
    {"name": "Initial only", "quote": "authentic SA testimonial", "matter": "practice area"}
  ],
  "faqs": [
    {"q": "relevant question", "a": "clear reassuring answer"},
    {"q": "relevant question", "a": "clear answer"},
    {"q": "relevant question", "a": "clear answer"},
    {"q": "relevant question", "a": "clear answer"}
  ],
  "contact_section_tag": "e.g. Book a Consultation",
  "contact_h2_line1": "e.g. Let's Discuss",
  "contact_h2_line2": "e.g. Your Matter",
  "contact_copy": "one line — reassuring and professional",
  "address_line1": "${area}, South Africa",
  "unsplash_queries": {
    "hero": "${brandBrief.unsplash_queries?.hero || industry + ' professional office south africa'}",
    "about": "${brandBrief.unsplash_queries?.about || industry + ' team meeting south africa'}",
    "services": "${brandBrief.unsplash_queries?.services || industry + ' consultation south africa'}"
  }
}`,

    experience: `{
  "page_title": "${bizName} | ${industry} | ${area}",
  "og_title": "${bizName} — ${industry} in ${area}",
  "og_description": "one sentence — sensory, aspirational, specific",
  "tagline": "${brandBrief.tagline || 'short brand tagline'}",
  "business_type": "e.g. hair salon | restaurant | spa",
  "hero_h1_line1": "experiential first line",
  "hero_h1_line2": "sensory or mood line",
  "hero_h1_line3": "invitation or promise",
  "hero_copy": "2 sentences — make them imagine being there",
  "hero_mood_line": "atmospheric one-liner — sets the scene",
  "cta_primary": "e.g. Book Your Appointment",
  "cta_secondary": "e.g. See Our Work",
  "vibe1": "${brandBrief.vibe_words[0] || 'Relaxing'}",
  "vibe2": "${brandBrief.vibe_words[1] || 'Luxurious'}",
  "vibe3": "${brandBrief.vibe_words[2] || 'Personal'}",
  "vibe4": "${brandBrief.vibe_words[3] || 'Transformative'}",
  "years_open": "e.g. 8", "team_size": "e.g. 6",
  "owner_name": "inferred from business name",
  "owner_title": "e.g. Head Stylist & Owner",
  "offerings_section_tag": "e.g. What We Offer",
  "offerings_h2": "e.g. Designed for You",
  "offerings": [
    {"name": "offering", "desc": "one sentence", "price": "e.g. From R350", "duration": "e.g. 45 min"},
    {"name": "offering", "desc": "one sentence", "price": "e.g. From R550", "duration": "e.g. 90 min"},
    {"name": "offering", "desc": "one sentence", "price": "e.g. From R280", "duration": "e.g. 30 min"},
    {"name": "offering", "desc": "one sentence", "price": "e.g. From R450", "duration": "e.g. 60 min"},
    {"name": "offering", "desc": "one sentence", "price": "e.g. From R650", "duration": "e.g. 2 hrs"},
    {"name": "offering", "desc": "one sentence", "price": "e.g. From R180", "duration": "e.g. 20 min"}
  ],
  "about_section_tag": "e.g. Our Story",
  "about_headline": "warm personal headline",
  "about_pull_quote": "one memorable line",
  "about_p1": "paragraph — origin story",
  "about_p2": "paragraph — experience and atmosphere",
  "contact_section_tag": "e.g. Reserve Your Spot",
  "contact_h2_line1": "e.g. Ready to Book?",
  "contact_h2_line2": "e.g. We'd Love to See You",
  "contact_copy": "one line — warm, inviting",
  "address_line1": "${area}, South Africa",
  "unsplash_queries": {
    "hero": "${brandBrief.unsplash_queries?.hero || industry + ' interior ambiance south africa'}",
    "about": "${brandBrief.unsplash_queries?.about || industry + ' owner staff south africa'}",
    "services": "${brandBrief.unsplash_queries?.services || industry + ' detail product south africa'}"
  }
}`,

    local: `{
  "page_title": "${bizName} | ${area}'s Trusted ${industry}",
  "og_title": "${bizName} — Serving ${area} Since Day One",
  "og_description": "one sentence — community, trust, local",
  "hero_h1_line1": "community-first headline",
  "hero_h1_line2": "the local advantage",
  "hero_h1_line3": "the relationship promise",
  "hero_copy": "2 sentences — neighbourhood feel, personal, owner-forward",
  "cta_primary": "e.g. Visit Us Today",
  "cta_secondary": "e.g. Call the Shop",
  "since_year": "e.g. 2004",
  "owner_name": "inferred from business name",
  "about_tagline": "one neighbourhood phrase",
  "services_section_tag": "e.g. What We Stock",
  "services_h2": "e.g. Everything You Need",
  "services": [
    {"icon": "emoji", "name": "product/service", "desc": "one sentence"},
    {"icon": "emoji", "name": "product/service", "desc": "one sentence"},
    {"icon": "emoji", "name": "product/service", "desc": "one sentence"},
    {"icon": "emoji", "name": "product/service", "desc": "one sentence"},
    {"icon": "emoji", "name": "product/service", "desc": "one sentence"},
    {"icon": "emoji", "name": "product/service", "desc": "one sentence"}
  ],
  "badges": ["Family Owned", "${area} Born", "Open 7 Days", "Cash & Card"],
  "about_section_tag": "e.g. Our Story",
  "about_headline": "community headline",
  "about_pull_quote": "one line capturing neighbourhood spirit",
  "about_p1": "paragraph — founding story",
  "about_p2": "paragraph — community connection",
  "testimonials": [
    {"name": "SA name", "quote": "neighbourhood customer testimonial"},
    {"name": "SA name", "quote": "loyal customer testimonial"},
    {"name": "SA name", "quote": "local testimonial"}
  ],
  "contact_section_tag": "e.g. Come See Us",
  "contact_h2_line1": "e.g. We're Right Here",
  "contact_h2_line2": "e.g. In ${area}",
  "contact_copy": "one line — warm and accessible",
  "address_line1": "${area}, South Africa",
  "unsplash_queries": {
    "hero": "${brandBrief.unsplash_queries?.hero || industry + ' shop storefront south africa local'}",
    "about": "${brandBrief.unsplash_queries?.about || industry + ' owner community south africa'}",
    "services": "${brandBrief.unsplash_queries?.services || industry + ' products shelves south africa'}"
  }
}`,

    results: `{
  "page_title": "${bizName} | ${industry} | ${area}",
  "og_title": "${bizName} — Results That Speak For Themselves",
  "og_description": "one sentence — outcome-focused, bold, specific",
  "hero_h1_line1": "transformation or outcome headline",
  "hero_h1_line2": "the quality promise",
  "hero_h1_line3": "the proof statement",
  "hero_copy": "2 sentences — show results, let work sell itself",
  "cta_primary": "e.g. See Our Work",
  "cta_secondary": "e.g. Get a Free Quote",
  "proof_stat1_num": "e.g. 500+", "proof_stat1_lbl": "Projects Completed",
  "proof_stat2_num": "e.g. 12+",  "proof_stat2_lbl": "Years Experience",
  "proof_stat3_num": "e.g. 98%",  "proof_stat3_lbl": "Client Satisfaction",
  "proof_stat4_num": "e.g. 0",    "proof_stat4_lbl": "Comebacks",
  "owner_name": "inferred from business name",
  "services_section_tag": "e.g. What We Do",
  "services_h2": "e.g. Our Work",
  "services": [
    {"icon": "emoji", "name": "service", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service", "desc": "one sentence", "result": "client outcome"}
  ],
  "about_section_tag": "e.g. The Work Speaks",
  "about_headline": "results-focused headline",
  "about_pull_quote": "one memorable line about quality",
  "about_p1": "paragraph — origin and expertise",
  "about_p2": "paragraph — process and standards",
  "about_p3": "paragraph — why trusted in ${area}",
  "about_proof_statement": "bold proof e.g. 500+ projects. Zero comebacks.",
  "testimonials": [
    {"name": "SA name", "quote": "results testimonial", "result": "e.g. Done in 3 days, perfect finish"},
    {"name": "SA name", "quote": "results testimonial", "result": "client result"},
    {"name": "SA name", "quote": "results testimonial", "result": "client result"}
  ],
  "case_studies": [
    {"client": "e.g. Family in ${area}", "challenge": "the problem", "solution": "what was done", "timeframe": "e.g. 5 days", "results": ["result 1", "result 2", "result 3"]},
    {"client": "e.g. Local business", "challenge": "the problem", "solution": "what was done", "timeframe": "e.g. 3 days", "results": ["result 1", "result 2", "result 3"]}
  ],
  "contact_section_tag": "e.g. Get a Free Quote",
  "contact_h2_line1": "e.g. Ready to See Results?",
  "contact_h2_line2": "e.g. Let's Talk",
  "contact_copy": "one line — confident, direct",
  "address_line1": "${area}, South Africa",
  "unsplash_queries": {
    "hero": "${brandBrief.unsplash_queries?.hero || industry + ' work result south africa before after'}",
    "about": "${brandBrief.unsplash_queries?.about || industry + ' team professional south africa'}",
    "services": "${brandBrief.unsplash_queries?.services || industry + ' finished work quality south africa'}"
  }
}`,
  };

  const schema = schemas[archetype] || schemas.results;

  return `BRAND BRIEF:
Voice: ${brandBrief.voice}
Headline direction: ${brandBrief.headline_direction}
Differentiator: ${brandBrief.differentiator}
Emotional hook: ${brandBrief.emotional_hook}
Copy notes: ${brandBrief.copy_notes}

CLIENT DATA:
Business: ${client.business_name}
Industry: ${client.industry}
Area: ${area}
About: ${about || 'not provided'}
Services: ${services || 'not provided'}
Package: ${pkg} — pages needed: ${pages.join(', ')}

Populate every field in this JSON schema. Be specific, local, South African:
${schema}`;
}

function buildPass3SystemPrompt(archetype, brief) {
  return `You are a ruthless South African brand editor. A junior copywriter has populated website content tokens. Your job is to review and refine — catch anything generic, weak, or AI-sounding and replace it with something real and specific.

INDUSTRY STANDARD:
Mood: ${brief.mood}
Emotional register: ${brief.emotionalRegister}
Copy style: ${brief.copyStyle}

YOUR JOB:
→ Review every field in the JSON provided
→ Replace any generic, weak, or AI-sounding copy with something specific and punchy
→ Ensure headlines are SHORT and memorable — if any headline is more than 6 words, tighten it
→ Ensure South African voice throughout — real, warm, direct
→ Output the COMPLETE refined JSON — every field, not just the ones you changed

OUTPUT RULES:
→ Output ONLY valid JSON. No preamble, no backticks, no markdown.
→ Keep unsplash_queries exactly as provided — do not change them.
→ Never use: "passionate", "dedicated", "committed", "excellence", "solution", "journey", "leverage", "innovative".`;
}

function buildPass3UserPrompt(client, archetype, contentTokens) {
  return `Business: ${client.business_name} | Industry: ${client.industry} | Area: ${client.area || 'South Africa'}

Review and refine this content. Replace anything generic or weak. Keep what is already strong:
${JSON.stringify(contentTokens, null, 2)}`;
}


// ============================================================
// QA CHECKS
// ============================================================

function runQAChecks(html, client, pageName = 'index', voiceProfile = null) {
  const failures = [];

  if (!html.includes('<!DOCTYPE'))                                         failures.push('Missing DOCTYPE');
  if (!html.includes('viewport'))                                          failures.push('Missing viewport');
  if (!html.includes('<nav') && !html.includes('class="nav"'))             failures.push('Missing nav');
  if (!html.includes('wa.me') && !html.toLowerCase().includes('whatsapp')) failures.push('Missing WhatsApp link');
  if (html.includes('Lorem ipsum'))                                        failures.push('Lorem ipsum detected');

  if (html.includes('<!--WH_CSS_INJECT-->'))
    failures.push('WH_CSS_INJECT placeholder not replaced — CSS injection failed');

  const styleOpens  = (html.match(/<style\b/gi)  || []).length;
  const styleCloses = (html.match(/<\/style>/gi) || []).length;
  if (styleOpens !== styleCloses)
    failures.push(`Unclosed <style> tag (${styleOpens} open, ${styleCloses} close)`);

  const scriptOpens  = (html.match(/<script\b/gi)  || []).length;
  const scriptCloses = (html.match(/<\/script>/gi) || []).length;
  if (scriptOpens !== scriptCloses)
    failures.push(`Unclosed <script> tag (${scriptOpens} open, ${scriptCloses} close)`);

  const bizName  = client.business_name || '';
  const bizFirst = bizName.split(' ')[0];
  if (bizFirst && !html.toLowerCase().includes(bizFirst.toLowerCase()))
    failures.push('Business name missing from page body');

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!titleMatch) {
    failures.push('Missing <title> tag');
  } else if (bizFirst && !titleMatch[1].toLowerCase().includes(bizFirst.toLowerCase())) {
    failures.push('Business name missing from <title>');
  }

  const recordPhone = normaliseSaPhone(client.phone);
  if (recordPhone) {
    const waLinks = html.match(/wa\.me\/(\+?\d+)/gi) || [];
    if (waLinks.length === 0) {
      failures.push('No wa.me links found');
    } else {
      const numbers = waLinks.map(l => l.replace(/wa\.me\/\+?/i, '').replace(/\D/g, ''));
      if (!numbers.some(n => n === recordPhone))
        failures.push(`wa.me link does not match client phone (${recordPhone})`);
    }
  }

  if (pageName === 'index') {
    if (!html.includes('id="home"') && !html.includes("id='home'"))
      failures.push('Home: missing hero id="home"');
  }

  if (pageName === 'contact') {
    if (!html.includes('<form'))  failures.push('Contact: missing form');
    if (!html.includes('wa.me')) failures.push('Contact: missing WhatsApp link');
  }

  return { passed: failures.length === 0, failures };
}

// ============================================================
// WATERMARK + FOOTER CREDIT
// ============================================================

function addWatermark(html, client, domain, clientId, env) {
  const bizName    = client?.business_name || 'your business';
  const pkg        = client?.package || 'standard';
  const tier       = PRICING[packageKey(pkg)];
  const slug       = client?.slug || slugify(bizName);
  const priceLabel = `R${tier.retainer}/mo`;

  const launchUrl = env.WORKER_URL_LAUNCH || '';
  const payLink   = buildPayFastLink(tier.retainer, 'Website Hub Monthly Subscription', clientId, env, {
    itemDesc:  `${bizName} — first month`,
    returnUrl: `https://${PREVIEW_DOMAIN}/${slug}`,
    cancelUrl: `https://${PREVIEW_DOMAIN}/${slug}`,
    notifyUrl: launchUrl ? `${launchUrl}/payfast-webhook` : undefined,
  });

  const reactUrl         = env.WORKER_URL_REACTIVATE || '';
  const notInterestedUrl = `${reactUrl}/not-interested?phone=${normaliseSaPhone(client?.phone || '')}&slug=${slug}`;

  const goLiveBtn = `<a href="${payLink}" style="background:#ff5500;color:#fff;padding:9px 20px;border-radius:7px;font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap;">🚀 Go Live — ${priceLabel}</a>`;
  const notIntBtn = `<a href="${notInterestedUrl}" style="background:transparent;color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.25);padding:8px 14px;border-radius:7px;font-size:12px;text-decoration:none;white-space:nowrap;">Not interested</a>`;

  const banner = `
<div id="wh-preview-bar" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:rgba(8,10,16,0.97);backdrop-filter:blur(14px);color:#fff;padding:10px 20px;font-family:'Arial',sans-serif;font-size:12px;border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;gap:10px;">
  <span style="flex:1;opacity:0.7;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">✨ Built for <strong style="color:#fff;">${escapeHtml(bizName)}</strong></span>
  <div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">${notIntBtn}${goLiveBtn}</div>
</div>
<!-- WH_WATERMARK_END -->`;

  if (html.includes('</body>')) return html.replace('</body>', banner + '\n</body>');
  return html + banner;
}

function removeWatermark(html) {
  return html.replace(/<div id="wh-preview-bar"[\s\S]*?<!-- WH_WATERMARK_END -->\n?/, '');
}

function addFooterCredit(html) {
  if (html.includes('websitehub.co.za')) return html;
  return html.replace('</body>',
    `<div style="text-align:center;padding:8px;font-size:11px;color:#999;font-family:Arial,sans-serif;">Hosted & managed by <a href="https://websitehub.co.za" style="color:#999;" target="_blank">Website Hub</a> · 🔒 Secured by Cloudflare</div></body>`,
  );
}

// ============================================================
// STATIC PAGES
// ============================================================

function suspendedPage(domain) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site Temporarily Unavailable</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:440px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{font-size:48px;margin-bottom:16px}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6;font-size:15px}a{color:#1a1a2e;font-weight:600}</style></head><body><div class="box"><div class="icon">⚠️</div><h1>Site Temporarily Unavailable</h1><p>This website is temporarily unavailable due to an outstanding subscription payment.<br><br>If you are the site owner, please contact <a href="https://wa.me/27840142017">Website Hub</a> to reinstate your site immediately.</p></div></body></html>`;
}

function notFoundPage(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:440px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6}</style></head><body><div class="box"><h1>Site Not Found</h1><p>The site <strong>${escapeHtml(slug)}</strong> doesn't exist or has been moved.<br><br><a href="https://websitehub.co.za" style="color:#1a1a2e;font-weight:600;">Visit Website Hub →</a></p></div></body></html>`;
}

function expiredPreviewPage(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview Expired</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:440px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6}a{color:#1a1a2e;font-weight:600}</style></head><body><div class="box"><div style="font-size:48px;margin-bottom:16px">⏱️</div><h1>This preview has expired</h1><p>This site preview is no longer available. If you'd like a website for your business, visit <a href="https://websitehub.co.za">websitehub.co.za</a> — we'll have something ready in 10 minutes.</p></div></body></html>`;
}

function landingPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website Hub Preview Portal</title></head><body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5"><div style="text-align:center"><h1 style="color:#1a1a2e">Website Hub</h1><p style="color:#666;margin-top:8px">Client preview portal</p></div></body></html>`;
}

function galleryUpgradePromptPage(slug, env) {
  const upgradeAmount = PRICING.upgrade.standardToPremium;
  const upgradeLink   = buildPayFastLink(
    upgradeAmount, 'Website Hub Upgrade to Premium', slug, env,
    { customStr2: 'upgrade:standardToPremium' },
  );
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gallery — Upgrade to Premium</title><style>body{margin:0;background:#0a0a0f;color:#fff;font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{background:#111118;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:48px 32px;max-width:420px}.icon{font-size:48px;margin-bottom:20px}.h{font-size:28px;font-weight:800;margin-bottom:12px}.p{color:#888899;line-height:1.7;margin-bottom:28px}.btn{display:inline-block;background:#ff5500;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px}</style></head><body><div class="card"><div class="icon">📸</div><h2 class="h">Gallery is a Premium feature</h2><p class="p">Upgrade to Premium to showcase your work with a dynamic photo gallery — updated automatically when you send photos via WhatsApp.</p><a href="${upgradeLink}" class="btn">Upgrade to Premium — R${upgradeAmount}/mo more</a></div></body></html>`;
}

// ============================================================
// ZIP EXTRACTION — Dropbox asset helper
// ============================================================

function read32(b, o) { return (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0; }
function read16(b, o) { return b[o] | (b[o+1] << 8); }

async function extractImagesFromZip(buffer) {
  const bytes      = new Uint8Array(buffer);
  const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'];
  const images     = [];
  let i = 0;

  while (i < bytes.length - 30 && images.length < MAX_IMAGES) {
    if (bytes[i] !== 0x50 || bytes[i+1] !== 0x4b || bytes[i+2] !== 0x03 || bytes[i+3] !== 0x04) { i++; continue; }

    const compression = read16(bytes, i + 8);
    const compSize    = read32(bytes, i + 18);
    const nameLen     = read16(bytes, i + 26);
    const extraLen    = read16(bytes, i + 28);
    const name        = new TextDecoder().decode(bytes.slice(i + 30, i + 30 + nameLen));
    const dataStart   = i + 30 + nameLen + extraLen;
    const ext         = name.split('.').pop()?.toLowerCase();
    const isHidden    = name.includes('__MACOSX') || name.startsWith('.') || name.includes('/.');

    if (!isHidden && IMAGE_EXTS.includes(ext) && compSize > 0) {
      const compressed = bytes.slice(dataStart, dataStart + compSize);
      const imageData  = compression === 0 ? compressed : compression === 8 ? await safeInflate(compressed) : null;
      if (imageData) images.push({ name: name.split('/').pop(), base64: uint8ArrayToBase64(imageData), mimeType: getMime(ext) });
    }

    i = dataStart + compSize;
  }

  return images.sort((a, b) =>
    (b.name.toLowerCase().includes('logo') ? 1 : 0) - (a.name.toLowerCase().includes('logo') ? 1 : 0),
  );
}


async function handleStart(request, url, env) {
  if (request.method === "POST") return handleIntake(request, env, null);
  let html = await env.SITES.get('app:start-v2');
  if (!html) return new Response('Start form not loaded. POST HTML to /bootstrap-start.', { status: 503 });
  html = html.replace('__TURNSTILE_SITE_KEY__', env.TURNSTILE_SITE_KEY || '');
  const clientId = url.searchParams.get('id');
  let intakeDataJson = 'null';
  if (clientId) {
    try {
      const { getClientById } = await import('./shared-services.js');
      const client = await getClientById(env, clientId);
      if (client) {
        const slug = (client.slug || client.business_name.toLowerCase().replace(/[^a-z0-9]+/g,'-'));
        const previewHtml = await env.SITES.get('preview:' + slug).catch(() => null);
        intakeDataJson = JSON.stringify({ clientId: client.id, business_name: client.business_name, client_name: client.client_name, phone: client.phone, industry: client.industry, area: client.area, vibe: client.vibe, previewHtml: previewHtml || null });
      }
    } catch(e) { console.warn('Mode 2 lookup failed:', e?.message); }
  }
  html = html.replace('__INTAKE_DATA_JSON__', intakeDataJson);
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}
