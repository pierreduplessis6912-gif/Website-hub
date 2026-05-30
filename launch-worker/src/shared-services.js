// ============================================================
// WEBSITE HUB — shared-services.js
// Foundation module imported by every worker in the system.
//
// Exports: constants, response helpers, string/encoding utilities,
// pricing helpers, Claude API, WhatsApp (Meta Cloud API), email
// (Resend), Zoho Books, D1 CRUD, logging, flag resolution,
// template system, quality gates.
//
// IMPORT EXAMPLE (in any worker file):
//   import {
//     PRICING, getPricingTier, buildPayFastLink, sendWhatsApp,
//     sendEmail, callClaudeInternal, getClientByToken, updateClient,
//     logEvent, logMessage, hasMessageBeenSent,
//     jsonResponse, corsResponse, slugify,
//   } from './shared-services.js';
//
// DESIGN RULES (do not break):
//   1. Every function takes `env` so it works across Workers.
//   2. TEST_MODE is honoured — no external side-effects when
//      env.TEST_MODE === 'true'. See isTestMode() callers.
//   3. KV (env.SITES) is content shelf only: HTML blobs, SPA,
//      templates, rate-limit counters, message queue, flag overrides.
//      All client state lives in D1 (env.DB).
//   4. Function signatures are LOCKED. Other workers depend on them.
//      env comes first on all D1/logging functions.
//   5. logEvent() is non-fatal. Every logging call is fire-and-forget.
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

// PRICING — locked per spec v2.0 (May 2026). Single source of truth.
// All other workers import this; no other file may redefine pricing.
export const PRICING = Object.freeze({
  express:  { build: 0, retainer:  299 },
  standard: { build: 0, retainer:  699 },
  premium:  { build: 0, retainer:  999 },
  upgrade: {
    expressToStandard: 300,  // 999 - 699
    expressToPremium:  800,  // 1499 - 699
    standardToPremium: 500,  // 1499 - 999
  },
  addons: {
    extraEmail: 200, // per month, Premium only
    revision:   150, // R150 per paid revision — fixed from incorrect R500
  },
});

// Package capabilities — manage panel and build pipeline read this.
export const PACKAGE_CAPS = Object.freeze({
  express: {
    pages:            ['index'],
    pass4TokenBudget: { index: 7000 },
    pass5TokenBudget: { index: 3000 },
    pageTokenBudget:  { index: 7000 },
    emailAccounts:    0,
    gallery:          false,
    referral:         false,
    analytics:        false,
    extraEmailAddon:  false,
  },
  standard: {
    pages:            ['index'],
    pass4TokenBudget: { index: 6000, services: 6000, about: 6000, contact: 5000 },
    pass5TokenBudget: { index: 3000, services: 3000, about: 3000, contact: 2500 },
    pageTokenBudget:  { index: 6000, services: 6000, about: 6000, contact: 5000 },
    emailAccounts:    1,
    gallery:          false,
    referral:         true,
    analytics:        true,
    extraEmailAddon:  false,
  },
  premium: {
    pages:            ['index'],
    pass4TokenBudget: { index: 6000, services: 6000, about: 6000, contact: 5000, gallery: 5000 },
    pass5TokenBudget: { index: 3000, services: 3000, about: 3000, contact: 2500, gallery: 2500 },
    pageTokenBudget:  { index: 6000, services: 6000, about: 6000, contact: 5000, gallery: 5000 },
    emailAccounts:    2,
    gallery:          true,
    referral:         true,
    analytics:        true,
    extraEmailAddon:  true,
  },
});

// Preview link expiry — 35 days after build (KV TTL).
export const PREVIEW_EXPIRY_DAYS = 35;

// Referral vesting — credit fires after referred client live this long.
export const REFERRAL_VEST_DAYS = 30;

// Win-back trigger — cancelled clients re-engaged after this many days.
export const WIN_BACK_TRIGGER_DAYS = 90;

// Prospect cooldown after final "not interested" follow-up.
export const PROSPECT_COOLDOWN_DAYS = 60;

// ── KV_KEYS registry ──────────────────────────────────────────────────────────
export const KV_KEYS = {
  // App HTML blobs
  APP_PWA:             'app:pwa',
  APP_START:           'app:start-v2',
  APP_ADMIN:           'app:admin',
  INTAKE_HTML:         'app:intake-experience',

  // Build status — keyed by manage_token, D1 is authoritative fallback
  BUILD_STATUS:        (token)       => `build_status:${token}`,

  // Built site pages
  SITE_PAGE:           (slug, page)  => `preview:${slug}:${page}`,
  DRAFT_PAGE:          (slug, page)  => `draft:${slug}:${page}`,
  CONTENT:             (slug)        => `content:${slug}`,

  // Brand brief cache
  INTAKE_BRIEF:        (slug)        => `intake_brief:${slug}`,

  // Client lookups
  CLIENT_SITE:         (slug)        => `site:${slug}`,
  CLIENT_META:         (slug)        => `meta:${slug}`,

  // Comms
  OPTOUT:              (phone)       => `optout:${phone}`,
  PROSPECT_STATE:      (phone)       => `prospect_state:${phone}`,

  // Templates
  TEMPLATE_HOME:       'template:home',
  TEMPLATE_SUSPENDED:  'template:suspended',
  TEMPLATE_CANCELLED:  'template:cancelled',
  TEMPLATE_PAGE:       (arch, page)  => `template:${arch}:${page}`,

  // Outbound
  PORTFOLIO_CANDIDATE: (slug)        => `portfolio_candidate:${slug}`,
};
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Rate limit check using KV. Returns true if allowed, false if rate limited.
 * KV is still the correct store for ephemeral rate-limit counters.
 */
export async function checkRateLimit(env, key, windowMs = 60000, maxRequests = 30) {
  const now         = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const limitKey    = `ratelimit:${key}:${windowStart}`;
  try {
    const current = parseInt(await env.SITES.get(limitKey).catch(() => '0') || '0');
    if (current >= maxRequests) return false;
    await env.SITES.put(limitKey, String(current + 1), { expirationTtl: Math.ceil(windowMs / 1000) + 1 });
    return true;
  } catch {
    return true; // fail open for availability
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

/** Alias used by createClient and prospect flows. */
export const generateSlug = slugify;

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
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

const MAX_INFLATE_OUTPUT = 50 * 1024 * 1024; // 50MB

export async function safeInflate(data, maxOutput = MAX_INFLATE_OUTPUT) {
  try {
    const ds     = new DecompressionStream('deflate-raw');
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

// ────────────────────────────────────────────────────────────
// MD5 — needed for PayFast signature generation.
// Pure JS (no Web Crypto MD5 in Workers runtime).
// ────────────────────────────────────────────────────────────

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
    a = md5ff(a,b,c,d,words[i+0],  7, -680876936);  d = md5ff(d,a,b,c,words[i+1],  12, -389564586);  c = md5ff(c,d,a,b,words[i+2],  17,  606105819);  b = md5ff(b,c,d,a,words[i+3],  22,-1044525330);
    a = md5ff(a,b,c,d,words[i+4],  7, -176418897);  d = md5ff(d,a,b,c,words[i+5],  12, 1200080426);  c = md5ff(c,d,a,b,words[i+6],  17,-1473231341);  b = md5ff(b,c,d,a,words[i+7],  22,  -45705983);
    a = md5ff(a,b,c,d,words[i+8],  7, 1770035416);  d = md5ff(d,a,b,c,words[i+9],  12,-1958414417);  c = md5ff(c,d,a,b,words[i+10], 17,    -42063);    b = md5ff(b,c,d,a,words[i+11], 22,-1990404162);
    a = md5ff(a,b,c,d,words[i+12], 7, 1804603682);  d = md5ff(d,a,b,c,words[i+13], 12,  -40341101);  c = md5ff(c,d,a,b,words[i+14], 17,-1502002290);  b = md5ff(b,c,d,a,words[i+15], 22, 1236535329);
    a = md5gg(a,b,c,d,words[i+1],  5, -165796510);  d = md5gg(d,a,b,c,words[i+6],   9,-1069501632);  c = md5gg(c,d,a,b,words[i+11], 14,  643717713);  b = md5gg(b,c,d,a,words[i+0],  20, -373897302);
    a = md5gg(a,b,c,d,words[i+5],  5, -701558691);  d = md5gg(d,a,b,c,words[i+10],  9,   38016083);  c = md5gg(c,d,a,b,words[i+15], 14, -660478335);  b = md5gg(b,c,d,a,words[i+4],  20, -405537848);
    a = md5gg(a,b,c,d,words[i+9],  5,  568446438);  d = md5gg(d,a,b,c,words[i+14],  9,-1019803690);  c = md5gg(c,d,a,b,words[i+3],  14, -187363961);  b = md5gg(b,c,d,a,words[i+8],  20, 1163531501);
    a = md5gg(a,b,c,d,words[i+13], 5,-1444681467);  d = md5gg(d,a,b,c,words[i+2],   9,  -51403784);  c = md5gg(c,d,a,b,words[i+7],  14, 1735328473);  b = md5gg(b,c,d,a,words[i+12], 20,-1926607734);
    a = md5hh(a,b,c,d,words[i+5],  4,    -378558);  d = md5hh(d,a,b,c,words[i+8],  11,-2022574463);  c = md5hh(c,d,a,b,words[i+11], 16, 1839030562);  b = md5hh(b,c,d,a,words[i+14], 23,  -35309556);
    a = md5hh(a,b,c,d,words[i+1],  4,-1530992060);  d = md5hh(d,a,b,c,words[i+4],  11, 1272893353);  c = md5hh(c,d,a,b,words[i+7],  16, -155497632);  b = md5hh(b,c,d,a,words[i+10], 23,-1094730640);
    a = md5hh(a,b,c,d,words[i+13], 4,  681279174);  d = md5hh(d,a,b,c,words[i+0],  11, -358537222);  c = md5hh(c,d,a,b,words[i+3],  16, -722521979);  b = md5hh(b,c,d,a,words[i+6],  23,   76029189);
    a = md5hh(a,b,c,d,words[i+9],  4, -640364487);  d = md5hh(d,a,b,c,words[i+12], 11, -421815835);  c = md5hh(c,d,a,b,words[i+15], 16,  530742520);  b = md5hh(b,c,d,a,words[i+2],  23, -995338651);
    a = md5ii(a,b,c,d,words[i+0],  6, -198630844);  d = md5ii(d,a,b,c,words[i+7],  10, 1126891415);  c = md5ii(c,d,a,b,words[i+14], 15,-1416354905);  b = md5ii(b,c,d,a,words[i+5],  21,  -57434055);
    a = md5ii(a,b,c,d,words[i+12], 6, 1700485571);  d = md5ii(d,a,b,c,words[i+3],  10,-1894986606);  c = md5ii(c,d,a,b,words[i+10], 15,   -1051523);  b = md5ii(b,c,d,a,words[i+1],  21,-2054922799);
    a = md5ii(a,b,c,d,words[i+8],  6, 1873313359);  d = md5ii(d,a,b,c,words[i+15], 10,  -30611744);  c = md5ii(c,d,a,b,words[i+6],  15,-1560198380);  b = md5ii(b,c,d,a,words[i+13], 21, 1309151649);
    a = md5ii(a,b,c,d,words[i+4],  6, -145523070);  d = md5ii(d,a,b,c,words[i+11], 10,-1120210379);  c = md5ii(c,d,a,b,words[i+2],  15,  718787259);  b = md5ii(b,c,d,a,words[i+9],  21, -343485551);
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
  return (L1 > L2 ? L1 / L2 : L2 / L1) >= minRatio;
}

/** Extracts all hex colors from a CSS block. */
export function extractColors(cssBlock) {
  const colors  = new Set();
  const matches = cssBlock.matchAll(/#[0-9a-fA-F]{3,6}/g);
  for (const m of matches) colors.add(m[0].toLowerCase());
  return [...colors];
}

/** Checks for generic AI filler phrases that kill brand authenticity. */
export function detectGenericCopy(html) {
  const fillerPhrases = [
    'we are a company that', 'we are dedicated to', 'our mission is to',
    'we strive to', 'excellence in everything we do',
    'customer satisfaction is our priority', 'quality you can trust',
    'your one-stop shop', 'we pride ourselves', 'leading provider of',
    'committed to delivering', 'tailored solutions', 'unparalleled service',
  ];
  const lower = html.toLowerCase();
  return fillerPhrases.filter(p => lower.includes(p));
}

/** Validates that images are reachable (HEAD check). */
export async function validateImages(html, env, timeoutMs = 5000) {
  const imgMatches = html.matchAll(/<img[^>]+src="(https?:\/\/[^"]+)"/gi);
  const urls       = [...new Set([...imgMatches].map(m => m[1]))];
  const results    = { ok: [], broken: [] };

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
  let score = 50;
  const lower = html.toLowerCase();

  const nameWords = businessName.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  score += Math.min(nameWords.filter(w => lower.includes(w)).length * 5, 20);
  if (area  && lower.includes(area.toLowerCase()))     score += 10;

  const industryTerms = {
    plumbing:    ['leak', 'pipe', 'drain', 'geyser', 'burst', 'tap'],
    electrical:  ['wiring', 'certificate', 'compliance', 'db board', 'tripping'],
    cleaning:    ['deep clean', 'steam', 'hygiene', 'spotless', 'oven'],
    construction:['brick', 'cement', 'renovation', 'extension', 'roofing'],
    beauty:      ['braids', 'nails', 'facial', 'massage', 'wax'],
    automotive:  ['service', 'brake', 'clutch', 'diagnostic', 'tyre'],
    food:        ['fresh', 'daily', 'homemade', 'recipe', 'ingredients'],
    fitness:     ['personal training', 'gym', 'weights', 'cardio', 'results'],
    medical:     ['consultation', 'appointment', 'clinic', 'prescription'],
    legal:       ['attorney', 'consultation', 'case', 'legal advice'],
    realestate:  ['property', 'valuation', 'bond', 'listing', 'viewing'],
  };
  const terms = industryTerms[Object.keys(industryTerms).find(k => (industry || '').toLowerCase().includes(k))];
  if (terms) score += Math.min(terms.filter(t => lower.includes(t)).length * 5, 15);

  score -= detectGenericCopy(html).length * 8;
  if (lower.includes('lorem ipsum') || lower.includes('placeholder')) score -= 30;

  return Math.max(0, Math.min(100, score));
}

// ────────────────────────────────────────────────────────────
// PRICING + PAYFAST
// ────────────────────────────────────────────────────────────

/** Normalises a package string to a PRICING key. Defaults to standard. */
export function packageKey(pkg) {
  const key = String(pkg || '').toLowerCase().trim();
  if (key === 'express') return 'express';
  if (key === 'premium') return 'premium';
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
 * Returns the monthly delta in Rands for upgrading between tiers.
 * Returns 0 for same tier or downgrade.
 */
export function getUpgradeDelta(fromPkg, toPkg) {
  const from = packageKey(fromPkg);
  const to   = packageKey(toPkg);
  if (from === to)                                    return 0;
  if (from === 'express'  && to === 'standard')       return PRICING.upgrade.expressToStandard;
  if (from === 'express'  && to === 'premium')        return PRICING.upgrade.expressToPremium;
  if (from === 'standard' && to === 'premium')        return PRICING.upgrade.standardToPremium;
  return 0;
}

/**
 * Builds a PayFast checkout URL.
 * TEST_MODE: sandbox.payfast.co.za + sandbox merchant id.
 * Live mode:  www.payfast.co.za   + production merchant id.
 *
 * @param {number} amount        ZAR amount (integer)
 * @param {string} itemName      Display name shown on PayFast page
 * @param {string} clientId      D1 client UUID — stored in custom_str1 for ITN lookup
 * @param {object} env
 * @param {object} [opts]
 */
export function buildPayFastLink(amount, itemName, clientId, env, opts = {}) {
  const sandbox = isTestMode(env);
  const host    = sandbox ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
  const merchId = sandbox
    ? (env?.PAYFAST_SANDBOX_MERCHANT_ID || '10000100')
    : (env?.PAYFAST_MERCHANT_ID         || '13581217');

  const params = new URLSearchParams();
  params.set('merchant_id', merchId);
  params.set('amount',      String(amount));
  params.set('item_name',   itemName);
  params.set('custom_str1', clientId);

  if (opts.itemDesc)   params.set('item_description', opts.itemDesc);
  if (opts.customStr2) params.set('custom_str2',      opts.customStr2);
  if (opts.returnUrl)  params.set('return_url',       opts.returnUrl);
  if (opts.cancelUrl)  params.set('cancel_url',       opts.cancelUrl);
  if (opts.notifyUrl)  params.set('notify_url',       opts.notifyUrl);

  return `https://${host}/eng/process?${params.toString()}`;
}

/**
 * Verifies a PayFast ITN signature.
 * Reconstructs the hash from posted parameters and compares with submitted signature.
 *
 * @param {URLSearchParams|object} params  All POST parameters from PayFast ITN
 * @param {string|null} passphrase         PayFast passphrase (from env.PAYFAST_PASSPHRASE)
 * @returns {boolean}
 */
export function verifyPayFastSignature(params, passphrase = null) {
  try {
    const paramObj = params instanceof URLSearchParams
      ? Object.fromEntries(params.entries())
      : { ...params };

    const submittedSig = paramObj.signature;
    if (!submittedSig) return false;

    // Build the string to hash — all params except signature, in original order
    const pairs = Object.entries(paramObj)
      .filter(([k]) => k !== 'signature')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v).trim())}`)
      .join('&');

    const toHash = passphrase
      ? `${pairs}&passphrase=${encodeURIComponent(passphrase.trim())}`
      : pairs;

    return md5(toHash) === submittedSig.toLowerCase();
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────
// FLAG RESOLUTION
// KV override first (config:*) then falls back to env var.
// Allows circuit-breaker toggles without redeploy.
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
// LOGGING — D1 events table
// Replaces logActivity, logHealth, and logBuild.
// All workers use logEvent. Non-fatal — never throws.
// ────────────────────────────────────────────────────────────

/**
 * Logs a system event to the D1 events table.
 *
 * @param {object} env
 * @param {string} worker     build / patch / launch / pulse / reactivate / shared
 * @param {string} eventType  e.g. build_started, payment_received, whatsapp_send
 * @param {string} status     success / failure / warning
 * @param {object} [options]
 * @param {string|null} [options.clientId]   D1 client UUID (null for system events)
 * @param {number|null} [options.durationMs]
 * @param {string|null} [options.error]
 * @param {object|null} [options.metadata]   Any extra JSON context
 */
export async function logEvent(env, worker, eventType, status, options = {}) {
  try {
    const { clientId = null, durationMs = null, error = null, metadata = null } = options;
    await env.DB.prepare(
      `INSERT INTO events (client_id, worker, event_type, status, duration_ms, error, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      clientId,
      worker,
      eventType,
      status,
      durationMs,
      error,
      metadata ? JSON.stringify(metadata) : null,
    ).run();
  } catch (e) {
    console.warn('logEvent failed (non-fatal):', e?.message || e);
  }
}

// ────────────────────────────────────────────────────────────
// CLAUDE API — model resolution + streaming completion
// ────────────────────────────────────────────────────────────

/**
 * Auto-resolves the latest Sonnet model from Anthropic's /v1/models endpoint.
 * Cached in KV for 24h. Falls back to pinned snapshot on any failure.
 */
export async function resolveClaudeModel(env) {
  const CACHE_KEY = 'system:claude_model';
  const CACHE_TTL = 60 * 60 * 24;

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
    await logEvent(env, 'shared', 'claude_api', 'failure', { error: `${res.status}: ${err.slice(0, 200)}` });
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
    await logEvent(env, 'shared', 'claude_api', 'failure', { error: 'Empty response' });
    throw new Error('Empty response received from Anthropic');
  }
  await logEvent(env, 'shared', 'claude_api', 'success');
  const stripped = fullText.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```\s*$/, '').trim();
  return stripped || fullText;
}

// ────────────────────────────────────────────────────────────
// WHATSAPP — Meta Cloud API
// Two send paths:
//   sendWhatsApp           — immediate. Honours optout + TEST_MODE.
//   queueScheduledMessage  — window-respecting. Sends if in window, else KV-queues.
// processMessageQueue drains queues during cron.
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
 *   — TEST_MODE → redirected to env.WH_PHONE with [TEST→originalNumber] prefix.
 *   — opted_out check via D1 client record (done by caller) or KV optout: key.
 *   — META_WA_TOKEN missing → logs and returns null (non-fatal).
 *
 * @param {string} to        Recipient phone (any SA format)
 * @param {string} message   Text body
 * @param {object} env
 * @param {object} [opts]
 * @param {boolean} [opts.previewUrl=false]   Allow URL previews
 * @param {boolean} [opts.skipTestRedirect]   Bypass TEST_MODE redirect (owner alerts)
 */
export async function sendWhatsApp(to, message, env, opts = {}) {
  if (!env.META_WA_TOKEN || !env.META_PHONE_NUMBER_ID) {
    console.warn('Meta WhatsApp not configured — skipping:', String(message).slice(0, 60));
    return null;
  }

  const toIntl = normaliseSaPhone(to);
  if (!toIntl) return null;

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

  // KV optout check (legacy opt-out flags — new opts stored in D1 clients.opted_out)
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
      await logEvent(env, 'shared', 'whatsapp_send', 'failure', {
        error: data?.error?.message || `HTTP ${res.status}`,
      });
    } else {
      await logEvent(env, 'shared', 'whatsapp_send', 'success');
    }
    return data;
  } catch (e) {
    console.warn('Meta WhatsApp fetch error:', e?.message || e);
    await logEvent(env, 'shared', 'whatsapp_send', 'failure', { error: e?.message || 'fetch failed' });
    return null;
  }
}

/**
 * Returns true if NOW is within the send window in SAST.
 */
export function isInSendWindow(opts = {}) {
  const { respectDayOfWeek = true } = opts;
  const sast = new Date(Date.now() + SAST_OFFSET_MS);
  const hour = sast.getUTCHours();
  const day  = sast.getUTCDay();
  return (hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour)
    && (!respectDayOfWeek || SEND_WINDOW.days.includes(day));
}

/**
 * Queues a WhatsApp message for delivery within the send window.
 * If already in window, sends immediately.
 * Otherwise stores in KV at msg_queue:{ts}:{phoneSuffix} with 7-day TTL.
 *
 * @param {string}  clientId     D1 client UUID (replaces legacy airtableId)
 * @param {string}  phone
 * @param {string}  message
 * @param {object}  env
 * @param {object}  [options]
 * @param {boolean} [options.respectDayOfWeek=true]
 * @param {string|null} [options.scheduledFor]  ISO datetime for future delivery
 */
export async function queueScheduledMessage(clientId, phone, message, env, options = {}) {
  const { respectDayOfWeek = true, scheduledFor = null } = options;
  const now        = Date.now();
  const targetTime = scheduledFor ? new Date(scheduledFor).getTime() : now;

  if (targetTime > now) {
    const queueKey = `msg_queue:${targetTime}:${String(phone).slice(-6)}:${Date.now().toString(36)}`;
    await env.SITES.put(
      queueKey,
      JSON.stringify({ clientId, phone, message, respectDayOfWeek, scheduledFor: new Date(targetTime).toISOString(), queuedAt: new Date(now).toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 7 },
    ).catch(() => sendWhatsApp(phone, message, env));
    return null;
  }

  if (isInSendWindow({ respectDayOfWeek })) {
    return sendWhatsApp(phone, message, env);
  }

  const queueKey = `msg_queue:${now}:${String(phone).slice(-6)}:${Date.now().toString(36)}`;
  await env.SITES.put(
    queueKey,
    JSON.stringify({ clientId, phone, message, respectDayOfWeek, queuedAt: new Date().toISOString() }),
    { expirationTtl: 60 * 60 * 24 * 7 },
  ).catch(() => sendWhatsApp(phone, message, env));
  return null;
}

/**
 * Drains KV message queue if we're in window.
 * Called from pulse-worker every cron tick.
 */
export async function processMessageQueue(env) {
  if (!isInSendWindow({ respectDayOfWeek: true })) return;

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
      const item = JSON.parse(raw);

      if (item.scheduledFor && new Date(item.scheduledFor).getTime() > now) continue;

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
// EMAIL — Resend API
// Sends from hello@websitehub.co.za. Tags every email with
// client slug and touchpoint for Resend dashboard filtering.
// TEST_MODE: logs payload to KV, no real send.
// ────────────────────────────────────────────────────────────

/**
 * Sends a transactional email via Resend.
 *
 * @param {object} args
 * @param {string}      args.to          Recipient email address
 * @param {string}      args.subject     Email subject line
 * @param {string}      args.html        HTML body
 * @param {string}      [args.text]      Plain-text fallback (auto-stripped if omitted)
 * @param {string}      [args.clientSlug] Used for Resend tagging
 * @param {string}      [args.touchpoint] Used for Resend tagging (e.g. 'go_live')
 * @param {object}      env
 * @returns {object|null}
 */
export async function sendEmail(args, env) {
  const { to, subject, html, text, clientSlug, touchpoint } = args;

  if (!to || !subject || !html) {
    console.warn('sendEmail: missing required fields (to, subject, html)');
    return null;
  }

  if (isTestMode(env)) {
    const key = `test_log:email:${Date.now()}:${touchpoint || 'unknown'}`;
    await env.SITES.put(
      key,
      JSON.stringify({ to, subject, clientSlug, touchpoint, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    console.log(`[TEST] Email logged: ${subject} → ${to}`);
    return { id: 'test_mode', test_mode: true };
  }

  if (!env.RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not configured — skipping email');
    return null;
  }

  try {
    const payload = {
      from: 'Website Hub <hello@websitehub.co.za>',
      to:   [to],
      subject,
      html,
      ...(text ? { text } : {}),
      tags: [
        ...(clientSlug  ? [{ name: 'client',     value: clientSlug  }] : []),
        ...(touchpoint  ? [{ name: 'touchpoint',  value: touchpoint  }] : []),
      ],
    };

    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      console.warn('Resend error:', JSON.stringify(data));
      await logEvent(env, 'shared', 'email_send', 'failure', {
        error: data?.message || `HTTP ${res.status}`,
        metadata: { to, subject, touchpoint },
      });
      return null;
    }
    await logEvent(env, 'shared', 'email_send', 'success', {
      metadata: { to, touchpoint, resend_id: data.id },
    });
    return data;
  } catch (e) {
    console.warn('Resend fetch error:', e?.message || e);
    await logEvent(env, 'shared', 'email_send', 'failure', { error: e?.message || 'fetch failed' });
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// ZOHO BOOKS — invoice + credit note (invoicing only)
// Email provisioning moved to RegisterDomain.co.za.
// TEST_MODE: API calls skipped; payloads logged to KV.
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
        await sendWhatsApp(
          env.WH_PHONE,
          `🔐 ZOHO AUTH EXPIRED — invoicing is down. Re-run /zoho-auth to fix.\nError: ${reason}`,
          env,
          { skipTestRedirect: true },
        ).catch(() => {});
      }
      await logEvent(env, 'shared', 'zoho_auth', 'failure', { error: reason });
      return null;
    }
    await logEvent(env, 'shared', 'zoho_auth', 'success');
    return data.access_token;
  } catch (e) {
    await logEvent(env, 'shared', 'zoho_auth', 'failure', { error: e?.message || 'token fetch failed' });
    return null;
  }
}

/**
 * Creates a Zoho invoice (or in TEST_MODE, logs to KV).
 *
 * @param {object} args
 * @param {string}  args.clientName
 * @param {string}  args.email
 * @param {number}  args.amount
 * @param {string}  args.description
 * @param {string}  args.invoiceNum
 * @param {boolean} [args.markPaid=false]
 * @param {string}  [args.payLink='']
 * @param {object}  env
 */
export async function createZohoInvoice(args, env) {
  const { clientName, email, amount, description, invoiceNum, markPaid = false, payLink = '' } = args;

  if (isTestMode(env)) {
    const key = `test_log:zoho:invoice:${Date.now()}:${invoiceNum}`;
    await env.SITES.put(
      key,
      JSON.stringify({ clientName, email, amount, description, invoiceNum, markPaid, payLink, ts: new Date().toISOString() }),
      { expirationTtl: 60 * 60 * 24 * 30 },
    ).catch(() => {});
    await logEvent(env, 'shared', 'zoho_invoice', 'success', { metadata: { invoiceNum, amount, clientName, test_mode: true } });
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
    await logEvent(env, 'shared', 'zoho_invoice', 'success', { metadata: { invoiceNum, amount } });
    return invoiceData?.invoice || null;
  } catch (e) {
    console.warn('Zoho invoice create failed:', e?.message || e);
    await logEvent(env, 'shared', 'zoho_invoice', 'failure', { error: e?.message || 'invoice create failed' });
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
    await logEvent(env, 'shared', 'zoho_credit', 'success', { metadata: { creditNum, amount, clientName, test_mode: true } });
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
    const creditRes = await fetch(
      `https://books.zoho.com/api/v3/creditnotes?organization_id=${orgId}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          customer_id:       contactId,
          creditnote_number: creditNum,
          date:              todayDateString(),
          line_items: [{ description, quantity: 1, rate: amount }],
        }),
      },
    );
    const creditData = await creditRes.json();
    await logEvent(env, 'shared', 'zoho_credit', 'success', { metadata: { creditNum, amount } });
    return creditData?.creditnote || null;
  } catch (e) {
    console.warn('Zoho credit note failed:', e?.message || e);
    await logEvent(env, 'shared', 'zoho_credit', 'failure', { error: e?.message || 'credit note failed' });
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// D1 — CLIENT CRUD
// All client state lives here. No Airtable calls anywhere.
// ────────────────────────────────────────────────────────────

/**
 * Creates a new client row in D1.
 * Generates UUID and slug automatically.
 * @param {object} env
 * @param {object} fields  Intake form fields matching the clients schema
 * @returns {{ id: string, slug: string }}
 */
export async function createClient(env, fields) {
  const id = crypto.randomUUID();
  const manage_token = crypto.randomUUID();
  let slug = slugify(fields.business_name);
  const exists = await env.DB.prepare('SELECT id FROM clients WHERE slug = ? LIMIT 1').bind(slug).first().catch(() => null);
  if (exists) slug = slug + '-' + Date.now().toString(36).slice(-4);
  const svc = typeof fields.services === 'string' ? fields.services : JSON.stringify(fields.services || []);
  const insertResult = await env.DB.prepare(`INSERT INTO clients (id,slug,manage_token,business_name,client_name,phone,email,industry,area,vibe,services,primary_cta,target_audience,about,differentiator,testimonial,instagram,facebook,tiktok,referral_code_used,status,source,package,retainer) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,slug,manage_token,fields.business_name||'',fields.client_name||'',fields.phone||'',fields.email||'',fields.industry||'',fields.area||'',fields.vibe||'bold_confident',svc,fields.primary_cta||'whatsapp_us',fields.target_audience||'everyone',fields.about||'',fields.differentiator||'',fields.testimonial||'',fields.instagram||'',fields.facebook||'',fields.tiktok||'',fields.referral_code_used||'',fields.status||'lead',fields.source||'website',fields.package||'standard',fields.retainer||999).first();
  if (!insertResult && insertResult !== null) throw new Error('createClient INSERT failed');
  return { id, slug, manage_token };
}
export async function getClientById(env, id) {
  return await env.DB.prepare(
    `SELECT * FROM clients WHERE id = ?`
  ).bind(id).first();
}

export async function getClientBySlug(env, slug) {
  return await env.DB.prepare(
    `SELECT * FROM clients WHERE slug = ?`
  ).bind(slug).first();
}

export async function getClientByPhone(env, phone) {
  return await env.DB.prepare(
    `SELECT * FROM clients WHERE phone = ?`
  ).bind(phone).first();
}

export async function getClientByToken(env, token) {
  return await env.DB.prepare(
    `SELECT * FROM clients WHERE manage_token = ?`
  ).bind(token).first();
}

export async function getClientByDomain(env, domain) {
  return await env.DB.prepare(
    `SELECT * FROM clients WHERE domain = ?`
  ).bind(domain).first();
}

/**
 * Updates one or more fields on a client row.
 * Always sets updated_at to now.
 */
export async function updateClient(env, id, fields) {
  const toUpdate = { ...fields, updated_at: new Date().toISOString() };
  const sets = Object.keys(toUpdate).map(k => `${k} = ?`).join(', ');
  await env.DB.prepare(
    `UPDATE clients SET ${sets} WHERE id = ?`
  ).bind(...Object.values(toUpdate), id).run();
}

/**
 * Runs a raw D1 query and returns all matching rows.
 * For complex pulse-worker queries — dunning, post-golive, win-back.
 */
export async function queryClients(env, sql, ...params) {
  return await env.DB.prepare(sql).bind(...params).all();
}

// ────────────────────────────────────────────────────────────
// D1 — MESSAGES
// Every outbound touch logged here. Deduplication via hasMessageBeenSent.
// ────────────────────────────────────────────────────────────

/**
 * Logs a sent message to the messages table.
 * @returns {number} Row ID of the inserted message
 */
export async function logMessage(env, clientId, touchpoint, channel) {
  const result = await env.DB.prepare(
    `INSERT INTO messages (client_id, touchpoint, channel, status, sent_at)
     VALUES (?, ?, ?, 'sent', ?) RETURNING id`
  ).bind(clientId, touchpoint, channel, new Date().toISOString()).first();
  return result?.id;
}

/**
 * Returns true if a message with this touchpoint has already been sent to this client.
 * Primary deduplication guard for all pulse-worker sequences.
 */
export async function hasMessageBeenSent(env, clientId, touchpoint) {
  const row = await env.DB.prepare(
    `SELECT id FROM messages
     WHERE client_id = ? AND touchpoint = ? AND status = 'sent' LIMIT 1`
  ).bind(clientId, touchpoint).first();
  return !!row;
}

// ────────────────────────────────────────────────────────────
// D1 — BUILDS
// ────────────────────────────────────────────────────────────

/**
 * Creates a new build record and returns its ID.
 */
export async function createBuild(env, clientId, fields = {}) {
  const result = await env.DB.prepare(
    `INSERT INTO builds (client_id, template_id, palette, voice_profile, unsplash_queries, status)
     VALUES (?, ?, ?, ?, ?, 'building') RETURNING id`
  ).bind(
    clientId,
    fields.template_id    || null,
    fields.palette        || null,
    fields.voice_profile  ? JSON.stringify(fields.voice_profile)  : null,
    fields.unsplash_queries ? JSON.stringify(fields.unsplash_queries) : null,
  ).first();
  return result?.id;
}

export async function updateBuild(env, buildId, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  await env.DB.prepare(
    `UPDATE builds SET ${sets} WHERE id = ?`
  ).bind(...Object.values(fields), buildId).run();
}

// ────────────────────────────────────────────────────────────
// D1 — REVISIONS
// ────────────────────────────────────────────────────────────

export async function createRevision(env, clientId, type, request) {
  const result = await env.DB.prepare(
    `INSERT INTO revisions (client_id, type, request, status)
     VALUES (?, ?, ?, 'pending') RETURNING id`
  ).bind(clientId, type, request).first();
  return result?.id;
}

export async function updateRevision(env, revisionId, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  await env.DB.prepare(
    `UPDATE revisions SET ${sets} WHERE id = ?`
  ).bind(...Object.values(fields), revisionId).run();
}

// ────────────────────────────────────────────────────────────
// D1 — INVOICES + PAYFAST IDEMPOTENCY
// payfast_payment_id has a UNIQUE constraint — duplicate ITNs
// are naturally blocked at the DB level.
// ────────────────────────────────────────────────────────────

export async function createInvoice(env, clientId, fields) {
  const result = await env.DB.prepare(
    `INSERT INTO invoices (client_id, zoho_invoice_id, payfast_payment_id, amount, type, status, due_date)
     VALUES (?, ?, ?, ?, ?, 'pending', ?) RETURNING id`
  ).bind(
    clientId,
    fields.zoho_invoice_id    || null,
    fields.payfast_payment_id || null,
    fields.amount,
    fields.type,
    fields.due_date           || null,
  ).first();
  return result?.id;
}

/**
 * Returns true if we've already processed this PayFast payment ID.
 * Call this BEFORE processing any PayFast ITN.
 */
export async function isPaymentDuplicate(env, payfastPaymentId) {
  const row = await env.DB.prepare(
    `SELECT id FROM invoices WHERE payfast_payment_id = ? LIMIT 1`
  ).bind(payfastPaymentId).first();
  return !!row;
}

export async function markInvoicePaid(env, payfastPaymentId) {
  await env.DB.prepare(
    `UPDATE invoices SET status = 'paid', paid_at = ? WHERE payfast_payment_id = ?`
  ).bind(new Date().toISOString(), payfastPaymentId).run();
}

// ────────────────────────────────────────────────────────────
// D1 — PHOTOS (self-building Unsplash library)
// ────────────────────────────────────────────────────────────

/**
 * Returns cached photos for a given industry/vibe/slot.
 * Called before hitting Unsplash — serve from library if available.
 */
export async function getPhotosByIndustryVibe(env, industry, vibe, slot, limit = 10) {
  const result = await env.DB.prepare(
    `SELECT * FROM photos WHERE industry = ? AND vibe = ? AND slot = ?
     ORDER BY usage_count DESC LIMIT ?`
  ).bind(industry, vibe, slot, limit).all();
  return result?.results || [];
}

/**
 * Upserts a photo into the library.
 * On conflict (same Unsplash ID), increments usage_count and updates last_used_at.
 */
export async function savePhoto(env, photo) {
  await env.DB.prepare(
    `INSERT INTO photos (unsplash_id, url, thumb_url, query_used, industry, vibe, slot, market)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(unsplash_id) DO UPDATE SET
       usage_count  = usage_count + 1,
       last_used_at = CURRENT_TIMESTAMP`
  ).bind(
    photo.unsplash_id,
    photo.url,
    photo.thumb_url   || null,
    photo.query_used  || null,
    photo.industry    || null,
    photo.vibe        || null,
    photo.slot        || null,
    photo.market      || 'africa',
  ).run();
}

// ────────────────────────────────────────────────────────────
// D1 — VISITS
// Daily page-level counters. Upsert-safe via UNIQUE constraint.
// ────────────────────────────────────────────────────────────

export async function recordVisit(env, clientId, page) {
  const today = todayDateString();
  await env.DB.prepare(
    `INSERT INTO visits (client_id, date, page, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(client_id, date, page) DO UPDATE SET count = count + 1`
  ).bind(clientId, today, page).run();
}

/**
 * Returns per-page visit totals for a given month.
 * @param {string} yearMonth  e.g. '2026-05'
 */
export async function getMonthlyVisits(env, clientId, yearMonth) {
  const result = await env.DB.prepare(
    `SELECT page, SUM(count) as total FROM visits
     WHERE client_id = ? AND date LIKE ? GROUP BY page`
  ).bind(clientId, `${yearMonth}%`).all();
  return result?.results || [];
}

// ────────────────────────────────────────────────────────────
// D1 — GALLERY PHOTOS
// ────────────────────────────────────────────────────────────

export async function addGalleryPhoto(env, clientId, r2Key, url, caption) {
  await env.DB.prepare(
    `INSERT INTO gallery_photos (client_id, r2_key, url, caption)
     VALUES (?, ?, ?, ?)`
  ).bind(clientId, r2Key, url, caption || null).run();
}

export async function getGalleryPhotos(env, clientId) {
  const result = await env.DB.prepare(
    `SELECT * FROM gallery_photos WHERE client_id = ?
     ORDER BY sort_order ASC, uploaded_at DESC`
  ).bind(clientId).all();
  return result?.results || [];
}

// ────────────────────────────────────────────────────────────
// D1 — REFERRALS
// ────────────────────────────────────────────────────────────

export async function createReferral(env, referrerClientId, referredClientId) {
  await env.DB.prepare(
    `INSERT INTO referrals (referrer_client_id, referred_client_id, status)
     VALUES (?, ?, 'pending')`
  ).bind(referrerClientId, referredClientId).run();
}

/**
 * Vests a referral at the 30-day mark.
 * Sets status = 'vested' and records the credit amount for the referrer.
 */
export async function vestReferral(env, referredClientId, creditAmount) {
  await env.DB.prepare(
    `UPDATE referrals SET status = 'vested', vested_at = ?, credit_amount = ?
     WHERE referred_client_id = ? AND status = 'pending'`
  ).bind(new Date().toISOString(), creditAmount, referredClientId).run();
}

// ────────────────────────────────────────────────────────────
// TEMPLATE SYSTEM — archetype detection, KV fetch, token replace
// Used exclusively by build-worker.
// ────────────────────────────────────────────────────────────

/**
 * Maps an industry string to one of the 5 template archetypes.
 * Falls back to 'emergency' — the most conversion-focused template.
 */
export function detectArchetype(industry) {
  const key = (industry || '').toLowerCase().replace(/[^a-z\s]/g, '');
  // Emergency trades — someone needs help NOW
  if (/plumb|electr|locksmith|hvac|geyser|security|pest|tow truck|handyman|appliance|repair|drainage|roofing|waterproof/.test(key))
    return 'emergency';
  // Trust professions — handing over a serious problem
  if (/lawyer|attorney|account|doctor|dentist|physio|financial|architect|consult|audit|tax|notary|insurance|mortgage|broker|therapist|psycholog|optom/.test(key))
    return 'trust';
  // Experience businesses — buying a feeling
  if (/restaurant|salon|spa|barber|nail|hotel|venue|bakery|coffee|cafe|hair|lash|brow|massage|beauty|tattoo|piercing|catering|events|wedding plan|guest house|lodge/.test(key))
    return 'experience';
  // Local community — beat chains on relationship
  if (/hardware|pharmacy|butcher|grocer|creche|dry clean|laundry|florist|nursery|pet shop|bottle store|supermarket|spaza|tuck shop|stationery|fabric|sewing|alterations/.test(key))
    return 'local';
  // Results driven — show the work
  if (/panel|landscap|renovat|contractor|painter|tiler|designer|trainer|gym|fitness|photog|wedding photo|floor|carpet|paving|ceiling|partiti|signage|print|wrap|brand/.test(key))
    return 'results';
  // Sensible default — most unknown trades show results better than emergency
  return 'results';
}

/**
 * Fetches template HTML files from KV for the given archetype and package tier.
 * Falls back to 'emergency' archetype if the requested set isn't loaded.
 *
 * @param {string} archetype  'emergency' | 'trust' | 'experience' | 'local' | 'results'
 * @param {string} pkg        Package key — 'express' | 'standard' | 'premium'
 * @param {object} env
 * @returns {{ css: string, pages: Record<string, string> }}
 */
export async function fetchTemplates(archetype, pkg, env) {
  const pageKeys = {
    express:  ['index'],
    standard: ['index', 'services', 'about', 'contact'],
    premium:  ['index', 'services', 'about', 'contact', 'p5'],
  };

  const tier  = pageKeys[pkg] || pageKeys.standard;
  const css   = await env.SITES.get(`template:${archetype}:css`).catch(() => null) || '';
  const pages = {};

  for (const page of tier) {
    pages[page] = await env.SITES.get(`template:${archetype}:${page}`).catch(() => null);
  }

  if (!pages.index) {
    console.warn(`Templates missing for archetype "${archetype}" — falling back to emergency`);
    if (archetype !== 'emergency') return fetchTemplates('emergency', pkg, env);
    throw new Error('No templates loaded in KV. Run /bootstrap-templates first.');
  }

  return { css, pages };
}

/**
 * Replaces all {{token}} placeholders in an HTML string with values from
 * contentJson and businessFields.
 *
 * @param {string} html
 * @param {object} contentJson    Output from voice extraction Claude call
 * @param {object} businessFields Normalised fields from D1 client record
 * @param {string} ogImage        Resolved Unsplash or R2 image URL
 */
export function tokenReplace(html, contentJson, businessFields, ogImage) {
  const c = contentJson    || {};
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

    // ── Services ──────────────────────────────────────────────
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
    about_section_tag:     c.about_section_tag    || 'Our Story',
    about_headline:        c.about_headline       || '',
    about_pull_quote:      c.about_pull_quote     || '',
    about_p1:              c.about_p1             || '',
    about_p2:              c.about_p2             || '',
    about_p3:              c.about_p3             || '',
    about_philosophy:      c.about_philosophy     || '',
    about_tagline:         c.about_tagline        || '',
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
    credential1:  c.credential1  || '', credential2:  c.credential2  || '',
    credential3:  c.credential3  || '', credential4:  c.credential4  || '',

    // ── Contact ───────────────────────────────────────────────
    contact_section_tag: c.contact_section_tag || 'Get In Touch',
    contact_h2_line1:    c.contact_h2_line1    || 'Get In Touch',
    contact_h2_line2:    c.contact_h2_line2    || '',
    contact_copy:        c.contact_copy        || '',

    // ── Hours ─────────────────────────────────────────────────
    hours_weekday:    b.hours_weekday    || 'Mon–Fri: 8am–5pm',
    hours_saturday:   b.hours_saturday   || 'Saturday: 8am–1pm',
    hours_sunday:     b.hours_sunday     || 'Sunday: Closed',
    hours_monday:     b.hours_weekday    || 'Monday–Friday: 8am–5pm',
    hours_emergency:  c.hours_emergency  || b.hours_emergency || '24/7 for emergencies',

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
    testimonial1_name:         s(c.testimonials,0,'name'),    testimonial1_quote:  s(c.testimonials,0,'quote'),
    testimonial1_result:       s(c.testimonials,0,'result'),  testimonial1_matter: s(c.testimonials,0,'matter'),
    testimonial1_context:      s(c.testimonials,0,'context'),
    testimonial1_name_initial: (s(c.testimonials,0,'name')).charAt(0) || '',

    testimonial2_name:         s(c.testimonials,1,'name'),    testimonial2_quote:  s(c.testimonials,1,'quote'),
    testimonial2_result:       s(c.testimonials,1,'result'),  testimonial2_matter: s(c.testimonials,1,'matter'),
    testimonial2_context:      s(c.testimonials,1,'context'),
    testimonial2_name_initial: (s(c.testimonials,1,'name')).charAt(0) || '',

    testimonial3_name:         s(c.testimonials,2,'name'),    testimonial3_quote:  s(c.testimonials,2,'quote'),
    testimonial3_result:       s(c.testimonials,2,'result'),  testimonial3_matter: s(c.testimonials,2,'matter'),
    testimonial3_context:      s(c.testimonials,2,'context'),
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
    clients_served:        c.clients_served        || '',
    years_active:          c.years_active          || '',
    response_commitment:   c.response_commitment   || '',
    availability_note:     c.availability_note     || '',
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

  // coverage_areas — handle both string and object items
  if (Array.isArray(c.coverage_areas)) {
    for (let i = 0; i < 8; i++) {
      const v = c.coverage_areas[i];
      tokens[`coverage_area${i+1}`] = (typeof v === 'string' ? v : v?.name || v?.area || '') || '';
    }
  }

  // Array fields — normalise each to flat strings
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
 * @param {object} pages  { index, services, about, contact } — all token-replaced
 * @returns {string}      Complete single-scroll HTML
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
