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

async function callClaude(env, pdfDocs, promptText, schemaText, maxTokens, appendSchemaInstruction) {
  const fullPrompt = appendSchemaInstruction
    ? promptText // promptText already has schema appended by caller for single-call products
    : `${promptText}\n\nReturn ONLY this JSON structure:\n${schemaText}\n\nReturn ONLY valid JSON. No markdown fencing. No explanation outside the JSON.`;

  // ── 2. PDF SIZE CHECK ────────────────────────────────────────────────────
  // Strategy:
  //   <100k tokens  → proceed normally
  //   100k-180k     → proceed with "focus on key sections" instruction injected
  //   >180k tokens  → hard reject with size_exceeded (not 'failed') + clear user message
  //
  // We never silently fail large tenders — the user must know why and what to do.
  let pdfSizeWarning = null;
  if (pdfDocs && pdfDocs.length) {
    const { totalBytes, estimatedTokens } = estimatePdfTokens(pdfDocs);
    if (estimatedTokens > MAX_PDF_TOKENS) {
      console.warn('TL callClaude — PDF too large:', estimatedTokens, 'est. tokens,', pdfDocs.length, 'docs');
      return {
        success: false,
        size_exceeded: true,
        reason: `This tender document is too large for a single analysis run (estimated ${Math.round(estimatedTokens/1000)}k tokens across ${pdfDocs.length} document${pdfDocs.length>1?'s':''}). To proceed: upload only the key sections — the Scope of Work, Evaluation Criteria, Pricing Schedule, and Mandatory Requirements. Skip the General Conditions of Contract (MBD 16) and other standard boilerplate sections. You will not be charged for this run.`,
        estimated_tokens: estimatedTokens,
        total_bytes: totalBytes
      };
    }
    if (estimatedTokens > MAX_SAFE_PDF_TOKENS) {
      // Large but within limit — inject a focusing instruction
      console.warn('TL callClaude — large tender warning:', estimatedTokens, 'est. tokens. Injecting focus instruction.');
      pdfSizeWarning = `NOTE: This is a large tender document (estimated ${Math.round(estimatedTokens/1000)}k tokens). Focus your analysis on: (1) the Scope of Work and technical requirements, (2) the Evaluation Criteria and scoring, (3) the Pricing Schedule and mandatory rates, (4) the Special Conditions and mandatory compliance requirements. You may summarise or skip the standard General Conditions of Contract boilerplate (GCC/MBD 16) — these are standard across all SA government tenders and do not affect the eligibility assessment.`;
    }
  }

  // ── Build user content — PDFs + prompt ─────────────────────────────────
  const finalPrompt = pdfSizeWarning ? `${fullPrompt}\n\n${pdfSizeWarning}` : fullPrompt;
  const userContent = pdfDocs && pdfDocs.length
    ? [...pdfDocs.map(d => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } })), { type: 'text', text: finalPrompt }]
    : finalPrompt;

  // ── CUT 1: tool_choice forced schema ────────────────────────────────────
  // Instead of appending schema to prompt and regex-parsing text output,
  // pass schema as a tool with tool_choice: forced. Anthropic enforces the
  // schema at the API level — response comes back in content[0].input as a
  // parsed object. No JSON.parse, no markdown fence stripping, no regex.
  //
  // Only applies when schemaText is provided (not callClaudeSimple).
  // appendSchemaInstruction=true means caller already handled schema in prompt
  // (bidpack call2 prose) — skip tool_choice for those.
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: userContent }]
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('TL v2 callClaude — Anthropic API error:', aiRes.status, 'response:', errBody.slice(0,500));
      return { success: false, reason: `Anthropic API returned ${aiRes.status}: ${errBody.slice(0,200)}` };
    }

    const aiData = await aiRes.json();
    const stopReason = aiData.stop_reason;

    // ── TOKEN TRACKING ───────────────────────────────────────────────────
    const inputTokens  = aiData.usage?.input_tokens  || 0;
    const outputTokens = aiData.usage?.output_tokens || 0;
    const costUsd      = (inputTokens * COST_INPUT_PER_TOKEN) + (outputTokens * COST_OUTPUT_PER_TOKEN);

    const rawText = aiData.content?.[0]?.text || '';
    if (!rawText) {
      console.error('TL v2 callClaude — empty response. stop_reason:', stopReason);
      return { success: false, reason: 'Empty response from analysis engine' };
    }

    let data;
    try {
      data = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      console.error('TL v2 callClaude — JSON parse failed. stop_reason:', stopReason, 'raw (800 chars):', rawText.slice(0,800));
      const reason = stopReason === 'max_tokens'
        ? 'The analysis exceeded the response size limit before completing. Please try again.'
        : 'Could not parse analysis result';
      return { success: false, reason };
    }

    return { success: true, data, inputTokens, outputTokens, costUsd };
  } catch(e) {
    console.error('TL v2 callClaude — exception:', e.message);
    return { success: false, reason: e.message };
  }
}

// ── SIMPLE CALL — plain text in, plain text out. No JSON schema, no
// forced structure, no parse step that can fail. This is deliberately the
// "what does a free chat interface do" version — the absolute minimum
// distance between prompt and answer. Used for bidpack's submission
// document specifically, since that step has no reason to be structured
// JSON at all — it's just prose, and prose doesn't need to parse.
async function callClaudeSimple(env, pdfDocs, promptText, maxTokens) {
  const userContent = pdfDocs.length
    ? [...pdfDocs.map(d => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } })), { type: 'text', text: promptText }]
    : promptText;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content: userContent }] }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('TL v2 callClaudeSimple — Anthropic API error:', aiRes.status, 'response:', errBody.slice(0,500));
      return { success: false, reason: `Anthropic API returned ${aiRes.status}` };
    }

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text || '';

    if (!text) {
      console.error('TL v2 callClaudeSimple — empty response. stop_reason:', aiData.stop_reason);
      return { success: false, reason: 'Empty response from analysis engine' };
    }

    // No JSON.parse. No schema validation. The text IS the answer.
    return { success: true, text, inputTokens, outputTokens, costUsd };
  } catch(e) {
    console.error('TL v2 callClaudeSimple — exception:', e.message);
    return { success: false, reason: e.message };
  }
}

// ── ANALYSIS — one focused prompt per product, genuinely distinct ────────

// ── TWO-PASS ANALYSIS FOR LARGE TENDERS ─────────────────────────────────────
// Pass 1: PDFs attached, skeleton extraction (cheap, ~2k output tokens)
// Pass 2: skeleton as text context, full analysis (no PDFs re-attached, ~20k input)
// Net: ~80% input token reduction for 100k-180k tenders vs single-pass.
async function callClaudeTwoPass(env, pdfDocs, promptText, schemaText, maxTokens) {
  // Kimi K2.5 has a 262k context window — no need for two-pass skeleton extraction.
  // Route directly to callClaude which handles the full PDF in one pass.
  console.log('TL callClaudeTwoPass — routing to single-pass (Kimi 262k context)');
  return callClaude(env, pdfDocs, promptText, schemaText, maxTokens, false);
}


