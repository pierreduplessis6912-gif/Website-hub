// ============================================================
// WEBSITE HUB — pulse-worker.js
// The daily cron orchestrator. Owns everything time-driven:
//   — Late payment dunning (D0 reminder → D3 nudge → D7 firm → D14 suspend)
//   — Post-go-live touches (D1 check-in, D7 referral nudge, D30 upsell)
//   — Win-back at 90 days post-cancellation
//   — Prospect limbo follow-up (outbound replies that never came)
//   — Referral credit vesting (30 days after referred client goes live)
//   — Leaderboard cache pre-computation (daily snapshot)
//   — Monthly summary hosted page generation + WhatsApp report (1st of month)
//   — Monthly visit totals written back to Airtable (1st of month)
//   — Message queue draining (during send window only)
//
// ROUTES OWNED:
//   POST /run-cron               — manual trigger (admin)
//   GET  /summary/{slug}/{month} — serves monthly summary HTML from KV
//   POST /track-fab              — records WhatsApp FAB taps (called by site JS)
//   POST /track-page-view        — alternate page view ping (called by site JS)
//   GET  /health                 — service health
//
// CRON TRIGGERS (wrangler.toml):
//   "0 6 * * *"          — daily 06:00 UTC = 08:00 SAST: main cron
//   "*/15 7-10 * * 2-4"  — every 15 min 09:00-12:59 SAST Tue-Thu: queue drain
//
// IDEMPOTENCY:
//   Every sequence guards on a "sent" KV key so reruns don't fire twice.
//   Keys: dunning_sent:{airtableId}:{stage}, golive_sent:{airtableId}:{day},
//   winback_sent:{airtableId}, referral_credited:{referredId},
//   monthly_summary_sent:{airtableId}:{YYYY-MM}, etc.
//
// ENV VARS NEEDED:
//   RESEND_API_KEY        — for invoice emails
//   WORKER_URL_LAUNCH     — for suspend-site calls
//
// TEST_MODE behaviour:
//   Cron still runs. WhatsApp messages get redirected to WH_PHONE by
//   sendWhatsApp. Zoho credit notes get logged to KV by createZohoCreditNote.
//   The only thing genuinely skipped is calling suspend on real domains —
//   we still write the suspended:{domain} KV key so the flow can be tested,
//   but the message clearly says [TEST] so you can identify dry runs.
//
// CROSS-WORKER:
//   Calls launch-worker /suspend-site for auto-suspension at D14 late.
// ============================================================

import {
  PRICING, PACKAGE_CAPS,
  PREVIEW_EXPIRY_DAYS, REFERRAL_VEST_DAYS, WIN_BACK_TRIGGER_DAYS, PROSPECT_COOLDOWN_DAYS,
  SAST_OFFSET_MS,
  isTestMode, packageKey, getPricingTier, getPackageCaps, buildPayFastLink,
  jsonResponse, corsResponse, htmlResponse,
  slugify, escapeHtml, currentMonthKey, todayDateString,
  sendWhatsApp, queueScheduledMessage, processMessageQueue,
  getClientById, getClientBySlug, queryClients, updateClient,
  logActivity, logHealth, getFlag,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

// Late payment dunning stages — days past Next Invoice Date
const DUNNING_STAGES = [
  { day: 0,  stage: 'reminder',  tone: 'polite'  },
  { day: 3,  stage: 'nudge',     tone: 'friendly'},
  { day: 7,  stage: 'firm',      tone: 'firm'    },
  { day: 14, stage: 'suspend',   tone: 'final'   },
];

// Prospect follow-up — N days after first outbound message with no reply
const PROSPECT_FOLLOWUP_DAY = 4;

// Post-go-live cadence
const POST_GOLIVE_DAYS = [1, 7, 30];

// Monthly summary KV TTL — 60 days so clients can look back two months
const MONTHLY_SUMMARY_TTL = 60 * 60 * 24 * 60;

// ────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/run-cron')               return handleRunCron(request, env, ctx);
    if (path.startsWith('/summary/'))       return handleSummaryPage(request, env, path);
    if (path === '/track-fab')              return handleTrackFab(request, env);
    if (path === '/track-page-view')        return handleTrackPageView(request, env);
    if (path === '/health')                 return handleHealth(env);

    return jsonResponse({ error: 'Not found', path }, 404);
  },

  async scheduled(event, env, ctx) {
    const cronExpr = event.cron;
    const sast     = new Date(Date.now() + SAST_OFFSET_MS);
    const hour     = sast.getUTCHours();

    // Queue-drain cron (every 15 min during send window) — lightweight
    if (cronExpr.includes('/15') || (hour >= 9 && hour < 12)) {
      ctx.waitUntil(processMessageQueue(env));
      return;
    }

    // Daily orchestrator
    ctx.waitUntil(runDailyCron(env));
  },
};

// ============================================================
// ROUTE: /health
// ============================================================

async function handleHealth(env) {
  const services = ['airtable', 'whatsapp', 'zoho', 'cron'];
  const health = {};
  for (const svc of services) {
    try {
      const raw = await env.SITES.get(`health:${svc}`);
      health[svc] = raw ? JSON.parse(raw) : { status: 'unknown' };
    } catch { health[svc] = { status: 'unknown' }; }
  }
  return jsonResponse({
    ok:       true,
    worker:   'pulse-worker',
    time:     new Date().toISOString(),
    testMode: isTestMode(env),
    services: health,
  });
}

// ============================================================
// ROUTE: /run-cron — manual trigger (admin)
// ============================================================

async function handleRunCron(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  ctx.waitUntil(runDailyCron(env));
  return jsonResponse({ success: true, message: 'Daily cron started in background' });
}

// ============================================================
// ROUTE: /summary/{slug}/{YYYY-MM} — serve monthly summary HTML
// ============================================================

async function handleSummaryPage(request, env, path) {
  if (request.method !== 'GET') return jsonResponse({ error: 'GET only' }, 405);

  // path = /summary/{slug}/{YYYY-MM}
  const parts = path.replace(/^\/summary\//, '').split('/');
  if (parts.length < 2) return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px">Invalid summary URL.</body></html>`, 400);

  const slug  = parts[0];
  const month = parts[1];
  if (!/^\d{4}-\d{2}$/.test(month)) return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px">Invalid month format.</body></html>`, 400);

  const html = await env.SITES.get(`monthly_summary:${slug}:${month}`);
  if (!html) {
    return htmlResponse(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Summary not ready</title></head><body style="font-family:Arial;text-align:center;padding:60px;background:#0d0d0d;color:#f0ede8"><div style="max-width:400px;margin:auto"><div style="font-size:48px;margin-bottom:16px">⏳</div><h2>Summary not ready yet</h2><p style="color:#666;line-height:1.6;margin-top:12px">Monthly summaries are generated on the 1st of each month. If you're seeing this on or after the 1st, please give it a few hours.</p></div></body></html>`, 404);
  }

  return htmlResponse(html, 200);
}

// ============================================================
// ROUTE: /track-fab — WhatsApp FAB tap counter
// ============================================================

async function handleTrackFab(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { slug } = body;
  if (!slug) return corsResponse(null, 204); // silent no-op so client JS doesn't error-loop

  const monthStr = currentMonthKey();
  const key      = `fab_taps:${slug}:${monthStr}`;
  try {
    const current = parseInt(await env.SITES.get(key).catch(() => '0') || '0');
    await env.SITES.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch { /* non-fatal */ }

  return corsResponse(null, 204);
}

// ============================================================
// ROUTE: /track-page-view — alternate page view recorder
// build-worker already records per-page visits server-side. This endpoint
// exists for clients that want to track soft navigations or anchor links
// that don't trigger a full page load.
// ============================================================

async function handleTrackPageView(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { slug, page } = body;
  if (!slug || !page) return corsResponse(null, 204);

  const today    = todayDateString();
  const countKey = `visits:${slug}:${today}`;
  const pageKey  = `visits:${slug}:${page}:${today}`;
  try {
    const v1 = parseInt(await env.SITES.get(countKey).catch(() => '0') || '0');
    const v2 = parseInt(await env.SITES.get(pageKey).catch(() => '0')  || '0');
    await env.SITES.put(countKey, String(v1 + 1), { expirationTtl: 60 * 60 * 24 * 35 });
    await env.SITES.put(pageKey,  String(v2 + 1), { expirationTtl: 60 * 60 * 24 * 35 });
  } catch { /* non-fatal */ }

  return corsResponse(null, 204);
}

// ============================================================
// DAILY CRON ORCHESTRATOR
// Calls each sub-sequence in order. Each is internally idempotent
// and tolerant of individual failures so one bad sequence doesn't
// block the rest.
// ============================================================

async function runDailyCron(env) {
  const startTs = Date.now();
  const today   = todayDateString();
  const sast    = new Date(Date.now() + SAST_OFFSET_MS);
  const dayOfMonth = sast.getUTCDate();
  const monthStr = currentMonthKey();

  await logActivity(env, 'cron_started', { date: today });

  const sequences = [
    { name: 'message_queue',         fn: () => processMessageQueue(env) },
    { name: 'monthly_invoicing',      fn: () => runMonthlyInvoicing(env, today) },
    { name: 'late_payment_dunning',  fn: () => runLatePaymentDunning(env, today) },
    { name: 'post_golive',           fn: () => runPostGoLiveSequences(env, today) },
    { name: 'win_back',              fn: () => runWinBackCron(env, today) },
    { name: 'prospect_followup',     fn: () => runProspectLimboFollowUp(env, today) },
    { name: 'referral_vesting',      fn: () => runReferralVesting(env, today) },
    { name: 'promo_nudge',           fn: () => runPromoNudge(env) },
    { name: 'outbound_scrape',        fn: () => runOutboundScrape(env) },
    { name: 'leaderboard_cache',     fn: () => precomputeLeaderboard(env, monthStr) },
    { name: 'showcase_validation',   fn: () => validateShowcaseQueue(env) },
  ];

  // 1st of month: monthly summary + visit totals
  if (dayOfMonth === 1) {
    sequences.push({ name: 'monthly_visit_totals', fn: () => runMonthlyVisitTotals(env) });
    sequences.push({ name: 'monthly_summary',      fn: () => runMonthlySummary(env) });
  }

  const results = {};
  for (const { name, fn } of sequences) {
    try {
      const r = await fn();
      results[name] = r || 'ok';
    } catch (err) {
      console.warn(`Cron sequence "${name}" failed:`, err);
      results[name] = `error: ${err.message}`;
      await logActivity(env, 'cron_sequence_error', { sequence: name, error: err.message });
    }
  }

  const elapsedMs = Date.now() - startTs;
  await logActivity(env, 'cron_completed', { date: today, elapsedMs, results });
  await logHealth(env, 'cron', 'success');
}

// ============================================================
// SEQUENCE: late payment dunning
// Stages: D0 reminder → D3 nudge → D7 firm → D14 suspend
// Idempotency: dunning_sent:{airtableId}:{stage} KV with 21-day TTL.
// Suspension at D14 calls launch-worker /suspend-site server-to-server.
// ============================================================

// ============================================================
// SEQUENCE: monthly invoicing
// Fires on the day next_invoice_date = today.
// Generates invoice in D1, sends HTML email via Resend,
// sends PayFast payment link via WhatsApp.
// ============================================================

async function runMonthlyInvoicing(env, today) {
  // Find live clients whose invoice is due TODAY (exact match — dunning handles overdue)
  const clients = await queryClients(env, `status='live' AND next_invoice_date=?`, [today]).catch(() => []);

  let processed = 0;

  for (const client of clients) {
    const guardKey = `invoice_sent:${client.id}:${today}`;
    const alreadySent = await env.SITES.get(guardKey).catch(() => null);
    if (alreadySent) continue;

    try {
      const tier       = getPricingTier(client.package || 'standard');
      const isAnnual   = (client.billing_cycle || 'monthly') === 'annual';
      const retainer   = isAnnual ? (tier?.retainer || 399) * 10 : (tier?.retainer || 399);
      const invoiceNum = `WH-${today.replace(/-/g, '')}-${client.slug.toUpperCase().slice(0, 6)}`;
      const nextDate   = isAnnual ? nextYearDateFrom(today) : nextMonthDateFrom(today);

      // Check for vested promo code
      const promoRow = await env.DB.prepare(
        `SELECT promo_code, credit_amount FROM referral_credits 
         WHERE client_id=? AND status='vested' AND used_at IS NULL LIMIT 1`
      ).bind(client.id).first().catch(() => null);

      const creditAmount = promoRow?.credit_amount || 0;
      const amountDue    = Math.max(0, retainer - creditAmount);
      const promoCode    = promoRow?.promo_code || null;

      // Generate PayFast link
      const payLink = buildPayFastLink(
        amountDue || retainer, // never send R0 to PayFast
        'Website Hub Monthly Subscription',
        client.id,
        env,
        {
          notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined,
          customStr2: `retainer:${client.package}`,
        }
      );

      // Store invoice in D1
      await env.DB.prepare(`
        INSERT OR IGNORE INTO invoices 
        (id, client_id, slug, invoice_num, amount, credit_applied, promo_code_used, description, type, status, due_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'retainer', 'pending', ?, datetime('now'))
      `).bind(
        crypto.randomUUID(), client.id, client.slug, invoiceNum,
        amountDue, creditAmount, promoCode,
        `${client.business_name} — ${(client.package || 'standard').charAt(0).toUpperCase() + (client.package || 'standard').slice(1)} Plan Monthly Retainer`,
        today
      ).run().catch(() => null);

      // Mark promo as used
      if (promoRow) {
        await env.DB.prepare(
          `UPDATE referral_credits SET used_at=datetime('now'), status='redeemed' WHERE promo_code=?`
        ).bind(promoCode).run().catch(() => null);
      }

      // Send HTML invoice email via Resend
      if (client.email && env.RESEND_API_KEY) {
        const invoiceHtml = buildInvoiceEmail({
          clientName:   client.client_name || client.business_name,
          businessName: client.business_name,
          slug:         client.slug,
          invoiceNum,
          retainer,
          creditAmount,
          amountDue,
          promoCode,
          dueDate:      today,
          nextDate,
          payLink,
          plan:         client.package || 'standard',
        });

        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.RESEND_API_KEY}`,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({
            from:    'invoices@websitehub.co.za',
            to:      [client.email],
            subject: `Invoice ${invoiceNum} — R${amountDue} due today`,
            html:    invoiceHtml,
          }),
        }).catch(e => console.warn('Resend invoice failed:', e?.message));
      }

      // Send WhatsApp payment link
      const name = (client.client_name || client.business_name || '').split(' ')[0] || 'there';
      let waMsg = `Hi ${name} 👋

`;
      waMsg += `Your *${client.business_name}* monthly invoice is ready.

`;
      if (creditAmount > 0) {
        waMsg += `✨ Referral credit applied: -R${creditAmount}
`;
        waMsg += `💳 Amount due: *R${amountDue}*

`;
      } else {
        waMsg += `💳 Amount due: *R${retainer}*

`;
      }
      waMsg += `Pay here: ${payLink}

`;
      waMsg += `Invoice: ${invoiceNum} · Due today
— Website Hub`;

      await sendWhatsApp(client.phone, waMsg, env).catch(() => null);

      // Update next invoice date
      await env.DB.prepare(
        `UPDATE clients SET next_invoice_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).bind(nextDate, client.id).run().catch(() => null);

      // Guard key — don't send twice
      await env.SITES.put(guardKey, invoiceNum, { expirationTtl: 60 * 60 * 24 * 35 });

      await logActivity(env, 'monthly_invoice_sent', {
        clientId: client.id, slug: client.slug, invoiceNum, amountDue, creditAmount
      });

      processed++;
    } catch (err) {
      console.warn(`Monthly invoice failed for ${client.slug}:`, err?.message || err);
    }
  }

  return { processed };
}

function nextMonthDateFrom(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().split('T')[0];
}

function nextYearDateFrom(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().split('T')[0];
}

function buildInvoiceEmail({ clientName, businessName, slug, invoiceNum, retainer, creditAmount, amountDue, promoCode, dueDate, nextDate, payLink, plan }) {
  const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
  const hasCreditect = creditAmount > 0;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Invoice ${invoiceNum}</title>
</head>
<body style="margin:0;padding:0;background:#f7f6f3;font-family:'Helvetica Neue',Arial,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:32px 16px">

  <!-- Header -->
  <div style="margin-bottom:32px">
    <div style="font-size:22px;font-weight:800;color:#009aa5;letter-spacing:-0.5px">Website<span style="color:#1a1814">Hub</span></div>
    <div style="font-size:12px;color:#8a8780;margin-top:2px">websitehub.co.za</div>
  </div>

  <!-- Invoice card -->
  <div style="background:#ffffff;border-radius:16px;padding:28px;margin-bottom:16px;border:1px solid #e5e2dc">
    
    <!-- Invoice meta -->
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;flex-wrap:wrap;gap:8px">
      <div>
        <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8a8780;margin-bottom:4px">INVOICE</div>
        <div style="font-size:13px;font-weight:600;color:#1a1814;font-family:'Courier New',monospace">${invoiceNum}</div>
      </div>
      <div style="text-align:right">
        <div style="font-size:11px;color:#8a8780;margin-bottom:2px">Due date</div>
        <div style="font-size:13px;font-weight:600;color:#1a1814">${dueDate}</div>
      </div>
    </div>

    <!-- Bill to -->
    <div style="margin-bottom:24px;padding-bottom:24px;border-bottom:1px solid #f0ede8">
      <div style="font-size:11px;font-weight:700;letter-spacing:1px;color:#8a8780;margin-bottom:6px">BILL TO</div>
      <div style="font-size:15px;font-weight:600;color:#1a1814">${businessName}</div>
      <div style="font-size:13px;color:#8a8780;margin-top:2px;font-family:'Courier New',monospace">${slug}.co.za</div>
    </div>

    <!-- Line items -->
    <div style="margin-bottom:24px">
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0ede8">
        <div>
          <div style="font-size:14px;font-weight:500;color:#1a1814">${planLabel} Plan — Monthly Retainer</div>
          <div style="font-size:12px;color:#8a8780;margin-top:2px">Next billing: ${nextDate}</div>
        </div>
        <div style="font-size:14px;font-weight:600;color:#1a1814;white-space:nowrap;margin-left:16px">R${retainer}</div>
      </div>
      ${hasCreditect ? `
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0ede8">
        <div>
          <div style="font-size:14px;font-weight:500;color:#00a86b">Referral credit${promoCode ? ` (${promoCode})` : ''}</div>
          <div style="font-size:12px;color:#8a8780;margin-top:2px">1 free month earned</div>
        </div>
        <div style="font-size:14px;font-weight:600;color:#00a86b;white-space:nowrap;margin-left:16px">-R${creditAmount}</div>
      </div>` : ''}
    </div>

    <!-- Total -->
    <div style="display:flex;justify-content:space-between;align-items:center;background:#f7f6f3;border-radius:10px;padding:14px 16px">
      <div style="font-size:13px;font-weight:700;color:#1a1814;letter-spacing:0.3px">TOTAL DUE</div>
      <div style="font-size:24px;font-weight:800;color:#1a1814">R${amountDue}</div>
    </div>
  </div>

  <!-- Pay button -->
  <div style="text-align:center;margin-bottom:16px">
    <a href="${payLink}" 
       style="display:inline-block;background:linear-gradient(135deg,#009aa5,#7b2fbe);color:#ffffff;font-size:16px;font-weight:700;padding:16px 40px;border-radius:14px;text-decoration:none;letter-spacing:-0.3px">
      Pay R${amountDue} →
    </a>
  </div>

  <!-- Footer -->
  <div style="text-align:center;font-size:12px;color:#8a8780;line-height:1.6;padding:0 16px">
    Secure payment via PayFast · Cancel anytime · No contracts<br>
    Questions? WhatsApp us at websitehub.co.za<br><br>
    <span style="font-size:11px;color:#c0bdb7">Invoice ${invoiceNum} · ${slug} · Website Hub SA</span>
  </div>

</div>
</body>
</html>`;
}


async function runLatePaymentDunning(env, today) {
  // Pull all Live clients with a Next Invoice Date <= today
  const records = await queryClients(env, `status='live' AND next_invoice_date IS NOT NULL AND next_invoice_date <= ?`, [today]).catch(() => []);

  let processed = 0, suspended = 0;
  const todayDate = new Date(today + 'T00:00:00Z');

  for (const client of records) {
    const f = { 'Next Invoice Date': client.next_invoice_date, 'Client Name': client.client_name, 'Business Name': client.business_name, 'WhatsApp': client.phone, 'Package': client.package, 'Domain': client.domain, 'Slug': client.slug };
    const record = { id: client.id, fields: f };
    const nextInvoice = client.next_invoice_date;
    if (!nextInvoice) continue;

    const dueDate = new Date(nextInvoice + 'T00:00:00Z');
    const daysLate = Math.floor((todayDate - dueDate) / (1000 * 60 * 60 * 24));

    // Find which stage we're at (the highest day threshold not yet passed by today)
    const stage = DUNNING_STAGES.slice().reverse().find(s => daysLate >= s.day);
    if (!stage) continue; // not yet due

    const guardKey = `dunning_sent:${record.id}:${stage.stage}`;
    const alreadySent = await env.SITES.get(guardKey).catch(() => null);
    if (alreadySent) continue;

    try {
      if (stage.stage === 'suspend') {
        await suspendLateClient(record.id, f, env);
        suspended++;
      } else {
        await sendDunningMessage(record.id, f, stage, daysLate, env);
      }
      await env.SITES.put(guardKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 21 });
      processed++;
    } catch (err) {
      console.warn(`Dunning ${stage.stage} failed for ${record.id}:`, err?.message || err);
    }
  }

  return { processed, suspended };
}

async function sendDunningMessage(airtableId, f, stage, daysLate, env) {
  const name  = f['Client Name']?.split(' ')[0] || 'there';
  const tier  = getPricingTier(f['Package'] || 'Standard');
  const payLink = buildPayFastLink(
    tier.retainer,
    'Website Hub Monthly Subscription',
    airtableId, // clientId
    env,
    { notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined },
  );

  let body;
  if (stage.stage === 'reminder') {
    body = `Hi ${name} 👋\n\nFriendly reminder — your *${f['Business Name']}* monthly subscription of R${tier.retainer} is due today.\n\n💳 Pay here: ${payLink}\n\n— Website Hub`;
  } else if (stage.stage === 'nudge') {
    body = `Hi ${name} — just a nudge, your *${f['Business Name']}* subscription of R${tier.retainer} is ${daysLate} days late.\n\n💳 ${payLink}\n\nReply here if you need anything.\n— Website Hub`;
  } else { // firm
    body = `Hi ${name} — your *${f['Business Name']}* site is ${daysLate} days past due (R${tier.retainer}).\n\nWe'll need to temporarily suspend the site if payment isn't received in the next 7 days.\n\n💳 Pay now: ${payLink}\n\nReply here if there's a problem and we'll sort it.\n— Website Hub`;
  }

  await sendWhatsApp(f['WhatsApp'], body, env);
  await logActivity(env, 'dunning_sent', {
    airtableId, business: f['Business Name'], stage: stage.stage, daysLate,
  });
}

async function suspendLateClient(airtableId, f, env) {
  // Calls launch-worker /suspend-site which marks suspended:{domain} in KV,
  // flips Airtable status to Suspended, and sends the suspension WhatsApp.
  const launchUrl = env.WORKER_URL_LAUNCH;
  if (!launchUrl) {
    // Fallback: do it inline (less clean but avoids stuck-suspension)
    const domain = (f['Domain'] || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    if (domain) await env.SITES.put(`suspended:${domain}`, '1');
    await updateClient(airtableId, { status: 'suspended' }, env);
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ AUTO-SUSPEND (fallback path): ${f['Business Name']} (${domain}) — 14 days late\nAirtable: ${airtableId}\n[WORKER_URL_LAUNCH not configured — used inline path]`,
      env, { skipTestRedirect: true });
    await logActivity(env, 'auto_suspend_fallback', { airtableId, business: f['Business Name'] });
    return;
  }

  const res = await fetch(`${launchUrl}/suspend-site`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key':  env.ADMIN_KEY,
    },
    body: JSON.stringify({ clientId: airtableId }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`suspend-site call failed: ${res.status} — ${errText}`);
  }

  await sendWhatsApp(env.WH_PHONE,
    `⏰ AUTO-SUSPENDED (14d late): ${f['Business Name']}\nAirtable: ${airtableId}`,
    env, { skipTestRedirect: true });
  await logActivity(env, 'auto_suspend', { airtableId, business: f['Business Name'] });
}

// ============================================================
// SEQUENCE: post-go-live touches (D1 / D7 / D30)
// Reads post_golive_d{N}:{airtableId} KV keys set by launch-worker.
// If today matches the stored date, fires the appropriate message and
// deletes the key (single-fire semantics).
// ============================================================

async function runPostGoLiveSequences(env, today) {
  const results = { d1: 0, d7: 0, d30: 0 };

  for (const day of POST_GOLIVE_DAYS) {
    const prefix = day === 30 ? 'upsell:' : `post_golive_d${day}:`;
    const listed = await env.SITES.list({ prefix }).catch(() => ({ keys: [] }));

    for (const key of listed.keys) {
      try {
        const storedDate = await env.SITES.get(key.name);
        if (!storedDate || storedDate !== today) continue;

        const airtableId = key.name.replace(prefix, '');
        const client = await getClientById(airtableId, env).catch(() => null);
        if (!client) { await env.SITES.delete(key.name); continue; }
        if (client.status !== 'live') { await env.SITES.delete(key.name); continue; }
        const f = { 'Client Name': client.client_name, 'Business Name': client.business_name, 'WhatsApp': client.phone, 'Package': client.package, 'Domain': client.domain, 'Slug': client.slug, 'Manage Token': client.manage_token };

        await sendPostGoLiveMessage(airtableId, f, day, env);
        await env.SITES.delete(key.name);
        results[`d${day}`] = (results[`d${day}`] || 0) + 1;
      } catch (err) {
        console.warn(`Post-go-live d${day} failed for ${key.name}:`, err?.message || err);
      }
    }
  }
  return results;
}

async function sendPostGoLiveMessage(airtableId, f, day, env) {
  const name        = f['Client Name']?.split(' ')[0] || 'there';
  const slug        = f['Slug'] || slugify(f['Business Name']);
  const domain      = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const manageToken = f['Manage Token'];
  const manageUrl   = manageToken ? `https://preview.websitehub.co.za/manage/${manageToken}` : null;
  const pkgKey      = packageKey(f['Package'] || 'Standard');
  const caps        = getPackageCaps(f['Package'] || 'Standard');

  let body;
  if (day === 1) {
    body = `Hi ${name} 👋 How's *${f['Business Name']}* going?\n\nJust checking in — any tweaks needed? Tap below to manage your site:\n${manageUrl || `https://${domain}`}\n\n— Website Hub`;

  } else if (day === 7) {
    const refLink = `https://websitehub.co.za/r/${slug}`;
    body = `Hi ${name} 👋 First week with *${f['Business Name']}* online — hope it's going well!\n\n💡 Did you know? Refer 10 friends who go live and we'll upgrade you to Hub Pro — your own *.co.za domain*, free.\n\nYour referral link:\n${refLink}\n\nShare it anywhere — WhatsApp, Facebook, Instagram.\n\n${manageUrl ? `Manage your site: ${manageUrl}\n` : ''}— Website Hub`;

  } else if (day === 30) {
    const isHubPro = pkgKey === 'hub_pro' || pkgKey === 'premium';
    if (isHubPro) {
      body = `Hi ${name} 👋 One month with *${f['Business Name']}* live! Hope it's bringing in customers.\n\nAnything to tweak? Just say the word.\n\n${manageUrl ? `Manage: ${manageUrl}\n` : ''}— Website Hub`;
    } else {
      const refLink = `https://websitehub.co.za/r/${slug}`;
      body = `Hi ${name} 👋 One month with *${f['Business Name']}* live!\n\n🌐 Want your own *.co.za domain*? Two ways to get it:\n• Upgrade to Hub Pro — just R300/mo more\n• Refer 10 friends who go live — get it free\n\nYour referral link:\n${refLink}\n\n${manageUrl ? `Manage: ${manageUrl}\n` : ''}— Website Hub`;
    }
  }

  if (body) {
    await queueScheduledMessage(airtableId, f['WhatsApp'], body, env, { respectDayOfWeek: true });
    await logActivity(env, 'post_golive_sent', { airtableId, business: f['Business Name'], day });
  }
}

// ============================================================
// SEQUENCE: win-back at 90 days
// Reads cancelled:{airtableId} keys (set by reactivate-worker).
// Idempotency: winback_sent:{airtableId} KV.
// ============================================================

async function runWinBackCron(env, today) {
  const listed = await env.SITES.list({ prefix: 'cancelled:' }).catch(() => ({ keys: [] }));
  let sent = 0;

  for (const key of listed.keys) {
    try {
      const cancelledAt = await env.SITES.get(key.name);
      if (!cancelledAt) continue;
      const daysSince = Math.floor((Date.now() - new Date(cancelledAt).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince < WIN_BACK_TRIGGER_DAYS) continue;

      const airtableId = key.name.replace('cancelled:', '');
      const alreadySent = await env.SITES.get(`winback_sent:${airtableId}`);
      if (alreadySent) continue;

      const client = await getClientById(airtableId, env).catch(() => null);
      if (!client) continue;
      const f    = { 'Client Name': client.client_name, 'Business Name': client.business_name, 'WhatsApp': client.phone };
      const name = client.client_name?.split(' ')[0] || 'there';
      const reactivateUrl = env.WORKER_URL_REACTIVATE
        ? `${env.WORKER_URL_REACTIVATE}/reactivate-site?clientId=${airtableId}`
        : null;

      const body = `Hi ${name} — Pierre here from Website Hub. 👋\n\nJust checking in — hope business is going well.\n\nIf you ever want to get your website back up, it's easy:\n${reactivateUrl || 'reply to this message'}\n\nNo rebuild fee if you come back within a year. Just your normal subscription.\n\nTake care.\n— Pierre, Website Hub`;

      await queueScheduledMessage(airtableId, f['WhatsApp'], body, env, { respectDayOfWeek: true });
      await env.SITES.put(`winback_sent:${airtableId}`, new Date().toISOString());
      await logActivity(env, 'winback_sent', { airtableId, business: f['Business Name'] });
      sent++;
    } catch (err) {
      console.warn(`Win-back failed for ${key.name}:`, err?.message || err);
    }
  }

  return { sent };
}

// ============================================================

// ── OUTBOUND SCRAPE — daily prospect sourcing from Google Places ──────────────
async function runOutboundScrape(env) {
  // Read config from D1
  const cfg = await getConfig(env);
  if (!cfg.outbound_enabled || cfg.outbound_enabled === 'false') return { skipped: 'outbound disabled' };

  // Check send window (SAST = UTC+2)
  const nowHour = new Date().getUTCHours() + 2;
  const [startH] = (cfg.send_window_start || '09:00').split(':').map(Number);
  const [endH]   = (cfg.send_window_end   || '17:00').split(':').map(Number);
  if (nowHour < startH || nowHour >= endH) return { skipped: 'outside send window' };

  // Guard — only run once per day
  const today = new Date().toISOString().split('T')[0];
  const guardKey = `scrape_guard:${today}`;
  const alreadyRan = await env.SITES.get(guardKey);
  if (alreadyRan) return { skipped: 'already ran today' };
  await env.SITES.put(guardKey, '1', { expirationTtl: 60 * 60 * 26 });

  const dryRun    = cfg.dry_run === 'true' || cfg.dry_run === true;
  const limit     = parseInt(cfg.daily_scrape_limit) || 20;
  const provinces = JSON.parse(cfg.target_provinces || '["KZN"]');
  const industries = JSON.parse(cfg.target_industries || '["plumber"]');

  let totalInserted = 0;

  // Pick one random province + industry combo per run to spread coverage
  const province = provinces[Math.floor(Math.random() * provinces.length)];
  const industry = industries[Math.floor(Math.random() * industries.length)];

  try {
    // Call build-worker scrape endpoint
    const res = await fetch(`https://preview.websitehub.co.za/admin/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
      body: JSON.stringify({ industry, province, limit }),
    });
    const data = await res.json().catch(() => ({}));
    totalInserted = data.inserted || 0;

    await logEvent(env, null, 'pulse', 'outbound_scrape_complete', 'success', {
      metadata: { province, industry, inserted: totalInserted, dryRun }
    });
  } catch(e) {
    await logEvent(env, null, 'pulse', 'outbound_scrape_error', 'error', {
      metadata: { error: e.message }
    });
  }

  // If dry run — stop here, don't build anything
  if (dryRun) {
    return { dryRun: true, inserted: totalInserted, province, industry };
  }

  // Auto mode — approve and build pending prospects up to send limit
  const sendLimit = parseInt(cfg.daily_send_limit) || 10;
  const mode = cfg.outbound_mode || 'manual';
  if (mode !== 'auto') return { manual: true, inserted: totalInserted };

  // Auto approve and trigger builds
  const pending = await env.DB.prepare(
    `SELECT * FROM prospects WHERE status='pending' ORDER BY created_at DESC LIMIT ?`
  ).bind(sendLimit).all().catch(() => ({ results: [] }));

  let built = 0;
  for (const prospect of (pending.results || [])) {
    try {
      await fetch(`https://preview.websitehub.co.za/admin/approve-prospect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
        body: JSON.stringify({ id: prospect.id }),
      });
      built++;
    } catch(e) { console.warn('Auto approve failed:', e.message); }
  }

  return { inserted: totalInserted, built, province, industry };
}

// ── GET CONFIG — reads all D1 config keys into an object ─────────────────────
async function getConfig(env) {
  try {
    const rows = await env.DB.prepare(`SELECT key, value FROM config`).all();
    const cfg = {};
    for (const r of (rows.results || [])) {
      try { cfg[r.key] = JSON.parse(r.value); } catch { cfg[r.key] = r.value; }
    }
    return cfg;
  } catch { return {}; }
}

// SEQUENCE: prospect limbo follow-up
// Outbound prospects sent their template > PROSPECT_FOLLOWUP_DAY ago
// with no reply → one final nudge. After that, prospect_cooldown:{phone}
// is set for PROSPECT_COOLDOWN_DAYS so we don't bother them again.
// ============================================================

async function runProspectLimboFollowUp(env, today) {
  const listed = await env.SITES.list({ prefix: 'prospect_state:' }).catch(() => ({ keys: [] }));
  let sent = 0;

  for (const key of listed.keys) {
    try {
      const raw = await env.SITES.get(key.name);
      if (!raw) continue;
      const state = JSON.parse(raw);
      if (state.phase !== 'sent') continue; // already followed up or in flow

      const sentAt = new Date(state.sentAt).getTime();
      const daysSince = Math.floor((Date.now() - sentAt) / (1000 * 60 * 60 * 24));
      if (daysSince < PROSPECT_FOLLOWUP_DAY) continue;

      const phone = key.name.replace('prospect_state:', '');
      const optedOut = await env.SITES.get(`optout:${phone}`).catch(() => null);
      if (optedOut) {
        await env.SITES.delete(key.name);
        continue;
      }

      // Single follow-up message
      const previewUrl = `https://preview.websitehub.co.za/${state.slug}`;
      const body = `Hi — Pierre here from Website Hub. 👋\n\nJust a heads-up that your free website preview is still here:\n${previewUrl}\n\nNo obligation. If it's not for you, reply STOP and I won't message again.\n— Pierre, Website Hub`;

      await queueScheduledMessage(state.airtableId, phone, body, env, { respectDayOfWeek: true });
      await env.SITES.put(key.name, JSON.stringify({
        ...state,
        phase: 'follow_up_sent',
        followUpAt: new Date().toISOString(),
      }), { expirationTtl: 60 * 60 * 24 * 30 });

      await logActivity(env, 'prospect_followup_sent', { airtableId: state.airtableId, phone });
      sent++;
    } catch (err) {
      console.warn(`Prospect follow-up failed for ${key.name}:`, err?.message || err);
    }
  }

  return { sent };
}

// ============================================================
// SEQUENCE: referral credit vesting
// Logic: for each Live client with a Referral Slug, check if their
// Go Live Date was exactly REFERRAL_VEST_DAYS ago. If yes and credit
// not yet granted (no referral_credited:{referredId} guard), grant
// the referrer one free month.
//
// Grant = increment referral:conversions:{referrerSlug} + create
// Zoho credit note on referrer's account for one month's retainer.
// ============================================================

async function runPromoNudge(env) {
  // Find promo clients still in preview_ready after 24hrs — send one nudge
  const rows = await env.DB.prepare(`
    SELECT id, slug, business_name, phone, manage_token, promo_code
    FROM clients
    WHERE promo_code IS NOT NULL
      AND status = 'preview_ready'
      AND created_at <= datetime('now', '-20 hours')
      AND created_at >= datetime('now', '-48 hours')
  `).all().catch(() => ({ results: [] }));

  let nudged = 0;
  for (const client of (rows.results || [])) {
    const guardKey = `promo_nudge_sent:${client.id}`;
    if (await env.SITES.get(guardKey)) continue;

    const promoParam = `?promo=${encodeURIComponent(client.promo_code)}`;
    const ogLink = `https://preview.websitehub.co.za/${client.slug}/og${promoParam}`;

    await sendWhatsApp(client.phone,
      `👋 Hi *${client.business_name}*!\n\n` +
      `Just checking — did you get a chance to look at your site?\n\n` +
      `Your complimentary build (worth R7,000) is still waiting. This offer won't last.\n` +
      `👉 ${ogLink}\n\n` +
      `— Website Hub`,
      env
    ).catch(() => {});

    await env.SITES.put(guardKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 7 });
    nudged++;
  }

  return { nudged };
}

async function runReferralVesting(env, today) {
  // New referral system: count live referrals per client
  // When a client reaches 10 live referrals → upgrade to Hub Pro → register domain
  const REFERRAL_GOAL = 10;

  // Find Hub clients who have 10+ live referrals and aren't already Hub Pro
  const rows = await env.DB.prepare(`
    SELECT c.id, c.slug, c.business_name, c.phone, c.package, c.manage_token,
           COUNT(r.id) as ref_count
    FROM clients c
    JOIN clients r ON r.referred_by = c.slug AND r.status = 'live'
    WHERE c.status = 'live'
      AND (c.package = 'hub' OR c.package = 'standard' OR c.package = 'express')
    GROUP BY c.id
    HAVING ref_count >= ?
  `).bind(REFERRAL_GOAL).all().catch(() => ({ results: [] }));

  let upgraded = 0;
  for (const client of (rows.results || [])) {
    const guardKey = `referral_upgraded:${client.id}`;
    if (await env.SITES.get(guardKey)) continue; // already processed

    try {
      // Upgrade to Hub Pro
      await env.DB.prepare(
        `UPDATE clients SET package='hub_pro', retainer=999 WHERE id=?`
      ).bind(client.id).run();

      // Mark guard
      await env.SITES.put(guardKey, new Date().toISOString());

      // WhatsApp client
      await sendWhatsApp(client.phone,
        `🎉 *${client.business_name}* — you've earned your domain!\n\n` +
        `You referred 10 friends who went live. Your Hub Pro upgrade is active — we're registering your .co.za domain now.\n\n` +
        `— Website Hub`,
        env
      ).catch(() => {});

      // WhatsApp owner
      await sendWhatsApp(env.WH_PHONE,
        `🎁 REFERRAL UPGRADE: ${client.business_name} (${client.slug}) → Hub Pro\n10 referrals achieved`,
        env, { skipTestRedirect: true }
      ).catch(() => {});

      // Trigger domain registration via launch worker
      if (env.LAUNCH_WORKER) {
        await env.LAUNCH_WORKER.fetch(new Request('https://internal/register-domain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: client.id, slug: client.slug }),
        })).catch(() => {});
      }

      await logActivity(env, 'referral_upgrade', { clientId: client.id, slug: client.slug, refCount: client.ref_count });
      upgraded++;
    } catch(err) {
      console.warn(`Referral upgrade failed for ${client.id}:`, err?.message);
    }
  }

  return { upgraded };
}

// ============================================================
// SEQUENCE: leaderboard cache pre-computation
// Reads all referral:sent:{slug}:{month} keys for current month,
// sorts, takes top 10, writes leaderboard:cache:{month}.
// build-worker's /leaderboard route reads this cache first.
// ============================================================

async function validateShowcaseQueue(env) {
  const raw = await env.SITES.get('showcase:queue').catch(() => null);
  const queue = JSON.parse(raw || '[]');
  if (!queue.length) return 'empty queue';

  const verified = await Promise.all(
    queue.map(async slug => {
      const site = await env.DB.prepare(
        `SELECT slug FROM clients WHERE slug=? AND status='live' LIMIT 1`
      ).bind(slug).first().catch(() => null);
      return site ? slug : null;
    })
  );

  const clean = verified.filter(Boolean).slice(0, 5);
  await env.SITES.put('showcase:queue', JSON.stringify(clean));
  return { before: queue.length, after: clean.length };
}

async function precomputeLeaderboard(env, monthStr) {
  const allKeys = await env.SITES.list({ prefix: 'referral:sent:' }).catch(() => ({ keys: [] }));
  const monthKeys = allKeys.keys.filter(k => k.name.endsWith(`:${monthStr}`));

  const slugCounts = {};
  for (const key of monthKeys) {
    // Key shape: referral:sent:{slug}:{YYYY-MM}
    const parts = key.name.split(':');
    const slug  = parts[2];
    const v     = parseInt(await env.SITES.get(key.name).catch(() => '0') || '0');
    slugCounts[slug] = (slugCounts[slug] || 0) + v;
  }

  // Sort, take top 10, map to leaderboard rows
  const board = Object.entries(slugCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([slug, count], i) => ({
      position:  i + 1,
      slug:      slug.slice(0, 3) + '***', // privacy: show only first 3 chars
      referrals: count,
    }));

  await env.SITES.put(`leaderboard:cache:${monthStr}`, JSON.stringify(board), {
    expirationTtl: 60 * 60 * 24 * 35,
  });

  return { entries: board.length };
}

// ============================================================
// SEQUENCE: monthly visit totals → Airtable
// Runs only on the 1st. Sums previous month's daily visit counts
// per slug and writes the total to Airtable "Monthly Visits".
// ============================================================

async function runMonthlyVisitTotals(env) {
  const now = new Date();
  // Previous month: subtract 1 month
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = prev.toISOString().slice(0, 7); // YYYY-MM

  // Pull all Live records
  const records = await queryClients(env, `status='live'`).catch(() => []);

  let updated = 0;
  for (const client of records) {
    const slug = client.slug;

    const keys = await env.SITES.list({ prefix: `visits:${slug}:` }).catch(() => ({ keys: [] }));
    let total = 0;
    for (const k of keys.keys) {
      const rest = k.name.slice(`visits:${slug}:`.length);
      if (rest.length === 10 && rest.startsWith(prevMonth)) {
        const v = await env.SITES.get(k.name).catch(() => '0');
        total += parseInt(v || '0');
      }
    }

    if (total === 0) continue;

    try {
      await updateClient(client.id, { monthly_visits: total }, env);
      updated++;
    } catch (e) {
      console.warn(`Monthly visit total update failed for ${client.id}:`, e?.message || e);
    }
  }

  return { updated, month: prevMonth };
}

// ============================================================
// SEQUENCE: monthly summary
// Runs only on the 1st. For each Live client: generate hosted HTML
// summary, store at monthly_summary:{slug}:{YYYY-MM} (60-day TTL),
// send WhatsApp with link to view.
// Idempotency: monthly_summary_sent:{airtableId}:{YYYY-MM} guard.
// ============================================================

async function runMonthlySummary(env) {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = prev.toISOString().slice(0, 7);

  const records = await queryClients(env, `status='live'`).catch(() => []);
  let sent = 0;

  for (const client of records) {
    const f    = { 'Business Name': client.business_name, 'Package': client.package, 'Domain': client.domain, 'Slug': client.slug, 'Client Name': client.client_name, 'WhatsApp': client.phone };
    const record = { id: client.id };
    const slug = client.slug;
    const guardKey = `monthly_summary_sent:${client.id}:${prevMonth}`;
    if (await env.SITES.get(guardKey)) continue;

    try {
      // Gather data
      const visitsData = await sumMonthlyVisits(slug, prevMonth, env);
      const fabTaps    = parseInt(await env.SITES.get(`fab_taps:${slug}:${prevMonth}`).catch(() => '0') || '0');
      const revisionsUsed = parseInt(await env.SITES.get(`manage_revisions:${record.id}:${prevMonth}`).catch(() => '0') || '0');
      const referralSent  = parseInt(await env.SITES.get(`referral:sent:${slug}:${prevMonth}`).catch(() => '0') || '0');

      // Generate HTML summary page
      const html = generateMonthlySummaryHtml({
        businessName: f['Business Name'],
        package:      f['Package'] || 'Standard',
        domain:       (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, ''),
        month:        prevMonth,
        visits:       visitsData,
        fabTaps,
        revisionsUsed,
        referralSent,
      });

      await env.SITES.put(`monthly_summary:${slug}:${prevMonth}`, html, {
        expirationTtl: MONTHLY_SUMMARY_TTL,
      });

      // Send WhatsApp with link
      const summaryUrl = env.WORKER_URL_PULSE
        ? `${env.WORKER_URL_PULSE}/summary/${slug}/${prevMonth}`
        : null;

      if (summaryUrl) {
        const name = f['Client Name']?.split(' ')[0] || 'there';
        const monthLabel = prev.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
        await queueScheduledMessage(record.id, f['WhatsApp'],
          `📊 Hi ${name}! Here's your *${monthLabel}* summary for *${f['Business Name']}*:\n\n👀 ${visitsData.total} site views\n💬 ${fabTaps} WhatsApp taps\n\nFull report: ${summaryUrl}\n\n— Website Hub`,
          env, { respectDayOfWeek: true });
      }

      await env.SITES.put(guardKey, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 90 });
      await logActivity(env, 'monthly_summary_sent', {
        airtableId: record.id,
        slug,
        month:      prevMonth,
        visits:     visitsData.total,
      });
      sent++;
    } catch (err) {
      console.warn(`Monthly summary failed for ${record.id}:`, err?.message || err);
    }
  }

  return { sent, month: prevMonth };
}

async function sumMonthlyVisits(slug, monthStr, env) {
  const keys = await env.SITES.list({ prefix: `visits:${slug}:` }).catch(() => ({ keys: [] }));
  let total = 0;
  const perPage = {};

  for (const k of keys.keys) {
    const rest = k.name.slice(`visits:${slug}:`.length);
    const parts = rest.split(':');
    if (parts.length === 1 && parts[0].length === 10 && parts[0].startsWith(monthStr)) {
      // Total day key
      total += parseInt(await env.SITES.get(k.name).catch(() => '0') || '0');
    } else if (parts.length === 2 && parts[1].startsWith(monthStr)) {
      // Per-page key
      const page = parts[0];
      const v = parseInt(await env.SITES.get(k.name).catch(() => '0') || '0');
      perPage[page] = (perPage[page] || 0) + v;
    }
  }

  const topPage = Object.entries(perPage)
    .sort(([, a], [, b]) => b - a)[0]?.[0] || 'index';

  return { total, perPage, topPage };
}

function generateMonthlySummaryHtml(d) {
  const monthLabel = new Date(d.month + '-01').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
  const perPageList = Object.entries(d.visits.perPage || {})
    .sort(([, a], [, b]) => b - a)
    .map(([page, v]) => `<tr><td style="padding:8px 0;border-bottom:1px solid #2a2a2a">${escapeHtml(page === 'index' ? 'Home' : page)}</td><td style="padding:8px 0;border-bottom:1px solid #2a2a2a;text-align:right;font-family:monospace;color:#ff5500">${v}</td></tr>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(d.businessName)} — ${monthLabel}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#0d0d0d;color:#f0ede8;line-height:1.6;padding:24px 16px}
.wrap{max-width:520px;margin:auto}
.hero{background:linear-gradient(135deg,rgba(255,85,0,0.1),rgba(255,85,0,0.02));border:1px solid rgba(255,85,0,0.25);border-radius:14px;padding:24px;margin-bottom:20px;text-align:center}
.month{font-size:12px;color:#ff5500;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;font-family:monospace}
.biz{font-size:26px;font-weight:800;line-height:1.2;margin-bottom:6px}
.dom{font-size:12px;color:#666;font-family:monospace}
.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:20px}
.stat{background:#161616;border:1px solid #2a2a2a;border-radius:10px;padding:18px;text-align:center}
.stat-val{font-size:32px;font-weight:800;color:#ff5500;line-height:1}
.stat-lbl{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;margin-top:6px}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;padding:20px;margin-bottom:14px}
.card-title{font-size:13px;color:#f0ede8;font-weight:600;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.card-title .ico{font-size:18px}
table{width:100%;font-size:14px}
.footer{text-align:center;font-size:11px;color:#444;margin-top:32px;padding-top:20px;border-top:1px solid #2a2a2a}
.footer a{color:#666}
.muted{color:#666;font-size:13px}
</style>
</head><body>
<div class="wrap">
  <div class="hero">
    <div class="month">${escapeHtml(monthLabel)}</div>
    <div class="biz">${escapeHtml(d.businessName)}</div>
    <div class="dom">${escapeHtml(d.domain)}</div>
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-val">${d.visits.total}</div><div class="stat-lbl">Site views</div></div>
    <div class="stat"><div class="stat-val">${d.fabTaps}</div><div class="stat-lbl">WhatsApp taps</div></div>
  </div>

  ${perPageList ? `<div class="card"><div class="card-title"><span class="ico">📊</span>Pages by views</div><table>${perPageList}</table></div>` : ''}

  <div class="card">
    <div class="card-title"><span class="ico">✏️</span>Revisions this month</div>
    <div style="font-size:24px;font-weight:700;color:#ff5500">${d.revisionsUsed}</div>
    <div class="muted" style="margin-top:4px">Updates requested via your manage panel.</div>
  </div>

  ${d.referralSent > 0 ? `<div class="card">
    <div class="card-title"><span class="ico">👥</span>Referral activity</div>
    <div style="font-size:14px">You sent <strong style="color:#00c97a">${d.referralSent}</strong> referral link${d.referralSent !== 1 ? 's' : ''} this month.</div>
    <div class="muted" style="margin-top:6px">Each conversion = 1 free month on your subscription.</div>
  </div>` : ''}

  <div class="footer">
    Hosted & managed by <a href="https://websitehub.co.za">Website Hub</a> · Plan: ${escapeHtml(d.package)}
  </div>
</div>
</body></html>`;
}

// ============================================================
// End of pulse-worker.js
// ============================================================
