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

const V2_PRICES = { gonogo: 100, pricing: 750, bidpack: 2500 };
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

  if (path === '/tl/v2/tender/upload' && method === 'POST') return handleTenderUpload(request, env, tlJson);
  if (path === '/tl/v2/tender' && method === 'GET') return handleGetTender(url, env, tlJson);
  if (path === '/tl/v2/tenders' && method === 'GET') return handleListTenders(url, env, tlJson);

  if (path === '/tl/v2/product/run' && method === 'POST') return handleRunProduct(request, env, tlJson);
  if (path === '/tl/v2/product-run' && method === 'GET') return handleGetProductRun(url, env, tlJson);

  if (path === '/tl/v2/free-trials' && method === 'GET') return handleGetFreeTrials(url, env, tlJson);

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
    { "filename_guess": "string", "reference_found": true | false, "different_reference_found": "string or null", "likely_annexure": true | false, "concern_level": "NONE" | "LOW" | "HIGH" }
  ]
}

Return ONLY valid JSON, no markdown, no explanation.`;

  const userContent = [
    ...pdfDocs.map(d => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } })),
    { type: 'text', text: prompt },
  ];

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: userContent }] }),
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
  for (let i = 0; i < pdfDocs.length; i++) {
    const docKey = `tenders/${company_id}/${id}/doc-${i}-${pdfDocs[i].filename.replace(/[^a-zA-Z0-9.\-]/g, '_')}`;
    await env.TL_DOCS.put(docKey, pdfDocs[i].buffer, { httpMetadata: { contentType: 'application/pdf' } });
    docKeys.push(docKey);
  }

  // Charge AFTER successful storage (storage can't really "fail" the way
  // analysis can, but staying consistent with the charge-after-success
  // principle established throughout this build)
  if (!isFreeTrial && price > 0) {
    await env.TL_DB.prepare('UPDATE tl_companies SET balance=balance-? WHERE id=?').bind(price, company_id).run();
    await env.TL_DB.prepare(`INSERT INTO tl_credits (id, company_id, amount, type) VALUES (?,?,?,'used')`)
      .bind(crypto.randomUUID(), company_id, -price).run();
  }

  await env.TL_DB.prepare(`
    INSERT INTO tl_tenders (id, company_id, tender_ref, doc_r2_keys, document_count, amount_paid)
    VALUES (?,?,?,?,?,?)
  `).bind(id, company_id, tender_ref, JSON.stringify(docKeys), files.length, isFreeTrial ? 0 : price).run();

  if (isFreeTrial) {
    await markFreeTrialUsed(env, company_id, 'upload', id);
  }

  return tlJson({ success: true, tender_id: id, document_count: files.length, charged: isFreeTrial ? 0 : price, was_free_trial: isFreeTrial });
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

// ── QUEUE CONSUMER — runs the actual Claude analysis for one product ─────
// Exported, called from the main Worker's queue() handler for type='tl_v2_run'.
export async function processTlV2QueueMessage(msg, env) {
  const { productRunId, tenderId, companyId, product, chargeAmount, isFreeTrial } = msg;

  const tender = await env.TL_DB.prepare('SELECT * FROM tl_tenders WHERE id=? LIMIT 1').bind(tenderId).first();
  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(companyId).first();

  if (!tender || !company) {
    console.error('TL v2 queue — tender or company not found. run:', productRunId, 'tender:', tenderId, 'company:', companyId);
    await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
    return;
  }

  await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='processing' WHERE id=?`).bind(productRunId).run();

  // ── Read all documents for this tender from R2 ──
  let docKeys = [];
  try { docKeys = JSON.parse(tender.doc_r2_keys || '[]'); } catch(e) {}

  const pdfDocs = [];
  for (const key of docKeys) {
    const obj = await env.TL_DOCS.get(key);
    if (obj) {
      const buf = await obj.arrayBuffer();
      pdfDocs.push({ base64: arrayBufferToBase64(buf), filename: key.split('/').pop() });
    }
  }

  if (!pdfDocs.length) {
    console.error('TL v2 queue — no documents found for tender:', tenderId, 'run:', productRunId);
    await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
    return;
  }

  const result = await runV2Product(productRunId, company, pdfDocs, product, env);

  if (!result.success) {
    console.error('TL v2 queue — product run failed:', productRunId, 'product:', product, 'reason:', result.reason);
    // status already set to 'failed' inside runV2Product — no charge happens.
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

// ── ANALYSIS — one focused prompt per product, genuinely distinct ────────
async function runV2Product(productRunId, company, pdfDocs, product, env) {
  try {
    const companyContext = await buildCompanyContext(company, env);

    let prompt, schema, maxTokens;

    if (product === 'gonogo') {
      maxTokens = 3072;
      prompt = `You are a South African tender bid intelligence analyst. Your single most important job is CREDIBILITY, not sales — clients return because verdicts are honest, not because they're positive.

NON-NEGOTIABLE PRINCIPLES:
1. NO ARTIFICIAL OPTIMISM OR PESSIMISM. Say NO_GO plainly when there's no realistic path. Say GO with confidence when well-positioned.
2. WHEN GENUINELY CLOSE, say CONDITIONAL_GO and give specific, concrete actions that would tip the odds — not vague advice.
3. MISSING PROFILE DATA IS NOT A GUESS — mark eligibility items UNKNOWN rather than assume.
4. EVERY NO_GO INCLUDES A PATH FORWARD WHERE ONE GENUINELY EXISTS — what would make THIS company eligible for similar tenders in future.
5. IF THE DOCUMENT IS ILLEGIBLE, INCOMPLETE, OR NOT A TENDER, say so directly rather than producing a confident-sounding report from insufficient information.

COMPANY PROFILE:
${companyContext}

TENDER DOCUMENT(S): ${pdfDocs.length} file(s) attached — treat as one combined tender pack.`;

      schema = `{
  "tender_title": "string — actual title/name of this tender. Never generic like 'Tender Document'.",
  "tender_reference": "string or null",
  "verdict": "GO" | "NO_GO" | "CONDITIONAL_GO",
  "verdict_summary": "2-3 sentence summary",
  "eligibility": [ { "requirement": "string", "detail": "string", "status": "MET" | "UNMET" | "UNKNOWN", "notes": "string" } ],
  "compliance_checklist": [ { "item": "string", "risk_level": "HIGH" | "MEDIUM" | "LOW", "notes": "string" } ],
  "risk_flags": [ { "flag": "string", "severity": "HIGH" | "MEDIUM" | "LOW", "mitigation": "string" } ],
  "edge_recommendations": [ { "action": "string", "impact": "string", "timeframe": "string" } ],
  "future_readiness": "string or null"
}`;

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
  "boq": [ { "line_item": "string", "unit": "string", "quantity": number, "unit_rate": number, "total": number, "confidence": "HIGH" | "MEDIUM" | "LOW", "source": "string" } ],
  "boq_totals": { "subtotal": number, "margin_30pct": number, "recommended_bid": number, "conservative_bid": number, "aggressive_bid": number },
  "competitive_landscape": "full paragraph — pricing structure, typical bidders, what wins on price vs preference points",
  "pricing_disclaimer": "string — standard disclaimer about indicative pricing, sources used, verify before submission"
}`;

    } else { // bidpack
      maxTokens = 6144;
      prompt = `You are preparing a submission-ready bid pack for a South African government tender. The client has ALREADY DECIDED to bid — your job is to build the strongest possible submission kit. Do NOT second-guess whether they should bid, do NOT produce a "notice of non-submission" or similar — that is not your role. Assume submission intent is final; focus entirely on making that submission as complete and compelling as possible.

COMPANY PROFILE:
${companyContext}

TENDER DOCUMENT(S): ${pdfDocs.length} file(s) attached.

Produce: a full priced BOQ (same standards as the pricing product — use gazetted rates where specified, flag confidence honestly), a compliance checklist of everything needed for submission, and a formatted, professional cover letter / submission document written in the company's voice, referencing their specific profile, ready to attach to the bid.`;

      schema = `{
  "tender_title": "string",
  "tender_reference": "string or null",
  "compliance_checklist": [ { "item": "string", "status": "string", "notes": "string" } ],
  "boq": [ { "line_item": "string", "unit": "string", "quantity": number, "unit_rate": number, "total": number, "confidence": "HIGH" | "MEDIUM" | "LOW", "source": "string" } ],
  "boq_totals": { "subtotal": number, "margin_30pct": number, "recommended_bid": number },
  "submission_document": "string — full formatted cover letter / submission document in markdown, written and ready to attach",
  "pricing_disclaimer": "string"
}`;
    }

    const fullPrompt = `${prompt}\n\nReturn ONLY this JSON structure:\n${schema}\n\nReturn ONLY valid JSON. No markdown fencing. No explanation outside the JSON.`;

    const userContent = [
      ...pdfDocs.map(d => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } })),
      { type: 'text', text: fullPrompt },
    ];

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens, messages: [{ role: 'user', content: userContent }] }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('TL v2 — Anthropic API error:', aiRes.status, 'run:', productRunId, 'product:', product, 'response:', errBody.slice(0,500));
      await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
      return { success: false, reason: `Anthropic API returned ${aiRes.status}` };
    }

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '';
    const stopReason = aiData.stop_reason;

    if (!rawText) {
      console.error('TL v2 — empty response. run:', productRunId, 'product:', product, 'stop_reason:', stopReason);
      await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
      return { success: false, reason: 'Empty response from analysis engine' };
    }

    let report;
    try {
      report = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      console.error('TL v2 — JSON parse failed. run:', productRunId, 'product:', product, 'stop_reason:', stopReason, 'raw (800 chars):', rawText.slice(0,800));
      await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
      const reason = stopReason === 'max_tokens'
        ? 'The analysis exceeded the response size limit before completing. Please try again.'
        : 'Could not parse analysis result';
      return { success: false, reason };
    }

    // Validation differs per product — gonogo MUST have a valid verdict;
    // pricing/bidpack must NOT have a verdict field at all (proves the
    // prompt boundary held) and must have boq data.
    if (product === 'gonogo' && (!report.verdict || !['GO','NO_GO','CONDITIONAL_GO'].includes(report.verdict))) {
      console.error('TL v2 — gonogo missing valid verdict. run:', productRunId, 'parsed:', JSON.stringify(report).slice(0,500));
      await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
      return { success: false, reason: 'Analysis did not produce a valid verdict' };
    }
    if ((product === 'pricing' || product === 'bidpack') && (!report.boq || !Array.isArray(report.boq))) {
      console.error('TL v2 —', product, 'missing BOQ data. run:', productRunId, 'parsed:', JSON.stringify(report).slice(0,500));
      await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
      return { success: false, reason: 'Analysis did not produce pricing data' };
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

    await env.TL_DB.prepare(`
      UPDATE tl_product_runs SET status='complete', verdict=?, report_r2_key=?, report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(report.verdict || null, reportKey, JSON.stringify(report), productRunId).run();

    return { success: true };

  } catch(e) {
    console.error('TL v2 — analysis error:', e.message, 'run:', productRunId, 'product:', product);
    await env.TL_DB.prepare(`UPDATE tl_product_runs SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(productRunId).run();
    return { success: false, reason: e.message };
  }
}

// ── Build company context including verified compliance docs — same logic as v1 ──
async function buildCompanyContext(company, env) {
  const verifiedDocs = await env.TL_DB.prepare(`
    SELECT cd.*, dt.name as doc_name FROM tl_compliance_documents cd
    JOIN tl_doc_types dt ON cd.doc_type_id = dt.id
    WHERE cd.company_id = ?
  `).bind(company.id).all();

  const verifiedByType = {};
  (verifiedDocs.results || []).forEach(d => { verifiedByType[d.doc_type_id] = d; });

  function complianceLine(typeId, label, selfReportedValue) {
    const v = verifiedByType[typeId];
    if (v && v.status !== 'red') {
      const expiryNote = v.expiry_date ? `, valid until ${v.expiry_date}` : '';
      return `${label}: ${v.extracted_value || 'Confirmed'} — VERIFIED via uploaded certificate${expiryNote} [status: ${v.status.toUpperCase()}]`;
    }
    if (v && v.status === 'red') {
      const expiredNote = v.expiry_date ? ` (expired ${v.expiry_date})` : '';
      return `${label}: EXPIRED${expiredNote} — uploaded certificate is no longer valid. Treat as UNMET until renewed.`;
    }
    return `${label}: ${selfReportedValue || 'Not specified'} — SELF-REPORTED, NOT VERIFIED.`;
  }

  return `
Company: ${company.name}
Industries: ${company.industries}
Provinces: ${company.provinces}
Years experience: ${company.years_experience}
Annual turnover: R${(company.annual_turnover||0).toLocaleString()}
Employees: ${company.employees}
${complianceLine('cidb', 'CIDB Grade', company.cidb_grade)}
${complianceLine('bee', 'B-BBEE Level', company.bee_level ? `Level ${company.bee_level}` : null)}
${complianceLine('csd', 'CSD Registration', company.csd_maaa ? 'Registered' : null)}

IMPORTANT: Lines marked VERIFIED come from an actual uploaded certificate — treat as fact. SELF-REPORTED/NOT VERIFIED lines have not been confirmed. EXPIRED lines are a current compliance gap.
`;
}
