// ============================================================
// WEBSITE HUB — launch-worker.js
// Owns: PayFast webhooks (signature + D1 idempotency + routing),
// go-live flow (panel choices → live KV → hostname binding →
// invoice → domain registration → GBP → go-live WhatsApp),
// suspend/reinstate (D1 status field), upgrade flow, email
// provisioning, Google Business Profile, OAuth setups.
//
// ROUTES OWNED:
//   POST /payfast-webhook          — PayFast ITN (multi-purpose routing)
//   POST /go-live-link             — server-side PayFast link generation
//   POST /go-live                  — admin direct go-live trigger
//   POST /suspend-site             — suspend non-paying client
//   POST /reinstate-site           — reinstate after payment
//   POST /upgrade                  — generate upgrade PayFast link
//   GET  /zoho-auth                — one-time Zoho OAuth setup
//   GET  /google-auth              — one-time GBP OAuth setup
//   POST /google-profile           — create/update GBP
//   GET  /health                   — service health
//
// KEY ARCHITECTURE NOTES (v2):
//   — PayFast idempotency: D1 invoices.payfast_payment_id UNIQUE constraint
//     replaces KV payfast_lock:* keys
//   — manage_token stored in D1 clients.manage_token (not KV manage_token:*)
//   — Suspend/reinstate via D1 clients.status = 'suspended'/'live'
//     build-worker.serveLiveSite() checks D1, not KV suspended:* key
//   — Post-go-live scheduling: pulse-worker queries D1 clients.go_live_date
//     No KV post_golive_d*:* scheduling keys needed
//   — Email provisioning writes to D1 email_accounts table
//
// REGISTERDOMAIN GAP (TODO):
//   Domain registration, hosting, and email provisioning are NOT yet
//   implemented — RegisterDomain.co.za API details are pending.
//   D1 fields (domain_status, registerdomain_order_id, hosting_status,
//   email_provisioned_at) are ready. Placeholders log to KV in TEST_MODE.
// ============================================================

import {
  PRICING, PACKAGE_CAPS,
  isTestMode, packageKey, getPricingTier, getPackageCaps, getUpgradeDelta,
  buildPayFastLink, verifyPayFastSignature,
  jsonResponse, corsResponse, htmlResponse,
  slugify, escapeHtml, nextMonthDate, todayDateString, md5, constantTimeCompare,
  callClaudeInternal,
  sendWhatsApp, normaliseSaPhone,
  createZohoInvoice,
  logEvent, getFlag,
  getClientById, getClientBySlug, getClientByToken, updateClient,
  createInvoice, isPaymentDuplicate, markInvoicePaid,
  logMessage, hasMessageBeenSent,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const PREVIEW_DOMAIN   = 'preview.websitehub.co.za';
const DOMAIN_PROXY_URL = 'https://websitehub.co.za/domain-proxy.php';
const AMOUNT_TOLERANCE = 10; // Rands — rounding grace on PayFast side

// ────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/payfast-webhook')  return handlePayfastWebhook(request, env, ctx);
    if (path === '/go-live-link')     return handleGoLiveLink(request, env);
    if (path === '/go-live')          return handleGoLive(request, env, ctx);
    if (path === '/suspend-site')     return handleSuspendSite(request, env);
    if (path === '/reinstate-site')   return handleReinstateSite(request, env);
    if (path === '/upgrade')          return handleUpgrade(request, env);
    if (path === '/zoho-auth')        return handleZohoAuth(url, env);
    if (path === '/google-auth')      return handleGoogleAuth(url, env);
    if (path === '/google-profile')   return handleGoogleProfile(request, env, ctx);
    if (path === '/health')           return handleHealth(env);

    return jsonResponse({ error: 'Not found', path }, 404);
  },
};

// ============================================================
// ROUTE: /health
// ============================================================

async function handleHealth(env) {
  let d1Status = 'unknown';
  try { await env.DB.prepare('SELECT 1').first(); d1Status = 'ok'; }
  catch { d1Status = 'error'; }

  return jsonResponse({
    ok:       true,
    worker:   'launch-worker',
    time:     new Date().toISOString(),
    testMode: isTestMode(env),
    d1:       d1Status,
  });
}

// ============================================================
// ROUTE: /go-live-link — server-side PayFast link generation
// Called by SPA handleGoLive(). Returns signed URL.
// ============================================================

async function handleGoLiveLink(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { token, slug, plan, package: pkgAlias, retainer, billing } = body;
  const pkg    = plan || pkgAlias || 'standard';
  const client = token ? await getClientByToken(env, token) : null;
  if (!client) return jsonResponse({ error: 'not found' }, 404);
  const clientId = client.id;

  const amount = retainer || 699;
  const url    = buildPayFastLink(amount, 'Website Hub Monthly Subscription', clientId, env, {
    returnUrl:  `https://${PREVIEW_DOMAIN}/${slug || ''}`,
    cancelUrl:  `https://${PREVIEW_DOMAIN}/${slug || ''}`,
    notifyUrl:  env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
    customStr2: pkg || 'standard',
  });

  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:go_live_link:${clientId}:${Date.now()}`,
      JSON.stringify({ clientId, slug, pkg, amount, url, ts: new Date().toISOString() }),
      { expirationTtl: 86400 * 7 },
    ).catch(() => {});
  }

  return jsonResponse({ url, redirectUrl: url });
}

// ============================================================
// ROUTE: /payfast-webhook — PayFast ITN handler
//
// Routes on (payment_status, custom_str2):
//   COMPLETE + ''                          → first-month subscription / go-live
//   COMPLETE + 'upgrade:expressToStandard' → tier upgrade
//   COMPLETE + 'upgrade:expressToPremium'  → tier upgrade
//   COMPLETE + 'upgrade:standardToPremium' → tier upgrade
//   COMPLETE + 'revision:{token}'          → forward to patch-worker
//   CANCELLED                              → log only
//   FAILED                                 → alert owner + client
//
// Idempotency: D1 invoices.payfast_payment_id UNIQUE constraint
// Signature: verifyPayFastSignature() from shared-services
// ============================================================

async function handlePayfastWebhook(request, env, ctx) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let formData;
  try { formData = await request.formData(); }
  catch { return new Response('Invalid form data', { status: 400 }); }

  const params = {};
  for (const [key, value] of formData.entries()) params[key] = value;

  // Signature verification using shared-services helper
  const passphrase = isTestMode(env)
    ? (env.PAYFAST_SANDBOX_MERCHANT_KEY || '')
    : (env.PAYFAST_PASSPHRASE || '');

  if (!verifyPayFastSignature(params, passphrase)) {
    console.warn('PayFast signature mismatch');
    await logEvent(env, 'launch', 'payfast_signature_failed', 'failure');
    return new Response('Invalid signature', { status: 400 });
  }

  const paymentStatus = formData.get('payment_status');
  const clientId      = formData.get('custom_str1');
  const customStr2    = formData.get('custom_str2') || '';
  const paymentId     = formData.get('m_payment_id') || formData.get('pf_payment_id') || null;
  const amount        = parseFloat(formData.get('amount_gross') || '0');

  if (!clientId) return new Response('Missing custom_str1', { status: 400 });

  if (paymentStatus === 'CANCELLED') {
    await logEvent(env, 'launch', 'payfast_cancelled', 'warning', { clientId, metadata: { customStr2 } });
    return new Response('OK', { status: 200 });
  }

  if (paymentStatus === 'FAILED') {
    await handleFailedPayment(clientId, customStr2, env);
    return new Response('OK', { status: 200 });
  }

  if (paymentStatus !== 'COMPLETE') {
    await logEvent(env, 'launch', 'payfast_pending', 'warning', { clientId, metadata: { paymentStatus } });
    return new Response('OK', { status: 200 });
  }

  // D1 idempotency check — invoices.payfast_payment_id has UNIQUE constraint
  if (paymentId && await isPaymentDuplicate(env, paymentId)) {
    console.warn(`PayFast duplicate webhook ignored: ${paymentId}`);
    return new Response('OK', { status: 200 });
  }

  try {
    if (customStr2.startsWith('upgrade:')) {
      await handleUpgradePayment(clientId, customStr2, paymentId, amount, env, ctx);
    } else if (customStr2.startsWith('revision:')) {
      await handleRevisionPayment(clientId, customStr2, paymentId, amount, env);
    } else {
      await handleGoLivePayment(clientId, paymentId, amount, env, ctx);
    }
    await logEvent(env, 'launch', 'payfast_complete', 'success', { clientId, metadata: { amount, customStr2 } });
  } catch (err) {
    console.error('PayFast routing error:', err);
    await logEvent(env, 'launch', 'payfast_error', 'failure', { clientId, error: err.message });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ PayFast webhook error\nClient: ${clientId}\ncustom_str2: "${customStr2}"\nError: ${err.message}`,
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
 * Routes by D1 client.status:
 *   suspended              → reinstate
 *   live                   → recurring retainer, advance next_invoice_date
 *   lead / preview_ready   → first-time go-live
 */
async function handleGoLivePayment(clientId, paymentId, amount, env, ctx) {
  const client = await getClientById(env, clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const tier = PRICING[packageKey(client.package || 'standard')];

  if (Math.abs(amount - tier.retainer) > AMOUNT_TOLERANCE) {
    await logEvent(env, 'launch', 'payfast_amount_mismatch', 'warning', {
      clientId, metadata: { amount, expected: tier.retainer },
    });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ PayFast amount mismatch\n${client.business_name}\nReceived: R${amount}\nExpected: R${tier.retainer}\nClient: ${clientId}`,
      env, { skipTestRedirect: true },
    );
    return;
  }

  const status = client.status || '';

  // ── Suspended → reinstate ──────────────────────────────────
  if (status === 'suspended') {
    await reinstateInternal(client, env);
    if (paymentId) {
      await createInvoice(env, clientId, {
        payfast_payment_id: paymentId, amount, type: 'monthly_retainer',
      }).catch(() => {});
      await markInvoicePaid(env, paymentId).catch(() => {});
    }
    await logEvent(env, 'launch', 'payment_received', 'success', {
      clientId, metadata: { amount, type: 'reinstatement' },
    });
    return;
  }

  // ── Live → recurring retainer ─────────────────────────────
  if (status === 'live') {
    const nextInvoice = nextMonthDate();
    await updateClient(env, clientId, {
      next_invoice_date: nextInvoice,
    });

    if (paymentId) {
      await createInvoice(env, clientId, {
        payfast_payment_id: paymentId, amount, type: 'monthly_retainer',
      }).catch(() => {});
      await markInvoicePaid(env, paymentId).catch(() => {});
    }

    const name = (client.client_name || '').split(' ')[0] || 'there';
    await sendWhatsApp(client.phone,
      `✅ Thanks ${name} — payment received for *${client.business_name}*.\n\nNext invoice: ${nextInvoice}\n— Website Hub`,
      env,
    );

    await sendEmail({
      to: client.email,
      subject: `Payment received — ${client.business_name} ✓`,
      touchpoint: 'retainer_paid',
      clientSlug: client.slug,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#111">Payment confirmed ✅</h2>
        <p>Hi ${name},</p>
        <p>We've received your retainer payment for <strong>${client.business_name}</strong>.</p>
        <p>Your next invoice is due: <strong>${nextInvoice}</strong></p>
        <p style="color:#888;font-size:12px">— Website Hub</p>
      </div>`,
    }, env).catch(() => {});
    await sendWhatsApp(env.WH_PHONE,
      `💰 RETAINER PAID: ${client.business_name} (R${amount})\nNext invoice: ${nextInvoice}`,
      env, { skipTestRedirect: true },
    ).catch(() => {});
    await logEvent(env, 'launch', 'payment_received', 'success', {
      clientId, metadata: { amount, type: 'recurring_retainer' },
    });
    return;
  }

  // ── Lead / preview_ready → first-time go-live ────────────
  const firstTimeStatuses = ['lead', 'preview_ready', 'qa_ready', 'building'];
  if (!firstTimeStatuses.includes(status)) {
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Unexpected payment for status "${status}": ${client.business_name}\nAmount: R${amount}\nClient: ${clientId}\nManual review needed.`,
      env, { skipTestRedirect: true },
    );
    await logEvent(env, 'launch', 'payment_unexpected_status', 'warning', {
      clientId, metadata: { status, amount },
    });
    return;
  }

  // Record invoice
  if (paymentId) {
    await createInvoice(env, clientId, {
      payfast_payment_id: paymentId, amount, type: 'go_live',
    }).catch(() => {});
  }

  await logEvent(env, 'launch', 'payment_received', 'success', {
    clientId, metadata: { amount, type: 'first_time_subscription' },
  });

  ctx.waitUntil(
    handleGoLiveInternal(clientId, client, env).catch(async err => {
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
 */
async function handleUpgradePayment(clientId, customStr2, paymentId, amount, env, ctx) {
  const upgradeKey    = customStr2.replace(/^upgrade:/, '');
  const validUpgrades = ['expressToStandard', 'expressToPremium', 'standardToPremium'];
  if (!validUpgrades.includes(upgradeKey)) throw new Error(`Unknown upgrade type: ${upgradeKey}`);

  const expectedDelta = PRICING.upgrade[upgradeKey];
  if (Math.abs(amount - expectedDelta) > AMOUNT_TOLERANCE) {
    await logEvent(env, 'launch', 'payfast_amount_mismatch', 'warning', {
      clientId, metadata: { upgradeKey, amount, expected: expectedDelta },
    });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Upgrade amount mismatch\nupgrade: ${upgradeKey}\nReceived: R${amount}\nExpected: R${expectedDelta}\nClient: ${clientId}`,
      env, { skipTestRedirect: true },
    );
    return;
  }

  const client = await getClientById(env, clientId);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const targetMap = {
    expressToStandard: 'standard',
    expressToPremium:  'premium',
    standardToPremium: 'premium',
  };
  const newPkg  = targetMap[upgradeKey];
  const newTier = PRICING[newPkg];

  await updateClient(env, clientId, { package: newPkg, retainer: newTier.retainer });

  if (paymentId) {
    await createInvoice(env, clientId, {
      payfast_payment_id: paymentId, amount: expectedDelta, type: 'upgrade',
    }).catch(() => {});
    await markInvoicePaid(env, paymentId).catch(() => {});
  }

  ctx.waitUntil(createZohoInvoice({
    clientName:  client.client_name,
    email:       client.email,
    amount:      expectedDelta,
    description: `${client.business_name} — Upgrade to ${newPkg}`,
    invoiceNum:  `WH-UPG-${Date.now()}`,
    markPaid:    true,
  }, env).catch(e => console.warn('Zoho upgrade invoice failed:', e?.message || e)));

  // Queue rebuild against the new tier
  await env.BUILD_QUEUE.send({ type: 'pre_build', clientId, paymentId, isOutbound: false });

  const name = (client.client_name || '').split(' ')[0] || 'there';
  await sendWhatsApp(client.phone,
    `🎉 Upgrade confirmed, ${name}!\n\nOur team is rebuilding *${client.business_name}* with all ${newPkg} features. New version coming in about 10 minutes.\n\n— Website Hub`,
    env,
  );

  await sendEmail({
    to: client.email,
    subject: `Upgrade confirmed — ${client.business_name} is being rebuilt`,
    touchpoint: 'upgrade_confirmed',
    clientSlug: client.slug,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#111">Upgrade confirmed 🎉</h2>
      <p>Hi ${name},</p>
      <p>Your upgrade for <strong>${client.business_name}</strong> to the <strong>${newPkg}</strong> plan is confirmed. We're rebuilding your site with all the new features now — it'll be ready in about 10 minutes.</p>
      <p style="color:#888;font-size:12px">— Website Hub</p>
    </div>`,
  }, env).catch(() => {});
  await sendWhatsApp(env.WH_PHONE,
    `⬆️ UPGRADE: ${client.business_name}\n${upgradeKey} (R${expectedDelta})\nClient: ${clientId}`,
    env, { skipTestRedirect: true },
  ).catch(() => {});

  await logEvent(env, 'launch', 'upgrade_payment_received', 'success', {
    clientId, metadata: { upgrade: upgradeKey, amount: expectedDelta },
  });
}

/**
 * Paid revision — forwards to patch-worker /apply-revision-payment.
 */
async function handleRevisionPayment(clientId, customStr2, paymentId, amount, env) {
  const revToken = customStr2.replace(/^revision:/, '');
  if (!revToken) throw new Error('Empty revision token in custom_str2');

  if (Math.abs(amount - PRICING.addons.revision) > AMOUNT_TOLERANCE) {
    await logEvent(env, 'launch', 'payfast_amount_mismatch', 'warning', {
      clientId, metadata: { amount, expected: PRICING.addons.revision, revToken },
    });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Revision amount mismatch\nReceived: R${amount}\nExpected: R${PRICING.addons.revision}\nToken: ${revToken}`,
      env, { skipTestRedirect: true },
    );
    return;
  }

  const client = await getClientById(env, clientId).catch(() => null);

  if (paymentId) {
    await createInvoice(env, clientId, {
      payfast_payment_id: paymentId, amount: PRICING.addons.revision, type: 'paid_revision',
    }).catch(() => {});
    await markInvoicePaid(env, paymentId).catch(() => {});
  }

  if (client) {
    createZohoInvoice({
      clientName:  client.client_name,
      email:       client.email,
      amount:      PRICING.addons.revision,
      description: `${client.business_name} — Additional revision`,
      invoiceNum:  `WH-REV-${Date.now()}`,
      markPaid:    true,
    }, env).catch(e => console.warn('Zoho revision invoice failed:', e?.message || e));
  }

  const patchUrl = env.WORKER_URL_PATCH;
  if (!patchUrl) throw new Error('WORKER_URL_PATCH not configured');

  const res = await fetch(`${patchUrl}/apply-revision-payment`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
    body:    JSON.stringify({ revisionToken: revToken }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`patch-worker forward failed: ${res.status} — ${errText}`);
  }

  await logEvent(env, 'launch', 'revision_payment_processed', 'success', {
    clientId, metadata: { revToken, amount: PRICING.addons.revision },
  });
}

/**
 * Failed payment — friendly client message, owner alert.
 */
async function handleFailedPayment(clientId, customStr2, env) {
  try {
    const client = await getClientById(env, clientId).catch(() => null);
    const name   = (client?.client_name || '').split(' ')[0] || 'there';

    if (!customStr2 && client?.phone) {
      await sendWhatsApp(client.phone,
        `Hi ${name} — looks like the payment didn't go through. No problem — give it another try when you're ready, or reply if you'd like to chat.\n\n— Website Hub`,
        env,
      );

      await sendEmail({
        to: client?.email,
        subject: `Payment unsuccessful — ${client?.business_name}`,
        touchpoint: 'payment_failed',
        clientSlug: client?.slug,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#111">Payment didn't go through</h2>
          <p>Hi ${name},</p>
          <p>Your payment for <strong>${client?.business_name}</strong> was unsuccessful. No problem — you can try again whenever you're ready.</p>
          <p style="margin:24px 0"><a href="https://preview.websitehub.co.za/manage/${client?.manage_token}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Try Again</a></p>
          <p style="color:#888;font-size:12px">— Website Hub</p>
        </div>`,
      }, env).catch(() => {});
    }

    await sendWhatsApp(env.WH_PHONE,
      `❌ PAYMENT FAILED: ${client?.business_name || clientId}\nType: ${customStr2 || 'subscription'}\nClient: ${clientId}`,
      env, { skipTestRedirect: true },
    );

    await logEvent(env, 'launch', 'payment_failed', 'failure', {
      clientId, metadata: { type: customStr2 || 'subscription' },
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
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY))
    return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  ctx.waitUntil(handleGoLiveInternal(clientId, client, env));
  return jsonResponse({ success: true, domain: client.domain });
}

/**
 * Core go-live flow. Single source of truth for both PayFast webhook
 * and manual /go-live admin trigger.
 *
 * Steps (order matters):
 *   1. Apply panel choices (palette, logo) from D1 to draft KV
 *   2. Strip watermark + add footer credit + write live:{domain}:{page} KV
 *   3. Generate manage token → write to D1 clients.manage_token
 *   4. Update D1: status=live, go_live_date, next_invoice_date, manage_token
 *   5. Cloudflare custom hostname binding (non-fatal)
 *   6. Zoho retainer invoice (non-fatal)
 *   7. Domain registration — TODO: RegisterDomain.co.za API (placeholder)
 *   8. Email provisioning → D1 email_accounts (non-fatal)
 *   9. Claude-written go-live WhatsApp
 *  10. GBP creation (non-fatal)
 *  11. Owner notification
 *
 * Post-go-live sequences (D1/D7/D30) are driven by pulse-worker
 * querying clients.go_live_date — no KV scheduling keys needed.
 */
async function handleGoLiveInternal(clientId, client, env) {
  const slug   = client.slug   || slugify(client.business_name);
  const domain = (client.domain || `${slug}.co.za`)
    .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  const pkg   = packageKey(client.package || 'standard');
  const caps  = PACKAGE_CAPS[pkg];
  const pages = caps.pages;
  const tier  = PRICING[pkg];

  // ── 1. Apply panel choices from D1 to draft KV ──────────────
  await applyPanelChoicesToDrafts(client, slug, pages, env);

  // ── 2. Strip watermark + write live KV ──────────────────────
  let homeHtml = null;
  for (const pageName of pages) {
    let pageHtml = await env.SITES.get(`draft:${slug}:${pageName}`);
    if (!pageHtml && pageName === 'index') pageHtml = await env.SITES.get(`draft:${slug}`);

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
  }

  if (!homeHtml) throw new Error('No built site found in KV — trigger a rebuild first');
  await env.SITES.put(`live:${domain}`, homeHtml);

  // ── 3 + 4. Generate manage token → write to D1 ──────────────
  const manageToken = crypto.randomUUID().replace(/-/g, '');
  const today       = todayDateString();
  const nextInvoice = nextMonthDate();
  const manageUrl   = `https://${PREVIEW_DOMAIN}/manage/${manageToken}`;

  await updateClient(env, clientId, {
    status:                  'live',
    go_live_date:            today,
    monthly_retainer_active: 1,
    next_invoice_date:       nextInvoice,
    manage_token:            manageToken,
    live_url:                `https://${domain}`,
  });

  // ── 5. Cloudflare custom hostname binding (non-fatal) ───────
  bindCustomHostname(domain, env).catch(e => {
    console.warn('CF hostname binding failed:', e?.message || e);
    sendWhatsApp(env.WH_PHONE,
      `⚠️ CF hostname binding failed for ${domain}: ${e.message}`,
      env, { skipTestRedirect: true },
    ).catch(() => {});
  });

  // ── 6. Zoho retainer invoice (non-fatal) ────────────────────
  const payLink = buildPayFastLink(
    tier.retainer, 'Website Hub Monthly Subscription', clientId, env,
    {
      itemDesc:  `${client.business_name} — monthly subscription`,
      notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
    },
  );

  createZohoInvoice({
    clientName:  client.client_name,
    email:       client.email,
    amount:      tier.retainer,
    description: `${client.business_name} — Monthly Website Subscription (due ${nextInvoice})`,
    invoiceNum:  `WH-RET-${Date.now()}`,
    markPaid:    false,
    payLink,
  }, env).catch(e => console.warn('Zoho retainer invoice failed:', e?.message || e));

  // ── 7. Domain registration ────────────────────────────────────
  // TODO: RegisterDomain.co.za API details pending.
  // D1 fields domain_status, registerdomain_order_id, hosting_status are ready.
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:domain:${slug}:${Date.now()}`,
      JSON.stringify({ action: 'register', slug, domain, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
  } else if (client.source !== 'outbound') {
    registerDomainViaProxy(clientId, slug, env).catch(e => {
      console.warn('Domain registration failed (non-fatal):', e?.message || e);
      sendWhatsApp(env.WH_PHONE,
        `⚠️ Domain reg failed for ${domain}: ${e.message}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    });
  }

  // ── 8. Email provisioning → D1 email_accounts (non-fatal) ───
  provisionEmailAccounts(clientId, client, domain, env).catch(e => {
    console.warn('Email provisioning failed (non-fatal):', e?.message || e);
  });

  // ── 9. Claude-written go-live WhatsApp ──────────────────────
  const referralUnlocked = caps.referral && await getFlag(env, 'REFERRAL_ENABLED');
  const referralLink     = referralUnlocked ? `https://websitehub.co.za?ref=${slug}` : null;
  const gbpOptInUrl      = `${env.WORKER_URL_LAUNCH}/google-profile?clientId=${clientId}&key=optin`;
  const goLiveMsg        = await composeGoLiveMessage(client, domain, tier, nextInvoice, manageUrl, referralLink, gbpOptInUrl, env);

  await sendWhatsApp(client.phone, goLiveMsg.trim(), env);
  await logMessage(env, clientId, 'go_live', 'whatsapp').catch(() => {});

  const goLiveName = (client.client_name || '').split(' ')[0] || 'there';
  await sendEmail({
    to: client.email,
    subject: `🎊 ${domain} is LIVE!`,
    touchpoint: 'go_live',
    clientSlug: client.slug,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#111">Your website is live! 🎊</h2>
      <p>Hi ${goLiveName},</p>
      <p><strong>${client.business_name}</strong> is now live on the internet at <a href="https://${domain}">${domain}</a>.</p>
      <p>Your monthly retainer of <strong>R${tier.retainer}</strong> is active. Next invoice: <strong>${nextInvoice}</strong></p>
      <p style="margin:24px 0">
        <a href="https://${domain}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold;margin-right:12px">Visit My Site</a>
        <a href="${manageUrl}" style="color:#111;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold;border:1px solid #111">My Dashboard</a>
      </p>
      <p style="color:#888;font-size:12px">— Website Hub</p>
    </div>`,
  }, env).catch(() => {});

  // ── 10. GBP creation (non-fatal) ────────────────────────────
  if (!isTestMode(env) && env.GOOGLE_REFRESH_TOKEN) {
    processGoogleProfile(clientId, client, env).catch(e => {
      console.warn('Auto GBP creation failed (non-fatal):', e?.message || e);
      sendWhatsApp(env.WH_PHONE,
        `⚠️ GBP auto-create failed for ${client.business_name}: ${e.message}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    });
  }

  // ── 11. Owner notification ────────────────────────────────────
  await sendWhatsApp(env.WH_PHONE,
    `🚀 LIVE: ${client.business_name}\n🌐 https://${domain}\nPackage: ${pkg}\nRetainer: R${tier.retainer}/month\nNext invoice: ${nextInvoice}\nManage: ${manageUrl}`,
    env, { skipTestRedirect: true },
  );

  await logEvent(env, 'launch', 'go_live', 'success', {
    clientId, metadata: { business: client.business_name, domain, pkg },
  });
}

/**
 * Reads palette and logo_url from D1 client record and bakes them into
 * every per-page draft. Replaces old KV preview_choices:* read.
 */
async function applyPanelChoicesToDrafts(client, slug, pages, env) {
  const palette  = client.palette;
  const logoUrl  = client.logo_url;

  if (!palette && !logoUrl) return; // Nothing to apply

  const keys = [`draft:${slug}`, ...pages.map(p => `draft:${slug}:${p}`)];

  for (const key of keys) {
    let html = await env.SITES.get(key).catch(() => null);
    if (!html) continue;

    if (palette) {
      html = html.replace(/<style/i, `<style>:root{--chosen-palette:${palette};}</style>\n<style`);
    }
    if (logoUrl) {
      const safeUrl = escapeHtml(logoUrl);
      html = html.replace(
        /<img[^>]+id=["']site-logo["'][^>]*>/i,
        `<img id="site-logo" src="${safeUrl}" alt="Logo" style="max-height:60px;">`,
      );
    }

    await env.SITES.put(key, html);
  }
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

async function composeGoLiveMessage(client, domain, tier, nextInvoice, manageUrl, referralLink, gbpOptInUrl, env) {
  const name = (client.client_name || '').split(' ')[0] || 'there';
  const slug = client.slug || slugify(client.business_name);
  const pkg  = client.package || 'standard';

  try {
    const prompt = `Write a go-live WhatsApp message for a South African small business owner. This is a big moment — their website just went live.

Client first name: ${name}
Business name: ${client.business_name}
Industry: ${client.industry || 'small business'}
Area: ${client.area || 'South Africa'}
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
${referralLink ? `- Include the referral link. Frame it: one referral = one free month.` : ''}
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
  } catch {
    return `🎉 *${client.business_name}* is LIVE, ${name}!

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
// Sets D1 status = 'suspended'. build-worker.serveLiveSite()
// checks D1 status, no KV suspended:* key needed.
// ============================================================

async function handleSuspendSite(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY))
    return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const domain = (client.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!domain) return jsonResponse({ error: 'No domain on record' }, 400);

  const tier    = PRICING[packageKey(client.package || 'standard')];
  const payLink = buildPayFastLink(
    tier.retainer, 'Website Hub Subscription Reinstatement', clientId, env,
    { notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined },
  );

  await updateClient(env, clientId, { status: 'suspended' });

  const name = (client.client_name || '').split(' ')[0] || 'there';
  await sendWhatsApp(client.phone,
    `⚠️ Hi ${name}, your *${client.business_name}* website has been temporarily suspended due to an outstanding payment of *R${tier.retainer}*.\n\nTap here to reinstate instantly:\n💳 ${payLink}\n\nYour site will be back online within minutes of payment.\n\nQuestions? Reply here.\n— Website Hub`,
    env,
  );

  await sendEmail({
    to: client.email,
    subject: `${client.business_name} — site suspended`,
    touchpoint: 'site_suspended',
    clientSlug: client.slug,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#c00">Site suspended ⚠️</h2>
      <p>Hi ${name},</p>
      <p>Your <strong>${client.business_name}</strong> website has been temporarily suspended due to an outstanding payment of <strong>R${tier.retainer}</strong>.</p>
      <p>Your data is safe — your site comes back online within minutes of payment.</p>
      <p style="margin:24px 0"><a href="${payLink}" style="background:#c00;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Reinstate Now — R${tier.retainer}</a></p>
      <p style="color:#888;font-size:12px">— Website Hub</p>
    </div>`,
  }, env).catch(() => {});

  await logEvent(env, 'launch', 'suspension', 'success', {
    clientId, metadata: { business: client.business_name, domain },
  });
  return jsonResponse({ success: true, domain, status: 'suspended' });
}

// ============================================================
// ROUTE: /reinstate-site
// ============================================================

async function handleReinstateSite(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY))
    return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  await reinstateInternal(client, env);
  return jsonResponse({ success: true });
}

async function reinstateInternal(client, env) {
  const domain = (client.domain || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  if (!domain) throw new Error('No domain on record');

  await updateClient(env, client.id, {
    status:            'live',
    next_invoice_date: nextMonthDate(),
  });

  const name = (client.client_name || '').split(' ')[0] || 'there';
  await sendWhatsApp(client.phone,
    `✅ You're back! *${client.business_name}* is live again at https://${domain}\n\nThank you for your payment.\n— Website Hub`,
    env,
  );

  const reinName = (client.client_name || '').split(' ')[0] || 'there';
  await sendEmail({
    to: client.email,
    subject: `Welcome back — ${client.business_name} is live again ✓`,
    touchpoint: 'reinstated',
    clientSlug: client.slug,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#111">You're back online ✅</h2>
      <p>Hi ${reinName},</p>
      <p><strong>${client.business_name}</strong> is live again at <a href="https://${domain}">${domain}</a>. Thank you for your payment.</p>
      <p style="margin:24px 0"><a href="https://${domain}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Visit My Site</a></p>
      <p style="color:#888;font-size:12px">— Website Hub</p>
    </div>`,
  }, env).catch(() => {});
  await sendWhatsApp(env.WH_PHONE,
    `✅ REINSTATED: ${client.business_name}\nhttps://${domain}`,
    env, { skipTestRedirect: true },
  ).catch(() => {});

  await logEvent(env, 'launch', 'reactivation', 'success', {
    clientId: client.id, metadata: { business: client.business_name, domain },
  });
}

// ============================================================
// ROUTE: /upgrade — generate upgrade PayFast link
// ============================================================

async function handleUpgrade(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, target } = body;
  if (!clientId || !target) return jsonResponse({ error: 'Missing clientId or target' }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const fromPkg = packageKey(client.package || 'standard');
  const toPkg   = packageKey(target);

  if (fromPkg === toPkg) return jsonResponse({ error: `Already on ${target}` }, 400);

  const delta = getUpgradeDelta(fromPkg, toPkg);
  if (delta <= 0) return jsonResponse({ error: `Invalid upgrade path: ${fromPkg} → ${toPkg}` }, 400);

  const upgradeKey =
    fromPkg === 'express'  && toPkg === 'standard' ? 'expressToStandard' :
    fromPkg === 'express'  && toPkg === 'premium'  ? 'expressToPremium'  :
    fromPkg === 'standard' && toPkg === 'premium'  ? 'standardToPremium' : null;
  if (!upgradeKey) return jsonResponse({ error: 'Invalid upgrade path' }, 400);

  const payLink = buildPayFastLink(delta, `Website Hub Upgrade to ${toPkg}`, clientId, env, {
    itemDesc:   `${client.business_name} — Upgrade from ${fromPkg} to ${toPkg}`,
    customStr2: `upgrade:${upgradeKey}`,
    notifyUrl:  env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
  });

  const name       = (client.client_name || '').split(' ')[0] || 'there';
  const targetTier = PRICING[toPkg];
  const featureLines = upgradeKey === 'expressToStandard'
    ? '• Services + About + Contact pages\n• Email account at your domain\n• Referral programme (one referral = one free month)\n• Site analytics'
    : upgradeKey === 'expressToPremium'
    ? '• All Standard features\n• Photo gallery (update via WhatsApp/email)\n• 2 email accounts\n• Unlimited revisions'
    : '• Photo gallery (update via WhatsApp/email)\n• 2 email accounts (up from 1)\n• Unlimited revisions (up from 2/month)';

  await sendWhatsApp(client.phone,
    `Hi ${name} 👋 Ready to upgrade to *${toPkg}*?\n\nYou pay the R${delta} difference once. Then *R${targetTier.retainer}/month* from your next invoice.\n\n${toPkg} unlocks:\n${featureLines}\n\n💳 Upgrade — just R${delta}:\n${payLink}\n\n— Website Hub`,
    env,
  );

  await sendEmail({
    to: client.email,
    subject: `Upgrade to ${toPkg} — R${delta} once-off`,
    touchpoint: 'upgrade_link',
    clientSlug: client.slug,
    html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#111">Ready to upgrade? 👋</h2>
      <p>Hi ${name},</p>
      <p>Upgrade <strong>${client.business_name}</strong> to <strong>${toPkg}</strong> for just <strong>R${delta}</strong> once-off, then <strong>R${targetTier.retainer}/month</strong> from your next invoice.</p>
      <p><strong>${toPkg} unlocks:</strong><br><span style="white-space:pre-line">${featureLines}</span></p>
      <p style="margin:24px 0"><a href="${payLink}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Upgrade Now — R${delta}</a></p>
      <p style="color:#888;font-size:12px">— Website Hub</p>
    </div>`,
  }, env).catch(() => {});

  await logEvent(env, 'launch', 'upgrade_link_sent', 'success', {
    clientId, metadata: { from: fromPkg, to: toPkg, delta },
  });

  return jsonResponse({ success: true, paymentLink: payLink, delta, target: toPkg });
}

// ============================================================
// CLOUDFLARE CUSTOM HOSTNAME BINDING
// ============================================================

async function bindCustomHostname(hostname, env) {
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:cf_hostname:${hostname}:${Date.now()}`,
      JSON.stringify({ action: 'bind', hostname, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    return { test_mode: true, hostname };
  }

  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    throw new Error('Cloudflare API not configured (CF_ACCOUNT_ID, CF_API_TOKEN, CF_ZONE_ID)');
  }

  const res  = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        hostname,
        ssl: {
          method: 'http', type: 'dv',
          settings: { http2: 'on', min_tls_version: '1.2', tls_1_3: 'on' },
          bundle_method: 'ubiquitous', wildcard: false,
        },
      }),
    },
  );
  const data = await res.json();
  if (!res.ok || data.success === false) {
    const errMsg = (data.errors || []).map(e => e.message).join('; ') || `HTTP ${res.status}`;
    await logEvent(env, 'launch', 'hostname_bound', 'failure', { error: errMsg });
    throw new Error(`CF custom hostname failed: ${errMsg}`);
  }

  await logEvent(env, 'launch', 'hostname_bound', 'success', { metadata: { hostname, id: data.result?.id } });
  return data.result;
}

// ============================================================
// DOMAIN REGISTRATION — TODO: RegisterDomain.co.za API
// Current implementation uses the PHP proxy as placeholder.
// When RegisterDomain API details arrive, update:
//   1. This function to call their API directly
//   2. updateClient() to set domain_status and registerdomain_order_id
//   3. Add hosting provisioning call
// ============================================================

async function registerDomainViaProxy(clientId, slug, env) {
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:domain_register:${slug}:${Date.now()}`,
      JSON.stringify({ slug, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    return { test_mode: true };
  }

  // TODO: Replace with direct RegisterDomain.co.za API call
  const data = await callDomainProxy('RegisterDomain', slug, 'co.za', {}, env);
  if (data?.result !== 'success' && data?.result !== 'active') {
    throw new Error(`Registration failed: ${JSON.stringify(data)}`);
  }

  // Update D1 domain_status
  await updateClient(env, clientId, {
    domain_status:               'registered',
    registerdomain_order_id:     data?.order_id || null,
  }).catch(() => {});

  await logEvent(env, 'launch', 'domain_registered', 'success', {
    clientId, metadata: { domain: `${slug}.co.za` },
  });
  return data;
}

async function callDomainProxy(action, sld, tld = 'co.za', extra = {}, env) {
  const secret = env.DOMAIN_PROXY_SECRET || '';
  const res    = await fetch(DOMAIN_PROXY_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': secret },
    body:    JSON.stringify({ action, sld, tld, ...extra }),
  });
  const data = await res.json();
  await logEvent(env, 'launch', 'domain_proxy', res.ok ? 'success' : 'failure', { error: data?.error });
  return data;
}

// ============================================================
// EMAIL PROVISIONING — TODO: RegisterDomain.co.za API
// Writes intent to D1 email_accounts table.
// When RegisterDomain API details arrive, add actual provisioning call here.
// ============================================================

async function provisionEmailAccounts(clientId, client, domain, env) {
  const caps   = PACKAGE_CAPS[packageKey(client.package || 'standard')];
  const count  = caps.emailAccounts;
  if (count <= 0) return; // Express has no email

  const accounts = ['info'];
  if (count >= 2) accounts.push('hello');

  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:email_accounts:${clientId}:${Date.now()}`,
      JSON.stringify({ domain, accounts, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    return;
  }

  // TODO: Wire RegisterDomain.co.za email provisioning API here
  // For now, write pending records to D1 email_accounts table
  for (const local of accounts) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO email_accounts (client_id, address, status, is_primary)
       VALUES (?, ?, 'pending', ?)`
    ).bind(clientId, `${local}@${domain}`, local === 'info' ? 1 : 0).run().catch(() => {});
  }

  await updateClient(env, clientId, {
    email_provisioned_at: new Date().toISOString(),
  }).catch(() => {});

  await logEvent(env, 'launch', 'email_provisioned', 'success', {
    clientId, metadata: { domain, accounts, note: 'pending_registerdomain_api' },
  });
}

function generateTempPassword() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let pw = '';
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  for (const byte of arr) pw += charset[byte % charset.length];
  return pw + '!9';
}

// ============================================================
// ROUTE: /zoho-auth — one-time OAuth setup
// ============================================================

async function handleZohoAuth(url, env) {
  const code        = url.searchParams.get('code');
  const redirectUri = `https://${url.host}/zoho-auth`;

  if (!code) {
    const consentUrl = `https://accounts.zoho.com/oauth/v2/auth?scope=ZohoBooks.invoices.CREATE,ZohoBooks.contacts.CREATE,ZohoBooks.creditnotes.CREATE&client_id=${env.ZOHO_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&access_type=offline`;
    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:700px">
      <h2>Zoho Books Auth Setup</h2>
      <p>Click this link and sign in with your Zoho admin account:</p>
      <p><a href="${consentUrl}" style="background:#1A1A2E;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">Sign in with Zoho →</a></p>
      <hr style="margin:32px 0">
      <p style="color:#999;font-size:12px">Redirect URI:<br>
      <code style="background:#f5f5f5;padding:4px 8px;border-radius:4px">${redirectUri}</code></p>
    </body></html>`);
  }

  try {
    const res  = await fetch('https://accounts.zoho.com/oauth/v2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code, client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
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
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code&scope=${encodeURIComponent('https://www.googleapis.com/auth/business.manage')}` +
      `&access_type=offline&prompt=consent`;

    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:700px">
      <h2>Google My Business — One-Time Auth Setup</h2>
      <p>Click this link and sign in with your Google admin account:</p>
      <p><a href="${authUrl}" style="background:#4285f4;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">Sign in with Google →</a></p>
      <hr style="margin:32px 0">
      <p style="color:#999;font-size:12px">Redirect URI:<br>
      <code style="background:#f5f5f5;padding:4px 8px;border-radius:4px">${redirectUri}</code></p>
    </body></html>`);
  }

  try {
    const tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();

    if (tokenData.refresh_token) {
      return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:700px">
        <h2>✅ Done! Copy your refresh token:</h2>
        <pre style="background:#e8f5e9;padding:16px;border-radius:8px;word-break:break-all;font-size:13px">${escapeHtml(tokenData.refresh_token)}</pre>
        <p>Add as <strong>GOOGLE_REFRESH_TOKEN</strong> in Cloudflare Workers Settings → Variables.</p>
      </body></html>`);
    }
    return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px"><h2>❌ Auth Failed</h2><pre>${escapeHtml(JSON.stringify(tokenData, null, 2))}</pre></body></html>`);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ============================================================
// ROUTE: /google-profile — create/update GBP
// POST { clientId } with x-admin-key → admin trigger
// GET  ?clientId=X&key=optin         → client tap from WhatsApp
// ============================================================

async function handleGoogleProfile(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const clientId = url.searchParams.get('clientId');
    const key      = url.searchParams.get('key');
    if (key !== 'optin' || !clientId)
      return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px"><h1>Invalid request</h1></body></html>`, 400);

    const client = await getClientById(env, clientId).catch(() => null);
    if (!client)
      return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px"><h1>Not found</h1></body></html>`, 404);

    ctx.waitUntil(
      processGoogleProfile(clientId, client, env).catch(async err => {
        console.error('GBP opt-in processing failed:', err);
        await sendWhatsApp(env.WH_PHONE,
          `⚠️ GBP processing failed: ${client.business_name}\nError: ${err.message}`,
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

  if (request.method !== 'POST') return jsonResponse({ error: 'POST or GET only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY))
    return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  ctx.waitUntil(
    processGoogleProfile(clientId, client, env).catch(async err => {
      console.error('GBP processing failed:', err);
      await logEvent(env, 'launch', 'gbp_creation', 'failure', { clientId, error: err.message });
      await sendWhatsApp(env.WH_PHONE,
        `⚠️ GOOGLE PROFILE ISSUE: ${client.business_name}\nError: ${err.message}\nClient: ${clientId}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    }),
  );

  return jsonResponse({ success: true, message: 'GBP processing started' });
}

async function processGoogleProfile(clientId, client, env) {
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:gbp:${clientId}:${Date.now()}`,
      JSON.stringify({ business: client.business_name, domain: client.domain, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    await logEvent(env, 'launch', 'gbp_creation', 'success', { clientId, metadata: { test_mode: true } });
    return;
  }

  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) throw new Error('Google access token unavailable — run /google-auth first');

  const bizName = client.business_name || '';
  const area    = client.area          || '';
  const domain  = (client.domain || `${slugify(bizName)}.co.za`)
    .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const phone   = normaliseSaPhone(client.phone || '');
  const name    = (client.client_name || '').split(' ')[0] || 'there';

  const accountsRes  = await fetch(
    'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  const accountsData = await accountsRes.json();
  const account      = accountsData?.accounts?.[0];
  if (!account) throw new Error('No GBP account found. Create one at business.google.com first.');

  const locRes   = await fetch(
    `https://mybusinessinformation.googleapis.com/v1/${account.name}/locations?readMask=name,title,websiteUri,phoneNumbers`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
  );
  const locData   = await locRes.json();
  const locations = locData?.locations || [];
  const existing  = locations.find(loc =>
    loc.title?.toLowerCase().includes(bizName.toLowerCase().split(' ')[0]),
  );

  if (existing) {
    await fetch(
      `https://mybusinessinformation.googleapis.com/v1/${existing.name}?updateMask=websiteUri`,
      {
        method:  'PATCH',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ websiteUri: `https://${domain}` }),
      },
    );
    await updateClient(env, clientId, { gbp_status: 'claimed', gbp_url: `https://business.google.com` }).catch(() => {});
    await logEvent(env, 'launch', 'gbp_creation', 'success', { clientId, metadata: { action: 'updated', domain } });
    await sendWhatsApp(client.phone,
      `📍 Great news, ${name}! We found your *${bizName}* Google Business Profile and linked it to your new website.\n\nPeople searching for you on Google Maps will now be sent straight to your site. 🗺️\n\n— Website Hub`,
      env,
    );

    await sendEmail({
      to: client.email,
      subject: `Google Business Profile linked — ${bizName}`,
      touchpoint: 'gbp_linked',
      clientSlug: client.slug,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#111">Google Business Profile linked 📍</h2>
        <p>Hi ${name},</p>
        <p>We found your <strong>${bizName}</strong> Google Business Profile and linked it to your new website. People searching for you on Google Maps will now land directly on your site.</p>
        <p style="color:#888;font-size:12px">— Website Hub</p>
      </div>`,
    }, env).catch(() => {});
    await sendWhatsApp(env.WH_PHONE,
      `📍 GOOGLE PROFILE UPDATED: ${bizName}\nWebsite: https://${domain}`,
      env, { skipTestRedirect: true },
    );
  } else {
    const newLocation = {
      title: bizName,
      storefrontAddress: { regionCode: 'ZA', administrativeArea: area, locality: area },
      websiteUri:   `https://${domain}`,
      phoneNumbers: phone ? { primaryPhone: `+${phone}` } : undefined,
      categories:   { primaryCategory: { name: industryToGoogleCategory(client.industry || '') } },
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

    const createRes  = await fetch(
      `https://mybusinessinformation.googleapis.com/v1/${account.name}/locations?validateOnly=false`,
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(newLocation),
      },
    );
    const createData = await createRes.json();
    if (!createRes.ok) throw new Error(`GBP create failed: ${JSON.stringify(createData)}`);

    await updateClient(env, clientId, { gbp_status: 'created' }).catch(() => {});
    await logEvent(env, 'launch', 'gbp_creation', 'success', { clientId, metadata: { action: 'created', domain } });
    await sendWhatsApp(client.phone,
      `📍 Hi ${name}! We've created your *${bizName}* Google Business Profile.\n\n*What happens next:*\nGoogle sends a postcard to your business address within 5–14 days. It has a PIN code.\n\nWhen it arrives, tap this link and enter the PIN:\nhttps://business.google.com/verify\n\nOnce verified, *${bizName}* appears on Google Maps. 🗺️\n\n— Website Hub`,
      env,
    );

    await sendEmail({
      to: client.email,
      subject: `Google Business Profile created — ${bizName}`,
      touchpoint: 'gbp_created',
      clientSlug: client.slug,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#111">Google Business Profile created 📍</h2>
        <p>Hi ${name},</p>
        <p>We've created a Google Business Profile for <strong>${bizName}</strong>.</p>
        <p><strong>What happens next:</strong><br>Google will send a postcard to your business address within 5–14 days with a PIN code.</p>
        <p>When it arrives, click below and enter the PIN to verify — then <strong>${bizName}</strong> appears on Google Maps.</p>
        <p style="margin:24px 0"><a href="https://business.google.com/verify" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Verify My Profile</a></p>
        <p style="color:#888;font-size:12px">— Website Hub</p>
      </div>`,
    }, env).catch(() => {});
    await sendWhatsApp(env.WH_PHONE,
      `📍 GOOGLE PROFILE CREATED: ${bizName}\nWebsite: https://${domain}\nStatus: Awaiting postcard verification`,
      env, { skipTestRedirect: true },
    );
  }
}

async function getGoogleAccessToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  try {
    const res  = await fetch('https://oauth2.googleapis.com/token', {
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

function industryToGoogleCategory(industry) {
  const key = (industry || '').toLowerCase();
  const map = {
    'restaurant': 'gcid:restaurant', 'food': 'gcid:restaurant', 'cafe': 'gcid:cafe',
    'hair': 'gcid:hair_salon',       'salon': 'gcid:beauty_salon', 'barber': 'gcid:barber_shop',
    'beauty': 'gcid:beauty_salon',   'nails': 'gcid:nail_salon',   'spa': 'gcid:spa',
    'gym': 'gcid:gym',               'fitness': 'gcid:gym', 'personal trainer': 'gcid:personal_trainer',
    'medical': 'gcid:doctor',        'dental': 'gcid:dentist',     'doctor': 'gcid:doctor',
    'clinic': 'gcid:medical_clinic', 'estate': 'gcid:real_estate_agency', 'property': 'gcid:real_estate_agency',
    'flooring': 'gcid:flooring_store', 'tiles': 'gcid:flooring_store',
    'construction': 'gcid:general_contractor', 'builder': 'gcid:general_contractor',
    'electrical': 'gcid:electrician', 'electrician': 'gcid:electrician',
    'plumber': 'gcid:plumber',        'plumbing': 'gcid:plumber',
    'cleaning': 'gcid:house_cleaning_service', 'automotive': 'gcid:car_repair',
    'retail': 'gcid:clothing_store',  'education': 'gcid:tutoring_service',
    'lawyer': 'gcid:lawyer',          'accountant': 'gcid:accounting_firm',
  };
  for (const [fragment, gcid] of Object.entries(map)) {
    if (key.includes(fragment)) return gcid;
  }
  return 'gcid:establishment';
}

// ============================================================
// End of launch-worker.js
// ============================================================
