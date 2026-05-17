// ============================================================
// WEBSITE HUB — build-worker.js
// Owns the build pipeline, preview/live serving, outbound prospecting,
// admin endpoints, Unsplash fetching, QA, watermarking, and the Claude
// Vision brand-signal extraction triggered by photo uploads (which are
// handled in patch-worker but call back via BUILD_QUEUE).
//
// ROUTES OWNED:
//   GET  /                          — serves preview SPA or landing
//   GET  preview.* / *              — site serving (hostname-routed)
//   POST /dropbox                   — cached Dropbox asset extraction
//   POST /claude                    — Claude API proxy
//   POST /formspree-webhook         — inbound lead → queued build
//   POST /verify-pin                — PIN verification (orphan route, now wired)
//   GET  /build-status              — polling endpoint for verify page
//   POST /preview-choices           — save palette/font/photo choices
//   GET  /preview-meta              — preview panel data
//   POST /bootstrap-preview-app     — push preview-manage.html into KV
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
//   GET  /leaderboard               — pre-computed leaderboard cache
//   POST /admin/purge-test-data     — KV purge (system reset)
//
// HANDLERS:
//   fetch     — all the routes above
//   scheduled — runs outbound prospecting cron at 11pm SAST (9pm UTC)
//   queue     — consumes BUILD_QUEUE; calls triggerBuildInternal
//
// CROSS-WORKER URLs (set in wrangler env):
//   WORKER_URL_BUILD, WORKER_URL_PATCH, WORKER_URL_LAUNCH,
//   WORKER_URL_PULSE, WORKER_URL_REACTIVATE
//
// SECRETS REQUIRED:
//   ANTHROPIC_KEY, AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID,
//   META_WA_TOKEN, META_PHONE_NUMBER_ID, WH_PHONE, ADMIN_KEY,
//   UNSPLASH_ACCESS_KEY, GOOGLE_PLACES_API_KEY, REGISTERDOMAIN_API_KEY,
//   PAYFAST_MERCHANT_ID (+ sandbox vars when TEST_MODE=true)
//
// FLAGS:
//   OUTBOUND_ENABLED, REFERRAL_ENABLED, VISION_VALIDATION_ENABLED,
//   TEST_MODE (all read via getFlag/isTestMode in shared-services)
// ============================================================

import {
  PRICING, PACKAGE_CAPS, PREVIEW_EXPIRY_DAYS, PROSPECT_COOLDOWN_DAYS,
  isTestMode, packageKey, getPricingTier, getPackageCaps, buildPayFastLink,
  jsonResponse, corsResponse, htmlResponse,
  slugify, escapeHtml, uint8ArrayToBase64, getMime, currentMonthKey, todayDateString,
  resolveClaudeModel, callClaudeInternal,
  sendWhatsApp, queueScheduledMessage, normaliseSaPhone,
  createAirtableRecord, getAirtableRecord, updateAirtableRecord, listAirtableRecords,
  mapFormspreeToAirtable,
  logActivity, logHealth, logBuild, getFlag,
  detectArchetype, fetchTemplates, tokenReplace, buildExpressPage,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const MAX_ZIP_SIZE   = 25 * 1024 * 1024;
const MAX_IMAGES     = 12;
const PREVIEW_DOMAIN = 'preview.websitehub.co.za';

// This worker's own hostname (used to detect API requests vs site serving).
// All other hostnames fall through to live site serving.
const WORKER_DOMAIN  = 'wh-build.pierreduplessis6912.workers.dev';

// Pass token budgets — Pass 2 ceiling is non-negotiable. See triggerBuildInternal
// for the rationale (unclosed </style> swallows the body in rawtext mode).
const PASS_1_MAX_TOKENS     = 3500; // Pass 1 — content strategy JSON
const PASS_2_CSS_MAX_TOKENS = 5500; // Pass 2 — CSS design system (non-negotiable floor)
const PASS_4_DEFAULT_TOKENS = 6000; // Pass 4 — full HTML per page
const PASS_5_DEFAULT_TOKENS = 3000; // Pass 5 — personality & polish

// ────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const hostname = url.hostname;

    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    // Site serving (hostname-based)
    if (hostname === PREVIEW_DOMAIN) {
      // /raw/ path serves plain HTML for the SPA iframe (no SPA wrapping)
      if (url.pathname.endsWith('/raw/') || url.pathname.endsWith('/raw')) {
        return servePreviewRaw(url, env);
      }
      return servePreview(url, env);
    }
    if (hostname !== WORKER_DOMAIN && !hostname.endsWith('.workers.dev')) {
      return serveLiveSite(url, hostname, env);
    }

    // API routes
    const path = url.pathname;

    if (path === '/dropbox')                return handleDropbox(request, url, env, ctx);
    if (path === '/claude')                 return handleClaude(request, env);
    if (path === '/formspree-webhook')      return handleFormspreeWebhook(request, env, ctx);
    if (path === '/verify-pin')             return handleVerifyPin(request, env, ctx);
    if (path === '/build-status')           return handleBuildStatus(request, url, env);
    if (path === '/preview-choices')        return handlePreviewChoices(request, env);
    if (path === '/preview-meta')           return handlePreviewMeta(request, url, env);
    if (path === '/bootstrap-preview-app')  return handleBootstrapPreviewApp(request, env);
    if (path === '/bootstrap-templates')    return handleBootstrapTemplates(request, env);
    if (path === '/purge-kv')               return handlePurgeKv(request, env);
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
      const { airtableId, paymentId, fields, isOutbound, buildToken } = message.body;
      const slug = slugify(fields?.['Business Name'] || '');
      try {
        const resolvedSlug = await triggerBuildInternal(airtableId, paymentId, env, fields, isOutbound);
        // Use resolvedSlug (from Airtable refetch) — not the pre-computed slug which may be '' when fields is null
        const finalSlug = resolvedSlug || slug;
        message.ack();
        await logActivity(env, 'build_completed', { airtableId, business: fields?.['Business Name'] });

        if (buildToken) {
          await env.SITES.put(`build_status:${buildToken}`, JSON.stringify({
            status:     'ready',
            slug:       finalSlug,
            previewUrl: `https://${PREVIEW_DOMAIN}/${finalSlug}`,
          }));
        }

        // Send second WhatsApp with rich preview card for inbound clients
        if (!isOutbound && fields?.['WhatsApp']) {
          const intl  = normaliseSaPhone(fields['WhatsApp']);
          const name  = fields['Client Name']?.split(' ')[0] || 'there';
          const url   = `https://${PREVIEW_DOMAIN}/${slug}`;
          await sendWhatsApp(intl,
            `🎉 ${name}, your *${fields['Business Name']}* website is ready!\n\n👀 Tap to see it:\n${url}\n\nTap *Go Live* on the page when you're happy. — Website Hub`,
            env, { previewUrl: true },
          ).catch(() => {});
          await env.SITES.put(`state:${intl}`, JSON.stringify({
            state:     'PREVIEW_SENT',
            airtableId, slug,
            updatedAt: new Date().toISOString(),
          })).catch(() => {});
        }
      } catch (err) {
        console.error('Queue build failed:', err);

        await logActivity(env, 'build_failed', {
          airtableId,
          business: fields?.['Business Name'] || airtableId,
          error:    err.message,
        });
        await env.SITES.put(
          `deadletter:${airtableId}:${Date.now()}`,
          JSON.stringify({ airtableId, error: err.message, fields, timestamp: new Date().toISOString() }),
          { expirationTtl: 60 * 60 * 24 * 30 },
        );

        if (buildToken) {
          await env.SITES.put(`build_status:${buildToken}`, JSON.stringify({
            status: 'error', slug, error: err.message,
          }), { expirationTtl: 3600 });
        }

        await updateAirtableRecord(airtableId, { 'Status': 'Lead' }, env).catch(() => {});
        await logBuild(airtableId, 'Failed', err.message, env).catch(() => {});

        await sendWhatsApp(env.WH_PHONE,
          `❌ BUILD FAILED\nBusiness: ${fields?.['Business Name'] || airtableId}\nError: ${err.message}\nAirtable: ${airtableId}`,
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
  // Outbound is gated by both the feature flag and TEST_MODE.
  // In TEST_MODE we skip outbound entirely — sending real prospect messages
  // (even redirected) wastes the daily volume budget and pollutes Airtable.
  if (isTestMode(env)) {
    await logActivity(env, 'outbound_skipped', { reason: 'TEST_MODE' });
    return;
  }
  if (!(await getFlag(env, 'OUTBOUND_ENABLED'))) {
    await logActivity(env, 'outbound_skipped', { reason: 'OUTBOUND_ENABLED=false' });
    return;
  }
  await runOutboundCron(env, todayDateString());
}

// ============================================================
// SITE SERVING — KV-backed hosting
// ============================================================

const VALID_PAGES = ['index', 'services', 'about', 'contact', 'gallery'];

async function servePreview(url, env) {
  const rawPath = url.pathname.replace(/^\//, '');
  const segment = rawPath.split('/')[0];

  // App-only entry points (no slug). Same SPA handles every entry route:
  // root, verify-pin landing, manage panel, build progress.
  if (!rawPath || segment === 'verify' || segment === 'manage' || segment === 'build') {
    const appHtml = await env.SITES.get('app:preview-manage');
    if (appHtml) return htmlResponse(appHtml, 200);
    return htmlResponse(landingPage(), 200);
  }

  // Slug-based path: /{slug} (preview entry) or /{slug}/{page} (deep link).
  // INBOUND and OUTBOUND share this path — same SPA, same Go Live, same upsells.
  // Only differences live inside the iframe content (outbound carries a watermark
  // applied at build time). The /raw/ path serves that iframe content and is
  // already intercepted in the fetch() handler before this function runs.
  const slug    = segment;
  const subPath = rawPath.split('/').slice(1).join('/');
  const pageName = VALID_PAGES.includes(subPath) ? subPath : 'index';

  // Preview expiry — archive to portfolio_candidate and serve expired page
  const expiry = await env.SITES.get(`preview_expiry:${slug}`);
  if (expiry && new Date(expiry) < new Date()) {
    await env.SITES.put(`portfolio_candidate:${slug}`, expiry);
    await env.SITES.delete(`preview:${slug}`);
    for (const p of ['index', 'services', 'about', 'contact', 'gallery']) {
      await env.SITES.delete(`preview:${slug}:${p}`).catch(() => {});
    }
    return htmlResponse(expiredPreviewPage(slug), 410);
  }

  // Verify the preview actually exists in KV before serving the SPA shell —
  // saves spinning the SPA for invalid slugs and surfaces a clean 404.
  let previewExists = await env.SITES.get(`preview:${slug}:${pageName}`);
  if (!previewExists && pageName === 'index') {
    previewExists = await env.SITES.get(`preview:${slug}`);
  }

  // Gallery for non-Premium clients — serve standalone upgrade prompt
  // (this is a sales nudge dead-end, intentionally not inside the SPA flow).
  if (!previewExists && pageName === 'gallery') {
    return htmlResponse(galleryUpgradePromptPage(slug, env), 200);
  }
  if (!previewExists) return htmlResponse(notFoundPage(slug), 404);

  // Visitor count — daily granular key under monthly prefix
  recordVisit(slug, pageName, env);

  // Serve the SPA shell. The SPA's client-side router reads location.pathname,
  // detects /{slug} mode, and loads the actual site HTML in an iframe via
  // /{slug}/raw/?page={pageName}. This is what gives outbound previews and
  // inbound previews the identical experience — Go Live button, tweak drawer,
  // tier-aware tabs, upsell cards.
  const appHtml = await env.SITES.get('app:preview-manage');
  if (appHtml) return htmlResponse(appHtml, 200);

  // Fallback if the SPA HTML hasn't been bootstrapped yet — serve the raw
  // preview so the client still sees their site rather than a blank page.
  // (Run POST /bootstrap-preview-app with the latest preview-manage-new.html
  // to fix this state.)
  return htmlResponse(previewExists, 200);
}

async function serveLiveSite(url, hostname, env) {
  const suspended = await env.SITES.get(`suspended:${hostname}`);
  if (suspended) return htmlResponse(suspendedPage(hostname), 402);

  const rawPath  = url.pathname.replace(/^\//, '');
  const subPath  = rawPath.split('/')[0] || '';
  const pageName = VALID_PAGES.includes(subPath) ? subPath : 'index';

  let html = await env.SITES.get(`live:${hostname}:${pageName}`);
  if (!html && pageName === 'index') html = await env.SITES.get(`live:${hostname}`);

  if (!html && pageName === 'gallery') return htmlResponse(galleryUpgradePromptPage(hostname, env), 200);
  if (!html) return htmlResponse(notFoundPage(hostname), 404);

  const slug = hostname.replace(/\.co\.za$/, '').replace(/\./g, '-');
  recordVisit(slug, pageName, env);

  return htmlResponse(html, 200);
}

/** Fire-and-forget visitor count increment. Daily + per-page granularity. */
function recordVisit(slug, pageName, env) {
  const today    = todayDateString();
  const countKey = `visits:${slug}:${today}`;          // total this day
  const pageKey  = `visits:${slug}:${pageName}:${today}`; // per-page this day
  env.SITES.get(countKey).then(v => {
    env.SITES.put(countKey, String((parseInt(v || '0') + 1)), { expirationTtl: 60 * 60 * 24 * 35 });
  }).catch(() => {});
  env.SITES.get(pageKey).then(v => {
    env.SITES.put(pageKey, String((parseInt(v || '0') + 1)), { expirationTtl: 60 * 60 * 24 * 35 });
  }).catch(() => {});
}

// ============================================================
// ROUTE: /raw/ — serves plain preview HTML for SPA iframe
// No SPA wrapping, no manage panel — just the raw site HTML.
// Called by preview-manage-new.html iframe src.
// URL format: preview.websitehub.co.za/{slug}/raw/
// ============================================================

async function servePreviewRaw(url, env) {
  // Extract slug from path: /{slug}/raw/
  const parts = url.pathname.replace(/\/raw\/?$/, '').split('/').filter(Boolean);
  const slug  = parts[0];
  if (!slug) return htmlResponse('<p>No slug</p>', 400);

  const page = url.searchParams.get('page') || 'index';

  // Try page-specific key first, then root key
  let html = await env.SITES.get(`preview:${slug}:${page}`);
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
// ROUTE: /formspree-webhook — inbound lead → queued build
// ============================================================

async function handleFormspreeWebhook(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const fields = mapFormspreeToAirtable(body);

  // Referral attribution
  const referralSlug = body['referral'] || body['Referral'] || body['ref'] || null;
  if (referralSlug) {
    fields['Referral Slug'] = referralSlug;
    const refMonthKey = `referral:sent:${referralSlug}:${currentMonthKey()}`;
    const refCurrent  = parseInt(await env.SITES.get(refMonthKey).catch(() => '0') || '0');
    await env.SITES.put(refMonthKey, String(refCurrent + 1), { expirationTtl: 60 * 60 * 24 * 35 }).catch(() => {});
  }

  let record;
  try { record = await createAirtableRecord(fields, env); }
  catch (err) { return jsonResponse({ error: `Airtable error: ${err.message}` }, 500); }

  await logActivity(env, 'lead_created', { airtableId: record.id, business: fields['Business Name'] });

  const token    = crypto.randomUUID().replace(/-/g, '');
  const slug     = slugify(fields['Business Name']);
  const phone    = fields['WhatsApp'];
  const name     = fields['Client Name']?.split(' ')[0] || 'there';
  const buildUrl = `https://${PREVIEW_DOMAIN}/build/${token}`;

  await env.SITES.put(`build_status:${token}`, JSON.stringify({ status: 'building', slug }));

  await env.BUILD_QUEUE.send({
    airtableId: record.id,
    paymentId:  null,
    fields,
    isOutbound: false,
    buildToken: token,
  });

  await sendWhatsApp(phone,
    `🔨 Hi ${name}! We're building your *${fields['Business Name']}* website right now.\n\nWe'll send you the link the moment it's ready — usually about 2 minutes. Sit tight!\n\n_You can also watch it build here: ${buildUrl}_\n— Website Hub`,
    env);

  await sendWhatsApp(env.WH_PHONE,
    `🆕 INBOUND LEAD: ${fields['Business Name']}\nPackage: ${fields['Package']}\nClient: ${fields['Client Name']}\nReferral: ${referralSlug || 'None'}\nAirtable: ${record.id}\nBuild: ${buildUrl}`,
    env, { skipTestRedirect: true });

  return jsonResponse({ success: true, redirect: buildUrl, airtableId: record.id });
}

// ============================================================
// ROUTE: /verify-pin — PIN verification (orphan now wired)
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
  const slug = slugify(session.fields['Business Name']);
  await env.SITES.put(`build_status:${token}`, JSON.stringify({ status: 'building', slug }));

  await env.BUILD_QUEUE.send({
    airtableId: session.airtableId,
    paymentId:  null,
    fields:     session.fields,
    isOutbound: false,
    buildToken: token,
  });

  return jsonResponse({ success: true, slug });
}

// ============================================================
// ROUTE: /build-status — polling endpoint for verify page
// ============================================================

async function handleBuildStatus(request, url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);
  const raw = await env.SITES.get(`build_status:${token}`);
  if (!raw) return jsonResponse({ status: 'not_found' }, 404);
  return jsonResponse(JSON.parse(raw));
}

// ============================================================
// ROUTE: /preview-choices — save panel selections
// ============================================================

async function handlePreviewChoices(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { slug, palette, font, photo, tagline, logo_url } = body;
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  await env.SITES.put(
    `preview_choices:${slug}`,
    JSON.stringify({ palette, font, photo, tagline, logo_url, savedAt: new Date().toISOString() }),
    { expirationTtl: 60 * 60 * 24 * 35 },
  );
  return jsonResponse({ success: true, slug });
}

// ============================================================
// ROUTE: /preview-meta — preview panel data for the SPA
// ============================================================

async function handlePreviewMeta(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  let records;
  try { records = await listAirtableRecords(`{Slug} = "${slug}"`, env); }
  catch { return jsonResponse({ error: 'Lookup failed' }, 500); }

  if (!records.length) return jsonResponse({ error: 'Not found' }, 404);

  const record   = records[0];
  const f        = record.fields;
  const pkg      = f['Package'] || 'Standard';
  const tier     = getPricingTier(pkg);
  const industry = (f['Industry'] || 'default').toLowerCase();

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
  const taglineKey = Object.keys(TAGLINES).find(k => industry.includes(k)) || 'default';
  const taglines   = TAGLINES[taglineKey];

  return jsonResponse({
    airtableId:   record.id,
    slug,
    package:      pkg,
    buildFee:     tier.build,
    retainer:     tier.retainer,
    businessName: f['Business Name'] || '',
    industry:     f['Industry'] || '',
    area:         f['Area'] || '',
    domain:       f['Domain'] || `${slug}.co.za`,
    heroPhotos:   heroPhotoUrls,
    taglines,
    manageToken:  f['Manage Token'] || null,
  });
}

// ============================================================
// ROUTE: /purge-kv — wipe every key in the SITES namespace
// DELETE method, protected by x-admin-key.
// Handles pagination internally so it clears everything in one call
// regardless of how many keys exist. Returns { deleted: N }.
// ============================================================
async function handlePurgeKv(request, env) {
  if (request.method !== 'DELETE') return jsonResponse({ error: 'DELETE only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let deleted = 0;
  let cursor  = undefined;

  do {
    const page = await env.SITES.list(cursor ? { cursor } : {});
    await Promise.all(page.keys.map(k => env.SITES.delete(k.name)));
    deleted += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor !== undefined);

  await logActivity(env, 'kv_purged', { deleted });
  return jsonResponse({ success: true, deleted });
}

// ============================================================
// ROUTE: /bootstrap-templates — load template HTML files into KV
// POST body: { archetype: 'emergency', page: 'index', html: '<!DOCTYPE...' }
// Protected by x-admin-key header.
// Call 30 times (5 archetypes × 6 files) to load the full library.
// KV key format: template:{archetype}:{page}
// ============================================================

async function handleBootstrapTemplates(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { archetype, page, html } = body;

  const validArchetypes = ['emergency', 'trust', 'experience', 'local', 'results'];
  const validPages      = ['css', 'index', 'services', 'about', 'contact', 'p5'];

  if (!validArchetypes.includes(archetype)) {
    return jsonResponse({ error: `Invalid archetype. Must be one of: ${validArchetypes.join(', ')}` }, 400);
  }
  if (!validPages.includes(page)) {
    return jsonResponse({ error: `Invalid page. Must be one of: ${validPages.join(', ')}` }, 400);
  }
  if (!html || typeof html !== 'string') {
    return jsonResponse({ error: 'Missing or invalid html field' }, 400);
  }

  const key = `template:${archetype}:${page}`;
  await env.SITES.put(key, html);
  await logActivity(env, 'template_bootstrapped', { archetype, page, key, size: html.length });

  return jsonResponse({ success: true, key, archetype, page, size: html.length });
}

// ============================================================
// ROUTE: /bootstrap-preview-app — push SPA HTML into KV
// ============================================================

async function handleBootstrapPreviewApp(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  const html = await request.text();
  if (!html || !html.includes('<!DOCTYPE')) {
    return jsonResponse({ error: 'Invalid HTML — must be a full DOCTYPE document' }, 400);
  }

  await env.SITES.put('app:preview-manage', html);
  await logActivity(env, 'preview_app_bootstrapped', { size: html.length });
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

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found in Airtable' }, 404); }

  const f = record.fields;
  const allowedStatuses = ['Lead', 'Building', 'QA', 'Live']; // Live = patch-worker asset rebuild
  if (!allowedStatuses.includes(f['Status'])) {
    return jsonResponse({ error: `Build blocked — status is "${f['Status']}" (must be Deposit Paid, QA, or Live)` }, 403);
  }

  await updateAirtableRecord(airtableId, { 'Status': 'Building' }, env);
  await logActivity(env, 'build_triggered', { airtableId, business: f['Business Name'], source: 'admin' });
  await sendWhatsApp(env.WH_PHONE, `🔨 BUILD STARTED: ${f['Business Name']} (${f['Package']})`, env, { skipTestRedirect: true });

  await env.BUILD_QUEUE.send({ airtableId, paymentId: null, fields: f });
  return jsonResponse({ success: true, airtableId });
}

// ============================================================
// ROUTE: /update-status — admin status patch
// ============================================================

async function handleUpdateStatus(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId, status, ...extra } = body;
  if (!airtableId || !status) return jsonResponse({ error: 'Missing airtableId or status' }, 400);

  await updateAirtableRecord(airtableId, { 'Status': status, ...extra }, env);
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

  // Feature flag persistence — accepts both naming styles
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

  // Merge prospecting config
  const existing = JSON.parse(await env.SITES.get('config:outbound').catch(() => null) || '{}');
  const merged = {
    daily_volume: body.daily_volume ?? body['config:daily_volume'] ?? existing.daily_volume ?? 10,
    mode:         body.mode         ?? body['config:mode']         ?? existing.mode         ?? 'manual',
    provinces:    body.provinces    ?? body['config:provinces']    ?? existing.provinces    ?? [],
    industries:   body.industries   ?? body['config:industries']   ?? existing.industries   ?? [],
  };
  if (merged.provinces && !Array.isArray(merged.provinces)) {
    merged.provinces = Object.entries(merged.provinces).filter(([, v]) => v === true).map(([k]) => k);
  }
  if (merged.industries && !Array.isArray(merged.industries)) {
    merged.industries = Object.entries(merged.industries).filter(([, v]) => v === true).map(([k]) => k);
  }

  await env.SITES.put('config:outbound', JSON.stringify(merged));
  await logActivity(env, 'config_updated', { merged });
  return jsonResponse({ success: true, config: merged });
}

// ============================================================
// ROUTE: /outbound-prospect — manual outbound trigger
// ============================================================

async function handleOutboundProspect(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  // TEST_MODE guard — never burn real WhatsApp template credits during testing
  if (isTestMode(env)) {
    return jsonResponse({ error: 'Outbound disabled in TEST_MODE' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { businessName, phone, industry, area, about, services } = body;
  if (!businessName || !phone) return jsonResponse({ error: 'Missing businessName or phone' }, 400);

  const intl     = normaliseSaPhone(phone);
  const optedOut = await env.SITES.get(`optout:${intl}`);
  if (optedOut) return jsonResponse({ error: 'Number opted out' }, 403);

  const cooldown = await env.SITES.get(`prospect_closed:${intl}`);
  if (cooldown) {
    const daysSince = Math.floor((Date.now() - new Date(cooldown).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince < PROSPECT_COOLDOWN_DAYS) {
      return jsonResponse({ error: `In ${PROSPECT_COOLDOWN_DAYS}-day cooldown (${PROSPECT_COOLDOWN_DAYS - daysSince} days remaining)` }, 403);
    }
  }

  const slug     = slugify(businessName);
  const existing = await env.SITES.get(`outbound:${slug}`);
  if (existing) return jsonResponse({ error: 'Already contacted' }, 409);

  const domain       = `${slug}.co.za`;
  const domainStatus = await checkDomainAvailabilityInternal(domain, env);

  const fields = {
    'Business Name':   businessName,
    'WhatsApp':        intl,
    'Industry':        industry || '',
    'Area':            area     || '',
    'About':           about    || '',
    'Services':        services || '',
    'Package':         'Standard',
    'Hosting':         'Hosted',
    'Build Fee':       PRICING.standard.build,
    'Retainer':        PRICING.standard.retainer,
    'Status':          'Lead',
    'Source':          'Scrape',
    'Domain':          domain,
    'Slug':            slug,
    'Submission Date': todayDateString(),
  };

  let record;
  try { record = await createAirtableRecord(fields, env); }
  catch (err) { return jsonResponse({ error: `Airtable error: ${err.message}` }, 500); }

  await env.SITES.put(`outbound:${slug}`, record.id);
  await env.SITES.put(`prospect_state:${intl}`, JSON.stringify({
    airtableId: record.id, slug, sentAt: new Date().toISOString(), phase: 'sent',
  }));

  await env.BUILD_QUEUE.send({ airtableId: record.id, paymentId: null, fields, isOutbound: true });
  await logActivity(env, 'outbound_queued', { airtableId: record.id, business: businessName, phone: intl });

  return jsonResponse({ success: true, airtableId: record.id, domain, domainStatus });
}

// ============================================================
// ROUTE: /preview-revert — restore preview from snapshot
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
// ROUTE: /check-domain — registerdomain.co.za API
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
        const data = await res.json();
        const available = data.available === true || data.status === 'available';
        const alternatives = available ? [] : [
          `${slug}-pta.co.za`,
          `${slug}-sa.co.za`,
          `${slug}online.co.za`,
        ].slice(0, 3);
        return jsonResponse({ available, domain, alternatives });
      }
    } catch { /* fall through to WHOIS */ }
  }

  const result = await checkDomainAvailabilityWhois(domain);
  const alternatives = result.available === false ? [
    `${slug}-pta.co.za`,
    `${slug}-sa.co.za`,
    `${slug}online.co.za`,
  ] : [];
  return jsonResponse({ ...result, alternatives, fallback: true });
}

async function handleDomainCheck(url, env) {
  const name = url.searchParams.get('name');
  if (!name) return jsonResponse({ error: 'Missing name parameter' }, 400);

  const sld = name.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/\.co\.za$/, '');
  if (!sld) return jsonResponse({ error: 'Invalid domain name' }, 400);
  const domain = `${sld}.co.za`;

  // Try proxy if configured; otherwise fall straight to WHOIS
  try {
    const data = await callDomainProxy('CheckAvailability', sld, 'co.za', {}, env);
    const available = data?.result === 'available' || data?.available === true || data?.result === 'success' || String(data?.result).includes('available');

    let suggestions = [];
    if (!available) {
      const alts = [
        sld + '-sa',
        sld.replace(/-/g, ''),
        sld + '-' + new Date().getFullYear().toString().slice(-2),
      ].filter((v, i, a) => a.indexOf(v) === i && v !== sld);

      suggestions = await Promise.all(alts.map(async altSld => {
        try {
          const altData = await callDomainProxy('CheckAvailability', altSld, 'co.za', {}, env);
          const altAvail = altData?.result === 'available' || altData?.available === true;
          return { domain: `${altSld}.co.za`, available: altAvail };
        } catch { return { domain: `${altSld}.co.za`, available: null }; }
      }));
      suggestions = suggestions.filter(s => s.available);
    }
    return jsonResponse({ domain, available, suggestions, raw: data });
  } catch (e) {
    console.warn('Domain proxy failed, falling back to WHOIS:', e.message);
    const result = await checkDomainAvailabilityWhois(domain);
    return jsonResponse({ ...result, fallback: true });
  }
}

async function checkDomainAvailabilityWhois(domain) {
  try {
    const res  = await fetch(`https://www.whois.com/whois/${domain}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
    });
    const text  = await res.text();
    const taken = text.includes('Domain Name:') || text.includes('Registrant');
    const avail = text.includes('No match for') || text.includes('NOT FOUND') || text.includes('is available');
    if (taken) return { domain, available: false };
    if (avail) return { domain, available: true };
    return { domain, available: null, error: 'Could not determine' };
  } catch (e) {
    return { domain, available: null, error: e.message };
  }
}

/** Internal check used by handleOutboundProspect — returns minimal availability info. */
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

const DOMAIN_PROXY_URL    = 'https://websitehub.co.za/domain-proxy.php';

async function callDomainProxy(action, sld, tld = 'co.za', extra = {}, env) {
  const secret = env.DOMAIN_PROXY_SECRET || '';
  if (!secret) console.warn('DOMAIN_PROXY_SECRET env var not set — domain proxy calls will be rejected');
  try {
    const res = await fetch(DOMAIN_PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': secret },
      body:    JSON.stringify({ action, sld, tld, ...extra }),
    });
    const data = await res.json();
    await logHealth(env, 'domain_proxy', res.ok ? 'success' : 'error', data?.error);
    return data;
  } catch (e) {
    await logHealth(env, 'domain_proxy', 'error', e.message);
    throw e;
  }
}

// ============================================================
// ROUTE: /clients — admin dashboard data
// ============================================================

async function handleListClients(request, env) {
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  try {
    const records = await listAirtableRecords('', env);

    const allServices = [
      'build', 'whatsapp', 'airtable', 'zoho', 'payfast', 'outbound',
      'unsplash', 'anthropic', 'google', 'r2', 'domain_proxy',
    ];
    const health = {};
    for (const svc of allServices) {
      try {
        const raw = await env.SITES.get(`health:${svc}`);
        health[svc] = raw ? JSON.parse(raw) : { status: 'unknown' };
      } catch { health[svc] = { status: 'unknown' }; }
    }

    const today        = todayDateString();
    const runRaw       = await env.SITES.get(`outbound_run:${today}`).catch(() => null);
    const outbound_run = runRaw ? JSON.parse(runRaw) : null;

    return jsonResponse({ clients: records, health, outbound_run });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ============================================================
// ROUTE: /health — service health snapshot
// ============================================================

async function handleHealth(env) {
  const services = ['build', 'whatsapp', 'airtable', 'zoho', 'payfast', 'outbound', 'anthropic', 'unsplash', 'domain_proxy'];
  const health   = {};
  for (const svc of services) {
    try {
      const raw = await env.SITES.get(`health:${svc}`);
      health[svc] = raw ? JSON.parse(raw) : { status: 'unknown' };
    } catch { health[svc] = { status: 'unknown' }; }
  }
  return jsonResponse({ health, timestamp: new Date().toISOString(), testMode: isTestMode(env) });
}

// ============================================================
// ROUTE: /analytics — manage panel analytics
// ============================================================

async function handleAnalytics(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const monthStr = currentMonthKey();
  const prevDate = new Date(); prevDate.setMonth(prevDate.getMonth() - 1);
  const prevMonthStr = prevDate.toISOString().slice(0, 7);

  const thisMonth = await sumVisits(slug, monthStr, env);
  const lastMonth = await sumVisits(slug, prevMonthStr, env);
  const perPage   = await perPageBreakdown(slug, monthStr, env);

  // FAB taps recorded by patch-worker /track-fab; null if not yet instrumented
  let fabTaps = null;
  try {
    const raw = await env.SITES.get(`fab_taps:${slug}:${monthStr}`);
    if (raw !== null) fabTaps = parseInt(raw || '0');
  } catch { /* leave as null */ }

  // Top page by visits this month
  const topPage = Object.entries(perPage)
    .sort(([, a], [, b]) => b - a)[0]?.[0] || 'index';

  return jsonResponse({
    views_this_month: thisMonth,
    views_last_month: lastMonth,
    top_page:         topPage,
    per_page:         perPage,
    whatsapp_taps:    fabTaps,
  });
}

async function sumVisits(slug, monthStr, env) {
  const keys = await env.SITES.list({ prefix: `visits:${slug}:` }).catch(() => ({ keys: [] }));
  let total = 0;
  for (const k of keys.keys) {
    // Only count keys matching this month, and exclude per-page keys (have :pageName:date format)
    // Total-day key shape: visits:{slug}:{YYYY-MM-DD}
    // Per-page key shape:  visits:{slug}:{page}:{YYYY-MM-DD}
    const rest = k.name.slice(`visits:${slug}:`.length);
    if (rest.length === 10 && rest.startsWith(monthStr)) {
      const v = await env.SITES.get(k.name).catch(() => '0');
      total += parseInt(v || '0');
    }
  }
  return total;
}

async function perPageBreakdown(slug, monthStr, env) {
  const keys = await env.SITES.list({ prefix: `visits:${slug}:` }).catch(() => ({ keys: [] }));
  const out = {};
  for (const k of keys.keys) {
    const rest = k.name.slice(`visits:${slug}:`.length); // either "YYYY-MM-DD" or "page:YYYY-MM-DD"
    const parts = rest.split(':');
    if (parts.length === 2 && parts[1].startsWith(monthStr)) {
      const page = parts[0];
      const v    = parseInt(await env.SITES.get(k.name).catch(() => '0') || '0');
      out[page]  = (out[page] || 0) + v;
    }
  }
  return out;
}

// ============================================================
// ROUTE: /referral-stats — manage panel referral data
// New KV key conventions per battle plan §6:
//   referral:sent:{slug}:{YYYY-MM}        — monthly sent count
//   referral:conversions:{slug}           — all-time conversion count
//   leaderboard:cache:{YYYY-MM}           — pre-computed by pulse-worker
// ============================================================

async function handleReferralStats(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const monthStr = currentMonthKey();

  const sent        = parseInt(await env.SITES.get(`referral:sent:${slug}:${monthStr}`).catch(() => '0') || '0');
  const conversions = parseInt(await env.SITES.get(`referral:conversions:${slug}`).catch(() => '0') || '0');

  // Position from pre-computed leaderboard cache (pulse-worker writes daily)
  let position = null;
  try {
    const cacheRaw = await env.SITES.get(`leaderboard:cache:${monthStr}`);
    if (cacheRaw) {
      const board = JSON.parse(cacheRaw);
      const idx   = board.findIndex(e => e.slug === slug);
      if (idx >= 0) position = idx + 1;
    }
  } catch { /* leave as null */ }

  return jsonResponse({ sent, conversions, position, reward_months: conversions });
}

// ============================================================
// ROUTE: /leaderboard — top 10 referrers this month
// Reads pre-computed cache from pulse-worker, falls back to live compute.
// ============================================================

async function handleLeaderboard(request, env) {
  const monthStr = currentMonthKey();
  try {
    const cacheRaw = await env.SITES.get(`leaderboard:cache:${monthStr}`);
    if (cacheRaw) return jsonResponse(JSON.parse(cacheRaw));

    // Fallback: live compute (slow, only happens until pulse-worker first run)
    const allKeys     = await env.SITES.list({ prefix: 'referral:sent:' });
    const monthKeys   = allKeys.keys.filter(k => k.name.endsWith(`:${monthStr}`));
    const slugCounts  = {};
    for (const key of monthKeys) {
      // Key shape: referral:sent:{slug}:{YYYY-MM}
      const parts = key.name.split(':');
      const s     = parts[2];
      const v     = parseInt(await env.SITES.get(key.name).catch(() => '0') || '0');
      slugCounts[s] = (slugCounts[s] || 0) + v;
    }
    const board = Object.entries(slugCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([s, count], i) => ({
        position:  i + 1,
        slug:      s.slice(0, 3) + '***',
        referrals: count,
      }));
    return jsonResponse(board);
  } catch {
    return jsonResponse([]);
  }
}

// ============================================================
// ROUTE: /admin/purge-test-data — system reset
// Deletes all KV keys not belonging to a Live Airtable record.
// Battle plan §"SYSTEM PURGE — DO FIRST". Run before first real test build.
// ============================================================

async function handleAdminPurge(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  // Build the keep-list: slugs belonging to records with Status = Live
  const liveRecords = await listAirtableRecords(`{Status} = "Live"`, env).catch(() => []);
  const keepSlugs   = new Set(
    liveRecords.map(r => r.fields?.['Slug'] || slugify(r.fields?.['Business Name'] || ''))
                .filter(Boolean),
  );

  // Prefixes that store per-client data and may contain stale keys
  const slugPrefixes = [
    'preview:', 'preview-original:', 'preview_choices:', 'preview_expiry:',
    'draft:', 'live:', 'css:', 'content:',
    'visits:', 'outbound:', 'referral:sent:', 'referral:conversions:',
    'portfolio_candidate:',
  ];
  // System keys to also nuke
  const systemKeysToClear = [
    'system:claude_model', // force fresh model resolution
  ];

  let scanned = 0, deleted = 0, kept = 0;

  for (const prefix of slugPrefixes) {
    let cursor = undefined;
    do {
      const page = await env.SITES.list({ prefix, cursor }).catch(() => ({ keys: [] }));
      for (const k of page.keys) {
        scanned++;
        const rest = k.name.slice(prefix.length);
        const slug = rest.split(':')[0];
        if (keepSlugs.has(slug)) { kept++; continue; }
        await env.SITES.delete(k.name).catch(() => {});
        deleted++;
      }
      cursor = page.cursor;
      if (page.list_complete) break;
    } while (cursor);
  }

  for (const k of systemKeysToClear) {
    try { await env.SITES.delete(k); deleted++; } catch { /* non-fatal */ }
  }

  // Also clear test-mode logs (zoho payload snapshots, etc)
  let testCursor = undefined;
  do {
    const page = await env.SITES.list({ prefix: 'test_log:', cursor: testCursor }).catch(() => ({ keys: [] }));
    for (const k of page.keys) { await env.SITES.delete(k.name).catch(() => {}); deleted++; }
    testCursor = page.cursor;
    if (page.list_complete) break;
  } while (testCursor);

  await logActivity(env, 'admin_purge', { scanned, deleted, kept, liveCount: keepSlugs.size });
  return jsonResponse({ success: true, scanned, deleted, kept, liveSlugs: [...keepSlugs] });
}

// ============================================================
// INDUSTRY MATRIX — pre-build creative brief lookup
// Each entry gives Claude a complete creative direction before Pass 1.
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
  fitness: {
    aesthetic: 'bold_modern',
    palette: { bg: '#050505', surface: '#111111', accent: '#22c55e', text: '#f0fdf4', muted: '#6b7280' },
    fonts: { display: 'Oswald', body: 'Open Sans' },
    mood: 'energetic, transformative, disciplined, community',
    copyStyle: 'Motivational without cliché. Real results language. SA fitness culture — outdoor training, township gyms.',
    vibeWords: ['Transform', 'Results', 'Discipline', 'Community', 'Stronger'],
    heroImage: 'gym fitness trainer south africa workout',
    trustSignals: ['Qualified Trainers', 'Proven Results', 'All Fitness Levels', 'Free Assessment'],
    emotionalRegister: 'Motivating and inclusive. Your best self starts here.',
  },
  retail: {
    aesthetic: 'soft_organic',
    palette: { bg: '#ffffff', surface: '#f9fafb', accent: '#7c3aed', text: '#111827', muted: '#6b7280' },
    fonts: { display: 'DM Serif Display', body: 'DM Sans' },
    mood: 'curated, trustworthy, value-driven, local pride',
    copyStyle: 'Benefit-first. Price transparency. SA value consciousness. Local is lekker energy.',
    vibeWords: ['Quality', 'Value', 'Local', 'Trusted', 'Wide Range'],
    heroImage: 'retail shop south africa small business products',
    trustSignals: ['Lowest Price Guarantee', 'Easy Returns', 'Local Business', 'Fast Delivery'],
    emotionalRegister: 'Friendly and value-conscious. We have what you need.',
  },
  medical: {
    aesthetic: 'soft_organic',
    palette: { bg: '#f0f9ff', surface: '#ffffff', accent: '#0ea5e9', text: '#0c4a6e', muted: '#64748b' },
    fonts: { display: 'Source Serif 4', body: 'Source Sans 3' },
    mood: 'calm, trustworthy, professional, caring',
    copyStyle: 'Reassuring and clear. No jargon. Empathetic. SA healthcare context — medical aid, state/private crossover.',
    vibeWords: ['Trusted', 'Caring', 'Professional', 'Experienced', 'Compassionate'],
    heroImage: 'medical doctor clinic south africa healthcare professional',
    trustSignals: ['HPCSA Registered', 'Medical Aid Accepted', 'Same-Day Appointments', 'Confidential'],
    emotionalRegister: "Calm and caring. You're in safe, experienced hands.",
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
  transport: {
    aesthetic: 'bold_modern',
    palette: { bg: '#0a0f1e', surface: '#111827', accent: '#3b82f6', text: '#f9fafb', muted: '#9ca3af' },
    fonts: { display: 'Titillium Web', body: 'Open Sans' },
    mood: 'reliable, on-time, professional, safe',
    copyStyle: 'Logistics language made human. Safety and timeliness front and centre. SA route knowledge.',
    vibeWords: ['On Time', 'Safe', 'Reliable', 'Professional', 'Affordable'],
    heroImage: 'transport logistics south africa driver professional',
    trustSignals: ['GPS Tracked', 'Fully Insured', 'Licensed Drivers', 'On-Time Guarantee'],
    emotionalRegister: 'Reliable and professional. Your goods arrive safely, on time, every time.',
  },
  events: {
    aesthetic: 'warm_artisan',
    palette: { bg: '#1a0533', surface: '#2d0a57', accent: '#e879f9', text: '#fdf4ff', muted: '#c084fc' },
    fonts: { display: 'Abril Fatface', body: 'Poppins' },
    mood: 'celebratory, creative, memorable, energetic',
    copyStyle: 'Excitement and anticipation. Sensory language. SA celebration culture — stokvels, lobola, matric dances.',
    vibeWords: ['Unforgettable', 'Spectacular', 'Custom', 'Professional', 'Magical'],
    heroImage: 'event planning south africa celebration party',
    trustSignals: ['100+ Events', 'Fully Equipped', 'Day-Of Coordination', 'Free Consultation'],
    emotionalRegister: 'Joyful and professional. Every detail, perfectly executed.',
  },
  education: {
    aesthetic: 'soft_organic',
    palette: { bg: '#fefce8', surface: '#ffffff', accent: '#ca8a04', text: '#1c1917', muted: '#78716c' },
    fonts: { display: 'Nunito', body: 'Nunito Sans' },
    mood: 'nurturing, encouraging, knowledgeable, community',
    copyStyle: 'Warm and encouraging. Results-focused. SA education landscape — matric, NQF levels, tutoring culture.',
    vibeWords: ['Qualified', 'Results', 'Nurturing', 'Experienced', 'Success'],
    heroImage: 'tutor teacher south africa education classroom',
    trustSignals: ['SACE Registered', 'Qualified Teachers', 'Proven Pass Rates', 'Small Groups'],
    emotionalRegister: 'Warm and encouraging. Every learner can succeed with the right support.',
  },
};

function getIndustryBrief(industry) {
  if (!industry) return INDUSTRY_MATRIX.plumbing; // safe default
  const key = industry.toLowerCase().replace(/[^a-z]/g, '');
  // Fuzzy match
  if (key.includes('plumb')) return INDUSTRY_MATRIX.plumbing;
  if (key.includes('electr')) return INDUSTRY_MATRIX.electrical;
  if (key.includes('clean') || key.includes('maid') || key.includes('domestic')) return INDUSTRY_MATRIX.cleaning;
  if (key.includes('build') || key.includes('construct') || key.includes('renovate') || key.includes('paint')) return INDUSTRY_MATRIX.construction;
  if (key.includes('beauty') || key.includes('hair') || key.includes('nail') || key.includes('salon') || key.includes('spa')) return INDUSTRY_MATRIX.beauty;
  if (key.includes('auto') || key.includes('car') || key.includes('mech') || key.includes('panel') || key.includes('tyre')) return INDUSTRY_MATRIX.automotive;
  if (key.includes('food') || key.includes('cater') || key.includes('restaurant') || key.includes('bakery') || key.includes('cook')) return INDUSTRY_MATRIX.food;
  if (key.includes('fit') || key.includes('gym') || key.includes('train') || key.includes('sport')) return INDUSTRY_MATRIX.fitness;
  if (key.includes('retail') || key.includes('shop') || key.includes('store')) return INDUSTRY_MATRIX.retail;
  if (key.includes('med') || key.includes('health') || key.includes('clinic') || key.includes('doctor') || key.includes('nurse')) return INDUSTRY_MATRIX.medical;
  if (key.includes('legal') || key.includes('law') || key.includes('attorn') || key.includes('advocate')) return INDUSTRY_MATRIX.legal;
  if (key.includes('property') || key.includes('estate') || key.includes('realty')) return INDUSTRY_MATRIX.realestate;
  if (key.includes('transport') || key.includes('logistics') || key.includes('deliver') || key.includes('courier') || key.includes('driver')) return INDUSTRY_MATRIX.transport;
  if (key.includes('event') || key.includes('wedding') || key.includes('party') || key.includes('function')) return INDUSTRY_MATRIX.events;
  if (key.includes('tutor') || key.includes('teach') || key.includes('educat') || key.includes('school') || key.includes('training')) return INDUSTRY_MATRIX.education;
  // Return a generic brief if no match
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
// BUILD PIPELINE — 5-pass architecture (express / standard / premium)
// Pass 1: Skeleton — content strategy + industry matrix lookup
// Pass 2: Organs  — copy and messaging
// Pass 3: Muscle  — CSS design system
// ============================================================
// BUILD PIPELINE — Template-based 2-pass architecture
// Pass 1: Content strategy JSON (Claude, archetype-aware)
// Pass 2: Token replacement into pre-built templates (instant, no Claude)
// Pass 3: claudePersonalise — only runs if unfilled {{tokens}} remain
// ============================================================

async function triggerBuildInternal(airtableId, paymentId, env, preloadedFields, isOutbound = false) {
  const record = preloadedFields
    ? { fields: preloadedFields }
    : await getAirtableRecord(airtableId, env);
  const f = record.fields || record;

  const slug    = slugify(f['Business Name']);
  const domain  = f['Domain'] || `${slug}.co.za`;
  const pkg     = packageKey(f['Package']);
  const caps    = getPackageCaps(pkg);

  await updateAirtableRecord(airtableId, {
    'Slug':        slug,
    'Mailto Link': `mailto:updates@websitehub.co.za?subject=wh-${slug}&body=Hi%20Website%20Hub%2C%20please%20find%20my%20photos%20attached.`,
    'Status':      'Building',
    'Domain':      domain,
  }, env);

  // Detect archetype from industry
  const archetype = detectArchetype(f['Industry'] || f['Business Name'] || '');

  // Unsplash fallback photo for og:image
  let unsplashPhotos = [];
  try { unsplashPhotos = await fetchUnsplashPhotos(f, env); }
  catch (e) { console.warn('Unsplash fetch failed (non-fatal):', e); }

  // R2 client photos
  let r2PhotoUrls = [];
  try {
    if (env.ASSETS) {
      const r2List = await env.ASSETS.list({ prefix: `${slug}/gallery/` });
      if (r2List.objects?.length > 0) {
        r2PhotoUrls = r2List.objects.map(obj => `https://assets.websitehub.co.za/${obj.key}`);
      }
    }
  } catch (e) { console.warn('R2 photo fetch failed (non-fatal):', e); }

  const ogImage = r2PhotoUrls[0] || unsplashPhotos[0]?.url
    || 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&q=80';

  // ── PASS 1 — Content Strategy (archetype-aware Claude call) ──
  let contentJson;
  try {
    const p1Raw = await callClaudeInternal(
      buildPass1SystemPrompt(archetype),
      [{ role: 'user', content: buildPass1UserPrompt(f, archetype, ogImage) }],
      env,
      { maxTokens: PASS_1_MAX_TOKENS },
    );
    const cleaned = p1Raw.replace(/```json|```/g, '').trim();
    contentJson = JSON.parse(cleaned);
    await env.SITES.put(`content:${slug}`, JSON.stringify(contentJson), { expirationTtl: 60 * 60 * 24 * 35 });
  } catch (e) {
    throw new Error(`Pass 1 failed: ${e.message}`);
  }

  // ── FETCH TEMPLATES from KV ───────────────────────────────────
  const { css, pages } = await fetchTemplates(archetype, pkg, env);

  // Business fields object for tokenReplace
  const businessFields = {
    name:           f['Business Name'] || '',
    phone:          normaliseSaPhone(f['WhatsApp'] || ''),
    area:           f['Area']          || '',
    email:          f['Email']         || '',
    address_line1:  f['Address Line 1'] || f['Area'] || '',
    address_line2:  f['Address Line 2'] || '',
    hours_weekday:  f['Hours Weekday']  || 'Mon–Fri: 8am–5pm',
    hours_saturday: f['Hours Saturday'] || 'Saturday: 8am–1pm',
    hours_sunday:   f['Hours Sunday']   || 'Sunday: Closed',
    hours_emergency: f['Hours Emergency'] || '24/7 for emergencies',
  };

  // ── BUILD PAGES ────────────────────────────────────────────────
  const builtPages = {};

  if (pkg === 'express') {
    // Token-replace all pages first, then collapse into single scroll
    const replaced = {};
    for (const [pg, tmpl] of Object.entries(pages)) {
      if (tmpl) replaced[pg] = tokenReplace(tmpl, contentJson, businessFields, ogImage);
    }
    // Build express single-scroll from full page set (use standard templates if available)
    const expressBase = {
      index:    replaced.index,
      services: replaced.services || await env.SITES.get(`template:${archetype}:services`).then(t => t ? tokenReplace(t, contentJson, businessFields, ogImage) : null).catch(() => null),
      about:    replaced.about    || await env.SITES.get(`template:${archetype}:about`).then(t => t ? tokenReplace(t, contentJson, businessFields, ogImage) : null).catch(() => null),
      contact:  replaced.contact  || await env.SITES.get(`template:${archetype}:contact`).then(t => t ? tokenReplace(t, contentJson, businessFields, ogImage) : null).catch(() => null),
    };
    let html = buildExpressPage(expressBase);
    html = injectCss(html, css, 'index');
    html = await claudePersonalise(html, contentJson, businessFields, archetype, env);
    builtPages['index'] = html;
  } else {
    for (const [pageName, template] of Object.entries(pages)) {
      if (!template) { console.warn(`Template missing for ${archetype}:${pageName}`); continue; }
      let html = tokenReplace(template, contentJson, businessFields, ogImage);
      html = injectCss(html, css, pageName);
      html = await claudePersonalise(html, contentJson, businessFields, archetype, env);

      // QA
      const qaResult = runQAChecks(html, f, pageName, contentJson);
      if (!qaResult.passed) {
        console.warn(`QA issues on "${pageName}" for ${f['Business Name']}:`, qaResult.failures.join(', '));
        await sendWhatsApp(env.WH_PHONE,
          `⚠️ QA issues on "${pageName}": ${f['Business Name']}\n${qaResult.failures.join(', ')}`,
          env, { skipTestRedirect: true }).catch(() => {});
        await updateAirtableRecord(airtableId, { 'QA Status': 'Issues' }, env).catch(() => {});
      } else {
        await updateAirtableRecord(airtableId, { 'QA Status': 'Passed' }, env).catch(() => {});
      }

      builtPages[pageName] = html;
    }
  }

  if (!builtPages['index']) throw new Error('Home page (index) failed to build — aborting');

  // ── STORE PAGES IN KV ──────────────────────────────────────────
  const previewUrl = `https://${PREVIEW_DOMAIN}/${slug}`;

  for (const [pageName, html] of Object.entries(builtPages)) {
    const withWatermark = isOutbound ? addWatermark(html, f, domain, airtableId, env) : html;
    await env.SITES.put(`preview:${slug}:${pageName}`, withWatermark, { expirationTtl: 60 * 60 * 24 * 35 });
    await env.SITES.put(`draft:${slug}:${pageName}`,   html,          { expirationTtl: 60 * 60 * 24 * 35 });
  }

  // Backward-compat single-key entries
  const homeWithWatermark = isOutbound ? addWatermark(builtPages['index'], f, domain, airtableId, env) : builtPages['index'];
  await env.SITES.put(`preview:${slug}`,          homeWithWatermark,        { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`preview-original:${slug}`, homeWithWatermark,        { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`draft:${slug}`,            builtPages['index'],      { expirationTtl: 60 * 60 * 24 * 35 });

  const expiryDate = new Date(Date.now() + PREVIEW_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.SITES.put(`preview_expiry:${slug}`, expiryDate);

  await logBuild(airtableId, 'Success', null, env);
  await logHealth(env, 'build', 'success');

  await updateAirtableRecord(airtableId, {
    'Status':     'QA',
    'PreviewURL': previewUrl,
    ...(paymentId ? { 'PayFast Payment ID': paymentId } : {}),
  }, env);

  if (isOutbound) {
    await sendOutboundPreviewMessage(f, previewUrl, domain, airtableId, env);
  } else {
    await sendInboundPreviewMessage(f, previewUrl, domain, airtableId, env);
  }

  await sendWhatsApp(env.WH_PHONE,
    `✅ BUILD COMPLETE: ${f['Business Name']}\nArchetype: ${archetype}\nPreview: ${previewUrl}\nPackage: ${pkg}\nPages: ${Object.keys(builtPages).length}`,
    env, { skipTestRedirect: true },
  );

  return slug;
}

/**
 * claudePersonalise — lightweight cleanup pass.
 * Only calls Claude if there are still unfilled {{token}} placeholders
 * after tokenReplace (e.g. archetype-specific tokens not in contentJson).
 * Returns the HTML unchanged if nothing needs filling.
 */
async function claudePersonalise(html, contentJson, businessFields, archetype, env) {
  // All tokens are covered by tokenReplace — no Claude call needed.
  return html;
}
/**
 * Inject the CSS block into the page HTML at the WH_CSS_INJECT placeholder.
 * Fallback chain: marker → </head> → <body → prepend.
 * Pass 3 system prompt instructs the model to emit <!--WH_CSS_INJECT--> exactly
 * once; this function makes it real.
 */
function injectCss(html, cssBlock, pageName) {
  if (html.includes('<!--WH_CSS_INJECT-->')) {
    return html.replace('<!--WH_CSS_INJECT-->', cssBlock);
  }
  console.warn(`Page "${pageName}" omitted WH_CSS_INJECT marker — using fallback injection`);
  if (html.includes('</head>')) return html.replace('</head>', `${cssBlock}\n</head>`);
  if (/<body\b/i.test(html))   return html.replace(/<body\b/i, `${cssBlock}\n<body`);
  return cssBlock + '\n' + html;
}

// ============================================================
// PREVIEW MESSAGES — inbound + outbound
// ============================================================

async function sendInboundPreviewMessage(f, previewUrl, domain, airtableId, env) {
  const name = f['Client Name']?.split(' ')[0] || 'there';

  await sendWhatsApp(f['WhatsApp'],
    `🎉 Hi ${name}! Your *${f['Business Name']}* website is ready!\n\n👀 See it here:\n${previewUrl}\n\nTap *Go Live* on the page to publish it. ⚡\n\n🌐 Your site will be live at *${domain}*\n\nWant changes? Just reply here.\n— Website Hub`,
    env);
  await logActivity(env, 'preview_sent', { airtableId, business: f['Business Name'], type: 'inbound' });
}

async function sendOutboundPreviewMessage(f, previewUrl, domain, airtableId, env) {
  const tier = getPricingTier(f['Package'] || 'Standard');

  // NEW ARCHITECTURE: Outbound converges with inbound at preview stage.
  // No payment link in first message — customer sees preview first, then clicks "Go Live".
  try {
    const prompt = `Write a WhatsApp message to a South African small business owner. Maximum 4 lines. Warm and direct — SA tone.

Business name: ${f['Business Name']}
Town/Area: ${f['Area'] || 'South Africa'}
Industry: ${f['Industry'] || 'small business'}

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
    await sendWhatsApp(f['WhatsApp'], message.trim(), env);
  } catch {
    await sendWhatsApp(f['WhatsApp'],
      `Hi *${f['Business Name']}* in ${f['Area'] || 'South Africa'} 👋

Our team built your business a free website — no strings attached.

👀 ${previewUrl}

Tap *Go Live* on the page to publish it for R${tier.retainer}/month.

_Reply STOP to opt out._`,
      env);
  }

  await logActivity(env, 'outbound_message_sent', { airtableId, business: f['Business Name'] });
}

// ============================================================
// UNSPLASH — stock photo fetching
// ============================================================

const INDUSTRY_COLLECTIONS = {
  'automotive':       '10082805',
  'car':              '10082805',
  'barber':           '1287248',
  'hair':             'j-aT-qQ5Df4',
  'salon':            'j-aT-qQ5Df4',
  'beauty':           'j-aT-qQ5Df4',
  'nails':            'j-aT-qQ5Df4',
  'spa':              'j-aT-qQ5Df4',
  'lashes':           'j-aT-qQ5Df4',
  'wax':              'j-aT-qQ5Df4',
  'cleaning':         'XbKl76m98Q0',
  'construction':     'V_jwB-ViUcU',
  'builder':          'V_jwB-ViUcU',
  'designer':         '490175',
  'creative':         '490175',
  'electrical':       'pWwvS2-nOFw',
  'electrician':      'pWwvS2-nOFw',
  'estate':           '9570795',
  'property':         '9570795',
  'real estate':      '9570795',
  'flooring':         'VE1938cQh68',
  'tiles':            'VE1938cQh68',
  'fitness':          '8325170',
  'gym':              '8325170',
  'health':           '8325170',
  'personal trainer': 'XauNd42mbfU',
  'kids':             '4939660',
  'education':        '4939660',
  'school':           '4939660',
  'tutor':            '4939660',
  'medical':          '4556826',
  'dental':           '4556826',
  'doctor':           '4556826',
  'clinic':           '4556826',
  'other':            '917133',
  'plumber':          'aR-OOwl7fD0',
  'plumbing':         'aR-OOwl7fD0',
  'professional':     'HNAhB_A7-yY',
  'lawyer':           'HNAhB_A7-yY',
  'accountant':       'HNAhB_A7-yY',
  'restaurant':       '345703',
  'food':             '345703',
  'cafe':             '345703',
  'catering':         '345703',
  'retail':           '9803932',
  'boutique':         '9803932',
  'shop':             '9803932',
  'clothing':         '9803932',
  'trades':           '1869713',
  'handyman':         '1869713',
};

function getCollectionId(industry) {
  const key = (industry || '').toLowerCase();
  for (const [fragment, id] of Object.entries(INDUSTRY_COLLECTIONS)) {
    if (key.includes(fragment)) return id;
  }
  return null;
}

async function fetchUnsplashPhotos(f, env) {
  if (!env.UNSPLASH_ACCESS_KEY) return [];

  const industry     = f['Industry'] || '';
  const vibe         = f['Vibe']     || '';
  const collectionId = getCollectionId(industry);

  const slots = [
    { slot: 'HERO IMAGE',                query: `${industry} hero South Africa` },
    { slot: 'ABOUT SECTION IMAGE',       query: `${industry} people team South Africa` },
    { slot: 'SERVICE IMAGE 1',           query: `${industry} professional workspace` },
    { slot: 'SERVICE IMAGE 2',           query: `${industry} ${vibe} detail` },
    { slot: 'BACKGROUND / ACCENT IMAGE', query: `${vibe || industry} texture minimal` },
  ];

  const photos = [];
  for (const { slot, query } of slots) {
    try {
      const endpoint = collectionId
        ? `https://api.unsplash.com/photos/random?collections=${collectionId}&orientation=landscape&content_filter=high`
        : `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query.trim().slice(0, 100))}&orientation=landscape&content_filter=high`;
      const res = await fetch(endpoint, {
        headers: { 'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' },
      });
      if (!res.ok) continue;
      const data = await res.json();
      photos.push({ slot, url: data.urls?.regular || data.urls?.full, credit: data.user?.name || 'Unsplash' });
    } catch (e) { console.warn(`Unsplash error for "${slot}":`, e); }
  }

  await logHealth(env, 'unsplash', photos.length > 0 ? 'success' : 'partial');
  return photos;
}

// ============================================================
// OUTBOUND PROSPECTING — Google Places + WhatsApp opt-in template
// ============================================================

async function runOutboundCron(env, todayStr) {
  const configStr = await env.SITES.get('config:outbound').catch(() => null);
  const config    = configStr ? JSON.parse(configStr) : {};

  const dailyVolume = parseInt(config.daily_volume || '10');
  const provinces   = config.provinces  || [];
  const industries  = config.industries || [];
  const mode        = config.mode       || 'manual';

  if (provinces.length === 0 || industries.length === 0) {
    await logActivity(env, 'outbound_skipped', { reason: 'No provinces or industries configured' });
    return;
  }

  const province = provinces[Math.floor(Math.random() * provinces.length)];
  const industry = industries[Math.floor(Math.random() * industries.length)];

  let prospects = [];
  try { prospects = await fetchGooglePlacesProspects(province, industry, dailyVolume, env); }
  catch (e) {
    await logActivity(env, 'outbound_places_error', { error: e.message });
    return;
  }

  let found = 0, queued = 0, skipped = 0, failed = 0;

  for (const prospect of prospects) {
    found++;
    if (!prospect.phone) { skipped++; continue; }

    const intl     = normaliseSaPhone(prospect.phone);
    const slug     = slugify(prospect.name);
    const optedOut = await env.SITES.get(`optout:${intl}`).catch(() => null);
    const cooldown = await env.SITES.get(`prospect_closed:${intl}`).catch(() => null);
    const existing = await env.SITES.get(`outbound:${slug}`).catch(() => null);

    if (optedOut || existing) { skipped++; continue; }
    if (cooldown) {
      const daysSince = Math.floor((Date.now() - new Date(cooldown).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince < PROSPECT_COOLDOWN_DAYS) { skipped++; continue; }
    }

    try {
      if (mode === 'auto') {
        // Opt-in FIRST — never build cold. Send template, build only on name reply.
        const prospectFields = {
          'Business Name':   prospect.name,
          'WhatsApp':        intl,
          'Industry':        industry,
          'Area':            prospect.area || province,
          'About':           prospect.about    || '',
          'Services':        prospect.services || '',
          'Package':         'Standard',
          'Hosting':         'Hosted',
          'Build Fee':       PRICING.standard.build,
          'Retainer':        PRICING.standard.retainer,
          'Status':          'Lead',
          'Source':          'Scrape',
          'Domain':          `${slug}.co.za`,
          'Slug':            slug,
          'Submission Date': todayStr,
        };

        let prospectRecord;
        try { prospectRecord = await createAirtableRecord(prospectFields, env); }
        catch (e) { failed++; continue; }

        await env.SITES.put(`prospect:${intl}`, JSON.stringify({
          airtableId: prospectRecord.id,
          fields:     prospectFields,
          slug,
          createdAt:  new Date().toISOString(),
        }), { expirationTtl: 60 * 60 * 24 * 30 });

        await env.SITES.put(`outbound:${slug}`, prospectRecord.id);
        await env.SITES.put(`prospect_state:${intl}`, JSON.stringify({
          airtableId: prospectRecord.id, slug, sentAt: new Date().toISOString(), phase: 'sent',
        }));
        await env.SITES.put(`state:${intl}`, JSON.stringify({
          state: 'PROSPECT', airtableId: prospectRecord.id, slug, updatedAt: new Date().toISOString(),
        }));

        await queueScheduledMessage(prospectRecord.id, intl,
          `Hi *${prospect.name}* 👋\n\nWe build free website previews for SA businesses — no payment needed to see yours.\n\nReply with your *first name* and we'll build it now.\n\n_Reply STOP to opt out._`,
          env, { respectDayOfWeek: false },
        );
        queued++;
      } else {
        // Manual mode: log to KV for admin approval via dashboard
        await env.SITES.put(`outbound_pending:${slug}`, JSON.stringify({
          name:      prospect.name,
          phone:     intl,
          industry,
          area:      prospect.area || province,
          about:     prospect.about    || '',
          services:  prospect.services || '',
          timestamp: new Date().toISOString(),
        }));
        queued++;
      }
    } catch { failed++; }
  }

  const runLog = { date: todayStr, province, industry, found, queued, skipped, failed, mode };
  await env.SITES.put(`outbound_run:${todayStr}`, JSON.stringify(runLog), { expirationTtl: 60 * 60 * 24 * 30 });
  await logActivity(env, 'outbound_run_complete', runLog);
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
      const detailUrl  = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=formatted_phone_number,website,name,vicinity&key=${env.GOOGLE_PLACES_API_KEY}`;
      const detailRes  = await fetch(detailUrl);
      const detailData = await detailRes.json();
      phone   = detailData.result?.formatted_phone_number;
      website = detailData.result?.website;
    } catch { /* skip */ }

    // Skip prospects with an existing real website (don't poach)
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
// BUILD PROMPTS — Pass 1 archetype-aware content strategy
// Pass 1 is the only Claude call in the new template pipeline.
// It outputs a complete JSON object covering all tokens for the
// detected archetype. tokenReplace() in shared-services fills
// the template; claudePersonalise() handles any gaps.
// ============================================================

function buildPass1SystemPrompt(archetype) {
  const archetypeContext = {
    emergency: 'emergency trades business (plumber/electrician/locksmith/AC/security). Someone is stressed, something is broken, they need help NOW. Be urgent, confident, and reassuring.',
    trust:     'professional services business (lawyer/accountant/doctor/dentist/financial advisor). Client is handing over a serious problem — they need to feel SAFE. Be authoritative, calm, and credentialed.',
    experience: 'experience-based business (restaurant/salon/spa/barber/hotel). Client is buying a feeling, not just a service. Make them imagine being there — warm, sensory, aspirational.',
    local:     'local community business (hardware/pharmacy/butcher/grocer/creche). Beat chains on trust and relationship. Community beats convenience — personal, neighbourhood-feel, owner-forward.',
    results:   'results-driven business (panel beater/landscaper/renovator/personal trainer/photographer). Show the work and let it sell itself — transformation narrative, outcome-focused, bold.',
  }[archetype] || 'South African small business';

  return `You are a South African brand strategist building website content for a ${archetypeContext}

OUTPUT RULES — non-negotiable:
→ Output ONLY valid JSON. Start with { and end with }. No preamble, no backticks, no markdown.
→ All copy must be warm, confident, specifically South African — not corporate, not American.
→ Headlines must be short, punchy, memorable — built around the actual business story.
→ NEVER use Lorem Ipsum, AI-sounding language, or generic stock phrases.
→ Fill EVERY field — never leave a field as null or empty string unless it genuinely does not apply.
→ All phone tokens must be omitted from JSON — phone is injected separately from Airtable.`;
}

function buildPass1UserPrompt(fields, archetype, ogImage) {
  const f = fields;
  const bizName = f['Business Name'] || '';
  const industry = f['Industry'] || '';
  const area = f['Area'] || '';
  const about = f['About'] || '';
  const services = f['Services'] || '';
  const vibe = f['Vibe'] || '';

  // Archetype-specific JSON schemas
  const schemas = {

    emergency: `{
  "page_title": "${bizName} | Emergency ${industry} | ${area}",
  "og_title": "${bizName} | ${area}'s Trusted ${industry}",
  "og_description": "One sentence — specific, urgent, local",
  "hero_badge": "short location + trust line, max 8 words",
  "hero_h1_line1": "punchy first line — the problem or question",
  "hero_h1_line2": "the solution line",
  "hero_h1_line3": "the proof or speed promise",
  "hero_accent_word": "one word from line2 or line3 to highlight",
  "hero_copy": "2 sentences — the business story, warm and specific to ${area}",
  "cta_primary": "urgent WhatsApp CTA e.g. Get Emergency Help",
  "cta_secondary": "call CTA e.g. Call Pierre Now",
  "stat1_num": "e.g. 15+", "stat1_lbl": "e.g. Years in ${area}",
  "stat2_num": "e.g. 24/7", "stat2_lbl": "e.g. Emergency Response",
  "stat3_num": "e.g. 100%", "stat3_lbl": "e.g. Workmanship Guaranteed",
  "services_section_tag": "e.g. What We Fix",
  "services_h2": "e.g. Our Services",
  "services": [
    {"icon": "emoji", "name": "service name", "desc": "one sentence, specific to ${industry} in ${area}"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence"}
  ],
  "about_section_tag": "e.g. Our Story",
  "about_headline": "specific to their story e.g. 15 Years Keeping ${area} Running",
  "about_pull_quote": "one memorable line capturing their brand promise",
  "about_p1": "paragraph — their story and why they started",
  "about_p2": "paragraph — what makes them different in ${area}",
  "owner_name": "infer from business name or use placeholder",
  "trust_point1": "e.g. Licensed & Insured",
  "trust_point2": "e.g. 24/7 Emergency",
  "trust_point3": "e.g. Upfront Quotes",
  "contact_section_tag": "e.g. Get In Touch",
  "contact_h2_line1": "e.g. Got a problem?",
  "contact_h2_line2": "e.g. Let's sort it out.",
  "contact_copy": "one line — warm, direct, reassuring, specific to response time",
  "hours_emergency": "e.g. 24/7 for emergencies",
  "coverage_intro": "one sentence intro to coverage area",
  "coverage_response_time": "e.g. 30–60 minutes",
  "coverage_areas": ["${area}", "nearby suburb", "nearby suburb", "nearby suburb", "nearby suburb", "nearby suburb", "nearby suburb", "nearby suburb"]
}`,

    trust: `{
  "page_title": "${bizName} | ${industry} | ${area}",
  "og_title": "${bizName} | Trusted ${industry} in ${area}",
  "og_description": "One sentence — authority, area, reassurance",
  "hero_badge": "e.g. Admitted Attorneys Since 1998 · ${area}",
  "hero_h1_line1": "what they protect or resolve",
  "hero_h1_line2": "the emotional promise",
  "hero_h1_line3": "the credibility anchor",
  "hero_accent_word": "one word to highlight in accent colour",
  "hero_copy": "2 sentences — specific, calm, authoritative",
  "cta_primary": "e.g. Book a Consultation",
  "cta_secondary": "e.g. Our Practice Areas",
  "profession": "e.g. Attorney | Accountant | Doctor",
  "founding_year": "e.g. 1998",
  "consultation_fee": "e.g. R850 per hour | Free initial consultation",
  "credential1": "e.g. Law Society of SA", "credential2": "e.g. 27 Years Experience",
  "credential3": "e.g. 500+ Matters Resolved", "credential4": "e.g. Admitted to Bar 1998",
  "about_philosophy": "one sentence — their professional philosophy",
  "owner_name": "inferred from business name",
  "owner_title": "e.g. Managing Attorney | Senior Partner",
  "team_member2_name": "plausible SA name", "team_member2_title": "e.g. Associate Attorney",
  "team_member3_name": "plausible SA name", "team_member3_title": "e.g. Conveyancing Specialist",
  "address_line1": "${area}, South Africa",
  "address_line2": "",
  "trust_point1": "e.g. HPCSA Registered", "trust_point2": "e.g. 27 Years Experience",
  "trust_point3": "e.g. Free Consultation", "trust_point4": "e.g. Confidential",
  "services_section_tag": "e.g. Our Practice Areas",
  "services_h2": "e.g. How We Can Help",
  "services": [
    {"icon": "emoji", "name": "practice area", "desc": "one sentence", "outcome": "client outcome e.g. Resolved efficiently and confidentially"},
    {"icon": "emoji", "name": "practice area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "practice area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "practice area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "practice area", "desc": "one sentence", "outcome": "client outcome"},
    {"icon": "emoji", "name": "practice area", "desc": "one sentence", "outcome": "client outcome"}
  ],
  "process_step1_title": "e.g. Initial Consultation", "process_step1_desc": "one sentence",
  "process_step2_title": "e.g. We Review Your Matter", "process_step2_desc": "one sentence",
  "process_step3_title": "e.g. We Act on Your Behalf", "process_step3_desc": "one sentence",
  "about_section_tag": "e.g. Our Firm",
  "about_headline": "specific e.g. Protecting ${area} Families Since YEAR",
  "about_pull_quote": "one memorable line about their approach",
  "about_p1": "paragraph — the firm's founding story",
  "about_p2": "paragraph — their approach and values",
  "about_p3": "paragraph — why clients choose them",
  "testimonials": [
    {"name": "Initial only e.g. T.M.", "quote": "authentic-sounding SA testimonial", "matter": "e.g. Family Law"},
    {"name": "Initial only", "quote": "authentic SA testimonial", "matter": "e.g. Property Transfer"},
    {"name": "Initial only", "quote": "authentic SA testimonial", "matter": "e.g. Commercial Contract"}
  ],
  "faq_intro": "one sentence introducing the FAQ",
  "faqs": [
    {"q": "relevant question", "a": "clear, reassuring answer"},
    {"q": "relevant question", "a": "clear answer"},
    {"q": "relevant question", "a": "clear answer"},
    {"q": "relevant question", "a": "clear answer"},
    {"q": "relevant question", "a": "clear answer"},
    {"q": "relevant question", "a": "clear answer"}
  ],
  "contact_section_tag": "e.g. Book a Consultation",
  "contact_h2_line1": "e.g. Let\'s Discuss",
  "contact_h2_line2": "e.g. Your Matter",
  "contact_copy": "one line — reassuring and professional"
}`,

    experience: `{
  "page_title": "${bizName} | ${industry} | ${area}",
  "og_title": "${bizName} — ${industry} in ${area}",
  "og_description": "One sentence — sensory, aspirational, specific",
  "tagline": "short brand tagline e.g. Where Every Cut Tells a Story",
  "business_type": "e.g. hair salon | restaurant | spa",
  "hero_h1_line1": "experiential first line",
  "hero_h1_line2": "sensory or mood line",
  "hero_h1_line3": "invitation or promise",
  "hero_copy": "2 sentences — make them imagine being there",
  "hero_mood_line": "atmospheric one-liner e.g. From the moment you walk in, the world outside disappears.",
  "cta_primary": "e.g. Book Your Appointment",
  "cta_secondary": "e.g. See Our Work",
  "vibes": ["e.g. Relaxing", "e.g. Luxurious", "e.g. Personal", "e.g. Transformative"],
  "years_open": "e.g. 8",
  "team_size": "e.g. 6",
  "parking_note": "e.g. Free parking available on site",
  "owner_name": "inferred from business name",
  "owner_title": "e.g. Head Stylist & Owner | Head Chef & Owner",
  "offerings_section_tag": "e.g. Our Menu | What We Offer",
  "offerings_h2": "e.g. Designed for You",
  "offerings": [
    {"name": "offering name", "desc": "one sentence", "price": "e.g. From R350", "duration": "e.g. 45 min"},
    {"name": "offering name", "desc": "one sentence", "price": "e.g. From R550", "duration": "e.g. 90 min"},
    {"name": "offering name", "desc": "one sentence", "price": "e.g. From R280", "duration": "e.g. 30 min"},
    {"name": "offering name", "desc": "one sentence", "price": "e.g. From R450", "duration": "e.g. 60 min"},
    {"name": "offering name", "desc": "one sentence", "price": "e.g. From R650", "duration": "e.g. 2 hrs"},
    {"name": "offering name", "desc": "one sentence", "price": "e.g. From R180", "duration": "e.g. 20 min"}
  ],
  "gallery_section_tag": "e.g. Our Work",
  "gallery_h2": "e.g. See What We Do",
  "gallery_intro": "one sentence inviting them to browse",
  "about_section_tag": "e.g. Our Story",
  "about_headline": "warm, personal headline",
  "about_pull_quote": "one memorable line",
  "about_p1": "paragraph — the origin story",
  "about_p2": "paragraph — the experience and atmosphere",
  "contact_section_tag": "e.g. Reserve Your Spot",
  "contact_h2_line1": "e.g. Ready to Book?",
  "contact_h2_line2": "e.g. We\'d Love to See You",
  "contact_copy": "one line — warm, inviting",
  "address_line1": "${area}, South Africa",
  "address_line2": ""
}`,

    local: `{
  "page_title": "${bizName} | ${industry} | ${area}",
  "og_title": "${bizName} — Your Local ${industry} in ${area}",
  "og_description": "One sentence — community, local, trusted",
  "hero_badge": "e.g. ${area}\'s Favourite ${industry} Since 2005",
  "hero_h1_line1": "community-focused first line",
  "hero_h1_line2": "personal connection line",
  "hero_h1_line3": "local pride line",
  "hero_accent_word": "one word to highlight",
  "hero_copy": "2 sentences — neighbourhood feel, personal",
  "cta_primary": "e.g. WhatsApp Us",
  "cta_secondary": "e.g. Find Us",
  "since_year": "e.g. 2005",
  "trade": "e.g. pharmacy | hardware store | butcher",
  "about_tagline": "short tagline e.g. Part of ${area} since 2005",
  "badges": ["e.g. Family-Owned", "e.g. Since 2005", "e.g. Community First", "e.g. Local Delivery"],
  "delivery_note": "e.g. Local delivery available — WhatsApp to arrange",
  "owner_name": "inferred from business name",
  "owner_title": "e.g. Owner & Founder",
  "staff_member2_name": "plausible SA name", "staff_member2_role": "e.g. Store Manager",
  "staff_member3_name": "plausible SA name", "staff_member3_role": "e.g. Senior Staff Member",
  "address_line1": "${area}, South Africa",
  "address_line2": "",
  "services_section_tag": "e.g. What We Stock | What We Offer",
  "services_h2": "e.g. Everything You Need",
  "services": [
    {"icon": "emoji", "name": "category/product", "desc": "one sentence", "note": "e.g. Wide range in stock"},
    {"icon": "emoji", "name": "category/product", "desc": "one sentence", "note": "e.g. Freshly sourced daily"},
    {"icon": "emoji", "name": "category/product", "desc": "one sentence", "note": ""},
    {"icon": "emoji", "name": "category/product", "desc": "one sentence", "note": ""},
    {"icon": "emoji", "name": "category/product", "desc": "one sentence", "note": ""},
    {"icon": "emoji", "name": "category/product", "desc": "one sentence", "note": ""}
  ],
  "process_step1_title": "e.g. Walk In or WhatsApp", "process_step1_desc": "one sentence",
  "process_step2_title": "e.g. We Help You Find It", "process_step2_desc": "one sentence",
  "process_step3_title": "e.g. Take It Home", "process_step3_desc": "one sentence",
  "about_section_tag": "e.g. Part of the Community",
  "about_headline": "personal, local headline",
  "about_pull_quote": "one memorable community-focused line",
  "about_p1": "paragraph — the origin story and connection to ${area}",
  "about_p2": "paragraph — what makes them the go-to local option",
  "about_p3": "paragraph — community involvement",
  "testimonials": [
    {"name": "SA first name e.g. Thabo", "quote": "warm, local testimonial", "context": "e.g. Sandton resident"},
    {"name": "SA first name", "quote": "warm testimonial", "context": "e.g. Regular customer"},
    {"name": "SA first name", "quote": "warm testimonial", "context": "e.g. Local business owner"}
  ],
  "community_points": ["e.g. Supporting local schools", "e.g. Sponsoring the street fair", "e.g. Employing locally", "e.g. Stocking SA-made products"],
  "community_cta": "e.g. Come see us — we\'re part of ${area} too",
  "gallery_captions": ["e.g. Our store", "e.g. Fresh stock daily", "e.g. Our team", "e.g. Community event", "e.g. Behind the counter", "e.g. In the neighbourhood"],
  "gallery_intro": "one sentence about what the photos show",
  "contact_section_tag": "e.g. Come Say Hello",
  "contact_h2_line1": "e.g. We\'re Right Here",
  "contact_h2_line2": "e.g. In ${area}",
  "contact_copy": "one line — warm and welcoming"
}`,

    results: `{
  "page_title": "${bizName} | ${industry} | ${area}",
  "og_title": "${bizName} — ${industry} Results in ${area}",
  "og_description": "One sentence — transformation, results, proof",
  "hero_badge": "e.g. ${area}\'s Most-Trusted ${industry}",
  "hero_h1_line1": "transformation-focused first line",
  "hero_h1_line2": "the proof or outcome line",
  "hero_h1_line3": "the invitation line",
  "hero_copy": "2 sentences — outcome-focused, specific to ${area}",
  "hero_result_stat": "e.g. 500+",
  "hero_result_label": "e.g. Projects Completed",
  "cta_primary": "e.g. Get a Free Quote",
  "cta_secondary": "e.g. See Our Work",
  "service_category": "e.g. panel beating | landscaping | personal training",
  "clients_served": "e.g. 500+",
  "years_active": "e.g. 12",
  "response_commitment": "e.g. Free quote within 24 hours",
  "availability_note": "e.g. Currently accepting new clients",
  "proof_stat1_num": "e.g. 500+", "proof_stat1_lbl": "e.g. Projects Completed",
  "proof_stat2_num": "e.g. 12", "proof_stat2_lbl": "e.g. Years Experience",
  "proof_stat3_num": "e.g. 98%", "proof_stat3_lbl": "e.g. Client Satisfaction",
  "proof_stat4_num": "e.g. R0", "proof_stat4_lbl": "e.g. Callout Fee",
  "owner_name": "inferred from business name",
  "owner_title": "e.g. Master Technician & Owner",
  "owner_credential1": "e.g. 12 Years in the Industry",
  "owner_credential2": "e.g. MIWA Certified",
  "owner_credential3": "e.g. Manufacturer Approved",
  "team_member2_name": "plausible SA name", "team_member2_title": "e.g. Senior Technician",
  "team_member3_name": "plausible SA name", "team_member3_title": "e.g. Workshop Supervisor",
  "address_line1": "${area}, South Africa",
  "address_line2": "",
  "services_section_tag": "e.g. What We Do",
  "services_h2": "e.g. Our Services",
  "services": [
    {"icon": "emoji", "name": "service name", "desc": "one sentence", "result": "e.g. Factory finish, guaranteed"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence", "result": "client outcome"},
    {"icon": "emoji", "name": "service name", "desc": "one sentence", "result": "client outcome"}
  ],
  "process_step1_title": "e.g. Free Assessment", "process_step1_desc": "one sentence",
  "process_step2_title": "e.g. We Get to Work", "process_step2_desc": "one sentence",
  "process_step3_title": "e.g. Results Guaranteed", "process_step3_desc": "one sentence",
  "about_section_tag": "e.g. The Work Speaks",
  "about_headline": "results-focused headline",
  "about_pull_quote": "one memorable line about quality or results",
  "about_p1": "paragraph — the origin and expertise",
  "about_p2": "paragraph — the process and standards",
  "about_p3": "paragraph — why they\'re trusted in ${area}",
  "about_proof_statement": "bold proof statement e.g. 500+ projects. Zero comebacks.",
  "testimonials": [
    {"name": "SA name", "quote": "results-focused testimonial", "result": "e.g. Car back in 3 days, perfect finish"},
    {"name": "SA name", "quote": "results-focused testimonial", "result": "client result"},
    {"name": "SA name", "quote": "results-focused testimonial", "result": "client result"}
  ],
  "case_studies": [
    {"client": "e.g. Family in ${area}", "challenge": "the problem", "solution": "what was done", "timeframe": "e.g. 5 days", "results": ["result 1", "result 2", "result 3"]},
    {"client": "e.g. Local business", "challenge": "the problem", "solution": "what was done", "timeframe": "e.g. 3 days", "results": ["result 1", "result 2", "result 3"]},
    {"client": "e.g. Resident in ${area}", "challenge": "the problem", "solution": "what was done", "timeframe": "e.g. 2 weeks", "results": ["result 1", "result 2", "result 3"]}
  ],
  "client_names": ["e.g. Toyota", "e.g. Private Client", "e.g. Local Business", "e.g. Fleet Client", "e.g. Insurance Referral"],
  "contact_section_tag": "e.g. Get a Free Quote",
  "contact_h2_line1": "e.g. Ready to See Results?",
  "contact_h2_line2": "e.g. Let\'s Talk",
  "contact_copy": "one line — confident and action-oriented"
}`,

  };

  const schema = schemas[archetype] || schemas.emergency;

  return `Generate website content for this South African business. Return ONLY this JSON — no other text.

BUSINESS BRIEF:
Name: ${bizName}
Industry: ${industry}
About: ${about}
Services: ${services}
Area: ${area}
Voice/Vibe: ${vibe || 'Professional, warm, South African'}

Return this exact JSON structure for the "${archetype}" archetype:
${schema}`;
}

// ============================================================
// QA CHECKS — expanded per battle plan §4
// Counts CSS class usage, verifies hero background-image inline style,
// verifies WH_CSS_INJECT was replaced, verifies business name in <title>,
// verifies the WhatsApp wa.me link matches the record's number.
// ============================================================

function runQAChecks(html, f, pageName = 'index', contentJson = null) {
  const failures = [];

  // ── Universal checks ────────────────────────────────────────
  if (!html.includes('<!DOCTYPE'))                                         failures.push('Missing DOCTYPE');
  if (!html.includes('viewport'))                                          failures.push('Missing viewport');
  if (!html.includes('<nav') && !html.includes('class="nav"'))             failures.push('Missing nav');
  if (!html.includes('wa.me') && !html.toLowerCase().includes('whatsapp')) failures.push('Missing WhatsApp link');
  if (html.includes('Lorem ipsum'))                                        failures.push('Lorem ipsum detected');

  // CSS injection placeholder MUST have been replaced before QA runs
  if (html.includes('<!--WH_CSS_INJECT-->')) {
    failures.push('WH_CSS_INJECT placeholder not replaced — CSS injection failed');
  }

  // Unclosed <style> swallows the entire body — every <style> must close
  const styleOpens  = (html.match(/<style\b/gi)  || []).length;
  const styleCloses = (html.match(/<\/style>/gi) || []).length;
  if (styleOpens !== styleCloses) {
    failures.push(`Unclosed <style> tag (${styleOpens} open, ${styleCloses} close) — body will not render`);
  }

  const scriptOpens  = (html.match(/<script\b/gi)  || []).length;
  const scriptCloses = (html.match(/<\/script>/gi) || []).length;
  if (scriptOpens !== scriptCloses) {
    failures.push(`Unclosed <script> tag (${scriptOpens} open, ${scriptCloses} close)`);
  }

  const bizName = f['Business Name'] || '';
  const bizFirst = bizName.split(' ')[0];
  if (bizFirst && !html.toLowerCase().includes(bizFirst.toLowerCase())) {
    failures.push('Business name missing from page body');
  }

  // Business name MUST appear in <title>
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!titleMatch) {
    failures.push('Missing <title> tag');
  } else if (bizFirst && !titleMatch[1].toLowerCase().includes(bizFirst.toLowerCase())) {
    failures.push('Business name missing from <title>');
  }

  // WhatsApp number in wa.me link MUST match the record
  const recordPhone = normaliseSaPhone(f['WhatsApp']);
  if (recordPhone) {
    const waLinks = html.match(/wa\.me\/(\+?\d+)/gi) || [];
    if (waLinks.length === 0) {
      failures.push('No wa.me links found');
    } else {
      const numbers = waLinks.map(l => l.replace(/wa\.me\/\+?/i, '').replace(/\D/g, ''));
      const matches = numbers.some(n => n === recordPhone);
      if (!matches) failures.push(`wa.me link does not match record phone (${recordPhone})`);
    }
  }

  // ── Page-specific checks ────────────────────────────────────
  if (pageName === 'index') {
    if (!html.includes('id="home"') && !html.includes("id='home'"))
      failures.push('Home: missing hero id="home"');
    if (!(html.includes('stats') || html.includes('stat-')))
      failures.push('Home: missing stats strip');

    // Hero must have background-image inline style
    const heroMatch = html.match(/<section[^>]+id="home"[^>]*>/i);
    if (heroMatch && !/background-image\s*:/i.test(heroMatch[0])) {
      failures.push('Home: hero <section id="home"> missing inline background-image style');
    }
  }

  if (pageName === 'services' || (pageName === 'index' && packageKey(f['Package']) === 'express')) {
    const expectedCount = Array.isArray(contentJson?.services) ? contentJson.services.length : 5;
    const cards = (html.match(/class="[^"]*\bcard\b[^"]*"/g) || []).length;
    if (cards < Math.min(3, expectedCount)) {
      failures.push(`Services: only ${cards} .card element(s) — expected at least ${expectedCount}`);
    }
  }

  if (pageName === 'about') {
    if (!html.toLowerCase().includes('about') && !html.toLowerCase().includes('story'))
      failures.push('About: missing about/story content');
    // Should use .grid-2 for image/text split
    if (!html.includes('grid-2')) failures.push('About: missing .grid-2 layout');
  }

  if (pageName === 'contact') {
    if (!html.includes('<form'))  failures.push('Contact: missing form');
    if (!html.includes('wa.me')) failures.push('Contact: missing WhatsApp link');
  }

  if (pageName === 'gallery') {
    if (!html.includes('gallery-grid'))   failures.push('Gallery: missing gallery-grid container');
    if (!html.includes('gallery-assets')) failures.push('Gallery: missing dynamic gallery fetch script');
  }

  return { passed: failures.length === 0, failures };
}

// ============================================================
// WATERMARK + FOOTER CREDIT
// ============================================================

function addWatermark(html, f, domain, airtableId, env) {
  const bizName = (f && f['Business Name']) || 'your business';
  const pkg     = (f && f['Package']) || 'Standard';
  const tier    = getPricingTier(pkg);
  const slug    = (f && f['Slug']) || slugify(bizName);
  const intl    = normaliseSaPhone(f && f['WhatsApp']);

  // Always show monthly retainer — build fee is R0 across all tiers
  const priceLabel = `R${tier.retainer}/mo`;

  // PayFast link routed through launch-worker's webhook for ITN handling
  const launchUrl = env.WORKER_URL_LAUNCH || '';
  const payLink   = buildPayFastLink(tier.retainer, 'Website Hub Monthly Subscription', airtableId, env, {
    itemDesc:  `${bizName} — first month`,
    returnUrl: `https://${PREVIEW_DOMAIN}/${slug}`,
    cancelUrl: `https://${PREVIEW_DOMAIN}/${slug}`,
    notifyUrl: launchUrl ? `${launchUrl}/payfast-webhook` : undefined,
  });

  // "Not interested" routed to reactivate-worker
  const reactUrl         = env.WORKER_URL_REACTIVATE || '';
  const notInterestedUrl = `${reactUrl}/not-interested?phone=${intl}&slug=${slug}`;

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
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview Expired</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:440px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6}a{color:#1a1a2e;font-weight:600}</style></head><body><div class="box"><div style="font-size:48px;margin-bottom:16px">⏱️</div><h1>This preview has expired</h1><p>This site preview is no longer available. If you'd like a website for your business, visit <a href="https://websitehub.co.za">websitehub.co.za</a> — we'll have something ready for you in 10 minutes.</p></div></body></html>`;
}

function landingPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website Hub Preview Portal</title></head><body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5"><div style="text-align:center"><h1 style="color:#1a1a2e">Website Hub</h1><p style="color:#666;margin-top:8px">Client preview portal</p></div></body></html>`;
}

function galleryUpgradePromptPage(slug, env) {
  // Gallery is Premium-only. Show appropriate upgrade copy + PayFast link.
  // We don't know the current tier here (slug-only context), so default to
  // "Standard → Premium" delta = R500. Most non-Premium clients are Standard.
  const upgradeAmount = PRICING.upgrade.standardToPremium;
  const upgradeLink   = buildPayFastLink(
    upgradeAmount,
    'Website Hub Upgrade to Premium',
    slug, // not an airtableId — launch-worker handles slug-based lookup
    env,
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

async function safeInflate(data) {
  try {
    const ds     = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  } catch { return null; }
}

// removeWatermark and addFooterCredit are mirrored in launch-worker (cross-worker imports are not possible)
export { removeWatermark, addFooterCredit };
