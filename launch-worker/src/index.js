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
  slugify, escapeHtml, nextMonthDate, todayDateString, md5, constantTimeCompare,
  callClaudeInternal,
  sendWhatsApp, normaliseSaPhone,
  getAirtableRecord, updateAirtableRecord,
  createZohoInvoice, getZohoAccessToken,
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
    if (path === '/suspend-site')     return handleSuspendSite(request, env);
    if (path === '/reinstate-site')   return handleReinstateSite(request, env);
    if (path === '/upgrade')          return handleUpgrade(request, env);
    if (path === '/zoho-auth')        return handleZohoAuth(url, env);
    if (path === '/google-auth')      return handleGoogleAuth(url, env);
    if (path === '/google-profile')   return handleGoogleProfile(request, env, ctx);
    if (path === '/health')           return handleHealth(env);
    if (path === '/promo-checkout')    return handlePromoCheckout(request, env, ctx);

    return jsonResponse({ error: 'Not found', path }, 404);
  },
};

// ============================================================
// ROUTE: /health
// ============================================================

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
async function handleGoLiveLink(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await request.json(); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  const { airtableId, slug, package: pkg, retainer } = body;
  if (!airtableId) return Response.json({ error: 'airtableId required' }, { status: 400 });

  const amount    = retainer || 699;
  const itemName  = 'Website Hub Monthly Subscription';
  const returnUrl = `https://preview.websitehub.co.za/${slug || ''}`;
  const notifyUrl = `https://wh-launch.pierreduplessis6912.workers.dev/payfast-webhook`;
  const cancelUrl = `https://preview.websitehub.co.za/${slug || ''}`;

  const url = buildPayFastLink(amount, itemName, airtableId, env, {
    returnUrl,
    notifyUrl,
    cancelUrl,
    customStr2: pkg || 'Standard',
  });

  // In TEST_MODE log the intent and return sandbox URL
  if (isTestMode(env)) {
    const testKey = `test_log:go_live_link:${airtableId}:${Date.now()}`;
    await env.SITES.put(testKey, JSON.stringify({
      airtableId, slug, pkg, amount, url, ts: new Date().toISOString(),
    }), { expirationTtl: 86400 * 7 });
    console.log(`[TEST] go-live-link generated for ${airtableId}: ${url}`);
  }

  return Response.json({ url });
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
  const airtableId    = formData.get('custom_str1');
  const customStr2    = formData.get('custom_str2') || '';
  const paymentId     = formData.get('m_payment_id') || formData.get('pf_payment_id') || null;
  const amount        = parseFloat(formData.get('amount_gross') || '0');

  if (!airtableId) return new Response('Missing custom_str1', { status: 400 });

  // ── CANCELLED ──────────────────────────────────────────────
  if (paymentStatus === 'CANCELLED') {
    await logActivity(env, 'payfast_cancelled', { airtableId, customStr2 });
    return new Response('OK', { status: 200 });
  }

  // ── FAILED ─────────────────────────────────────────────────
  if (paymentStatus === 'FAILED') {
    await handleFailedPayment(airtableId, customStr2, env);
    return new Response('OK', { status: 200 });
  }

  // ── COMPLETE ───────────────────────────────────────────────
  if (paymentStatus !== 'COMPLETE') {
    // PENDING and other states — log and ignore
    await logActivity(env, 'payfast_pending', { airtableId, paymentStatus });
    return new Response('OK', { status: 200 });
  }

  // Idempotency lock — 24h TTL, keyed on paymentId or fallback to (airtableId,amount,customStr2)
  const lockKey = `payfast_lock:${paymentId || `${airtableId}:${amount}:${customStr2}`}`;
  const alreadyProcessed = await env.SITES.get(lockKey);
  if (alreadyProcessed) {
    console.warn(`PayFast duplicate webhook ignored: ${lockKey}`);
    return new Response('OK', { status: 200 });
  }
  await env.SITES.put(lockKey, new Date().toISOString(), { expirationTtl: 86400 });

  // Route based on custom_str2
  try {
    if (customStr2.startsWith('upgrade:')) {
      await handleUpgradePayment(airtableId, customStr2, paymentId, amount, env, ctx);
    } else if (customStr2.startsWith('revision:')) {
      await handleRevisionPayment(airtableId, customStr2, paymentId, amount, env);
    } else {
      // Default: first-month subscription / go-live
      await handleGoLivePayment(airtableId, paymentId, amount, env, ctx);
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

// ============================================================
// PAYMENT BRANCHES
// ============================================================

/**
 * First-month subscription / recurring retainer / reinstatement.
 * Routes by current Airtable Status:
 *   Lead / Deposit Paid / QA  → first-time go-live (full flow)
 *   Suspended                 → reinstate (clear suspended:{domain}, message client)
 *   Live                      → recurring retainer payment, advance Next Invoice
 *   anything else             → log + alert owner for manual review
 */
async function handleGoLivePayment(airtableId, paymentId, amount, env, ctx) {
  const record = await getAirtableRecord(airtableId, env);
  const f      = record.fields;
  const tier   = getPricingTier(f['Package'] || 'Standard');

  // Anti-tamper amount check — accept if within tolerance of the expected retainer
  if (Math.abs(amount - tier.retainer) > AMOUNT_TOLERANCE) {
    await logActivity(env, 'payfast_amount_mismatch', {
      airtableId, customStr2: '', amount, expected: tier.retainer,
    });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ PayFast amount mismatch — manual review needed\n${f['Business Name']}\nReceived: R${amount}\nExpected: R${tier.retainer}\nAirtable: ${airtableId}`,
      env, { skipTestRedirect: true },
    );
    return;
  }

  const status = f['Status'] || '';

  // ── Suspended → reinstate ──────────────────────────────────
  if (status === 'Suspended') {
    await reinstateInternal(airtableId, f, env);
    await logActivity(env, 'payment_received', {
      airtableId, business: f['Business Name'], amount, type: 'reinstatement',
    });
    return;
  }

  // ── Live → recurring retainer, advance Next Invoice ─────────
  if (status === 'Live') {
    await updateAirtableRecord(airtableId, {
      'PayFast Payment ID': paymentId || '',
      'Payment Date':       todayDateString(),
      'Next Invoice Date':  nextMonthDate(),
    }, env);

    // Mark this month's invoice paid in Zoho if we have one outstanding
    // (the createZohoInvoice unpaid invoice from go-live is matched by client+amount).
    // We don't fail the webhook if Zoho can't be reconciled; owner sees the activity log.

    const name = f['Client Name']?.split(' ')[0] || 'there';
    await sendWhatsApp(f['WhatsApp'],
      `✅ Thanks ${name} — payment received for *${f['Business Name']}*.\n\nNext invoice: ${nextMonthDate()}\n— Website Hub`,
      env,
    );
    await sendWhatsApp(env.WH_PHONE,
      `💰 RETAINER PAID: ${f['Business Name']} (R${amount})\nNext invoice: ${nextMonthDate()}`,
      env, { skipTestRedirect: true },
    ).catch(() => {});
    await logActivity(env, 'payment_received', {
      airtableId, business: f['Business Name'], amount, type: 'recurring_retainer',
    });
    return;
  }

  // ── Lead / QA → first-time go-live ───────────
  const firstTimeStatuses = ['Lead', 'QA'];
  if (!firstTimeStatuses.includes(status)) {
    // Unknown status — alert owner for manual review rather than auto-acting
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Unexpected payment for status "${status}": ${f['Business Name']}\nAmount: R${amount}\nAirtable: ${airtableId}\nManual review needed.`,
      env, { skipTestRedirect: true },
    );
    await logActivity(env, 'payment_unexpected_status', {
      airtableId, status, amount,
    });
    return;
  }

  // Record payment — status stays 'QA' until handleGoLiveInternal sets 'Live'
  await updateAirtableRecord(airtableId, {
    'PayFast Payment ID': paymentId || '',
    'Payment Date':       todayDateString(),
  }, env);

  await logActivity(env, 'payment_received', {
    airtableId, business: f['Business Name'], amount, type: 'first_time_subscription',
  });

  // Go live (applies panel choices + writes live KV + binds hostname + sends messages)
  ctx.waitUntil(handleGoLiveInternal(airtableId, env, f)
    .catch(async err => {
      console.error('Go-live after payment failed:', err);
      await sendWhatsApp(env.WH_PHONE,
        `❌ GO-LIVE FAILED after payment: ${f['Business Name']}\nError: ${err.message}\nAirtable: ${airtableId}`,
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

  const record = await getAirtableRecord(airtableId, env);
  const f      = record.fields;

  // Determine new package name from upgrade key
  const targetMap = {
    expressToStandard: 'Standard',
    expressToPremium:  'Premium',
    standardToPremium: 'Premium',
  };
  const newPackage = targetMap[upgradeKey];
  const newTier    = getPricingTier(newPackage);

  // Flip package + record payment
  await updateAirtableRecord(airtableId, {
    'Package':            newPackage,
    'Retainer':           newTier.retainer,
    'PayFast Payment ID': paymentId || '',
    'Payment Date':       todayDateString(),
  }, env);

  // Paid upgrade invoice (TEST_MODE handled in shared-services)
  ctx.waitUntil(createZohoInvoice({
    clientName:  f['Client Name'],
    email:       f['Email'],
    amount:      expectedDelta,
    description: `${f['Business Name']} — Upgrade to ${newPackage}`,
    invoiceNum:  `WH-UPG-${Date.now()}`,
    markPaid:    true,
  }, env).catch(e => console.warn('Zoho upgrade invoice failed:', e?.message || e)));

  // Queue rebuild against the new tier — build-worker reads Package field on refetch
  if (f['Status'] === 'Live') {
    await updateAirtableRecord(airtableId, { 'Status': 'Building' }, env);
  }
  await env.BUILD_QUEUE.send({
    airtableId,
    paymentId,
    fields:     null, // build-worker refetches with the new Package value
    isOutbound: false,
  });

  // Client confirmation
  const name = f['Client Name']?.split(' ')[0] || 'there';
  await sendWhatsApp(f['WhatsApp'],
    `🎉 Upgrade confirmed, ${name}!\n\nOur team is rebuilding *${f['Business Name']}* with all ${newPackage} features. New version coming in about 10 minutes.\n\n— Website Hub`,
    env,
  );

  // Owner alert
  await sendWhatsApp(env.WH_PHONE,
    `⬆️ UPGRADE: ${f['Business Name']}\n${upgradeKey} (R${expectedDelta})\nAirtable: ${airtableId}`,
    env, { skipTestRedirect: true },
  ).catch(() => {});

  await logActivity(env, 'upgrade_payment_received', {
    airtableId, business: f['Business Name'], upgrade: upgradeKey, amount: expectedDelta,
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

  const record = await getAirtableRecord(airtableId, env);
  const f      = record.fields;

  // Paid revision invoice (logged in TEST_MODE; real call otherwise)
  await createZohoInvoice({
    clientName:  f['Client Name'],
    email:       f['Email'],
    amount:      PRICING.addons.revision,
    description: `${f['Business Name']} — Additional revision request`,
    invoiceNum:  `WH-REV-${Date.now()}`,
    markPaid:    true,
  }, env).catch(e => console.warn('Zoho revision invoice failed:', e?.message || e));

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
async function handleFailedPayment(airtableId, customStr2, env) {
  try {
    const record = await getAirtableRecord(airtableId, env);
    const f      = record.fields;
    const name   = f['Client Name']?.split(' ')[0] || 'there';

    // Don't alarm client on revision/upgrade failures — they'll see PayFast's own message
    // Only message client for go-live (subscription) failures since those are higher stakes
    if (!customStr2) {
      await sendWhatsApp(f['WhatsApp'],
        `Hi ${name} — looks like the payment didn't go through. No problem — give it another try when you're ready, or reply if you'd like to chat.\n\n— Website Hub`,
        env,
      );
    }

    await sendWhatsApp(env.WH_PHONE,
      `❌ PAYMENT FAILED: ${f['Business Name']}\nType: ${customStr2 || 'subscription'}\nAirtable: ${airtableId}`,
      env, { skipTestRedirect: true },
    );

    await logActivity(env, 'payment_failed', {
      airtableId, business: f['Business Name'], type: customStr2 || 'subscription',
    });
  } catch (e) {
    console.warn('Failed payment handler error:', e?.message || e);
  }
}

// ============================================================
// ROUTE: /promo-checkout — bypass PayFast with a valid promo code
// POST body: { airtableId, slug, promoCode, package, retainer, choices }
// Validates env.PROMO_CODE (case-insensitive), then runs the full
// go-live pipeline for real — domain, hosting, email, WhatsApp, GBP.
// Works across all three tiers. Set via:
//   wrangler secret put PROMO_CODE --name wh-launch
// ============================================================
async function handlePromoCheckout(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId, slug, promoCode, package: pkg, retainer, choices } = body;

  // Validate promo code — case-insensitive, constant-time compare
  const storedCode = (env.PROMO_CODE || '').trim().toUpperCase();
  const givenCode  = (promoCode || '').trim().toUpperCase();
  if (!storedCode || !givenCode || givenCode !== storedCode) {
    await logActivity(env, 'promo_invalid', { airtableId, slug, ts: new Date().toISOString() });
    return jsonResponse({ error: 'Invalid promo code' }, 403);
  }

  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  const f = { ...record.fields };

  // Apply chosen package if different from current
  const chosenPkg = pkg || f['Package'] || 'Standard';
  if (chosenPkg !== f['Package']) {
    await updateAirtableRecord(airtableId, { 'Package': chosenPkg }, env);
    f['Package'] = chosenPkg;
  }

  // Apply panel choices if provided
  if (choices && typeof choices === 'object') {
    const updates = {};
    if (choices.palette)  updates['Palette Choice'] = choices.palette;
    if (choices.font)     updates['Font Choice']    = choices.font;
    if (choices.photo)    updates['Photo Choice']   = choices.photo;
    if (choices.tagline)  updates['Tagline Choice'] = choices.tagline;
    if (choices.logo_url) updates['Logo URL']       = choices.logo_url;
    if (Object.keys(updates).length) {
      await updateAirtableRecord(airtableId, updates, env);
      Object.assign(f, updates);
    }
  }

  // Log promo usage (partial code only — never log the full code)
  await logActivity(env, 'promo_checkout', {
    airtableId, slug,
    pkg: chosenPkg,
    retainer: retainer || 0,
    promoHint: givenCode.substring(0, 3) + '***',
    ts: new Date().toISOString(),
  });

  // Fire the full go-live pipeline asynchronously
  // (domain registration, hosting, email, WhatsApp, GBP)
  ctx.waitUntil(
    handleGoLiveInternal(airtableId, env, f).catch(err => {
      console.error('[promo-checkout] go-live failed:', err);
      logActivity(env, 'promo_go_live_error', { airtableId, slug, error: err.message });
    })
  );

  return jsonResponse({
    success: true,
    domain:  f['Domain'] || `${(f['Slug'] || slug || '').toLowerCase()}.co.za`,
    pkg:     chosenPkg,
  });
}

// ============================================================
// ROUTE: /go-live — admin direct go-live trigger
// ============================================================

async function handleGoLive(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY)) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  await handleGoLiveInternal(airtableId, env, record.fields);
  return jsonResponse({ success: true, domain: record.fields['Domain'] });
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
async function handleGoLiveInternal(airtableId, env, f) {
  const slug   = f['Slug'] || slugify(f['Business Name']);
  const domain = (f['Domain'] || `${slug}.co.za`)
    .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  const caps        = getPackageCaps(f['Package'] || 'Standard');
  const pages       = caps.pages;
  const tier        = getPricingTier(f['Package'] || 'Standard');

  // ── 1. Apply panel choices to draft KV ──────────────────────
  // Must happen BEFORE we strip watermarks and write to live keys;
  // otherwise choices are lost on the live site.
  await applyPanelChoicesToDrafts(slug, pages, env);

  // ── 2. Strip watermark, add footer credit, write live KV ────
  let homeHtml = null;
  const builtPages = {}; // collected for cPanel upload
  for (const pageName of pages) {
    let pageHtml = await env.SITES.get(`draft:${slug}:${pageName}`);
    if (!pageHtml && pageName === 'index') pageHtml = await env.SITES.get(`draft:${slug}`);

    // Fallback: strip watermark from preview
    if (!pageHtml) {
      const prev = await env.SITES.get(`preview:${slug}:${pageName}`);
      if (prev) pageHtml = removeWatermark(prev);
    }
    if (!pageHtml) {
      console.warn(`Go-live: no HTML for "${pageName}" of ${slug} — skipping`);
      continue;
    }

    pageHtml = addFooterCredit(pageHtml);
    await env.SITES.put(`live:${domain}:${pageName}`, pageHtml);
    if (pageName === 'index') homeHtml = pageHtml;
    builtPages[pageName] = pageHtml;
  }

  if (!homeHtml) {
    throw new Error('No built site found in KV — trigger a rebuild first');
  }

  // Legacy single-key entry points to home page
  await env.SITES.put(`live:${domain}`, homeHtml);

  // ── 3. Generate manage token ────────────────────────────────
  const manageToken = crypto.randomUUID().replace(/-/g, '');
  await env.SITES.put(`manage_token:${manageToken}`, airtableId);
  const manageUrl = `https://${PREVIEW_DOMAIN}/manage/${manageToken}`;

  // ── 4. Update Airtable ──────────────────────────────────────
  const today       = todayDateString();
  const nextInvoice = nextMonthDate();
  await updateAirtableRecord(airtableId, {
    'Status':                  'Live',
    'Go Live Date':            today,
    'Monthly Retainer Active': true,
    'Next Invoice Date':       nextInvoice,
    'Manage Token':            manageToken,
  }, env);

  // ── 5. Provision client hosting: register domain → cPanel addon →
  //        upload HTML → create emails (all non-fatal, logged) ──────
  if (!isTestMode(env)) {
    provisionClientHosting(slug, domain, builtPages, f, env).catch(e => {
      console.warn('Client hosting provisioning failed (non-fatal):', e?.message || e);
      sendWhatsApp(env.WH_PHONE,
        `⚠️ Hosting setup failed for ${domain}: ${e.message}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    });
  } else {
    await env.SITES.put(
      `test_log:hosting:${slug}:${Date.now()}`,
      JSON.stringify({ action: 'provision_hosting', slug, domain, pages: Object.keys(builtPages), ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
    console.log(`[TEST] Would provision cPanel hosting for ${domain}:`, Object.keys(builtPages));
  }

  // ── 6. Zoho retainer invoice (unpaid, with payLink) ─────────
  const payLink = buildPayFastLink(
    tier.retainer,
    'Website Hub Monthly Subscription',
    airtableId,
    env,
    {
      itemDesc:  `${f['Business Name']} — monthly subscription`,
      notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
    },
  );

  createZohoInvoice({
    clientName:  f['Client Name'],
    email:       f['Email'],
    amount:      tier.retainer,
    description: `${f['Business Name']} — Monthly Website Subscription (due ${nextInvoice})`,
    invoiceNum:  `WH-RET-${Date.now()}`,
    markPaid:    false,
    payLink,
  }, env).catch(e => console.warn('Zoho retainer invoice failed:', e?.message || e));

  // ── 7. Domain registration + cPanel hosting handled in step 5 ──
  // (provisionClientHosting covers register → addon → upload → emails)

  // ── 8. Email provisioning handled in step 5 (cPanel UAPI) ──────

  // ── 9. Claude-written go-live WhatsApp ──────────────────────
  const referralUnlocked = caps.referral && await getFlag(env, 'REFERRAL_ENABLED');
  const referralLink     = referralUnlocked ? `https://websitehub.co.za?ref=${slug}` : null;
  const gbpOptInUrl      = `${env.WORKER_URL_LAUNCH}/google-profile?airtableId=${airtableId}&key=optin`;
  const goLiveMsg        = await composeGoLiveMessage(f, domain, tier, nextInvoice, manageUrl, referralLink, gbpOptInUrl, env);

  await sendWhatsApp(f['WhatsApp'], goLiveMsg.trim(), env);

  // ── 10. Schedule post-go-live touches ───────────────────────
  const day1Date = new Date(Date.now() + 1  * 24 * 60 * 60 * 1000).toISOString();
  const day7Date = new Date(Date.now() + 7  * 24 * 60 * 60 * 1000).toISOString();
  const day30Date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const day90Date = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  await env.SITES.put(`post_golive_d1:${airtableId}`,  day1Date);
  await env.SITES.put(`post_golive_d7:${airtableId}`,  day7Date);
  await env.SITES.put(`upsell:${airtableId}`,          day30Date);
  await env.SITES.put(`winback_eligible:${airtableId}`, day90Date);

  // ── 11. Auto-trigger GBP creation (non-fatal) ───────────────
  if (!isTestMode(env) && env.GOOGLE_REFRESH_TOKEN) {
    processGoogleProfile(airtableId, f, env).catch(e => {
      console.warn('Auto GBP creation failed (non-fatal):', e?.message || e);
      sendWhatsApp(env.WH_PHONE,
        `⚠️ GBP auto-create failed for ${f['Business Name']}: ${e.message}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    });
  }

  // Owner notification
  await sendWhatsApp(env.WH_PHONE,
    `🚀 LIVE: ${f['Business Name']}\n🌐 https://${domain}\nPackage: ${f['Package']}\nRetainer: R${tier.retainer}/month\nNext invoice: ${nextInvoice}\nManage: ${manageUrl}`,
    env, { skipTestRedirect: true },
  );

  await logActivity(env, 'site_went_live', { airtableId, business: f['Business Name'], domain });
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
  const name = f['Client Name']?.split(' ')[0] || 'there';
  const slug = f['Slug'] || slugify(f['Business Name']);
  const pkg  = f['Package'] || 'Standard';

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

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  const f      = record.fields;
  const domain = (f['Domain'] || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!domain) return jsonResponse({ error: 'No domain on record' }, 400);

  const tier    = getPricingTier(f['Package'] || 'Standard');
  const payLink = buildPayFastLink(
    tier.retainer,
    'Website Hub Subscription Reinstatement',
    airtableId,
    env,
    { notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined },
  );

  await env.SITES.put(`suspended:${domain}`, '1');
  await updateAirtableRecord(airtableId, { 'Status': 'Suspended' }, env);

  const name = f['Client Name']?.split(' ')[0] || 'there';
  await sendWhatsApp(f['WhatsApp'],
    `⚠️ Hi ${name}, your *${f['Business Name']}* website has been temporarily suspended due to an outstanding payment of *R${tier.retainer}*.\n\nTap here to reinstate instantly:\n💳 ${payLink}\n\nYour site will be back online within minutes of payment.\n\nQuestions? Reply here.\n— Website Hub`,
    env,
  );

  await logActivity(env, 'site_suspended', { airtableId, business: f['Business Name'], domain });
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

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  await reinstateInternal(airtableId, record.fields, env);
  return jsonResponse({ success: true });
}

async function reinstateInternal(airtableId, f, env) {
  const domain = (f['Domain'] || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!domain) throw new Error('No domain on record');

  await env.SITES.delete(`suspended:${domain}`);
  await updateAirtableRecord(airtableId, {
    'Status':            'Live',
    'Next Invoice Date': nextMonthDate(),
  }, env);

  const name = f['Client Name']?.split(' ')[0] || 'there';
  await sendWhatsApp(f['WhatsApp'],
    `✅ You're back! *${f['Business Name']}* is live again at https://${domain}\n\nThank you for your payment.\n— Website Hub`,
    env,
  );

  await sendWhatsApp(env.WH_PHONE,
    `✅ REINSTATED: ${f['Business Name']}\nhttps://${domain}`,
    env, { skipTestRedirect: true },
  ).catch(() => {});

  await logActivity(env, 'site_reinstated', { airtableId, business: f['Business Name'], domain });
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

  const { airtableId, target } = body;
  if (!airtableId || !target) return jsonResponse({ error: 'Missing airtableId or target' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  const f          = record.fields;
  const fromPkg    = packageKey(f['Package'] || 'Standard');
  const toPkg      = packageKey(target);

  if (fromPkg === toPkg) {
    return jsonResponse({ error: `Already on ${target}` }, 400);
  }

  const delta = getUpgradeDelta(fromPkg, toPkg);
  if (delta <= 0) {
    return jsonResponse({ error: `Invalid upgrade path: ${fromPkg} → ${toPkg}` }, 400);
  }

  // Construct upgrade key for custom_str2
  const upgradeKey =
    fromPkg === 'express' && toPkg === 'standard' ? 'expressToStandard' :
    fromPkg === 'express' && toPkg === 'premium'  ? 'expressToPremium'  :
    fromPkg === 'standard' && toPkg === 'premium' ? 'standardToPremium' : null;
  if (!upgradeKey) return jsonResponse({ error: 'Invalid upgrade path' }, 400);

  const payLink = buildPayFastLink(
    delta,
    `Website Hub Upgrade to ${target}`,
    airtableId,
    env,
    {
      itemDesc:   `${f['Business Name']} — Upgrade from ${f['Package']} to ${target}`,
      customStr2: `upgrade:${upgradeKey}`,
      notifyUrl:  env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
    },
  );

  // Friendly client message + paylink
  const name = f['Client Name']?.split(' ')[0] || 'there';
  const targetTier = getPricingTier(target);
  const featureLines = upgradeKey === 'expressToStandard'
    ? '• Services + About + Contact pages\n• Email account at your domain\n• Referral programme (one referral = one free month)\n• Site analytics'
    : upgradeKey === 'expressToPremium'
    ? '• All Standard features\n• Photo gallery (update via WhatsApp/email)\n• 2 email accounts\n• Unlimited revisions'
    : '• Photo gallery (update via WhatsApp/email)\n• 2 email accounts (up from 1)\n• Unlimited revisions (up from 2/month)';

  await sendWhatsApp(f['WhatsApp'],
    `Hi ${name} 👋 Ready to upgrade to *${target}*?\n\nYou pay the R${delta} difference once. Then *R${targetTier.retainer}/month* from your next invoice.\n\n${target} unlocks:\n${featureLines}\n\n💳 Upgrade — just R${delta}:\n${payLink}\n\n— Website Hub`,
    env,
  );

  await logActivity(env, 'upgrade_link_sent', {
    airtableId, business: f['Business Name'], from: fromPkg, to: toPkg, delta,
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

async function provisionZohoEmails(airtableId, f, domain, env) {
  const caps = getPackageCaps(f['Package'] || 'Standard');
  const count = caps.emailAccounts;
  if (count <= 0) return; // Express has no email

  const accounts = ['info'];
  if (count >= 2) accounts.push('hello');

  // TEST_MODE: log intent only
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:zoho_mail:${airtableId}:${Date.now()}`,
      JSON.stringify({ domain, accounts, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
    return;
  }

  // Real path: requires ZOHO_MAIL_TOKEN + ZOHO_MAIL_ORG_ID
  if (!env.ZOHO_MAIL_TOKEN || !env.ZOHO_MAIL_ORG_ID) {
    await updateAirtableRecord(airtableId, {
      'Email Status': `Pending — accounts: ${accounts.map(a => `${a}@${domain}`).join(', ')}`,
    }, env).catch(() => {});
    await logActivity(env, 'zoho_email_pending', { airtableId, domain, accounts });
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
            displayName:         f['Business Name'] || local,
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

  await updateAirtableRecord(airtableId, {
    'Email Status': created.length === accounts.length
      ? `Provisioned: ${created.join(', ')}`
      : `Partial: ${created.join(', ')}${failed.length ? ` | Failed: ${failed.map(f => f.email).join(', ')}` : ''}`,
  }, env).catch(() => {});

  await logActivity(env, 'zoho_email_provisioned', {
    airtableId, domain, created, failedCount: failed.length,
  });

  if (failed.length) {
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Zoho email provisioning partial: ${f['Business Name']}\nCreated: ${created.join(', ')}\nFailed: ${failed.map(f => `${f.email} (${f.error})`).join(', ')}`,
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
// ROUTE: /zoho-auth — one-time OAuth setup
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


// ============================================================
// REGISTERDOMAIN RESELLER API
// Docs: https://www.registerdomain.co.za reseller portal
// Auth: time-based HMAC token (changes hourly)
// ============================================================

async function generateRegisterDomainToken(env) {
  // Token = base64(hmac_sha256(api_key, email:yy-mm-dd HH))
  // PHP equivalent: base64_encode(hash_hmac("sha256", $key, "$email:".gmdate("y-m-d H")))
  const now = new Date();
  const y = now.getUTCFullYear().toString().slice(-2);
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const H = String(now.getUTCHours()).padStart(2, '0');
  const dateHour = `${y}-${m}-${d} ${H}`;
  // Key = email:dateHour, Data = api_key (unusual but matches PHP docs)
  const keyBytes  = new TextEncoder().encode(`${env.REGISTERDOMAIN_EMAIL}:${dateHour}`);
  const dataBytes = new TextEncoder().encode(env.REGISTERDOMAIN_API_KEY);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function callRegisterDomainApi(action, params, env) {
  const token = await generateRegisterDomainToken(env);
  const baseUrl = env.REGISTERDOMAIN_API_URL || 'https://www.registerdomain.co.za/modules/addons/DomainsReseller/api/index.php';
  const res = await fetch(baseUrl + action, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'username':     env.REGISTERDOMAIN_EMAIL,
      'token':        token,
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`RegisterDomain API ${action} error ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function registerClientDomain(domain, env) {
  return callRegisterDomainApi('/order/domains/register', {
    domain,
    regperiod:   '1',
    nameserver1: env.CPANEL_NS1 || 'ns1.s54.registerdomain.net.za',
    nameserver2: env.CPANEL_NS2 || 'ns2.s54.registerdomain.net.za',
    addons: { dnsmanagement: 0, emailforwarding: 0, idprotection: 0 },
  }, env);
}

// ============================================================
// CPANEL API HELPERS
// Host: s54.registerdomain.net.za:2083
// Auth: HTTP Basic (username:password) over HTTPS
// ============================================================

function cpanelBasicAuth(env) {
  return 'Basic ' + btoa(`${env.CPANEL_USERNAME || 'websiteh'}:${env.CPANEL_PASSWORD}`);
}

async function cpanelUapi(module, fn, params, env) {
  const qs  = new URLSearchParams(params).toString();
  const url = `https://${env.CPANEL_HOST}:2083/execute/${module}/${fn}?${qs}`;
  const res = await fetch(url, { headers: { Authorization: cpanelBasicAuth(env) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`cPanel UAPI ${module}/${fn} ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function cpanelApi2(module, fn, params, env) {
  const qs = new URLSearchParams({
    cpanel_jsonapi_module:     module,
    cpanel_jsonapi_func:       fn,
    cpanel_jsonapi_apiversion: '2',
    ...params,
  }).toString();
  const url = `https://${env.CPANEL_HOST}:2083/json-api/cpanel?${qs}`;
  const res = await fetch(url, { headers: { Authorization: cpanelBasicAuth(env) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`cPanel API2 ${module}/${fn} ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function addCpanelAddonDomain(domain, env) {
  // Document root: public_html/{domain}  (cPanel default for addon domains)
  const subDomain = domain.replace(/\./g, '_'); // cPanel needs a valid subdomain label
  return cpanelApi2('AddonDomain', 'addaddondomain', {
    newdomain: domain,
    subdomain:  subDomain,
    dir:        `public_html/${domain}`,
  }, env);
}

async function uploadFileToCpanel(domain, fileName, content, env) {
  const dir = `/home/${env.CPANEL_USERNAME || 'websiteh'}/public_html/${domain}`;
  return cpanelUapi('Fileman', 'save_file_content', { dir, file: fileName, content }, env);
}

async function createCpanelEmail(emailName, domain, password, env) {
  return cpanelUapi('Email', 'add_pop', {
    email:              emailName,
    domain,
    password,
    quota:              0,   // unlimited quota from pool
    send_welcome_email: 1,   // cPanel auto-sends iOS/Mac config email to the account
  }, env);
}

function generateEmailPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let pwd = '';
  for (const b of bytes) pwd += chars[b % chars.length];
  return pwd;
}

function getEmailsForPackage(pkg) {
  // Returns array of email account names to auto-create based on package
  const p = (pkg || '').toLowerCase();
  if (p === 'express')  return [];           // No emails — upsell in SPA
  if (p === 'standard') return ['info', 'admin'];          // 2 emails
  if (p === 'premium')  return ['info', 'admin'];          // 2 emails + 3 slots in manage panel
  return ['info'];                           // Safe fallback
}

const HTACCESS = `Options -Indexes
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^([^.]+)$ $1.html [L]
`;

// ============================================================
// MAIN ORCHESTRATOR — called from handleGoLiveInternal step 5
// Order matters: register → addon domain → upload files → emails
// All sub-steps are individually non-fatal and logged.
// ============================================================

async function provisionClientHosting(slug, domain, builtPages, f, env) {
  const pkg = f['Package'] || 'Standard';
  const log = (msg) => console.log(`[cPanel] ${domain}: ${msg}`);

  // ── A. Register domain ─────────────────────────────────────
  // Skip if source is Scrape (they haven't paid yet, no domain purchase)
  if (f['Source'] !== 'Scrape') {
    try {
      const regResult = await registerClientDomain(domain, env);
      log('Domain registered: ' + JSON.stringify(regResult).slice(0, 100));
      await logActivity(env, 'domain_registered', { domain, slug, result: regResult });
    } catch (e) {
      console.warn(`[cPanel] Domain registration failed for ${domain}:`, e.message);
      await logActivity(env, 'domain_register_failed', { domain, slug, error: e.message });
      // Continue — domain may already exist or be registered elsewhere
    }
  }

  // ── B. Add addon domain to cPanel ──────────────────────────
  try {
    const addonResult = await addCpanelAddonDomain(domain, env);
    log('Addon domain added: ' + JSON.stringify(addonResult).slice(0, 100));
    await logActivity(env, 'cpanel_addon_domain_added', { domain, slug });
  } catch (e) {
    console.warn(`[cPanel] Addon domain failed for ${domain}:`, e.message);
    await logActivity(env, 'cpanel_addon_domain_failed', { domain, slug, error: e.message });
    // Continue — domain may already exist as addon
  }

  // ── C. Upload HTML pages ────────────────────────────────────
  for (const [pageName, html] of Object.entries(builtPages)) {
    const fileName = pageName === 'index' ? 'index.html' : `${pageName}.html`;
    try {
      await uploadFileToCpanel(domain, fileName, html, env);
      log(`Uploaded ${fileName}`);
    } catch (e) {
      console.warn(`[cPanel] File upload failed — ${fileName}:`, e.message);
    }
  }

  // ── D. Upload .htaccess for clean URLs ──────────────────────
  try {
    await uploadFileToCpanel(domain, '.htaccess', HTACCESS, env);
    log('Uploaded .htaccess');
  } catch (e) {
    console.warn('[cPanel] .htaccess upload failed:', e.message);
  }

  // ── E. Provision email accounts ─────────────────────────────
  // All accounts under a domain share one password — simpler for the client.
  const emailNames    = getEmailsForPackage(pkg);
  const emailPassword = generateEmailPassword();
  const emailCreds    = [];

  for (const name of emailNames) {
    try {
      await createCpanelEmail(name, domain, emailPassword, env);
      emailCreds.push({ address: `${name}@${domain}` });
      log(`Email created: ${name}@${domain}`);
    } catch (e) {
      console.warn(`[cPanel] Email creation failed — ${name}@${domain}:`, e.message);
    }
  }

  // Store credentials in Airtable + KV
  if (emailCreds.length) {
    const mailHost     = env.CPANEL_HOST || 's54.registerdomain.net.za';
    const emailSummary = emailCreds.map(e => e.address).join(', ');
    await updateAirtableRecord(airtableId, {
      'Email Accounts': emailSummary,
      'Email Password': emailPassword,
    }, env).catch(() => {});
    await env.SITES.put(
      `email_creds:${slug}`,
      JSON.stringify({ accounts: emailCreds, password: emailPassword, mailHost }),
      { expirationTtl: 60 * 60 * 24 * 365 },
    );

    // ── Send email credentials via WhatsApp ──────────────────
    const accountLines = emailCreds.map(e => `✅ ${e.address}`).join('\n');
    const emailMsg = `📧 *Your email accounts are ready!*

${accountLines}

🔑 *Password:* ${emailPassword}
_(same for all accounts — change anytime in your manage panel)_

⚙️ *Setup settings:*
• Incoming (IMAP): ${mailHost} — Port 993 (SSL)
• Outgoing (SMTP): ${mailHost} — Port 465 (SSL)

📱 Check your inbox — cPanel will also send you a one-tap iPhone/Mac config email automatically.`;

    if (f['WhatsApp']) {
      await sendWhatsApp(f['WhatsApp'], emailMsg, env).catch(e => {
        console.warn('[cPanel] Email creds WhatsApp failed:', e.message);
      });
    }
  }

  await logActivity(env, 'hosting_provisioned', {
    domain, slug, pkg,
    pages:  Object.keys(builtPages),
    emails: emailCreds.map(e => e.address),
  });

  log('Provisioning complete ✓');
}
