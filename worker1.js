// ============================================================
// WEBSITE HUB — Cloudflare Worker v6.0
// Complete automation: scrape → build → preview → payment → live → retainer
//
// NEW IN v6.0 (spec lock: May 8, 2026):
//   — Pricing: Standard R0 build R699/mo, Premium R0 build R1099/mo, Upgrade delta R400
//   — Formspree webhook → PIN flow (no payment link on submit)
//   — New /build-status route — polling endpoint for verify page (GET ?token=)
//   — New /preview-choices route — saves panel selections to KV
//   — PayFast deposit → go-live only (reads preview_choices, no rebuild queue)
//   — runOutboundCron auto mode → always creates Airtable record before queuing
//   — processMessageQueue() called from runDailyCron (orphaned function fix)
//   — handleGoLiveInternal → generates manage token, stores in KV, sends in go-live msg
//   — New /manage-panel route — returns panel data for a manage token
//   — New /submit-revision route — creates revision ticket, checks counter, queues rebuild
//   — registerDomain() wired to registerdomain.co.za API when REGISTERDOMAIN_API_KEY set
//   — BF-01: /trigger-build now validates x-admin-key header
//   — BF-02: PayFast webhook idempotency — double-fire protection via KV lock
//   — BF-03: Queue dead letter logging — failed jobs logged to KV + owner alert
//   — BF-04: Admin key validated from env, never hardcoded
//   — BF-05: Watermark bar — 2 buttons only: Go Live + Not Interested
//            Not Interested writes optout:{phone} to KV immediately
//   — ENHANCE-02: Circuit breaker flags — OUTBOUND_ENABLED, REFERRAL_ENABLED,
//                 VISION_VALIDATION_ENABLED (all off by default)
//   — ENHANCE-03: Operational health logging to KV on every real operation
//   — ENHANCE-04: Post-payment revision flow — client texts change → rebuild → confirm
//   — ENHANCE-05: Revision limits by plan (Standard 2/mo, Premium unlimited)
//   — ENHANCE-08: All unready features wrapped in env flags
//   — ENHANCE-09: All AI language removed from client-facing touchpoints
//   — ENHANCE-18: Send window enforcement — 9am–12pm SAST, Tue–Thu only
//                 (retainer reminders exempt from day-of-week, still time-gated)
//   — ENHANCE-19: Prospect limbo follow-up — day 3 soft, day 7 final + 60-day cooldown
//   — ENHANCE-20: Preview link expiry — 30 days, branded expired page
//   — ENHANCE-24: Cron fires at 11pm SAST — processes outbound, holds delivery
//   — ENHANCE-25: Prospecting intelligence logging per cron run
//   — ENHANCE-26: Go-live WhatsApp — Claude-written, personal per client
//                 Premium: referral link in go-live message at peak excitement
//   — ENHANCE-27: Post go-live sequence — day 1 tip, day 7 pulse
//   — ENHANCE-29: Standard late payment grace offer — reply HELP triggers Premium trial
//   — ENHANCE-30: Premium late payment — referral-first language throughout
//   — ENHANCE-31: Cancellation flow — FILE / DOMAIN / ARCHIVE three options
//   — ENHANCE-32: Win-back touch — 90-day trigger, no rebuild fee within 12 months
//   — ENHANCE-36: Interactive preview panel — /patch-preview accepts structured JSON
//   — ENHANCE-37: Visitor count tracking per slug on site serve
//   — DEPENDENCY-01: KV activity logs on every significant operation
//   — DEPENDENCY-03: Visitor count tracking on site serve requests
//   — DEPENDENCY-04: Referral cookie / hidden field processing
//   — DEPENDENCY-05: Zoho credit note creation for referral credits
//   — DEPENDENCY-06: Upgrade delta payment — R250 only via /upgrade-to-premium
//   — DEPENDENCY-07: REFERRAL_ENABLED flag gates all referral link generation
//   — DEPENDENCY-09: /patch-preview — surgical patch from structured JSON payload
//   — MONITOR-01: Build failure WhatsApp alert to owner (already in v5.8, reinforced)
//
// ROUTES:
//   GET  /dropbox                  — fetch Dropbox assets (cached)
//   POST /claude                   — proxy Claude API
//   POST /formspree-webhook        — form → Airtable (Status: Lead)
//   POST /trigger-build            — admin dashboard → build [requires x-admin-key]
//   POST /update-status            — update Airtable status
//   POST /payfast-webhook          — PayFast payment → auto-trigger build or go-live
//   POST /go-live                  — strip watermark → deploy live → notify
//   POST /suspend-site             — suspend non-paying client
//   POST /reinstate-site           — reinstate after payment
//   GET  /domain-check?name=       — check .co.za availability
//   GET  /zoho-auth                — one-time Zoho OAuth setup
//   GET  /clients                  — list all clients (admin dashboard) [requires x-admin-key]
//   POST /stop-reply               — handle STOP opt-out from WhatsApp
//   POST /outbound-prospect        — trigger outbound build + WhatsApp for a prospect
//   POST /inbound-reply            — handle inbound WhatsApp replies (HELP, STOP, changes)
//   POST /patch-preview            — surgical preview patch from interactive panel
//   POST /upgrade-to-premium       — Standard → Premium upgrade (delta R250 payment)
//   POST /cancel-site              — cancellation flow (FILE/DOMAIN/ARCHIVE)
//   POST /reactivate-site          — win-back reactivation
//   GET  /not-interested           — prospect taps Not Interested on watermark bar
//   GET  /health                   — service health status
//
// CLOUDFLARE SECRETS REQUIRED:
//   ANTHROPIC_KEY
//   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_WA_FROM
//   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_ORG_ID, ZOHO_REFRESH_TOKEN
//   CF_ACCOUNT_ID, CF_API_TOKEN
//   PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY
//   WH_PHONE  (owner WhatsApp, international format no +, e.g. 27840142017)
//   UNSPLASH_ACCESS_KEY
//   ADMIN_KEY  (value: ADMIN_KEY_CLAUDEROX)
//   REGISTERDOMAIN_API_KEY  (pending IP whitelist fix)
//   REGISTERDOMAIN_EMAIL    (loc10@live.co.za)
//   GOOGLE_PLACES_API_KEY
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//
// ENVIRONMENT FLAGS (set in Cloudflare dashboard — no redeploy needed):
//   OUTBOUND_ENABLED         = "true" to enable outbound cron
//   REFERRAL_ENABLED         = "true" to enable referral links
//   VISION_VALIDATION_ENABLED = "true" to enable Claude Vision photo check
//
// KV + QUEUE BINDINGS (wrangler.toml):
//   [[kv_namespaces]]
//   binding = "SITES"
//   id = "b63e5b885ead4c02a9e184dd6477e711"
//
//   [[r2_buckets]]
//   binding = "ASSETS"
//   bucket_name = "wh-assets"
//
//   [[queues.producers]]
//   queue = "build-queue"
//   binding = "BUILD_QUEUE"
//
//   [[queues.consumers]]
//   queue = "build-queue"
//   max_batch_size = 1
//   max_retries = 2
//
// CRON (wrangler.toml):
//   [triggers]
//   crons = ["0 21 * * *"]   ← 9pm UTC = 11pm SAST (processing window)
//                               Delivery held until next 9am–12pm SAST Tue–Thu window
// ============================================================

const MAX_ZIP_SIZE   = 25 * 1024 * 1024;
const MAX_IMAGES     = 12;
const PREVIEW_DOMAIN = 'preview.websitehub.co.za';
const WORKER_DOMAIN  = 'dropbox-proxy.pierreduplessis6912.workers.dev';

// Pricing — final and locked (spec: May 8 2026)
const PRICING = {
  standard: { build: 0,    retainer: 699 },
  premium:  { build: 0,    retainer: 1099 },
  upgrade:  { delta: 400 }, // Standard → Premium monthly delta (R1099 - R699)
};

// SAST = UTC+2
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// ─── EXPORT ──────────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    const url      = new URL(request.url);
    const hostname = url.hostname;

    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    // ── Site serving (hostname-based) ──────────────────────────
    if (hostname === PREVIEW_DOMAIN) return servePreview(url, env);
    if (hostname !== WORKER_DOMAIN)  return serveLiveSite(url, hostname, env);

    // ── API routes ─────────────────────────────────────────────
    const path = url.pathname;

    if (path === '/dropbox')            return handleDropbox(request, url, env, ctx);
    if (path === '/claude')             return handleClaude(request, env);
    if (path === '/formspree-webhook')  return handleFormspreeWebhook(request, env, ctx);
    if (path === '/check-domain')         return handleCheckDomain(url, env);
    if (path === '/build-status')       return handleBuildStatus(request, url, env);
    if (path === '/preview-choices')    return handlePreviewChoices(request, env);
    if (path === '/manage-panel')       return handleManagePanel(request, url, env);
    if (path === '/submit-revision')    return handleSubmitRevision(request, env, ctx);
    if (path === '/preview-meta')       return handlePreviewMeta(request, url, env);
    if (path === '/bootstrap-preview-app') return handleBootstrapPreviewApp(request, env);
    if (path === '/trigger-build')      return handleTriggerBuild(request, env, ctx);
    if (path === '/update-status')      return handleUpdateStatus(request, env);
    if (path === '/payfast-webhook')    return handlePayfastWebhook(request, env, ctx);
    if (path === '/go-live')            return handleGoLive(request, env);
    if (path === '/suspend-site')       return handleSuspendSite(request, env);
    if (path === '/reinstate-site')     return handleReinstateSite(request, env);
    if (path === '/domain-check')       return handleDomainCheck(url, env);
    if (path === '/zoho-auth')          return handleZohoAuth(url, env);
    if (path === '/clients')            return handleListClients(request, env);
    if (path === '/stop-reply')         return handleStopReply(request, env);
    if (path === '/outbound-prospect')  return handleOutboundProspect(request, env, ctx);
    if (path === '/inbound-reply')      return handleInboundReply(request, env, ctx);
    if (path === '/patch-preview')      return handlePatchPreview(request, env, ctx);
    if (path === '/preview-revert')     return handlePreviewRevert(request, env);
    if (path === '/upgrade-to-premium') return handleUpgradeToPremium(request, env, ctx);
    if (path === '/cancel-site')        return handleCancelSite(request, env, ctx);
    if (path === '/reactivate-site')    return handleReactivateSite(request, env, ctx);
    if (path === '/not-interested')     return handleNotInterested(url, env);
    if (path === '/health')             return handleHealth(env);
    if (path === '/update-config')      return handleUpdateConfig(request, env);
    if (path === '/referral-stats')     return handleReferralStats(request, url, env);
    if (path === '/analytics')          return handleAnalytics(request, url, env);
    if (path === '/leaderboard')        return handleLeaderboard(request, env);

    return jsonResponse({ error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDailyCron(env));
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const { airtableId, paymentId, fields, isOutbound, buildToken } = message.body;
      const slug = slugify(fields?.['Business Name'] || '');
      try {
        await triggerBuildInternal(airtableId, paymentId, env, fields, isOutbound);
        message.ack();
        await logActivity(env, 'build_completed', { airtableId, business: fields?.['Business Name'] });

        // Write build_status so the verify page polling resolves
        if (buildToken) {
          await env.SITES.put(`build_status:${buildToken}`, JSON.stringify({
            status:     'ready',
            slug,
            previewUrl: `https://${PREVIEW_DOMAIN}/${slug}`,
          }));
        }

        // v7: Send second WhatsApp with slug URL for rich card OG preview
        // Slug URL serves the built site HTML with OG tags — WhatsApp renders the card
        if (!isOutbound && fields?.['WhatsApp']) {
          const phone2   = fields['WhatsApp'].replace(/\D/g, '');
          const intl2    = phone2.startsWith('27') ? phone2 : phone2.replace(/^0/, '27');
          const name2    = fields['Client Name']?.split(' ')[0] || 'there';
          const previewSlugUrl = `https://${PREVIEW_DOMAIN}/${slug}`;
          await sendWhatsApp(
            intl2,
            `🎉 ${name2}, your *${fields['Business Name']}* website is ready!\n\n👀 Tap to see it:\n${previewSlugUrl}\n\nTap *Go Live* on the page when you're happy. — Website Hub`,
            env,
            { previewUrl: true }
          ).catch(() => {});
          // Transition state to PREVIEW_SENT
          await env.SITES.put(`state:${intl2}`, JSON.stringify({
            state:      'PREVIEW_SENT',
            airtableId,
            slug,
            updatedAt:  new Date().toISOString(),
          })).catch(() => {});
        }
      } catch (err) {
        console.error('Queue build failed:', err);

        // BF-03: Dead letter logging — failed jobs never vanish silently
        await logActivity(env, 'build_failed', {
          airtableId,
          business: fields?.['Business Name'] || airtableId,
          error: err.message,
        });
        await env.SITES.put(
          `deadletter:${airtableId}:${Date.now()}`,
          JSON.stringify({ airtableId, error: err.message, fields, timestamp: new Date().toISOString() }),
          { expirationTtl: 60 * 60 * 24 * 30 } // keep 30 days
        );

        // Update verify page so it doesn't spin forever on error
        if (buildToken) {
          await env.SITES.put(`build_status:${buildToken}`, JSON.stringify({
            status: 'error',
            slug,
            error:  err.message,
          }), { expirationTtl: 3600 });
        }

        await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env).catch(() => {});
        await logBuild(airtableId, 'Failed', err.message, env).catch(() => {});

        // MONITOR-01: Build failure alert to owner
        await sendWhatsApp(env.WH_PHONE,
          `❌ BUILD FAILED\nBusiness: ${fields?.['Business Name'] || airtableId}\nError: ${err.message}\nAirtable: ${airtableId}\nCheck dashboard immediately.`,
          env
        ).catch(() => {});

        message.retry();
      }
    }
  },
};

// ============================================================
// SITE SERVING — KV-based hosting
// ============================================================

async function servePreview(url, env) {
  const rawPath = url.pathname.replace(/^\//, '');
  const segment = rawPath.split('/')[0];

  // v6.0: Serve the preview/manage SPA for all app entry points
  // /verify?session=…   — inbound PIN flow
  // /manage/TOKEN       — post-go-live manage panel
  // /  (root)           — landing
  if (!rawPath || segment === 'verify' || segment === 'manage' || segment === 'build') {
    const appHtml = await env.SITES.get('app:preview-manage');
    if (appHtml) return htmlResponse(appHtml, 200);
    // Fallback if app hasn't been bootstrapped yet
    return htmlResponse(landingPage(), 200);
  }

  // Slug-based preview — path routing for multi-page sites
  const slug    = segment;
  const subPath = rawPath.split('/').slice(1).join('/');
  const VALID_PAGES = ['index', 'services', 'about', 'contact', 'gallery'];
  const pageName = VALID_PAGES.includes(subPath) ? subPath : 'index';

  // ENHANCE-20: Check preview expiry
  const expiry = await env.SITES.get(`preview_expiry:${slug}`);
  if (expiry && new Date(expiry) < new Date()) {
    await env.SITES.put(`portfolio_candidate:${slug}`, expiry);
    await env.SITES.delete(`preview:${slug}`);
    return htmlResponse(expiredPreviewPage(slug), 410);
  }

  // Try per-page key first, fall back to legacy single-page key for index
  let html = await env.SITES.get(`preview:${slug}:${pageName}`);
  if (!html && pageName === 'index') html = await env.SITES.get(`preview:${slug}`);

  // Gallery for Standard clients — serve upgrade prompt, not 404
  if (!html && pageName === 'gallery') {
    return htmlResponse(galleryUpgradePromptPage(slug), 200);
  }

  if (!html) return htmlResponse(notFoundPage(slug), 404);

  // DEPENDENCY-03: Visitor count tracking
  const countKey = `visits:${slug}:${new Date().toISOString().split('T')[0]}`;
  env.SITES.get(countKey).then(v => {
    env.SITES.put(countKey, String((parseInt(v || '0') + 1)), { expirationTtl: 60 * 60 * 24 * 35 });
  }).catch(() => {});

  return htmlResponse(html, 200);
}

async function serveLiveSite(url, hostname, env) {
  const suspended = await env.SITES.get(`suspended:${hostname}`);
  if (suspended) return htmlResponse(suspendedPage(hostname), 402);

  const rawPath  = url.pathname.replace(/^\//, '');
  const subPath  = rawPath.split('/')[0] || '';
  const VALID_PAGES = ['index', 'services', 'about', 'contact', 'gallery'];
  const pageName = VALID_PAGES.includes(subPath) ? subPath : 'index';

  // Try per-page live key, fall back to legacy single key for index
  let html = await env.SITES.get(`live:${hostname}:${pageName}`);
  if (!html && pageName === 'index') html = await env.SITES.get(`live:${hostname}`);

  // Gallery for Standard — upgrade prompt
  if (!html && pageName === 'gallery') return htmlResponse(galleryUpgradePromptPage(hostname), 200);
  if (!html) return htmlResponse(notFoundPage(hostname), 404);

  // DEPENDENCY-03: Visitor count tracking
  const slug     = hostname.replace(/\.co\.za$/, '').replace(/\./g, '-');
  const countKey = `visits:${slug}:${new Date().toISOString().split('T')[0]}`;
  env.SITES.get(countKey).then(v => {
    env.SITES.put(countKey, String((parseInt(v || '0') + 1)), { expirationTtl: 60 * 60 * 24 * 35 });
  }).catch(() => {});

  return htmlResponse(html, 200);
}

// ============================================================
// ROUTE: /dropbox — cached asset extraction
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
      'Content-Type':               'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control':              'public, max-age=3600',
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
// ROUTE: /formspree-webhook — inbound lead → PIN verification flow
// NEW IN v6.0: No payment link on submission. Generate PIN, send
// via WhatsApp, redirect to verify page.
// ============================================================

async function handleFormspreeWebhook(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const fields = mapFormspreeToAirtable(body);

  // DEPENDENCY-04: Referral cookie processing
  const referralSlug = body['referral'] || body['Referral'] || body['ref'] || null;
  if (referralSlug) {
    fields['Referral Slug'] = referralSlug;
    // Increment referral sent count for the referrer's monthly stats
    const refMonthKey = `referral:${referralSlug}:${new Date().toISOString().slice(0, 7)}`;
    const refCurrent  = parseInt(await env.SITES.get(refMonthKey).catch(() => '0') || '0');
    await env.SITES.put(refMonthKey, String(refCurrent + 1), { expirationTtl: 60 * 60 * 24 * 35 }).catch(() => {});
  }

  // Create Airtable record immediately (status Lead)
  let record;
  try { record = await createAirtableRecord(fields, env); }
  catch (err) { return jsonResponse({ error: `Airtable error: ${err.message}` }, 500); }

  await logActivity(env, 'lead_created', { airtableId: record.id, business: fields['Business Name'] });

  // Generate build token and slug
  const token    = crypto.randomUUID().replace(/-/g, '');
  const slug     = slugify(fields['Business Name']);
  const phone    = fields['WhatsApp'];
  const name     = fields['Client Name']?.split(' ')[0] || 'there';
  const buildUrl = `https://${PREVIEW_DOMAIN}/build/${token}`;

  // Store build status immediately so the page shows building screen on tap
  await env.SITES.put(`build_status:${token}`, JSON.stringify({ status: 'building', slug }));

  // Queue the build straight away — no PIN step
  await env.BUILD_QUEUE.send({
    airtableId: record.id,
    paymentId:  null,
    fields,
    isOutbound: false,
    buildToken: token,
  });

  // Send WhatsApp with direct link — one tap, straight to building screen
  await sendWhatsApp(
    phone,
    `🔨 Hi ${name}! We're building your *${fields['Business Name']}* website right now.\n\nWe'll send you the link the moment it's ready — usually about 2 minutes. Sit tight!\n\n_You can also watch it build here: ${buildUrl}_\n— Website Hub`,
    env
  );

  await sendWhatsApp(
    env.WH_PHONE,
    `🆕 INBOUND LEAD: ${fields['Business Name']}\nPackage: ${fields['Package'] || 'Standard'}\nClient: ${fields['Client Name']}\nReferral: ${referralSlug || 'None'}\nAirtable: ${record.id}\nBuild: ${buildUrl}`,
    env
  );

  return jsonResponse({ success: true, redirect: buildUrl, airtableId: record.id });
}

// ============================================================
// ROUTE: /check-domain — checks .co.za availability via registerdomain API
// ============================================================
async function handleCheckDomain(url, env) {
  const domain = url.searchParams.get('domain')?.toLowerCase().trim();
  if (!domain) return jsonResponse({ error: 'Missing domain' }, 400);

  const slug = domain.replace(/\.co\.za$/, '');

  // Try registerdomain.co.za API if key is configured
  if (env.REGISTERDOMAIN_API_KEY) {
    try {
      const res = await fetch(`https://api.registerdomain.co.za/v2/domain/check?domain=${encodeURIComponent(domain)}&apikey=${env.REGISTERDOMAIN_API_KEY}`, {
        headers: { 'Accept': 'application/json' }
      });
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
    } catch(e) { /* fall through to WHOIS */ }
  }

  // WHOIS fallback — real check, no false optimism
  const result = await checkDomainAvailabilityWhois(domain);
  const alternatives = result.available === false ? [
    `${slug}-pta.co.za`,
    `${slug}-sa.co.za`,
    `${slug}online.co.za`,
  ] : [];
  return jsonResponse({ ...result, alternatives, fallback: true });
}


// ============================================================
async function handlePreviewRevert(request, env) {
  const { slug } = await request.json().catch(() => ({}));
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const original = await env.SITES.get(`preview-original:${slug}`);
  if (!original) return jsonResponse({ error: 'No original found' }, 404);

  await env.SITES.put(`preview:${slug}`, original);
  return jsonResponse({ success: true });
}


// NEW IN v6.0
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

  // PIN correct — delete session, mark build as in-progress
  await env.SITES.delete(`session:${token}`);
  const slug = slugify(session.fields['Business Name']);
  await env.SITES.put(`build_status:${token}`, JSON.stringify({ status: 'building', slug }));

  // Queue the build — ctx.waitUntil cannot survive a 60-120s Claude streaming call
  await env.BUILD_QUEUE.send({
    airtableId:  session.airtableId,
    paymentId:   null,
    fields:      session.fields,
    isOutbound:  false,
    buildToken:  token,  // passed so the consumer can write build_status back
  });

  return jsonResponse({ success: true, slug });
}

// ============================================================
// ROUTE: /build-status — polling endpoint for verify page
// GET ?token={token}
// NEW IN v6.0
// ============================================================

async function handleBuildStatus(request, url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);

  const raw = await env.SITES.get(`build_status:${token}`);
  if (!raw) return jsonResponse({ status: 'not_found' }, 404);

  const data = JSON.parse(raw);
  return jsonResponse(data);
}

// ============================================================
// ROUTE: /preview-choices — save panel selections to KV
// POST { slug, palette, font, photo, tagline, logo_url }
// NEW IN v6.0
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
    { expirationTtl: 60 * 60 * 24 * 35 } // 35 days
  );

  return jsonResponse({ success: true, slug });
}

// ============================================================
// ROUTE: /manage-panel — returns manage panel data for a token
// GET ?token={token}
// NEW IN v6.0
// ============================================================

async function handleManagePanel(request, url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);

  const airtableId = await env.SITES.get(`manage_token:${token}`);
  if (!airtableId) return jsonResponse({ error: 'Invalid or expired manage token' }, 404);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  const f      = record.fields;
  const slug   = f['Slug'] || slugify(f['Business Name']);
  const domain = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const pkg    = (f['Package'] || 'Standard').toLowerCase();
  const tier   = getPricingTier(f['Package'] || 'Standard');
  const monthStr = new Date().toISOString().slice(0, 7);

  // Visitor count for current month
  const visitKeys = await env.SITES.list({ prefix: `visits:${slug}:${monthStr}` }).catch(() => ({ keys: [] }));
  let totalVisits = 0;
  for (const vk of visitKeys.keys) {
    const v = await env.SITES.get(vk.name).catch(() => '0');
    totalVisits += parseInt(v || '0');
  }

  // Revision usage
  const revisionsUsed = parseInt(
    await env.SITES.get(`manage_revisions:${airtableId}:${monthStr}`).catch(() => '0') || '0'
  );
  const revisionsLimit = pkg === 'premium' ? null : 2; // null = unlimited

  // Referral stats
  const referralCount  = parseInt(await env.SITES.get(`referral_count:${airtableId}`).catch(() => '0') || '0');
  const referralCredits = parseInt(await env.SITES.get(`referral_credits:${airtableId}`).catch(() => '0') || '0');
  const referralEnabled = env.REFERRAL_ENABLED === 'true';
  const referralLink   = referralEnabled ? `https://websitehub.co.za?ref=${slug}` : null;

  // Next invoice days
  const nextInvoiceStr = f['Next Invoice Date'];
  let daysUntilInvoice = null;
  if (nextInvoiceStr) {
    const diff = new Date(nextInvoiceStr).getTime() - Date.now();
    daysUntilInvoice = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  return jsonResponse({
    airtableId,
    businessName:     f['Business Name'],
    domain,
    liveUrl:          `https://${domain}`,
    package:          f['Package'] || 'Standard',
    status:           f['Status'],
    retainer:         tier.retainer,
    nextInvoiceDate:  nextInvoiceStr || null,
    daysUntilInvoice,
    visitorsThisMonth: totalVisits,
    revisionsUsed,
    revisionsLimit,
    referralLink,
    referralCount,
    referralCredits,
    referralEnabled,
  });
}

// ============================================================
// ROUTE: /submit-revision — manage panel revision submit
// Creates Airtable ticket, checks counter, queues rebuild
// NEW IN v6.0
// ============================================================

async function handleSubmitRevision(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { token, palette, font, photo, tagline, specials } = body;
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);

  const airtableId = await env.SITES.get(`manage_token:${token}`);
  if (!airtableId) return jsonResponse({ error: 'Invalid manage token' }, 404);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  const f        = record.fields;
  const pkg      = (f['Package'] || 'Standard').toLowerCase();
  const monthStr = new Date().toISOString().slice(0, 7);
  const countKey = `manage_revisions:${airtableId}:${monthStr}`;
  const used     = parseInt(await env.SITES.get(countKey).catch(() => '0') || '0');
  const limit    = pkg === 'premium' ? Infinity : 2;

  if (used >= limit) {
    return jsonResponse({
      error:     'revision_limit_reached',
      used,
      limit: limit === Infinity ? null : limit,
    }, 403);
  }

  // Increment counter
  await env.SITES.put(countKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 35 });

  // Log revision in Airtable
  const timestamp  = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  const existing   = f['Extra Notes'] || '';
  const revisionNote = [
    `[MANAGE REVISION ${timestamp}]`,
    palette   ? `Palette: ${palette}`   : null,
    font      ? `Font: ${font}`         : null,
    photo     ? `Photo: ${photo}`       : null,
    tagline   ? `Tagline: ${tagline}`   : null,
    specials  ? `Notes: ${specials}`    : null,
  ].filter(Boolean).join('\n');

  await updateAirtableRecord(airtableId, {
    'Extra Notes': `${existing}\n\n${revisionNote}`,
    'Status':      f['Status'] === 'Live' ? 'Live' : f['Status'],
  }, env);

  // Save new choices to KV
  const slug = f['Slug'] || slugify(f['Business Name']);
  if (palette || font || photo || tagline) {
    const existing_choices = JSON.parse(await env.SITES.get(`preview_choices:${slug}`).catch(() => '{}') || '{}');
    await env.SITES.put(`preview_choices:${slug}`, JSON.stringify({
      ...existing_choices,
      ...(palette  ? { palette }  : {}),
      ...(font     ? { font }     : {}),
      ...(photo    ? { photo }    : {}),
      ...(tagline  ? { tagline }  : {}),
      savedAt: new Date().toISOString(),
    }));
  }

  // Queue rebuild
  const updatedFields = {
    ...f,
    'Extra Notes': `${existing}\n\n${revisionNote}`,
  };
  await env.BUILD_QUEUE.send({ airtableId, paymentId: null, fields: updatedFields, isOutbound: false });

  // Notify client
  const name = f['Client Name']?.split(' ')[0] || 'there';
  await sendWhatsApp(f['WhatsApp'],
    `Got it ${name}! 👍 Your revision is in — we'll have it live within 10 minutes.\n\n${pkg === 'standard' ? `_(${used + 1}/${limit} revisions used this month)_\n\n` : ''}- Website Hub`,
    env
  );

  await logActivity(env, 'manage_revision_submitted', { airtableId, business: f['Business Name'], used: used + 1 });
  return jsonResponse({ success: true, used: used + 1, limit: limit === Infinity ? null : limit });
}

// ============================================================
// ROUTE: /preview-meta — returns airtableId, package, pricing
// and hero photos for a slug. Used by preview-manage.html to
// power the Go Live button and populate the panel.
// GET ?slug={slug}
// NEW IN v6.0
// ============================================================

async function handlePreviewMeta(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  // Look up record by slug
  let records;
  try {
    records = await listAirtableRecords(`{Slug} = "${slug}"`, env);
  } catch (err) {
    return jsonResponse({ error: 'Lookup failed' }, 500);
  }

  if (!records.length) return jsonResponse({ error: 'Not found' }, 404);

  const record     = records[0];
  const f          = record.fields;
  const pkg        = f['Package'] || 'Standard';
  const tier       = getPricingTier(pkg);
  const industry   = (f['Industry'] || 'default').toLowerCase();
  const manageToken = f['Manage Token'] || null;

  // Pull stored Unsplash photo URLs from draft HTML (extract src from hero img)
  // Fallback to generic industry photos if not extractable
  const draft = await env.SITES.get(`draft:${slug}`).catch(() => null);
  const heroPhotoUrls = [];
  if (draft) {
    const matches = draft.matchAll(/<img[^>]+src="(https:\/\/images\.unsplash\.com[^"]+)"/gi);
    for (const m of matches) {
      const url = m[1].split('?')[0] + '?w=400&q=60&auto=format';
      if (!heroPhotoUrls.includes(url)) heroPhotoUrls.push(url);
      if (heroPhotoUrls.length >= 5) break;
    }
  }

  // Taglines by industry
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
    manageToken,
  });
}

// ============================================================
// ROUTE: /bootstrap-preview-app — stores preview-manage.html
// in KV so servePreview can serve it.
// POST body: raw HTML. Protected by x-admin-key.
// Run once after deploy, re-run whenever preview-manage.html changes.
// NEW IN v6.0
// ============================================================

async function handleBootstrapPreviewApp(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  const key = request.headers.get('x-admin-key');
  if (!key || key !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  const html = await request.text();
  if (!html || !html.includes('<!DOCTYPE')) {
    return jsonResponse({ error: 'Invalid HTML — must be a full DOCTYPE document' }, 400);
  }

  await env.SITES.put('app:preview-manage', html);
  await logActivity(env, 'preview_app_bootstrapped', { size: html.length });

  return jsonResponse({ success: true, size: html.length, message: 'Preview app stored in KV. preview.websitehub.co.za is now live.' });
}

// ============================================================
// ROUTE: /trigger-build — admin dashboard manual trigger
// BF-01: Now validates x-admin-key header
// ============================================================

async function handleTriggerBuild(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  // BF-01: Admin key validation
  const key = request.headers.get('x-admin-key');
  if (!key || key !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found in Airtable' }, 404); }

  const f = record.fields;
  const allowedStatuses = ['Deposit Paid', 'QA', 'Live']; // Live = W2 asset/photo rebuild
  if (!allowedStatuses.includes(f['Status'])) {
    return jsonResponse({ error: `Build blocked — status is "${f['Status']}" (must be Deposit Paid, QA, or Live)` }, 403);
  }

  await updateAirtableRecord(airtableId, { 'Status': 'Building' }, env);
  await logActivity(env, 'build_triggered', { airtableId, business: f['Business Name'], source: 'admin' });
  await sendWhatsApp(env.WH_PHONE, `🔨 BUILD STARTED: ${f['Business Name']} (${f['Package']})`, env);

  await env.BUILD_QUEUE.send({ airtableId, paymentId: null, fields: f });

  return jsonResponse({ success: true, airtableId, message: 'Build started in background' });
}

// ============================================================
// ROUTE: /outbound-prospect — build outbound preview + send WhatsApp
// ============================================================

async function handleOutboundProspect(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  const key = request.headers.get('x-admin-key');
  if (!key || key !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { businessName, phone, industry, area, about, services, googleUrl } = body;
  if (!businessName || !phone) return jsonResponse({ error: 'Missing businessName or phone' }, 400);

  // Check opt-out
  const optedOut = await env.SITES.get(`optout:${phone}`);
  if (optedOut) return jsonResponse({ error: 'Number opted out' }, 403);

  // Check 60-day cooldown
  const cooldown = await env.SITES.get(`prospect_closed:${phone}`);
  if (cooldown) {
    const closedAt = new Date(cooldown);
    const daysSince = Math.floor((Date.now() - closedAt.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince < 60) return jsonResponse({ error: `In 60-day cooldown (${60 - daysSince} days remaining)` }, 403);
  }

  // Check if already contacted (dedup)
  const slug     = slugify(businessName);
  const existing = await env.SITES.get(`outbound:${slug}`);
  if (existing) return jsonResponse({ error: 'Already contacted' }, 409);

  const domain       = `${slug}.co.za`;
  const domainStatus = await checkDomainAvailabilityInternal(domain, env);

  const fields = {
    'Business Name':   businessName,
    'WhatsApp':        phone,
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
    'Submission Date': new Date().toISOString().split('T')[0],
  };

  let record;
  try { record = await createAirtableRecord(fields, env); }
  catch (err) { return jsonResponse({ error: `Airtable error: ${err.message}` }, 500); }

  // Mark as contacted — prevents duplicates
  await env.SITES.put(`outbound:${slug}`, record.id);

  // Store prospect state for follow-up sequence
  await env.SITES.put(`prospect_state:${phone}`, JSON.stringify({
    airtableId: record.id,
    slug,
    sentAt: new Date().toISOString(),
    phase: 'sent',
  }));

  await env.BUILD_QUEUE.send({ airtableId: record.id, paymentId: null, fields, isOutbound: true });

  await logActivity(env, 'outbound_queued', { airtableId: record.id, business: businessName, phone });

  return jsonResponse({ success: true, airtableId: record.id, domain, domainStatus });
}

// ============================================================
// CORE BUILD — runs inside Cloudflare Queue (no time limit)
// ============================================================

async function triggerBuildInternal(airtableId, paymentId, env, preloadedFields, isOutbound = false) {
  const record = preloadedFields
    ? { fields: preloadedFields }
    : await getAirtableRecord(airtableId, env);
  const f = record.fields || record;

  const slug       = slugify(f['Business Name']);
  const domain     = f['Domain'] || `${slug}.co.za`;
  const mailtoLink = `mailto:updates@websitehub.co.za?subject=wh-${slug}&body=Hi%20Website%20Hub%2C%20please%20find%20my%20photos%20attached.`;

  await updateAirtableRecord(airtableId, {
    'Slug':        slug,
    'Mailto Link': mailtoLink,
    'Status':      'Building',
    'Domain':      domain,
  }, env);

  // Fetch Unsplash photos for Pass 3
  let unsplashPhotos = [];
  try {
    unsplashPhotos = await fetchUnsplashPhotos(f, env);
  } catch (e) { console.warn('Unsplash fetch failed (non-fatal):', e); }

  const unsplashContext = unsplashPhotos.length > 0
    ? `\n\nPHOTOS (use these direct URLs in <img> tags — never base64):\n` +
      unsplashPhotos.map(p => `${p.slot}: ${p.url}\nCredit: ${p.credit} on Unsplash`).join('\n') +
      `\n\nInclude small "Photos: Unsplash" credit in footer.\n`
    : '';

  // ══════════════════════════════════════════
  // PASS 1 — Content & Strategy (~800 tokens)
  // ══════════════════════════════════════════
  let contentJson;
  try {
    const p1Raw = await callClaudeInternal(
      buildPass1SystemPrompt(),
      [{ role: 'user', content: buildPass1UserPrompt(f) }],
      env,
      { maxTokens: 1500 }
    );
    const cleaned = p1Raw.replace(/```json|```/g, '').trim();
    contentJson = JSON.parse(cleaned);
    await env.SITES.put(`content:${slug}`, JSON.stringify(contentJson), { expirationTtl: 60 * 60 * 24 * 35 });
  } catch (e) {
    throw new Error(`Pass 1 failed: ${e.message}`);
  }

  // ══════════════════════════════════════════
  // PASS 2 — CSS Design System (2,500 tokens)
  // Generates the shared <style> block used across all 5 pages.
  // ══════════════════════════════════════════
  let cssBlock;
  try {
    // Pass 2 must emit 28+ CSS components with media queries — a full output
    // is typically 3000–4500 tokens. The previous 2500-token cap was truncating
    // the stream mid-CSS, leaving the <style> tag unclosed. Pass 3 then pasted
    // the truncated block verbatim, and the HTML parser entered rawtext mode at
    // <style> and swallowed the entire body as style text — producing a blank
    // page with only the SPA's surrounding chrome visible. Bumped to 5000 so a
    // full design system always fits.
    const p2Raw = await callClaudeInternal(
      buildPass2SystemPrompt(),
      [{ role: 'user', content: buildPass2UserPrompt(contentJson, f) }],
      env,
      { maxTokens: 5000 }
    );
    cssBlock = p2Raw.trim();

    if (!cssBlock.includes('<style>')) throw new Error('No <style> block in Pass 2 output');

    // Defence in depth: if the stream was still cut off and </style> is missing,
    // close it ourselves so Pass 3's pasted output never swallows the body.
    // Some CSS rules may be incomplete, but the page will still render and the
    // missing components will degrade visibly (catchable) instead of invisibly.
    if (!cssBlock.includes('</style>')) {
      console.warn(`Pass 2 output for "${slug}" missing </style> — auto-closing.`);
      await sendWhatsApp(env.WH_PHONE,
        `⚠️ Pass 2 truncated for ${f['Business Name']} (slug: ${slug}) — </style> auto-closed. Check site for missing styles.`,
        env
      ).catch(() => {});
      // Strip any trailing dangling CSS-rule fragment (open brace, no close)
      // to keep the parser happy, then append </style>.
      const lastOpenBrace  = cssBlock.lastIndexOf('{');
      const lastCloseBrace = cssBlock.lastIndexOf('}');
      if (lastOpenBrace > lastCloseBrace) {
        cssBlock = cssBlock.slice(0, lastOpenBrace).trimEnd();
      }
      cssBlock += '\n</style>';
    }

    await env.SITES.put(`css:${slug}`, cssBlock, { expirationTtl: 60 * 60 * 24 * 35 });
  } catch (e) {
    throw new Error(`Pass 2 failed: ${e.message}`);
  }

  // ══════════════════════════════════════════
  // PASS 3 — 5 Parallel Page Renders
  // Standard: 4 pages. Premium: 5 pages (adds gallery).
  // Each page gets the shared CSS + page-specific content.
  // ══════════════════════════════════════════
  const isPremium = (f['Package'] || '').toLowerCase() === 'premium';
  const pages     = ['index', 'services', 'about', 'contact'];
  if (isPremium) pages.push('gallery');

  const pageTokenBudgets = { index: 3000, services: 3000, about: 3500, contact: 3500, gallery: 2500 };

  const rawPageHtmls = await Promise.all(
    pages.map(pageName =>
      callClaudeInternal(
        buildPass3PageSystemPrompt(pageName, f['Package']),
        [{ role: 'user', content: buildPass3PageUserPrompt(pageName, contentJson, cssBlock, f, unsplashContext, slug) }],
        env,
        { maxTokens: pageTokenBudgets[pageName] || 3000 }
      ).catch(err => { console.warn(`Pass 3 failed for "${pageName}":`, err.message); return null; })
    )
  );

  // ── QA + per-page retry ─────────────────────────────────
  const builtPages = {};

  for (let i = 0; i < pages.length; i++) {
    const pageName = pages[i];
    let html = rawPageHtmls[i];

    if (!html || !html.includes('<!DOCTYPE')) {
      console.warn(`Pass 3 invalid output for "${pageName}" — retrying`);
      try {
        html = await callClaudeInternal(
          buildPass3PageSystemPrompt(pageName, f['Package']),
          [{ role: 'user', content: buildPass3PageUserPrompt(pageName, contentJson, cssBlock, f, unsplashContext, slug) }],
          env,
          { maxTokens: pageTokenBudgets[pageName] || 3000 }
        );
      } catch (e) { console.error(`Retry failed for "${pageName}":`, e.message); continue; }
    }

    const qaResult = runQAChecks(html, f, pageName);
    if (!qaResult.passed) {
      console.warn(`QA failed "${pageName}":`, qaResult.failures.join(', '));
      try {
        const qaRetry = await callClaudeInternal(
          buildPass3PageSystemPrompt(pageName, f['Package']),
          [
            { role: 'user',      content: buildPass3PageUserPrompt(pageName, contentJson, cssBlock, f, unsplashContext, slug) },
            { role: 'assistant', content: html },
            { role: 'user',      content: `QA failed: ${qaResult.failures.join(', ')}. Fix and return complete corrected HTML.` },
          ],
          env,
          { maxTokens: pageTokenBudgets[pageName] || 3000 }
        );
        const retryQA = runQAChecks(qaRetry, f, pageName);
        if (!retryQA.passed) {
          await sendWhatsApp(env.WH_PHONE,
            `⚠️ QA FAILED x2 — page "${pageName}": ${f['Business Name']}\nFailed: ${retryQA.failures.join(', ')}\nAirtable: ${airtableId}`, env
          ).catch(() => {});
          await updateAirtableRecord(airtableId, { 'QA Status': 'Failed' }, env);
        } else {
          html = qaRetry;
          await updateAirtableRecord(airtableId, { 'QA Status': 'Passed' }, env);
        }
      } catch(e) { console.warn(`QA retry error "${pageName}":`, e.message); }
    } else {
      await updateAirtableRecord(airtableId, { 'QA Status': 'Passed' }, env);
    }

    // ── Inject CSS into placeholder ────────────────────────
    // Pass 3 emits the structural HTML with a <!--WH_CSS_INJECT--> marker in <head>
    // so it doesn't waste its token budget re-emitting the entire stylesheet.
    // Substitute the real stylesheet here, with fallbacks in case the model
    // forgot the marker or the document structure is unusual.
    if (html.includes('<!--WH_CSS_INJECT-->')) {
      html = html.replace('<!--WH_CSS_INJECT-->', cssBlock);
    } else if (html.includes('</head>')) {
      console.warn(`Pass 3 for "${pageName}" omitted CSS marker — injecting before </head>`);
      html = html.replace('</head>', `${cssBlock}\n</head>`);
    } else if (/<body\b/i.test(html)) {
      console.warn(`Pass 3 for "${pageName}" has no </head> — injecting before <body>`);
      html = html.replace(/<body\b/i, `${cssBlock}\n<body`);
    } else {
      console.warn(`Pass 3 for "${pageName}" has no </head> or <body> — appending styles at top`);
      html = cssBlock + '\n' + html;
    }

    builtPages[pageName] = html;
  }

  if (!builtPages['index']) throw new Error('Home page (index) failed to build — aborting');

  // ── Store all pages in KV ────────────────────────────────
  const previewUrl = `https://${PREVIEW_DOMAIN}/${slug}`;

  for (const [pageName, html] of Object.entries(builtPages)) {
    const withWatermark = isOutbound ? addWatermark(html, f, domain, airtableId, env) : html;
    await env.SITES.put(`preview:${slug}:${pageName}`, withWatermark, { expirationTtl: 60 * 60 * 24 * 35 });
    await env.SITES.put(`draft:${slug}:${pageName}`,   html,          { expirationTtl: 60 * 60 * 24 * 35 });
  }

  // Backward-compat: legacy keys always point to home page
  const homeWithWatermark = isOutbound
    ? addWatermark(builtPages['index'], f, domain, airtableId, env)
    : builtPages['index'];

  await env.SITES.put(`preview:${slug}`,          homeWithWatermark,   { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`preview-original:${slug}`, homeWithWatermark,   { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`draft:${slug}`,            builtPages['index'], { expirationTtl: 60 * 60 * 24 * 35 });

  const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.SITES.put(`preview_expiry:${slug}`, expiryDate);

  const tokens = Math.round(Object.values(builtPages).join('').length / 4);
  await logBuild(airtableId, 'Success', null, env, tokens);
  await logHealth(env, 'build', 'success');

  await updateAirtableRecord(airtableId, {
    'Status':     'QA',
    'PreviewURL': previewUrl,
    ...(paymentId ? { 'PayFast Payment ID': paymentId } : {}),
  }, env);

  // ── Send preview messages ────────────────────────────────
  if (isOutbound) {
    await sendOutboundPreviewMessage(f, previewUrl, domain, airtableId, env);
  } else {
    await sendInboundPreviewMessage(f, previewUrl, domain, airtableId, env);
  }

  await sendWhatsApp(env.WH_PHONE,
    `✅ BUILD COMPLETE (3-pass): ${f['Business Name']}\nPreview: ${previewUrl}\nOutbound: ${isOutbound ? 'Yes' : 'No'}\nTokens: ~${tokens}`,
    env
  );
}


async function sendInboundPreviewMessage(f, previewUrl, domain, airtableId, env) {
  const name    = f['Client Name']?.split(' ')[0] || 'there';
  const pkg     = f['Package'] || 'Standard';
  const tier    = getPricingTier(pkg);
  const payLink = buildPayFastLink(tier.build, `Website Hub Go Live`, airtableId, env);

  await sendWhatsApp(
    f['WhatsApp'],
    `🎉 Hi ${name}! Your *${f['Business Name']}* website is ready!\n\n👀 See it here:\n${previewUrl}\n\nTap *Go Live* on the page to publish it. ⚡\n\n🌐 Your site will be live at *${domain}*\n\nWant changes? Just reply here.\n— Website Hub`,
    env
  );
  await logActivity(env, 'preview_sent', { airtableId, business: f['Business Name'], type: 'inbound' });
}

// ============================================================
// OUTBOUND PREVIEW MESSAGE — Claude-written, ENHANCE-13
// ============================================================

async function sendOutboundPreviewMessage(f, previewUrl, domain, airtableId, env) {
  const tier    = getPricingTier(f['Package'] || 'Standard');
  const payLink = buildPayFastLink(tier.build, 'Website Hub Go Live', airtableId, env);
  const name    = f['Client Name']?.split(' ')[0] || f['Business Name'];

  // ENHANCE-13: 4 lines max, business name + town in line 1, single action
  try {
    const prompt = `Write a WhatsApp message to a South African small business owner. Maximum 4 lines. Warm and direct — SA tone.

Business name: ${f['Business Name']}
Town/Area: ${f['Area'] || 'South Africa'}
Industry: ${f['Industry'] || 'small business'}

Line 1: Start with their business name and town — something specific and personal.
Line 2: Say our team built them a free website — no obligation, no catch.
Line 3: Preview link only: ${previewUrl}
Line 4: Single action — go live for R${tier.build} once off. Payment link: ${payLink}
Final line must always be: "_Reply STOP to opt out._"

Write only the message. No labels. No intro. No explanation.`;

    const message = await callClaudeInternal(
      'You write short, warm, direct WhatsApp messages for a South African web agency. Human tone. Never corporate. 4 lines maximum.',
      [{ role: 'user', content: prompt }],
      env
    );

    await sendWhatsApp(f['WhatsApp'], message.trim(), env);
  } catch (e) {
    // Fallback template
    await sendWhatsApp(
      f['WhatsApp'],
      `Hi *${f['Business Name']}* in ${f['Area'] || 'South Africa'} 👋\n\nOur team built your business a free website — no strings attached.\n\n👀 ${previewUrl}\n\n🚀 Go live for R${tier.build}: ${payLink}\n\n_Reply STOP to opt out._`,
      env
    );
  }

  await logActivity(env, 'outbound_message_sent', { airtableId, business: f['Business Name'] });
}

// ============================================================
// ROUTE: /not-interested — BF-05 watermark bar "Not Interested"
// ============================================================

async function handleNotInterested(url, env) {
  const phone   = url.searchParams.get('phone');
  const slug    = url.searchParams.get('slug');
  const confirm = url.searchParams.get('confirm');

  if (!phone) {
    return htmlResponse(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Error</title></head><body style="font-family:Arial;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5"><div style="background:#fff;padding:40px;border-radius:12px;text-align:center"><h1>Missing info</h1><p style="color:#666;margin-top:8px">This link appears to be incomplete.</p></div></body></html>`, 400);
  }

  const clean = String(phone).replace(/\D/g, '');
  const intl  = clean.startsWith('27') ? clean : clean.replace(/^0/, '27');

  // First tap — show confirm page (prevents browser prefetch / accidental tap)
  if (!confirm) {
    const confirmUrl = `${url.origin}/not-interested?phone=${encodeURIComponent(phone)}&slug=${encodeURIComponent(slug||'')}&confirm=1`;
    const cancelUrl  = slug ? `https://preview.websitehub.co.za/${slug}` : 'https://websitehub.co.za';
    return htmlResponse(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Are you sure?</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:40px 32px;text-align:center;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{font-size:40px;margin-bottom:14px}h1{font-size:20px;color:#222;margin-bottom:10px}p{color:#666;line-height:1.6;font-size:14px;margin-bottom:24px}.btns{display:flex;flex-direction:column;gap:10px}.btn{display:block;padding:13px;border-radius:8px;font-size:15px;font-weight:700;text-decoration:none}.btn-yes{background:#1a1a2e;color:#fff}.btn-no{background:#f5f5f5;color:#666;border:1px solid #ddd}</style></head><body><div class="box"><div class="icon">🤔</div><h1>Are you sure?</h1><p>We'll remove you from our list and won't contact you again. This can't be undone.</p><div class="btns"><a href="${confirmUrl}" class="btn btn-yes">Yes, remove me</a><a href="${cancelUrl}" class="btn btn-no">No, go back</a></div></div></body></html>`, 200);
  }

  // Second tap — commit opt-out
  await env.SITES.put(`optout:${intl}`, new Date().toISOString());
  await env.SITES.put(`prospect_closed:${intl}`, new Date().toISOString());

  try {
    const records = await listAirtableRecords(`{WhatsApp} = "${intl}"`, env);
    if (records.length > 0) {
      await updateAirtableRecord(records[0].id, {
        'Opted Out':    true,
        'Opt Out Date': new Date().toISOString().split('T')[0],
        'Status':       'Cancelled',
      }, env);
    }
  } catch (e) { console.warn('Airtable opt-out update failed:', e); }

  await logActivity(env, 'not_interested', { phone: intl, slug });
  await sendWhatsApp(env.WH_PHONE, `👎 NOT INTERESTED (confirmed): ${slug || phone}`, env);

  return htmlResponse(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No Problem</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6}a{color:#1a1a2e;font-weight:600}</style></head><body><div class="box"><div style="font-size:48px;margin-bottom:16px">👍</div><h1>No problem at all.</h1><p>We won't contact you again.<br><br>If you ever need a website in the future, visit <a href="https://websitehub.co.za">websitehub.co.za</a> — we'll be here.</p></div></body></html>`, 200);
}

// ============================================================
// ROUTE: /stop-reply — POPIA opt-out handler
// ============================================================

async function handleStopReply(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { phone } = body;
  if (!phone) return jsonResponse({ error: 'Missing phone' }, 400);

  const clean = String(phone).replace(/\D/g, '');
  const intl   = clean.startsWith('27') ? clean : clean.replace(/^0/, '27');

  await env.SITES.put(`optout:${intl}`, new Date().toISOString());

  try {
    const records = await listAirtableRecords(`{WhatsApp} = "${intl}"`, env);
    if (records.length > 0) {
      await updateAirtableRecord(records[0].id, {
        'Opted Out':    true,
        'Opt Out Date': new Date().toISOString().split('T')[0],
      }, env);
    }
  } catch (e) { console.warn('Airtable opt-out update failed:', e); }

  await sendWhatsApp(intl, `✅ You've been removed from our list. We'll never contact you again.\n— Website Hub`, env);
  await sendWhatsApp(env.WH_PHONE, `🛑 OPT-OUT: ${intl}`, env);
  await logActivity(env, 'opt_out', { phone: intl });

  return jsonResponse({ success: true });
}

// ============================================================
// ROUTE: /inbound-reply — handle client WhatsApp replies
// ENHANCE-04: Change requests → revision flow
// ENHANCE-29: HELP reply → grace offer
// ============================================================

async function handleInboundReply(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { phone, message: msg, messageType } = body;
  if (!phone || !msg) return jsonResponse({ error: 'Missing phone or message' }, 400);

  const clean = String(phone).replace(/\D/g, '');
  const intl  = clean.startsWith('27') ? clean : clean.replace(/^0/, '27');
  const text  = (msg || '').trim().toUpperCase();

  // ── Opt-out always wins first ─────────────────────────────
  if (text === 'STOP') {
    return handleStopReply(new Request('https://x', {
      method: 'POST',
      body: JSON.stringify({ phone: intl }),
      headers: { 'Content-Type': 'application/json' },
    }), env);
  }

  // ── Check state machine ───────────────────────────────────
  const stateRaw = await env.SITES.get(`state:${intl}`).catch(() => null);
  const stateObj = stateRaw ? JSON.parse(stateRaw) : null;
  const state    = stateObj?.state || 'UNKNOWN';

  // ── PROSPECT state: waiting for name opt-in ───────────────
  if (state === 'PROSPECT') {
    const prospectRaw = await env.SITES.get(`prospect:${intl}`).catch(() => null);

    if (!prospectRaw) {
      // Prospect data expired (>30 days) — redirect to website
      await sendWhatsApp(intl,
        `Thanks for getting back to us! 👋 To get your free website preview, visit websitehub.co.za and fill in your details — takes 2 minutes.

_Reply STOP to opt out._`,
        env
      );
      return jsonResponse({ success: true, action: 'prospect_expired' });
    }

    const prospectData = JSON.parse(prospectRaw);

    // Handle non-text message types (voice, sticker, image)
    if (messageType && messageType !== 'text') {
      await sendWhatsApp(intl,
        `Hi! Please reply with your *first name* (as text) and we'll build your free website preview now 👇`,
        env
      );
      return jsonResponse({ success: true, action: 'non_text_prompt' });
    }

    // Check for opt-out phrases
    const rawLower = msg.trim().toLowerCase();
    if (['no', 'nee', 'nie', 'not interested', 'remove me', 'unsubscribe'].includes(rawLower)) {
      await env.SITES.put(`optout:${intl}`, new Date().toISOString());
      await env.SITES.put(`state:${intl}`, JSON.stringify({ state: 'COOLDOWN', updatedAt: new Date().toISOString() }));
      await sendWhatsApp(intl, `No problem at all 👍 We won't contact you again.
— Website Hub`, env);
      return jsonResponse({ success: true, action: 'opted_out' });
    }

    // Extract name using Claude — handles "Kim", "Hi I'm Kim", "my name is Pierre", etc.
    let firstName = msg.trim();
    try {
      const nameExtract = await callClaudeInternal(
        'Extract only the first name from this message. Reply with ONLY the first name, nothing else. If no name found, reply UNKNOWN.',
        [{ role: 'user', content: msg.trim() }],
        env,
        { maxTokens: 20 }
      );
      const extracted = nameExtract.trim().replace(/[^a-zA-Z]/g, '');
      if (extracted && extracted.toUpperCase() !== 'UNKNOWN' && extracted.length > 1) {
        firstName = extracted.charAt(0).toUpperCase() + extracted.slice(1).toLowerCase();
      }
    } catch (e) { /* use raw message as name fallback */ }

    // Update Airtable with their name
    const airtableId = prospectData.airtableId;
    await updateAirtableRecord(airtableId, { 'Client Name': firstName }).catch(() => {});

    // Transition state to BUILDING
    await env.SITES.put(`state:${intl}`, JSON.stringify({
      state:      'BUILDING',
      airtableId,
      slug:       prospectData.slug,
      updatedAt:  new Date().toISOString(),
    }));

    // Send building acknowledgment immediately
    await sendWhatsApp(intl,
      `${firstName}! 🔨 Perfect — we're building your *${prospectData.fields['Business Name']}* website right now.

We'll send you the link the moment it's ready — usually about 2 minutes. Sit tight.`,
      env
    );

    // Queue the build
    await env.BUILD_QUEUE.send({
      airtableId,
      paymentId:  null,
      fields:     { ...prospectData.fields, 'Client Name': firstName },
      isOutbound: true,
      buildToken: null,
    });

    // Clean up prospect data from KV
    await env.SITES.delete(`prospect:${intl}`).catch(() => {});

    await logActivity(env, 'prospect_opted_in', { airtableId, business: prospectData.fields['Business Name'], name: firstName });
    return jsonResponse({ success: true, action: 'build_queued', name: firstName });
  }

  // ── LIVE client state: revision or billing ─────────────────
  if (state === 'LIVE' || state === 'UNKNOWN') {
    // HELP reply — grace offer (ENHANCE-29)
    if (text === 'HELP') {
      const records = await listAirtableRecords(`{WhatsApp} = "${intl}"`, env).catch(() => []);
      const record  = records.find(r => r.fields['Status'] === 'Suspended' || r.fields['Status'] === 'Live');
      if (record) {
        const f          = record.fields;
        const airtableId = record.id;
        const pkg        = (f['Package'] || 'Standard').toLowerCase();
        const graceUsed  = await env.SITES.get(`grace_used:${airtableId}`);

        if (pkg === 'standard' && !graceUsed) {
          await env.SITES.put(`grace_used:${airtableId}`, new Date().toISOString());
          await env.SITES.put(`grace_expiry:${airtableId}`, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
          await updateAirtableRecord(airtableId, { 'Package': 'Premium', 'Status': 'Live' }, env);
          if (f['Domain']) await env.SITES.delete(`suspended:${f['Domain']}`);
          const slug = f['Slug'] || slugify(f['Business Name']);
          const referralLink = env.REFERRAL_ENABLED === 'true' ? `https://websitehub.co.za?ref=${slug}` : null;
          const name = f['Client Name']?.split(' ')[0] || 'there';
          await sendWhatsApp(intl,
            `Hi ${name} 👋 We've got you.\n\nWe've reinstated *${f['Business Name']}* and upgraded you to *Premium* for one month — on us.\n\nNo payment needed right now. Just pay your normal subscription next month.\n\n${referralLink ? `💡 One referral covers a whole month: ${referralLink}\n\n` : ''}Your site is live. Use it. — Website Hub`,
            env
          );
          await sendWhatsApp(env.WH_PHONE, `🆘 GRACE ACTIVATED: ${f['Business Name']} — Standard → Premium 30 days`, env);
        } else {
          const tier    = getPricingTier(f['Package'] || 'Standard');
          const payLink = buildPayFastLink(tier.retainer, 'Website Hub Monthly Subscription', airtableId, env);
          const name    = f['Client Name']?.split(' ')[0] || 'there';
          await sendWhatsApp(intl, `To reinstate your site, please pay your subscription:\n💳 ${payLink}\n— Website Hub`, env);
        }
      }
      return jsonResponse({ success: true, action: 'help_handled' });
    }

    // Revision request from live client
    try {
      const records    = await listAirtableRecords(`{WhatsApp} = "${intl}"`, env);
      const liveRecord = records.find(r => ['Live', 'QA'].includes(r.fields['Status']));

      if (liveRecord) {
        const f          = liveRecord.fields;
        const airtableId = liveRecord.id;
        const pkg        = (f['Package'] || 'Standard').toLowerCase();
        const slug       = f['Slug'] || slugify(f['Business Name']);
        const name       = f['Client Name']?.split(' ')[0] || 'there';
        const monthKey   = `revisions:${airtableId}:${new Date().toISOString().slice(0, 7)}`;
        const used       = parseInt(await env.SITES.get(monthKey).catch(() => '0') || '0');
        const limit      = pkg === 'premium' ? Infinity : 2;

        if (used >= limit) {
          await sendWhatsApp(intl,
            `Hi ${name} 👋 You've used your ${limit} revision${limit > 1 ? 's' : ''} this month.\n\n⭐ Upgrade to Premium for unlimited revisions:\nhttps://websitehub.co.za?upgrade=true&airtableId=${airtableId}\n\n— Website Hub`,
            env
          );
          return jsonResponse({ success: true, action: 'revision_limit_reached' });
        }

        const existing  = f['Extra Notes'] || '';
        const timestamp = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
        await updateAirtableRecord(airtableId, {
          'Extra Notes': `${existing}\n\n[REVISION ${timestamp}]: ${msg}`,
        }, env);
        await env.SITES.put(monthKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 35 });

        // Pass 3 only revision rebuild — reuse stored content + CSS
        const storedContent = await env.SITES.get(`content:${slug}`).catch(() => null);
        const storedCss     = await env.SITES.get(`css:${slug}`).catch(() => null);

        const updatedFields = { ...f, 'Extra Notes': `${existing}\n\n[REVISION REQUEST]: ${msg}` };

        if (storedContent && storedCss) {
          await env.BUILD_QUEUE.send({
            airtableId,
            paymentId:  null,
            fields:     updatedFields,
            isOutbound: false,
            revisionNote: msg,
          });
        } else {
          await env.BUILD_QUEUE.send({ airtableId, paymentId: null, fields: updatedFields, isOutbound: false });
        }

        await sendWhatsApp(intl,
          `Got it ${name}! 👍 We're updating your site now. New preview within 10 minutes.\n\n${pkg === 'standard' ? `_(${used + 1}/${limit} revisions used this month)_\n\n` : ''}- Website Hub`,
          env
        );
        await logActivity(env, 'revision_requested', { airtableId, business: f['Business Name'] });
        return jsonResponse({ success: true, action: 'revision_queued' });
      }
    } catch (e) { console.warn('Revision flow error:', e); }
  }

  // ── Universal catch-all: Claude-powered response ──────────
  // Handles anything not matched above — contextual, human, SA tone
  try {
    const stateContext = stateObj ? `Client state: ${state}` : 'Unknown contact — not in our system';
    const catchAllMsg = await callClaudeInternal(
      'You handle WhatsApp replies for Website Hub, a South African website agency. Reply warmly, briefly (max 3 lines), in SA tone. If the person is interested in a website, direct them to websitehub.co.za. If they seem confused, reassure them. Never promise specific timelines you cannot guarantee.',
      [{ role: 'user', content: `${stateContext}\nMessage: "${msg}"\nWrite a brief, warm reply.` }],
      env,
      { maxTokens: 150 }
    );
    await sendWhatsApp(intl, catchAllMsg.trim(), env);
  } catch (e) {
    // Fallback if Claude fails
    await sendWhatsApp(intl,
      `Hi! Thanks for getting in touch 👋\n\nFor website enquiries, visit websitehub.co.za or reply with your business name to get started.\n\n— Website Hub`,
      env
    );
  }

  return jsonResponse({ success: true, action: 'catch_all_handled' });
}


// ROUTE: /patch-preview — DEPENDENCY-09, ENHANCE-36
// Receives structured JSON from interactive preview panel
// Surgical patch — full rebuild only if tone changes
// ============================================================

async function handlePatchPreview(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  // Payload: { airtableId, palette, hero_photo, tagline, about, services, tone }
  const { airtableId, palette, hero_photo, tagline, about, services, tone } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  const f    = record.fields;
  const slug = f['Slug'] || slugify(f['Business Name']);

  const existingHtml = await env.SITES.get(`draft:${slug}`);
  if (!existingHtml) return jsonResponse({ error: 'No draft found — trigger a build first' }, 404);

  // Determine if full rebuild needed (tone change) or surgical patch
  const needsRebuild = tone && tone !== (f['Vibe'] || '');

  // Update Airtable with new values
  const updates = {};
  if (tagline) updates['About'] = (f['About'] || '') + `\n\n[TAGLINE]: ${tagline}`;
  if (about)   updates['About'] = about;
  if (services) updates['Services'] = services;
  if (tone)    updates['Vibe'] = tone;
  if (Object.keys(updates).length > 0) {
    await updateAirtableRecord(airtableId, updates, env);
  }

  if (needsRebuild) {
    // Full rebuild for tone changes
    const updatedFields = { ...f, ...updates };
    await updateAirtableRecord(airtableId, { 'Status': 'Building' }, env);
    await env.BUILD_QUEUE.send({ airtableId, paymentId: null, fields: updatedFields, isOutbound: false });
    return jsonResponse({ success: true, action: 'full_rebuild_queued', reason: 'tone_change' });
  }

  // Surgical patch — inject palette / photo / tagline via Claude
  try {
    // v7: Reuse stored Pass 1 content + Pass 2 CSS → re-run Pass 3 only (cheaper + complete)
    const storedContent = await env.SITES.get(`content:${slug}`).catch(() => null);
    const storedCss     = await env.SITES.get(`css:${slug}`).catch(() => null);

    let patched;

    if (storedContent && storedCss) {
      const contentJson = JSON.parse(storedContent);
      // Merge patch fields into content JSON
      if (tagline)    contentJson.headline_line1 = tagline;
      if (about)      contentJson.about_copy_1   = about;
      if (services)   contentJson.services = services.split(',').map(s => ({ name: s.trim(), description: '' }));
      if (palette)    contentJson.color_accent = palette;
      if (hero_photo) contentJson.hero_photo = hero_photo;
      await env.SITES.put(`content:${slug}`, JSON.stringify(contentJson), { expirationTtl: 60 * 60 * 24 * 35 });

      patched = await callClaudeInternal(
        buildRenderSystemPrompt(f['Package']),
        [{ role: 'user', content: buildRenderUserPrompt(contentJson, f, '') }],
        env,
        { maxTokens: 8000 }
      );
    } else {
      // Fallback surgical patch when stored passes not available
      const changes = [
        palette   ? `PALETTE: Change primary/accent CSS variable to ${palette}.`          : '',
        hero_photo? `HERO IMAGE: Replace hero background or img src with ${hero_photo}.`  : '',
        tagline   ? `TAGLINE: Replace hero headline with: "${tagline}"`                    : '',
        about     ? `ABOUT: Replace about section body text with: "${about}"`              : '',
        services  ? `SERVICES: Update services list with: "${services}"`                   : '',
      ].filter(Boolean).join('\n');

      patched = await callClaudeInternal(
        'Make ONLY the specified changes to this HTML. Output complete HTML starting with <!DOCTYPE html>. No preamble.',
        [{ role: 'user', content: `CHANGES:\n${changes}\n\nHTML:\n${existingHtml}` }],
        env,
        { maxTokens: 8000 }
      );
    }

    if (patched && patched.includes('<!DOCTYPE')) {
      const previewHtml = addWatermark(patched, f, f['Domain'] || `${slug}.co.za`, airtableId, env);

      // Write to legacy key (backward compat) + per-page index key
      await env.SITES.put(`preview:${slug}`, previewHtml);
      await env.SITES.put(`preview:${slug}:index`, previewHtml);
      await env.SITES.put(`draft:${slug}`, patched);
      await env.SITES.put(`draft:${slug}:index`, patched);

      // Propagate palette/tagline patches to other pages so the whole site stays consistent
      const otherPages = ['services', 'about', 'contact', 'gallery'];
      for (const pageName of otherPages) {
        let pageHtml = await env.SITES.get(`preview:${slug}:${pageName}`).catch(() => null);
        if (!pageHtml) continue;
        if (palette)    pageHtml = pageHtml.replace(/(--primary:\s*)#[0-9a-fA-F]{3,6}/g,   `$1${palette}`);
        if (tagline)    pageHtml = pageHtml.replace(/(<[^>]+class="[^"]*tagline[^"]*"[^>]*>)[^<]*/i, `$1${tagline}`);
        await env.SITES.put(`preview:${slug}:${pageName}`, pageHtml);
      }

      await logActivity(env, 'preview_patched', { airtableId, business: f['Business Name'] });

      return jsonResponse({
        success: true,
        action: 'patched',
        previewUrl: `https://${PREVIEW_DOMAIN}/${slug}`,
      });
    }
  } catch (e) {
    console.warn('Patch preview failed:', e);
  }

  return jsonResponse({ error: 'Patch failed — try a full rebuild' }, 500);
}

// ============================================================
// ROUTE: /upgrade-to-premium — DEPENDENCY-06
// Standard → Premium — R250 delta only
// ============================================================

async function handleUpgradeToPremium(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  const f   = record.fields;
  const pkg = (f['Package'] || 'Standard').toLowerCase();

  if (pkg === 'premium') return jsonResponse({ error: 'Already on Premium' }, 400);

  // R250 delta only — NOT R699
  const deltaPayLink = buildPayFastLink(
    PRICING.upgrade.delta,
    'Website Hub Premium Upgrade',
    airtableId,
    env
  );

  const name = f['Client Name']?.split(' ')[0] || 'there';

  await sendWhatsApp(
    f['WhatsApp'],
    `Hi ${name} 👋 Ready to upgrade to *Premium*?\n\nYou only pay the R250 difference — your R449/month stays the same.\n\nPremium gets you:\n• Testimonials section\n• Gallery (add photos by email)\n• Full SEO setup\n• Unlimited revisions\n• Referral programme (one referral = one free month)\n\n💳 Upgrade now — just R250: ${deltaPayLink}\n\n— Website Hub`,
    env
  );

  await logActivity(env, 'upgrade_link_sent', { airtableId, business: f['Business Name'] });

  return jsonResponse({ success: true, deltaPayLink });
}

// ============================================================
// ROUTE: /cancel-site — ENHANCE-31
// Three options: FILE / DOMAIN / ARCHIVE
// ============================================================

async function handleCancelSite(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId, option } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  const f      = record.fields;
  const slug   = f['Slug'] || slugify(f['Business Name']);
  const domain = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const name   = f['Client Name']?.split(' ')[0] || 'there';

  if (!option) {
    // Send the three-option message
    await sendWhatsApp(
      f['WhatsApp'],
      `Hi ${name} — we're sorry to see you go.\n\nBefore we close your account, what would you like to do with your website?\n\n*Reply FILE* — We'll send you your website file to keep forever.\n*Reply DOMAIN* — We'll transfer your domain to you (takes 3-5 days).\n*Reply ARCHIVE* — We'll hold your site safely. Reactivate anytime.\n\nNo reply within 7 days — we'll archive your site automatically.\n\n— Website Hub`,
      env
    );

    // Set 7-day archive default timer
    const archiveDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await env.SITES.put(`cancel_pending:${airtableId}`, archiveDate);

    return jsonResponse({ success: true, action: 'cancellation_options_sent' });
  }

  // Process chosen option
  const opt = option.toUpperCase();

  if (opt === 'FILE') {
    // Package HTML and notify owner to deliver
    const siteHtml = await env.SITES.get(`live:${domain}`) || await env.SITES.get(`draft:${slug}`);
    if (siteHtml) {
      await env.SITES.put(`archived:${airtableId}`, siteHtml);
    }
    await env.SITES.put(`suspended:${domain}`, '1');
    await updateAirtableRecord(airtableId, { 'Status': 'Cancelled' }, env);
    await env.SITES.put(`cancelled:${airtableId}`, new Date().toISOString());
    await env.SITES.delete(`cancel_pending:${airtableId}`);

    await sendWhatsApp(env.WH_PHONE,
      `📦 FILE REQUEST: ${f['Business Name']}\nSend their HTML file to: ${f['Email'] || f['WhatsApp']}\nAirtable: ${airtableId}`,
      env
    );
    await sendWhatsApp(f['WhatsApp'],
      `Hi ${name} ✅ We'll send your website file to ${f['Email'] || 'your WhatsApp'} within 24 hours.\n\nThank you for being a Website Hub client. If you ever need us again, we'll be here.\n— Website Hub`,
      env
    );

  } else if (opt === 'DOMAIN') {
    await env.SITES.put(`suspended:${domain}`, '1');
    await updateAirtableRecord(airtableId, { 'Status': 'Cancelled' }, env);
    await env.SITES.put(`cancelled:${airtableId}`, new Date().toISOString());
    await env.SITES.delete(`cancel_pending:${airtableId}`);

    // Notify owner to initiate EPP transfer
    await sendWhatsApp(env.WH_PHONE,
      `🔑 DOMAIN TRANSFER: ${domain}\nClient: ${f['Business Name']}\nGenerate EPP code from registerdomain.co.za and send to: ${f['Email'] || f['WhatsApp']}\nAirtable: ${airtableId}`,
      env
    );
    await sendWhatsApp(f['WhatsApp'],
      `Hi ${name} ✅ Your domain transfer is being processed. You'll receive an EPP transfer code within 24 hours — then your registrar will handle the rest (3-5 days).\n\nThank you for being with Website Hub.\n— Website Hub`,
      env
    );

  } else if (opt === 'ARCHIVE') {
    // Archive — site suspended but retained
    await env.SITES.put(`suspended:${domain}`, '1');
    await updateAirtableRecord(airtableId, { 'Status': 'Cancelled' }, env);
    await env.SITES.put(`cancelled:${airtableId}`, new Date().toISOString());
    await env.SITES.put(`archived_flag:${airtableId}`, new Date().toISOString());
    await env.SITES.delete(`cancel_pending:${airtableId}`);

    const reactivateLink = `https://${WORKER_DOMAIN}/reactivate-site?airtableId=${airtableId}`;

    await sendWhatsApp(f['WhatsApp'],
      `Hi ${name} ✅ Your site is safely archived.\n\nWhen you're ready to come back, tap here to reactivate — no rebuild fee within 12 months:\n${reactivateLink}\n\nTake care.\n— Website Hub`,
      env
    );
  }

  await logActivity(env, 'cancellation_processed', { airtableId, business: f['Business Name'], option: opt });
  return jsonResponse({ success: true, action: `cancel_${opt.toLowerCase()}` });
}

// ============================================================
// ROUTE: /reactivate-site — ENHANCE-32
// Win-back reactivation — no rebuild fee within 12 months
// ============================================================

async function handleReactivateSite(request, env, ctx) {
  const url = new URL(request.url);
  const airtableId = url.searchParams.get('airtableId') ||
    (request.method === 'POST' ? (await request.json().catch(() => ({}))).airtableId : null);

  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  const f      = record.fields;
  const slug   = f['Slug'] || slugify(f['Business Name']);
  const domain = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const name   = f['Client Name']?.split(' ')[0] || 'there';

  // Check if within 12-month window
  const cancelledAt = await env.SITES.get(`cancelled:${airtableId}`);
  const withinWindow = cancelledAt
    ? (Date.now() - new Date(cancelledAt).getTime()) < 365 * 24 * 60 * 60 * 1000
    : false;

  const tier    = getPricingTier(f['Package'] || 'Standard');
  const payLink = buildPayFastLink(tier.retainer, 'Website Hub Reactivation', airtableId, env);

  if (withinWindow) {
    // No rebuild fee — just subscription
    await sendWhatsApp(f['WhatsApp'],
      `Welcome back, ${name}! 🎉\n\nYour *${f['Business Name']}* site is being reinstated now — no rebuild fee.\n\nYour monthly subscription of *R${tier.retainer}* starts today:\n💳 ${payLink}\n\n— Pierre, Website Hub`,
      env
    );
    // Reinstate immediately
    await env.SITES.delete(`suspended:${domain}`);
    await updateAirtableRecord(airtableId, {
      'Status':                  'Live',
      'Monthly Retainer Active': true,
      'Next Invoice Date':       nextMonthDate(),
    }, env);
    await env.SITES.delete(`cancelled:${airtableId}`);
    await env.SITES.delete(`archived_flag:${airtableId}`);

    await sendWhatsApp(env.WH_PHONE, `🔄 REACTIVATED: ${f['Business Name']} (within 12mo window)`, env);
  } else {
    // Outside 12-month window — full rebuild fee applies
    const buildPayLink = buildPayFastLink(tier.build, 'Website Hub Rebuild', airtableId, env);
    await sendWhatsApp(f['WhatsApp'],
      `Welcome back, ${name}! 👋\n\nIt's been a while — we'd love to rebuild your site.\n\n💳 Rebuild fee: R${tier.build}: ${buildPayLink}\n\nOnce paid your site gets rebuilt and goes live same day.\n\n— Website Hub`,
      env
    );
  }

  await logActivity(env, 'reactivation_initiated', { airtableId, business: f['Business Name'], withinWindow });
  return htmlResponse(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome Back</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:400px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6}</style></head><body><div class="box"><div style="font-size:48px;margin-bottom:16px">🎉</div><h1>Welcome back!</h1><p>Check your WhatsApp — we've sent you everything you need to get back online.</p></div></body></html>`, 200);
}

// ============================================================
// ROUTE: /update-status
// ============================================================

async function handleUpdateStatus(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  const key = request.headers.get('x-admin-key');
  if (!key || key !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId, status, ...extra } = body;
  if (!airtableId || !status) return jsonResponse({ error: 'Missing airtableId or status' }, 400);

  await updateAirtableRecord(airtableId, { 'Status': status, ...extra }, env);
  return jsonResponse({ success: true });
}

// ============================================================
// ROUTE: /update-config
// Saves prospecting config and feature flags to KV.
// Called by admin dashboard circuit breaker toggles and prospecting engine.
// ============================================================

async function handleUpdateConfig(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  const key = request.headers.get('x-admin-key');
  if (!key || key !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  // Persist feature flags — accepts both field name formats
  const flagMap = {
    outbound_enabled:              'config:outbound_enabled',
    referral_enabled:              'config:referral_enabled',
    vision_enabled:                'config:vision_enabled',
    'flag:outbound_enabled':       'config:outbound_enabled',
    'flag:referral_enabled':       'config:referral_enabled',
    'flag:vision_enabled':         'config:vision_enabled',
    'flag:vision_validation_enabled': 'config:vision_enabled',
  };
  for (const [bodyKey, kvKey] of Object.entries(flagMap)) {
    if (body[bodyKey] !== undefined) {
      await env.SITES.put(kvKey, String(body[bodyKey]));
    }
  }

  // Merge prospecting config into single object the cron reads
  const existing = JSON.parse(await env.SITES.get('config:outbound').catch(() => null) || '{}');
  const merged = {
    daily_volume: body.daily_volume ?? body['config:daily_volume'] ?? existing.daily_volume ?? 10,
    mode:         body.mode         ?? body['config:mode']         ?? existing.mode         ?? 'manual',
    provinces:    body.provinces    ?? body['config:provinces']    ?? existing.provinces    ?? [],
    industries:   body.industries   ?? body['config:industries']   ?? existing.industries   ?? [],
  };

  if (merged.provinces && !Array.isArray(merged.provinces)) {
    merged.provinces = Object.entries(merged.provinces).filter(([,v]) => v === true).map(([k]) => k);
  }
  if (merged.industries && !Array.isArray(merged.industries)) {
    merged.industries = Object.entries(merged.industries).filter(([,v]) => v === true).map(([k]) => k);
  }

  await env.SITES.put('config:outbound', JSON.stringify(merged));
  await logActivity(env, 'config_updated', { merged });
  return jsonResponse({ success: true, config: merged });
}

// ============================================================
// ROUTE: /health — ENHANCE-03 service health status
// ============================================================

async function handleHealth(env) {
  const services = ['build', 'whatsapp', 'airtable', 'zoho', 'payfast', 'outbound'];
  const health   = {};

  for (const svc of services) {
    try {
      const raw = await env.SITES.get(`health:${svc}`);
      health[svc] = raw ? JSON.parse(raw) : { status: 'unknown' };
    } catch {
      health[svc] = { status: 'unknown' };
    }
  }

  return jsonResponse({ health, timestamp: new Date().toISOString() });
}

// ============================================================
// PURE JS MD5 — Web Crypto does not support MD5
// ============================================================

function md5(str) {
  function safeAdd(x, y) { const lsw=(x&0xFFFF)+(y&0xFFFF); return (((x>>16)+(y>>16)+(lsw>>16))<<16)|(lsw&0xFFFF); }
  function bitRotateLeft(num, cnt) { return (num<<cnt)|(num>>>(32-cnt)); }
  function md5cmn(q,a,b,x,s,t){return safeAdd(bitRotateLeft(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
  function md5ff(a,b,c,d,x,s,t){return md5cmn((b&c)|((~b)&d),a,b,x,s,t);}
  function md5gg(a,b,c,d,x,s,t){return md5cmn((b&d)|(c&(~d)),a,b,x,s,t);}
  function md5hh(a,b,c,d,x,s,t){return md5cmn(b^c^d,a,b,x,s,t);}
  function md5ii(a,b,c,d,x,s,t){return md5cmn(c^(b|(~d)),a,b,x,s,t);}
  const bytes = new TextEncoder().encode(str);
  const length8 = bytes.length;
  const length16 = (length8 + 72) >> 6;
  const words = new Int32Array(length16 << 4);
  for(let i=0;i<length8;i++) words[i>>2]|=bytes[i]<<((i%4)*8);
  words[length8>>2]|=0x80<<((length8%4)*8);
  words[(length16<<4)-2]=length8*8;
  let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
  for(let i=0;i<words.length;i+=16){
    const [oa,ob,oc,od]=[a,b,c,d];
    a=md5ff(a,b,c,d,words[i+0],7,-680876936);d=md5ff(d,a,b,c,words[i+1],12,-389564586);c=md5ff(c,d,a,b,words[i+2],17,606105819);b=md5ff(b,c,d,a,words[i+3],22,-1044525330);
    a=md5ff(a,b,c,d,words[i+4],7,-176418897);d=md5ff(d,a,b,c,words[i+5],12,1200080426);c=md5ff(c,d,a,b,words[i+6],17,-1473231341);b=md5ff(b,c,d,a,words[i+7],22,-45705983);
    a=md5ff(a,b,c,d,words[i+8],7,1770035416);d=md5ff(d,a,b,c,words[i+9],12,-1958414417);c=md5ff(c,d,a,b,words[i+10],17,-42063);b=md5ff(b,c,d,a,words[i+11],22,-1990404162);
    a=md5ff(a,b,c,d,words[i+12],7,1804603682);d=md5ff(d,a,b,c,words[i+13],12,-40341101);c=md5ff(c,d,a,b,words[i+14],17,-1502002290);b=md5ff(b,c,d,a,words[i+15],22,1236535329);
    a=md5gg(a,b,c,d,words[i+1],5,-165796510);d=md5gg(d,a,b,c,words[i+6],9,-1069501632);c=md5gg(c,d,a,b,words[i+11],14,643717713);b=md5gg(b,c,d,a,words[i+0],20,-373897302);
    a=md5gg(a,b,c,d,words[i+5],5,-701558691);d=md5gg(d,a,b,c,words[i+10],9,38016083);c=md5gg(c,d,a,b,words[i+15],14,-660478335);b=md5gg(b,c,d,a,words[i+4],20,-405537848);
    a=md5gg(a,b,c,d,words[i+9],5,568446438);d=md5gg(d,a,b,c,words[i+14],9,-1019803690);c=md5gg(c,d,a,b,words[i+3],14,-187363961);b=md5gg(b,c,d,a,words[i+8],20,1163531501);
    a=md5gg(a,b,c,d,words[i+13],5,-1444681467);d=md5gg(d,a,b,c,words[i+2],9,-51403784);c=md5gg(c,d,a,b,words[i+7],14,1735328473);b=md5gg(b,c,d,a,words[i+12],20,-1926607734);
    a=md5hh(a,b,c,d,words[i+5],4,-378558);d=md5hh(d,a,b,c,words[i+8],11,-2022574463);c=md5hh(c,d,a,b,words[i+11],16,1839030562);b=md5hh(b,c,d,a,words[i+14],23,-35309556);
    a=md5hh(a,b,c,d,words[i+1],4,-1530992060);d=md5hh(d,a,b,c,words[i+4],11,1272893353);c=md5hh(c,d,a,b,words[i+7],16,-155497632);b=md5hh(b,c,d,a,words[i+10],23,-1094730640);
    a=md5hh(a,b,c,d,words[i+13],4,681279174);d=md5hh(d,a,b,c,words[i+0],11,-358537222);c=md5hh(c,d,a,b,words[i+3],16,-722521979);b=md5hh(b,c,d,a,words[i+6],23,76029189);
    a=md5hh(a,b,c,d,words[i+9],4,-640364487);d=md5hh(d,a,b,c,words[i+12],11,-421815835);c=md5hh(c,d,a,b,words[i+15],16,530742520);b=md5hh(b,c,d,a,words[i+2],23,-995338651);
    a=md5ii(a,b,c,d,words[i+0],6,-198630844);d=md5ii(d,a,b,c,words[i+7],10,1126891415);c=md5ii(c,d,a,b,words[i+14],15,-1416354905);b=md5ii(b,c,d,a,words[i+5],21,-57434055);
    a=md5ii(a,b,c,d,words[i+12],6,1700485571);d=md5ii(d,a,b,c,words[i+3],10,-1894986606);c=md5ii(c,d,a,b,words[i+10],15,-1051523);b=md5ii(b,c,d,a,words[i+1],21,-2054922799);
    a=md5ii(a,b,c,d,words[i+8],6,1873313359);d=md5ii(d,a,b,c,words[i+15],10,-30611744);c=md5ii(c,d,a,b,words[i+6],15,-1560198380);b=md5ii(b,c,d,a,words[i+13],21,1309151649);
    a=md5ii(a,b,c,d,words[i+4],6,-145523070);d=md5ii(d,a,b,c,words[i+11],10,-1120210379);c=md5ii(c,d,a,b,words[i+2],15,718787259);b=md5ii(b,c,d,a,words[i+9],21,-343485551);
    a=safeAdd(a,oa);b=safeAdd(b,ob);c=safeAdd(c,oc);d=safeAdd(d,od);
  }
  return [a,b,c,d].map(n=>Array.from({length:4},(_,i)=>((n>>(i*8))&0xFF).toString(16).padStart(2,'0')).join('')).join('');
}

// ============================================================
// ROUTE: /payfast-webhook — payment confirmation
// BF-02: Idempotency lock — double-fire protection
// ============================================================

async function handlePayfastWebhook(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let formData;
  try { formData = await request.formData(); }
  catch { return new Response('Invalid form data', { status: 400 }); }

  const params = {};
  for (const [key, value] of formData.entries()) params[key] = value;

  const signature = params['signature'];
  delete params['signature'];

  const paramString = Object.keys(params).sort()
    .map(k => `${k}=${encodeURIComponent(params[k]).replace(/%20/g, '+')}`)
    .join('&') + `&passphrase=${encodeURIComponent(env.PAYFAST_MERCHANT_KEY || '')}`;

  const hash = md5(paramString);
  if (hash !== signature) {
    console.warn('PayFast signature mismatch');
    return new Response('Invalid signature', { status: 400 });
  }

  const paymentStatus = formData.get('payment_status');
  const airtableId    = formData.get('custom_str1');
  const paymentId     = formData.get('m_payment_id') || null;
  const amount        = parseFloat(formData.get('amount_gross') || '0');

  if (!airtableId) return new Response('Missing custom_str1', { status: 400 });

  if (paymentStatus === 'COMPLETE') {
    // BF-02: Idempotency lock — prevent double processing
    const lockKey = `payfast_lock:${paymentId || `${airtableId}:${amount}`}`;
    const alreadyProcessed = await env.SITES.get(lockKey);
    if (alreadyProcessed) {
      console.warn(`PayFast duplicate webhook ignored: ${paymentId}`);
      return new Response('OK', { status: 200 });
    }
    // Set lock for 24 hours
    await env.SITES.put(lockKey, new Date().toISOString(), { expirationTtl: 86400 });

    try {
      const record   = await getAirtableRecord(airtableId, env);
      const f        = record.fields;
      const tier     = getPricingTier(f['Package'] || 'Standard');
      const isDeposit = Math.abs(amount - tier.build) < 10;
      const isRetainer = Math.abs(amount - tier.retainer) < 10;
      const isUpgrade  = Math.abs(amount - PRICING.upgrade.delta) < 10;

      // DEPENDENCY-06: Upgrade payment — flip package, no rebuild
      if (isUpgrade && f['Status'] === 'Live') {
        await updateAirtableRecord(airtableId, { 'Package': 'Premium' }, env);
        const slug = f['Slug'] || slugify(f['Business Name']);

        // Queue a Premium rebuild of existing site
        const upgradedFields = { ...f, 'Package': 'Premium' };
        await updateAirtableRecord(airtableId, { 'Status': 'Building' }, env);
        await env.BUILD_QUEUE.send({ airtableId, paymentId, fields: upgradedFields, isOutbound: false });

        const name = f['Client Name']?.split(' ')[0] || 'there';
        await sendWhatsApp(f['WhatsApp'],
          `🎉 Upgrade confirmed, ${name}!\n\nOur team is rebuilding *${f['Business Name']}* with all Premium features. New preview coming in about 10 minutes.\n\n— Website Hub`,
          env
        );
        ctx.waitUntil(createZohoInvoice({
          clientName:  f['Client Name'],
          email:       f['Email'],
          amount:      PRICING.upgrade.delta,
          description: `${f['Business Name']} — Upgrade to Premium`,
          invoiceNum:  `WH-UPG-${Date.now()}`,
          markPaid:    true,
        }, env).catch(e => console.warn('Zoho upgrade invoice failed:', e)));

        await logActivity(env, 'upgrade_payment_received', { airtableId, business: f['Business Name'] });
        await logHealth(env, 'payfast', 'success');

      } else if (isDeposit && (f['Status'] === 'Lead' || f['Status'] === 'Deposit Paid' || f['Status'] === 'QA')) {
        // v6.0: Build already happened during PIN/verify flow.
        // Payment = go-live. Apply any stored panel choices then go live.
        await updateAirtableRecord(airtableId, {
          'Status':             'Deposit Paid',
          'PayFast Payment ID': paymentId || '',
          'Payment Date':       new Date().toISOString().split('T')[0],
        }, env);

        ctx.waitUntil(createZohoInvoice({
          clientName:  f['Client Name'],
          email:       f['Email'],
          amount:      tier.build,
          description: `${f['Business Name']} — ${f['Package']} Website Build`,
          invoiceNum:  `WH-BUILD-${Date.now()}`,
          markPaid:    true,
        }, env).catch(e => console.warn('Zoho build invoice failed:', e)));

        // DEPENDENCY-04: Process referral if present
        if (f['Referral Slug'] && env.REFERRAL_ENABLED === 'true') {
          ctx.waitUntil(processReferralCredit(f['Referral Slug'], f['Package'], env));
        }

        // Apply preview choices to draft and go live directly
        ctx.waitUntil((async () => {
          try {
            const slug    = f['Slug'] || slugify(f['Business Name']);
            const choices = JSON.parse(await env.SITES.get(`preview_choices:${slug}`).catch(() => '{}') || '{}');
            let   draft   = await env.SITES.get(`draft:${slug}`);

            if (!draft) {
              // Fallback: strip watermark from preview
              const preview = await env.SITES.get(`preview:${slug}`);
              if (preview) draft = removeWatermark(preview);
            }

            if (draft) {
              // Bake in palette / font choices via CSS variables if stored
              if (choices.palette) {
                draft = draft.replace(/<style/i, `<style>:root{--chosen-palette:${choices.palette};}</style>\n<style`);
              }
              // Logo swap
              if (choices.logo_url) {
                draft = draft.replace(/<img[^>]+id=["']site-logo["'][^>]*>/i,
                  `<img id="site-logo" src="${choices.logo_url}" alt="Logo" style="max-height:60px;">`);
              }
              await env.SITES.put(`draft:${slug}`, draft);

              // Apply same choices to all other per-page draft keys
              const choicePages = ['index', 'services', 'about', 'contact', 'gallery'];
              for (const pageName of choicePages) {
                let pageDraft = await env.SITES.get(`draft:${slug}:${pageName}`).catch(() => null);
                if (!pageDraft) continue;
                if (choices.palette) {
                  pageDraft = pageDraft.replace(/<style/i, `<style>:root{--chosen-palette:${choices.palette};}</style>\n<style`);
                }
                if (choices.logo_url) {
                  pageDraft = pageDraft.replace(/<img[^>]+id=["']site-logo["'][^>]*>/i,
                    `<img id="site-logo" src="${choices.logo_url}" alt="Logo" style="max-height:60px;">`);
                }
                await env.SITES.put(`draft:${slug}:${pageName}`, pageDraft);
              }
            }

            await handleGoLiveInternal(airtableId, env, { ...f, 'Status': 'Deposit Paid' });
          } catch (err) {
            console.error('Go-live after payment failed:', err);
            await sendWhatsApp(env.WH_PHONE,
              `❌ GO-LIVE FAILED after payment: ${f['Business Name']}\nError: ${err.message}\nAirtable: ${airtableId}`,
              env
            ).catch(() => {});
          }
        })());

        await logActivity(env, 'build_payment_received', { airtableId, business: f['Business Name'], amount });
        await logHealth(env, 'payfast', 'success');

      } else if (isRetainer && f['Status'] === 'Suspended') {
        // Retainer payment — auto reinstate
        ctx.waitUntil(handleGoLiveFromPayment(airtableId, env, f, false));

      } else if (f['Status'] === 'QA') {
        // Go-live payment
        ctx.waitUntil(handleGoLiveFromPayment(airtableId, env, f, true));
      }

    } catch (err) {
      console.error('PayFast webhook error:', err);
      await logHealth(env, 'payfast', 'error', err.message);
    }
  }

  return new Response('OK', { status: 200 });
}

// Helper for payment-triggered go-live vs reinstatement
async function handleGoLiveFromPayment(airtableId, env, f, isGoLive) {
  if (isGoLive) {
    await handleGoLiveInternal(airtableId, env, f);
  } else {
    // Reinstatement after suspension
    const slug   = f['Slug'] || slugify(f['Business Name']);
    const domain = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');
    await env.SITES.delete(`suspended:${domain}`);
    await updateAirtableRecord(airtableId, {
      'Status':            'Live',
      'Next Invoice Date': nextMonthDate(),
    }, env);
    const name = f['Client Name']?.split(' ')[0] || 'there';
    await sendWhatsApp(f['WhatsApp'],
      `✅ You're back! *${f['Business Name']}* is live again at https://${domain}\n\nThank you. — Website Hub`,
      env
    );
    await logActivity(env, 'site_reinstated', { airtableId, business: f['Business Name'] });
  }
}

// ============================================================
// ROUTE: /go-live — strip watermark → deploy → notify
// ENHANCE-26: Claude-written go-live WhatsApp
// ============================================================

async function handleGoLive(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  await handleGoLiveInternal(airtableId, env, record.fields);
  return jsonResponse({ success: true, domain: record.fields['Domain'] });
}

async function handleGoLiveInternal(airtableId, env, f) {
  const slug   = slugify(f['Business Name']);
  const domain = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  // Deploy all pages to live KV
  const isPremiumGoLive = (f['Package'] || '').toLowerCase() === 'premium';
  const goLivePages     = ['index', 'services', 'about', 'contact'];
  if (isPremiumGoLive) goLivePages.push('gallery');

  let homeHtml = null;

  for (const pageName of goLivePages) {
    // Prefer per-page draft key
    let pageHtml = await env.SITES.get(`draft:${slug}:${pageName}`);
    // Fall back to legacy draft key for index
    if (!pageHtml && pageName === 'index') pageHtml = await env.SITES.get(`draft:${slug}`);
    // Fall back to stripping watermark from preview
    if (!pageHtml) {
      const prev = await env.SITES.get(`preview:${slug}:${pageName}`);
      if (prev) pageHtml = removeWatermark(prev);
    }
    if (!pageHtml) { console.warn(`handleGoLiveInternal: no HTML for "${pageName}" of ${slug} — skipping`); continue; }

    pageHtml = addFooterCredit(pageHtml);
    await env.SITES.put(`live:${domain}:${pageName}`, pageHtml);
    if (pageName === 'index') homeHtml = pageHtml;
  }

  if (!homeHtml) throw new Error('No built site found in KV — trigger a rebuild first');

  // Backward-compat: live:{domain} always points to home
  await env.SITES.put(`live:${domain}`, homeHtml);

  const today       = new Date().toISOString().split('T')[0];
  const nextInvoice = nextMonthDate();
  const tier        = getPricingTier(f['Package'] || 'Standard');
  const name        = f['Client Name']?.split(' ')[0] || 'there';
  const slug_       = f['Slug'] || slug;
  const pkg         = (f['Package'] || 'Standard').toLowerCase();

  // v6.0: Generate manage token and store in KV
  const manageToken = crypto.randomUUID().replace(/-/g, '');
  await env.SITES.put(`manage_token:${manageToken}`, airtableId);
  await updateAirtableRecord(airtableId, { 'Manage Token': manageToken }, env).catch(() => {});
  const manageUrl = `https://${PREVIEW_DOMAIN}/manage/${manageToken}`;

  await updateAirtableRecord(airtableId, {
    'Status':                  'Live',
    'Go Live Date':            today,
    'Monthly Retainer Active': true,
    'Next Invoice Date':       nextInvoice,
  }, env);

  // Zoho retainer invoice
  createZohoInvoice({
    clientName:  f['Client Name'],
    email:       f['Email'],
    amount:      tier.retainer,
    description: `${f['Business Name']} — Monthly Website Subscription (due ${nextInvoice})`,
    invoiceNum:  `WH-RET-${Date.now()}`,
    markPaid:    false,
    payLink:     buildPayFastLink(tier.retainer, 'Website Hub Monthly Subscription', airtableId, env),
  }, env).catch(e => console.warn('Zoho retainer invoice failed:', e));

  // v6.0: Domain registration via proxy → registerdomain.co.za API
  if (env.OUTBOUND_ENABLED === 'true' || f['Source'] !== 'Scrape') {
    registerDomainViaProxy(slug, env).catch(e => {
      console.warn('Domain registration failed (non-fatal):', e);
      sendWhatsApp(env.WH_PHONE, `⚠️ Domain reg failed for ${domain}: ${e.message}`, env).catch(() => {});
    });
  }

  // ENHANCE-26: Claude-written go-live message, personal per client
  const referralLink = env.REFERRAL_ENABLED === 'true' ? `https://websitehub.co.za?ref=${slug_}` : null;

  let goLiveMsg;
  try {
    const isPremium = pkg === 'premium';
    const prompt = `Write a go-live WhatsApp message for a South African small business owner. This is a big moment — their website just went live.

Client first name: ${name}
Business name: ${f['Business Name']}
Industry: ${f['Industry'] || 'small business'}
Area: ${f['Area'] || 'South Africa'}
Live URL: https://${domain}
Monthly subscription: R${tier.retainer}
Next invoice date: ${nextInvoice}
${isPremium && referralLink ? `Referral link: ${referralLink}\nReferral benefit: One referral = one free month` : ''}
Email for photos: updates@websitehub.co.za (subject: wh-${slug_})
Manage panel link: ${manageUrl}

Requirements:
- Open with the emotional moment — their site is LIVE
- Include the live URL
- Mention the monthly subscription and next invoice date naturally
- Mention adding photos via email (for Premium especially)
${isPremium && referralLink ? `- Include the referral link at peak excitement — right now is the best moment. Frame it: one referral = one free month.` : ''}
- Include the manage panel link so they can request changes: "${manageUrl}"
- Sign off: "— Pierre, Website Hub 🚀"
- Max 200 words. Warm and personal. SA tone.

Write only the message. No labels.`;

    goLiveMsg = await callClaudeInternal(
      'You write warm, personal, celebratory go-live messages for South African small business owners. Human tone. This is their big moment.',
      [{ role: 'user', content: prompt }],
      env
    );
  } catch (e) {
    // Fallback
    goLiveMsg = `🎉 *${f['Business Name']}* is LIVE, ${name}!\n\nTold you. 10 minutes. ⚡\n\n🌐 https://${domain}\n\nShare this with your customers — it's yours now.\n\nYour subscription of *R${tier.retainer}/month* starts today. We'll send a WhatsApp with a payment link when it's due (${nextInvoice}).\n\n📸 Add photos anytime: email updates@websitehub.co.za\nSubject: wh-${slug_}\n\n🛠 Manage your site anytime:\n${manageUrl}\n\n${referralLink ? `👥 One referral = one free month:\n${referralLink}\n\n` : ''}- Pierre, Website Hub 🚀`;
  }

  await sendWhatsApp(f['WhatsApp'], goLiveMsg.trim(), env);

  // Schedule post go-live sequence — ENHANCE-27
  const day1Date = new Date(Date.now() + 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const day7Date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  await env.SITES.put(`post_golive_d1:${airtableId}`, day1Date);
  await env.SITES.put(`post_golive_d7:${airtableId}`, day7Date);

  // Schedule day-30 upsell
  const upsellDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  await env.SITES.put(`upsell:${airtableId}`, upsellDate);

  // Schedule win-back (90 days — stored now, used only if cancelled)
  await env.SITES.put(`winback_eligible:${airtableId}`, new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]);

  await sendWhatsApp(env.WH_PHONE,
    `🚀 LIVE: ${f['Business Name']}\n🌐 https://${domain}\nRetainer: R${tier.retainer}/month\nNext invoice: ${nextInvoice}`,
    env
  );

  await logActivity(env, 'site_went_live', { airtableId, business: f['Business Name'], domain });
  await logHealth(env, 'build', 'success');
}

// ============================================================
// ROUTE: /suspend-site
// ============================================================

async function handleSuspendSite(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  const key = request.headers.get('x-admin-key');
  if (!key || key !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  const f      = record.fields;
  const domain = (f['Domain'] || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!domain) return jsonResponse({ error: 'No domain on record' }, 400);

  const tier    = getPricingTier(f['Package'] || 'Standard');
  const payLink = buildPayFastLink(tier.retainer, 'Website Hub Subscription Reinstatement', airtableId, env);

  await env.SITES.put(`suspended:${domain}`, '1');
  await updateAirtableRecord(airtableId, { 'Status': 'Suspended' }, env);

  await sendWhatsApp(
    f['WhatsApp'],
    `⚠️ Hi ${f['Client Name']?.split(' ')[0] || 'there'}, your *${f['Business Name']}* website has been temporarily suspended due to an outstanding payment of *R${tier.retainer}*.\n\nTap here to reinstate instantly:\n💳 ${payLink}\n\nYour site will be back online within minutes of payment.\n\nQuestions? Reply here.\n— Website Hub`,
    env
  );

  await logActivity(env, 'site_suspended', { airtableId, business: f['Business Name'], domain });
  return jsonResponse({ success: true, domain, status: 'suspended' });
}

// ============================================================
// ROUTE: /reinstate-site
// ============================================================

async function handleReinstateSite(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  const key = request.headers.get('x-admin-key');
  if (!key || key !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId } = body;
  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch (err) { return jsonResponse({ error: 'Client not found' }, 404); }

  const f      = record.fields;
  const domain = (f['Domain'] || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  await env.SITES.delete(`suspended:${domain}`);
  await updateAirtableRecord(airtableId, {
    'Status':            'Live',
    'Next Invoice Date': nextMonthDate(),
  }, env);

  await sendWhatsApp(
    f['WhatsApp'],
    `✅ You're back! *${f['Business Name']}* is live again at https://${domain}\n\nThank you for your payment.\n— Website Hub`,
    env
  );

  await logActivity(env, 'site_reinstated', { airtableId, business: f['Business Name'], domain });
  return jsonResponse({ success: true, domain, status: 'reinstated' });
}

// ============================================================
// ROUTE: /domain-check — checks availability via proxy
// GET ?name=blooming-florist
// Returns { domain, available, suggestions[] }
// ============================================================

async function handleDomainCheck(url, env) {
  const name = url.searchParams.get('name');
  if (!name) return jsonResponse({ error: 'Missing name parameter' }, 400);

  const sld = name.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/\.co\.za$/, '');
  if (!sld) return jsonResponse({ error: 'Invalid domain name' }, 400);

  const domain = `${sld}.co.za`;

  try {
    const data = await callDomainProxy('CheckAvailability', sld, 'co.za', {}, env);
    const available = data?.result === 'available' || data?.available === true
                   || data?.result === 'success'   || String(data?.result).includes('available');

    let suggestions = [];
    if (!available) {
      // Generate and check 3 alternative slugs
      const alts = [
        sld + '-sa',
        sld.replace(/-/g, '') ,           // remove hyphens
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
    // Fallback to WHOIS if proxy fails
    console.warn('Domain proxy failed, falling back to WHOIS:', e.message);
    const result = await checkDomainAvailabilityWhois(domain);
    return jsonResponse({ ...result, fallback: true });
  }
}

// WHOIS fallback — used if proxy is unreachable
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

// ============================================================
// ROUTE: /zoho-auth — one-time OAuth setup
// ============================================================

async function handleZohoAuth(url, env) {
  const code = url.searchParams.get('code');
  if (!code) {
    return new Response(`<html><body style="font-family:Arial;padding:40px">
      <h2>Zoho Auth Setup</h2>
      <p>Visit this URL first to get your auth code:</p>
      <pre style="background:#f5f5f5;padding:16px;border-radius:8px;word-break:break-all">https://accounts.zoho.com/oauth/v2/auth?scope=ZohoBooks.invoices.CREATE,ZohoBooks.contacts.CREATE,ZohoBooks.creditnotes.CREATE&client_id=${env.ZOHO_CLIENT_ID}&response_type=code&redirect_uri=https://${WORKER_DOMAIN}/zoho-auth&access_type=offline</pre>
      </body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  try {
    const res  = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code, client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET,
        redirect_uri: `https://${WORKER_DOMAIN}/zoho-auth`, grant_type: 'authorization_code',
      }),
    });
    const data = await res.json();
    if (data.refresh_token) {
      return new Response(`<html><body style="font-family:Arial;padding:40px"><h2>✅ Success!</h2><p>Add this as <code>ZOHO_REFRESH_TOKEN</code>:</p><pre style="background:#e8f5e9;padding:16px;border-radius:8px">${data.refresh_token}</pre></body></html>`,
        { headers: { 'Content-Type': 'text/html' } });
    }
    return new Response(`<html><body style="font-family:Arial;padding:40px"><h2>❌ Failed</h2><pre>${JSON.stringify(data, null, 2)}</pre></body></html>`,
      { headers: { 'Content-Type': 'text/html' } });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ============================================================
// ROUTE: /clients — admin dashboard
// BF-04: Admin key from env, runtime check
// ============================================================

async function handleListClients(request, env) {
  // BF-04: Runtime env check — not hardcoded
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  try {
    const records = await listAirtableRecords('', env);

    // Health status for dashboard
    const allServices = [
      'build', 'whatsapp', 'airtable', 'zoho', 'payfast', 'outbound', 'unsplash',
      'twilio', 'anthropic', 'google', 'worker1', 'r2',
    ];
    const health = {};
    for (const svc of allServices) {
      try {
        const raw = await env.SITES.get(`health:${svc}`);
        health[svc] = raw ? JSON.parse(raw) : { status: 'unknown' };
      } catch { health[svc] = { status: 'unknown' }; }
    }

    // v6.0: Last outbound run for prospecting tab
    const today    = new Date().toISOString().split('T')[0];
    const runRaw   = await env.SITES.get(`outbound_run:${today}`).catch(() => null);
    const outbound_run = runRaw ? JSON.parse(runRaw) : null;

    return jsonResponse({ clients: records, health, outbound_run });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ============================================================
// DAILY CRON — 11pm SAST (9pm UTC)
// Retainer management, lifecycle messages, outbound processing
// ENHANCE-18: All client messages respect send window
// ENHANCE-24: Cron processes at night, delivery held for morning
// ============================================================

async function runDailyCron(env) {
  const now     = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // Drain any queued messages that are now in the send window
  // (orphaned function fix — DEPENDENCY-01 from spec)
  try { await processMessageQueue(env); } catch (e) { console.warn('processMessageQueue failed:', e); }

  // ── Retainer management ──────────────────────────────────
  let records;
  try {
    records = await listAirtableRecords(`AND({Monthly Retainer Active} = TRUE(), {Status} = "Live")`, env);
  } catch (e) {
    console.error('Cron: Airtable list failed:', e);
    await logActivity(env, 'cron_error', { error: e.message });
    return;
  }

  for (const record of records) {
    const f          = record.fields;
    const airtableId = record.id;
    const nextInvoice = f['Next Invoice Date'] ? new Date(f['Next Invoice Date']) : null;
    if (!nextInvoice) continue;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daysOverdue = Math.floor((today - nextInvoice) / (1000 * 60 * 60 * 24));
    const name        = f['Client Name']?.split(' ')[0] || 'there';
    const biz         = f['Business Name'] || 'your site';
    const domain      = (f['Domain'] || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const tier        = getPricingTier(f['Package'] || 'Standard');
    const pkg         = (f['Package'] || 'Standard').toLowerCase();
    const payLink     = buildPayFastLink(tier.retainer, 'Website Hub Monthly Subscription', airtableId, env);
    const slug        = f['Slug'] || slugify(f['Business Name']);

    if (daysOverdue === 0) {
      let invoiceUrl = '';
      try {
        const inv = await createZohoInvoice({
          clientName:  f['Client Name'],
          email:       f['Email'],
          amount:      tier.retainer,
          description: `${biz} — Monthly Website Subscription`,
          invoiceNum:  `WH-RET-${Date.now()}`,
          markPaid:    false,
          payLink,
        }, env);
        invoiceUrl = inv?.web_url ? `\n📄 Invoice: ${inv.web_url}` : '';
      } catch (e) { console.warn('Zoho invoice failed:', e); }

      // ENHANCE-18: Queue for 9am–12pm SAST send window (retainer: time-gated, any day)
      await queueScheduledMessage(airtableId, f['WhatsApp'],
        `Hi ${name} 👋 Your monthly Website Hub subscription of *R${tier.retainer}* is due today.${invoiceUrl}\n\n💳 Pay here: ${payLink}\n\nThank you!\n— Website Hub`,
        env, { respectDayOfWeek: false }
      );

    } else if (daysOverdue === 7) {
      await queueScheduledMessage(airtableId, f['WhatsApp'],
        `Hi ${name}, your Website Hub subscription of *R${tier.retainer}* for *${biz}* is 7 days overdue.\n\n💳 Pay here: ${payLink}\n\nPlease pay to avoid any interruption.\n— Website Hub`,
        env, { respectDayOfWeek: false }
      );

    } else if (daysOverdue === 14) {
      const referralLink = env.REFERRAL_ENABLED === 'true' && pkg === 'premium'
        ? `\n\n💡 Or send one referral to cover this month: https://websitehub.co.za?ref=${slug}`
        : '';

      await queueScheduledMessage(airtableId, f['WhatsApp'],
        `⚠️ Hi ${name}, your subscription for *${biz}* is 14 days overdue (R${tier.retainer}).\n\n*Your site will be suspended in 48 hours* if payment is not received.\n\n💳 Pay now: ${payLink}${referralLink}\n\n${pkg === 'standard' ? 'Reply *HELP* if you need assistance.\n\n' : ''}- Website Hub`,
        env, { respectDayOfWeek: false }
      );

      await sendWhatsApp(env.WH_PHONE,
        `⚠️ OVERDUE 14 days: ${biz} — R${tier.retainer}\nAirtable: ${airtableId}`, env
      );

    } else if (daysOverdue === 16) {
      // ENHANCE-29: Check if first-time Standard client — hold 72 hours
      const graceUsed    = await env.SITES.get(`grace_used:${airtableId}`);
      const isPremium    = pkg === 'premium';
      const isFirstLate  = !graceUsed && !isPremium;

      if (isFirstLate) {
        // 72-hour hold — send HELP offer instead
        await env.SITES.put(`grace_pending:${airtableId}`, new Date().toISOString(), { expirationTtl: 60 * 60 * 72 });
        await queueScheduledMessage(airtableId, f['WhatsApp'],
          `⚠️ Hi ${name}, *${biz}* is due for suspension.\n\nBefore we suspend — reply *HELP* and we'll sort something out.\n\nOr pay here: ${payLink}\n\n— Website Hub`,
          env, { respectDayOfWeek: false }
        );
      } else {
        // Normal suspension
        if (domain) await env.SITES.put(`suspended:${domain}`, '1');
        await updateAirtableRecord(airtableId, { 'Status': 'Suspended' }, env);

        await queueScheduledMessage(airtableId, f['WhatsApp'],
          `🚫 Hi ${name}, *${biz}* has been suspended due to non-payment of R${tier.retainer}.\n\nTap here to reinstate instantly:\n💳 ${payLink}\n\n— Website Hub`,
          env, { respectDayOfWeek: false }
        );
        await sendWhatsApp(env.WH_PHONE,
          `🚫 SUSPENDED: ${biz} — ${domain}\nR${tier.retainer} overdue ${daysOverdue} days.`, env
        );
      }
    } else if (daysOverdue === 19) {
      // 72-hour grace expired — suspend for real
      const gracePending = await env.SITES.get(`grace_pending:${airtableId}`);
      if (gracePending) {
        await env.SITES.delete(`grace_pending:${airtableId}`);
        if (domain) await env.SITES.put(`suspended:${domain}`, '1');
        await updateAirtableRecord(airtableId, { 'Status': 'Suspended' }, env);
        await sendWhatsApp(env.WH_PHONE, `🚫 SUSPENDED (post-grace): ${biz}`, env);
      }
    }
  }

  // ── Post go-live sequence — ENHANCE-27 ──────────────────
  try {
    const d1Keys = await env.SITES.list({ prefix: 'post_golive_d1:' });
    for (const key of d1Keys.keys) {
      const date = await env.SITES.get(key.name);
      if (date === todayStr) {
        const airtableId = key.name.replace('post_golive_d1:', '');
        const rec = await getAirtableRecord(airtableId, env).catch(() => null);
        if (!rec) continue;
        const f    = rec.fields;
        const name = f['Client Name']?.split(' ')[0] || 'there';
        await queueScheduledMessage(airtableId, f['WhatsApp'],
          `Hi ${name} 👋 Quick tip for day one — share your website link in your WhatsApp status today. That single thing can bring in your first enquiry.\n\n🌐 https://${(f['Domain'] || '').replace(/^https?:\/\//, '')}\n\n— Website Hub`,
          env, { respectDayOfWeek: true }
        );
        await env.SITES.delete(key.name);
      }
    }
  } catch (e) { console.warn('Post go-live D1 cron failed:', e); }

  try {
    const d7Keys = await env.SITES.list({ prefix: 'post_golive_d7:' });
    for (const key of d7Keys.keys) {
      const date = await env.SITES.get(key.name);
      if (date === todayStr) {
        const airtableId = key.name.replace('post_golive_d7:', '');
        const rec = await getAirtableRecord(airtableId, env).catch(() => null);
        if (!rec) continue;
        const f    = rec.fields;
        const name = f['Client Name']?.split(' ')[0] || 'there';
        const pkg  = (f['Package'] || 'Standard').toLowerCase();
        const slug = f['Slug'] || slugify(f['Business Name']);
        const used = parseInt(await env.SITES.get(`revisions:${airtableId}:${todayStr.slice(0, 7)}`).catch(() => '0') || '0');
        const limit = pkg === 'premium' ? '∞' : '2';
        await queueScheduledMessage(airtableId, f['WhatsApp'],
          `Hi ${name} — how's the first week been? 👊\n\nHope the site's bringing in enquiries. Don't forget — you can request changes anytime by replying here.\n\n_Revisions this month: ${used === Infinity ? '0' : used}/${limit}_\n\n— Website Hub`,
          env, { respectDayOfWeek: true }
        );
        await env.SITES.delete(key.name);
      }
    }
  } catch (e) { console.warn('Post go-live D7 cron failed:', e); }

  // ── ENHANCE-19: Prospect limbo follow-up ────────────────
  try {
    const prospectKeys = await env.SITES.list({ prefix: 'prospect_state:' });
    for (const key of prospectKeys.keys) {
      const stateStr = await env.SITES.get(key.name);
      if (!stateStr) continue;
      const state = JSON.parse(stateStr);
      if (state.phase === 'converted') continue;

      const sentAt   = new Date(state.sentAt);
      const daysSince = Math.floor((Date.now() - sentAt.getTime()) / (1000 * 60 * 60 * 24));
      const phone    = key.name.replace('prospect_state:', '');
      const slug     = state.slug;
      const previewUrl = `https://${PREVIEW_DOMAIN}/${slug}`;

      if (daysSince === 3 && state.phase === 'sent') {
        // Day 3: soft reminder — no pitch, just the link
        await queueScheduledMessage(state.airtableId, phone,
          `Hi 👋 Just leaving your free preview up in case you missed it:\n\n${previewUrl}\n\nNo pressure at all.\n\n_Reply STOP to opt out._`,
          env, { respectDayOfWeek: true }
        );
        state.phase = 'd3_sent';
        await env.SITES.put(key.name, JSON.stringify(state));

      } else if (daysSince === 7 && state.phase === 'd3_sent') {
        // Day 7: final touch with soft expiry framing
        await queueScheduledMessage(state.airtableId, phone,
          `Hi — last message from us on this one 👋\n\nYour free preview is still live: ${previewUrl}\n\nWe'll take it down in a few days. No rush, no pressure — just didn't want you to miss it.\n\n_Reply STOP to opt out._`,
          env, { respectDayOfWeek: true }
        );
        state.phase = 'd7_sent';
        await env.SITES.put(key.name, JSON.stringify(state));

      } else if (daysSince > 7 && state.phase === 'd7_sent') {
        // Close the prospect — 60-day cooldown
        await env.SITES.put(`prospect_closed:${phone}`, new Date().toISOString());
        state.phase = 'closed';
        await env.SITES.put(key.name, JSON.stringify(state));
      }
    }
  } catch (e) { console.warn('Prospect follow-up cron failed:', e); }

  // ── ENHANCE-20: Expire old previews ─────────────────────
  try {
    const expiryKeys = await env.SITES.list({ prefix: 'preview_expiry:' });
    for (const key of expiryKeys.keys) {
      const expiryStr = await env.SITES.get(key.name);
      if (!expiryStr) continue;
      if (new Date(expiryStr) < new Date()) {
        const slug = key.name.replace('preview_expiry:', '');
        await env.SITES.put(`portfolio_candidate:${slug}`, expiryStr);
        await env.SITES.delete(`preview:${slug}`);
        await env.SITES.delete(key.name);
      }
    }
  } catch (e) { console.warn('Preview expiry cron failed:', e); }

  // ── Day-30 upsell messages ───────────────────────────────
  try {
    const allLive = await listAirtableRecords(`{Status} = "Live"`, env);
    for (const record of allLive) {
      const airtableId = record.id;
      const upsellDate = await env.SITES.get(`upsell:${airtableId}`);
      if (upsellDate && upsellDate === todayStr) {
        const f   = record.fields;
        const pkg = (f['Package'] || 'Standard').toLowerCase();
        await env.SITES.delete(`upsell:${airtableId}`);

        if (pkg === 'standard') {
          const upgradeLink = `https://${WORKER_DOMAIN}/upgrade-to-premium`;
          const name = f['Client Name']?.split(' ')[0] || 'there';
          await queueScheduledMessage(airtableId, f['WhatsApp'],
            `Hi ${name} 👋 Your *${f['Business Name']}* website has been live for a month — hope it's working hard for you!\n\nWant to take it further? Upgrade to Premium and get:\n• Testimonials section\n• Gallery (add photos by email anytime)\n• Full SEO setup\n• Unlimited revisions\n• Referral programme — one referral = one free month\n\nUpgrade: just *R250 extra* (your R449/month stays the same).\n\n👉 ${upgradeLink}?airtableId=${airtableId}\n\n— Pierre, Website Hub`,
            env, { respectDayOfWeek: true }
          );
        }
      }
    }
  } catch (e) { console.warn('Day-30 upsell cron failed:', e); }

  // ── Monthly value reports ────────────────────────────────
  try {
    const liveClients = await listAirtableRecords(`{Status} = "Live"`, env);
    for (const record of liveClients) {
      const f             = record.fields;
      const lastReportStr = f['Monthly Report Sent'];
      if (!lastReportStr) continue;

      const lastReport = new Date(lastReportStr);
      const today      = new Date();
      today.setHours(0, 0, 0, 0);
      const daysSince  = Math.floor((today - lastReport) / (1000 * 60 * 60 * 24));
      if (daysSince < 30) continue;

      await sendMonthlyValueReport(record.id, f, env);
    }
  } catch (e) { console.warn('Monthly report cron failed:', e); }

  // ── Win-back touches — ENHANCE-32 ───────────────────────
  try {
    const cancelledKeys = await env.SITES.list({ prefix: 'cancelled:' });
    for (const key of cancelledKeys.keys) {
      const cancelledAt = await env.SITES.get(key.name);
      if (!cancelledAt) continue;
      const daysSince = Math.floor((Date.now() - new Date(cancelledAt).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince !== 90) continue;

      const airtableId = key.name.replace('cancelled:', '');
      const alreadySent = await env.SITES.get(`winback_sent:${airtableId}`);
      if (alreadySent) continue;

      const rec = await getAirtableRecord(airtableId, env).catch(() => null);
      if (!rec) continue;

      const f    = rec.fields;
      const name = f['Client Name']?.split(' ')[0] || 'there';
      const reactivateLink = `https://${WORKER_DOMAIN}/reactivate-site?airtableId=${airtableId}`;

      await queueScheduledMessage(airtableId, f['WhatsApp'],
        `Hi ${name} — Pierre here from Website Hub. 👋\n\nJust checking in — hope business is going well.\n\nIf you ever want to get your website back up, it's easy:\n${reactivateLink}\n\nNo rebuild fee if you come back within a year. Just your normal subscription.\n\nTake care.\n— Pierre, Website Hub`,
        env, { respectDayOfWeek: true }
      );
      await env.SITES.put(`winback_sent:${airtableId}`, new Date().toISOString());
    }
  } catch (e) { console.warn('Win-back cron failed:', e); }

  // ── Cancellation defaults — 7 days no reply → archive ───
  try {
    const cancelPendingKeys = await env.SITES.list({ prefix: 'cancel_pending:' });
    for (const key of cancelPendingKeys.keys) {
      const archiveDateStr = await env.SITES.get(key.name);
      if (!archiveDateStr) continue;
      if (new Date(archiveDateStr) < new Date()) {
        const airtableId = key.name.replace('cancel_pending:', '');
        // Default to archive silently
        await handleCancelSite(new Request('https://x', {
          method: 'POST',
          body: JSON.stringify({ airtableId, option: 'ARCHIVE' }),
          headers: { 'Content-Type': 'application/json' },
        }), env, {});
        await env.SITES.delete(key.name);
      }
    }
  } catch (e) { console.warn('Cancellation default cron failed:', e); }

  // ── Outbound cron — ENHANCE-22 to ENHANCE-25 ────────────
  const outboundEnabled = await getFlag(env, 'OUTBOUND_ENABLED');
  if (outboundEnabled) {
    try {
      await runOutboundCron(env, todayStr);
    } catch (e) {
      console.warn('Outbound cron failed:', e);
      await logActivity(env, 'outbound_cron_error', { error: e.message });
    }
  }

  await logActivity(env, 'cron_completed', { date: todayStr });
}

// ============================================================
// OUTBOUND CRON ENGINE — ENHANCE-22 to 25
// Processes at 11pm SAST, delivers in morning window
// ============================================================

async function runOutboundCron(env, todayStr) {
  // Read config from KV — DEPENDENCY-10
  const configStr = await env.SITES.get('config:outbound').catch(() => null);
  const config    = configStr ? JSON.parse(configStr) : {};

  const dailyVolume  = parseInt(config.daily_volume || '10');
  const provinces    = config.provinces || [];
  const industries   = config.industries || [];
  const mode         = config.mode || 'manual'; // 'manual' or 'auto'

  if (provinces.length === 0 || industries.length === 0) {
    await logActivity(env, 'outbound_skipped', { reason: 'No provinces or industries configured' });
    return;
  }

  // Pick a random province + industry combo for tonight
  const province = provinces[Math.floor(Math.random() * provinces.length)];
  const industry = industries[Math.floor(Math.random() * industries.length)];

  // Fetch prospects from Google Places
  let prospects = [];
  try {
    prospects = await fetchGooglePlacesProspects(province, industry, dailyVolume, env);
  } catch (e) {
    await logActivity(env, 'outbound_places_error', { error: e.message });
    return;
  }

  let found = 0, queued = 0, skipped = 0, failed = 0;

  for (const prospect of prospects) {
    found++;
    const phone = prospect.phone;
    if (!phone) { skipped++; continue; }

    const clean = phone.replace(/\D/g, '');
    const intl  = clean.startsWith('27') ? clean : clean.replace(/^0/, '27');

    // Check opt-out and cooldown and dedup
    const optedOut  = await env.SITES.get(`optout:${intl}`).catch(() => null);
    const cooldown  = await env.SITES.get(`prospect_closed:${intl}`).catch(() => null);
    const slug      = slugify(prospect.name);
    const existing  = await env.SITES.get(`outbound:${slug}`).catch(() => null);

    if (optedOut || existing) { skipped++; continue; }
    if (cooldown) {
      const daysSince = Math.floor((Date.now() - new Date(cooldown).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince < 60) { skipped++; continue; }
    }

    try {
      if (mode === 'auto') {
        // v7: Opt-in FIRST — never build cold. Send template, build only on name reply.
        const prospectFields = {
          'Business Name':   prospect.name,
          'WhatsApp':        intl,
          'Industry':        industry,
          'Area':            prospect.area || province,
          'About':           prospect.about || '',
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
        try {
          prospectRecord = await createAirtableRecord(prospectFields, env);
        } catch (e) {
          console.warn(`Airtable record creation failed for ${prospect.name}:`, e);
          failed++;
          continue;
        }

        // Store scraped data in KV — retrieved when they reply with their name
        await env.SITES.put(`prospect:${intl}`, JSON.stringify({
          airtableId: prospectRecord.id,
          fields:     prospectFields,
          slug,
          createdAt:  new Date().toISOString(),
        }), { expirationTtl: 60 * 60 * 24 * 30 }); // 30-day TTL

        // Mark as contacted for dedup
        await env.SITES.put(`outbound:${slug}`, prospectRecord.id);

        // Store prospect state for Day 3 / Day 7 follow-ups
        await env.SITES.put(`prospect_state:${intl}`, JSON.stringify({
          airtableId: prospectRecord.id,
          slug,
          sentAt: new Date().toISOString(),
          phase: 'sent',
        }));

        // Set state to PROSPECT for state machine
        await env.SITES.put(`state:${intl}`, JSON.stringify({
          state:      'PROSPECT',
          airtableId: prospectRecord.id,
          slug,
          updatedAt:  new Date().toISOString(),
        }));

        // Send opt-in template — MUST be Meta-approved before going live
        // Template: "Hi [Business Name] 👋 Reply with your first name to see your free website preview."
        await queueScheduledMessage(prospectRecord.id, intl,
          `Hi *${prospect.name}* 👋\n\nWe build free website previews for SA businesses — no payment needed to see yours.\n\nReply with your *first name* and we'll build it now.\n\n_Reply STOP to opt out._`,
          env, { respectDayOfWeek: false }
        );
        queued++;
      } else {
        // Manual mode: log to KV for admin approval
        await env.SITES.put(`outbound_pending:${slug}`, JSON.stringify({
          name:      prospect.name,
          phone:     intl,
          industry,
          area:      prospect.area || province,
          about:     prospect.about || '',
          services:  prospect.services || '',
          timestamp: new Date().toISOString(),
        }));
        queued++; // queued for review
      }
    } catch (e) {
      failed++;
    }
  }

  // ENHANCE-25: Log this run
  const runLog = { date: todayStr, province, industry, found, queued, skipped, failed, mode };
  await env.SITES.put(`outbound_run:${todayStr}`, JSON.stringify(runLog), { expirationTtl: 60 * 60 * 24 * 30 });
  await logActivity(env, 'outbound_run_complete', runLog);
}

async function fetchGooglePlacesProspects(province, industry, limit, env) {
  if (!env.GOOGLE_PLACES_API_KEY) return [];

  const query    = `${industry} in ${province}, South Africa`;
  const url      = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${env.GOOGLE_PLACES_API_KEY}`;
  const res      = await fetch(url);
  const data     = await res.json();
  const results  = (data.results || []).slice(0, limit);

  const prospects = [];
  for (const place of results) {
    // Get phone number via Place Details
    let phone = null, website = null;
    try {
      const detailUrl  = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${place.place_id}&fields=formatted_phone_number,website,name,vicinity&key=${env.GOOGLE_PLACES_API_KEY}`;
      const detailRes  = await fetch(detailUrl);
      const detailData = await detailRes.json();
      phone   = detailData.result?.formatted_phone_number;
      website = detailData.result?.website;
    } catch { /* skip */ }

    // Skip if they already have a decent website
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
// SEND WINDOW ENFORCEMENT — ENHANCE-18
// 9am–12pm SAST, Tue–Thu (respectDayOfWeek=true)
// Or just 9am–12pm SAST any day (respectDayOfWeek=false)
// If outside window: queue message for next valid slot
// ============================================================

async function queueScheduledMessage(airtableId, phone, message, env, options = {}) {
  const { respectDayOfWeek = true } = options;

  const nowSAST  = new Date(Date.now() + SAST_OFFSET_MS);
  const hour     = nowSAST.getUTCHours();
  const day      = nowSAST.getUTCDay(); // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

  const inTimeWindow = hour >= 9 && hour < 12;
  const validDays    = [2, 3, 4]; // Tue, Wed, Thu
  const inValidDay   = validDays.includes(day);

  const canSendNow = inTimeWindow && (!respectDayOfWeek || inValidDay);

  if (canSendNow) {
    await sendWhatsApp(phone, message, env);
    await logHealth(env, 'whatsapp', 'success');
  } else {
    // Queue for next valid window — store in KV
    const queueKey = `msg_queue:${Date.now()}:${phone.slice(-6)}`;
    await env.SITES.put(queueKey, JSON.stringify({
      airtableId, phone, message, respectDayOfWeek,
      queuedAt: new Date().toISOString(),
    }), { expirationTtl: 60 * 60 * 24 * 7 }); // expire after 7 days
  }
}

// Message queue processor — runs in cron, sends queued messages in window
async function processMessageQueue(env) {
  const nowSAST  = new Date(Date.now() + SAST_OFFSET_MS);
  const hour     = nowSAST.getUTCHours();
  const day      = nowSAST.getUTCDay();
  const validDays = [2, 3, 4];

  if (hour < 9 || hour >= 12) return; // Not in window
  // Cron fires at 11pm — queue processor runs separately

  const [w1Keys, w2Keys] = await Promise.all([
    env.SITES.list({ prefix: 'msg_queue:' }).catch(() => ({ keys: [] })),
    env.SITES.list({ prefix: 'send_queue:' }).catch(() => ({ keys: [] })),
  ]);

  for (const key of [...w1Keys.keys, ...w2Keys.keys]) {
    try {
      const raw = await env.SITES.get(key.name);
      if (!raw) continue;
      const item = JSON.parse(raw);
      const respectDay = item.respectDayOfWeek !== undefined ? item.respectDayOfWeek : true;
      if (respectDay && !validDays.includes(day)) continue;
      const recipient = item.phone || item.to;
      if (!recipient) { await env.SITES.delete(key.name); continue; }
      await sendWhatsApp(recipient, item.message, env);
      await env.SITES.delete(key.name);
    } catch (e) { console.warn('Message queue item failed:', e); }
  }
}

// ============================================================
// MONTHLY VALUE REPORT — ENHANCE-16
// ============================================================

async function sendMonthlyValueReport(airtableId, f, env) {
  try {
    const name   = f['Client Name']?.split(' ')[0] || 'there';
    const domain = (f['Domain'] || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    const tier   = getPricingTier(f['Package'] || 'Standard');
    const slug   = f['Slug'] || slugify(f['Business Name']);
    const pkg    = (f['Package'] || 'Standard').toLowerCase();

    // Get visitor count for this month
    const monthStr   = new Date().toISOString().slice(0, 7);
    const visitKey   = `visits:${slug}:${monthStr}`;
    // Sum up daily counts for this month
    const visitKeys  = await env.SITES.list({ prefix: `visits:${slug}:${monthStr}` }).catch(() => ({ keys: [] }));
    let totalVisits  = 0;
    for (const vk of visitKeys.keys) {
      const v = await env.SITES.get(vk.name).catch(() => '0');
      totalVisits += parseInt(v || '0');
    }

    // Revision usage
    const revisionsKey = `revisions:${airtableId}:${monthStr}`;
    const usedStr      = await env.SITES.get(revisionsKey).catch(() => '0');
    const used         = parseInt(usedStr || '0');
    const limit        = pkg === 'premium' ? '∞' : '2';

    // Referral stats (if enabled)
    const referralCount = parseInt(await env.SITES.get(`referral_count:${airtableId}`).catch(() => '0') || '0');
    const creditMonths  = parseInt(await env.SITES.get(`referral_credits:${airtableId}`).catch(() => '0') || '0');

    const referralLink  = env.REFERRAL_ENABLED === 'true' ? `https://websitehub.co.za?ref=${slug}` : null;

    const reportPrompt = `Write a short WhatsApp monthly report for a South African small business owner. Max 150 words. Warm and personal. This is a partnership — not a bill.

Business: ${f['Business Name']}
Industry: ${f['Industry'] || 'small business'}
Domain: ${domain}
Package: ${f['Package']}
Estimated site visits this month: ${totalVisits || 'a number of'}
Revisions used: ${used}/${limit}
${referralCount > 0 ? `Referrals sent: ${referralCount} (${creditMonths} free month${creditMonths !== 1 ? 's' : ''} banked)` : ''}

The message must include:
1. Greeting with first name: ${name}
2. A quick month summary — their site is working
3. Visitor stat if available
4. One industry-specific insight or encouragement
5. Reminder: add photos by emailing updates@websitehub.co.za with subject wh-${slug}
6. Revisions remaining this month
${referralLink ? `7. Referral reminder — one referral = one free month: ${referralLink}` : ''}
7. Sign off: "— Pierre, Website Hub"

Write only the message. No labels.`;

    const report = await callClaudeInternal(
      'You write warm, personal monthly check-in messages for South African small business owners. Partnership tone. Human. Encouraging.',
      [{ role: 'user', content: reportPrompt }],
      env
    );

    await queueScheduledMessage(airtableId, f['WhatsApp'], report.trim(), env, { respectDayOfWeek: true });

    await updateAirtableRecord(airtableId, {
      'Monthly Report Sent': new Date().toISOString().split('T')[0],
    }, env);

    await logActivity(env, 'monthly_report_sent', { airtableId, business: f['Business Name'] });
  } catch (e) {
    console.warn(`Monthly report failed for ${airtableId}:`, e);
  }
}

// ============================================================
// REFERRAL PROCESSING — DEPENDENCY-04, DEPENDENCY-05, DEPENDENCY-07
// ============================================================

async function processReferralCredit(referralSlug, newClientPkg, env) {
  const referralEnabled = await getFlag(env, 'REFERRAL_ENABLED');
  if (!referralEnabled) return;

  try {
    // Find the referring client by slug
    const records = await listAirtableRecords(`{Slug} = "${referralSlug}"`, env);
    if (records.length === 0) return;

    const referrer    = records[0];
    const airtableId  = referrer.id;
    const f           = referrer.fields;
    const pkg         = (f['Package'] || 'Standard').toLowerCase();

    // Only Premium clients get referral credits (ENHANCE-17)
    if (pkg !== 'premium') return;

    // Credit value matches referred client's plan
    const creditValue = newClientPkg?.toLowerCase() === 'premium'
      ? PRICING.premium.retainer   // R699
      : PRICING.standard.retainer; // R449

    // Increment referral count and credits
    const countKey   = `referral_count:${airtableId}`;
    const creditKey  = `referral_credits:${airtableId}`;
    const count      = parseInt(await env.SITES.get(countKey).catch(() => '0') || '0') + 1;
    const credits    = parseInt(await env.SITES.get(creditKey).catch(() => '0') || '0') + 1;

    await env.SITES.put(countKey, String(count));
    await env.SITES.put(creditKey, String(credits));

    // Update Airtable referral field
    await updateAirtableRecord(airtableId, {
      'Free Months': credits,
    }, env);

    const name = f['Client Name']?.split(' ')[0] || 'there';
    const slug = f['Slug'] || slugify(f['Business Name']);

    // DEPENDENCY-05: Create Zoho credit note
    await createZohoCreditNote({
      clientName:  f['Client Name'],
      email:       f['Email'],
      amount:      creditValue,
      description: `Website Hub Referral Credit — 1 free month`,
      creditNum:   `WH-REF-${Date.now()}`,
    }, env);

    // Celebrate the referral
    await sendWhatsApp(f['WhatsApp'],
      `🎉 ${name} — you just earned a free month!\n\nSomeone signed up using your referral link. *R${creditValue} credit* has been applied to your account.\n\nYou now have *${credits} free month${credits !== 1 ? 's' : ''}* banked.\n\nKeep sharing:\nhttps://websitehub.co.za?ref=${slug}\n\n— Website Hub`,
      env
    );

    await logActivity(env, 'referral_credit_applied', {
      referrer: airtableId,
      business: f['Business Name'],
      creditValue,
      totalCredits: credits,
    });

  } catch (e) { console.warn('Referral processing failed:', e); }
}

// ============================================================
// AUTOMATED QA CHECKS
// ============================================================

function runQAChecks(html, f, pageName = 'index') {
  const failures = [];

  // ── Universal checks (all pages) ─────────────────────────
  if (!html.includes('<!DOCTYPE'))                                         failures.push('Missing DOCTYPE');
  if (!html.includes('viewport'))                                          failures.push('Missing viewport');
  if (!html.includes('<nav') && !html.includes('class="nav"'))             failures.push('Missing nav');
  if (!html.includes('wa.me') && !html.toLowerCase().includes('whatsapp')) failures.push('Missing WhatsApp link');
  if (html.includes('Lorem ipsum'))                                        failures.push('Lorem ipsum detected');

  // Unclosed <style> swallows the entire body in HTML5 rawtext mode, producing
  // a blank page with only surrounding chrome visible. Every <style> must close.
  const styleOpens  = (html.match(/<style\b/gi)  || []).length;
  const styleCloses = (html.match(/<\/style>/gi) || []).length;
  if (styleOpens !== styleCloses) {
    failures.push(`Unclosed <style> tag (${styleOpens} open, ${styleCloses} close) — body will not render`);
  }

  // Same hazard for <script> in body content — far less common but cheap to check
  const scriptOpens  = (html.match(/<script\b/gi)  || []).length;
  const scriptCloses = (html.match(/<\/script>/gi) || []).length;
  if (scriptOpens !== scriptCloses) {
    failures.push(`Unclosed <script> tag (${scriptOpens} open, ${scriptCloses} close)`);
  }

  const bizName = (f['Business Name'] || '').split(' ')[0];
  if (bizName && !html.toLowerCase().includes(bizName.toLowerCase()))
    failures.push('Business name missing');

  // ── Page-specific checks ──────────────────────────────────
  if (pageName === 'index') {
    if (!html.includes('id="home"') && !html.includes("id='home'"))
      failures.push('Home: missing hero id="home"');
    if (!(html.includes('stats') || html.includes('stat-')))
      failures.push('Home: missing stats strip');
  }
  if (pageName === 'services') {
    const cards = (html.match(/class="[^"]*card[^"]*"/g) || []).length;
    if (cards < 3) failures.push(`Services: only ${cards} card(s)`);
  }
  if (pageName === 'about') {
    if (!html.toLowerCase().includes('about') && !html.toLowerCase().includes('story'))
      failures.push('About: missing about/story content');
  }
  if (pageName === 'contact') {
    if (!html.includes('<form'))  failures.push('Contact: missing form');
    if (!html.includes('wa.me')) failures.push('Contact: missing WhatsApp link');
  }
  if (pageName === 'gallery') {
    if (!html.includes('gallery-grid'))   failures.push('Gallery: missing gallery-grid');
    if (!html.includes('gallery-assets')) failures.push('Gallery: missing dynamic fetch');
  }

  return { passed: failures.length === 0, failures };
}

// ============================================================
// UNSPLASH — Stock photo fetching (19 industries)
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
// PAYFAST LINK GENERATOR
// ============================================================

function buildPayFastLink(amount, itemName, airtableId, env) {
  const merchantId = env?.PAYFAST_MERCHANT_ID || '13581217';
  return `https://www.payfast.co.za/eng/process?merchant_id=${merchantId}&amount=${amount}&item_name=${encodeURIComponent(itemName)}&custom_str1=${airtableId}`;
}

// ============================================================
// TWILIO — WhatsApp messaging
// ============================================================

async function sendWhatsApp(to, message, env, opts = {}) {
  // v6.0: Meta Cloud API replaces Twilio
  // Falls back gracefully if not configured
  if (!env.META_WA_TOKEN || !env.META_PHONE_NUMBER_ID) {
    console.warn('Meta WhatsApp not configured — skipping:', message.slice(0, 60));
    return null;
  }

  const toRaw  = String(to || '').replace(/\D/g, '');
  if (!toRaw) return null;
  const toIntl = toRaw.startsWith('27') ? toRaw : toRaw.replace(/^0/, '27');

  // Opt-out check
  const optedOut = await env.SITES.get(`optout:${toIntl}`).catch(() => null);
  if (optedOut) {
    console.warn(`Skipping WhatsApp to opted-out number: ${toIntl}`);
    return null;
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${env.META_PHONE_NUMBER_ID}/messages`,
      {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${env.META_WA_TOKEN}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type:    'individual',
          to:                `+${toIntl}`,
          type:              'text',
          text:              { preview_url: opts.previewUrl === true, body: message },
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      console.warn('Meta WhatsApp error:', JSON.stringify(data));
      await logHealth(env, 'whatsapp', 'error', data?.error?.message);
    } else {
      await logHealth(env, 'whatsapp', 'success');
    }
    return data;
  } catch (e) {
    console.warn('Meta WhatsApp fetch error:', e);
    await logHealth(env, 'whatsapp', 'error', e.message);
    return null;
  }
}

// ============================================================
// ZOHO BOOKS — Invoice + Credit Note creation
// ============================================================

async function getZohoAccessToken(env) {
  if (!env.ZOHO_REFRESH_TOKEN) return null;
  try {
    const res  = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        refresh_token: env.ZOHO_REFRESH_TOKEN,
        client_id:     env.ZOHO_CLIENT_ID,
        client_secret: env.ZOHO_CLIENT_SECRET,
        grant_type:    'refresh_token',
      }),
    });
    const data = await res.json();
    if (!data.access_token) {
      const reason = data.error || data.message || 'No access_token in response';
      if (['invalid_code', 'access_denied'].includes(reason) || reason.includes('expired')) {
        await sendWhatsApp(
          env.WH_PHONE,
          `🔐 ZOHO AUTH EXPIRED — invoicing is down. Re-run /zoho-auth to fix.\nError: ${reason}`,
          env
        ).catch(() => {});
      }
      await logHealth(env, 'zoho', 'error', reason);
      return null;
    }
    await logHealth(env, 'zoho', 'success');
    return data.access_token;
  } catch (e) {
    await logHealth(env, 'zoho', 'error', e.message);
    return null;
  }
}

async function createZohoInvoice({ clientName, email, amount, description, invoiceNum, markPaid = false, payLink = '' }, env) {
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_ORG_ID) {
    console.warn('Zoho not configured — skipping invoice');
    return null;
  }

  const accessToken = await getZohoAccessToken(env);
  if (!accessToken) return null;

  const headers = {
    'Authorization': `Zoho-oauthtoken ${accessToken}`,
    'Content-Type':  'application/json',
  };
  const orgId = env.ZOHO_ORG_ID;

  let contactId;
  try {
    const searchRes  = await fetch(`https://books.zoho.com/api/v3/contacts?organization_id=${orgId}&email=${encodeURIComponent(email)}`, { headers });
    const searchData = await searchRes.json();
    const existing   = searchData?.contacts?.[0];
    if (existing) {
      contactId = existing.contact_id;
    } else {
      const contactRes  = await fetch(`https://books.zoho.com/api/v3/contacts?organization_id=${orgId}`, {
        method: 'POST', headers,
        body: JSON.stringify({ contact_name: clientName, email, contact_type: 'customer' }),
      });
      const contactData = await contactRes.json();
      contactId = contactData?.contact?.contact_id;
    }
  } catch (e) { console.warn('Zoho contact failed:', e); return null; }

  if (!contactId) return null;

  const today   = new Date().toISOString().split('T')[0];
  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const notes   = payLink
    ? `Pay online: ${payLink}\n\nThank you for choosing Website Hub.`
    : 'Thank you for choosing Website Hub.';

  try {
    const suffix     = markPaid ? '&invoice_status=paid' : '';
    const invoiceRes = await fetch(`https://books.zoho.com/api/v3/invoices?organization_id=${orgId}&send=true${suffix}`, {
      method: 'POST', headers,
      body: JSON.stringify({
        customer_id:    contactId,
        invoice_number: invoiceNum,
        date:           today,
        due_date:       dueDate,
        line_items: [{ description, quantity: 1, rate: amount }],
        notes,
      }),
    });
    const invoiceData = await invoiceRes.json();
    await logHealth(env, 'zoho', 'success');
    return invoiceData?.invoice || null;
  } catch (e) {
    console.warn('Zoho invoice create failed:', e);
    await logHealth(env, 'zoho', 'error', e.message);
    return null;
  }
}

// DEPENDENCY-05: Zoho credit note creation for referral credits
async function createZohoCreditNote({ clientName, email, amount, description, creditNum }, env) {
  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_ORG_ID) return null;

  const accessToken = await getZohoAccessToken(env);
  if (!accessToken) return null;

  const headers = {
    'Authorization': `Zoho-oauthtoken ${accessToken}`,
    'Content-Type':  'application/json',
  };
  const orgId = env.ZOHO_ORG_ID;

  // Find contact
  let contactId;
  try {
    const searchRes  = await fetch(`https://books.zoho.com/api/v3/contacts?organization_id=${orgId}&email=${encodeURIComponent(email)}`, { headers });
    const searchData = await searchRes.json();
    contactId = searchData?.contacts?.[0]?.contact_id;
  } catch { return null; }

  if (!contactId) return null;

  try {
    const today = new Date().toISOString().split('T')[0];
    const creditRes = await fetch(`https://books.zoho.com/api/v3/creditnotes?organization_id=${orgId}`, {
      method: 'POST', headers,
      body: JSON.stringify({
        customer_id:       contactId,
        creditnote_number: creditNum,
        date:              today,
        line_items: [{ description, quantity: 1, rate: amount }],
      }),
    });
    const creditData = await creditRes.json();
    return creditData?.creditnote || null;
  } catch (e) { console.warn('Zoho credit note failed:', e); return null; }
}

// ============================================================
// AIRTABLE HELPERS
// ============================================================

async function createAirtableRecord(fields, env) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== '' && v !== null && v !== undefined));
  const res   = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields: clean }),
    }
  );
  if (!res.ok) throw new Error(`Airtable create failed: ${await res.text()}`);
  await logHealth(env, 'airtable', 'success');
  return res.json();
}

async function getAirtableRecord(recordId, env) {
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}/${recordId}`,
    { headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Airtable get failed: ${res.status}`);
  return res.json();
}

async function updateAirtableRecord(recordId, fields, env) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([_, v]) => v !== undefined && v !== null));
  const res   = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}/${recordId}`,
    {
      method:  'PATCH',
      headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ fields: clean }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Airtable update failed: ${res.status} — ${body}`);
  }
  return res.json();
}

async function listAirtableRecords(filterFormula, env, maxRecords = null) {
  const allRecords = [];
  let offset = null;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (filterFormula) params.set('filterByFormula', filterFormula);
    if (offset)        params.set('offset', offset);
    const res = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}?${params}`,
      { headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` } }
    );
    if (!res.ok) throw new Error(`Airtable list failed: ${res.status}`);
    const data = await res.json();
    allRecords.push(...(data.records || []));
    offset = data.offset || null;
    if (maxRecords && allRecords.length >= maxRecords) break;
    if (allRecords.length >= 1000) break;
  } while (offset);
  return allRecords;
}

async function logBuild(clientId, status, errorMsg, env, tokens = 0) {
  try {
    await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Build%20Log`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        fields: {
          'Client':          [clientId],
          'Build Triggered': new Date().toISOString(),
          'Build Status':    status,
          'Tokens Used':     tokens,
          'Error Log':       errorMsg || '',
        }
      }),
    });
  } catch (e) { console.warn('Build log failed (non-fatal):', e); }
}

// ============================================================
// FLAG HELPER — KV override takes priority over env var
// Allows dashboard circuit breaker toggles to control behaviour
// without a Cloudflare env var change or redeployment.
// ============================================================

async function getFlag(env, envVarName) {
  const kvKeyMap = {
    'OUTBOUND_ENABLED':          'config:outbound_enabled',
    'REFERRAL_ENABLED':          'config:referral_enabled',
    'VISION_VALIDATION_ENABLED': 'config:vision_enabled',
  };
  const kvKey = kvKeyMap[envVarName];
  if (kvKey) {
    try {
      const kvVal = await env.SITES.get(kvKey);
      if (kvVal !== null) return kvVal === 'true';
    } catch { /* fall through */ }
  }
  return env[envVarName] === 'true';
}

// ============================================================
// ACTIVITY LOGGING — DEPENDENCY-01
// Every significant operation logged to KV
// ============================================================

async function logActivity(env, event, data = {}) {
  try {
    const key     = `activity:${Date.now()}:${event}`;
    const payload = JSON.stringify({ event, ...data, timestamp: new Date().toISOString() });
    await env.SITES.put(key, payload, { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days
  } catch { /* non-fatal */ }
}

// ENHANCE-03: Operational health logging
async function logHealth(env, service, status, error = null) {
  try {
    const normStatus = status === 'success' || status === 'partial' ? 'ok' : 'error';
    const now = new Date().toISOString();
    const payload = {
      status: normStatus,
      timestamp: now,
      ...(normStatus === 'ok' ? { lastSuccess: now } : { lastError: error }),
    };
    await env.SITES.put(`health:${service}`, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 7 });
  } catch { /* non-fatal */ }
}

// ============================================================
// FIELD MAPPING — Formspree → Airtable
// ============================================================

function mapFormspreeToAirtable(body) {
  const pkg  = body['Package'] || body['package'] || 'Standard';
  const tier = getPricingTier(pkg);
  return {
    'Business Name':   body['Business Name']  || body['businessName']  || '',
    'Client Name':     body['Client Name']    || body['clientName']    || '',
    'WhatsApp':        body['WhatsApp']       || body['whatsapp']      || '',
    'Email':           body['Email']          || body['email']         || '',
    'Package':         pkg,
    'Hosting':         'Hosted',
    'Build Fee':       tier.build,
    'Retainer':        tier.retainer,
    'Status':          'Lead',
    'Industry':        body['Industry']       || body['industry']      || '',
    'Area':            body['Area']           || body['area']          || '',
    'Domain':          body['Domain']         || body['domain']        || '',
    'Dropbox Link':    body['Dropbox Assets'] || body['gdrive']        || '',
    'Instagram':       body['Instagram']      || body['instagram']     || '',
    'Facebook':        body['Facebook']       || body['facebook']      || '',
    'TikTok':          body['TikTok']         || body['tiktok']        || '',
    'Google Business': body['Google Business']|| body['google']        || '',
    'Services':        body['Services']       || body['services']      || '',
    'About':           body['About']          || body['about']         || '',
    'Bio':             body['Bio']            || body['bio']           || '',
    'Post Captions':   body['Posts']          || body['posts']         || '',
    'Reviews':         body['Reviews']        || body['reviews']       || '',
    'Colours':         body['Colours']        || body['colours']       || '',
    'Vibe':            body['Vibe']           || body['vibe']          || '',
    'Inspo Sites':     body['Inspo']          || body['inspo']         || '',
    'Extra Notes':     body['Extra Notes']    || body['extra']         || '',
    'Source':          'Website',
    'Submission Date': new Date().toISOString().split('T')[0],
  };
}

function getPricingTier(pkg) {
  const key = (pkg || '').toLowerCase().trim();
  if (key === 'premium') return PRICING.premium;
  return PRICING.standard;
}

// ============================================================
// CLAUDE API — Auto model resolution + streaming
// Calls /v1/models to pick the latest Sonnet available.
// Result cached in KV for 24h — zero manual intervention on deprecation.
// ============================================================

async function resolveClaudeModel(env) {
  const CACHE_KEY = 'system:claude_model';
  const CACHE_TTL = 60 * 60 * 24; // 24 hours

  // Return cached model if still fresh
  const cached = await env.SITES.get(CACHE_KEY);
  if (cached) return cached;

  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key':         env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!res.ok) throw new Error(`Models API ${res.status}`);

    const { data: models } = await res.json();

    // Pick best available: prefer sonnet, fall back to any claude model
    // Sort by created desc so newest wins
    const sorted = models
      .filter(m => m.id.includes('claude') && !m.id.includes('haiku'))
      .sort((a, b) => (b.created || 0) - (a.created || 0));

    const sonnet = sorted.find(m => m.id.includes('sonnet'));
    const chosen = (sonnet || sorted[0])?.id;

    if (!chosen) throw new Error('No suitable Claude model found');

    await env.SITES.put(CACHE_KEY, chosen, { expirationTtl: CACHE_TTL });
    console.log(`Claude model resolved: ${chosen}`);
    return chosen;
  } catch (e) {
    // Hard fallback — current active Sonnet model (dateless format, pinned snapshot)
    // Only update this if Anthropic changes naming conventions entirely
    console.warn(`Model resolution failed (${e.message}), using fallback`);
    return 'claude-sonnet-4-6';
  }
}

async function callClaudeInternal(systemPrompt, messages, env, options = {}) {
  const model = await resolveClaudeModel(env); // auto-resolves latest Sonnet, 24h KV cache

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: options.maxTokens ?? 8000,
      stream:     true,
      system:     systemPrompt,
      messages,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let fullText = '';
  let buffer   = '';

  while (true) {
    const { done, value } = await reader.read();
    const chunk = done
      ? decoder.decode(new Uint8Array(0), { stream: false })
      : decoder.decode(value, { stream: true });

    if (chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            fullText += parsed.delta.text;
          }
        } catch { /* malformed chunk — skip */ }
      }
    }

    if (done) break;
  }

  if (!fullText) throw new Error('Empty response received');
  return fullText;
}

// ============================================================
// BUILD PROMPTS — Standard and Premium
// ENHANCE-09: All AI language removed, team language used
// ============================================================

// ============================================================
// 3-PASS BUILD SYSTEM — v7
// Pass 1: Content & Strategy (JSON, ~800 tokens out)
// Pass 2: CSS Design System (<style> block, ~2000 tokens out)
// Pass 3: HTML Assembly (complete HTML, ~4500 tokens out)
// Total: ~5300 tokens vs old single-pass ~7800 (32% cheaper)
// All sections guaranteed complete. QA retry = Pass 3 only.
// ============================================================

// ── PASS 1 — Content & Strategy ─────────────────────────────

function buildPass1SystemPrompt() {
  return `You are a South African website content strategist with 15 years experience building brands for SA small businesses. You understand the local market, the language, the trust signals that convert.

Output ONLY valid JSON — no preamble, no explanation, no markdown backticks. Start with { and end with }.

Your copy must be:
- Warm, confident, specifically South African (not corporate, not American)
- Headline-driven: short, punchy, memorable
- Built around the business's actual story, not generic filler`;
}

function buildPass1UserPrompt(fields) {
  const pkg       = fields['Package'] || 'Standard';
  const isPremium = pkg.toLowerCase() === 'premium';
  const waRaw     = (fields['WhatsApp'] || '').replace(/\D/g, '');
  const waIntl    = waRaw.startsWith('27') ? waRaw : waRaw.replace(/^0/, '27');

  return `Generate website content for this South African business. Return ONLY this JSON structure with no other text:

BUSINESS BRIEF:
Name: ${fields['Business Name'] || ''}
Industry: ${fields['Industry'] || ''}
About: ${fields['About'] || ''}
Services: ${fields['Services'] || ''}
Area: ${fields['Area'] || ''}
Package: ${pkg}
Voice/Vibe: ${fields['Vibe'] || 'Professional, warm, South African'}
Social bio: ${fields['Bio'] || 'Not provided'}
Colours requested: ${fields['Colours'] || 'Choose industry-appropriate'}

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
  "hero_h1": "3-line headline — punchy, specific, South African",
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

// ── PASS 2 — CSS Design System ───────────────────────────────

// ── PASS 2 — Combined CSS + HTML Render ─────────────────────
// Replaces separate Pass 2 (CSS) and Pass 3 (HTML assembly)
// CSS and HTML in one call = class names always match

function buildRenderSystemPrompt(pkg) {
  const isPremium = (pkg || '').toLowerCase() === 'premium';
  return `You are an expert South African web designer and developer. You build complete, beautiful, production-ready websites in a single HTML file.

OUTPUT RULES — non-negotiable:
→ Output ONLY raw HTML. Start with <!DOCTYPE html>. No preamble, no explanation, no backticks.
→ Write your OWN CSS inside a single <style> block in <head>. Use short class names.
→ NEVER reference external CSS files. All styles must be inline in <style>.
→ NEVER use Lorem Ipsum. NEVER invent contact details.
→ ALL four sections MUST use these exact IDs: id="home" id="services" id="about" id="contact"
→ MUST include a <nav> element with a hamburger button for mobile
→ MUST include a WhatsApp link using wa.me format
→ MUST include og:title, og:description, og:image meta tags in <head>

REQUIRED STRUCTURE — in this exact order:
1. <!DOCTYPE html><html lang="en"><head> with charset, viewport, page title, meta desc, OG tags, Google Fonts, <style> block
2. <nav> — fixed top, brand name left, links right on desktop, hamburger on mobile
3. Mobile nav overlay
4. <section id="home"> — full viewport hero with background photo + stats strip at bottom
5. <section id="services"> — card grid, 5 service cards
6. <section id="about"> — 2-column: image left, text + trust points right (stacks on mobile)
7. <section id="contact"> — contact info grid + emergency CTA box
8. <footer> — one line copyright
9. WhatsApp floating action button (fixed bottom-right, #25D366)
10. Watermark bar (fixed bottom, full width) — pre-built HTML provided below
11. <script> — hamburger toggle only

DESIGN STANDARDS:
→ Dark background (#0a0a0f range), one strong accent colour, white text
→ Hero: full viewport height, background photo with gradient overlay, massive bold headline
→ Stats: 3-column strip anchored to hero bottom with glassmorphism/frosted look
→ Service cards: grid layout, icon + title + one-line description
→ Typography: display font for headings (large, tight letter-spacing), clean sans for body
→ Animations: subtle fade-up on load, smooth hover transitions
→ Fully mobile-responsive — hamburger nav, stacked layouts under 720px${isPremium ? `

PREMIUM EXTRAS (after services, before about):
→ Testimonials section (id="testimonials") if testimonials provided
→ Gallery grid section (id="gallery") with placeholder slots` : ''}`;
}

function buildRenderUserPrompt(contentJson, fields, unsplashContext) {
  const pkg    = fields['Package'] || 'Standard';
  const waRaw  = (fields['WhatsApp'] || '').replace(/\D/g, '');
  const waIntl = waRaw.startsWith('27') ? waRaw : waRaw.replace(/^0/, '27');
  const slug   = fields['Slug'] || slugify(fields['Business Name'] || '');
  const domain = fields['Domain'] || `${slug}.co.za`;
  const email  = fields['Email'] || '';
  const area   = fields['Area'] || '';

  // Extract hero photo URL for OG tag — must be a direct URL not base64
  const ogImageMatch = unsplashContext.match(/https:\/\/images\.unsplash\.com\/[^\s\n]+/);
  const ogImage = ogImageMatch ? ogImageMatch[0] : 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&q=80';

  const services = (contentJson.services || []).map((s, i) =>
    `${i+1}. ${s.icon || '⚡'} ${s.name}: ${s.desc}`
  ).join('\n');

  const trustPoints = (contentJson.trust_points || []).join(' | ');

  return `Build the complete website using this content and business data.

══ BRAND ══
Aesthetic: ${contentJson.aesthetic || 'bold_modern'}
Background: ${contentJson.color_bg || '#0a0a0f'}
Surface: ${contentJson.color_surface || '#111118'}
Accent: ${contentJson.color_accent || '#ff5500'}
Text: ${contentJson.color_text || '#ffffff'}
Muted: ${contentJson.color_muted || '#888899'}
Display font: ${contentJson.font_display || 'Syne'} (weights 700, 800)
Body font: ${contentJson.font_body || 'DM Sans'} (weights 400, 500, 600)

══ HERO ══
Badge: ${contentJson.hero_badge || ''}
Headline line 1: ${contentJson.hero_h1_line1 || ''}
Headline line 2: ${contentJson.hero_h1_line2 || ''} ← wrap accent word "${contentJson.hero_accent_word || ''}" in <em style="color:var(--acc);font-style:normal">
Headline line 3: ${contentJson.hero_h1_line3 || ''}
Body copy: ${contentJson.hero_copy || ''}
CTA 1: ${contentJson.cta_primary || 'Get a Free Quote'} → links to wa.me
CTA 2: ${contentJson.cta_secondary || 'WhatsApp Us'} → links to wa.me
Stats: ${contentJson.stat1_num} ${contentJson.stat1_lbl} | ${contentJson.stat2_num} ${contentJson.stat2_lbl} | ${contentJson.stat3_num} ${contentJson.stat3_lbl}

══ SERVICES ══
Section tag: ${contentJson.services_section_tag || 'What We Do'}
Heading: ${contentJson.services_h2 || 'Our Services'}
${services}

══ ABOUT ══
Section tag: ${contentJson.about_section_tag || 'Our Story'}
Heading: ${contentJson.about_headline || ''}
Pull quote (left border accent): "${contentJson.about_pull_quote || ''}"
Paragraph 1: ${contentJson.about_p1 || ''}
Paragraph 2: ${contentJson.about_p2 || ''}
Trust points: ${trustPoints}

══ CONTACT ══
Section tag: ${contentJson.contact_section_tag || 'Get In Touch'}
Heading: ${contentJson.contact_h2_line1 || 'Get In Touch'} ${contentJson.contact_h2_line2 || ''} (accent: ${contentJson.contact_h2_accent || ''})
Body: ${contentJson.contact_copy || ''}
Phone card: ${fields['WhatsApp'] || ''}
WhatsApp card: links to https://wa.me/${waIntl}
Email card: ${email || '<!-- add email -->'}
Area card: ${area}
Emergency CTA button: links to https://wa.me/${waIntl}?text=Hi%2C%20I%20have%20an%20emergency

══ META / OG ══
Page title: ${contentJson.page_title || fields['Business Name']}
OG title: ${contentJson.og_title || fields['Business Name']}
OG description: ${contentJson.og_description || ''}
OG image: ${ogImage}

══ BUSINESS ══
Name: ${fields['Business Name']}
Domain: ${domain}
WhatsApp (intl): +${waIntl}
Email: ${email}
Area: ${area}
Industry: ${fields['Industry'] || ''}
${unsplashContext}

══ FOOTER ══
© 2026 ${fields['Business Name']} · ${area} · Hosted & managed by Website Hub — websitehub.co.za · 🔒 Secured by Cloudflare${unsplashContext ? ' · Photos: Unsplash' : ''}

══ WATERMARK BAR (paste verbatim just before </body>) ══
<!-- WATERMARK: DO NOT EDIT -->
<div id="wh-preview-bar" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:rgba(8,10,16,0.97);backdrop-filter:blur(14px);color:#fff;padding:10px 20px;font-family:'Arial',sans-serif;font-size:12px;border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;gap:10px;"><span style="flex:1;opacity:0.7;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">✨ Built for <strong style="color:#fff;">${fields['Business Name']}</strong></span><div style="display:flex;gap:8px;align-items:center;flex-shrink:0;"><a href="/not-interested" style="background:transparent;color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.25);padding:8px 14px;border-radius:7px;font-size:12px;text-decoration:none;white-space:nowrap;">Not interested</a><a href="/go-live" style="background:#ff5500;color:#fff;padding:9px 20px;border-radius:7px;font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap;">🚀 Go Live — R${fields['Package']?.toLowerCase() === 'premium' ? '1,099' : '699'}/mo</a></div></div>
<!-- WH_WATERMARK_END -->

Output ONLY the complete HTML document. Start with <!DOCTYPE html>.`;
}

// ── PASS 2 — CSS-only design system ─────────────────────────
// Generates the shared <style> block used across all 5 pages.
// Stored in KV as css:{slug}. Pass 3 injects it verbatim into each page.

function buildPass2SystemPrompt() {
  return `You are a senior CSS engineer building a shared design system for a South African small business website.

OUTPUT RULES — non-negotiable:
→ Output ONLY a single <style> block. Start with <style> and end with </style>. No other text.
→ Include @import for Google Fonts inside the <style> block.
→ Define all colours, fonts, and spacing as CSS custom properties in :root.
→ Write all shared component styles: reset, typography, nav, buttons, cards, grid utilities, footer, FAB, animations.
→ Do NOT write any page-specific section HTML or inline content.
→ All styles must be mobile-first and fully responsive. Main breakpoint: 720px.`;
}

function buildPass2UserPrompt(contentJson, fields) {
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

REQUIRED COMPONENTS (all must be present):
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

// ── PASS 3 — Per-page HTML renders ───────────────────────────
// 5 calls run in parallel via Promise.all in triggerBuildInternal.
// Each receives the shared CSS block from Pass 2 and page-specific content.

function buildPass3PageSystemPrompt(pageName, pkg) {
  const isPremium = (pkg || '').toLowerCase() === 'premium';
  const navPages  = isPremium
    ? `Home | Services | About | Contact | Gallery`
    : `Home | Services | About | Contact`;

  return `You are an expert South African web developer building one page of a multi-page website.

OUTPUT RULES — non-negotiable:
→ Output ONLY raw HTML. Start with <!DOCTYPE html>. No preamble, no explanation, no backticks.
→ DO NOT include any <style> block or <link rel="stylesheet"> in your output. The stylesheet is injected by our build pipeline. In <head>, place EXACTLY this single line where styles should go: <!--WH_CSS_INJECT-->
→ The CSS classes you may reference are shown in the user message below. They are for your REFERENCE ONLY — do not paste them into the output.
→ Use ONLY those CSS classes. You MAY add inline styles ONLY for: hero background-image URLs, section min-height, and any dynamic value that cannot be known at CSS authoring time.
→ NEVER use Lorem Ipsum. NEVER invent contact details not provided.
→ MUST include a <nav class="nav"> with links to all pages using relative paths (${navPages}).
→ MUST include a WhatsApp FAB: <a href="..." class="fab-wa" ...>💬</a>
→ MUST include og:title, og:description, og:image meta tags.
→ MUST include a <script> tag at the end for hamburger toggle (and gallery fetch if this is the gallery page).
→ You are building the ${pageName.toUpperCase()} page only. Do not include sections belonging to other pages.`;
}

function buildPass3PageUserPrompt(pageName, contentJson, cssBlock, fields, unsplashContext, slug) {
  const pkg       = fields['Package'] || 'Standard';
  const isPremium = pkg.toLowerCase() === 'premium';
  const waRaw     = (fields['WhatsApp'] || '').replace(/\D/g, '');
  const waIntl    = waRaw.startsWith('27') ? waRaw : waRaw.replace(/^0/, '27');
  const email     = fields['Email'] || '';
  const area      = fields['Area']  || '';
  const domain    = fields['Domain'] || `${slug}.co.za`;
  const bizName   = fields['Business Name'] || '';

  const navLinks = isPremium
    ? `<a href="/">Home</a><a href="/services">Services</a><a href="/about">About</a><a href="/contact">Contact</a><a href="/gallery">Gallery</a>`
    : `<a href="/">Home</a><a href="/services">Services</a><a href="/about">About</a><a href="/contact">Contact</a>`;

  const services = (contentJson.services || []).map((s, i) =>
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

  const pageContent = {

    index: `
BUILD: HOME PAGE — conversion-focused. Hero + stats strip + single bottom CTA. No services grid, no full about.

HERO SECTION — use this EXACT HTML structure (fill in content, keep all attributes):
<section id="home" class="hero" style="background-image:url(UNSPLASH_URL);">
  <div class="hero-overlay"></div>
  <div class="hero-content">
    <!-- badge, h1, copy, CTAs go here -->
  </div>
  <div class="stats-strip">
    <!-- 3 stats go here -->
  </div>
</section>
Replace UNSPLASH_URL with the first photo URL from the PHOTOS section below. Keep the class="hero" and style="background-image:url(...)" exactly as shown.
  Badge:        "${contentJson.hero_badge || ''}"
  H1 line 1:    "${contentJson.hero_h1_line1 || ''}"
  H1 line 2:    "${contentJson.hero_h1_line2 || ''}" — wrap "${contentJson.hero_accent_word || ''}" in <em style="color:var(--acc);font-style:normal">
  H1 line 3:    "${contentJson.hero_h1_line3 || ''}"
  Body copy:    "${contentJson.hero_copy || ''}"
  CTA 1 (.btn-primary):  "${contentJson.cta_primary  || 'Get a Free Quote'}" → https://wa.me/${waIntl}
  CTA 2 (.btn-outline):  "${contentJson.cta_secondary || 'WhatsApp Us'}"     → https://wa.me/${waIntl}

STATS STRIP (.stats-strip — position:absolute;bottom:0;left:0;right:0 inside the hero):
  ${contentJson.stat1_num} ${contentJson.stat1_lbl} | ${contentJson.stat2_num} ${contentJson.stat2_lbl} | ${contentJson.stat3_num} ${contentJson.stat3_lbl}

BOTTOM CTA SECTION (warm, urgent, industry-specific):
  Button (.btn-primary): "WhatsApp Us Now" → https://wa.me/${waIntl}

${unsplashContext}`,

    services: `
BUILD: SERVICES PAGE — full services grid, trust signals, emergency CTA.

PAGE HERO (.page-hero):
  Heading: "Our Services"
  Subtext: Brief one-liner about the business.

SERVICES GRID (.grid-5 → .grid-2 → .grid-1):
${services}
${isPremium
  ? 'PREMIUM: Each card (.card) has: icon (large), service name (h3), FULL description (3-4 sentences), price range if applicable, specific WhatsApp CTA link.'
  : 'STANDARD: Each card (.card) has: icon, service name (h3), one-sentence description, WhatsApp CTA link.'}

TRUST SIGNALS STRIP (3-col):
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

TRUST POINTS (icon + text list):
  ${trustPoints}
${isPremium ? `
TEAM SECTION (.grid-2):
  Founder card: name from business fields, role "Founder & Owner", short bio from about field.
  Use a professional Unsplash portrait placeholder.

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

INCLUDE THIS EXACT SCRIPT:
<script>
(function(){
  var slug='${slug}';
  var grid=document.getElementById('gallery-grid');
  var loader=document.getElementById('gallery-loader');
  fetch('https://wh-enrichment-worker.pierreduplessis6912.workers.dev/gallery-assets/'+slug)
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

// Legacy stubs — kept so handlePatchPreview still compiles without changes
function buildPass3SystemPrompt(pkg) { return buildRenderSystemPrompt(pkg); }
function buildPass3UserPrompt(contentJson, cssBlock, fields, unsplashContext) { return buildRenderUserPrompt(contentJson, fields, unsplashContext); }


// Legacy aliases — keep these so any other code calling old names still works
function buildSystemPrompt(pkg) { return buildPass3SystemPrompt(pkg); }
function buildUserPrompt(fields) { return buildPass1UserPrompt(fields); }


// WATERMARK — BF-05: 2 buttons only: Go Live + Not Interested
// Not Interested writes optout immediately
// ============================================================

function addWatermark(html, f, domain, airtableId, env) {
  const bizName = (f && f['Business Name']) ? f['Business Name'] : 'your business';
  const pkg     = f && f['Package'] ? f['Package'] : 'Standard';
  const tier    = getPricingTier(pkg);
  const slug    = f && f['Slug'] ? f['Slug'] : slugify(bizName);
  const phone   = f && f['WhatsApp'] ? f['WhatsApp'].replace(/\D/g, '') : '';
  const intl    = phone.startsWith('27') ? phone : phone.replace(/^0/, '27');

  // v7: Always show monthly retainer — build fee is now R0
  const priceLabel = tier.build > 0
    ? `R${tier.build.toLocaleString()}`
    : `R${tier.retainer}/mo`;

  // Go Live → PayFast first month subscription
  const payLink          = buildPayFastLink(tier.retainer, 'Website Hub Monthly Subscription', airtableId, env);
  const notInterestedUrl = `https://${WORKER_DOMAIN}/not-interested?phone=${intl}&slug=${slug}`;

  const goLiveBtn = `<a href="${payLink}" style="background:#ff5500;color:#fff;padding:9px 20px;border-radius:7px;font-size:13px;font-weight:700;text-decoration:none;white-space:nowrap;">🚀 Go Live — ${priceLabel}</a>`;
  const notIntBtn = `<a href="${notInterestedUrl}" style="background:transparent;color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.25);padding:8px 14px;border-radius:7px;font-size:12px;text-decoration:none;white-space:nowrap;">Not interested</a>`;

  // v7: Inject at BOTTOM of body (before </body>), never at top
  const banner = `
<div id="wh-preview-bar" style="position:fixed;bottom:0;left:0;right:0;z-index:2147483647;background:rgba(8,10,16,0.97);backdrop-filter:blur(14px);color:#fff;padding:10px 20px;font-family:'Arial',sans-serif;font-size:12px;border-top:1px solid rgba(255,255,255,0.07);display:flex;align-items:center;gap:10px;">
  <span style="flex:1;opacity:0.7;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">✨ Built for <strong style="color:#fff;">${bizName}</strong></span>
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
  return html.replace('</body>', `<div style="text-align:center;padding:8px;font-size:11px;color:#999;font-family:Arial,sans-serif;">Hosted & managed by <a href="https://websitehub.co.za" style="color:#999;" target="_blank">Website Hub</a> · 🔒 Secured by Cloudflare</div></body>`);
}

// ============================================================
// STATIC PAGES
// ============================================================

function suspendedPage(domain) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site Temporarily Unavailable</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:440px;box-shadow:0 4px 24px rgba(0,0,0,.08)}.icon{font-size:48px;margin-bottom:16px}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6;font-size:15px}a{color:#1a1a2e;font-weight:600}</style></head><body><div class="box"><div class="icon">⚠️</div><h1>Site Temporarily Unavailable</h1><p>This website is temporarily unavailable due to an outstanding subscription payment.<br><br>If you are the site owner, please contact <a href="https://wa.me/27840142017">Website Hub</a> to reinstate your site immediately.</p></div></body></html>`;
}

function notFoundPage(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:440px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6}</style></head><body><div class="box"><h1>Site Not Found</h1><p>The site <strong>${slug}</strong> doesn't exist or has been moved.<br><br><a href="https://websitehub.co.za" style="color:#1a1a2e;font-weight:600;">Visit Website Hub →</a></p></div></body></html>`;
}

function expiredPreviewPage(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview Expired</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}.box{background:#fff;border-radius:12px;padding:48px 40px;text-align:center;max-width:440px;box-shadow:0 4px 24px rgba(0,0,0,.08)}h1{font-size:22px;color:#222;margin-bottom:12px}p{color:#666;line-height:1.6}a{color:#1a1a2e;font-weight:600}</style></head><body><div class="box"><div style="font-size:48px;margin-bottom:16px">⏱️</div><h1>This preview has expired</h1><p>This site preview is no longer available. If you'd like a website for your business, visit <a href="https://websitehub.co.za">websitehub.co.za</a> — we'll have something ready for you in 10 minutes.</p></div></body></html>`;
}

function landingPage() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Website Hub Preview Portal</title></head><body style="font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f5f5f5"><div style="text-align:center"><h1 style="color:#1a1a2e">Website Hub</h1><p style="color:#666;margin-top:8px">Client preview portal</p></div></body></html>`;
}

function galleryUpgradePromptPage(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gallery — Upgrade to Premium</title><style>body{margin:0;background:#0a0a0f;color:#fff;font-family:'DM Sans',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{background:#111118;border:1px solid rgba(255,255,255,0.07);border-radius:16px;padding:48px 32px;max-width:420px}.icon{font-size:48px;margin-bottom:20px}.h{font-size:28px;font-weight:800;margin-bottom:12px}.p{color:#888899;line-height:1.7;margin-bottom:28px}.btn{display:inline-block;background:#ff5500;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px}</style></head><body><div class="card"><div class="icon">📸</div><h2 class="h">Gallery is a Premium feature</h2><p class="p">Upgrade to Premium to showcase your work with a dynamic photo gallery — updated automatically when you send photos via WhatsApp.</p><a href="https://www.payfast.co.za/eng/process?merchant_id=10048685&amount=400&item_name=Website+Hub+Upgrade+to+Premium&custom_str1=${slug}" class="btn">Upgrade to Premium — R400/mo more</a></div></body></html>`;
}

// ============================================================
// ROUTE: /referral-stats — management panel referral data
// GET ?slug={slug}
// ============================================================

async function handleReferralStats(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const monthStr = new Date().toISOString().slice(0, 7);

  // Count monthly referrals sent
  let monthlySent = 0;
  try {
    const val = await env.SITES.get(`referral:${slug}:${monthStr}`);
    monthlySent = parseInt(val || '0');
  } catch { /* non-fatal */ }

  // Total conversions (clients who used this referral link and went live)
  const conversions = parseInt(await env.SITES.get(`referral_conversions:${slug}`).catch(() => '0') || '0');
  const rewardMonths = conversions; // 1 conversion = 1 free month

  // Leaderboard position — compute from all monthly referral keys
  let position = null;
  try {
    const allKeys = await env.SITES.list({ prefix: `referral:` });
    const thisMonthKeys = allKeys.keys.filter(k => k.name.endsWith(`:${monthStr}`));
    const slugCounts = {};
    for (const key of thisMonthKeys) {
      const s = key.name.replace('referral:', '').replace(`:${monthStr}`, '');
      const v = parseInt(await env.SITES.get(key.name).catch(() => '0') || '0');
      slugCounts[s] = (slugCounts[s] || 0) + v;
    }
    const sorted = Object.entries(slugCounts).sort(([, a], [, b]) => b - a);
    const idx    = sorted.findIndex(([s]) => s === slug);
    position     = idx >= 0 ? idx + 1 : null;
  } catch { /* non-fatal */ }

  return jsonResponse({ sent: monthlySent, conversions, position, reward_months: rewardMonths });
}

// ============================================================
// ROUTE: /analytics — management panel analytics
// GET ?slug={slug}
// ============================================================

async function handleAnalytics(request, url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  const monthStr = new Date().toISOString().slice(0, 7);

  // Aggregate all daily visit keys for this month
  const visitKeys = await env.SITES.list({ prefix: `visits:${slug}:${monthStr}` }).catch(() => ({ keys: [] }));
  let totalViews = 0;
  for (const key of visitKeys.keys) {
    const v = await env.SITES.get(key.name).catch(() => '0');
    totalViews += parseInt(v || '0');
  }

  // Previous month for comparison
  const prevDate     = new Date();
  prevDate.setMonth(prevDate.getMonth() - 1);
  const prevMonthStr = prevDate.toISOString().slice(0, 7);
  const prevKeys     = await env.SITES.list({ prefix: `visits:${slug}:${prevMonthStr}` }).catch(() => ({ keys: [] }));
  let prevViews = 0;
  for (const key of prevKeys.keys) {
    const v = await env.SITES.get(key.name).catch(() => '0');
    prevViews += parseInt(v || '0');
  }

  return jsonResponse({
    views_this_month: totalViews,
    views_last_month: prevViews,
    top_page: 'Home', // Per-page tracking not yet instrumented
    whatsapp_taps: null,
  });
}

// ============================================================
// ROUTE: /leaderboard — top referrers this month
// GET (public — slugs are masked)
// ============================================================

async function handleLeaderboard(request, env) {
  const monthStr = new Date().toISOString().slice(0, 7);
  try {
    const allKeys      = await env.SITES.list({ prefix: `referral:` });
    const monthKeys    = allKeys.keys.filter(k => k.name.endsWith(`:${monthStr}`));
    const slugCounts   = {};
    for (const key of monthKeys) {
      const s = key.name.replace('referral:', '').replace(`:${monthStr}`, '');
      const v = parseInt(await env.SITES.get(key.name).catch(() => '0') || '0');
      slugCounts[s] = (slugCounts[s] || 0) + v;
    }
    const board = Object.entries(slugCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([s, count], i) => ({
        position: i + 1,
        slug:     s.slice(0, 3) + '***', // mask for privacy
        referrals: count,
      }));
    return jsonResponse(board);
  } catch(e) {
    return jsonResponse([]);
  }
}

// ============================================================
// DOMAIN REGISTRATION VIA PROXY
// ============================================================

async function registerDomainViaProxy(slug, env) {
  const data = await callDomainProxy('RegisterDomain', slug, 'co.za', {}, env);
  if (data?.result !== 'success' && data?.result !== 'active') {
    throw new Error(`Registration failed: ${JSON.stringify(data)}`);
  }
  await logActivity(env, 'domain_registered', { domain: `${slug}.co.za`, response: data });
  return data;
}

// ============================================================
// DOMAIN API PROXY — calls websitehub.co.za/domain-proxy.php
// Proxy sits on fixed IP 156.38.165.210, whitelisted with registerdomain.co.za
// DOMAIN_PROXY_SECRET must match the secret in domain-proxy.php
// ============================================================

const DOMAIN_PROXY_URL    = 'https://websitehub.co.za/domain-proxy.php';
const DOMAIN_PROXY_SECRET = 'wh-proxy-d8f3a1b9c2e4f7d6a5b8c3e1f9d2a4b7';

async function callDomainProxy(action, sld, tld = 'co.za', extra = {}, env) {
  try {
    const res = await fetch(DOMAIN_PROXY_URL, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Proxy-Secret':  DOMAIN_PROXY_SECRET,
      },
      body: JSON.stringify({ action, sld, tld, ...extra }),
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
// ZIP EXTRACTION
// ============================================================

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

  return images.sort((a, b) => (b.name.toLowerCase().includes('logo') ? 1 : 0) - (a.name.toLowerCase().includes('logo') ? 1 : 0));
}

// ============================================================
// UTILITIES
// ============================================================

function slugify(name) {
  return (name || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function nextMonthDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type':    'text/html;charset=UTF-8',
      'X-Frame-Options': 'SAMEORIGIN',
      ...extraHeaders,
    },
  });
}

function read32(b, o) { return (b[o] | (b[o+1] << 8) | (b[o+2] << 16) | (b[o+3] << 24)) >>> 0; }
function read16(b, o) { return b[o] | (b[o+1] << 8); }

function getMime(ext) {
  return { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp', gif:'image/gif', svg:'image/svg+xml' }[ext] || 'image/jpeg';
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
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
