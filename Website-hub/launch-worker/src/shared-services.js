// ============================================================
// WEBSITE HUB — shared-services.js
// Foundation module imported by every worker in the system.
//
// Exports: constants, response helpers, string/encoding utilities,
// pricing helpers, Claude API, WhatsApp (Meta Cloud API), Airtable
// CRUD, Zoho Books, Formspree mapping, logging, flag resolution.
//
// IMPORT EXAMPLE (in any worker file):
//   import {
//     PRICING, getPricingTier, buildPayFastLink, sendWhatsApp,
//     callClaudeInternal, getAirtableRecord, updateAirtableRecord,
//     logActivity, logHealth, jsonResponse, corsResponse, slugify,
//   } from './shared-services.js';
//
// DESIGN RULES (do not break):
//   1. Every function takes `env` so it works across Workers.
//   2. TEST_MODE is honoured here — no external side-effects when
//      env.TEST_MODE === 'true'. See isTestMode() callers.
//   3. No KV key prefix collisions with worker-local data — anything
//      shared lives under: health:, activity:, msg_queue:, send_queue:,
//      optout:, config:, system:.
//   4. Function signatures are LOCKED. Other workers depend on them.
//      env comes first on all logging functions; (recipient, message,
//      env, opts) on send functions; (recordId, ..., env) on Airtable.
// ============================================================

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

// SAST = UTC+2
export const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// Send window: Tue/Wed/Thu, 09:00–12:00 SAST.
// Day numbers: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat.
export const SEND_WINDOW = Object.freeze({
  days:      [2, 3, 4],
  startHour: 9,
  endHour:   12,
});

// PRICING — locked per battle plan (May 11 2026). Single source of truth.
// All other workers import this; no other file may redefine pricing.
export const PRICING = Object.freeze({
  express:  { build: 0, retainer:  699 },
  standard: { build: 0, retainer:  999 },
  premium:  { build: 0, retainer: 1499 },
  upgrade: {
    expressToStandard: 300, // 999 - 699
    expressToPremium:  800, // 1499 - 699
    standardToPremium: 500, // 1499 - 999
  },
  addons: {
    extraEmail: 200, // per month, Premium only
    revision:   500, // per request, all tiers
  },
});

// Package capabilities — manage panel and build pipeline read this.
export const PACKAGE_CAPS = Object.freeze({
  express: {
    pages:           ['index'],
    // 4-pass architecture token budgets per page
    // Pass 2 = CSS only (no HTML). Pass 3 = slot-fill HTML. Pass 4 = copy polish.
    pass3TokenBudget: { index: 2000 },
    pass4TokenBudget: { index: 3000 },
    // pageTokenBudget kept for backward compat
    pageTokenBudget:  { index: 3000 },
    emailAccounts:   0,
    gallery:         false,
    referral:        false,
    analytics:       false,
    extraEmailAddon: false,
  },
  standard: {
    pages:           ['index', 'services', 'about', 'contact'],
    pass3TokenBudget: { index: 2000, services: 2000, about: 2000, contact: 2000 },
    pass4TokenBudget: { index: 3000, services: 3000, about: 3000, contact: 3000 },
    pageTokenBudget:  { index: 3000, services: 3000, about: 3000, contact: 3000 },
    emailAccounts:   1,
    gallery:         false,
    referral:        true,
    analytics:       true,
    extraEmailAddon: false,
  },
  premium: {
    pages:           ['index', 'services', 'about', 'contact', 'gallery'],
    pass4TokenBudget: { index: 12000, services: 12000, about: 12000, contact: 10000, gallery: 8000 },
    pass5TokenBudget: { index: 4000, services: 4000, about: 4000, contact: 3000, gallery: 3000 },
    pageTokenBudget:  { index: 12000, services: 12000, about: 12000, contact: 10000, gallery: 8000 },
    emailAccounts:   2,
    gallery:         true,
    referral:        true,
    analytics:       true,
    extraEmailAddon: true,
  },
});

// Preview link expiry — 30 days after build.
export const PREVIEW_EXPIRY_DAYS = 30;

// Referral vesting — credit fires after referred client live this long.
export const REFERRAL_VEST_DAYS = 30;

// Win-back trigger — cancelled clients re-engaged after this many days.
export const WIN_BACK_TRIGGER_DAYS = 90;

// Prospect cooldown after final "not interested" follow-up.
export const PROSPECT_COOLDOWN_DAYS = 60;

// ────────────────────────────────────────────────────────────
// TEST_MODE
// ────────────────────────────────────────────────────────────

/** Single source of truth for sandbox mode. */
export function isTestMode(env) {
  return env?.TEST_MODE === 'true' || env?.TEST_MODE === true;
}

// ────────────────────────────────────────────────────────────
// HTTP RESPONSE HELPERS
// ────────────────────────────────────────────────────────────

export function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    },
  });
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      'Content-Type':    'text/html;charset=UTF-8',
      'X-Frame-Options': 'SAMEORIGIN',
      ...extraHeaders,
    },
  });
}

// ────────────────────────────────────────────────────────────
// STRING + ENCODING UTILITIES
// ────────────────────────────────────────────────────────────

export function slugify(name) {
  return (name || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function getMime(ext) {
  return {
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
    png:  'image/png',
    webp: 'image/webp',
    gif:  'image/gif',
    svg:  'image/svg+xml',
  }[String(ext || '').toLowerCase()] || 'image/jpeg';
}

/** Returns YYYY-MM-DD one calendar month from today. */
export function nextMonthDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}

/** Returns YYYY-MM (e.g. "2026-05") for current month in UTC. */
export function currentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

/** Returns YYYY-MM-DD for current day in UTC. */
export function todayDateString() {
  return new Date().toISOString().split('T')[0];
}

// MD5 — needed for PayFast signature generation.
// Pure JS implementation (no Web Crypto MD5 in Workers runtime).
export function md5(str) {
  function safeAdd(x, y) { const lsw = (x & 0xFFFF) + (y & 0xFFFF); return (((x >> 16) + (y >> 16) + (lsw >> 16)) << 16) | (lsw & 0xFFFF); }
  function bitRotateLeft(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }
  function md5cmn(q, a, b, x, s, t) { return safeAdd(bitRotateLeft(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
  function md5ff(a, b, c, d, x, s, t) { return md5cmn((b & c) | ((~b) & d), a, b, x, s, t); }
  function md5gg(a, b, c, d, x, s, t) { return md5cmn((b & d) | (c & (~d)), a, b, x, s, t); }
  function md5hh(a, b, c, d, x, s, t) { return md5cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5ii(a, b, c, d, x, s, t) { return md5cmn(c ^ (b | (~d)), a, b, x, s, t); }

  const bytes    = new TextEncoder().encode(str);
  const length8  = bytes.length;
  const length16 = (length8 + 72) >> 6;
  const words    = new Int32Array(length16 << 4);
  for (let i = 0; i < length8; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
  words[length8 >> 2] |= 0x80 << ((length8 % 4) * 8);
  words[(length16 << 4) - 2] = length8 * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < words.length; i += 16) {
    const [oa, ob, oc, od] = [a, b, c, d];
    a = md5ff(a, b, c, d, words[i+0],  7,  -680876936); d = md5ff(d, a, b, c, words[i+1],  12,  -389564586); c = md5ff(c, d, a, b, words[i+2],  17,   606105819); b = md5ff(b, c, d, a, words[i+3],  22, -1044525330);
    a = md5ff(a, b, c, d, words[i+4],  7,  -176418897); d = md5ff(d, a, b, c, words[i+5],  12,  1200080426); c = md5ff(c, d, a, b, words[i+6],  17, -1473231341); b = md5ff(b, c, d, a, words[i+7],  22,   -45705983);
    a = md5ff(a, b, c, d, words[i+8],  7,  1770035416); d = md5ff(d, a, b, c, words[i+9],  12, -1958414417); c = md5ff(c, d, a, b, words[i+10], 17,      -42063); b = md5ff(b, c, d, a, words[i+11], 22, -1990404162);
    a = md5ff(a, b, c, d, words[i+12], 7,  1804603682); d = md5ff(d, a, b, c, words[i+13], 12,   -40341101); c = md5ff(c, d, a, b, words[i+14], 17, -1502002290); b = md5ff(b, c, d, a, words[i+15], 22,  1236535329);
    a = md5gg(a, b, c, d, words[i+1],  5,  -165796510); d = md5gg(d, a, b, c, words[i+6],  9,  -1069501632); c = md5gg(c, d, a, b, words[i+11], 14,   643717713); b = md5gg(b, c, d, a, words[i+0],  20,  -373897302);
    a = md5gg(a, b, c, d, words[i+5],  5,  -701558691); d = md5gg(d, a, b, c, words[i+10], 9,     38016083); c = md5gg(c, d, a, b, words[i+15], 14,  -660478335); b = md5gg(b, c, d, a, words[i+4],  20,  -405537848);
    a = md5gg(a, b, c, d, words[i+9],  5,   568446438); d = md5gg(d, a, b, c, words[i+14], 9,  -1019803690); c = md5gg(c, d, a, b, words[i+3],  14,  -187363961); b = md5gg(b, c, d, a, words[i+8],  20,  1163531501);
    a = md5gg(a, b, c, d, words[i+13], 5, -1444681467); d = md5gg(d, a, b, c, words[i+2],  9,    -51403784); c = md5gg(c, d, a, b, words[i+7],  14,  1735328473); b = md5gg(b, c, d, a, words[i+12], 20, -1926607734);
    a = md5hh(a, b, c, d, words[i+5],  4,     -378558); d = md5hh(d, a, b, c, words[i+8],  11, -2022574463); c = md5hh(c, d, a, b, words[i+11], 16,  1839030562); b = md5hh(b, c, d, a, words[i+14], 23,   -35309556);
    a = md5hh(a, b, c, d, words[i+1],  4, -1530992060); d = md5hh(d, a, b, c, words[i+4],  11,  1272893353); c = md5hh(c, d, a, b, words[i+7],  16,  -155497632); b = md5hh(b, c, d, a, words[i+10], 23, -1094730640);
    a = md5hh(a, b, c, d, words[i+13], 4,   681279174); d = md5hh(d, a, b, c, words[i+0],  11,  -358537222); c = md5hh(c, d, a, b, words[i+3],  16,  -722521979); b = md5hh(b, c, d, a, words[i+6],  23,    76029189);
    a = md5hh(a, b, c, d, words[i+9],  4,  -640364487); d = md5hh(d, a, b, c, words[i+12], 11,  -421815835); c = md5hh(c, d, a, b, words[i+15], 16,   530742520); b = md5hh(b, c, d, a, words[i+2],  23,  -995338651);
    a = md5ii(a, b, c, d, words[i+0],  6,  -198630844); d = md5ii(d, a, b, c, words[i+7],  10,  1126891415); c = md5ii(c, d, a, b, words[i+14], 15, -1416354905); b = md5ii(b, c, d, a, words[i+5],  21,   -57434055);
    a = md5ii(a, b, c, d, words[i+12], 6,  1700485571); d = md5ii(d, a, b, c, words[i+3],  10, -1894986606); c = md5ii(c, d, a, b, words[i+10], 15,    -1051523); b = md5ii(b, c, d, a, words[i+1],  21, -2054922799);
    a = md5ii(a, b, c, d, words[i+8],  6,  1873313359); d = md5ii(d, a, b, c, words[i+15], 10,    -30611744); c = md5ii(c, d, a, b, words[i+6],  15, -1560198380); b = md5ii(b, c, d, a, words[i+13], 21,  1309151649);
    a = md5ii(a, b, c, d, words[i+4],  6,  -145523070); d = md5ii(d, a, b, c, words[i+11], 10, -1120210379); c = md5ii(c, d, a, b, words[i+2],  15,   718787259); b = md5ii(b, c, d, a, words[i+9],  21,  -343485551);
    a = safeAdd(a, oa); b = safeAdd(b, ob); c = safeAdd(c, oc); d = safeAdd(d, od);
  }
  return [a, b, c, d]
    .map(n => Array.from({ length: 4 }, (_, i) => ((n >> (i * 8)) & 0xFF).toString(16).padStart(2, '0')).join(''))
    .join('');
}

// ────────────────────────────────────────────────────────────
// PRICING + PAYFAST
// ────────────────────────────────────────────────────────────

/** Normalises a package string to a PRICING key. Defaults to standard. */
export function packageKey(pkg) {
  const key = String(pkg || '').toLowerCase().trim();
  if (key === 'express')  return 'express';
  if (key === 'premium')  return 'premium';
  return 'standard';
}

/** Returns the pricing tier object for a package name. */
export function getPricingTier(pkg) {
  return PRICING[packageKey(pkg)];
}

/** Returns the capability set for a package name. */
export function getPackageCaps(pkg) {
  return PACKAGE_CAPS[packageKey(pkg)];
}

/**
 * Returns the monthly delta in Rands for upgrading from one tier to another.
 * Returns 0 if downgrade or same tier (we don't bill for those).
 */
export function getUpgradeDelta(fromPkg, toPkg) {
  const from = packageKey(fromPkg);
  const to   = packageKey(toPkg);
  if (from === to) return 0;
  if (from === 'express'  && to === 'standard') return PRICING.upgrade.expressToStandard;
  if (from === 'express'  && to === 'premium')  return PRICING.upgrade.expressToPremium;
  if (from === 'standard' && to === 'premium')  return PRICING.upgrade.standardToPremium;
  return 0;
}

/**
 * Builds a PayFast checkout URL.
 * In TEST_MODE: uses sandbox.payfast.co.za + sandbox merchant id (PAYFAST_SANDBOX_*).
 * In live mode: uses www.payfast.co.za + production merchant id.
 *
 * @param {number} amount        ZAR amount (integer)
 * @param {string} itemName      Display name shown on PayFast page
 * @param {string} airtableId    Stored in custom_str1 for webhook lookup
 * @param {object} env           Cloudflare env bindings
 * @param {object} [opts]        Optional overrides
 * @param {string} [opts.itemDesc]   Extra description on PayFast page
 * @param {string} [opts.returnUrl]  Where PayFast sends user on success
 * @param {string} [opts.cancelUrl]  Where PayFast sends user on cancel
 * @param {string} [opts.notifyUrl]  ITN webhook URL (launch-worker /payfast-webhook)
 * @param {string} [opts.customStr2] Optional second custom field for context
 */
export function buildPayFastLink(amount, itemName, airtableId, env, opts = {}) {
  const sandbox = isTestMode(env);
  const host    = sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
  const merchId = sandbox
    ? (env?.PAYFAST_SANDBOX_MERCHANT_ID || '10000100')
    : (env?.PAYFAST_MERCHANT_ID || '13581217');

  const params = new URLSearchParams();
  params.set('merchant_id', merchId);
  params.set('amount',      String(amount));
  params.set('item_name',   itemName);
  params.set('custom_str1', airtableId);

  if (opts.itemDesc)   params.set('item_description', opts.itemDesc);
  if (opts.customStr2) params.set('custom_str2',     opts.customStr2);
  if (opts.returnUrl)  params.set('return_url',      opts.returnUrl);
  if (opts.cancelUrl)  params.set('cancel_url',      opts.cancelUrl);
  if (opts.notifyUrl)  params.set('notify_url',      opts.notifyUrl);

  return `https://${host}/eng/process?${params.toString()}`;
}

// ────────────────────────────────────────────────────────────
// FLAG RESOLUTION
// Reads KV override first (config:*) then falls back to env var.
// Allows dashboard circuit-breaker toggles without redeploy.
// ────────────────────────────────────────────────────────────

const FLAG_KV_KEYS = {
  OUTBOUND_ENABLED:          'config:outbound_enabled',
  REFERRAL_ENABLED:          'config:referral_enabled',
  VISION_VALIDATION_ENABLED: 'config:vision_enabled',
  ZOHO_PROVISIONING_ENABLED: 'config:zoho_provisioning_enabled',
  GBP_UPDATE_ENABLED:        'config:gbp_update_enabled',
};

export async function getFlag(env, envVarName) {
  const kvKey = FLAG_KV_KEYS[envVarName];
  if (kvKey) {
    try {
      const kvVal = await env.SITES.get(kvKey);
      if (kvVal !== null && kvVal !== undefined) return kvVal === 'true';
    } catch { /* fall through to env var */ }
  }
  return env[envVarName] === 'true';
}

// ────────────────────────────────────────────────────────────
// LOGGING
// All logs go to KV. Dashboard reads health:* for circuit breaker
// panel; activity:* for activity feed; Airtable Build Log table
// for build history.
// ────────────────────────────────────────────────────────────

/**
 * Logs an activity event with arbitrary data.
 * Key: activity:{timestamp}:{event}
 * TTL: 30 days.
 *
 * Optionally pass data.source = 'build' | 'patch' | 'launch' | 'pulse' | 'reactivate'
 * to tag which worker emitted the event.
 */
export async function logActivity(env, event, data = {}) {
  try {
    const ts      = Date.now();
    const key     = `activity:${ts}:${event}`;
    const payload = JSON.stringify({
      event,
      ...data,
      timestamp: new Date(ts).toISOString(),
    });
    await env.SITES.put(key, payload, { expirationTtl: 60 * 60 * 24 * 30 });
  } catch { /* non-fatal */ }
}

/**
 * Logs the result of a call to an external service.
 * Key: health:{service}.
 * status: 'success' | 'partial' | 'error'.
 * TTL: 7 days.
 *
 * Dashboard reads these to show traffic-light state per service.
 * If any health key is missing or status === 'error' with a recent
 * timestamp, the dashboard lights it red.
 */
export async function logHealth(env, service, status, error = null) {
  try {
    const normStatus = (status === 'success' || status === 'partial' || status === 'ok') ? 'ok' : 'error';
    const now        = new Date().toISOString();
    const payload    = {
      status:    normStatus,
      timestamp: now,
      ...(normStatus === 'ok' ? { lastSuccess: now } : { lastError: error }),
    };
    await env.SITES.put(
      `health:${service}`,
      JSON.stringify(payload),
      { expirationTtl: 60 * 60 * 24 * 7 },
    );
  } catch { /* non-fatal */ }
}

/**
 * Logs a build attempt to the Airtable "Build Log" table.
 * Non-fatal — failures are swallowed so a build never dies because logging failed.
 */
export async function logBuild(clientId, status, errorMsg, env, tokens = 0) {
  try {
    await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/Build%20Log`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        fields: {
          'Client':          [clientId],
          'Build Triggered': new Date().toISOString(),
          'Build Status':    status,
          'Tokens Used':     tokens,
          'Error Log':       errorMsg || '',
        },
      }),
    });
  } catch (e) {
    console.warn('Build log failed (non-fatal):', e?.message || e);
  }
}

// ────────────────────────────────────────────────────────────
// CLAUDE API — model resolution + streaming completion
// ────────────────────────────────────────────────────────────

/**
 * Auto-resolves the latest Sonnet model from Anthropic's /v1/models endpoint.
 * Cached in KV for 24h. On any failure, falls back to the pinned snapshot.
 *
 * To force a re-resolution: delete KV key `system:claude_model`.
 */
export async function resolveClaudeModel(env) {
  const CACHE_KEY = 'system:claude_model';
  const CACHE_TTL = 60 * 60 * 24; // 24 hours

  const cached = await env.SITES.get(CACHE_KEY).catch(() => null);
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
    const sorted = (models || [])
      .filter(m => m.id?.includes('claude') && !m.id.includes('haiku'))
      .sort((a, b) => (b.created || 0) - (a.created || 0));

    const sonnet = sorted.find(m => m.id.includes('sonnet'));
    const chosen = (sonnet || sorted[0])?.id;
    if (!chosen) throw new Error('No suitable Claude model found');

    await env.SITES.put(CACHE_KEY, chosen, { expirationTtl: CACHE_TTL });
    console.log(`Claude model resolved: ${chosen}`);
    return chosen;
  } catch (e) {
    console.warn(`Model resolution failed (${e.message}), using fallback`);
    return 'claude-sonnet-4-6';
  }
}

/**
 * Calls Claude with streaming. Returns the full concatenated text.
 *
 * @param {string} systemPrompt
 * @param {Array}  messages       [{ role, content }, ...]
 * @param {object} env
 * @param {object} [options]
 * @param {number} [options.maxTokens=8000]
 * @param {number} [options.temperature]  Optional — omitted means default.
 */
export async function callClaudeInternal(systemPrompt, messages, env, options = {}) {
  const model = await resolveClaudeModel(env);

  const body = {
    model,
    max_tokens: options.maxTokens ?? 8000,
    stream:     true,
    system:     systemPrompt,
    messages,
  };
  if (typeof options.temperature === 'number') body.temperature = options.temperature;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    await logHealth(env, 'anthropic', 'error', `${res.status}: ${err.slice(0, 200)}`);
    throw new Error(`Anthropic API error ${res.status}: ${err}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let fullText  = '';
  let buffer    = '';

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

  if (!fullText) {
    await logHealth(env, 'anthropic', 'error', 'Empty response');
    throw new Error('Empty response received from Anthropic');
  }
  await logHealth(env, 'anthropic', 'success');

  // Strip markdown fences that Claude sometimes wraps around HTML/CSS/JSON output.
  // Handles: ```html, ```css, ```json, ``` — at start and end of response.
  // This is the single source of truth for fence stripping; build-worker's
  // local stripMarkdown() is kept as a second defence layer.
  const stripped = fullText
    .replace(/^```[a-zA-Z]*\r?\n?/, '')  // opening fence + optional language tag
    .replace(/\r?\n?```\s*$/, '')         // closing fence
    .trim();

  return stripped || fullText; // fall back to raw if strip produces empty string
}

// ────────────────────────────────────────────────────────────
// WHATSAPP — Meta Cloud API
// Two send paths:
//   sendWhatsApp           — immediate. Honours optout + TEST_MODE.
//   queueScheduledMessage  — window-respecting. Sends if in window, else KV-queues.
// processMessageQueue drains queues during cron. Drains BOTH legacy prefixes
// (msg_queue: from worker1 and send_queue: from enrichment worker).
// ────────────────────────────────────────────────────────────

/**
 * Normalises a SA phone number to international format without leading +.
 * Example: '0840142017' → '27840142017'
 */
export function normaliseSaPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('27') ? digits : digits.replace(/^0/, '27');
}

/**
 * Sends a WhatsApp message immediately via Meta Cloud API.
 *
 * Behaviour:
 *   — TEST_MODE → redirected to env.WH_PHONE with a [TEST→originalNumber] prefix.
 *   — optout:{phone} in KV → silently dropped.
 *   — META_WA_TOKEN missing → logs and returns null (non-fatal).
 *
 * @param {string} to        Recipient phone (any SA format)
 * @param {string} message   Text body
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.previewUrl=false]   Allow URL previews
 * @param {boolean} [opts.skipTestRedirect]   Bypass TEST_MODE redirect (rare; e.g. owner alerts)
 */
export async function sendWhatsApp(to, message, env, opts = {}) {
  if (!env.META_WA_TOKEN || !env.META_PHONE_NUMBER_ID) {
    console.warn('Meta WhatsApp not configured — skipping:', String(message).slice(0, 60));
    return null;
  }

  const toIntl = normaliseSaPhone(to);
  if (!toIntl) return null;

  // TEST_MODE redirect — message goes to owner with a tag showing intended recipient.
  // We check optout AFTER deciding the final destination, so opted-out real recipients
  // don't block test deliveries to owner.
  let finalTo  = toIntl;
  let finalMsg = message;
  const testRedirect = isTestMode(env) && !opts.skipTestRedirect;
  if (testRedirect) {
    const ownerPhone = normaliseSaPhone(env.WH_PHONE);
    if (!ownerPhone) {
      console.warn('TEST_MODE on but WH_PHONE missing — dropping message');
      return null;
    }
    finalTo  = ownerPhone;
    finalMsg = `[TEST → +${toIntl}]\n${message}`;
  }

  // Opt-out check on the FINAL recipient.
  // In TEST_MODE that's the owner — they shouldn't have themselves opted out, but
  // we still honour the flag if they did. In production it's the real recipient.
  const optedOut = await env.SITES.get(`optout:${finalTo}`).catch(() => null);
  if (optedOut) {
    console.warn(`Skipping WhatsApp to opted-out number: ${finalTo}`);
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
          to:                `+${finalTo}`,
          type:              'text',
          text:              { preview_url: opts.previewUrl === true, body: finalMsg },
        }),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      console.warn('Meta WhatsApp error:', JSON.stringify(data));
      await logHealth(env, 'whatsapp', 'error', data?.error?.message || `HTTP ${res.status}`);
    } else {
      await logHealth(env, 'whatsapp', 'success');
    }
    return data;
  } catch (e) {
    console.warn('Meta WhatsApp fetch error:', e?.message || e);
    await logHealth(env, 'whatsapp', 'error', e?.message || 'fetch failed');
    return null;
  }
}

/**
 * Returns true if NOW is within the send window in SAST.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.respectDayOfWeek=true]  If false, allow any day (still respects hours).
 */
export function isInSendWindow(opts = {}) {
  const { respectDayOfWeek = true } = opts;
  const sast = new Date(Date.now() + SAST_OFFSET_MS);
  const hour = sast.getUTCHours();
  const day  = sast.getUTCDay();

  const inHours = hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour;
  const inDays  = SEND_WINDOW.days.includes(day);
  return inHours && (!respectDayOfWeek || inDays);
}

/**
 * Queues a WhatsApp message for delivery within the send window.
 * If we're already in the window, sends immediately.
 * Otherwise stores in KV at msg_queue:{ts}:{phoneSuffix} with 7-day TTL.
 *
 * @param {string}  airtableId
 * @param {string}  phone
 * @param {string}  message
 * @param {object}  env
 * @param {object}  [options]
 * @param {boolean} [options.respectDayOfWeek=true]  Retainer reminders set false (still gated to hours).
 */
export async function queueScheduledMessage(airtableId, phone, message, env, options = {}) {
  const { respectDayOfWeek = true } = options;

  if (isInSendWindow({ respectDayOfWeek })) {
    return sendWhatsApp(phone, message, env);
  }

  const queueKey = `msg_queue:${Date.now()}:${String(phone).slice(-6)}`;
  await env.SITES.put(
    queueKey,
    JSON.stringify({
      airtableId,
      phone,
      message,
      respectDayOfWeek,
      queuedAt: new Date().toISOString(),
    }),
    { expirationTtl: 60 * 60 * 24 * 7 },
  ).catch(e => {
    console.warn('Queue write failed — sending immediately as fallback:', e?.message || e);
    return sendWhatsApp(phone, message, env);
  });
  return null;
}

/**
 * Drains both queue prefixes (msg_queue: and send_queue:) if we're in window.
 * Called from pulse-worker every cron tick.
 */
export async function processMessageQueue(env) {
  if (!isInSendWindow({ respectDayOfWeek: true })) return; // skip out-of-window entirely

  const sast = new Date(Date.now() + SAST_OFFSET_MS);
  const day  = sast.getUTCDay();

  const [w1Keys, w2Keys] = await Promise.all([
    env.SITES.list({ prefix: 'msg_queue:'  }).catch(() => ({ keys: [] })),
    env.SITES.list({ prefix: 'send_queue:' }).catch(() => ({ keys: [] })),
  ]);

  for (const key of [...w1Keys.keys, ...w2Keys.keys]) {
    try {
      const raw = await env.SITES.get(key.name);
      if (!raw) continue;
      const item       = JSON.parse(raw);
      const respectDay = item.respectDayOfWeek !== undefined ? item.respectDayOfWeek : true;
      if (respectDay && !SEND_WINDOW.days.includes(day)) continue;

      const recipient = item.phone || item.to;
      if (!recipient) { await env.SITES.delete(key.name); continue; }

      await sendWhatsApp(recipient, item.message, env);
      await env.SITES.delete(key.name);
    } catch (e) {
      console.warn('Message queue item failed:', e?.message || e);
    }
  }
}

// ────────────────────────────────────────────────────────────
// AIRTABLE — CRUD against the main Clients table
// ────────────────────────────────────────────────────────────

export async function createAirtableRecord(fields, env) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([_, v]) => v !== '' && v !== null && v !== undefined),
  );
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ fields: clean }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    await logHealth(env, 'airtable', 'error', `create ${res.status}`);
    throw new Error(`Airtable create failed: ${res.status} — ${body}`);
  }
  await logHealth(env, 'airtable', 'success');
  return res.json();
}

export async function getAirtableRecord(recordId, env) {
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}/${recordId}`,
    { headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` } },
  );
  if (!res.ok) {
    await logHealth(env, 'airtable', 'error', `get ${res.status}`);
    throw new Error(`Airtable get failed: ${res.status}`);
  }
  return res.json();
}

export async function updateAirtableRecord(recordId, fields, env) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([_, v]) => v !== undefined && v !== null),
  );
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}/${recordId}`,
    {
      method:  'PATCH',
      headers: {
        'Authorization': `Bearer ${env.AIRTABLE_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ fields: clean }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    await logHealth(env, 'airtable', 'error', `update ${res.status}`);
    throw new Error(`Airtable update failed: ${res.status} — ${body}`);
  }
  return res.json();
}

/**
 * Lists records matching a filter formula. Handles pagination automatically.
 * Hard cap of 1000 records to prevent runaway scans.
 *
 * @param {string|null} filterFormula  Airtable formula or null for "all"
 * @param {object}      env
 * @param {number|null} [maxRecords=null]  Optional smaller cap
 */
export async function listAirtableRecords(filterFormula, env, maxRecords = null) {
  const allRecords = [];
  let offset = null;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (filterFormula) params.set('filterByFormula', filterFormula);
    if (offset)        params.set('offset', offset);

    const res = await fetch(
      `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}?${params}`,
      { headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` } },
    );
    if (!res.ok) {
      await logHealth(env, 'airtable', 'error', `list ${res.status}`);
      throw new Error(`Airtable list failed: ${res.status}`);
    }
    const data = await res.json();
    allRecords.push(...(data.records || []));
    offset = data.offset || null;

    if (maxRecords && allRecords.length >= maxRecords) break;
    if (allRecords.length >= 1000) break;
  } while (offset);
  return allRecords;
}

// ────────────────────────────────────────────────────────────
// FORMSPREE → AIRTABLE field mapping
// ────────────────────────────────────────────────────────────

export function mapFormspreeToAirtable(body) {
  const pkgRaw = body['Package'] || body['package'] || 'Standard';
  // Normalise display: Express / Standard / Premium
  const pkgKey = packageKey(pkgRaw);
  const pkg    = pkgKey.charAt(0).toUpperCase() + pkgKey.slice(1);
  const tier   = getPricingTier(pkg);

  return {
    'Business Name':   body['Business Name']   || body['businessName'] || '',
    'Client Name':     body['Client Name']     || body['clientName']   || '',
    'WhatsApp':        body['WhatsApp']        || body['whatsapp']     || '',
    'Email':           body['Email']           || body['email']        || '',
    'Package':         pkg,
    'Hosting':         'Hosted',
    'Build Fee':       tier.build,
    'Retainer':        tier.retainer,
    'Status':          'Lead',
    'Industry':        body['Industry']        || body['industry']     || '',
    'Area':            body['Area']            || body['area']         || '',
    'Domain':          body['Domain']          || body['domain']       || '',
    'Dropbox Link':    body['Dropbox Assets']  || body['gdrive']       || '',
    'Instagram':       body['Instagram']       || body['instagram']    || '',
    'Facebook':        body['Facebook']        || body['facebook']     || '',
    'TikTok':          body['TikTok']          || body['tiktok']       || '',
    'Google Business': body['Google Business'] || body['google']       || '',
    'Services':        body['Services']        || body['services']     || '',
    'About':           body['About']           || body['about']        || '',
    'Bio':             body['Bio']             || body['bio']          || '',
    'Post Captions':   body['Posts']           || body['posts']        || '',
    'Reviews':         body['Reviews']         || body['reviews']      || '',
    'Colours':         body['Colours']         || body['colours']      || '',
    'Vibe':            body['Vibe']            || body['vibe']         || '',
    'Inspo Sites':     body['Inspo']           || body['inspo']        || '',
    'Extra Notes':     body['Extra Notes']     || body['extra']        || '',
    'Source':          'Website',
    'Submission Date': todayDateString(),
  };
}

// ────────────────────────────────────────────────────────────
// ZOHO BOOKS — invoice + credit note
// TEST_MODE: API calls skipped; payloads logged to KV instead at:
//   test_log:zoho:invoice:{ts}:{invoiceNum}
//   test_log:zoho:credit:{ts}:{creditNum}
// ────────────────────────────────────────────────────────────

export async function getZohoAccessToken(env) {
  if (!env.ZOHO_REFRESH_TOKEN) return null;
  try {
    const res = await fetch('https://accounts.zoho.com/oauth/v2/token', {
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
      if (['invalid_code', 'access_denied'].includes(reason) || String(reason).includes('expired')) {
        // Alert owner — never gets test-redirected because it's already to owner
        await sendWhatsApp(
          env.WH_PHONE,
          `🔐 ZOHO AUTH EXPIRED — invoicing is down. Re-run /zoho-auth to fix.\nError: ${reason}`,
          env,
          { skipTestRedirect: true },
        ).catch(() => {});
      }
      await logHealth(env, 'zoho', 'error', reason);
      return null;
    }
    await logHealth(env, 'zoho', 'success');
    return data.access_token;
  } catch (e) {
    await logHealth(env, 'zoho', 'error', e?.message || 'token fetch failed');
    return null;
  }
}

/**
 * Creates a Zoho invoice (or in TEST_MODE, logs the payload to KV).
 *
 * @param {object} args
 * @param {string} args.clientName
 * @param {string} args.email
 * @param {number} args.amount
 * @param {string} args.description
 * @param {string} args.invoiceNum
 * @param {boolean} [args.markPaid=false]  Set to true on go-live (deposit already paid via PayFast)
 * @param {string}  [args.payLink='']      PayFast URL to include in invoice notes
 * @param {object}  env
 */
export async function createZohoInvoice(args, env) {
  const { clientName, email, amount, description, invoiceNum, markPaid = false, payLink = '' } = args;

  // TEST_MODE → log payload only
  if (isTestMode(env)) {
    const key = `test_log:zoho:invoice:${Date.now()}:${invoiceNum}`;
    await env.SITES.put(
      key,
      JSON.stringify({ clientName, email, amount, description, invoiceNum, markPaid, payLink, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    await logActivity(env, 'test_mode_zoho_invoice', { invoiceNum, amount, clientName });
    return { invoice_number: invoiceNum, amount, test_mode: true };
  }

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
    const searchRes  = await fetch(
      `https://books.zoho.com/api/v3/contacts?organization_id=${orgId}&email=${encodeURIComponent(email)}`,
      { headers },
    );
    const searchData = await searchRes.json();
    const existing   = searchData?.contacts?.[0];
    if (existing) {
      contactId = existing.contact_id;
    } else {
      const contactRes  = await fetch(
        `https://books.zoho.com/api/v3/contacts?organization_id=${orgId}`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({ contact_name: clientName, email, contact_type: 'customer' }),
        },
      );
      const contactData = await contactRes.json();
      contactId = contactData?.contact?.contact_id;
    }
  } catch (e) {
    console.warn('Zoho contact lookup failed:', e?.message || e);
    return null;
  }
  if (!contactId) return null;

  const today   = todayDateString();
  const dueDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const notes   = payLink
    ? `Pay online: ${payLink}\n\nThank you for choosing Website Hub.`
    : 'Thank you for choosing Website Hub.';

  try {
    const suffix     = markPaid ? '&invoice_status=paid' : '';
    const invoiceRes = await fetch(
      `https://books.zoho.com/api/v3/invoices?organization_id=${orgId}&send=true${suffix}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          customer_id:    contactId,
          invoice_number: invoiceNum,
          date:           today,
          due_date:       dueDate,
          line_items: [{ description, quantity: 1, rate: amount }],
          notes,
        }),
      },
    );
    const invoiceData = await invoiceRes.json();
    await logHealth(env, 'zoho', 'success');
    return invoiceData?.invoice || null;
  } catch (e) {
    console.warn('Zoho invoice create failed:', e?.message || e);
    await logHealth(env, 'zoho', 'error', e?.message || 'invoice create failed');
    return null;
  }
}

/**
 * Creates a Zoho credit note (e.g. for referral free months).
 * TEST_MODE: logs payload to KV.
 */
export async function createZohoCreditNote(args, env) {
  const { clientName, email, amount, description, creditNum } = args;

  if (isTestMode(env)) {
    const key = `test_log:zoho:credit:${Date.now()}:${creditNum}`;
    await env.SITES.put(
      key,
      JSON.stringify({ clientName, email, amount, description, creditNum, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    await logActivity(env, 'test_mode_zoho_credit', { creditNum, amount, clientName });
    return { creditnote_number: creditNum, amount, test_mode: true };
  }

  if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_ORG_ID) return null;

  const accessToken = await getZohoAccessToken(env);
  if (!accessToken) return null;

  const headers = {
    'Authorization': `Zoho-oauthtoken ${accessToken}`,
    'Content-Type':  'application/json',
  };
  const orgId = env.ZOHO_ORG_ID;

  let contactId;
  try {
    const searchRes  = await fetch(
      `https://books.zoho.com/api/v3/contacts?organization_id=${orgId}&email=${encodeURIComponent(email)}`,
      { headers },
    );
    const searchData = await searchRes.json();
    contactId = searchData?.contacts?.[0]?.contact_id;
  } catch {
    return null;
  }
  if (!contactId) return null;

  try {
    const today     = todayDateString();
    const creditRes = await fetch(
      `https://books.zoho.com/api/v3/creditnotes?organization_id=${orgId}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          customer_id:       contactId,
          creditnote_number: creditNum,
          date:              today,
          line_items: [{ description, quantity: 1, rate: amount }],
        }),
      },
    );
    const creditData = await creditRes.json();
    await logHealth(env, 'zoho', 'success');
    return creditData?.creditnote || null;
  } catch (e) {
    console.warn('Zoho credit note failed:', e?.message || e);
    await logHealth(env, 'zoho', 'error', e?.message || 'credit note failed');
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// End of shared-services.js
// ────────────────────────────────────────────────────────────
