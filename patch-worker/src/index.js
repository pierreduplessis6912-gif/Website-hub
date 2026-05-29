// ============================================================
// WEBSITE HUB — patch-worker.js
// Owns surgical preview patches, asset uploads to R2, gallery
// management, the email gateway (updates@websitehub.co.za),
// the manage panel data endpoint, the revision flow, and Claude
// Vision brand-signal extraction from uploaded photos.
//
// ROUTES OWNED:
//   POST /patch-preview            — surgical KV patch from SPA tweak drawer
//   POST /upload-assets            — manage panel photo upload to R2 + D1
//   GET  /asset/{key}              — R2 proxy
//   GET  /gallery-assets/{slug}    — JSON list of gallery photo URLs (D1 + R2)
//   POST /patch-gallery            — admin manual gallery patch
//   POST /submit-revision          — revision submission (gates on free limit)
//   GET  /manage-panel             — manage panel data (tier-gated, from D1)
//   POST /apply-revision-payment   — called by launch-worker after paid revision ITN
//   GET  /health                   — service health
//
// EMAIL HANDLER:
//   email(message, env, ctx)       — incoming email to updates@websitehub.co.za
//                                    Subject: "wh-{slug}", attachments → R2 + D1 gallery
//
// KEY ARCHITECTURE NOTES (v2):
//   — manage_token lookup is now via D1 getClientByToken (no KV manage_token:* keys)
//   — Revision counts tracked in D1 revisions table (not KV manage_revisions:*)
//   — Gallery photos stored in D1 gallery_photos table (addGalleryPhoto)
//   — pending_revision:* stays in KV (ephemeral 2-hour token for PayFast flow)
// ============================================================

import {
  PRICING, PACKAGE_CAPS,
  isTestMode, packageKey, getPricingTier, getPackageCaps, getUpgradeDelta, buildPayFastLink,
  jsonResponse, corsResponse,
  slugify, escapeHtml, uint8ArrayToBase64, currentMonthKey, todayDateString,
  resolveClaudeModel,
  sendWhatsApp, queueScheduledMessage, normaliseSaPhone,
  logEvent, getFlag,
  constantTimeCompare, checkRateLimit,
  getClientById, getClientBySlug, getClientByToken, updateClient,
  createRevision, updateRevision,
  addGalleryPhoto, getGalleryPhotos,
  logMessage, hasMessageBeenSent,
} from './shared-services.js';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const ASSETS_DOMAIN = 'assets.websitehub.co.za';

const PLAN_PHOTO_LIMITS = Object.freeze({
  express:  { maxPhotos: 0,  maxSizeBytes: 0 },
  standard: { maxPhotos: 10, maxSizeBytes: 3 * 1024 * 1024 },
  premium:  { maxPhotos: 30, maxSizeBytes: 5 * 1024 * 1024 },
});

const PENDING_REVISION_TTL = 60 * 60 * 2; // 2 hours — stays in KV (ephemeral PayFast handshake)

// ────────────────────────────────────────────────────────────
// EXPORT — fetch + email
// ────────────────────────────────────────────────────────────

export default {

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return corsResponse(null, 204);

    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/patch-preview')           return handlePatchPreview(request, env, ctx);
    if (path === '/upload-assets')           return handleUploadAssets(request, env, ctx);
    if (path.startsWith('/asset/'))          return handleAssetProxy(request, env, path);
    if (path.startsWith('/gallery-assets/')) return handleGalleryAssets(request, env, path);
    if (path === '/patch-gallery')           return handlePatchGallery(request, env);
    if (path === '/submit-revision')         return handleSubmitRevision(request, env, ctx);
    if (path === '/manage-panel')            return handleManagePanel(request, url, env);
    if (path === '/apply-revision-payment')  return handleApplyRevisionPayment(request, env);
    if (path === '/health')                  return handleHealth(env);

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
  let d1Status = 'unknown';
  try { await env.DB.prepare('SELECT 1').first(); d1Status = 'ok'; }
  catch { d1Status = 'error'; }

  return jsonResponse({
    ok:       true,
    worker:   'patch-worker',
    time:     new Date().toISOString(),
    testMode: isTestMode(env),
    d1:       d1Status,
  });
}

// ============================================================
// ROUTE: /patch-preview — surgical KV patch from SPA tweak drawer
//
// Body: { clientId, slug, patch: { palette?, heroPhotoId?, tagline?,
//         about?, services?, tone? } }
// ============================================================

async function handlePatchPreview(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId: bodyClientId, token, slug, patch } = body;
  if (!slug || !patch) return jsonResponse({ error: 'Missing slug or patch' }, 400);

  // Resolve clientId from token if not provided directly
  let clientId = bodyClientId;
  if (!clientId && token) {
    const resolved = await getClientByToken(env, token).catch(() => null);
    if (resolved) clientId = resolved.id;
  }

  // Tone change = full rebuild
  if (patch.tone) {
    ctx.waitUntil(triggerFullRebuild(clientId, slug, patch, env));
    return jsonResponse({
      success: true,
      action:  'rebuild',
      message: 'Style change detected — our team is rebuilding your site now. Check back in a few minutes.',
    });
  }

  ctx.waitUntil(applyPreviewPatch(clientId, slug, patch, env));

  return jsonResponse({
    success: true,
    action:  'patch',
    message: 'Changes applied. Refresh your preview link to see them.',
  });
}

async function applyPreviewPatch(clientId, slug, patch, env) {
  try {
    let client = null;
    if (clientId) client = await getClientById(env, clientId).catch(() => null);
    if (!client && slug) client = await getClientBySlug(env, slug).catch(() => null);

    const pkg   = packageKey(client?.package || 'standard');
    const caps  = getPackageCaps(pkg);
    const pages = caps.pages;
    const domain = (client?.domain || `${slug}.co.za`)
      .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

    // Patch the legacy single-page key first
    let html = await env.SITES.get(`preview:${slug}`);
    if (!html) html = await env.SITES.get(`live:${domain}`);

    if (!html) {
      await logEvent(env, 'patch', 'patch_failed', 'warning', { metadata: { slug, reason: 'No preview/live KV entry' } });
      return;
    }

    html = applyPatchToHtml(html, patch, 'index');
    await env.SITES.put(`preview:${slug}`, html);

    for (const pageName of pages) {
      let pageHtml = await env.SITES.get(`preview:${slug}:${pageName}`).catch(() => null);
      if (!pageHtml) continue;
      pageHtml = applyPatchToHtml(pageHtml, patch, pageName);
      await env.SITES.put(`preview:${slug}:${pageName}`, pageHtml);
    }

    // Persist palette and logo_url choices to D1
    if (client?.id) {
      const updates = {};
      if (patch.palette)  updates.palette  = patch.palette;
      if (patch.logo_url) updates.logo_url = patch.logo_url;
      if (Object.keys(updates).length) await updateClient(env, client.id, updates).catch(() => {});
    }

    // Persist text changes to D1 client record
    if (client?.id) {
      const textUpdates = {};
      if (patch.tagline)  textUpdates.testimonial  = patch.tagline;   // closest field
      if (patch.about)    textUpdates.about        = patch.about.slice(0, 200);
      if (patch.services) textUpdates.services     = patch.services;
      if (Object.keys(textUpdates).length) await updateClient(env, client.id, textUpdates).catch(() => {});
    }

    await logEvent(env, 'patch', 'preview_patched', 'success', {
      clientId: client?.id,
      metadata: { slug, keys: Object.keys(patch).join(', ') },
    });
  } catch (err) {
    console.error('applyPreviewPatch failed:', err);
    await logEvent(env, 'patch', 'patch_failed', 'failure', { metadata: { slug, error: err.message } });
  }
}

function applyPatchToHtml(html, patch, pageName) {
  let out = html;

  if (patch.palette) out = applyPalette(out, patch.palette);

  if (patch.tagline) {
    out = out.replace(
      /(<[^>]+class="[^"]*tagline[^"]*"[^>]*>)[^<]*/i,
      `$1${escapeHtml(patch.tagline)}`,
    );
  }

  if (patch.heroPhotoId && pageName === 'index') {
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

function applyPalette(html, paletteName) {
  const palettes = {
    'warm-welcoming':     { primary: '#C8724F', secondary: '#F5EBE0', accent: '#8B4513', text: '#3D2B1F' },
    'clean-professional': { primary: '#1A3A5C', secondary: '#F8F9FA', accent: '#2E86AB', text: '#212529' },
    'bold-modern':        { primary: '#1A1A2E', secondary: '#16213E', accent: '#E94560', text: '#EAEAEA' },
  };
  const c = palettes[paletteName];
  if (!c) return html;
  return html
    .replace(/--primary:\s*#[0-9a-fA-F]{3,6}/g,   `--primary: ${c.primary}`)
    .replace(/--secondary:\s*#[0-9a-fA-F]{3,6}/g, `--secondary: ${c.secondary}`)
    .replace(/--accent:\s*#[0-9a-fA-F]{3,6}/g,    `--accent: ${c.accent}`)
    .replace(/--acc:\s*#[0-9a-fA-F]{3,6}/g,       `--acc: ${c.accent}`)
    .replace(/--text:\s*#[0-9a-fA-F]{3,6}/g,      `--text: ${c.text}`)
    .replace(/--bg:\s*#[0-9a-fA-F]{3,6}/g,        `--bg: ${c.primary}`)
    .replace(/--surface:\s*#[0-9a-fA-F]{3,6}/g,   `--surface: ${c.secondary}`);
}

async function triggerFullRebuild(clientId, slug, patch, env) {
  try {
    if (clientId) {
      const updates = {};
      if (patch.tone)     updates.vibe     = patch.tone;
      if (patch.tagline)  updates.testimonial = patch.tagline;
      if (patch.about)    updates.about    = patch.about.slice(0, 200);
      if (patch.services) updates.services = patch.services;
      if (Object.keys(updates).length) await updateClient(env, clientId, updates);
    }

    await env.BUILD_QUEUE.send({ type: 'pre_build', clientId, paymentId: null, isOutbound: false });

    await logEvent(env, 'patch', 'full_rebuild_triggered', 'success', {
      clientId, metadata: { slug, source: 'patch_preview_tone_change' },
    });
  } catch (err) {
    console.error('triggerFullRebuild failed:', err);
    await logEvent(env, 'patch', 'rebuild_failed', 'failure', { clientId, error: err.message });
  }
}

// ============================================================
// ROUTE: /upload-assets — manage panel photo upload to R2 + D1
// ============================================================

async function handleUploadAssets(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  const allowed  = await checkRateLimit(env, `upload:${clientIp}`, 60000, 10);
  if (!allowed) return jsonResponse({ error: 'Upload rate limit exceeded — max 10 uploads/minute' }, 429);

  let formData;
  try { formData = await request.formData(); }
  catch { return jsonResponse({ error: 'Expected multipart/form-data' }, 400); }

  const clientId = formData.get('clientId');
  const slug     = formData.get('slug') || slugify(formData.get('businessName') || '');
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  // Resolve client from D1
  let client = null;
  if (clientId) client = await getClientById(env, clientId).catch(() => null);
  if (!client && slug) client = await getClientBySlug(env, slug).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client record not found' }, 404);

  const pkg      = packageKey(client.package || 'standard');
  const limits   = PLAN_PHOTO_LIMITS[pkg];

  if (limits.maxPhotos === 0) {
    return jsonResponse({
      error: `Photo gallery is not included in the ${pkg} plan.`,
      upgradeAvailable: true,
      upgradeDelta:     getUpgradeDelta(pkg, 'premium'),
    }, 403);
  }

  // Count existing gallery photos from D1
  const existingPhotos = await getGalleryPhotos(env, client.id).catch(() => []);
  const slotsRemaining = limits.maxPhotos - existingPhotos.length;

  if (slotsRemaining <= 0) {
    return jsonResponse({
      error: `Photo limit reached for ${pkg} plan (${limits.maxPhotos} max). ` +
             (pkg === 'standard' ? 'Upgrade to Premium for 30 photos.' : 'Remove some photos first.'),
      upgradeAvailable: pkg === 'standard',
      upgradeDelta:     pkg === 'standard' ? getUpgradeDelta(pkg, 'premium') : 0,
    }, 400);
  }

  const files = [];
  for (let i = 0; i < 6; i++) {
    const file = formData.get(`file_${i}`);
    if (file && file instanceof File) files.push(file);
  }
  if (files.length === 0) return jsonResponse({ error: 'No files received' }, 400);

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
    const r2Key    = `${slug}/gallery/${Date.now()}_${safeName}`;

    try {
      await env.ASSETS.put(r2Key, bytes, {
        httpMetadata:   { contentType: file.type || `image/${ext}` },
        customMetadata: { slug, uploadedAt: new Date().toISOString() },
      });
      const url = `https://${ASSETS_DOMAIN}/${r2Key}`;
      r2Paths.push({ key: r2Key, name: file.name, type: file.type, size: bytes.byteLength, url });
    } catch (e) {
      console.warn(`R2 upload failed for ${file.name}:`, e);
      rejected.push({ name: file.name, reason: 'Storage error' });
    }
  }

  if (r2Paths.length === 0) return jsonResponse({ error: 'All uploads failed', rejected }, 500);

  await logEvent(env, 'patch', 'assets_uploaded', 'success', {
    clientId: client.id, metadata: { count: r2Paths.length, slug },
  });

  ctx.waitUntil(
    runVisionAndRebuild(client, slug, r2Paths, files, env).catch(async err => {
      console.error('Vision/rebuild failed:', err);
      await logEvent(env, 'patch', 'vision_rebuild_failed', 'failure', {
        clientId: client.id, error: err.message,
      });
      await sendWhatsApp(env.WH_PHONE,
        `⚠️ ASSET PROCESSING ISSUE: ${slug}\nError: ${err.message}`,
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
// VISION SYSTEM — extract brand signals, store to D1, queue rebuild
// ============================================================

async function runVisionAndRebuild(client, slug, r2Paths, files, env) {
  let brandBrief = '';

  if (await getFlag(env, 'VISION_VALIDATION_ENABLED')) {
    const visionImages = [];
    for (let i = 0; i < Math.min(files.length, 3); i++) {
      try {
        const bytes = await files[i].arrayBuffer();
        visionImages.push({
          base64:    uint8ArrayToBase64(new Uint8Array(bytes)),
          mediaType: files[i].type || 'image/jpeg',
          name:      files[i].name,
        });
      } catch (e) { console.warn(`Failed to read file for vision: ${files[i].name}`, e); }
    }

    if (visionImages.length > 0) {
      brandBrief = await extractBrandSignals(visionImages, slug, env);
      await logEvent(env, 'patch', 'vision_complete', 'success', { clientId: client.id });
    }
  }

  // Save each photo to D1 gallery_photos table
  for (const r2Path of r2Paths) {
    const url = r2Path.url || `https://${ASSETS_DOMAIN}/${r2Path.key}`;
    await addGalleryPhoto(env, client.id, r2Path.key, url, null).catch(() => {});
  }

  // If brand brief extracted, persist to voice_profile
  if (brandBrief && client.id) {
    const existingProfile = (() => {
      try { return JSON.parse(client.voice_profile || '{}'); } catch { return {}; }
    })();
    existingProfile.brand_analysis = brandBrief;
    await updateClient(env, client.id, {
      voice_profile: JSON.stringify(existingProfile),
    }).catch(() => {});
  }

  // Reset status if not already live (so rebuild is accepted)
  if (client.status !== 'live') {
    await updateClient(env, client.id, { status: 'lead' }).catch(() => {});
  }

  await env.BUILD_QUEUE.send({ type: 'pre_build', clientId: client.id, paymentId: null, isOutbound: false });

  await logEvent(env, 'patch', 'assets_processed', 'success', {
    clientId: client.id,
    metadata: { slug, fileCount: r2Paths.length, visionUsed: !!brandBrief },
  });

  await sendWhatsApp(env.WH_PHONE,
    `📸 ASSETS PROCESSED: ${slug}\n${r2Paths.length} file${r2Paths.length !== 1 ? 's' : ''} stored\nRebuild queued`,
    env, { skipTestRedirect: true },
  );
}

async function extractBrandSignals(images, slug, env) {
  const content = [{
    type: 'text',
    text: `Analyse these brand assets (logo and photos) for a South African small business. Extract:

1. PRIMARY COLOUR — most dominant brand colour (hex code)
2. SECONDARY COLOUR — supporting colour (hex code)
3. ACCENT COLOUR — highlight/pop colour (hex code)
4. TYPOGRAPHY FEEL — serif, sans-serif, script, geometric, bold/delicate?
5. BRAND PERSONALITY — 3 adjectives describing the visual tone
6. DESIGN DIRECTION — one sentence: what design style should the website use?
7. LOGO PRESENT — yes/no
8. PHOTO QUALITY — describe quality and style if photos are present

Be specific and practical. Format: "PRIMARY COLOUR: #hexcode"`,
  }];

  for (const img of images) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
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
// ============================================================

async function handleAssetProxy(request, env, path) {
  const r2Key = decodeURIComponent(path.replace(/^\/asset\//, ''));
  if (!r2Key || r2Key.includes('..')) return new Response('Not found', { status: 404 });

  try {
    const obj = await env.ASSETS.get(r2Key);
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, {
      headers: {
        'Content-Type':                obj.httpMetadata?.contentType || 'application/octet-stream',
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
// ROUTE: /gallery-assets/{slug} — returns D1 + R2 gallery URLs
// ============================================================

async function handleGalleryAssets(request, env, path) {
  if (request.method !== 'GET') return jsonResponse({ error: 'GET only' }, 405);

  const slug = path.replace('/gallery-assets/', '').split('/')[0].trim();
  if (!slug) return jsonResponse({ error: 'Missing slug' }, 400);

  try {
    // First try D1 gallery_photos table
    const client = await getClientBySlug(env, slug).catch(() => null);
    let urls = [];

    if (client?.id) {
      const d1Photos = await getGalleryPhotos(env, client.id).catch(() => []);
      urls = d1Photos.map(p => p.url);
    }

    // Fall back to R2 listing if D1 has no records (pre-migration photos)
    if (urls.length === 0) {
      const ownUrl = env.WORKER_URL_PATCH || '';
      const listed = await env.ASSETS.list({ prefix: `${slug}/gallery/` }).catch(() => ({ objects: [] }));
      urls = (listed.objects || [])
        .filter(obj => /\.(jpg|jpeg|png|webp|gif)$/i.test(obj.key))
        .map(obj => env.ASSETS_DOMAIN_READY === 'true'
          ? `https://${ASSETS_DOMAIN}/${obj.key}`
          : `${ownUrl}/asset/${obj.key}`);
    }

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
// ============================================================

async function handlePatchGallery(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY))
    return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { clientId, r2Paths } = body;
  if (!clientId || !r2Paths?.length) return jsonResponse({ error: 'Missing clientId or r2Paths' }, 400);

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  const slug   = client.slug    || slugify(client.business_name);
  const domain = (client.domain || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();

  // Save to D1
  for (const key of r2Paths) {
    const url = `https://${ASSETS_DOMAIN}/${key}`;
    await addGalleryPhoto(env, clientId, key, url, null).catch(() => {});
  }

  const patched = await patchGalleryInKV(slug, domain, r2Paths, env);
  await logEvent(env, 'patch', 'gallery_manual_patch', 'success', {
    clientId, metadata: { slug, count: r2Paths.length },
  });

  return jsonResponse({ success: patched, slug, domain, photosPatched: r2Paths.length });
}

async function patchGalleryInKV(slug, domain, r2Paths, env) {
  const ownUrl    = env.WORKER_URL_PATCH || '';
  const photoUrls = r2Paths.map(key =>
    env.ASSETS_DOMAIN_READY === 'true'
      ? `https://${ASSETS_DOMAIN}/${key}`
      : `${ownUrl}/asset/${key}`
  );

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
      continue;
    }

    await env.SITES.put(key, html);
    anyPatched = true;
  }

  return anyPatched;
}

// ============================================================
// ROUTE: /manage-panel — tier-gated manage panel data from D1
// Token lookup is now via D1 clients.manage_token (not KV).
// ============================================================

async function handleManagePanel(request, url, env) {
  const token = url.searchParams.get('token');
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);

  // D1 token lookup — replaces KV manage_token:* key
  const client = await getClientByToken(env, token).catch(() => null);
  if (!client) return jsonResponse({ error: 'Invalid or expired manage token' }, 404);

  const slug    = client.slug || slugify(client.business_name);
  const domain  = (client.domain || `${slug}.co.za`).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const pkg     = packageKey(client.package || 'standard');
  const tier    = PRICING[pkg];
  const caps    = PACKAGE_CAPS[pkg];

  // Revision count from D1 revisions table (this month)
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const revCountResult = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM revisions
     WHERE client_id = ? AND created_at >= ? AND type = 'free'`
  ).bind(client.id, monthStart.toISOString()).first().catch(() => ({ count: 0 }));

  const revisionsUsed  = revCountResult?.count || 0;
  const revisionsLimit = pkg === 'premium' ? null : pkg === 'express' ? 1 : 2;

  // Next invoice
  let daysUntilInvoice = null;
  if (client.next_invoice_date) {
    const diff = new Date(client.next_invoice_date).getTime() - Date.now();
    daysUntilInvoice = Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
  }

  // Referral block — D1 referrals table
  const referralFlag     = await getFlag(env, 'REFERRAL_ENABLED');
  const referralUnlocked = caps.referral && referralFlag;
  let referralBlock = null;
  if (referralUnlocked) {
    const refStats = await env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN status = 'vested' THEN 1 ELSE 0 END) as vested
       FROM referrals WHERE referrer_client_id = ?`
    ).bind(client.id).first().catch(() => ({ total: 0, vested: 0 }));

    referralBlock = {
      enabled:      true,
      link:         `https://websitehub.co.za?ref=${slug}`,
      sent:         refStats?.total || 0,
      conversions:  refStats?.vested || 0,
      rewardMonths: refStats?.vested || 0,
    };
  }

  // Analytics block
  const analyticsBlock = caps.analytics ? { enabled: true, slug } : null;

  // Gallery block — D1 gallery_photos count
  let galleryBlock = null;
  if (caps.gallery) {
    const photoCount = (await getGalleryPhotos(env, client.id).catch(() => [])).length;
    const planLimits = PLAN_PHOTO_LIMITS[pkg];
    galleryBlock = {
      enabled:   true,
      photoCount,
      maxPhotos: planLimits.maxPhotos,
      maxSizeMB: planLimits.maxSizeBytes / 1024 / 1024,
    };
  }

  // Email block
  const emailBlock = {
    included:       caps.emailAccounts,
    addonAvailable: caps.extraEmailAddon,
    addonCost:      caps.extraEmailAddon ? PRICING.addons.extraEmail : 0,
  };

  // Upgrade offers
  const upgradeOffers = [];
  if (pkg === 'express') {
    upgradeOffers.push({ to: 'standard', delta: PRICING.upgrade.expressToStandard });
    upgradeOffers.push({ to: 'premium',  delta: PRICING.upgrade.expressToPremium  });
  } else if (pkg === 'standard') {
    upgradeOffers.push({ to: 'premium',  delta: PRICING.upgrade.standardToPremium });
  }

  return jsonResponse({
    clientId:          client.id,
    businessName:      client.business_name,
    slug,
    domain,
    liveUrl:           `https://${domain}`,
    package:           pkg,
    status:            client.status,
    retainer:          tier.retainer,
    nextInvoiceDate:   client.next_invoice_date || null,
    daysUntilInvoice,
    pages:             caps.pages,
    revisions: {
      used:     revisionsUsed,
      limit:    revisionsLimit,
      paidCost: PRICING.addons.revision,
    },
    email:    emailBlock,
    gallery:  galleryBlock,
    referral: referralBlock,
    analytics: analyticsBlock,
    upgradeOffers,
  });
}

// ============================================================
// ROUTE: /submit-revision — free or paid revision flow
// ============================================================

async function handleSubmitRevision(request, env, ctx) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { token, palette, font, photo, tagline, specials } = body;
  if (!token) return jsonResponse({ error: 'Missing token' }, 400);

  // D1 token lookup
  const client = await getClientByToken(env, token).catch(() => null);
  if (!client) return jsonResponse({ error: 'Invalid manage token' }, 404);

  const pkg   = packageKey(client.package || 'standard');
  const slug  = client.slug || slugify(client.business_name);

  // Count free revisions used this month from D1
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const usedResult = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM revisions
     WHERE client_id = ? AND created_at >= ? AND type = 'free'`
  ).bind(client.id, monthStart.toISOString()).first().catch(() => ({ count: 0 }));

  const used       = usedResult?.count || 0;
  const freeLimit  = pkg === 'premium' ? Infinity : pkg === 'express' ? 1 : 2;
  const revPayload = { palette, font, photo, tagline, specials };

  if (used >= freeLimit) {
    // Store pending revision in KV (ephemeral — 2hr PayFast handshake token)
    const revToken = crypto.randomUUID().replace(/-/g, '');
    await env.SITES.put(`pending_revision:${revToken}`, JSON.stringify({
      clientId: client.id,
      payload:  revPayload,
      created:  new Date().toISOString(),
    }), { expirationTtl: PENDING_REVISION_TTL });

    const launchUrl = env.WORKER_URL_LAUNCH || '';
    const payLink   = buildPayFastLink(
      PRICING.addons.revision,
      `Website Hub Revision — ${client.business_name}`,
      client.id,
      env,
      {
        itemDesc:   'Additional revision request',
        customStr2: `revision:${revToken}`,
        notifyUrl:  launchUrl ? `${launchUrl}/payfast-webhook` : undefined,
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

  await processRevision(client, revPayload, env, { paid: false });

  return jsonResponse({
    success: true,
    used:    used + 1,
    limit:   freeLimit === Infinity ? null : freeLimit,
    message: `Got it! Your revision is in — we'll have it live within 10 minutes.`,
  });
}

async function processRevision(client, payload, env, opts = {}) {
  const { paid = false } = opts;
  const { palette, font, photo, tagline, specials } = payload;

  // Create revision record in D1
  const request    = [palette, font, photo, tagline, specials].filter(Boolean).join(' | ');
  const revisionId = await createRevision(env, client.id, paid ? 'paid' : 'free', request || 'SPA revision').catch(() => null);

  // Persist choices to D1
  const updates = {};
  if (palette) updates.palette = palette;
  if (Object.keys(updates).length) await updateClient(env, client.id, updates).catch(() => {});

  // Queue rebuild
  await env.BUILD_QUEUE.send({ type: 'pre_build', clientId: client.id, paymentId: null, isOutbound: false });

  // Notify client
  const name      = (client.client_name || '').split(' ')[0] || 'there';
  const freeLimit = packageKey(client.package) === 'premium' ? Infinity : packageKey(client.package) === 'express' ? 1 : 2;
  const paidLine  = paid ? `\nThanks for the payment — much appreciated!\n` : '';

  await sendWhatsApp(client.phone,
    `Got it ${name}! 👍 Your revision is in — we'll have it live within 10 minutes.${paidLine}\n— Website Hub`,
    env,
  );

  if (client.email) {
    await sendEmail({
      to: client.email,
      subject: paid
        ? `Revision payment confirmed — ${client.business_name}`
        : `Revision received — ${client.business_name}`,
      touchpoint: paid ? 'paid_revision_confirmed' : 'revision_submitted',
      clientSlug: client.slug,
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <h2 style="color:#111">${paid ? 'Revision payment confirmed 👍' : 'Revision received 👍'}</h2>
        <p>Hi ${name},</p>
        <p>Your revision for <strong>${client.business_name}</strong> is in — we'll have it live within 10 minutes.${paid ? ' Thank you for the payment!' : ''}</p>
        <p style="margin:24px 0"><a href="https://preview.websitehub.co.za/manage/${client.manage_token}" style="background:#111;color:#fff;padding:12px 24px;text-decoration:none;border-radius:4px;font-weight:bold">View My Preview</a></p>
        <p style="color:#888;font-size:12px">— Website Hub</p>
      </div>`,
    }, env).catch(() => {});
  }

  await sendWhatsApp(env.WH_PHONE,
    `✏️ REVISION${paid ? ` (PAID R${PRICING.addons.revision})` : ''}: ${client.business_name}\nClient: ${client.id}`,
    env, { skipTestRedirect: true },
  ).catch(() => {});

  // Log message
  await logMessage(env, client.id, paid ? 'paid_revision_link' : 'revision_submitted', 'whatsapp').catch(() => {});

  await logEvent(env, 'patch', 'revision_processed', 'success', {
    clientId: client.id,
    metadata: { paid, business: client.business_name },
  });

  // Mark revision complete
  if (revisionId) {
    await updateRevision(env, revisionId, { status: 'complete', completed_at: new Date().toISOString() }).catch(() => {});
  }
}

// ============================================================
// ROUTE: /apply-revision-payment
// Called by launch-worker after PayFast paid-revision ITN.
// ============================================================

async function handleApplyRevisionPayment(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);
  if (!constantTimeCompare(request.headers.get('x-admin-key'), env.ADMIN_KEY))
    return jsonResponse({ error: 'Unauthorized' }, 401);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { revisionToken } = body;
  if (!revisionToken) return jsonResponse({ error: 'Missing revisionToken' }, 400);

  const raw = await env.SITES.get(`pending_revision:${revisionToken}`);
  if (!raw) return jsonResponse({ success: true, already_processed: true });

  const pending   = JSON.parse(raw);
  const { clientId, payload } = pending;

  const client = await getClientById(env, clientId).catch(() => null);
  if (!client) return jsonResponse({ error: 'Client not found' }, 404);

  try {
    await processRevision(client, payload, env, { paid: true });
    await env.SITES.delete(`pending_revision:${revisionToken}`);
    return jsonResponse({ success: true, clientId });
  } catch (err) {
    console.error('Paid revision processing failed:', err);
    await logEvent(env, 'patch', 'paid_revision_failed', 'failure', {
      clientId, error: err.message, metadata: { revisionToken },
    });
    return jsonResponse({ error: err.message }, 500);
  }
}

// ============================================================
// EMAIL HANDLER — incoming gallery photo updates
// Subject: "wh-{slug}" → looks up client in D1 by slug
// Attachments → R2 + D1 gallery_photos table
// ============================================================

async function handleIncomingEmail(message, env) {
  const subject = message.headers.get('subject') || '';
  const from    = message.headers.get('from')    || '';

  const slugMatch = subject.match(/wh-([a-z0-9-]+)/i) || subject.match(/([a-z0-9-]{3,50})/i);
  if (!slugMatch) {
    await logEvent(env, 'patch', 'email_unroutable', 'warning', { metadata: { subject, from } });
    message.setReject('No valid site slug in subject line. Format: wh-your-business-name');
    return;
  }

  const slug = slugMatch[1].toLowerCase().replace(/[^a-z0-9-]/g, '-');

  // D1 lookup by slug — replaces listAirtableRecords
  const client = await getClientBySlug(env, slug).catch(() => null);

  if (!client) {
    await logEvent(env, 'patch', 'email_unknown_slug', 'warning', { metadata: { slug, from } });
    message.forward('loc10@live.co.za');
    return;
  }

  const status      = client.status || '';
  const clientPhone = client.phone  || '';
  const bizName     = client.business_name || slug;
  const pkg         = packageKey(client.package || 'standard');
  const limits      = PLAN_PHOTO_LIMITS[pkg];

  // Express has no gallery
  if (limits.maxPhotos === 0) {
    if (clientPhone) {
      await queueScheduledMessage(client.id, clientPhone,
        `Hi! We received your photos for *${bizName}*, but the Express plan doesn't include a photo gallery.\n\nUpgrade to Standard or Premium to add a gallery. Reply UPGRADE for details.\n\n— Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await logEvent(env, 'patch', 'email_express_no_gallery', 'warning', { clientId: client.id });
    return;
  }

  const existingPhotos = await getGalleryPhotos(env, client.id).catch(() => []);
  const slotsRemaining = limits.maxPhotos - existingPhotos.length;

  if (slotsRemaining <= 0) {
    if (clientPhone) {
      await queueScheduledMessage(client.id, clientPhone,
        `Hi! We received your photos for *${bizName}*, but your ${pkg} plan gallery is full (${limits.maxPhotos} photos max).\n\n` +
        (pkg === 'standard' ? `Upgrade to Premium for up to 30 photos. Reply UPGRADE for details.` : `Please ask us to remove some existing photos first.`) +
        `\n\n— Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await logEvent(env, 'patch', 'email_limit_reached', 'warning', { clientId: client.id, metadata: { pkg } });
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
        console.warn(`Photo too large for ${pkg} plan: ${att.data.byteLength} bytes`);
        continue;
      }

      const ext   = att.contentType.includes('png') ? 'png' : att.contentType.includes('webp') ? 'webp' : 'jpg';
      const r2Key = `${slug}/gallery/photo_${Date.now()}_${i}.${ext}`;

      await env.ASSETS.put(r2Key, att.data, {
        httpMetadata:   { contentType: att.contentType },
        customMetadata: { slug, source: 'email', uploadedAt: new Date().toISOString() },
      });

      const photoUrl = `https://${ASSETS_DOMAIN}/${r2Key}`;
      r2Paths.push(r2Key);

      // Save to D1 gallery_photos
      await addGalleryPhoto(env, client.id, r2Key, photoUrl, null).catch(() => {});
      photoCount++;
    }

    await logEvent(env, 'patch', 'email_photos_uploaded', 'success', {
      clientId: client.id, metadata: { count: photoCount, slug },
    });
  } catch (e) {
    console.error('MIME parsing/R2 failed:', e);
    await logEvent(env, 'patch', 'email_photo_error', 'failure', { clientId: client.id, error: e.message });
  }

  if (photoCount === 0) {
    if (clientPhone) {
      await queueScheduledMessage(client.id, clientPhone,
        `Hi! We received your email for *${bizName}* but couldn't find any valid photo attachments (JPG, PNG, or WEBP under ${limits.maxSizeBytes / 1024 / 1024}MB).\n\nPlease try again with your photos attached. — Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await logEvent(env, 'patch', 'email_no_photos', 'warning', { clientId: client.id, metadata: { from } });
    return;
  }

  if (status === 'live') {
    const domain = (client.domain || `${slug}.co.za`)
      .replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    await patchGalleryInKV(slug, domain, r2Paths, env);

    if (clientPhone) {
      await queueScheduledMessage(client.id, clientPhone,
        `📸 Got your photos! We've added *${photoCount} photo${photoCount > 1 ? 's' : ''}* to your *${bizName}* gallery.\n\n✅ Your site is updated: https://${domain}\n\n— Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await sendWhatsApp(env.WH_PHONE,
      `📸 GALLERY UPDATED: ${bizName} (${slug})\n${photoCount} photos added via email\nSite: https://${domain}`,
      env, { skipTestRedirect: true },
    );
    await logEvent(env, 'patch', 'gallery_updated', 'success', {
      clientId: client.id, metadata: { slug, count: photoCount, source: 'email' },
    });
  } else {
    // Not live — reset to lead and queue rebuild
    await updateClient(env, client.id, { status: 'lead' }).catch(() => {});
    await env.BUILD_QUEUE.send({ type: 'pre_build', clientId: client.id, paymentId: null, isOutbound: false });

    if (clientPhone) {
      await queueScheduledMessage(client.id, clientPhone,
        `📸 Got your photos! We're updating your *${bizName}* website with them now. You'll have an updated preview link in about 10 minutes. ⚡\n\n— Website Hub`,
        env, { respectDayOfWeek: false },
      );
    }
    await sendWhatsApp(env.WH_PHONE,
      `📸 PHOTOS RECEIVED (PRE-LIVE): ${bizName} (${slug})\n${photoCount} photos — rebuild queued`,
      env, { skipTestRedirect: true },
    );
    await logEvent(env, 'patch', 'email_rebuild_triggered', 'success', {
      clientId: client.id, metadata: { slug, count: photoCount, status },
    });
  }

  await logMessage(env, client.id, 'gallery_added', 'email').catch(() => {});
}

// ============================================================
// MIME PARSING — extract image attachments from raw email bytes
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
      } catch (e) { console.warn('Base64 decode failed:', e); continue; }
    } else if (encoding === 'quoted-printable') {
      const decoded = bodySection
        .replace(/=\r\n/g, '').replace(/=\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
      data = new TextEncoder().encode(decoded);
    } else {
      data = new TextEncoder().encode(bodySection);
    }

    if (data && data.length > 1024) attachments.push({ contentType, data });
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
