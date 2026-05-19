// ============================================================
// WEBSITE HUB — pulse-worker.js
// The daily cron orchestrator. Owns everything time-driven.
//
// SEQUENCES RUN DAILY:
//   — Late payment dunning (D0 reminder → D3 nudge → D7 firm → D14 suspend)
//   — Post-go-live touches (D1 check-in, D7 referral nudge, D30 upsell)
//   — Win-back at 90 days post-cancellation
//   — Prospect limbo follow-up (outbound no-reply)
//   — Referral credit vesting (30 days after referred client goes live)
//   — Message queue draining (during send window only)
//
// 1ST OF MONTH ONLY:
//   — Monthly visit totals → clients.monthly_visits in D1
//   — Monthly summary HTML → KV + WhatsApp
//
// ROUTES:
//   POST /run-cron               — manual trigger (admin)
//   GET  /summary/{slug}/{month} — serves monthly summary HTML from KV
//   POST /track-fab              — records WhatsApp FAB taps
//   POST /track-page-view        — soft navigation page view ping
//   GET  /health
//
// KEY ARCHITECTURE NOTES (v2):
//   — All client queries use D1 (no Airtable listRecords)
//   — Idempotency via hasMessageBeenSent (D1 messages table) instead of KV guards
//   — Post-go-live timing derived from clients.go_live_date (no KV scheduling keys)
//   — Win-back derived from clients.cancellation_date + status='cancelled'
//   — Prospect follow-up from D1 prospects table
//   — Referral vesting from D1 referrals table (vestReferral)
//   — Leaderboard: build-worker runs live D1 query, no KV cache needed here
// ============================================================

import {
  PRICING, PACKAGE_CAPS,
  REFERRAL_VEST_DAYS, WIN_BACK_TRIGGER_DAYS, SAST_OFFSET_MS,
  isTestMode, packageKey, getPricingTier, getPackageCaps, buildPayFastLink,
  jsonResponse, corsResponse, htmlResponse,
  slugify, escapeHtml, currentMonthKey, todayDateString,
  sendWhatsApp, queueScheduledMessage, processMessageQueue,
  createZohoCreditNote,
  logEvent, getFlag,
  getClientById, getClientBySlug, updateClient, queryClients,
  logMessage, hasMessageBeenSent,
  getMonthlyVisits, vestReferral,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const DUNNING_STAGES = [
  { day: 0,  stage: 'd0_dunning', label: 'reminder', tone: 'polite'   },
  { day: 3,  stage: 'd3_dunning', label: 'nudge',    tone: 'friendly' },
  { day: 7,  stage: 'd7_dunning', label: 'firm',     tone: 'firm'     },
  { day: 14, stage: 'd14_dunning', label: 'suspend', tone: 'final'    },
];

const PROSPECT_FOLLOWUP_DAY = 4;
const POST_GOLIVE_DAYS      = [1, 7, 30];
const MONTHLY_SUMMARY_TTL   = 60 * 60 * 24 * 60;

// Touchpoint constants (must match messages.touchpoint column values)
const TP = {
  POST_LIVE_D1:     'post_live_d1',
  POST_LIVE_D7:     'post_live_d7',
  POST_LIVE_D30:    'post_live_d30',
  WIN_BACK:         'win_back_d90',
  REFERRAL_VESTING: 'referral_vesting',
  MONTHLY_SUMMARY:  'monthly_summary',
};

// ────────────────────────────────────────────────────────────
// EXPORT
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/run-cron')         return handleRunCron(request, env, ctx);
    if (path.startsWith('/summary/')) return handleSummaryPage(request, env, path);
    if (path === '/track-fab')        return handleTrackFab(request, env);
    if (path === '/track-page-view')  return handleTrackPageView(request, env);
    if (path === '/health')           return handleHealth(env);

    return jsonResponse({ error: 'Not found', path }, 404);
  },

  async scheduled(event, env, ctx) {
    const cronExpr = event.cron;
    const sast     = new Date(Date.now() + SAST_OFFSET_MS);
    const hour     = sast.getUTCHours();

    // Queue-drain cron (every 15 min during send window)
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
  let d1Status = 'unknown';
  try { await env.DB.prepare('SELECT 1').first(); d1Status = 'ok'; }
  catch { d1Status = 'error'; }

  return jsonResponse({
    ok:       true,
    worker:   'pulse-worker',
    time:     new Date().toISOString(),
    testMode: isTestMode(env),
    d1:       d1Status,
  });
}

// ============================================================
// ROUTE: /run-cron — manual trigger
// ============================================================

async function handleRunCron(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  ctx.waitUntil(runDailyCron(env));
  return jsonResponse({ success: true, message: 'Daily cron started in background' });
}

// ============================================================
// ROUTE: /summary/{slug}/{YYYY-MM}
// ============================================================

async function handleSummaryPage(request, env, path) {
  if (request.method !== 'GET') return jsonResponse({ error: 'GET only' }, 405);

  const parts = path.replace(/^\/summary\//, '').split('/');
  if (parts.length < 2) return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px">Invalid summary URL.</body></html>`, 400);

  const slug  = parts[0];
  const month = parts[1];
  if (!/^\d{4}-\d{2}$/.test(month)) return htmlResponse(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px">Invalid month format.</body></html>`, 400);

  const html = await env.SITES.get(`monthly_summary:${slug}:${month}`);
  if (!html) {
    return htmlResponse(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Summary not ready</title></head><body style="font-family:Arial;text-align:center;padding:60px;background:#0d0d0d;color:#f0ede8"><div style="max-width:400px;margin:auto"><div style="font-size:48px;margin-bottom:16px">⏳</div><h2>Summary not ready yet</h2><p style="color:#666;line-height:1.6;margin-top:12px">Monthly summaries are generated on the 1st of each month.</p></div></body></html>`, 404);
  }

  return htmlResponse(html, 200);
}

// ============================================================
// ROUTE: /track-fab — WhatsApp FAB tap counter
// Increments KV for monthly summary + D1 monthly_wa_taps for analytics.
// ============================================================

async function handleTrackFab(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { slug } = body;
  if (!slug) return corsResponse(null, 204);

  const monthStr = currentMonthKey();
  const key      = `fab_taps:${slug}:${monthStr}`;

  // KV increment for monthly summary
  try {
    const current = parseInt(await env.SITES.get(key).catch(() => '0') || '0');
    await env.SITES.put(key, String(current + 1), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch { /* non-fatal */ }

  // D1 increment for analytics endpoint
  env.DB.prepare(
    `UPDATE clients SET monthly_wa_taps = monthly_wa_taps + 1 WHERE slug = ?`
  ).bind(slug).run().catch(() => {});

  return corsResponse(null, 204);
}

// ============================================================
// ROUTE: /track-page-view — soft navigation page view ping
// ============================================================

async function handleTrackPageView(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { slug, page } = body;
  if (!slug || !page) return corsResponse(null, 204);

  // Non-blocking D1 visit record via slug lookup
  env.DB.prepare(
    `SELECT id FROM clients WHERE slug = ? LIMIT 1`
  ).bind(slug).first().then(async row => {
    if (row?.id) {
      const today = todayDateString();
      await env.DB.prepare(
        `INSERT INTO visits (client_id, date, page, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(client_id, date, page) DO UPDATE SET count = count + 1`
      ).bind(row.id, today, page).run().catch(() => {});
    }
  }).catch(() => {});

  return corsResponse(null, 204);
}

// ============================================================
// DAILY CRON ORCHESTRATOR
// ============================================================

async function runDailyCron(env) {
  const startTs    = Date.now();
  const today      = todayDateString();
  const sast       = new Date(Date.now() + SAST_OFFSET_MS);
  const dayOfMonth = sast.getUTCDate();

  await logEvent(env, 'pulse', 'cron_run', 'success', { metadata: { date: today, phase: 'started' } });

  const sequences = [
    { name: 'message_queue',        fn: () => processMessageQueue(env) },
    { name: 'late_payment_dunning', fn: () => runLatePaymentDunning(env, today) },
    { name: 'post_golive',          fn: () => runPostGoLiveSequences(env) },
    { name: 'win_back',             fn: () => runWinBackCron(env) },
    { name: 'prospect_followup',    fn: () => runProspectLimboFollowUp(env) },
    { name: 'referral_vesting',     fn: () => runReferralVesting(env) },
  ];

  if (dayOfMonth === 1) {
    sequences.push({ name: 'monthly_visit_totals', fn: () => runMonthlyVisitTotals(env) });
    sequences.push({ name: 'monthly_summary',      fn: () => runMonthlySummary(env) });
  }

  const results = {};
  for (const { name, fn } of sequences) {
    try {
      results[name] = (await fn()) || 'ok';
    } catch (err) {
      console.warn(`Cron sequence "${name}" failed:`, err);
      results[name] = `error: ${err.message}`;
      await logEvent(env, 'pulse', 'cron_sequence_error', 'failure', {
        metadata: { sequence: name, error: err.message },
      });
    }
  }

  const elapsedMs = Date.now() - startTs;
  await logEvent(env, 'pulse', 'cron_complete', 'success', {
    metadata: { date: today, elapsedMs, results },
  });
}

// ============================================================
// SEQUENCE: late payment dunning
// D0 reminder → D3 nudge → D7 firm → D14 suspend
// Idempotency: hasMessageBeenSent(env, clientId, touchpoint)
// ============================================================

async function runLatePaymentDunning(env, today) {
  // D1: all Live clients with next_invoice_date <= today
  const result = await queryClients(
    env,
    `SELECT * FROM clients WHERE status = 'live' AND next_invoice_date <= ? AND opted_out = 0`,
    today,
  );

  const clients = result?.results || [];
  let processed = 0, suspended = 0;
  const todayDate = new Date(today + 'T00:00:00Z');

  for (const client of clients) {
    if (!client.next_invoice_date) continue;

    const dueDate  = new Date(client.next_invoice_date.split('T')[0] + 'T00:00:00Z');
    const daysLate = Math.floor((todayDate - dueDate) / (1000 * 60 * 60 * 24));

    const stage = DUNNING_STAGES.slice().reverse().find(s => daysLate >= s.day);
    if (!stage) continue;

    // D1 idempotency — check messages table
    const alreadySent = await hasMessageBeenSent(env, client.id, stage.stage);
    if (alreadySent) continue;

    try {
      if (stage.label === 'suspend') {
        await suspendLateClient(client, env);
        suspended++;
      } else {
        await sendDunningMessage(client, stage, daysLate, env);
      }
      // Log to D1 messages so hasMessageBeenSent returns true on next run
      await logMessage(env, client.id, stage.stage, client.channel || 'whatsapp');
      processed++;
    } catch (err) {
      console.warn(`Dunning ${stage.stage} failed for ${client.id}:`, err?.message || err);
    }
  }

  return { processed, suspended };
}

async function sendDunningMessage(client, stage, daysLate, env) {
  const name  = (client.client_name || '').split(' ')[0] || 'there';
  const tier  = PRICING[packageKey(client.package || 'standard')];
  const payLink = buildPayFastLink(
    tier.retainer, 'Website Hub Monthly Subscription', client.id, env,
    { notifyUrl: env.WORKER_URL_LAUNCH ? `${env.WORKER_URL_LAUNCH}/payfast-webhook` : undefined },
  );

  let body;
  if (stage.label === 'reminder') {
    body = `Hi ${name} 👋\n\nFriendly reminder — your *${client.business_name}* monthly subscription of R${tier.retainer} is due today.\n\n💳 Pay here: ${payLink}\n\n— Website Hub`;
  } else if (stage.label === 'nudge') {
    body = `Hi ${name} — just a nudge, your *${client.business_name}* subscription of R${tier.retainer} is ${daysLate} days late.\n\n💳 ${payLink}\n\nReply here if you need anything.\n— Website Hub`;
  } else {
    body = `Hi ${name} — your *${client.business_name}* site is ${daysLate} days past due (R${tier.retainer}).\n\nWe'll need to temporarily suspend the site if payment isn't received in the next 7 days.\n\n💳 Pay now: ${payLink}\n\nReply here if there's a problem and we'll sort it.\n— Website Hub`;
  }

  await queueScheduledMessage(client.id, client.phone, body, env, { respectDayOfWeek: true });
  await logEvent(env, 'pulse', stage.stage, 'success', {
    clientId: client.id, metadata: { business: client.business_name, daysLate },
  });
}

async function suspendLateClient(client, env) {
  const launchUrl = env.WORKER_URL_LAUNCH;

  if (!launchUrl) {
    // Fallback inline: set D1 status directly
    await updateClient(env, client.id, { status: 'suspended' }).catch(() => {});
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ AUTO-SUSPEND (fallback): ${client.business_name} — 14 days late\nClient: ${client.id}\n[WORKER_URL_LAUNCH not configured]`,
      env, { skipTestRedirect: true });
    await logEvent(env, 'pulse', 'd14_dunning', 'warning', {
      clientId: client.id, metadata: { path: 'fallback_inline' },
    });
    return;
  }

  const res = await fetch(`${launchUrl}/suspend-site`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
    body:    JSON.stringify({ clientId: client.id }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`suspend-site call failed: ${res.status} — ${errText}`);
  }

  await sendWhatsApp(env.WH_PHONE,
    `⏰ AUTO-SUSPENDED (14d late): ${client.business_name}\nClient: ${client.id}`,
    env, { skipTestRedirect: true });
  await logEvent(env, 'pulse', 'd14_dunning', 'success', {
    clientId: client.id, metadata: { business: client.business_name },
  });
}

// ============================================================
// SEQUENCE: post-go-live touches (D1 / D7 / D30)
// D1 query on clients.go_live_date instead of KV scheduling keys.
// Idempotency: hasMessageBeenSent with TP.POST_LIVE_D{N} touchpoints.
// ============================================================

async function runPostGoLiveSequences(env) {
  const results = { d1: 0, d7: 0, d30: 0 };

  for (const day of POST_GOLIVE_DAYS) {
    const touchpoint = day === 1 ? TP.POST_LIVE_D1 : day === 7 ? TP.POST_LIVE_D7 : TP.POST_LIVE_D30;

    const result = await env.DB.prepare(
      `SELECT * FROM clients
       WHERE status = 'live'
       AND date(go_live_date) = date('now', ?)
       AND opted_out = 0`,
    ).bind(`-${day} days`).all().catch(() => ({ results: [] }));

    const clients = result?.results || [];

    for (const client of clients) {
      try {
        const alreadySent = await hasMessageBeenSent(env, client.id, touchpoint);
        if (alreadySent) continue;

        await sendPostGoLiveMessage(client, day, env);
        await logMessage(env, client.id, touchpoint, client.channel || 'whatsapp');
        results[`d${day}`]++;
      } catch (err) {
        console.warn(`Post-go-live d${day} failed for ${client.id}:`, err?.message || err);
      }
    }
  }

  return results;
}

async function sendPostGoLiveMessage(client, day, env) {
  const name       = (client.client_name || '').split(' ')[0] || 'there';
  const slug       = client.slug || slugify(client.business_name);
  const domain     = (client.domain || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const manageUrl  = client.manage_token
    ? `https://preview.websitehub.co.za/manage/${client.manage_token}`
    : null;
  const pkg        = packageKey(client.package || 'standard');
  const caps       = PACKAGE_CAPS[pkg];

  let body;
  if (day === 1) {
    body = `Hi ${name} 👋 How's *${client.business_name}* going?\n\nJust checking in — any tweaks needed? Tap below to manage:\n${manageUrl || `https://${domain}`}\n\nOr reply here.\n— Website Hub`;

  } else if (day === 7) {
    if (caps.referral && await getFlag(env, 'REFERRAL_ENABLED')) {
      const refLink = `https://websitehub.co.za?ref=${slug}`;
      body = `Hi ${name} 👋 First week with *${client.business_name}* online — hope it's going well!\n\n👥 Heads up — for every business you refer, you get a free month. Your link:\n${refLink}\n\nShare it on WhatsApp, Facebook, anywhere.\n\n${manageUrl ? `Manage: ${manageUrl}\n` : ''}— Website Hub`;
    } else {
      body = `Hi ${name} — first week down with *${client.business_name}*! Anything to tweak?\n\n${manageUrl ? `Manage: ${manageUrl}\n` : ''}— Website Hub`;
    }

  } else if (day === 30) {
    if (pkg === 'express') {
      body = `Hi ${name} 👋 One month with *${client.business_name}* live! How's it going?\n\n💡 Ready for more? Upgrade to *Standard* (just R${PRICING.upgrade.expressToStandard}/mo more) and unlock:\n• Services + About + Contact pages\n• Email at your domain\n• Site analytics\n• Referral programme\n\nReply YES to upgrade.\n— Website Hub`;
    } else if (pkg === 'standard') {
      body = `Hi ${name} 👋 One month with *${client.business_name}* live! How's it going?\n\n💡 Ready for more? Upgrade to *Premium* (just R${PRICING.upgrade.standardToPremium}/mo more) and unlock:\n• Photo gallery (update via WhatsApp)\n• 2 email accounts\n• Unlimited revisions\n\nReply YES to upgrade.\n— Website Hub`;
    } else {
      body = `Hi ${name} 👋 One month with *${client.business_name}* live! Hope it's bringing in customers.\n\nAnything to tweak? Just say the word.\n\n${manageUrl ? `Manage: ${manageUrl}\n` : ''}— Website Hub`;
    }
  }

  if (body) {
    await queueScheduledMessage(client.id, client.phone, body, env, { respectDayOfWeek: true });
    await logEvent(env, 'pulse', `post_live_d${day}`, 'success', {
      clientId: client.id, metadata: { business: client.business_name },
    });
  }
}

// ============================================================
// SEQUENCE: win-back at 90 days post-cancellation
// D1 query on clients.cancellation_date instead of KV cancelled:* keys.
// ============================================================

async function runWinBackCron(env) {
  const result = await env.DB.prepare(
    `SELECT * FROM clients
     WHERE status = 'cancelled'
     AND date(cancellation_date) = date('now', ?)
     AND opted_out = 0`,
  ).bind(`-${WIN_BACK_TRIGGER_DAYS} days`).all().catch(() => ({ results: [] }));

  const clients = result?.results || [];
  let sent = 0;

  for (const client of clients) {
    try {
      const alreadySent = await hasMessageBeenSent(env, client.id, TP.WIN_BACK);
      if (alreadySent) continue;

      const name = (client.client_name || '').split(' ')[0] || 'there';
      const reactivateUrl = env.WORKER_URL_REACTIVATE
        ? `${env.WORKER_URL_REACTIVATE}/reactivate-site?clientId=${client.id}`
        : null;

      const body = `Hi ${name} — Pierre here from Website Hub. 👋\n\nJust checking in — hope business is going well.\n\nIf you ever want to get your website back up, it's easy:\n${reactivateUrl || 'reply to this message'}\n\nNo rebuild fee if you come back within a year. Just your normal subscription.\n\nTake care.\n— Pierre, Website Hub`;

      await queueScheduledMessage(client.id, client.phone, body, env, { respectDayOfWeek: true });
      await logMessage(env, client.id, TP.WIN_BACK, client.channel || 'whatsapp');
      await logEvent(env, 'pulse', 'win_back_d90', 'success', {
        clientId: client.id, metadata: { business: client.business_name },
      });
      sent++;
    } catch (err) {
      console.warn(`Win-back failed for ${client.id}:`, err?.message || err);
    }
  }

  return { sent };
}

// ============================================================
// SEQUENCE: prospect limbo follow-up
// D1 prospects table — contacted PROSPECT_FOLLOWUP_DAY days ago, no followup yet.
// ============================================================

async function runProspectLimboFollowUp(env) {
  const result = await env.DB.prepare(
    `SELECT * FROM prospects
     WHERE status = 'pending'
     AND contacted_at IS NOT NULL
     AND followup_sent_at IS NULL
     AND date(contacted_at) = date('now', ?)`,
  ).bind(`-${PROSPECT_FOLLOWUP_DAY} days`).all().catch(() => ({ results: [] }));

  const prospects = result?.results || [];
  let sent = 0;

  for (const prospect of prospects) {
    try {
      if (!prospect.phone) continue;

      // Check opt-out in D1 (clients table or opted_out KV key)
      const optedOut = await env.SITES.get(`optout:${prospect.phone}`).catch(() => null);
      if (optedOut) {
        await env.DB.prepare(`UPDATE prospects SET status = 'opted_out' WHERE id = ?`)
          .bind(prospect.id).run().catch(() => {});
        continue;
      }

      const slug = prospect.slug || slugify(prospect.business_name || '');
      const previewUrl = `https://preview.websitehub.co.za/${slug}`;
      const body = `Hi — Pierre here from Website Hub. 👋\n\nJust a heads-up that your free website preview is still here:\n${previewUrl}\n\nNo obligation. If it's not for you, reply STOP and I won't message again.\n— Pierre, Website Hub`;

      await queueScheduledMessage(null, prospect.phone, body, env, { respectDayOfWeek: true });

      await env.DB.prepare(
        `UPDATE prospects SET followup_sent_at = datetime('now'), status = 'pending'
         WHERE id = ?`
      ).bind(prospect.id).run().catch(() => {});

      await logEvent(env, 'pulse', 'prospect_followup', 'success', {
        metadata: { phone: prospect.phone, slug },
      });
      sent++;
    } catch (err) {
      console.warn(`Prospect follow-up failed for prospect ${prospect.id}:`, err?.message || err);
    }
  }

  return { sent };
}

// ============================================================
// SEQUENCE: referral credit vesting
// D1 referrals table — referred clients whose go_live_date was
// REFERRAL_VEST_DAYS ago and whose referral is still pending.
// ============================================================

async function runReferralVesting(env) {
  if (!(await getFlag(env, 'REFERRAL_ENABLED'))) {
    return { skipped: 'REFERRAL_ENABLED=false' };
  }

  // Find pending referrals where the referred client went live REFERRAL_VEST_DAYS ago
  const result = await env.DB.prepare(
    `SELECT r.id as referral_id, r.referrer_client_id, r.referred_client_id,
            rc.business_name as referred_business, rc.go_live_date,
            rf.id as referrer_id, rf.business_name as referrer_business,
            rf.client_name as referrer_name, rf.email as referrer_email,
            rf.phone as referrer_phone, rf.channel as referrer_channel,
            rf.manage_token as referrer_token
     FROM referrals r
     JOIN clients rc ON rc.id = r.referred_client_id
     JOIN clients rf ON rf.id = r.referrer_client_id
     WHERE r.status = 'pending'
     AND rc.status = 'live'
     AND date(rc.go_live_date) = date('now', ?)`,
  ).bind(`-${REFERRAL_VEST_DAYS} days`).all().catch(() => ({ results: [] }));

  const rows    = result?.results || [];
  let granted   = 0;

  for (const row of rows) {
    try {
      const alreadySent = await hasMessageBeenSent(env, row.referrer_client_id, TP.REFERRAL_VESTING);
      if (alreadySent) {
        // Still vest even if message already sent (idempotent data update)
        await vestReferral(env, row.referred_client_id, PRICING[packageKey('standard')].retainer)
          .catch(() => {});
        continue;
      }

      // Fetch full referrer record for retainer amount
      const referrer = await getClientById(env, row.referrer_client_id).catch(() => null);
      if (!referrer) continue;

      const refTier = PRICING[packageKey(referrer.package || 'standard')];

      // Vest the referral in D1 (updates referrals.status = 'vested' + credit_amount)
      await vestReferral(env, row.referred_client_id, refTier.retainer);

      // Update referrer free_months_earned
      await updateClient(env, referrer.id, {
        referral_conversions: (referrer.referral_conversions || 0) + 1,
        free_months_earned:   (referrer.free_months_earned  || 0) + 1,
      }).catch(() => {});

      // Zoho credit note
      await createZohoCreditNote({
        clientName:  referrer.client_name,
        email:       referrer.email,
        amount:      refTier.retainer,
        description: `Referral credit — ${row.referred_business} went live ${REFERRAL_VEST_DAYS} days ago`,
        creditNum:   `WH-REFCR-${Date.now()}-${(referrer.slug || '').slice(0, 6)}`,
      }, env).catch(e => console.warn('Zoho credit note failed:', e?.message || e));

      // Notify referrer
      const referrerName = (referrer.client_name || '').split(' ')[0] || 'there';
      await queueScheduledMessage(referrer.id, referrer.phone,
        `🎉 ${referrerName}! You just earned a free month thanks to your referral.\n\nYour next invoice will be R0 — credited as a thank you for sending *${row.referred_business}* our way.\n\nKeep them coming!\n— Website Hub`,
        env, { respectDayOfWeek: true });

      await logMessage(env, referrer.id, TP.REFERRAL_VESTING, referrer.channel || 'whatsapp');

      await sendWhatsApp(env.WH_PHONE,
        `🎁 REFERRAL VESTED: ${referrer.business_name} → ${row.referred_business}\nFree month: R${refTier.retainer}\nReferrer: ${referrer.id}`,
        env, { skipTestRedirect: true });

      await logEvent(env, 'pulse', 'referral_vesting', 'success', {
        clientId: referrer.id,
        metadata: { referrerId: referrer.id, referredBusiness: row.referred_business, amount: refTier.retainer },
      });
      granted++;
    } catch (err) {
      console.warn(`Referral vesting failed for referral ${row.referral_id}:`, err?.message || err);
    }
  }

  return { granted };
}

// ============================================================
// SEQUENCE: monthly visit totals → D1 clients.monthly_visits
// Runs on 1st of month. Updates previous month's total visits.
// ============================================================

async function runMonthlyVisitTotals(env) {
  const now      = new Date();
  const prev     = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = prev.toISOString().slice(0, 7);

  const result = await queryClients(
    env,
    `SELECT id, slug, business_name FROM clients WHERE status = 'live'`,
  );
  const clients = result?.results || [];

  let updated = 0;
  for (const client of clients) {
    try {
      const rows  = await getMonthlyVisits(env, client.id, prevMonth);
      const total = rows.reduce((sum, r) => sum + (r.total || 0), 0);
      if (total === 0) continue;

      await updateClient(env, client.id, { monthly_visits: total });
      updated++;
    } catch (e) {
      console.warn(`Monthly visit total failed for ${client.id}:`, e?.message || e);
    }
  }

  return { updated, month: prevMonth };
}

// ============================================================
// SEQUENCE: monthly summary HTML → KV + WhatsApp
// ============================================================

async function runMonthlySummary(env) {
  const now       = new Date();
  const prev      = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = prev.toISOString().slice(0, 7);

  const result  = await queryClients(env, `SELECT * FROM clients WHERE status = 'live'`);
  const clients = result?.results || [];
  let sent = 0;

  for (const client of clients) {
    const alreadySent = await hasMessageBeenSent(env, client.id, TP.MONTHLY_SUMMARY);
    if (alreadySent) continue;

    try {
      const slug = client.slug || slugify(client.business_name);

      // Visits from D1
      const visitRows = await getMonthlyVisits(env, client.id, prevMonth);
      const visits = {
        total:   visitRows.reduce((sum, r) => sum + (r.total || 0), 0),
        perPage: Object.fromEntries(visitRows.map(r => [r.page, r.total || 0])),
        topPage: visitRows.sort((a, b) => (b.total || 0) - (a.total || 0))[0]?.page || 'index',
      };

      // WhatsApp FAB taps from KV (monthly dimension, kept in KV)
      const fabTaps = parseInt(
        await env.SITES.get(`fab_taps:${slug}:${prevMonth}`).catch(() => '0') || '0',
      );

      // Revisions from D1 revisions table (previous month)
      const revStart = prevMonth + '-01';
      const revEnd   = new Date(prev.getFullYear(), prev.getMonth() + 1, 1).toISOString().split('T')[0];
      const revResult = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM revisions
         WHERE client_id = ? AND created_at >= ? AND created_at < ?`
      ).bind(client.id, revStart, revEnd).first().catch(() => ({ count: 0 }));
      const revisionsUsed = revResult?.count || 0;

      // Referrals from D1 (vested this period)
      const refResult = await env.DB.prepare(
        `SELECT COUNT(*) as count FROM referrals
         WHERE referrer_client_id = ? AND status = 'vested'
         AND vested_at >= ? AND vested_at < ?`
      ).bind(client.id, revStart + 'T00:00:00Z', revEnd + 'T00:00:00Z').first().catch(() => ({ count: 0 }));
      const referralVested = refResult?.count || 0;

      const domain = (client.domain || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');

      const html = generateMonthlySummaryHtml({
        businessName: client.business_name,
        package:      client.package || 'standard',
        domain,
        month:        prevMonth,
        visits,
        fabTaps,
        revisionsUsed,
        referralSent: referralVested,
      });

      await env.SITES.put(`monthly_summary:${slug}:${prevMonth}`, html, {
        expirationTtl: MONTHLY_SUMMARY_TTL,
      });

      const summaryUrl = env.WORKER_URL_PULSE
        ? `${env.WORKER_URL_PULSE}/summary/${slug}/${prevMonth}`
        : null;

      if (summaryUrl) {
        const name       = (client.client_name || '').split(' ')[0] || 'there';
        const monthLabel = prev.toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
        await queueScheduledMessage(client.id, client.phone,
          `📊 Hi ${name}! Here's your *${monthLabel}* summary for *${client.business_name}*:\n\n👀 ${visits.total} site views\n💬 ${fabTaps} WhatsApp taps\n\nFull report: ${summaryUrl}\n\n— Website Hub`,
          env, { respectDayOfWeek: true });
      }

      await logMessage(env, client.id, TP.MONTHLY_SUMMARY, client.channel || 'whatsapp');
      await logEvent(env, 'pulse', 'monthly_summary', 'success', {
        clientId: client.id, metadata: { slug, month: prevMonth, visits: visits.total },
      });
      sent++;
    } catch (err) {
      console.warn(`Monthly summary failed for ${client.id}:`, err?.message || err);
    }
  }

  return { sent, month: prevMonth };
}

function generateMonthlySummaryHtml(d) {
  const monthLabel = new Date(d.month + '-01').toLocaleDateString('en-ZA', { month: 'long', year: 'numeric' });
  const perPageList = Object.entries(d.visits.perPage || {})
    .sort(([, a], [, b]) => b - a)
    .map(([page, v]) =>
      `<tr><td style="padding:8px 0;border-bottom:1px solid #2a2a2a">${escapeHtml(page === 'index' ? 'Home' : page)}</td><td style="padding:8px 0;border-bottom:1px solid #2a2a2a;text-align:right;font-family:monospace;color:#ff5500">${v}</td></tr>`,
    ).join('');

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
    <div style="font-size:14px">You earned <strong style="color:#00c97a">${d.referralSent}</strong> referral credit${d.referralSent !== 1 ? 's' : ''} this month.</div>
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
