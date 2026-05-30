// ============================================================
// WEBSITE HUB — reactivate-worker.js
// Owns inbound + churn flow:
//   — /cancel-site       Three-branch cancellation (FILE / DOMAIN / ARCHIVE)
//   — /reactivate-site   Restore cancelled clients
//   — /not-interested    Prospect cooldown (link from outbound watermark)
//   — /stop-reply        Permanent opt-out
//   — /inbound-reply     Meta WhatsApp webhook — verification + intent routing
//   — /health            Service health
//
// INBOUND INTENT ROUTING:
//   STOP / opt out               → opt-out flow (permanent)
//   YES (Live + recent go-live)  → trigger GBP creation (launch-worker)
//   YES (Live + manage panel)    → forward to upgrade target flow
//   YES (prospect opted in)      → triggers build (sets Client Name, queues build)
//   any name (prospect 'sent')   → also triggers build (treats reply as opt-in)
//   UPGRADE / PREMIUM            → launch-worker /upgrade
//   CANCEL                       → owner alert + acknowledgement
//   REACTIVATE                   → /reactivate-site flow
//   anything else                → forward to owner with context
//
// META WEBHOOK:
//   GET  /inbound-reply?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
//        → returns hub.challenge if token matches META_VERIFY_TOKEN
//   POST /inbound-reply with Meta JSON body + X-Hub-Signature-256 header
//        → validates HMAC-SHA256, parses messages, routes by intent
//
// CROSS-WORKER:
//   POST {WORKER_URL_LAUNCH}/google-profile   → admin trigger for GBP
//   POST {WORKER_URL_LAUNCH}/upgrade          → upgrade link generator
//   Queue env.BUILD_QUEUE.send()              → prospect opt-in builds
//
// CANCELLATION OPTIONS:
//   archive (default) — write suspended:{domain}, keep KV. Easiest reactivation.
//                       Use for "I'm pausing for now" — pulse-worker fires win-back at 90d.
//   file              — delete live KV entries, keep suspended:{domain} forever.
//                       Use for permanent shutdown but want it documented.
//   domain            — delete live KV entries, delete suspended:{domain},
//                       unbind CF custom hostname. Use when client takes their domain elsewhere.
//
// SECRETS:
//   META_VERIFY_TOKEN, META_WEBHOOK_SECRET (optional — verifies HMAC if set),
//   AIRTABLE_*, ADMIN_KEY, WH_PHONE, WORKER_URL_LAUNCH, CF_* (for domain unbind)
// ============================================================

import {
  PRICING, PACKAGE_CAPS,
  PROSPECT_COOLDOWN_DAYS, WIN_BACK_TRIGGER_DAYS,
  isTestMode, packageKey, getPricingTier, getPackageCaps,
  jsonResponse, corsResponse, htmlResponse,
  slugify, escapeHtml, todayDateString, nextMonthDate,
  sendWhatsApp, queueScheduledMessage, normaliseSaPhone,
  getClientById, getClientBySlug, getClientByPhone, getClientByToken, queryClients, updateClient,
  logActivity, logHealth,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS — intent keyword matching (case-insensitive)
// ────────────────────────────────────────────────────────────

const INTENT_KEYWORDS = Object.freeze({
  optOut:     ['STOP', 'OPT OUT', 'OPT-OUT', 'UNSUBSCRIBE', 'REMOVE ME', 'NEVER MESSAGE', 'BLOCK'],
  yes:        ['YES', 'YES!', 'YEP', 'YEAH', 'OK', 'SURE', 'PLEASE DO', '✅', '👍'],
  no:         ['NO', 'NO THANKS', 'NAH', 'NOT INTERESTED'],
  upgrade:    ['UPGRADE', 'PREMIUM', 'GO PREMIUM', 'STANDARD'],
  cancel:     ['CANCEL', 'CANCEL MY SITE', 'CANCEL SUBSCRIPTION'],
  reactivate: ['REACTIVATE', 'COME BACK', 'BRING IT BACK', 'TURN IT BACK ON'],
});

const VALID_CANCEL_OPTIONS = ['archive', 'file', 'domain'];

// ────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/cancel-site')      return handleCancelSite(request, env, ctx);
    if (path === '/reactivate-site')  return handleReactivateSite(request, env, ctx);
    if (path === '/not-interested')   return handleNotInterested(request, url, env);
    if (path === '/stop-reply')       return handleStopReply(request, url, env);
    if (path === '/inbound-reply')    return handleInboundReply(request, env, ctx);
    if (path === '/health')           return handleHealth(env);

    return jsonResponse({ error: 'Not found', path }, 404);
  },
};

// ============================================================
// ROUTE: /health
// ============================================================

async function handleHealth(env) {
  const services = ['airtable', 'whatsapp', 'meta_webhook'];
  const health = {};
  for (const svc of services) {
    try {
      const raw = await env.SITES.get(`health:${svc}`);
      health[svc] = raw ? JSON.parse(raw) : { status: 'unknown' };
    } catch { health[svc] = { status: 'unknown' }; }
  }
  return jsonResponse({
    ok:       true,
    worker:   'reactivate-worker',
    time:     new Date().toISOString(),
    testMode: isTestMode(env),
    services: health,
  });
}

// ============================================================
// ROUTE: /cancel-site
// Body: { airtableId, option: 'archive' | 'file' | 'domain', reason? }
// Auth: x-admin-key (for admin trigger) OR inbound webhook (no auth, marks
//       in Airtable as cancellation_pending for admin review)
// ============================================================

async function handleCancelSite(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, option = 'archive', reason = '' } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);

  if (!VALID_CANCEL_OPTIONS.includes(option)) {
    return jsonResponse({ error: `Invalid option — must be one of: ${VALID_CANCEL_OPTIONS.join(', ')}` }, 400);
  }

  const isAdmin = request.headers.get('x-admin-key') === env.ADMIN_KEY;
  if (!isAdmin) return jsonResponse({ error: 'Unauthorized' }, 401);

  const client = await getClientById(clientId, env);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);
  const airtableId = clientId;
  const f = { 'Business Name': client.business_name, 'Client Name': client.client_name, 'WhatsApp': client.phone, 'Package': client.package, 'Domain': client.domain, 'Slug': client.slug, 'Manage Token': client.manage_token };
  const slug   = client.slug;
  const domain = (client.domain || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  // Branch on cancellation option
  if (option === 'archive') {
    await env.SITES.put(`suspended:${domain}`, '1');
    // Keep all live:{domain}:* entries so reactivation is instant
  } else if (option === 'file') {
    await env.SITES.put(`suspended:${domain}`, '1');
    // Delete live KV entries — site goes to "Site temporarily unavailable" page
    await deleteLiveKvEntries(slug, domain, env);
  } else if (option === 'domain') {
    // Hard cancel — client takes their domain elsewhere
    await deleteLiveKvEntries(slug, domain, env);
    await env.SITES.delete(`suspended:${domain}`);
    // Unbind CF custom hostname (best-effort, non-fatal)
    ctx.waitUntil(unbindCustomHostname(domain, env).catch(e => {
      console.warn('CF hostname unbind failed:', e?.message || e);
    }));
  }

  // Set the cancellation marker that pulse-worker's win-back cron watches
  await env.SITES.put(`cancelled:${airtableId}`, new Date().toISOString());

  // Delete manage token so the old manage URL stops working
  if (f['Manage Token']) {
    await env.SITES.delete(`manage_token:${f['Manage Token']}`).catch(() => {});
  }

  await updateClient(clientId, { status: 'cancelled', cancellation_date: todayDateString() }, env);

  // Client confirmation
  const name = f['Client Name']?.split(' ')[0] || 'there';
  let clientMsg;
  if (option === 'archive') {
    clientMsg = `Hi ${name} — we've paused *${f['Business Name']}*. No more invoices.\n\nYour site is on hold but kept on file. If you ever want to bring it back, just reply REACTIVATE and we'll have it up in minutes.\n\nAll the best.\n— Pierre, Website Hub`;
  } else if (option === 'file') {
    clientMsg = `Hi ${name} — we've cancelled *${f['Business Name']}* and removed your site from our servers. No more invoices.\n\nIf you change your mind later, we can rebuild from scratch with our normal subscription. No build fee.\n\nAll the best.\n— Pierre, Website Hub`;
  } else { // domain
    clientMsg = `Hi ${name} — we've cancelled *${f['Business Name']}* and released your domain (*${domain}*) so you can use it elsewhere.\n\nGood luck with everything.\n— Pierre, Website Hub`;
  }
  await sendWhatsApp(f['WhatsApp'], clientMsg, env);

  // Owner alert
  await sendWhatsApp(env.WH_PHONE,
    `🛑 CANCELLED: ${f['Business Name']}\nOption: ${option}\nReason: ${reason || '(none given)'}\nDomain: ${domain}\nAirtable: ${airtableId}\nWin-back eligible in ${WIN_BACK_TRIGGER_DAYS} days.`,
    env, { skipTestRedirect: true });

  await logActivity(env, 'site_cancelled', {
    airtableId, business: f['Business Name'], option, reason, domain,
  });

  return jsonResponse({ success: true, option, winBackEligibleIn: WIN_BACK_TRIGGER_DAYS });
}

/**
 * Deletes the per-page live KV entries for a slug+domain.
 * Used by 'file' and 'domain' cancellation options.
 */
async function deleteLiveKvEntries(slug, domain, env) {
  const caps  = getPackageCaps('Premium'); // 5 pages — covers all tiers
  const pages = caps.pages;
  for (const p of pages) {
    await env.SITES.delete(`live:${domain}:${p}`).catch(() => {});
  }
  await env.SITES.delete(`live:${domain}`).catch(() => {});
}

/**
 * Unbinds a Cloudflare custom hostname. Best-effort — failures don't block
 * the rest of the cancellation flow.
 */
async function unbindCustomHostname(hostname, env) {
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:cf_unbind:${hostname}:${Date.now()}`,
      JSON.stringify({ hostname, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    );
    return { test_mode: true };
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.CF_ZONE_ID) {
    throw new Error('Cloudflare API not configured');
  }

  // First, find the custom_hostname ID by listing and matching
  const listRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
    { headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` } },
  );
  const listData = await listRes.json();
  if (!listRes.ok || !listData.success) throw new Error(`CF list failed: ${JSON.stringify(listData.errors)}`);

  const match = (listData.result || []).find(h => h.hostname === hostname);
  if (!match) return { not_found: true }; // already unbound, no-op

  const delRes = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${match.id}`,
    {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
    },
  );
  const delData = await delRes.json();
  if (!delRes.ok || !delData.success) throw new Error(`CF delete failed: ${JSON.stringify(delData.errors)}`);

  await logActivity(env, 'cf_hostname_unbound', { hostname, id: match.id });
  return { unbound: true, id: match.id };
}

// ============================================================
// ROUTE: /reactivate-site
// Accepts both GET (tap from win-back WhatsApp link) and POST (admin/SPA).
// GET ?airtableId=X — looks up record, generates fresh PayFast, redirects.
// POST { airtableId } with admin key — immediate reactivation without payment.
// ============================================================

async function handleReactivateSite(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const clientId = url.searchParams.get('clientId') || url.searchParams.get('airtableId');
    if (!clientId) return htmlResponse(simpleErrorPage('Missing record ID.'), 400);

    const client = await getClientById(clientId, env);
    if (!client) return htmlResponse(simpleErrorPage('Record not found.'), 404);
    const f      = { 'Package': client.package, 'Slug': client.slug, 'Business Name': client.business_name };
    const tier   = getPricingTier(client.package || 'standard');
    const launchUrl = env.WORKER_URL_LAUNCH || '';
    const airtableId = clientId;

    // Build a PayFast link via launch-worker URL pattern (no custom_str2 = subscription)
    // and an "amount" matching the retainer. PayFast COMPLETE webhook will fire
    // handleGoLivePayment which detects Status=Cancelled → reinstateInternal.
    // For Cancelled status, we first need to flip it to Suspended so the launch-worker
    // recognises it as a reinstatement target. Do that here.
    await updateClient(clientId, { status: 'suspended' }, env);

    const itemName  = encodeURIComponent('Website Hub Reactivation');
    const returnUrl = encodeURIComponent(`https://preview.websitehub.co.za/${f['Slug'] || slugify(f['Business Name'])}`);
    const notifyUrl = encodeURIComponent(`${launchUrl}/payfast-webhook`);
    const sandboxHost = isTestMode(env) ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
    const merchantId  = isTestMode(env)
      ? (env.PAYFAST_SANDBOX_MERCHANT_ID || '10000100')
      : (env.PAYFAST_MERCHANT_ID || '13581217');
    const payLink = `https://${sandboxHost}/eng/process?merchant_id=${merchantId}&amount=${tier.retainer}&item_name=${itemName}&custom_str1=${airtableId}&return_url=${returnUrl}&notify_url=${notifyUrl}`;

    return Response.redirect(payLink, 302);
  }

  // POST — admin direct reactivation (no payment required, e.g. comping a client)
  if (request.method !== 'POST') return jsonResponse({ error: 'GET or POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);

  const _rc = await getClientById(clientId, env);
  if (!_rc) return jsonResponse({ error: 'Client not found' }, 404);

  ctx.waitUntil(reactivateInternal(clientId, _rc, env));
  return jsonResponse({ success: true, message: 'Reactivation started' });
}

async function reactivateInternal(clientId, client, env) {
  const airtableId = clientId;
  const f = { 'Business Name': client.business_name, 'Client Name': client.client_name, 'WhatsApp': client.phone, 'Package': client.package, 'Domain': client.domain, 'Slug': client.slug };
  const slug   = client.slug;
  const domain = (client.domain || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  // Clear the cancellation marker so pulse-worker doesn't re-send win-back
  await env.SITES.delete(`cancelled:${airtableId}`);
  await env.SITES.delete(`winback_sent:${airtableId}`);

  // If KV live entries still exist (archive option), just unsuspend
  const hasLive = await env.SITES.get(`live:${domain}`);
  if (hasLive) {
    await env.SITES.delete(`suspended:${domain}`);
    await updateClient(clientId, { status: 'live', next_invoice_date: nextMonthDate() }, env);

    const name = f['Client Name']?.split(' ')[0] || 'there';
    await sendWhatsApp(f['WhatsApp'],
      `✅ Welcome back, ${name}! *${f['Business Name']}* is live again at https://${domain}\n\n— Pierre, Website Hub`,
      env);

  } else {
    // KV entries were deleted (file/domain option) — queue a fresh build
    await updateClient(clientId, { status: 'building' }, env);
    await env.BUILD_QUEUE.send({ type: 'substance_build', clientId, isOutbound: false });

    const name = f['Client Name']?.split(' ')[0] || 'there';
    await sendWhatsApp(f['WhatsApp'],
      `🎉 Welcome back, ${name}! We're rebuilding *${f['Business Name']}* now — you'll have a fresh preview in about 10 minutes.\n\n— Pierre, Website Hub`,
      env);
  }

  await sendWhatsApp(env.WH_PHONE,
    `🎉 REACTIVATED: ${f['Business Name']}\nDomain: ${domain}\nAirtable: ${airtableId}`,
    env, { skipTestRedirect: true });

  await logActivity(env, 'site_reactivated', {
    airtableId, business: f['Business Name'], domain,
  });
}

// ============================================================
// ROUTE: /not-interested
// GET link from outbound preview watermark.
// Sets prospect_closed:{phone} so pulse-worker's prospect cron skips them
// for PROSPECT_COOLDOWN_DAYS.
// ============================================================

async function handleNotInterested(request, url, env) {
  const slug  = url.searchParams.get('slug');
  const phone = url.searchParams.get('phone');

  // Try to identify the prospect even if only one of slug/phone is provided
  let airtableId = null, businessName = null, normalisedPhone = null;

  if (phone) {
    normalisedPhone = normaliseSaPhone(phone);
    const stateRaw = await env.SITES.get(`prospect_state:${normalisedPhone}`).catch(() => null);
    if (stateRaw) {
      const state = JSON.parse(stateRaw);
      airtableId = state.airtableId;
    }
  }
  if (!airtableId && slug) {
    const outboundRaw = await env.SITES.get(`outbound:${slug}`).catch(() => null);
    if (outboundRaw) airtableId = outboundRaw;
  }

  if (airtableId) {
    try {
      const record = await getClientById(airtableId, env);
      const f = { 'Business Name': record?.business_name, 'WhatsApp': record?.phone };
      businessName    = f['Business Name'];
      normalisedPhone = normalisedPhone || normaliseSaPhone(f['WhatsApp']);

      if (record) await updateClient(airtableId, { status: 'not_interested' }, env);
    } catch (e) {
      console.warn('not-interested airtable update failed:', e?.message || e);
    }
  }

  // Cooldown marker
  if (normalisedPhone) {
    await env.SITES.put(`prospect_closed:${normalisedPhone}`, new Date().toISOString());
    await env.SITES.put(`prospect_state:${normalisedPhone}`, JSON.stringify({
      airtableId, slug, phase: 'closed', closedAt: new Date().toISOString(),
    }), { expirationTtl: 60 * 60 * 24 * PROSPECT_COOLDOWN_DAYS });
  }

  await sendWhatsApp(env.WH_PHONE,
    `❌ NOT INTERESTED: ${businessName || slug || normalisedPhone || 'unknown prospect'}\n${PROSPECT_COOLDOWN_DAYS}-day cooldown set.`,
    env, { skipTestRedirect: true });

  await logActivity(env, 'prospect_not_interested', { airtableId, slug, phone: normalisedPhone });

  return htmlResponse(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No problem</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0d0d0d;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}.box{max-width:380px;background:#161616;border:1px solid #2a2a2a;border-radius:14px;padding:40px 28px}.icon{font-size:40px;margin-bottom:16px}h2{font-size:22px;font-weight:800;margin-bottom:10px}p{color:#888;line-height:1.7;font-size:14px}</style></head><body><div class="box"><div class="icon">👋</div><h2>No problem at all</h2><p>We won't contact you again. All the best with your business.</p></div></body></html>`);
}

// ============================================================
// ROUTE: /stop-reply
// GET or POST — permanent opt-out. Sets optout:{phone} (no TTL) so
// sendWhatsApp always skips this number going forward.
// ============================================================

async function handleStopReply(request, url, env) {
  let phone = url.searchParams.get('phone');
  if (!phone && request.method === 'POST') {
    try { const body = await request.json(); phone = body.phone; } catch { /* fall through */ }
  }
  if (!phone) return htmlResponse(simpleErrorPage('Missing phone parameter.'), 400);

  const normalisedPhone = normaliseSaPhone(phone);
  if (!normalisedPhone) return htmlResponse(simpleErrorPage('Invalid phone format.'), 400);

  await env.SITES.put(`optout:${normalisedPhone}`, new Date().toISOString());

  // Clean up any prospect state too
  await env.SITES.delete(`prospect_state:${normalisedPhone}`).catch(() => {});

  await sendWhatsApp(env.WH_PHONE,
    `🚫 OPT-OUT: +${normalisedPhone}`,
    env, { skipTestRedirect: true });

  await logActivity(env, 'opt_out', { phone: normalisedPhone });

  return htmlResponse(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opted out</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0d0d0d;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}.box{max-width:380px;background:#161616;border:1px solid #2a2a2a;border-radius:14px;padding:40px 28px}.icon{font-size:40px;margin-bottom:16px}h2{font-size:22px;font-weight:800;margin-bottom:10px}p{color:#888;line-height:1.7;font-size:14px}</style></head><body><div class="box"><div class="icon">✓</div><h2>You're opted out</h2><p>We won't message you again. All the best.</p></div></body></html>`);
}

// ============================================================
// ROUTE: /inbound-reply — Meta WhatsApp webhook
//
// GET (verification, once per webhook registration):
//   ?hub.mode=subscribe&hub.verify_token=X&hub.challenge=Y
//   If X === META_VERIFY_TOKEN, returns Y as plain text.
//
// POST (incoming messages):
//   Validates X-Hub-Signature-256 if META_WEBHOOK_SECRET is set.
//   Parses Meta's nested JSON for the message text + sender phone.
//   Routes by intent keyword + Airtable record status.
// ============================================================

async function handleInboundReply(request, env, ctx) {
  const url = new URL(request.url);

  // ── GET verification ────────────────────────────────────────
  if (request.method === 'GET') {
    const mode      = url.searchParams.get('hub.mode');
    const token     = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge');

    if (mode === 'subscribe' && token === env.META_VERIFY_TOKEN) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Forbidden', { status: 403 });
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'GET or POST only' }, 405);

  // Read body once, verify signature, then parse
  const rawBody = await request.text();

  // ── HMAC verification (if META_WEBHOOK_SECRET is configured) ─
  if (env.META_WEBHOOK_SECRET) {
    const sigHeader = request.headers.get('x-hub-signature-256');
    if (!sigHeader || !(await verifyMetaSignature(rawBody, sigHeader, env.META_WEBHOOK_SECRET))) {
      await logHealth(env, 'meta_webhook', 'error', 'signature mismatch');
      return new Response('Invalid signature', { status: 401 });
    }
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  // Process all messages in the payload (Meta may batch)
  const messages = extractInboundMessages(payload);
  if (messages.length === 0) {
    // Status updates, delivery receipts, etc — acknowledge silently
    return new Response('OK', { status: 200 });
  }

  // Process asynchronously, return 200 immediately so Meta doesn't retry
  ctx.waitUntil(processInboundMessages(messages, env));

  await logHealth(env, 'meta_webhook', 'success');
  return new Response('OK', { status: 200 });
}

/**
 * Web Crypto HMAC-SHA256 signature verification for Meta webhooks.
 * Header format: "sha256={hex}"
 */
async function verifyMetaSignature(body, signatureHeader, secret) {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false, ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    const sigHex = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
    return `sha256=${sigHex}` === signatureHeader;
  } catch (e) {
    console.warn('Signature verification error:', e);
    return false;
  }
}

/**
 * Walks Meta's nested webhook payload and pulls out [{ from, text, type }, ...].
 * Ignores status updates, delivery receipts, and non-text messages.
 */
function extractInboundMessages(payload) {
  const out = [];
  try {
    for (const entry of (payload.entry || [])) {
      for (const change of (entry.changes || [])) {
        const value = change.value || {};
        for (const m of (value.messages || [])) {
          if (m.type === 'text' && m.text?.body) {
            out.push({ from: m.from, text: m.text.body, type: 'text', timestamp: m.timestamp });
          } else if (m.type === 'button' && m.button?.text) {
            // Quick-reply button taps come as type=button
            out.push({ from: m.from, text: m.button.text, type: 'button', timestamp: m.timestamp });
          }
        }
      }
    }
  } catch (e) {
    console.warn('extractInboundMessages error:', e);
  }
  return out;
}

async function processInboundMessages(messages, env) {
  for (const msg of messages) {
    try { await routeInboundMessage(msg, env); }
    catch (e) {
      console.warn('Inbound message routing failed:', e?.message || e);
      await logActivity(env, 'inbound_routing_error', { from: msg.from, error: e.message });
    }
  }
}

/**
 * Main intent router. Looks up state from Airtable + KV, applies keyword
 * matching in priority order, and dispatches to the right handler.
 *
 * Priority (highest first):
 *   1. STOP → opt-out (always wins)
 *   2. Active prospect state → name reply or YES → trigger build
 *   3. Live client + recent go-live + YES → trigger GBP
 *   4. UPGRADE / PREMIUM → upgrade flow
 *   5. REACTIVATE → reactivation flow
 *   6. CANCEL → owner alert, await admin processing
 *   7. unrecognised → forward to owner
 */
async function routeInboundMessage(msg, env) {
  // findRecordByPhone now returns D1 client object directly
  const phone = normaliseSaPhone(msg.from);
  const text  = String(msg.text || '').trim();
  const upper = text.toUpperCase();

  // ── 1. STOP keywords (always highest priority) ──────────────
  if (matchesAny(upper, INTENT_KEYWORDS.optOut)) {
    return handleOptOutIntent(phone, env);
  }

  // Look up Airtable record (by phone) + prospect state
  const record = await findRecordByPhone(phone, env);
  const prospectStateRaw = await env.SITES.get(`prospect_state:${phone}`).catch(() => null);
  const prospectState    = prospectStateRaw ? JSON.parse(prospectStateRaw) : null;

  // ── 2. Active prospect — first reply is opt-in ──────────────
  if (prospectState && (prospectState.phase === 'sent' || prospectState.phase === 'follow_up_sent')) {
    return handleProspectOptIn(phone, text, prospectState, env);
  }

  // ── 3. Client-context intents (require Airtable record) ─────
  if (record) {
    const f = record.fields;
    const status = f['Status'] || '';

    // YES — context-aware. If recently went live and GBP not yet processed, it's GBP opt-in.
    if (matchesAny(upper, INTENT_KEYWORDS.yes)) {
      const goLiveDate = f['Go Live Date'];
      const gbpStatus  = f['Google Profile Status'] || '';
      if (status === 'Live' && goLiveDate && !gbpStatus) {
        const daysSinceLive = Math.floor((Date.now() - new Date(goLiveDate).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceLive <= 7) {
          return handleGbpOptIn(record.id, env);
        }
      }
      // Otherwise YES might be a generic acknowledgement — forward to owner
      return forwardToOwner(phone, text, record, 'yes-ambiguous', env);
    }

    // UPGRADE / PREMIUM
    if (matchesAny(upper, INTENT_KEYWORDS.upgrade)) {
      return handleUpgradeIntent(record.id, f, upper, env);
    }

    // REACTIVATE (only valid if currently Cancelled)
    if (matchesAny(upper, INTENT_KEYWORDS.reactivate)) {
      if (status === 'Cancelled') {
        return handleReactivateIntent(record.id, f, env);
      }
      return forwardToOwner(phone, text, record, 'reactivate-not-cancelled', env);
    }

    // CANCEL — never auto-process; surface to owner with context
    if (matchesAny(upper, INTENT_KEYWORDS.cancel)) {
      return handleCancelIntent(record.id, f, text, env);
    }

    // ── 4. Unrecognised — forward to owner with client context ─
    return forwardToOwner(phone, text, record, 'unrecognised', env);
  }

  // ── 5. No record at all — could be a new lead or wrong number ──
  // Forward to owner so they can decide if it's worth following up.
  await sendWhatsApp(env.WH_PHONE,
    `📩 UNKNOWN SENDER (+${phone})\n\n"${text.slice(0, 200)}"\n\nNot in Airtable. May be wrong number or organic outreach.`,
    env, { skipTestRedirect: true });
  await logActivity(env, 'inbound_unknown_sender', { phone, text: text.slice(0, 100) });
}

function matchesAny(upper, keywords) {
  // Tight match — keyword must be a discrete token (or whole message)
  // Prevents false positives like "no problem!" matching "NO"
  for (const kw of keywords) {
    const re = new RegExp(`(^|\\s|\\W)${escapeRegex(kw)}($|\\s|\\W)`, 'i');
    if (re.test(upper)) return true;
  }
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Looks up an Airtable record by phone number.
 * Strips '+' and matches against WhatsApp field with both formats.
 */
async function findRecordByPhone(phone, env) {
  if (!phone) return null;
  // Match against both '27840142017' and '+27840142017' shapes
  const formula = `OR({WhatsApp} = "${phone}", {WhatsApp} = "+${phone}", {WhatsApp} = "0${phone.slice(2)}")`;
  try {
    return await getClientByPhone(phone, env);
    return records[0] || null;
  } catch (e) {
    console.warn('findRecordByPhone failed:', e?.message || e);
    return null;
  }
}

// ============================================================
// INBOUND INTENT HANDLERS
// ============================================================

async function handleOptOutIntent(phone, env) {
  await env.SITES.put(`optout:${phone}`, new Date().toISOString());
  await env.SITES.delete(`prospect_state:${phone}`).catch(() => {});

  // Confirmation (only sent if they haven't been totally hostile)
  await sendWhatsApp(phone,
    `Got it — we won't message you again. All the best. — Website Hub`,
    env, { skipTestRedirect: false }); // honours their opt-out request immediately after this final reply

  await sendWhatsApp(env.WH_PHONE,
    `🚫 OPTED OUT: +${phone}`,
    env, { skipTestRedirect: true });

  await logActivity(env, 'inbound_opt_out', { phone });
}

/**
 * Prospect reply (opted in by replying — typically with their name).
 * We don't actually parse the name out — we just save the message text as
 * the Client Name and trigger a build. Owner can review/correct in Airtable.
 *
 * Skip if message is just "NO" or similar refusal.
 */
async function handleProspectOptIn(phone, text, prospectState, env) {
  const upper = text.toUpperCase().trim();

  // If the prospect replied with NO or similar, treat as soft decline
  if (matchesAny(upper, INTENT_KEYWORDS.no)) {
    await env.SITES.put(`prospect_closed:${phone}`, new Date().toISOString());
    await env.SITES.put(`prospect_state:${phone}`, JSON.stringify({
      ...prospectState, phase: 'declined', declinedAt: new Date().toISOString(),
    }), { expirationTtl: 60 * 60 * 24 * PROSPECT_COOLDOWN_DAYS });

    if (prospectState.airtableId) {
      await updateClient(prospectState.airtableId, { status: 'not_interested' }, env).catch(() => {});
    }
    await logActivity(env, 'prospect_declined', { phone, airtableId: prospectState.airtableId });
    return;
  }

  // Extract name — take first 2 words, capitalise, limit length
  const nameGuess = text.split(/\s+/).slice(0, 2).join(' ').slice(0, 40)
    .replace(/[^a-zA-Z\s'-]/g, '').trim();
  const clientName = nameGuess
    ? nameGuess.split(/\s+/).map(w => w[0]?.toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : 'there';

  // Update Airtable + queue build
  if (prospectState.airtableId) {
    await updateClient(prospectState.airtableId, { client_name: clientName, status: 'building' }, env);
    await env.BUILD_QUEUE.send({ type: 'substance_build', clientId: prospectState.airtableId, isOutbound: true });
  }

  // Update prospect state
  await env.SITES.put(`prospect_state:${phone}`, JSON.stringify({
    ...prospectState, phase: 'opted_in', optedInAt: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 30 });

  // Acknowledge
  await sendWhatsApp(phone,
    `Brilliant ${clientName} 👋 We're building your free website preview right now — you'll have the link in about 2 minutes. Sit tight!\n\n— Website Hub`,
    env);

  await sendWhatsApp(env.WH_PHONE,
    `✅ PROSPECT OPTED IN: "${clientName}" (+${phone})\nAirtable: ${prospectState.airtableId}\nBuild queued.`,
    env, { skipTestRedirect: true });

  await logActivity(env, 'prospect_opted_in', {
    phone, airtableId: prospectState.airtableId, name: clientName,
  });
}

/**
 * YES reply to the go-live message's "📍 Reply YES to also list us on Google Maps."
 * Forwards to launch-worker /google-profile admin endpoint to trigger GBP creation.
 */
async function handleGbpOptIn(airtableId, env) {
  const launchUrl = env.WORKER_URL_LAUNCH;
  if (!launchUrl) {
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ GBP opt-in received but WORKER_URL_LAUNCH not configured. Process manually for ${airtableId}.`,
      env, { skipTestRedirect: true });
    return;
  }

  try {
    const res = await fetch(`${launchUrl}/google-profile`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key':  env.ADMIN_KEY,
      },
      body: JSON.stringify({ airtableId }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`launch-worker GBP call failed: ${res.status} — ${errText}`);
    }
    await logActivity(env, 'gbp_optin_processed', { airtableId });
  } catch (err) {
    console.warn('GBP opt-in forward failed:', err?.message || err);
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ GBP opt-in forward failed for ${airtableId}: ${err.message}`,
      env, { skipTestRedirect: true });
  }
}

/**
 * UPGRADE / PREMIUM intent — forward to launch-worker /upgrade for
 * PayFast link generation, send link to client.
 */
async function handleUpgradeIntent(airtableId, f, upper, env) {
  const launchUrl = env.WORKER_URL_LAUNCH;
  if (!launchUrl) {
    return forwardToOwner(normaliseSaPhone(f['WhatsApp']), 'UPGRADE intent', { id: airtableId, fields: f }, 'no-launch-worker', env);
  }

  // Decide target tier from current package + keyword
  const currentPkg = packageKey(f['Package'] || 'Standard');
  let target;
  if (upper.includes('PREMIUM')) {
    target = 'Premium';
  } else if (upper.includes('STANDARD')) {
    target = 'Standard';
  } else {
    // Just "UPGRADE" — default to next tier up
    target = currentPkg === 'express' ? 'Standard' : 'Premium';
  }

  if (currentPkg === packageKey(target)) {
    await sendWhatsApp(f['WhatsApp'],
      `Hi! You're already on *${f['Package']}* — nothing to upgrade to that tier. Reply if you'd like to go higher.\n— Website Hub`,
      env);
    return;
  }

  try {
    const res  = await fetch(`${launchUrl}/upgrade`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientId: airtableId, target }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    // launch-worker already sends the upgrade message to the client; we just log
    await logActivity(env, 'upgrade_intent_processed', { airtableId, target, delta: data.delta });
  } catch (err) {
    console.warn('Upgrade intent forward failed:', err?.message || err);
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Upgrade intent forward failed for ${f['Business Name']}: ${err.message}`,
      env, { skipTestRedirect: true });
  }
}

/**
 * REACTIVATE intent — only valid for currently Cancelled clients.
 * Triggers reactivateInternal directly.
 */
async function handleReactivateIntent(airtableId, f, env) {
  await reactivateInternal(airtableId, f, env);
}

/**
 * CANCEL keyword — never auto-cancel from inbound. Always surface to
 * owner for review with full context.
 */
async function handleCancelIntent(airtableId, f, text, env) {
  const phone = f['WhatsApp'];
  await sendWhatsApp(env.WH_PHONE,
    `🛑 CANCEL REQUEST: ${f['Business Name']}\n\nMessage: "${text.slice(0, 200)}"\n\nAirtable: ${airtableId}\nPhone: ${phone}\n\nTo process: POST to /cancel-site with { airtableId, option: 'archive'|'file'|'domain' }`,
    env, { skipTestRedirect: true });

  // Soft acknowledgement to client
  const name = f['Client Name']?.split(' ')[0] || 'there';
  await sendWhatsApp(phone,
    `Hi ${name} — got your cancellation message. Pierre will WhatsApp you back within the hour to sort it. — Website Hub`,
    env);

  await logActivity(env, 'cancel_intent_received', { airtableId, phone, snippet: text.slice(0, 100) });
}

/**
 * Generic forward to owner for unmatched intents. Includes client context
 * so the owner can decide what to do.
 */
async function forwardToOwner(phone, text, record, reason, env) {
  const f = record.fields || {};
  const context = record.id
    ? `${f['Business Name'] || 'Unknown'} (${f['Status'] || 'Unknown'} · ${f['Package'] || 'Unknown'})\nAirtable: ${record.id}`
    : 'No matching record';

  await sendWhatsApp(env.WH_PHONE,
    `📩 INBOUND (+${phone}) — ${reason}\n${context}\n\n"${text.slice(0, 300)}"`,
    env, { skipTestRedirect: true });

  await logActivity(env, 'inbound_forwarded', { phone, reason, recordId: record.id });
}

// ============================================================
// HELPERS
// ============================================================

function simpleErrorPage(msg) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0d0d0d;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}.box{max-width:380px;background:#161616;border:1px solid #2a2a2a;border-radius:14px;padding:40px 28px}.icon{font-size:40px;margin-bottom:16px}h2{font-size:20px;margin-bottom:10px}p{color:#888;line-height:1.6;font-size:14px}</style></head><body><div class="box"><div class="icon">⚠️</div><h2>Something went wrong</h2><p>${escapeHtml(msg)}</p></div></body></html>`;
}

// ============================================================
// End of reactivate-worker.js
// ============================================================
