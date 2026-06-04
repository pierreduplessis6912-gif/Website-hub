// ============================================================
// WEBSITE HUB — launch-worker.js
// Owns: PayFast webhooks (signature + idempotency + explicit routing),
// go-live flow (panel choices → live KV → custom-hostname binding →
// retainer invoice → domain registration → GBP creation → go-live WhatsApp),
// suspend/reinstate, upgrade flow (express→standard, express→premium,
// standard→premium with correct deltas), Zoho email account provisioning,
// Google Business Profile creation/update, one-time OAuth setups.
//
// ROUTES OWNED:
//   POST /payfast-webhook          — PayFast ITN handler (multi-purpose routing)
//   POST /go-live                  — admin direct go-live trigger
//   POST /suspend-site             — suspend non-paying client
//   POST /reinstate-site           — reinstate after manual confirmation
//   POST /upgrade                  — generate upgrade PayFast link (express/std/prm)
//   GET  /zoho-auth                — one-time Zoho OAuth setup
//   GET  /google-auth              — one-time Google Business Profile OAuth
//   POST /google-profile           — create/update GBP for a client
//   GET  /health                   — service health
//
// CRITICAL SUBTLETIES:
//   1. PayFast webhook routes on custom_str2 prefix, not amount-fuzzy-matching:
//      ''                          → first-month subscription / go-live
//      'upgrade:expressToStandard' → tier upgrade
//      'upgrade:expressToPremium'  → tier upgrade
//      'upgrade:standardToPremium' → tier upgrade
//      'revision:{token}'          → paid revision; forward to patch-worker
//      Amount is still cross-checked against the expected value (anti-tamper).
//
//   2. handleGoLiveInternal applies panel choices BEFORE writing live KV.
//      Old code applied them in the webhook handler then went live;
//      direct /go-live calls (admin manual) skipped choices entirely.
//      Now choice-apply is part of the internal function. Single source of truth.
//
//   3. Zoho invoice fires on every billable event:
//      go-live → retainer invoice (unpaid, with payLink)
//      upgrade → upgrade invoice (paid, markPaid=true)
//      revision → revision invoice (paid, markPaid=true)
//
//   4. Cloudflare custom hostname binding happens during go-live so
//      live:{hostname}:{page} KV lookups in build-worker resolve.
//      Non-fatal — failure alerts owner but go-live proceeds.
//
// CROSS-WORKER:
//   POST {WORKER_URL_PATCH}/apply-revision-payment   ← revision ITN forward
//   Queue: env.BUILD_QUEUE.send()                     ← upgrade triggers rebuild
//
// SECRETS:
//   PAYFAST_MERCHANT_ID, PAYFAST_MERCHANT_KEY,
//   PAYFAST_SANDBOX_MERCHANT_ID, PAYFAST_SANDBOX_MERCHANT_KEY,
//   CF_ACCOUNT_ID, CF_API_TOKEN, CF_ZONE_ID,
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN,
//   ZOHO_MAIL_TOKEN, ZOHO_MAIL_ORG_ID (for email provisioning, optional),
//   AIRTABLE_*, ANTHROPIC_KEY, ADMIN_KEY, WH_PHONE
// ============================================================

import {
  PRICING, PACKAGE_CAPS,
  isTestMode, packageKey, getPricingTier, getPackageCaps, getUpgradeDelta, buildPayFastLink,
  jsonResponse, corsResponse, htmlResponse,
  slugify, escapeHtml, nextMonthDate, nextYearDate, todayDateString, md5, constantTimeCompare,
  callClaudeInternal,
  sendWhatsApp, normaliseSaPhone,
  logActivity, logHealth, getFlag,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const PREVIEW_DOMAIN = 'preview.websitehub.co.za';

// Domain proxy — same as build-worker; kept local since launch-worker is the
// only other consumer (during go-live for domain registration)
const DOMAIN_PROXY_URL    = 'https://websitehub.co.za/domain-proxy.php';

// PayFast tolerance for amount comparisons (rounding edge cases on PayFast side)
const AMOUNT_TOLERANCE = 10;

// ────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/payfast-webhook')  return handlePayfastWebhook(request, env, ctx);
    if (path === '/go-live')          return handleGoLive(request, env, ctx);
    if (path === '/go-live-link')     return handleGoLiveLink(request, env, ctx);
    if (path === '/activate-free')    return handleActivateFree(request, env, ctx);
    if (path === '/suspend-site')     return handleSuspendSite(request, env);
    if (path === '/reinstate-site')   return handleReinstateSite(request, env);
    if (path === '/upgrade')          return handleUpgrade(request, env);
    // /zoho-auth removed — Zoho replaced by D1 invoicing + CF Email Routing
    if (path === '/google-auth')      return handleGoogleAuth(url, env);
    if (path === '/google-profile')   return handleGoogleProfile(request, env, ctx);
    if (path === '/health')           return handleHealth(env);
    if (path === '/manage-panel')     return handleManagePanel(request, url, env);
    if (path === '/client-status')    return handleClientStatus(url, env);
    if (path === '/submit-revision')  return handleSubmitRevision(request, env);
    if (path === '/cancel-site')      return handleCancelSite(request, env);

    return jsonResponse({ error: 'Not found', path }, 404);
  },
};

// ============================================================
// ROUTE: /health
// ============================================================


// ── D1 CLIENT HELPERS ─────────────────────────────────────────
async function getClientById(clientId, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE id=? LIMIT 1`).bind(clientId).first();
}
async function getClientBySlug(slug, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE slug=? LIMIT 1`).bind(slug).first();
}
async function updateClient(clientId, fields, env) {
  const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
  const vals = [...Object.values(fields), clientId];
  return env.DB.prepare(`UPDATE clients SET ${sets}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...vals).run();
}

async function handleHealth(env) {
  const services = ['payfast', 'zoho', 'google', 'airtable', 'cloudflare', 'domain_proxy'];
  const health = {};
  for (const svc of services) {
    try {
      const raw = await env.SITES.get(`health:${svc}`);
      health[svc] = raw ? JSON.parse(raw) : { status: 'unknown' };
    } catch { health[svc] = { status: 'unknown' }; }
  }
  return jsonResponse({
    ok: true,
    worker: 'launch-worker',
    time: new Date().toISOString(),
    testMode: isTestMode(env),
    services: health,
  });
}

// ============================================================
// ROUTE: /payfast-webhook — payment confirmation (ITN)
//
// Routes on (payment_status, custom_str2):
//   COMPLETE + ''                          → first-month subscription, go-live
//   COMPLETE + 'upgrade:expressToStandard' → tier upgrade
//   COMPLETE + 'upgrade:expressToPremium'  → tier upgrade
//   COMPLETE + 'upgrade:standardToPremium' → tier upgrade
//   COMPLETE + 'revision:{token}'          → forward to patch-worker
//   CANCELLED                              → log only
//   FAILED                                 → alert owner + client
//
// Idempotency: keyed on (paymentId or airtableId+amount) for 24h.
// Signature: MD5 of sorted query string + passphrase; sandbox uses sandbox passphrase.
// ============================================================

// ── /go-live-link — server-side PayFast link generation (Fix B) ──────────────
// Called by preview-manage.html handleGoLive(). Generates signed PayFast URL
// server-side so signature includes passphrase and sandbox mode is respected.
// ── /manage-panel — dashboard data for manage.html ───────────────────────────
async function handleManagePanel(request, url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'token_required' }, 400);

  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not_found' }, 404);
  if (client.status !== 'live') return jsonResponse({ error: 'not_live', status: client.status }, 403);

  const slug = client.slug;
  const pkg  = (client.package || 'standard').toLowerCase();
  const caps = getPackageCaps(pkg);
  const tier = getPricingTier(pkg);

  // Revisions used this month
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const revRow = await env.DB.prepare(
    `SELECT COUNT(*) as cnt FROM revisions WHERE client_id=? AND created_at>=? AND type='free'`
  ).bind(client.id, monthStart).first().catch(() => ({ cnt: 0 }));
  const revUsed = revRow?.cnt || 0;
  const revLimit = caps.revisionsPerMonth ?? 2;

  // Analytics — visits this month
  const visits  = await getMonthlyVisits(env, client.id).catch(() => 0);
  const waTaps  = 0; // future — track separately

  // Referral data
  const refRow = await env.DB.prepare(
    `SELECT COUNT(*) as sent FROM clients WHERE referral_slug=?`
  ).bind(slug).first().catch(() => ({ sent: 0 }));
  const convRow = await env.DB.prepare(
    `SELECT COUNT(*) as conversions FROM clients WHERE referral_slug=? AND status='live'`
  ).bind(slug).first().catch(() => ({ conversions: 0 }));
  const conversions = convRow?.conversions || 0;
  const creditEarned = conversions * (tier?.retainer || 0);

  // Leaderboard — top 10 by conversions
  const lbRows = await env.DB.prepare(`
    SELECT c.referral_slug as slug, COUNT(*) as conversions
    FROM clients c
    WHERE c.status='live' AND c.referral_slug IS NOT NULL AND c.referral_slug != ''
    GROUP BY c.referral_slug
    ORDER BY conversions DESC
    LIMIT 10
  `).all().catch(() => ({ results: [] }));

  const leaderboard = (lbRows.results || []).map((row, i) => ({
    rank: i + 1,
    name: row.slug,
    conversions: row.conversions,
    credit: row.conversions * (tier?.retainer || 0),
    isYou: row.slug === slug,
  }));
  if (!leaderboard.find(r => r.isYou) && conversions > 0) {
    leaderboard.push({
      rank: leaderboard.length + 1,
      name: slug,
      conversions,
      credit: creditEarned,
      isYou: true,
    });
  }

  // Upgrade offers
  const upgradeOffers = [];
  const planRank = { express:1, standard:2, premium:3 };
  if ((planRank[pkg] || 1) < 2) upgradeOffers.push({ to:'standard', delta: 400 });
  if ((planRank[pkg] || 1) < 3) upgradeOffers.push({ to:'premium',  delta: pkg === 'express' ? 700 : 300 });

  // Email
  const emailActive = caps.email && client.email_provisioned;
  const emailAddress = emailActive ? `hello@${client.domain || slug + '.co.za'}` : null;

  const domain = client.domain || `${slug}.co.za`;
  const liveUrl = `https://${domain}`;

  return jsonResponse({
    businessName:    client.business_name,
    slug,
    domain,
    liveUrl,
    package:         pkg,
    status:          client.status,
    retainer:        tier?.retainer || 0,
    nextInvoiceDate: client.next_invoice_date,
    revisions: {
      used:  revUsed,
      limit: revLimit === -1 ? null : revLimit,
    },
    analytics: { visits, waTaps },
    email: {
      active:  !!emailActive,
      address: emailAddress,
    },
    referral: {
      active:       caps.referral || false,
      link:         `https://websitehub.co.za?ref=${slug}`,
      sent:         refRow?.sent || 0,
      conversions,
      creditEarned,
      leaderboard,
    },
    upgradeOffers,
  });
}

// ── /client-status — lightweight status check for processing screen ───────────
async function handleClientStatus(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'token_required' }, 400);
  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not_found' }, 404);
  return jsonResponse({ status: client.status, slug: client.slug, domain: client.domain });
}

// ── /submit-revision — log revision request ───────────────────────────────────
async function handleSubmitRevision(request, env) {
  const { token, message, type = 'free' } = await request.json().catch(() => ({}));
  if (!token || !message) return jsonResponse({ error: 'missing_fields' }, 400);

  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not_found' }, 404);

  const caps = getPackageCaps(client.package || 'standard');
  const revLimit = caps.revisionsPerMonth ?? 2;

  if (revLimit !== -1) {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const used = await env.DB.prepare(
      `SELECT COUNT(*) as cnt FROM revisions WHERE client_id=? AND created_at>=? AND type='free'`
    ).bind(client.id, monthStart).first().catch(() => ({ cnt: 0 }));
    if ((used?.cnt || 0) >= revLimit) {
      return jsonResponse({ success: false, paymentRequired: true });
    }
  }

  await env.DB.prepare(
    `INSERT INTO revisions (id, client_id, message, type, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', datetime('now'))`
  ).bind(generateUUID(), client.id, message, type).run().catch(() => null);

  await sendWhatsApp(
    env.WH_PHONE,
    `✏️ Revision request\n${client.business_name} (${client.slug})\n\n"${message}"`,
    env
  ).catch(() => null);

  return jsonResponse({ success: true });
}

// ── /cancel-site — flag for cancellation ─────────────────────────────────────
async function handleCancelSite(request, env) {
  const { token } = await request.json().catch(() => ({}));
  if (!token) return jsonResponse({ error: 'token_required' }, 400);

  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not_found' }, 404);

  await updateClient(env, client.id, { status: 'cancellation_requested' });

  await sendWhatsApp(
    env.WH_PHONE,
    `⚠️ Cancellation request\n${client.business_name} (${client.slug})\nPlan: ${client.package}\nRetainer: R${client.retainer}/mo`,
    env
  ).catch(() => null);

  return jsonResponse({ success: true });
}


// ── /activate-free — skip PayFast for 100% promo codes ───────────────────────
async function handleActivateFree(request, env, ctx) {
  if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });

  const { token, plan, promoCode } = await request.json().catch(() => ({}));
  if (!token) return Response.json({ error: 'token required' }, { status: 400 });

  const client = await env.DB.prepare(
    `SELECT * FROM clients WHERE manage_token=? LIMIT 1`
  ).bind(token).first();
  if (!client) return Response.json({ error: 'Client not found' }, { status: 404 });

  const pkg = plan || client.package || 'express';

  // Trigger go-live internally
  ctx.waitUntil(handleGoLiveInternal(client.id, client, env));

  return Response.json({ success: true });
}

async function handleGoLiveLink(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  // Accept token (PWA) — resolve client from D1
  const { token, slug, plan, retainer, billing } = body;
  if (!token) return Response.json({ error: 'token required' }, { status: 400 });

  const client = await env.DB.prepare(
    `SELECT * FROM clients WHERE manage_token=? LIMIT 1`
  ).bind(token).first();
  if (!client) return Response.json({ error: 'Client not found' }, { status: 404 });

  const pkg    = plan || client.package || 'standard';
  const amount = retainer || client.retainer || 399;
  const isAnnual = billing === 'annual';
  const domain = client.domain || `${client.slug}.co.za`;

  const notifyUrl = env.WORKER_URL_LAUNCH
    ? `${env.WORKER_URL_LAUNCH}/payfast-webhook`
    : `https://wh-launch.pierreduplessis6912.workers.dev/payfast-webhook`;

  const returnUrl = `https://preview.websitehub.co.za/manage/${token}`;
  const cancelUrl = `https://preview.websitehub.co.za/manage/${token}`;

  const itemName = isAnnual
    ? 'Website Hub Annual Subscription'
    : 'Website Hub Monthly Subscription';
  const customStr2 = isAnnual ? `${pkg}_annual` : pkg;

  const url = buildPayFastLink(amount, itemName, client.id, env, {
    returnUrl,
    notifyUrl,
    cancelUrl,
    customStr2,
    itemDesc: `${client.business_name} — ${pkg} plan${isAnnual ? ' (annual)' : ''}`,
  });

  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:go_live_link:${client.id}:${Date.now()}`,
      JSON.stringify({ clientId: client.id, slug: client.slug, pkg, amount, url, ts: new Date().toISOString() }),
      { expirationTtl: 86400 * 7 }
    );
  }

  return Response.json({ redirectUrl: url });
}

async function handlePayfastWebhook(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let formData;
  try { formData = await request.formData(); }
  catch { return new Response('Invalid form data', { status: 400 }); }

  const params = {};
  for (const [key, value] of formData.entries()) params[key] = value;

  // Signature verification — use sandbox passphrase in TEST_MODE
  const signature = params['signature'];
  delete params['signature'];

  const passphrase = isTestMode(env)
    ? (env.PAYFAST_SANDBOX_MERCHANT_KEY || '')
    : (env.PAYFAST_MERCHANT_KEY || '');

  const paramString = Object.keys(params).sort()
    .map(k => `${k}=${encodeURIComponent(params[k]).replace(/%20/g, '+')}`)
    .join('&') + `&passphrase=${encodeURIComponent(passphrase)}`;

  const hash = md5(paramString);
  if (hash !== signature) {
    console.warn('PayFast signature mismatch');
    await logHealth(env, 'payfast', 'error', 'signature mismatch');
    return new Response('Invalid signature', { status: 400 });
  }

  const paymentStatus = formData.get('payment_status');
  const clientId      = formData.get('custom_str1'); // D1 client UUID
  const customStr2    = formData.get('custom_str2') || '';
  const paymentId     = formData.get('m_payment_id') || formData.get('pf_payment_id') || null;
  const amount        = parseFloat(formData.get('amount_gross') || '0');

  if (!clientId) return new Response('Missing custom_str1', { status: 400 });

  // ── CANCELLED ──────────────────────────────────────────────
  if (paymentStatus === 'CANCELLED') {
    await logActivity(env, 'payfast_cancelled', { clientId, customStr2 });
    return new Response('OK', { status: 200 });
  }

  // ── FAILED ─────────────────────────────────────────────────
  if (paymentStatus === 'FAILED') {
    await handleFailedPayment(clientId, customStr2, env);
    return new Response('OK', { status: 200 });
  }

  // ── COMPLETE ───────────────────────────────────────────────
  if (paymentStatus !== 'COMPLETE') {
    await logActivity(env, 'payfast_pending', { clientId, paymentStatus });
    return new Response('OK', { status: 200 });
  }

  // Idempotency lock — 24h TTL
  const lockKey = `payfast_lock:${paymentId || `${clientId}:${amount}:${customStr2}`}`;
  const alreadyProcessed = await env.SITES.get(lockKey);
  if (alreadyProcessed) {
    console.warn(`PayFast duplicate webhook ignored: ${lockKey}`);
    return new Response('OK', { status: 200 });
  }
  await env.SITES.put(lockKey, new Date().toISOString(), { expirationTtl: 86400 });

  // Route based on custom_str2
  try {
    if (customStr2.startsWith('upgrade:')) {
      await handleUpgradePayment(clientId, customStr2, paymentId, amount, env, ctx);
    } else if (customStr2.startsWith('revision:')) {
      await handleRevisionPayment(clientId, customStr2, paymentId, amount, env);
    } else {
      // Default: first-month subscription / go-live (monthly or annual)
      await handleGoLivePayment(clientId, paymentId, amount, customStr2, env, ctx);
    }
    await logHealth(env, 'payfast', 'success');
  } catch (err) {
    console.error('PayFast routing error:', err);
    await logHealth(env, 'payfast', 'error', err.message);
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ PayFast webhook error\nAirtable: ${airtableId}\ncustom_str2: "${customStr2}"\nError: ${err.message}`,
      env, { skipTestRedirect: true },
    ).catch(() => {});
  }

  return new Response('OK', { status: 200 });
}


/**
 * First-month subscription / recurring retainer / reinstatement — D1-native.
 * Routes by current D1 client.status:
 *   lead/building/preview_ready/qa → first-time go-live
 *   suspended                      → reinstate
 *   live                           → recurring retainer
 */
async function handleGoLivePayment(clientId, paymentId, amount, customStr2, env, ctx) {
  const client = await env.DB.prepare(
    `SELECT * FROM clients WHERE id=? LIMIT 1`
  ).bind(clientId).first();
  if (!client) {
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ PayFast webhook — client not found: ${clientId}`,
      env, { skipTestRedirect: true }
    ).catch(() => {});
    return;
  }

  const isAnnual = (customStr2 || '').endsWith('_annual');
  const tier = getPricingTier(client.package || 'standard');
  const expectedAmount = isAnnual ? tier.retainer * 10 : tier.retainer;
  const nextInvoice = isAnnual ? nextYearDate() : nextMonthDate();

  if (Math.abs(amount - expectedAmount) > AMOUNT_TOLERANCE) {
    await logActivity(env, 'payfast_amount_mismatch', { clientId, amount, expected: expectedAmount, isAnnual });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ PayFast amount mismatch\n${client.business_name}\nReceived: R${amount}\nExpected: R${expectedAmount}${isAnnual ? ' (annual)' : ''}\nClient: ${clientId}`,
      env, { skipTestRedirect: true },
    );
    return;
  }

  const status = client.status || '';

  if (status === 'suspended') {
    await reinstateInternal(clientId, client, env);
    await logActivity(env, 'payment_received', { clientId, business: client.business_name, amount, type: 'reinstatement' });
    return;
  }

  if (status === 'live') {
    await env.DB.prepare(
      `UPDATE clients SET payfast_payment_id=?, payment_date=?, next_invoice_date=?, billing_cycle=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
    ).bind(paymentId || '', todayDateString(), nextInvoice, isAnnual ? 'annual' : 'monthly', clientId).run();

    await env.DB.prepare(
      `UPDATE invoices SET status='paid', paid_at=datetime('now'), payfast_id=?
       WHERE client_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1`
    ).bind(paymentId || '', clientId).run().catch(() => null);

    const name = client.client_name?.split(' ')[0] || 'there';
    const billingMsg = isAnnual
      ? `Annual subscription confirmed 🎉 Next renewal: ${nextInvoice}`
      : `Next invoice: ${nextInvoice}`;
    await sendWhatsApp(client.phone,
      `✅ Thanks ${name} — payment received for *${client.business_name}*.\n\n${billingMsg}\n— Website Hub`,
      env,
    );
    await sendWhatsApp(env.WH_PHONE,
      `💰 ${isAnnual ? 'ANNUAL' : 'RETAINER'} PAID: ${client.business_name} (R${amount})\nNext invoice: ${nextInvoice}`,
      env, { skipTestRedirect: true },
    ).catch(() => {});
    await logActivity(env, 'payment_received', { clientId, business: client.business_name, amount, type: isAnnual ? 'annual_subscription' : 'recurring_retainer' });
    return;
  }

  const firstTimeStatuses = ['lead','building','preview_ready','qa'];
  if (!firstTimeStatuses.includes(status)) {
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Unexpected payment for status "${status}": ${client.business_name}\nAmount: R${amount}\nClient: ${clientId}`,
      env, { skipTestRedirect: true },
    );
    await logActivity(env, 'payment_unexpected_status', { clientId, status, amount });
    return;
  }

  await env.DB.prepare(
    `UPDATE clients SET payfast_payment_id=?, payment_date=?, billing_cycle=?, next_invoice_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).bind(paymentId || '', todayDateString(), isAnnual ? 'annual' : 'monthly', nextInvoice, clientId).run();

  await logActivity(env, 'payment_received', { clientId, business: client.business_name, amount, type: isAnnual ? 'annual_first_payment' : 'first_time_subscription' });

  ctx.waitUntil(handleGoLiveInternal(clientId, client, env)
    .catch(async err => {
      console.error('Go-live after payment failed:', err);
      await sendWhatsApp(env.WH_PHONE,
        `❌ GO-LIVE FAILED after payment: ${client.business_name}\nError: ${err.message}\nClient: ${clientId}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    }),
  );
}

/**
 * Tier upgrade payment.
 * customStr2 = 'upgrade:expressToStandard' | 'upgrade:expressToPremium' | 'upgrade:standardToPremium'
 * Verifies amount matches the delta for that upgrade, flips Package field,
 * creates paid invoice, and queues a rebuild against the new tier.
 */
async function handleUpgradePayment(airtableId, customStr2, paymentId, amount, env, ctx) {
  const upgradeKey = customStr2.replace(/^upgrade:/, '');
  const validUpgrades = ['expressToStandard', 'expressToPremium', 'standardToPremium'];
  if (!validUpgrades.includes(upgradeKey)) {
    throw new Error(`Unknown upgrade type: ${upgradeKey}`);
  }

  const expectedDelta = PRICING.upgrade[upgradeKey];
  if (Math.abs(amount - expectedDelta) > AMOUNT_TOLERANCE) {
    await logActivity(env, 'payfast_amount_mismatch', {
      airtableId, customStr2, amount, expected: expectedDelta,
    });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Upgrade amount mismatch\nupgrade: ${upgradeKey}\nReceived: R${amount}\nExpected: R${expectedDelta}\nAirtable: ${airtableId}`,
      env, { skipTestRedirect: true },
    );
    return;
  }

  const client = await getClientById(airtableId, env);
  if (!client) throw new Error(`Client not found: ${airtableId}`);

  const targetMap = { expressToStandard:'standard', expressToPremium:'premium', standardToPremium:'premium' };
  const newPackage = targetMap[upgradeKey];
  const newTier    = getPricingTier(newPackage);

  await updateClient(airtableId, {
    package:            newPackage,
    retainer:           newTier.retainer,
    payfast_payment_id: paymentId || '',
    payment_date:       todayDateString(),
    status:             'building',
  }, env);

  ctx.waitUntil(createInvoice({
    clientId:    airtableId,
    clientName:  client.client_name,
    email:       client.email,
    amount:      expectedDelta,
    description: `${client.business_name} — Upgrade to ${newPackage}`,
    invoiceNum:  `WH-UPG-${Date.now()}`,
    type:        'upgrade',
    status:      'paid',
  }, env).catch(e => console.warn('Invoice creation failed:', e?.message || e)));

  await env.BUILD_QUEUE.send({ type: 'pre_build', clientId: airtableId, isOutbound: false });

  const name = client.client_name?.split(' ')[0] || 'there';
  await sendWhatsApp(client.phone,
    `🎉 Upgrade confirmed, ${name}!\n\nWe're rebuilding *${client.business_name}* with all ${newPackage} features. Live in about 10 minutes.\n\n— Website Hub`,
    env,
  );

  await sendWhatsApp(env.WH_PHONE,
    `⬆️ UPGRADE: ${client.business_name}\n${upgradeKey} (R${expectedDelta})\nClient: ${airtableId}`,
    env, { skipTestRedirect: true },
  ).catch(() => {});

  await logActivity(env, 'upgrade_payment_received', {
    clientId: airtableId, business: client.business_name, upgrade: upgradeKey, amount: expectedDelta,
  });
}

/**
 * Paid revision payment. Forwards to patch-worker /apply-revision-payment.
 * Patch-worker owns the pending revision payload + the rebuild trigger;
 * launch-worker's job is just to verify the payment and pass the token.
 */
async function handleRevisionPayment(airtableId, customStr2, paymentId, amount, env) {
  const revToken = customStr2.replace(/^revision:/, '');
  if (!revToken) throw new Error('Empty revision token in custom_str2');

  if (Math.abs(amount - PRICING.addons.revision) > AMOUNT_TOLERANCE) {
    await logActivity(env, 'payfast_amount_mismatch', {
      airtableId, customStr2, amount, expected: PRICING.addons.revision,
    });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Revision amount mismatch\nReceived: R${amount}\nExpected: R${PRICING.addons.revision}\nToken: ${revToken}\nAirtable: ${airtableId}`,
      env, { skipTestRedirect: true },
    );
    return;
  }

  const client = await getClientById(airtableId, env);
  if (!client) throw new Error(`Client not found: ${airtableId}`);

  await createInvoice({
    clientId:    airtableId,
    clientName:  client.client_name,
    email:       client.email,
    amount:      PRICING.addons.revision,
    description: `${client.business_name} — Additional revision request`,
    invoiceNum:  `WH-REV-${Date.now()}`,
    type:        'revision',
    status:      'paid',
  }, env).catch(e => console.warn('Invoice creation failed:', e?.message || e));

  // Forward to patch-worker — it owns the pending revision payload
  const patchUrl = env.WORKER_URL_PATCH;
  if (!patchUrl) {
    throw new Error('WORKER_URL_PATCH not configured — cannot forward revision payment');
  }

  const res = await fetch(`${patchUrl}/apply-revision-payment`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key':  env.ADMIN_KEY,
    },
    body: JSON.stringify({ revisionToken: revToken }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`patch-worker forward failed: ${res.status} — ${errText}`);
  }

  await logActivity(env, 'revision_payment_processed', {
    airtableId, revToken, amount: PRICING.addons.revision,
  });
}

/**
 * Failed payment — friendly client message, owner alert. No state changes.
 */
async function handleFailedPayment(clientId, customStr2, env) {
  try {
    const client = await getClientById(clientId, env);
    if (!client) return;
    const name = client.client_name?.split(' ')[0] || 'there';

    if (!customStr2) {
      await sendWhatsApp(client.phone,
        `Hi ${name} — looks like the payment didn't go through. No problem — give it another try when you're ready, or reply if you'd like to chat.\n\n— Website Hub`,
        env,
      );
    }

    await sendWhatsApp(env.WH_PHONE,
      `❌ PAYMENT FAILED: ${client.business_name}\nType: ${customStr2 || 'subscription'}\nClient: ${clientId}`,
      env, { skipTestRedirect: true },
    );

    await logActivity(env, 'payment_failed', {
      clientId, business: client.business_name, type: customStr2 || 'subscription',
    });
  } catch (e) {
    console.warn('Failed payment handler error:', e?.message || e);
  }
}

// ============================================================
// ROUTE: /go-live — admin direct go-live trigger
// ============================================================

async function handleGoLive(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY)) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, slug, token } = body;
  const id = clientId || (slug ? (await getClientBySlug(slug, env))?.id : null)
           || (token  ? (await env.DB.prepare('SELECT id FROM clients WHERE manage_token=? LIMIT 1').bind(token).first())?.id : null);
  if (!id) return jsonResponse({ error: 'client not found — provide clientId, slug or token' }, 404);

  const client = await getClientById(id, env);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  await handleGoLiveInternal(id, client, env);
  return jsonResponse({ success: true, domain: client.domain || client.slug + '.co.za' });
}

/**
 * Internal go-live function. Single source of truth used by both
 * the manual /go-live route and the PayFast COMPLETE handler.
 *
 * Steps (in order — order matters):
 *   1. Apply panel choices (palette, logo, photo) to every draft KV entry
 *   2. Strip watermark + add footer credit + write to live:{hostname}:{page}
 *   3. Generate manage token, store in KV + Airtable
 *   4. Update Airtable: Status=Live, Go Live Date, Next Invoice Date
 *   5. Bind custom hostname at Cloudflare (non-fatal)
 *   6. Create Zoho retainer invoice (non-fatal in test mode)
 *   7. Register domain via proxy (non-fatal, gated to non-Scrape sources)
 *   8. Provision Zoho email accounts (non-fatal, skeleton)
 *   9. Send Claude-written go-live WhatsApp with manage URL + GBP opt-in
 *  10. Schedule D1/D7/D30 follow-ups + 90-day win-back eligibility
 *  11. Auto-trigger GBP creation (non-fatal)
 */
async function handleGoLiveInternal(clientId, client, env) {
  const slug   = client.slug;
  const domain = (client.domain || `${slug}.co.za`)
    .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  const caps  = getPackageCaps(client.package || 'standard');
  const pages = caps.pages;
  const tier  = getPricingTier(client.package || 'standard');

  // ── 1. Apply panel choices to draft KV ──────────────────────
  await applyPanelChoicesToDrafts(slug, pages, env);

  // ── 2. Strip watermark, write live KV ───────────────────────
  let homeHtml = null;
  for (const pageName of pages) {
    let pageHtml = await env.SITES.get(`draft:${slug}:${pageName}`);
    if (!pageHtml && pageName === 'index') pageHtml = await env.SITES.get(`draft:${slug}`);

    if (!pageHtml) {
      const prev = await env.SITES.get(`preview:${slug}:${pageName}`);
      if (prev) pageHtml = removeWatermark(prev);
    }
    // Fall back to substance build key
    if (!pageHtml) {
      pageHtml = await env.SITES.get(`site:${slug}`);
      if (pageHtml) pageHtml = removeWatermark(pageHtml);
    }
    if (!pageHtml) {
      console.warn(`Go-live: no HTML for "${pageName}" of ${slug} — skipping`);
      continue;
    }

    pageHtml = addFooterCredit(pageHtml);
    await env.SITES.put(`live:${domain}:${pageName}`, pageHtml);
    if (pageName === 'index') homeHtml = pageHtml;
  }

  if (!homeHtml) throw new Error('No built site found in KV — trigger a rebuild first');
  await env.SITES.put(`live:${domain}`, homeHtml);

  // ── 3. Update D1 — status → live ────────────────────────────
  const today       = todayDateString();
  const nextInvoice = nextMonthDate();
  await env.DB.prepare(
    `UPDATE clients SET status='live', go_live_date=?, next_invoice_date=?, domain=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).bind(today, nextInvoice, domain, clientId).run();

  const manageUrl = `https://preview.websitehub.co.za/manage/${client.manage_token}`;

  // ── 4. Cloudflare hostname binding (non-fatal) ───────────────
  bindCustomHostname(domain, env).catch(e => {
    console.warn('CF hostname binding failed:', e?.message || e);
    sendWhatsApp(env.WH_PHONE,
      `⚠️ CF hostname binding failed for ${domain}: ${e.message}`,
      env, { skipTestRedirect: true },
    ).catch(() => {});
  });

  // ── 5. Domain registration (non-fatal) ──────────────────────
  if (!isTestMode(env)) {
    registerDomainViaProxy(slug, env).catch(e => {
      console.warn('Domain registration failed (non-fatal):', e?.message || e);
      sendWhatsApp(env.WH_PHONE,
        `⚠️ Domain reg failed for ${domain}: ${e.message}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    });
  } else {
    await env.SITES.put(
      `test_log:domain:${slug}:${Date.now()}`,
      JSON.stringify({ action: 'register', slug, domain, ts: new Date().toISOString() }),
      { expirationTtl: 86400 * 30 },
    );
  }

  // ── 6. Cloudflare Email Routing (non-fatal) ─────────────────
  if (caps.email && client.email) {
    provisionEmailRouting(domain, client.email, env).catch(e => {
      console.warn('Email routing setup failed (non-fatal):', e?.message || e);
    });
  }

  // ── 7. Go-live WhatsApp to client ────────────────────────────
  const referralLink = caps.referral ? `https://websitehub.co.za?ref=${slug}` : null;
  const name = client.client_name?.split(' ')[0] || 'there';
  const tierLabel = (client.package || 'standard').charAt(0).toUpperCase() + (client.package || 'standard').slice(1);

  let goLiveMsg = `🚀 *${client.business_name}* is live!\n\n`;
  goLiveMsg += `🌐 https://${domain}\n`;
  goLiveMsg += `📱 Manage your site: ${manageUrl}\n\n`;
  goLiveMsg += `💳 Next invoice: R${tier.retainer} due ${nextInvoice}\n`;
  if (referralLink) goLiveMsg += `\n💡 Refer a friend and earn R${tier.retainer} credit:\n${referralLink}\n`;
  goLiveMsg += `\n— Website Hub`;

  await sendWhatsApp(client.phone, goLiveMsg.trim(), env);

  // ── 8. Post go-live touch schedule ──────────────────────────
  await env.SITES.put(`post_golive_d1:${clientId}`,   new Date(Date.now() + 1  * 864e5).toISOString());
  await env.SITES.put(`post_golive_d7:${clientId}`,   new Date(Date.now() + 7  * 864e5).toISOString());
  await env.SITES.put(`upsell:${clientId}`,            new Date(Date.now() + 30 * 864e5).toISOString());
  await env.SITES.put(`winback_eligible:${clientId}`,  new Date(Date.now() + 90 * 864e5).toISOString());

  // ── 9. Owner notification ────────────────────────────────────
  await sendWhatsApp(env.WH_PHONE,
    `🚀 LIVE: ${client.business_name}\n🌐 https://${domain}\nPlan: ${tierLabel}\nR${tier.retainer}/mo · Next: ${nextInvoice}`,
    env, { skipTestRedirect: true },
  );

  await logActivity(env, 'site_went_live', { clientId, business: client.business_name, domain });
  await logHealth(env, 'build', 'success');
}

/**
 * Reads preview_choices:{slug} and bakes them into every per-page draft.
 * Idempotent — re-running on an already-applied draft is harmless.
 */
async function applyPanelChoicesToDrafts(slug, pages, env) {
  const choicesRaw = await env.SITES.get(`preview_choices:${slug}`).catch(() => null);
  if (!choicesRaw) return; // No choices saved — nothing to do

  const choices = JSON.parse(choicesRaw || '{}');
  const keys = [`draft:${slug}`, ...pages.map(p => `draft:${slug}:${p}`)];

  for (const key of keys) {
    let html = await env.SITES.get(key).catch(() => null);
    if (!html) continue;

    if (choices.palette) {
      // Palette choice is baked as a marker CSS variable that the live page reads
      html = html.replace(/<style/i, `<style>:root{--chosen-palette:${choices.palette};}</style>\n<style`);
    }
    if (choices.logo_url) {
      const safeUrl = escapeHtml(choices.logo_url);
      html = html.replace(
        /<img[^>]+id=["']site-logo["'][^>]*>/i,
        `<img id="site-logo" src="${safeUrl}" alt="Logo" style="max-height:60px;">`,
      );
    }

    await env.SITES.put(key, html);
  }
}

/**
 * Strips the watermark bar that build-worker added to outbound previews.
 * Mirrored from build-worker's removeWatermark; kept local to avoid cross-worker imports.
 */
function removeWatermark(html) {
  return html.replace(/<div id="wh-preview-bar"[\s\S]*?<!-- WH_WATERMARK_END -->\n?/, '');
}

/**
 * Adds the "Hosted & managed by Website Hub" footer credit to live pages.
 * Mirrored from build-worker.
 */
function addFooterCredit(html) {
  if (html.includes('websitehub.co.za')) return html;
  return html.replace('</body>',
    `<div style="text-align:center;padding:8px;font-size:11px;color:#999;font-family:Arial,sans-serif;">Hosted & managed by <a href="https://websitehub.co.za" style="color:#999;" target="_blank">Website Hub</a> · 🔒 Secured by Cloudflare</div></body>`,
  );
}

/**
 * Composes the go-live WhatsApp message via Claude with a hard-coded fallback.
 */
async function composeGoLiveMessage(f, domain, tier, nextInvoice, manageUrl, referralLink, gbpOptInUrl, env) {
  const name = client.client_name?.split(' ')[0] || 'there';
  const slug = f['Slug'] || slugify(f['Business Name']);
  const pkg  = client.package || 'Standard';

  try {
    const prompt = `Write a go-live WhatsApp message for a South African small business owner. This is a big moment — their website just went live.

Client first name: ${name}
Business name: ${f['Business Name']}
Industry: ${f['Industry'] || 'small business'}
Area: ${f['Area'] || 'South Africa'}
Live URL: https://${domain}
Package: ${pkg}
Monthly subscription: R${tier.retainer}
Next invoice date: ${nextInvoice}
${referralLink ? `Referral link: ${referralLink}\nReferral benefit: One referral = one free month` : ''}
Email for photos: updates@websitehub.co.za (subject: wh-${slug})
Manage panel link: ${manageUrl}
GBP opt-in: Reply YES to add to Google Maps

Requirements:
- Open with the emotional moment — their site is LIVE
- Include the live URL
- Mention the monthly subscription and next invoice date naturally
- Mention adding photos via email (subject: wh-${slug})
${referralLink ? `- Include the referral link at peak excitement. Frame it: one referral = one free month.` : ''}
- Include the manage panel link
- Include a single line at the end: "📍 Reply YES to also list us on Google Maps."
- Sign off: "— Pierre, Website Hub 🚀"
- Max 200 words. Warm and personal. SA tone.

Write only the message. No labels.`;

    return await callClaudeInternal(
      'You write warm, personal, celebratory go-live messages for South African small business owners. Human tone. This is their big moment.',
      [{ role: 'user', content: prompt }],
      env,
    );
  } catch (e) {
    // Fallback template
    return `🎉 *${f['Business Name']}* is LIVE, ${name}!

Told you — 10 minutes. ⚡

🌐 https://${domain}

Share this with your customers — it's yours now.

Your subscription of *R${tier.retainer}/month* starts today. We'll send a WhatsApp with a payment link when it's due (${nextInvoice}).

📸 Add photos anytime: email updates@websitehub.co.za
Subject: wh-${slug}

🛠 Manage your site anytime:
${manageUrl}

${referralLink ? `👥 One referral = one free month:\n${referralLink}\n\n` : ''}📍 Reply YES to also list us on Google Maps.

— Pierre, Website Hub 🚀`;
  }
}

// ============================================================
// ROUTE: /suspend-site
// ============================================================

async function handleSuspendSite(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY)) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, slug } = body;
  const id = clientId || (slug ? (await getClientBySlug(slug, env))?.id : null);
  if (!id) return jsonResponse({ error: 'Provide clientId or slug' }, 400);

  const client = await getClientById(id, env);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const domain = (client.domain || `${client.slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const tier   = getPricingTier(client.package || 'standard');
  const payLink = buildPayFastLink(
    tier.retainer, 'Website Hub Subscription Reinstatement', id, env,
    { notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined },
  );

  await env.SITES.put(`suspended:${domain}`, '1');
  await updateClient(id, { status: 'suspended' }, env);

  const name = client.client_name?.split(' ')[0] || 'there';
  await sendWhatsApp(client.phone,
    `⚠️ Hi ${name}, your *${client.business_name}* website has been temporarily suspended due to an outstanding payment of *R${tier.retainer}*.\n\nTap here to reinstate instantly:\n💳 ${payLink}\n\nYour site will be back online within minutes of payment.\n\nQuestions? Reply here.\n— Website Hub`,
    env,
  );

  await logActivity(env, 'site_suspended', { clientId: id, business: client.business_name, domain });
  return jsonResponse({ success: true, domain, status: 'suspended' });
}

// ============================================================
// ROUTE: /reinstate-site
// Called by admin after manual confirmation; PayFast retainer payments
// to a Suspended site reinstate automatically via the webhook.
// ============================================================

async function handleReinstateSite(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY)) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, slug } = body;
  const id = clientId || (slug ? (await getClientBySlug(slug, env))?.id : null);
  if (!id) return jsonResponse({ error: 'Provide clientId or slug' }, 400);
  const client = await getClientById(id, env);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);
  await reinstateInternal(id, client, env);
  return jsonResponse({ success: true });
}

async function reinstateInternal(clientId, client, env) {
  const domain = (client.domain || `${client.slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  await env.SITES.delete(`suspended:${domain}`);
  await updateClient(clientId, { status: 'live', next_invoice_date: nextMonthDate() }, env);

  const name = client.client_name?.split(' ')[0] || 'there';
  await sendWhatsApp(client.phone,
    `✅ You're back! *${client.business_name}* is live again at https://${domain}\n\nThank you for your payment.\n— Website Hub`,
    env,
  );

  await sendWhatsApp(env.WH_PHONE,
    `✅ REINSTATED: ${client.business_name}\nhttps://${domain}`,
    env, { skipTestRedirect: true },
  ).catch(() => {});

  await logActivity(env, 'site_reinstated', { clientId, business: client.business_name, domain });
}

// ============================================================
// ROUTE: /upgrade — generate upgrade PayFast link
// Body: { airtableId, target: 'Standard' | 'Premium' }
// Returns: { paymentLink, delta, target }
// The PayFast link carries custom_str2 = 'upgrade:{key}' so the
// webhook routes correctly back to handleUpgradePayment.
// ============================================================

async function handleUpgrade(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, token, target } = body;
  const id = clientId || (token ? (await env.DB.prepare('SELECT id FROM clients WHERE manage_token=? LIMIT 1').bind(token).first())?.id : null);
  if (!id || !target) return jsonResponse({ error: 'Provide clientId/token and target' }, 400);

  const client  = await getClientById(id, env);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const fromPkg = packageKey(client.package || 'standard');
  const toPkg   = packageKey(target);

  if (fromPkg === toPkg) return jsonResponse({ error: `Already on ${target}` }, 400);

  const delta = getUpgradeDelta(fromPkg, toPkg);
  if (delta <= 0) return jsonResponse({ error: `Invalid upgrade path: ${fromPkg} → ${toPkg}` }, 400);

  const upgradeKey =
    fromPkg === 'express' && toPkg === 'standard' ? 'expressToStandard' :
    fromPkg === 'express' && toPkg === 'premium'  ? 'expressToPremium'  :
    fromPkg === 'standard' && toPkg === 'premium' ? 'standardToPremium' : null;
  if (!upgradeKey) return jsonResponse({ error: 'Invalid upgrade path' }, 400);

  const payLink = buildPayFastLink(delta, `Website Hub Upgrade to ${target}`, id, env, {
    itemDesc:   `${client.business_name} — Upgrade from ${client.package} to ${target}`,
    customStr2: `upgrade:${upgradeKey}`,
    notifyUrl:  env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
  });

  const name       = client.client_name?.split(' ')[0] || 'there';
  const targetTier = getPricingTier(target);
  const featureLines = upgradeKey === 'expressToStandard'
    ? '• About section + full services\n• Social links + logo in nav\n• Analytics'
    : upgradeKey === 'expressToPremium'
    ? '• All Standard features\n• Photo gallery\n• Enquiry form + map location\n• Google Business Profile'
    : '• Photo gallery\n• Enquiry form + map location\n• Google Business Profile';

  await sendWhatsApp(client.phone,
    `Hi ${name} 👋 Ready to upgrade to *${target}*?\n\nOne-time R${delta} — then *R${targetTier.retainer}/month*.\n\n${target} unlocks:\n${featureLines}\n\n💳 Upgrade now:\n${payLink}\n\n— Website Hub`,
    env,
  );

  await logActivity(env, 'upgrade_link_sent', {
    clientId: id, business: client.business_name, from: fromPkg, to: toPkg, delta,
  });

  return jsonResponse({ success: true, paymentLink: payLink, delta, target });
}

// ============================================================
// CLOUDFLARE CUSTOM HOSTNAME BINDING
// Binds clientdomain.co.za to the build-worker's zone so the worker
// receives requests for that hostname. Requires the zone (websitehub.co.za)
// to be on Cloudflare and the API token to have Custom Hostnames:Edit permission.
// ============================================================

async function bindCustomHostname(hostname, env) {
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:cf_hostname:${hostname}:${Date.now()}`,
      JSON.stringify({ action: 'bind', hostname, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
    return { test_mode: true, hostname };
  }

  // Domain ownership check: verify domain is in client's Airtable record
  const allowedDomains = await env.SITES.list({ prefix: `live:` }).catch(() => ({ keys: [] }));
  const isKnownDomain = allowedDomains.keys.some(k => k.name.startsWith(`live:${hostname}:`) || k.name === `live:${hostname}`);
  if (!isKnownDomain) {
    console.warn(`Domain ${hostname} not found in KV — skipping CF binding`);
    return { skipped: true, reason: 'domain_not_found_in_kv' };
  }

  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    throw new Error('Cloudflare API not configured (CF_ACCOUNT_ID, CF_API_TOKEN, CF_ZONE_ID)');
  }

  const url = `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`;
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      hostname,
      ssl: {
        method:        'http',
        type:          'dv',
        settings:      { http2: 'on', min_tls_version: '1.2', tls_1_3: 'on' },
        bundle_method: 'ubiquitous',
        wildcard:      false,
      },
    }),
  });

  const data = await res.json();
  if (!res.ok || data.success === false) {
    const errMsg = (data.errors || []).map(e => e.message).join('; ') || `HTTP ${res.status}`;
    await logHealth(env, 'cloudflare', 'error', errMsg);
    throw new Error(`CF custom hostname failed: ${errMsg}`);
  }

  await logHealth(env, 'cloudflare', 'success');
  await logActivity(env, 'cf_hostname_bound', { hostname, id: data.result?.id });
  return data.result;
}

// ============================================================
// DOMAIN REGISTRATION VIA PROXY
// Calls registerdomain.co.za through the websitehub.co.za PHP proxy
// (proxy IP is whitelisted with registrar; worker IPs are not).
// ============================================================

async function registerDomainViaProxy(slug, env) {
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:domain_register:${slug}:${Date.now()}`,
      JSON.stringify({ slug, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
    return { test_mode: true };
  }

  const data = await callDomainProxy('RegisterDomain', slug, 'co.za', {}, env);
  if (data?.result !== 'success' && data?.result !== 'active') {
    throw new Error(`Registration failed: ${JSON.stringify(data)}`);
  }
  await logActivity(env, 'domain_registered', { domain: `${slug}.co.za`, response: data });
  return data;
}

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
// ZOHO EMAIL PROVISIONING — skeleton with TEST_MODE
// Standard: 1 account (info@{domain})
// Premium:  2 accounts (info@ + hello@)
// Express:  0 accounts
//
// NOTE: Real Zoho Mail Admin API requires:
//   — Domain verified in Zoho Mail
//   — Zoho Mail organization ID (env.ZOHO_MAIL_ORG_ID)
//   — Admin OAuth scope (different from Zoho Books refresh token)
//
// Until those are configured, this function records the intent in KV
// and Airtable as Pending so the owner can provision manually. When the
// admin secrets land, this function calls the API automatically.
// ============================================================

async function provisionZohoEmails(clientId, client, domain, env) {
  const caps = getPackageCaps(client.package || 'standard');
  const count = caps.emailAccounts;
  if (count <= 0) return; // Express has no email

  const accounts = ['info'];
  if (count >= 2) accounts.push('hello');

  // TEST_MODE: log intent only
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:zoho_mail:${clientId}:${Date.now()}`,
      JSON.stringify({ domain, accounts, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
    return;
  }

  // Real path: requires ZOHO_MAIL_TOKEN + ZOHO_MAIL_ORG_ID
  if (!env.ZOHO_MAIL_TOKEN || !env.ZOHO_MAIL_ORG_ID) {
    await updateClient(clientId, { email_status: `Pending — ${accounts.map(a => `${a}@${domain}`).join(', ')}` }, env).catch(() => {});
    await logActivity(env, 'zoho_email_pending', { clientId, domain, accounts });
    return;
  }

  const created = [];
  const failed  = [];

  for (const local of accounts) {
    const email = `${local}@${domain}`;
    try {
      const res = await fetch(
        `https://mail.zoho.com/api/organization/${env.ZOHO_MAIL_ORG_ID}/accounts`,
        {
          method:  'POST',
          headers: {
            'Authorization': `Zoho-oauthtoken ${env.ZOHO_MAIL_TOKEN}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            primaryEmailAddress: email,
            password:            generateTempPassword(),
            displayName:         client.business_name || local,
            role:                'member',
          }),
        },
      );
      const data = await res.json();
      if (res.ok && data.status?.code === 200) {
        created.push(email);
      } else {
        failed.push({ email, error: data?.status?.description || `HTTP ${res.status}` });
      }
    } catch (e) {
      failed.push({ email, error: e?.message || 'fetch failed' });
    }
  }

  await updateClient(clientId, { email_status: created.length === accounts.length
    ? `Provisioned: ${created.join(', ')}`
    : `Partial: ${created.join(', ')}` }, env).catch(() => {});

  await logActivity(env, 'zoho_email_provisioned', { clientId, domain, created, failedCount: failed.length });

  if (failed.length) {
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Zoho email provisioning partial: ${client.business_name}\nCreated: ${created.join(', ')}\nFailed: ${failed.map(f => `${f.email} (${f.error})`).join(', ')}`,
      env, { skipTestRedirect: true },
    ).catch(() => {});
  }
}

/** Temporary password for newly-provisioned email accounts. Client resets on first use. */
function generateTempPassword() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  for (const byte of arr) pw += charset[byte % charset.length];
  return pw + '!9'; // append symbols to meet Zoho complexity requirements
}

// ============================================================

// ── CLOUDFLARE EMAIL ROUTING ──────────────────────────────────────────────────
// Sets up email forwarding: hello@{domain} → client's personal email
async function provisionEmailRouting(domain, forwardTo, env) {
  const zoneId  = env.CF_ZONE_ID;
  const cfToken = env.CF_API_TOKEN;
  if (!zoneId || !cfToken) {
    console.warn('CF Email Routing: missing CF_ZONE_ID or CF_API_TOKEN');
    return;
  }

  // Create email routing rule: hello@{domain} → client email
  const emailAddress = `hello@${domain}`;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/email/routing/rules`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        name:    `${domain} routing`,
        enabled: true,
        matchers: [{ type: 'literal', field: 'to', value: emailAddress }],
        actions:  [{ type: 'forward', value: [forwardTo] }],
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) {
    console.warn('CF Email Routing failed:', JSON.stringify(data));
    return;
  }

  await logActivity(env, 'email_routing_provisioned', { domain, emailAddress, forwardTo });
  return emailAddress;
}

// ── D1 INVOICE SYSTEM ─────────────────────────────────────────────────────────
// Creates an invoice record in D1 and sends via Resend
async function createInvoice({ clientId, clientName, email, amount, description, invoiceNum, type = 'retainer', status = 'pending' }, env) {
  // Store in D1
  await env.DB.prepare(`
    INSERT INTO invoices (id, client_id, invoice_num, amount, description, type, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).bind(generateUUID(), clientId, invoiceNum, amount, description, type, status).run().catch(() => null);

  // Send invoice email via Resend if email provided and not test mode
  if (email && !isTestMode(env) && env.RESEND_API_KEY) {
    const invoiceHtml = buildInvoiceHtml({ clientName, amount, description, invoiceNum, status });
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    'invoices@websitehub.co.za',
        to:      [email],
        subject: `${status === 'paid' ? 'Receipt' : 'Invoice'} ${invoiceNum} — Website Hub`,
        html:    invoiceHtml,
      }),
    }).catch(e => console.warn('Resend invoice email failed:', e?.message));
  }
}

function buildInvoiceHtml({ clientName, amount, description, invoiceNum, status }) {
  const isPaid = status === 'paid';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#1a1814">
    <div style="margin-bottom:32px">
      <div style="font-size:24px;font-weight:700;color:#009aa5">Website Hub</div>
      <div style="font-size:13px;color:#8a8780">websitehub.co.za</div>
    </div>
    <div style="background:${isPaid ? '#f0fdf4' : '#f7f6f3'};border:1px solid ${isPaid ? '#bbf7d0' : '#e5e2dc'};border-radius:12px;padding:24px;margin-bottom:24px">
      <div style="font-size:12px;font-weight:700;letter-spacing:1px;color:${isPaid ? '#00a86b' : '#8a8780'};margin-bottom:8px">${isPaid ? 'RECEIPT' : 'INVOICE'} · ${invoiceNum}</div>
      <div style="font-size:32px;font-weight:700;color:#1a1814;margin-bottom:4px">R${amount.toLocaleString()}</div>
      <div style="font-size:14px;color:#8a8780">${description}</div>
    </div>
    <div style="font-size:13px;color:#8a8780;line-height:1.6">
      Hi ${clientName || 'there'},<br><br>
      ${isPaid ? 'Thank you for your payment. This is your receipt.' : 'Please find your invoice attached.'}<br><br>
      Questions? WhatsApp us anytime.<br><br>
      — Website Hub Team
    </div>
  </body></html>`;
}

// ZOHO REMOVED — /zoho-auth — one-time OAuth setup
// Visit this URL once to set up Zoho Books refresh token.
// Step 1: Visit /zoho-auth (no params) → see the consent URL
// Step 2: Click consent URL → sign in with Zoho admin account
// Step 3: Zoho redirects back here with ?code= → exchange for refresh_token
// Step 4: Copy refresh_token, add as ZOHO_REFRESH_TOKEN secret
// ============================================================

async function handleZohoAuth(url, env) {
  const code = url.searchParams.get('code');
  const redirectUri = `https://${url.host}/zoho-auth`;

  if (!code) {
    const consentUrl = `https://accounts.zoho.com/oauth/v2/auth?scope=ZohoBooks.invoices.CREATE,ZohoBooks.contacts.CREATE,ZohoBooks.creditnotes.CREATE&client_id=${env.ZOHO_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&access_type=offline`;
    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:700px">
      <h2>Zoho Books Auth Setup</h2>
      <p>Click this link and sign in with your Zoho admin account:</p>
      <p><a href="${consentUrl}" style="background:#1A1A2E;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">Sign in with Zoho →</a></p>
      <hr style="margin:32px 0">
      <p style="color:#999;font-size:12px">Redirect URI (must be in Zoho API Console → Self Client):<br>
      <code style="background:#f5f5f5;padding:4px 8px;border-radius:4px">${redirectUri}</code></p>
    </body></html>`);
  }

  try {
    const res  = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     env.ZOHO_CLIENT_ID,
        client_secret: env.ZOHO_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    const data = await res.json();
    if (data.refresh_token) {
      return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px"><h2>✅ Success!</h2><p>Add this as <code>ZOHO_REFRESH_TOKEN</code> in Cloudflare:</p><pre style="background:#e8f5e9;padding:16px;border-radius:8px;word-break:break-all">${escapeHtml(data.refresh_token)}</pre></body></html>`);
    }
    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px"><h2>❌ Failed</h2><pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre></body></html>`);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ============================================================
// ROUTE: /google-auth — one-time GBP OAuth setup
// ============================================================

async function handleGoogleAuth(url, env) {
  const code        = url.searchParams.get('code');
  const redirectUri = `https://${url.host}/google-auth`;

  if (!code) {
    const scopes  = 'https://www.googleapis.com/auth/business.manage';
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&access_type=offline` +
      `&prompt=consent`;

    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:700px">
      <h2>Google My Business — One-Time Auth Setup</h2>
      <p>Click this link and sign in with your Google admin account:</p>
      <p><a href="${authUrl}" style="background:#4285f4;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">Sign in with Google →</a></p>
      <hr style="margin:32px 0">
      <p style="color:#999;font-size:12px">Redirect URI (must be in Google Cloud Console → OAuth credentials):<br>
      <code style="background:#f5f5f5;padding:4px 8px;border-radius:4px">${redirectUri}</code></p>
    </body></html>`);
  }

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.refresh_token) {
      return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:700px">
        <h2>✅ Done! Copy your refresh token:</h2>
        <pre style="background:#e8f5e9;padding:16px;border-radius:8px;word-break:break-all;font-size:13px">${escapeHtml(tokenData.refresh_token)}</pre>
        <p style="color:#555">
          1. Copy the token above<br>
          2. Cloudflare → Workers → launch-worker → Settings → Variables → Add Secret<br>
          3. Name: <strong>GOOGLE_REFRESH_TOKEN</strong> — paste your token<br>
          4. Save
        </p>
      </body></html>`);
    }

    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px"><h2>❌ Auth Failed</h2><pre>${escapeHtml(JSON.stringify(tokenData, null, 2))}</pre></body></html>`);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ============================================================
// ROUTE: /google-profile — create/update Google Business Profile
// Two entry modes:
//   POST { airtableId }  with x-admin-key → admin trigger
//   GET  ?airtableId=X&key=optin            → client tap from go-live message
// Both routes call processGoogleProfile asynchronously.
// ============================================================

async function handleGoogleProfile(request, env, ctx) {
  const url = new URL(request.url);

  // Client opt-in via GET (tapped from WhatsApp message)
  if (request.method === 'GET') {
    const airtableId = url.searchParams.get('airtableId');
    const key        = url.searchParams.get('key');
    if (key !== 'optin' || !airtableId) {
      return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px"><h1>Invalid request</h1></body></html>`, 400);
    }

    let record;
    try { record = await getAirtableRecord(airtableId, env); }
    catch { return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px"><h1>Not found</h1></body></html>`, 404); }

    // Run async; respond immediately so client gets the confirmation page
    ctx.waitUntil(
      processGoogleProfile(airtableId, record.fields, env).catch(async err => {
        console.error('GBP opt-in processing failed:', err);
        await sendWhatsApp(env.WH_PHONE,
          `⚠️ GBP processing failed: ${record.fields['Business Name']}\nError: ${err.message}`,
          env, { skipTestRedirect: true },
        ).catch(() => {});
      }),
    );

    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px 20px;background:#f5f5f5">
      <div style="background:#fff;border-radius:12px;padding:40px;max-width:480px;margin:auto;box-shadow:0 4px 24px rgba(0,0,0,.08)">
        <div style="font-size:48px;margin-bottom:16px">📍</div>
        <h1 style="margin:0 0 12px 0;color:#1a1a2e">Got it!</h1>
        <p style="color:#666;line-height:1.6">We're setting up your Google Business Profile now. You'll get a WhatsApp when it's ready — usually a few minutes.</p>
      </div>
    </body></html>`);
  }

  // Admin POST
  if (request.method !== 'POST') return jsonResponse({ error: 'POST or GET only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY)) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  ctx.waitUntil(
    processGoogleProfile(airtableId, record.fields, env).catch(async err => {
      console.error('GBP processing failed:', err);
      await logHealth(env, 'google', 'error', err.message);
      await sendWhatsApp(env.WH_PHONE,
        `⚠️ GOOGLE PROFILE ISSUE: ${record.fields['Business Name']}\nError: ${err.message}\nAirtable: ${airtableId}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    }),
  );

  return jsonResponse({ success: true, message: 'GBP processing started' });
}

/**
 * GBP creation / update flow. Looks for an existing profile by business name;
 * if found, patches the websiteUri to point at the new site. If not, creates
 * a new location with industry-mapped GBP category and SA service area.
 *
 * Postcard verification flow notification is sent to the client when a new
 * profile is created (Google sends a physical postcard within 5–14 days).
 */
async function processGoogleProfile(airtableId, f, env) {
  // TEST_MODE: log intent, skip API call
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:gbp:${airtableId}:${Date.now()}`,
      JSON.stringify({ business: f['Business Name'], domain: f['Domain'], ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
    await logActivity(env, 'test_mode_gbp', { airtableId, business: f['Business Name'] });
    return;
  }

  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) throw new Error('Google access token unavailable — run /google-auth first');

  const bizName    = f['Business Name'] || '';
  const area       = f['Area'] || '';
  const domain     = (f['Domain'] || `${slugify(bizName)}.co.za`)
    .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const phone      = normaliseSaPhone(f['WhatsApp']);
  const clientName = f['Client Name']?.split(' ')[0] || 'there';
  const industry   = f['Industry'] || '';

  // Look up the GBP account
  const accountsRes = await fetch(
    'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  const accountsData = await accountsRes.json();
  const account      = accountsData?.accounts?.[0];
  if (!account) throw new Error('No GBP account found. Create one at business.google.com first.');
  const accountName = account.name;

  // List existing locations to find a match
  const locRes  = await fetch(
    `https://mybusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,websiteUri,phoneNumbers`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  const locData   = await locRes.json();
  const locations = locData?.locations || [];

  const existing = locations.find(loc =>
    loc.title?.toLowerCase().includes(bizName.toLowerCase().split(' ')[0]),
  );

  if (existing) {
    // Update existing
    await fetch(
      `https://mybusinessinformation.googleapis.com/v1/${existing.name}?updateMask=websiteUri`,
      {
        method:  'PATCH',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ websiteUri: `https://${domain}` }),
      },
    );

    await updateAirtableRecord(airtableId, { 'Google Profile Status': 'Claimed' }, env);
    await logHealth(env, 'google', 'success');
    await logActivity(env, 'google_profile_updated', { airtableId, business: bizName, domain });

    await sendWhatsApp(f['WhatsApp'],
      `📍 Great news, ${clientName}! We found your *${bizName}* Google Business Profile and linked it to your new website.\n\nPeople searching for you on Google Maps will now be sent straight to your site. 🗺️\n\n— Website Hub`,
      env,
    );
    await sendWhatsApp(env.WH_PHONE,
      `📍 GOOGLE PROFILE UPDATED: ${bizName}\nWebsite: https://${domain}\nLocation: ${existing.name}`,
      env, { skipTestRedirect: true },
    );

  } else {
    // Create new profile
    const category = industryToGoogleCategory(industry);
    const newLocation = {
      title: bizName,
      storefrontAddress: { regionCode: 'ZA', administrativeArea: area, locality: area },
      websiteUri:   `https://${domain}`,
      phoneNumbers: phone ? { primaryPhone: `+${phone}` } : undefined,
      categories:   { primaryCategory: { name: category } },
      serviceArea:  {
        businessType: 'CUSTOMER_LOCATION_ONLY',
        places:       { placeInfos: [{ name: area, placeId: '' }] },
      },
      regularHours: {
        periods: [
          { openDay: 'MONDAY',    openTime: { hours: 8 }, closeDay: 'MONDAY',    closeTime: { hours: 17 } },
          { openDay: 'TUESDAY',   openTime: { hours: 8 }, closeDay: 'TUESDAY',   closeTime: { hours: 17 } },
          { openDay: 'WEDNESDAY', openTime: { hours: 8 }, closeDay: 'WEDNESDAY', closeTime: { hours: 17 } },
          { openDay: 'THURSDAY',  openTime: { hours: 8 }, closeDay: 'THURSDAY',  closeTime: { hours: 17 } },
          { openDay: 'FRIDAY',    openTime: { hours: 8 }, closeDay: 'FRIDAY',    closeTime: { hours: 17 } },
        ],
      },
    };

    const createRes = await fetch(
      `https://mybusinessinformation.googleapis.com/v1/${accountName}/locations?validateOnly=false`,
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(newLocation),
      },
    );
    const createData = await createRes.json();
    if (!createRes.ok) throw new Error(`GBP create failed: ${JSON.stringify(createData)}`);

    await updateAirtableRecord(airtableId, { 'Google Profile Status': 'Created' }, env);
    await logHealth(env, 'google', 'success');
    await logActivity(env, 'google_profile_created', { airtableId, business: bizName, domain });

    await sendWhatsApp(f['WhatsApp'],
      `📍 Hi ${clientName}! We've created your *${bizName}* Google Business Profile.\n\n*What happens next:*\nGoogle sends a postcard to your business address within 5–14 days. It has a PIN code.\n\nWhen it arrives, tap this link and enter the PIN:\nhttps://business.google.com/verify\n\nOnce verified, *${bizName}* appears on Google Maps. 🗺️\n\n— Website Hub`,
      env,
    );
    await sendWhatsApp(env.WH_PHONE,
      `📍 GOOGLE PROFILE CREATED: ${bizName}\nWebsite: https://${domain}\nStatus: Awaiting postcard verification\nAirtable: ${airtableId}`,
      env, { skipTestRedirect: true },
    );
  }
}

/** Exchanges the GOOGLE_REFRESH_TOKEN for a fresh access token. Returns null on failure. */
async function getGoogleAccessToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return null;
  }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type:    'refresh_token',
      }),
    });
    const data = await res.json();
    return data.access_token || null;
  } catch (e) {
    console.warn('Google token refresh failed:', e);
    return null;
  }
}

/** Maps an industry string to a Google Business Category ID (gcid:*). */
function industryToGoogleCategory(industry) {
  const key = (industry || '').toLowerCase();
  const map = {
    'restaurant':       'gcid:restaurant',
    'food':             'gcid:restaurant',
    'cafe':             'gcid:cafe',
    'hair':             'gcid:hair_salon',
    'salon':            'gcid:beauty_salon',
    'barber':           'gcid:barber_shop',
    'beauty':           'gcid:beauty_salon',
    'nails':            'gcid:nail_salon',
    'spa':              'gcid:spa',
    'gym':              'gcid:gym',
    'fitness':          'gcid:gym',
    'personal trainer': 'gcid:personal_trainer',
    'medical':          'gcid:doctor',
    'dental':           'gcid:dentist',
    'doctor':           'gcid:doctor',
    'clinic':           'gcid:medical_clinic',
    'estate':           'gcid:real_estate_agency',
    'property':         'gcid:real_estate_agency',
    'flooring':         'gcid:flooring_store',
    'tiles':            'gcid:flooring_store',
    'construction':     'gcid:general_contractor',
    'builder':          'gcid:general_contractor',
    'electrical':       'gcid:electrician',
    'electrician':      'gcid:electrician',
    'plumber':          'gcid:plumber',
    'plumbing':         'gcid:plumber',
    'cleaning':         'gcid:house_cleaning_service',
    'automotive':       'gcid:car_repair',
    'car':              'gcid:car_dealer',
    'retail':           'gcid:clothing_store',
    'boutique':         'gcid:clothing_store',
    'kids':             'gcid:tutoring_service',
    'education':        'gcid:tutoring_service',
    'school':           'gcid:school',
    'lawyer':           'gcid:lawyer',
    'accountant':       'gcid:accounting_firm',
    'professional':     'gcid:business_management_consultant',
  };
  for (const [fragment, gcid] of Object.entries(map)) {
    if (key.includes(fragment)) return gcid;
  }
  return 'gcid:establishment';
}

// ============================================================
// End of launch-worker.js
// ============================================================

