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
const PASS_1_MAX_TOKENS = 3500; // Pass 1 Skeleton — content strategy JSON
const PASS_2_MAX_TOKENS = 4500; // Pass 2 Organs — copy and messaging
const PASS_3_MAX_TOKENS = 5500; // Pass 3 Muscle — CSS design system (non-negotiable floor)
const PASS_4_DEFAULT_TOKENS = 6000; // Pass 4 Skin — HTML per page
const PASS_5_DEFAULT_TOKENS = 3000; // Pass 5 Soul — personality and polish

// ────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const hostname = url.hostname;

    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    // Site serving (hostname-based)
    if (hostname === PREVIEW_DOMAIN) return servePreview(url, env);
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

        await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env).catch(() => {});
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

  // Serve the SPA for app entry points
  if (!rawPath || segment === 'verify' || segment === 'manage' || segment === 'build') {
    const appHtml = await env.SITES.get('app:preview-manage');
    if (appHtml) return htmlResponse(appHtml, 200);
    return htmlResponse(landingPage(), 200);
  }

  const slug    = segment;
  const subPath = rawPath.split('/').slice(1).join('/');
  const pageName = VALID_PAGES.includes(subPath) ? subPath : 'index';

  // Preview expiry — archive to portfolio_candidate and serve expired page
  const expiry = await env.SITES.get(`preview_expiry:${slug}`);
  if (expiry && new Date(expiry) < new Date()) {
    await env.SITES.put(`portfolio_candidate:${slug}`, expiry);
    await env.SITES.delete(`preview:${slug}`);
    return htmlResponse(expiredPreviewPage(slug), 410);
  }

  // Try per-page key first, fall back to legacy single-page key for index
  let html = await env.SITES.get(`preview:${slug}:${pageName}`);
  if (!html && pageName === 'index') html = await env.SITES.get(`preview:${slug}`);

  // Gallery for non-Premium clients — serve upgrade prompt
  if (!html && pageName === 'gallery') {
    return htmlResponse(galleryUpgradePromptPage(slug, env), 200);
  }
  if (!html) return htmlResponse(notFoundPage(slug), 404);

  // Visitor count — daily granular key under monthly prefix
  recordVisit(slug, pageName, env);

  return htmlResponse(html, 200);
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
  const allowedStatuses = ['Deposit Paid', 'QA', 'Live']; // Live = patch-worker asset rebuild
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
const DOMAIN_PROXY_SECRET = 'wh-proxy-d8f3a1b9c2e4f7d6a5b8c3e1f9d2a4b7';

async function callDomainProxy(action, sld, tld = 'co.za', extra = {}, env) {
  try {
    const res = await fetch(DOMAIN_PROXY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': DOMAIN_PROXY_SECRET },
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
// Pass 4: Skin    — full HTML per page (sequential)
// Pass 5: Soul    — personality polish (sequential)
// ============================================================

async function triggerBuildInternal(airtableId, paymentId, env, preloadedFields, isOutbound = false) {
  const record = preloadedFields
    ? { fields: preloadedFields }
    : await getAirtableRecord(airtableId, env);
  const f = record.fields || record;

  const slug       = slugify(f['Business Name']);
  const domain     = f['Domain'] || `${slug}.co.za`;
  const mailtoLink = `mailto:updates@websitehub.co.za?subject=wh-${slug}&body=Hi%20Website%20Hub%2C%20please%20find%20my%20photos%20attached.`;
  const pkg        = packageKey(f['Package']);
  const caps       = getPackageCaps(pkg);

  await updateAirtableRecord(airtableId, {
    'Slug':        slug,
    'Mailto Link': mailtoLink,
    'Status':      'Building',
    'Domain':      domain,
  }, env);

  // Industry matrix lookup — feeds creative brief into Pass 1
  const industryBrief = getIndustryBrief(f['Industry'] || f['Business Name'] || '');

  // Unsplash photos — use industry brief search term for better results
  let unsplashPhotos = [];
  try { unsplashPhotos = await fetchUnsplashPhotos(f, env, industryBrief.heroImage); }
  catch (e) { console.warn('Unsplash fetch failed (non-fatal):', e); }

  // R2 client photos — read from gallery/ prefix (consistent with patch-worker
  // upload path and /gallery-assets listing endpoint)
  let r2PhotoUrls = [];
  try {
    if (env.ASSETS) {
      const r2List = await env.ASSETS.list({ prefix: `${slug}/gallery/` });
      if (r2List.objects && r2List.objects.length > 0) {
        r2PhotoUrls = r2List.objects.map(obj =>
          `https://assets.websitehub.co.za/${obj.key}`
        );
      }
    }
  } catch (e) { console.warn('R2 photo fetch failed (non-fatal):', e); }

  // Build photo context — prefer client photos, fallback to Unsplash
  const photoContext = r2PhotoUrls.length > 0
    ? `\n\nCLIENT PHOTOS (use these first — real photos from the business):\n` +
      r2PhotoUrls.map((url, i) => `photo_${i+1}: ${url}`).join('\n') + '\n'
    : unsplashPhotos.length > 0
      ? `\n\nPHOTOS (use these direct URLs in <img> tags — never base64):\n` +
        unsplashPhotos.map(p => `${p.slot}: ${p.url}\nCredit: ${p.credit} on Unsplash`).join('\n') +
        `\n\nInclude small "Photos: Unsplash" credit in footer.\n`
      : '';

  const unsplashContext = photoContext; // legacy alias

  // ── PASS 1 — Skeleton: Content Strategy + Industry Matrix ───
  let contentJson;
  try {
    const p1Raw = await callClaudeInternal(
      buildPass1SystemPrompt(industryBrief),
      [{ role: 'user', content: buildPass1UserPrompt(f, industryBrief) }],
      env,
      { maxTokens: PASS_1_MAX_TOKENS },
    );
    const cleaned = p1Raw.replace(/```json|```/g, '').trim();
    contentJson = JSON.parse(cleaned);
    await env.SITES.put(`content:${slug}`, JSON.stringify(contentJson), { expirationTtl: 60 * 60 * 24 * 35 });
  } catch (e) {
    throw new Error(`Pass 1 failed: ${e.message}`);
  }

  // ── PASS 2 — CSS Design System ──────────────────────────────
  // PASS_2_MAX_TOKENS = 5000 — must not be reduced. Truncated </style>
  // swallows the entire body in HTML5 rawtext mode → blank page.
  let cssBlock;
  try {
    const p2Raw = await callClaudeInternal(
      buildPass2SystemPrompt(),
      [{ role: 'user', content: buildPass2UserPrompt(contentJson, f, industryBrief) }],
      env,
      { maxTokens: PASS_3_MAX_TOKENS }, // Pass 3 Muscle = CSS, must not be truncated
    );
    cssBlock = p2Raw.trim();

    if (!cssBlock.includes('<style>')) throw new Error('No <style> block in Pass 2 output');

    // Defence in depth: auto-close </style> if truncated mid-stream.
    if (!cssBlock.includes('</style>')) {
      console.warn(`Pass 2 output for "${slug}" missing </style> — auto-closing.`);
      await sendWhatsApp(env.WH_PHONE,
        `⚠️ Pass 2 truncated for ${f['Business Name']} (slug: ${slug}) — </style> auto-closed. Check site for missing styles.`,
        env, { skipTestRedirect: true },
      ).catch(() => {});

      const lastOpenBrace  = cssBlock.lastIndexOf('{');
      const lastCloseBrace = cssBlock.lastIndexOf('}');
      if (lastOpenBrace > lastCloseBrace) cssBlock = cssBlock.slice(0, lastOpenBrace).trimEnd();
      cssBlock += '\n</style>';
    }

    await env.SITES.put(`css:${slug}`, cssBlock, { expirationTtl: 60 * 60 * 24 * 35 });
  } catch (e) {
    throw new Error(`Pass 2 failed: ${e.message}`);
  }

  // ── PASSES 4 & 5 — Skin + Soul (sequential per page) ────────
  // Pass 4 (Skin): Full HTML per page — sequential to avoid CPU timeout
  // Pass 5 (Soul): Personality polish — surgical micro-copy layer
  // Express: 1 page. Standard: 4 pages. Premium: 5 pages.
  const pages            = caps.pages;
  const pass4Budgets     = caps.pass4TokenBudget || caps.pageTokenBudget;
  const pass5Budgets     = caps.pass5TokenBudget;

  const builtPages = {};

  for (const pageName of pages) {
    // ── Pass 4: Skin — Full HTML render ───────────────────────
    let html = null;
    try {
      html = await callClaudeInternal(
        buildPass4SystemPrompt(pageName, pkg),
        [{ role: 'user', content: buildPass4UserPrompt(pageName, contentJson, cssBlock, f, unsplashContext, slug, pkg, env) }],
        env,
        { maxTokens: pass4Budgets[pageName] || PASS_4_DEFAULT_TOKENS },
      );
    } catch (err) {
      console.warn(`Pass 4 failed for "${pageName}":`, err.message);
    }

    // Pass 4 validation + retry
    if (!html || !html.includes('<!DOCTYPE')) {
      console.warn(`Pass 4 invalid output for "${pageName}" — retrying`);
      try {
        html = await callClaudeInternal(
          buildPass4SystemPrompt(pageName, pkg),
          [{ role: 'user', content: buildPass4UserPrompt(pageName, contentJson, cssBlock, f, unsplashContext, slug, pkg, env) }],
          env,
          { maxTokens: pass4Budgets[pageName] || PASS_4_DEFAULT_TOKENS },
        );
      } catch (e) { console.error(`Pass 4 retry failed for "${pageName}":`, e.message); continue; }
    }

    // Inject CSS
    html = injectCss(html, cssBlock, pageName);

    // Guarantee hero background image is set regardless of Claude compliance
    if (pageName === 'index') html = injectHeroImage(html, unsplashContext);

    // QA check
    const qaResult = runQAChecks(html, f, pageName, contentJson);
    if (!qaResult.passed) {
      console.warn(`QA failed "${pageName}":`, qaResult.failures.join(', '));
      try {
        const qaRetry = await callClaudeInternal(
          buildPass4SystemPrompt(pageName, pkg),
          [
            { role: 'user',      content: buildPass4UserPrompt(pageName, contentJson, cssBlock, f, unsplashContext, slug, pkg, env) },
            { role: 'assistant', content: html },
            { role: 'user',      content: `QA failed: ${qaResult.failures.join(', ')}. Fix and return complete corrected HTML.` },
          ],
          env,
          { maxTokens: pass4Budgets[pageName] || PASS_4_DEFAULT_TOKENS },
        );
        const retryHtml = injectCss(qaRetry, cssBlock, pageName);
        const retryQA   = runQAChecks(retryHtml, f, pageName, contentJson);
        if (retryQA.passed) {
          html = retryHtml;
          await updateAirtableRecord(airtableId, { 'QA Status': 'Passed' }, env);
        } else {
          await sendWhatsApp(env.WH_PHONE,
            `⚠️ QA FAILED x2 — page "${pageName}": ${f['Business Name']}\nFailed: ${retryQA.failures.join(', ')}`,
            env, { skipTestRedirect: true },
          ).catch(() => {});
          await updateAirtableRecord(airtableId, { 'QA Status': 'Failed' }, env);
        }
      } catch(e) { console.warn(`QA retry error "${pageName}":`, e.message); }
    } else {
      await updateAirtableRecord(airtableId, { 'QA Status': 'Passed' }, env);
    }

    // ── Pass 5: Soul — Personality & Polish ───────────────────
    // Surgical micro-copy layer. Reads rendered HTML, patches specific elements.
    // Skipped if Pass 4 failed.
    if (html && pass5Budgets) {
      try {
        const soulResult = await callClaudeInternal(
          buildPass5SystemPrompt(pageName, industryBrief),
          [{
            role: 'user',
            content: buildPass5UserPrompt(pageName, html, contentJson, f, industryBrief),
          }],
          env,
          { maxTokens: pass5Budgets[pageName] || PASS_5_DEFAULT_TOKENS },
        );
        // Pass 5 returns the patched HTML — validate before accepting
        if (soulResult && soulResult.includes('<!DOCTYPE')) {
          html = soulResult;
        } else {
          console.warn(`Pass 5 Soul returned non-HTML for "${pageName}" — keeping Pass 4 output`);
        }
      } catch (e) {
        // Pass 5 is non-critical — if it fails, keep Pass 4 output
        console.warn(`Pass 5 Soul failed for "${pageName}" (non-fatal):`, e.message);
      }
    }

    builtPages[pageName] = html;
  }

  if (!builtPages['index']) throw new Error('Home page (index) failed to build — aborting');

  // ── Store all pages in KV ───────────────────────────────────
  const previewUrl = `https://${PREVIEW_DOMAIN}/${slug}`;

  for (const [pageName, html] of Object.entries(builtPages)) {
    const withWatermark = isOutbound ? addWatermark(html, f, domain, airtableId, env) : html;
    await env.SITES.put(`preview:${slug}:${pageName}`, withWatermark, { expirationTtl: 60 * 60 * 24 * 35 });
    await env.SITES.put(`draft:${slug}:${pageName}`,   html,          { expirationTtl: 60 * 60 * 24 * 35 });
  }

  // Backward-compat legacy single-key entries point to home page
  const homeWithWatermark = isOutbound
    ? addWatermark(builtPages['index'], f, domain, airtableId, env)
    : builtPages['index'];

  await env.SITES.put(`preview:${slug}`,          homeWithWatermark,   { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`preview-original:${slug}`, homeWithWatermark,   { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`draft:${slug}`,            builtPages['index'], { expirationTtl: 60 * 60 * 24 * 35 });

  const expiryDate = new Date(Date.now() + PREVIEW_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.SITES.put(`preview_expiry:${slug}`, expiryDate);

  const tokens = Math.round(Object.values(builtPages).join('').length / 4);
  await logBuild(airtableId, 'Success', null, env, tokens);
  await logHealth(env, 'build', 'success');

  await updateAirtableRecord(airtableId, {
    'Status':     'QA',
    'PreviewURL': previewUrl,
    ...(paymentId ? { 'PayFast Payment ID': paymentId } : {}),
  }, env);

  // ── Send preview messages ───────────────────────────────────
  if (isOutbound) {
    await sendOutboundPreviewMessage(f, previewUrl, domain, airtableId, env);
  } else {
    await sendInboundPreviewMessage(f, previewUrl, domain, airtableId, env);
  }

  await sendWhatsApp(env.WH_PHONE,
    `✅ BUILD COMPLETE: ${f['Business Name']}\nPreview: ${previewUrl}\nPackage: ${pkg}\nPages: ${pages.length}\nOutbound: ${isOutbound ? 'Yes' : 'No'}\nTokens: ~${tokens}`,
    env, { skipTestRedirect: true },
  );

  // Return slug so queue consumer can write correct build_status (Fix D)
  return slug;
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
// HERO IMAGE INJECTION
// Guarantees the hero background-image is set regardless of whether
// Claude replaced the UNSPLASH_URL placeholder or omitted it entirely.
// Extracts the first Unsplash URL from the unsplashContext string and
// writes it into the hero section style attribute.
// ============================================================

function injectHeroImage(html, unsplashContext) {
  if (!unsplashContext) return html;

  // Extract first Unsplash URL from the photo context block
  const match = unsplashContext.match(/https:\/\/images\.unsplash\.com\/[^\s\n"')]+/);
  if (!match) return html;
  const heroUrl = match[0];

  // Case 1: Claude left the UNSPLASH_URL placeholder — replace it
  if (html.includes('UNSPLASH_URL')) {
    return html.replace(/UNSPLASH_URL/g, heroUrl);
  }

  // Case 2: Hero section exists but has no background-image — inject it
  if (html.includes('class="hero"') && !html.includes('background-image')) {
    return html.replace(
      /class="hero"/,
      `class="hero" style="background-image:url('${heroUrl}')"`
    );
  }

  // Case 3: Hero has a background-image style but it's empty or malformed
  if (html.includes('class="hero"')) {
    return html.replace(
      /class="hero"\s+style="background-image:url\([^)]*\)"/,
      `class="hero" style="background-image:url('${heroUrl}')"`
    );
  }

  return html;
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
  const tier    = getPricingTier(f['Package'] || 'Standard');
  const payLink = buildPayFastLink(tier.retainer, 'Website Hub Monthly Subscription', airtableId, env, {
    itemDesc:  `${f['Business Name']} — first month`,
    returnUrl: `https://${PREVIEW_DOMAIN}/${slugify(f['Business Name'])}`,
    cancelUrl: previewUrl,
    notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
  });

  try {
    const prompt = `Write a WhatsApp message to a South African small business owner. Maximum 4 lines. Warm and direct — SA tone.

Business name: ${f['Business Name']}
Town/Area: ${f['Area'] || 'South Africa'}
Industry: ${f['Industry'] || 'small business'}

Line 1: Start with their business name and town — something specific and personal.
Line 2: Say our team built them a free website — no obligation, no catch.
Line 3: Preview link only: ${previewUrl}
Line 4: Single action — go live for R${tier.retainer}/month. Payment link: ${payLink}
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
      `Hi *${f['Business Name']}* in ${f['Area'] || 'South Africa'} 👋\n\nOur team built your business a free website — no strings attached.\n\n👀 ${previewUrl}\n\n🚀 Go live for R${tier.retainer}/mo: ${payLink}\n\n_Reply STOP to opt out._`,
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
// VISION SYSTEM — Claude Vision brand-signal extraction
// Called by patch-worker's photo-upload handler via BUILD_QUEUE.
// Moved here from enrichment worker; no more cross-worker HTTP.
// ============================================================

/**
 * Runs Claude Vision over uploaded images, extracts a brand brief, and queues
 * a rebuild via BUILD_QUEUE. Idempotent — calling twice just queues twice;
 * the second build supersedes the first.
 *
 * @param {string} airtableId
 * @param {string} slug
 * @param {Array<{key:string}>} r2Paths      R2 keys returned by patch-worker upload
 * @param {Array<{arrayBuffer:Function,type:string,name:string}>} files
 * @param {object} env
 */
export async function runVisionAndRebuild(airtableId, slug, r2Paths, files, env) {
  let brandBrief = '';

  if (await getFlag(env, 'VISION_VALIDATION_ENABLED')) {
    const visionImages = [];
    for (let i = 0; i < Math.min(files.length, 3); i++) {
      try {
        const bytes = await files[i].arrayBuffer();
        const b64   = uint8ArrayToBase64(new Uint8Array(bytes));
        const mime  = files[i].type || 'image/jpeg';
        visionImages.push({ base64: b64, mediaType: mime, name: files[i].name });
      } catch (e) {
        console.warn(`Failed to read file for vision: ${files[i].name}`, e);
      }
    }

    if (visionImages.length > 0) {
      brandBrief = await extractBrandSignals(visionImages, slug, env);
      await logHealth(env, 'anthropic', 'success');
    }
  }

  const r2PathList    = r2Paths.map(p => p.key).join(', ');
  const existingFields = (await getAirtableRecord(airtableId, env)).fields;
  const existingPhotos = existingFields['Photos'] || '';
  const allPhotos      = [existingPhotos, r2PathList].filter(Boolean).join(', ');

  const updateFields = { 'Photos': allPhotos };
  if (brandBrief) {
    const existingNotes = existingFields['Extra Notes'] || '';
    updateFields['Extra Notes'] = `[BRAND ANALYSIS]\n${brandBrief}\n\n${existingNotes}`.slice(0, 5000);
  }

  await updateAirtableRecord(airtableId, updateFields, env);
  await logHealth(env, 'airtable', 'success');

  // Only reset status if NOT already Live
  if (existingFields['Status'] !== 'Live') {
    await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env);
  }

  // Queue rebuild directly — no HTTP hop, vision and build are in the same worker now
  await env.BUILD_QUEUE.send({
    airtableId,
    paymentId:  null,
    fields:     null, // triggerBuildInternal will refetch
    isOutbound: false,
  });

  await logActivity(env, 'assets_processed', {
    slug,
    fileCount:  r2Paths.length,
    visionUsed: !!brandBrief,
  });

  await sendWhatsApp(env.WH_PHONE,
    `📸 ASSETS PROCESSED: ${slug}\n${r2Paths.length} file${r2Paths.length !== 1 ? 's' : ''} stored\nRebuild queued`,
    env, { skipTestRedirect: true },
  );
}

async function extractBrandSignals(images, slug, env) {
  const content = [{
    type: 'text',
    text: `Analyse these brand assets (logo and photos) for a South African small business. Extract the following:

1. PRIMARY COLOUR — the most dominant brand colour (hex code)
2. SECONDARY COLOUR — supporting colour (hex code)
3. ACCENT COLOUR — highlight/pop colour (hex code)
4. TYPOGRAPHY FEEL — is the logo serif, sans-serif, script, geometric, bold/delicate?
5. BRAND PERSONALITY — 3 adjectives that describe the visual tone
6. DESIGN DIRECTION — one sentence: what design style should the website use to match this brand?
7. LOGO PRESENT — yes/no
8. PHOTO QUALITY — describe the photo quality and style if photos are present

Be specific and practical. A developer will use this to build a website.
Format your response as plain text with labels like "PRIMARY COLOUR: #hexcode".`,
  }];

  for (const img of images) {
    content.push({
      type:   'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      await resolveClaudeModel(env),
      max_tokens: 1000,
      messages:   [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brand analysis failed: ${res.status} — ${err}`);
  }

  const data      = await res.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  return textBlock?.text || '';
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
// BUILD PROMPTS — 3-pass pipeline
// Tightened per battle plan §4: must/do not language, exact CSS classes,
// exact card counts matching contentJson.services length.
// ============================================================

function buildPass1SystemPrompt(industryBrief) {
  return `You are a South African brand strategist and content director. You have 15 years building brands for SA small businesses across every industry and township.

CREATIVE BRIEF FOR THIS BUILD:
Mood: ${industryBrief.mood}
Copy Style: ${industryBrief.copyStyle}
Emotional Register: ${industryBrief.emotionalRegister}
Vibe Words to weave in: ${industryBrief.vibeWords.join(', ')}
Trust Signals to reference: ${industryBrief.trustSignals.join(', ')}
Suggested colour direction: bg ${industryBrief.palette.bg}, accent ${industryBrief.palette.accent}
Aesthetic: ${industryBrief.aesthetic}
Display Font suggestion: ${industryBrief.fonts.display}
Body Font suggestion: ${industryBrief.fonts.body}

OUTPUT RULES — non-negotiable:
→ Output ONLY valid JSON. Start with { and end with }. No preamble, no backticks.
→ Copy MUST be warm, confident, specifically South African — not corporate, not American.
→ Headlines MUST be short, punchy, memorable — built around the actual business story.
→ Colours MUST be influenced by the brief above unless the client specified something different.
→ NEVER use Lorem Ipsum, AI-sounding language, or generic stock phrases.
→ The creative brief above is your compass — let it inform every word and colour choice.`;
}

function buildPass1UserPrompt(fields, industryBrief) {
  const pkg       = fields['Package'] || 'Standard';
  const isPremium = packageKey(pkg) === 'premium';

  const brief = industryBrief || {};
  const suggestedPalette = brief.palette
    ? `Suggested: bg ${brief.palette.bg}, accent ${brief.palette.accent} (override if client specified colours)`
    : 'Choose industry-appropriate';

  return `Generate website content for this South African business. Return ONLY this JSON structure with no other text:

BUSINESS BRIEF:
Name: ${fields['Business Name'] || ''}
Industry: ${fields['Industry'] || ''}
About: ${fields['About'] || ''}
Services: ${fields['Services'] || ''}
Area: ${fields['Area'] || ''}
Package: ${pkg}
Voice/Vibe: ${fields['Vibe'] || brief.mood || 'Professional, warm, South African'}
Social bio: ${fields['Bio'] || 'Not provided'}
Colours requested: ${fields['Colours'] || suggestedPalette}
Suggested fonts: Display: ${brief.fonts?.display || 'Syne'}, Body: ${brief.fonts?.body || 'DM Sans'}
Vibe words to weave in: ${brief.vibeWords?.join(', ') || ''}
Trust signals to reference: ${brief.trustSignals?.join(', ') || ''}

Return this exact JSON:
{
  "aesthetic": "one of: refined_luxury | bold_modern | warm_artisan | raw_editorial | soft_organic",
  "color_bg": "#hex — dominant background",
  "color_surface": "#hex — card/section background",
  "color_accent": "#hex — primary accent, 1 strong colour",
  "color_text": "#hex — body text",
  "color_muted": "#hex — secondary text",
  "font_display": "Google Font name for headings (NOT Inter/Roboto/Arial)",
  "font_body": "Google Font name for body",
  "hero_badge": "short location + trust line, max 8 words",
  "hero_h1_line1": "line 1",
  "hero_h1_line2": "line 2",
  "hero_h1_line3": "line 3",
  "hero_accent_word": "one word in line 2 or 3 that gets accent colour",
  "hero_copy": "2 sentences — the business story, warm and specific",
  "cta_primary": "primary button text",
  "cta_secondary": "WhatsApp button text",
  "stat1_num": "e.g. 15+", "stat1_lbl": "e.g. Years in Pretoria East",
  "stat2_num": "e.g. 24/7", "stat2_lbl": "e.g. Emergency Response",
  "stat3_num": "e.g. 100%", "stat3_lbl": "e.g. Family-Owned",
  "services": [
    {"icon": "emoji", "name": "Service name", "desc": "One sentence, specific to their business"},
    {"icon": "emoji", "name": "Service name", "desc": "One sentence"},
    {"icon": "emoji", "name": "Service name", "desc": "One sentence"},
    {"icon": "emoji", "name": "Service name", "desc": "One sentence"},
    {"icon": "emoji", "name": "Service name", "desc": "One sentence"}
  ],
  "about_headline": "About section H2 — specific to their story",
  "about_pull_quote": "One memorable line that captures their brand promise",
  "about_p1": "First paragraph — their story and why they started",
  "about_p2": "Second paragraph — what makes them different",
  "trust_points": ["Point 1", "Point 2", "Point 3"],
  "contact_h2_line1": "Contact headline line 1",
  "contact_h2_line2": "line 2 (accent word here)",
  "contact_h2_accent": "the accent word",
  "contact_copy": "One line — warm, direct, reassuring",
  "services_section_tag": "section label e.g. What We Do",
  "services_h2": "Services section headline",
  "about_section_tag": "section label e.g. Our Story",
  "contact_section_tag": "section label e.g. Get In Touch",
  "og_title": "${fields['Business Name']} | tagline for OG",
  "og_description": "One sentence for WhatsApp link preview",
  "page_title": "${fields['Business Name']} | Industry | Area"${isPremium ? `,
  "testimonials": [],
  "gallery_heading": "Gallery section headline"` : ''}
}`;
}

function buildPass2SystemPrompt() {
  return `You are a senior CSS engineer building a shared design system for a South African small business website.

OUTPUT RULES — non-negotiable:
→ Output ONLY a single <style> block. Start with <style> and end with </style>. No other text.
→ Include @import for Google Fonts inside the <style> block.
→ Define all colours, fonts, and spacing as CSS custom properties in :root.
→ Write all shared component styles: reset, typography, nav, buttons, cards, grid utilities, footer, FAB, animations.
→ Do NOT write any page-specific section HTML or inline content.
→ All styles MUST be mobile-first and fully responsive. Main breakpoint: 720px.

TOKEN BUDGET WARNING:
This stylesheet must be complete and fully closed with </style>. If you are approaching the response limit, prioritise: hero styles, nav styles, section styles, card styles, FAB. Cut animations and decorative effects before cutting structural styles. NEVER leave a CSS rule with an open brace and no close.`;
}

function buildPass2UserPrompt(contentJson, fields, industryBrief) {
  return `Generate the shared CSS design system for this website.

BRAND TOKENS:
Aesthetic: ${contentJson.aesthetic || 'bold_modern'}
--bg:      ${contentJson.color_bg      || '#0a0a0f'}
--surface: ${contentJson.color_surface || '#111118'}
--acc:     ${contentJson.color_accent  || '#ff5500'}
--text:    ${contentJson.color_text    || '#ffffff'}
--muted:   ${contentJson.color_muted   || '#888899'}
Display font: ${contentJson.font_display || 'Syne'} — weights 700, 800
Body font:    ${contentJson.font_body    || 'DM Sans'} — weights 400, 500, 600

REQUIRED COMPONENTS — all MUST be present, named exactly as below:
1.  :root                  — all custom properties above, plus --radius:12px, --transition:0.2s
2.  @import                — Google Fonts for both fonts
3.  Reset                  — *, box-sizing:border-box, margin:0, padding:0
4.  body                   — bg, text colour, font-body, line-height:1.6
5.  h1–h4                  — font-display, tight letter-spacing, leading
6.  .nav                   — position:fixed top, full width, z-index:100, flex, brand left / links right
7.  .nav-links             — horizontal on desktop, display:none on mobile
8.  .hamburger             — display:none desktop, visible mobile, no border
9.  .mobile-nav            — full-screen overlay, flex column, centred; shown via .open class
10. .btn-primary           — var(--acc) bg, white text, padding 12px 28px, border-radius var(--radius)
11. .btn-outline           — transparent, 1px solid white, same padding
12. .section               — padding 80px 20px desktop / 60px 16px mobile
13. .section-tag           — uppercase, var(--acc), font-size 11px, letter-spacing 3px, margin-bottom 12px
14. .page-hero             — 300px height, bg var(--surface), flex center, text-align center
15. .card                  — var(--surface) bg, border-radius var(--radius), padding 28px, box-shadow subtle
16. .grid-2                — 2-col CSS grid, gap 32px; 1-col under 720px
17. .grid-3                — 3-col CSS grid, gap 24px; 1-col under 720px
18. .grid-5                — 5-col CSS grid, gap 20px; 2-col under 900px; 1-col under 520px
19. .fab-wa                — position:fixed bottom-right 24px, width 56px, height 56px, border-radius 50%, background #25D366, z-index:200, flex center
20. footer                 — var(--surface) bg, centre-aligned, font-size 12px, padding 20px, var(--muted) colour
21. .fade-up               — opacity:0 translateY(20px); animation triggers on .visible class
22. @keyframes fadeUp      — 0%: opacity 0 translateY(20px); 100%: opacity 1 translateY(0)
23. html                   — scroll-behavior:smooth
24. Gallery styles         — .gallery-grid (CSS grid 3-col/2-col/1-col), .gallery-item img (width 100%, object-fit:cover, border-radius var(--radius))
25. .stats-strip           — 3-col flex/grid, glassmorphism bg, anchored to hero bottom
26. .hero                  — min-height:100vh; display:flex; flex-direction:column; justify-content:center; align-items:center; text-align:center; position:relative; background-size:cover; background-position:center; background-repeat:no-repeat; padding-bottom:80px;
27. .hero-content          — position:relative; z-index:2; max-width:800px; padding:0 20px;
28. .hero-overlay          — position:absolute; inset:0; background:linear-gradient(rgba(0,0,0,0.5),rgba(0,0,0,0.7)); z-index:1;

Output ONLY the <style> block. Start immediately with <style>.`;
}

function buildPass4SystemPrompt(pageName, pkg) {
// Also aliased as buildPass3PageSystemPrompt for backward compatibility
  const pkgKey  = packageKey(pkg);
  const caps    = getPackageCaps(pkgKey);
  const navStr  = caps.pages.map(p => p === 'index' ? 'Home' : (p[0].toUpperCase() + p.slice(1))).join(' | ');

  return `You are an expert South African web developer building one page of a multi-page website.

OUTPUT RULES — non-negotiable:
→ Output ONLY raw HTML. Start with <!DOCTYPE html>. No preamble, no explanation, no backticks.
→ DO NOT include any <style> block or <link rel="stylesheet"> in your output. The stylesheet is injected by our build pipeline. In <head>, place EXACTLY this single line where styles should go: <!--WH_CSS_INJECT-->
→ The CSS classes you may reference are listed in the user message. Use ONLY those classes. You MAY add inline styles ONLY for: hero background-image URLs, section min-height, and dynamic values that cannot be known at CSS authoring time.
→ You MUST NOT use Lorem Ipsum. You MUST NOT invent contact details not provided.
→ You MUST include a <nav class="nav"> with links to all pages using relative paths (${navStr}).
→ You MUST include a WhatsApp FAB: <a href="..." class="fab-wa" ...>💬</a>
→ You MUST include og:title, og:description, og:image meta tags.
→ You MUST include a <script> tag at the end for hamburger toggle (and gallery fetch on the gallery page).
→ You MUST include the business name in the <title> tag.
→ You are building the ${pageName.toUpperCase()} page only. Do not include sections belonging to other pages.`;
}

function buildPass4UserPrompt(pageName, contentJson, cssBlock, fields, unsplashContext, slug, pkg, env) {
// Also aliased as buildPass3PageUserPrompt for backward compatibility
  const pkgKey    = packageKey(pkg);
  const caps      = getPackageCaps(pkgKey);
  const isPremium = pkgKey === 'premium';
  const isExpress = pkgKey === 'express';
  const waIntl    = normaliseSaPhone(fields['WhatsApp']);
  const email     = fields['Email'] || '';
  const area      = fields['Area']  || '';
  const domain    = fields['Domain'] || `${slug}.co.za`;
  const bizName   = fields['Business Name'] || '';

  // Patch-worker URL for the gallery fetch script. Resolved here so the model
  // receives the actual URL, not a literal ${WORKER_URL_PATCH} placeholder.
  // WORKER_URL_PATCH must be set as a Cloudflare env var — no old-worker fallback.
  const patchWorkerUrl = env?.WORKER_URL_PATCH
    || 'https://wh-patch.pierreduplessis6912.workers.dev';

  // Build nav links from the actual page set for this tier
  const navLinks = caps.pages.map(p => {
    const label = p === 'index' ? 'Home' : (p[0].toUpperCase() + p.slice(1));
    const href  = p === 'index' ? '/' : `/${p}`;
    return `<a href="${href}">${label}</a>`;
  }).join('');

  // Exact services count from contentJson — pass it to the prompt explicitly
  const servicesArr   = Array.isArray(contentJson.services) ? contentJson.services : [];
  const servicesCount = servicesArr.length || 5;
  const servicesList  = servicesArr.map((s, i) =>
    `${i + 1}. ${s.icon || '⚡'} ${s.name}: ${s.desc}`
  ).join('\n');

  const trustPoints = (contentJson.trust_points || []).join(' | ');

  const ogImageMatch = unsplashContext.match(/https:\/\/images\.unsplash\.com\/[^\s\n]+/);
  const ogImage = ogImageMatch
    ? ogImageMatch[0]
    : 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&q=80';

  const pageTitles = {
    index:    contentJson.page_title || bizName,
    services: `Services | ${bizName}`,
    about:    `About Us | ${bizName}`,
    contact:  `Contact | ${bizName}`,
    gallery:  `Gallery | ${bizName}`,
  };

  // Express index page packs all four sections into one page
  const expressIndex = `
BUILD: EXPRESS HOME PAGE — single-page site. Hero + services + about + contact, all on /index.

HERO SECTION — use this EXACT HTML structure (fill in content, keep all attributes):
<section id="home" class="hero" style="background-image:url(UNSPLASH_URL);">
  <div class="hero-overlay"></div>
  <div class="hero-content"><!-- badge, h1, copy, CTAs --></div>
  <div class="stats-strip"><!-- 3 stats --></div>
</section>
Replace UNSPLASH_URL with the first photo URL from PHOTOS below.
  Badge:        "${contentJson.hero_badge || ''}"
  H1 line 1:    "${contentJson.hero_h1_line1 || ''}"
  H1 line 2:    "${contentJson.hero_h1_line2 || ''}" — wrap "${contentJson.hero_accent_word || ''}" in <em style="color:var(--acc);font-style:normal">
  H1 line 3:    "${contentJson.hero_h1_line3 || ''}"
  Body copy:    "${contentJson.hero_copy || ''}"
  CTA 1 (.btn-primary):  "${contentJson.cta_primary  || 'Get a Free Quote'}" → https://wa.me/${waIntl}
  CTA 2 (.btn-outline):  "${contentJson.cta_secondary || 'WhatsApp Us'}"     → https://wa.me/${waIntl}

STATS STRIP (.stats-strip):
  ${contentJson.stat1_num} ${contentJson.stat1_lbl} | ${contentJson.stat2_num} ${contentJson.stat2_lbl} | ${contentJson.stat3_num} ${contentJson.stat3_lbl}

SERVICES SECTION (id="services", class="section"):
  Tag: "${contentJson.services_section_tag || 'What We Do'}"
  H2:  "${contentJson.services_h2 || 'Our Services'}"
  Use .grid-${servicesCount >= 5 ? '5' : (servicesCount >= 3 ? '3' : '2')} with EXACTLY ${servicesCount} .card elements:
${servicesList}
  Each card: icon span, h3 with service name, p with description.

ABOUT SECTION (id="about", class="section"):
  Use .grid-2 (image left from PHOTOS, text right):
  Pull quote: "${contentJson.about_pull_quote || ''}"
  Paragraph 1: "${contentJson.about_p1 || ''}"
  Paragraph 2: "${contentJson.about_p2 || ''}"
  Trust points: ${trustPoints}

CONTACT SECTION (id="contact", class="section"):
  H2: "${contentJson.contact_h2_line1 || 'Get In Touch'} ${contentJson.contact_h2_line2 || ''}"
  Use .grid-2 of .card elements:
    📞 ${fields['WhatsApp'] || ''}
    💬 https://wa.me/${waIntl}
    📧 ${email || '(not provided)'}
    📍 ${area}
  Emergency CTA (.btn-primary, full-width): "WhatsApp Us Now" → https://wa.me/${waIntl}

${unsplashContext}`;

  const pageContent = {

    index: isExpress ? expressIndex : `
BUILD: HOME PAGE — conversion-focused. Hero + stats strip + bottom CTA only. No services grid, no full about (those are separate pages).

HERO SECTION — use this EXACT HTML structure (fill in content, keep all attributes):
<section id="home" class="hero" style="background-image:url(UNSPLASH_URL);">
  <div class="hero-overlay"></div>
  <div class="hero-content"><!-- badge, h1, copy, CTAs --></div>
  <div class="stats-strip"><!-- 3 stats --></div>
</section>
Replace UNSPLASH_URL with the first photo URL from PHOTOS below.
  Badge:        "${contentJson.hero_badge || ''}"
  H1 line 1:    "${contentJson.hero_h1_line1 || ''}"
  H1 line 2:    "${contentJson.hero_h1_line2 || ''}" — wrap "${contentJson.hero_accent_word || ''}" in <em style="color:var(--acc);font-style:normal">
  H1 line 3:    "${contentJson.hero_h1_line3 || ''}"
  Body copy:    "${contentJson.hero_copy || ''}"
  CTA 1 (.btn-primary):  "${contentJson.cta_primary  || 'Get a Free Quote'}" → https://wa.me/${waIntl}
  CTA 2 (.btn-outline):  "${contentJson.cta_secondary || 'WhatsApp Us'}"     → https://wa.me/${waIntl}

STATS STRIP (.stats-strip — anchored to hero bottom):
  ${contentJson.stat1_num} ${contentJson.stat1_lbl} | ${contentJson.stat2_num} ${contentJson.stat2_lbl} | ${contentJson.stat3_num} ${contentJson.stat3_lbl}

BOTTOM CTA SECTION:
  Button (.btn-primary): "WhatsApp Us Now" → https://wa.me/${waIntl}

${unsplashContext}`,

    services: `
BUILD: SERVICES PAGE — full services grid, trust signals, emergency CTA.

PAGE HERO (.page-hero):
  Heading: "Our Services"
  Subtext: Brief one-liner about the business.

SERVICES GRID — use .grid-${servicesCount >= 5 ? '5' : (servicesCount >= 3 ? '3' : '2')} with EXACTLY ${servicesCount} .card elements:
${servicesList}
${isPremium
  ? `PREMIUM: Each .card has icon (large), service name (h3), FULL description (3-4 sentences), price range if applicable, specific WhatsApp CTA link.`
  : `STANDARD: Each .card has icon, service name (h3), one-sentence description, WhatsApp CTA link.`}

TRUST SIGNALS STRIP (.grid-3):
  ${trustPoints}

EMERGENCY CTA BOX (.card, accent border):
  Button (.btn-primary): "WhatsApp Us" → https://wa.me/${waIntl}?text=Hi%2C+I+need+urgent+help`,

    about: `
BUILD: ABOUT PAGE — story, team${isPremium ? ', testimonials' : ''}.

PAGE HERO (.page-hero):
  Heading: "${contentJson.about_headline || 'Our Story'}"

STORY SECTION (.grid-2 — image left, text right; stacks on mobile):
  Left:  Unsplash team/about photo from context
  Right:
    Pull quote (blockquote, left border var(--acc)): "${contentJson.about_pull_quote || ''}"
    Paragraph 1: "${contentJson.about_p1 || ''}"
    Paragraph 2: "${contentJson.about_p2 || ''}"

TRUST POINTS (.grid-3, icon + text per cell):
  ${trustPoints}
${isPremium ? `
TEAM SECTION (.grid-2):
  Founder card: name from business fields, role "Founder & Owner", short bio from about field.

TESTIMONIALS (.grid-3, .card each):
${(contentJson.testimonials || []).map((t, i) => `  ${i + 1}. ${JSON.stringify(t)}`).join('\n') || '  Use 3 generic but plausible SA business testimonials — never fabricate names, use initials only.'}` : ''}

${unsplashContext}`,

    contact: `
BUILD: CONTACT PAGE — contact info, form${isPremium ? ', map, hours' : ''}, emergency CTA.

PAGE HERO (.page-hero):
  H1: "${contentJson.contact_h2_line1 || 'Get In Touch'} ${contentJson.contact_h2_line2 || ''}"
  Copy: "${contentJson.contact_copy || ''}"

CONTACT INFO GRID (.grid-2, each a .card):
  📞 ${fields['WhatsApp'] || ''}
  💬 https://wa.me/${waIntl}
  📧 ${email || '(not provided)'}
  📍 ${area}

CONTACT FORM (Formspree):
  <form action="https://formspree.io/f/placeholder" method="POST">
  Fields: Name, Phone (tel), Message (textarea 4 rows), Submit (.btn-primary)
${isPremium ? `
MAP EMBED:
  <iframe src="https://maps.google.com/maps?q=${encodeURIComponent((area || 'South Africa') + ', South Africa')}&output=embed" width="100%" height="300" style="border:0;border-radius:var(--radius);" loading="lazy" allowfullscreen></iframe>

OPERATING HOURS (.card):
  Mon–Fri: 08:00–17:00 | Sat: 08:00–13:00 | Sun: Closed` : ''}

EMERGENCY CTA (.btn-primary, full-width):
  "Need urgent help? WhatsApp now →" → https://wa.me/${waIntl}?text=Emergency%20-%20I+need+urgent+help`,

    gallery: `
BUILD: GALLERY PAGE — dynamic photo grid fetched at runtime. Premium only.

PAGE HERO (.page-hero):
  Heading: "${contentJson.gallery_heading || 'Our Work'}"
  Subtext: "Updated regularly — every photo shows real work from our team."

UPLOAD PROMPT CARD (.card, margin-bottom 32px):
  Icon: 📸
  Heading: "Add your photos"
  Text: "Send photos to us on WhatsApp and they appear here within minutes."
  Button (.btn-outline): "WhatsApp a Photo" → https://wa.me/${waIntl}?text=Hi%2C+here+are+some+photos+for+my+gallery

GALLERY CONTAINER:
  <p id="gallery-loader" style="color:var(--muted);text-align:center;padding:40px 0;">Loading photos...</p>
  <div id="gallery-grid" class="gallery-grid"></div>

INCLUDE THIS EXACT SCRIPT (patch-worker URL is already substituted below):
<script>
(function(){
  var slug='${slug}';
  var grid=document.getElementById('gallery-grid');
  var loader=document.getElementById('gallery-loader');
  fetch('${patchWorkerUrl}/gallery-assets/'+slug)
    .then(function(r){return r.json();})
    .then(function(photos){
      loader.style.display='none';
      if(!photos||!photos.length){
        grid.innerHTML='<p style="color:var(--muted);text-align:center;grid-column:1/-1;padding:40px 0;">Photos coming soon.</p>';
        return;
      }
      grid.innerHTML=photos.map(function(url){
        return '<div class="gallery-item"><img src="'+url+'" alt="Gallery photo" loading="lazy"></div>';
      }).join('');
    })
    .catch(function(){
      loader.style.display='none';
      grid.innerHTML='<p style="color:var(--muted);text-align:center;grid-column:1/-1;">Could not load photos — try refreshing.</p>';
    });
})();
</script>`,

  }[pageName] || `BUILD: ${pageName.toUpperCase()} page.`;

  return `Build the complete ${pageName.toUpperCase()} page.

══ SHARED CSS (REFERENCE ONLY — DO NOT include this in your output. In <head>, put exactly <!--WH_CSS_INJECT--> instead. The build pipeline injects the styles afterwards.) ══
${cssBlock}

══ NAV ══
<nav class="nav">
  <a href="/" class="brand" style="font-weight:800;text-decoration:none;color:var(--text);">${bizName}</a>
  <div class="nav-links">${navLinks}</div>
  <button class="hamburger" aria-label="Open menu">☰</button>
</nav>
<div class="mobile-nav" id="mobileNav">${navLinks}</div>

══ WHATSAPP FAB ══
<a href="https://wa.me/${waIntl}" class="fab-wa" target="_blank" rel="noopener" aria-label="WhatsApp">💬</a>

══ META ══
Page title:     ${pageTitles[pageName] || bizName}
OG title:       ${contentJson.og_title || bizName}
OG description: ${contentJson.og_description || ''}
OG image:       ${ogImage}
Domain:         ${domain}

══ HAMBURGER SCRIPT ══
<script>
document.querySelector('.hamburger').addEventListener('click',function(){
  document.getElementById('mobileNav').classList.toggle('open');
});
</script>

══ PAGE CONTENT ══
${pageContent}

Output ONLY the complete HTML. Start with <!DOCTYPE html>.`;
}

// ============================================================

// ============================================================
// PASS 5 PROMPTS — Soul: Personality & Polish
// Pass 5 reads the completed Pass 4 HTML and makes surgical
// micro-copy improvements — it does NOT rewrite the page.
// It patches: hero copy, CTA text, stat labels, section tags,
// pull quotes, and footer tagline. Returns complete HTML.
// ============================================================

function buildPass5SystemPrompt(pageName, industryBrief) {
  const brief = industryBrief || {};
  return `You are a South African brand voice specialist doing final personality polish on a completed website page.

YOUR MISSION — surgical micro-copy improvements only:
→ Strengthen the hero headline if it sounds generic
→ Make CTAs more specific and action-driven (e.g. "WhatsApp Pierre Now" not "Contact Us")
→ Punch up stat labels to be more specific to the business
→ Make section tags feel alive (not "Our Services" — something that fits this exact business)
→ Sharpen the pull quote to be truly memorable
→ Add ONE unexpected human detail that makes the brand feel real

CREATIVE BRIEF:
Mood: ${brief.mood || 'professional, warm, South African'}
Copy style: ${brief.copyStyle || 'Direct. Warm. SA-specific.'}
Emotional register: ${brief.emotionalRegister || 'Trustworthy and approachable.'}
Vibe words: ${brief.vibeWords?.join(', ') || ''}

OUTPUT RULES — non-negotiable:
→ Return the COMPLETE page HTML with your patches applied
→ Do NOT change layout, CSS, images, or structure
→ Do NOT add new sections or remove existing ones
→ Only change text content in the specific elements above
→ If the copy is already strong, return the HTML unchanged
→ Start with <!DOCTYPE and end with </html>`;
}

function buildPass5UserPrompt(pageName, html, contentJson, fields, industryBrief) {
  const brief = industryBrief || {};
  return `Apply personality polish to this ${pageName} page for ${fields['Business Name'] || 'this business'}.

Business context:
- Industry: ${fields['Industry'] || 'General'}
- Area: ${fields['Area'] || 'South Africa'}
- About: ${fields['About'] || ''}
- Vibe requested: ${fields['Vibe'] || brief.mood || ''}

Focus areas to check and improve:
1. Hero headline — is it punchy and specific to THIS business?
2. CTA buttons — are they personal and action-driven?
3. Stat labels — are they specific or generic?
4. Section tags — do they feel alive?
5. Pull quote — is it truly memorable?
6. Any element that sounds like AI wrote it — make it human.

Return the complete page HTML with improvements applied:

${html}`;
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

// Exports used by patch-worker (vision system + watermark removal on go-live)
export { removeWatermark, addFooterCredit };
