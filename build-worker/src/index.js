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

import { callClaudeInternal, sendWhatsApp, isTestMode, normaliseSaPhone, PRICING, PACKAGE_CAPS } from './shared-services.js';
import { getDesignBrief, buildCssVariables, UX_RULES, getPersonality, SECTION_FLOWS, SPACING_RHYTHMS, generateFingerprint, selectionPassSystem, selectionPassUser, LIGHT_PALETTES } from '../../design-db.js';
import { getHeroPhotoQuery, getHeroPhotoQueryByKey, getIndustryKey } from '../../photo-db.js';
import { generateExperienceHTML } from './archetypes/experience.js';
import { generateEmergencyHTML }  from './archetypes/emergency.js';
import { generateTrustHTML }      from './archetypes/trust.js';
import { generateLocalHTML }      from './archetypes/local.js';
import { generateResultsHTML }    from './archetypes/results.js';

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

export default {
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
        return new Response(html, { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600', 'X-Served-By': 'wh-build' } });
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
      if (path === '/admin/bootstrap-blast'    && method === 'POST') return handleAdminBootstrap(request, env, 'app:blast');
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
      if (path === '/admin/test-whatsapp'     && method === 'POST') return handleTestWhatsapp(request, env);
      if (path === '/admin/get-config'         && method === 'GET')  return handleGetConfig(env);
      if (path === '/admin/debug-env'           && method === 'GET')  return jsonResponse({
        has_maps_key: !!env.GOOGLE_MAPS_API_KEY,
        maps_key_prefix: env.GOOGLE_MAPS_API_KEY?.slice(0,10) || 'MISSING',
        has_anthropic: !!env.ANTHROPIC_KEY,
        has_google_refresh: !!env.GOOGLE_REFRESH_TOKEN,
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

async function handleAdminSetConfig(request, env) {
  const patch  = await request.json();
  const stored = await env.SITES.get('app:config', 'json') || DEFAULT_CONFIG;
  const merged = deepMerge(stored, patch);
  await env.SITES.put('app:config', JSON.stringify(merged));
  return jsonResponse({ success: true, config: merged });
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
    `SELECT * FROM prospects WHERE status='pending' AND scrape_date=date('now') ORDER BY id DESC LIMIT ?`
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
          (id, business_name, slug, phone, industry, area, manage_token,
           referral_slug, promo_code, status, source, package, retainer)
        VALUES (?,?,?,?,?,?,?,?,?,'lead','outbound','hub',?)
      `).bind(id, p.business_name, slug, p.phone || '', p.industry || '', p.area || '',
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
  const res = await fetch('https://places-proxy.websitehub.co.za', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-secret': env.PLACES_PROXY_SECRET || env.DOMAIN_PROXY_SECRET || 'mysecretkey123',
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

async function getGoogleAccessToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'refresh_token',
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
      }),
    });
    const d = await res.json();
    return d.access_token || null;
  } catch { return null; }
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

async function handleAdminResetBuild(request, env) {
  const body = await request.json().catch(() => ({}));
  const { clientId, slug } = body;
  const client = clientId
    ? await env.DB.prepare(`SELECT * FROM clients WHERE id=? LIMIT 1`).bind(clientId).first()
    : await env.DB.prepare(`SELECT * FROM clients WHERE slug=? LIMIT 1`).bind(slug).first();
  if (!client) return jsonResponse({ error: 'clientId or slug required' }, 400);
  await env.DB.prepare(`UPDATE clients SET status='preview_ready', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(client.id).run();
  return jsonResponse({ success: true, clientId: client.id, status: 'preview_ready' });
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

async function handleAdminResetTest(env) {
  if (!isTestMode(env)) return jsonResponse({ error: 'Only in test mode' }, 403);
  await env.DB.prepare(`DELETE FROM events`).run();
  await env.DB.prepare(`DELETE FROM builds`).run();
  await env.DB.prepare(`DELETE FROM messages`).run();
  await env.DB.prepare(`DELETE FROM visits`).run();
  await env.DB.prepare(`DELETE FROM revisions`).run();
  await env.DB.prepare(`DELETE FROM invoices`).run();
  await env.DB.prepare(`DELETE FROM referrals`).run();
  await env.DB.prepare(`DELETE FROM clients WHERE status != 'live'`).run();
  return jsonResponse({ success: true });
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
          await env.DB.prepare(
            `UPDATE clients SET gbp_data=?, gbp_place_id=?, area=COALESCE(NULLIF(area,''),?) WHERE id=?`
          ).bind(JSON.stringify(gbp), gbp.placeId || resolvedPlaceId, gbp.address?.split(',')[1]?.trim() || area || '', id).run()
            .then(() => logEvent(env, id, 'build', 'gbp_write', 'success', { metadata: { wrote: gbp.name, reviews: gbp.reviewCount } }))
            .catch(e => logEvent(env, id, 'build', 'gbp_write', 'error', { error: e.message }));
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
const GBP_FIELD_MASK = 'id,displayName,formattedAddress,shortFormattedAddress,location,nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,currentOpeningHours,primaryTypeDisplayName,types,editorialSummary,reviews,rating,userRatingCount,photos,priceLevel,paymentOptions,goodForChildren,goodForGroups,liveMusic,servesBeer,servesCocktails,servesWine,servesVegetarianFood,outdoorSeating,reservable,takeout,delivery,dineIn,parkingOptions';
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
  if (client.gbp_data) {
    try { gbpData = JSON.parse(client.gbp_data); } catch {}
  }
  if (!gbpData && client.gbp_url) {
    gbpData = await fetchGbpData(client.gbp_url, env).catch(() => null);
  }
  // If still no GBP data — try resolving now using phone + name + area
  const hasGbp = gbpData && typeof gbpData === 'object' && Object.keys(gbpData).length > 0;
  if (!hasGbp) {
    try {
      const fresh = await resolveGbp(env, client.gbp_place_id || null, client.business_name, client.area, client.phone || null);
      if (fresh && isRealEstablishment(fresh)) {
        gbpData = shapeGbp(fresh, client.business_name);
        await env.DB.prepare(
          `UPDATE clients SET gbp_data=?, gbp_place_id=? WHERE id=?`
        ).bind(JSON.stringify(gbpData), gbpData.placeId || '', clientId).run().catch(() => {});
        await logEvent(env, clientId, 'build', 'gbp_write', 'success', { metadata: { wrote: gbpData.name, reviews: gbpData.reviewCount } });
      }
    } catch(e) { console.warn('triggerFullBuild GBP lookup failed:', e.message); }
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
    const industry = (client.industry || '').toLowerCase();
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
      const promoCode  = client.promo_code || null;
      const promoParam = promoCode ? `?promo=${encodeURIComponent(promoCode)}` : '';
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
  // API key is hardcoded in VPS proxy — Cloudflare Tunnel strips custom headers
  const res = await fetch('https://places-proxy.websitehub.co.za', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-proxy-secret': env.DOMAIN_PROXY_SECRET || 'mysecretkey123',
    },
    body: JSON.stringify({
      url,
      method,
      postBody,
      fieldMask: extraHeaders['X-Goog-FieldMask'] || null,
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
  const personalityCategory = brief.personality?.category || 'trade_authority';

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
  const isStd   = tier === 'standard';
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

  const useCache = false; // Always fresh — different query each build
  if (useCache) {
    try {
      const cached = await env.DB.prepare(
        `SELECT url FROM photos WHERE industry=? AND slot='hero' ORDER BY RANDOM() LIMIT 3`
      ).bind(industry).all();
      if (cached.results?.length >= 1) {
        const chosen = cached.results[Math.floor(Math.random() * cached.results.length)];
        await env.DB.prepare(`UPDATE photos SET usage_count=usage_count+1, last_used_at=CURRENT_TIMESTAMP WHERE url=?`)
          .bind(chosen.url).run().catch(() => {});
        return chosen.url;
      }
    } catch {}
  }

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

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source || {})) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
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

