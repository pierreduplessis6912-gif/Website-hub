// ============================================================
// WEBSITE HUB — patch-worker.js
// Owns surgical preview patches (no rebuild), asset uploads to R2,
// gallery management, the email gateway (updates@websitehub.co.za),
// the manage panel data endpoint, the revision flow including paid
// revision PayFast handshake, and Claude vision brand-signal extraction
// from uploaded photos.
//
// ROUTES OWNED:
//   POST /patch-preview            — surgical KV patch from SPA tweak drawer
//   POST /upload-assets            — manage panel photo upload to R2
//   GET  /asset/{key}              — R2 proxy
//   GET  /gallery-assets/{slug}    — JSON list of gallery photo URLs (site fetch)
//   POST /patch-gallery            — admin manual gallery patch
//   POST /submit-revision          — revision submission (gates on free limit)
//   GET  /manage-panel             — manage panel data (tier-gated)
//   POST /apply-revision-payment   — called by launch-worker after paid-revision PayFast ITN
//   GET  /health                   — service health
//
// EMAIL HANDLER:
//   email(message, env, ctx)       — incoming email to updates@websitehub.co.za
//                                    Subject: "wh-{slug}", attachments → R2 gallery
//
// CROSS-WORKER URLs (set in wrangler env):
//   WORKER_URL_BUILD, WORKER_URL_LAUNCH, WORKER_URL_REACTIVATE
//
// QUEUE BINDING:
//   patch-worker is a PRODUCER on build-queue. Sends rebuild messages
//   to build-worker. Does NOT consume the queue.
//
// SECRETS:
//   ANTHROPIC_KEY (for vision), AIRTABLE_TOKEN/_BASE_ID/_TABLE_ID,
//   META_WA_TOKEN/_PHONE_NUMBER_ID, WH_PHONE, ADMIN_KEY
// ============================================================

import {
  PRICING, PACKAGE_CAPS,
  isTestMode, packageKey, getPricingTier, getPackageCaps, getUpgradeDelta, buildPayFastLink,
  jsonResponse, corsResponse,
  slugify, escapeHtml, uint8ArrayToBase64, currentMonthKey,
  resolveClaudeModel,
  sendWhatsApp, queueScheduledMessage, normaliseSaPhone,
  getAirtableRecord, updateAirtableRecord, listAirtableRecords,
  logActivity, logHealth, getFlag,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const ASSETS_DOMAIN = 'assets.websitehub.co.za';

// Plan photo limits — manage panel uploads and email gateway both enforce these.
// Express has no gallery so isn't listed; uploads are blocked at the tier check.
const PLAN_PHOTO_LIMITS = Object.freeze({
  Express:  { maxPhotos: 0,  maxSizeBytes: 0 },
  Standard: { maxPhotos: 10, maxSizeBytes: 3 * 1024 * 1024 },
  Premium:  { maxPhotos: 30, maxSizeBytes: 5 * 1024 * 1024 },
});

// Pending revision TTL — long enough for PayFast checkout, short enough to
// not pile up forgotten revisions. Battle plan §"Late payment grace" uses
// similar TTLs for related KV state.
const PENDING_REVISION_TTL = 60 * 60 * 2; // 2 hours

// ────────────────────────────────────────────────────────────
// EXPORT — fetch + email
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/patch-preview')          return handlePatchPreview(request, env, ctx);
    if (path === '/upload-assets')          return handleUploadAssets(request, env, ctx);
    if (path.startsWith('/asset/'))         return handleAssetProxy(request, env, path);
    if (path.startsWith('/gallery-assets/')) return handleGalleryAssets(request, env, path);
    if (path === '/patch-gallery')          return handlePatchGallery(request, env);
    if (path === '/submit-revision')        return handleSubmitRevision(request, env, ctx);
    if (path === '/manage-panel')           return handleManagePanel(request, url, env);
    if (path === '/apply-revision-payment') return handleApplyRevisionPayment(request, env);
    if (path === '/health')                 return handleHealth(env);

    return jsonResponse({ error: 'Not found', path }, 404);
  },

  async email(message, env, ctx) {
    ctx.waitUntil(handleIncomingEmail(message, env));
  },
};

// ============================================================
// ROUTE: /health
// ============================================================

async function handleHealth(env) {
  const services = ['airtable', 'r2', 'anthropic', 'whatsapp'];
  const health = {};
  for (const svc of services) {
    try {
      const raw = await env.SITES.get(`health:${svc}`);
      health[svc] = raw ? JSON.parse(raw) : { status: 'unknown' };
    } catch { health[svc] = { status: 'unknown' }; }
  }
  return jsonResponse({
    ok:      true,
    worker:  'patch-worker',
    time:    new Date().toISOString(),
    testMode: isTestMode(env),
    services: health,
  });
}

// ============================================================
// ROUTE: /patch-preview — surgical KV patch from SPA tweak drawer
//
// Body: { airtableId, slug, patch: { palette?, heroPhotoId?, tagline?,
//         about?, services?, tone? } }
//
// If patch.tone is present, falls through to full rebuild path (queues
// a build via BUILD_QUEUE). Otherwise applies the patch surgically to all
// per-page KV entries — no Claude call, instant.
// ============================================================

async function handlePatchPreview(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId, slug, patch } = body;
  if (!airtableId || !slug || !patch) {
    return jsonResponse({ error: 'Missing airtableId, slug, or patch' }, 400);
  }

  // Tone change = full rebuild (regenerates the Pass 1 brand brief)
  if (patch.tone) {
    ctx.waitUntil(triggerFullRebuild(airtableId, slug, patch, env));
    return jsonResponse({
      success: true,
      action:  'rebuild',
      message: 'Style change detected — our team is rebuilding your site now. Check back in a few minutes.',
    });
  }

  // Surgical KV patch — no Claude, no rebuild
  ctx.waitUntil(applyPreviewPatch(airtableId, slug, patch, env));

  return jsonResponse({
    success: true,
    action:  'patch',
    message: 'Changes applied. Refresh your preview link to see them.',
  });
}

/**
 * Applies a surgical patch to a slug's preview HTML across all per-page keys.
 * Reads tier capabilities to know which pages exist, so Express sites with
 * a single index page don't get unnecessary key reads.
 */
async function applyPreviewPatch(airtableId, slug, patch, env) {
  try {
    // Determine tier so we know which pages to patch
    const record = await getAirtableRecord(airtableId, env);
    const f      = record.fields || {};
    const caps   = getPackageCaps(f['Package'] || 'Standard');
    const pages  = caps.pages;
    const domain = (f['Domain'] || `${slug}.co.za`)
      .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

    // Patch the legacy single-page key first (for backward compat + index)
    let html = await env.SITES.get(`preview:${slug}`);
    if (!html) html = await env.SITES.get(`live:${domain}`);

    if (!html) {
      await logActivity(env, 'patch_failed', { slug, reason: 'No preview/live KV entry' });
      return;
    }

    html = applyPatchToHtml(html, patch, 'index');
    await env.SITES.put(`preview:${slug}`, html);

    // Per-page propagation. Each page only receives the relevant subset of patches.
    for (const pageName of pages) {
      const pageKey = `preview:${slug}:${pageName}`;
      let pageHtml  = await env.SITES.get(pageKey).catch(() => null);
      if (!pageHtml) continue;
      pageHtml = applyPatchToHtml(pageHtml, patch, pageName);
      await env.SITES.put(pageKey, pageHtml);
    }

    await logActivity(env, 'preview_patched', {
      slug,
      keys: Object.keys(patch).join(', '),
    });

    // Write text changes back to Airtable so the next full rebuild picks them up
    const airtableUpdates = {};
    if (patch.tagline)  airtableUpdates['Bio']      = patch.tagline;
    if (patch.about)    airtableUpdates['About']    = patch.about;
    if (patch.services) airtableUpdates['Services'] = patch.services;
    if (Object.keys(airtableUpdates).length) {
      await updateAirtableRecord(airtableId, airtableUpdates, env).catch(() => {});
    }
  } catch (err) {
    console.error('applyPreviewPatch failed:', err);
    await logActivity(env, 'patch_failed', { slug, error: err.message });
  }
}

/**
 * Single-page patch logic. Each patch field has a page-relevance rule:
 *   palette       → all pages
 *   tagline       → all pages (often near logo/nav)
 *   heroPhotoId   → index/express index only
 *   about         → about page only (Standard/Premium) or index (Express)
 *   services      → services page only (Standard/Premium) or index (Express)
 */
function applyPatchToHtml(html, patch, pageName) {
  let out = html;

  if (patch.palette) {
    out = applyPalette(out, patch.palette);
  }

  if (patch.tagline) {
    out = out.replace(
      /(<[^>]+class="[^"]*tagline[^"]*"[^>]*>)[^<]*/i,
      `$1${escapeHtml(patch.tagline)}`,
    );
  }

  // Hero photo only swaps on the page that has the hero
  if (patch.heroPhotoId && (pageName === 'index')) {
    const photoUrl = `https://images.unsplash.com/photo-${patch.heroPhotoId}?auto=format&fit=crop&w=1400&q=80`;
    out = out.replace(
      /(<[^>]+class="[^"]*hero[^"]*"[^>]*style="[^"]*background-image:\s*url\()[^)]*(\)[^"]*")/i,
      `$1${photoUrl}$2`,
    );
  }

  if (patch.about && (pageName === 'about' || pageName === 'index')) {
    out = out.replace(
      /(<[^>]+class="[^"]*about-text[^"]*"[^>]*>)[^<]*/i,
      `$1${escapeHtml(patch.about)}`,
    );
  }

  if (patch.services && (pageName === 'services' || pageName === 'index')) {
    out = out.replace(
      /(<[^>]+class="[^"]*services-text[^"]*"[^>]*>)[^<]*/i,
      `$1${escapeHtml(patch.services)}`,
    );
  }

  return out;
}

/**
 * Queues a full rebuild via BUILD_QUEUE. No HTTP hop — both workers
 * share the same queue binding (patch-worker as producer, build-worker
 * as consumer).
 */
async function triggerFullRebuild(airtableId, slug, patch, env) {
  try {
    const updates = {};
    if (patch.tone)     updates['Vibe']     = patch.tone;
    if (patch.tagline)  updates['Bio']      = patch.tagline;
    if (patch.about)    updates['About']    = patch.about;
    if (patch.services) updates['Services'] = patch.services;
    if (Object.keys(updates).length) await updateAirtableRecord(airtableId, updates, env);

    // Reset status so build-worker accepts the rebuild
    const current = (await getAirtableRecord(airtableId, env)).fields;
    if (current['Status'] !== 'Live') {
      await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env);
    }

    await env.BUILD_QUEUE.send({
      airtableId,
      paymentId:  null,
      fields:     null, // build-worker refetches with the just-updated values
      isOutbound: false,
    });

    await logActivity(env, 'full_rebuild_triggered', {
      slug, source: 'patch_preview_tone_change',
    });
  } catch (err) {
    console.error('triggerFullRebuild failed:', err);
    await logActivity(env, 'rebuild_failed', { slug, error: err.message });
  }
}

/**
 * Replaces CSS custom-property colour values in a stylesheet/inline-style block.
 * Three pre-defined palettes — palette name maps to a {primary,secondary,accent,text} set.
 */
function applyPalette(html, paletteName) {
  const palettes = {
    'warm-welcoming':     { primary: '#C8724F', secondary: '#F5EBE0', accent: '#8B4513', text: '#3D2B1F' },
    'clean-professional': { primary: '#1A3A5C', secondary: '#F8F9FA', accent: '#2E86AB', text: '#212529' },
    'bold-modern':        { primary: '#1A1A2E', secondary: '#16213E', accent: '#E94560', text: '#EAEAEA' },
  };
  const c = palettes[paletteName];
  if (!c) return html;

  // Replace both --primary/--secondary/--accent/--text and --acc/--bg/--surface
  // (build-worker uses --acc/--bg/--surface; legacy templates use --primary etc).
  return html
    .replace(/--primary:\s*#[0-9a-fA-F]{3,6}/g,   `--primary: ${c.primary}`)
    .replace(/--secondary:\s*#[0-9a-fA-F]{3,6}/g, `--secondary: ${c.secondary}`)
    .replace(/--accent:\s*#[0-9a-fA-F]{3,6}/g,    `--accent: ${c.accent}`)
    .replace(/--acc:\s*#[0-9a-fA-F]{3,6}/g,       `--acc: ${c.accent}`)
    .replace(/--text:\s*#[0-9a-fA-F]{3,6}/g,      `--text: ${c.text}`)
    .replace(/--bg:\s*#[0-9a-fA-F]{3,6}/g,        `--bg: ${c.primary}`)
    .replace(/--surface:\s*#[0-9a-fA-F]{3,6}/g,   `--surface: ${c.secondary}`);
}

// ============================================================
// ROUTE: /upload-assets — manage panel photo upload to R2
//
// Multipart form fields:
//   airtableId  (required)
//   slug        (required; or businessName for slug fallback)
//   file_0..N   (File objects, max 6 per request)
//
// Enforces tier photo limits. Triggers vision analysis + rebuild
// asynchronously via runVisionAndRebuild (local to this worker).
// ============================================================

async function handleUploadAssets(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let formData;
  try { formData = await request.formData(); }
  catch { return jsonResponse({ error: 'Expected multipart/form-data' }, 400); }

  const airtableId = formData.get('airtableId');
  const slug       = formData.get('slug') || slugify(formData.get('businessName') || '');
  if (!airtableId || !slug) return jsonResponse({ error: 'Missing airtableId or slug' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client record not found' }, 404); }

  const plan       = record.fields['Package'] || 'Standard';
  const planKey    = (plan === 'Express' || plan === 'Standard' || plan === 'Premium') ? plan : 'Standard';
  const limits     = PLAN_PHOTO_LIMITS[planKey];

  // Express has no gallery — block upload at the door with an upgrade nudge.
  if (limits.maxPhotos === 0) {
    return jsonResponse({
      error: `Photo gallery is not included in the ${plan} plan.`,
      upgradeAvailable: true,
      upgradeDelta:     getUpgradeDelta(plan, 'Premium'),
    }, 403);
  }

  const existingPhotos = (record.fields['Photos'] || '').split(',').filter(Boolean);
  const slotsRemaining = limits.maxPhotos - existingPhotos.length;
  if (slotsRemaining <= 0) {
    return jsonResponse({
      error: `Photo limit reached for ${plan} plan (${limits.maxPhotos} max). ` +
             (plan === 'Standard'
               ? 'Upgrade to Premium for 30 photos.'
               : 'Remove some photos first.'),
      upgradeAvailable: plan === 'Standard',
      upgradeDelta:     plan === 'Standard' ? getUpgradeDelta(plan, 'Premium') : 0,
    }, 400);
  }

  // Collect uploaded files
  const files = [];
  for (let i = 0; i < 6; i++) {
    const file = formData.get(`file_${i}`);
    if (file && file instanceof File) files.push(file);
  }
  if (files.length === 0) return jsonResponse({ error: 'No files received' }, 400);

  // Upload to R2 with per-file size enforcement
  const r2Paths  = [];
  const rejected = [];

  for (const file of files.slice(0, slotsRemaining)) {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > limits.maxSizeBytes) {
      rejected.push({ name: file.name, reason: `Exceeds ${limits.maxSizeBytes / 1024 / 1024}MB limit` });
      continue;
    }

    const ext      = (file.name.split('.').pop() || 'jpg').toLowerCase();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const r2Key    = `${slug}/brand/${Date.now()}_${safeName}`;

    try {
      await env.ASSETS.put(r2Key, bytes, {
        httpMetadata:   { contentType: file.type || `image/${ext}` },
        customMetadata: { slug, uploadedAt: new Date().toISOString() },
      });
      r2Paths.push({ key: r2Key, name: file.name, type: file.type, size: bytes.byteLength });
    } catch (e) {
      console.warn(`R2 upload failed for ${file.name}:`, e);
      rejected.push({ name: file.name, reason: 'Storage error' });
    }
  }

  if (r2Paths.length === 0) {
    return jsonResponse({ error: 'All uploads failed', rejected }, 500);
  }

  await logHealth(env, 'r2', 'success');

  // Vision + rebuild runs in background — failures alert owner but don't fail upload
  ctx.waitUntil(
    runVisionAndRebuild(airtableId, slug, r2Paths, files, env).catch(async err => {
      console.error('Vision/rebuild failed:', err);
      await logHealth(env, 'anthropic', 'error', err.message);
      await logActivity(env, 'upload_processing_failed', { slug, error: err.message });
      await sendWhatsApp(env.WH_PHONE,
        `⚠️ ASSET PROCESSING ISSUE: ${slug}\nError: ${err.message}\nAirtable: ${airtableId}`,
        env, { skipTestRedirect: true },
      ).catch(() => {});
    }),
  );

  return jsonResponse({
    success:  true,
    uploaded: r2Paths.length,
    files:    r2Paths.map(f => f.key),
    rejected,
    message:  'Assets uploaded. Our team is processing them now.',
  });
}

// ============================================================
// VISION SYSTEM — extract brand signals, queue rebuild
// Lives in patch-worker because patch-worker is the only worker
// with raw upload file bytes in scope. build-worker handles the
// rebuild via queue consumer.
// ============================================================

async function runVisionAndRebuild(airtableId, slug, r2Paths, files, env) {
  let brandBrief = '';

  if (await getFlag(env, 'VISION_VALIDATION_ENABLED')) {
    const visionImages = [];
    for (let i = 0; i < Math.min(files.length, 3); i++) {
      try {
        const bytes = await files[i].arrayBuffer();
        const b64   = uint8ArrayToBase64(new Uint8Array(bytes));
        const mime  = files[i].type || 'image/jpeg';
        visionImages.push({ base64: b64, mediaType: mime, name: files[i].name });
      } catch (e) {
        console.warn(`Failed to read file for vision: ${files[i].name}`, e);
      }
    }

    if (visionImages.length > 0) {
      brandBrief = await extractBrandSignals(visionImages, slug, env);
      await logHealth(env, 'anthropic', 'success');
    }
  }

  const r2PathList     = r2Paths.map(p => p.key).join(', ');
  const currentFields  = (await getAirtableRecord(airtableId, env)).fields;
  const existingPhotos = currentFields['Photos'] || '';
  const allPhotos      = [existingPhotos, r2PathList].filter(Boolean).join(', ');

  const updateFields = { 'Photos': allPhotos };
  if (brandBrief) {
    const existingNotes = currentFields['Extra Notes'] || '';
    updateFields['Extra Notes'] = `[BRAND ANALYSIS]\n${brandBrief}\n\n${existingNotes}`.slice(0, 5000);
  }

  await updateAirtableRecord(airtableId, updateFields, env);

  // Only reset status if NOT already Live
  if (currentFields['Status'] !== 'Live') {
    await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env);
  }

  // Queue rebuild — build-worker's queue consumer handles it
  await env.BUILD_QUEUE.send({
    airtableId,
    paymentId:  null,
    fields:     null, // build-worker refetches with updated values
    isOutbound: false,
  });

  await logActivity(env, 'assets_processed', {
    slug, fileCount: r2Paths.length, visionUsed: !!brandBrief,
  });

  await sendWhatsApp(env.WH_PHONE,
    `📸 ASSETS PROCESSED: ${slug}\n${r2Paths.length} file${r2Paths.length !== 1 ? 's' : ''} stored\nRebuild queued`,
    env, { skipTestRedirect: true },
  );
}

/**
 * Calls Claude Vision with the uploaded images and returns a plain-text
 * brand brief that downstream Pass 1 uses to colour the design.
 */
async function extractBrandSignals(images, slug, env) {
  const content = [{
    type: 'text',
    text: `Analyse these brand assets (logo and photos) for a South African small business. Extract the following:

1. PRIMARY COLOUR — the most dominant brand colour (hex code)
2. SECONDARY COLOUR — supporting colour (hex code)
3. ACCENT COLOUR — highlight/pop colour (hex code)
4. TYPOGRAPHY FEEL — is the logo serif, sans-serif, script, geometric, bold/delicate?
5. BRAND PERSONALITY — 3 adjectives that describe the visual tone
6. DESIGN DIRECTION — one sentence: what design style should the website use to match this brand?
7. LOGO PRESENT — yes/no
8. PHOTO QUALITY — describe the photo quality and style if photos are present

Be specific and practical. A developer will use this to build a website.
Format your response as plain text with labels like "PRIMARY COLOUR: #hexcode".`,
  }];

  for (const img of images) {
    content.push({
      type:   'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
    });
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      await resolveClaudeModel(env),
      max_tokens: 1000,
      messages:   [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brand analysis failed: ${res.status} — ${err}`);
  }

  const data      = await res.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  return textBlock?.text || '';
}

// ============================================================
// ROUTE: /asset/{key} — R2 proxy
// Serves uploaded files until assets.websitehub.co.za CDN domain is wired.
// ============================================================

async function handleAssetProxy(request, env, path) {
  const r2Key = decodeURIComponent(path.replace(/^\/asset\//, ''));
  if (!r2Key || r2Key.includes('..')) return new Response('Not found', { status: 404 });

  try {
    const obj = await env.ASSETS.get(r2Key);
    if (!obj) return new Response('Not found', { status: 404 });

    const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
    return new Response(obj.body, {
      headers: {
        'Content-Type':                contentType,
        'Cache-Control':               'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('Asset proxy error:', e);
    return new Response('Error', { status: 500 });
  }
}

// ============================================================
// ROUTE: /gallery-assets/{slug}
// Returns JSON array of gallery photo URLs. Called by the gallery
// page script on every page load (1-min cache). Empty array means
// "Photos coming soon" placeholder in the UI.
// ============================================================

async function handleGalleryAssets(request, env, path) {
  if (request.method !== 'GET') return jsonResponse({ error: 'GET only' }, 405);

  const slug = path.replace('/gallery-assets/', '').split('/')[0].trim();
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  try {
    const listed = await env.ASSETS.list({ prefix: `${slug}/gallery/` });
    const ownUrl = env.WORKER_URL_PATCH || '';

    const urls = (listed.objects || [])
      .filter(obj => /\.(jpg|jpeg|png|webp|gif)$/i.test(obj.key))
      .map(obj => {
        if (env.ASSETS_DOMAIN_READY === 'true') return `https://${ASSETS_DOMAIN}/${obj.key}`;
        return `${ownUrl}/asset/${obj.key}`;
      });

    return new Response(JSON.stringify(urls), {
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=60',
      },
    });
  } catch (e) {
    console.error('Gallery listing error:', e);
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

// ============================================================
// ROUTE: /patch-gallery — admin manual gallery patch
// Body: { airtableId, r2Paths: [...] }
// Used when assets are uploaded out-of-band and need to be patched
// into a Live site without a rebuild.
// ============================================================

async function handlePatchGallery(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId, r2Paths } = body;
  if (!airtableId || !r2Paths?.length) {
    return jsonResponse({ error: 'Missing airtableId or r2Paths' }, 400);
  }

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  const f      = record.fields;
  const slug   = f['Slug'] || slugify(f['Business Name']);
  const domain = (f['Domain'] || `${slug}.co.za`)
    .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  const patched = await patchGalleryInKV(slug, domain, r2Paths, env);
  await logActivity(env, 'gallery_manual_patch', { slug, count: r2Paths.length });

  return jsonResponse({ success: patched, slug, domain, photosPatched: r2Paths.length });
}

/**
 * Replaces the gallery section in both the preview and live KV entries.
 * Looks for <!-- GALLERY START --> / <!-- GALLERY END --> markers, or the
 * older single <!-- Gallery: ... --> comment. If neither marker is present,
 * the gallery script (in build-worker's Pass 3 prompt) fetches photos at
 * runtime via /gallery-assets, so this is best-effort cache-warming only.
 */
async function patchGalleryInKV(slug, domain, r2Paths, env) {
  const ownUrl = env.WORKER_URL_PATCH || '';
  const photoUrls = r2Paths.map(key => {
    if (env.ASSETS_DOMAIN_READY === 'true') return `https://${ASSETS_DOMAIN}/${key}`;
    return `${ownUrl}/asset/${key}`;
  });

  const galleryItems = photoUrls.map(url =>
    `<div class="gallery-item"><img src="${url}" alt="Gallery photo" loading="lazy" style="width:100%;height:220px;object-fit:cover;border-radius:4px;"></div>`
  ).join('\n        ');

  const galleryHtml = `<!-- GALLERY START -->\n        ${galleryItems}\n        <!-- GALLERY END -->`;

  let anyPatched = false;
  for (const key of [`live:${domain}`, `preview:${slug}`, `preview:${slug}:gallery`]) {
    let html = await env.SITES.get(key);
    if (!html) continue;

    if (html.includes('<!-- Gallery:')) {
      html = html.replace(/<!-- Gallery:.*?-->/s, galleryHtml);
    } else if (html.includes('<!-- GALLERY START -->')) {
      html = html.replace(/<!-- GALLERY START -->[\s\S]*?<!-- GALLERY END -->/, galleryHtml);
    } else {
      continue; // No marker — gallery script fetches at runtime anyway
    }

    await env.SITES.put(key, html);
    anyPatched = true;
  }

  return anyPatched;
}

// ============================================================
// ROUTE: /manage-panel — tier-gated manage panel data
// Returns everything the SPA needs to render the panel for the
// client's plan. Sections the plan doesn't have are returned as
// null so the SPA can decide whether to show "Upgrade to unlock".
// ============================================================

async function handleManagePanel(request, url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);

  const airtableId = await env.SITES.get(`manage_token:${token}`);
  if (!airtableId) return jsonResponse({ error: 'Invalid or expired manage token' }, 404);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  const f         = record.fields;
  const slug      = f['Slug'] || slugify(f['Business Name']);
  const domain    = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const plan      = f['Package'] || 'Standard';
  const pkgKey    = packageKey(plan);
  const tier      = getPricingTier(plan);
  const caps      = getPackageCaps(plan);
  const monthStr  = currentMonthKey();

  // Revision usage + free limit per tier
  const revisionsUsed = parseInt(
    await env.SITES.get(`manage_revisions:${airtableId}:${monthStr}`).catch(() => '0') || '0',
  );
  const revisionsLimit = pkgKey === 'premium' ? null
                       : pkgKey === 'express' ? 1 : 2; // Standard = 2, Express = 1

  // Next invoice
  const nextInvoiceStr = f['Next Invoice Date'];
  let daysUntilInvoice = null;
  if (nextInvoiceStr) {
    const diff = new Date(nextInvoiceStr).getTime() - Date.now();
    daysUntilInvoice = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  // Referral block — only when feature flag on AND tier supports it
  const referralFlag  = await getFlag(env, 'REFERRAL_ENABLED');
  const referralUnlocked = caps.referral && referralFlag;
  let referralBlock = null;
  if (referralUnlocked) {
    const sent        = parseInt(await env.SITES.get(`referral:sent:${slug}:${monthStr}`).catch(() => '0') || '0');
    const conversions = parseInt(await env.SITES.get(`referral:conversions:${slug}`).catch(() => '0') || '0');
    referralBlock = {
      enabled:      true,
      link:         `https://websitehub.co.za?ref=${slug}`,
      sent,
      conversions,
      rewardMonths: conversions, // 1 conversion = 1 free month
    };
  }

  // Analytics block — only for tiers that support it
  let analyticsBlock = null;
  if (caps.analytics) {
    // Pulled from build-worker /analytics by SPA when it loads the panel,
    // but we surface the URL here for one-tap deep linking.
    analyticsBlock = { enabled: true, slug };
  }

  // Gallery block — only for tiers that support it
  let galleryBlock = null;
  if (caps.gallery) {
    const photoCount = (f['Photos'] || '').split(',').filter(Boolean).length;
    const planLimits = PLAN_PHOTO_LIMITS[plan] || PLAN_PHOTO_LIMITS.Standard;
    galleryBlock = {
      enabled:     true,
      photoCount,
      maxPhotos:   planLimits.maxPhotos,
      maxSizeMB:   planLimits.maxSizeBytes / 1024 / 1024,
    };
  }

  // Email accounts block — show how many configured + upgrade offer if applicable
  const emailBlock = {
    included:      caps.emailAccounts,
    addonAvailable: caps.extraEmailAddon,
    addonCost:     caps.extraEmailAddon ? PRICING.addons.extraEmail : 0,
  };

  // Upgrade offers (presented if upgrade target exists)
  const upgradeOffers = [];
  if (pkgKey === 'express') {
    upgradeOffers.push({ to: 'Standard', delta: PRICING.upgrade.expressToStandard });
    upgradeOffers.push({ to: 'Premium',  delta: PRICING.upgrade.expressToPremium });
  } else if (pkgKey === 'standard') {
    upgradeOffers.push({ to: 'Premium',  delta: PRICING.upgrade.standardToPremium });
  }

  return jsonResponse({
    airtableId,
    businessName:      f['Business Name'],
    slug,
    domain,
    liveUrl:           `https://${domain}`,
    package:           plan,
    status:            f['Status'],
    retainer:          tier.retainer,
    nextInvoiceDate:   nextInvoiceStr || null,
    daysUntilInvoice,
    pages:             caps.pages,
    revisions: {
      used:          revisionsUsed,
      limit:         revisionsLimit,
      paidCost:      PRICING.addons.revision,
    },
    email:    emailBlock,
    gallery:  galleryBlock,
    referral: referralBlock,
    analytics: analyticsBlock,
    upgradeOffers,
  });
}

// ============================================================
// ROUTE: /submit-revision — revision flow with paid fallback
//
// Behaviour:
//   1. Read tier's free revision limit (1/2/∞).
//   2. If under limit → increment counter, queue rebuild, return success.
//   3. If at/over limit → store pending revision in KV, return 402 with
//      PayFast checkout URL. Client pays. PayFast ITN hits launch-worker.
//      launch-worker calls /apply-revision-payment, which queues the rebuild.
// ============================================================

async function handleSubmitRevision(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { token, palette, font, photo, tagline, specials } = body;
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);

  const airtableId = await env.SITES.get(`manage_token:${token}`);
  if (!airtableId) return jsonResponse({ error: 'Invalid manage token' }, 404);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  const f        = record.fields;
  const pkgKey   = packageKey(f['Package'] || 'Standard');
  const slug     = f['Slug'] || slugify(f['Business Name']);
  const monthStr = currentMonthKey();
  const countKey = `manage_revisions:${airtableId}:${monthStr}`;
  const used     = parseInt(await env.SITES.get(countKey).catch(() => '0') || '0');
  const freeLimit = pkgKey === 'premium' ? Infinity
                  : pkgKey === 'express' ? 1 : 2;

  const revisionPayload = { palette, font, photo, tagline, specials };

  // Over free limit → require payment
  if (used >= freeLimit) {
    // Stash the revision payload keyed by a fresh token. PayFast carries this
    // token in custom_str2; launch-worker forwards it to /apply-revision-payment.
    const revToken = crypto.randomUUID().replace(/-/g, '');
    await env.SITES.put(`pending_revision:${revToken}`, JSON.stringify({
      airtableId,
      payload: revisionPayload,
      created: new Date().toISOString(),
    }), { expirationTtl: PENDING_REVISION_TTL });

    const launchUrl = env.WORKER_URL_LAUNCH || '';
    const payLink   = buildPayFastLink(
      PRICING.addons.revision,
      `Website Hub Revision — ${f['Business Name']}`,
      airtableId,
      env,
      {
        itemDesc:   'Additional revision request',
        customStr2: `revision:${revToken}`,
        notifyUrl:  launchUrl ? `${launchUrl}/payfast-webhook` : undefined,
        // No returnUrl — client stays in WhatsApp / SPA flow
      },
    );

    return jsonResponse({
      error:         'revision_payment_required',
      used,
      freeLimit,
      paidCost:      PRICING.addons.revision,
      paymentLink:   payLink,
      revisionToken: revToken,
      message:       `You've used ${used} of ${freeLimit} free revisions this month. Tap to pay R${PRICING.addons.revision} for this revision.`,
    }, 402);
  }

  // Under free limit — process immediately
  await processRevision(airtableId, revisionPayload, env, { paid: false, monthStr, used });
  return jsonResponse({
    success:   true,
    used:      used + 1,
    limit:     freeLimit === Infinity ? null : freeLimit,
    message:   `Got it! Your revision is in — we'll have it live within 10 minutes.`,
  });
}

/**
 * Applies a revision: increment counter, write change log to Airtable,
 * write panel choices to KV, queue rebuild, notify client.
 *
 * Used by both /submit-revision (free path) and /apply-revision-payment
 * (paid path after PayFast confirmation).
 */
async function processRevision(airtableId, payload, env, opts = {}) {
  const { paid = false, monthStr = currentMonthKey() } = opts;

  const record = await getAirtableRecord(airtableId, env);
  const f      = record.fields;
  const slug   = f['Slug'] || slugify(f['Business Name']);
  const pkgKey = packageKey(f['Package'] || 'Standard');

  // Counter increment (paid revisions also increment, since they consumed a slot)
  const countKey = `manage_revisions:${airtableId}:${monthStr}`;
  const used     = parseInt(await env.SITES.get(countKey).catch(() => '0') || '0');
  await env.SITES.put(countKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 35 });

  const { palette, font, photo, tagline, specials } = payload;

  // Append revision log to Extra Notes
  const timestamp = new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' });
  const existing  = f['Extra Notes'] || '';
  const revisionNote = [
    `[MANAGE REVISION ${timestamp}${paid ? ' — PAID' : ''}]`,
    palette  ? `Palette: ${palette}` : null,
    font     ? `Font: ${font}`       : null,
    photo    ? `Photo: ${photo}`     : null,
    tagline  ? `Tagline: ${tagline}` : null,
    specials ? `Notes: ${specials}`  : null,
  ].filter(Boolean).join('\n');

  await updateAirtableRecord(airtableId, {
    'Extra Notes': `${existing}\n\n${revisionNote}`,
  }, env);

  // Persist panel choices so the rebuilt site reflects them
  if (palette || font || photo || tagline) {
    const existingChoices = JSON.parse(await env.SITES.get(`preview_choices:${slug}`).catch(() => '{}') || '{}');
    await env.SITES.put(`preview_choices:${slug}`, JSON.stringify({
      ...existingChoices,
      ...(palette ? { palette } : {}),
      ...(font    ? { font }    : {}),
      ...(photo   ? { photo }   : {}),
      ...(tagline ? { tagline } : {}),
      savedAt: new Date().toISOString(),
    }));
  }

  // Queue rebuild
  await env.BUILD_QUEUE.send({
    airtableId,
    paymentId:  null,
    fields:     null, // build-worker refetches with the Extra Notes + Bio updates
    isOutbound: false,
  });

  // Notify client
  const name      = f['Client Name']?.split(' ')[0] || 'there';
  const freeLimit = pkgKey === 'premium' ? Infinity : pkgKey === 'express' ? 1 : 2;
  const usageLine = freeLimit !== Infinity && !paid
    ? `\n_(${used + 1}/${freeLimit} free revisions used this month)_\n`
    : '';
  const paidLine  = paid ? `\nThanks for the payment — much appreciated!\n` : '';

  await sendWhatsApp(f['WhatsApp'],
    `Got it ${name}! 👍 Your revision is in — we'll have it live within 10 minutes.${paidLine}${usageLine}\n— Website Hub`,
    env,
  );

  // Owner alert
  await sendWhatsApp(env.WH_PHONE,
    `✏️ REVISION ${paid ? '(PAID R' + PRICING.addons.revision + ')' : ''}: ${f['Business Name']}\nUsed: ${used + 1}/${freeLimit === Infinity ? '∞' : freeLimit}\nAirtable: ${airtableId}`,
    env, { skipTestRedirect: true },
  ).catch(() => {});

  await logActivity(env, 'manage_revision_submitted', {
    airtableId, business: f['Business Name'], used: used + 1, paid,
  });
}

// ============================================================
// ROUTE: /apply-revision-payment
// Called server-to-server by launch-worker after a PayFast revision
// payment ITN is verified. Reads the pending revision payload from KV
// and processes it through the normal revision pipeline.
//
// Body: { revisionToken }
// Auth: x-admin-key (shared secret between workers)
// ============================================================

async function handleApplyRevisionPayment(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { revisionToken } = body;
  if (!revisionToken) return jsonResponse({ error: 'Missing revisionToken' }, 400);

  const raw = await env.SITES.get(`pending_revision:${revisionToken}`);
  if (!raw) {
    // Either expired or already processed — return 200 idempotent so launch-worker
    // doesn't retry the ITN forwarding loop.
    return jsonResponse({ success: true, already_processed: true });
  }

  const pending = JSON.parse(raw);
  const { airtableId, payload } = pending;

  try {
    await processRevision(airtableId, payload, env, { paid: true });
    await env.SITES.delete(`pending_revision:${revisionToken}`);
    return jsonResponse({ success: true, airtableId });
  } catch (err) {
    console.error('Paid revision processing failed:', err);
    // Don't delete the token — leaves room for manual retry/inspection
    await logActivity(env, 'paid_revision_failed', {
      revisionToken, airtableId, error: err.message,
    });
    return jsonResponse({ error: err.message }, 500);
  }
}

// ============================================================
// EMAIL HANDLER — incoming gallery photo updates
//
// Email format:
//   To:      updates@websitehub.co.za
//   Subject: wh-{slug}   (or just {slug})
//   Body:    anything
//   Attachments: JPG / PNG / WEBP photos
//
// Flow:
//   1. Parse subject → slug
//   2. Look up Airtable record
//   3. Enforce gallery photo limits
//   4. Parse MIME attachments → upload each to R2 under {slug}/gallery/
//   5. If Live → patch gallery in KV; otherwise queue a rebuild
//   6. WhatsApp confirmation (window-respecting)
// ============================================================

async function handleIncomingEmail(message, env) {
  const subject = message.headers.get('subject') || '';
  const from    = message.headers.get('from')    || '';

  const slugMatch = subject.match(/wh-([a-z0-9-]+)/i) || subject.match(/([a-z0-9-]{3,50})/i);
  if (!slugMatch) {
    await logActivity(env, 'email_unroutable', { subject, from });
    message.setReject('No valid site slug in subject line. Format: wh-your-business-name');
    return;
  }

  const slug = slugMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');

  let records;
  try { records = await listAirtableRecords(`{Slug} = "${slug}"`, env); }
  catch (e) {
    await logHealth(env, 'airtable', 'error', e.message);
    message.forward('loc10@live.co.za');
    return;
  }

  if (!records.length) {
    await logActivity(env, 'email_unknown_slug', { slug, from });
    message.forward('loc10@live.co.za');
    return;
  }

  const record      = records[0];
  const f           = record.fields;
  const airtableId  = record.id;
  const status      = f['Status'] || '';
  const clientPhone = f['WhatsApp'] || '';
  const bizName     = f['Business Name'] || slug;
  const plan        = f['Package'] || 'Standard';
  const planKey     = (plan === 'Express' || plan === 'Standard' || plan === 'Premium') ? plan : 'Standard';
  const limits      = PLAN_PHOTO_LIMITS[planKey];

  // Express has no gallery — politely decline
  if (limits.maxPhotos === 0) {
    if (clientPhone) {
      await queueScheduledMessage(airtableId, clientPhone,
        `Hi! We received your photos for *${bizName}*, but the Express plan doesn't include a photo gallery.\n\nUpgrade to Standard or Premium to add a gallery. Reply UPGRADE for details.\n\n— Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await logActivity(env, 'email_express_no_gallery', { slug });
    return;
  }

  const existingPhotoList = (f['Photos'] || '').split(',').filter(Boolean);
  const slotsRemaining    = limits.maxPhotos - existingPhotoList.length;

  if (slotsRemaining <= 0) {
    if (clientPhone) {
      await queueScheduledMessage(airtableId, clientPhone,
        `Hi! We received your photos for *${bizName}*, but your ${plan} plan gallery is full (${limits.maxPhotos} photos max).\n\n` +
        (plan === 'Standard'
          ? `Upgrade to Premium for up to 30 photos. Reply UPGRADE for details.`
          : `Please ask us to remove some existing photos first.`) +
        `\n\n— Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await logActivity(env, 'email_limit_reached', { slug, plan });
    return;
  }

  // Parse + upload
  let photoCount = 0;
  const r2Paths  = [];

  try {
    const rawEmail    = await streamToUint8Array(message.raw);
    const attachments = parseMimeAttachments(rawEmail);
    const imageTypes  = ['image/jpeg', 'image/png', 'image/webp'];

    for (let i = 0; i < Math.min(attachments.length, slotsRemaining); i++) {
      const att = attachments[i];
      if (!imageTypes.includes(att.contentType.toLowerCase())) continue;
      if (att.data.byteLength > limits.maxSizeBytes) {
        console.warn(`Photo too large for ${plan} plan: ${att.data.byteLength} bytes`);
        continue;
      }

      const ext   = att.contentType.includes('png') ? 'png'
                  : att.contentType.includes('webp') ? 'webp' : 'jpg';
      const r2Key = `${slug}/gallery/photo_${Date.now()}_${i}.${ext}`;

      await env.ASSETS.put(r2Key, att.data, {
        httpMetadata:   { contentType: att.contentType },
        customMetadata: { slug, source: 'email', uploadedAt: new Date().toISOString() },
      });

      r2Paths.push(r2Key);
      photoCount++;
    }

    await logHealth(env, 'r2', 'success');
  } catch (e) {
    console.error('MIME parsing/R2 failed:', e);
    await logHealth(env, 'r2', 'error', e.message);
    await logActivity(env, 'email_photo_error', { slug, error: e.message });
  }

  if (photoCount === 0) {
    if (clientPhone) {
      await queueScheduledMessage(airtableId, clientPhone,
        `Hi! We received your email for *${bizName}* but couldn't find any valid photo attachments (JPG, PNG, or WEBP under ${limits.maxSizeBytes / 1024 / 1024}MB).\n\nPlease try again with your photos attached. — Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await logActivity(env, 'email_no_photos', { slug, from });
    return;
  }

  // Update Airtable Photos field
  const allPhotos = [...existingPhotoList, ...r2Paths];
  await updateAirtableRecord(airtableId, { 'Photos': allPhotos.join(', ') }, env);

  // Patch or rebuild depending on Live status
  if (status === 'Live') {
    const domain = (f['Domain'] || `${slug}.co.za`)
      .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    await patchGalleryInKV(slug, domain, r2Paths, env);

    if (clientPhone) {
      await queueScheduledMessage(airtableId, clientPhone,
        `📸 Got your photos! We've added *${photoCount} photo${photoCount > 1 ? 's' : ''}* to your *${bizName}* gallery.\n\n✅ Your site is updated: https://${domain}\n\n— Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await sendWhatsApp(env.WH_PHONE,
      `📸 GALLERY UPDATED: ${bizName} (${slug})\n${photoCount} photos added via email\nSite: https://${domain}`,
      env, { skipTestRedirect: true },
    );
    await logActivity(env, 'gallery_updated', { slug, count: photoCount, source: 'email' });

  } else {
    if (status !== 'Live') {
      await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env);
    }

    await env.BUILD_QUEUE.send({
      airtableId,
      paymentId:  null,
      fields:     null,
      isOutbound: false,
    });

    if (clientPhone) {
      await queueScheduledMessage(airtableId, clientPhone,
        `📸 Got your photos! We're updating your *${bizName}* website with them now. You'll have an updated preview link in about 10 minutes. ⚡\n\n— Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await sendWhatsApp(env.WH_PHONE,
      `📸 PHOTOS RECEIVED (PRE-LIVE): ${bizName} (${slug})\n${photoCount} photos — rebuild queued`,
      env, { skipTestRedirect: true },
    );
    await logActivity(env, 'email_rebuild_triggered', { slug, count: photoCount, status });
  }
}

// ============================================================
// MIME PARSING — extract image attachments from raw email bytes
// Handles base64 + quoted-printable + 8bit encodings.
// Strict on attachment minimum size (1KB) to skip MIME boilerplate.
// ============================================================

function parseMimeAttachments(rawBytes) {
  const text        = new TextDecoder('utf-8', { fatal: false }).decode(rawBytes);
  const attachments = [];

  const boundaryMatch = text.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) return attachments;

  const boundary = boundaryMatch[1];
  const parts    = text.split(`--${boundary}`);

  for (const part of parts) {
    if (!part || part === '--' || part.trim() === '--') continue;

    const useCRLF  = part.includes('\r\n\r\n');
    const splitIdx = useCRLF ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n');
    if (splitIdx === -1) continue;

    const headerSection = part.slice(0, splitIdx);
    const bodySection   = part.slice(splitIdx + (useCRLF ? 4 : 2));

    const contentType = (headerSection.match(/Content-Type:\s*([^\r\n;]+)/i) || [])[1]
      ?.trim().toLowerCase() || '';
    if (!contentType.startsWith('image/')) continue;

    const encoding = (headerSection.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1]
      ?.trim().toLowerCase() || '';

    let data;
    if (encoding === 'base64') {
      try {
        const b64 = bodySection.replace(/\s/g, '');
        const bin = atob(b64);
        data = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
      } catch (e) {
        console.warn('Base64 decode failed:', e);
        continue;
      }
    } else if (encoding === 'quoted-printable') {
      const decoded = bodySection
        .replace(/=\r\n/g, '')
        .replace(/=\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      data = new TextEncoder().encode(decoded);
    } else {
      data = new TextEncoder().encode(bodySection);
    }

    if (data && data.length > 1024) {
      attachments.push({ contentType, data });
    }
  }

  return attachments;
}

async function streamToUint8Array(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.length; }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

// ============================================================
// End of patch-worker.js
// ============================================================
