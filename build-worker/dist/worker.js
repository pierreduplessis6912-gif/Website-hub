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
//     PRICING, getPricingTier, buildPayFastLink, sendWhatsApp, createInvoice,
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


// PRICING — locked 2026-06-07. Two products: Hub and Hub Pro.
// Hub = full site, subdomain. Hub Pro = full site, .co.za domain.
// Same build fee. Same features. Domain is the only difference.
// Promo (LAUNCH2026) = Hub at R0 build + R599/mo for launch period.
// All other workers import this; no other file may redefine pricing.
const PRICING = Object.freeze({
  hub:     { build: 7000, retainer: 699,  domain: 'subdomain', label: 'Hub' },
  hub_pro: { build: 7000, retainer: 999,  domain: 'co.za',     label: 'Hub Pro' },
  promo:   { build: 0,    retainer: 599,  domain: 'subdomain', label: 'Hub (Promo)' },
  // Legacy keys — kept for backward compat with existing clients in D1
  express:  { build: 7000, retainer: 699, domain: 'subdomain', label: 'Hub' },
  standard: { build: 7000, retainer: 699, domain: 'subdomain', label: 'Hub' },
  premium:  { build: 7000, retainer: 999, domain: 'co.za',     label: 'Hub Pro' },
  upgrade: {
    hubToHubPro:    300, // R999 - R699
    promoToHubPro:  400, // R999 - R599
  },
  addons: {
    extraEmail: 200,
    revision:   500,
  },
});

// Package capabilities — all plans get the same features.
// Domain is the only differentiator between Hub and Hub Pro.
const PACKAGE_CAPS = Object.freeze({
  hub: {
    pages:              ['index'],
    pass3TokenBudget:   7500,
    emailAccounts:      1,
    gallery:            true,
    referral:           true,
    revisionsPerMonth:  2,
    domain:             'subdomain',
  },
  hub_pro: {
    pages:              ['index'],
    pass3TokenBudget:   7500,
    emailAccounts:      2,
    gallery:            true,
    referral:           true,
    revisionsPerMonth:  5,
    domain:             'co.za',
  },
  promo: {
    pages:              ['index'],
    pass3TokenBudget:   7500,
    emailAccounts:      1,
    gallery:            true,
    referral:           true,
    revisionsPerMonth:  2,
    domain:             'subdomain',
  },
  // Legacy keys
  express:  { pages:['index'], pass3TokenBudget:7500, emailAccounts:1, gallery:true, referral:true, revisionsPerMonth:2, domain:'subdomain' },
  standard: { pages:['index'], pass3TokenBudget:7500, emailAccounts:1, gallery:true, referral:true, revisionsPerMonth:2, domain:'subdomain' },
  premium:  { pages:['index'], pass3TokenBudget:7500, emailAccounts:2, gallery:true, referral:true, revisionsPerMonth:5, domain:'co.za' },
});

// ────────────────────────────────────────────────────────────
// TEST_MODE
// ────────────────────────────────────────────────────────────

/** Single source of truth for sandbox mode. */
function isTestMode(env) {
  return env?.TEST_MODE === 'true' || env?.TEST_MODE === true;
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
async function logHealth(env, service, status, error = null) {
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

// ────────────────────────────────────────────────────────────
// CLAUDE API — model resolution + streaming completion
// ────────────────────────────────────────────────────────────

/**
 * Auto-resolves the latest Sonnet model from Anthropic's /v1/models endpoint.
 * Cached in KV for 24h. On any failure, falls back to the pinned snapshot.
 *
 * To force a re-resolution: delete KV key `system:claude_model`.
 */
async function resolveClaudeModel(env) {
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
async function callClaudeInternal(systemPrompt, messages, env, options = {}) {
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
function normaliseSaPhone(raw) {
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
async function sendWhatsApp(to, message, env, opts = {}) {
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
          number:       finalTo,
          textMessage:  { text: finalMsg },
        }),
      },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('Evolution API error:', JSON.stringify(data));
      // Log to events table since health_log doesn't exist
      await env.DB?.prepare(
        `INSERT INTO events (worker, event_type, status, error, created_at) VALUES ('build','whatsapp_send','error',?,'` + new Date().toISOString() + `')`
      ).bind(`Evolution ${res.status}: ${JSON.stringify(data)}`).run().catch(() => {});
    } else {
      // Success — optionally log
    }
    return data;
  } catch (e) {
    console.warn('Evolution API fetch error:', e?.message || e);
    await logHealth(env, 'whatsapp', 'error', e?.message || 'fetch failed');
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// End of shared-services.js
// ────────────────────────────────────────────────────────────

// ============================================================
// DESIGN DATABASE — replaces INDUSTRY_MATRIX entirely
// Source: ui-ux-pro-max-skill (nextlevelbuilder/ui-ux-pro-max-skill)
// 161 product types × WCAG-compliant palettes × 57 font pairings
// × 99 UX guidelines × 35 landing patterns × 67 UI styles
//
// Usage:
//   const brief = getDesignBrief(client.industry, client.vibe);
//   // Returns: { palette, typography, landingPattern, uxRules, unsplashQuery }
//
// No hardcoded guesses. No archetype routing. Pure data lookup.
// ============================================================

// ── RAW DATA ─────────────────────────────────────────────────
// Loaded at module init. In Cloudflare Workers, import these
// as static assets via wrangler.toml [[assets]] binding,
// or inline the parsed JSON via a build step.
// For now: inline the extracted rows we need.

// Palette data — extracted from colors.csv
// Keys map from our industry fuzzy-match to product row number
const PALETTE_DB = {
  // Row number → { productType, css custom properties }
  5:  { type:'B2B Service',                    primary:'#0F172A', onPrimary:'#FFFFFF', secondary:'#334155', accent:'#0369A1', bg:'#F8FAFC', fg:'#020617', card:'#FFFFFF', muted:'#E8ECF1', mutedFg:'#64748B', border:'#E2E8F0', ring:'#0F172A', notes:'Professional navy + blue CTA' },
  31: { type:'Hyperlocal Services',            primary:'#059669', onPrimary:'#FFFFFF', secondary:'#10B981', accent:'#EA580C', bg:'#ECFDF5', fg:'#064E3B', card:'#FFFFFF', muted:'#E8F1F3', mutedFg:'#64748B', border:'#A7F3D0', ring:'#059669', notes:'Location green + action orange' },
  32: { type:'Beauty/Spa/Wellness',            primary:'#EC4899', onPrimary:'#FFFFFF', secondary:'#F9A8D4', accent:'#8B5CF6', bg:'#FDF2F8', fg:'#831843', card:'#FFFFFF', muted:'#F1EEF5', mutedFg:'#64748B', border:'#FBCFE8', ring:'#EC4899', notes:'Soft pink + lavender luxury' },
  34: { type:'Restaurant/Food',                primary:'#DC2626', onPrimary:'#FFFFFF', secondary:'#F87171', accent:'#A16207', bg:'#FEF2F2', fg:'#450A0A', card:'#FFFFFF', muted:'#F0EDF1', mutedFg:'#64748B', border:'#FECACA', ring:'#DC2626', notes:'Appetizing red + warm gold' },
  35: { type:'Fitness/Gym',                    primary:'#F97316', onPrimary:'#0F172A', secondary:'#FB923C', accent:'#22C55E', bg:'#1F2937', fg:'#F8FAFC', card:'#313742', muted:'#37414F', mutedFg:'#94A3B8', border:'#374151', ring:'#F97316', notes:'Energy orange + success green' },
  36: { type:'Real Estate/Property',           primary:'#0F766E', onPrimary:'#FFFFFF', secondary:'#14B8A6', accent:'#0369A1', bg:'#F0FDFA', fg:'#134E4A', card:'#FFFFFF', muted:'#E8F0F3', mutedFg:'#64748B', border:'#99F6E4', ring:'#0F766E', notes:'Trust teal + professional blue' },
  39: { type:'Wedding/Events',                 primary:'#DB2777', onPrimary:'#FFFFFF', secondary:'#F472B6', accent:'#A16207', bg:'#FDF2F8', fg:'#831843', card:'#FFFFFF', muted:'#F0EDF4', mutedFg:'#64748B', border:'#FBCFE8', ring:'#DB2777', notes:'Romantic pink + elegant gold' },
  40: { type:'Legal Services',                 primary:'#1E3A8A', onPrimary:'#FFFFFF', secondary:'#1E40AF', accent:'#B45309', bg:'#F8FAFC', fg:'#0F172A', card:'#FFFFFF', muted:'#E9EEF5', mutedFg:'#64748B', border:'#CBD5E1', ring:'#1E3A8A', notes:'Authority navy + trust gold' },
  51: { type:'Construction/Architecture',      primary:'#64748B', onPrimary:'#FFFFFF', secondary:'#94A3B8', accent:'#EA580C', bg:'#F8FAFC', fg:'#334155', card:'#FFFFFF', muted:'#EBF0F5', mutedFg:'#64748B', border:'#E2E8F0', ring:'#64748B', notes:'Industrial grey + safety orange' },
  52: { type:'Automotive',                     primary:'#1E293B', onPrimary:'#FFFFFF', secondary:'#334155', accent:'#DC2626', bg:'#F8FAFC', fg:'#0F172A', card:'#FFFFFF', muted:'#E9EDF1', mutedFg:'#64748B', border:'#E2E8F0', ring:'#1E293B', notes:'Premium dark + action red' },
  53: { type:'Photography',                    primary:'#18181B', onPrimary:'#FFFFFF', secondary:'#27272A', accent:'#F8FAFC', bg:'#000000', fg:'#FAFAFA', card:'#0C0C0C', muted:'#181818', mutedFg:'#94A3B8', border:'#3F3F46', ring:'#18181B', notes:'Pure black + white contrast' },
  55: { type:'Home Services (Trades)',         primary:'#1E40AF', onPrimary:'#FFFFFF', secondary:'#3B82F6', accent:'#EA580C', bg:'#EFF6FF', fg:'#1E3A8A', card:'#FFFFFF', muted:'#E9EEF6', mutedFg:'#64748B', border:'#BFDBFE', ring:'#1E40AF', notes:'Professional blue + urgent orange' },
  58: { type:'Medical/Health Clinic',          primary:'#0891B2', onPrimary:'#FFFFFF', secondary:'#22D3EE', accent:'#16A34A', bg:'#F0FDFA', fg:'#134E4A', card:'#FFFFFF', muted:'#E8F1F6', mutedFg:'#64748B', border:'#CCFBF1', ring:'#0891B2', notes:'Medical teal + health green' },
  60: { type:'Dental',                         primary:'#0284C7', onPrimary:'#FFFFFF', secondary:'#38BDF8', accent:'#059669', bg:'#F0F9FF', fg:'#082F49', card:'#FFFFFF', muted:'#E6F1F8', mutedFg:'#64748B', border:'#BAE6FD', ring:'#0284C7', notes:'Sky blue + fresh green' },
  62: { type:'Florist/Garden',                 primary:'#15803D', onPrimary:'#FFFFFF', secondary:'#22C55E', accent:'#EC4899', bg:'#F0FDF4', fg:'#14532D', card:'#FFFFFF', muted:'#E8F0F1', mutedFg:'#64748B', border:'#BBF7D0', ring:'#15803D', notes:'Natural green + floral pink' },
  63: { type:'Bakery/Cafe',                    primary:'#92400E', onPrimary:'#FFFFFF', secondary:'#B45309', accent:'#92400E', bg:'#FEF3C7', fg:'#78350F', card:'#FFFFFF', muted:'#EDEEF0', mutedFg:'#64748B', border:'#FDE68A', ring:'#92400E', notes:'Warm brown + cream' },
  // Default fallback
  0:  { type:'General Service',               primary:'#0F172A', onPrimary:'#FFFFFF', secondary:'#334155', accent:'#0369A1', bg:'#F8FAFC', fg:'#020617', card:'#FFFFFF', muted:'#E8ECF1', mutedFg:'#64748B', border:'#E2E8F0', ring:'#0F172A', notes:'Professional dark + blue' },
};

// Typography pairings — extracted from typography.csv
// Keyed by mood/style for fuzzy matching
const TYPOGRAPHY_DB = [
  { id:1,  name:'Classic Elegant',     heading:'Playfair Display', body:'Inter',          moods:['elegant','luxury','timeless','spa','beauty','premium'],          import:"@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:wght@400;500;600;700&display=swap');" },
  { id:2,  name:'Modern Professional', heading:'Poppins',           body:'Open Sans',      moods:['modern','professional','service','clean','corporate'],            import:"@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap');" },
  { id:4,  name:'Editorial Classic',   heading:'Cormorant Garamond',body:'Libre Baskerville',moods:['editorial','classic','legal','traditional','authority'],        import:"@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Libre+Baskerville:wght@400;700&display=swap');" },
  { id:6,  name:'Playful Creative',    heading:'Fredoka',           body:'Nunito',         moods:['playful','friendly','childcare','kids','casual'],                 import:"@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@300;400;500;600;700&display=swap');" },
  { id:7,  name:'Bold Statement',      heading:'Bebas Neue',        body:'Source Sans 3',  moods:['bold','impactful','dramatic','trades','construction','automotive','gym'],import:"@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Source+Sans+3:wght@300;400;500;600;700&display=swap');" },
  { id:8,  name:'Wellness Calm',       heading:'Lora',              body:'Raleway',        moods:['calm','wellness','relaxing','medical','health','gentle'],         import:"@import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&family=Raleway:wght@300;400;500;600;700&display=swap');" },
  { id:11, name:'Geometric Modern',    heading:'Outfit',            body:'Work Sans',      moods:['geometric','modern','balanced','startup','tech'],                 import:"@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Work+Sans:wght@300;400;500;600;700&display=swap');" },
  { id:12, name:'Luxury Serif',        heading:'Cormorant',         body:'Montserrat',     moods:['luxury','high-end','elegant','realestate','photography','legal'], import:"@import url('https://fonts.googleapis.com/css2?family=Cormorant:wght@400;500;600;700&family=Montserrat:wght@300;400;500;600;700&display=swap');" },
  { id:14, name:'News Editorial',      heading:'Newsreader',        body:'Roboto',         moods:['news','editorial','trustworthy','information','clear'],           import:"@import url('https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500;600;700&family=Roboto:wght@300;400;500;700&display=swap');" },
  { id:16, name:'Corporate Trust',     heading:'Lexend',            body:'Source Sans 3',  moods:['corporate','trustworthy','readable','professional','financial'],  import:"@import url('https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&family=Source+Sans+3:wght@300;400;500;600;700&display=swap');" },
  { id:18, name:'Fashion Forward',     heading:'Syne',              body:'Manrope',        moods:['fashion','avant-garde','bold','editorial','dark','modern'],       import:"@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&family=Syne:wght@400;500;600;700;800&display=swap');" },
  { id:10, name:'Retro Warm',          heading:'Abril Fatface',     body:'Merriweather',   moods:['retro','vintage','warm','food','cafe','bakery','artisan'],       import:"@import url('https://fonts.googleapis.com/css2?family=Abril+Fatface&family=Merriweather:wght@300;400;700&display=swap');" },
];


// ============================================================
// PERSONALITY PROFILE SYSTEM
// 13 categories → layout genome → renderer driver
// industry → personality → composition intelligence
// ============================================================

// ── INDUSTRY → PERSONALITY MAPPING ───────────────────────────
const INDUSTRY_PERSONALITY = {
  // Trade Authority
  plumbing:'trade_authority', electrical:'trade_authority', aircon:'trade_authority',
  handyman:'trade_authority', carpentry:'trade_authority', roofing:'trade_authority',
  waterproofing:'trade_authority', welding:'trade_authority', plastering:'trade_authority',
  appliance_repair:'trade_authority', pest_control:'trade_authority',
  signage:'trade_authority', cctv:'trade_authority',

  // Transformation
  flooring:'transformation', renovation:'transformation', panel_beater:'transformation',
  landscaping:'transformation', garden:'transformation', florist:'transformation',
  painting:'transformation',

  // Personal Care
  hair_salon:'personal_care', barber:'personal_care', nails:'personal_care',
  spa:'personal_care', lashes:'personal_care', makeup:'personal_care',

  // Wellness
  gym:'wellness', personal_trainer:'wellness', yoga:'wellness',

  // Hospitality
  restaurant:'hospitality', cafe:'hospitality', bakery:'hospitality',
  catering:'hospitality', street_food:'hospitality', chicken_shop:'hospitality',
  shisa_nyama:'hospitality',

  // Community Local
  childcare:'community_local', tutoring:'community_local',
  cleaning:'community_local', laundry:'community_local',
  optometrist:'medical_health', vet:'medical_health', driving_school:'community_local',
  tattoo:'beauty_wellness', tiling:'trade_authority', glazier:'trade_authority',
  furniture:'trade_authority', butchery:'food_beverage',

  // Professional Trust
  legal:'professional_trust', accounting:'professional_trust', property:'professional_trust',
  crypto:'professional_trust', ai_consulting:'professional_trust',

  // Technical Expertise
  it_support:'technical_expertise', social_media:'technical_expertise',
  graphic_design:'technical_expertise', security:'technical_expertise',

  // Retail Utility
  spaza:'retail_utility', hardware:'retail_utility', bottle_store:'retail_utility',

  // Event & Creative
  wedding:'event_creative', photography:'event_creative',
  dj:'event_creative', events:'event_creative',

  // Mobility
  transport:'mobility', kombi:'mobility', bakkie_hire:'mobility',

  // Medical Trust
  medical:'medical_trust', dental:'medical_trust', pharmacy:'medical_trust', physio:'medical_trust',

  // Memorial & Legacy
  funeral:'memorial_legacy',

  // Default
  general:'trade_authority',
};

// ── PERSONALITY GENOME LIBRARY ────────────────────────────────
// Each category defines the full composition intelligence
// Hero archetypes, opening strategies, spacing, typography, density
const PERSONALITY_GENOMES = {

  trade_authority: {
    label: 'Trade Authority',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['proof_first','local_hero'],
    typography_mode: 'bold_statement',
    spacing_rhythm: 'compact',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 55,
    typography_id: 7,
    trust_signals: true,
    image_treatment: { bg_position:'center 30%', hero_height:'90svh', scrim:'heavy_bottom' },
  },

  transformation: {
    label: 'Transformation',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['before_after','proof_first'],
    typography_mode: 'bold_statement',
    spacing_rhythm: 'airy',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'medium',
    surface_style: 'matte_dark',
    cta_style: 'visual_proof',
    section_flow: 'story_first',
    palette_row: 51,
    typography_id: 7,
    trust_signals: true,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'cinematic' },
  },

  personal_care: {
    label: 'Personal Care',
    hero_layouts: ['cinematic_left','quiet_premium'],
    opening_strategies: ['emotional_story','local_hero'],
    typography_mode: 'classic_elegant',
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'soft',
    surface_style: 'warm_dark',
    cta_style: 'inviting',
    section_flow: 'story_first',
    palette_row: 32,
    typography_id: 1,
    trust_signals: false,
    image_treatment: { bg_position:'center top', hero_height:'100svh', scrim:'soft_bottom' },
  },

  wellness: {
    label: 'Wellness',
    hero_layouts: ['quiet_premium','cinematic_left'],
    opening_strategies: ['emotional_story','manifesto'],
    typography_mode: 'bold_statement',
    spacing_rhythm: 'airy',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'matte_dark',
    cta_style: 'motivational',
    section_flow: 'emotion_first',
    palette_row: 35,
    typography_id: 7,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'95svh', scrim:'heavy_bottom' },
  },

  hospitality: {
    label: 'Hospitality',
    hero_layouts: ['cinematic_left','quiet_premium'],
    opening_strategies: ['emotional_story','direct_offer'],
    typography_mode: 'retro_warm',
    spacing_rhythm: 'airy',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'warm',
    surface_style: 'warm_dark',
    cta_style: 'appetite',
    section_flow: 'emotion_first',
    palette_row: 34,
    typography_id: 10,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'warm_bottom' },
  },

  community_local: {
    label: 'Community Local',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['local_hero','emotional_story'],
    typography_mode: 'modern_professional',
    spacing_rhythm: 'airy',
    card_density: 'medium',
    alignment_bias: 'left',
    visual_energy: 'soft',
    surface_style: 'warm_dark',
    cta_style: 'friendly',
    section_flow: 'story_first',
    palette_row: 31,
    typography_id: 2,
    trust_signals: false,
    image_treatment: { bg_position:'center top', hero_height:'90svh', scrim:'soft_bottom' },
  },

  professional_trust: {
    label: 'Professional Trust',
    hero_layouts: ['quiet_premium','trade_authority'],
    opening_strategies: ['proof_first','local_hero'],
    typography_mode: 'luxury_serif',
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'restrained',
    surface_style: 'deep_dark',
    cta_style: 'minimal',
    section_flow: 'proof_first',
    palette_row: 40,
    typography_id: 12,
    trust_signals: true,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'minimal' },
  },

  technical_expertise: {
    label: 'Technical Expertise',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['proof_first','direct_offer'],
    typography_mode: 'geometric_modern',
    spacing_rhythm: 'compact',
    card_density: 'medium',
    alignment_bias: 'left',
    visual_energy: 'medium',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 5,
    typography_id: 11,
    trust_signals: true,
    image_treatment: { bg_position:'center', hero_height:'88svh', scrim:'heavy_bottom' },
  },

  retail_utility: {
    label: 'Retail Utility',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['direct_offer','local_hero'],
    typography_mode: 'modern_professional',
    spacing_rhythm: 'compact',
    card_density: 'medium',
    alignment_bias: 'left',
    visual_energy: 'medium',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 31,
    typography_id: 2,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'80svh', scrim:'heavy_bottom' },
  },

  event_creative: {
    label: 'Event & Creative',
    hero_layouts: ['cinematic_left','quiet_premium'],
    opening_strategies: ['emotional_story','manifesto'],
    typography_mode: 'fashion_forward',
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'deep_dark',
    cta_style: 'experiential',
    section_flow: 'emotion_first',
    palette_row: 39,
    typography_id: 18,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'cinematic' },
  },

  mobility: {
    label: 'Mobility',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['direct_offer','local_hero'],
    typography_mode: 'bold_statement',
    spacing_rhythm: 'compact',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 52,
    typography_id: 7,
    trust_signals: true,
    image_treatment: { bg_position:'center 40%', hero_height:'88svh', scrim:'heavy_bottom' },
  },

  medical_trust: {
    label: 'Medical Trust',
    hero_layouts: ['quiet_premium','trade_authority'],
    opening_strategies: ['proof_first','emotional_story'],
    typography_mode: 'wellness_calm',
    spacing_rhythm: 'dramatic',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'restrained',
    surface_style: 'clean_dark',
    cta_style: 'reassuring',
    section_flow: 'proof_first',
    palette_row: 58,
    typography_id: 8,
    trust_signals: true,
    image_treatment: { bg_position:'center top', hero_height:'100svh', scrim:'minimal' },
  },

  memorial_legacy: {
    label: 'Memorial & Legacy',
    hero_layouts: ['quiet_premium','cinematic_left'],
    opening_strategies: ['emotional_story','local_hero'],
    typography_mode: 'editorial_classic',
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'restrained',
    surface_style: 'deep_dark',
    cta_style: 'minimal',
    section_flow: 'story_first',
    palette_row: 5,
    typography_id: 4,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'minimal' },
  },
};

// ── PERSONALITY RESOLUTION ────────────────────────────────────
function getPersonality(industryKey) {
  const category = INDUSTRY_PERSONALITY[industryKey] || 'trade_authority';
  return {
    category,
    ...PERSONALITY_GENOMES[category],
  };
}

// ── TYPOGRAPHY BY ID ──────────────────────────────────────────
function getTypographyById$1(id) {
  return TYPOGRAPHY_DB.find(t => t.id === id) || TYPOGRAPHY_DB[1];
}

// ── LANDING PATTERN SELECTION ─────────────────────────────────
// Always returns "Scroll-Triggered Storytelling" for Website Hub.
// This is locked in the spec. The data confirms it's the right pattern
// for service businesses: "Narrative increases time-on-page 3x."

function getLandingPattern() {
  return {
    id: 10,
    name: 'Scroll-Triggered Storytelling',
    sectionOrder: ['hero', 'about', 'services', 'why-us', 'testimonial', 'contact'],
    ctaPlacement: 'End of each chapter + Final climax CTA',
    colorStrategy: 'Progressive reveal. Each section distinct visual weight.',
    mobileNote: 'Simplify animations on mobile. Progress indicator optional.',
  };
}

// ── UX RULES — mobile-critical subset ────────────────────────
// Extracted from ux-guidelines.csv — rows most critical for
// mobile-first single-page SA business sites.

const UX_RULES = [
  { id:1,  rule:'Smooth scroll',      do:'html { scroll-behavior: smooth; }',                               dont:'Anchor jump without transition' },
  { id:20, rule:'Viewport units',     do:'Use 100svh or dvh for full-height sections',                      dont:'Use 100vh — breaks on mobile browsers' },
  { id:22, rule:'Touch targets',      do:'Minimum 44×44px for all tappable elements',                       dont:'Small buttons or links' },
  { id:23, rule:'Touch spacing',      do:'Minimum 8px gap between touch targets',                           dont:'Tightly packed tappable elements' },
  { id:36, rule:'Colour contrast',    do:'Minimum 4.5:1 ratio for normal text, 3:1 for large text',         dont:'Low contrast text on any background' },
  { id:16, rule:'Overflow hidden',    do:'Test all content fits within overflow:hidden containers',          dont:'Blindly apply overflow:hidden' },
];

// ── MAIN EXPORT ───────────────────────────────────────────────

/**
 * getDesignBrief — personality-driven design system
 * Routes industry → personality category → genome → palette + typography
 *
 * @param {string} industry  e.g. "flooring", "hair_salon", "plumbing"
 * @param {string} vibe      optional override (legacy support)
 * @returns {object} Complete design brief for build pipeline
 */
function getDesignBrief(industry, vibe) {
  // Resolve personality from industry key
  const industryKey = normaliseIndustryKey(industry);
  const personality = getPersonality(industryKey);

  // Get palette from personality's preferred row
  const palette     = PALETTE_DB[personality.palette_row] || PALETTE_DB[0];

  // Get typography from personality's preferred id
  const typo        = getTypographyById$1(personality.typography_id);
  const landing     = getLandingPattern();

  return {
    palette: {
      primary:    palette.primary,
      onPrimary:  palette.onPrimary,
      secondary:  palette.secondary,
      accent:     palette.accent,
      bg:         palette.bg,
      fg:         palette.fg,
      card:       palette.card,
      muted:      palette.muted,
      mutedFg:    palette.mutedFg,
      border:     palette.border,
      ring:       palette.ring,
      notes:      palette.notes,
    },
    typography: {
      heading:    typo.heading,
      body:       typo.body,
      name:       typo.name,
      cssImport:  typo.import,
    },
    // Full personality genome — drives renderer
    personality,
    landing,
    uxRules: UX_RULES,
    unsplashQuery: buildUnsplashQuery(industry, vibe),
    _source:       `personality:${personality.category} palette:${personality.palette_row}`,
    industryKey,
  };
}

// ── INDUSTRY KEY NORMALISER ───────────────────────────────────
// Converts free-text industry to a normalised key
function normaliseIndustryKey(industry) {
  if (!industry) return 'general';
  const k = industry.toLowerCase().replace(/[^a-z\s_]/g, '').trim();

  if (/plumb/.test(k))                    return 'plumbing';
  if (/electr/.test(k))                   return 'electrical';
  if (/aircon|hvac|air.con/.test(k))      return 'aircon';
  if (/handyman/.test(k))                 return 'handyman';
  if (/carpent|joinery/.test(k))          return 'carpentry';
  if (/paint(?!er.*photo)/.test(k))       return 'painting';
  if (/roof/.test(k))                     return 'roofing';
  if (/waterproof/.test(k))               return 'waterproofing';
  if (/pest|exterminat/.test(k))          return 'pest_control';
  if (/appliance|whitegoods/.test(k))     return 'appliance_repair';
  if (/floor|carpet|vinyl|laminate/.test(k)) return 'flooring';
  if (/hair.*salon|salon|hairdress/.test(k)) return 'hair_salon';
  if (/barber/.test(k))                   return 'barber';
  if (/nail/.test(k))                     return 'nails';
  if (/spa|massage/.test(k))              return 'spa';
  if (/lash/.test(k))                     return 'lashes';
  if (/makeup|make.up|cosmetic/.test(k))  return 'makeup';
  if (/restaurant|diner/.test(k))         return 'restaurant';
  if (/cater/.test(k))                    return 'catering';
  if (/baker/.test(k))                    return 'bakery';
  if (/cafe|coffee/.test(k))              return 'cafe';
  if (/street.food|food.stall/.test(k))   return 'street_food';
  if (/chicken|kfc|chick/.test(k))        return 'chicken_shop';
  if (/shisa|nyama|braai/.test(k))        return 'shisa_nyama';
  if (/gym|fitness/.test(k))             return 'gym';
  if (/personal.train/.test(k))           return 'personal_trainer';
  if (/yoga|pilates/.test(k))             return 'yoga';
  if (/mechanic|auto.repair/.test(k))     return 'mechanic';
  if (/panel|body.shop/.test(k))          return 'panel_beater';
  if (/tyre|tire/.test(k))               return 'tyres';
  if (/carwash|car.wash/.test(k))         return 'carwash';
  if (/bakkie.hire|truck.hire/.test(k))   return 'bakkie_hire';
  if (/construct|build/.test(k))          return 'construction';
  if (/renovat/.test(k))                  return 'renovation';
  if (/plaster/.test(k))                  return 'plastering';
  if (/weld/.test(k))                     return 'welding';
  if (/sign/.test(k))                     return 'signage';
  if (/cctv|camera/.test(k))              return 'cctv';
  if (/clean|maid|domestic/.test(k))      return 'cleaning';
  if (/laundry/.test(k))                  return 'laundry';
  if (/medical|doctor|clinic/.test(k))    return 'medical';
  if (/pharm/.test(k))                    return 'pharmacy';
  if (/physio/.test(k))                   return 'physio';
  if (/dental|dentist/.test(k))           return 'dental';
  if (/property|estate.agent|realtor/.test(k)) return 'property';
  if (/legal|law|attorney|advocate/.test(k))   return 'legal';
  if (/account|bookkeep/.test(k))         return 'accounting';
  if (/crypto|blockchain/.test(k))        return 'crypto';
  if (/it.support|tech.support/.test(k))  return 'it_support';
  if (/social.media/.test(k))             return 'social_media';
  if (/graphic|design/.test(k))           return 'graphic_design';
  if (/securi/.test(k))                   return 'security';
  if (/spaza|tuck.shop/.test(k))          return 'spaza';
  if (/hardware/.test(k))                 return 'hardware';
  if (/bottle.store|liquor/.test(k))      return 'bottle_store';
  if (/wedding/.test(k))                  return 'wedding';
  if (/photo/.test(k))                    return 'photography';
  if (/\bdj\b|disc.jockey/.test(k))       return 'dj';
  if (/event/.test(k))                    return 'events';
  if (/transport|logistics/.test(k))      return 'transport';
  if (/kombi|minibus/.test(k))            return 'kombi';
  if (/landscap/.test(k))                 return 'landscaping';
  if (/garden|nursery/.test(k))           return 'garden';
  if (/florist|flower/.test(k))           return 'florist';
  if (/childcare|creche|daycare/.test(k)) return 'childcare';
  if (/tutor|teach|educat/.test(k))       return 'tutoring';
  if (/funeral/.test(k))                  return 'funeral';
  if (/ai.consult/.test(k))               return 'ai_consulting';

  // ── INTAKE LIST ADDITIONS ─────────────────────────────────
  if (/optom|optical|eye.care|eyewear/.test(k))  return 'optometrist';
  if (/vet(?:erinarian)?|animal.clinic|pet.care/.test(k)) return 'vet';
  if (/driving.school|drive.school/.test(k))     return 'driving_school';
  if (/tattoo|piercing/.test(k))                 return 'tattoo';
  if (/makeup.artist/.test(k))                   return 'makeup';
  if (/event.venue|venue/.test(k))               return 'events';
  if (/wedding.plan/.test(k))                    return 'wedding';
  if (/furniture/.test(k))                       return 'furniture';
  if (/butch/.test(k))                           return 'butchery';
  if (/food.truck/.test(k))                      return 'street_food';
  if (/pool.service|pool.clean/.test(k))         return 'cleaning';
  if (/tiler|tiling/.test(k))                    return 'tiling';
  if (/glazier|glass/.test(k))                   return 'glazier';
  if (/financial.advis|wealth/.test(k))          return 'accounting';
  if (/videograph/.test(k))                      return 'photography';
  if (/web.dev|web.design/.test(k))              return 'it_support';
  if (/courier|deliver/.test(k))                 return 'transport';

  return 'general';
}

// ── UNSPLASH KEYWORD QUERY BUILDER ───────────────────────────
// No collections. Full Unsplash archive keyword search only.
// Query is derived from: industry keyword + vibe modifier + palette mood.
// Substance build Pass 1 generates its own richer query from full card data —
// this function serves the pre-build and as a fallback.

const VIBE_MODIFIERS = {
  bold:         'dramatic powerful confident',
  warm:         'warm inviting natural light',
  professional: 'professional clean modern',
  playful:      'bright vibrant energetic',
  luxury:       'luxury premium elegant',
  minimal:      'minimal clean simple',
};

const INDUSTRY_PHOTO_TERMS = {
  plumb:        'plumber pipes professional trade',
  electr:       'electrician wiring professional trade',
  hvac:         'hvac technician professional',
  handyman:     'handyman tools professional repair',
  beauty:       'beauty salon interior professional',
  hair:         'hair salon stylist professional',
  nail:         'nail salon beauty professional',
  spa:          'spa wellness interior calm',
  restaurant:   'restaurant interior food professional',
  food:         'food catering professional kitchen',
  cafe:         'cafe coffee interior warm',
  bakery:       'bakery pastry interior warm',
  fitness:      'gym fitness training professional',
  gym:          'gym weights fitness professional',
  yoga:         'yoga studio calm wellness',
  property:     'real estate property modern interior',
  estate:       'real estate property professional',
  legal:        'law office professional authority',
  attorney:     'attorney law professional',
  construct:    'construction site building professional',
  build:        'builder construction professional site',
  flooring:     'flooring installation craftsman professional',
  tile:         'tiling installation professional craftsman',
  renovate:     'renovation interior professional',
  auto:         'automotive workshop professional mechanic',
  mechanic:     'mechanic workshop car professional',
  panel:        'panel beater workshop professional',
  medical:      'medical clinic professional clean',
  doctor:       'doctor clinic professional health',
  dental:       'dental clinic professional clean',
  clean:        'cleaning professional service spotless',
  domestic:     'cleaning service professional home',
  photo:        'photographer studio professional creative',
  florist:      'florist flowers professional shop',
  garden:       'garden nursery plants professional',
  event:        'event venue professional setup',
  wedding:      'wedding venue professional elegant',
  transport:    'transport logistics professional driver',
  tutor:        'education tutoring professional classroom',
};

function buildUnsplashQuery(industry, vibe, palette) {
  const k = (industry || '').toLowerCase();

  // Find the most specific industry photo term
  let industryTerm = 'professional service business south africa';
  for (const [fragment, term] of Object.entries(INDUSTRY_PHOTO_TERMS)) {
    if (k.includes(fragment)) { industryTerm = term; break; }
  }

  // Layer in vibe modifier if available
  const vibeMod = VIBE_MODIFIERS[(vibe || '').toLowerCase()] || '';

  // Combine — keep under 100 chars for Unsplash API
  const query = [industryTerm, vibeMod, 'south africa']
    .filter(Boolean)
    .join(' ')
    .slice(0, 100)
    .trim();

  return query;
}

// ── CSS VARIABLES GENERATOR ───────────────────────────────────

/**
 * buildCssVariables — generates the :root CSS block from a palette
 * Ready to inject directly into the HTML <head>
 * primaryColour (optional) — hex from Claude's palette decision or logo extraction
 * accentColour (optional)  — hex for CTAs and highlights from Claude's decision
 */
function buildCssVariables(palette, typography, primaryColour = null, accentColour = null) {
  // Claude's chosen colours override primary/accent only
  // All other colours come from the palette naturally — light or dark as designed
  const primary = primaryColour || palette.primary;
  const accent  = accentColour  || primaryColour || palette.accent;

  return `<style id="wh-design-system">
${typography.cssImport}
:root {
  --primary:      ${primary};
  --on-primary:   ${palette.onPrimary};
  --accent:       ${accent};
  --bg:           ${palette.bg};
  --surface:      ${palette.muted};
  --card:         ${palette.card};
  --card-solid:   ${palette.muted};
  --fg:           ${palette.fg};
  --muted-fg:     ${palette.mutedFg};
  --border:       ${palette.border};
  --label-color:  ${palette.mutedFg};
  --font-heading: '${typography.heading}', serif;
  --font-body:    '${typography.body}', sans-serif;
}
</style>`;
}

// ============================================================
// EXPANSION — New personality categories, variant tokens,
// fingerprint system, selection pass helpers
// Added: 2026-06-07
// ============================================================

// ── NEW INDUSTRY → PERSONALITY MAPPINGS ──────────────────────
// Extend existing INDUSTRY_PERSONALITY with new categories
Object.assign(INDUSTRY_PERSONALITY, {
  // Luxury
  boutique:'luxury', interior_design:'luxury', high_end_salon:'luxury',
  jeweller:'luxury', luxury_car:'luxury', fine_dining:'luxury',
  concierge:'luxury', private_chef:'luxury', wine:'luxury',

  // Artisan
  pottery:'artisan', woodwork:'artisan', leather:'artisan',
  candlemaker:'artisan', seamstress:'artisan', tailor:'artisan',
  bespoke:'artisan', craft_beer:'artisan', artisan_bakery:'artisan',
  soap:'artisan', homeware:'artisan', ceramics:'artisan',

  // Hustle
  food_truck:'hustle', spaza:'hustle', street_vendor:'hustle',
  mobile_barber:'hustle', mobile_mechanic:'hustle', kiosk:'hustle',
  flea_market:'hustle', township_business:'hustle',

  // Heritage
  family_business:'heritage', established_restaurant:'heritage',
  old_school_barber:'heritage', traditional_healer:'heritage',
  pawn_shop:'heritage', second_hand:'heritage',

  // Authority
  chartered_accountant:'authority', specialist_doctor:'authority',
  advocate:'authority', engineer:'authority', architect:'authority',
  quantity_surveyor:'authority', financial_planner:'authority',
  insurance_broker:'authority',
});

// ── NEW PERSONALITY GENOMES ───────────────────────────────────
Object.assign(PERSONALITY_GENOMES, {

  luxury: {
    label: 'Luxury',
    hero_layouts: ['quiet_premium', 'cinematic_left'],
    opening_strategies: ['manifesto', 'emotional_story'],
    typography_mode: 'luxury_serif',
    typography_alt_id: 1,        // Classic Elegant as alt
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'center',
    visual_energy: 'restrained',
    surface_style: 'deep_dark',
    cta_style: 'minimal',
    section_flow: 'emotion_first',
    palette_row: 32,
    palette_row_light: 'luxury_light',
    typography_id: 12,
    trust_signals: false,
    colour_mood_default: 'dark',
    image_treatment: { bg_position:'center top', hero_height:'100svh', scrim:'minimal' },
    archetype_code: 'LUX',
  },

  artisan: {
    label: 'Artisan',
    hero_layouts: ['cinematic_left', 'quiet_premium'],
    opening_strategies: ['emotional_story', 'manifesto'],
    typography_mode: 'retro_warm',
    typography_alt_id: 4,        // Editorial Classic as alt
    spacing_rhythm: 'airy',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'warm',
    surface_style: 'warm_dark',
    cta_style: 'inviting',
    section_flow: 'story_first',
    palette_row: 63,
    palette_row_light: 'artisan_light',
    typography_id: 10,
    trust_signals: false,
    colour_mood_default: 'dark',
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'warm_bottom' },
    archetype_code: 'ART',
  },

  hustle: {
    label: 'Hustle',
    hero_layouts: ['trade_authority', 'cinematic_left'],
    opening_strategies: ['direct_offer', 'local_hero'],
    typography_mode: 'bold_statement',
    typography_alt_id: 2,        // Modern Professional as alt
    spacing_rhythm: 'compact',
    card_density: 'medium',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 34,
    palette_row_light: 'hustle_light',
    typography_id: 7,
    trust_signals: false,
    colour_mood_default: 'dark',
    image_treatment: { bg_position:'center', hero_height:'88svh', scrim:'heavy_bottom' },
    archetype_code: 'HST',
  },

  heritage: {
    label: 'Heritage',
    hero_layouts: ['quiet_premium', 'cinematic_left'],
    opening_strategies: ['local_hero', 'emotional_story'],
    typography_mode: 'editorial_classic',
    typography_alt_id: 10,       // Retro Warm as alt
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'restrained',
    surface_style: 'warm_dark',
    cta_style: 'minimal',
    section_flow: 'story_first',
    palette_row: 63,
    palette_row_light: 'heritage_light',
    typography_id: 4,
    trust_signals: true,
    colour_mood_default: 'dark',
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'cinematic' },
    archetype_code: 'HER',
  },

  authority: {
    label: 'Authority',
    hero_layouts: ['quiet_premium', 'trade_authority'],
    opening_strategies: ['proof_first', 'local_hero'],
    typography_mode: 'corporate_trust',
    typography_alt_id: 4,        // Editorial Classic as alt
    spacing_rhythm: 'dramatic',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'restrained',
    surface_style: 'deep_dark',
    cta_style: 'minimal',
    section_flow: 'proof_first',
    palette_row: 40,
    palette_row_light: 'authority_light',
    typography_id: 16,
    trust_signals: true,
    colour_mood_default: 'dark',
    image_treatment: { bg_position:'center', hero_height:'95svh', scrim:'minimal' },
    archetype_code: 'AUT',
  },

});

// ── LIGHT PALETTE VARIANTS ────────────────────────────────────
// Dark is default for most archetypes.
// Light variants for luxury, artisan, heritage when colour_mood=light
const LIGHT_PALETTES = {
  luxury_light:    { primary:'#1a1a2e', onPrimary:'#ffffff', secondary:'#2d2d4e', accent:'#c9913a', bg:'#faf8f5', fg:'#1a1a2e', card:'#ffffff', muted:'#f0ece6', mutedFg:'#6b6460', border:'#e8e0d8', ring:'#c9913a', notes:'Warm cream + gold luxury' },
  artisan_light:   { primary:'#3d2b1f', onPrimary:'#ffffff', secondary:'#6b4c38', accent:'#c47a3a', bg:'#fdf8f2', fg:'#3d2b1f', card:'#ffffff', muted:'#f2ede5', mutedFg:'#7a6458', border:'#e8ddd2', ring:'#c47a3a', notes:'Warm parchment + craft amber' },
  heritage_light:  { primary:'#2c2418', onPrimary:'#ffffff', secondary:'#5c4d38', accent:'#8b6914', bg:'#faf7f0', fg:'#2c2418', card:'#ffffff', muted:'#f0ebe0', mutedFg:'#7a6e5a', border:'#e5dcc8', ring:'#8b6914', notes:'Aged paper + heritage gold' },
  hustle_light:    { primary:'#1a0a00', onPrimary:'#ffffff', secondary:'#8b3a00', accent:'#ff6b00', bg:'#fff8f5', fg:'#1a0a00', card:'#ffffff', muted:'#ffe8d8', mutedFg:'#8b5a4a', border:'#ffd0b0', ring:'#ff6b00', notes:'Warm white + bold orange' },
  authority_light: { primary:'#0f1e3d', onPrimary:'#ffffff', secondary:'#1e3a6e', accent:'#b45309', bg:'#f8f9fc', fg:'#0f1e3d', card:'#ffffff', muted:'#eef0f5', mutedFg:'#5a6580', border:'#d8dce8', ring:'#0f1e3d', notes:'Clean white + authority navy' },
};

// ── ARCHETYPE CODE MAP ────────────────────────────────────────
// Short codes for fingerprint generation
const ARCHETYPE_CODES = {
  trade_authority:   'TRD',
  transformation:    'TRN',
  personal_care:     'PCA',
  wellness:          'WEL',
  hospitality:       'HOS',
  community_local:   'COM',
  professional_trust:'PRO',
  technical_expertise:'TEC',
  retail_utility:    'RET',
  event_creative:    'EVT',
  mobility:          'MOB',
  medical_trust:     'MED',
  memorial_legacy:   'MEM',
  luxury:            'LUX',
  artisan:           'ART',
  hustle:            'HST',
  heritage:          'HER',
  authority:         'AUT',
};

const LAYOUT_CODES = {
  trade_authority: 'BOLD',
  cinematic_left:  'CIN',
  quiet_premium:   'QP',
};

const FLOW_CODES = {
  service_first: 'SVC',
  story_first:   'STR',
  emotion_first: 'EMO',
  proof_first:   'PRF',
};

const TYPO_CODES = {
  1:  'CLE',  // Classic Elegant
  2:  'MPR',  // Modern Professional
  4:  'EDC',  // Editorial Classic
  6:  'PLC',  // Playful Creative
  7:  'BLD',  // Bold Statement
  8:  'WLC',  // Wellness Calm
  10: 'RTW',  // Retro Warm
  11: 'GEO',  // Geometric Modern
  12: 'LSF',  // Luxury Serif
  14: 'NEW',  // News Editorial
  16: 'CRP',  // Corporate Trust
  18: 'FFW',  // Fashion Forward
};

// ── FINGERPRINT GENERATOR ─────────────────────────────────────
/**
 * Generates a short design fingerprint for a build.
 * Format: ARCH-TYPO-MOOD-LAYOUT-FLOW
 * Example: ART-RTW-LIGHT-CIN-STR
 *
 * @param {string} category — personality category key
 * @param {object} variants — { colour_mood, hero_layout, section_flow, typography_id }
 * @returns {string} fingerprint
 */
function generateFingerprint(category, variants = {}) {
  const genome  = PERSONALITY_GENOMES[category] || PERSONALITY_GENOMES.trade_authority;
  const arch    = ARCHETYPE_CODES[category]   || 'GEN';
  const typo    = TYPO_CODES[variants.typography_id || genome.typography_id] || 'STD';
  const mood    = (variants.colour_mood || genome.colour_mood_default || 'dark').toUpperCase().slice(0, 5);
  const layout  = LAYOUT_CODES[variants.hero_layout || genome.hero_layouts[0]] || 'STD';
  const flow    = FLOW_CODES[variants.section_flow || genome.section_flow] || 'STD';
  return `${arch}-${typo}-${mood}-${layout}-${flow}`;
}

// ── SELECTION PASS SYSTEM PROMPT ──────────────────────────────
/**
 * Returns the system prompt for Pass 0 — the design selection pass.
 * This pass reads all available signals and outputs a design decision object.
 */
function selectionPassSystem() {
  return `You are a South African brand designer making a single, confident design decision for a small business website.

You will receive business data — name, industry, area, GBP category, reviews, review count, rating.

Your job is to output ONLY a JSON object with these exact keys:
- personality_category: one of [trade_authority, transformation, personal_care, wellness, hospitality, community_local, professional_trust, technical_expertise, retail_utility, event_creative, mobility, medical_trust, memorial_legacy, luxury, artisan, hustle, heritage, authority]
- hero_layout: one of [trade_authority, cinematic_left, quiet_premium]
- section_flow: one of [service_first, story_first, emotion_first, proof_first]
- colour_mood: one of [dark, light]
- typography_id: one of [1, 2, 4, 6, 7, 8, 10, 11, 12, 14, 16, 18]
- reasoning: one sentence explaining the core decision

DECISION RULES:
- Trade/emergency/repair → trade_authority, dark, service_first, bold typography (7)
- Salon/spa/beauty → personal_care, dark, story_first, elegant typography (1)
- Bakery/artisan food/craft → artisan, light or dark, story_first, retro warm (10)
- Restaurant/cafe/food → hospitality, dark, emotion_first, retro warm (10)
- Legal/accounting/engineering → authority, light, proof_first, corporate trust (16)
- Luxury/boutique/high-end → luxury, dark or light, emotion_first, luxury serif (12)
- Street food/mobile/hustle → hustle, dark, service_first, bold (7)
- Old established business → heritage, dark, story_first, editorial classic (4)
- Medical/dental/physio → medical_trust, light, proof_first, wellness calm (8)
- Photography/events/creative → event_creative, dark, emotion_first, fashion forward (18)
- SA area signals: Sandton/Umhlanga/Constantia → luxury bias; township names → hustle/community bias; small towns → heritage/local bias
- Review language: "family", "friendly", "like home" → community/heritage; "professional", "expert" → authority/professional_trust; "beautiful", "amazing" → experience/luxury; "fast", "saved us" → emergency/trade
- Light mood: luxury, authority, heritage, artisan (often better in light), medical
- Dark mood: trades, hustle, wellness, hospitality, events, photography

Output ONLY valid JSON. No markdown. No explanation outside the reasoning field.`;
}

/**
 * Returns the user prompt for Pass 0.
 * @param {object} client — client record from D1
 * @param {object} gbpData — GBP data or null
 * @returns {string}
 */
function selectionPassUser(client, gbpData) {
  const reviewSample = gbpData?.reviews?.slice(0, 3).map(r => r.text).filter(Boolean).join(' | ') || '';
  return `Business: ${client.business_name}
Industry: ${client.industry || 'unknown'}
Area: ${client.area || 'South Africa'}
${client.about ? `About: ${client.about}` : ''}
GBP Category: ${gbpData?.category || 'unknown'}
GBP Rating: ${gbpData?.rating || 'unknown'} (${gbpData?.reviewCount || 0} reviews)
Review snippets: ${reviewSample || 'none available'}
Package: ${client.package || 'standard'}`;
}

// ============================================================
// PHOTO DATABASE — SA-specific Unsplash query system
// Replaces Claude-generated unsplash_query in pre-build pipeline
//
// Usage:
//   const query = getHeroPhotoQuery(businessName, freeText);
//   // Returns a validated Unsplash query string
//
// Design principles:
//   - Query for the VISUAL not the name
//   - SA context lives in the INFERENCE not the query
//   - Multiple queries per industry for variation across builds
//   - No "south africa" in queries — Unsplash coverage too thin
//   - Residential scale for trades — never industrial/commercial
//   - Aspirational but achievable for ekasi/informal sector
// ============================================================

// ── QUERY POOLS ───────────────────────────────────────────────
// 8-10 validated queries per industry
// Selected randomly per build — fresh photo every time
// Oriented toward portrait/square for mobile full-bleed hero

const PHOTO_DB = {

  // ── TRADES (RESIDENTIAL SCALE) ──────────────────────────────
  plumbing: [
    'plumber fixing sink home close up hands',
    'plumber pipe repair residential bathroom',
    'plumber tools wrench home repair',
    'water pipe repair close up hands',
    'plumber under sink home repair natural light',
    'residential plumbing repair professional',
    'plumber working home bathroom natural',
    'pipe fitting close up hands tools',
  ],

  electrical: [
    'electrician wiring home residential close',
    'electrician distribution board home',
    'electrician hands cable residential',
    'electrical wiring repair close up',
    'electrician working home natural light',
    'residential electrical repair professional',
    'electrician tools hands working',
    'circuit breaker home electrical close',
  ],

  aircon: [
    'split unit air conditioner installation wall',
    'air conditioning unit home wall mounted',
    'hvac technician split unit residential',
    'air conditioner remote control home',
    'split air conditioner clean white wall',
    'air conditioning installation home close',
    'technician air conditioner unit wall',
    'split unit aircon modern home',
  ],

  handyman: [
    'handyman tools belt home repair',
    'handyman fixing door home residential',
    'maintenance man home repair natural light',
    'handyman drill home improvement',
    'home repair tools natural light',
    'handyman working home close up',
    'maintenance repair home professional',
    'handyman painting wall home close',
  ],

  carpentry: [
    'carpenter wood workshop hands close',
    'carpenter measuring cutting wood',
    'woodwork hands tools natural light',
    'carpenter fitting door frame home',
    'wood cabinet custom build close',
    'carpenter tools bench workshop warm',
    'joinery woodwork hands detail',
    'carpenter sanding wood natural light',
  ],

  painting: [
    'painter roller wall white clean',
    'house painter brush close up wall',
    'painting wall home fresh white',
    'painter professional home interior',
    'paint brush roller home renovation',
    'wall painting close up smooth',
    'house painter natural light interior',
    'painting home walls professional clean',
  ],

  roofing: [
    'roof tiles roofing professional close',
    'roofer working roof residential',
    'roof repair tiles close up sky',
    'roofing contractor residential home',
    'roof installation tiles professional',
    'roofer close up working tiles',
    'residential roof repair natural light',
    'roof tile pattern close up warm',
  ],

  waterproofing: [
    'waterproofing roof membrane close up',
    'waterproof coating surface professional',
    'waterproofing application close hands',
    'roof waterproof treatment professional',
    'damp proofing wall close up',
    'waterproofing membrane application',
    'professional waterproofing surface close',
    'wall waterproof coating application',
  ],

  pest_control: [
    'pest control spray professional uniform',
    'exterminator professional uniform home',
    'pest control technician home residential',
    'pest control professional protective gear',
    'fumigation professional home service',
    'pest control equipment professional',
    'exterminator spraying home close',
    'pest control professional service home',
  ],

  appliance_repair: [
    'appliance repair technician home close',
    'washing machine repair technician',
    'appliance technician tools home repair',
    'fridge repair close up technician',
    'home appliance repair professional',
    'technician fixing appliance home',
    'washing machine repair close hands',
    'appliance service technician tools',
  ],

  // ── FLOORING (SA-SPECIFIC — NO TILE NO HARDWOOD NO EPOXY) ───
  flooring: [
    'carpet installation close up hands',
    'carpet rolls warehouse warm light',
    'laminate floor installation click close',
    'vinyl floor plank installation close',
    'carpet texture warm bedroom floor',
    'laminate flooring installation professional',
    'vinyl plank floor modern interior',
    'carpet fitting professional close hands',
    'laminate floor sample warm wood look',
    'sheet vinyl floor clean commercial',
  ],

  // ── BEAUTY & WELLNESS ────────────────────────────────────────
  hair_salon: [
    'hair stylist scissors close bokeh warm',
    'hair salon styling mirror warm light',
    'hairdresser cutting hair close up',
    'hair colour salon professional warm',
    'stylist hands hair natural light bokeh',
    'hair salon interior warm lighting',
    'hairdresser blow dry styling close',
    'hair cut close up scissors professional',
  ],

  barber: [
    'barber fade close up clippers',
    'barber shop interior warm light',
    'barber cutting hair close clippers',
    'barbershop mirror chair warm',
    'barber fade haircut close professional',
    'barber tools clippers comb close',
    'barber shop interior bokeh warm',
    'men haircut barber close professional',
  ],

  nails: [
    'nail technician manicure close up',
    'nail art close up hands beautiful',
    'manicure nail polish hands close',
    'nail salon hands close up art',
    'gel nails close up hands professional',
    'nail technician working close hands',
    'manicure hands close beautiful nails',
    'nail polish application close up',
  ],

  spa: [
    'massage therapy hands back close',
    'spa candles stones relaxing warm',
    'massage table warm light relaxing',
    'spa treatment hands close warm',
    'wellness massage professional close',
    'spa interior candles warm calm',
    'massage therapy professional warm',
    'relaxing spa treatment close warm',
  ],

  lashes: [
    'eyelash extension close up professional',
    'lash technician applying extensions close',
    'eyelash extension beautiful close up',
    'lash extensions eye close up',
    'beauty technician lashes close',
    'eyelash extension application close',
    'beautiful lashes close up bokeh',
    'lash extension professional close eye',
  ],

  makeup: [
    'makeup artist applying makeup close',
    'makeup brush face close up professional',
    'makeup application professional close',
    'beauty makeup artist close warm',
    'makeup brushes professional close up',
    'makeup artist working close natural',
    'bridal makeup application close',
    'makeup tools professional close up',
  ],

  // ── FOOD & HOSPITALITY ───────────────────────────────────────
  restaurant: [
    'restaurant food plated warm close',
    'restaurant table setting warm light',
    'plated meal restaurant warm bokeh',
    'restaurant interior warm evening',
    'food close up warm restaurant',
    'restaurant dish close up beautiful',
    'dining table warm light food',
    'restaurant meal close warm bokeh',
  ],

  catering: [
    'catering food trays close up warm',
    'plated catering food close professional',
    'catering dishes food close warm',
    'food trays catering professional warm',
    'catering spread food close up',
    'buffet catering food warm close',
    'catering professional food presentation',
    'catering dishes warm food close',
  ],

  bakery: [
    'bakery bread fresh warm close',
    'cake baking close up warm light',
    'fresh bread bakery warm morning',
    'pastry close up bakery warm',
    'baking hands bread dough warm',
    'cake decoration close up professional',
    'fresh pastry bakery morning warm',
    'bread loaves warm bakery close',
  ],

  cafe: [
    'coffee cup latte art close warm',
    'cafe interior warm light cozy',
    'barista coffee making close warm',
    'coffee latte art cup close',
    'cafe table coffee warm morning',
    'coffee cup close up warm bokeh',
    'barista hands coffee machine close',
    'coffee shop warm interior cozy',
  ],

  street_food: [
    'street food vendor warm smoke cooking',
    'food stall cooking warm light',
    'grilled food vendor smoke warm',
    'street food cooking close warm',
    'food vendor hands cooking warm',
    'informal food stall warm cooking',
    'street vendor food smoke natural',
    'food cooking close up flame warm',
  ],

  chicken_shop: [
    'grilled chicken close up flame warm',
    'rotisserie chicken close warm light',
    'grilled chicken pieces close up',
    'flame grilled chicken close warm',
    'chicken grilling close smoke warm',
    'grilled chicken pieces warm close',
    'roasted chicken close up warm',
    'chicken grill flame close warm',
  ],

  shisa_nyama: [
    'braai meat grilling close up flame',
    'barbecue meat close up warm smoke',
    'grilling meat braai smoke warm',
    'meat on grill close flame warm',
    'bbq grill meat close smoke',
    'braai fire meat close up warm',
    'grilled meat smoke close warm',
    'outdoor grill meat flame close',
  ],

  bottle_store: [
    'liquor store bottles shelf warm',
    'wine bottles shelf close up',
    'spirits bottles store shelf warm',
    'alcohol bottles shelf store close',
    'liquor shelf bottles warm light',
    'beer bottles cold store close',
    'wine spirits bottles shelf warm',
    'bottle store shelf close up warm',
  ],

  // ── AUTOMOTIVE ───────────────────────────────────────────────
  mechanic: [
    'mechanic car engine close up hands',
    'car repair mechanic workshop close',
    'mechanic working under car close',
    'auto repair hands engine close',
    'mechanic tools workshop car close',
    'car service mechanic close hands',
    'auto workshop mechanic natural light',
    'mechanic diagnostic car close hands',
  ],

  panel_beater: [
    'panel beating car repair close up',
    'car body repair sanding close',
    'auto body repair professional close',
    'car panel repair professional workshop',
    'body shop car repair close',
    'auto body sanding professional close',
    'car dent repair close professional',
    'panel beating workshop close up',
  ],

  tyres: [
    'tyre fitting close up professional',
    'car tyre change workshop close',
    'tyre shop fitting professional',
    'tyre change car workshop close',
    'wheel tyre fitting professional close',
    'tyre fitment workshop professional',
    'car wheel tyre change close',
    'tyre shop workshop close up',
  ],

  carwash: [
    'car wash hands chamois close up',
    'car washing soap suds close',
    'hand car wash close up clean',
    'car wash wipe down close professional',
    'washing car hands close soapy',
    'car detailing close up professional',
    'car wash clean shine close',
    'hand wash car close up water',
  ],

  bakkie_hire: [
    'pickup truck bakkie side profile clean',
    'truck hire transport professional',
    'pickup truck loading close up',
    'delivery truck professional clean',
    'truck transport hire professional',
    'pickup truck professional clean side',
    'transport truck hire close',
    'bakkie truck professional clean',
  ],

  // ── CONSTRUCTION & RENOVATION ────────────────────────────────
  construction: [
    'construction worker residential building',
    'builder laying bricks close up',
    'construction residential home build',
    'builder hands bricks mortar close',
    'home construction worker natural',
    'residential building construction close',
    'builder construction residential warm',
    'bricklaying close up hands mortar',
  ],

  renovation: [
    'home renovation interior modern clean',
    'renovation interior before after clean',
    'home improvement renovation close',
    'interior renovation modern clean',
    'renovation work home interior close',
    'home makeover interior modern',
    'renovation interior clean modern warm',
    'home renovation professional interior',
  ],

  plastering: [
    'plastering wall smooth close hands',
    'plaster wall application close up',
    'wall plastering professional close',
    'plasterer smooth wall close hands',
    'wall plaster application professional',
    'plastering hands close up wall',
    'smooth plaster wall professional',
    'plasterer working wall close up',
  ],

  welding: [
    'welder sparks metal work close',
    'welding sparks close up professional',
    'metal welding close spark warm',
    'welder mask sparks close work',
    'welding professional metal close',
    'sparks welding close up metal',
    'steel welding professional close',
    'welding work metal sparks close',
  ],

  // ── CLEANING ─────────────────────────────────────────────────
  cleaning: [
    'professional cleaner uniform cleaning',
    'cleaning service professional mop floor',
    'cleaner professional uniform indoor',
    'cleaning professional service indoor',
    'mop floor cleaning professional',
    'cleaning staff uniform professional',
    'professional cleaning service indoor',
    'cleaner spray clean professional',
  ],

  laundry: [
    'laundry clean folded clothes warm',
    'laundry service clean white clothes',
    'folded laundry clean warm light',
    'laundry professional clean service',
    'clean clothes folded warm light',
    'laundry service professional clean',
    'washing clean clothes folded warm',
    'laundry clean professional service',
  ],

  // ── HEALTH & MEDICAL ─────────────────────────────────────────
  medical: [
    'doctor consultation professional warm',
    'medical professional stethoscope close',
    'doctor patient consultation warm',
    'clinic professional medical warm',
    'healthcare professional consultation',
    'doctor stethoscope professional close',
    'medical consultation warm professional',
    'clinic interior clean professional',
  ],

  pharmacy: [
    'pharmacy shelves medicine professional',
    'pharmacist professional close counter',
    'pharmacy medicine shelves clean',
    'pharmacist counter professional warm',
    'pharmacy professional service close',
    'medicine pharmacy shelves professional',
    'pharmacy counter professional clean',
    'pharmacist helping customer close',
  ],

  physio: [
    'physiotherapy treatment hands close',
    'physio massage therapy professional',
    'physiotherapy exercise professional',
    'physio treatment hands patient close',
    'rehabilitation therapy professional warm',
    'physiotherapist hands treatment close',
    'physio professional treatment warm',
    'therapy hands close professional',
  ],

  // ── DENTAL ───────────────────────────────────────────────────
  dental: [
    'dentist dental chair professional clean',
    'dental treatment professional close',
    'dentist professional clean clinic',
    'dental clinic professional clean warm',
    'dentist smiling patient professional',
    'dental professional treatment close',
    'teeth smile beautiful close up',
    'dental care professional clean close',
  ],

  // ── FITNESS ──────────────────────────────────────────────────
  gym: [
    'gym weights training professional',
    'fitness gym training equipment',
    'workout gym weights close up',
    'fitness training gym professional',
    'gym equipment weights professional',
    'training fitness gym close',
    'gym workout professional equipment',
    'fitness weights gym warm light',
  ],

  personal_trainer: [
    'personal trainer training client',
    'fitness coach training professional',
    'personal trainer outdoor fitness',
    'fitness coach client training close',
    'personal training professional outdoor',
    'trainer coaching fitness close',
    'personal trainer fitness professional',
    'fitness coaching outdoor professional',
  ],

  yoga: [
    'yoga pose studio calm light',
    'yoga meditation calm natural light',
    'yoga studio peaceful natural',
    'yoga pose calm warm light',
    'yoga practice calm studio',
    'meditation yoga peaceful light',
    'yoga class calm professional',
    'yoga pose natural light calm',
  ],

  // ── EVENTS ───────────────────────────────────────────────────
  events: [
    'event marquee tent tables chairs setup',
    'event setup tables chairs outdoor',
    'marquee tent event outdoor warm',
    'event tables chairs setup outdoor',
    'outdoor event setup marquee warm',
    'event decor tables chairs professional',
    'marquee event setup professional',
    'outdoor event tent setup warm',
  ],

  wedding: [
    'wedding reception tables elegant warm',
    'wedding decor flowers elegant close',
    'wedding table setting elegant warm',
    'wedding ceremony outdoor elegant',
    'wedding flowers decor close warm',
    'wedding reception elegant warm light',
    'wedding table flowers close elegant',
    'wedding decor elegant warm beautiful',
  ],

  photography: [
    'photographer camera outdoor natural light',
    'photography camera bokeh natural',
    'photographer shooting outdoor natural',
    'camera lens close up bokeh',
    'photographer professional natural light',
    'photography natural light bokeh close',
    'photographer camera professional outdoor',
    'camera photography natural bokeh',
  ],

  dj: [
    'dj mixer decks close up lights',
    'dj console mixing music close',
    'dj equipment music lights close',
    'mixer dj hands music close',
    'dj setup equipment music lights',
    'dj decks music professional close',
    'dj mixing console close lights',
    'music dj professional setup close',
  ],

  // ── EDUCATION ────────────────────────────────────────────────
  tutoring: [
    'tutor student home table books warm',
    'tutoring home kitchen table natural',
    'student books studying home warm',
    'tutor helping student home close',
    'home tutoring books study warm',
    'student studying books home natural',
    'tutoring one on one home warm',
    'books study table home warm light',
  ],

  // ── PROPERTY ─────────────────────────────────────────────────
  property: [
    'house property exterior modern clean',
    'real estate house exterior clean',
    'property home exterior modern',
    'house exterior clean modern warm',
    'property estate home professional',
    'real estate home exterior warm',
    'house modern exterior clean light',
    'property home exterior professional',
  ],

  // ── LEGAL & FINANCIAL ────────────────────────────────────────
  legal: [
    'lawyer desk professional office',
    'legal books desk professional',
    'attorney professional office close',
    'law books desk professional warm',
    'legal professional desk office',
    'lawyer professional office books',
    'legal desk professional close warm',
    'attorney office professional books',
  ],

  accounting: [
    'accountant desk calculator professional',
    'tax accounting desk professional',
    'financial professional desk close',
    'accounting books calculator desk',
    'tax professional desk warm close',
    'accountant professional desk papers',
    'financial desk calculator professional',
    'accounting professional close warm',
  ],

  crypto: [
    'laptop trading charts professional',
    'crypto trading phone laptop modern',
    'financial charts laptop professional',
    'trading setup laptop screens modern',
    'laptop charts trading professional',
    'digital finance laptop modern clean',
    'trading charts professional laptop',
    'laptop financial professional modern',
  ],

  // ── TECH & DIGITAL (EKASI RISING) ────────────────────────────
  it_support: [
    'laptop repair technician close up',
    'computer repair professional close',
    'it technician laptop repair',
    'computer technician professional close',
    'laptop repair hands close technical',
    'it professional laptop repair close',
    'technician computer repair close',
    'laptop open repair professional close',
  ],

  social_media: [
    'social media phone content creation',
    'content creator phone filming modern',
    'social media professional phone laptop',
    'content creation phone professional',
    'social media management laptop phone',
    'digital marketing professional laptop',
    'content creator modern professional',
    'phone laptop content professional',
  ],

  ai_consulting: [
    'laptop modern technology professional',
    'technology consulting professional modern',
    'digital professional laptop modern clean',
    'tech consulting laptop professional',
    'modern technology professional laptop',
    'digital consultant professional laptop',
    'technology modern professional clean',
    'laptop professional modern technology',
  ],

  graphic_design: [
    'graphic designer laptop creative close',
    'design work laptop creative professional',
    'graphic design creative laptop close',
    'designer working laptop creative',
    'creative design professional laptop',
    'graphic design work close professional',
    'designer laptop creative professional',
    'design professional creative laptop',
  ],

  cctv: [
    'cctv camera installation professional',
    'security camera installation close',
    'cctv installation professional close',
    'security camera wall close professional',
    'surveillance camera professional close',
    'cctv security professional installation',
    'camera security installation close',
    'security cctv professional install',
  ],

  // ── SECURITY ─────────────────────────────────────────────────
  security: [
    'security guard patrol professional uniform',
    'security officer professional uniform',
    'security guard professional patrol car',
    'security patrol professional car uniform',
    'armed response security professional',
    'security officer uniform professional',
    'patrol security professional car',
    'security guard professional close uniform',
  ],

  // ── RETAIL (INFORMAL) ────────────────────────────────────────
  spaza: [
    'small store shelves informal market',
    'corner store shelves products warm',
    'informal shop shelves products warm',
    'small grocery store shelves close',
    'neighbourhood store shelves warm',
    'local shop products shelves warm',
    'small store products shelves close',
    'informal retail store shelves warm',
  ],

  hardware: [
    'hardware store tools shelves professional',
    'building materials store professional',
    'hardware tools shelf close warm',
    'building supplies store professional',
    'hardware shelves tools professional',
    'tools hardware store close warm',
    'building materials hardware close',
    'hardware professional store tools',
  ],

  // ── TRANSPORT & LOGISTICS ────────────────────────────────────
  transport: [
    'delivery van professional driver',
    'logistics transport van professional',
    'delivery professional van close',
    'transport professional driver van',
    'logistics van delivery professional',
    'courier van professional delivery',
    'transport delivery professional close',
    'driver professional van delivery',
  ],

  kombi: [
    'minibus taxi transport professional',
    'minibus van transport professional',
    'kombi transport professional clean',
    'minibus hire professional transport',
    'van transport hire professional',
    'minibus professional transport clean',
    'hire transport van professional',
    'minibus clean professional transport',
  ],

  // ── CHILDCARE ────────────────────────────────────────────────
  childcare: [
    'childcare teacher children warm close',
    'daycare children playing warm',
    'teacher children close warm light',
    'childcare warm children playing',
    'creche children happy warm',
    'teacher child close warm natural',
    'childcare professional warm children',
    'children learning warm close',
  ],

  // ── FUNERAL SERVICES ─────────────────────────────────────────
  funeral: [
    'funeral flowers peaceful close warm',
    'memorial flowers peaceful warm',
    'funeral service flowers close',
    'peaceful memorial flowers warm',
    'funeral flowers close up warm',
    'memorial service flowers peaceful',
    'flowers memorial close peaceful',
    'funeral professional service flowers',
  ],

  // ── SIGNAGE & PRINT ──────────────────────────────────────────
  signage: [
    'signage printing professional banner',
    'banner printing professional close',
    'printing professional signage close',
    'vinyl printing professional sign',
    'signage professional print close',
    'banner sign printing professional',
    'print professional signage close',
    'branding print professional close',
  ],

  // ── FALLBACK ─────────────────────────────────────────────────
  // Clean, aspirational, professional — works for anything
  optometrist: [
    'optometrist eye exam professional clinic',
    'optical store glasses frames professional',
    'eye care professional optometry clinic',
    'optician glasses professional modern',
    'vision care eye test professional',
    'optical glasses frames retail clean',
  ],
  vet: [
    'veterinarian dog cat professional clinic',
    'vet animal clinic professional care',
    'veterinary practice professional pet care',
    'animal doctor professional clinic warm',
    'vet professional dog examination',
  ],
  driving_school: [
    'driving lesson instructor car professional',
    'driving school car lesson road',
    'driving instructor professional car lesson',
    'learner driver lesson professional road',
  ],
  tattoo: [
    'tattoo artist professional studio work',
    'tattoo studio professional artist close',
    'tattoo work professional artist detail',
    'body art tattoo professional studio',
  ],
  furniture: [
    'furniture store interior design modern',
    'furniture showroom modern professional',
    'furniture workshop craftsman wood professional',
    'modern furniture design interior professional',
  ],
  tiling: [
    'tile installation professional bathroom floor',
    'tiler professional tile floor work',
    'bathroom tile installation professional',
    'floor tile professional installation work',
  ],
  glazier: [
    'glass installation professional window',
    'glazier professional glass window work',
    'glass window professional installation',
  ],
  general: [
    'small business storefront south africa',
    'local business interior warm professional',
    'small business owner working confident',
    'south africa small business professional',
    'local shop interior professional warm',
    'business premises exterior professional',
    'small business professional interior',
    'local business professional warm light',
  ],

  beauty_salon: [
    'beauty salon interior elegant warm professional',
    'hair salon mirror styling chair warm light',
    'beauty salon styling station professional warm',
    'salon interior elegant clean professional',
    'hair beauty salon warm professional interior',
    'styling salon professional mirror warm',
    'beauty salon professional clean warm light',
    'unisex salon interior professional warm',
  ],
  florist: [
    'florist shop flowers beautiful colourful',
    'flower bouquet fresh colourful close',
    'florist arranging flowers beautiful',
    'fresh flowers bouquet colourful shop',
    'flower shop beautiful arrangement close',
    'florist flowers colourful fresh bright',
    'bouquet flowers beautiful fresh close',
    'floral arrangement beautiful colourful',
  ],
  landscaping: [
    'landscaping garden beautiful green',
    'garden landscaping professional green',
    'landscape garden design beautiful',
    'garden design professional beautiful green',
    'landscaping professional garden outdoor',
  ],
  garden: [
    'beautiful garden green outdoor',
    'garden green plants outdoor natural',
    'garden outdoor green plants beautiful',
    'green garden outdoor plants natural',
    'garden design outdoor green natural',
  ],
  nursery: [
    'plant nursery green plants professional',
    'garden nursery plants green natural',
    'nursery plants green professional',
    'plant nursery green natural outdoor',
  ],
  car_wash: [
    'car wash clean professional shiny',
    'vehicle detailing professional clean',
    'car detailing professional clean shiny',
    'auto detailing professional vehicle clean',
    'car wash professional clean exterior',
  ],
  physiotherapy: [
    'physiotherapy treatment professional clinic',
    'physio treatment professional close',
    'physiotherapy clinic professional warm',
    'physical therapy professional treatment',
    'physio professional treatment warm',
  ],
  building: [
    'construction building professional site',
    'builder professional construction site',
    'building construction professional',
    'construction site professional builder',
    'building professional construction work',
  ],

  // ── NEW INDUSTRIES ────────────────────────────────────────────
  butchery: [
    'butcher shop fresh meat display',
    'butcher cutting meat professional',
    'fresh meat butcher counter close',
    'butcher shop display beef close',
    'meat cutting professional butcher',
    'fresh cuts butcher shop display',
  ],
  pizza: [
    'wood fired pizza professional oven',
    'pizza restaurant fresh ingredients close',
    'pizza making dough professional',
    'wood fired pizza close up hot',
    'artisan pizza restaurant professional',
  ],
  sushi: [
    'sushi chef professional close up',
    'fresh sushi rolls close professional',
    'sushi restaurant professional chef',
    'japanese food sushi close fresh',
    'sushi platter fresh professional',
  ],
  pub: [
    'bar counter professional warm light',
    'pub interior warm inviting counter',
    'bar taps close warm interior',
    'tavern interior warm social',
    'bar counter warm drinks close',
  ],
  guest_house: [
    'bed and breakfast room clean bright',
    'guesthouse room inviting clean bright',
    'boutique hotel room clean bright',
    'guesthouse interior clean welcoming',
    'bed breakfast room bright inviting',
  ],
  lodge: [
    'african lodge luxury interior warm',
    'bush lodge room warm natural',
    'lodge outdoor nature deck warm',
    'luxury lodge south africa nature',
    'game lodge interior warm natural',
  ],
  home_industry: [
    'home baking kitchen professional warm',
    'homemade baked goods close warm',
    'home kitchen baking professional',
    'artisan food home kitchen warm',
    'home industry food production warm',
  ],
  deli: [
    'deli counter fresh food close',
    'delicatessen display professional fresh',
    'charcuterie board professional close',
    'deli food fresh display close',
    'artisan deli counter professional',
  ],
  farm_stall: [
    'farm stall fresh produce display',
    'farm fresh vegetables display colourful',
    'farm stall rustic fresh produce',
    'fresh farm produce display rustic',
    'farm market fresh vegetables warm',
  ],
  ice_cream: [
    'ice cream shop colourful close',
    'ice cream scoops close colourful',
    'dessert shop ice cream bright',
    'ice cream cone close bright',
    'gelato display colourful close professional',
  ],
  juice_bar: [
    'fresh juice bar colourful counter',
    'smoothie bowl fresh colourful close',
    'juice bar fresh fruit colourful',
    'healthy smoothie fresh colourful',
    'juice bar counter fresh bright',
  ],
  skincare: [
    'skincare treatment professional close',
    'facial treatment spa professional close',
    'skincare products professional clean',
    'beauty treatment professional close warm',
    'skin clinic professional treatment',
  ],
  waxing: [
    'beauty salon treatment professional warm',
    'waxing treatment professional close',
    'beauty treatment spa professional',
    'salon treatment professional warm',
  ],
  beauty_salon: [
    'beauty salon interior professional warm',
    'beauty treatment professional close',
    'salon chair professional warm interior',
    'beauty salon professional clean warm',
  ],
  chiropractor: [
    'chiropractic treatment professional close',
    'physiotherapy treatment professional',
    'spinal treatment professional clinic',
    'wellness treatment professional close',
  ],
  nutrition: [
    'nutritionist consultation professional',
    'healthy food nutrition professional',
    'dietitian consultation professional warm',
    'nutrition healthy food colourful',
  ],
  mental_health: [
    'counselling session professional warm',
    'therapy room professional warm calm',
    'psychologist consultation professional',
    'mental wellness professional calm warm',
  ],
  martial_arts: [
    'karate training professional studio',
    'martial arts training action',
    'boxing training professional gym',
    'martial arts studio professional',
  ],
  swimming_lessons: [
    'swimming pool lesson professional',
    'swimming coach pool professional',
    'swim lesson child pool professional',
    'pool swimming lesson professional',
  ],
  health_shop: [
    'health food store clean bright',
    'health shop supplements professional',
    'natural health store bright clean',
    'wellness products health store',
  ],
  clothing: [
    'clothing boutique interior clean bright',
    'fashion boutique professional display',
    'clothing store interior bright clean',
    'fashion display boutique professional',
  ],
  shoes: [
    'shoe store display professional clean',
    'shoes display boutique professional',
    'footwear store professional clean',
    'shoe shop display bright clean',
  ],
  electronics: [
    'electronics store professional clean',
    'phone repair shop professional',
    'electronics display clean bright',
    'tech store professional clean',
  ],
  car_parts: [
    'auto parts store professional clean',
    'car parts display professional',
    'spare parts mechanical professional',
    'automotive parts store professional',
  ],
  pet_shop: [
    'pet shop animals warm interior',
    'pet store cute animals display',
    'pet shop interior warm bright',
    'animals pet store professional warm',
  ],
  toys: [
    'toy store bright colourful interior',
    'toys display bright colourful clean',
    'toy shop bright happy interior',
    'children toys display bright colourful',
  ],
  books: [
    'bookstore interior warm shelves',
    'books library warm shelves interior',
    'bookshop warm inviting interior',
    'books shelves warm interior',
  ],
  clothing_boutique: [
    'boutique clothing interior bright',
    'fashion boutique display professional',
  ],
  towing: [
    'tow truck professional road',
    'vehicle recovery tow truck professional',
    'towing service truck professional',
    'tow truck vehicle recovery professional',
  ],
  car_rental: [
    'car rental fleet professional clean',
    'car hire professional clean fleet',
    'vehicle rental professional clean',
    'rental cars professional fleet clean',
  ],
  venue: [
    'function venue professional elegant',
    'event venue elegant professional interior',
    'function hall professional elegant',
    'venue interior professional elegant bright',
  ],
  party_hire: [
    'event hire tent professional setup',
    'party setup professional elegant',
    'event decor professional beautiful setup',
    'party hire professional setup',
  ],
  band: [
    'live band performing professional stage',
    'musician performing professional stage',
    'band live performance professional',
    'music performance professional stage',
  ],
  videography: [
    'videographer filming professional camera',
    'video production professional filming',
    'filmmaker professional camera close',
    'videography professional filming',
  ],
  courier: [
    'courier delivery professional van',
    'delivery driver professional uniform',
    'parcel delivery professional fast',
    'courier professional delivery uniform',
  ],
  moving: [
    'moving furniture professional truck',
    'removals team professional truck',
    'house moving professional team',
    'removal truck professional team',
  ],
  taxi: [
    'taxi cab professional clean urban',
    'metered taxi professional urban',
    'ride hailing professional car urban',
  ],
  solar: [
    'solar panels installation professional roof',
    'solar installation professional clean',
    'solar panels roof professional',
    'solar energy installation professional',
  ],
  locksmith: [
    'locksmith working lock professional',
    'lock repair professional close',
    'locksmith professional tools door',
    'lock installation professional close',
  ],
  gates: [
    'gate installation professional clean',
    'electric gate professional installation',
    'security gate professional modern',
    'automatic gate professional installation',
  ],
  demolition: [
    'construction demolition professional',
    'building construction site professional',
    'demolition professional site',
    'construction site professional workers',
  ],
  pool_service: [
    'swimming pool cleaning professional',
    'pool maintenance professional clean blue',
    'pool service professional maintenance',
    'pool cleaning professional blue water',
  ],
  pool_building: [
    'swimming pool construction professional',
    'new pool installation professional',
    'pool building professional construction',
    'luxury pool professional construction',
  ],
  curtains: [
    'curtain fitting professional interior',
    'blinds installation professional interior',
    'interior curtains professional warm',
    'window treatments professional interior',
  ],
  alterations: [
    'seamstress sewing professional close',
    'clothing alterations professional sewing',
    'tailor sewing professional close',
    'alterations professional sewing close',
  ],
  shoe_repair: [
    'shoe repair professional cobbler close',
    'cobbler working shoe professional',
    'shoe repair workshop professional',
    'footwear repair professional close',
  ],
  beekeeping: [
    'beekeeper hive professional natural',
    'honeybee hive professional natural',
    'beekeeper professional honey natural',
    'honey extraction professional natural',
  ],
  fishing: [
    'fishing bait tackle professional',
    'fishing store bait professional',
    'angling fishing professional natural',
    'fishing tackle professional close',
  ],
  home_care: [
    'home care nurse professional warm',
    'nursing care professional home warm',
    'home healthcare professional warm',
    'elderly care professional home warm',
  ],
  after_school: [
    'children learning classroom bright',
    'after school kids learning warm',
    'education children classroom bright',
    'kids learning after school warm',
  ],
  coding_school: [
    'coding class professional laptop',
    'programming students professional',
    'tech education coding professional',
    'coding students laptop professional',
  ],
  drone: [
    'drone aerial photography professional',
    'drone flying professional aerial',
    'aerial drone photography professional',
    'drone operator professional aerial',
  ],
  printing: [
    'print shop printing professional close',
    'printing press professional close',
    'print production professional',
    'large format printing professional',
  ],
  software: [
    'software developer professional laptop',
    'app development professional coding',
    'software development professional clean',
    'developer coding professional laptop',
  ],
  hr: [
    'recruitment interview professional',
    'hr professional meeting warm',
    'hiring recruitment professional',
    'human resources professional meeting',
  ],
  consulting: [
    'business consulting professional meeting',
    'consultant professional meeting warm',
    'consulting meeting professional',
    'business advisor professional meeting',
  ],
  mortgage: [
    'property bond professional consultation',
    'home loan professional consultation',
    'mortgage consultant professional warm',
    'bond originator professional consultation',
  ],
  financial_advisor: [
    'financial advisor professional consultation',
    'wealth management professional meeting',
    'financial planning professional warm',
    'insurance advisor professional meeting',
  ],
  tax: [
    'tax consultant professional meeting',
    'tax office professional clean',
    'accountant tax professional meeting',
    'tax advisor professional consultation',
  ],
  gp: [
    'doctor consultation professional warm',
    'gp doctor professional clinic',
    'medical consultation doctor warm',
    'doctor office professional clean warm',
  ],
  specialist: [
    'medical specialist professional clinic',
    'specialist doctor professional warm',
    'medical professional consultation warm',
  ],
  hearing: [
    'audiologist professional hearing test',
    'hearing aid professional consultation',
    'hearing clinic professional warm',
  ],
  nukery: [
    'plant nursery green professional',
    'garden nursery plants professional',
    'nursery plants green natural',
    'plant nursery professional natural green',
  ],
  farming: [
    'farm south africa natural outdoor',
    'smallholding farming natural outdoor',
    'farm produce natural outdoor',
    'farm south africa outdoor natural',
  ],
};

/**
 * getHeroPhotoQueryByKey — direct lookup using pre-computed industry key
 * Bypasses text inference. Use when industryKey is already known.
 */
function getHeroPhotoQueryByKey(industryKey) {
  const pool = PHOTO_DB[industryKey] || PHOTO_DB.general;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * EXPERIENCE ARCHETYPE — The World You Step Into
 *
 * For: restaurant, salon, spa, bakery, florist, coffee shop, lodge,
 *      guest house, wedding, event venue, lashes, massage, beauty
 *
 * Feel: Immersive. Sensory. You are already there before you read a word.
 *       A field of daffodils. The smell of fresh bread. The sound of rain
 *       on a garden. Content bleeds between sections like memory bleeds
 *       into memory. Reviews whisper. The contact section says "come see us"
 *       and you already want to.
 */

function generateExperienceHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone   = (client.phone || '').replace(/\D/g, '');
  const domain  = client.domain || (pkg === 'hub_pro' || pkg === 'premium' ? `${client.slug}.co.za` : `${client.slug}.websitehub.co.za`);
  const waLink  = `https://wa.me/${phone}`;
  const isExp   = pkg === 'express';

  const primary = brandBrief?.primary_colour || '#c8a96e';
  const accent  = brandBrief?.accent_colour  || '#e8d5a3';
  const svcs    = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';

  (client.phone || '').replace(/^\+?27/, '0').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── PARTICLE SYSTEM — industry aware ─────────────────────────
  const industry = (cards?.industry || client.industry || '').toLowerCase();
  const particleType =
    /florist|flower|nursery|garden|plant/.test(industry)   ? 'petals'     :
    /wedding|event|venue/.test(industry)                    ? 'confetti'   :
    /lodge|guest.house|airbnb|camp/.test(industry)          ? 'fireflies'  :
    /spa|massage|yoga|pilates|wellness/.test(industry)      ? 'orbs'       :
    /tattoo|piercing/.test(industry)                        ? 'none'       :
    /restaurant|bakery|cafe|coffee|food/.test(industry)     ? 'none'       :
    'none'; // default — most businesses look better without particles

  const particleCSS = particleType === 'petals' ? `
.particle{position:absolute;background:var(--accent);border-radius:50% 50% 50% 0;opacity:0;animation:petalFloat linear infinite;pointer-events:none}
${Array.from({length:8},(_,i)=>`.particle:nth-child(${i+1}){left:${10+i*11}%;animation-duration:${12+i*2.3}s;animation-delay:${i*1.7}s;width:${5+i%3}px;height:${8+i%4}px}`).join('\n')}
@keyframes petalFloat{0%{transform:translateY(100vh) rotate(0deg);opacity:0}5%{opacity:.6}90%{opacity:.4}100%{transform:translateY(-20vh) rotate(720deg) translateX(40px);opacity:0}}` :

  particleType === 'fireflies' ? `
.particle{position:absolute;width:4px;height:4px;background:var(--accent);border-radius:50%;opacity:0;animation:fireflyFloat ease-in-out infinite;pointer-events:none;box-shadow:0 0 6px var(--accent)}
${Array.from({length:10},(_,i)=>`.particle:nth-child(${i+1}){left:${5+i*9}%;top:${20+i*6}%;animation-duration:${6+i*1.5}s;animation-delay:${i*0.8}s}`).join('\n')}
@keyframes fireflyFloat{0%,100%{opacity:0;transform:translate(0,0)}25%{opacity:.8;transform:translate(${Math.random()>0.5?'':'-'}12px,-8px)}50%{opacity:.4;transform:translate(8px,4px)}75%{opacity:.7;transform:translate(-6px,-12px)}}` :

  particleType === 'orbs' ? `
.particle{position:absolute;border-radius:50%;background:radial-gradient(circle,var(--accent),transparent);opacity:0;animation:orbFloat ease-in-out infinite;pointer-events:none}
${Array.from({length:5},(_,i)=>`.particle:nth-child(${i+1}){width:${40+i*20}px;height:${40+i*20}px;left:${10+i*18}%;top:${30+i*8}%;animation-duration:${8+i*2}s;animation-delay:${i*1.2}s}`).join('\n')}
@keyframes orbFloat{0%,100%{opacity:0;transform:translateY(0)}50%{opacity:.15;transform:translateY(-20px)}}` :

  particleType === 'confetti' ? `
.particle{position:absolute;width:6px;height:6px;opacity:0;animation:confettiFall linear infinite;pointer-events:none}
${Array.from({length:12},(_,i)=>`.particle:nth-child(${i+1}){left:${i*8}%;background:${['var(--primary)','var(--accent)','#fff'][i%3]};border-radius:${i%2?'50%':'2px'};animation-duration:${8+i*1.2}s;animation-delay:${i*0.6}s}`).join('\n')}
@keyframes confettiFall{0%{transform:translateY(-20px) rotate(0deg);opacity:0}10%{opacity:.8}90%{opacity:.5}100%{transform:translateY(100vh) rotate(720deg);opacity:0}}` :
  ''; // none

  const particleElements = particleType !== 'none'
    ? Array.from({length: particleType === 'confetti' ? 12 : particleType === 'fireflies' ? 10 : 8}, () => `<div class="particle"></div>`).join('')
    : '';

  const botanicalLeaves = Array.from({length:6}, (_,i) =>
    `<ellipse cx="${70+i*10}" cy="${320-i*40}" rx="${8+i*2}" ry="${4+i}" fill="white" opacity="${(0.2+i*0.05).toFixed(2)}" transform="rotate(${ -20+i*8} ${70+i*10} ${320-i*40})"/>`
  ).join('');

  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(t.page_title || client.business_name)}</title>
<meta name="description" content="${esc(t.meta_description || '')}">
<meta property="og:title" content="${esc(client.business_name)}">
<meta property="og:description" content="${esc(t.hero_subline || '')}">
<meta property="og:image" content="${esc(heroUrl)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400;1,500&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --dark:#0e0c09;
  --dark2:#1a1612;
  --warm-white:#faf7f2;
  --cream:#f5f0e8;
  --muted:#8a7d6e;
  --font-display:'Cormorant Garamond',Georgia,serif;
  --font-body:'Jost',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--warm-white);color:var(--dark);overflow-x:hidden}

/* NAV */

.map-section{padding:0}
.map-embed{width:100%;height:220px;border:none;display:block;filter:grayscale(20%)}

.nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:16px 20px;transition:background .4s,backdrop-filter .4s}
.nav.scrolled{background:rgba(14,12,9,.88);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.nav-brand{font-family:var(--font-display);font-size:17px;font-weight:400;color:#fff;letter-spacing:.5px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55vw}
.nav-links{display:flex;align-items:center;gap:14px;flex-shrink:0}
.nav-link{color:rgba(255,255,255,.8);font-size:13px;font-weight:400;letter-spacing:.5px;text-decoration:none;transition:color .2s;display:none}
.nav-link:hover{color:#fff}
@media(min-width:640px){.nav-link{display:block}}
.nav-wa{background:var(--primary);color:var(--dark)!important;padding:8px 16px;border-radius:100px;font-weight:600;display:block!important;font-size:13px;white-space:nowrap}

/* HERO */
.hero{position:relative;height:100svh;min-height:600px;display:flex;flex-direction:column;justify-content:flex-end;padding:0 28px 80px;overflow:hidden}
.hero-bg{position:absolute;inset:0;background-image:url('${esc(heroUrl)}');background-size:cover;background-position:center;transform:scale(1.08);animation:heroReveal 1.8s cubic-bezier(.16,1,.3,1) forwards}
.hero-bg::after{content:'';position:absolute;inset:0;background:linear-gradient(to bottom,rgba(14,12,9,.1) 0%,rgba(14,12,9,.2) 40%,rgba(14,12,9,.78) 100%)}
.hero-content{position:relative;z-index:2}
.hero-label{font-family:var(--font-body);font-size:11px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:var(--accent);margin-bottom:16px;animation:fadeUp .8s .4s ease both}
.hero-h1{font-family:var(--font-display);font-size:clamp(52px,13vw,88px);font-weight:300;line-height:1;letter-spacing:-1px;color:#fff;margin-bottom:20px;animation:fadeUp .8s .55s ease both}
.hero-h1 em{font-style:italic;color:var(--accent)}
.hero-subline{font-size:16px;font-weight:300;color:rgba(255,255,255,.8);line-height:1.6;max-width:400px;margin-bottom:36px;animation:fadeUp .8s .7s ease both}
.hero-ctas{display:flex;gap:14px;flex-wrap:wrap;animation:fadeUp .8s .85s ease both}
.btn-primary{background:var(--primary);color:var(--dark);padding:14px 28px;border-radius:100px;font-size:14px;font-weight:600;letter-spacing:.3px;text-decoration:none;transition:transform .2s,opacity .2s;display:inline-flex;align-items:center;gap:8px}
.btn-primary:hover{transform:translateY(-1px);opacity:.9}
.btn-ghost{border:1.5px solid rgba(255,255,255,.35);color:#fff;padding:14px 28px;border-radius:100px;font-size:14px;font-weight:400;text-decoration:none;transition:all .2s}
.btn-ghost:hover{border-color:rgba(255,255,255,.7);background:rgba(255,255,255,.08)}
.hero-rating{position:absolute;top:88px;right:20px;background:rgba(255,255,255,.12);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:12px 14px;text-align:center;z-index:2;animation:fadeIn 1s 1.2s ease both;min-width:80px}
.rating-num{font-family:var(--font-display);font-size:28px;font-weight:300;color:#fff;line-height:1}
.rating-stars{color:var(--accent);font-size:12px;margin:4px 0}
.rating-count{font-size:11px;color:rgba(255,255,255,.6)}
.scroll-hint{position:absolute;bottom:32px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:8px;z-index:2;animation:fadeIn 1s 2s ease both}
.scroll-hint-line{width:1px;height:40px;background:linear-gradient(to bottom,rgba(255,255,255,.5),transparent);animation:scrollPulse 2s infinite}
.scroll-hint-text{font-size:10px;letter-spacing:2px;color:rgba(255,255,255,.4);text-transform:uppercase}

/* INTRO RIBBON */
.intro-ribbon{background:var(--cream);padding:48px 28px;overflow:hidden}
.intro-ribbon-inner{max-width:680px;margin:0 auto;text-align:center}
.intro-ribbon-text{font-family:var(--font-display);font-size:clamp(22px,5vw,32px);font-weight:300;font-style:italic;color:var(--dark);line-height:1.4;opacity:0;transform:translateY(20px);transition:opacity .8s ease,transform .8s ease}
.intro-ribbon-text.visible{opacity:1;transform:none}

/* ABOUT */
.about{position:relative;background:var(--dark);padding:100px 28px;overflow:hidden}
.about-botanical{position:absolute;right:-60px;top:50%;transform:translateY(-50%);width:55vw;max-width:380px;opacity:.07;pointer-events:none}
.about-inner{position:relative;z-index:2;max-width:560px}
.section-label{font-size:10px;font-weight:600;letter-spacing:4px;text-transform:uppercase;color:var(--primary);margin-bottom:20px;opacity:0;transform:translateY(12px);transition:opacity .6s ease,transform .6s ease}
.section-label.visible{opacity:1;transform:none}
.about-headline{font-family:var(--font-display);font-size:clamp(36px,8vw,58px);font-weight:300;line-height:1.1;letter-spacing:-.5px;color:#fff;margin-bottom:28px;opacity:0;transform:translateY(20px);transition:opacity .8s .1s ease,transform .8s .1s ease}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{font-style:italic;color:var(--accent)}
.about-pull{font-family:var(--font-display);font-size:clamp(18px,4vw,24px);font-style:italic;font-weight:300;color:var(--accent);line-height:1.5;margin-bottom:28px;padding-left:20px;border-left:2px solid var(--primary);opacity:0;transform:translateY(16px);transition:opacity .8s .2s ease,transform .8s .2s ease}
.about-pull.visible{opacity:1;transform:none}
.about-body{font-size:15px;font-weight:300;color:rgba(255,255,255,.7);line-height:1.8;margin-bottom:16px;opacity:0;transform:translateY(12px);transition:opacity .8s .3s ease,transform .8s .3s ease}
.about-body.visible{opacity:1;transform:none}

/* SERVICES */
.services{background:var(--warm-white);padding:100px 28px}
.services-inner{max-width:680px;margin:0 auto}
.section-headline{font-family:var(--font-display);font-size:clamp(32px,7vw,52px);font-weight:300;line-height:1.15;letter-spacing:-.3px;color:var(--dark);margin-bottom:48px;opacity:0;transform:translateY(20px);transition:opacity .8s ease,transform .8s ease}
.section-headline.visible{opacity:1;transform:none}
.service-item{display:flex;align-items:flex-start;gap:20px;padding:28px 0;border-bottom:1px solid rgba(14,12,9,.1);opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s ease}
.service-item:last-child{border-bottom:none}
.service-item.visible{opacity:1;transform:none}
.service-icon{font-size:24px;flex-shrink:0;width:48px;height:48px;background:var(--cream);border-radius:50%;display:flex;align-items:center;justify-content:center}
.service-name{font-family:var(--font-display);font-size:20px;font-weight:400;color:var(--dark);margin-bottom:4px}
.service-desc{font-size:14px;font-weight:300;color:var(--muted);line-height:1.6}

/* REVIEWS */
.reviews{background:var(--dark2);padding:100px 28px;position:relative;overflow:hidden}
.reviews::before{content:'';position:absolute;top:0;left:0;right:0;height:120px;background:linear-gradient(to bottom,var(--warm-white),transparent);opacity:.05;pointer-events:none}
.reviews-inner{max-width:680px;margin:0 auto}
.reviews-header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:56px;flex-wrap:wrap;gap:16px}
.reviews-title{font-family:var(--font-display);font-size:clamp(28px,6vw,44px);font-weight:300;color:#fff;line-height:1.1}
.reviews-title em{font-style:italic;color:var(--accent)}
.reviews-rating-num{font-family:var(--font-display);font-size:48px;font-weight:300;color:var(--accent);line-height:1}
.reviews-rating-stars{color:var(--accent);font-size:14px;margin:4px 0}
.reviews-rating-count{font-size:12px;color:rgba(255,255,255,.4)}
.review-item{padding:40px 0;border-bottom:1px solid rgba(255,255,255,.08);opacity:0;transform:translateX(-24px);transition:opacity .8s ease,transform .8s ease}
.review-item:last-child{border-bottom:none}
.review-item.visible{opacity:1;transform:none}
.review-quote{font-family:var(--font-display);font-size:clamp(18px,4vw,24px);font-weight:300;font-style:italic;color:rgba(255,255,255,.9);line-height:1.5;margin-bottom:16px}
.review-quote::before{content:'\u201C';font-size:1.5em;color:var(--primary);vertical-align:-.15em;margin-right:4px}
.review-quote::after{content:'\u201D';font-size:1.5em;color:var(--primary);vertical-align:-.15em;margin-left:4px}
.review-attr{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);display:flex;align-items:center;gap:12px}
.review-attr-stars{color:var(--accent)}

/* WHY US */
.whyus{background:var(--cream);padding:100px 28px}
.whyus-inner{max-width:680px;margin:0 auto}
.diff-item{padding:36px 0;border-bottom:1px solid rgba(14,12,9,.1);opacity:0;transform:translateY(16px);transition:opacity .6s ease,transform .6s ease}
.diff-item:last-child{border-bottom:none}
.diff-item.visible{opacity:1;transform:none}
.diff-num{font-family:var(--font-display);font-size:11px;font-weight:400;letter-spacing:3px;color:var(--primary);margin-bottom:8px;text-transform:uppercase}
.diff-title{font-family:var(--font-display);font-size:clamp(22px,5vw,32px);font-weight:400;color:var(--dark);margin-bottom:10px}
.diff-body{font-size:15px;font-weight:300;color:var(--muted);line-height:1.7}

/* TESTIMONIAL */
.testimonial{background:var(--dark);padding:120px 28px;text-align:center;position:relative;overflow:hidden}
.testimonial::before{content:'\u201C';position:absolute;top:-20px;left:50%;transform:translateX(-50%);font-family:var(--font-display);font-size:300px;font-weight:300;color:rgba(255,255,255,.03);line-height:1;pointer-events:none;user-select:none}
.testimonial-inner{position:relative;z-index:2;max-width:580px;margin:0 auto;opacity:0;transform:translateY(24px);transition:opacity 1s ease,transform 1s ease}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{font-family:var(--font-display);font-size:clamp(22px,5vw,34px);font-weight:300;font-style:italic;color:#fff;line-height:1.5;margin-bottom:32px}
.testimonial-name{font-size:12px;font-weight:500;letter-spacing:2px;text-transform:uppercase;color:var(--primary)}
.testimonial-context{font-size:12px;font-weight:300;color:rgba(255,255,255,.4);margin-top:4px}

/* GALLERY */
.gallery{background:var(--dark2);padding:80px 0}
.gallery-header{padding:0 28px 40px;opacity:0;transform:translateY(16px);transition:opacity .8s ease,transform .8s ease}
.gallery-header.visible{opacity:1;transform:none}
.gallery-title{font-family:var(--font-display);font-size:clamp(28px,6vw,44px);font-weight:300;color:#fff}
.gallery-carousel{position:relative;overflow:hidden}
.gallery-track{display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;-ms-overflow-style:none;padding:0 28px 20px}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-slide{flex-shrink:0;width:80vw;max-width:360px;scroll-snap-align:start}
.gallery-img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:20px;display:block;opacity:0;transition:opacity .6s ease}
.gallery-img.visible{opacity:1}
.gallery-dots{display:flex;justify-content:center;gap:6px;padding-top:4px}
.gallery-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.25);transition:background .3s,width .3s}
.gallery-dot.active{width:20px;border-radius:3px;background:var(--accent)}

/* CONTACT */
.contact{background:var(--warm-white);padding:100px 28px}
.contact-inner{max-width:680px;margin:0 auto}
.contact-headline{font-family:var(--font-display);font-size:clamp(36px,8vw,60px);font-weight:300;line-height:1.1;letter-spacing:-.5px;color:var(--dark);margin-bottom:12px;opacity:0;transform:translateY(20px);transition:opacity .8s ease,transform .8s ease}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{font-style:italic;color:var(--primary)}
.contact-subline{font-size:16px;font-weight:300;color:var(--muted);line-height:1.6;margin-bottom:48px;opacity:0;transform:translateY(12px);transition:opacity .8s .1s ease,transform .8s .1s ease}
.contact-subline.visible{opacity:1;transform:none}
.contact-actions{display:flex;flex-direction:column;gap:14px;margin-bottom:48px;opacity:0;transform:translateY(12px);transition:opacity .8s .2s ease,transform .8s .2s ease}
.contact-actions.visible{opacity:1;transform:none}
.contact-wa{background:var(--primary);color:var(--dark);padding:18px 28px;border-radius:16px;font-size:16px;font-weight:600;text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;gap:10px;transition:transform .2s,opacity .2s}
.contact-wa:hover{transform:translateY(-1px);opacity:.9}
.contact-details{display:flex;flex-direction:column;gap:16px}
.contact-detail{display:flex;align-items:flex-start;gap:16px;padding:20px;background:var(--cream);border-radius:16px;opacity:0;transform:translateY(12px);transition:opacity .6s ease,transform .6s ease}
.contact-detail.visible{opacity:1;transform:none}
.contact-detail-icon{font-size:20px;flex-shrink:0;margin-top:2px}
.contact-detail-label{font-size:11px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.contact-detail-value{font-size:15px;font-weight:400;color:var(--dark);line-height:1.5}
.contact-detail-link{color:var(--primary);text-decoration:none}
.hours-grid{display:flex;flex-direction:column;gap:2px}
.hours-row{display:flex;font-size:13px;font-weight:300;color:var(--dark);padding:3px 0}

/* FOOTER */
.footer{background:var(--dark);padding:48px 28px;text-align:center}
.footer-brand{font-family:var(--font-display);font-size:22px;font-weight:300;color:#fff;margin-bottom:8px}
.footer-domain{font-size:12px;color:var(--muted);letter-spacing:.5px;margin-bottom:24px}
.footer-links{display:flex;justify-content:center;gap:20px;margin-bottom:20px;flex-wrap:wrap}
.footer-link{font-size:12px;color:rgba(255,255,255,.4);text-decoration:none;letter-spacing:.5px;transition:color .2s}
.footer-link:hover{color:var(--accent)}
.footer-copy{font-size:11px;color:rgba(255,255,255,.2)}

/* WA FLOAT */{position:fixed;bottom:24px;right:24px;z-index:90;background:#25D366;color:#fff;width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;text-decoration:none;box-shadow:0 4px 20px rgba(37,211,102,.4);transition:transform .2s}
.wa-float:hover{transform:scale(1.08)}

/* ANIMATIONS */
@keyframes heroReveal{from{transform:scale(1.08)}to{transform:scale(1)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes scrollPulse{0%,100%{opacity:.3}50%{opacity:.8}}
${particleCSS}
</style>
</head>
<body>

<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    ${!isExp ? `<a href="#about" class="nav-link">About</a>` : ''}
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Reviews</a>` : ''}
    <a href="#contact" class="nav-link">Contact</a>
    <a href="${esc(waLink)}" class="nav-link nav-wa">WhatsApp</a>
  </div>
</nav>

<section class="hero">
  ${particleElements}
  <div class="hero-bg"></div>
  ${rating ? `
  <div class="hero-rating">
    <div class="rating-num">${rating}</div>
    <div class="rating-stars">${'★'.repeat(Math.round(rating))}${'☆'.repeat(5-Math.round(rating))}</div>
    <div class="rating-count">${reviewCount} reviews</div>
  </div>` : ''}
  <div class="hero-content">
    <div class="hero-label">${esc(domain.toUpperCase())}</div>
    <h1 class="hero-h1">${esc(t.hero_h1_line1 || '')}${t.hero_h1_line2 ? `<br><em>${esc(t.hero_h1_line2)}</em>` : ''}</h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(waLink)}" class="btn-primary">💬 ${esc(t.hero_cta || 'WhatsApp Us')}</a>
      <a href="#${!isExp ? 'about' : 'services'}" class="btn-ghost">Our story ↓</a>
    </div>
  </div>
  <div class="scroll-hint">
    <div class="scroll-hint-line"></div>
    <span class="scroll-hint-text">Scroll</span>
  </div>
</section>

<div class="intro-ribbon">
  <div class="intro-ribbon-inner">
    <p class="intro-ribbon-text">${esc(t.about_pull_quote || t.hero_trust_line || '')}</p>
  </div>
</div>

${!isExp ? `
<section class="about" id="about">
  <svg class="about-botanical" viewBox="0 0 200 400" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M100 380 Q80 300 60 250 Q40 200 50 150 Q60 100 100 80 Q140 100 150 150 Q160 200 140 250 Q120 300 100 380Z" fill="white"/>
    <path d="M100 280 Q60 260 40 220 Q20 180 40 150 Q60 120 100 130 Q140 120 160 150 Q180 180 160 220 Q140 260 100 280Z" fill="white" opacity=".6"/>
    <path d="M100 200 Q70 180 60 150 Q50 120 70 100 Q90 80 100 90 Q110 80 130 100 Q150 120 140 150 Q130 180 100 200Z" fill="white" opacity=".4"/>
    <line x1="100" y1="380" x2="100" y2="80" stroke="white" stroke-width="1.5" opacity=".3"/>
    ${botanicalLeaves}
  </svg>
  <div class="about-inner">
    <div class="section-label">${esc(t.section_label_about || 'OUR STORY')}</div>
    <h2 class="about-headline">${esc(t.about_headline || '')}${t.about_headline?.includes('em>') ? '' : ''}</h2>
    <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    <p class="about-body">${esc(t.about_p1 || '')}</p>
    ${t.about_p2 ? `<p class="about-body" style="transition-delay:.4s">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

<section class="services" id="services">
  <div class="services-inner">
    <div class="section-label" style="color:var(--primary)">${esc(t.section_label_services || 'WHAT WE OFFER')}</div>
    <h2 class="section-headline">${esc(t.services_headline || '')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-item" style="transition-delay:${i*.1}s">
      <div class="service-icon">${s.icon || '✦'}</div>
      <div>
        <div class="service-name">${esc(s.name || '')}</div>
        ${!isExp && s.desc ? `<div class="service-desc">${esc(s.desc)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>

${reviews.length && !isExp ? `
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">What they <em>say about us</em></h2>
      ${rating ? `
      <div style="text-align:right">
        <div class="reviews-rating-num">${rating}</div>
        <div class="reviews-rating-stars">${'★'.repeat(Math.round(rating))}</div>
        <div class="reviews-rating-count">${reviewCount} Google reviews</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-item" style="transition-delay:${i*.15}s">
      <p class="review-quote">${esc(r.text || '')}</p>
      <div class="review-attr">
        <span class="review-attr-stars">${'★'.repeat(r.rating || 5)}</span>
        <span>${esc(r.author || '')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-label" style="color:var(--primary)">${esc(t.section_label_whyus || 'WHY CHOOSE US')}</div>
    <h2 class="section-headline">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-item" style="transition-delay:${i*.12}s">
      <div class="diff-num">0${i+1}</div>
      <div class="diff-title">${esc(d.title)}</div>
      <div class="diff-body">${esc(d.body || '')}</div>
    </div>`).join('')}
  </div>
</section>` : ''}

${t.testimonial_quote && !isExp ? `
<section class="testimonial">
  <div class="testimonial-inner">
    <p class="testimonial-quote">${esc(t.testimonial_quote)}</p>
    <div class="testimonial-name">${esc(t.testimonial_name || '')}</div>
    <div class="testimonial-context">${esc(t.testimonial_context || '')}</div>
  </div>
</section>` : ''}

${galleryPhotos.length ? `
<section class="gallery" id="gallery">
  <div class="gallery-header">
    <div class="section-label" style="color:var(--accent)">${esc(t.section_label_gallery || 'OUR WORK')}</div>
    <h2 class="gallery-title">See it for yourself</h2>
  </div>
  <div class="gallery-carousel">
    <div class="gallery-track" id="galleryTrack">
      ${galleryPhotos.map((url, i) => `<div class="gallery-slide"><img class="gallery-img" src="${esc(url)}" alt="${esc(client.business_name)}" loading="lazy"></div>`).join('')}
    </div>
    <div class="gallery-dots" id="galleryDots">
      ${galleryPhotos.map((_, i) => `<div class="gallery-dot${i === 0 ? ' active' : ''}" data-idx="${i}"></div>`).join('')}
    </div>
  </div>
</section>` : ''}

<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="section-label" style="color:var(--primary)">${esc(t.section_label_contact || 'COME SEE US')}</div>
    <h2 class="contact-headline">${esc(t.contact_headline || 'Come see us')}</h2>
    <p class="contact-subline">${esc(t.contact_subline || '')}</p>
    <div class="contact-actions">
      <a href="${esc(waLink)}" class="contact-wa">💬 ${esc(t.contact_cta || 'WhatsApp Us')}</a>
    </div>
    <div class="contact-details">
      ${client.phone ? `
      <div class="contact-detail">
        <div class="contact-detail-icon">📞</div>
        <div>
          <div class="contact-detail-label">Call us</div>
          <a href="tel:${esc(client.phone)}" class="contact-detail-value contact-detail-link">${esc(client.phone)}</a>
        </div>
      </div>` : ''}
      ${address ? `
      <div class="contact-detail" style="transition-delay:.1s">
        <div class="contact-detail-icon">📍</div>
        <div>
          <div class="contact-detail-label">Find us</div>
          <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-detail-value contact-detail-link">${esc(address)}</a>
        </div>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-detail" style="transition-delay:.2s">
        <div class="contact-detail-icon">🕐</div>
        <div>
          <div class="contact-detail-label">Hours</div>
          <div class="hours-grid">${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
      ${gbpData?.payment?.acceptsCreditCards ? `
      <div class="contact-detail" style="transition-delay:.3s">
        <div class="contact-detail-icon">💳</div>
        <div>
          <div class="contact-detail-label">Payment</div>
          <div class="contact-detail-value">Card${gbpData.payment.acceptsDebitCards ? ', debit' : ''}, cash accepted</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>


${address ? `
<section class="map-section" id="map">
  <iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
    src="https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed"
    title="Find us"></iframe>
</section>` : ''}
<footer class="footer">
  <div class="footer-brand">${esc(t.short_name || client.business_name)}</div>
  <div class="footer-domain">${esc(domain)}</div>
  <div class="footer-links">
    <a href="${esc(waLink)}" class="footer-link">WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    ${client.facebook ? `<a href="https://facebook.com/${esc(client.facebook||'')}" class="footer-link" target="_blank">Facebook</a>` : ''}
    <a href="#" class="footer-link">Back to top ↑</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)} · ${esc(domain)}</div>
</footer>

${esc(phone) ? `<div class="fab-stack"><a href="tel:${esc(phone)}" class="fab-btn fab-call" aria-label="Call">📞</a><a href="${esc(waLink)}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a></div>` : `<a href="${esc(waLink)}" class="fab-btn fab-wa" style="position:fixed;bottom:24px;right:20px;z-index:999" aria-label="WhatsApp">💬</a>`}

<script>

// Licence check — self-hosting protection
(function(){
  var slug = '${esc(client.slug)}';
  var allowed = [slug+'.websitehub.co.za', slug+'.co.za', 'preview.websitehub.co.za', 'localhost', '127.0.0.1'];
  var host = window.location.hostname.toLowerCase();
  if(!allowed.some(function(d){ return host === d || host.endsWith('.'+d); })){
    window.location.replace('https://websitehub.co.za');
  }
})();

const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>{nav.classList.toggle('scrolled',window.scrollY>60)},{passive:true});

const obs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target)}});
},{threshold:0.12,rootMargin:'0px 0px -40px 0px'});

document.querySelectorAll('.section-label,.about-headline,.about-pull,.about-body,.section-headline,.service-item,.review-item,.diff-item,.testimonial-inner,.contact-headline,.contact-subline,.contact-actions,.contact-detail,.gallery-img,.gallery-header,.intro-ribbon-text').forEach(el=>obs.observe(el));

document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{

// Gallery carousel dots
const track = document.getElementById('galleryTrack');
const dots  = document.querySelectorAll('.gallery-dot');
if (track && dots.length) {
  track.addEventListener('scroll', () => {
    const idx = Math.round(track.scrollLeft / track.offsetWidth);
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
  }, { passive: true });
  dots.forEach((d, i) => {
    d.addEventListener('click', () => {
      const slide = track.querySelectorAll('.gallery-slide')[i];
      if (slide) slide.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    });
  });
}
    const t=document.querySelector(a.getAttribute('href'));
    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}
  });
});

// Counters
(function(){
  var s='${client.slug}';
  if(!s)return;
  new Image().src='/'+s+'/ping';
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(a){
    a.addEventListener('click',function(){new Image().src='/'+s+'/wa';},{once:true,passive:true});
  });
})();
</script>
</body>
</html>`;
}

/**
 * EMERGENCY ARCHETYPE — The Man Who Shows Up
 *
 * For: plumber, electrician, locksmith, HVAC, handyman, appliance repair,
 *      pest control, security, towing, roofing, waterproofing, welding,
 *      gates, solar installation, pool service, fire protection
 *
 * Feel: Dark workshop. Sawdust in the air. The smell of hard work.
 *       Tough, quick to act, dependable. Not urgent in a stressful way —
 *       urgent in a "someone has your back" way. The phone number is always
 *       visible. Everything snaps into place. No slow fades.
 *       The tools are the texture. The skill is the story.
 */

function generateEmergencyHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone   = (client.phone || '').replace(/\D/g, '');
  const domain  = client.domain || (pkg === 'hub_pro' || pkg === 'premium' ? `${client.slug}.co.za` : `${client.slug}.websitehub.co.za`);
  const waLink  = `https://wa.me/${phone}`;
  const callLink = `tel:${client.phone || ''}`;
  const isExp   = pkg === 'express';

  const primary = brandBrief?.primary_colour || '#e85d04';
  const accent  = brandBrief?.accent_colour  || '#ffd700';
  const svcs    = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';
  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

  // Format phone for display — strip country code, add leading zero
  const phoneDisplay = client.phone
    ? client.phone.replace(/^\+?27/, '0').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')
    : '';

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Industry-specific availability line
  const industry = (cards?.industry || client.industry || '').toLowerCase();
  const availability =
    /electric|plumb|lock|geyser|burst|leak/.test(industry) ? '24/7 Emergency Response' :
    /tow|recov/.test(industry)                              ? 'Available Day & Night' :
    /securi|alarm|cctv/.test(industry)                      ? '24/7 Monitoring & Response' :
    'Available When You Need Us';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(t.page_title || client.business_name)}</title>
<meta name="description" content="${esc(t.meta_description || '')}">
<meta property="og:title" content="${esc(client.business_name)}">
<meta property="og:description" content="${esc(t.hero_subline || '')}">
<meta property="og:image" content="${esc(heroUrl)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,400;0,600;0,700;0,800;0,900;1,700&family=Barlow:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --dark:#0a0908;
  --dark2:#111009;
  --steel:#1c1b19;
  --iron:#2a2825;
  --rust:${primary};
  --warm-grey:#8c8880;
  --light:#f0ede8;
  --font-display:'Barlow Condensed',Impact,sans-serif;
  --font-body:'Barlow',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--dark);color:var(--light);overflow-x:hidden}

/* ── GRAIN TEXTURE — over everything ─────── */
body::before{
  content:'';position:fixed;inset:0;
  background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E");
  pointer-events:none;z-index:999;opacity:.4;
}

/* ── ALWAYS-VISIBLE PHONE STRIP ──────────── */
.phone-strip{
  position:fixed;top:0;left:0;right:0;z-index:200;
  background:var(--rust);
  display:flex;align-items:center;justify-content:center;
  gap:12px;padding:10px 20px;
  font-family:var(--font-display);
  font-size:15px;font-weight:700;letter-spacing:1px;
}
.phone-strip a{color:#000;text-decoration:none;display:flex;align-items:center;gap:8px}
.phone-strip-label{font-size:11px;font-weight:600;letter-spacing:2px;opacity:.7;text-transform:uppercase}

/* ── NAV ──────────────────────────────────── */

.gallery{padding:60px 0;background:var(--bg,#0e0c09)}
.gallery-header{padding:0 24px 28px;text-align:center}
.gallery-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.5;margin-bottom:8px}
.gallery-title{font-size:26px;font-weight:700;margin-bottom:6px}
.gallery-subtitle{font-size:14px;opacity:.6}
.gallery-track{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 24px 16px}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-slide{flex:0 0 72vw;max-width:280px;scroll-snap-align:start;border-radius:14px;overflow:hidden;aspect-ratio:4/3}
.gallery-img{width:100%;height:100%;object-fit:cover;display:block}


.map-section{padding:0}
.map-embed{width:100%;height:220px;border:none;display:block;filter:grayscale(20%)}

.nav{
  position:fixed;top:40px;left:0;right:0;z-index:100;
  display:flex;align-items:center;justify-content:space-between;
  padding:16px 24px;
  background:transparent;
  transition:background .3s;
}
.nav.scrolled{background:rgba(10,9,8,.92);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.nav-brand{
  font-family:var(--font-display);
  font-size:20px;font-weight:800;letter-spacing:1px;
  color:var(--light);text-decoration:none;text-transform:uppercase;
}
.nav-links{display:flex;align-items:center;gap:14px;flex-shrink:0}
.nav-link{
  color:rgba(255,255,255,.7);font-size:13px;font-weight:500;
  letter-spacing:.5px;text-decoration:none;text-transform:uppercase;
  transition:color .15s;
}
.nav-link:hover{color:var(--rust)}
.nav-call{
  display:block!important;white-space:nowrap;
  background:var(--rust);color:#000!important;
  padding:8px 16px;font-weight:700;letter-spacing:.5px;
  border-radius:4px;transition:opacity .15s;
}
.nav-call:hover{opacity:.85}

/* ── HERO ──────────────────────────────────── */
.hero{
  position:relative;
  min-height:100svh;padding-top:90px;
  display:flex;flex-direction:column;
  justify-content:flex-end;
  padding-bottom:60px;padding-left:24px;padding-right:24px;
  overflow:hidden;
}
.hero-bg{
  position:absolute;inset:0;
  background-image:url('${esc(heroUrl)}');
  background-size:cover;background-position:center;
  animation:heroSnap .4s cubic-bezier(.16,1,.3,1) both;
}
/* Heavy dark overlay — this is a workshop, not a gallery */
.hero-bg::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(
    160deg,
    rgba(10,9,8,.85) 0%,
    rgba(10,9,8,.6) 50%,
    rgba(10,9,8,.9) 100%
  );
}
/* Tool silhouette watermark */
.hero-watermark{
  position:absolute;right:-40px;top:50%;
  transform:translateY(-50%);
  opacity:.04;pointer-events:none;
  width:60vw;max-width:320px;
}
.hero-content{position:relative;z-index:2}
.hero-availability{
  display:inline-flex;align-items:center;gap:8px;
  background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);
  border-radius:3px;padding:6px 12px;
  font-size:11px;font-weight:700;letter-spacing:2px;
  text-transform:uppercase;color:var(--accent);
  margin-bottom:20px;
  animation:snapIn .3s .2s ease both;
}
.hero-availability::before{
  content:'';width:7px;height:7px;border-radius:50%;
  background:var(--accent);
  animation:pulse 1.5s infinite;
  flex-shrink:0;
}
.hero-h1{
  font-family:var(--font-display);
  font-size:clamp(60px,16vw,110px);
  font-weight:900;line-height:.92;
  letter-spacing:-1px;
  text-transform:uppercase;
  color:var(--light);
  margin-bottom:20px;
  animation:snapIn .3s .3s ease both;
}
.hero-h1 em{
  font-style:italic;color:var(--rust);
  display:block;
}
.hero-subline{
  font-size:16px;font-weight:400;
  color:rgba(255,255,255,.7);
  line-height:1.6;max-width:480px;
  margin-bottom:32px;
  animation:snapIn .3s .4s ease both;
}
.hero-ctas{
  display:flex;gap:12px;flex-wrap:wrap;
  animation:snapIn .3s .5s ease both;
}
.btn-call{
  background:var(--rust);color:#000;
  padding:16px 28px;border-radius:4px;
  font-family:var(--font-display);
  font-size:16px;font-weight:800;letter-spacing:1px;
  text-decoration:none;text-transform:uppercase;
  display:inline-flex;align-items:center;gap:10px;
  transition:transform .15s,opacity .15s;
}
.btn-call:hover{transform:translateY(-1px)}
.btn-wa{
  border:2px solid rgba(255,255,255,.3);
  color:var(--light);
  padding:16px 28px;border-radius:4px;
  font-family:var(--font-display);
  font-size:15px;font-weight:700;letter-spacing:.5px;
  text-decoration:none;text-transform:uppercase;
  transition:all .15s;
}
.btn-wa:hover{border-color:var(--rust);color:var(--rust)}

/* Rating stamp */
.hero-stamp{
  position:absolute;bottom:140px;right:24px;
  border:2px solid var(--rust);
  border-radius:4px;padding:12px;
  text-align:center;z-index:2;
  animation:snapIn .3s .8s ease both;
  background:rgba(10,9,8,.7);
  backdrop-filter:blur(4px);
  min-width:72px;
}
.stamp-rating{
  font-family:var(--font-display);
  font-size:32px;font-weight:900;
  color:var(--rust);line-height:1;
}
.stamp-stars{color:var(--accent);font-size:11px;margin:3px 0}
.stamp-count{font-size:10px;color:rgba(255,255,255,.5);letter-spacing:.5px}

/* ── TRUST BAR ──────────────────────────────── */
.trust-bar{
  background:var(--rust);
  padding:16px 24px;
  display:flex;align-items:center;justify-content:center;
  gap:32px;flex-wrap:wrap;
}
.trust-item{
  display:flex;align-items:center;gap:8px;
  font-family:var(--font-display);
  font-size:13px;font-weight:700;
  letter-spacing:1px;text-transform:uppercase;color:#000;
}
.trust-item::before{content:'✓';font-size:14px}

/* ── SERVICES ──────────────────────────────── */
.services{
  background:var(--dark2);
  padding:80px 24px;
}
.services-inner{max-width:680px;margin:0 auto}
.section-eyebrow{
  font-size:10px;font-weight:700;letter-spacing:4px;
  text-transform:uppercase;color:var(--rust);
  margin-bottom:16px;
  opacity:0;transform:translateX(-12px);
  transition:opacity .3s ease,transform .3s ease;
}
.section-eyebrow.visible{opacity:1;transform:none}
.section-h1{
  font-family:var(--font-display);
  font-size:clamp(36px,9vw,64px);
  font-weight:900;line-height:.95;
  text-transform:uppercase;letter-spacing:-1px;
  color:var(--light);margin-bottom:40px;
  opacity:0;transform:translateX(-16px);
  transition:opacity .35s .05s ease,transform .35s .05s ease;
}
.section-h1.visible{opacity:1;transform:none}
.section-h1 em{font-style:italic;color:var(--rust)}
.service-row{
  display:flex;align-items:flex-start;gap:20px;
  padding:24px 0;border-bottom:1px solid rgba(255,255,255,.07);
  opacity:0;transform:translateX(-12px);
  transition:opacity .3s ease,transform .3s ease;
}
.service-row:last-child{border-bottom:none}
.service-row.visible{opacity:1;transform:none}
.service-num{
  font-family:var(--font-display);
  font-size:13px;font-weight:700;
  color:var(--rust);letter-spacing:1px;
  min-width:28px;margin-top:3px;
}
.service-name{
  font-family:var(--font-display);
  font-size:clamp(20px,5vw,28px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--light);
  margin-bottom:4px;
}
.service-desc{
  font-size:14px;font-weight:300;
  color:var(--warm-grey);line-height:1.5;
}

/* ── ABOUT ──────────────────────────────────── */
.about{
  background:var(--steel);
  padding:80px 24px;position:relative;overflow:hidden;
}
/* Concrete texture overlay */
.about::before{
  content:'';position:absolute;inset:0;
  background:repeating-linear-gradient(
    0deg,
    transparent,transparent 2px,
    rgba(255,255,255,.015) 2px,rgba(255,255,255,.015) 3px
  );pointer-events:none;
}
.about-inner{position:relative;z-index:2;max-width:680px;margin:0 auto}
.about-headline{
  font-family:var(--font-display);
  font-size:clamp(32px,8vw,56px);
  font-weight:900;text-transform:uppercase;
  letter-spacing:-1px;line-height:.95;
  color:var(--light);margin-bottom:24px;
  opacity:0;transform:translateY(16px);
  transition:opacity .35s ease,transform .35s ease;
}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{display:block;font-style:italic;color:var(--rust)}
.about-pull{
  font-size:18px;font-weight:400;
  color:rgba(255,255,255,.8);line-height:1.6;
  border-left:3px solid var(--rust);
  padding-left:20px;margin-bottom:24px;
  opacity:0;transform:translateY(12px);
  transition:opacity .35s .1s ease,transform .35s .1s ease;
}
.about-pull.visible{opacity:1;transform:none}
.about-body{
  font-size:15px;font-weight:300;
  color:var(--warm-grey);line-height:1.8;
  margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .35s .2s ease,transform .35s .2s ease;
}
.about-body.visible{opacity:1;transform:none}

/* ── WHY US ──────────────────────────────────── */
.whyus{
  background:var(--dark);
  padding:80px 24px;
}
.whyus-inner{max-width:680px;margin:0 auto}
.diff-block{
  padding:28px 0;
  border-bottom:1px solid rgba(255,255,255,.07);
  opacity:0;transform:translateY(12px);
  transition:opacity .3s ease,transform .3s ease;
}
.diff-block:last-child{border-bottom:none}
.diff-block.visible{opacity:1;transform:none}
.diff-num{
  font-family:var(--font-display);
  font-size:11px;font-weight:700;
  letter-spacing:3px;color:var(--rust);
  margin-bottom:6px;text-transform:uppercase;
}
.diff-title{
  font-family:var(--font-display);
  font-size:clamp(22px,5vw,32px);
  font-weight:800;text-transform:uppercase;
  letter-spacing:.5px;color:var(--light);
  margin-bottom:8px;
}
.diff-body{
  font-size:14px;font-weight:300;
  color:var(--warm-grey);line-height:1.7;
}

/* ── REVIEWS ──────────────────────────────────── */
.reviews{
  background:var(--iron);
  padding:80px 24px;
}
.reviews-inner{max-width:680px;margin:0 auto}
.reviews-header{
  display:flex;align-items:flex-end;
  justify-content:space-between;
  margin-bottom:48px;flex-wrap:wrap;gap:16px;
}
.reviews-title{
  font-family:var(--font-display);
  font-size:clamp(32px,8vw,52px);
  font-weight:900;text-transform:uppercase;
  letter-spacing:-1px;color:var(--light);line-height:.95;
}
.reviews-title em{font-style:italic;color:var(--rust)}
.review-block{
  padding:32px 0;border-bottom:1px solid rgba(255,255,255,.07);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.review-block:last-child{border-bottom:none}
.review-block.visible{opacity:1;transform:none}
.review-text{
  font-size:16px;font-weight:400;
  color:rgba(255,255,255,.85);line-height:1.7;
  margin-bottom:16px;
}
.review-text::before{
  content:'"';
  font-family:var(--font-display);
  font-size:48px;font-weight:900;
  color:var(--rust);line-height:0;
  vertical-align:-.5em;margin-right:4px;
}
.review-meta{
  display:flex;align-items:center;gap:12px;
  font-size:11px;font-weight:700;
  letter-spacing:2px;text-transform:uppercase;
}
.review-stars{color:var(--accent)}
.review-name{color:var(--rust)}

/* ── TESTIMONIAL ──────────────────────────────── */
.testimonial{
  background:var(--rust);
  padding:80px 24px;
  text-align:center;
}
.testimonial-inner{
  max-width:560px;margin:0 auto;
  opacity:0;transform:translateY(16px);
  transition:opacity .5s ease,transform .5s ease;
}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{
  font-family:var(--font-display);
  font-size:clamp(22px,6vw,36px);
  font-weight:800;text-transform:uppercase;
  letter-spacing:-.5px;line-height:1.1;
  color:#000;margin-bottom:24px;
}
.testimonial-attr{
  font-size:12px;font-weight:700;
  letter-spacing:2px;text-transform:uppercase;color:rgba(0,0,0,.6);
}

/* ── CONTACT ──────────────────────────────────── */
.contact{
  background:var(--dark2);
  padding:80px 24px;
}
.contact-inner{max-width:680px;margin:0 auto}
.contact-headline{
  font-family:var(--font-display);
  font-size:clamp(40px,10vw,72px);
  font-weight:900;text-transform:uppercase;
  letter-spacing:-2px;line-height:.9;
  color:var(--light);margin-bottom:8px;
  opacity:0;transform:translateY(16px);
  transition:opacity .35s ease,transform .35s ease;
}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{display:block;font-style:italic;color:var(--rust)}
.contact-subline{
  font-size:16px;font-weight:300;
  color:var(--warm-grey);margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .35s .1s ease,transform .35s .1s ease;
}
.contact-subline.visible{opacity:1;transform:none}
.contact-primary{
  display:flex;flex-direction:column;gap:12px;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .35s .2s ease,transform .35s .2s ease;
}
.contact-primary.visible{opacity:1;transform:none}
.btn-contact-call{
  background:var(--rust);color:#000;
  padding:20px 28px;border-radius:4px;
  font-family:var(--font-display);
  font-size:18px;font-weight:900;letter-spacing:1px;
  text-decoration:none;text-transform:uppercase;
  display:flex;align-items:center;justify-content:center;gap:12px;
  transition:opacity .15s;
}
.btn-contact-call:hover{opacity:.9}
.btn-contact-wa{
  border:2px solid var(--rust);color:var(--rust);
  padding:18px 28px;border-radius:4px;
  font-family:var(--font-display);
  font-size:16px;font-weight:800;letter-spacing:.5px;
  text-decoration:none;text-transform:uppercase;
  display:flex;align-items:center;justify-content:center;gap:10px;
  transition:all .15s;
}
.btn-contact-wa:hover{background:var(--rust);color:#000}
.contact-details{display:flex;flex-direction:column;gap:12px}
.contact-item{
  display:flex;align-items:flex-start;gap:16px;
  padding:18px;background:var(--steel);border-radius:4px;
  border-left:3px solid var(--rust);
  opacity:0;transform:translateY(10px);
  transition:opacity .3s ease,transform .3s ease;
}
.contact-item.visible{opacity:1;transform:none}
.contact-item-icon{font-size:18px;flex-shrink:0;margin-top:2px}
.contact-item-label{
  font-size:10px;font-weight:700;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--rust);margin-bottom:4px;
}
.contact-item-value{
  font-size:15px;font-weight:400;color:var(--light);line-height:1.5;
}
.contact-item-link{color:var(--rust);text-decoration:none}
.hours-row{
  font-size:13px;font-weight:300;color:var(--light);
  padding:2px 0;display:flex;gap:8px;
}

/* ── FOOTER ──────────────────────────────────── */
.footer{
  background:var(--dark);
  border-top:1px solid rgba(255,255,255,.07);
  padding:40px 24px;
  display:flex;flex-direction:column;align-items:center;gap:16px;
  text-align:center;
}
.footer-brand{
  font-family:var(--font-display);
  font-size:20px;font-weight:900;
  letter-spacing:2px;text-transform:uppercase;color:var(--light);
}
.footer-links{display:flex;gap:20px;flex-wrap:wrap;justify-content:center}
.footer-link{
  font-size:11px;font-weight:600;
  letter-spacing:1.5px;text-transform:uppercase;
  color:rgba(255,255,255,.3);text-decoration:none;transition:color .2s;
}
.footer-link:hover{color:var(--rust)}
.footer-copy{font-size:11px;color:rgba(255,255,255,.15)}

/* ── FLOATING CALL BUTTON ──────────────────── */
.call-float{
  position:fixed;bottom:24px;right:24px;z-index:90;
  background:var(--rust);color:#000;
  width:60px;height:60px;border-radius:4px;
  display:flex;flex-direction:column;align-items:center;justify-content:center;
  font-family:var(--font-display);
  font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase;
  text-decoration:none;gap:2px;
  box-shadow:0 4px 20px rgba(0,0,0,.5);
  transition:transform .15s;
}
.call-float:hover{transform:scale(1.05)}
.call-float-icon{font-size:22px}

/* ── ANIMATIONS ──────────────────────────────── */
@keyframes heroSnap{from{transform:scale(1.03)}to{transform:scale(1)}}
@keyframes snapIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(.8)}}
</style>
</head>
<body>

<!-- Always-visible phone strip -->
<div class="phone-strip">
  <span class="phone-strip-label">${esc(availability)}</span>
  <a href="${esc(callLink)}">📞 ${esc(phoneDisplay || client.phone || '')}</a>
</div>

<!-- Nav -->
<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    ${!isExp ? `<a href="#about" class="nav-link">About</a>` : ''}
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Reviews</a>` : ''}
    <a href="#contact" class="nav-link">Contact</a>
    <a href="${esc(callLink)}" class="nav-link nav-call">Call Now</a>
  </div>
</nav>

<!-- Hero -->
<section class="hero">
  <div class="hero-bg"></div>
  <!-- Tool silhouette watermark SVG -->
  <svg class="hero-watermark" viewBox="0 0 200 400" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M80 20 L120 20 L130 60 L140 380 L60 380 L70 60 Z" fill="white"/>
    <rect x="60" y="55" width="80" height="12" rx="2" fill="white" opacity=".5"/>
    <rect x="70" y="30" width="60" height="8" rx="2" fill="white" opacity=".3"/>
    <path d="M90 380 L110 380 L115 340 L85 340 Z" fill="white" opacity=".6"/>
  </svg>

  ${rating ? `
  <div class="hero-stamp">
    <div class="stamp-rating">${rating}</div>
    <div class="stamp-stars">${'★'.repeat(Math.round(rating))}</div>
    <div class="stamp-count">${reviewCount} reviews</div>
  </div>` : ''}

  <div class="hero-content">
    <div class="hero-availability">
      <span></span>${esc(availability)}
    </div>
    <h1 class="hero-h1">
      ${esc(t.hero_h1_line1 || '')}
      ${t.hero_h1_line2 ? `<em>${esc(t.hero_h1_line2)}</em>` : ''}
    </h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(callLink)}" class="btn-call">📞 Call Now</a>
      <a href="${esc(waLink)}" class="btn-wa">💬 WhatsApp</a>
    </div>
  </div>
</section>

<!-- Trust bar -->
<div class="trust-bar">
  <div class="trust-item">${esc(availability)}</div>
  <div class="trust-item">Free Quote</div>
  <div class="trust-item">Guaranteed Work</div>
  ${gbpData?.payment?.acceptsCreditCards ? `<div class="trust-item">Card Accepted</div>` : ''}
</div>

<!-- Services -->
<section class="services" id="services">
  <div class="services-inner">
    <div class="section-eyebrow">${esc(t.section_label_services || 'WHAT WE DO')}</div>
    <h2 class="section-h1">${esc(t.services_headline || '')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-row" style="transition-delay:${i*.07}s">
      <div class="service-num">0${i+1}</div>
      <div>
        <div class="service-name">${esc(s.name || '')}</div>
        ${!isExp && s.desc ? `<div class="service-desc">${esc(s.desc)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>

${!isExp ? `
<!-- About -->
<section class="about" id="about">
  <div class="about-inner">
    <div class="section-eyebrow">${esc(t.section_label_about || 'WHO WE ARE')}</div>
    <h2 class="about-headline">${esc(t.about_headline || '')}</h2>
    <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    <p class="about-body">${esc(t.about_p1 || '')}</p>
    ${t.about_p2 ? `<p class="about-body" style="transition-delay:.3s">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<!-- Why Us -->
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-eyebrow">${esc(t.section_label_whyus || 'WHY US')}</div>
    <h2 class="section-h1" style="margin-bottom:8px">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-block" style="transition-delay:${i*.08}s">
      <div class="diff-num">0${i+1}</div>
      <div class="diff-title">${esc(d.title)}</div>
      <div class="diff-body">${esc(d.body || '')}</div>
    </div>`).join('')}
  </div>
</section>` : ''}

${reviews.length && !isExp ? `
<!-- Reviews -->
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">What they <em>say</em></h2>
      ${rating ? `
      <div style="text-align:right">
        <div style="font-family:var(--font-display);font-size:44px;font-weight:900;color:var(--rust);line-height:1">${rating}</div>
        <div style="color:var(--accent);font-size:14px">${'★'.repeat(Math.round(rating))}</div>
        <div style="font-size:11px;color:rgba(255,255,255,.4);letter-spacing:1px">${reviewCount} REVIEWS</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-block" style="transition-delay:${i*.1}s">
      <p class="review-text">${esc(r.text || '')}</p>
      <div class="review-meta">
        <span class="review-stars">${'★'.repeat(r.rating || 5)}</span>
        <span class="review-name">${esc(r.author || '')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${t.testimonial_quote && !isExp ? `
<!-- Testimonial -->
<section class="testimonial">
  <div class="testimonial-inner">
    <p class="testimonial-quote">${esc(t.testimonial_quote)}</p>
    <div class="testimonial-attr">${esc(t.testimonial_name || '')} · ${esc(t.testimonial_context || '')}</div>
  </div>
</section>` : ''}

${galleryPhotos.length ? `
<section style="background:var(--surface);padding:80px 0">
  <div style="padding:0 28px 32px">
    <div style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:var(--accent);margin-bottom:8px">${esc(t.section_label_gallery || 'OUR WORK')}</div>
    <h2 style="font-size:clamp(28px,6vw,40px);font-weight:800;color:var(--fg);line-height:1.1">See the results</h2>
  </div>
  <div style="overflow:hidden">
    <div id="galleryTrack" style="display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 28px 16px">
      ${galleryPhotos.map((url,i) => `<div style="flex-shrink:0;width:78vw;max-width:320px;scroll-snap-align:start"><img src="${esc(url)}" alt="${esc(client.business_name)}" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:16px;display:block" loading="lazy"></div>`).join('')}
    </div>
    <div id="galleryDots" style="display:flex;justify-content:center;gap:6px;padding-bottom:8px">
      ${galleryPhotos.map((_,i) => `<div class="gdot" data-idx="${i}" style="width:${i===0?'20px':'6px'};height:6px;border-radius:3px;background:${i===0?'var(--accent)':'rgba(255,255,255,.2)'};cursor:pointer;transition:all .3s"></div>`).join('')}
    </div>
  </div>
</section>` : ''}

<!-- Contact -->
<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="section-eyebrow">${esc(t.section_label_contact || 'GET IN TOUCH')}</div>
    <h2 class="contact-headline">${esc(t.contact_headline || 'Call us')} <em>${esc(t.contact_subline || 'We answer.')}</em></h2>
    <div class="contact-primary">
      <a href="${esc(callLink)}" class="btn-contact-call">📞 ${esc(client.phone || 'Call Now')}</a>
      <a href="${esc(waLink)}" class="btn-contact-wa">💬 ${esc(t.contact_cta || 'WhatsApp Us')}</a>
    </div>
    <div class="contact-details">
      ${address ? `
      <div class="contact-item">
        <div class="contact-item-icon">📍</div>
        <div>
          <div class="contact-item-label">Find Us</div>
          <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-item-value contact-item-link">${esc(address)}</a>
        </div>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-item" style="transition-delay:.1s">
        <div class="contact-item-icon">🕐</div>
        <div>
          <div class="contact-item-label">Hours</div>
          <div>${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
      ${gbpData?.payment?.acceptsCreditCards ? `
      <div class="contact-item" style="transition-delay:.2s">
        <div class="contact-item-icon">💳</div>
        <div>
          <div class="contact-item-label">Payment</div>
          <div class="contact-item-value">Card${gbpData.payment.acceptsDebitCards ? ', debit' : ''}, cash accepted</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>

<!-- Footer -->

${address ? `
<section class="map-section" id="map">
  <iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
    src="https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed"
    title="Find us"></iframe>
</section>` : ''}
<footer class="footer">
  <div class="footer-brand">${esc(t.short_name || client.business_name)}</div>
  <div class="footer-links">
    <a href="${esc(callLink)}" class="footer-link">📞 Call</a>
    <a href="${esc(waLink)}" class="footer-link">💬 WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    <a href="#" class="footer-link">Back to top ↑</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)} · ${esc(domain)}</div>
</footer>

<!-- Floating call button -->
<a href="${esc(callLink)}" class="call-float" aria-label="Call Now">
  <span class="call-float-icon">📞</span>
  <span>CALL</span>
</a>

<script>

// Licence check — self-hosting protection
(function(){
  var slug = '${esc(client.slug)}';
  var allowed = [slug+'.websitehub.co.za', slug+'.co.za', 'preview.websitehub.co.za', 'localhost', '127.0.0.1'];
  var host = window.location.hostname.toLowerCase();
  if(!allowed.some(function(d){ return host === d || host.endsWith('.'+d); })){
    window.location.replace('https://websitehub.co.za');
  }
})();

// Nav scroll
const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>{nav.classList.toggle('scrolled',window.scrollY>56)},{passive:true});

// Intersection observer — snap in
const obs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target)}});
},{threshold:0.12,rootMargin:'0px 0px -32px 0px'});

document.querySelectorAll('.section-eyebrow,.section-h1,.service-row,.about-headline,.about-pull,.about-body,.diff-block,.review-block,.testimonial-inner,.contact-headline,.contact-subline,.contact-primary,.contact-item').forEach(el=>obs.observe(el));

// Smooth scroll
document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{
    const t=document.querySelector(a.getAttribute('href'));
    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}
  });
});

// Gallery carousel
(function(){
  const track=document.getElementById('galleryTrack');
  const dots=document.querySelectorAll('.gdot');
  if(!track||!dots.length)return;
  track.addEventListener('scroll',function(){
    const slide=track.querySelector('div');
    const idx=Math.round(track.scrollLeft/((slide?.offsetWidth||300)+12));
    dots.forEach(function(d,i){
      d.style.width=i===idx?'20px':'6px';
      d.style.background=i===idx?'var(--accent)':'rgba(255,255,255,.2)';
    });
  },{passive:true});
  dots.forEach(function(d,i){
    d.addEventListener('click',function(){
      const slides=track.querySelectorAll(':scope > div');
      if(slides[i])slides[i].scrollIntoView({behavior:'smooth',block:'nearest',inline:'start'});
    });
  });
})();

// Counters
(function(){
  var s='${client.slug}';
  if(!s)return;
  new Image().src='/'+s+'/ping';
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(a){
    a.addEventListener('click',function(){new Image().src='/'+s+'/wa';},{once:true,passive:true});
  });
})();
</script>

<style>
.fab-stack{position:fixed;bottom:24px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:999}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.3);text-decoration:none;font-size:22px;transition:transform .2s}
.fab-btn:hover{transform:scale(1.08)}
.fab-wa{background:#25D366}
.fab-call{background:#007AFF}
</style>

${phone ? `<div class="fab-stack">
  <a href="tel:${esc(phone)}" class="fab-btn fab-call" aria-label="Call">📞</a>
  <a href="${esc(waLink)}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a>
</div>` : `<a href="${esc(waLink)}" class="fab-btn fab-wa" style="position:fixed;bottom:24px;right:20px;z-index:999" aria-label="WhatsApp">💬</a>`}

</body>
</html>`;
}

/**
 * TRUST ARCHETYPE — Where Professionalism Lives
 *
 * For: lawyer, attorney, accountant, doctor, dentist, optometrist,
 *      financial advisor, estate agent, tax consultant, architect,
 *      physiotherapist, audiologist, specialist, bond originator
 *
 * Feel: Boardrooms and coffee. Deep leather furniture. Composed, poised,
 *       ready to change the world. The people you depend on with your life.
 *       Clean whites and deep navies. Zero noise. The restraint IS the message.
 *       Credentials whisper authority. The CTA is an appointment, not a call.
 */

function generateTrustHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone    = (client.phone || '').replace(/\D/g, '');
  const domain   = client.domain || (pkg === 'hub_pro' || pkg === 'premium' ? `${client.slug}.co.za` : `${client.slug}.websitehub.co.za`);
  const waLink   = `https://wa.me/${phone}`;
  `tel:${client.phone || ''}`;
  const isExp    = pkg === 'express';

  const primary  = brandBrief?.primary_colour || '#1a3a6b';
  const accent   = brandBrief?.accent_colour  || '#b8902a';
  const svcs     = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';
  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

  (client.phone || '').replace(/^\+?27/, '0').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');
  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Industry-specific CTA language
  const industry = (cards?.industry || client.industry || '').toLowerCase();
  const ctaLabel =
    /legal|law|attorney|advocate/.test(industry)           ? 'Schedule a Consultation' :
    /account|tax|financial|mortgage|bond/.test(industry)   ? 'Book a Meeting' :
    /doctor|gp|dental|dentist|optom|physio|hearing/.test(industry) ? 'Book an Appointment' :
    /property|estate/.test(industry)                        ? 'Request a Valuation' :
    'Schedule a Consultation';

  const credentialLine =
    /legal|law|attorney/.test(industry)     ? 'Admitted to the Bar · South Africa' :
    /account|tax/.test(industry)            ? 'Registered with SAICA · South Africa' :
    /financial|bond|mortgage/.test(industry)? 'FSP Licensed · South Africa' :
    /doctor|gp/.test(industry)              ? 'Registered with HPCSA · South Africa' :
    /dental/.test(industry)                 ? 'Registered Dentist · South Africa' :
    /optom/.test(industry)                  ? 'Registered Optometrist · South Africa' :
    /property|estate/.test(industry)        ? 'Registered with PPRA · South Africa' :
    'Registered Professional · South Africa';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(t.page_title || client.business_name)}</title>
<meta name="description" content="${esc(t.meta_description || '')}">
<meta property="og:title" content="${esc(client.business_name)}">
<meta property="og:description" content="${esc(t.hero_subline || '')}">
<meta property="og:image" content="${esc(heroUrl)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,500;0,600;1,400;1,500&family=Source+Sans+3:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --navy:${primary};
  --gold:${accent};
  --white:#ffffff;
  --off-white:#f8f6f2;
  --light-grey:#f2f0ec;
  --mid-grey:#e8e5df;
  --text:#1a1814;
  --muted:#6b6560;
  --font-display:'Playfair Display',Georgia,serif;
  --font-body:'Source Sans 3',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--white);color:var(--text);overflow-x:hidden}

/* ── NAV ──────────────────────────────────── */

.gallery{padding:60px 0;background:var(--bg,#0e0c09)}
.gallery-header{padding:0 24px 28px;text-align:center}
.gallery-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.5;margin-bottom:8px}
.gallery-title{font-size:26px;font-weight:700;margin-bottom:6px}
.gallery-subtitle{font-size:14px;opacity:.6}
.gallery-track{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 24px 16px}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-slide{flex:0 0 72vw;max-width:280px;scroll-snap-align:start;border-radius:14px;overflow:hidden;aspect-ratio:4/3}
.gallery-img{width:100%;height:100%;object-fit:cover;display:block}


.map-section{padding:0}
.map-embed{width:100%;height:220px;border:none;display:block;filter:grayscale(20%)}

.nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  display:flex;align-items:center;justify-content:space-between;
  padding:20px 40px;
  background:rgba(255,255,255,.97);
  border-bottom:1px solid transparent;
  transition:border-color .4s,box-shadow .4s;
}
.nav.scrolled{
  border-color:var(--mid-grey);
  box-shadow:0 1px 20px rgba(0,0,0,.06);
}
.nav-brand{
  font-family:var(--font-display);
  font-size:18px;font-weight:500;
  color:var(--navy);text-decoration:none;
  letter-spacing:.3px;
}
.nav-links{display:flex;align-items:center;gap:14px;flex-shrink:0}
.nav-link{
  color:var(--muted);font-size:13px;font-weight:400;
  letter-spacing:.3px;text-decoration:none;
  transition:color .2s;
}
.nav-link:hover{color:var(--navy)}
.nav-cta{
  display:block!important;white-space:nowrap;
  background:var(--navy);color:var(--white)!important;
  padding:10px 22px;font-size:13px;font-weight:500;
  letter-spacing:.3px;border-radius:2px;
  transition:background .2s;
}
.nav-cta:hover{background:color-mix(in srgb,var(--navy) 85%,#000)}

/* ── HERO ──────────────────────────────────── */
.hero{
  padding-top:80px;
  min-height:100svh;
  display:grid;
  grid-template-columns:1fr 1fr;
  position:relative;overflow:hidden;
}
/* Left — credentials and headline */
.hero-left{
  display:flex;flex-direction:column;
  justify-content:center;
  padding:80px 48px 80px 40px;
  background:var(--white);
  position:relative;z-index:2;
}
.hero-credential{
  display:inline-flex;align-items:center;gap:10px;
  margin-bottom:32px;
  animation:fadeUp .6s .2s ease both;
}
.credential-line{
  width:32px;height:1px;background:var(--gold);
}
.credential-text{
  font-size:11px;font-weight:500;letter-spacing:2px;
  text-transform:uppercase;color:var(--gold);
}
.hero-h1{
  font-family:var(--font-display);
  font-size:clamp(36px,4vw,56px);
  font-weight:400;line-height:1.15;
  letter-spacing:-.3px;color:var(--navy);
  margin-bottom:20px;
  animation:fadeUp .6s .3s ease both;
}
.hero-h1 em{font-style:italic;color:var(--gold)}
.hero-subline{
  font-size:17px;font-weight:300;
  color:var(--muted);line-height:1.7;
  max-width:380px;margin-bottom:40px;
  animation:fadeUp .6s .4s ease both;
}
.hero-cta-wrap{
  display:flex;flex-direction:column;gap:12px;
  animation:fadeUp .6s .5s ease both;
}
.btn-primary-trust{
  background:var(--navy);color:var(--white);
  padding:16px 28px;border-radius:2px;
  font-size:14px;font-weight:500;letter-spacing:.3px;
  text-decoration:none;display:inline-flex;
  align-items:center;gap:10px;
  width:fit-content;
  transition:background .2s;
}
.btn-primary-trust:hover{background:color-mix(in srgb,var(--navy) 85%,#000)}
.btn-secondary-trust{
  color:var(--navy);font-size:13px;font-weight:400;
  text-decoration:none;display:inline-flex;
  align-items:center;gap:8px;width:fit-content;
  padding-bottom:2px;
  border-bottom:1px solid var(--mid-grey);
  transition:border-color .2s;
}
.btn-secondary-trust:hover{border-color:var(--navy)}
.hero-trust-note{
  margin-top:32px;padding-top:32px;
  border-top:1px solid var(--mid-grey);
  display:flex;align-items:center;gap:12px;
  animation:fadeUp .6s .6s ease both;
}
.trust-note-text{
  font-size:12px;font-weight:400;
  color:var(--muted);line-height:1.5;
}

/* Right — full photo */
.hero-right{
  position:relative;overflow:hidden;
}
.hero-img{
  position:absolute;inset:0;
  background-image:url('${esc(heroUrl)}');
  background-size:cover;background-position:center top;
  animation:heroReveal .8s cubic-bezier(.16,1,.3,1) both;
}
.hero-img::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(
    to right,
    rgba(255,255,255,.15) 0%,
    transparent 30%
  );
}
/* Rating badge — lower right of photo */
.hero-rating{
  position:absolute;top:76px;right:20px;
  background:rgba(255,255,255,.95);
  border:1px solid var(--mid-grey);
  border-radius:2px;padding:16px 20px;
  text-align:center;z-index:2;
  box-shadow:0 4px 20px rgba(0,0,0,.08);
  animation:fadeUp .6s 1s ease both;
}
.rating-num{
  font-family:var(--font-display);
  font-size:32px;font-weight:400;
  color:var(--navy);line-height:1;
}
.rating-stars{color:var(--gold);font-size:12px;margin:4px 0;letter-spacing:2px}
.rating-count{font-size:11px;color:var(--muted);letter-spacing:.5px}

/* Mobile hero */
@media(max-width:680px){
  .hero{grid-template-columns:1fr;grid-template-rows:auto 320px}
  .hero-left{padding:60px 24px 40px}
  .hero-h1{font-size:clamp(32px,10vw,48px)}
  .hero-right{grid-row:1;margin-top:80px;height:320px}
  .hero-img{position:absolute}
  .hero-rating{top:76px;right:20px}
}

/* ── CREDENTIALS BAR ──────────────────────── */
.cred-bar{
  background:var(--navy);
  padding:20px 40px;
  display:flex;align-items:center;
  justify-content:center;gap:48px;
  flex-wrap:wrap;
}
.cred-item{
  display:flex;align-items:center;gap:10px;
  font-size:12px;font-weight:500;
  letter-spacing:1px;text-transform:uppercase;
  color:rgba(255,255,255,.8);
}
.cred-divider{
  width:1px;height:20px;
  background:rgba(255,255,255,.2);
}

/* ── SERVICES ──────────────────────────────── */
.services{
  background:var(--white);
  padding:100px 40px;
}
.services-inner{max-width:760px;margin:0 auto}
.section-label{
  font-size:10px;font-weight:600;
  letter-spacing:4px;text-transform:uppercase;
  color:var(--gold);margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s ease,transform .5s ease;
}
.section-label.visible{opacity:1;transform:none}
.section-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,4vw,44px);
  font-weight:400;line-height:1.2;
  letter-spacing:-.2px;color:var(--navy);
  margin-bottom:56px;max-width:560px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s .05s ease,transform .5s .05s ease;
}
.section-headline.visible{opacity:1;transform:none}
.section-headline em{font-style:italic;color:var(--gold)}
.service-item{
  display:grid;grid-template-columns:80px 1fr;
  gap:24px;align-items:start;
  padding:32px 0;
  border-bottom:1px solid var(--mid-grey);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.service-item:last-child{border-bottom:none}
.service-item.visible{opacity:1;transform:none}
.service-num{
  font-family:var(--font-display);
  font-size:36px;font-weight:400;
  color:var(--mid-grey);line-height:1;
  font-style:italic;
}
.service-name{
  font-family:var(--font-display);
  font-size:20px;font-weight:500;
  color:var(--navy);margin-bottom:6px;
}
.service-desc{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.6;
}

/* ── ABOUT ──────────────────────────────────── */
.about{
  background:var(--off-white);
  padding:100px 40px;
}
.about-inner{
  max-width:760px;margin:0 auto;
  display:grid;grid-template-columns:1fr 1fr;gap:64px;
  align-items:start;
}
@media(max-width:680px){
  .about-inner{grid-template-columns:1fr;gap:32px}
}
.about-left{}
.about-right{}
.about-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,4vw,40px);
  font-weight:400;line-height:1.2;
  letter-spacing:-.2px;color:var(--navy);
  margin-bottom:24px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{font-style:italic}
.about-pull{
  font-family:var(--font-display);
  font-size:18px;font-style:italic;font-weight:400;
  color:var(--navy);line-height:1.5;
  padding-left:20px;border-left:2px solid var(--gold);
  margin-bottom:28px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.about-pull.visible{opacity:1;transform:none}
.about-body{
  font-size:15px;font-weight:300;
  color:var(--muted);line-height:1.8;
  margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .15s ease,transform .5s .15s ease;
}
.about-body.visible{opacity:1;transform:none}

/* ── WHY US ──────────────────────────────────── */
.whyus{
  background:var(--white);
  padding:100px 40px;
}
.whyus-inner{max-width:760px;margin:0 auto}
.diff-item{
  padding:36px 0;
  border-bottom:1px solid var(--mid-grey);
  display:grid;grid-template-columns:48px 1fr;gap:24px;align-items:start;
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.diff-item:last-child{border-bottom:none}
.diff-item.visible{opacity:1;transform:none}
.diff-num{
  font-family:var(--font-display);
  font-size:13px;font-weight:400;font-style:italic;
  color:var(--gold);padding-top:4px;
}
.diff-title{
  font-family:var(--font-display);
  font-size:22px;font-weight:500;
  color:var(--navy);margin-bottom:8px;
}
.diff-body{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.7;
}

/* ── REVIEWS ──────────────────────────────────── */
.reviews{
  background:var(--navy);
  padding:100px 40px;
}
.reviews-inner{max-width:760px;margin:0 auto}
.reviews-header{
  display:flex;align-items:flex-end;
  justify-content:space-between;
  margin-bottom:56px;flex-wrap:wrap;gap:24px;
}
.reviews-title{
  font-family:var(--font-display);
  font-size:clamp(28px,4vw,40px);
  font-weight:400;color:var(--white);line-height:1.2;
}
.reviews-title em{font-style:italic;color:var(--gold)}
.reviews-rating-num{
  font-family:var(--font-display);
  font-size:44px;font-weight:400;
  color:var(--gold);line-height:1;
}
.reviews-rating-stars{color:var(--gold);font-size:13px;margin:4px 0;letter-spacing:2px}
.reviews-rating-count{font-size:11px;color:rgba(255,255,255,.4);letter-spacing:.5px}
.review-item{
  padding:40px 0;
  border-bottom:1px solid rgba(255,255,255,.1);
  opacity:0;transform:translateY(12px);
  transition:opacity .5s ease,transform .5s ease;
}
.review-item:last-child{border-bottom:none}
.review-item.visible{opacity:1;transform:none}
.review-quote{
  font-family:var(--font-display);
  font-size:clamp(16px,2.5vw,20px);
  font-weight:400;font-style:italic;
  color:rgba(255,255,255,.9);line-height:1.6;
  margin-bottom:20px;
}
.review-quote::before{
  content:'\u201C';color:var(--gold);
  font-size:1.4em;vertical-align:-.1em;margin-right:3px;
}
.review-quote::after{
  content:'\u201D';color:var(--gold);
  font-size:1.4em;vertical-align:-.1em;margin-left:3px;
}
.review-attr{
  display:flex;align-items:center;gap:16px;
  font-size:12px;letter-spacing:1px;text-transform:uppercase;
}
.review-stars{color:var(--gold);letter-spacing:2px}
.review-name{color:rgba(255,255,255,.5);font-weight:500}

/* ── TESTIMONIAL ──────────────────────────────── */
.testimonial{
  background:var(--light-grey);
  padding:100px 40px;
  text-align:center;
}
.testimonial-inner{
  max-width:640px;margin:0 auto;
  opacity:0;transform:translateY(16px);
  transition:opacity .6s ease,transform .6s ease;
}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{
  font-family:var(--font-display);
  font-size:clamp(20px,3vw,28px);
  font-weight:400;font-style:italic;
  color:var(--navy);line-height:1.5;
  margin-bottom:28px;
}
.testimonial-rule{
  width:40px;height:1px;
  background:var(--gold);
  margin:0 auto 20px;
}
.testimonial-name{
  font-size:12px;font-weight:600;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--gold);
}
.testimonial-context{
  font-size:12px;font-weight:300;
  color:var(--muted);margin-top:4px;
}

/* ── CONTACT ──────────────────────────────────── */
.contact{
  background:var(--white);
  padding:100px 40px;
}
.contact-inner{
  max-width:760px;margin:0 auto;
  display:grid;grid-template-columns:1fr 1fr;gap:64px;
  align-items:start;
}
@media(max-width:680px){
  .contact-inner{grid-template-columns:1fr;gap:40px}
}
.contact-left{}
.contact-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,4vw,44px);
  font-weight:400;line-height:1.15;
  letter-spacing:-.2px;color:var(--navy);
  margin-bottom:12px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{font-style:italic;color:var(--gold)}
.contact-subline{
  font-size:15px;font-weight:300;
  color:var(--muted);line-height:1.6;
  margin-bottom:36px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.contact-subline.visible{opacity:1;transform:none}
.contact-ctas{
  display:flex;flex-direction:column;gap:12px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .2s ease,transform .5s .2s ease;
}
.contact-ctas.visible{opacity:1;transform:none}
.btn-appt{
  background:var(--navy);color:var(--white);
  padding:16px 28px;border-radius:2px;
  font-size:14px;font-weight:500;letter-spacing:.3px;
  text-decoration:none;display:flex;
  align-items:center;gap:10px;
  transition:background .2s;
}
.btn-appt:hover{background:color-mix(in srgb,var(--navy) 85%,#000)}
.btn-appt-wa{
  border:1px solid var(--mid-grey);color:var(--navy);
  padding:15px 28px;border-radius:2px;
  font-size:13px;font-weight:400;letter-spacing:.3px;
  text-decoration:none;display:flex;
  align-items:center;gap:10px;
  transition:border-color .2s;
}
.btn-appt-wa:hover{border-color:var(--navy)}
.contact-right{
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .3s ease,transform .5s .3s ease;
}
.contact-right.visible{opacity:1;transform:none}
.contact-detail{
  padding:20px 0;
  border-bottom:1px solid var(--mid-grey);
}
.contact-detail:last-child{border-bottom:none}
.contact-detail-label{
  font-size:10px;font-weight:600;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--gold);margin-bottom:6px;
}
.contact-detail-value{
  font-size:15px;font-weight:300;
  color:var(--text);line-height:1.5;
}
.contact-detail-link{color:var(--navy);text-decoration:none}
.contact-detail-link:hover{color:var(--gold)}
.hours-row{font-size:13px;color:var(--text);padding:2px 0}

/* ── FOOTER ──────────────────────────────────── */
.footer{
  background:var(--navy);
  padding:40px 40px;
  display:flex;align-items:center;
  justify-content:space-between;flex-wrap:wrap;gap:20px;
}
.footer-brand{
  font-family:var(--font-display);
  font-size:16px;font-weight:400;
  color:rgba(255,255,255,.9);
  text-decoration:none;
}
.footer-links{display:flex;gap:24px;flex-wrap:wrap}
.footer-link{
  font-size:12px;color:rgba(255,255,255,.4);
  text-decoration:none;letter-spacing:.3px;
  transition:color .2s;
}
.footer-link:hover{color:var(--gold)}
.footer-copy{
  font-size:11px;color:rgba(255,255,255,.2);
  width:100%;
}

/* ── FLOATING CTA ──────────────────────────── */
/* Dual FAB — WhatsApp + Call */
.fab-stack{position:fixed;bottom:24px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:999}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.25);text-decoration:none;font-size:22px;transition:transform .2s,box-shadow .2s}
.fab-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,.35)}
.fab-wa{background:#25D366}
.fab-call{background:#007AFF}

/* ── ANIMATIONS ──────────────────────────────── */
@keyframes heroReveal{from{transform:scale(1.04)}to{transform:scale(1)}}
@keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
</style>
</head>
<body>

<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    ${!isExp ? `<a href="#about" class="nav-link">About</a>` : ''}
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Testimonials</a>` : ''}
    <a href="#contact" class="nav-link">Contact</a>
    <a href="#contact" class="nav-link nav-cta">${esc(ctaLabel)}</a>
  </div>
</nav>

<!-- Hero — split layout -->
<section class="hero">
  <div class="hero-left">
    <div class="hero-credential">
      <div class="credential-line"></div>
      <div class="credential-text">${esc(credentialLine)}</div>
    </div>
    <h1 class="hero-h1">
      ${esc(t.hero_h1_line1 || '')}
      ${t.hero_h1_line2 ? `<br><em>${esc(t.hero_h1_line2)}</em>` : ''}
    </h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-cta-wrap">
      <a href="#contact" class="btn-primary-trust">${esc(ctaLabel)} →</a>
      <a href="${esc(waLink)}" class="btn-secondary-trust">💬 WhatsApp us</a>
    </div>
    <div class="hero-trust-note">
      <div class="credential-line"></div>
      <div class="trust-note-text">${esc(t.hero_trust_line || 'Confidential · Professional · Dependable')}</div>
    </div>
  </div>
  <div class="hero-right">
    <div class="hero-img"></div>
    ${rating ? `
    <div class="hero-rating">
      <div class="rating-num">${rating}</div>
      <div class="rating-stars">${'★'.repeat(Math.round(rating))}${'☆'.repeat(5-Math.round(rating))}</div>
      <div class="rating-count">${reviewCount} reviews</div>
    </div>` : ''}
  </div>
</section>

<!-- Credentials bar -->
<div class="cred-bar">
  <div class="cred-item">${esc(credentialLine.split('·')[0].trim())}</div>
  <div class="cred-divider"></div>
  <div class="cred-item">${esc(client.area || 'South Africa')}</div>
  <div class="cred-divider"></div>
  <div class="cred-item">Confidential Service</div>
  ${gbpData?.payment?.acceptsCreditCards ? `<div class="cred-divider"></div><div class="cred-item">Card Accepted</div>` : ''}
</div>

<!-- Services -->
<section class="services" id="services">
  <div class="services-inner">
    <div class="section-label">${esc(t.section_label_services || 'OUR SERVICES')}</div>
    <h2 class="section-headline">${esc(t.services_headline || '')} <em>for you</em></h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-item" style="transition-delay:${i*.08}s">
      <div class="service-num">0${i+1}</div>
      <div>
        <div class="service-name">${esc(s.name || '')}</div>
        ${!isExp && s.desc ? `<div class="service-desc">${esc(s.desc)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>

${!isExp ? `
<!-- About -->
<section class="about" id="about">
  <div class="about-inner">
    <div class="about-left">
      <div class="section-label">${esc(t.section_label_about || 'ABOUT US')}</div>
      <h2 class="about-headline">${esc(t.about_headline || '')}</h2>
      <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    </div>
    <div class="about-right">
      <p class="about-body">${esc(t.about_p1 || '')}</p>
      ${t.about_p2 ? `<p class="about-body" style="transition-delay:.2s">${esc(t.about_p2)}</p>` : ''}
    </div>
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<!-- Why Us -->
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-label">${esc(t.section_label_whyus || 'WHY CHOOSE US')}</div>
    <h2 class="section-headline" style="margin-bottom:8px">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-item" style="transition-delay:${i*.1}s">
      <div class="diff-num">0${i+1}.</div>
      <div>
        <div class="diff-title">${esc(d.title)}</div>
        <div class="diff-body">${esc(d.body || '')}</div>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${reviews.length && !isExp ? `
<!-- Reviews -->
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">Client <em>testimonials</em></h2>
      ${rating ? `
      <div style="text-align:right">
        <div class="reviews-rating-num">${rating}</div>
        <div class="reviews-rating-stars">${'★'.repeat(Math.round(rating))}</div>
        <div class="reviews-rating-count">${reviewCount} GOOGLE REVIEWS</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-item" style="transition-delay:${i*.12}s">
      <p class="review-quote">${esc(r.text || '')}</p>
      <div class="review-attr">
        <span class="review-stars">${'★'.repeat(r.rating || 5)}</span>
        <span class="review-name">${esc(r.author || '')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${t.testimonial_quote && !isExp ? `
<!-- Testimonial -->
<section class="testimonial">
  <div class="testimonial-inner">
    <p class="testimonial-quote">${esc(t.testimonial_quote)}</p>
    <div class="testimonial-rule"></div>
    <div class="testimonial-name">${esc(t.testimonial_name || '')}</div>
    <div class="testimonial-context">${esc(t.testimonial_context || '')}</div>
  </div>
</section>` : ''}

<!-- Contact -->
<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="contact-left">
      <div class="section-label">${esc(t.section_label_contact || 'GET IN TOUCH')}</div>
      <h2 class="contact-headline">${esc(t.contact_headline || '')} <em>${esc(t.contact_subline || '')}</em></h2>
      <div class="contact-ctas">
        <a href="${esc(waLink)}" class="btn-appt">💬 ${esc(ctaLabel)}</a>
        <a href="tel:${esc(client.phone || '')}" class="btn-appt-wa">📞 ${esc(client.phone || 'Call us')}</a>
      </div>
    </div>
    <div class="contact-right">
      ${client.phone ? `
      <div class="contact-detail">
        <div class="contact-detail-label">Telephone</div>
        <a href="tel:${esc(client.phone)}" class="contact-detail-value contact-detail-link">${esc(client.phone)}</a>
      </div>` : ''}
      ${address ? `
      <div class="contact-detail">
        <div class="contact-detail-label">Address</div>
        <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-detail-value contact-detail-link">${esc(address)}</a>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-detail">
        <div class="contact-detail-label">Office Hours</div>
        <div>${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
      </div>` : ''}
      <div class="contact-detail">
        <div class="contact-detail-label">Service Area</div>
        <div class="contact-detail-value">${esc(client.area || 'South Africa')}</div>
      </div>
    </div>
  </div>
</section>

${galleryPhotos.length ? `
<!-- Gallery -->
<section class="gallery" id="gallery">
  <div class="gallery-header">
    <div class="gallery-label">OUR WORK</div>
    <div class="gallery-title">See what we do</div>
    <div class="gallery-subtitle">Real work. Real results.</div>
  </div>
  <div class="gallery-track" id="galleryTrack">
    ${galleryPhotos.map((url,i) => `<div class="gallery-slide"><img class="gallery-img" src="${esc(url)}" alt="${esc(client.business_name)}" loading="lazy"></div>`).join('')}
  </div>
</section>` : ''}

${address ? `
<section class="map-section" id="map">
  <iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
    src="https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed"
    title="Find us"></iframe>
</section>` : ''}

<!-- Footer -->
<footer class="footer">
  <a href="#" class="footer-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="footer-links">
    <a href="${esc(waLink)}" class="footer-link">WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    ${client.facebook ? `<a href="https://facebook.com/${esc(client.facebook||'')}" class="footer-link" target="_blank">Facebook</a>` : ''}
    <a href="#" class="footer-link">Back to top ↑</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)} · ${esc(domain)}</div>
</footer>

${esc(phone) ? `<div class="fab-stack"><a href="tel:${esc(phone)}" class="fab-btn fab-call" aria-label="Call">📞</a><a href="${esc(waLink)}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a></div>` : `<a href="${esc(waLink)}" class="fab-btn fab-wa" style="position:fixed;bottom:24px;right:20px;z-index:999" aria-label="WhatsApp">💬</a>`}

<script>

// Licence check — self-hosting protection
(function(){
  var slug = '${esc(client.slug)}';
  var allowed = [slug+'.websitehub.co.za', slug+'.co.za', 'preview.websitehub.co.za', 'localhost', '127.0.0.1'];
  var host = window.location.hostname.toLowerCase();
  if(!allowed.some(function(d){ return host === d || host.endsWith('.'+d); })){
    window.location.replace('https://websitehub.co.za');
  }
})();

const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>{nav.classList.toggle('scrolled',window.scrollY>60)},{passive:true});

const obs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target)}});
},{threshold:0.12,rootMargin:'0px 0px -32px 0px'});

document.querySelectorAll('.section-label,.section-headline,.service-item,.about-headline,.about-pull,.about-body,.diff-item,.review-item,.testimonial-inner,.contact-headline,.contact-subline,.contact-ctas,.contact-right').forEach(el=>obs.observe(el));

document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{
    const t=document.querySelector(a.getAttribute('href'));
    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}
  });
});

// Counters
(function(){
  var s='${client.slug}';
  if(!s)return;
  new Image().src='/'+s+'/ping';
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(a){
    a.addEventListener('click',function(){new Image().src='/'+s+'/wa';},{once:true,passive:true});
  });
})();
</script>
</body>
</html>`;
}

/**
 * LOCAL ARCHETYPE — The Good Morning Wave
 *
 * For: barber, shisa nyama, spaza, laundry, cleaning, childcare,
 *      driving school, alterations, shoe repair, tuck shop, tavern,
 *      community centre, after school care, garden services, car wash
 *
 * Feel: The barber who knows your no.2 on the sides. The petrol attendant
 *       who washes your window without expecting a tip. Twenty years of
 *       good mornings with people whose names you don't even know.
 *       Warm amber light. Earthy tones. Handmade texture. The neighbourhood
 *       is part of the design. "Pop in and see us." The door is always open.
 */

function generateLocalHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone       = (client.phone || '').replace(/\D/g, '');
  const domain      = client.domain || (pkg === 'hub_pro' || pkg === 'premium' ? `${client.slug}.co.za` : `${client.slug}.websitehub.co.za`);
  const waLink      = `https://wa.me/${phone}`;
  const callLink    = `tel:${client.phone || ''}`;
  const isExp       = pkg === 'express';

  const primary     = brandBrief?.primary_colour || '#d4722a';
  const accent      = brandBrief?.accent_colour  || '#f5c842';
  const svcs        = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';
  const area        = client.area || '';

  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

  const phoneDisplay = (client.phone || '')
    .replace(/^\+?27/, '0')
    .replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Years in business from GBP or default
  const sinceYear = client.since_year || gbpData?.openingDate?.split('-')[0] || null;
  const yearsLine = sinceYear ? `Serving ${esc(area)} since ${sinceYear}` : `Proudly serving ${esc(area)}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(t.page_title || client.business_name)}</title>
<meta name="description" content="${esc(t.meta_description || '')}">
<meta property="og:title" content="${esc(client.business_name)}">
<meta property="og:description" content="${esc(t.hero_subline || '')}">
<meta property="og:image" content="${esc(heroUrl)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --warm-dark:#1c1208;
  --brown:#2d1f0e;
  --bark:#4a3520;
  --tan:#c4956a;
  --warm-white:#fdf8f0;
  --cream:#f5ede0;
  --parchment:#efe5d4;
  --muted:#8a7060;
  --font-display:'Fraunces',Georgia,serif;
  --font-body:'DM Sans',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--warm-white);color:var(--warm-dark);overflow-x:hidden}

/* ── HANDMADE TEXTURE — subtle paper grain ── */
body::after{
  content:'';position:fixed;inset:0;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='300' height='300' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
  pointer-events:none;z-index:998;opacity:1;
}

/* ── NAV ──────────────────────────────────── */

.gallery{padding:60px 0;background:var(--bg,#0e0c09)}
.gallery-header{padding:0 24px 28px;text-align:center}
.gallery-label{font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:.5;margin-bottom:8px}
.gallery-title{font-size:26px;font-weight:700;margin-bottom:6px}
.gallery-subtitle{font-size:14px;opacity:.6}
.gallery-track{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:0 24px 16px}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-slide{flex:0 0 72vw;max-width:280px;scroll-snap-align:start;border-radius:14px;overflow:hidden;aspect-ratio:4/3}
.gallery-img{width:100%;height:100%;object-fit:cover;display:block}


.map-section{padding:0}
.map-embed{width:100%;height:220px;border:none;display:block;filter:grayscale(20%)}

.nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  display:flex;align-items:center;justify-content:space-between;
  padding:18px 24px;
  background:transparent;
  transition:background .4s;
}
.nav.scrolled{
  background:rgba(253,248,240,.96);
  border-bottom:1px solid var(--parchment);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
}
.nav-brand{
  font-family:var(--font-display);
  font-size:18px;font-weight:400;
  color:var(--warm-dark);text-decoration:none;
}
.nav-links{display:flex;align-items:center;gap:14px;flex-shrink:0}
.nav-link{
  color:var(--muted);font-size:13px;font-weight:400;
  text-decoration:none;transition:color .2s;
}
.nav-link:hover{color:var(--primary)}
.nav-wa{
  display:block!important;white-space:nowrap;
  background:var(--primary);color:#fff!important;
  padding:9px 18px;border-radius:100px;
  font-weight:500;transition:opacity .2s;
}
.nav-wa:hover{opacity:.9}

/* ── HERO ──────────────────────────────────── */
.hero{
  position:relative;
  height:100svh;min-height:580px;
  display:flex;flex-direction:column;
  justify-content:flex-end;
  padding:0 24px 72px;overflow:hidden;
}
.hero-bg{
  position:absolute;inset:0;
  background-image:url('${esc(heroUrl)}');
  background-size:cover;background-position:center;
  animation:heroReveal 1.2s cubic-bezier(.16,1,.3,1) both;
}
/* Warm amber overlay — feels like golden hour */
.hero-bg::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(
    to bottom,
    rgba(28,18,8,.05) 0%,
    rgba(28,18,8,.15) 40%,
    rgba(28,18,8,.82) 100%
  );
}
/* Hand-drawn underline decoration */
.hero-content{position:relative;z-index:2}
.hero-neighbourhood{
  display:inline-flex;align-items:center;gap:10px;
  margin-bottom:16px;
  animation:driftUp .7s .3s ease both;
}
.neighbourhood-dot{
  width:8px;height:8px;border-radius:50%;
  background:var(--accent);flex-shrink:0;
}
.neighbourhood-text{
  font-size:12px;font-weight:500;letter-spacing:2px;
  text-transform:uppercase;color:var(--accent);
}
.hero-h1{
  font-family:var(--font-display);
  font-size:clamp(44px,12vw,80px);
  font-weight:300;line-height:1.05;
  letter-spacing:-.5px;color:#fff;
  margin-bottom:16px;
  animation:driftUp .7s .4s ease both;
}
.hero-h1 em{font-style:italic;color:var(--accent)}
.hero-subline{
  font-size:16px;font-weight:300;
  color:rgba(255,255,255,.8);line-height:1.6;
  max-width:380px;margin-bottom:32px;
  animation:driftUp .7s .5s ease both;
}
.hero-ctas{
  display:flex;gap:12px;flex-wrap:wrap;
  animation:driftUp .7s .6s ease both;
}
.btn-primary-local{
  background:var(--primary);color:#fff;
  padding:14px 26px;border-radius:100px;
  font-size:14px;font-weight:500;
  text-decoration:none;display:inline-flex;
  align-items:center;gap:8px;
  transition:transform .2s,opacity .2s;
}
.btn-primary-local:hover{transform:translateY(-1px);opacity:.9}
.btn-ghost-local{
  border:1.5px solid rgba(255,255,255,.4);color:#fff;
  padding:14px 26px;border-radius:100px;
  font-size:14px;font-weight:300;
  text-decoration:none;transition:all .2s;
}
.btn-ghost-local:hover{border-color:rgba(255,255,255,.8)}
/* Rating — warm pill */
.hero-rating{
  position:absolute;top:76px;right:20px;
  background:rgba(253,248,240,.92);
  border-radius:100px;padding:10px 16px;
  display:flex;align-items:center;gap:10px;
  z-index:2;animation:driftUp .7s 1s ease both;
  backdrop-filter:blur(4px);
}
.rating-num{
  font-family:var(--font-display);
  font-size:22px;font-weight:600;
  color:var(--warm-dark);line-height:1;
}
.rating-stars{color:var(--primary);font-size:12px}
.rating-count{font-size:11px;color:var(--muted)}
/* Scroll nudge */
.scroll-nudge{
  position:absolute;bottom:24px;left:50%;
  transform:translateX(-50%);
  font-size:11px;letter-spacing:2px;
  color:rgba(255,255,255,.4);text-transform:uppercase;
  display:flex;flex-direction:column;align-items:center;gap:6px;
  animation:fadeIn 1s 1.5s ease both;z-index:2;
}
.scroll-nudge-line{
  width:1px;height:32px;
  background:linear-gradient(to bottom,rgba(255,255,255,.4),transparent);
  animation:scrollPulse 2s infinite;
}

/* ── SINCE RIBBON ──────────────────────────── */
.since-ribbon{
  background:var(--primary);
  padding:14px 24px;
  text-align:center;
  font-family:var(--font-display);
  font-size:15px;font-weight:300;font-style:italic;
  color:#fff;letter-spacing:.3px;
}

/* ── ABOUT ──────────────────────────────────── */
.about{
  background:var(--cream);
  padding:88px 24px;position:relative;overflow:hidden;
}
/* Warm geometric shape in background */
.about::before{
  content:'';position:absolute;
  right:-80px;top:-80px;
  width:320px;height:320px;
  border-radius:50%;
  background:var(--parchment);
  opacity:.6;pointer-events:none;
}
.about-inner{position:relative;z-index:2;max-width:620px}
.section-tag{
  font-size:10px;font-weight:500;letter-spacing:3px;
  text-transform:uppercase;color:var(--primary);
  margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s ease,transform .5s ease;
}
.section-tag.visible{opacity:1;transform:none}
.about-headline{
  font-family:var(--font-display);
  font-size:clamp(32px,7vw,52px);
  font-weight:300;line-height:1.15;
  letter-spacing:-.3px;color:var(--warm-dark);
  margin-bottom:24px;
  opacity:0;transform:translateY(14px);
  transition:opacity .6s ease,transform .6s ease;
}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{font-style:italic;color:var(--primary)}
.about-pull{
  font-family:var(--font-display);
  font-size:18px;font-weight:300;font-style:italic;
  color:var(--bark);line-height:1.6;
  padding-left:20px;border-left:2px solid var(--primary);
  margin-bottom:24px;
  opacity:0;transform:translateY(10px);
  transition:opacity .6s .1s ease,transform .6s .1s ease;
}
.about-pull.visible{opacity:1;transform:none}
.about-body{
  font-size:15px;font-weight:300;
  color:var(--muted);line-height:1.8;
  margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .6s .15s ease,transform .6s .15s ease;
}
.about-body.visible{opacity:1;transform:none}

/* ── SERVICES ──────────────────────────────── */
.services{
  background:var(--warm-white);
  padding:88px 24px;
}
.services-inner{max-width:620px;margin:0 auto}
.services-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,44px);
  font-weight:300;line-height:1.15;
  color:var(--warm-dark);margin-bottom:44px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.services-headline.visible{opacity:1;transform:none}
.service-card{
  display:flex;align-items:flex-start;gap:18px;
  padding:24px 0;border-bottom:1px solid var(--parchment);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.service-card:last-child{border-bottom:none}
.service-card.visible{opacity:1;transform:none}
.service-badge{
  width:44px;height:44px;border-radius:50%;
  background:var(--cream);
  display:flex;align-items:center;justify-content:center;
  font-size:20px;flex-shrink:0;
  border:1.5px solid var(--parchment);
}
.service-name{
  font-family:var(--font-display);
  font-size:18px;font-weight:400;
  color:var(--warm-dark);margin-bottom:3px;
}
.service-desc{
  font-size:13px;font-weight:300;
  color:var(--muted);line-height:1.5;
}

/* ── REVIEWS — regulars talking ───────────── */
.reviews{
  background:var(--brown);
  padding:88px 24px;position:relative;overflow:hidden;
}
/* Warm texture circles */
.reviews::before{
  content:'';position:absolute;
  left:-100px;bottom:-100px;
  width:400px;height:400px;
  border-radius:50%;
  border:60px solid rgba(255,255,255,.03);
  pointer-events:none;
}
.reviews::after{
  content:'';position:absolute;
  right:-60px;top:-60px;
  width:240px;height:240px;
  border-radius:50%;
  border:40px solid rgba(255,255,255,.03);
  pointer-events:none;
}
.reviews-inner{position:relative;z-index:2;max-width:620px;margin:0 auto}
.reviews-header{
  margin-bottom:48px;
  display:flex;align-items:flex-end;
  justify-content:space-between;flex-wrap:wrap;gap:16px;
}
.reviews-title{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,44px);
  font-weight:300;color:#fff;line-height:1.15;
}
.reviews-title em{font-style:italic;color:var(--accent)}
.reviews-aggregate{text-align:right}
.reviews-rating-num{
  font-family:var(--font-display);
  font-size:44px;font-weight:300;
  color:var(--accent);line-height:1;
}
.reviews-rating-stars{color:var(--accent);font-size:13px;margin:3px 0}
.reviews-rating-count{font-size:11px;color:rgba(255,255,255,.4);letter-spacing:.5px}
.review-card{
  background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.08);
  border-radius:16px;padding:28px;
  margin-bottom:16px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.review-card:last-child{margin-bottom:0}
.review-card.visible{opacity:1;transform:none}
.review-text{
  font-family:var(--font-display);
  font-size:clamp(16px,3.5vw,20px);
  font-weight:300;font-style:italic;
  color:rgba(255,255,255,.9);line-height:1.6;
  margin-bottom:20px;
}
.review-text::before{
  content:'\u201C';color:var(--accent);
  font-size:1.4em;vertical-align:-.1em;margin-right:4px;
}
.review-footer{
  display:flex;align-items:center;gap:12px;
}
.review-stars{color:var(--accent);font-size:12px}
.review-name{
  font-size:12px;font-weight:500;
  letter-spacing:1px;text-transform:uppercase;
  color:rgba(255,255,255,.5);
}

/* ── WHY US ──────────────────────────────────── */
.whyus{
  background:var(--parchment);
  padding:88px 24px;
}
.whyus-inner{max-width:620px;margin:0 auto}
.diff-row{
  padding:28px 0;
  border-bottom:1px solid rgba(74,53,32,.15);
  display:flex;gap:20px;align-items:flex-start;
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.diff-row:last-child{border-bottom:none}
.diff-row.visible{opacity:1;transform:none}
.diff-icon{
  font-size:24px;flex-shrink:0;
  width:48px;height:48px;background:var(--cream);
  border-radius:50%;display:flex;
  align-items:center;justify-content:center;
  border:1.5px solid rgba(74,53,32,.1);
}
.diff-title{
  font-family:var(--font-display);
  font-size:20px;font-weight:400;
  color:var(--warm-dark);margin-bottom:6px;
}
.diff-body{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.7;
}

/* ── TESTIMONIAL ──────────────────────────────── */
.testimonial{
  background:var(--primary);
  padding:88px 24px;text-align:center;
}
.testimonial-inner{
  max-width:540px;margin:0 auto;
  opacity:0;transform:translateY(16px);
  transition:opacity .6s ease,transform .6s ease;
}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{
  font-family:var(--font-display);
  font-size:clamp(20px,5vw,30px);
  font-weight:300;font-style:italic;
  color:#fff;line-height:1.5;margin-bottom:28px;
}
.testimonial-name{
  font-size:12px;font-weight:500;
  letter-spacing:2px;text-transform:uppercase;
  color:rgba(255,255,255,.6);
}

/* ── CONTACT — "Pop in and see us" ───────── */
.contact{
  background:var(--warm-white);
  padding:88px 24px;
}
.contact-inner{max-width:620px;margin:0 auto}
.contact-headline{
  font-family:var(--font-display);
  font-size:clamp(32px,7vw,52px);
  font-weight:300;line-height:1.1;
  letter-spacing:-.3px;color:var(--warm-dark);
  margin-bottom:10px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{font-style:italic;color:var(--primary)}
.contact-directions{
  font-size:16px;font-weight:300;
  color:var(--muted);line-height:1.7;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.contact-directions.visible{opacity:1;transform:none}
.contact-actions{
  display:flex;gap:12px;flex-wrap:wrap;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .2s ease,transform .5s .2s ease;
}
.contact-actions.visible{opacity:1;transform:none}
.btn-contact-wa{
  background:var(--primary);color:#fff;
  padding:16px 28px;border-radius:100px;
  font-size:15px;font-weight:500;
  text-decoration:none;display:flex;
  align-items:center;gap:8px;
  transition:opacity .2s;
}
.btn-contact-wa:hover{opacity:.9}
.btn-contact-call{
  border:1.5px solid var(--parchment);color:var(--warm-dark);
  padding:15px 28px;border-radius:100px;
  font-size:15px;font-weight:400;
  text-decoration:none;display:flex;
  align-items:center;gap:8px;
  transition:border-color .2s;
}
.btn-contact-call:hover{border-color:var(--primary);color:var(--primary)}
.contact-cards{display:flex;flex-direction:column;gap:12px}
.contact-card{
  background:var(--cream);border-radius:16px;
  padding:20px;display:flex;gap:16px;
  align-items:flex-start;
  opacity:0;transform:translateY(10px);
  transition:opacity .4s ease,transform .4s ease;
}
.contact-card.visible{opacity:1;transform:none}
.contact-card-icon{font-size:20px;flex-shrink:0;margin-top:2px}
.contact-card-label{
  font-size:10px;font-weight:600;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--primary);margin-bottom:4px;
}
.contact-card-value{
  font-size:15px;font-weight:400;
  color:var(--warm-dark);line-height:1.5;
}
.contact-card-link{color:var(--primary);text-decoration:none}
.hours-row{font-size:13px;color:var(--warm-dark);padding:2px 0}

/* ── FOOTER ──────────────────────────────────── */
.footer{
  background:var(--warm-dark);
  padding:48px 24px;text-align:center;
}
.footer-brand{
  font-family:var(--font-display);
  font-size:20px;font-weight:300;
  color:#fff;margin-bottom:6px;
}
.footer-tagline{
  font-size:13px;font-weight:300;
  font-style:italic;color:var(--tan);
  margin-bottom:24px;
}
.footer-links{
  display:flex;justify-content:center;
  gap:20px;flex-wrap:wrap;margin-bottom:20px;
}
.footer-link{
  font-size:12px;color:rgba(255,255,255,.3);
  text-decoration:none;letter-spacing:.3px;
  transition:color .2s;
}
.footer-link:hover{color:var(--accent)}
.footer-copy{font-size:11px;color:rgba(255,255,255,.15)}

/* ── FLOATING WA ──────────────────────────── */
/* Dual FAB — WhatsApp + Call */
.fab-stack{position:fixed;bottom:24px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:999}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.25);text-decoration:none;font-size:22px;transition:transform .2s,box-shadow .2s}
.fab-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,.35)}
.fab-wa{background:#25D366}
.fab-call{background:#007AFF}

/* ── ANIMATIONS ──────────────────────────────── */
@keyframes heroReveal{from{transform:scale(1.06)}to{transform:scale(1)}}
@keyframes driftUp{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes scrollPulse{0%,100%{opacity:.3}50%{opacity:.7}}
</style>
</head>
<body>

<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    ${!isExp ? `<a href="#about" class="nav-link">Our story</a>` : ''}
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Reviews</a>` : ''}
    <a href="#contact" class="nav-link">Find us</a>
    <a href="${esc(waLink)}" class="nav-link nav-wa">WhatsApp</a>
  </div>
</nav>

<section class="hero">
  <div class="hero-bg"></div>
  ${rating ? `
  <div class="hero-rating">
    <div class="rating-num">${rating}</div>
    <div class="rating-stars">${'★'.repeat(Math.round(rating))}</div>
    <div class="rating-count">${reviewCount} reviews</div>
  </div>` : ''}
  <div class="hero-content">
    <div class="hero-neighbourhood">
      <div class="neighbourhood-dot"></div>
      <div class="neighbourhood-text">${esc(area) || esc(domain)}</div>
    </div>
    <h1 class="hero-h1">
      ${esc(t.hero_h1_line1 || '')}
      ${t.hero_h1_line2 ? `<br><em>${esc(t.hero_h1_line2)}</em>` : ''}
    </h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(waLink)}" class="btn-primary-local">💬 ${esc(t.hero_cta || 'WhatsApp Us')}</a>
      <a href="#${!isExp ? 'about' : 'services'}" class="btn-ghost-local">Our story ↓</a>
    </div>
  </div>
  <div class="scroll-nudge">
    <div class="scroll-nudge-line"></div>
    <span>Scroll</span>
  </div>
</section>

<div class="since-ribbon">${yearsLine}</div>

${!isExp ? `
<section class="about" id="about">
  <div class="about-inner">
    <div class="section-tag">${esc(t.section_label_about || 'OUR STORY')}</div>
    <h2 class="about-headline">${esc(t.about_headline || '')}</h2>
    <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    <p class="about-body">${esc(t.about_p1 || '')}</p>
    ${t.about_p2 ? `<p class="about-body" style="transition-delay:.2s">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

<section class="services" id="services">
  <div class="services-inner">
    <div class="section-tag">${esc(t.section_label_services || 'WHAT WE DO')}</div>
    <h2 class="services-headline">${esc(t.services_headline || '')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-card" style="transition-delay:${i*.08}s">
      <div class="service-badge">${s.icon || '✦'}</div>
      <div>
        <div class="service-name">${esc(s.name || '')}</div>
        ${!isExp && s.desc ? `<div class="service-desc">${esc(s.desc)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>

${reviews.length && !isExp ? `
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">What the <em>regulars say</em></h2>
      ${rating ? `
      <div class="reviews-aggregate">
        <div class="reviews-rating-num">${rating}</div>
        <div class="reviews-rating-stars">${'★'.repeat(Math.round(rating))}</div>
        <div class="reviews-rating-count">${reviewCount} GOOGLE REVIEWS</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-card" style="transition-delay:${i*.1}s">
      <p class="review-text">${esc(r.text || '')}</p>
      <div class="review-footer">
        <span class="review-stars">${'★'.repeat(r.rating || 5)}</span>
        <span class="review-name">${esc(r.author || '')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-tag">${esc(t.section_label_whyus || 'WHY US')}</div>
    <h2 class="services-headline">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-row" style="transition-delay:${i*.1}s">
      <div class="diff-icon">✦</div>
      <div>
        <div class="diff-title">${esc(d.title)}</div>
        <div class="diff-body">${esc(d.body || '')}</div>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${t.testimonial_quote && !isExp ? `
<section class="testimonial">
  <div class="testimonial-inner">
    <p class="testimonial-quote">${esc(t.testimonial_quote)}</p>
    <div class="testimonial-name">${esc(t.testimonial_name || '')}</div>
  </div>
</section>` : ''}

<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="section-tag">${esc(t.section_label_contact || 'FIND US')}</div>
    <h2 class="contact-headline">Pop in and <em>see us</em></h2>
    <p class="contact-directions">${esc(t.contact_subline || address || 'We\'re right here in the neighbourhood — come say hello.')}</p>
    <div class="contact-actions">
      <a href="${esc(waLink)}" class="btn-contact-wa">💬 ${esc(t.contact_cta || 'WhatsApp Us')}</a>
      <a href="${esc(callLink)}" class="btn-contact-call">📞 ${phoneDisplay || esc(client.phone || 'Call us')}</a>
    </div>
    <div class="contact-cards">
      ${client.phone ? `
      <div class="contact-card">
        <div class="contact-card-icon">📞</div>
        <div>
          <div class="contact-card-label">Give us a ring</div>
          <a href="${esc(callLink)}" class="contact-card-value contact-card-link">${phoneDisplay}</a>
        </div>
      </div>` : ''}
      ${address ? `
      <div class="contact-card" style="transition-delay:.1s">
        <div class="contact-card-icon">📍</div>
        <div>
          <div class="contact-card-label">You'll find us here</div>
          <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-card-value contact-card-link">${esc(address)}</a>
        </div>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-card" style="transition-delay:.2s">
        <div class="contact-card-icon">🕐</div>
        <div>
          <div class="contact-card-label">We're open</div>
          <div>${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
      ${gbpData?.payment?.acceptsCreditCards ? `
      <div class="contact-card" style="transition-delay:.3s">
        <div class="contact-card-icon">💳</div>
        <div>
          <div class="contact-card-label">Payment</div>
          <div class="contact-card-value">Card${gbpData.payment.acceptsDebitCards ? ', debit' : ''} and cash — no stress</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>

${galleryPhotos.length ? `
<!-- Gallery -->
<section class="gallery" id="gallery">
  <div class="gallery-header">
    <div class="gallery-label">OUR WORK</div>
    <div class="gallery-title">See what we do</div>
    <div class="gallery-subtitle">Real work. Real results.</div>
  </div>
  <div class="gallery-track" id="galleryTrack">
    ${galleryPhotos.map((url,i) => `<div class="gallery-slide"><img class="gallery-img" src="${esc(url)}" alt="${esc(client.business_name)}" loading="lazy"></div>`).join('')}
  </div>
</section>` : ''}

${address ? `
<section class="map-section" id="map">
  <iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
    src="https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed"
    title="Find us"></iframe>
</section>` : ''}

<footer class="footer">
  <div class="footer-brand">${esc(t.short_name || client.business_name)}</div>
  <div class="footer-tagline">${yearsLine}</div>
  <div class="footer-links">
    <a href="${esc(waLink)}" class="footer-link">WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    ${client.facebook ? `<a href="https://facebook.com/${esc(client.facebook||'')}" class="footer-link" target="_blank">Facebook</a>` : ''}
    <a href="#" class="footer-link">Back to top ↑</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)} · ${esc(domain)}</div>
</footer>

${esc(phone) ? `<div class="fab-stack"><a href="tel:${esc(phone)}" class="fab-btn fab-call" aria-label="Call">📞</a><a href="${esc(waLink)}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a></div>` : `<a href="${esc(waLink)}" class="fab-btn fab-wa" style="position:fixed;bottom:24px;right:20px;z-index:999" aria-label="WhatsApp">💬</a>`}

<script>

// Licence check — self-hosting protection
(function(){
  var slug = '${esc(client.slug)}';
  var allowed = [slug+'.websitehub.co.za', slug+'.co.za', 'preview.websitehub.co.za', 'localhost', '127.0.0.1'];
  var host = window.location.hostname.toLowerCase();
  if(!allowed.some(function(d){ return host === d || host.endsWith('.'+d); })){
    window.location.replace('https://websitehub.co.za');
  }
})();

const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>{nav.classList.toggle('scrolled',window.scrollY>60)},{passive:true});

const obs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target)}});
},{threshold:0.12,rootMargin:'0px 0px -32px 0px'});

document.querySelectorAll('.section-tag,.about-headline,.about-pull,.about-body,.services-headline,.service-card,.review-card,.diff-row,.testimonial-inner,.contact-headline,.contact-directions,.contact-actions,.contact-card').forEach(el=>obs.observe(el));

document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{
    const t=document.querySelector(a.getAttribute('href'));
    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}
  });
});

// Counters
(function(){
  var s='${client.slug}';
  if(!s)return;
  new Image().src='/'+s+'/ping';
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(a){
    a.addEventListener('click',function(){new Image().src='/'+s+'/wa';},{once:true,passive:true});
  });
})();
</script>
</body>
</html>`;
}

/**
 * RESULTS ARCHETYPE — The Invisible Backbone
 *
 * For: panel beater, flooring, renovation, landscaping, car wash,
 *      pool building, curtains/blinds, painting contractor, tiling,
 *      personal trainer, gym, before/after transformation businesses
 *
 * Feel: These are the workers we didn't know we needed. The guys behind
 *       the scenes that make us shine. Before and after is the DNA.
 *       Dark to light. Raw to refined. Broken to whole. The gallery is
 *       the hero. The testimonial is the emotional peak. The process
 *       section replaces the services list. "See what we can do for you."
 *       Quiet confidence. The work speaks.
 */

function generateResultsHTML(t, heroUrl, client, cards, pkg, gbpData, brandBrief) {
  const phone       = (client.phone || '').replace(/\D/g, '');
  const domain      = client.domain || (pkg === 'hub_pro' || pkg === 'premium' ? `${client.slug}.co.za` : `${client.slug}.websitehub.co.za`);
  const waLink      = `https://wa.me/${phone}`;
  const callLink    = `tel:${client.phone || ''}`;
  const isExp       = pkg === 'express';

  const primary     = brandBrief?.primary_colour || '#2c5f2e';
  const accent      = brandBrief?.accent_colour  || '#97bc62';
  const svcs        = t.services || [];

  const reviews     = gbpData?.reviews?.slice(0, 3) || [];
  const rating      = gbpData?.rating || null;
  const reviewCount = gbpData?.reviewCount || 0;
  const hours       = gbpData?.hours || [];
  const address     = gbpData?.address || cards?.address || client.address || '';
  const galleryPhotos = (client.gallery_photos || []).slice(0, 6);

  const phoneDisplay = (client.phone || '')
    .replace(/^\+?27/, '0')
    .replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3');

  function esc(s) {
    return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Process steps — the journey they take every client on
  const processSteps = [
    { num:'01', title: 'We come to you',      body: 'Free assessment on-site. We look, we listen, we tell you exactly what\'s possible.' },
    { num:'02', title: 'We agree on a plan',  body: 'Clear quote. Realistic timeline. No surprises. You approve before we start.' },
    { num:'03', title: 'We get to work',       body: 'The team arrives when we say. We work until it\'s done. Every time.' },
    { num:'04', title: 'You walk back in',     body: 'This is the moment. We don\'t finish until you love it.' },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(t.page_title || client.business_name)}</title>
<meta name="description" content="${esc(t.meta_description || '')}">
<meta property="og:title" content="${esc(client.business_name)}">
<meta property="og:description" content="${esc(t.hero_subline || '')}">
<meta property="og:image" content="${esc(heroUrl)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
<style>
:root{
  --primary:${primary};
  --accent:${accent};
  --dark:#0d0f0d;
  --dark2:#131513;
  --surface:#1a1f1a;
  --border:#252a25;
  --text:#f0f2f0;
  --muted:#7a8c7a;
  --light:#f4f6f4;
  --cream:#eef0ea;
  --font-display:'Syne',system-ui,sans-serif;
  --font-body:'Inter',system-ui,sans-serif;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--dark);color:var(--text);overflow-x:hidden}

/* ── NAV ──────────────────────────────────── */

.map-section{padding:0}
.map-embed{width:100%;height:220px;border:none;display:block;filter:grayscale(20%)}

.nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  display:flex;align-items:center;justify-content:space-between;
  padding:20px 28px;background:transparent;
  transition:background .3s,border-color .3s;
}
.nav.scrolled{
  background:rgba(13,15,13,.92);
  border-bottom:1px solid var(--border);
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.nav-brand{
  font-family:var(--font-display);
  font-size:17px;font-weight:700;letter-spacing:.5px;
  color:var(--text);text-decoration:none;text-transform:uppercase;
}
.nav-links{display:flex;align-items:center;gap:14px;flex-shrink:0}
.nav-link{display:none;
  color:rgba(255,255,255,.5);font-size:13px;font-weight:400;
  text-decoration:none;letter-spacing:.3px;transition:color .2s;
}
.nav-link:hover{color:var(--text)}
.nav-cta{
  display:block!important;background:var(--primary);color:var(--text)!important;
  padding:9px 20px;border-radius:6px;
  font-weight:500;letter-spacing:.3px;transition:opacity .2s;white-space:nowrap;
}
.nav-cta:hover{opacity:.85}

/* ── HERO — the after ──────────────────────── */
.hero{
  position:relative;
  height:100svh;min-height:600px;
  display:flex;flex-direction:column;
  justify-content:flex-end;
  padding:0 28px 72px;overflow:hidden;
}
.hero-bg{
  position:absolute;inset:0;
  background-image:url('${esc(heroUrl)}');
  background-size:cover;background-position:center;
  animation:heroLift .8s cubic-bezier(.16,1,.3,1) both;
}
/* Cinematic dark overlay — heavy at bottom, reveals the work */
.hero-bg::after{
  content:'';position:absolute;inset:0;
  background:linear-gradient(
    to bottom,
    rgba(13,15,13,.2) 0%,
    rgba(13,15,13,.1) 35%,
    rgba(13,15,13,.85) 100%
  );
}
/* Reveal line — a thin accent line that sweeps in */
.hero-reveal-line{
  position:absolute;top:0;left:0;right:0;
  height:3px;
  background:linear-gradient(90deg, transparent, var(--accent), transparent);
  animation:revealLine .8s .5s ease both;
  transform-origin:left;
}
.hero-content{position:relative;z-index:2}
.hero-category{
  display:inline-flex;align-items:center;gap:10px;
  margin-bottom:20px;
  animation:liftIn .5s .3s ease both;
}
.category-bar{
  width:28px;height:2px;background:var(--accent);
}
.category-text{
  font-family:var(--font-display);
  font-size:11px;font-weight:600;
  letter-spacing:3px;text-transform:uppercase;
  color:var(--accent);
}
.hero-h1{
  font-family:var(--font-display);
  font-size:clamp(44px,11vw,80px);
  font-weight:800;line-height:1;
  letter-spacing:-1px;color:var(--text);
  margin-bottom:16px;text-transform:uppercase;
  animation:liftIn .5s .4s ease both;
}
.hero-h1 em{
  font-style:normal;color:var(--accent);
  display:block;font-weight:400;
  font-size:.75em;letter-spacing:0;
  text-transform:none;font-family:var(--font-body);
  margin-top:8px;
}
.hero-subline{
  font-size:16px;font-weight:300;
  color:rgba(255,255,255,.7);line-height:1.6;
  max-width:420px;margin-bottom:36px;
  animation:liftIn .5s .5s ease both;
}
.hero-ctas{
  display:flex;gap:12px;flex-wrap:wrap;
  animation:liftIn .5s .6s ease both;
}
.btn-results-primary{
  background:var(--primary);color:var(--text);
  padding:15px 28px;border-radius:6px;
  font-size:14px;font-weight:500;letter-spacing:.3px;
  text-decoration:none;display:inline-flex;
  align-items:center;gap:8px;
  transition:opacity .2s,transform .2s;
}
.btn-results-primary:hover{opacity:.9;transform:translateY(-1px)}
.btn-results-ghost{
  border:1px solid rgba(255,255,255,.2);color:var(--text);
  padding:14px 28px;border-radius:6px;
  font-size:14px;font-weight:300;
  text-decoration:none;transition:border-color .2s;
}
.btn-results-ghost:hover{border-color:var(--accent);color:var(--accent)}
/* Rating */
.hero-rating{
  position:absolute;top:76px;right:20px;
  background:rgba(13,15,13,.8);
  border:1px solid var(--border);border-radius:8px;
  padding:14px 18px;text-align:center;z-index:2;
  animation:liftIn .5s .9s ease both;
  backdrop-filter:blur(8px);
}
.rating-num{
  font-family:var(--font-display);
  font-size:30px;font-weight:800;
  color:var(--accent);line-height:1;
}
.rating-stars{color:var(--accent);font-size:11px;margin:4px 0;letter-spacing:1px}
.rating-count{font-size:10px;color:var(--muted);letter-spacing:.5px}

/* ── STATS BAR ──────────────────────────────── */
.stats-bar{
  background:var(--primary);
  padding:20px 28px;
  display:flex;align-items:center;
  justify-content:center;gap:0;flex-wrap:wrap;
}
.stat-item{
  display:flex;flex-direction:column;align-items:center;
  padding:0 32px;border-right:1px solid rgba(255,255,255,.2);
}
.stat-item:last-child{border-right:none}
.stat-num{
  font-family:var(--font-display);
  font-size:28px;font-weight:800;
  color:var(--text);line-height:1;
}
.stat-label{
  font-size:11px;font-weight:400;
  color:rgba(255,255,255,.6);letter-spacing:1px;
  text-transform:uppercase;margin-top:4px;
}

/* ── PROCESS — the journey ─────────────────── */
.process{
  background:var(--dark2);
  padding:96px 28px;
}
.process-inner{max-width:680px;margin:0 auto}
.section-label{
  font-family:var(--font-display);
  font-size:10px;font-weight:600;
  letter-spacing:4px;text-transform:uppercase;
  color:var(--accent);margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .4s ease,transform .4s ease;
}
.section-label.visible{opacity:1;transform:none}
.section-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,44px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
  margin-bottom:48px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s .05s ease,transform .5s .05s ease;
}
.section-headline.visible{opacity:1;transform:none}
.section-headline em{color:var(--accent);font-style:normal}
.process-step{
  display:grid;grid-template-columns:56px 1fr;
  gap:20px;align-items:start;
  padding:28px 0;
  border-bottom:1px solid var(--border);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.process-step:last-child{border-bottom:none}
.process-step.visible{opacity:1;transform:none}
.step-num{
  font-family:var(--font-display);
  font-size:13px;font-weight:700;
  color:var(--accent);letter-spacing:1px;
  padding-top:4px;
}
.step-title{
  font-family:var(--font-display);
  font-size:clamp(18px,4vw,24px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--text);
  margin-bottom:8px;
}
.step-body{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.7;
}

/* ── SERVICES ──────────────────────────────── */
.services{
  background:var(--surface);
  padding:96px 28px;
}
.services-inner{max-width:680px;margin:0 auto}
.service-tile{
  display:flex;align-items:flex-start;gap:16px;
  padding:24px 0;
  border-bottom:1px solid var(--border);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.service-tile:last-child{border-bottom:none}
.service-tile.visible{opacity:1;transform:none}
.service-accent{
  width:3px;height:100%;min-height:40px;
  background:var(--accent);border-radius:2px;
  flex-shrink:0;margin-top:3px;
}
.service-name{
  font-family:var(--font-display);
  font-size:clamp(18px,4vw,22px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--text);
  margin-bottom:4px;
}
.service-desc{
  font-size:13px;font-weight:300;
  color:var(--muted);line-height:1.6;
}

/* ── ABOUT ──────────────────────────────────── */
.about{
  background:var(--dark);
  padding:96px 28px;position:relative;overflow:hidden;
}
/* Diagonal line texture */
.about::before{
  content:'';position:absolute;inset:0;
  background:repeating-linear-gradient(
    -45deg,
    transparent,transparent 40px,
    rgba(255,255,255,.01) 40px,rgba(255,255,255,.01) 41px
  );pointer-events:none;
}
.about-inner{position:relative;z-index:2;max-width:680px;margin:0 auto}
.about-headline{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,44px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
  margin-bottom:24px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.about-headline.visible{opacity:1;transform:none}
.about-headline em{color:var(--accent);font-style:normal}
.about-pull{
  font-size:18px;font-weight:300;
  color:rgba(255,255,255,.8);line-height:1.6;
  border-left:3px solid var(--accent);
  padding-left:20px;margin-bottom:28px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.about-pull.visible{opacity:1;transform:none}
.about-body{
  font-size:15px;font-weight:300;
  color:var(--muted);line-height:1.8;margin-bottom:16px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .15s ease,transform .5s .15s ease;
}
.about-body.visible{opacity:1;transform:none}

/* ── GALLERY — the proof ────────────────────── */
.gallery{
  background:var(--dark2);
  padding:80px 0;
}
.gallery-header{
  padding:0 28px 40px;
  opacity:0;transform:translateY(12px);
  transition:opacity .5s ease,transform .5s ease;
}
.gallery-header.visible{opacity:1;transform:none}
.gallery-title{
  font-family:var(--font-display);
  font-size:clamp(24px,5vw,36px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
}
.gallery-subtitle{
  font-size:14px;font-weight:300;
  color:var(--muted);margin-top:6px;
}
/* Gallery carousel */
.gallery-carousel{overflow:hidden}
.gallery-track{display:flex;gap:16px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;-ms-overflow-style:none;padding:0 28px 20px}
.gallery-track::-webkit-scrollbar{display:none}
.gallery-slide{flex-shrink:0;width:80vw;max-width:360px;scroll-snap-align:start}
.gallery-img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:20px;display:block;opacity:0;transition:opacity .6s ease}
.gallery-img.visible{opacity:1}
.gallery-dots{display:flex;justify-content:center;gap:6px;padding-top:4px}
.gallery-dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.25);transition:background .3s,width .3s}
.gallery-dot.active{width:20px;border-radius:3px;background:var(--accent)}

/* ── REVIEWS ──────────────────────────────────── */
.reviews{
  background:var(--surface);
  padding:96px 28px;
}
.reviews-inner{max-width:680px;margin:0 auto}
.reviews-header{
  display:flex;align-items:flex-end;
  justify-content:space-between;
  margin-bottom:48px;flex-wrap:wrap;gap:16px;
}
.reviews-title{
  font-family:var(--font-display);
  font-size:clamp(28px,6vw,40px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
}
.reviews-title em{color:var(--accent);font-style:normal}
.review-block{
  padding:32px 0;
  border-bottom:1px solid var(--border);
  opacity:0;transform:translateY(12px);
  transition:opacity .4s ease,transform .4s ease;
}
.review-block:last-child{border-bottom:none}
.review-block.visible{opacity:1;transform:none}
.review-text{
  font-size:16px;font-weight:300;
  color:rgba(255,255,255,.85);line-height:1.7;
  margin-bottom:16px;
}
.review-text::before{
  content:'"';font-family:var(--font-display);
  font-size:40px;font-weight:800;
  color:var(--accent);line-height:0;
  vertical-align:-.4em;margin-right:4px;
}
.review-meta{
  display:flex;align-items:center;gap:12px;
  font-size:11px;font-weight:500;
  letter-spacing:1.5px;text-transform:uppercase;
}
.review-stars{color:var(--accent)}
.review-name{color:var(--muted)}

/* ── TESTIMONIAL — the emotional peak ─────── */
.testimonial{
  background:var(--dark);
  padding:120px 28px;
  text-align:center;position:relative;overflow:hidden;
}
/* Large quote mark background */
.testimonial::before{
  content:'"';
  position:absolute;top:-60px;left:50%;
  transform:translateX(-50%);
  font-family:var(--font-display);
  font-size:400px;font-weight:800;
  color:rgba(255,255,255,.02);
  line-height:1;pointer-events:none;user-select:none;
}
.testimonial-inner{
  position:relative;z-index:2;
  max-width:600px;margin:0 auto;
  opacity:0;transform:translateY(20px);
  transition:opacity .8s ease,transform .8s ease;
}
.testimonial-inner.visible{opacity:1;transform:none}
.testimonial-quote{
  font-family:var(--font-display);
  font-size:clamp(22px,5vw,34px);
  font-weight:400;color:var(--text);
  line-height:1.4;margin-bottom:36px;
}
.testimonial-accent-line{
  width:40px;height:2px;
  background:var(--accent);
  margin:0 auto 20px;
}
.testimonial-name{
  font-family:var(--font-display);
  font-size:12px;font-weight:700;
  letter-spacing:3px;text-transform:uppercase;
  color:var(--accent);
}
.testimonial-context{
  font-size:12px;font-weight:300;
  color:var(--muted);margin-top:4px;
}

/* ── WHY US ──────────────────────────────────── */
.whyus{
  background:var(--dark2);
  padding:96px 28px;
}
.whyus-inner{max-width:680px;margin:0 auto}
.diff-item{
  padding:28px 0;
  border-bottom:1px solid var(--border);
  opacity:0;transform:translateY(10px);
  transition:opacity .4s ease,transform .4s ease;
}
.diff-item:last-child{border-bottom:none}
.diff-item.visible{opacity:1;transform:none}
.diff-num{
  font-family:var(--font-display);
  font-size:10px;font-weight:700;
  letter-spacing:3px;color:var(--accent);
  margin-bottom:6px;text-transform:uppercase;
}
.diff-title{
  font-family:var(--font-display);
  font-size:clamp(18px,4vw,24px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:.5px;color:var(--text);
  margin-bottom:8px;
}
.diff-body{
  font-size:14px;font-weight:300;
  color:var(--muted);line-height:1.7;
}

/* ── CONTACT ──────────────────────────────────── */
.contact{
  background:var(--surface);
  padding:96px 28px;
}
.contact-inner{max-width:680px;margin:0 auto}
.contact-headline{
  font-family:var(--font-display);
  font-size:clamp(32px,7vw,52px);
  font-weight:700;text-transform:uppercase;
  letter-spacing:-1px;color:var(--text);
  margin-bottom:12px;
  opacity:0;transform:translateY(14px);
  transition:opacity .5s ease,transform .5s ease;
}
.contact-headline.visible{opacity:1;transform:none}
.contact-headline em{color:var(--accent);font-style:normal}
.contact-promise{
  font-size:16px;font-weight:300;
  color:var(--muted);line-height:1.6;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .1s ease,transform .5s .1s ease;
}
.contact-promise.visible{opacity:1;transform:none}
.contact-actions{
  display:flex;gap:12px;flex-wrap:wrap;
  margin-bottom:40px;
  opacity:0;transform:translateY(10px);
  transition:opacity .5s .2s ease,transform .5s .2s ease;
}
.contact-actions.visible{opacity:1;transform:none}
.btn-contact-primary{
  background:var(--primary);color:var(--text);
  padding:16px 28px;border-radius:6px;
  font-size:15px;font-weight:500;
  text-decoration:none;display:flex;
  align-items:center;gap:8px;
  transition:opacity .2s;
}
.btn-contact-primary:hover{opacity:.9}
.btn-contact-secondary{
  border:1px solid var(--border);color:var(--text);
  padding:15px 28px;border-radius:6px;
  font-size:14px;font-weight:300;
  text-decoration:none;display:flex;
  align-items:center;gap:8px;
  transition:border-color .2s;
}
.btn-contact-secondary:hover{border-color:var(--accent);color:var(--accent)}
.contact-details{display:flex;flex-direction:column;gap:12px}
.contact-detail{
  display:flex;align-items:flex-start;gap:16px;
  padding:18px;background:var(--dark2);
  border-radius:8px;border-left:3px solid var(--accent);
  opacity:0;transform:translateY(8px);
  transition:opacity .3s ease,transform .3s ease;
}
.contact-detail.visible{opacity:1;transform:none}
.contact-detail-icon{font-size:18px;flex-shrink:0;margin-top:2px}
.contact-detail-label{
  font-size:10px;font-weight:600;
  letter-spacing:2px;text-transform:uppercase;
  color:var(--accent);margin-bottom:4px;
}
.contact-detail-value{
  font-size:15px;font-weight:300;
  color:var(--text);line-height:1.5;
}
.contact-detail-link{color:var(--accent);text-decoration:none}
.hours-row{font-size:13px;color:var(--text);padding:2px 0}

/* ── FOOTER ──────────────────────────────────── */
.footer{
  background:var(--dark);
  border-top:1px solid var(--border);
  padding:48px 28px;text-align:center;
}
.footer-brand{
  font-family:var(--font-display);
  font-size:18px;font-weight:700;
  text-transform:uppercase;letter-spacing:1px;
  color:var(--text);margin-bottom:6px;
}
.footer-tagline{
  font-size:12px;font-weight:300;
  color:var(--muted);margin-bottom:24px;
}
.footer-links{
  display:flex;justify-content:center;
  gap:20px;flex-wrap:wrap;margin-bottom:20px;
}
.footer-link{
  font-size:12px;color:rgba(255,255,255,.3);
  text-decoration:none;letter-spacing:.3px;
  transition:color .2s;
}
.footer-link:hover{color:var(--accent)}
.footer-copy{font-size:11px;color:rgba(255,255,255,.15)}

/* ── FLOATING WA ──────────────────────────── */
/* Dual FAB — WhatsApp + Call */
.fab-stack{position:fixed;bottom:24px;right:20px;display:flex;flex-direction:column;gap:10px;z-index:999}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.25);text-decoration:none;font-size:22px;transition:transform .2s,box-shadow .2s}
.fab-btn:hover{transform:scale(1.08);box-shadow:0 6px 20px rgba(0,0,0,.35)}
.fab-wa{background:#25D366}
.fab-call{background:#007AFF}

/* ── ANIMATIONS ──────────────────────────────── */
@keyframes heroLift{from{transform:scale(1.05)}to{transform:scale(1)}}
@keyframes liftIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes revealLine{from{transform:scaleX(0);opacity:0}to{transform:scaleX(1);opacity:1}}
</style>
</head>
<body>

<nav class="nav" id="nav">
  <a href="#" class="nav-brand">${esc(t.short_name || client.business_name)}</a>
  <div class="nav-links">
    <a href="#process" class="nav-link">How we work</a>
    <a href="#services" class="nav-link">Services</a>
    ${reviews.length ? `<a href="#reviews" class="nav-link">Reviews</a>` : ''}
    <a href="#contact" class="nav-link">Contact</a>
    <a href="${esc(waLink)}" class="nav-link nav-cta">Get a quote</a>
  </div>
</nav>

<section class="hero">
  <div class="hero-bg"></div>
  <div class="hero-reveal-line"></div>
  ${rating ? `
  <div class="hero-rating">
    <div class="rating-num">${rating}</div>
    <div class="rating-stars">${'★'.repeat(Math.round(rating))}</div>
    <div class="rating-count">${reviewCount} reviews</div>
  </div>` : ''}
  <div class="hero-content">
    <div class="hero-category">
      <div class="category-bar"></div>
      <div class="category-text">${esc(client.area || domain)}</div>
    </div>
    <h1 class="hero-h1">
      ${esc(t.hero_h1_line1 || '')}
      ${t.hero_h1_line2 ? `<em>${esc(t.hero_h1_line2)}</em>` : ''}
    </h1>
    <p class="hero-subline">${esc(t.hero_subline || '')}</p>
    <div class="hero-ctas">
      <a href="${esc(waLink)}" class="btn-results-primary">💬 Get a free quote</a>
      <a href="#process" class="btn-results-ghost">How we work ↓</a>
    </div>
  </div>
</section>

<!-- Stats bar -->
<div class="stats-bar">
  <div class="stat-item">
    <div class="stat-num">100%</div>
    <div class="stat-label">Satisfaction</div>
  </div>
  <div class="stat-item">
    <div class="stat-num">Free</div>
    <div class="stat-label">Site Visit</div>
  </div>
  ${rating ? `
  <div class="stat-item">
    <div class="stat-num">${rating}★</div>
    <div class="stat-label">Google Rating</div>
  </div>` : ''}
  <div class="stat-item">
    <div class="stat-num">0</div>
    <div class="stat-label">Surprises</div>
  </div>
</div>

<!-- Process -->
<section class="process" id="process">
  <div class="process-inner">
    <div class="section-label">${esc(t.section_label_services || 'HOW WE WORK')}</div>
    <h2 class="section-headline">From <em>quote to done</em></h2>
    ${processSteps.map((s,i) => `
    <div class="process-step" style="transition-delay:${i*.08}s">
      <div class="step-num">${s.num}</div>
      <div>
        <div class="step-title">${esc(s.title)}</div>
        <div class="step-body">${esc(s.body)}</div>
      </div>
    </div>`).join('')}
  </div>
</section>

<!-- Services -->
<section class="services" id="services">
  <div class="services-inner">
    <div class="section-label">${esc(t.section_label_services || 'WHAT WE DO')}</div>
    <h2 class="section-headline">${esc(t.services_headline || '')}</h2>
    ${svcs.slice(0, isExp ? 4 : 6).map((s,i) => `
    <div class="service-tile" style="transition-delay:${i*.07}s">
      <div class="service-accent"></div>
      <div>
        <div class="service-name">${esc(s.name || '')}</div>
        ${!isExp && s.desc ? `<div class="service-desc">${esc(s.desc)}</div>` : ''}
      </div>
    </div>`).join('')}
  </div>
</section>

${!isExp ? `
<!-- About -->
<section class="about" id="about">
  <div class="about-inner">
    <div class="section-label">${esc(t.section_label_about || 'WHO WE ARE')}</div>
    <h2 class="about-headline">${esc(t.about_headline || '')}</h2>
    <p class="about-pull">${esc(t.about_pull_quote || '')}</p>
    <p class="about-body">${esc(t.about_p1 || '')}</p>
    ${t.about_p2 ? `<p class="about-body" style="transition-delay:.2s">${esc(t.about_p2)}</p>` : ''}
  </div>
</section>` : ''}

${galleryPhotos.length ? `
<!-- Gallery -->
<section class="gallery" id="gallery">
  <div class="gallery-header">
    <div class="section-label">OUR WORK</div>
    <div class="gallery-title">See what we can do</div>
    <div class="gallery-subtitle">Every job finished to the same standard. No exceptions.</div>
  </div>
  <div class="gallery-carousel">
    <div class="gallery-track" id="galleryTrack">
      ${galleryPhotos.map((url,i) => `<div class="gallery-slide"><img class="gallery-img" src="${esc(url)}" alt="${esc(client.business_name)}" loading="lazy"></div>`).join('')}
    </div>
    <div class="gallery-dots" id="galleryDots">
      ${galleryPhotos.map((_,i) => `<div class="gallery-dot${i===0?' active':''}" data-idx="${i}"></div>`).join('')}
    </div>
  </div>
</section>` : ''}

${reviews.length && !isExp ? `
<!-- Reviews -->
<section class="reviews" id="reviews">
  <div class="reviews-inner">
    <div class="reviews-header">
      <h2 class="reviews-title">THE <em>PROOF</em></h2>
      ${rating ? `
      <div style="text-align:right">
        <div style="font-family:var(--font-display);font-size:44px;font-weight:800;color:var(--accent);line-height:1">${rating}</div>
        <div style="color:var(--accent);font-size:13px;letter-spacing:2px">${'★'.repeat(Math.round(rating))}</div>
        <div style="font-size:11px;color:var(--muted);letter-spacing:1px;margin-top:4px">${reviewCount} REVIEWS</div>
      </div>` : ''}
    </div>
    ${reviews.map((r,i) => `
    <div class="review-block" style="transition-delay:${i*.1}s">
      <p class="review-text">${esc(r.text || '')}</p>
      <div class="review-meta">
        <span class="review-stars">${'★'.repeat(r.rating || 5)}</span>
        <span class="review-name">${esc(r.author || '')}</span>
      </div>
    </div>`).join('')}
  </div>
</section>` : ''}

${t.testimonial_quote && !isExp ? `
<!-- Testimonial -->
<section class="testimonial">
  <div class="testimonial-inner">
    <p class="testimonial-quote">${esc(t.testimonial_quote)}</p>
    <div class="testimonial-accent-line"></div>
    <div class="testimonial-name">${esc(t.testimonial_name || '')}</div>
    <div class="testimonial-context">${esc(t.testimonial_context || '')}</div>
  </div>
</section>` : ''}

${!isExp && (t.diff1_title || t.diff2_title) ? `
<!-- Why Us -->
<section class="whyus">
  <div class="whyus-inner">
    <div class="section-label">${esc(t.section_label_whyus || 'WHY US')}</div>
    <h2 class="section-headline">${esc(t.whyus_headline || '')}</h2>
    ${[{title:t.diff1_title,body:t.diff1_body},{title:t.diff2_title,body:t.diff2_body},{title:t.diff3_title,body:t.diff3_body}].filter(d=>d.title).map((d,i) => `
    <div class="diff-item" style="transition-delay:${i*.08}s">
      <div class="diff-num">0${i+1}</div>
      <div class="diff-title">${esc(d.title)}</div>
      <div class="diff-body">${esc(d.body || '')}</div>
    </div>`).join('')}
  </div>
</section>` : ''}

<!-- Contact -->
<section class="contact" id="contact">
  <div class="contact-inner">
    <div class="section-label">${esc(t.section_label_contact || 'GET IN TOUCH')}</div>
    <h2 class="contact-headline">See what we can <em>do for you</em></h2>
    <p class="contact-promise">${esc(t.contact_subline || 'We don\'t finish until you love it. That\'s not a slogan — it\'s how we work.')}</p>
    <div class="contact-actions">
      <a href="${esc(waLink)}" class="btn-contact-primary">💬 ${esc(t.contact_cta || 'Get a free quote')}</a>
      <a href="${esc(callLink)}" class="btn-contact-secondary">📞 ${phoneDisplay || esc(client.phone || 'Call us')}</a>
    </div>
    <div class="contact-details">
      ${client.phone ? `
      <div class="contact-detail">
        <div class="contact-detail-icon">📞</div>
        <div>
          <div class="contact-detail-label">Call us</div>
          <a href="${esc(callLink)}" class="contact-detail-value contact-detail-link">${phoneDisplay}</a>
        </div>
      </div>` : ''}
      ${address ? `
      <div class="contact-detail" style="transition-delay:.1s">
        <div class="contact-detail-icon">📍</div>
        <div>
          <div class="contact-detail-label">Find us</div>
          <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener" class="contact-detail-value contact-detail-link">${esc(address)}</a>
        </div>
      </div>` : ''}
      ${hours.length ? `
      <div class="contact-detail" style="transition-delay:.2s">
        <div class="contact-detail-icon">🕐</div>
        <div>
          <div class="contact-detail-label">Hours</div>
          <div>${hours.map(h => `<div class="hours-row">${esc(h)}</div>`).join('')}</div>
        </div>
      </div>` : ''}
    </div>
  </div>
</section>


${address ? `
<section class="map-section" id="map">
  <iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade"
    src="https://www.google.com/maps?q=${encodeURIComponent(address)}&output=embed"
    title="Find us"></iframe>
</section>` : ''}
<footer class="footer">
  <div class="footer-brand">${esc(t.short_name || client.business_name)}</div>
  <div class="footer-tagline">We don't finish until you love it.</div>
  <div class="footer-links">
    <a href="${esc(waLink)}" class="footer-link">WhatsApp</a>
    ${client.instagram ? `<a href="https://instagram.com/${esc((client.instagram||'').replace('@',''))}" class="footer-link" target="_blank">Instagram</a>` : ''}
    ${client.facebook ? `<a href="https://facebook.com/${esc(client.facebook||'')}" class="footer-link" target="_blank">Facebook</a>` : ''}
    <a href="#" class="footer-link">Back to top ↑</a>
  </div>
  <div class="footer-copy">© ${new Date().getFullYear()} ${esc(client.business_name)} · ${esc(domain)}</div>
</footer>

${esc(phone) ? `<div class="fab-stack"><a href="tel:${esc(phone)}" class="fab-btn fab-call" aria-label="Call">📞</a><a href="${esc(waLink)}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a></div>` : `<a href="${esc(waLink)}" class="fab-btn fab-wa" style="position:fixed;bottom:24px;right:20px;z-index:999" aria-label="WhatsApp">💬</a>`}

<script>

// Licence check — self-hosting protection
(function(){
  var slug = '${esc(client.slug)}';
  var allowed = [slug+'.websitehub.co.za', slug+'.co.za', 'preview.websitehub.co.za', 'localhost', '127.0.0.1'];
  var host = window.location.hostname.toLowerCase();
  if(!allowed.some(function(d){ return host === d || host.endsWith('.'+d); })){
    window.location.replace('https://websitehub.co.za');
  }
})();

const nav=document.getElementById('nav');
window.addEventListener('scroll',()=>{nav.classList.toggle('scrolled',window.scrollY>60)},{passive:true});

const obs=new IntersectionObserver((entries)=>{
  entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target)}});
},{threshold:0.12,rootMargin:'0px 0px -32px 0px'});

document.querySelectorAll('.section-label,.section-headline,.process-step,.service-tile,.about-headline,.about-pull,.about-body,.gallery-header,.gallery-img,.review-block,.testimonial-inner,.diff-item,.contact-headline,.contact-promise,.contact-actions,.contact-detail').forEach(el=>obs.observe(el));

// Gallery carousel
const gTrack=document.getElementById('galleryTrack');
const gDots=document.querySelectorAll('.gallery-dot');
if(gTrack&&gDots.length){
  gTrack.addEventListener('scroll',()=>{
    const idx=Math.round(gTrack.scrollLeft/(gTrack.querySelector('.gallery-slide')?.offsetWidth+16||1));
    gDots.forEach((d,i)=>d.classList.toggle('active',i===idx));
  },{passive:true});
  gDots.forEach((d,i)=>d.addEventListener('click',()=>{
    const slides=gTrack.querySelectorAll('.gallery-slide');
    if(slides[i])slides[i].scrollIntoView({behavior:'smooth',block:'nearest',inline:'start'});
  }));
}

document.querySelectorAll('a[href^="#"]').forEach(a=>{
  a.addEventListener('click',e=>{
    const t=document.querySelector(a.getAttribute('href'));
    if(t){e.preventDefault();t.scrollIntoView({behavior:'smooth',block:'start'})}
  });
});

// Counters
(function(){
  var s='${client.slug}';
  if(!s)return;
  new Image().src='/'+s+'/ping';
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(a){
    a.addEventListener('click',function(){new Image().src='/'+s+'/wa';},{once:true,passive:true});
  });
})();
</script>
</body>
</html>`;
}

// ============================================================
// WH-BUILD — Website Hub Build Worker
// Clean rewrite — Session D10 2026-05-27
// ============================================================
// Bindings (wrangler.toml):
//   DB           — D1 database (all client data, 12 tables)
//   SITES        — KV (HTML blobs, PWA, config)
//   ASSETS       — R2 (photos, logos, gallery)
//   BUILD_QUEUE  — Queue (pre-build + substance build jobs)
// Secrets (GH Actions):
//   ANTHROPIC_KEY, UNSPLASH_ACCESS_KEY, WH_PHONE,
//   CLOUDFLARE_API_TOKEN, ADMIN_KEY, RESEND_API_KEY
// Route: preview.websitehub.co.za/*
// ============================================================


// ── CONSTANTS ─────────────────────────────────────────────────

const PREVIEW_DOMAIN   = 'preview.websitehub.co.za';
const FALLBACK_HERO    = 'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1200&q=80';
const PREVIEW_TTL      = 60 * 60 * 24 * 35; // 35 days
const CONFIG_CACHE_TTL = 300;               // 5 min browser cache

const PASS_TOKENS = {
  pre_1: 1200, pre_2: 1500, pre_3: 800,
  sub_1: 2000, sub_3: 1500,
};

// Structural CSS — fixed for all sites. Design tokens come from buildCssVariables.
const STRUCTURAL_CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:var(--bg);color:var(--fg);overflow-x:hidden}
.nav{position:fixed;top:0;left:0;right:0;height:52px;background:rgba(var(--bg-rgb,255,255,255),0.95);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);display:flex;align-items:center;justify-content:space-between;padding:0 20px;z-index:50;border-bottom:1px solid var(--border)}
.nav-brand{font-family:var(--font-heading);font-size:13px;font-weight:700;color:var(--fg);text-decoration:none;max-width:55vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nav-logo{height:32px;width:auto;object-fit:contain;max-width:120px}
.nav-links{display:flex;gap:14px;flex-shrink:0;align-items:center}
.nav-link{font-size:13px;color:var(--muted-fg);text-decoration:none;display:none}
@media(min-width:640px){.nav-link{display:block}}
.section-hero{min-height:100svh;background-size:cover;background-position:center;background-attachment:scroll;display:flex;flex-direction:column;justify-content:flex-end;padding:52px 0 56px;position:relative}
.section-hero::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,0.2) 35%,rgba(0,0,0,0.75) 65%,rgba(0,0,0,0.96) 100%)}
.hero-content{position:relative;z-index:1;padding:0 24px}
.hero-h1{font-family:var(--font-heading);font-size:clamp(36px,10vw,64px);font-weight:800;line-height:1.05;letter-spacing:-0.02em;color:#fff;margin-bottom:14px;text-shadow:0 2px 24px rgba(0,0,0,0.7),0 1px 4px rgba(0,0,0,0.5)}
.hero-sub{font-size:17px;color:rgba(255,255,255,0.92);margin-bottom:10px;line-height:1.5;font-weight:400;text-shadow:0 1px 8px rgba(0,0,0,0.6)}
.trust-line{font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:28px;letter-spacing:1.5px;text-transform:uppercase;font-family:var(--font-body)}
.section{background:var(--bg);padding:72px 24px;border-top:1px solid var(--border)}
.section.surface{background:var(--surface)}
.section-bleed{background:var(--surface);border-radius:24px 24px 0 0;margin-top:-32px;position:relative;z-index:2;padding:56px 24px 72px}
.label{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--label-color);margin-bottom:14px;display:block}
.section-h2{font-family:var(--font-heading);font-size:clamp(24px,6vw,40px);font-weight:800;line-height:1.15;margin-bottom:20px}
.pull-quote{font-family:var(--font-heading);font-size:clamp(18px,5vw,26px);font-style:italic;line-height:1.4;color:var(--fg);margin-bottom:24px;padding-left:16px;border-left:3px solid var(--accent)}
.body-text{font-size:15px;line-height:1.7;color:var(--muted-fg);margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:20px;padding:28px 24px}
.services-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:28px}
.service-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px 20px}
.service-icon{font-size:28px;margin-bottom:10px;display:block}
.service-num{font-family:var(--font-heading);font-size:11px;letter-spacing:2px;color:var(--accent);margin-bottom:12px;font-weight:700}
.service-name{font-family:var(--font-heading);font-size:15px;font-weight:700;margin-bottom:6px;color:var(--fg)}
.service-desc{font-size:13px;color:var(--muted-fg);line-height:1.5}
.diff-stack{display:flex;flex-direction:column;gap:12px;margin-top:28px}
.diff-card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:24px 20px}
.diff-title{font-family:var(--font-heading);font-size:16px;font-weight:700;margin-bottom:8px;color:var(--fg)}
.diff-body{font-size:14px;color:var(--muted-fg);line-height:1.6}
.testimonial-wrap{display:flex;justify-content:center}
.testimonial-card{background:var(--card);border:1px solid var(--border);border-radius:24px;padding:32px 24px;text-align:center;width:100%}
.stars{font-size:18px;letter-spacing:2px;margin-bottom:20px;color:#FFB800}
.testimonial-quote{font-size:16px;line-height:1.7;font-style:italic;color:var(--fg);margin-bottom:20px}
.testimonial-quote strong{font-style:normal;font-weight:700}
.testimonial-attr{font-size:13px;color:var(--muted-fg)}
.cta-wa{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:56px;border-radius:14px;background:#25D366;color:#fff;font-size:16px;font-weight:700;text-decoration:none;margin-top:28px}
.fab-stack{position:fixed;bottom:calc(24px + env(safe-area-inset-bottom));right:20px;display:flex;flex-direction:column;gap:10px;z-index:100}
.fab-btn{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.25);text-decoration:none;font-size:22px;transition:transform .2s}
.fab-btn:hover{transform:scale(1.08)}
.fab-wa{background:#25D366;box-shadow:0 4px 20px rgba(37,211,102,.4)}
.fab-call{background:#007AFF;box-shadow:0 4px 20px rgba(0,122,255,.4)}
.footer{background:var(--bg);border-top:1px solid var(--border);padding:32px 24px;text-align:center}
.footer-brand{font-family:var(--font-heading);font-size:16px;font-weight:700;margin-bottom:6px}
.footer-meta{font-size:12px;color:var(--muted-fg);line-height:1.8}
.footer-credit{font-size:11px;color:var(--muted-fg);opacity:0.4;margin-top:16px}
.watermark-strip{position:fixed;bottom:0;left:0;right:0;background:var(--primary);border-top:1px solid var(--border);padding:10px 20px;display:flex;align-items:center;justify-content:space-between;z-index:200;backdrop-filter:blur(12px)}
.watermark-text{font-size:12px;color:rgba(255,255,255,0.6)}
.watermark-cta{font-size:12px;font-weight:700;color:var(--accent);text-decoration:none}

/* ── TRADE AUTHORITY HERO ─────────────────────────────────── */
.hero-ta{min-height:90svh;background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end;padding:52px 0 56px;position:relative}
.hero-ta::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.7) 50%,rgba(0,0,0,0.97) 100%)}
.hero-ta .trust-bar{display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.hero-ta .trust-pill{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:var(--accent);font-weight:700;padding:6px 12px;border:1px solid var(--accent);border-radius:4px;white-space:nowrap}
.hero-ta .trust-sep{width:1px;height:14px;background:rgba(255,255,255,0.2)}
.hero-ta .hero-h1{font-family:var(--font-heading);font-size:clamp(40px,11vw,72px);font-weight:900;line-height:0.95;letter-spacing:-0.02em;color:#fff;margin-bottom:16px;text-transform:uppercase}
.hero-ta .hero-sub{font-size:16px;color:rgba(255,255,255,0.75);margin-bottom:28px;line-height:1.5;max-width:340px}
.hero-ta .hero-content{position:relative;z-index:1;padding:0 24px}

/* ── CINEMATIC LEFT HERO ─────────────────────────────────── */
.hero-cl{min-height:100svh;background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end;padding:52px 0 64px;position:relative}
.hero-cl::before{content:'';position:absolute;inset:0;background:linear-gradient(105deg,rgba(0,0,0,0.82) 0%,rgba(0,0,0,0.5) 55%,rgba(0,0,0,0.1) 100%),linear-gradient(180deg,rgba(0,0,0,0) 40%,rgba(0,0,0,0.9) 100%)}
.hero-cl .hero-content{position:relative;z-index:1;padding:0 24px;max-width:420px}
.hero-cl .hero-emotion{font-size:14px;color:var(--accent);letter-spacing:1px;margin-bottom:16px;font-weight:500}
.hero-cl .hero-h1{font-family:var(--font-heading);font-size:clamp(38px,10vw,66px);font-weight:800;line-height:1.05;letter-spacing:-0.02em;color:#fff;margin-bottom:14px}
.hero-cl .hero-sub{font-size:16px;color:rgba(255,255,255,0.82);margin-bottom:10px;line-height:1.55}
.hero-cl .trust-line{font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:28px;letter-spacing:1.5px;text-transform:uppercase}

/* ── QUIET PREMIUM HERO ──────────────────────────────────── */
.hero-qp{min-height:100svh;background-size:cover;background-position:center;display:flex;flex-direction:column;justify-content:flex-end;padding:52px 0 72px;position:relative}
.hero-qp::before{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0.1) 0%,rgba(0,0,0,0.3) 50%,rgba(0,0,0,0.92) 100%)}
.hero-qp .hero-content{position:relative;z-index:1;padding:0 32px}
.hero-qp .hero-eyebrow{font-size:11px;letter-spacing:4px;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:24px;display:block}
.hero-qp .hero-h1{font-family:var(--font-heading);font-size:clamp(32px,8vw,54px);font-weight:600;line-height:1.15;letter-spacing:-0.01em;color:#fff;margin-bottom:20px}
.hero-qp .hero-p{font-size:15px;color:rgba(255,255,255,0.65);line-height:1.7;margin-bottom:32px;max-width:360px}
.hero-qp .cta-qp{display:inline-flex;align-items:center;gap:8px;padding:14px 24px;border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#fff;font-size:14px;font-weight:500;text-decoration:none;letter-spacing:0.5px}
`;

// ── DEFAULT CONFIG (written to KV on first boot if missing) ───

const DEFAULT_CONFIG = {
  pricing: {
    express:  { retainer: 399 },
    standard: { retainer: 699 },
    premium:  { retainer: 999 },
  },
  addons:  { extraPage: 300, revision: 500 },
  upgrades: {
    expressToStandard: 400,
    expressToPremium:  700,
    standardToPremium: 300,
  },
  tiers: {
    express: {
      name: 'Express', badge: 'Get online fast',
      features: ['Single-page website','Free .co.za domain','WhatsApp CTA','1 revision/month'],
    },
    standard: {
      name: 'Standard', badge: 'Most popular',
      features: ['Single-page website','Free .co.za domain','WhatsApp CTA','2 revisions/month','Analytics','Referral rewards','Extra pages available'],
    },
    premium: {
      name: 'Premium', badge: 'Maximum impact',
      features: ['Single-page website','Free .co.za domain','WhatsApp CTA','Unlimited revisions','Analytics','Photo gallery','Referral rewards','Extra pages available'],
    },
  },
  upsells: {
    expressToStandard: { headline: 'Add analytics and referral rewards', delta: 400 },
    standardToPremium: { headline: 'Add gallery and unlimited revisions', delta: 300 },
    extraPage:         { headline: 'Add a dedicated page', price: 300 },
    revision:          { headline: 'Request an extra revision', price: 500 },
  },
  support: { whatsapp: '' },
  flags: {
    emailProductLive:   false,
    galleryAddonLive:   false,
    referralSystemLive: true,
  },
  announcements: [],
};

// ── MAIN FETCH HANDLER ────────────────────────────────────────

const SYSTEM_SUBDOMAINS = new Set(['evolution','preview','www','mail','smtp','imap','ftp','cpanel','whm','webmail','admin','api','places-proxy']);

var index = {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const path     = url.pathname;
    const method   = request.method;
    const hostname = url.hostname;

    // ── CLIENT SITE SERVING — *.websitehub.co.za ────────────────
    // Any subdomain that isn't a system subdomain gets served from KV
    // IMPORTANT: preview.websitehub.co.za must fall through to platform routing
    if (hostname.endsWith('.websitehub.co.za') && hostname !== 'preview.websitehub.co.za' && hostname !== 'websitehub.co.za' && hostname !== 'www.websitehub.co.za') {
      const subdomain = hostname.split('.')[0];
      // System subdomains — pass through to their own origin
      if (SYSTEM_SUBDOMAINS.has(subdomain)) {
        return fetch(request);
      }
      // Client subdomains — serve from KV
      try {
        if (path === '/health') return new Response(JSON.stringify({ status: 'ok', hostname }), { headers: { 'Content-Type': 'application/json' } });
        const page    = path.replace(/^\//, '').replace(/\/$/, '') || 'index';
        const pageKey = `live:${hostname}:${page}`;
        const rootKey = `live:${hostname}`;
        let html = await env.SITES.get(pageKey);
        if (!html) html = await env.SITES.get(rootKey);
        if (!html) return new Response(clientNotFoundHtml(hostname), { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' } });
        return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache', 'X-Served-By': 'wh-build' } });
      } catch(e) {
        console.error('Client site serving error:', e?.message);
      }
    }

    try {
      // ── MAIN DOMAIN — websitehub.co.za ──────────────────────
      if (hostname === 'websitehub.co.za' || hostname === 'www.websitehub.co.za') {
        if (path === '/' || path === '' || path === '/landing') return servePwa(env, 'app:landing');
        if (path === '/privacy')         return servePwa(env, 'app:privacy');
        if (path === '/terms')           return servePwa(env, 'app:terms');
        if (path === '/referral-terms')  return servePwa(env, 'app:referral-terms');
        if (path === '/aup')             return servePwa(env, 'app:aup');
        if (path === '/cancellation')    return servePwa(env, 'app:cancellation');
        if (path === '/dpa')             return servePwa(env, 'app:dpa');
        if (path === '/blast')           return servePwa(env, 'app:blast');
        if (path === '/start')           return servePwa(env, 'app:start-v2');
        if (path.startsWith('/r/')) {
          // Referral link — set cookie and redirect to /start
          const referralSlug = path.replace('/r/', '').split('/')[0];
        if (referralSlug) {
          // Check if referrer is a promo client — pass promo through
          const referrer = await env.DB.prepare(
            `SELECT promo_code FROM clients WHERE slug=? AND status IN ('live','preview_ready') LIMIT 1`
          ).bind(referralSlug).first().catch(() => null);

          const promoCode = referrer?.promo_code || null;
          const destination = promoCode
            ? `https://websitehub.co.za/start?promo=${encodeURIComponent(promoCode)}`
            : `https://websitehub.co.za/start`;

          return new Response(null, {
            status: 302,
            headers: {
              'Location': destination,
              'Set-Cookie': [
                `ref=${referralSlug}; Path=/; Max-Age=2592000; SameSite=Lax`,
                promoCode ? `promo=${promoCode}; Path=/; Max-Age=2592000; SameSite=Lax` : null,
              ].filter(Boolean).join(', '),
            },
          });
        }
        }
        if (path === '/admin' || path === '/admin/') return servePwa(env, 'app:admin');
        if (path.startsWith('/preview/')) return servePwa(env, 'app:preview');
        if (path.startsWith('/manage/'))  return servePwa(env, 'app:manage');
        if (path.startsWith('/intake/'))  return servePwa(env, 'app:intake');
        // API routes — fall through to normal handling below
        if (path.startsWith('/admin/') || path === '/intake' || path === '/domain-check' || 
            path === '/check-slug' || path === '/build-status' || path.endsWith('/og') ||
            path === '/internal-golive' || path === '/go-live-link' || path === '/activate-free' ||
            path === '/manage-panel' || path === '/client-status' || path === '/payfast-webhook' ||
            path === '/whatsapp-incoming' || path === '/address-suggest' || path === '/showcase' ||
            path === '/godmode' ||
            path.startsWith('/site/')) {
          // Fall through to main routing
        } else {
          // Unknown path on main domain — serve landing
          return servePwa(env, 'app:landing');
        }
      }

      // ── LAUNCH WORKER ROUTES (via Service Binding) ──────────
      if (path === '/internal-golive' || path === '/go-live-link' || 
          path === '/activate-free'   || path === '/manage-panel' ||
          path === '/client-status'   || path === '/submit-revision' ||
          path === '/cancel-site'     || path === '/go-live'      ||
          path === '/payfast-webhook') {
        if (env.LAUNCH_WORKER) return env.LAUNCH_WORKER.fetch(request);
        const launchUrl = env.WORKER_URL_LAUNCH || 'https://wh-launch.pierreduplessis6912.workers.dev';
        return fetch(`${launchUrl}${path}${url.search}`, { method: request.method, headers: request.headers, body: request.body });
      }

      // ── ADMIN ROUTES (checked first — before slug serving) ──
      if (path.startsWith('/admin/')) {
        const adminKey = request.headers.get('x-admin-key');
        if (adminKey !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);
        if (path === '/admin/health')          return handleAdminHealth(env);
        if (path === '/admin/clients')         return handleAdminClients(env);
      if (path === '/admin/run-migration'      && method === 'POST') return handleRunMigration(request, env);
      if (path === '/admin/delete-client'      && method === 'POST') return handleDeleteClient(request, env);
      if (path === '/admin/bootstrap-admin'    && method === 'POST') return handleAdminBootstrapAdmin(request, env);
      if (path === '/admin/bootstrap-start'    && method === 'POST') return handleAdminBootstrapStart(request, env);
      if (path === '/admin/bootstrap-preview'  && method === 'POST') return handleAdminBootstrapPreview(request, env);
      if (path === '/admin/bootstrap-manage'   && method === 'POST') return handleAdminBootstrapManage(request, env);
      if (path === '/admin/bootstrap-intake'   && method === 'POST') return handleAdminBootstrapIntake(request, env);
      if (path === '/admin/bootstrap-godmode' && method === 'POST') {
        const html = await request.text();
        if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
        await env.SITES.put('app:godmode', html);
        return jsonResponse({ success: true, key: 'app:godmode', size: html.length });
      }
      if (path === '/admin/bootstrap-blast'     && method === 'POST') return handleAdminBootstrap(request, env, 'app:blast');
      if (path === '/admin/bootstrap-landing'  && method === 'POST') return handleAdminBootstrap(request, env, 'app:landing');
      if (path === '/admin/bootstrap-privacy'  && method === 'POST') return handleAdminBootstrap(request, env, 'app:privacy');
      if (path === '/admin/bootstrap-terms'    && method === 'POST') return handleAdminBootstrap(request, env, 'app:terms');
      if (path === '/admin/bootstrap-referral-terms' && method === 'POST') return handleAdminBootstrap(request, env, 'app:referral-terms');
      if (path === '/admin/bootstrap-aup'      && method === 'POST') return handleAdminBootstrap(request, env, 'app:aup');
      if (path === '/admin/bootstrap-cancellation' && method === 'POST') return handleAdminBootstrap(request, env, 'app:cancellation');
      if (path === '/admin/bootstrap-dpa'      && method === 'POST') return handleAdminBootstrap(request, env, 'app:dpa');
      if (path === '/admin/bootstrap-pwa'      && method === 'POST') return handleAdminBootstrapPwa(request, env);
      if (path === '/admin/test-registerdomain') return handleTestRegisterDomain(request, env);
      if (path === '/admin/force-live'         && method === 'POST') return handleAdminForceLive(request, env);
      if (path === '/admin/query'              && method === 'POST') return handleAdminQuery(request, env);
      if (path === '/admin/register-domain'    && method === 'POST') return handleAdminRegisterDomain(request, env);
      if (path === '/admin/trigger-rebuild'    && method === 'POST') return handleAdminTriggerRebuild(request, env);
      if (path === '/admin/promo-blast'        && method === 'POST') return handlePromoBlast(request, env);
      if (path === '/admin/scrape'             && method === 'POST') return handleScrape(request, env);
      if (path === '/admin/test-whatsapp'     && method === 'POST') return handleTestWhatsapp(request, env);
      if (path === '/admin/get-config'         && method === 'GET')  return handleGetConfig(env);
      if (path === '/admin/test-gbp'          && method === 'GET')  {
        try {
          const res = await fetch('https://classictouchsalon.co.za/places-proxy.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-proxy-secret': env.DOMAIN_PROXY_SECRET || 'mysecretkey123' },
            body: JSON.stringify({
              url: 'https://places.googleapis.com/v1/places:searchText',
              method: 'POST',
              postBody: { textQuery: 'Classic Touch Salon Richards Bay', regionCode: 'ZA', maxResultCount: 1 },
              fieldMask: 'places.id,places.displayName,places.rating',
              apiKey: env.GOOGLE_MAPS_API_KEY,
            }),
          });
          const text = await res.text();
          return jsonResponse({ status: res.status, ok: res.ok, body: text.slice(0, 500) });
        } catch(e) {
          return jsonResponse({ error: e.message });
        }
      }
      if (path === '/admin/debug-env'           && method === 'GET')  return jsonResponse({
        has_maps_key: !!env.GOOGLE_MAPS_API_KEY,
        maps_key_prefix: env.GOOGLE_MAPS_API_KEY?.slice(0,10) || 'MISSING',
        has_anthropic: !!env.ANTHROPIC_KEY,
        has_google_refresh: !!env.GOOGLE_REFRESH_TOKEN,
        proxy_secret: env.DOMAIN_PROXY_SECRET ? env.DOMAIN_PROXY_SECRET.slice(0,6) + '...' : 'NOT SET',
      });
      if (path === '/admin/set-config'         && method === 'POST') return handleSetConfig(request, env);
      if (path === '/admin/scrape'             && method === 'POST') return handleScrape(request, env);
      if (path === '/admin/promo-blast'         && method === 'POST') return handlePromoBlast(request, env);
      if (path === '/admin/approve-prospect'   && method === 'POST') return handleApproveProspect(request, env);
      if (path === '/admin/reject-prospect'    && method === 'POST') return handleRejectProspect(request, env);
      if (path === '/admin/prospect-queue'     && method === 'GET')  return handleProspectQueue(env);
      if (path === '/admin/migrate'         && method === 'POST') return handleAdminMigrate(request, env);
      if (path === '/admin/prospects'        && method === 'GET')  return handleAdminProspects(url, env);
      if (path === '/admin/build-detail'     && method === 'GET')  return handleAdminBuildDetail(url, env);
      if (path === '/admin/purge-cache'      && method === 'POST') return handleAdminPurgeCache(env);
      if (path === '/admin/delete-kv'        && method === 'POST') return handleAdminDeleteKv(request, env);
      return jsonResponse({ error: 'Unknown admin route' }, 404);
      }

      // ── DOMAIN CHECK ─────────────────────────────────────────
      if (path === '/domain-check' && method === 'GET') return handleDomainCheck(url, env);
      if (path === '/check-slug'   && method === 'GET') return handleCheckSlug(url, env);

      // ── PUBLIC CONFIG ────────────────────────────────────────
      if (path === '/config' && method === 'GET') return handleConfig(env);

      // ── INTAKE ───────────────────────────────────────────────
      if (path === '/whatsapp-incoming' && method === 'POST') return handleWhatsAppIncoming(request, env);

      // ── BUILD STATUS (polling) ───────────────────────────────
      if (path === '/build-status'  && method === 'GET') return handleBuildStatus(url, env);
      if (path === '/address-suggest' && method === 'GET')  return handleAddressSuggest(url, env);
      if (path === '/showcase'       && method === 'GET') return handleShowcase(env);
      if (path === '/client-status' && method === 'GET') return handleClientStatus(url, env);

      // ── PREVIEW META (prefetch for intake screen) ────────────
      if (path === '/preview-meta' && method === 'GET') return handlePreviewMeta(url, env);

      // ── INTAKE PREVIEW (cosmetic, per card) ─────────────────
      if (path === '/intake-preview'  && method === 'POST') return handleIntakePreview(request, env);

      // ── PREVIEW CHOICES (palette / font / tagline) ───────────
      if (path === '/preview-choices' && method === 'POST') return handlePreviewChoices(request, env);

      // ── TRIGGER SUBSTANCE BUILD ──────────────────────────────
      if (path === '/trigger-rebuild' && method === 'POST') return handleTriggerRebuild(request, env);

      // ── ADMIN (no auth required — page handles its own auth) ──
      if (path === '/admin' || path === '/admin/') return servePwa(env, 'app:admin');

      // ── GOOGLE AUTH — one-time OAuth setup ───────────────────
      if (path === '/google-auth') return handleGoogleAuth(url, env);

      // ── PWA SHELLS ───────────────────────────────────────────
      if (path === '/blast')               return servePwa(env, 'app:blast');
      if (path === '/godmode')             return servePwa(env, 'app:godmode');
      if (path === '/start')               return servePwa(env, 'app:start-v2');
      if (path === '/privacy')             return servePwa(env, 'app:privacy');
      if (path === '/terms')               return servePwa(env, 'app:terms');
      if (path === '/referral-terms')      return servePwa(env, 'app:referral-terms');
      if (path === '/aup')                 return servePwa(env, 'app:aup');
      if (path === '/cancellation')        return servePwa(env, 'app:cancellation');
      if (path === '/dpa')                 return servePwa(env, 'app:dpa');
      if (path === '/intake' && method === 'POST') return handleIntake(request, env);
      if (path.startsWith('/intake/'))     return servePwa(env, 'app:intake');
      if (path.startsWith('/preview/'))    return servePwa(env, 'app:preview');
      if (path.startsWith('/manage/'))     return servePwa(env, 'app:manage');
      // Legacy routes — keep for backwards compatibility
      if (path.startsWith('/experience/')) return servePwa(env, 'app:intake');
      if (path.startsWith('/verify/'))     return servePwa(env, 'app:manage');

      // ── OG CARD — WhatsApp rich preview, redirects to real site ──
      if (path.endsWith('/og')) return serveOgCard(path, env, request);

      // ── COUNTERS — fire and forget, 1x1 gif response ─────────
      if (path.endsWith('/ping')) {
        const slug = path.replace(/\/ping$/, '').replace(/^\//, '').split('/')[0];
        if (slug) env.DB.prepare(`UPDATE clients SET visits = visits + 1 WHERE slug=?`).bind(slug).run().catch(() => {});
        return new Response(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), {
          headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }
        });
      }
      if (path.endsWith('/wa')) {
        const slug = path.replace(/\/wa$/, '').replace(/^\//, '').split('/')[0];
        if (slug) env.DB.prepare(`UPDATE clients SET wa_taps = wa_taps + 1 WHERE slug=?`).bind(slug).run().catch(() => {});
        return new Response(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), {
          headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' }
        });
      }

      // ── HEALTH ───────────────────────────────────────────────
      if (path === '/health') return new Response(JSON.stringify({ status: 'ok', worker: 'wh-build', ts: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } });

      // ── BUILT SITE SERVING ───────────────────────────────────
      return serveBuiltSite(url, path, request, env);

    } catch (err) {
      console.error('Unhandled error:', err);
      return jsonResponse({ error: 'Internal server error', message: err.message }, 500);
    }
  },

  // ── QUEUE CONSUMER ─────────────────────────────────────────
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const { type, clientId, cardPayload, isOutbound, silent } = msg.body;
        if (type === 'pre_build')       await triggerPreBuild(clientId, env, isOutbound);
        if (type === 'substance_build') await triggerSubstanceBuild(clientId, cardPayload, env);
        if (type === 'full_build')      await triggerFullBuild(clientId, env, isOutbound, silent);
        msg.ack();
      } catch (err) {
        console.error('Queue message failed:', err);
        msg.retry();
      }
    }
  },

  // ── CRON ────────────────────────────────────────────────────
  async scheduled(event, env) {
    await handleCron(env);
  },
};

// ── ADMIN HANDLERS ────────────────────────────────────────────

async function handleAdminHealth(env) {
  let d1 = 'unknown';
  try { await env.DB.prepare('SELECT 1').first(); d1 = 'ok'; } catch { d1 = 'error'; }

  const recentEvents = await env.DB.prepare(
    `SELECT worker, event_type, status, error, metadata, created_at FROM events ORDER BY created_at DESC LIMIT 20`
  ).all().then(r => r.results).catch(() => []);

  const recentBuilds = await env.DB.prepare(
    `SELECT c.business_name, b.status, b.build_time_ms, b.created_at
     FROM builds b JOIN clients c ON c.id = b.client_id
     ORDER BY b.created_at DESC LIMIT 5`
  ).all().then(r => r.results).catch(() => []);

  return jsonResponse({ d1, recentEvents, recentBuilds, timestamp: new Date().toISOString(), testMode: isTestMode(env), evoConfigured: !!(env.EVOLUTION_API_URL && env.EVOLUTION_API_KEY), whPhone: env.WH_PHONE ? 'set' : 'missing' });
}

async function handleAdminClients(env) {
  const rows = await env.DB.prepare(
    `SELECT id, business_name, slug, phone, manage_token, status, package, domain, created_at
     FROM clients ORDER BY created_at DESC LIMIT 20`
  ).all();
  const events = await env.DB.prepare(
    `SELECT worker, event_type, status, error, metadata, created_at 
     FROM events ORDER BY created_at DESC LIMIT 50`
  ).all().catch(() => ({ results: [] }));
  return jsonResponse({ clients: rows.results, recentEvents: events.results });
}

// ── CONFIG ────────────────────────────────────────────────────────────────────
async function handleGetConfig(env) {
  const rows = await env.DB.prepare(`SELECT key, value, description, updated_at FROM config ORDER BY key`).all().catch(() => ({ results: [] }));
  const config = {};
  for (const r of (rows.results || [])) {
    try { config[r.key] = JSON.parse(r.value); } catch { config[r.key] = r.value; }
  }
  return jsonResponse({ config, raw: rows.results || [] });
}

async function handleSetConfig(request, env) {
  const body = await request.json().catch(() => ({}));
  const { key, value } = body;
  if (!key || value === undefined) return jsonResponse({ error: 'key and value required' }, 400);

  const strVal = typeof value === 'string' ? value : JSON.stringify(value);
  await env.DB.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).bind(key, strVal).run();

  return jsonResponse({ success: true, key, value });
}

// ── GOOGLE PLACES SCRAPE ──────────────────────────────────────────────────────
async function handlePromoBlast(request, env) {
  const body = await request.json().catch(() => ({}));
  const { industry, province, area, limit = 20, promoCode = 'LAUNCH2026' } = body;
  if (!industry || !province) return jsonResponse({ error: 'industry and province required' }, 400);

  // 1. Scrape Google Places
  const scrapeReq = new Request(request.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ industry, province, area, limit }),
  });
  await handleScrape(scrapeReq, env);

  // 2. Fetch all pending prospects just scraped
  const prospects = await env.DB.prepare(
    `SELECT * FROM prospects WHERE status='pending' ORDER BY id DESC LIMIT ?`
  ).bind(limit).all();

  let built = 0, skipped = 0;

  for (const p of (prospects.results || [])) {
    try {
      const id           = crypto.randomUUID();
      const slug         = await uniqueSlug(p.business_name, env);
      const manage_token = crypto.randomUUID();
      const referral_slug = slug.slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6);

      await env.DB.prepare(`
        INSERT INTO clients
          (id, business_name, slug, phone, industry, area, vibe, manage_token,
           referral_slug, promo_code, status, source, package, retainer)
        VALUES (?,?,?,?,?,?,?,?,?,?,'lead','outbound','hub',?)
      `).bind(id, p.business_name, slug, p.phone || '', p.industry || '', p.area || '', 'professional',
          manage_token, referral_slug, promoCode, PRICING.promo?.retainer || 599).run();

      await env.DB.prepare(`UPDATE prospects SET status='built', client_id=?, contacted_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(id, p.id).run();

      // GBP lookup — use prospect's place_id and phone from scraper
      try {
        const gbpData = await resolveGbp(env, p.google_place_id || null, p.business_name, p.area, p.phone || null);
        if (gbpData && isRealEstablishment(gbpData)) {
          const gbp = shapeGbp(gbpData, p.business_name);
          await env.DB.prepare(
            `UPDATE clients SET gbp_data=?, gbp_place_id=?, area=COALESCE(NULLIF(area,''),?) WHERE id=?`
          ).bind(JSON.stringify(gbp), gbp.placeId || p.google_place_id, gbp.address?.split(',')[1]?.trim() || p.area || '', id).run();
          await logEvent(env, id, 'build', 'gbp_write', 'success', { metadata: { wrote: gbp.name, reviews: gbp.reviewCount } });
        }
      } catch(e) { console.warn('Promo blast GBP lookup failed:', e.message); }

      // Queue build
      await env.BUILD_QUEUE.send({ type: 'full_build', clientId: id, isOutbound: true });
      built++;
    } catch (err) {
      console.error(`Promo blast failed for prospect ${p.id}:`, err.message);
      skipped++;
    }
  }

  await logEvent(env, null, 'build', 'promo_blast', 'success', {
    metadata: { industry, province, area, promoCode, built, skipped }
  });

  return jsonResponse({ success: true, found: prospects.results?.length || 0, built, skipped, promoCode });
}

async function handleScrape(request, env) {
  const { industry, province, area, limit = 20 } = await request.json().catch(() => ({}));
  if (!industry || !province) return jsonResponse({ error: 'industry and province required' }, 400);

  // Use Maps Platform API key
  const accessToken = env.GOOGLE_MAPS_API_KEY;
  if (!accessToken) return jsonResponse({ error: 'Google auth failed — check GOOGLE_MAPS_API_KEY' }, 500);

  // Build search query
  const searchArea = area || province;
  const query = `${industry} in ${searchArea} South Africa`;

  // Route through VPS proxy — Cloudflare IPs blocked by Google Places
  const res = await fetch('https://classictouchsalon.co.za/places-proxy.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-secret': env.DOMAIN_PROXY_SECRET || 'mysecretkey123',
    },
    body: JSON.stringify({
      url: 'https://places.googleapis.com/v1/places:searchText',
      method: 'POST',
      fieldMask: 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.primaryTypeDisplayName,places.shortFormattedAddress',
      postBody: {
        textQuery: query,
        maxResultCount: Math.min(limit, 20),
        regionCode: 'ZA',
        languageCode: 'en',
      }
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return jsonResponse({ error: 'Places API error', detail: err, status: res.status }, 502);
  }

  const data = await res.json();

  // Places API New returns { places: [...] } — no status field
  if (data.error) {
    return jsonResponse({ error: 'Places API error', detail: JSON.stringify(data.error) }, 502);
  }

  const places = (data.places || []);

  // Filter: no website = our target
  const targets = places.filter(p => !p.websiteUri);

  let inserted = 0, skipped = 0;

  for (const p of targets) {
    const phone = normalisePhone(p.internationalPhoneNumber || p.nationalPhoneNumber || '');
    if (!phone) { skipped++; continue; }

    // Skip landlines — can't WhatsApp them
    // Normalised format: 27XXXXXXXXX
    // SA mobiles start with 276x, 277x, 278x (i.e. 06x, 07x, 08x locally)
    // Landlines start with 271x, 272x, 273x, 274x, 275x (i.e. 01x-05x locally)
    const thirdDigit = parseInt(phone[2]); // digit after "27"
    if (thirdDigit < 6) { skipped++; continue; }

    // Check if already in prospects or clients
    const existing = await env.DB.prepare(
      `SELECT id FROM prospects WHERE phone=? OR google_place_id=? LIMIT 1`
    ).bind(phone, p.id).first().catch(() => null);
    if (existing) { skipped++; continue; }

    const bizName = p.displayName?.text || 'Unknown Business';
    const area    = p.shortFormattedAddress || province;

    await env.DB.prepare(`
      INSERT INTO prospects (business_name, phone, industry, area, google_place_id, province_scraped, status, scrape_date)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', date('now'))
    `).bind(bizName, phone, industry, area, p.id, province).run().catch(() => { skipped++; });

    inserted++;
  }

  await logEvent(env, null, 'build', 'scrape_complete', 'success', {
    metadata: { query, found: places.length, noWebsite: targets.length, inserted, skipped }
  });

  return jsonResponse({ success: true, query, found: places.length, noWebsite: targets.length, inserted, skipped });
}

function normalisePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('27') && digits.length === 11) return digits;
  if (digits.startsWith('0') && digits.length === 10) return '27' + digits.slice(1);
  return null;
}

// ── PROSPECT QUEUE ────────────────────────────────────────────────────────────
async function handleProspectQueue(env) {
  const rows = await env.DB.prepare(
    `SELECT * FROM prospects WHERE status='pending' ORDER BY created_at DESC LIMIT 50`
  ).all().catch(() => ({ results: [] }));
  return jsonResponse({ prospects: rows.results || [] });
}

async function handleApproveProspect(request, env) {
  const { id } = await request.json().catch(() => ({}));
  if (!id) return jsonResponse({ error: 'id required' }, 400);
  await env.DB.prepare(`UPDATE prospects SET status='approved' WHERE id=?`).bind(id).run();

  // Check mode — if auto, trigger build immediately
  const modeRow = await env.DB.prepare(`SELECT value FROM config WHERE key='outbound_mode'`).first().catch(() => null);
  if (modeRow?.value === 'auto') {
    const prospect = await env.DB.prepare(`SELECT * FROM prospects WHERE id=?`).bind(id).first().catch(() => null);
    if (prospect) {
      await triggerOutboundBuild(prospect, env).catch(e => console.warn('Auto build failed:', e.message));
    }
  }

  return jsonResponse({ success: true });
}

async function handleRejectProspect(request, env) {
  const { id } = await request.json().catch(() => ({}));
  if (!id) return jsonResponse({ error: 'id required' }, 400);
  await env.DB.prepare(
    `UPDATE prospects SET status='rejected', cooldown_until=datetime('now','+30 days') WHERE id=?`
  ).bind(id).run();
  return jsonResponse({ success: true });
}

async function triggerOutboundBuild(prospect, env) {
  const id           = generateUUID();
  const slug         = await uniqueSlug(prospect.business_name, env);
  const manage_token = generateUUID();
  const referral_slug = slug.slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6);

  await env.DB.prepare(`
    INSERT INTO clients (id, business_name, slug, phone, industry, area, vibe, manage_token, referral_slug, status, source, package, retainer)
    VALUES (?,?,?,?,?,?,?,?,?,'lead','outbound','standard',?)
  `).bind(id, prospect.business_name, slug, prospect.phone || '', prospect.industry || '',
      prospect.area || '', 'professional', manage_token, referral_slug, PRICING.express.retainer).run();

  await env.DB.prepare(`UPDATE prospects SET status='built', client_id=?, contacted_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(id, prospect.id).run();

  await env.BUILD_QUEUE.send({ type: 'full_build', clientId: id, isOutbound: true });
}


// ── GOOGLE AUTH — one-time refresh token setup ───────────────────────────────
async function handleGoogleAuth(url, env) {
  const code        = url.searchParams.get('code');
  const redirectUri = `https://${url.host}/google-auth`;

  if (!code) {
    const scopes  = [
      'https://www.googleapis.com/auth/business.manage',
      'https://www.googleapis.com/auth/places',
    ].join(' ');
    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' +
      `client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&access_type=offline` +
      `&prompt=consent`;

    return new Response(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:600px;background:#0a0a0f;color:#e8e8f0">
      <h2 style="color:#00f0ff">Google Auth Setup</h2>
      <p>Click to authorise Website Hub to access Google Business and Places:</p>
      <a href="${authUrl}" style="display:inline-block;margin:16px 0;padding:14px 28px;background:linear-gradient(135deg,#00f0ff,#b829dd);color:#000;font-weight:700;border-radius:10px;text-decoration:none">Sign in with Google →</a>
      <p style="color:#8888aa;font-size:12px;margin-top:24px">Redirect URI registered in Google Console:<br>
      <code style="background:#161616;padding:4px 8px;border-radius:4px;color:#00f0ff">${redirectUri}</code></p>
    </body></html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
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
      return new Response(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:600px;background:#0a0a0f;color:#e8e8f0">
        <h2 style="color:#00ff88">✅ Authorised! Copy your refresh token:</h2>
        <pre style="background:#161616;border:1px solid rgba(0,255,136,.2);padding:16px;border-radius:10px;word-break:break-all;font-size:13px;color:#00ff88">${tokenData.refresh_token}</pre>
        <p style="color:#8888aa">Run from Termux:<br>
        <code style="background:#161616;padding:8px 12px;border-radius:6px;display:block;margin-top:8px;color:#00f0ff">echo -n "PASTE_TOKEN_HERE" | gh secret set GOOGLE_REFRESH_TOKEN</code></p>
      </body></html>`, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    }

    return new Response(`<pre style="padding:40px;color:red">${JSON.stringify(tokenData, null, 2)}</pre>`,
      { status: 400, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  } catch(e) {
    return new Response(`<pre style="padding:40px;color:red">${e.message}</pre>`,
      { status: 500, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
}


async function handleAdminBootstrapPwa(request, env) {
  const html = await request.text();
  if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
  await env.SITES.put('app:pwa', html);
  return jsonResponse({ success: true, size: html.length });
}

async function handleAdminBootstrapIntake(request, env) {
  const html = await request.text();
  if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
  await env.SITES.put('app:intake', html);
  return jsonResponse({ success: true, size: html.length });
}

async function handleAdminBootstrapPreview(request, env) {
  const html = await request.text();
  if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
  await env.SITES.put('app:preview', html);
  return jsonResponse({ success: true, size: html.length });
}

async function handleTestWhatsapp(request, env) {
  const { to, message } = await request.json().catch(() => ({}));
  if (!to) return jsonResponse({ error: 'to required' }, 400);
  const evoUrl = env.EVOLUTION_API_URL;
  const evoKey = env.EVOLUTION_API_KEY;
  const evoInstance = env.EVOLUTION_INSTANCE || 'wa1';
  if (!evoUrl || !evoKey) return jsonResponse({ error: 'Evolution API not configured', evoUrl: !!evoUrl, evoKey: !!evoKey }, 500);
  // Debug: return first/last 3 chars of key so we can verify without exposing it
  const keyHint = evoKey ? evoKey.slice(0,3) + '...' + evoKey.slice(-3) : 'EMPTY';
  try {
    const res = await fetch(`${evoUrl}/message/sendText/${evoInstance}`, {
      method: 'POST',
      headers: { 'apikey': evoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ number: to, textMessage: { text: message || 'Test from Website Hub ✅' } }),
    });
    const data = await res.json().catch(() => ({}));
    return jsonResponse({ status: res.status, ok: res.ok, data, evoUrl, evoInstance, keyHint });
  } catch(e) {
    return jsonResponse({ error: e.message, evoUrl, evoInstance }, 500);
  }
}


async function handleAdminRegisterDomain(request, env) {
  const { slug } = await request.json().catch(() => ({}));
  if (!slug) return jsonResponse({ error: 'slug required' }, 400);
  try {
    const res = await fetch('https://websitehub.co.za/domain-proxy.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Proxy-Secret': env.DOMAIN_PROXY_SECRET || 'wh-proxy-d8f3a1b9c2e4f7d6a5b8c3e1f9d2a4b7' },
      body: JSON.stringify({ action: 'RegisterDomain', sld: slug, tld: 'co.za' }),
    });
    const data = await res.json().catch(() => ({}));
    return jsonResponse({ success: res.ok, data });
  } catch(e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

async function handleAdminTriggerRebuild(request, env) {
  const { clientId, slug, silent } = await request.json().catch(() => ({}));
  const client = clientId
    ? await env.DB.prepare(`SELECT * FROM clients WHERE id=? LIMIT 1`).bind(clientId).first()
    : await env.DB.prepare(`SELECT * FROM clients WHERE slug=? LIMIT 1`).bind(slug).first();
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);
  await env.DB.prepare(`UPDATE clients SET status='preview_ready', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(client.id).run();
  await env.BUILD_QUEUE.send({ type: 'full_build', clientId: client.id, isOutbound: false, silent: !!silent });
  return jsonResponse({ success: true, clientId: client.id, slug: client.slug });
}

async function handleTestRegisterDomain(request, env) {
  const apiKey = env.REGISTERDOMAIN_API_KEY;
  const email  = env.REGISTERDOMAIN_EMAIL || 'loc10@live.co.za';
  const PROXY  = 'https://classictouchsalon.co.za/rd-proxy.php';
  const SECRET = env.DOMAIN_PROXY_SECRET || 'mysecretkey123';

  if (!apiKey) return jsonResponse({ error: 'REGISTERDOMAIN_API_KEY not set on build worker — add it' }, 400);

  try {
    // Generate token
    const now = new Date();
    const yy = String(now.getUTCFullYear()).slice(2);
    const mm = String(now.getUTCMonth()+1).padStart(2,'0');
    const dd = String(now.getUTCDate()).padStart(2,'0');
    const HH = String(now.getUTCHours()).padStart(2,'0');
    const dateHour = `${yy}-${mm}-${dd} ${HH}`;
    const keyStr = `${email}:${dateHour}`;
    const keyBytes  = new TextEncoder().encode(keyStr);
    const dataBytes = new TextEncoder().encode(apiKey);
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, dataBytes);
    const hexStr = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,'0')).join('');
    const token = btoa(hexStr);

    const rdHeaders = [`username: ${email}`, `token: ${token}`];

    // Test 1: Get credits — confirmed working
    const creditsRes = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-secret': SECRET },
      body: JSON.stringify({ action: '/billing/credits', method: 'GET', params: {}, headers: rdHeaders }),
    });
    const creditsData = await creditsRes.json().catch(() => ({ raw: 'parse error' }));

    // Test 2: Check domain availability
    const checkRes = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-secret': SECRET },
      body: JSON.stringify({ action: '/domains/lookup', method: 'POST', params: { searchTerm: 'testxyz99887766.co.za' }, headers: rdHeaders }),
    });
    const checkData = await checkRes.json().catch(() => ({ raw: 'parse error' }));

    return jsonResponse({ success: true, dateHour, token: token.slice(0,20)+'...', credits: creditsData, domainCheck: checkData });
  } catch(e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

async function handleAdminDeleteKv(request, env) {
  const { keys } = await request.json().catch(() => ({}));
  if (!keys?.length) return jsonResponse({ error: 'keys array required' }, 400);
  const results = [];
  for (const key of keys) {
    await env.SITES.delete(key).catch(() => {});
    results.push(key);
  }
  return jsonResponse({ success: true, deleted: results });
}

async function handleAdminPurgeCache(env) {
  const token  = env.CF_API_TOKEN;
  const zoneId = env.CF_ZONE_ID;
  if (!token || !zoneId) return jsonResponse({ error: 'CF_API_TOKEN or CF_ZONE_ID not set' }, 500);
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ purge_everything: true }),
      }
    );
    const data = await res.json();
    if (!res.ok) return jsonResponse({ success: false, error: JSON.stringify(data.errors) });
    return jsonResponse({ success: true });
  } catch(e) {
    return jsonResponse({ success: false, error: e.message }, 500);
  }
}

async function handleAdminForceLive(request, env) {
  const body = await request.json().catch(() => ({}));
  const { slug } = body;
  if (!slug) return jsonResponse({ error: 'slug required' }, 400);

  const client = await env.DB.prepare(`SELECT * FROM clients WHERE slug=? LIMIT 1`).bind(slug).first();
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  // Get the built HTML from site:{slug}
  const html = await env.SITES.get(`site:${slug}`);
  if (!html) return jsonResponse({ error: 'No built HTML found at site:' + slug }, 404);

  const pkg = pkgKey(client.package || 'hub');
  const isHubPro = pkg === 'hub_pro' || pkg === 'premium';
  const domain = client.domain || (isHubPro ? `${slug}.co.za` : `${slug}.websitehub.co.za`);

  // Write to all the right places
  await env.SITES.put(`preview:${slug}`, html, { expirationTtl: 60 * 60 * 24 * 35 });
  await env.SITES.put(`live:${domain}`, html);
  await env.SITES.put(`live:${domain}:index`, html);

  // Update status to live
  const today = new Date().toISOString().split('T')[0];
  const nextMonth = new Date(Date.now() + 30 * 864e5).toISOString().split('T')[0];
  await env.DB.prepare(
    `UPDATE clients SET status='live', go_live_date=?, next_invoice_date=?, domain=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).bind(today, nextMonth, domain, client.id).run();

  // Always notify immediately
  const manageUrl = `https://${PREVIEW_DOMAIN}/manage/${client.manage_token}`;
  await sendWhatsApp(env.WH_PHONE,
    `✅ FORCE LIVE: ${client.business_name}\n🌐 https://${domain}`,
    env, { skipTestRedirect: true }
  ).catch(() => {});
  await sendWhatsApp(client.phone,
    `🎉 *${client.business_name}* is live!\n\n🌐 https://${domain}\n📱 Manage: ${manageUrl}\n\n📬 Your email:\nhello@${domain}\ninfo@${domain}\n\n— Website Hub`,
    env
  ).catch(() => {});

  // Also trigger full go-live via launch worker for email provisioning etc
  if (env.LAUNCH_WORKER) {
    env.LAUNCH_WORKER.fetch(new Request('https://internal/internal-golive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: client.id, slug }),
    })).catch(e => console.warn('Internal go-live failed:', e?.message));
  }

  return jsonResponse({ success: true, slug, domain, status: 'live' });
}

async function handleAdminQuery(request, env) {
  const { sql } = await request.json().catch(() => ({}));
  if (!sql) return jsonResponse({ error: 'sql required' }, 400);
  try {
    const result = await env.DB.prepare(sql).all();
    return jsonResponse({ results: result.results });
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

async function handleDeleteClient(request, env) {
  const { slug } = await request.json().catch(() => ({}));
  if (!slug) return jsonResponse({ error: 'slug required' }, 400);

  const client = await env.DB.prepare(`SELECT id FROM clients WHERE slug=?`).bind(slug).first().catch(() => null);
  if (!client) return jsonResponse({ error: 'not found' }, 404);

  const id = client.id;
  const tables = ['invoices','referrals','referral_credits','visits','events','builds','revisions'];
  for (const t of tables) {
    await env.DB.prepare(`DELETE FROM ${t} WHERE client_id=?`).bind(id).run().catch(() => {});
  }
  await env.DB.prepare(`DELETE FROM clients WHERE id=?`).bind(id).run();

  // Also clear KV
  await env.SITES.delete(`preview:${slug}`).catch(() => {});
  await env.SITES.delete(`site:${slug}`).catch(() => {});
  await env.SITES.delete(`content:${slug}`).catch(() => {});

  return jsonResponse({ success: true, slug, id });
}

async function handleRunMigration(request, env) {
  const body = await request.json().catch(() => ({}));
  const { migration } = body;
  if (!migration) return jsonResponse({ error: 'migration name required' }, 400);

  const migrations = {
    '0002': [
      `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_by TEXT DEFAULT 'admin')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('outbound_enabled','false','Master outbound switch')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('daily_scrape_limit','20','Max prospects scraped per cron run')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('daily_send_limit','10','Max WhatsApps sent per day')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('send_window_start','09:00','Earliest send time SAST')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('send_window_end','17:00','Latest send time SAST')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('outbound_mode','manual','manual = you approve | auto = fire and forget')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('target_provinces','["KZN","GP","WC"]','Active scrape provinces')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('target_industries','["plumber","electrician","builder","painter","salon","barber","nails","restaurant","cleaning","landscaping","mechanic"]','Active scrape industries')`,
      `INSERT OR IGNORE INTO config (key, value, description) VALUES ('dry_run','true','Scrape without building or sending — review quality first')`,
      `CREATE TABLE IF NOT EXISTS referral_credits (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, referral_id INTEGER, promo_code TEXT UNIQUE NOT NULL, credit_amount INTEGER NOT NULL, status TEXT DEFAULT 'vested', vested_at DATETIME DEFAULT CURRENT_TIMESTAMP, used_at DATETIME, expires_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
      `CREATE INDEX IF NOT EXISTS idx_config_key ON config(key)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_credits_client ON referral_credits(client_id)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_credits_code ON referral_credits(promo_code)`,
      `CREATE INDEX IF NOT EXISTS idx_ref_credits_status ON referral_credits(status)`,
    ],
    '0003': [
      `ALTER TABLE clients ADD COLUMN gbp_place_id TEXT`,
      `ALTER TABLE clients ADD COLUMN gbp_data TEXT`,
    ],
    '0004': [
      `ALTER TABLE clients ADD COLUMN hero_url TEXT`,
    ]
  };

  const stmts = migrations[migration];
  if (!stmts) return jsonResponse({ error: 'Unknown migration: ' + migration }, 400);

  const results = [];
  for (const sql of stmts) {
    try {
      await env.DB.prepare(sql).run();
      results.push({ ok: true, sql: sql.slice(0, 60) + '...' });
    } catch(e) {
      results.push({ ok: false, sql: sql.slice(0, 60) + '...', error: e.message });
    }
  }

  const failed = results.filter(r => !r.ok);
  return jsonResponse({ success: failed.length === 0, results, failed: failed.length });
}

async function handleAdminBootstrap(request, env, kvKey) {
  const html = await request.text();
  if (!html) return jsonResponse({ error: 'No content' }, 400);
  await env.SITES.put(kvKey, html);
  return jsonResponse({ success: true, key: kvKey, size: html.length });
}

async function handleAdminBootstrapAdmin(request, env) {
  const html = await request.text();
  if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
  await env.SITES.put('app:admin', html);
  return jsonResponse({ success: true, size: html.length });
}

async function handleAdminBootstrapManage(request, env) {
  const html = await request.text();
  if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
  await env.SITES.put('app:manage', html);
  return jsonResponse({ success: true, size: html.length });
}

async function handleAdminBootstrapStart(request, env) {
  const html = await request.text();
  if (!html.includes('</html>')) return jsonResponse({ error: 'Invalid HTML' }, 400);
  await env.SITES.put('app:start-v2', html);
  return jsonResponse({ success: true, size: html.length });
}

async function handleAdminMigrate(request, env) {
  const { sql } = await request.json();
  if (!sql) return jsonResponse({ error: 'sql required' }, 400);
  try {
    await env.DB.prepare(sql).run();
    return jsonResponse({ ok: true, sql });
  } catch (err) {
    return jsonResponse({ error: err.message, sql }, 500);
  }
}

async function handleAdminBuildDetail(url, env) {
  const slug     = url.searchParams.get('slug');
  const clientId = url.searchParams.get('id');

  let client;
  if (slug)     client = await getClientBySlug(slug, env);
  if (clientId) client = await getClientById(clientId, env);
  if (!client)  return jsonResponse({ error: 'not found' }, 404);

  const build = await env.DB.prepare(
    `SELECT * FROM builds WHERE client_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(client.id).first();

  const contentTokens = await env.SITES.get(`content:${client.slug}`, 'json');

  return jsonResponse({
    client: {
      id:            client.id,
      business_name: client.business_name,
      slug:          client.slug,
      industry:      client.industry,
      area:          client.area,
      vibe:          client.vibe,
      services:      client.services,
      palette:       client.palette,
      voice_profile: client.voice_profile ? JSON.parse(client.voice_profile) : null,
    },
    build: build ? {
      status:           build.status,
      build_time_ms:    build.build_time_ms,
      palette:          build.palette,
      unsplash_queries: build.unsplash_queries ? JSON.parse(build.unsplash_queries) : null,
      voice_profile:    build.voice_profile   ? JSON.parse(build.voice_profile)    : null,
    } : null,
    contentTokens,
  });
}

async function handleAdminProspects(url, env) {
  const status = url.searchParams.get('status') || 'pending';
  const limit  = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const rows = await env.DB.prepare(
    `SELECT id, business_name, phone, industry, area, status,
            contacted_at, cooldown_until, created_at
     FROM prospects
     WHERE status = ?
     ORDER BY created_at DESC
     LIMIT ?`
  ).bind(status, limit).all();
  return jsonResponse({ prospects: rows.results, count: rows.results?.length || 0, status });
}

// ── PREVIEW CHOICES ───────────────────────────────────────────

async function handlePreviewChoices(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { token, palette, font, tagline, logo_url, photo } = body;
  if (!token) return jsonResponse({ error: 'token required' }, 400);

  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not found' }, 404);

  // Update client fields — only the ones provided
  const updates = {};
  if (palette)  updates.palette   = palette;
  if (logo_url) updates.logo_url  = logo_url;

  // Store font + tagline + photo in voice_profile JSON
  const profile = safeJson(client.voice_profile) || {};
  if (font)    profile._font    = font;
  if (tagline) profile.tagline  = tagline;
  if (photo)   profile._photo   = photo;
  updates.voice_profile = JSON.stringify(profile);

  await updateClient(env, client.id, updates);
  return jsonResponse({ success: true });
}

// ── DOMAIN CHECK ─────────────────────────────────────────────

async function handleCheckSlug(url, env) {
  const slug = (url.searchParams.get('slug') || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) return jsonResponse({ available: false }, 400);

  const existing = await env.DB.prepare(
    `SELECT id FROM clients WHERE slug=? AND status NOT IN ('lead','building','preview_ready','qa_ready') LIMIT 1`
  ).bind(slug).first().catch(() => null);

  return new Response(JSON.stringify({ slug, available: !existing }), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }
  });
}

async function handleDomainCheck(url, env) {
  let rawName = url.searchParams.get('name') || '';
  // Strip .co.za if caller passed full domain instead of business name
  if (rawName.toLowerCase().endsWith('.co.za')) rawName = rawName.slice(0, -6);
  const slug   = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const domain = slug + '.co.za';

  if (!slug) return jsonResponse({ available: false, domain, error: 'Invalid name' }, 400);

  // CORS — landing page is on a different origin
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  };

  // Check D1 — only block if domain is actually live/registered, not just a lead
  try {
    const existing = await env.DB.prepare(
      `SELECT id FROM clients WHERE slug = ? AND status NOT IN ('lead','building','preview_ready','qa_ready') LIMIT 1`
    ).bind(slug).first();
    if (existing) {
      return new Response(JSON.stringify({
        available:   false,
        domain,
        suggestions: generateSuggestions(slug),
      }), { headers });
    }
  } catch {}

  // Call RegisterDomain API
  if (!env.REGISTERDOMAIN_API_KEY || !env.REGISTERDOMAIN_EMAIL) {
    // No credentials — assume available (dev/test mode)
    return new Response(JSON.stringify({ available: true, domain }), { headers });
  }

  try {
    const params = new URLSearchParams({
      username:     env.REGISTERDOMAIN_EMAIL,
      password:     env.REGISTERDOMAIN_API_KEY,
      action:       'CheckAvailability',
      responsetype: 'json',
    });
    // WHMCS expects domains as array
    params.append('domains[0]', domain);

    const res  = await fetch('https://www.registerdomain.co.za/includes/api.php', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString(),
    });

    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = await res.json();

    // Log raw response for debugging
    console.log('RegisterDomain response:', JSON.stringify(data));

    // WHMCS response: { domains: [{ domain, status }] }
    const domainResult = data?.domains?.[0];
    const status       = (domainResult?.status || data?.result || '').toLowerCase();
    const available    = status === 'available' || status === 'free';

    return new Response(JSON.stringify({
      available,
      domain,
      suggestions: available ? [] : generateSuggestions(slug),
      _debug: { status, raw: data?.domains?.[0] },
    }), { headers });

  } catch (err) {
    console.error('Domain check failed:', err.message);
    // Fail open — let them proceed, backend will catch duplicates at intake
    return new Response(JSON.stringify({ available: true, domain, _fallback: true }), { headers });
  }
}

function generateSuggestions(slug) {
  return [
    slug + 'sa.co.za',
    slug + 'kzn.co.za',
    'my' + slug + '.co.za',
  ];
}

// ── PUBLIC CONFIG ─────────────────────────────────────────────

async function handleConfig(env) {
  let config = await env.SITES.get('app:config', 'json');
  if (!config) {
    config = DEFAULT_CONFIG;
    await env.SITES.put('app:config', JSON.stringify(config));
  }
  return new Response(JSON.stringify(config), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CONFIG_CACHE_TTL}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── INTAKE ────────────────────────────────────────────────────

async function handleWhatsAppIncoming(request, env) {
  // Verify it's from our Evolution instance
  const secret = request.headers.get('apikey') || request.headers.get('x-api-key') || '';
  const expectedSecret = env.EVOLUTION_KEY || env.DOMAIN_PROXY_SECRET || 'mysecretkey123';
  if (secret !== expectedSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const body = await request.json().catch(() => null);
    if (!body) return new Response('OK', { status: 200 });

    // Only handle incoming messages — not our own sends
    const msg = body?.data;
    if (!msg || msg?.key?.fromMe) return new Response('OK', { status: 200 });

    // Extract message content
    const text = msg?.message?.conversation
      || msg?.message?.extendedTextMessage?.text
      || msg?.message?.imageMessage?.caption
      || '[media message]';

    // Debug — log full payload to find real phone
    await logEvent(env, null, 'whatsapp', 'incoming_debug', 'info', {
      metadata: {
        remoteJid: msg?.key?.remoteJid,
        participant: msg?.key?.participant,
        pushName: msg?.pushName,
        fromMe: msg?.key?.fromMe,
      }
    }).catch(() => {});

    // Extract sender phone — handle @s.whatsapp.net, @c.us, @lid formats
    const rawJid = msg?.key?.remoteJid || '';
    let phone = rawJid.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '').replace(/@lid$/, '');

    // If @lid — try to resolve real phone via Evolution contacts API
    if (rawJid.endsWith('@lid') && env.EVOLUTION_URL && env.EVOLUTION_KEY) {
      try {
        const res = await fetch(
          `${env.EVOLUTION_URL}/chat/findContacts/${env.EVOLUTION_INSTANCE}`,
          {
            method: 'POST',
            headers: { 'apikey': env.EVOLUTION_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ where: { id: rawJid } }),
          }
        );
        const contacts = await res.json();
        const contact = Array.isArray(contacts) ? contacts[0] : contacts;
        const resolved = contact?.remoteJid || contact?.jid || contact?.phoneNumber;
        if (resolved) {
          phone = resolved.replace(/@s\.whatsapp\.net$/, '').replace(/@c\.us$/, '');
        }
      } catch(e) {
        console.warn('LID resolution failed:', e?.message);
      }
    }

    phone = phone.replace(/\D/g, '');
    if (!phone || phone.length < 7) return new Response('OK', { status: 200 });

    // Look up client by phone
    const client = await env.DB.prepare(
      `SELECT business_name, slug FROM clients WHERE phone=? OR phone=? LIMIT 1`
    ).bind(phone, '+' + phone).first().catch(() => null);

    const pushName = msg?.pushName || '';
    const businessLabel = client
      ? `*${client.business_name}*`
      : pushName ? `*${pushName}*` : `Unknown (${phone})`;

    // Forward to owner
    await sendWhatsApp(env.WH_PHONE,
      `📩 ${businessLabel}:\n${text}\n\n_Reply: wa.me/${phone}_`,
      env,
      { skipTestRedirect: true }
    ).catch(() => {});

  } catch(e) {
    console.warn('WhatsApp incoming handler error:', e?.message);
  }
  return new Response('OK', { status: 200 });
}

async function handleIntake(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { business_name, client_name, phone, email, package: pkg, area, industry, place_id, address } = body;
  if (!business_name || !phone)
    return jsonResponse({ error: 'business_name and phone required' }, 400);

  try {
    const id            = generateUUID();

    // ── ABUSE PREVENTION ───────────────────────────────────────
    const WHITELISTED   = ['27790128508'];
    const WHITELISTED_IPS = ['41.23.165.89'];
    const normPhone     = normaliseSaPhone(phone);
    const isWhitelisted = WHITELISTED.includes(normPhone.replace('+',''));

    if (!isTestMode(env) && !isWhitelisted) {
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const isWhitelistedIP = WHITELISTED_IPS.includes(ip);

      if (!isWhitelistedIP) {
        // IP rate limit — max 3 intake attempts per IP per hour
        const ipKey = `rate:intake:ip:${ip}`;
        const ipCount = parseInt(await env.SITES.get(ipKey) || '0');
        if (ipCount >= 3) {
          return jsonResponse({ error: 'Too many requests — please try again in an hour.' }, 429);
        }
        await env.SITES.put(ipKey, String(ipCount + 1), { expirationTtl: 3600 });
      }

      // Global daily cap — max 50 builds per day
      const today = new Date().toISOString().split('T')[0];
      const globalKey = `rate:intake:global:${today}`;
      const globalCount = parseInt(await env.SITES.get(globalKey) || '0');
      if (globalCount >= 50) {
        return jsonResponse({ error: 'Daily build limit reached — please try again tomorrow.' }, 429);
      }
      await env.SITES.put(globalKey, String(globalCount + 1), { expirationTtl: 86400 });

      // Phone deduplication — one build per phone per 24 hours
      const existing = await env.DB.prepare(
        `SELECT id, slug FROM clients
         WHERE phone = ? AND status NOT IN ('cancelled')
         AND created_at > datetime('now', '-1 day')
         LIMIT 1`
      ).bind(normPhone).first();

      if (existing) {
        return jsonResponse({
          error: 'You already have a site building today. Check your WhatsApp or email for your preview link, or come back tomorrow to start fresh.',
          slug: existing.slug,
        }, 429);
      }
    }

    const slug          = await uniqueSlug(business_name, env);
    const manage_token  = generateUUID();
    const referral_slug = slug.slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6);
    const packageKey    = pkgKey(pkg);

    const termsAccepted = body.terms_accepted ? new Date().toISOString() : null;
    const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || null;

    await env.DB.prepare(`
      INSERT INTO clients
        (id, business_name, client_name, slug, phone, email, package, retainer,
         industry, area, vibe, manage_token, referral_slug, promo_code, status, source, business_type,
         instagram, facebook, referred_by, terms_accepted_at, terms_accepted_ip)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'lead','website',?,?,?,?,?,?)
    `).bind(
      id, business_name, client_name || null, slug, normPhone, email || null,
      packageKey, body.promo_code ? (PRICING.promo?.retainer || 599) : (PRICING[packageKey]?.retainer || 699),
      industry || '', area || '', 'professional', manage_token, referral_slug,
      body.promo_code || null,
      body.business_type || '',
      body.instagram || null,
      body.facebook || null,
      body.referred_by || null,
      termsAccepted,
      clientIp,
    ).run();

    await logEvent(env, null, 'build', 'intake_received', 'success', { metadata: { business_name, slug, pkg: packageKey } });

    // GBP lookup — multipronged: phone → place_id/gbp_url → name+area
    let resolvedPlaceId = place_id;
    if (!resolvedPlaceId && body.gbp_url) {
      try {
        const gbpFromUrl = await fetchGbpData(body.gbp_url, env);
        if (gbpFromUrl?.id) resolvedPlaceId = gbpFromUrl.id;
      } catch(e) { console.warn('Short URL GBP resolve failed:', e.message); }
    }

    // Extract area from address text if area not explicitly provided
    let resolvedArea = area;
    if (!resolvedArea && address) {
      const parts = address.split(',').map(p => p.trim()).filter(Boolean);
      resolvedArea = parts[parts.length - 1] || parts[0] || '';
    }

    if (normPhone || resolvedPlaceId || business_name) {
      try {
        const data = await resolveGbp(env, resolvedPlaceId, business_name, resolvedArea, normPhone);
        await logEvent(env, id, 'build', 'gbp_diag', 'success', { metadata: {
          place_id: resolvedPlaceId,
          resolved: !!data,
          name_found: data?.displayName?.text || 'NONE',
          reviews: data?.userRatingCount || 0,
          real: isRealEstablishment(data),
        }});
        if (isRealEstablishment(data)) {
          const gbp = shapeGbp(data, business_name);
          try {
            await env.DB.prepare(
              `UPDATE clients SET gbp_data=?, gbp_place_id=?, area=COALESCE(NULLIF(area,''),?) WHERE id=?`
            ).bind(JSON.stringify(gbp), gbp.placeId || resolvedPlaceId, gbp.address?.split(',')[1]?.trim() || area || '', id).run();
            await logEvent(env, id, 'build', 'gbp_write', 'success', { metadata: { wrote: gbp.name, reviews: gbp.reviewCount } });
          } catch(e) {
            await logEvent(env, id, 'build', 'gbp_write', 'error', { error: e.message });
          }
        }
      } catch(e) { console.warn('GBP lookup failed:', e.message); }
    }

    await env.BUILD_QUEUE.send({ type: 'full_build', clientId: id, isOutbound: false });

    return jsonResponse({ slug, manage_token, clientId: id, redirectUrl: `https://${PREVIEW_DOMAIN}/preview/${manage_token}` });

  } catch (err) {
    console.error('Intake error:', err.message, err.stack);
    return jsonResponse({ error: 'intake_failed', detail: err.message }, 500);
  }
}


// ── GBP RESOLVE — fetch by place_id, fall back to proximity searchText if geocode ──
const GBP_FIELD_MASK = 'id,displayName,formattedAddress,shortFormattedAddress,location,nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,primaryTypeDisplayName,types,editorialSummary,reviews,rating,userRatingCount,photos';
const GBP_SEARCH_MASK = 'places.id,places.displayName,places.formattedAddress,places.shortFormattedAddress,places.location,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.primaryTypeDisplayName,places.types,places.editorialSummary,places.reviews,places.rating,places.userRatingCount,places.photos';

// A real business listing has reviews, a phone, or business types.
// A geocode (street/suburb) has none of these — detect and re-resolve.
function isRealEstablishment(data) {
  if (!data) return false;
  if (data.userRatingCount > 0) return true;
  if (data.nationalPhoneNumber) return true;
  const types = data.types || [];
  return types.some(t => t !== 'geocode' && t !== 'route' && t !== 'street_address'
    && t !== 'premise' && t !== 'subpremise' && t !== 'political'
    && !t.startsWith('administrative_area') && !t.startsWith('locality'));
}

async function resolveGbp(env, place_id, businessName, area, phone) {
  // PRINCIPLE: the business name identifies the business. The tapped place
  // only supplies a coordinate to bias proximity. The address never decides
  // *which* business — it only says "look near here." This is robust against
  // shared plaza addresses, wrong pins, geocodes, and anchor-tenant taps.

  // Step 0: phone number search — most accurate, unique identifier
  // Google Places searches work with local SA format (0xx xxx xxxx) not international
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    // Convert 27xxxxxxxxx → 0xxxxxxxxx for local format
    let localPhone = digits;
    if (digits.startsWith('27') && digits.length === 11) {
      localPhone = '0' + digits.slice(2);
    }
    // Format as 0xx xxx xxxx
    const formatted = localPhone.length === 10
      ? `${localPhone.slice(0,3)} ${localPhone.slice(3,6)} ${localPhone.slice(6)}`
      : localPhone;

    const search = await callPlacesProxy(env,
      'https://places.googleapis.com/v1/places:searchText',
      'POST',
      { textQuery: formatted, regionCode: 'ZA', maxResultCount: 1 },
      { 'X-Goog-FieldMask': GBP_SEARCH_MASK }
    ).catch(() => null);
    const best = search?.places?.[0];
    if (isRealEstablishment(best)) return best;
  }

  // Step 1: get a coordinate from the tapped place (works for geocode OR business)
  let coord = null;
  if (place_id) {
    const tapped = await callPlacesProxy(env,
      `https://places.googleapis.com/v1/places/${place_id}`,
      'GET', null, { 'X-Goog-FieldMask': 'id,location' }
    ).catch(() => null);
    if (tapped?.location) coord = tapped.location;
  }

  // Step 2: identify the business by NAME, biased to the tapped coordinate
  if (businessName) {
    const body = {
      textQuery:  [businessName, area].filter(Boolean).join(' '),
      regionCode: 'ZA',
    };
    if (coord) {
      body.locationBias = {
        circle: { center: { latitude: coord.latitude, longitude: coord.longitude }, radius: 500.0 },
      };
    }
    const search = await callPlacesProxy(env,
      'https://places.googleapis.com/v1/places:searchText',
      'POST', body, { 'X-Goog-FieldMask': GBP_SEARCH_MASK }
    ).catch(() => null);
    const best = search?.places?.[0];
    if (isRealEstablishment(best)) return best;
  }

  // Step 3: last resort — if name search found nothing but the tapped place
  // itself was a real establishment, use it rather than returning empty.
  if (place_id) {
    const tapped = await callPlacesProxy(env,
      `https://places.googleapis.com/v1/places/${place_id}`,
      'GET', null, { 'X-Goog-FieldMask': GBP_FIELD_MASK }
    ).catch(() => null);
    if (isRealEstablishment(tapped)) return tapped;
  }

  return null;
}

function shapeGbp(data, business_name) {
  return {
    name:         data.displayName?.text || business_name,
    placeId:      data.id || '',
    address:      data.formattedAddress || '',
    shortAddress: data.shortFormattedAddress || '',
    phone:        data.nationalPhoneNumber || '',
    website:      data.websiteUri || '',
    rating:       data.rating || null,
    reviewCount:  data.userRatingCount || 0,
    priceLevel:   data.priceLevel || null,
    category:     data.primaryTypeDisplayName?.text || '',
    types:        data.types || [],
    description:  data.editorialSummary?.text || '',
    hours:        data.regularOpeningHours?.weekdayDescriptions || [],
    reviews:      (data.reviews || []).slice(0,5).map(r => ({
      text:   r.text?.text || '',
      rating: r.rating || 0,
      author: r.authorAttribution?.displayName || '',
    })),
    photos:       (data.photos || []).slice(0,6).map(p => p.name || ''),
    amenities: {
      goodForChildren:      data.goodForChildren || false,
      goodForGroups:        data.goodForGroups || false,
      liveMusic:            data.liveMusic || false,
      servesBeer:           data.servesBeer || false,
      servesCocktails:      data.servesCocktails || false,
      servesWine:           data.servesWine || false,
      servesVegetarianFood: data.servesVegetarianFood || false,
      outdoorSeating:       data.outdoorSeating || false,
      reservable:           data.reservable || false,
      takeout:              data.takeout || false,
      delivery:             data.delivery || false,
      dineIn:               data.dineIn || false,
    },
    payment: {
      acceptsCreditCards: data.paymentOptions?.acceptsCreditCards || false,
      acceptsDebitCards:  data.paymentOptions?.acceptsDebitCards || false,
      acceptsCashOnly:    data.paymentOptions?.acceptsCashOnly || false,
    },
  };
}

// ── GBP PHOTO RESOLVER ───────────────────────────────────────
// Converts Places photo references to actual image URLs
// Google Places Photo API: GET /v1/{photo_name}/media?maxWidthPx=1200
async function resolveGbpPhotos(photoNames, env, maxPhotos = 1) {
  if (!photoNames?.length || !env.GOOGLE_MAPS_API_KEY) return [];

  const resolved = [];
  for (const name of photoNames.slice(0, maxPhotos)) {
    if (!name) continue;
    try {
      // Use places proxy to avoid CORS/IP issues
      const data = await callPlacesProxy(env,
        `https://places.googleapis.com/v1/${name}/media?maxWidthPx=1200&skipHttpRedirect=true`,
        'GET', null, {}
      );
      // Returns { photoUri: "https://..." }
      if (data?.photoUri) {
        resolved.push(data.photoUri);
      }
    } catch(e) {
      console.warn('GBP photo resolve failed:', e.message);
    }
  }
  return resolved;
}

// ── INSTAGRAM PHOTO FETCHER ──────────────────────────────────
// Routes through cPanel proxy — Instagram blocks Cloudflare IPs
async function fetchInstagramPhotos(handle, env) {
  if (!handle) return [];
  try {
    const cleanHandle = handle.replace(/^@/, '').replace(/https?:\/\/(www\.)?instagram\.com\/?/, '').replace(/\/$/, '').split('/')[0].split('?')[0];
    const PROXY  = 'https://classictouchsalon.co.za/rd-proxy.php';
    const SECRET = env.DOMAIN_PROXY_SECRET || 'mysecretkey123';

    // Use proxy to fetch Instagram profile info
    const res = await fetch(PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-proxy-secret': SECRET },
      body: JSON.stringify({
        action:  `/api/v1/users/web_profile_info/?username=${cleanHandle}`,
        method:  'GET',
        params:  {},
        headers: [
          'User-Agent: Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          'Accept: application/json, text/plain, */*',
          'X-IG-App-ID: 936619743392459',
        ],
        baseUrl: 'https://www.instagram.com',
      }),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const user = data?.data?.user;
    if (!user) return [];

    const photos = [];
    if (user.profile_pic_url_hd) photos.push(user.profile_pic_url_hd);
    const edges = user.edge_owner_to_timeline_media?.edges || [];
    for (const edge of edges.slice(0, 8)) {
      const url = edge.node?.display_url || edge.node?.thumbnail_src;
      if (url) photos.push(url);
    }

    if (photos.length > 0) {
      await logEvent(env, null, 'build', 'instagram_fetch_success', 'success', {
        metadata: { handle: cleanHandle, photos: photos.length }
      }).catch(() => {});
    }

    return photos.slice(0, 6);
  } catch(e) {
    console.warn('Instagram fetch failed:', e.message);
    return [];
  }
}

function detectArchetypeFromPersonality(personalityCategory, industry) {
  const k = (industry || '').toLowerCase();
  // Experience: sensory, immersive businesses
  if (['hospitality','personal_care','wellness','event_creative'].includes(personalityCategory)) return 'experience';
  if (/restaurant|salon|spa|barber|nail|hotel|venue|bakery|coffee|cafe|hair|lash|brow|massage|beauty|florist|flower|lodge|guest.house|wedding|tattoo|yoga|pilates/.test(k)) return 'experience';
  // Results: transformation, renovation, visual change, home finishing
  if (['transformation'].includes(personalityCategory)) return 'results';
  if (/floor|flooring|blind|curtain|shutter|renovate|renovation|paint|painting|tiling|tile|carpet|decor|interior|interior.design|landscap|garden|pool|solar|roof|roofing|ceiling|kitchen|bathroom|home.improv|finishing|plastering|paving|driveway|fencing|gates|aluminium|awning|canopy|upholstery|furniture|cabinet|built.in|wardrobe/.test(k)) return 'results';
  // Trust: professional services
  if (['professional_trust','medical_trust'].includes(personalityCategory)) return 'trust';
  // Local: community
  if (['community_local','retail_utility'].includes(personalityCategory)) return 'local';
  // Emergency: trade callouts
  if (['trade_authority','technical_expertise'].includes(personalityCategory)) return 'emergency';
  return 'experience'; // default
}

// ── SHOWCASE — live site carousel feed ───────────────────────────
async function handleShowcase(env) {
  try {
    const raw   = await env.SITES.get('showcase:queue');
    const queue = JSON.parse(raw || '[]');
    if (!queue.length) return new Response('[]', {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });

    const sites = await Promise.all(
      queue.map(async slug => {
        const c = await env.DB.prepare(
          `SELECT slug, business_name, industry, area, domain, hero_url, voice_profile
           FROM clients WHERE slug=? AND status='live' LIMIT 1`
        ).bind(slug).first().catch(() => null);
        if (!c) return null;

        // Extract accent colour from voice_profile palette if available
        let accent = '#00e8f5';
        try {
          const vp = JSON.parse(c.voice_profile || '{}');
          if (vp.primary_colour) accent = vp.primary_colour;
        } catch {}

        // Extract services from voice_profile
        let services = [];
        try {
          const vp = JSON.parse(c.voice_profile || '{}');
          if (Array.isArray(vp.services)) {
            services = vp.services.slice(0, 3).map(s => s.name || s).filter(Boolean);
          }
        } catch {}

        return {
          slug:     c.slug,
          business: c.business_name,
          industry: c.industry || '',
          location: c.area || '',
          services,
          accent,
          domain:   c.domain || (c.slug + '.co.za'),
          hero_url: c.hero_url || '',
        };
      })
    );

    const clean = sites.filter(Boolean);
    return new Response(JSON.stringify(clean), {
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=300',
      }
    });
  } catch(e) {
    return new Response('[]', { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}

// ── ADDRESS AUTOCOMPLETE — Google Places autocomplete for start page ──────────
async function handleAddressSuggest(url, env) {
  const q = url.searchParams.get('q');
  if (!q || q.length < 3) return jsonResponse({ suggestions: [] });

  if (!env.GOOGLE_MAPS_API_KEY) return jsonResponse({ suggestions: [] });

  try {
    const data = await callPlacesProxy(env,
      'https://places.googleapis.com/v1/places:autocomplete',
      'POST',
      { input: q, includedRegionCodes: ['ZA'], languageCode: 'en' },
      { 'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text' }
    );
    if (!data) return jsonResponse({ suggestions: [] });

    const suggestions = (data.suggestions || []).slice(0, 5).map(s => ({
      place_id:    s.placePrediction?.placeId || '',
      description: s.placePrediction?.text?.text || '',
    })).filter(s => s.place_id);

    return jsonResponse({ suggestions });
  } catch(e) {
    return jsonResponse({ suggestions: [] });
  }
}

// ── BUILD STATUS ──────────────────────────────────────────────

async function handleBuildStatus(url, env) {
  const token = url.searchParams.get('token');
  const slug  = url.searchParams.get('slug');

  let client;
  if (token) client = await getClientByToken(token, env);
  else if (slug) client = await getClientBySlug(slug, env);
  if (!client) return jsonResponse({ status: 'not_found' }, 404);

  return jsonResponse({
    status:     client.status,
    slug:       client.slug,
    package:    client.package || 'hub',
    retainer:   client.retainer || 699,
    promo_code: client.promo_code || null,
    previewUrl: client.preview_url || null,
    domain:     client.domain || null,
  });
}

async function handleClientStatus(url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'token required' }, 400);
  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ status: 'not_found' }, 404);
  return jsonResponse({ status: client.status, liveUrl: client.live_url || null });
}

// ── PREVIEW META ──────────────────────────────────────────────

async function handlePreviewMeta(url, env) {
  const slug = url.searchParams.get('slug');
  if (!slug) return jsonResponse({ error: 'slug required' }, 400);
  const client = await getClientBySlug(slug, env);
  if (!client) return jsonResponse({ error: 'not found' }, 404);
  return jsonResponse({
    business_name: client.business_name,
    area:          client.area,
    industry:      client.industry,
    package:       client.package,
    domain:        client.domain || `${slug}.co.za`,
    slug,
  });
}

// ── INTAKE PREVIEW (cosmetic per-card update) ─────────────────

async function handleIntakePreview(request, env) {
  // Cosmetic only — returns updated copy tokens without triggering a rebuild
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { token, field, value } = body;
  if (!token) return jsonResponse({ error: 'token required' }, 400);
  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not found' }, 404);
  // Store the update in voice_profile JSON
  const profile = safeJson(client.voice_profile) || {};
  profile[field] = value;
  await env.DB.prepare(`UPDATE clients SET voice_profile=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(JSON.stringify(profile), client.id).run();
  return jsonResponse({ success: true });
}

// ── TRIGGER SUBSTANCE BUILD ────────────────────────────────────

async function handleTriggerRebuild(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }
  const { token, package: pkg, cards } = body;
  if (!token || !cards) return jsonResponse({ error: 'token and cards required' }, 400);
  const client = await getClientByToken(token, env);
  if (!client) return jsonResponse({ error: 'not found' }, 404);

  // Update package + card fields
  const packageKey = pkgKey(pkg || client.package);
  const differentiator = [cards.diff1, cards.diff2, cards.diff3].filter(Boolean).join(' | ');
  await env.DB.prepare(`
    UPDATE clients SET
      package=?, retainer=?, industry=?, area=?, vibe=?,
      services=?, primary_cta=?, target_audience=?, testimonial=?,
      logo_url=?, palette=?, differentiator=?, status='building',
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(
    packageKey, PRICING[packageKey]?.retainer || 399,
    cards.industry || client.industry,
    cards.area     || client.area,
    cards.vibe     || client.vibe,
    JSON.stringify(cards.services || []),
    cards.cta      || null,
    cards.audience || null,
    cards.testimonial || null,
    cards.logo     || null,
    cards.palette  || null,
    differentiator || null,
    client.id
  ).run();

  await env.BUILD_QUEUE.send({ type: 'full_build', clientId: client.id, isOutbound: false });
  return jsonResponse({ success: true, status: 'building' });
}

// ── PWA / SITE SERVING ────────────────────────────────────────

async function servePwa(env, kvKey) {
  const html = await env.SITES.get(kvKey);
  if (!html) return new Response('PWA not bootstrapped', { status: 503 });
  return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' } });
}

// ── OG CARD — minimal HTML for WhatsApp rich preview ─────────────────────────
// Path: /{slug}/og
// WhatsApp crawls this, renders the card. Humans get auto-redirected to the
// real preview. Bots see the OG tags and stop (no redirect).
async function serveOgCard(path, env, request) {
  const slug = path.replace(/^\//, '').replace(/\/og$/, '');
  if (!slug) return new Response('Not found', { status: 404 });

  const client = await getClientBySlug(slug, env);
  if (!client) return new Response('Not found', { status: 404 });

  // Preserve promo param through the redirect
  const reqUrl = new URL(request?.url || `https://${PREVIEW_DOMAIN}${path}`);
  const promo  = reqUrl.searchParams.get('promo');
  const promoSuffix = promo ? `?promo=${encodeURIComponent(promo)}` : '';

  const voice   = safeJson(client.voice_profile) || {};
  const heroUrl = client.hero_url || '';
  const title   = esc(client.business_name);
  const area    = esc(client.area || '');
  const desc    = esc(voice.hero_subline || voice.meta_description || `${client.business_name} — built by Website Hub`);
  const dest    = `https://${PREVIEW_DOMAIN}/preview/${client.manage_token}${promoSuffix}`;
  const ogUrl   = `https://${PREVIEW_DOMAIN}/${slug}/og`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}${area ? ' — ' + area : ''}</title>
<meta name="description" content="${desc}">
<meta property="og:type" content="website">
<meta property="og:title" content="${title}${area ? ' — ' + area : ''}">
<meta property="og:description" content="${desc}">
${heroUrl ? `<meta property="og:image" content="${esc(heroUrl)}">` : ''}
<meta property="og:url" content="${ogUrl}">
<meta property="og:site_name" content="Website Hub">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
${heroUrl ? `<meta name="twitter:image" content="${esc(heroUrl)}">` : ''}
<meta http-equiv="refresh" content="0;url=${dest}">
<style>body{margin:0;background:#0a0a0a;color:#fff;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}</style>
</head>
<body>
<p>Opening your site preview… <a href="${dest}" style="color:#25D366">tap here if it doesn't open</a></p>
<script>window.location.replace("${dest}");</script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public,max-age=3600',
    },
  });
}

async function serveBuiltSite(url, path, request, env) {
  // /site/{slug} — raw HTML for PWA iframe (no wrapper)
  if (path.startsWith('/site/')) {
    const slug = path.replace(/^\/site\//, '').split('/')[0];
    if (!slug) return new Response('Not found', { status: 404 });
    const html = await env.SITES.get(`site:${slug}`) ||
                 await env.SITES.get(`preview:${slug}`);
    if (!html) return new Response(siteNotFound(slug), { status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
    return new Response(html, {
      headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-cache', 'X-Frame-Options': 'SAMEORIGIN' },
    });
  }

  // Paths: /{slug} or /{slug}/{page}
  const parts = path.replace(/^\//, '').split('/');
  const slug  = parts[0];
  const page  = parts[1] || 'index';

  if (!slug) return servePwa(env, 'app:start-v2');

  // Record visit (fire and forget)
  const client = await getClientBySlug(slug, env).catch(() => null);
  if (client?.id) fireAndForget(() => recordVisit(env, client.id, page));

  // /{slug} always serves the PWA shell (managed experience) until go-live
  // After go-live, live:{domain} takes over via custom hostname
  let html = await env.SITES.get(`preview:${slug}`);

  if (!html) {
    return new Response(siteNotFound(slug), {
      status: 404, headers: { 'Content-Type': 'text/html;charset=UTF-8' }
    });
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'no-cache',
      'X-Robots-Tag': 'noindex',
    },
  });
}

// ── PRE-BUILD PIPELINE ────────────────────────────────────────

// ── UNIFIED FULL BUILD PIPELINE ──────────────────────────────
// Single function. 6 passes. One WhatsApp.
// Replaces pre_build + substance_build queue hop.
// Pass 0: Design selection (archetype, layout, mood, typography)
// Pass 1: Brand intelligence
// Pass 2: Skeleton content
// Pass 3: UX refinement (non-fatal)
// Pass 4: Rich content with GBP
// Pass 5: Full content generation
// Pass 6: Quality gate (non-fatal)

async function triggerFullBuild(clientId, env, isOutbound = false, silent = false) {
  const client = await getClientById(clientId, env);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const slug      = client.slug;
  const pkg       = pkgKey(client.package);
  const buildId   = await createBuild(env, clientId, { template_id: pkg, palette: client.vibe || 'professional' });
  const buildStart = Date.now();

  await updateClient(env, clientId, { status: 'building' });
  await logEvent(env, clientId, 'build', 'full_build_started', 'success', {
    metadata: { business: client.business_name, pkg },
  });

  // ── PASS 0: Design Selection ────────────────────────────────
  // Fetch GBP data first — needed for selection pass
  let gbpData = null;
  if (client.gbp_data && client.gbp_data !== 'null' && client.gbp_data !== '{}') {
    try { gbpData = JSON.parse(client.gbp_data); } catch {}
  }
  if (!gbpData && client.gbp_url) {
    gbpData = await fetchGbpData(client.gbp_url, env).catch(() => null);
  }
  // If still no GBP data — try resolving now using phone + name + area
  const hasGbp = gbpData && typeof gbpData === 'object' && Object.keys(gbpData).length > 0 && gbpData.name;
  if (!hasGbp) {
    try {
      const fresh = await resolveGbp(env, client.gbp_place_id || null, client.business_name, client.area, client.phone || null);
      if (fresh && isRealEstablishment(fresh)) {
        gbpData = shapeGbp(fresh, client.business_name);
        await env.DB.prepare(
          `UPDATE clients SET gbp_data=?, gbp_place_id=? WHERE id=?`
        ).bind(JSON.stringify(gbpData), gbpData.placeId || '', clientId).run()
          .catch(e => logEvent(env, clientId, 'build', 'gbp_write_error', 'error', { error: e?.message || String(e) }));
        await logEvent(env, clientId, 'build', 'gbp_write', 'success', { metadata: { wrote: gbpData.name, reviews: gbpData.reviewCount, placeId: gbpData.placeId } });
      }
    } catch(e) { await logEvent(env, clientId, 'build', 'gbp_resolve_error', 'error', { error: e?.message || String(e) }); }
  }

  // Fetch Instagram photos if handle provided
  let instaPhotos = [];
  if (client.instagram) {
    instaPhotos = await fetchInstagramPhotos(client.instagram, env).catch(() => []);
  }

  // Run selection pass
  let selectionResult = null;
  try {
    const raw = await callClaudeInternal(
      selectionPassSystem(),
      [{ role: 'user', content: selectionPassUser(client, gbpData) }],
      env, { maxTokens: 500 }
    );
    selectionResult = parseJson(raw);
    await logEvent(env, clientId, 'build', 'pass0_selection_complete', 'success', {
      metadata: selectionResult,
    });
  } catch(e) {
    console.warn('Selection pass failed (non-fatal), using defaults:', e.message);
  }

  // Apply selection or fall back to personality system
  const personalityCategory = selectionResult?.personality_category ||
    getDesignBrief(client.industry || client.business_name, client.vibe).personality?.category ||
    'trade_authority';

  const variants = {
    colour_mood:    selectionResult?.colour_mood    || 'dark',
    hero_layout:    selectionResult?.hero_layout    || null,
    section_flow:   selectionResult?.section_flow   || null,
    typography_id:  selectionResult?.typography_id  || null,
  };

  // Generate fingerprint
  const fingerprint = generateFingerprint(personalityCategory, variants);
  await updateClient(env, clientId, { design_fingerprint: fingerprint }).catch(() => {});

  // Get full design brief with selection overrides
  const brief = getDesignBrief(client.industry || client.business_name, client.vibe);

  // Apply colour mood — swap to light palette if selected
  try {
    if (variants.colour_mood === 'light' && brief.personality?.palette_row_light) {
      const lightPalette = LIGHT_PALETTES[brief.personality.palette_row_light];
      if (lightPalette) brief.palette = lightPalette;
    }
    if (variants.typography_id) {
      const chosenTypo = getTypographyById(variants.typography_id);
      if (chosenTypo) brief.typography = {
        heading: chosenTypo.heading, body: chosenTypo.body,
        name: chosenTypo.name, cssImport: chosenTypo.import,
      };
    }
    if (brief.personality) {
      if (variants.section_flow) brief.personality.section_flow = variants.section_flow;
      if (variants.hero_layout)  brief.personality.hero_layouts = [variants.hero_layout, ...(brief.personality.hero_layouts || [])];
    }
  } catch(e) {
    console.warn('Brief override failed (non-fatal):', e.message);
  }

  // ── PASS 1: Brand Intelligence ──────────────────────────────
  let brandBrief;
  try {
    const raw = await callClaudeInternal(
      preBuildPass1System(brief),
      [{ role: 'user', content: preBuildPass1User(client, brief) }],
      env, { maxTokens: PASS_TOKENS.pre_1 }
    );
    brandBrief = parseJson(raw) || {};
    await logEvent(env, clientId, 'build', 'pass1_brand_complete', 'success', {});
  } catch(e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pass 1 (Brand) failed: ${e.message}`);
  }

  // ── PASS 2: Skeleton Content ────────────────────────────────
  let skeletonTokens;
  try {
    const raw = await callClaudeInternal(
      preBuildPass2System(),
      [{ role: 'user', content: preBuildPass2User(client, brief, brandBrief) }],
      env, { maxTokens: PASS_TOKENS.pre_2 }
    );
    skeletonTokens = parseJson(raw) || {};
    await logEvent(env, clientId, 'build', 'pass2_skeleton_complete', 'success', {});
  } catch(e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pass 2 (Skeleton) failed: ${e.message}`);
  }

  // ── PASS 3: UX Refinement (non-fatal) ──────────────────────
  try {
    const raw = await callClaudeInternal(
      preBuildPass3System(),
      [{ role: 'user', content: preBuildPass3User(skeletonTokens, brief) }],
      env, { maxTokens: PASS_TOKENS.pre_3 }
    );
    const refined = parseJson(raw);
    if (refined && Object.keys(refined).length > 0) {
      skeletonTokens = { ...skeletonTokens, ...refined };
    }
    await logEvent(env, clientId, 'build', 'pass3_ux_complete', 'success', {});
  } catch(e) {
    console.warn('Pass 3 (UX) failed (non-fatal):', e.message);
  }

  // ── PASS 4: Rich Brand Intelligence with GBP ────────────────
  let richBrandBrief;
  try {
    const raw = await callClaudeInternal(
      substancePass1System(brief),
      [{ role: 'user', content: substancePass1User(client, null, brief, skeletonTokens, gbpData) }],
      env, { maxTokens: PASS_TOKENS.sub_1 }
    );
    richBrandBrief = parseJson(raw) || brandBrief;
    await logEvent(env, clientId, 'build', 'pass4_richbrand_complete', 'success', {});
  } catch(e) {
    console.warn('Pass 4 (Rich Brand) failed, using pass 1 brandBrief:', e.message);
    richBrandBrief = brandBrief; // fallback to pass 1
  }

  // ── PASS 5: Full Content Generation ────────────────────────
  const pass5Budget = PACKAGE_CAPS[pkg]?.pass3TokenBudget || 7500;
  let contentTokens;
  try {
    const raw = await callClaudeInternal(
      substancePass2System(),
      [{ role: 'user', content: substancePass2User(client, null, brief, richBrandBrief, skeletonTokens) }],
      env, { maxTokens: pass5Budget }
    );
    contentTokens = parseJson(raw) || skeletonTokens;
    await logEvent(env, clientId, 'build', 'pass5_content_complete', 'success', {});
  } catch(e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pass 5 (Content) failed: ${e.message}`);
  }

  // ── PASS 6: Quality Gate (non-fatal) ───────────────────────
  try {
    const raw = await callClaudeInternal(
      substancePass3System(),
      [{ role: 'user', content: substancePass3User(contentTokens, null, brief) }],
      env, { maxTokens: PASS_TOKENS.sub_3 }
    );
    const refined = parseJson(raw);
    // Only merge if it's a plain object with string values — not audit text
    if (refined && typeof refined === 'object' && !Array.isArray(refined)) {
      const safeRefined = {};
      for (const [k, v] of Object.entries(refined)) {
        if (typeof v === 'string' || typeof v === 'number' || Array.isArray(v)) {
          safeRefined[k] = v;
        }
      }
      if (Object.keys(safeRefined).length > 0) {
        contentTokens = { ...contentTokens, ...safeRefined };
      }
    }
    await logEvent(env, clientId, 'build', 'pass6_quality_complete', 'success', {});
  } catch(e) {
    console.warn('Pass 6 (Quality) failed (non-fatal):', e.message);
  }

  // ── PHOTO ───────────────────────────────────────────────────
  // Combine GBP and Instagram photos — real business photos beat stock
  let heroUrl = null;
  let gbpGalleryPhotos = [];
  const allCandidatePhotos = [];

  // GBP photos
  if (gbpData?.photos?.length) {
    const resolvedPhotos = await resolveGbpPhotos(gbpData.photos, env, 6);
    allCandidatePhotos.push(...resolvedPhotos);
  }

  // Instagram photos
  if (instaPhotos.length > 0) {
    allCandidatePhotos.push(...instaPhotos);
  }

  if (allCandidatePhotos.length > 0) {
    heroUrl = allCandidatePhotos[0];
    gbpGalleryPhotos = allCandidatePhotos.slice(1, 6);
  }

  // Fall back to Unsplash if no real photos
  if (!heroUrl) {
    heroUrl = await fetchHeroPhoto(brief, richBrandBrief, env);
  }

  // ── CSS ─────────────────────────────────────────────────────
  const primaryColour = richBrandBrief?.logo_brand_colour || richBrandBrief?.primary_colour || null;
  const accentColour  = richBrandBrief?.accent_colour || null;
  const cssBlock      = buildCssVariables(brief.palette, brief.typography, primaryColour, accentColour);

  // ── LAYOUT ──────────────────────────────────────────────────
  const heroLayout      = variants.hero_layout || brief.personality?.hero_layouts?.[0] || 'cinematic_left';
  const openingStrategy = brief.personality?.opening_strategies?.[0] || 'proof_first';

  // ── GALLERY — all packages get gallery ─────────────────────
  let galleryPhotos = [...gbpGalleryPhotos]; // Start with GBP photos
  try {
    const rows = await env.DB.prepare(
      `SELECT url FROM gallery_photos WHERE client_id=? ORDER BY created_at DESC LIMIT 6`
    ).bind(clientId).all();
    const d1Photos = (rows.results || []).map(r => r.url);
    galleryPhotos = [...d1Photos, ...gbpGalleryPhotos].slice(0, 6);
  } catch {}

  // Unsplash fallback — use industry-relevant photos when no GBP photos
  if (galleryPhotos.length === 0) {
    (client.industry || '').toLowerCase();
    const UNSPLASH_QUERIES = {
      plumb:       'plumber pipes repair work',
      electr:      'electrician electrical installation',
      hair:        'hair salon styling',
      salon:       'beauty salon treatment',
      barber:      'barbershop haircut men',
      nail:        'nail salon manicure',
      spa:         'spa massage relaxation',
      massage:     'massage therapy spa',
      restaurant:  'restaurant food plating',
      food:        'food restaurant kitchen',
      coffee:      'coffee shop cafe interior',
      caf:         'coffee shop cafe espresso',
      bakery:      'bakery bread pastry',
      cake:        'cake bakery dessert',
      shisanyama:  'braai grill barbecue meat',
      butch:       'butchery meat fresh',
      carwash:     'car wash detailing clean',
      floor:       'flooring tiles interior design',
      blind:       'window blinds curtains interior',
      curtain:     'curtains blinds interior design',
      optical:     'optometrist eyewear glasses',
      dental:      'dental clinic teeth',
      dent:        'dentist dental office',
      construct:   'construction building site',
      paint:       'house painting interior',
      clean:       'professional cleaning service',
      laundry:     'laundry washing service',
      florist:     'florist flowers bouquet',
      flower:      'flower arrangement floral',
      gym:         'gym fitness workout',
      fitness:     'fitness gym training',
      physio:      'physiotherapy rehabilitation',
      secur:       'security guard professional',
      solar:       'solar panels installation',
      hvac:        'air conditioning installation',
      aircon:      'air conditioning cooling',
      mechanic:    'mechanic car repair garage',
      tyre:        'tyre wheel automotive',
      panel:       'panel beating car repair',
      photo:       'photography studio camera',
      video:       'videography filming production',
      event:       'event venue decoration',
      landscap:    'landscaping garden outdoor',
      garden:      'garden landscaping plants',
      pest:        'pest control professional',
      tutor:       'tutoring education study',
      driver:      'driving school car lesson',
    };
    const industryLower = (client.industry || '').toLowerCase();
    const key = Object.keys(UNSPLASH_QUERIES).find(k => industryLower.includes(k));
    const query = encodeURIComponent(UNSPLASH_QUERIES[key] || 'professional business workspace interior');
    const unsplashKey = env.UNSPLASH_ACCESS_KEY;
    if (unsplashKey) {
      try {
        const res = await fetch(`https://api.unsplash.com/photos/random?count=4&query=${query}&orientation=landscape`, {
          headers: { Authorization: `Client-ID ${unsplashKey}` }
        });
        if (res.ok) {
          const photos = await res.json();
          galleryPhotos = photos.map(p => p.urls?.regular || p.urls?.small).filter(Boolean);
        }
      } catch(e) { console.warn('Unsplash fallback failed:', e.message); }
    }
  }
  // Attach gallery photos to client object so archetype templates can use them
  const clientWithPhotos = { ...client, gallery_photos: galleryPhotos };
  const archetype = detectArchetypeFromPersonality(brief.personality?.category, client.industry);
  let html;
  if (archetype === 'experience') {
    html = generateExperienceHTML(contentTokens, heroUrl, clientWithPhotos, null, pkg, gbpData, richBrandBrief);
  } else if (archetype === 'emergency') {
    html = generateEmergencyHTML(contentTokens, heroUrl, clientWithPhotos, null, pkg, gbpData, richBrandBrief);
  } else if (archetype === 'trust') {
    html = generateTrustHTML(contentTokens, heroUrl, clientWithPhotos, null, pkg, gbpData, richBrandBrief);
  } else if (archetype === 'local') {
    html = generateLocalHTML(contentTokens, heroUrl, clientWithPhotos, null, pkg, gbpData, richBrandBrief);
  } else if (archetype === 'results') {
    html = generateResultsHTML(contentTokens, heroUrl, clientWithPhotos, null, pkg, gbpData, richBrandBrief);
  } else {
    html = generateFullHTML(contentTokens, cssBlock, heroUrl, clientWithPhotos, null, galleryPhotos, pkg, heroLayout, openingStrategy, brief.personality?.image_treatment || {});
  }

  // ── STORE ───────────────────────────────────────────────────
  await env.SITES.put(`site:${slug}`, html, { expirationTtl: PREVIEW_TTL });
  await env.SITES.put(`preview:${slug}`, html, { expirationTtl: PREVIEW_TTL });
  await env.SITES.put(`content:${slug}`, JSON.stringify(contentTokens), { expirationTtl: PREVIEW_TTL });

  const buildMs = Date.now() - buildStart;
  await updateBuild(env, buildId, {
    status: 'complete',
    build_time_ms: buildMs,
    voice_profile: JSON.stringify(contentTokens),
    unsplash_queries: JSON.stringify([richBrandBrief?.unsplash_query || brief.unsplashQuery]),
  });

  await updateClient(env, clientId, {
    status:           'preview_ready',
    voice_profile:    JSON.stringify(contentTokens),
    hero_url:         heroUrl,
    design_fingerprint: fingerprint,
  });

  await logEvent(env, clientId, 'build', 'full_build_complete', 'success', {
    durationMs: buildMs,
    metadata: { business: client.business_name, pkg, fingerprint },
  });

  // ── NOTIFY ──────────────────────────────────────────────────
  if (!isTestMode(env)) {
    await sendWhatsApp(env.WH_PHONE,
      `✅ FULL BUILD: ${client.business_name}\n${fingerprint}\n${buildMs}ms${silent ? ' [SILENT]' : ''}`,
      env, { skipTestRedirect: true }
    ).catch(e => logEvent(env, clientId, 'build', 'whatsapp_owner_failed', 'error', { error: e?.message || String(e) }));

    if (!silent) {
      const promoCode  = client.promo_code || null;
      const promoParam = promoCode ? `?promo=${encodeURIComponent(promoCode)}` : '';
      const isPromo = !!promoCode;

      let clientMsg;
      if (isOutbound && isPromo) {
        clientMsg =
          `👋 Hi *${client.business_name}*!\n\n` +
          `Website Hub is on a mission to make professional websites accessible to every South African small business.\n\n` +
          `We built one for you — have a look:\n` +
          `👉 https://${PREVIEW_DOMAIN}/${slug}/og${promoParam}\n\n` +
          `Normally R7,000 build fee + R699/month.\n` +
          `Today only: *no build fee* · R599/month · Cancel anytime.\n\n` +
          `— Website Hub`;
      } else if (isOutbound && !isPromo) {
        clientMsg =
          `👋 Hi *${client.business_name}*!\n\n` +
          `Website Hub believes every South African business deserves a professional online presence.\n\n` +
          `We built one for you — have a look:\n` +
          `👉 https://${PREVIEW_DOMAIN}/${slug}/og${promoParam}\n\n` +
          `R7,000 build fee · R699/month · Cancel anytime.\n\n` +
          `— Website Hub`;
      } else {
        clientMsg =
          `👋 *${client.business_name}* — your site is ready!\n\n` +
          `Have a look:\n` +
          `👉 https://${PREVIEW_DOMAIN}/${slug}/og${promoParam}\n\n` +
          `— Website Hub`;
      }

      await sendWhatsApp(client.phone, clientMsg, env)
      .catch(e => logEvent(env, clientId, 'build', 'whatsapp_client_failed', 'error', { error: e?.message || String(e) }));

      // Store OG card send time for 24hr nudge (promo only)
      if (isOutbound && isPromo) {
        await env.SITES.put(`promo_nudge:${clientId}`, new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), { expirationTtl: 60 * 60 * 48 });
      }
    } // end !silent
  }

  return slug;
}

async function triggerPreBuild(clientId, env, isOutbound = false) {
  const client = await getClientById(clientId, env);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const slug   = client.slug;
  const pkg    = pkgKey(client.package);
  const brief  = getDesignBrief(
    client.industry || client.business_type || client.business_name,
    client.vibe
  );
  const buildId = await createBuild(env, clientId, { template_id: pkg, palette: client.vibe });
  const buildStart = Date.now();

  await updateClient(env, clientId, { status: 'building' });
  await logEvent(env, clientId, 'build', 'pre_build_started', 'success', {
    metadata: { business: client.business_name, pkg, palette: brief.palette.notes }
  });

  // ── PASS 1: Brand Intelligence ─────────────────────────────
  let brandBrief;
  try {
    const raw = await callClaudeInternal(
      preBuildPass1System(brief),
      [{ role: 'user', content: preBuildPass1User(client, brief) }],
      env, { maxTokens: PASS_TOKENS.pre_1 }
    );
    brandBrief = parseJson(raw);
    await logEvent(env, clientId, 'build', 'pre_pass1_complete', 'success', {});
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pre-build Pass 1 failed: ${e.message}`);
  }

  // ── PASS 2: Skeleton Content ───────────────────────────────
  let contentTokens;
  try {
    const raw = await callClaudeInternal(
      preBuildPass2System(),
      [{ role: 'user', content: preBuildPass2User(client, brief, brandBrief) }],
      env, { maxTokens: PASS_TOKENS.pre_2 }
    );
    contentTokens = parseJson(raw);
    await logEvent(env, clientId, 'build', 'pre_pass2_complete', 'success', {});
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Pre-build Pass 2 failed: ${e.message}`);
  }

  // ── PASS 3: Mobile UX Check (non-fatal) ────────────────────
  try {
    const raw = await callClaudeInternal(
      preBuildPass3System(),
      [{ role: 'user', content: preBuildPass3User(contentTokens, brief) }],
      env, { maxTokens: PASS_TOKENS.pre_3 }
    );
    const refined = parseJson(raw);
    if (refined && Object.keys(refined).length > 0) {
      contentTokens = { ...contentTokens, ...refined };
    }
    await logEvent(env, clientId, 'build', 'pre_pass3_complete', 'success', {});
  } catch (e) {
    console.warn('Pre-build Pass 3 failed (non-fatal):', e.message);
  }

  // ── PHOTO ──────────────────────────────────────────────────
  const heroUrl = await fetchHeroPhoto(brief, brandBrief, env);

  // ── CSS ────────────────────────────────────────────────────
  const cssBlock = buildCssVariables(brief.palette, brief.typography);

  // ── HTML ───────────────────────────────────────────────────
  const html = generateSkeletonHTML(contentTokens, cssBlock, heroUrl, client);
  const finalHtml = addWatermark(html, client, env, isOutbound);

  // ── STORE ──────────────────────────────────────────────────
  await env.SITES.put(`preview:${slug}`, finalHtml, { expirationTtl: PREVIEW_TTL });
  await env.SITES.put(`content:${slug}`, JSON.stringify(contentTokens), { expirationTtl: PREVIEW_TTL });

  const buildMs = Date.now() - buildStart;
  await updateBuild(env, buildId, {
    status: 'complete',
    build_time_ms: buildMs,
    voice_profile: JSON.stringify(contentTokens),
    unsplash_queries: JSON.stringify([brandBrief.unsplash_query || brief.unsplashQuery]),
  });

  const previewUrl = `https://${PREVIEW_DOMAIN}/${slug}`;
  await updateClient(env, clientId, { status: 'preview_ready', preview_url: previewUrl, hero_url: heroUrl });

  await logEvent(env, clientId, 'build', 'pre_build_complete', 'success', {
    durationMs: buildMs,
    metadata: { business: client.business_name, pkg },
  });

  // ── NOTIFY ─────────────────────────────────────────────────
  if (!isTestMode(env)) {
    await sendWhatsApp(env.WH_PHONE,
      `✅ PRE-BUILD: ${client.business_name}\nPreview: ${previewUrl}\n${buildMs}ms`,
      env, { skipTestRedirect: true }
    ).catch(e => logEvent(env, clientId, 'build', 'whatsapp_owner_failed', 'error', { error: e?.message || String(e) }));

    if (!isOutbound) {
      client.promo_code || null;
      await sendWhatsApp(client.phone,
        `⚡ *${client.business_name}* — we're building your site now!\n\nWe'll send you another message when it's ready.\n\n— Website Hub`,
        env
      ).catch(e => logEvent(env, clientId, 'build', 'whatsapp_client_failed', 'error', { error: e?.message || String(e) }));
    }
  }

  return slug;
}

// ── SUBSTANCE BUILD PIPELINE ──────────────────────────────────


// ── GBP DATA FETCHER — extracts rich business data from Google Business Profile ──

// ── PLACES PROXY HELPER — routes all Google Places calls through VPS ─────────
async function callPlacesProxy(env, url, method = 'GET', postBody = null, extraHeaders = {}) {
  const fieldMask = extraHeaders['X-Goog-FieldMask'] || null;
  const apiKey = env.GOOGLE_MAPS_API_KEY;
  const res = await fetch('https://classictouchsalon.co.za/places-proxy.php', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-secret': env.DOMAIN_PROXY_SECRET || 'mysecretkey123',
    },
    body: JSON.stringify({
      url,
      method,
      postBody,
      fieldMask,
      apiKey,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.error) return null;
  return data;
}

async function fetchGbpData(gbpUrl, env) {
  if (!gbpUrl || !env.GOOGLE_MAPS_API_KEY) return null;

  try {
    // Step 1: Resolve short URLs (maps.app.goo.gl, g.page)
    let resolvedUrl = gbpUrl;
    if (gbpUrl.includes('goo.gl') || gbpUrl.includes('g.page')) {
      const resp = await fetch(gbpUrl, { method: 'HEAD', redirect: 'follow' });
      resolvedUrl = resp.url || gbpUrl;
    }

    // Step 2: Extract place identifier
    let placeId = null;
    let searchQuery = null;

    // Try to extract place ID from URL formats
    const placeMatch = resolvedUrl.match(/place\/([^/@]+)/);
    const cidMatch   = resolvedUrl.match(/[?&]cid=(\d+)/);
    const dataMatch  = resolvedUrl.match(/!1s([^!]+)!8m/);

    if (dataMatch) {
      placeId = decodeURIComponent(dataMatch[1]);
    } else if (placeMatch) {
      searchQuery = decodeURIComponent(placeMatch[1].replace(/\+/g, ' '));
    } else if (cidMatch) {
      searchQuery = `cid:${cidMatch[1]}`;
    }

    if (!env.GOOGLE_MAPS_API_KEY) return null;

    let place = null;
    const fieldMask = 'places.id,places.displayName,places.formattedAddress,places.nationalPhoneNumber,places.websiteUri,places.regularOpeningHours,places.primaryTypeDisplayName,places.editorialSummary,places.reviews,places.rating,places.userRatingCount,places.shortFormattedAddress';

    // Step 4a: Direct lookup by place ID
    if (placeId && placeId.startsWith('ChIJ')) {
      const data = await callPlacesProxy(env,
        `https://places.googleapis.com/v1/places/${placeId}`,
        'GET', null,
        { 'X-Goog-FieldMask': fieldMask.replace('places.','') }
      );
      if (data && !data.error) place = data;
    }

    // Step 4b: Text search fallback
    if (!place && searchQuery) {
      const data = await callPlacesProxy(env,
        'https://places.googleapis.com/v1/places:searchText',
        'POST',
        { textQuery: searchQuery, maxResultCount: 1, regionCode: 'ZA' },
        { 'X-Goog-FieldMask': fieldMask }
      );
      place = data?.places?.[0] || null;
    }

    if (!place) return null;

    // Step 5: Extract useful data
    const reviews = (place.reviews || []).slice(0, 3).map(r => ({
      text: r.text?.text || '',
      rating: r.rating || 5,
    }));

    return {
      name:         place.displayName?.text || null,
      address:      place.formattedAddress || place.shortFormattedAddress || null,
      phone:        place.nationalPhoneNumber || null,
      website:      place.websiteUri || null,
      category:     place.primaryTypeDisplayName?.text || null,
      description:  place.editorialSummary?.text || null,
      rating:       place.rating || null,
      reviewCount:  place.userRatingCount || 0,
      reviews,
      hours:        place.regularOpeningHours?.weekdayDescriptions || [],
      placeId:      place.id || null,
    };
  } catch(e) {
    console.warn('GBP fetch failed:', e.message);
    return null;
  }
}

async function triggerSubstanceBuild(clientId, cards, env) {
  const client = await getClientById(clientId, env);
  if (!client) throw new Error(`Client not found: ${clientId}`);

  const slug  = client.slug;
  const pkg   = pkgKey(client.package);
  const brief = getDesignBrief(
    cards?.industry || client.industry || client.business_type || client.business_name,
    cards?.vibe || client.vibe
  );

  // Use GBP data — from background lookup (place_id) or manual link (gbp_url)
  let gbpData = null;
  if (client.gbp_data) {
    try { gbpData = JSON.parse(client.gbp_data); } catch {}
  }
  if (!gbpData && cards?.gbp_url) {
    gbpData = await fetchGbpData(cards.gbp_url, env).catch(() => null);
  }
  if (gbpData) console.log(`GBP data for ${slug}: ${gbpData.name}, ${gbpData.reviewCount} reviews`);

  // Load pre-build voice profile as anchor
  const previewProfile = await env.SITES.get(`content:${slug}`, 'json').catch(() => null);

  const buildId    = await createBuild(env, clientId, { template_id: pkg, palette: cards?.palette || client.vibe });
  const buildStart = Date.now();

  await updateClient(env, clientId, { status: 'building' });
  await logEvent(env, clientId, 'build', 'substance_build_started', 'success', {
    metadata: { business: client.business_name, pkg },
  });

  // ── PASS 1: Rich Brand Intelligence ────────────────────────
  let brandBrief;
  try {
    const raw = await callClaudeInternal(
      substancePass1System(brief),
      [{ role: 'user', content: substancePass1User(client, cards, brief, previewProfile, gbpData) }],
      env, { maxTokens: PASS_TOKENS.sub_1 }
    );
    brandBrief = parseJson(raw);
    await logEvent(env, clientId, 'build', 'sub_pass1_complete', 'success', {});
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Substance Pass 1 failed: ${e.message}`);
  }

  // ── PASS 2: Full Content Generation ────────────────────────
  const pass2Budget = PACKAGE_CAPS[pkg]?.pass3TokenBudget || 7500;
  let contentTokens;
  try {
    const raw = await callClaudeInternal(
      substancePass2System(),
      [{ role: 'user', content: substancePass2User(client, cards, brief, brandBrief, previewProfile) }],
      env, { maxTokens: pass2Budget }
    );
    contentTokens = parseJson(raw);
    await logEvent(env, clientId, 'build', 'sub_pass2_complete', 'success', {});
  } catch (e) {
    await updateBuild(env, buildId, { status: 'failed', error: e.message });
    throw new Error(`Substance Pass 2 failed: ${e.message}`);
  }

  // ── PASS 3: Mobile UX + Quality Gate (non-fatal) ────────────
  try {
    const raw = await callClaudeInternal(
      substancePass3System(),
      [{ role: 'user', content: substancePass3User(contentTokens, cards, brief) }],
      env, { maxTokens: PASS_TOKENS.sub_3 }
    );
    const refined = parseJson(raw);
    if (refined && Object.keys(refined).length > 0) {
      contentTokens = { ...contentTokens, ...refined };
    }
    await logEvent(env, clientId, 'build', 'sub_pass3_complete', 'success', {});
  } catch (e) {
    console.warn('Substance Pass 3 failed (non-fatal):', e.message);
  }

  // ── PHOTO ──────────────────────────────────────────────────
  const heroUrl = await fetchHeroPhoto(brief, brandBrief, env);

  // ── COLOURS ─────────────────────────────────────────────────
  const primaryColour = brandBrief?.logo_brand_colour || brandBrief?.primary_colour || null;
  const accentColour  = brandBrief?.accent_colour || null;
  const cssBlock      = buildCssVariables(brief.palette, brief.typography, primaryColour, accentColour);

  // ── PERSONALITY — genome drives layout, Claude refines colour/voice only ──
  // Use personality genome directly — don't let Claude override layout
  const heroLayout       = brief.personality?.hero_layouts?.[0]       || 'cinematic_left';
  const openingStrategy  = brief.personality?.opening_strategies?.[0] || 'proof_first';
  brief.personality?.category || 'trade_authority';

  // ── GALLERY PHOTOS from D1 (Premium only) ──────────────────
  const caps        = PACKAGE_CAPS[pkg] || PACKAGE_CAPS.standard;
  let galleryPhotos = [];
  if (caps.gallery) {
    try {
      const rows = await env.DB.prepare(
        `SELECT url FROM gallery_photos WHERE client_id = ? ORDER BY created_at DESC LIMIT 6`
      ).bind(clientId).all();
      galleryPhotos = (rows.results || []).map(r => r.url);
    } catch {}
  }

  // ── HTML — archetype-routed ────────────────────────────────
  const archetype = detectArchetypeFromPersonality(brief.personality?.category, cards?.industry || client.industry);
  let html;
  if (archetype === 'experience') {
    html = generateExperienceHTML(contentTokens, heroUrl, client, cards, pkg, gbpData, brandBrief);
  } else if (archetype === 'emergency') {
    html = generateEmergencyHTML(contentTokens, heroUrl, client, cards, pkg, gbpData, brandBrief);
  } else if (archetype === 'trust') {
    html = generateTrustHTML(contentTokens, heroUrl, client, cards, pkg, gbpData, brandBrief);
  } else if (archetype === 'local') {
    html = generateLocalHTML(contentTokens, heroUrl, client, cards, pkg, gbpData, brandBrief);
  } else if (archetype === 'results') {
    html = generateResultsHTML(contentTokens, heroUrl, client, cards, pkg, gbpData, brandBrief);
  } else {
    html = generateFullHTML(contentTokens, cssBlock, heroUrl, client, cards, galleryPhotos, pkg, heroLayout, openingStrategy, brief.personality?.image_treatment || {});
  }

  // ── STORE ──────────────────────────────────────────────────
  // Raw HTML at site:{slug} — served at /site/{slug}
  await env.SITES.put(`site:${slug}`, html, { expirationTtl: PREVIEW_TTL });

  // preview:{slug} — served at /{slug} — always the built site
  await env.SITES.put(`preview:${slug}`, html, { expirationTtl: PREVIEW_TTL });

  await env.SITES.put(`content:${slug}`, JSON.stringify(contentTokens), { expirationTtl: PREVIEW_TTL });

  const buildMs = Date.now() - buildStart;
  await updateBuild(env, buildId, {
    status: 'complete',
    build_time_ms: buildMs,
    voice_profile: JSON.stringify(contentTokens),
    unsplash_queries: JSON.stringify([brandBrief.unsplash_query || brief.unsplashQuery]),
  });

  await updateClient(env, clientId, {
    status:        'preview_ready',
    voice_profile: JSON.stringify(contentTokens),
    hero_url:      heroUrl,
  });

  await logEvent(env, clientId, 'build', 'substance_build_complete', 'success', {
    durationMs: buildMs,
    metadata: { business: client.business_name, pkg },
  });

  await logEvent(env, clientId, 'build', 'whatsapp_attempt', 'info', {
    metadata: { ownerPhone: env.WH_PHONE ? 'set' : 'MISSING', clientPhone: client.phone || 'MISSING', testMode: String(isTestMode(env)) }
  });

  if (!isTestMode(env)) {
    await sendWhatsApp(env.WH_PHONE,
      `✅ SUBSTANCE BUILD: ${client.business_name}\nSlug: ${slug}\n${buildMs}ms`,
      env, { skipTestRedirect: true }
    ).catch(e => logEvent(env, clientId, 'build', 'whatsapp_owner_failed', 'error', { error: e?.message || String(e) }));

    // Client message — send to preview SPA (iframe + Go Live button)
    const promoCode  = client.promo_code || null;
    const promoParam = promoCode ? `?promo=${encodeURIComponent(promoCode)}` : '';
    await sendWhatsApp(client.phone,
      `🎉 *${client.business_name}* — your site is ready!\n\n` +
      `Have a look and go live when you're ready:\n\n` +
      `👉 https://${PREVIEW_DOMAIN}/preview/${client.manage_token}${promoParam}\n\n` +
      `— Website Hub`,
      env
    ).catch(e => logEvent(env, clientId, 'build', 'whatsapp_client_failed', 'error', { error: e?.message || String(e) }));
  }

  return slug;
}

// ── PASS PROMPTS: PRE-BUILD ───────────────────────────────────

function preBuildPass1System(brief) {
  return `You are a South African brand strategist. You have minimal information about a business — a name, area, and industry. The design system is already chosen (${brief.palette.notes}, ${brief.typography.name} typography). Read between the lines. Infer personality. Find the story angle that makes this business feel specific and real. SA context always. Output only valid JSON — no markdown, no explanation.`;
}

function preBuildPass1User(client, brief) {
  return `Business: ${client.business_name}
Area: ${client.area}
Industry: ${client.industry}
Design palette: ${brief.palette.notes}
Typography: ${brief.typography.name}
Brand accent colour: ${brief.palette.primary}

Output this JSON exactly:
{
  "inferred_tone": "2-4 words describing the brand voice",
  "hero_angle": "the specific angle that makes this business feel real",
  "tagline_candidates": ["option 1", "option 2", "option 3"],
  "trust_signals": ["signal 1", "signal 2", "signal 3"],
  "unsplash_query": "specific Unsplash search — industry + mood + setting, no text overlays, photographic quality"
}`;
}

function preBuildPass2System() {
  return `You are a South African copywriter building a skeleton website — the customer's first impression. Write short, punchy, and real. Every word earns its place. No filler. No corporate language. No generic phrases. Stay strictly within the word count limits. SA tone throughout. Output only valid JSON — no markdown.`;
}

function preBuildPass2User(client, brief, brandBrief) {
  return `Business: ${client.business_name}
Area: ${client.area}
Industry: ${client.industry}
${client.about ? `About: ${client.about}` : ''}
Brand tone: ${brandBrief.inferred_tone}
Hero angle: ${brandBrief.hero_angle}
Trust signals: ${brandBrief.trust_signals?.join(', ')}
Tagline options: ${brandBrief.tagline_candidates?.join(' / ')}

Word limits are HARD — do not exceed them.

Output this JSON exactly:
{
  "hero_h1": "max 5 words",
  "hero_subline": "max 10 words",
  "tagline": "max 6 words — choose from candidates or write better",
  "cta_primary": "max 4 words — WhatsApp action",
  "trust_line": "max 8 words — one trust signal below hero",
  "services": [
    {"name": "2-3 words", "icon": "single emoji"},
    {"name": "2-3 words", "icon": "single emoji"},
    {"name": "2-3 words", "icon": "single emoji"},
    {"name": "2-3 words", "icon": "single emoji"}
  ],
  "section_label_services": "max 3 words — uppercase label",
  "contact_headline": "max 5 words",
  "contact_subline": "max 8 words",
  "section_label_contact": "max 3 words — uppercase label"
}`;
}

function preBuildPass3System() {
  return `You are testing a mobile website on a Samsung Galaxy A15 in Durban. One hand. 1.5 second first paint. You are NOT an editor — do not rewrite for style. Only fix functional failures: headline too long, CTA not action-oriented, copy sounds like a template. Check against these UX rules: ${UX_RULES.map(r => r.rule + ': ' + r.do).join(' | ')}. Return ONLY the failing fields as a partial JSON object. If everything passes return {}.`;
}

function preBuildPass3User(contentTokens, brief) {
  return `Content to check:
${JSON.stringify(contentTokens, null, 2)}

Return only failing fields. Empty object {} if all pass.`;
}

// ── PASS PROMPTS: SUBSTANCE BUILD ─────────────────────────────

function substancePass1System(brief) {
  const p = brief.personality;
  return `You are a South African brand strategist and designer. You have been given a personality profile for this business — it defines the visual direction, layout archetype, and opening strategy. Your job is to:
1. Confirm or refine the personality classification based on the specific business context
2. Select the hero layout and opening strategy from the allowed options
3. Develop the brand voice and story
4. Choose colours that fit THIS specific business — the personality system gives you a baseline, but you should refine it based on their name, area, differentiators, and what makes them distinct

Personality profile assigned: ${p.category} (${p.label})
Allowed hero layouts: ${p.hero_layouts.join(', ')}
Allowed opening strategies: ${p.opening_strategies.join(', ')}
Baseline palette: ${brief.palette.notes}
Typography: ${brief.typography.name}

Colour guidance: The baseline palette is a starting point. Choose a primary colour that fits this specific business — richer and more specific than a generic industry colour. A flooring company in Richards Bay should feel different from one in Sandton. The accent colour drives CTAs and highlights — must pop on dark backgrounds. Only extract logo_brand_colour if a logo image was uploaded.

Output only valid JSON — no markdown.`;
}

function substancePass1User(client, cards, brief, previewProfile, gbpData) {
  const gbpBlock = gbpData ? `
Google Business Profile (use as primary source of truth for all copy):
Business: ${gbpData.name || ''}
Address: ${gbpData.address || ''}
Category: ${gbpData.category || ''}
Description: ${gbpData.description || ''}
Rating: ${gbpData.rating || ''} stars · ${gbpData.reviewCount || 0} reviews
Hours: ${(gbpData.hours || []).join(' | ')}
${gbpData.priceLevel ? `Price level: ${gbpData.priceLevel}` : ''}
${Object.entries(gbpData.amenities || {}).filter(([,v])=>v).map(([k])=>k.replace(/([A-Z])/g,' $1').toLowerCase()).join(', ')}
${gbpData.payment?.acceptsCreditCards ? 'Accepts credit cards' : ''}${gbpData.payment?.acceptsCashOnly ? ' · Cash only' : ''}
${gbpData.reviews?.length ? `Real customer reviews:\n${gbpData.reviews.map(r => `- "${r.text}" — ${r.author} (${r.rating}/5)`).join('\n')}` : ''}
${gbpData.photos?.length ? `Has ${gbpData.photos.length} real business photos available` : ''}
` : '';

  return `Business: ${client.business_name}
Area: ${client.area}
Industry: ${cards?.industry || client.industry}
Business type: ${client.business_type || cards?.industry || ''}
Services: ${(cards?.services || []).join(', ')}
Main CTA: ${cards?.cta || 'Get in touch'}
Differentiator 1: ${cards?.diff1 || ''}
Differentiator 2: ${cards?.diff2 || ''}
Differentiator 3: ${cards?.diff3 || ''}
Testimonial seed: ${cards?.testimonial || ''}
${gbpBlock}${previewProfile ? `\nExisting skeleton content (build forward from this, don't contradict):\nHero: ${previewProfile.hero_h1 || ''} — ${previewProfile.hero_subline || ''}` : ''}

Output this JSON exactly:
{
  "personality_category": "${brief.personality.category} — confirm or override with: trade_authority|transformation|personal_care|wellness|hospitality|community_local|professional_trust|technical_expertise|retail_utility|event_creative|mobility|medical_trust|memorial_legacy",
  "hero_layout": "choose from: ${brief.personality.hero_layouts.join('|')}",
  "opening_strategy": "choose from: ${brief.personality.opening_strategies.join('|')}",
  "brand_voice": "one sentence — their specific voice, not a category",
  "story_angle": "the narrative thread tying their differentiators together",
  "emotional_core": "what the customer feels after reading this site",
  "hero_angle": "specific and informed by their actual data",
  "differentiator_narrative": "one paragraph weaving diff1 + diff2 + diff3 into one story",
  "testimonial_frame": "how to present the testimonial seed most powerfully",
  "primary_colour": "refine from the baseline — a hex that fits THIS specific business, area, and personality. Not generic.",
  "accent_colour": "complementary accent hex — must contrast on dark backgrounds. Used for CTAs and highlights.",
  "logo_brand_colour": "extract dominant hex from uploaded logo/business card — otherwise null"
}`;
}

function substancePass2System() {
  return `You are a South African brand copywriter. You know this business personally — their story, their voice, their differentiators, what their happiest customer said. Write every section of their website in that voice. Not a generic trade voice. Not a template. Their specific voice. Every headline should be something only this business could say. Obey all word limits — the design containers are fixed. SA tone throughout. No stock phrases. Output only valid JSON — no markdown.`;
}

function substancePass2User(client, cards, brief, brandBrief, previewProfile) {
  const pkg  = pkgKey(client.package);
  const caps = PACKAGE_CAPS[pkg] || PACKAGE_CAPS.standard;
  const svcs = cards?.services || [];

  return `Business: ${client.business_name}
Area: ${client.area}
Phone: ${client.phone}
Domain: ${client.domain || client.slug + '.co.za'}
Brand voice: ${brandBrief.brand_voice}
Story angle: ${brandBrief.story_angle}
Emotional core: ${brandBrief.emotional_core}
Hero angle: ${brandBrief.hero_angle}
Differentiator narrative: ${brandBrief.differentiator_narrative}
Testimonial frame: ${brandBrief.testimonial_frame}
Raw testimonial: ${cards?.testimonial || ''}
Services (${svcs.length}): ${svcs.join(', ')}
Main CTA: ${cards?.cta || 'Get in touch'}
Audience: ${cards?.audience || 'local community'}
Package: ${pkg} (${caps.pass3TokenBudget} token budget — ${pkg === 'premium' ? 'maximum depth' : pkg === 'standard' ? 'full detail' : 'solid foundation'})

WORD LIMITS — hard limits, do not exceed:
hero_h1_line1/2: 4 words each | hero_subline: 12 words | hero_cta: 4 words | hero_trust_line: 8 words
about_headline: 8 words | about_pull_quote: 12 words | about_p1/p2: 45 words each
services_headline: 6 words | each service name: 3 words | each service desc: 12 words
whyus_headline: 6 words | each diff title: 4 words | each diff body: 15 words
testimonial_quote: 35 words | testimonial_context: 4 words
contact_headline: 6 words | contact_subline: 12 words | contact_cta: 4 words
All section labels: 3 words, UPPERCASE

Output this JSON exactly:
{
  "page_title": "${client.business_name} | ${client.industry} | ${client.area}",
  "short_name": "max 3 words — the nav/footer name (e.g. 'Classic Touch' not 'Classic Touch Unisex Hair & Beauty Salon')",
  "meta_description": "max 155 chars",
  "hero_h1_line1": "max 4 words",
  "hero_h1_line2": "max 4 words",
  "hero_subline": "max 12 words",
  "hero_cta": "max 4 words",
  "hero_trust_line": "max 8 words",
  "section_label_about": "UPPERCASE MAX 3 WORDS",
  "about_headline": "max 8 words — specific to their story",
  "about_pull_quote": "max 12 words — only this business would say this",
  "about_p1": "max 45 words — origin story",
  "about_p2": "max 45 words — what makes them different in ${client.area}",
  "section_label_services": "UPPERCASE MAX 3 WORDS",
  "services_headline": "max 6 words",
  "services": [${svcs.map(s => `{"name":"3 words max","desc":"12 words max","icon":"emoji"}`).join(',')}],
  "section_label_whyus": "UPPERCASE MAX 3 WORDS",
  "whyus_headline": "max 6 words",
  "diff1_title": "max 4 words", "diff1_body": "max 15 words",
  "diff2_title": "max 4 words", "diff2_body": "max 15 words",
  "diff3_title": "max 4 words", "diff3_body": "max 15 words",
  "testimonial_quote": "max 35 words",
  "testimonial_name": "first name or initial only",
  "testimonial_context": "max 4 words e.g. Homeowner KZN",
  "section_label_contact": "UPPERCASE MAX 3 WORDS",
  "contact_headline": "max 6 words",
  "contact_subline": "max 12 words",
  "contact_cta": "max 4 words"
}`;
}

function substancePass3System() {
  return `You are a mobile UX reviewer. Check the content tokens for two issues only:
1. MOBILE: Is the hero CTA label clear and thumb-reachable? Is any field too long for mobile?
2. SPECIFICITY: Do differentiators sound generic? Does the testimonial sound real?

If you find issues, return ONLY a valid JSON object with the corrected field values.
If everything passes, return exactly: {}

CRITICAL: Output ONLY valid JSON. No markdown. No explanations. No audit text. No comments. Just JSON or {}.`;
}

function substancePass3User(contentTokens, cards, brief) {
  return `Content to check:
${JSON.stringify(contentTokens, null, 2)}

Original client differentiators for comparison:
diff1: ${cards?.diff1 || ''} | diff2: ${cards?.diff2 || ''} | diff3: ${cards?.diff3 || ''}

Return only failing fields. Empty {} if all pass.`;
}

// ── HTML GENERATORS ───────────────────────────────────────────

function generateSkeletonHTML(t, cssBlock, heroUrl, client) {
  const phone  = client.phone?.replace(/\D/g, '');
  const domain = client.domain || `${client.slug}.co.za`;
  const waLink = `https://wa.me/${phone}`;
  const svcs   = t.services || [];

  // ── TAGLINE — best available from Pass 1/2 output ────────────
  const tagline   = t.tagline || t.hero_subline || '';
  const trustLine = t.trust_line || t.hero_trust_line || '';
  const heroH1    = t.hero_h1 || client.business_name;
  const ctaLabel  = t.cta_primary || 'WhatsApp Us';

  // ── SERVICE NAMES — up to 4, names only, no cards ────────────
  const svcNames = svcs.slice(0, 4).map(s => s.name || '').filter(Boolean);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heroH1)} | ${esc(client.area)}</title>
<meta name="description" content="${esc(tagline)}">
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(client.business_name)} — ${esc(client.area)}">
<meta property="og:description" content="${esc(tagline)}">
<meta property="og:image" content="${esc(heroUrl)}">
<meta property="og:url" content="https://${PREVIEW_DOMAIN}/${client.slug}/og">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(heroUrl)}">
${cssBlock}
<style>
/* ── PREVIEW RESET ───────────────────────────── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:var(--font-body);background:#0a0a0a;color:#f0ede8;overflow-x:hidden;padding-bottom:140px}

/* ── HERO — full bleed, image-dominant ──────── */
.preview-hero{
  position:relative;
  min-height:100svh;
  background-size:cover;
  background-position:center;
  display:flex;
  flex-direction:column;
  justify-content:flex-end;
}
.preview-hero::before{
  content:'';
  position:absolute;inset:0;
  background:linear-gradient(
    180deg,
    rgba(0,0,0,0) 0%,
    rgba(0,0,0,0.15) 30%,
    rgba(0,0,0,0.7) 60%,
    rgba(0,0,0,0.97) 100%
  );
}
.hero-body{
  position:relative;z-index:1;
  padding:0 24px 36px;
}
.hero-domain{
  display:inline-flex;align-items:center;gap:8px;
  font-family:var(--font-body);
  font-size:11px;letter-spacing:2px;text-transform:uppercase;
  color:var(--accent);
  margin-bottom:16px;
}
.hero-domain::before{
  content:'';
  width:6px;height:6px;border-radius:50%;
  background:var(--accent);
  animation:pulse 2s ease-in-out infinite;
}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.75)}}

.hero-h1{
  font-family:var(--font-heading);
  font-size:clamp(38px,11vw,68px);
  font-weight:800;
  line-height:1.02;
  letter-spacing:-0.025em;
  color:#fff;
  margin-bottom:12px;
  text-shadow:0 2px 24px rgba(0,0,0,0.5);
}
.hero-tagline{
  font-size:16px;
  color:rgba(255,255,255,0.82);
  line-height:1.55;
  margin-bottom:10px;
  font-weight:400;
  max-width:300px;
}
.hero-trust{
  font-size:11px;
  color:rgba(255,255,255,0.4);
  letter-spacing:1.8px;
  text-transform:uppercase;
  margin-bottom:28px;
  font-family:var(--font-body);
}
.hero-wa{
  display:inline-flex;align-items:center;gap:10px;
  padding:15px 24px;
  background:#25D366;
  color:#fff;
  font-size:15px;font-weight:700;
  border-radius:12px;
  text-decoration:none;
  width:100%;
  justify-content:center;
}

/* ── SERVICES STRIP — free floating, no cards ─ */
.services-strip{
  padding:40px 24px 8px;
}
.strip-label{
  font-size:10px;letter-spacing:3px;text-transform:uppercase;
  color:rgba(240,237,232,0.3);
  margin-bottom:20px;display:block;
}
.strip-list{
  display:flex;flex-direction:column;gap:0;
}
.strip-item{
  display:flex;align-items:center;gap:16px;
  padding:14px 0;
  border-bottom:1px solid rgba(255,255,255,0.06);
}
.strip-item:last-child{border-bottom:none}
.strip-num{
  font-family:var(--font-heading);
  font-size:11px;letter-spacing:2px;
  color:var(--accent);
  font-weight:700;
  flex-shrink:0;width:24px;
}
.strip-name{
  font-family:var(--font-heading);
  font-size:16px;font-weight:700;
  color:#f0ede8;
}

/* ── GHOST SECTIONS — honest locked placeholders ─ */
.ghost-wrap{
  padding:0 24px;
  display:flex;flex-direction:column;gap:12px;
  margin-top:32px;
}
.ghost-block{
  border-radius:16px;
  border:1px solid rgba(255,255,255,0.06);
  padding:24px 20px;
  position:relative;
  overflow:hidden;
}
.ghost-block::before{
  content:'';
  position:absolute;inset:0;
  background:linear-gradient(135deg,rgba(255,255,255,0.02),transparent);
  pointer-events:none;
}
.ghost-label{
  font-size:9px;letter-spacing:2.5px;text-transform:uppercase;
  color:rgba(240,237,232,0.2);
  margin-bottom:10px;display:block;
}
.ghost-lines{display:flex;flex-direction:column;gap:8px}
.ghost-line{
  height:10px;border-radius:4px;
  background:rgba(255,255,255,0.05);
}
.ghost-line.w100{width:100%}
.ghost-line.w75{width:75%}
.ghost-line.w55{width:55%}
.ghost-line.w85{width:85%}
.ghost-unlock{
  margin-top:14px;
  font-size:11px;
  color:rgba(var(--accent-rgb, 0,240,255),0.5);
  letter-spacing:.5px;
}

/* ── CLAIM BAR ───────────────────────────────── */
.claim-bar{
  position:fixed;bottom:0;left:0;right:0;z-index:999;
  background:rgba(8,8,8,0.97);
  backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);
  border-top:1px solid rgba(255,255,255,0.08);
  padding:14px 20px calc(14px + env(safe-area-inset-bottom,0px));
}
.claim-domain{
  font-family:var(--font-body);
  font-size:11px;letter-spacing:1.5px;text-transform:uppercase;
  color:rgba(240,237,232,0.4);
  text-align:center;
  margin-bottom:10px;
}
.claim-domain strong{color:var(--accent);font-weight:600}
.claim-btn{
  display:block;width:100%;
  padding:17px;border-radius:14px;
  background:linear-gradient(135deg,#00f0ff,#b829dd);
  color:#000;
  font-family:var(--font-body);
  font-size:16px;font-weight:800;
  text-align:center;text-decoration:none;
  letter-spacing:-0.3px;
}
.claim-sub{
  text-align:center;
  font-size:11px;
  color:rgba(240,237,232,0.3);
  margin-top:8px;
  letter-spacing:.3px;
}
</style>
</head>
<body>

<!-- ── HERO ───────────────────────────────────────────────── -->
<section class="preview-hero" style="background-image:url('${heroUrl}')">
  <div class="hero-body">
    <div class="hero-domain">${esc(domain)}</div>
    <h1 class="hero-h1">${esc(heroH1)}</h1>
    ${tagline   ? `<p class="hero-tagline">${esc(tagline)}</p>` : ''}
    ${trustLine ? `<p class="hero-trust">${esc(trustLine)}</p>` : ''}
    <a href="${waLink}" class="hero-wa">💬 ${esc(ctaLabel)}</a>
  </div>
</section>

<!-- ── SERVICES STRIP — free floating ────────────────────── -->
${svcNames.length > 0 ? `
<div class="services-strip">
  <span class="strip-label">${esc(t.section_label_services || 'What we do')}</span>
  <div class="strip-list">
    ${svcNames.map((name, i) => `
    <div class="strip-item">
      <span class="strip-num">${String(i + 1).padStart(2, '0')}</span>
      <span class="strip-name">${esc(name)}</span>
    </div>`).join('')}
  </div>
</div>` : ''}

<!-- ── GHOST SECTIONS — locked, honest ───────────────────── -->
<div class="ghost-wrap">

  <div class="ghost-block">
    <span class="ghost-label">Your story</span>
    <div class="ghost-lines">
      <div class="ghost-line w100"></div>
      <div class="ghost-line w85"></div>
      <div class="ghost-line w75"></div>
    </div>
    <div class="ghost-unlock">Unlock by completing your profile →</div>
  </div>

  <div class="ghost-block">
    <span class="ghost-label">Why choose you</span>
    <div class="ghost-lines">
      <div class="ghost-line w75"></div>
      <div class="ghost-line w100"></div>
      <div class="ghost-line w55"></div>
    </div>
    <div class="ghost-unlock">Unlock by completing your profile →</div>
  </div>

  <div class="ghost-block">
    <span class="ghost-label">What your customers say</span>
    <div class="ghost-lines">
      <div class="ghost-line w85"></div>
      <div class="ghost-line w100"></div>
      <div class="ghost-line w55"></div>
    </div>
    <div class="ghost-unlock">Unlock by completing your profile →</div>
  </div>

</div>

<!-- ── CLAIM BAR ──────────────────────────────────────────── -->
<div class="claim-bar">
  <div class="claim-domain"><strong>${esc(domain)}</strong> is yours to claim</div>
  <a href="__CLAIM_LINK__" class="claim-btn" onclick="window.top.location.href=this.href;return false;">Claim &amp; build your site free →</a>
  <div class="claim-sub">No build fee &nbsp;·&nbsp; No credit card &nbsp;·&nbsp; Live in 2 minutes</div>
</div>

</body>
</html>`;
}


// ══════════════════════════════════════════════════════════════
// HERO RENDERER REGISTRY
// 3 layouts × 4 opening strategies = 12 distinct hero experiences
// ══════════════════════════════════════════════════════════════

// ── OPENING STRATEGY COMPOSERS ────────────────────────────────
function composeOpening(strategy, t) {
  switch (strategy) {
    case 'proof_first':
      return {
        pre:  t.hero_trust_line || '',
        h1:   t.hero_h1_line1 || t.hero_h1 || '',
        h1b:  t.hero_h1_line2 || '',
        sub:  t.hero_subline   || '',
        type: 'proof',
      };
    case 'emotional_story':
      return {
        pre:  t.hero_subline   || '',
        h1:   t.hero_h1_line1  || t.hero_h1 || '',
        h1b:  t.hero_h1_line2  || '',
        sub:  t.hero_trust_line || '',
        type: 'emotion',
      };
    case 'direct_offer':
      return {
        pre:  t.hero_trust_line || '',
        h1:   t.hero_h1_line1  || t.hero_h1 || '',
        h1b:  t.hero_h1_line2  || '',
        sub:  t.hero_subline   || '',
        type: 'offer',
      };
    case 'manifesto':
    default:
      return {
        pre:  '',
        h1:   t.hero_h1_line1  || t.hero_h1 || '',
        h1b:  t.hero_h1_line2  || '',
        sub:  t.hero_subline   || '',
        type: 'manifesto',
      };
  }
}

// ── TRADE AUTHORITY HERO ──────────────────────────────────────
// Dense, trust-bar-led, left-anchored. Dark overlay dominates.
// Used for: trades, security, technical expertise, mobility
function renderTradeAuthorityHero(t, client, waLink, openingStrategy, heroUrl, img) {
  const o    = composeOpening(openingStrategy, t);
  const bgPos = img.bg_position || 'center 30%';
  const minH  = img.hero_height || '90svh';
  const pills = o.pre ? o.pre.split(/[·|,·]/).map(p => p.trim()).filter(Boolean) : [];
  const trustBar = pills.length > 0
    ? `<div class="trust-bar">${pills.map((p,i) => `<span class="trust-pill">${esc(p)}</span>${i < pills.length-1 ? '<span class="trust-sep"></span>' : ''}`).join('')}</div>`
    : '';

  return `<section class="hero-ta" style="background-image:url('${heroUrl}');min-height:${minH};background-position:${bgPos}">
  <div class="hero-content">
    ${trustBar}
    <h1 class="hero-h1">${esc(o.h1)}${o.h1b ? '<br>' + esc(o.h1b) : ''}</h1>
    <p class="hero-sub">${esc(o.sub)}</p>
    <a href="${waLink}" class="cta-wa">💬 ${esc(t.hero_cta || 'Get a Quote')}</a>
  </div>
</section>`;
}

// ── CINEMATIC LEFT HERO ───────────────────────────────────────
// Image carries 70% emotional weight. Text hard left, breathing room.
// Used for: transformation, hospitality, event_creative, personal_care
function renderCinematicHero(t, client, waLink, openingStrategy, heroUrl, img) {
  const o     = composeOpening(openingStrategy, t);
  const bgPos = img.bg_position || 'center';
  const minH  = img.hero_height || '100svh';
  const warm  = img.scrim === 'warm_bottom'
    ? 'background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(20,8,0,0.92) 100%)'
    : 'background:linear-gradient(105deg,rgba(0,0,0,0.82) 0%,rgba(0,0,0,0.5) 55%,rgba(0,0,0,0.1) 100%),linear-gradient(180deg,rgba(0,0,0,0) 40%,rgba(0,0,0,0.9) 100%)';

  const preHtml = o.type === 'emotion'
    ? `<p class="hero-emotion" style="color:rgba(255,255,255,0.9);text-shadow:0 1px 8px rgba(0,0,0,0.6)">${esc(o.pre)}</p>`
    : o.pre
      ? `<p class="trust-line">${esc(o.pre)}</p>`
      : '';

  return `<section class="hero-cl" style="background-image:url('${heroUrl}');min-height:${minH};background-position:${bgPos}"><style>.hero-cl::before{${warm}}</style>
  <div class="hero-content">
    ${preHtml}
    <h1 class="hero-h1">${esc(o.h1)}${o.h1b ? '<br>' + esc(o.h1b) : ''}</h1>
    <p class="hero-sub">${esc(o.sub)}</p>
    <a href="${waLink}" class="cta-wa">💬 ${esc(t.hero_cta || 'WhatsApp Us')}</a>
  </div>
</section>`;
}

// ── QUIET PREMIUM HERO ────────────────────────────────────────
// Restrained, editorial. Acres of breathing room. Small CTA.
// Used for: professional_trust, medical_trust, memorial_legacy, property
function renderQuietPremiumHero(t, client, waLink, openingStrategy, heroUrl, img) {
  const o     = composeOpening(openingStrategy, t);
  const bgPos = img.bg_position || 'center';
  const minH  = img.hero_height || '100svh';

  // Eyebrow = area + industry signal
  const eyebrow = [client.area, t.section_label_about].filter(Boolean).join(' · ').toUpperCase();

  return `<section class="hero-qp" style="background-image:url('${heroUrl}');min-height:${minH};background-position:${bgPos}">
  <div class="hero-content">
    <span class="hero-eyebrow">${esc(eyebrow)}</span>
    ${o.pre ? `<p style="font-size:13px;color:rgba(255,255,255,0.85);letter-spacing:1px;margin-bottom:16px;font-weight:500;text-shadow:0 1px 8px rgba(0,0,0,0.5)">${esc(o.pre)}</p>` : ''}
    <h1 class="hero-h1">${esc(o.h1)}${o.h1b ? '<br>' + esc(o.h1b) : ''}</h1>
    <p class="hero-p">${esc(o.sub)}</p>
    <a href="${waLink}" class="cta-qp">Get in touch →</a>
  </div>
</section>`;
}

// ── SECTION FLOW ORCHESTRATOR ─────────────────────────────────
// Reorders sections based on personality-driven flow
// Eliminates the same Hero→About→Services→WhyUs→Testimonial every time
function renderSections(flow, sections) {
  const { aboutSection, servicesSection, gallerySection, whyUsSection, testimonialSection, mapSection, enquiryForm } = sections;

  const orders = {
    service_first: [servicesSection, gallerySection, aboutSection, whyUsSection, testimonialSection, mapSection, enquiryForm],
    story_first:   [aboutSection, servicesSection, gallerySection, whyUsSection, testimonialSection, mapSection, enquiryForm],
    proof_first:   [whyUsSection, testimonialSection, servicesSection, gallerySection, aboutSection, mapSection, enquiryForm],
    emotion_first: [testimonialSection, aboutSection, servicesSection, gallerySection, whyUsSection, mapSection, enquiryForm],
  };

  return (orders[flow] || orders.service_first).filter(Boolean).join('\n');
}


const HERO_RENDERERS = {
  trade_authority:  renderTradeAuthorityHero,
  split_authority:  renderTradeAuthorityHero,   // alias
  cinematic_left:   renderCinematicHero,
  before_after:     renderCinematicHero,         // alias
  warm_community:   renderCinematicHero,         // alias
  editorial_offset: renderCinematicHero,         // alias
  quiet_premium:    renderQuietPremiumHero,
  centered_manifesto: renderQuietPremiumHero,    // alias — build separately later
};

function renderHero(heroLayout, openingStrategy, t, client, waLink, heroUrl, imageTreatment) {
  const renderer = HERO_RENDERERS[heroLayout] || renderCinematicHero;
  return renderer(t, client, waLink, openingStrategy, heroUrl, imageTreatment || {});
}

function generateFullHTML(t, cssBlock, heroUrl, client, cards, photos, pkg, heroLayout = 'cinematic_left', openingStrategy = 'proof_first', imageTreatment = {}) {
  const phone   = client.phone?.replace(/\D/g, '');
  const domain  = client.domain || `${client.slug}.co.za`;
  const waLink  = `https://wa.me/${phone}`;
  const svcs    = t.services || [];
  const tier    = pkgKey(pkg || client.package || 'express');
  const isExp   = tier === 'express';
  const isPrem  = tier === 'premium';

  // ── NAV LINKS — Express is minimal ────────────────────────────
  const navLinks = isExp
    ? `<a href="#services" class="nav-link">Services</a>
    <a href="#contact" class="nav-link">Contact</a>
    <a href="${waLink}" class="nav-link" style="color:var(--accent)">WhatsApp</a>`
    : `<a href="#about"    class="nav-link">About</a>
    <a href="#services" class="nav-link">Services</a>
    <a href="#contact"  class="nav-link">Contact</a>
    <a href="${waLink}" class="nav-link" style="color:var(--accent)">WhatsApp</a>`;

  // ── ABOUT SECTION — Standard + Premium only ────────────────────
  const aboutSection = isExp ? '' : `
<!-- ABOUT -->
<section id="about" class="section-bleed">
  <span class="label">${esc(t.section_label_about || 'OUR STORY')}</span>
  <h2 class="section-h2">${esc(t.about_headline || '')}</h2>
  <p class="pull-quote">${esc(t.about_pull_quote || '')}</p>
  <p class="body-text">${esc(t.about_p1 || '')}</p>
  <p class="body-text">${esc(t.about_p2 || '')}</p>
</section>`;

  // ── SERVICES — Express gets max 4, no descriptions ─────────────
  const svcList  = isExp ? svcs.slice(0, 4) : svcs;
  const svcCards = svcList.map((s, i) => `
    <div class="service-card">
      <div class="service-num">${String(i + 1).padStart(2, '0')}</div>
      <div class="service-name">${esc(s.name || '')}</div>
      ${!isExp ? `<div class="service-desc">${esc(s.desc || '')}</div>` : ''}
    </div>`).join('');

  const servicesSection = `
<!-- SERVICES -->
<section id="services" class="section">
  <span class="label">${esc(t.section_label_services || 'WHAT WE DO')}</span>
  <h2 class="section-h2">${esc(t.services_headline || '')}</h2>
  <div class="services-grid">${svcCards}</div>
</section>`;

  // ── SECTION FLOW — personality-driven ordering ──────────────
  const sectionFlow = openingStrategy === 'proof_first'  ? 'proof_first'
                    : openingStrategy === 'emotional_story' ? 'story_first'
                    : 'service_first';

  // ── WHY US — Standard + Premium only, card-free ──────────────
  // Differentiators rendered as free-floating editorial blocks, not cards
  const whyUsSection = isExp ? '' : `
<!-- WHY US -->
<section id="why-us" class="section">
  <span class="label">${esc(t.section_label_whyus || 'WHY US')}</span>
  <h2 class="section-h2">${esc(t.whyus_headline || '')}</h2>
  <div style="margin-top:32px;display:flex;flex-direction:column;gap:0">
    <div style="padding:24px 0;border-bottom:1px solid var(--border)">
      <div style="font-family:var(--font-heading);font-size:17px;font-weight:700;margin-bottom:8px;color:var(--fg)">${esc(t.diff1_title || '')}</div>
      <div style="font-size:14px;color:var(--muted-fg);line-height:1.6">${esc(t.diff1_body || '')}</div>
    </div>
    <div style="padding:24px 0;border-bottom:1px solid var(--border)">
      <div style="font-family:var(--font-heading);font-size:17px;font-weight:700;margin-bottom:8px;color:var(--fg)">${esc(t.diff2_title || '')}</div>
      <div style="font-size:14px;color:var(--muted-fg);line-height:1.6">${esc(t.diff2_body || '')}</div>
    </div>
    <div style="padding:24px 0">
      <div style="font-family:var(--font-heading);font-size:17px;font-weight:700;margin-bottom:8px;color:var(--fg)">${esc(t.diff3_title || '')}</div>
      <div style="font-size:14px;color:var(--muted-fg);line-height:1.6">${esc(t.diff3_body || '')}</div>
    </div>
  </div>
</section>`;

  // ── TESTIMONIAL — Standard + Premium only ──────────────────────
  const testimonialSection = isExp ? '' : `
<!-- TESTIMONIAL -->
<section class="section">
  <div class="testimonial-wrap">
    <div class="testimonial-card">
      <div class="stars">★★★★★</div>
      <p class="testimonial-quote">${esc(t.testimonial_quote || '')}</p>
      <div class="testimonial-attr">${esc(t.testimonial_name || '')} · ${esc(t.testimonial_context || '')}</div>
    </div>
  </div>
</section>`;

  // ── GALLERY — Premium only, requires uploaded photos ───────────
  const gallerySection = photos?.length > 0 ? `
<!-- GALLERY -->
<section id="gallery" class="section">
  <span class="label">${t.section_label_gallery || 'OUR WORK'}</span>
  <h2 class="section-h2">See it for yourself</h2>
  <div style="margin:0 -28px;overflow:hidden">
    <div id="galleryTrack" style="display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;padding:20px 28px">
      ${photos.slice(0,6).map((url,i) => `<div style="flex-shrink:0;width:78vw;max-width:320px;scroll-snap-align:start"><img src="${esc(url)}" alt="Our work" style="width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:16px;display:block"></div>`).join('')}
    </div>
    <div id="galleryDots" style="display:flex;justify-content:center;gap:6px;padding-bottom:8px">
      ${photos.slice(0,6).map((_,i) => `<div class="gdot${i===0?' active':''}" data-idx="${i}" style="width:${i===0?'20px':'6px'};height:6px;border-radius:3px;background:${i===0?'var(--accent)':'rgba(0,0,0,.2)'};cursor:pointer;transition:all .3s"></div>`).join('')}
    </div>
  </div>
</section>` : '';

  // ── MAP — Premium only, if address provided ────────────────────
  const address = cards?.address || client.address || '';
  const mapSection = isPrem && address ? `
<!-- MAP -->
<section class="section">
  <span class="label">FIND US</span>
  <h2 class="section-h2">Come see us</h2>
  <a href="https://maps.google.com/?q=${encodeURIComponent(address)}" target="_blank" rel="noopener"
     style="display:flex;align-items:center;gap:14px;background:var(--card-solid);border:1px solid var(--border);border-radius:16px;padding:18px;text-decoration:none;color:inherit;margin-top:16px">
    <span style="font-size:28px">📍</span>
    <div>
      <div style="font-weight:600;margin-bottom:4px">${esc(address)}</div>
      <div style="font-size:13px;color:var(--accent)">Open in Google Maps →</div>
    </div>
  </a>
</section>` : '';

  // ── ENQUIRY FORM — Premium only ────────────────────────────────
  const enquiryForm = isPrem && cards?.contactFormEnabled ? `
<!-- ENQUIRY FORM -->
<section class="section-bleed">
  <span class="label">QUICK ENQUIRY</span>
  <h2 class="section-h2">Send us a message</h2>
  <form id="enquiryForm" onsubmit="submitEnquiry(event)" style="display:flex;flex-direction:column;gap:12px;margin-top:20px">
    <input type="text" id="eq-name" placeholder="Your name" required
           style="padding:14px;background:var(--card-solid);border:1px solid var(--border);border-radius:12px;color:var(--fg);font-size:15px">
    <input type="tel" id="eq-phone" placeholder="Your WhatsApp number"
           style="padding:14px;background:var(--card-solid);border:1px solid var(--border);border-radius:12px;color:var(--fg);font-size:15px">
    <textarea id="eq-msg" placeholder="Your message" rows="4" required
           style="padding:14px;background:var(--card-solid);border:1px solid var(--border);border-radius:12px;color:var(--fg);font-size:15px;resize:none"></textarea>
    <button type="submit" style="padding:15px;background:var(--accent);color:#fff;border:none;border-radius:12px;font-size:15px;font-weight:700;cursor:pointer">Send →</button>
  </form>
  <script>
  function submitEnquiry(e) {
    e.preventDefault();
    const name = document.getElementById('eq-name').value;
    const msg  = document.getElementById('eq-msg').value;
    window.location.href = 'https://wa.me/${phone}?text=' + encodeURIComponent('Hi, I\'m ' + name + '. ' + msg);
  }
  </script>
</section>` : '';

  // ── SOCIAL FOOTER LINKS — Standard + Premium ───────────────────
  const socialLinks = !isExp && (cards?.instagram || cards?.facebook || cards?.tiktok) ? `
  <div style="display:flex;gap:16px;justify-content:center;margin-bottom:12px">
    ${cards.instagram ? `<a href="https://instagram.com/${cards.instagram.replace('@','')}" target="_blank" rel="noopener" style="color:var(--muted-fg);font-size:13px">📸 ${cards.instagram}</a>` : ''}
    ${cards.facebook  ? `<a href="https://facebook.com/${cards.facebook.replace('@','')}"  target="_blank" rel="noopener" style="color:var(--muted-fg);font-size:13px">👍 ${cards.facebook}</a>`  : ''}
    ${cards.tiktok    ? `<a href="https://tiktok.com/${cards.tiktok.replace('@','')}"      target="_blank" rel="noopener" style="color:var(--muted-fg);font-size:13px">🎵 ${cards.tiktok}</a>`    : ''}
  </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(t.page_title || client.business_name)}</title>
<meta name="description" content="${esc(t.meta_description || '')}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(client.business_name)} — ${esc(client.area || '')}">
<meta property="og:description" content="${esc(t.hero_subline || t.meta_description || '')}">
<meta property="og:image" content="${esc(heroUrl)}">
<meta property="og:url" content="https://${PREVIEW_DOMAIN}/${client.slug}/og">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(heroUrl)}">
${cssBlock}
<style>${STRUCTURAL_CSS}</style>
</head>
<body>

<nav class="nav">
  ${client.logo_url ? `<img src="${client.logo_url}" class="nav-logo" alt="${esc(client.business_name)}">` : `<a href="/" class="nav-brand">${esc(client.business_name)}</a>`}
  <div class="nav-links">${navLinks}</div>
</nav>

${renderHero(heroLayout, openingStrategy, t, client, waLink, heroUrl, imageTreatment)}

${renderSections(sectionFlow, { aboutSection, servicesSection, gallerySection, whyUsSection, testimonialSection, mapSection, enquiryForm })}

<!-- CONTACT -->
<section id="contact" class="section-bleed">
  <span class="label">${esc(t.section_label_contact || 'GET IN TOUCH')}</span>
  <h2 class="section-h2">${esc(t.contact_headline || '')}</h2>
  <p class="body-text">${esc(t.contact_subline || '')}</p>
  <a href="${waLink}" class="cta-wa">💬 ${esc(t.contact_cta || 'WhatsApp Us')}</a>
</section>

<footer class="footer">
  ${socialLinks}
  <div class="footer-brand">${esc(client.business_name)}</div>
  <div class="footer-meta">${esc(client.area)} · ${esc(domain)}</div>
  <div class="footer-credit">Built by Website Hub</div>
</footer>

<div class="fab-stack">
  ${client.phone ? `<a href="tel:${client.phone}" class="fab-btn fab-call" aria-label="Call">📞</a>` : ''}
  <a href="${waLink}" class="fab-btn fab-wa" aria-label="WhatsApp">💬</a>
</div>

<script>
// Gallery carousel
(function(){
  const track=document.getElementById('galleryTrack');
  const dots=document.querySelectorAll('.gdot');
  if(!track||!dots.length)return;
  track.addEventListener('scroll',function(){
    const idx=Math.round(track.scrollLeft/(track.querySelector('div')?.offsetWidth+12||1));
    dots.forEach(function(d,i){
      d.style.width=i===idx?'20px':'6px';
      d.style.background=i===idx?'var(--accent)':'rgba(0,0,0,.2)';
    });
  },{passive:true});
  dots.forEach(function(d,i){
    d.addEventListener('click',function(){
      const slides=track.querySelectorAll(':scope > div');
      if(slides[i])slides[i].scrollIntoView({behavior:'smooth',block:'nearest',inline:'start'});
    });
  });
})();
</script>

<script>
(function(){
  var s='${client.slug}';
  if(!s)return;
  new Image().src='/'+s+'/ping';
  document.querySelectorAll('a[href*="wa.me"]').forEach(function(a){
    a.addEventListener('click',function(){new Image().src='/'+s+'/wa';},{once:true,passive:true});
  });
})();
</script>

</body>
</html>`;
}

function addWatermark(html, client, env, isOutbound = false) {
  const claimLink = `https://${PREVIEW_DOMAIN}/intake/${client.manage_token}`;

  // Inject claim link into skeleton preview bar — replaces __CLAIM_LINK__ placeholder
  // For outbound builds, swap the entire claim bar CTA text too
  let result = html.replace('__CLAIM_LINK__', claimLink);

  // Outbound: override the claim bar copy to drive fresh signups
  if (isOutbound) {
    result = result
      .replace('is yours to claim', 'was built for you')
      .replace('Claim &amp; build your site free →', 'Claim this site free →')
      .replace('No build fee', 'Yours before someone else claims it');
  }

  return result;
}

// ── PHOTO FETCHING ────────────────────────────────────────────

async function fetchHeroPhoto(brief, brandBrief, env) {
  if (!env.UNSPLASH_ACCESS_KEY) return FALLBACK_HERO;

  // Always use photo-db validated pools — use industryKey from personality system
  const industry = brief.industryKey || 'general';
  const query    = getHeroPhotoQueryByKey(industry);
  const vibe     = '';

  // Fetch from Unsplash — get 3 results, take first (best relevance match)
  try {
    const endpoint = `https://api.unsplash.com/photos/random`
      + `?query=${encodeURIComponent(query.slice(0, 100))}`
      + `&orientation=landscape&content_filter=high&count=3`;
    const res  = await fetch(endpoint, {
      headers: { 'Authorization': `Client-ID ${env.UNSPLASH_ACCESS_KEY}`, 'Accept-Version': 'v1' }
    });
    if (!res.ok) return FALLBACK_HERO;
    const data = await res.json();

    // data is array when count>1, object when count=1
    const photos = Array.isArray(data) ? data : [data];
    const photo  = photos[0];
    const url    = photo?.urls?.regular || photo?.urls?.full;
    if (!url) return FALLBACK_HERO;

    console.log(`[photo] industry=${industry} query="${query}" url=${url}`);

    // Cache in D1 library
    await env.DB.prepare(
      `INSERT OR IGNORE INTO photos (unsplash_id, url, thumb_url, query_used, industry, vibe, slot)
       VALUES (?,?,?,?,?,?,'hero')`
    ).bind(photo.id, url, photo.urls?.thumb || url, query, industry, vibe).run().catch(() => {});

    return url;
  } catch {
    return FALLBACK_HERO;
  }
}

// ── CRON — OUTBOUND PROSPECTING ───────────────────────────────

async function handleCron(env) {
  if (isTestMode(env)) return;

  // Respect master outbound toggle
  const outboundEnabled = await env.DB.prepare(`SELECT value FROM config WHERE key='outbound_enabled' LIMIT 1`).first().catch(() => null);
  if (!outboundEnabled || outboundEnabled.value !== 'true') {
    await logEvent(env, null, 'build', 'cron_skipped', 'info', { metadata: { reason: 'outbound_enabled is false' } });
    return;
  }

  await logEvent(env, null, 'build', 'cron_run', 'success', { metadata: { trigger: 'scheduled' } });

  // Get approved prospects not yet contacted and not on cooldown
  const prospects = await env.DB.prepare(
    `SELECT * FROM prospects
     WHERE status = 'approved'
       AND (cooldown_until IS NULL OR cooldown_until < CURRENT_TIMESTAMP)
       AND contacted_at IS NULL
     LIMIT 10`
  ).all();

  for (const p of (prospects.results || [])) {
    try {
      // Create client record from prospect
      const id           = generateUUID();
      const slug         = await uniqueSlug(p.business_name, env);
      const manage_token = generateUUID();
      const referral_slug = slug.slice(0, 8) + '-' + Math.random().toString(36).slice(2, 6);

      await env.DB.prepare(`
        INSERT INTO clients
          (id, business_name, slug, phone, industry, area, vibe, manage_token,
           referral_slug, promo_code, status, source, package, retainer)
        VALUES (?,?,?,?,?,?,?,?,?,'LAUNCH2026','lead','outbound','hub',?)
      `).bind(id, p.business_name, slug, p.phone || '', p.industry || '', p.area || '',
          'professional', manage_token, referral_slug, PRICING.promo?.retainer || 599).run();

      await env.DB.prepare(`UPDATE prospects SET status='built', client_id=?, contacted_at=CURRENT_TIMESTAMP WHERE id=?`)
        .bind(id, p.id).run();

      // Queue outbound pre-build (with watermark)
      await env.BUILD_QUEUE.send({ type: 'full_build', clientId: id, isOutbound: true });

    } catch (err) {
      console.error(`Cron: failed for prospect ${p.id}:`, err.message);
      await env.DB.prepare(`UPDATE prospects SET cooldown_until=datetime('now','+7 days') WHERE id=?`)
        .bind(p.id).run().catch(() => {});
    }
  }

  await logEvent(env, null, 'build', 'cron_complete', 'success', {
    metadata: { processed: prospects.results?.length || 0 }
  });
}

// ── D1 HELPERS ────────────────────────────────────────────────

async function getClientById(id, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE id=? LIMIT 1`).bind(id).first();
}

async function getClientByToken(token, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE manage_token=? LIMIT 1`).bind(token).first();
}

async function getClientBySlug(slug, env) {
  return env.DB.prepare(`SELECT * FROM clients WHERE slug=? LIMIT 1`).bind(slug).first();
}

async function updateClient(env, id, fields) {
  const cols = Object.keys(fields).map(k => `${k}=?`).join(',');
  const vals = Object.values(fields);
  await env.DB.prepare(`UPDATE clients SET ${cols}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(...vals, id).run();
}

async function createBuild(env, clientId, fields) {
  const result = await env.DB.prepare(
    `INSERT INTO builds (client_id, template_id, palette, status) VALUES (?,?,?,'building')`
  ).bind(clientId, fields.template_id || null, fields.palette || null).run();
  return result.meta?.last_row_id;
}

async function updateBuild(env, buildId, fields) {
  const cols = Object.keys(fields).map(k => `${k}=?`).join(',');
  const vals = Object.values(fields);
  await env.DB.prepare(`UPDATE builds SET ${cols} WHERE id=?`).bind(...vals, buildId).run();
}

async function logEvent(env, clientId, worker, eventType, status, opts = {}) {
  await env.DB.prepare(
    `INSERT INTO events (client_id, worker, event_type, status, duration_ms, error, metadata)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(
    clientId || null, worker, eventType, status,
    opts.durationMs || null, opts.error || null,
    opts.metadata ? JSON.stringify(opts.metadata) : null
  ).run().catch(e => console.warn('logEvent failed:', e.message));
}

async function recordVisit(env, clientId, page) {
  await env.DB.prepare(
    `INSERT INTO visits (client_id, date, page, count) VALUES (?,date('now'),?,1)
     ON CONFLICT(client_id, date, page) DO UPDATE SET count=count+1`
  ).bind(clientId, page).run().catch(() => {});
}

// ── UTILITIES ─────────────────────────────────────────────────

function generateUUID() {
  return crypto.randomUUID();
}

function slugify(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')  // remove special chars
    .trim()
    .replace(/\s+/g, '')           // join words — no hyphens
    .slice(0, 63);
}

async function uniqueSlug(name, env) {
  const base = slugify(name);

  // Try clean slug first
  const existing = await env.DB.prepare(
    `SELECT slug FROM clients WHERE slug = ? LIMIT 1`
  ).bind(base).first().catch(() => null);
  if (!existing) return base;

  // Try with number suffix: zululandflooring2, zululandflooring3...
  for (let i = 2; i <= 9; i++) {
    const candidate = base + i;
    const ex = await env.DB.prepare(
      `SELECT slug FROM clients WHERE slug = ? LIMIT 1`
    ).bind(candidate).first().catch(() => null);
    if (!ex) return candidate;
  }

  // Last resort — random 4-char suffix
  return base + '-' + Math.random().toString(36).slice(2, 6);
}

function pkgKey(pkg) {
  const p = (pkg || 'hub').toLowerCase().trim().replace(/[^a-z_]/g, '');
  if (p === 'hub_pro' || p === 'hubpro' || p === 'premium') return 'hub_pro';
  if (p === 'promo')  return 'promo';
  if (p === 'hub' || p === 'standard') return 'hub';
  if (p === 'legacy' || p === 'express') return 'hub'; // legacy → hub
  return 'hub'; // default
}

function parseJson(raw) {
  try {
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());
    return result;
  } catch {
    return null;
  }
}

function safeJson(str) {
  try { return JSON.parse(str); } catch { return null; }
}

function esc(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function clientNotFoundHtml(hostname) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site not found</title><style>*{margin:0;padding:0;box-sizing:border-box}body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#f0ede8;font-family:-apple-system,sans-serif;text-align:center;padding:40px}h1{font-size:22px;font-weight:600;margin-bottom:8px}p{font-size:14px;opacity:.5;margin-bottom:24px}a{color:#00f0ff;text-decoration:none;font-size:13px}</style></head><body><div><h1>Site not found</h1><p>This site hasn't launched yet or the address is incorrect.</p><a href="https://websitehub.co.za">← Website Hub</a></div></body></html>`;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function fireAndForget(fn) {
  fn().catch(e => console.warn('fireAndForget error:', e));
}

function siteNotFound(slug) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not Found</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0a0a0a;color:#f0ede8;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.box{max-width:400px}h1{font-size:22px;margin-bottom:12px}p{color:rgba(240,237,232,0.55);line-height:1.6}a{color:#25D366;font-weight:700;text-decoration:none}</style></head><body><div class="box"><h1>Site not found</h1><p>The site <strong>${slug}</strong> doesn't exist yet.<br><br><a href="https://websitehub.co.za">Visit Website Hub →</a></p></div></body></html>`;
}

export { index as default };
