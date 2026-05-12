// ============================================================
// WEBSITE HUB — Enrichment Worker v2.0 (wh-enrichment-worker.js)
// Worker 2 — Rich & Complex. If this fails, Worker 1 keeps running.
//
// RESPONSIBILITIES:
//   — Brand asset upload → R2 storage (wh-assets/{slug}/brand/)
//   — Claude vision analysis → extract colours, fonts, design language
//   — Interactive preview patch → surgical JSON patch without full rebuild
//   — Trigger Premium rebuild on Worker 1 with enriched brief
//   — Email-to-gallery → parse attachments → R2 → KV patch → WhatsApp
//   — Google Business Profile → check / create / update via My Business API
//   — One-time /google-auth route for OAuth setup
//   — R2 asset proxy → serves files until assets.websitehub.co.za is live
//   — Health/activity logging → all operations written to KV for dashboard
//
// ROUTES:
//   POST /upload-assets       — frontend uploads Premium brand files here
//   POST /patch-preview       — interactive preview panel JSON patch (ENHANCE-36)
//   GET  /asset/:key          — R2 proxy (until assets.websitehub.co.za is live)
//   POST /email               — Cloudflare Email Worker handler (email export)
//   GET  /google-auth         — one-time Google OAuth setup
//   POST /google-profile      — create/update Google Business Profile for a client
//   POST /patch-gallery       — manually patch gallery section in KV site
//   GET  /health              — simple ping + service status
//
// ENVIRONMENT FLAGS (set in Cloudflare dashboard — zero redeployment):
//   VISION_VALIDATION_ENABLED — "true" to enable Claude vision on uploads (default off)
//   OUTBOUND_ENABLED          — "true" to enable outbound prospecting (default off)
//   REFERRAL_ENABLED          — "true" to enable referral system (default off)
//
// CLOUDFLARE SECRETS REQUIRED:
//   ANTHROPIC_KEY
//   AIRTABLE_TOKEN, AIRTABLE_BASE_ID, AIRTABLE_TABLE_ID
//   TWILIO_SID, TWILIO_TOKEN, TWILIO_WA_FROM
//   WH_PHONE           (owner WhatsApp — 27840142017)
//   ADMIN_KEY          (same value as Worker 1 — ADMIN_KEY_CLAUDEROX)
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN  (set after running /google-auth one-time flow)
//   WORKER1_URL        (https://dropbox-proxy.pierreduplessis6912.workers.dev)
//
// KV + R2 BINDINGS (wrangler.toml):
//   binding = "SITES" / id = "b63e5b885ead4c02a9e184dd6477e711"
//   binding = "ASSETS" / bucket_name = "wh-assets"
//
// PLAN LIMITS:
//   Standard: 10 gallery photos max, 3MB per photo
//   Premium:  30 gallery photos max, 5MB per photo
//
// ACTIVITY LOGGING (KV keys, all read by admin dashboard):
//   health:{service}   → { status, lastSuccess, lastError, timestamp }
//   activity:w2:{ts}   → { event, slug, detail, timestamp }
// ============================================================

// WORKER1_URL is set as a Cloudflare secret on this worker (wrangler secret put WORKER1_URL).
// The string fallback below is intentionally null — if the env var is missing,
// calls will fail loudly rather than silently using a stale hardcoded URL.
const WORKER1_FALLBACK = null;
const PREVIEW_DOMAIN    = 'preview.websitehub.co.za';
const ASSETS_DOMAIN     = 'assets.websitehub.co.za';

// Plan limits
const PLAN_LIMITS = {
  Standard: { maxPhotos: 10, maxSizeBytes: 3 * 1024 * 1024 },
  Premium:  { maxPhotos: 30, maxSizeBytes: 5 * 1024 * 1024 },
};

// SAST send window: 09:00–12:00, Tuesday–Thursday
// Day index: 0=Sun,1=Mon,2=Tue,3=Wed,4=Thu,5=Fri,6=Sat
const SEND_WINDOW = { days: [2, 3, 4], startHour: 9, endHour: 12 };

// ─── EXPORT ──────────────────────────────────────────────────────────────────

// ============================================================
// CLAUDE MODEL — Auto-resolution with 24hr KV cache
// Same pattern as worker1.js v7 — never needs manual updates
// ============================================================

async function resolveClaudeModel(env) {
  const CACHE_KEY = 'system:claude_model_enrichment';
  const CACHE_TTL = 60 * 60 * 24;

  try {
    const cached = await env.SITES.get(CACHE_KEY);
    if (cached) return cached;
  } catch { /* fall through */ }

  try {
    const res = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key':         env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    if (!res.ok) throw new Error(`Models API ${res.status}`);
    const { data: models } = await res.json();
    const sorted = models
      .filter(m => m.id.includes('claude') && !m.id.includes('haiku'))
      .sort((a, b) => (b.created || 0) - (a.created || 0));
    const sonnet = sorted.find(m => m.id.includes('sonnet'));
    const chosen = (sonnet || sorted[0])?.id;
    if (!chosen) throw new Error('No suitable model found');
    await env.SITES.put(CACHE_KEY, chosen, { expirationTtl: CACHE_TTL });
    console.log(`[enrichment] Claude model resolved: ${chosen}`);
    return chosen;
  } catch (e) {
    console.warn(`[enrichment] Model resolution failed (${e.message}), using fallback`);
    return 'claude-sonnet-4-6';
  }
}

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/upload-assets')  return handleUploadAssets(request, env, ctx);
    if (path === '/patch-preview')  return handlePatchPreview(request, env, ctx);
    if (path.startsWith('/asset/')) return handleAssetProxy(request, env, path);
    if (path.startsWith('/gallery-assets/')) return handleGalleryAssets(request, env, path);
    if (path === '/google-auth')    return handleGoogleAuth(url, env);
    if (path === '/google-profile') return handleGoogleProfile(request, env, ctx);
    if (path === '/patch-gallery')  return handlePatchGallery(request, env);
    if (path === '/health')         return handleHealth(env);

    return jsonResponse({ error: 'Not found' }, 404);
  },

  // ── Email Worker export — handles incoming email to updates@websitehub.co.za
  async email(message, env, ctx) {
    ctx.waitUntil(handleIncomingEmail(message, env));
  },
};

// ============================================================
// ROUTE: /health
// Returns worker status + last-known health of all integrations.
// Admin dashboard reads this to populate the circuit breaker panel.
// ============================================================

async function handleHealth(env) {
  const services = ['twilio', 'airtable', 'anthropic', 'google', 'worker1', 'r2'];
  const checks   = await Promise.all(
    services.map(async s => {
      try {
        const raw = await env.SITES.get(`health:${s}`);
        return [s, raw ? JSON.parse(raw) : { status: 'unknown' }];
      } catch {
        return [s, { status: 'unknown' }];
      }
    })
  );

  const health = Object.fromEntries(checks);

  // Read feature flags
  const flags = {
    VISION_VALIDATION_ENABLED: env.VISION_VALIDATION_ENABLED === 'true',
    OUTBOUND_ENABLED:          env.OUTBOUND_ENABLED === 'true',
    REFERRAL_ENABLED:          env.REFERRAL_ENABLED === 'true',
  };

  return jsonResponse({
    ok:      true,
    worker:  'wh-enrichment-worker',
    version: '2.0',
    time:    new Date().toISOString(),
    flags,
    services: health,
  });
}

// ============================================================
// ROUTE: /upload-assets
// Frontend POSTs Premium brand files here as multipart FormData.
// Fields expected:
//   airtableId   — string (required)
//   slug         — string (required)
//   file_0..N    — File objects (logo + photos, max 6)
//
// Plan limits enforced:
//   Standard: max 10 gallery photos total, 3MB per file
//   Premium:  max 30 gallery photos total, 5MB per file
//
// Flow:
//   1. Extract files from FormData
//   2. Enforce plan limits
//   3. Upload each to R2 under wh-assets/{slug}/brand/
//   4. If VISION_VALIDATION_ENABLED → run Claude vision to extract brand signals
//   5. Update Airtable with brand data
//   6. Trigger rebuild on Worker 1 via /trigger-build
// ============================================================

async function handleUploadAssets(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let formData;
  try { formData = await request.formData(); }
  catch { return jsonResponse({ error: 'Expected multipart/form-data' }, 400); }

  const airtableId = formData.get('airtableId');
  const slug       = formData.get('slug') || slugify(formData.get('businessName') || '');

  if (!airtableId || !slug) {
    return jsonResponse({ error: 'Missing airtableId or slug' }, 400);
  }

  // Fetch client record to determine plan + current photo count
  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client record not found' }, 404); }

  const plan        = record.fields['Package'] || 'Standard';
  const limits      = PLAN_LIMITS[plan] || PLAN_LIMITS.Standard;
  const existingPhotos = (record.fields['Photos'] || '').split(',').filter(Boolean);
  const slotsRemaining = limits.maxPhotos - existingPhotos.length;

  if (slotsRemaining <= 0) {
    return jsonResponse({
      error: `Photo limit reached for ${plan} plan (${limits.maxPhotos} max). ` +
             (plan === 'Standard' ? 'Upgrade to Premium for 30 photos.' : 'Remove some photos first.'),
    }, 400);
  }

  // Collect uploaded files
  const files = [];
  for (let i = 0; i < 6; i++) {
    const file = formData.get(`file_${i}`);
    if (file && file instanceof File) files.push(file);
  }

  if (files.length === 0) {
    return jsonResponse({ error: 'No files received' }, 400);
  }

  // ── Upload to R2 with size limit enforcement ──────────────
  const r2Paths = [];
  const rejected = [];

  for (const file of files.slice(0, slotsRemaining)) {
    const bytes = await file.arrayBuffer();

    if (bytes.byteLength > limits.maxSizeBytes) {
      rejected.push({ name: file.name, reason: `Exceeds ${limits.maxSizeBytes / 1024 / 1024}MB limit` });
      continue;
    }

    const ext      = file.name.split('.').pop().toLowerCase() || 'jpg';
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const r2Key    = `${slug}/brand/${Date.now()}_${safeName}`;

    try {
      await env.ASSETS.put(r2Key, bytes, {
        httpMetadata: { contentType: file.type || `image/${ext}` },
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

  await logHealth('r2', 'ok', `${r2Paths.length} files uploaded for ${slug}`, env);

  // ── Vision + rebuild runs in background ──────────────────
  ctx.waitUntil(
    runVisionAndRebuild(airtableId, slug, r2Paths, files, env).catch(async err => {
      console.error('Vision/rebuild failed:', err);
      await logHealth('anthropic', 'error', err.message, env);
      await logActivity('upload_failed', slug, err.message, env);
      await sendWhatsApp(env.WH_PHONE,
        `⚠️ ASSET PROCESSING ISSUE: ${slug}\nError: ${err.message}\nAirtable: ${airtableId}`,
        env
      ).catch(() => {});
    })
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
// VISION ANALYSIS + REBUILD
// ============================================================

async function runVisionAndRebuild(airtableId, slug, r2Paths, files, env) {
  let brandBrief = '';

  // Vision only runs if flag is enabled
  if (env.VISION_VALIDATION_ENABLED === 'true') {
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
      await logHealth('anthropic', 'ok', `Vision analysis for ${slug}`, env);
    }
  }

  // ── Update Airtable ───────────────────────────────────────
  const r2PathList     = r2Paths.map(p => p.key).join(', ');
  const existingPhotos = (await getAirtableRecord(airtableId, env)).fields['Photos'] || '';
  const allPhotos      = [existingPhotos, r2PathList].filter(Boolean).join(', ');

  const updateFields = { 'Photos': allPhotos };
  if (brandBrief) {
    const existing = (await getAirtableRecord(airtableId, env)).fields['Extra Notes'] || '';
    updateFields['Extra Notes'] = `[BRAND ANALYSIS]\n${brandBrief}\n\n${existing}`.slice(0, 5000);
  }

  await updateAirtableRecord(airtableId, updateFields, env);
  await logHealth('airtable', 'ok', `Photos updated for ${slug}`, env);

  // ── Trigger rebuild via Worker 1 ──────────────────────────
  const worker1Url = env.WORKER1_URL || WORKER1_FALLBACK;

  // v6.0: Only reset status if client is NOT already Live.
  // Live clients keep their Live status — rebuild runs against existing draft.
  const currentStatus = (await getAirtableRecord(airtableId, env)).fields['Status'];
  if (currentStatus !== 'Live') {
    await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env);
  }

  const triggerRes = await fetch(`${worker1Url}/trigger-build`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key':  env.ADMIN_KEY,
    },
    body: JSON.stringify({ airtableId }),
  });

  if (!triggerRes.ok) {
    const errText = await triggerRes.text();
    await logHealth('worker1', 'error', `trigger-build failed: ${triggerRes.status}`, env);
    throw new Error(`Build trigger failed: ${triggerRes.status} — ${errText}`);
  }

  await logHealth('worker1', 'ok', `Rebuild triggered for ${slug}`, env);
  await logActivity('assets_processed', slug, `${r2Paths.length} files, vision=${env.VISION_VALIDATION_ENABLED === 'true'}`, env);

  // Owner notification — no AI language
  await sendWhatsApp(env.WH_PHONE,
    `📸 ASSETS PROCESSED: ${slug}\n${r2Paths.length} file${r2Paths.length !== 1 ? 's' : ''} stored\nRebuild queued`,
    env
  );
}

// ── Claude Vision — extract brand signals from uploaded images ────────────────

async function extractBrandSignals(images, slug, env) {
  const content = [
    {
      type: 'text',
      text: `Analyse these brand assets (logo and photos) for a South African small business. Extract the following:

1. PRIMARY COLOUR — the most dominant brand colour (hex code)
2. SECONDARY COLOUR — supporting colour (hex code)
3. ACCENT COLOUR — highlight/pop colour (hex code)
4. TYPOGRAPHY FEEL — is the logo serif, sans-serif, script, geometric, bold/delicate?
5. BRAND PERSONALITY — 3 adjectives that describe the visual tone (e.g. "warm, artisanal, premium")
6. DESIGN DIRECTION — one sentence: what design style should the website use to match this brand?
7. LOGO PRESENT — yes/no
8. PHOTO QUALITY — describe the photo quality and style if photos are present

Be specific and practical. A developer will use this to build a website.
Format your response as plain text with labels like "PRIMARY COLOUR: #hexcode".`,
    },
  ];

  for (const img of images) {
    content.push({
      type: 'image',
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
// ROUTE: /patch-preview
// Interactive preview panel — ENHANCE-36, DEPENDENCY-09
//
// Client taps palette/photo/text in preview panel → structured JSON POSTed here.
// We do a surgical patch in KV without triggering a full Claude rebuild.
// Full rebuild is only triggered if 'tone' changes.
//
// Body: {
//   airtableId: string,
//   slug:       string,
//   patch: {
//     palette?:    string,          // "warm-welcoming" | "clean-professional" | "bold-modern"
//     heroPhotoId?: string,         // Unsplash photo ID from curated list
//     tagline?:    string,
//     about?:      string,
//     services?:   string,
//     tone?:       string,          // triggers full rebuild
//   }
// }
// ============================================================

async function handlePatchPreview(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId, slug, patch } = body;
  if (!airtableId || !slug || !patch) {
    return jsonResponse({ error: 'Missing airtableId, slug, or patch' }, 400);
  }

  // Tone change = full rebuild needed
  if (patch.tone) {
    ctx.waitUntil(triggerFullRebuild(airtableId, slug, patch, env));
    return jsonResponse({
      success:   true,
      action:    'rebuild',
      message:   'Style change detected — our team is rebuilding your site now. Check back in a few minutes.',
    });
  }

  // Surgical KV patch — no rebuild
  ctx.waitUntil(applyPreviewPatch(airtableId, slug, patch, env));

  return jsonResponse({
    success: true,
    action:  'patch',
    message: 'Changes applied. Refresh your preview link to see them.',
  });
}

async function applyPreviewPatch(airtableId, slug, patch, env) {
  try {
    // Get current KV html
    let html = await env.SITES.get(`preview:${slug}`);
    if (!html) {
      // Try live key
      const record = await getAirtableRecord(airtableId, env);
      const domain = (record.fields['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
      html = await env.SITES.get(`live:${domain}`);
    }

    if (!html) {
      await logActivity('patch_failed', slug, 'KV entry not found', env);
      return;
    }

    // Apply patches
    if (patch.tagline) {
      html = html.replace(
        /(<[^>]+class="[^"]*tagline[^"]*"[^>]*>)[^<]*/i,
        `$1${escapeHtml(patch.tagline)}`
      );
    }

    if (patch.about) {
      html = html.replace(
        /(<[^>]+class="[^"]*about-text[^"]*"[^>]*>)[^<]*/i,
        `$1${escapeHtml(patch.about)}`
      );
    }

    if (patch.services) {
      html = html.replace(
        /(<[^>]+class="[^"]*services-text[^"]*"[^>]*>)[^<]*/i,
        `$1${escapeHtml(patch.services)}`
      );
    }

    if (patch.heroPhotoId) {
      const photoUrl = `https://images.unsplash.com/photo-${patch.heroPhotoId}?auto=format&fit=crop&w=1400&q=80`;
      html = html.replace(
        /(<[^>]+class="[^"]*hero[^"]*"[^>]*style="[^"]*background-image:\s*url\()[^)]*(\)[^"]*")/i,
        `$1${photoUrl}$2`
      );
    }

    if (patch.palette) {
      html = applyPalette(html, patch.palette);
    }

    // Save patched html — write to legacy key AND all per-page keys
    await env.SITES.put(`preview:${slug}`, html);

    // Propagate patch to each per-page preview key so /services, /about etc stay in sync
    const allPages = ['index', 'services', 'about', 'contact', 'gallery'];
    for (const pageName of allPages) {
      const pageKey  = `preview:${slug}:${pageName}`;
      let pageHtml   = await env.SITES.get(pageKey).catch(() => null);
      if (!pageHtml) continue;
      if (patch.palette)    pageHtml = applyPalette(pageHtml, patch.palette);
      if (patch.tagline)    pageHtml = pageHtml.replace(/(<[^>]+class="[^"]*tagline[^"]*"[^>]*>)[^<]*/i, `$1${escapeHtml(patch.tagline)}`);
      if (patch.about    && pageName === 'about')    pageHtml = pageHtml.replace(/(<[^>]+class="[^"]*about-text[^"]*"[^>]*>)[^<]*/i,    `$1${escapeHtml(patch.about)}`);
      if (patch.services && pageName === 'services') pageHtml = pageHtml.replace(/(<[^>]+class="[^"]*services-text[^"]*"[^>]*>)[^<]*/i, `$1${escapeHtml(patch.services)}`);
      if (patch.heroPhotoId && pageName === 'index') {
        const photoUrl = `https://images.unsplash.com/photo-${patch.heroPhotoId}?auto=format&fit=crop&w=1400&q=80`;
        pageHtml = pageHtml.replace(/(<[^>]+class="[^"]*hero[^"]*"[^>]*style="[^"]*background-image:\s*url\()[^)]*(\)[^"]*")/i, `$1${photoUrl}$2`);
      }
      await env.SITES.put(pageKey, pageHtml);
    }

    await logActivity('preview_patched', slug, `patch keys: ${Object.keys(patch).join(', ')}`, env);

    // Update Airtable with any text changes for next rebuild
    const airtableUpdates = {};
    if (patch.tagline)  airtableUpdates['Bio']   = patch.tagline;
    if (patch.about)    airtableUpdates['About']  = patch.about;
    if (patch.services) airtableUpdates['Services'] = patch.services;
    if (Object.keys(airtableUpdates).length) {
      await updateAirtableRecord(airtableId, airtableUpdates, env).catch(() => {});
    }

  } catch (err) {
    console.error('applyPreviewPatch failed:', err);
    await logActivity('patch_failed', slug, err.message, env);
  }
}

async function triggerFullRebuild(airtableId, slug, patch, env) {
  try {
    // Save tone/updates to Airtable first so rebuild picks them up
    const updates = {};
    if (patch.tone)     updates['Vibe']     = patch.tone;
    if (patch.tagline)  updates['Bio']      = patch.tagline;
    if (patch.about)    updates['About']    = patch.about;
    if (patch.services) updates['Services'] = patch.services;
    if (Object.keys(updates).length) {
      await updateAirtableRecord(airtableId, updates, env);
    }

    await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env);

    const worker1Url = env.WORKER1_URL || WORKER1_FALLBACK;
    const res = await fetch(`${worker1Url}/trigger-build`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
      body:    JSON.stringify({ airtableId }),
    });

    if (!res.ok) throw new Error(`trigger-build responded ${res.status}`);
    await logActivity('full_rebuild_triggered', slug, `tone change: ${patch.tone}`, env);
    await logHealth('worker1', 'ok', `Rebuild triggered from patch-preview for ${slug}`, env);
  } catch (err) {
    console.error('triggerFullRebuild failed:', err);
    await logHealth('worker1', 'error', err.message, env);
    await logActivity('rebuild_failed', slug, err.message, env);
  }
}

// Apply colour palette CSS variables to site HTML
function applyPalette(html, paletteName) {
  const palettes = {
    'warm-welcoming':     { primary: '#C8724F', secondary: '#F5EBE0', accent: '#8B4513', text: '#3D2B1F' },
    'clean-professional': { primary: '#1A3A5C', secondary: '#F8F9FA', accent: '#2E86AB', text: '#212529' },
    'bold-modern':        { primary: '#1A1A2E', secondary: '#16213E', accent: '#E94560', text: '#EAEAEA' },
  };

  const colours = palettes[paletteName];
  if (!colours) return html;

  // Replace CSS variables in the style block
  return html
    .replace(/--primary:\s*#[0-9a-fA-F]{3,6}/g,   `--primary: ${colours.primary}`)
    .replace(/--secondary:\s*#[0-9a-fA-F]{3,6}/g, `--secondary: ${colours.secondary}`)
    .replace(/--accent:\s*#[0-9a-fA-F]{3,6}/g,    `--accent: ${colours.accent}`)
    .replace(/--text:\s*#[0-9a-fA-F]{3,6}/g,       `--text: ${colours.text}`);
}

// ============================================================
// ROUTE: GET /gallery-assets/:slug
// Lists R2 bucket at {slug}/gallery/ and returns public photo URLs.
// Called by the gallery page JS fetch on every page load.
// Returns empty array if no photos yet — gallery shows placeholder.
// R2 path: {slug}/gallery/*.jpg (matches email worker upload path)
// ============================================================

async function handleGalleryAssets(request, env, path) {
  if (request.method !== 'GET') return jsonResponse({ error: 'GET only' }, 405);

  const slug = path.replace('/gallery-assets/', '').split('/')[0].trim();
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  try {
    const listed = await env.ASSETS.list({ prefix: `${slug}/gallery/` });

    const urls = (listed.objects || [])
      .filter(obj => /\.(jpg|jpeg|png|webp|gif)$/i.test(obj.key))
      .map(obj => {
        // Use the asset proxy route — assets.websitehub.co.za CDN domain when ready
        if (env.ASSETS_DOMAIN_READY === 'true') {
          return `https://${ASSETS_DOMAIN}/${obj.key}`;
        }
        return `https://wh-enrichment-worker.pierreduplessis6912.workers.dev/asset/${obj.key}`;
      });

    return new Response(JSON.stringify(urls), {
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=60', // 1-min cache — photos update quickly
      },
    });
  } catch (e) {
    console.error('Gallery assets listing error:', e);
    // Return empty array rather than error — gallery shows placeholder gracefully
    return new Response(JSON.stringify([]), {
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// ============================================================
// ROUTE: /asset/:key — R2 asset proxy (existing, unchanged)
// ============================================================

async function handleAssetProxy(request, env, path) {
  // Strip the leading /asset/
  const r2Key = decodeURIComponent(path.replace(/^\/asset\//, ''));

  if (!r2Key || r2Key.includes('..')) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const obj = await env.ASSETS.get(r2Key);
    if (!obj) return new Response('Not found', { status: 404 });

    const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
    return new Response(obj.body, {
      headers: {
        'Content-Type':  contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    console.error('Asset proxy error:', e);
    return new Response('Error', { status: 500 });
  }
}

// ============================================================
// EMAIL WORKER — handles incoming email to updates@websitehub.co.za
//
// Email format expected:
//   To: updates@websitehub.co.za
//   Subject: wh-{slug}  (e.g. "wh-zululand-flooring")
//   Body: anything
//   Attachments: JPG / PNG / WEBP photos
//
// Plan limits enforced on gallery photo count.
//
// Flow:
//   1. Parse subject line → extract slug
//   2. Look up client in Airtable by slug
//   3. Parse MIME attachments from raw email
//   4. Enforce plan photo limit
//   5. Upload each photo to R2 under {slug}/gallery/
//   6. If site is Live → patch gallery section in KV
//   7. If site is Preview/QA → trigger rebuild via Worker 1
//   8. WhatsApp confirmation to client (within send window)
// ============================================================

async function handleIncomingEmail(message, env) {
  const subject = message.headers.get('subject') || '';
  const from    = message.headers.get('from') || '';

  // Extract slug from subject — format: "wh-{slug}" or just "{slug}"
  const slugMatch = subject.match(/wh-([a-z0-9-]+)/i) || subject.match(/([a-z0-9-]{3,50})/i);
  if (!slugMatch) {
    console.warn('Email received with unrecognisable subject:', subject);
    await logActivity('email_unroutable', 'unknown', `from: ${from}, subject: ${subject}`, env);
    message.setReject('No valid site slug in subject line. Format: wh-your-business-name');
    return;
  }

  const slug = slugMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // Look up client in Airtable by slug
  let records;
  try {
    records = await listAirtableRecords(`{Slug} = "${slug}"`, env);
    await logHealth('airtable', 'ok', `Email lookup for ${slug}`, env);
  } catch (e) {
    console.warn('Airtable lookup failed:', e);
    await logHealth('airtable', 'error', e.message, env);
    message.forward('loc10@live.co.za');
    return;
  }

  if (!records.length) {
    console.warn(`No Airtable record for slug: ${slug}`);
    await logActivity('email_unknown_slug', slug, `from: ${from}`, env);
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
  const limits      = PLAN_LIMITS[plan] || PLAN_LIMITS.Standard;
  const existingPhotoList = (f['Photos'] || '').split(',').filter(Boolean);
  const slotsRemaining    = limits.maxPhotos - existingPhotoList.length;

  // Parse MIME attachments
  let photoCount = 0;
  const r2Paths  = [];

  if (slotsRemaining <= 0) {
    // Photo limit reached — notify client
    if (clientPhone) {
      await sendWhatsAppInWindow(clientPhone,
        `Hi! We received your photos for *${bizName}*, but your ${plan} plan gallery is full (${limits.maxPhotos} photos max).\n\n` +
        (plan === 'Standard'
          ? `Upgrade to Premium for up to 30 photos. Reply UPGRADE for details.`
          : `Please ask us to remove some existing photos first.`) +
        `\n\n— Website Hub`,
        env
      );
    }
    await logActivity('email_limit_reached', slug, `plan: ${plan}`, env);
    return;
  }

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

      const ext   = att.contentType.includes('png') ? 'png' : att.contentType.includes('webp') ? 'webp' : 'jpg';
      const r2Key = `${slug}/gallery/photo_${Date.now()}_${i}.${ext}`;

      await env.ASSETS.put(r2Key, att.data, {
        httpMetadata: { contentType: att.contentType },
        customMetadata: { slug, source: 'email', uploadedAt: new Date().toISOString() },
      });

      r2Paths.push(r2Key);
      photoCount++;
    }

    await logHealth('r2', 'ok', `${photoCount} email photos stored for ${slug}`, env);
  } catch (e) {
    console.error('MIME parsing/R2 failed:', e);
    await logHealth('r2', 'error', e.message, env);
    await logActivity('email_photo_error', slug, e.message, env);
  }

  if (photoCount === 0) {
    if (clientPhone) {
      await sendWhatsAppInWindow(clientPhone,
        `Hi! We received your email for *${bizName}* but couldn't find any valid photo attachments (JPG, PNG, or WEBP under ${limits.maxSizeBytes / 1024 / 1024}MB).\n\nPlease try again with your photos attached. — Website Hub`,
        env
      );
    }
    await logActivity('email_no_photos', slug, `from: ${from}`, env);
    return;
  }

  // ── Update Airtable ───────────────────────────────────────
  const allPhotos = [...existingPhotoList, ...r2Paths];
  await updateAirtableRecord(airtableId, { 'Photos': allPhotos.join(', ') }, env);

  // ── Patch gallery or rebuild ──────────────────────────────
  if (status === 'Live') {
    const domain = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    await patchGalleryInKV(slug, domain, r2Paths, env);

    await sendWhatsAppInWindow(clientPhone,
      `📸 Got your photos! We've added *${photoCount} photo${photoCount > 1 ? 's' : ''}* to your *${bizName}* gallery.\n\n✅ Your site is updated: https://${domain}\n\n— Website Hub`,
      env
    );
    await sendWhatsApp(env.WH_PHONE,
      `📸 GALLERY UPDATED: ${bizName} (${slug})\n${photoCount} photos added via email\nSite: https://${domain}`,
      env
    );
    await logActivity('gallery_updated', slug, `${photoCount} photos via email`, env);

  } else {
    const worker1Url = env.WORKER1_URL || WORKER1_FALLBACK;
    // v6.0: Only reset to Deposit Paid if not already Live
    if (status !== 'Live') {
      await updateAirtableRecord(airtableId, { 'Status': 'Deposit Paid' }, env);
    }

    const rebuildRes = await fetch(`${worker1Url}/trigger-build`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
      body:    JSON.stringify({ airtableId }),
    }).catch(e => ({ ok: false, _err: e }));

    if (!rebuildRes.ok) {
      await logHealth('worker1', 'error', `trigger-build failed for email rebuild: ${slug}`, env);
    } else {
      await logHealth('worker1', 'ok', `Rebuild triggered from email for ${slug}`, env);
    }

    await sendWhatsAppInWindow(clientPhone,
      `📸 Got your photos! We're updating your *${bizName}* website with them now. You'll have an updated preview link in about 10 minutes. ⚡\n\n— Website Hub`,
      env
    );
    await sendWhatsApp(env.WH_PHONE,
      `📸 PHOTOS RECEIVED (PRE-LIVE): ${bizName} (${slug})\n${photoCount} photos — rebuild triggered`,
      env
    );
    await logActivity('email_rebuild_triggered', slug, `${photoCount} photos, status: ${status}`, env);
  }
}

// ── Patch gallery section in live KV site ────────────────────────────────────

async function patchGalleryInKV(slug, domain, r2Paths, env) {
  // Build public URLs — use /asset/ proxy until assets.websitehub.co.za is live
  const worker1Url = env.WORKER1_URL || WORKER1_FALLBACK;
  const enrichWorkerBase = (worker1Url || '').replace('dropbox-proxy', 'wh-enrichment-worker');

  const photoUrls = r2Paths.map(key => {
    // If custom domain is set up use it, otherwise fall back to asset proxy
    if (env.ASSETS_DOMAIN_READY === 'true') {
      return `https://${ASSETS_DOMAIN}/${key}`;
    }
    return `https://wh-enrichment-worker.pierreduplessis6912.workers.dev/asset/${key}`;
  });

  const galleryItems = photoUrls.map(url =>
    `<div class="gallery-item"><img src="${url}" alt="Gallery photo" loading="lazy" style="width:100%;height:220px;object-fit:cover;border-radius:4px;"></div>`
  ).join('\n        ');

  const galleryHtml = `<!-- GALLERY START -->\n        ${galleryItems}\n        <!-- GALLERY END -->`;

  for (const key of [`live:${domain}`, `preview:${slug}`]) {
    let html = await env.SITES.get(key);
    if (!html) continue;

    if (html.includes('<!-- Gallery:')) {
      html = html.replace(/<!-- Gallery:.*?-->/s, galleryHtml);
    } else if (html.includes('<!-- GALLERY START -->')) {
      html = html.replace(/<!-- GALLERY START -->[\s\S]*?<!-- GALLERY END -->/, galleryHtml);
    } else {
      console.warn(`No gallery placeholder found in KV key: ${key}`);
      continue;
    }

    await env.SITES.put(key, html);
    console.log(`Gallery patched in KV: ${key} — ${r2Paths.length} photos`);
    return true;
  }

  return false;
}

// ============================================================
// ROUTE: /patch-gallery
// Manual trigger — admin can call this to force a gallery patch.
// Body: { airtableId, r2Paths: ['slug/gallery/photo1.jpg', ...] }
// Protected by x-admin-key.
// ============================================================

async function handlePatchGallery(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

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
  const domain = (f['Domain'] || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  const patched = await patchGalleryInKV(slug, domain, r2Paths, env);
  await logActivity('gallery_manual_patch', slug, `${r2Paths.length} paths`, env);

  return jsonResponse({ success: patched, slug, domain, photosPatched: r2Paths.length });
}

// ============================================================
// ROUTE: /google-profile
// Creates or updates a Google Business Profile for a client.
// Body: { airtableId }
// Protected by x-admin-key.
//
// Logic:
//   1. Get client data from Airtable
//   2. Get Google access token from refresh token
//   3. Search for existing profile by business name
//   3a. FOUND → update website URL
//   3b. NOT FOUND → create new profile → WhatsApp client with postcard instructions
// ============================================================

async function handleGoogleProfile(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (request.headers.get('x-admin-key') !== env.ADMIN_KEY) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { airtableId } = body;
  if (!airtableId) return jsonResponse({ error: 'Missing airtableId' }, 400);

  let record;
  try { record = await getAirtableRecord(airtableId, env); }
  catch { return jsonResponse({ error: 'Client not found' }, 404); }

  ctx.waitUntil(
    processGoogleProfile(airtableId, record.fields, env).catch(async err => {
      console.error('Google profile processing failed:', err);
      await logHealth('google', 'error', err.message, env);
      await sendWhatsApp(env.WH_PHONE,
        `⚠️ GOOGLE PROFILE ISSUE: ${record.fields['Business Name']}\nError: ${err.message}\nAirtable: ${airtableId}`,
        env
      ).catch(() => {});
    })
  );

  return jsonResponse({ success: true, message: 'Google profile processing started.' });
}

async function processGoogleProfile(airtableId, f, env) {
  const accessToken = await getGoogleAccessToken(env);
  if (!accessToken) {
    throw new Error('Google access token unavailable — run /google-auth first');
  }

  const bizName    = f['Business Name'] || '';
  const area       = f['Area'] || '';
  const domain     = (f['Domain'] || `${slugify(bizName)}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const phone      = f['WhatsApp'] || '';
  const clientName = f['Client Name']?.split(' ')[0] || 'there';
  const industry   = f['Industry'] || '';

  // ── Get Google My Business account ───────────────────────
  const accountsRes  = await fetch(
    'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const accountsData = await accountsRes.json();
  const account      = accountsData?.accounts?.[0];

  if (!account) {
    throw new Error('No Google My Business account found. Create one at business.google.com first.');
  }

  const accountName = account.name;

  // ── Search existing locations ─────────────────────────────
  const locRes = await fetch(
    `https://mybusinessinformation.googleapis.com/v1/${accountName}/locations?readMask=name,title,websiteUri,phoneNumbers`,
    { headers: { 'Authorization': `Bearer ${accessToken}` } }
  );
  const locData   = await locRes.json();
  const locations = locData?.locations || [];

  const existing = locations.find(loc =>
    loc.title?.toLowerCase().includes(bizName.toLowerCase().split(' ')[0])
  );

  if (existing) {
    // ── EXISTING PROFILE: update website URL ─────────────────
    await fetch(
      `https://mybusinessinformation.googleapis.com/v1/${existing.name}?updateMask=websiteUri`,
      {
        method:  'PATCH',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ websiteUri: `https://${domain}` }),
      }
    );

    await updateAirtableRecord(airtableId, { 'Google Profile Status': 'Claimed' }, env);
    await logHealth('google', 'ok', `Profile updated for ${bizName}`, env);
    await logActivity('google_profile_updated', slugify(bizName), domain, env);

    await sendWhatsAppInWindow(phone,
      `📍 Great news, ${clientName}! We found your *${bizName}* Google Business Profile and linked it to your new website.\n\nPeople searching for you on Google Maps will now be sent straight to your site. 🗺️\n\n— Website Hub`,
      env
    );

    await sendWhatsApp(env.WH_PHONE,
      `📍 GOOGLE PROFILE UPDATED: ${bizName}\nWebsite: https://${domain}\nLocation: ${existing.name}`,
      env
    );

  } else {
    // ── NEW PROFILE: create location ──────────────────────────
    const category = industryToGoogleCategory(industry);

    const newLocation = {
      title: bizName,
      storefrontAddress: {
        regionCode:     'ZA',
        administrativeArea: area,
        locality:       area,
      },
      websiteUri:   `https://${domain}`,
      phoneNumbers: phone ? {
        primaryPhone: `+${String(phone).replace(/\D/g, '').replace(/^0/, '27')}`,
      } : undefined,
      categories: {
        primaryCategory: { name: category },
      },
      serviceArea: {
        businessType: 'CUSTOMER_LOCATION_ONLY',
        places: { placeInfos: [{ name: area, placeId: '' }] },
      },
      regularHours: {
        periods: [
          { openDay: 'MONDAY',    openTime: { hours: 8 }, closeDay: 'MONDAY',    closeTime: { hours: 17 } },
          { openDay: 'TUESDAY',   openTime: { hours: 8 }, closeDay: 'TUESDAY',   closeTime: { hours: 17 } },
          { openDay: 'WEDNESDAY', openTime: { hours: 8 }, closeDay: 'WEDNESDAY', closeTime: { hours: 17 } },
          { openDay: 'THURSDAY',  openTime: { hours: 8 }, closeDay: 'THURSDAY',  closeTime: { hours: 17 } },
          { openDay: 'FRIDAY',    openTime: { hours: 8 }, closeDay: 'FRIDAY',    closeTime: { hours: 17 } },
        ],
      },
    };

    const createRes  = await fetch(
      `https://mybusinessinformation.googleapis.com/v1/${accountName}/locations?validateOnly=false`,
      {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(newLocation),
      }
    );
    const createData = await createRes.json();

    if (!createRes.ok) {
      throw new Error(`Google profile create failed: ${JSON.stringify(createData)}`);
    }

    await updateAirtableRecord(airtableId, { 'Google Profile Status': 'Created' }, env);
    await logHealth('google', 'ok', `Profile created for ${bizName}`, env);
    await logActivity('google_profile_created', slugify(bizName), domain, env);

    await sendWhatsAppInWindow(phone,
      `📍 Hi ${clientName}! We've created your *${bizName}* Google Business Profile.\n\n*What happens next:*\nGoogle sends a postcard to your business address within 5–14 days. It has a PIN code.\n\nWhen it arrives, tap this link and enter the PIN:\nhttps://business.google.com/verify\n\nOnce verified, *${bizName}* appears on Google Maps. 🗺️\n\n— Website Hub`,
      env
    );

    await sendWhatsApp(env.WH_PHONE,
      `📍 GOOGLE PROFILE CREATED: ${bizName}\nWebsite: https://${domain}\nStatus: Awaiting postcard verification\nAirtable: ${airtableId}`,
      env
    );
  }
}

// ── Industry → Google Business Category mapping ───────────────────────────────

function industryToGoogleCategory(industry) {
  const key = (industry || '').toLowerCase();
  const map = {
    'restaurant':       'gcid:restaurant',
    'food':             'gcid:restaurant',
    'cafe':             'gcid:cafe',
    'hair':             'gcid:hair_salon',
    'salon':            'gcid:beauty_salon',
    'barber':           'gcid:barber_shop',
    'beauty':           'gcid:beauty_salon',
    'nails':            'gcid:nail_salon',
    'spa':              'gcid:spa',
    'gym':              'gcid:gym',
    'fitness':          'gcid:gym',
    'personal trainer': 'gcid:personal_trainer',
    'medical':          'gcid:doctor',
    'dental':           'gcid:dentist',
    'doctor':           'gcid:doctor',
    'clinic':           'gcid:medical_clinic',
    'estate':           'gcid:real_estate_agency',
    'property':         'gcid:real_estate_agency',
    'flooring':         'gcid:flooring_store',
    'tiles':            'gcid:flooring_store',
    'construction':     'gcid:general_contractor',
    'builder':          'gcid:general_contractor',
    'electrical':       'gcid:electrician',
    'electrician':      'gcid:electrician',
    'plumber':          'gcid:plumber',
    'plumbing':         'gcid:plumber',
    'cleaning':         'gcid:house_cleaning_service',
    'automotive':       'gcid:car_repair',
    'car':              'gcid:car_dealer',
    'retail':           'gcid:clothing_store',
    'boutique':         'gcid:clothing_store',
    'kids':             'gcid:tutoring_service',
    'education':        'gcid:tutoring_service',
    'school':           'gcid:school',
    'lawyer':           'gcid:lawyer',
    'accountant':       'gcid:accounting_firm',
    'professional':     'gcid:business_management_consultant',
  };
  for (const [fragment, gcid] of Object.entries(map)) {
    if (key.includes(fragment)) return gcid;
  }
  return 'gcid:establishment';
}

// ============================================================
// ROUTE: /google-auth — one-time OAuth setup
// Visit this URL to get a refresh token for the Google My Business API.
// Step 1: Visit /google-auth → click link → sign in with Google
// Step 2: Google redirects back with ?code=... → exchanges for refresh_token
// Step 3: Copy refresh_token → add as GOOGLE_REFRESH_TOKEN secret
// ============================================================

async function handleGoogleAuth(url, env) {
  const redirectUri = `${url.origin}/google-auth`;
  const code        = url.searchParams.get('code');

  if (!code) {
    const scopes  = 'https://www.googleapis.com/auth/business.manage';
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=code` +
      `&scope=${encodeURIComponent(scopes)}` +
      `&access_type=offline` +
      `&prompt=consent`;

    return new Response(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:700px">
      <h2>Google My Business — One-Time Auth Setup</h2>
      <p>Click this link and sign in with <strong>pierreduplessis6912@gmail.com</strong>:</p>
      <p><a href="${authUrl}" style="background:#4285f4;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;margin:16px 0">
        Sign in with Google →
      </a></p>
      <p style="color:#666;font-size:13px">After sign-in, you'll be redirected back here with your refresh token.</p>
      <hr style="margin:32px 0">
      <p style="color:#999;font-size:12px">Redirect URI (must be in Google Cloud Console → OAuth credentials):<br>
      <code style="background:#f5f5f5;padding:4px 8px;border-radius:4px">${redirectUri}</code></p>
    </body></html>`, { headers: { 'Content-Type': 'text/html' } });
  }

  // Exchange code for tokens
  try {
    const tokenRes  = await fetch('https://oauth2.googleapis.com/token', {
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
      return new Response(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px;max-width:700px">
        <h2>✅ Done! Copy your refresh token:</h2>
        <pre style="background:#e8f5e9;padding:16px;border-radius:8px;word-break:break-all;font-size:13px">${tokenData.refresh_token}</pre>
        <p style="color:#555">
          1. Copy the token above<br>
          2. Cloudflare → Workers → wh-enrichment-worker → Settings → Variables → Add Secret<br>
          3. Name: <strong>GOOGLE_REFRESH_TOKEN</strong> — paste your token<br>
          4. Save
        </p>
      </body></html>`, { headers: { 'Content-Type': 'text/html' } });
    }

    return new Response(`<!DOCTYPE html><html><body style="font-family:Arial;padding:40px">
      <h2>❌ Auth Failed</h2>
      <pre>${JSON.stringify(tokenData, null, 2)}</pre>
      <p>Go back to /google-auth and try again. Make sure you see the account chooser screen.</p>
    </body></html>`, { headers: { 'Content-Type': 'text/html' } });

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ── Get Google access token from refresh token ────────────────────────────────

async function getGoogleAccessToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return null;
  }
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        client_id:     env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type:    'refresh_token',
      }),
    });
    const data = await res.json();
    return data.access_token || null;
  } catch (e) {
    console.warn('Google token refresh failed:', e);
    return null;
  }
}

// ============================================================
// MIME ATTACHMENT PARSER
// Parses raw email bytes to extract image attachments.
// Handles quoted-printable and base64 Content-Transfer-Encoding.
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

    const splitIdx = part.indexOf('\r\n\r\n') !== -1
      ? part.indexOf('\r\n\r\n')
      : part.indexOf('\n\n');
    if (splitIdx === -1) continue;

    const headerSection = part.slice(0, splitIdx);
    const bodySection   = part.slice(splitIdx + (part.includes('\r\n\r\n') ? 4 : 2));

    const contentType = (headerSection.match(/Content-Type:\s*([^\r\n;]+)/i) || [])[1]?.trim().toLowerCase() || '';
    if (!contentType.startsWith('image/')) continue;

    const encoding = (headerSection.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1]?.trim().toLowerCase() || '';

    let data;
    if (encoding === 'base64') {
      try {
        const b64 = bodySection.replace(/\s/g, '');
        const bin = atob(b64);
        data      = new Uint8Array(bin.length);
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

// ── Stream raw email to Uint8Array ───────────────────────────────────────────

async function streamToUint8Array(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total    = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) { chunks.push(value); total += value.length; }
  }

  const out    = new Uint8Array(total);
  let   offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ============================================================
// TWILIO — WhatsApp
// sendWhatsApp         — sends immediately (owner alerts only)
// sendWhatsAppInWindow — respects SAST send window (client-facing)
//
// Send window: 09:00–12:00 SAST, Tuesday–Thursday
// Retainer reminders are exempt from day-of-week restriction.
// Opt-out honoured instantly — never contacts opted-out numbers.
// ============================================================

async function sendWhatsApp(to, message, env) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_WA_FROM) {
    console.warn('Twilio not configured — skipping:', message.slice(0, 60));
    return null;
  }

  const toRaw  = String(to || '').replace(/\D/g, '');
  if (!toRaw) return null;

  const toIntl = toRaw.startsWith('27') ? toRaw : toRaw.replace(/^0/, '27');
  const toWA   = `whatsapp:+${toIntl}`;

  // Opt-out check
  const optedOut = await env.SITES.get(`optout:${toIntl}`).catch(() => null);
  if (optedOut) {
    console.warn(`Skipping opted-out number: ${toIntl}`);
    return null;
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`,
      {
        method:  'POST',
        headers: {
          'Authorization': 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`),
          'Content-Type':  'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ From: env.TWILIO_WA_FROM, To: toWA, Body: message }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      console.warn('Twilio error:', data);
      await logHealth('twilio', 'error', data?.message || res.status, env);
    } else {
      await logHealth('twilio', 'ok', `Sent to ${toIntl}`, env);
    }
    return data;
  } catch (e) {
    console.warn('Twilio fetch error:', e);
    await logHealth('twilio', 'error', e.message, env);
    return null;
  }
}

// sendWhatsAppInWindow — respects SAST business hours for client messages
// If outside window, queues message in KV for delivery at next valid window.
// Cron on Worker 1 handles deferred delivery (drains KV key send_queue:{ts}).
async function sendWhatsAppInWindow(to, message, env, opts = {}) {
  const now     = new Date();
  // SAST = UTC+2
  const sastMs  = now.getTime() + (2 * 60 * 60 * 1000);
  const sast    = new Date(sastMs);
  const hour    = sast.getUTCHours();
  const day     = sast.getUTCDay(); // 0=Sun

  const inWindow =
    SEND_WINDOW.days.includes(day) &&
    hour >= SEND_WINDOW.startHour &&
    hour < SEND_WINDOW.endHour;

  // Retainer reminders (opts.urgent=true) skip day restriction but still respect hours
  const urgentInWindow = opts.urgent
    ? (hour >= SEND_WINDOW.startHour && hour < SEND_WINDOW.endHour)
    : false;

  if (inWindow || urgentInWindow) {
    return sendWhatsApp(to, message, env);
  }

  // Queue for next window — Worker 1 daily cron drains this
  const queueKey = `send_queue:${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  await env.SITES.put(queueKey, JSON.stringify({ to, message, queuedAt: now.toISOString() }), {
    expirationTtl: 7 * 24 * 60 * 60, // expire after 7 days if unclaimed
  }).catch(e => {
    // If queue write fails, send immediately rather than dropping the message
    console.warn('Send queue write failed — sending immediately:', e);
    return sendWhatsApp(to, message, env);
  });

  console.log(`Message queued for next send window: ${queueKey}`);
  return null;
}

// ============================================================
// AIRTABLE HELPERS
// ============================================================

async function getAirtableRecord(recordId, env) {
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}/${recordId}`,
    { headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Airtable get failed: ${res.status}`);
  return res.json();
}

async function updateAirtableRecord(recordId, fields, env) {
  const clean = Object.fromEntries(
    Object.entries(fields).filter(([_, v]) => v !== undefined && v !== null)
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
    }
  );
  if (!res.ok) throw new Error(`Airtable update failed: ${res.status}`);
  return res.json();
}

async function listAirtableRecords(filterFormula, env) {
  const params = new URLSearchParams({ maxRecords: '10' });
  if (filterFormula) params.set('filterByFormula', filterFormula);
  const res = await fetch(
    `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}?${params}`,
    { headers: { 'Authorization': `Bearer ${env.AIRTABLE_TOKEN}` } }
  );
  if (!res.ok) throw new Error(`Airtable list failed: ${res.status}`);
  const data = await res.json();
  return data.records || [];
}

// ============================================================
// HEALTH + ACTIVITY LOGGING
// All operations write their last result to KV.
// Admin dashboard reads health:{service} to show circuit breaker panel.
// activity:w2:{ts} entries give dashboard the Worker 2 activity feed.
// ============================================================

async function logHealth(service, status, detail, env) {
  const payload = JSON.stringify({
    status,
    detail,
    timestamp: new Date().toISOString(),
    ...(status === 'ok'    ? { lastSuccess: new Date().toISOString() } : {}),
    ...(status === 'error' ? { lastError:   detail } : {}),
  });
  await env.SITES.put(`health:${service}`, payload).catch(() => {});
}

async function logActivity(event, slug, detail, env) {
  const ts  = Date.now();
  const key = `activity:w2:${ts}`;
  await env.SITES.put(key, JSON.stringify({ event, slug, detail, timestamp: new Date().toISOString() }), {
    expirationTtl: 30 * 24 * 60 * 60, // 30 days
  }).catch(() => {});
}

// ============================================================
// UTILITIES
// ============================================================

function slugify(name) {
  return (name || 'site').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function corsResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    },
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
