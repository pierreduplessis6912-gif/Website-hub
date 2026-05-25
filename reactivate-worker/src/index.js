// ============================================================
// WEBSITE HUB — reactivate-worker.js
// Owns inbound + churn flow.
//
// ROUTES:
//   POST /cancel-site       Three-branch cancellation (archive/file/domain)
//   GET  /reactivate-site   Prospect win-back PayFast redirect
//   POST /reactivate-site   Admin direct reactivation (no payment)
//   GET  /not-interested    Prospect cooldown (link from outbound watermark)
//   GET  /stop-reply        Permanent opt-out
//   POST /inbound-reply     Meta WhatsApp webhook — verification + intent routing
//   GET  /inbound-reply     Meta webhook verification handshake
//   GET  /health
//
// CANCELLATION OPTIONS:
//   archive — status='cancelled', live KV kept → instant reactivation.
//             Build-worker shows suspended page for status='cancelled'.
//             Pulse-worker fires win-back at 90 days.
//   file    — status='cancelled', live KV deleted. Rebuild needed on reactivation.
//   domain  — status='cancelled', live KV deleted, CF hostname unbound.
//
// KEY ARCHITECTURE NOTES (v2):
//   — Client lookup by phone: D1 getClientByPhone (no Airtable listRecords)
//   — Prospect state: D1 prospects table (not KV prospect_state:*)
//   — Opt-out: KV optout:* (kept — sendWhatsApp already checks this) + D1 clients.opted_out
//   — Cancellation marker: D1 cancellation_date + status='cancelled'
//     (pulse-worker win-back queries this, no KV cancelled:* key needed)
//   — manage_token invalidated by clearing clients.manage_token in D1
//     (no KV manage_token:* key to delete)
//
// NOTE FOR BUILD-WORKER:
//   serveLiveSite() should check status === 'suspended' || status === 'cancelled'
//   to show the suspended page for cancelled (archive) clients.
//   Current build-worker only checks 'suspended'. Minor follow-up fix needed.
// ============================================================

import {
  PRICING, PACKAGE_CAPS,
  PROSPECT_COOLDOWN_DAYS, WIN_BACK_TRIGGER_DAYS,
  isTestMode, packageKey, getPricingTier, buildPayFastLink,
  jsonResponse, corsResponse, htmlResponse,
  slugify, escapeHtml, todayDateString, nextMonthDate,
  sendWhatsApp, normaliseSaPhone,
  logEvent,
  getClientById, getClientByPhone, getClientBySlug, updateClient,
  logMessage,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// INTENT KEYWORDS
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
  let d1Status = 'unknown';
  try { await env.DB.prepare('SELECT 1').first(); d1Status = 'ok'; }
  catch { d1Status = 'error'; }

  return jsonResponse({
    ok: true, worker: 'reactivate-worker',
    time: new Date().toISOString(), testMode: isTestMode(env), d1: d1Status,
  });
}

// ============================================================
// ROUTE: /cancel-site
// Body: { clientId, option: 'archive' | 'file' | 'domain', reason? }
// ============================================================

async function handleCancelSite(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, option = 'archive', reason = '' } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);
  if (!VALID_CANCEL_OPTIONS.includes(option))
    return jsonResponse({ error: `Invalid option — must be one of: ${VALID_CANCEL_OPTIONS.join(', ')}` }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const slug   = client.slug   || slugify(client.business_name);
  const domain = (client.domain || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  // Branch on cancellation option
  if (option === 'archive') {
    // Status = cancelled, live KV kept → instant reactivation if they come back.
    // build-worker should show suspended page for status='cancelled' (see NOTE above).
  } else if (option === 'file') {
    await deleteLiveKvEntries(slug, domain, env);
  } else if (option === 'domain') {
    await deleteLiveKvEntries(slug, domain, env);
    ctx.waitUntil(unbindCustomHostname(domain, env).catch(e => {
      console.warn('CF hostname unbind failed:', e?.message || e);
    }));
  }

  // Update D1 — status + cancellation fields
  await updateClient(env, clientId, {
    status:                  'cancelled',
    cancellation_date:       new Date().toISOString(),
    cancellation_option:     option,
    cancellation_reason:     reason || '',
    monthly_retainer_active: 0,
    manage_token:            null, // invalidate manage URL
  });

  // Client confirmation
  const name = (client.client_name || '').split(' ')[0] || 'there';
  let clientMsg;
  if (option === 'archive') {
    clientMsg = `Hi ${name} — we've paused *${client.business_name}*. No more invoices.\n\nYour site is on hold but kept on file. If you ever want to bring it back, just reply REACTIVATE and we'll have it up in minutes.\n\nAll the best.\n— Pierre, Website Hub`;
  } else if (option === 'file') {
    clientMsg = `Hi ${name} — we've cancelled *${client.business_name}* and removed your site from our servers. No more invoices.\n\nIf you change your mind later, we can rebuild from scratch with our normal subscription. No build fee.\n\nAll the best.\n— Pierre, Website Hub`;
  } else {
    clientMsg = `Hi ${name} — we've cancelled *${client.business_name}* and released your domain (*${domain}*) so you can use it elsewhere.\n\nGood luck with everything.\n— Pierre, Website Hub`;
  }
  await sendWhatsApp(client.phone, clientMsg, env);

  if (client.email) {
    const cancelSubjects = {
      archive: `${client.business_name} has been paused`,
      file:    `${client.business_name} has been cancelled`,
      domain:  `${client.business_name} cancelled — domain released`,
    };
    await sendEmail({
      to: client.email,
      subject: cancelSubjects[option] || `${client.business_name} — cancellation confirmed`,
      touchpoint: 'cancellation_confirmed',
      clientSlug: client.slug,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#111">Cancellation confirmed</h2>
        <p>Hi ${name},</p>
        <p>${clientMsg.replace(/\n/g, '<br>').replace(/\*(.*?)\*/g, '<strong>$1</strong>')}</p>
        <p style="color:#888;font-size:12px">— Pierre, Website Hub</p>
      </div>`,
    }, env).catch(() => {});
  }

  await sendWhatsApp(env.WH_PHONE,
    `🛑 CANCELLED: ${client.business_name}\nOption: ${option}\nReason: ${reason || '(none)'}\nDomain: ${domain}\nClient: ${clientId}\nWin-back in ${WIN_BACK_TRIGGER_DAYS} days.`,
    env, { skipTestRedirect: true });

  await logEvent(env, 'reactivate', 'cancellation', 'success', {
    clientId, metadata: { business: client.business_name, option, reason, domain },
  });

  return jsonResponse({ success: true, option, winBackEligibleIn: WIN_BACK_TRIGGER_DAYS });
}

async function deleteLiveKvEntries(slug, domain, env) {
  const pages = PACKAGE_CAPS.premium.pages; // all possible pages
  for (const p of pages) {
    await env.SITES.delete(`live:${domain}:${p}`).catch(() => {});
  }
  await env.SITES.delete(`live:${domain}`).catch(() => {});
}

async function unbindCustomHostname(hostname, env) {
  if (isTestMode(env)) {
    await env.SITES.put(
      `test_log:cf_unbind:${hostname}:${Date.now()}`,
      JSON.stringify({ hostname, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    return { test_mode: true };
  }
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN || !env.CF_ZONE_ID)
    throw new Error('Cloudflare API not configured');

  const listRes  = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
    { headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` } },
  );
  const listData = await listRes.json();
  if (!listRes.ok || !listData.success)
    throw new Error(`CF list failed: ${JSON.stringify(listData.errors)}`);

  const match = (listData.result || []).find(h => h.hostname === hostname);
  if (!match) return { not_found: true };

  const delRes  = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/custom_hostnames/${match.id}`,
    { method: 'DELETE', headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` } },
  );
  const delData = await delRes.json();
  if (!delRes.ok || !delData.success)
    throw new Error(`CF delete failed: ${JSON.stringify(delData.errors)}`);

  await logEvent(env, 'reactivate', 'hostname_unbound', 'success', { metadata: { hostname, id: match.id } });
  return { unbound: true, id: match.id };
}

// ============================================================
// ROUTE: /reactivate-site
// GET  ?clientId=X → PayFast redirect (win-back link)
// POST { clientId } with x-admin-key → admin direct reactivation
// ============================================================

async function handleReactivateSite(request, env, ctx) {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const clientId = url.searchParams.get('clientId');
    if (!clientId) return htmlResponse(simpleErrorPage('Missing client ID.'), 400);

    const client = await getClientById(env, clientId).catch(() => null);
    if (!client) return htmlResponse(simpleErrorPage('Record not found.'), 404);

    const tier = PRICING[packageKey(client.package || 'standard')];

    // Flip to suspended so launch-worker.handleGoLivePayment routes it as reinstatement
    await updateClient(env, clientId, { status: 'suspended' });

    const payLink = buildPayFastLink(tier.retainer, 'Website Hub Reactivation', clientId, env, {
      returnUrl: `https://preview.websitehub.co.za/${client.slug || slugify(client.business_name)}`,
      notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
    });

    return Response.redirect(payLink, 302);
  }

  if (request.method !== 'POST') return jsonResponse({ error: 'GET or POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId } = body;
  if (!clientId) return jsonResponse({ error: 'Missing clientId' }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  ctx.waitUntil(reactivateInternal(client, env));
  return jsonResponse({ success: true, message: 'Reactivation started' });
}

async function reactivateInternal(client, env) {
  const slug   = client.slug   || slugify(client.business_name);
  const domain = (client.domain || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  // Check if live KV still exists (archive path — instant reactivation)
  const hasLive = await env.SITES.get(`live:${domain}`);

  if (hasLive) {
    // Archive path: live KV exists, just flip status back to live
    await updateClient(env, client.id, {
      status:                  'live',
      monthly_retainer_active: 1,
      next_invoice_date:       nextMonthDate(),
      cancellation_date:       null,
      cancellation_option:     null,
      cancellation_reason:     null,
    });

    const name = (client.client_name || '').split(' ')[0] || 'there';
    await sendWhatsApp(client.phone,
      `✅ Welcome back, ${name}! *${client.business_name}* is live again at https://${domain}\n\n— Pierre, Website Hub`,
      env);

    if (client.email) {
      await sendEmail({
        to: client.email,
        subject: `Welcome back — ${client.business_name} is live again ✓`,
        touchpoint: 'reactivated_archive',
        clientSlug: client.slug,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#111">You're back online ✅</h2>
          <p>Hi ${name},</p>
          <p><strong>${client.business_name}</strong> is live again at <a href="https://${domain}">${domain}</a>. Great to have you back.</p>
          <p style="margin:24px 0"><a href="https://${domain}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">Visit My Site</a></p>
          <p style="color:#888;font-size:12px">— Pierre, Website Hub</p>
        </div>`,
      }, env).catch(() => {});
    }
  } else {
    // File/domain path: live KV was deleted — queue a fresh rebuild
    await updateClient(env, client.id, {
      status:            'lead',
      cancellation_date: null,
      cancellation_option: null,
    });

    await env.BUILD_QUEUE.send({ clientId: client.id, paymentId: null, isOutbound: false });

    const name = (client.client_name || '').split(' ')[0] || 'there';
    await sendWhatsApp(client.phone,
      `🎉 Welcome back, ${name}! We're rebuilding *${client.business_name}* now — you'll have a fresh preview in about 10 minutes.\n\n— Pierre, Website Hub`,
      env);

    if (client.email) {
      await sendEmail({
        to: client.email,
        subject: `Welcome back — rebuilding ${client.business_name} now`,
        touchpoint: 'reactivated_rebuild',
        clientSlug: client.slug,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
          <h2 style="color:#111">Welcome back! 🎉</h2>
          <p>Hi ${name},</p>
          <p>We're rebuilding <strong>${client.business_name}</strong> right now. You'll have a fresh preview in about 10 minutes.</p>
          <p style="color:#888;font-size:12px">— Pierre, Website Hub</p>
        </div>`,
      }, env).catch(() => {});
    }
  }

  await sendWhatsApp(env.WH_PHONE,
    `🎉 REACTIVATED: ${client.business_name}\nDomain: ${domain}\nClient: ${client.id}`,
    env, { skipTestRedirect: true });

  await logEvent(env, 'reactivate', 'reactivation', 'success', {
    clientId: client.id, metadata: { business: client.business_name, domain },
  });
}

// ============================================================
// ROUTE: /not-interested — prospect cooldown
// GET ?slug=X&phone=Y from outbound watermark "Not interested" link
// ============================================================

async function handleNotInterested(request, url, env) {
  const slug  = url.searchParams.get('slug');
  const phone = url.searchParams.get('phone');

  let clientId = null, businessName = null, normalisedPhone = null;

  if (phone) {
    normalisedPhone = normaliseSaPhone(phone);
    const client = await getClientByPhone(env, normalisedPhone).catch(() => null);
    if (client) { clientId = client.id; businessName = client.business_name; }
  }
  if (!clientId && slug) {
    const client = await getClientBySlug(env, slug).catch(() => null);
    if (client) { clientId = client.id; businessName = client.business_name; normalisedPhone = normalisedPhone || client.phone; }
  }

  if (clientId) {
    // Set prospect cooldown in D1 prospects table
    await env.DB.prepare(
      `UPDATE prospects SET status = 'rejected',
       cooldown_until = datetime('now', '+${PROSPECT_COOLDOWN_DAYS} days')
       WHERE phone = ?`
    ).bind(normalisedPhone || '').run().catch(() => {});

    // Mark client as not-interested (optional status update for prospects-as-clients)
    await updateClient(env, clientId, { conversation_state: 'CLOSED' }).catch(() => {});
  }

  // KV prospect state cleanup
  if (normalisedPhone) {
    await env.SITES.delete(`prospect_state:${normalisedPhone}`).catch(() => {});
  }

  await sendWhatsApp(env.WH_PHONE,
    `❌ NOT INTERESTED: ${businessName || slug || normalisedPhone || 'unknown prospect'}\n${PROSPECT_COOLDOWN_DAYS}-day cooldown set.`,
    env, { skipTestRedirect: true });

  await logEvent(env, 'reactivate', 'prospect_not_interested', 'success', {
    clientId, metadata: { slug, phone: normalisedPhone },
  });

  return htmlResponse(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>No problem</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0d0d0d;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}.box{max-width:380px;background:#161616;border:1px solid #2a2a2a;border-radius:14px;padding:40px 28px}.icon{font-size:40px;margin-bottom:16px}h2{font-size:22px;font-weight:800;margin-bottom:10px}p{color:#888;line-height:1.7;font-size:14px}</style></head><body><div class="box"><div class="icon">👋</div><h2>No problem at all</h2><p>We won't contact you again. All the best with your business.</p></div></body></html>`);
}

// ============================================================
// ROUTE: /stop-reply — permanent opt-out
// KV optout:* kept (sendWhatsApp checks it) + D1 clients.opted_out
// ============================================================

async function handleStopReply(request, url, env) {
  let phone = url.searchParams.get('phone');
  if (!phone && request.method === 'POST') {
    try { const body = await request.json(); phone = body.phone; } catch { /* fall through */ }
  }
  if (!phone) return htmlResponse(simpleErrorPage('Missing phone parameter.'), 400);

  const normalisedPhone = normaliseSaPhone(phone);
  if (!normalisedPhone) return htmlResponse(simpleErrorPage('Invalid phone format.'), 400);

  // KV optout — sendWhatsApp checks this on every send
  await env.SITES.put(`optout:${normalisedPhone}`, new Date().toISOString());

  // D1 opt-out
  const client = await getClientByPhone(env, normalisedPhone).catch(() => null);
  if (client) {
    await updateClient(env, client.id, { opted_out: 1, opted_out_at: new Date().toISOString() }).catch(() => {});
  }

  // D1 prospect cooldown
  await env.DB.prepare(
    `UPDATE prospects SET status = 'opted_out', cooldown_until = datetime('now', '+3650 days')
     WHERE phone = ?`
  ).bind(normalisedPhone).run().catch(() => {});

  // Clean up KV prospect state
  await env.SITES.delete(`prospect_state:${normalisedPhone}`).catch(() => {});

  await sendWhatsApp(env.WH_PHONE,
    `🚫 OPT-OUT: +${normalisedPhone}`,
    env, { skipTestRedirect: true });

  await logEvent(env, 'reactivate', 'opt_out', 'success', { metadata: { phone: normalisedPhone } });

  return htmlResponse(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Opted out</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0d0d0d;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}.box{max-width:380px;background:#161616;border:1px solid #2a2a2a;border-radius:14px;padding:40px 28px}.icon{font-size:40px;margin-bottom:16px}h2{font-size:22px;font-weight:800;margin-bottom:10px}p{color:#888;line-height:1.7;font-size:14px}</style></head><body><div class="box"><div class="icon">✓</div><h2>You're opted out</h2><p>We won't message you again. All the best.</p></div></body></html>`);
}

// ============================================================
// ROUTE: /inbound-reply — Meta WhatsApp webhook
// ============================================================

async function handleInboundReply(request, env, ctx) {
  const url = new URL(request.url);

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

  const rawBody = await request.text();

  if (env.META_WEBHOOK_SECRET) {
    const sigHeader = request.headers.get('x-hub-signature-256');
    if (!sigHeader || !(await verifyMetaSignature(rawBody, sigHeader, env.META_WEBHOOK_SECRET))) {
      await logEvent(env, 'reactivate', 'meta_webhook_sig_fail', 'failure');
      return new Response('Invalid signature', { status: 401 });
    }
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return new Response('Invalid JSON', { status: 400 }); }

  const messages = extractInboundMessages(payload);
  if (messages.length === 0) return new Response('OK', { status: 200 });

  ctx.waitUntil(processInboundMessages(messages, env));
  await logEvent(env, 'reactivate', 'meta_webhook', 'success', { metadata: { count: messages.length } });
  return new Response('OK', { status: 200 });
}

async function verifyMetaSignature(body, signatureHeader, secret) {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const sig    = await crypto.subtle.sign('HMAC', key, enc.encode(body));
    const sigHex = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return `sha256=${sigHex}` === signatureHeader;
  } catch (e) {
    console.warn('Signature verification error:', e);
    return false;
  }
}

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
      await logEvent(env, 'reactivate', 'inbound_routing_error', 'failure', {
        metadata: { from: msg.from, error: e.message },
      });
    }
  }
}

/**
 * Intent router. Looks up D1 client + prospect state, routes by keyword.
 * Priority: STOP > prospect state > client context intents > forward
 */
async function routeInboundMessage(msg, env) {
  const phone = normaliseSaPhone(msg.from);
  const text  = String(msg.text || '').trim();
  const upper = text.toUpperCase();

  // ── 1. STOP (always wins) ────────────────────────────────────
  if (matchesAny(upper, INTENT_KEYWORDS.optOut)) {
    return handleOptOutIntent(phone, env);
  }

  // ── 2. D1 lookup — client by phone ──────────────────────────
  const client = await getClientByPhone(env, phone).catch(() => null);

  // ── 3. D1 prospect state lookup ─────────────────────────────
  const prospect = await env.DB.prepare(
    `SELECT * FROM prospects WHERE phone = ? AND status IN ('pending') LIMIT 1`
  ).bind(phone).first().catch(() => null);

  // ── 4. Active prospect — first reply is opt-in ──────────────
  if (prospect && !client) {
    return handleProspectOptIn(phone, text, prospect, env);
  }

  // ── 5. KV prospect state (legacy — outbound pre-D1 records) ─
  const legacyStateRaw = await env.SITES.get(`prospect_state:${phone}`).catch(() => null);
  const legacyState    = legacyStateRaw ? (() => { try { return JSON.parse(legacyStateRaw); } catch { return null; } })() : null;
  if (legacyState && (legacyState.phase === 'sent' || legacyState.phase === 'follow_up_sent')) {
    return handleLegacyProspectOptIn(phone, text, legacyState, env);
  }

  // ── 6. Client-context intents ────────────────────────────────
  if (client) {
    const status = client.status || '';

    if (matchesAny(upper, INTENT_KEYWORDS.yes)) {
      const goLiveDate = client.go_live_date;
      const gbpStatus  = client.gbp_status || '';
      if (status === 'live' && goLiveDate && !gbpStatus) {
        const daysSinceLive = Math.floor((Date.now() - new Date(goLiveDate).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceLive <= 7) return handleGbpOptIn(client.id, env);
      }
      return forwardToOwner(phone, text, client, 'yes-ambiguous', env);
    }

    if (matchesAny(upper, INTENT_KEYWORDS.upgrade)) {
      return handleUpgradeIntent(client, upper, env);
    }

    if (matchesAny(upper, INTENT_KEYWORDS.reactivate)) {
      if (status === 'cancelled') return handleReactivateIntent(client, env);
      return forwardToOwner(phone, text, client, 'reactivate-not-cancelled', env);
    }

    if (matchesAny(upper, INTENT_KEYWORDS.cancel)) {
      return handleCancelIntent(client, text, env);
    }

    return forwardToOwner(phone, text, client, 'unrecognised', env);
  }

  // ── 7. Unknown sender ────────────────────────────────────────
  await sendWhatsApp(env.WH_PHONE,
    `📩 UNKNOWN SENDER (+${phone})\n\n"${text.slice(0, 200)}"\n\nNot in D1. May be wrong number or organic outreach.`,
    env, { skipTestRedirect: true });
  await logEvent(env, 'reactivate', 'inbound_unknown', 'warning', {
    metadata: { phone, snippet: text.slice(0, 100) },
  });
}

function matchesAny(upper, keywords) {
  for (const kw of keywords) {
    const re = new RegExp(`(^|\\s|\\W)${escapeRegex(kw)}($|\\s|\\W)`, 'i');
    if (re.test(upper)) return true;
  }
  return false;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ============================================================
// INBOUND INTENT HANDLERS
// ============================================================

async function handleOptOutIntent(phone, env) {
  await env.SITES.put(`optout:${phone}`, new Date().toISOString());
  await env.SITES.delete(`prospect_state:${phone}`).catch(() => {});

  // D1 opt-out
  const client = await getClientByPhone(env, phone).catch(() => null);
  if (client) {
    await updateClient(env, client.id, { opted_out: 1, opted_out_at: new Date().toISOString() }).catch(() => {});
  }

  await sendWhatsApp(phone,
    `Got it — we won't message you again. All the best. — Website Hub`,
    env);

  await sendWhatsApp(env.WH_PHONE,
    `🚫 OPTED OUT: +${phone}`,
    env, { skipTestRedirect: true });

  await logEvent(env, 'reactivate', 'opt_out', 'success', { metadata: { phone } });
}

async function handleProspectOptIn(phone, text, prospect, env) {
  const upper = text.toUpperCase().trim();

  if (matchesAny(upper, INTENT_KEYWORDS.no)) {
    await env.DB.prepare(
      `UPDATE prospects SET status = 'rejected',
       cooldown_until = datetime('now', '+${PROSPECT_COOLDOWN_DAYS} days')
       WHERE id = ?`
    ).bind(prospect.id).run().catch(() => {});
    await logEvent(env, 'reactivate', 'prospect_declined', 'success', { metadata: { phone } });
    return;
  }

  const nameGuess  = text.split(/\s+/).slice(0, 2).join(' ').slice(0, 40).replace(/[^a-zA-Z\s'-]/g, '').trim();
  const clientName = nameGuess
    ? nameGuess.split(/\s+/).map(w => w[0]?.toUpperCase() + w.slice(1).toLowerCase()).join(' ')
    : 'there';

  // If prospect already has a linked client_id, use that; otherwise create client record
  let clientId = prospect.client_id;
  if (!clientId) {
    // Create client record from prospect data
    try {
      const { createClient, slugify: sl } = await import('./shared-services.js');
      const result = await createClient(env, {
        business_name: prospect.business_name,
        client_name:   clientName,
        phone:         phone,
        industry:      prospect.industry || 'Other',
        area:          prospect.area     || '',
        about:         prospect.about    || '',
        services:      prospect.services || '',
        vibe:          'bold_confident',
        status:        'lead',
        source:        'outbound',
        package:       'standard',
        retainer:      PRICING.standard.retainer,
      });
      clientId = result.id;
      await env.DB.prepare(`UPDATE prospects SET client_id = ?, status = 'built' WHERE id = ?`)
        .bind(clientId, prospect.id).run().catch(() => {});
    } catch (e) {
      console.warn('Failed to create client from prospect opt-in:', e?.message || e);
    }
  } else {
    await updateClient(env, clientId, { client_name: clientName, status: 'lead' }).catch(() => {});
  }

  if (clientId) {
    await env.BUILD_QUEUE.send({ clientId, paymentId: null, isOutbound: true });
  }

  await sendWhatsApp(phone,
    `Brilliant ${clientName} 👋 We're building your free website preview right now — you'll have the link in about 2 minutes. Sit tight!\n\n— Website Hub`,
    env);

  const prospectClient = clientId ? await getClientById(env, clientId).catch(() => null) : null;
  if (prospectClient?.email) {
    await sendEmail({
      to: prospectClient.email,
      subject: `Building your free ${prospectClient.business_name} website now`,
      touchpoint: 'prospect_opted_in',
      clientSlug: prospectClient.slug,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#111">Building your preview now 🔨</h2>
        <p>Hi ${clientName},</p>
        <p>We're building your free <strong>${prospectClient.business_name}</strong> website preview right now. You'll have the link in about 2 minutes.</p>
        <p style="color:#888;font-size:12px">— Website Hub</p>
      </div>`,
    }, env).catch(() => {});
  }

  await sendWhatsApp(env.WH_PHONE,
    `✅ PROSPECT OPTED IN: "${clientName}" (+${phone})\nClient: ${clientId || 'creation failed'}\nBuild queued.`,
    env, { skipTestRedirect: true });

  await logEvent(env, 'reactivate', 'prospect_opted_in', 'success', {
    clientId, metadata: { phone, name: clientName },
  });
}

/** Handles legacy KV-based prospect state (pre-D1 records). */
async function handleLegacyProspectOptIn(phone, text, prospectState, env) {
  const upper = text.toUpperCase().trim();
  if (matchesAny(upper, INTENT_KEYWORDS.no)) {
    await env.SITES.put(`prospect_state:${phone}`, JSON.stringify({
      ...prospectState, phase: 'declined', declinedAt: new Date().toISOString(),
    }), { expirationTtl: 60 * 60 * 24 * PROSPECT_COOLDOWN_DAYS }).catch(() => {});
    return;
  }

  const nameGuess  = text.split(/\s+/).slice(0, 2).join(' ').slice(0, 40).replace(/[^a-zA-Z\s'-]/g, '').trim();
  const clientName = nameGuess || 'there';

  if (prospectState.clientId || prospectState.airtableId) {
    const clientId = prospectState.clientId;
    if (clientId) {
      await updateClient(env, clientId, { client_name: clientName, status: 'lead' }).catch(() => {});
      await env.BUILD_QUEUE.send({ clientId, paymentId: null, isOutbound: true });
    }
  }

  await env.SITES.put(`prospect_state:${phone}`, JSON.stringify({
    ...prospectState, phase: 'opted_in', optedInAt: new Date().toISOString(),
  }), { expirationTtl: 60 * 60 * 24 * 30 }).catch(() => {});

  await sendWhatsApp(phone,
    `Brilliant ${clientName} 👋 We're building your free website preview right now — you'll have the link in about 2 minutes!\n\n— Website Hub`,
    env);
}

async function handleGbpOptIn(clientId, env) {
  const launchUrl = env.WORKER_URL_LAUNCH;
  if (!launchUrl) {
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ GBP opt-in received but WORKER_URL_LAUNCH not configured. Process manually for ${clientId}.`,
      env, { skipTestRedirect: true });
    return;
  }
  try {
    const res = await fetch(`${launchUrl}/google-profile`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
      body:    JSON.stringify({ clientId }),
    });
    if (!res.ok) throw new Error(`launch-worker GBP call failed: ${res.status}`);
    await logEvent(env, 'reactivate', 'gbp_optin', 'success', { clientId });
  } catch (err) {
    console.warn('GBP opt-in forward failed:', err?.message || err);
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ GBP opt-in forward failed for ${clientId}: ${err.message}`,
      env, { skipTestRedirect: true });
  }
}

async function handleUpgradeIntent(client, upper, env) {
  const launchUrl = env.WORKER_URL_LAUNCH;
  if (!launchUrl) {
    return forwardToOwner(client.phone, 'UPGRADE intent', client, 'no-launch-worker', env);
  }

  const currentPkg = packageKey(client.package || 'standard');
  let target;
  if (upper.includes('PREMIUM'))  target = 'premium';
  else if (upper.includes('STANDARD')) target = 'standard';
  else target = currentPkg === 'express' ? 'standard' : 'premium';

  if (currentPkg === target) {
    await sendWhatsApp(client.phone,
      `Hi! You're already on *${client.package}* — nothing to upgrade to that tier. Reply if you'd like to go higher.\n— Website Hub`,
      env);
    return;
  }

  try {
    const res  = await fetch(`${launchUrl}/upgrade`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientId: client.id, target }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    await logEvent(env, 'reactivate', 'upgrade_intent', 'success', {
      clientId: client.id, metadata: { target, delta: data.delta },
    });
  } catch (err) {
    console.warn('Upgrade intent forward failed:', err?.message || err);
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Upgrade intent forward failed for ${client.business_name}: ${err.message}`,
      env, { skipTestRedirect: true });
  }
}

async function handleReactivateIntent(client, env) {
  await reactivateInternal(client, env);
}

async function handleCancelIntent(client, text, env) {
  await sendWhatsApp(env.WH_PHONE,
    `🛑 CANCEL REQUEST: ${client.business_name}\n\nMessage: "${text.slice(0, 200)}"\n\nClient: ${client.id}\nPhone: ${client.phone}\n\nTo process: POST /cancel-site { clientId, option: 'archive'|'file'|'domain' }`,
    env, { skipTestRedirect: true });

  const name = (client.client_name || '').split(' ')[0] || 'there';
  await sendWhatsApp(client.phone,
    `Hi ${name} — got your cancellation message. Pierre will WhatsApp you back within the hour to sort it. — Website Hub`,
    env);

  if (client.email) {
    await sendEmail({
      to: client.email,
      subject: `We got your cancellation request — ${client.business_name}`,
      touchpoint: 'cancel_intent',
      clientSlug: client.slug,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#111">Cancellation request received</h2>
        <p>Hi ${name},</p>
        <p>We've received your cancellation request for <strong>${client.business_name}</strong>. Pierre will be in touch within the hour to sort everything out.</p>
        <p style="color:#888;font-size:12px">— Website Hub</p>
      </div>`,
    }, env).catch(() => {});
  }

  await logEvent(env, 'reactivate', 'cancel_intent', 'success', {
    clientId: client.id, metadata: { snippet: text.slice(0, 100) },
  });
}

async function forwardToOwner(phone, text, client, reason, env) {
  const context = client?.id
    ? `${client.business_name || 'Unknown'} (${client.status || 'Unknown'} · ${client.package || 'Unknown'})\nClient: ${client.id}`
    : 'No matching D1 record';

  await sendWhatsApp(env.WH_PHONE,
    `📩 INBOUND (+${phone}) — ${reason}\n${context}\n\n"${String(text).slice(0, 300)}"`,
    env, { skipTestRedirect: true });

  if (client?.id) {
    await logEvent(env, 'reactivate', 'inbound_forwarded', 'success', {
      clientId: client.id, metadata: { phone, reason },
    });
  }
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
