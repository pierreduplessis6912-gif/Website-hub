// ── TENDER LOGIX v2 ───────────────────────────────────────────────────────
// Separated tender entity from product runs. Three genuinely independent
// products (gonogo/pricing/bidpack), none gating any other, each with its
// own one-time free trial per company. Upload is its own free-trial product
// too (first tender, up to 5 docs, free).
//
// PRICING:
//   Upload:   R20/doc — first tender free, capped at 5 docs
//   Go/No-Go: R100/run — first run free
//   Pricing:  R750/run — first run free
//   Bid Pack: R2,500/run — first run free
//
// All four free trials are independent, one-time, per company, lifetime.

import { generateProductRunDocx } from './tl-docx.js';
import { checkVaultSubscription } from './tl-handler.js';
import { requireTlAuth } from './tl-auth.js';

const V2_PRICES = { gonogo: 100, pricing: 750, bidpack: 750 };
// NOTE: 'pricing' as a standalone purchasable product is being retired from
// the UI — its content (BOQ, competitive landscape) is now fully absorbed
// into 'bidpack', which dropped from R2,500 to R750 to match. The pricing
// constant and internal product type are kept (not deleted) since the v1
// dashboard and any existing in-flight 'pricing' runs still reference it.
const UPLOAD_PRICE_PER_DOC = 20;
const FREE_UPLOAD_MAX_DOCS = 5;

export async function handleTlV2(request, env) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
  if (method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  function tlJson(data, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  // ── AUTH MIDDLEWARE — all v2 routes require valid session ──────────
  const authError = await requireTlAuth(request, env);
  if (authError) return authError;

  // ── Self-declared documents ──────────────────────────────────────────
  if (path === '/tl/v2/company/self-declared' && method === 'GET') {
    const companyId = url.searchParams.get('company_id');
    if (!companyId) return tlJson({ error: 'company_id required' }, 400);
    const row = await env.TL_DB.prepare('SELECT self_declared_docs FROM tl_companies WHERE id=? LIMIT 1').bind(companyId).first();
    const selfDeclared = row?.self_declared_docs ? JSON.parse(row.self_declared_docs) : {};
    return tlJson({ self_declared: selfDeclared });
  }
  if (path === '/tl/v2/company/self-declared' && method === 'POST') {
    const body = await request.json();
    const { company_id, self_declared } = body;
    if (!company_id) return tlJson({ error: 'company_id required' }, 400);
    await env.TL_DB.prepare('UPDATE tl_companies SET self_declared_docs=? WHERE id=?')
      .bind(JSON.stringify(self_declared || {}), company_id).run();
    return tlJson({ success: true });
  }

  if (path === '/tl/v2/tender/upload' && method === 'POST') return handleTenderUpload(request, env, tlJson);
  if (path === '/tl/v2/tender' && method === 'GET') return handleGetTender(url, env, tlJson);
  if (path === '/tl/v2/tenders' && method === 'GET') return handleListTenders(url, env, tlJson);

  if (path === '/tl/v2/product/run' && method === 'POST') return handleRunProduct(request, env, tlJson);
  if (path === '/tl/v2/product-run' && method === 'GET') return handleGetProductRun(url, env, tlJson);
  if (path === '/tl/v2/product-run/download' && method === 'GET') return handleDownloadProductRun(url, env);

  if (path === '/tl/v2/free-trials' && method === 'GET') return handleGetFreeTrials(url, env, tlJson);

  if (path === '/tl/v2/directors' && method === 'GET') return handleListDirectors(url, env, tlJson);
  if (path === '/tl/v2/directors' && method === 'POST') return handleSaveDirector(request, env, tlJson);
  if (path === '/tl/v2/directors' && method === 'DELETE') return handleDeleteDirector(request, env, tlJson);
  if (path === '/tl/v2/company/details' && method === 'POST') return handleUpdateCompanyDetails(request, env, tlJson);

  return tlJson({ error: 'Not found' }, 404);
}

// ── Helper — reused from v1 ──────────────────────────────────────────────
function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── Helper — has this company used a given free trial already? ──────────
async function hasUsedFreeTrial(env, company_id, product) {
  const row = await env.TL_DB.prepare(
    'SELECT id FROM tl_free_trials_used WHERE company_id=? AND product=? LIMIT 1'
  ).bind(company_id, product).first();
  return !!row;
}

async function markFreeTrialUsed(env, company_id, product, product_run_id) {
  await env.TL_DB.prepare(
    `INSERT OR IGNORE INTO tl_free_trials_used (id, company_id, product, product_run_id) VALUES (?,?,?,?)`
  ).bind(crypto.randomUUID(), company_id, product, product_run_id || null).run();
}

// ── Same reference gate check as v1 — verbatim, multi-doc only ──────────
async function checkReferenceGate(pdfDocs, tender_ref, env) {
  if (pdfDocs.length <= 1 || !tender_ref) {
    return { passed: true, mismatched: [] };
  }

  const prompt = `You are checking whether a set of PDF documents all belong to the same tender, identified by reference "${tender_ref}".

For EACH document attached (in the order given), answer:
- Does the reference "${tender_ref}" appear anywhere in this document? (yes/no)
- If no, does the document contain a DIFFERENT tender/RFQ reference number? If so, what is it?
- If no reference appears at all, does this look like a standard supporting annexure (drawing, photo, spreadsheet export, generic form) where an absent reference is normal and not a concern?

Return ONLY this JSON, one entry per document in the same order they were attached:
{
  "documents": [
    { "filename_guess": "string", "reference_found": true, "different_reference_found": "string or null", "likely_annexure": true, "concern_level": "NONE or LOW or HIGH" }
  ]
}

Return ONLY valid JSON, no markdown, no explanation.`;

  const userContent = [
    ...pdfDocs.map(d => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } })),
    { type: 'text', text: prompt },
  ];

  try {
    const aiRes = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.KIMI_KEY },
      body: JSON.stringify({ model: 'kimi-k2.5', max_tokens: 1024, messages: [{ role: 'user', content: userContent }] }),
    });
    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '{}';
    const result = JSON.parse(rawText.replace(/```json|```/g, '').trim());

    const mismatched = [];
    (result.documents || []).forEach((doc, i) => {
      if (doc.concern_level === 'HIGH') {
        mismatched.push({
          filename: pdfDocs[i]?.filename || `document ${i+1}`,
          reason: doc.different_reference_found
            ? `appears to belong to a different tender (found reference "${doc.different_reference_found}")`
            : `reference "${tender_ref}" not found`,
        });
      }
    });

    return { passed: mismatched.length === 0, mismatched };
  } catch(e) {
    console.warn('TL v2 — reference gate check failed, allowing through:', e.message);
    return { passed: true, mismatched: [] };
  }
}

// ── TENDER UPLOAD — R20/doc, first tender free up to 5 docs ─────────────
// Pure data acquisition. No analysis triggered. Creates a tl_tenders row.
async function handleTenderUpload(request, env, tlJson) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return tlJson({ error: 'multipart/form-data required' }, 400);
  }

  const form = await request.formData();
  const company_id = form.get('company_id');
  const tender_ref  = form.get('tender_ref') || null;
  const overrideGate = form.get('override_gate') === 'true';
  const files = form.getAll('files');

  if (!company_id || !files.length) return tlJson({ error: 'company_id and at least one file required' }, 400);
  if (files.length > 1 && !tender_ref) {
    return tlJson({ error: 'Tender reference is required when uploading more than one document' }, 400);
  }

  for (const f of files) {
    if (f.type !== 'application/pdf') return tlJson({ error: `"${f.name}" is not a PDF. Only PDF files are supported.` }, 400);
    if (f.size > 32 * 1024 * 1024) return tlJson({ error: `"${f.name}" is over 32MB.` }, 400);
  }

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  // ── Determine pricing: free trial vs paid ──
  const uploadTrialUsed = await hasUsedFreeTrial(env, company_id, 'upload');
  let isFreeTrial = false;
  let price = UPLOAD_PRICE_PER_DOC * files.length;

  if (!uploadTrialUsed && files.length <= FREE_UPLOAD_MAX_DOCS) {
    isFreeTrial = true;
    price = 0;
  }

  if (!isFreeTrial && (company.balance || 0) < price) {
    const shortfall = price - (company.balance || 0);
    return tlJson({ error: `This costs R${price} (${files.length} document${files.length>1?'s':''} × R20) — you have R${company.balance||0}. Top up R${shortfall} to continue.`, shortfall }, 402);
  }

  // Read all files into base64 once — reused for gate check and storage
  const pdfDocs = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    pdfDocs.push({ base64: arrayBufferToBase64(buf), filename: f.name, buffer: buf });
  }

  if (!overrideGate) {
    const gateResult = await checkReferenceGate(pdfDocs, tender_ref, env);
    if (!gateResult.passed) {
      return tlJson({
        error: 'Some documents do not appear to match the tender reference provided.',
        gate_failed: true,
        mismatched_files: gateResult.mismatched.map(m => m.filename),
        gate_message: gateResult.mismatched.map(m => `"${m.filename}" — ${m.reason}`).join('; '),
      }, 409);
    }
  }

  const id = crypto.randomUUID();
  const docKeys = [];

  try {
    // ── Step 1: Upload to R2 ─────────────────────────────────────────────
    for (let i = 0; i < pdfDocs.length; i++) {
      const docKey = `tenders/${company_id}/${id}/doc-${i}-${pdfDocs[i].filename.replace(/[^a-zA-Z0-9.\-]/g, '_')}`;
      await env.TL_DOCS.put(docKey, pdfDocs[i].buffer, { httpMetadata: { contentType: 'application/pdf' } });
      docKeys.push(docKey);
    }

    // ── Step 2: Insert tender record to D1 BEFORE charging ───────────────
    // If this fails, user is not charged and no orphaned R2 file creates confusion
    await env.TL_DB.prepare(`
      INSERT INTO tl_tenders (id, company_id, tender_ref, doc_r2_keys, document_count, amount_paid)
      VALUES (?,?,?,?,?,?)
    `).bind(id, company_id, tender_ref, JSON.stringify(docKeys), files.length, isFreeTrial ? 0 : price).run();

    // ── Step 3: Charge only after D1 record confirmed ────────────────────
    if (!isFreeTrial && price > 0) {
      await env.TL_DB.prepare('UPDATE tl_companies SET balance=balance-? WHERE id=?').bind(price, company_id).run();
      await env.TL_DB.prepare(`INSERT INTO tl_credits (id, company_id, amount, type) VALUES (?,?,?,'used')`)
        .bind(crypto.randomUUID(), company_id, -price).run();
    }

    // ── Step 4: Mark free trial used ─────────────────────────────────────
    if (isFreeTrial) {
      await markFreeTrialUsed(env, company_id, 'upload', id);
    }

    return tlJson({ success: true, tender_id: id, document_count: files.length, charged: isFreeTrial ? 0 : price, was_free_trial: isFreeTrial });

  } catch(uploadErr) {
    console.error('TL upload error:', uploadErr.message, 'company:', company_id, 'tender:', id);
    return tlJson({ error: 'Upload failed — ' + uploadErr.message + '. You have not been charged.' }, 500);
  }
}

// ── GET a single tender + all its product runs ───────────────────────────
async function handleGetTender(url, env, tlJson) {
  const id = url.searchParams.get('id');
  if (!id) return tlJson({ error: 'id required' }, 400);

  const tender = await env.TL_DB.prepare('SELECT * FROM tl_tenders WHERE id=? LIMIT 1').bind(id).first();
  if (!tender) return tlJson({ error: 'Tender not found' }, 404);

  const runs = await env.TL_DB.prepare(
    'SELECT id, product, status, is_free_trial, amount_paid, verdict, created_at, updated_at FROM tl_product_runs WHERE tender_id=? ORDER BY created_at DESC'
  ).bind(id).all();

  return tlJson({ ...tender, product_runs: runs.results || [] });
}

// ── LIST all tenders for a company, each with their product run summary ──
async function handleListTenders(url, env, tlJson) {
  const company_id = url.searchParams.get('company_id');
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);

  const tenders = await env.TL_DB.prepare(
    'SELECT * FROM tl_tenders WHERE company_id=? ORDER BY created_at DESC LIMIT 30'
  ).bind(company_id).all();

  const tenderList = tenders.results || [];
  for (const t of tenderList) {
    const runs = await env.TL_DB.prepare(
      'SELECT id, product, status, verdict FROM tl_product_runs WHERE tender_id=? ORDER BY created_at DESC'
    ).bind(t.id).all();
    t.product_runs = runs.results || [];
  }

  return tlJson({ tenders: tenderList });
}

// ── GET free trial availability for a company — drives dashboard button states ──
async function handleGetFreeTrials(url, env, tlJson) {
  const company_id = url.searchParams.get('company_id');
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);

  const used = await env.TL_DB.prepare(
    'SELECT product FROM tl_free_trials_used WHERE company_id=?'
  ).bind(company_id).all();

  const usedSet = new Set((used.results || []).map(r => r.product));
  const allProducts = ['upload', 'gonogo', 'pricing', 'bidpack'];
  const availability = {};
  allProducts.forEach(p => { availability[p] = !usedSet.has(p); });

  return tlJson({ company_id, free_trials_available: availability });
}

// ── DIRECTORS — list/add/edit/delete ──────────────────────────────────────
// Closes the real gap that left MBD 4, MBD 15, and MBD 7.2 mostly blank:
// director name, ID number, tax number, residential address.
async function handleListDirectors(url, env, tlJson) {
  const company_id = url.searchParams.get('company_id');
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);

  const directors = await env.TL_DB.prepare(
    'SELECT * FROM tl_company_directors WHERE company_id=? ORDER BY display_order, created_at'
  ).bind(company_id).all();

  return tlJson({ company_id, directors: directors.results || [] });
}

async function handleSaveDirector(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id, id, full_name, id_number, tax_number, residential_address, is_state_employee } = body;

  if (!company_id || !full_name) return tlJson({ error: 'company_id and full_name required' }, 400);

  const company = await env.TL_DB.prepare('SELECT id FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  if (id) {
    // Editing an existing director — verify it belongs to this company first
    const existing = await env.TL_DB.prepare('SELECT id FROM tl_company_directors WHERE id=? AND company_id=? LIMIT 1').bind(id, company_id).first();
    if (!existing) return tlJson({ error: 'Director not found for this company' }, 404);

    await env.TL_DB.prepare(`
      UPDATE tl_company_directors SET full_name=?, id_number=?, tax_number=?, residential_address=?, is_state_employee=? WHERE id=?
    `).bind(full_name, id_number || null, tax_number || null, residential_address || null, is_state_employee ? 1 : 0, id).run();

    return tlJson({ success: true, director_id: id, updated: true });
  }

  const newId = crypto.randomUUID();
  const countRow = await env.TL_DB.prepare('SELECT COUNT(*) as cnt FROM tl_company_directors WHERE company_id=?').bind(company_id).first();
  await env.TL_DB.prepare(`
    INSERT INTO tl_company_directors (id, company_id, full_name, id_number, tax_number, residential_address, is_state_employee, display_order)
    VALUES (?,?,?,?,?,?,?,?)
  `).bind(newId, company_id, full_name, id_number || null, tax_number || null, residential_address || null, is_state_employee ? 1 : 0, countRow?.cnt || 0).run();

  return tlJson({ success: true, director_id: newId, created: true });
}

async function handleDeleteDirector(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id, id } = body;
  if (!company_id || !id) return tlJson({ error: 'company_id and id required' }, 400);

  const existing = await env.TL_DB.prepare('SELECT id FROM tl_company_directors WHERE id=? AND company_id=? LIMIT 1').bind(id, company_id).first();
  if (!existing) return tlJson({ error: 'Director not found for this company' }, 404);

  await env.TL_DB.prepare('DELETE FROM tl_company_directors WHERE id=?').bind(id).run();
  return tlJson({ success: true, deleted: id });
}

// ── COMPANY DETAILS — address, tax ref, VAT, municipal account ───────────
// Separate, focused endpoint from the existing /tl/company/update (v1) so
// v2 can evolve its own profile fields independently.
async function handleUpdateCompanyDetails(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id, street_address, postal_address, city, postal_code, tax_reference_number, vat_number, municipal_account_number } = body;
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);

  const existing = await env.TL_DB.prepare('SELECT id FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!existing) return tlJson({ error: 'Company not found' }, 404);

  await env.TL_DB.prepare(`
    UPDATE tl_companies SET
      street_address=COALESCE(?, street_address),
      postal_address=COALESCE(?, postal_address),
      city=COALESCE(?, city),
      postal_code=COALESCE(?, postal_code),
      tax_reference_number=COALESCE(?, tax_reference_number),
      vat_number=COALESCE(?, vat_number),
      municipal_account_number=COALESCE(?, municipal_account_number)
    WHERE id=?
  `).bind(street_address, postal_address, city, postal_code, tax_reference_number, vat_number, municipal_account_number, company_id).run();

  return tlJson({ success: true, company_id });
}

// ── RUN A PRODUCT — gonogo/pricing/bidpack, fully independent, charge-after-success via queue ──
async function handleRunProduct(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { tender_id, product } = body;

  if (!tender_id || !product) return tlJson({ error: 'tender_id and product required' }, 400);
  if (!V2_PRICES[product]) return tlJson({ error: 'product must be gonogo, pricing, or bidpack' }, 400);

  const tender = await env.TL_DB.prepare('SELECT * FROM tl_tenders WHERE id=? LIMIT 1').bind(tender_id).first();
  if (!tender) return tlJson({ error: 'Tender not found' }, 404);

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(tender.company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  const trialUsed = await hasUsedFreeTrial(env, tender.company_id, product);
  const isFreeTrial = !trialUsed;
  const price = isFreeTrial ? 0 : V2_PRICES[product];

  if (!isFreeTrial && (company.balance || 0) < price) {
    const shortfall = price - (company.balance || 0);
    return tlJson({ error: `${product} costs R${price} — you have R${company.balance||0}. Top up R${shortfall} to continue.`, shortfall }, 402);
  }

  const id = crypto.randomUUID();
  // ── 4. QUEUE SERIALISATION — check BEFORE insert ────────────────────
  const activeRun = await env.TL_DB.prepare(
    `SELECT id FROM tl_product_runs WHERE company_id=? AND status IN ('queued','processing') LIMIT 1`
  ).bind(tender.company_id).first().catch(() => null);

  if (activeRun) {
    return tlJson({ error: 'Another analysis is already running. Please wait for it to complete before starting a new one.', retry_after_seconds: 60 }, 429);
  }

  await env.TL_DB.prepare(`
    INSERT INTO tl_product_runs (id, tender_id, company_id, product, status, is_free_trial, amount_paid)
    VALUES (?,?,?,?,'queued',?,0)
  `).bind(id, tender_id, tender.company_id, product, isFreeTrial ? 1 : 0).run();

  // Analysis runs in the background queue — same proven pattern as v1.
  // Charging (if not a free trial) happens inside the queue consumer, AFTER
  // a genuine, valid result is confirmed — never before.
  await env.BUILD_QUEUE.send({
    type: 'tl_v2_run',
    productRunId: id,
    tenderId: tender_id,
    companyId: tender.company_id,
    product,
    chargeAmount: price,
    isFreeTrial,
  });

  return tlJson({ success: true, product_run_id: id, status: 'queued', is_free_trial: isFreeTrial, price });
}

// ── GET a single product run's status/report ──────────────────────────────
async function handleGetProductRun(url, env, tlJson) {
  const id = url.searchParams.get('id');
  if (!id) return tlJson({ error: 'id required' }, 400);

  const run = await env.TL_DB.prepare('SELECT * FROM tl_product_runs WHERE id=? LIMIT 1').bind(id).first();
  if (!run) return tlJson({ error: 'Product run not found' }, 404);
  if (run.report_json) run.report = JSON.parse(run.report_json);

  return tlJson(run);
}

// ── DOWNLOAD a product run as a real, editable .docx ──────────────────────
async function handleDownloadProductRun(url, env) {
  const id = url.searchParams.get('id');
  if (!id) return new Response(JSON.stringify({ error: 'id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  const run = await env.TL_DB.prepare('SELECT * FROM tl_product_runs WHERE id=? LIMIT 1').bind(id).first();
  if (!run) return new Response(JSON.stringify({ error: 'Product run not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  if (run.status !== 'complete' || !run.report_json) {
    return new Response(JSON.stringify({ error: 'This report is not ready yet' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(run.company_id).first();
  const report = JSON.parse(run.report_json);

  // Phase 2 — real verified compliance documents, only relevant for the
  // bidpack tier's submission pack (others don't show this section at all).
  // GATED behind Document Vault — non-subscribers get an upsell note
  // instead of an empty/broken-looking section. Directors/address data is
  // NOT gated — that's free, since it's just pre-filling forms with data
  // the company entered themselves, not custody of verified documents.
  let complianceDocuments = [];
  let directors = [];
  let hasVaultAccess = false;
  if (run.product === 'bidpack') {
    hasVaultAccess = await checkVaultSubscription(env, run.company_id);
    if (hasVaultAccess) {
      const docsResult = await env.TL_DB.prepare(`
        SELECT cd.*, dt.name as doc_name FROM tl_compliance_documents cd
        JOIN tl_doc_types dt ON cd.doc_type_id = dt.id
        WHERE cd.company_id = ?
        ORDER BY dt.name
      `).bind(run.company_id).all();
      complianceDocuments = docsResult.results || [];
    }

    const directorsResult = await env.TL_DB.prepare(
      'SELECT * FROM tl_company_directors WHERE company_id=? ORDER BY display_order, created_at'
    ).bind(run.company_id).all();
    directors = directorsResult.results || [];
  }

  try {
    const arrayBuffer = await generateProductRunDocx(run, report, company, complianceDocuments, directors, hasVaultAccess);
    const safeTitle = (report.tender_title || 'TenderLogix-Report').replace(/[^a-zA-Z0-9 \-]/g, '').slice(0, 60).trim() || 'TenderLogix-Report';
    const productLabel = run.product === 'gonogo' ? 'GoNoGo' : run.product === 'pricing' ? 'Pricing' : 'BidPack';

    return new Response(arrayBuffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="${safeTitle} - ${productLabel}.docx"`,
      },
    });
  } catch(e) {
    console.error('TL v2 download — docx generation failed:', e.message, 'run:', id);
    return new Response(JSON.stringify({ error: 'Could not generate document: ' + e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}

async function runV2Product(productRunId, company, pdfDocs, product, env, useTwoPass = false) {
  try {
    const companyContext = await buildCompanyContext(company, env);

    // ── PRICING ORACLE ────────────────────────────────────────────────────────
    let pricingContext = '';
    try {
      const industries = JSON.parse(company.industries || '[]');
      const provinces = JSON.parse(company.provinces || '[]');
      const tenderTitle = tender.title || '';
      const titleLower = tenderTitle.toLowerCase();

      const SECTOR_MAP = [
        ['clean', 'cleaning'],
        ['civil', 'civil_engineering'], ['construction', 'civil_engineering'], ['infrastructure', 'civil_engineering'],
        ['electrical', 'electrical'], ['electric', 'electrical'],
        ['security', 'security'],
        ['metal', 'metal_engineering'], ['steel', 'metal_engineering'], ['engineering', 'metal_engineering'],
        ['motor', 'motor'], ['automotive', 'motor'],
        ['logistic', 'road_freight'], ['transport', 'road_freight'], ['freight', 'road_freight'],
      ];

      const detectedSectors = [];
      const allText = (industries.join(' ') + ' ' + titleLower).toLowerCase();
      for (const [keyword, sector] of SECTOR_MAP) {
        if (allText.includes(keyword) && !detectedSectors.includes(sector)) {
          detectedSectors.push(sector);
        }
      }

      // Map province codes to oracle province keys
      const PROVINCE_MAP = { 'GP': 'national', 'WC': 'Area_A_Metros', 'EC': 'national', 'KZN': 'KZN', 'LP': 'national', 'MP': 'national', 'NW': 'national', 'NC': 'national', 'FS': 'national' };
      const rawProvince = provinces[0] || 'national';
      const province = PROVINCE_MAP[rawProvince] || rawProvince;
      const oracleBase = env.PRICING_ORACLE_URL || 'https://pricing-oracle.websitehub.co.za';
      const oracleLines = [];
      console.log('TL oracle — province:', rawProvince, '->', province, 'sectors:', detectedSectors.join(','));

      for (const sector of detectedSectors.slice(0, 3)) {
        try {
          // Try province-specific first, then national
          const provincesToTry = province !== 'national' ? [province, 'national'] : ['national'];
          let oData = null;
          for (const p of provincesToTry) {
            const oRes = await fetch(oracleBase + '/pricing-oracle?sector=' + sector + '&province=' + p, {
              headers: { 'Accept': 'application/json' }
            });
            if (oRes.ok) {
              const data = await oRes.json();
              if (data.found && data.rates && data.rates.length > 0) { oData = data; break; }
            }
          }
          if (oData) {
            const rt = oData.rates[0];
            oracleLines.push('Sector: ' + sector + ' | Council: ' + rt.council_name + ' | Gazette: ' + (rt.gazette_ref || 'N/A') + ' | Effective: ' + rt.effective_date);
            if (rt.base_rate) oracleLines.push('  Base rate: R' + rt.base_rate + '/' + (rt.rate_unit || 'hour'));
            if (rt.oncost_pct) oracleLines.push('  On-costs: +' + rt.oncost_pct + '% (' + (rt.oncost_components || 'UIF, COIDA, leave, provident') + ')');
            if (rt.total_rate) oracleLines.push('  Total cost (base + on-costs): R' + rt.total_rate + '/' + (rt.rate_unit || 'hour'));
          }
        } catch(oErr) {
          console.warn('TL oracle fetch failed for sector', sector, oErr.message);
        }
      }

      // Always include NMW floor
      try {
        const nmwRes = await fetch(oracleBase + '/pricing-oracle?sector=national_minimum_wage', { });
        if (nmwRes.ok) {
          const nmw = await nmwRes.json();
          if (nmw.found && nmw.rates && nmw.rates[0]) {
            oracleLines.push('NMW Floor: R' + nmw.rates[0].base_rate + '/hour effective ' + nmw.rates[0].effective_date + ' (' + nmw.rates[0].gazette_ref + ')');
          }
        }
      } catch(nmwErr) {}

      if (oracleLines.length > 0) {
        pricingContext = '\nLIVE PRICING ORACLE DATA (fetched from statutory sources today):\n' + oracleLines.join('\n') + '\n';
        console.log('TL oracle — injected rates for sectors:', detectedSectors.join(', '), 'lines:', oracleLines.length);
      } else {
        console.log('TL oracle — no rates found. Detected sectors:', detectedSectors.join(', '), 'province:', province);
      }
    } catch(oracleErr) {
      console.warn('TL oracle — failed:', oracleErr.message);
    }

        let prompt, schema, maxTokens;

     if (product === 'gonogo') {
      maxTokens = 8192;
      prompt = `You are a South African tender bid decision intelligence system. Your job is not to tell the client what to do — it is to make the hidden cost of each option visible before they commit. Think like a GPS: precise about what you know, honest about uncertainty, directional without being authoritarian.

YOUR OUTPUT HAS THREE DISTINCT LAYERS — keep them completely separate, never blend them:

LAYER 1 — FACTS (what exists in the document and verified company data only)
Extract requirements directly from the tender document and cross-reference against the company profile. Mark each item: VERIFIED (from uploaded certificate), SELF_REPORTED (stated in profile but not confirmed), MISSING (not in profile at all), or EXPIRED (certificate on file is expired). No interpretation — only what is demonstrably true.

LAYER 2 — RISK ASSESSMENT (probability + reasoning + confidence)
Score each risk with a likelihood AND your reasoning. Be explicit about uncertainty. A 35% complete company profile means LOW confidence — state this. Estimate disqualification probability and functionality scores where possible. Distinguish hard disqualifiers (missing mandatory cert) from soft risks (pricing outside typical range).

LAYER 3 — RECOMMENDATION (directional, not declarative)
Never write DO NOT SUBMIT or AUTOMATIC DISQUALIFICATION. Write: Not recommended in current state — high disqualification risk due to X. Or: Recommended if Y is resolved before closing date. Always include what would change the recommendation.

VERDICT VALUES: GO (well-positioned, no hard blockers), CONDITIONAL_GO (viable but actions required), NO_GO (hard blocker or unfavourable risk/effort — always explain what would change this).

PROFILE COMPLETENESS: Estimate what percentage of meaningful profile fields are populated. State this explicitly. Low completeness means low confidence.

COMPANY PROFILE:
${companyContext}${pricingContext}

TENDER DOCUMENT(S): ${pdfDocs.length} file(s) attached — treat as one combined tender pack.`;

      schema = JSON.stringify({
        tender_title: "string — actual title of this tender",
        tender_reference: "string or null",
        verdict: "GO or NO_GO or CONDITIONAL_GO",
        verdict_summary: "string — 2-3 sentences, directional not declarative",
        assessment_confidence: "HIGH or MEDIUM or LOW",
        assessment_confidence_reason: "string — why this confidence level",
        profile_completeness_pct: 0,
        facts: [{
          requirement: "string — exact requirement from tender",
          source: "string — where in tender found",
          company_status: "MET or UNMET or UNKNOWN or EXPIRED",
          company_data: "string or null",
          verification: "VERIFIED or SELF_REPORTED or MISSING",
          is_mandatory: true
        }],
        risk_assessment: [{
          risk: "string — specific risk",
          likelihood: "HIGH or MEDIUM or LOW",
          impact: "HIGH or MEDIUM or LOW",
          reasoning: "string — why this rating",
          what_changes_it: "string — action that reduces this risk"
        }],
        disqualification_probability: "HIGH or MEDIUM or LOW",
        disqualification_probability_reasoning: "string",
        recommendation: "string — directional, not DO/DO NOT",
        conditional_actions: [{ action: 'string', deadline: 'string or null', impact_if_done: 'string' }],
        compliance_checklist: [{ item: 'string', status: 'CAN_COMPLETE_NOW or MISSING_DOCUMENTS or NEEDS_PARTNER', notes: 'string' }],
        future_readiness: "string or null",
        scorecard: {
          total: 0,
          geographic_compliance: { score: 0, max: 20, notes: "string" },
          experience_track_record: { score: 0, max: 20, notes: "string" },
          registrations_certifications: { score: 0, max: 20, notes: "string" },
          financial_capacity: { score: 0, max: 20, notes: "string" },
          documentation_compliance: { score: 0, max: 20, notes: "string" }
        }
      });

    } else if (product === 'pricing') {
      maxTokens = 6144;
      prompt = `You are a South African tender pricing analyst. Your ONLY job is market pricing intelligence — you do NOT assess eligibility, do NOT give a verdict, do NOT discuss whether the company should bid. That is a separate product. Stay strictly in your lane: pricing and market data only.

This output is useful standalone regardless of whether the requesting company can bid this specific tender — it may be for a related entity, future capacity planning, or general market understanding. Never frame anything as conditional on winnability.

COMPANY PROFILE (for context only, e.g. industry-relevant rate benchmarking — NOT for eligibility assessment):
${companyContext}

TENDER DOCUMENT(S): ${pdfDocs.length} file(s) attached.

Produce a priced BOQ. If the tender specifies government-prescribed/gazetted rates, use those with HIGH confidence and say so explicitly. Otherwise benchmark against AECOM/ASAQS/Stats SA P01511/DPSA scales, flagging confidence honestly — HIGH only for standard statutory rates or directly comparable data, MEDIUM for general benchmarks, LOW for genuinely unknowable specialist/supplier-specific pricing.`;

      schema = `{
  "tender_title": "string",
  "tender_reference": "string or null",
  "boq": [ { "line_item": "string", "unit": "string", "quantity": number, "unit_rate": number, "total": number, "confidence": "HIGH or MEDIUM or LOW", "source": "string" } ],
  "boq_totals": { "subtotal": number, "margin_30pct": number, "recommended_bid": number, "conservative_bid": number, "aggressive_bid": number },
  "competitive_landscape": "full paragraph — pricing structure, typical bidders, what wins on price vs preference points",
  "pricing_disclaimer": "string — standard disclaimer about indicative pricing, sources used, verify before submission"
}`;

    }

    let report;

    if (product === 'bidpack') {
      // ── SPLIT INTO TWO LIGHTER CALLS ──────────────────────────────────
      // Bidpack was consistently failing (~2min, zero logs — likely a hard
      // platform-level kill on the heaviest single-call payload: full BOQ +
      // full compliance checklist + full formatted document, all at once).
      // Splitting into two calls — each individually no heavier than what
      // pricing already does reliably — closes that gap without losing any
      // capability.

      // Call 1 — BOQ + compliance checklist (identical shape to pricing's
      // proven-working call, just without the verdict-free pricing framing).
      const call1Prompt = `You are a South African tender bid preparation specialist. Return ONLY valid JSON matching the schema below. No markdown, no explanation outside the JSON.

SCHEMA RULES (mandatory — always populate all fields):
- boq: always include, even if company is ineligible. Use gazetted rates where specified. Never empty.
- compliance_checklist: split into three groups using the 'status' field: 'CAN_COMPLETE_NOW', 'MISSING_DOCUMENTS', 'NEEDS_PARTNER'
- pricing_disclaimer: use this field for eligibility assessment — state gaps, provide path forward (partner/JV/register/withdraw with timeline), estimate functionality score. Never a bare 'do not bid'.
- Do NOT apply a 30% margin to gazetted professional service rates.
- If quantities are not explicitly stated in the tender document, set quantity to null and set source to 'QUANTITY NOT SPECIFIED IN TENDER — bidder must confirm with procuring entity before submission'. Do NOT invent or estimate quantities. A wrong quantity is worse than no quantity.


PRICING AUTHORITY — MANDATORY FOR ALL BOQ LINE ITEMS:
You must use the following SA construction pricing framework in this exact order of priority:

1. GAZETTED RATES — if the tender document specifies fixed rates (e.g. housing subsidy programme), use those exactly. Do not adjust.

2. AECOM AFRICA PROPERTY & CONSTRUCTION COST GUIDE 2025/26 — the industry-standard SA pricing bible, calibrated to 1 July 2025. Use these as your primary rate anchor for all construction line items:

BUILDING COSTS (R/m² excl. VAT — July 2025 baseline):
- RDP housing: R3,200–R3,400/m²
- Low-cost housing: R4,000–R7,000/m²
- Low-rise residential apartment: R9,800–R13,500/m²
- Economic house: R7,400/m² | Standard: R9,300/m² | Middle-class: R11,200/m² | Luxury: R15,600/m²
- Light industrial (steel frame/cladding): R5,400–R6,900/m²
- Heavy industrial (brick to ceiling): R6,100–R8,800/m²
- Office park (standard low-rise): R10,700–R13,100/m²
- Primary school: R8,800–R10,100/m² | Secondary school: R10,500–R11,200/m²
- Community centre: R14,900–R21,700/m²

MEP SERVICES (R/m² excl. VAT):
- Electrical — standard offices: R1,000–R1,500 | Residential: R900–R1,500 | Shopping centre: R1,500–R1,900
- Electronic/security (CCTV, access, fire detection): R500–R700 offices | R450–R700 residential
- Sprinkler system: R450–R550/m²
- Air-conditioning — split units residential: R1,300–R2,050 | offices console: R1,150–R1,600 | central plant: R2,300–R3,600

CIVIL & INFRASTRUCTURE:
- Parking on grade: R750–R950/m² | Structured parking: R5,200–R5,800/m² | Basement: R6,100–R10,700/m²
- Building sand: R350–R450/m³ | Plaster sand: R380–R500/m³ | River sand: R450–R600/m³
- Cement (50kg bag): R75–R120

3. STATS SA CPAP ESCALATION — apply these annual escalation rates to any rate sourced from documents older than July 2025:
- Total construction: +7.2% per year
- Electrical engineering: +6.5% per year
- Mechanical engineering: +7.2% per year
- Civil engineering materials: +7.0% per year
- Plant and equipment: +6.8% per year

4. TRADE-SPECIFIC CURRENT SA MARKET RATES (June 2026 — verified against current market):
FLOORING:
- Standard laminate 8mm AC3: R145–R185/m² supply | Install: R65–R85/m² | Underlay 3mm foam: R18–R28/m²
- Quality laminate 12mm AC4: R220–R320/m² supply | Install: R75–R95/m²
- Vinyl plank (LVT): R185–R380/m² supply | Install: R75–R95/m²
- Ceramic tile 600x600 standard: R120–R185/m² supply | Install: R145–R195/m²
- Porcelain tile 600x600: R195–R420/m² supply | Install: R155–R210/m²
- Self-levelling screed 3mm: R95–R145/m² | 6mm: R165–R225/m²
- Carpet tiles commercial: R145–R285/m² supply | Install: R45–R75/m²
- Aluminium threshold strips: R75–R110/m

PLUMBING & DRAINAGE:
- HDPE pipe 50mm: R85–R125/m | 110mm: R195–R285/m | 160mm: R380–R520/m
- PVC pressure pipe 20mm: R18–R28/m | 32mm: R38–R55/m | 50mm: R65–R95/m
- Standard close-coupled toilet suite: R1,850–R3,200 supply + fit
- Basin with mixer tap: R1,200–R2,800 supply + fit
- Shower tray + mixer: R2,400–R5,500 supply + fit
- Hot water cylinder 150L: R4,500–R7,800 supply + fit

ELECTRICAL:
- DB board 3-phase 12-way: R4,500–R8,500 supply + fit
- DB board single-phase 8-way: R1,800–R3,500 supply + fit
- 2.5mm² TRS cable (per m): R12–R18 | 4mm²: R18–R28 | 6mm²: R28–R42
- NYY 4mm² (per m): R22–R35 | 6mm²: R35–R55
- LED downlight fitting + lamp: R285–R650 supply + fit
- Double power point: R285–R420 supply + fit
- Light switch single: R165–R285 supply + fit
- Solar PV panel 400W: R2,200–R3,800 supply

PAINTING & FINISHES:
- Interior walls — PVA 2 coats: R45–R75/m²
- Exterior walls — textured finish: R85–R145/m²
- Ceiling — PVA 2 coats: R40–R65/m²
- Roof sheeting IBR 0.47mm: R135–R185/m² supply + fix

STRUCTURAL:
- Reinforced concrete (30MPa): R4,200–R5,800/m³ supply + pour
- Brickwork (face brick): R580–R850/m² supply + lay
- Brickwork (plaster brick): R380–R580/m² supply + lay
- Plastering: R95–R145/m²
- Steel I-beam structure: R2,800–R4,200/m² (Gauteng basis — add 8% for WC, 5% for KZN)

EARTHWORKS & CIVIL:
- Bulk earthworks (cut and fill): R65–R145/m³
- Concrete kerbing: R185–R285/m
- Asphalt paving: R195–R285/m²
- Paving bricks (60mm): R145–R225/m² supply + lay

LABOUR RATES (bargaining council basis — unskilled/semi-skilled/skilled):
- General labourer: R95–R145/hr | Artisan (plumber/electrician): R185–R320/hr | Foreman: R220–R380/hr
- These include statutory contributions — do not add again.

REGIONAL ADJUSTMENT FACTORS (apply to all material and labour rates):
- Gauteng: base (0%)
- Western Cape: +8–12%
- KwaZulu-Natal: +3–6%
- Eastern Cape: +5–10%
- Mpumalanga/Limpopo: +8–15% (logistics premium)
- Northern Cape: +12–20%

CONFIDENCE RATING RULES:
- HIGH: rate taken directly from gazetted schedule or AECOM 2025/26 table above
- MEDIUM: rate interpolated from above tables with reasonable assumptions about specification
- LOW: rate estimated from first principles or for specialist/niche items not in above tables — flag for supplier verification

MANDATORY BOQ INSTRUCTIONS:
- Always include waste factors: tiles +15%, laminate/vinyl +10%, paint +10%, carpet +8%
- Always include prep work as separate line items (screed, priming, waterproofing where applicable)
- Always include site establishment, temporary facilities, and contingency (5–10%) as line items
- Quantities must have a source note explaining how you derived them if not stated in tender
- Never leave unit_rate as 0 — estimate with LOW confidence and note it

COMPANY PROFILE:
${companyContext}

TENDER DOCUMENT(S): ${pdfDocs.length} file(s) attached.`;

      const call1Schema = `{
  "tender_title": "string — actual title/name of this tender",
  "tender_reference": "string or null",
  "compliance_checklist": [ { "item": "string", "status": "string", "notes": "string" } ],
  "pricing_basis": {
    "dominant_labour_category": "string — main labour type in this tender",
    "applicable_council": "string — bargaining council or gazette name",
    "gazette_reference": "string or null",
    "effective_date": "string",
    "base_rate": number,
    "base_rate_unit": "string — e.g. per hour, per week",
    "oncost_pct": number,
    "oncost_amount": number,
    "oncost_components": "string — e.g. UIF 1%, COIDA 0.83%, leave 8.33%...",
    "overhead_pct": number,
    "overhead_amount": number,
    "margin_pct": number,
    "margin_amount": number,
    "transcribe_rate": number,
    "transcribe_rate_unit": "string",
    "assumptions": "string — what this rate assumes about the company",
    "reality_check": "string — honest note about when actual costs will be higher"
  },
  "boq": [ { "line_item": "string", "unit": "string", "quantity": number, "unit_rate": number, "total": number, "confidence": "HIGH or MEDIUM or LOW", "source": "string" } ],
  "boq_totals": { "subtotal": number, "margin_30pct": number, "recommended_bid": number },
  "pricing_disclaimer": "string"
}`;

      const call1Result = await callClaude(env, pdfDocs, call1Prompt, call1Schema, 16000);
      if (!call1Result.success) {
        console.error('TL v2 — bidpack call 1 (BOQ+checklist) failed. run:', productRunId, 'reason:', call1Result.reason);
        await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(JSON.stringify({ error: call1Result.reason, stage: 'call1' }), productRunId).run();
        return { success: false, reason: call1Result.reason };
      }
      // Handle both flat and nested result structures from tool_choice
      const call1Data = call1Result.data?.boq ? call1Result.data : (call1Result.data?.result || call1Result.data);
      if (!call1Data.boq || !Array.isArray(call1Data.boq)) {
        console.error('TL v2 — bidpack call 1 missing BOQ. run:', productRunId, 'keys:', Object.keys(call1Result.data||{}).join(','), 'parsed:', JSON.stringify(call1Result.data).slice(0,500));
        await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(JSON.stringify({ error: 'Missing BOQ data', keys: Object.keys(call1Result.data||{}), data_preview: JSON.stringify(call1Result.data).slice(0,300) }), productRunId).run();
        return { success: false, reason: 'Analysis did not produce pricing data' };
      }

      // Call 2 — the FULL submission preparation pack, written directly as
      // plain markdown text, NO JSON wrapper at all. This mirrors what a
      // direct chat conversation does (ask Claude/Kimi/etc "give me a full
      // tender-ready submission pack for this PDF" and it just writes the
      // answer) — every MBD form's fields laid out for transcription, the
      // category selection table, functionality scoring breakdown,
      // envelope endorsement wording, submission checklist. Re-attaches the
      // original PDF so this call has full access to the tender's specific
      // forms and requirements, not just a summary of call 1's output.
      const       call2Prompt = `You are a South African government tender bid preparation specialist producing a complete, practical bid preparation toolkit. This is a working reference document — not a legal opinion.

SINGLE DISCLAIMER (top of document only, never repeated): 'Reference document — transcribe to official forms in black ink. Do not submit this document as your bid.'

QUALITY STANDARD: Match the depth of a professional bid consultant. Every section must contain actionable, specific information pulled directly from the tender document and company profile. No generic text. No vague statements. If data is missing, state exactly what is missing and where to obtain it.

## Eligibility Summary

Write 2-3 paragraphs:
1. What this tender requires — specific registrations, experience, geographic presence, staff numbers, financial thresholds
2. What the company has vs what it lacks — be specific with numbers (e.g. "tender requires 14 cleaning staff, company declares 0 employees")
3. Concrete path forward with realistic timelines — JV requirements, registration timelines, or withdrawal recommendation

If recommending JV: specify exactly which registrations the JV partner must hold, experience needed, and functionality score impact.

## Pricing Basis

Before the BOQ, include a PRICING BASIS section that shows:
1. The statutory minimum base rate for the dominant labour category in this tender (cite source: council name, gazette number, effective date)
2. The on-cost factor applied (UIF, COIDA, leave, provident fund, council levies) — show the percentage and rand amount
3. The overhead recovery applied (typically 15%)
4. The profit margin applied (typically 10%)
5. The final TRANSCRIBE THIS RATE clearly marked

Format it exactly like this example:

---
**PRICING BASIS — [Labour Category]**

**Transcribe this rate: R[X]/hour**

How we got here:
- Base wage ([Council name], effective [date]): R[X]/hour
- Statutory on-costs +[X]% (UIF, COIDA, leave, provident, council levy): +R[X]
- Overhead recovery [X]%: +R[X]
- Profit margin [X]%: +R[X]
- **Total: R[X]/hour**

What this assumes:
- You are registered and compliant with [relevant council/gazette]
- You have a stable workforce with low absenteeism and turnover
- Your overhead structure is lean and established
- You are pricing to win competitively, not to maximise margin

If you are a well-run, established company this rate is competitive and compliant. If you are newly established, still building systems, or managing multiple contracts simultaneously, your actual cost will be higher — adjust before submitting.

*Source: [Council/Gazette name], [Gazette number], effective [date]*
---

## Bill of Quantities

Use the confirmed BOQ data. For each line item show: description, unit, quantity, the single transcribable rate (matching the pricing basis above), total, and confidence rating.

For quantities explicitly stated in the tender: use them exactly.
For quantities NOT stated: write null for quantity and note "QUANTITY NOT SPECIFIED IN TENDER — confirm with procuring entity before submission."

Do NOT add a blanket margin to gazetted professional service rates (ECSA, SACPCMP, etc.) — those are all-inclusive fee guidelines. The margin structure above applies to labour-intensive service contracts only.

## Forms You Can Complete Now

Pre-fill EVERY field from the company profile. Mark missing as 'UNKNOWN — verify in profile'. Include:

**MBD 1** — company name, trading name, all addresses, contact person, all registration numbers, B-BBEE level
**MBD 2** — tax reference, compliance status
**MBD 4** — representative from directors, ID number, position, company details. Directors table with full name, ID, equity %.
**MBD 6.1** — B-BBEE level, certificate number, points claimed
**MBD 8** — company name, all available fields
**MBD 9** — exact bid number and description from tender, company name
**MBD 15** — company name, physical address, municipal account number, all director details. Note: Commissioner of Oaths required.
**MBD 7.1 Part 1** — firm name, bid number, capacity

## Category Selection Table

All categories with required registrations, gazetted rates, unchecked tick boxes.

## SBD 3.1 — Pricing Schedule

Gazetted rates pre-filled as tendered rates.

## Form C1 — Project References

Full form template with columns. If no projects: state exact impact on functionality score.

## Verified Compliance Documents

For each document: name, status (VERIFIED/SELF-REPORTED/MISSING/EXPIRED), value, exact expiry, specific renewal action with cost and lead time.

## Submission Checklist

Exact envelope wording, USB if required, black ink rule, Commissioner of Oaths, exact closing time and physical address, validity period.

COMPANY PROFILE:
${companyContext}

CONFIRMED BOQ TOTAL: R${call1Data.boq_totals?.recommended_bid?.toLocaleString() || 'see BOQ'}.
BOQ LINE ITEMS: ${JSON.stringify(call1Data.boq || []).slice(0,2000)}

PRICING BASIS (use this to build the Pricing Basis section):
${call1Data.pricing_basis ? JSON.stringify(call1Data.pricing_basis, null, 2) : 'Not extracted — derive from tender document and applicable bargaining council rates'}

Write complete well-formatted markdown. One disclaimer at top. No placeholders where actual data exists.`;


      const call2Result = await callClaudeSimple(env, pdfDocs, call2Prompt, 10000);
      if (!call2Result.success) {
        console.error('TL v2 — bidpack call 2 (submission pack) failed. run:', productRunId, 'reason:', call2Result.reason);
        await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(JSON.stringify({ error: call2Result.reason, stage: 'call2', boq_succeeded: true }), productRunId).run();
        return { success: false, reason: call2Result.reason };
      }

      report = { ...call1Result.data, submission_document: call2Result.text || null };

    } else {
      const fullPrompt = `${prompt}\n\nReturn ONLY this JSON structure:\n${schema}\n\nReturn ONLY valid JSON. No markdown fencing. No explanation outside the JSON.`;
      const singleResult = useTwoPass
        ? await callClaudeTwoPass(env, pdfDocs, fullPrompt, schema, maxTokens)
        : await callClaude(env, pdfDocs, fullPrompt, schema, maxTokens, true);
      if (!singleResult.success) {
        console.error('TL v2 —', product, 'call failed. run:', productRunId, 'reason:', singleResult.reason);
        await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(JSON.stringify({ error: singleResult.reason }), productRunId).run();
        return { success: false, reason: singleResult.reason };
      }
      report = singleResult.data;

      if (product === 'gonogo' && (!report.verdict || !['GO','NO_GO','CONDITIONAL_GO'].includes(report.verdict))) {
        console.error('TL v2 — gonogo missing valid verdict. run:', productRunId, 'parsed:', JSON.stringify(report).slice(0,500));
        await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .bind(JSON.stringify({ error: 'Missing valid verdict', parsed_keys: Object.keys(report||{}), verdict_found: report?.verdict }), productRunId).run();
        return { success: false, reason: 'Analysis did not produce a valid verdict' };
      }
      if (product === 'pricing' && (!report.boq || !Array.isArray(report.boq))) {
        console.error('TL v2 — pricing missing BOQ data. run:', productRunId, 'parsed:', JSON.stringify(report).slice(0,500));
        await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
        return { success: false, reason: 'Analysis did not produce pricing data' };
      }
    }

    const reportKey = `product-runs/${productRunId}/report.json`;
    await env.TL_DOCS.put(reportKey, JSON.stringify(report));

    // Update the parent tender's title/ref if this is the first run to discover them
    if (report.tender_title) {
      const tenderRow = await env.TL_DB.prepare('SELECT tender_title, tender_ref, id FROM tl_tenders WHERE id=(SELECT tender_id FROM tl_product_runs WHERE id=?)').bind(productRunId).first();
      if (tenderRow && !tenderRow.tender_title) {
        await env.TL_DB.prepare('UPDATE tl_tenders SET tender_title=?, tender_ref=COALESCE(tender_ref, ?) WHERE id=?')
          .bind(report.tender_title, report.tender_reference || null, tenderRow.id).run();
      }
    }

    // ── TOKEN COST LOGGING ───────────────────────────────────────────────
    // call1Result/call2Result only exist for bidpack; singleResult only for gonogo/pricing
    // Use typeof check to avoid ReferenceError in strict mode
    const _c1 = typeof call1Result !== 'undefined' ? call1Result : null;
    const _c2 = typeof call2Result !== 'undefined' ? call2Result : null;
    const _sr = typeof singleResult !== 'undefined' ? singleResult : null;
    const totalInputTokens  = (_c1?.inputTokens  || 0) + (_c2?.inputTokens  || 0) + (_sr?.inputTokens  || 0);
    const totalOutputTokens = (_c1?.outputTokens || 0) + (_c2?.outputTokens || 0) + (_sr?.outputTokens || 0);
    const totalCostUsd      = (_c1?.costUsd || 0) + (_c2?.costUsd || 0) + (_sr?.costUsd || 0);
    const pdfSizeInfo       = pdfDocs?.length ? estimatePdfTokens(pdfDocs) : { totalBytes: 0, estimatedTokens: 0 };

    await env.TL_DB.prepare(`
      UPDATE tl_product_runs
      SET status='complete', verdict=?, report_r2_key=?, report_json=?,
          input_tokens=?, output_tokens=?, estimated_cost_usd=?,
          pdf_total_bytes=?, pdf_estimated_tokens=?,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(
      report.verdict || null, reportKey, JSON.stringify(report),
      totalInputTokens, totalOutputTokens, totalCostUsd,
      pdfSizeInfo.totalBytes, pdfSizeInfo.estimatedTokens,
      productRunId
    ).run();

    console.log('TL v2 — run complete:', productRunId, 'tokens:', totalInputTokens, '+', totalOutputTokens, 'cost: $' + totalCostUsd.toFixed(4));

    return { success: true };

  } catch(e) {
    console.error('TL v2 — analysis error:', e.message, 'stack:', e.stack?.slice(0,300), 'run:', productRunId, 'product:', product);
    await env.TL_DB.prepare(
      `UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
    ).bind(JSON.stringify({ error: e.message, stack: e.stack?.slice(0,500) }), productRunId).run();
    return { success: false, reason: e.message };
  }
}

// ── Build company context including verified compliance docs — same logic as v1 ──
async function buildCompanyContext(company, env) {
  // Load self-declared documents — treated equally to verified in analysis
  const selfDeclaredDocs = (() => {
    try { return JSON.parse(company.self_declared_docs || '{}'); } catch(e) { return {}; }
  })();

  const verifiedDocs = await env.TL_DB.prepare(`
    SELECT cd.*, dt.name as doc_name FROM tl_compliance_documents cd
    JOIN tl_doc_types dt ON cd.doc_type_id = dt.id
    WHERE cd.company_id = ?
  `).bind(company.id).all();

  const verifiedByType = {};
  (verifiedDocs.results || []).forEach(d => { verifiedByType[d.doc_type_id] = d; });

  function complianceLine(typeId, label, selfReportedValue, selfDeclaredDocs) {
    const v = verifiedByType[typeId];
    // Vault-uploaded and expired — genuine gap
    if (v && v.status === 'red') {
      const expiredNote = v.expiry_date ? ` (expired ${v.expiry_date})` : '';
      return `${label}: EXPIRED${expiredNote} — certificate on file is no longer valid.`;
    }
    // Vault-uploaded and valid — confirmed on file
    if (v && v.status !== 'red') {
      const expiryNote = v.expiry_date ? `, valid until ${v.expiry_date}` : '';
      return `${label}: ${v.extracted_value || 'Confirmed'} — on file${expiryNote}.`;
    }
    // Self-declared via profile — treated the same as verified for analysis purposes
    // The company has declared they hold this document. Treat as confirmed.
    const sd = selfDeclaredDocs && selfDeclaredDocs[typeId];
    if (sd && sd.declared) {
      const val = sd.level || sd.grade || sd.number || sd.pin || selfReportedValue || 'Confirmed';
      const expiryNote = sd.expiry ? `, valid until ${sd.expiry}` : '';
      return `${label}: ${val} — declared on file${expiryNote}.`;
    }
    // Profile field only (no declaration, no upload)
    if (selfReportedValue && selfReportedValue !== 'Not specified') {
      return `${label}: ${selfReportedValue} — declared on file.`;
    }
    return `${label}: Not on file.`;
  }

  const employeeBreakdown = [
    company.employees_management ? `${company.employees_management} management` : null,
    company.employees_skilled ? `${company.employees_skilled} skilled/technical` : null,
    company.employees_unskilled ? `${company.employees_unskilled} unskilled/general` : null,
  ].filter(Boolean).join(', ');

  return `
COMPANY PROFILE
===============
Company: ${company.name}
Registration: ${company.reg_number || 'Not provided'}
Industries: ${company.industries || 'Not specified'}
Operating Provinces: ${company.provinces || 'Not specified'}

CAPACITY & WORKFORCE
====================
Total Employees: ${company.employees || 0}${employeeBreakdown ? ` (${employeeBreakdown})` : ''}
Years in Operation: ${company.years_experience || 0}
Company Vehicles: ${company.vehicles_owned ?? 'Not specified'}
UIF Registered: ${company.uif_registered || 'Not specified'}
PAYE Registered: ${company.paye_registered || 'Not specified'}

FINANCIAL STANDING
==================
Annual Turnover: R${(company.annual_turnover||0).toLocaleString()}
Working Capital: ${company.working_capital ? 'R' + company.working_capital.toLocaleString() : 'Not specified'}
Largest Single Contract: ${company.largest_contract_value ? 'R' + company.largest_contract_value.toLocaleString() : 'Not specified'}
Banking Institution: ${company.banking_institution || 'Not specified'}

TRACK RECORD
============
Total Contracts Completed: ${company.contracts_completed ?? 'Not specified'}
Government Contracts Completed: ${company.government_contracts ?? 'Not specified'}
Current Active Contracts: ${company.active_contracts ?? 'Not specified'}
Client References Available: ${company.client_references ?? 'Not specified'}
Professional Registrations: ${company.professional_registrations || 'None declared'}
Specialist Equipment: ${company.equipment_owned || 'None declared'}

COMPLIANCE DOCUMENTS
====================
${complianceLine('cidb', 'CIDB Grade', company.cidb_grade, selfDeclaredDocs)}
${complianceLine('bee', 'B-BBEE Level', company.bee_level ? `Level ${company.bee_level}` : null, selfDeclaredDocs)}
${complianceLine('csd', 'CSD Registration', company.csd_maaa ? 'Registered' : null, selfDeclaredDocs)}
${complianceLine('tax', 'Tax Clearance/TCS PIN', null, selfDeclaredDocs)}
${complianceLine('coida', 'COIDA Letter of Good Standing', null, selfDeclaredDocs)}
${complianceLine('liability', 'Public Liability Insurance', null, selfDeclaredDocs)}
${complianceLine('vat', 'VAT Registration', company.vat_number ? 'Registered' : null, selfDeclaredDocs)}
${complianceLine('bank', 'Bank Confirmation Letter', null, selfDeclaredDocs)}

IMPORTANT: Lines marked VERIFIED come from an actual uploaded certificate — treat as fact. Lines marked "declared on file" are self-reported by the company. NOT ON FILE means the document is absent. EXPIRED lines are a current compliance gap that will likely cause disqualification.
`;
}


// ── QUEUE CONSUMER — runs the actual Claude analysis for one product ─────
// Exported, called from the main Worker's queue() handler for type='tl_v2_run'.
export async function processTlV2QueueMessage(msg, env) {
  const { productRunId, tenderId, companyId, product, chargeAmount, isFreeTrial } = msg;

  console.log('TL v2 queue STEP 1 — fetching tender and company. run:', productRunId);
  let tender, company;
  try {
    tender = await env.TL_DB.prepare('SELECT * FROM tl_tenders WHERE id=? LIMIT 1').bind(tenderId).first();
    company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(companyId).first();
  } catch(dbErr) {
    console.error('TL v2 queue STEP 1 FAILED — DB error:', dbErr.message);
    await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(JSON.stringify({ error: 'DB fetch failed: ' + dbErr.message, step: 1 }), productRunId).run().catch(()=>{});
    return;
  }

  console.log('TL v2 queue STEP 1 done — tender:', !!tender, 'company:', !!company);

  if (!tender || !company) {
    console.error('TL v2 queue — tender or company not found. run:', productRunId, 'tender:', tenderId, 'company:', companyId);
    await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(JSON.stringify({ error: 'Tender or company not found', tenderId, companyId }), productRunId).run();
    return;
  }

  console.log('TL v2 queue STEP 2 — setting processing status');
  await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='processing' WHERE id=?`).bind(productRunId).run();

  // ── Read all documents for this tender from R2 ──
  let docKeys = [];
  try { docKeys = JSON.parse(tender.doc_r2_keys || '[]'); } catch(e) {}

  const pdfDocs = [];
  let totalPdfBytes = 0;
  for (const key of docKeys) {
    const obj = await env.TL_DOCS.get(key);
    if (obj) {
      const buf = await obj.arrayBuffer();
      totalPdfBytes += buf.byteLength;
      pdfDocs.push({ base64: arrayBufferToBase64(buf), filename: key.split('/').pop() });
    }
  }

  // ── 3. LARGE TENDER DETECTION ────────────────────────────────────────
  const estimatedPdfTokens = Math.ceil(totalPdfBytes / 3.5);
  const useTwoPass = estimatedPdfTokens > MAX_SAFE_PDF_TOKENS && estimatedPdfTokens <= MAX_PDF_TOKENS;
  if (estimatedPdfTokens > 100_000) {
    console.warn('TL v2 — large tender:', estimatedPdfTokens, 'est. tokens,', docKeys.length, 'docs,', totalPdfBytes, 'bytes. run:', productRunId, useTwoPass ? '→ two-pass' : '→ size_exceeded');
  }

  if (!pdfDocs.length) {
    const reason = `No documents found in storage for tender ${tenderId}. Keys checked: ${docKeys.join(', ')}. Please re-upload the tender document.`;
    console.error('TL v2 queue —', reason, 'run:', productRunId);
    await env.TL_DB.prepare(
      `UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
    ).bind(JSON.stringify({ error: reason }), productRunId).run();
    return;
  }

  console.log('TL v2 queue — calling runV2Product. run:', productRunId, 'product:', product, 'docs:', pdfDocs.length, 'bytes:', totalPdfBytes);
  let result;
  try {
    result = await runV2Product(productRunId, company, pdfDocs, product, env, useTwoPass);
  } catch(queueErr) {
    console.error('TL v2 queue — unhandled exception in runV2Product:', queueErr.message, queueErr.stack?.slice(0,400));
    await env.TL_DB.prepare(
      `UPDATE tl_product_runs SET status='failed', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
    ).bind(JSON.stringify({ error: queueErr.message, stack: queueErr.stack?.slice(0,400), stage: 'runV2Product' }), productRunId).run();
    return;
  }

  if (!result.success) {
    if (result.size_exceeded) {
      // Special case — not a technical failure, just too large. Give user a clear message.
      console.warn('TL v2 queue — tender too large for analysis. run:', productRunId, 'estimated_tokens:', result.estimated_tokens);
      await env.TL_DB.prepare(
        `UPDATE tl_product_runs SET status='size_exceeded', report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).bind(JSON.stringify({ error: result.reason, estimated_tokens: result.estimated_tokens }), productRunId).run();
    } else {
      console.error('TL v2 queue — product run failed:', productRunId, 'product:', product, 'reason:', result.reason);
      // status already set to 'failed' inside runV2Product — no charge happens.
    }
    return;
  }

  // ── Genuine success — charge now (unless this was a free trial) ──
  if (!isFreeTrial && chargeAmount > 0) {
    const bal = await env.TL_DB.prepare('SELECT balance FROM tl_companies WHERE id=? LIMIT 1').bind(companyId).first();
    const fromBalance = Math.min(bal?.balance || 0, chargeAmount);
    if (fromBalance > 0) {
      await env.TL_DB.prepare('UPDATE tl_companies SET balance=balance-? WHERE id=?').bind(fromBalance, companyId).run();
      await env.TL_DB.prepare(`INSERT INTO tl_credits (id, company_id, amount, type) VALUES (?,?,?,'used')`)
        .bind(crypto.randomUUID(), companyId, -fromBalance).run();
    }
    if (fromBalance < chargeAmount) {
      console.error('TL v2 queue — balance changed during analysis, undercharged. run:', productRunId, 'chargeAmount:', chargeAmount, 'actually charged:', fromBalance);
    }
    await env.TL_DB.prepare('UPDATE tl_product_runs SET amount_paid=? WHERE id=?').bind(fromBalance, productRunId).run();
  }

  if (isFreeTrial) {
    await markFreeTrialUsed(env, companyId, product, productRunId);
  }
}

// ── Shared Claude call helper — used by gonogo/pricing directly, and by
// bidpack's two-call split. Centralises the fetch/parse/validate-shape logic
// so error handling stays consistent everywhere a Claude call happens.
// ── TOKEN COST CONSTANTS (Sonnet 4.6 pricing) ────────────────────────────
const COST_INPUT_PER_TOKEN  = 3 / 1_000_000;   // $3 per 1M input tokens
const COST_OUTPUT_PER_TOKEN = 15 / 1_000_000;  // $15 per 1M output tokens
const MAX_SAFE_PDF_TOKENS   = 150_000;          // warn above this
const MAX_PDF_TOKENS        = 180_000;          // hard reject above this — but estimator is conservative so real limit is rarely hit
const BYTES_PER_TOKEN_PDF   = 20;               // PDF files are mostly binary/compressed — actual text tokens are ~5-10% of raw bytes

// ── Estimate PDF token count from raw bytes ───────────────────────────────
function estimatePdfTokens(pdfDocs) {
  const totalBytes = pdfDocs.reduce((sum, d) => sum + Math.ceil(d.base64.length * 0.75), 0);
  return { totalBytes, estimatedTokens: Math.ceil(totalBytes / BYTES_PER_TOKEN_PDF) };
}

async function callClaude(env, pdfDocs, promptText, schemaText, maxTokens, appendSchemaInstruction = false) {
  const finalPrompt = schemaText && appendSchemaInstruction
    ? `${promptText}\n\nReturn ONLY this JSON structure:\n${schemaText}\n\nReturn ONLY valid JSON. No markdown, no explanation, no text outside the JSON object.`
    : promptText;

  try {
    // ── Upload PDFs to Kimi and extract text ─────────────────────────────
    const fileMessages = [];
    for (const pdf of (pdfDocs || [])) {
      // Build multipart form data for file upload
      const boundary = '----KimiFormBoundary' + Math.random().toString(36).slice(2);
      const pdfBytes = Uint8Array.from(atob(pdf.base64), c => c.charCodeAt(0));

      const beforeFile = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${pdf.filename}"`,
        `Content-Type: application/pdf`,
        '',
        ''
      ].join('\r\n');
      const afterFile = `\r\n--${boundary}--\r\n`;
      const purposePart = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="purpose"`,
        '',
        'file-extract',
        ''
      ].join('\r\n');

      // Encode to bytes
      const encoder = new TextEncoder();
      const beforeBytes = encoder.encode(beforeFile);
      const afterBytes = encoder.encode(afterFile);
      const purposeBytes = encoder.encode(purposePart);

      const body = new Uint8Array(purposeBytes.length + beforeBytes.length + pdfBytes.length + afterBytes.length);
      body.set(purposeBytes, 0);
      body.set(beforeBytes, purposeBytes.length);
      body.set(pdfBytes, purposeBytes.length + beforeBytes.length);
      body.set(afterBytes, purposeBytes.length + beforeBytes.length + pdfBytes.length);

      const uploadRes = await fetch('https://api.moonshot.ai/v1/files', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.KIMI_KEY,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        },
        body: body
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        console.error('TL Kimi upload failed:', uploadRes.status, err.slice(0,200));
        return { success: false, reason: `File upload failed: ${uploadRes.status}` };
      }

      const fileObj = await uploadRes.json();
      const fileId = fileObj.id;

      // Extract text content from uploaded file
      const contentRes = await fetch(`https://api.moonshot.ai/v1/files/${fileId}/content`, {
        headers: { 'Authorization': 'Bearer ' + env.KIMI_KEY }
      });

      if (!contentRes.ok) {
        console.error('TL Kimi content extract failed:', contentRes.status);
        return { success: false, reason: 'File content extraction failed' };
      }

      const extractedText = await contentRes.text();
      fileMessages.push({ role: 'system', content: extractedText });

      // Clean up — delete file after extraction (respect 1000 file limit)
      fetch(`https://api.moonshot.ai/v1/files/${fileId}`, {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + env.KIMI_KEY }
      }).catch(() => {});
    }

    // ── Call Kimi chat completion ─────────────────────────────────────────
    const messages = [
      ...fileMessages,
      { role: 'user', content: finalPrompt }
    ];

    const aiRes = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.KIMI_KEY
      },
      body: JSON.stringify({
        model: 'kimi-k2.5',
        max_tokens: maxTokens,
        messages
      })
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('TL Kimi API error:', aiRes.status, errBody.slice(0,500));
      return { success: false, reason: `Kimi API returned ${aiRes.status}: ${errBody.slice(0,200)}` };
    }

    const aiData = await aiRes.json();
    const rawText = aiData.choices?.[0]?.message?.content || '';
    const stopReason = aiData.choices?.[0]?.finish_reason || '';

    const inputTokens  = aiData.usage?.prompt_tokens    || 0;
    const outputTokens = aiData.usage?.completion_tokens || 0;
    // Kimi K2.5 pricing: $0.60/1M input, $3.00/1M output
    const costUsd = (inputTokens * 0.0000006) + (outputTokens * 0.000003);

    if (!rawText) {
      console.error('TL Kimi — empty response. stop_reason:', stopReason);
      return { success: false, reason: 'Empty response from analysis engine' };
    }

    let data;
    try {
      data = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      console.error('TL Kimi — JSON parse failed. stop_reason:', stopReason, 'raw (800 chars):', rawText.slice(0,800));
      const reason = stopReason === 'length'
        ? 'The analysis exceeded the response size limit. Please try again.'
        : 'Could not parse analysis result';
      return { success: false, reason };
    }

    return { success: true, data, inputTokens, outputTokens, costUsd };

  } catch(e) {
    console.error('TL Kimi — exception:', e.message);
    return { success: false, reason: e.message };
  }
}


async function callClaudeSimple(env, pdfDocs, promptText, maxTokens) {
  // Prose generation — same Kimi pipeline but no JSON parsing
  try {
    const fileMessages = [];
    for (const pdf of (pdfDocs || [])) {
      const boundary = '----KimiFormBoundary' + Math.random().toString(36).slice(2);
      const pdfBytes = Uint8Array.from(atob(pdf.base64), c => c.charCodeAt(0));
      const beforeFile = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${pdf.filename}"\r\nContent-Type: application/pdf\r\n\r\n`;
      const afterFile = `\r\n--${boundary}--\r\n`;
      const purposePart = `--${boundary}\r\nContent-Disposition: form-data; name="purpose"\r\n\r\nfile-extract\r\n`;
      const encoder = new TextEncoder();
      const beforeBytes = encoder.encode(beforeFile);
      const afterBytes = encoder.encode(afterFile);
      const purposeBytes = encoder.encode(purposePart);
      const body = new Uint8Array(purposeBytes.length + beforeBytes.length + pdfBytes.length + afterBytes.length);
      body.set(purposeBytes, 0);
      body.set(beforeBytes, purposeBytes.length);
      body.set(pdfBytes, purposeBytes.length + beforeBytes.length);
      body.set(afterBytes, purposeBytes.length + beforeBytes.length + pdfBytes.length);

      const uploadRes = await fetch('https://api.moonshot.ai/v1/files', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + env.KIMI_KEY, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body
      });
      if (!uploadRes.ok) return { success: false, reason: `File upload failed: ${uploadRes.status}` };
      const fileObj = await uploadRes.json();
      const contentRes = await fetch(`https://api.moonshot.ai/v1/files/${fileObj.id}/content`, {
        headers: { 'Authorization': 'Bearer ' + env.KIMI_KEY }
      });
      if (!contentRes.ok) return { success: false, reason: 'File content extraction failed' };
      fileMessages.push({ role: 'system', content: await contentRes.text() });
      fetch(`https://api.moonshot.ai/v1/files/${fileObj.id}`, { method: 'DELETE', headers: { 'Authorization': 'Bearer ' + env.KIMI_KEY } }).catch(() => {});
    }

    const aiRes = await fetch('https://api.moonshot.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.KIMI_KEY },
      body: JSON.stringify({ model: 'kimi-k2.5', max_tokens: maxTokens, messages: [...fileMessages, { role: 'user', content: promptText }] })
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      return { success: false, reason: `Kimi API returned ${aiRes.status}: ${errBody.slice(0,200)}` };
    }

    const aiData = await aiRes.json();
    const text = aiData.choices?.[0]?.message?.content || '';
    const inputTokens  = aiData.usage?.prompt_tokens    || 0;
    const outputTokens = aiData.usage?.completion_tokens || 0;
    const costUsd = (inputTokens * 0.0000006) + (outputTokens * 0.000003);
    return { success: !!text, text, inputTokens, outputTokens, costUsd };
  } catch(e) {
    return { success: false, reason: e.message };
  }
}


async function callClaudeTwoPass(env, pdfDocs, promptText, schemaText, maxTokens) {
  // Kimi K2.5 has a 262k context window — no need for two-pass skeleton extraction.
  // Route directly to callClaude which handles the full PDF in one pass.
  console.log('TL callClaudeTwoPass — routing to single-pass (Kimi 262k context)');
  return callClaude(env, pdfDocs, promptText, schemaText, maxTokens, false);
}


