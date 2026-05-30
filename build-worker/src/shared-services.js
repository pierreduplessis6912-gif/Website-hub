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
    // 5-pass architecture token budgets per page
    // Pass 4 (Skin/HTML) gets the largest budget — full page render
    pass4TokenBudget: { index: 7000 },
    pass5TokenBudget: { index: 3000 },
    // Legacy pageTokenBudget kept for backward compat during transition
    pageTokenBudget:  { index: 7000 },
    emailAccounts:   0,
    gallery:         false,
    referral:        false,
    analytics:       false,
    extraEmailAddon: false,
  },
  standard: {
    pages:           ['index', 'services', 'about', 'contact'],
    pass4TokenBudget: { index: 6000, services: 6000, about: 6000, contact: 5000 },
    pass5TokenBudget: { index: 3000, services: 3000, about: 3000, contact: 2500 },
    pageTokenBudget:  { index: 6000, services: 6000, about: 6000, contact: 5000 },
    emailAccounts:   1,
    gallery:         false,
    referral:        true,
    analytics:       true,
    extraEmailAddon: false,
  },
  premium: {
    pages:           ['index', 'services', 'about', 'contact', 'gallery'],
    pass4TokenBudget: { index: 6000, services: 6000, about: 6000, contact: 5000, gallery: 5000 },
    pass5TokenBudget: { index: 3000, services: 3000, about: 3000, contact: 2500, gallery: 2500 },
    pageTokenBudget:  { index: 6000, services: 6000, about: 6000, contact: 5000, gallery: 5000 },
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
// SECURITY HELPERS
// ────────────────────────────────────────────────────────────

/** Constant-time string comparison to prevent timing attacks. */
export function constantTimeCompare(a, b) {
  const strA = String(a || '');
  const strB = String(b || '');
  if (strA.length !== strB.length) return false;
  let result = 0;
  for (let i = 0; i < strA.length; i++) {
    result |= strA.charCodeAt(i) ^ strB.charCodeAt(i);
  }
  return result === 0;
}

/** Rate limit check using KV. Returns true if allowed, false if rate limited. */
export async function checkRateLimit(env, key, windowMs = 60000, maxRequests = 30) {
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const limitKey = `ratelimit:${key}:${windowStart}`;

  try {
    const current = parseInt(await env.SITES.get(limitKey).catch(() => '0') || '0');
    if (current >= maxRequests) return false;
    await env.SITES.put(limitKey, String(current + 1), { expirationTtl: Math.ceil(windowMs / 1000) + 1 });
    return true;
  } catch {
    // If KV fails, allow the request (fail open for availability)
    return true;
  }
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


// ────────────────────────────────────────────────────────────
// SAFE INFLATE — ZIP bomb protection
// ────────────────────────────────────────────────────────────

const MAX_INFLATE_OUTPUT = 50 * 1024 * 1024; // 50MB max output

export async function safeInflate(data, maxOutput = MAX_INFLATE_OUTPUT) {
  try {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    writer.write(data);
    writer.close();
    const reader = ds.readable.getReader();
    const chunks = [];
    let totalSize = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        totalSize += value.length;
        if (totalSize > maxOutput) {
          reader.releaseLock();
          throw new Error(`Inflate output exceeded ${maxOutput} bytes — possible ZIP bomb`);
        }
        chunks.push(value);
      }
    }

    const out = new Uint8Array(totalSize);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  } catch (e) {
    if (e.message.includes('ZIP bomb')) throw e;
    return null;
  }
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
// QUALITY GATES — Autonomous enforcement without human loop
// ────────────────────────────────────────────────────────────

/** Validates color contrast ratio (WCAG AA = 4.5:1 for normal text). */
export function hasContrast(bgHex, textHex, minRatio = 4.5) {
  const luminance = (hex) => {
    const rgb = hex.replace('#', '').match(/.{2}/g).map(x => {
      const v = parseInt(x, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const L1 = luminance(bgHex) + 0.05;
  const L2 = luminance(textHex) + 0.05;
  const ratio = L1 > L2 ? L1 / L2 : L2 / L1;
  return ratio >= minRatio;
}

/** Extracts all hex colors from a CSS block. */
export function extractColors(cssBlock) {
  const colors = new Set();
  const matches = cssBlock.matchAll(/#[0-9a-fA-F]{3,6}/g);
  for (const m of matches) colors.add(m[0].toLowerCase());
  return [...colors];
}

/** Checks for generic AI filler phrases that kill brand authenticity. */
export function detectGenericCopy(html) {
  const fillerPhrases = [
    'we are a company that',
    'we are dedicated to',
    'our mission is to',
    'we strive to',
    'excellence in everything we do',
    'customer satisfaction is our priority',
    'quality you can trust',
    'your one-stop shop',
    'we pride ourselves',
    'leading provider of',
    'committed to delivering',
    'tailored solutions',
    'unparalleled service',
  ];
  const found = [];
  const lowerHtml = html.toLowerCase();
  for (const phrase of fillerPhrases) {
    if (lowerHtml.includes(phrase)) found.push(phrase);
  }
  return found;
}

/** Validates that images are reachable (HEAD check). */
export async function validateImages(html, env, timeoutMs = 5000) {
  const imgMatches = html.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/gi);
  const urls = [...new Set([...imgMatches].map(m => m[1]))];
  const results = { ok: [], broken: [] };

  await Promise.all(urls.map(async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: 'HEAD', signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) results.ok.push(url);
      else results.broken.push({ url, status: res.status });
    } catch (e) {
      clearTimeout(timer);
      results.broken.push({ url, error: e.message });
    }
  }));

  return results;
}

/** Scores brand voice authenticity (0-100). Higher = more specific, less generic. */
export function scoreBrandVoice(html, businessName, industry, area) {
  let score = 50; // Baseline
  const lower = html.toLowerCase();

  // Bonus: business name appears in body (not just title)
  const nameWords = businessName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const nameInBody = nameWords.filter(w => lower.includes(w)).length;
  score += Math.min(nameInBody * 5, 20);

  // Bonus: area mentioned
  if (area && lower.includes(area.toLowerCase())) score += 10;

  // Bonus: industry-specific terms
  const industryTerms = {
    plumbing: ['leak', 'pipe', 'drain', 'geyser', 'burst', 'tap'],
    electrical: ['wiring', 'certificate', 'compliance', 'db board', 'tripping'],
    cleaning: ['deep clean', 'steam', 'hygiene', 'spotless', 'oven'],
    construction: ['brick', 'cement', 'renovation', 'extension', 'roofing'],
    beauty: ['braids', 'nails', 'facial', 'massage', 'wax'],
    automotive: ['service', 'brake', 'clutch', 'diagnostic', 'tyre'],
    food: ['fresh', 'daily', 'homemade', 'recipe', 'ingredients'],
    fitness: ['personal training', 'gym', 'weights', 'cardio', 'results'],
    medical: ['consultation', 'appointment', 'clinic', 'prescription'],
    legal: ['attorney', 'consultation', 'case', 'legal advice'],
    realestate: ['property', 'valuation', 'bond', 'listing', 'viewing'],
  };
  const terms = industryTerms[Object.keys(industryTerms).find(k => (industry || '').toLowerCase().includes(k))];
  if (terms) {
    const matched = terms.filter(t => lower.includes(t)).length;
    score += Math.min(matched * 5, 15);
  }

  // Penalty: generic filler
  const filler = detectGenericCopy(html);
  score -= filler.length * 8;

  // Penalty: Lorem ipsum or placeholder
  if (lower.includes('lorem ipsum') || lower.includes('placeholder')) score -= 30;

  return Math.max(0, Math.min(100, score));
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

// ── ADDITIONAL D1 HELPERS ─────────────────────────────────────

/** Query multiple clients with optional WHERE clause */
export async function queryClients(env, where = '1=1', bindings = []) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM clients WHERE ${where} ORDER BY created_at DESC`
  ).bind(...bindings).all();
  return results || [];
}

/** Log that a message was sent — prevents duplicate touches */
export async function logMessage(env, clientId, messageKey) {
  const key = `msg:${clientId}:${messageKey}`;
  await env.SITES.put(key, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 120 });
}

/** Check if a message was already sent to this client */
export async function hasMessageBeenSent(env, clientId, messageKey) {
  const key = `msg:${clientId}:${messageKey}`;
  const val = await env.SITES.get(key);
  return !!val;
}

/** Get monthly visit count for a slug (KV-based analytics) */
export async function getMonthlyVisits(env, slug) {
  const key = `analytics:visits:${slug}:${currentMonthKey()}`;
  return parseInt(await env.SITES.get(key) || '0');
}

/** Vest a referral — mark as qualifying, credit the referrer */
export async function vestReferral(env, referralSlug, referredClientId) {
  const key = `referral:vested:${referralSlug}:${referredClientId}`;
  const already = await env.SITES.get(key);
  if (already) return false; // already vested
  await env.SITES.put(key, new Date().toISOString(), { expirationTtl: 60 * 60 * 24 * 365 });
  const conversions = parseInt(await env.SITES.get(`referral:conversions:${referralSlug}`) || '0');
  await env.SITES.put(`referral:conversions:${referralSlug}`, String(conversions + 1));
  return true;
}

// ── D1 CLIENT HELPERS ─────────────────────────────────────────
// Shared across all workers — single source of truth for D1 access

export async function getClientById(clientId, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE id=? LIMIT 1`).bind(clientId).first();
}

export async function getClientBySlug(slug, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE slug=? LIMIT 1`).bind(slug).first();
}

export async function getClientByToken(token, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE manage_token=? LIMIT 1`).bind(token).first();
}

export async function getClientByPhone(phone, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE phone=? ORDER BY created_at DESC LIMIT 1`).bind(phone).first();
}

export async function updateClient(clientId, fields, env) {
  const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
  const vals = [...Object.values(fields), clientId];
  return env.DB.prepare(`UPDATE clients SET ${sets}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...vals).run();
}

// logEvent — alias for logActivity (legacy compat)
export async function logEvent(env, event, data = {}) {
  return logActivity(env, event, data);
}

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
  return fullText;
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
  const evoUrl = env.EVOLUTION_API_URL;
  const evoKey = env.EVOLUTION_API_KEY;
  const evoInstance = env.EVOLUTION_INSTANCE || 'wa1';

  if (!evoUrl || !evoKey) {
    console.warn('Evolution API not configured — skipping:', String(message).slice(0, 60));
    return null;
  }

  const toIntl = normaliseSaPhone(to);
  if (!toIntl) return null;

  // TEST_MODE redirect — message goes to owner with tag showing intended recipient
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

  // Opt-out check
  const optedOut = await env.SITES.get(`optout:${finalTo}`).catch(() => null);
  if (optedOut) {
    console.warn(`Skipping WhatsApp to opted-out number: ${finalTo}`);
    return null;
  }

  try {
    const res = await fetch(
      `${evoUrl}/message/sendText/${evoInstance}`,
      {
        method:  'POST',
        headers: {
          'apikey':       evoKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          number:  `+${finalTo}`,
          text:    finalMsg,
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('Evolution API error:', JSON.stringify(data));
      await logHealth(env, 'whatsapp', 'error', data?.message || `HTTP ${res.status}`);
    } else {
      await logHealth(env, 'whatsapp', 'success');
    }
    return data;
  } catch (e) {
    console.warn('Evolution API fetch error:', e?.message || e);
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
  const { respectDayOfWeek = true, scheduledFor = null } = options;

  // If scheduled for future, always queue regardless of window
  const now = Date.now();
  const targetTime = scheduledFor ? new Date(scheduledFor).getTime() : now;

  if (targetTime > now) {
    const queueKey = `msg_queue:${targetTime}:${String(phone).slice(-6)}:${Date.now().toString(36)}`;
    await env.SITES.put(
      queueKey,
      JSON.stringify({
        airtableId,
        phone,
        message,
        respectDayOfWeek,
        scheduledFor: new Date(targetTime).toISOString(),
        queuedAt: new Date(now).toISOString(),
      }),
      { expirationTtl: 60 * 60 * 24 * 7 },
    ).catch(e => {
      console.warn('Queue write failed — sending immediately as fallback:', e?.message || e);
      return sendWhatsApp(phone, message, env);
    });
    return null;
  }

  if (isInSendWindow({ respectDayOfWeek })) {
    return sendWhatsApp(phone, message, env);
  }

  const queueKey = `msg_queue:${Date.now()}:${String(phone).slice(-6)}:${Date.now().toString(36)}`;
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
  const now  = Date.now();

  const [w1Keys, w2Keys] = await Promise.all([
    env.SITES.list({ prefix: 'msg_queue:'  }).catch(() => ({ keys: [] })),
    env.SITES.list({ prefix: 'send_queue:' }).catch(() => ({ keys: [] })),
  ]);

  for (const key of [...w1Keys.keys, ...w2Keys.keys]) {
    try {
      const raw = await env.SITES.get(key.name);
      if (!raw) continue;
      const item       = JSON.parse(raw);

      // Respect scheduledFor — skip if not yet time
      if (item.scheduledFor) {
        const scheduledTime = new Date(item.scheduledFor).getTime();
        if (scheduledTime > now) continue; // Not yet time
      }

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
// TEMPLATE SYSTEM — archetype detection, KV fetch, token replace
// Used exclusively by build-worker. Lives here so shared-services
// is the single source of truth for all pipeline helpers.
// ────────────────────────────────────────────────────────────

/**
 * Maps an industry string to one of the 5 template archetypes.
 * Falls back to 'emergency' — the most conversion-focused template.
 */
export function detectArchetype(industry) {
  const key = (industry || '').toLowerCase().replace(/[^a-z\s]/g, '');
  if (/plumb|electr|locksmith|ac repair|hvac|geyser|security|pest|tow truck|handyman|appli/.test(key))
    return 'emergency';
  if (/lawyer|attorney|account|doctor|dentist|physio|financial|architect|consult|audit|tax|notary/.test(key))
    return 'trust';
  if (/restaurant|salon|spa|barber|nail|hotel|venue|bakery|coffee|cafe|hair|lash|brow|massage|beauty/.test(key))
    return 'experience';
  if (/hardware|pharmacy|butcher|grocer|creche|dry clean|laundry|florist|nursery|pet shop|bottle store/.test(key))
    return 'local';
  if (/panel|landscap|renovat|contractor|painter|tiler|designer|trainer|gym|fitness|photog|wedding photo/.test(key))
    return 'results';
  return 'emergency';
}

/**
 * Fetches template HTML files from KV for the given archetype and package tier.
 * Falls back to 'emergency' archetype if the requested set isn't loaded yet.
 *
 * @param {string} archetype  'emergency' | 'trust' | 'experience' | 'local' | 'results'
 * @param {string} pkg        Package key from packageKey() — 'express' | 'standard' | 'premium'
 * @param {object} env
 * @returns {{ css: string, pages: Record<string, string> }}
 */
export async function fetchTemplates(archetype, pkg, env) {
  const pageKeys = {
    express:  ['index'],
    standard: ['index', 'services', 'about', 'contact'],
    premium:  ['index', 'services', 'about', 'contact', 'p5'],
  };

  const tier = pageKeys[pkg] || pageKeys.standard;
  const css  = await env.SITES.get(`template:${archetype}:css`).catch(() => null) || '';

  const pages = {};
  for (const page of tier) {
    pages[page] = await env.SITES.get(`template:${archetype}:${page}`).catch(() => null);
  }

  // Fallback: if templates not loaded, try emergency
  if (!pages.index) {
    console.warn(`Templates missing for archetype "${archetype}" — falling back to emergency`);
    if (archetype !== 'emergency') return fetchTemplates('emergency', pkg, env);
    throw new Error('No templates loaded in KV. Run /bootstrap-templates first.');
  }

  return { css, pages };
}

/**
 * Replaces all {{token}} placeholders in an HTML string with values from
 * contentJson and businessFields. Any token not found in the map is left
 * as-is (so claudePersonalise can fill remaining gaps).
 *
 * @param {string} html
 * @param {object} contentJson   Output from Pass 1 Claude call
 * @param {object} businessFields  Normalised fields from Airtable record
 * @param {string} ogImage       Resolved Unsplash or R2 image URL
 */
export function tokenReplace(html, contentJson, businessFields, ogImage) {
  const c = contentJson   || {};
  const b = businessFields || {};
  const s = (arr, i, k) => Array.isArray(arr) && arr[i] ? (arr[i][k] || '') : '';

  const tokens = {
    // ── Global ────────────────────────────────────────────────
    business_name:   b.name  || '',
    phone:           b.phone || '',
    area:            b.area  || '',
    page_title:      c.page_title      || b.name || '',
    og_title:        c.og_title        || b.name || '',
    og_description:  c.og_description  || c.hero_copy || '',
    og_image:        ogImage || '',

    // ── Hero ──────────────────────────────────────────────────
    hero_badge:        c.hero_badge        || '',
    hero_h1_line1:     c.hero_h1_line1     || '',
    hero_h1_line2:     c.hero_h1_line2     || '',
    hero_h1_line3:     c.hero_h1_line3     || '',
    hero_accent_word:  c.hero_accent_word  || '',
    hero_copy:         c.hero_copy         || '',
    hero_mood_line:    c.hero_mood_line    || '',
    hero_result_stat:  c.hero_result_stat  || '',
    hero_result_label: c.hero_result_label || '',
    cta_primary:       c.cta_primary       || 'Contact Us',
    cta_secondary:     c.cta_secondary     || 'Learn More',
    tagline:           c.tagline           || '',

    // ── Stats (emergency) ─────────────────────────────────────
    stat1_num: c.stat1_num || '', stat1_lbl: c.stat1_lbl || '',
    stat2_num: c.stat2_num || '', stat2_lbl: c.stat2_lbl || '',
    stat3_num: c.stat3_num || '', stat3_lbl: c.stat3_lbl || '',

    // ── Proof stats (results) ─────────────────────────────────
    proof_stat1_num: c.proof_stat1_num || '', proof_stat1_lbl: c.proof_stat1_lbl || '',
    proof_stat2_num: c.proof_stat2_num || '', proof_stat2_lbl: c.proof_stat2_lbl || '',
    proof_stat3_num: c.proof_stat3_num || '', proof_stat3_lbl: c.proof_stat3_lbl || '',
    proof_stat4_num: c.proof_stat4_num || '', proof_stat4_lbl: c.proof_stat4_lbl || '',

    // ── Services (emergency / trust / local / results) ────────
    services_section_tag: c.services_section_tag || 'Our Services',
    services_h2:          c.services_h2          || 'What We Do',
    service_category:     c.service_category     || '',

    service1_icon: s(c.services,0,'icon'), service1_name: s(c.services,0,'name'),
    service1_desc: s(c.services,0,'desc'), service1_outcome: s(c.services,0,'outcome'),
    service1_result: s(c.services,0,'result'), service1_note: s(c.services,0,'note'),

    service2_icon: s(c.services,1,'icon'), service2_name: s(c.services,1,'name'),
    service2_desc: s(c.services,1,'desc'), service2_outcome: s(c.services,1,'outcome'),
    service2_result: s(c.services,1,'result'), service2_note: s(c.services,1,'note'),

    service3_icon: s(c.services,2,'icon'), service3_name: s(c.services,2,'name'),
    service3_desc: s(c.services,2,'desc'), service3_outcome: s(c.services,2,'outcome'),
    service3_result: s(c.services,2,'result'), service3_note: s(c.services,2,'note'),

    service4_icon: s(c.services,3,'icon'), service4_name: s(c.services,3,'name'),
    service4_desc: s(c.services,3,'desc'), service4_outcome: s(c.services,3,'outcome'),
    service4_result: s(c.services,3,'result'), service4_note: s(c.services,3,'note'),

    service5_icon: s(c.services,4,'icon'), service5_name: s(c.services,4,'name'),
    service5_desc: s(c.services,4,'desc'), service5_outcome: s(c.services,4,'outcome'),
    service5_result: s(c.services,4,'result'), service5_note: s(c.services,4,'note'),

    service6_icon: s(c.services,5,'icon'), service6_name: s(c.services,5,'name'),
    service6_desc: s(c.services,5,'desc'), service6_outcome: s(c.services,5,'outcome'),
    service6_result: s(c.services,5,'result'), service6_note: s(c.services,5,'note'),

    // ── Offerings (experience) ────────────────────────────────
    offerings_section_tag: c.offerings_section_tag || 'What We Offer',
    offerings_h2:          c.offerings_h2          || 'Our Services',

    offering1_name: s(c.offerings,0,'name'), offering1_desc: s(c.offerings,0,'desc'),
    offering1_price: s(c.offerings,0,'price'), offering1_duration: s(c.offerings,0,'duration'),
    offering2_name: s(c.offerings,1,'name'), offering2_desc: s(c.offerings,1,'desc'),
    offering2_price: s(c.offerings,1,'price'), offering2_duration: s(c.offerings,1,'duration'),
    offering3_name: s(c.offerings,2,'name'), offering3_desc: s(c.offerings,2,'desc'),
    offering3_price: s(c.offerings,2,'price'), offering3_duration: s(c.offerings,2,'duration'),
    offering4_name: s(c.offerings,3,'name'), offering4_desc: s(c.offerings,3,'desc'),
    offering4_price: s(c.offerings,3,'price'), offering4_duration: s(c.offerings,3,'duration'),
    offering5_name: s(c.offerings,4,'name'), offering5_desc: s(c.offerings,4,'desc'),
    offering5_price: s(c.offerings,4,'price'), offering5_duration: s(c.offerings,4,'duration'),
    offering6_name: s(c.offerings,5,'name'), offering6_desc: s(c.offerings,5,'desc'),
    offering6_price: s(c.offerings,5,'price'), offering6_duration: s(c.offerings,5,'duration'),

    // ── About ─────────────────────────────────────────────────
    about_section_tag:    c.about_section_tag    || 'Our Story',
    about_headline:       c.about_headline       || '',
    about_pull_quote:     c.about_pull_quote     || '',
    about_p1:             c.about_p1             || '',
    about_p2:             c.about_p2             || '',
    about_p3:             c.about_p3             || '',
    about_philosophy:     c.about_philosophy     || '',
    about_tagline:        c.about_tagline        || '',
    about_proof_statement: c.about_proof_statement || '',

    // ── Owner / Team ──────────────────────────────────────────
    owner_name:         c.owner_name         || '',
    owner_title:        c.owner_title        || 'Owner',
    owner_credential1:  c.owner_credential1  || '',
    owner_credential2:  c.owner_credential2  || '',
    owner_credential3:  c.owner_credential3  || '',
    team_member2_name:  c.team_member2_name  || '', team_member2_title: c.team_member2_title || '',
    team_member3_name:  c.team_member3_name  || '', team_member3_title: c.team_member3_title || '',
    staff_member2_name: c.staff_member2_name || '', staff_member2_role: c.staff_member2_role || '',
    staff_member3_name: c.staff_member3_name || '', staff_member3_role: c.staff_member3_role || '',

    // ── Trust / Credentials ───────────────────────────────────
    trust_point1: c.trust_point1 || '', trust_point2: c.trust_point2 || '',
    trust_point3: c.trust_point3 || '', trust_point4: c.trust_point4 || '',
    credential1:  c.credential1  || '', credential2: c.credential2  || '',
    credential3:  c.credential3  || '', credential4: c.credential4  || '',

    // ── Contact ───────────────────────────────────────────────
    contact_section_tag: c.contact_section_tag || 'Get In Touch',
    contact_h2_line1:    c.contact_h2_line1    || 'Get In Touch',
    contact_h2_line2:    c.contact_h2_line2    || '',
    contact_copy:        c.contact_copy        || '',

    // ── Hours ─────────────────────────────────────────────────
    hours_weekday:  b.hours_weekday  || 'Mon–Fri: 8am–5pm',
    hours_saturday: b.hours_saturday || 'Saturday: 8am–1pm',
    hours_sunday:   b.hours_sunday   || 'Sunday: Closed',
    hours_monday:   b.hours_weekday  || 'Monday–Friday: 8am–5pm',
    hours_emergency: c.hours_emergency || b.hours_emergency || '24/7 for emergencies',

    // ── Address ───────────────────────────────────────────────
    address_line1: b.address_line1 || b.area || '',
    address_line2: b.address_line2 || '',

    // ── Professional (trust) ──────────────────────────────────
    profession:       c.profession       || '',
    founding_year:    c.founding_year    || '',
    consultation_fee: c.consultation_fee || '',

    // ── Process steps ─────────────────────────────────────────
    process_step1_title: c.process_step1_title || '', process_step1_desc: c.process_step1_desc || '',
    process_step2_title: c.process_step2_title || '', process_step2_desc: c.process_step2_desc || '',
    process_step3_title: c.process_step3_title || '', process_step3_desc: c.process_step3_desc || '',

    // ── Testimonials ──────────────────────────────────────────
    testimonial1_name:    s(c.testimonials,0,'name'),    testimonial1_quote:  s(c.testimonials,0,'quote'),
    testimonial1_result:  s(c.testimonials,0,'result'),  testimonial1_matter: s(c.testimonials,0,'matter'),
    testimonial1_context: s(c.testimonials,0,'context'),
    testimonial1_name_initial: (s(c.testimonials,0,'name')).charAt(0) || '',

    testimonial2_name:    s(c.testimonials,1,'name'),    testimonial2_quote:  s(c.testimonials,1,'quote'),
    testimonial2_result:  s(c.testimonials,1,'result'),  testimonial2_matter: s(c.testimonials,1,'matter'),
    testimonial2_context: s(c.testimonials,1,'context'),
    testimonial2_name_initial: (s(c.testimonials,1,'name')).charAt(0) || '',

    testimonial3_name:    s(c.testimonials,2,'name'),    testimonial3_quote:  s(c.testimonials,2,'quote'),
    testimonial3_result:  s(c.testimonials,2,'result'),  testimonial3_matter: s(c.testimonials,2,'matter'),
    testimonial3_context: s(c.testimonials,2,'context'),
    testimonial3_name_initial: (s(c.testimonials,2,'name')).charAt(0) || '',

    // ── FAQ (trust p5) ────────────────────────────────────────
    faq_intro: c.faq_intro || '',
    faq1_q: s(c.faqs,0,'q'), faq1_a: s(c.faqs,0,'a'),
    faq2_q: s(c.faqs,1,'q'), faq2_a: s(c.faqs,1,'a'),
    faq3_q: s(c.faqs,2,'q'), faq3_a: s(c.faqs,2,'a'),
    faq4_q: s(c.faqs,3,'q'), faq4_a: s(c.faqs,3,'a'),
    faq5_q: s(c.faqs,4,'q'), faq5_a: s(c.faqs,4,'a'),
    faq6_q: s(c.faqs,5,'q'), faq6_a: s(c.faqs,5,'a'),

    // ── Coverage (emergency p5) ───────────────────────────────
    coverage_intro:         c.coverage_intro         || '',
    coverage_response_time: c.coverage_response_time || '30–60 minutes',
    coverage_area1: s(c.coverage_areas,0,''), coverage_area2: s(c.coverage_areas,1,''),
    coverage_area3: s(c.coverage_areas,2,''), coverage_area4: s(c.coverage_areas,3,''),
    coverage_area5: s(c.coverage_areas,4,''), coverage_area6: s(c.coverage_areas,5,''),
    coverage_area7: s(c.coverage_areas,6,''), coverage_area8: s(c.coverage_areas,7,''),

    // ── Experience-specific ───────────────────────────────────
    business_type:       c.business_type       || '',
    vibe1: s(c.vibes,0,''), vibe2: s(c.vibes,1,''), vibe3: s(c.vibes,2,''), vibe4: s(c.vibes,3,''),
    years_open:          c.years_open          || '',
    team_size:           c.team_size           || '',
    parking_note:        c.parking_note        || '',
    gallery_section_tag: c.gallery_section_tag || 'Our Work',
    gallery_h2:          c.gallery_h2          || 'Gallery',
    gallery_intro:       c.gallery_intro       || '',

    // ── Local-specific ────────────────────────────────────────
    since_year:    c.since_year    || c.founding_year || '',
    trade:         c.trade         || '',
    about_tagline: c.about_tagline || '',
    delivery_note: c.delivery_note || '',
    badge1: s(c.badges,0,''), badge2: s(c.badges,1,''), badge3: s(c.badges,2,''), badge4: s(c.badges,3,''),
    community_point1: s(c.community_points,0,''), community_point2: s(c.community_points,1,''),
    community_point3: s(c.community_points,2,''), community_point4: s(c.community_points,3,''),
    community_cta:    c.community_cta || '',
    gallery_caption1: s(c.gallery_captions,0,''), gallery_caption2: s(c.gallery_captions,1,''),
    gallery_caption3: s(c.gallery_captions,2,''), gallery_caption4: s(c.gallery_captions,3,''),
    gallery_caption5: s(c.gallery_captions,4,''), gallery_caption6: s(c.gallery_captions,5,''),

    // ── Results-specific ──────────────────────────────────────
    clients_served:     c.clients_served     || '',
    years_active:       c.years_active       || '',
    response_commitment: c.response_commitment || '',
    availability_note:  c.availability_note  || '',
    about_proof_statement: c.about_proof_statement || '',

    case1_client: s(c.case_studies,0,'client'), case1_challenge: s(c.case_studies,0,'challenge'),
    case1_solution: s(c.case_studies,0,'solution'), case1_timeframe: s(c.case_studies,0,'timeframe'),
    case1_result1: Array.isArray(c.case_studies?.[0]?.results) ? (c.case_studies[0].results[0]||'') : '',
    case1_result2: Array.isArray(c.case_studies?.[0]?.results) ? (c.case_studies[0].results[1]||'') : '',
    case1_result3: Array.isArray(c.case_studies?.[0]?.results) ? (c.case_studies[0].results[2]||'') : '',

    case2_client: s(c.case_studies,1,'client'), case2_challenge: s(c.case_studies,1,'challenge'),
    case2_solution: s(c.case_studies,1,'solution'), case2_timeframe: s(c.case_studies,1,'timeframe'),
    case2_result1: Array.isArray(c.case_studies?.[1]?.results) ? (c.case_studies[1].results[0]||'') : '',
    case2_result2: Array.isArray(c.case_studies?.[1]?.results) ? (c.case_studies[1].results[1]||'') : '',
    case2_result3: Array.isArray(c.case_studies?.[1]?.results) ? (c.case_studies[1].results[2]||'') : '',

    case3_client: s(c.case_studies,2,'client'), case3_challenge: s(c.case_studies,2,'challenge'),
    case3_solution: s(c.case_studies,2,'solution'), case3_timeframe: s(c.case_studies,2,'timeframe'),
    case3_result1: Array.isArray(c.case_studies?.[2]?.results) ? (c.case_studies[2].results[0]||'') : '',
    case3_result2: Array.isArray(c.case_studies?.[2]?.results) ? (c.case_studies[2].results[1]||'') : '',
    case3_result3: Array.isArray(c.case_studies?.[2]?.results) ? (c.case_studies[2].results[2]||'') : '',

    client1_name: s(c.client_names,0,''), client2_name: s(c.client_names,1,''),
    client3_name: s(c.client_names,2,''), client4_name: s(c.client_names,3,''),
    client5_name: s(c.client_names,4,''),
  };

  // coverage_areas is an array — handle both string and object items
  if (Array.isArray(c.coverage_areas)) {
    for (let i = 0; i < 8; i++) {
      const v = c.coverage_areas[i];
      tokens[`coverage_area${i+1}`] = (typeof v === 'string' ? v : v?.name || v?.area || '') || '';
    }
  }

  // vibes, badges, community_points, gallery_captions — same pattern
  ['vibes', 'badges', 'community_points', 'gallery_captions', 'client_names'].forEach(key => {
    if (Array.isArray(c[key])) {
      const prefix = { vibes: 'vibe', badges: 'badge', community_points: 'community_point',
                       gallery_captions: 'gallery_caption', client_names: 'client' }[key];
      c[key].forEach((v, i) => { tokens[`${prefix}${i+1}`] = (typeof v === 'string' ? v : '') || ''; });
    }
  });

  return html.replace(/\{\{(\w+)\}\}/g, (match, key) => tokens[key] ?? match);
}

/**
 * Builds the Express single-scroll page by extracting WH_EXPRESS_INCLUDE
 * sections from services, about, and contact pages and injecting them
 * before the footer of the index page.
 *
 * @param {object} pages   { index, services, about, contact } — all already token-replaced
 * @param {string} css     CSS block to inject (handled separately by injectCss)
 * @returns {string}       Complete single-scroll HTML
 */
export function buildExpressPage(pages) {
  const extract = (html, pageName) => {
    if (!html) return '';
    const start = `<!-- WH_EXPRESS_INCLUDE: ${pageName} -->`;
    const end   = '<!-- WH_EXPRESS_END -->';
    const si = html.indexOf(start);
    const ei = html.indexOf(end, si);
    if (si === -1 || ei === -1) return '';
    return html.slice(si + start.length, ei).trim();
  };

  let expressHtml = pages.index || '';

  const servicesSection = extract(pages.services || '', 'services');
  const aboutSection    = extract(pages.about    || '', 'about');
  const contactSection  = extract(pages.contact  || '', 'contact');

  // Fix nav links to use anchor hrefs
  expressHtml = expressHtml
    .replace(/href="services\.html"/g, 'href="#services"')
    .replace(/href="about\.html"/g,    'href="#about"')
    .replace(/href="contact\.html"/g,  'href="#contact"')
    .replace(/href="coverage\.html"/g, 'href="#contact"');

  // Inject extracted sections before </body> (after last main section)
  const sections = [
    servicesSection ? `<section id="services">${servicesSection}</section>` : '',
    aboutSection    ? `<section id="about">${aboutSection}</section>`       : '',
    contactSection  ? `<section id="contact">${contactSection}</section>`   : '',
  ].filter(Boolean).join('\n');

  if (sections && expressHtml.includes('<footer')) {
    expressHtml = expressHtml.replace('<footer', `${sections}\n<footer`);
  }

  return expressHtml;
}

// ────────────────────────────────────────────────────────────
// End of shared-services.js
// ────────────────────────────────────────────────────────────
