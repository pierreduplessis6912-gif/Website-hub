// ── TENDER LOGIX HANDLER ─────────────────────────────────────
// Routes all tenderlogix.co.za requests
//
// PRICING MODEL — per submission, ceiling R2,500:
//   gonogo  — R20   — verdict, eligibility, compliance, risks, future readiness, ONE edge tip
//   pricing — R750  — adds full priced BOQ, full competitive landscape, full edge recommendations
//   bidpack — R2500 — adds formatted submission document
// Each tier upgrade charges (tier_price - amount_paid) on that SAME submission.
// Balance is rand sitting on the account, drawn down first; PayFast covers the shortfall.

import { buildPayFastLink, isTestMode } from './shared-services.js';

const TIER_PRICES = { gonogo: 20, pricing: 750, bidpack: 2500 };

export async function handleTenderLogix(request, env) {
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

  // ── ROUTES ──────────────────────────────────────────────────
  if (path === '/health') return tlJson({ status: 'ok', service: 'tenderlogix' });

  if (path === '/tl/company' && method === 'POST') return handleTlCreateCompany(request, env, tlJson);
  if (path === '/tl/company' && method === 'GET')  return handleTlGetCompany(url, env, tlJson);
  if (path === '/tl/company/update' && method === 'POST') return handleTlUpdateCompany(request, env, tlJson);

  if (path === '/tl/submission'  && method === 'GET')  return handleTlGetSubmission(url, env, tlJson);
  if (path === '/tl/submissions' && method === 'GET')  return handleTlListSubmissions(url, env, tlJson);

  if (path === '/tl/analyse' && method === 'POST') {
    try { return await handleTlAnalyse(request, env, tlJson); }
    catch(e) { console.error('UNCAUGHT in handleTlAnalyse:', e.message, e.stack?.slice(0,500)); return tlJson({ error: `Unexpected error: ${e.message}. You have NOT been charged.`, retry_safe: true }, 500); }
  }
  if (path === '/tl/upload'  && method === 'POST') {
    try { return await handleTlUpload(request, env, tlJson); }
    catch(e) { console.error('UNCAUGHT in handleTlUpload:', e.message, e.stack?.slice(0,500)); return tlJson({ error: `Unexpected error: ${e.message}. You have NOT been charged.`, retry_safe: true }, 500); }
  }
  if (path === '/tl/upgrade' && method === 'POST') {
    try { return await handleTlUpgrade(request, env, tlJson); }
    catch(e) { console.error('UNCAUGHT in handleTlUpgrade:', e.message, e.stack?.slice(0,500)); return tlJson({ error: `Unexpected error: ${e.message}. You have NOT been charged for this upgrade.`, retry_safe: true }, 500); }
  }
  if (path === '/tl/add-documents' && method === 'POST') {
    try { return await handleTlAddDocuments(request, env, tlJson); }
    catch(e) { console.error('UNCAUGHT in handleTlAddDocuments:', e.message, e.stack?.slice(0,500)); return tlJson({ error: `Unexpected error: ${e.message}. You have NOT been charged.`, retry_safe: true }, 500); }
  }

  // ── Compliance documents ──────────────────────────────────────
  if (path === '/tl/vault/status' && method === 'GET') {
    const company_id = url.searchParams.get('company_id');
    if (!company_id) return tlJson({ error: 'company_id required' }, 400);
    const hasAccess = await checkVaultSubscription(env, company_id);
    return tlJson({ company_id, vault_active: hasAccess, price: 'R99/month' });
  }
  if (path === '/tl/compliance/requirements' && method === 'GET')  return handleTlComplianceRequirements(url, env, tlJson);
  if (path === '/tl/compliance/upload'       && method === 'POST') return handleTlComplianceUpload(request, env, tlJson);
  if (path === '/tl/compliance/flag-missing' && method === 'POST') return handleTlComplianceFlagMissing(request, env, tlJson);
  if (path === '/tl/compliance/document' && method === 'GET') return handleTlComplianceDocumentDownload(url, env);

  if (path === '/tl/balance' && method === 'GET')  return handleTlGetBalance(url, env, tlJson);
  if (path === '/tl/payfast-webhook' && method === 'POST') return handleTlPayfast(request, env, tlJson);
  if (path === '/tl/vault/subscribe' && method === 'POST') return handleVaultSubscribe(request, env, tlJson);

  // ── Static pages ─────────────────────────────────────────────
  if (path === '/' || path === '') {
    const landing = await env.SITES.get('app:tl-landing').catch(() => null);
    if (landing) return new Response(landing, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
  if (path === '/register') {
    const intake = await env.SITES.get('app:tl-intake').catch(() => null);
    if (intake) return new Response(intake, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }
  if (path.startsWith('/dashboard')) {
    const dashboard = await env.SITES.get('app:tl-dashboard').catch(() => null);
    if (dashboard) return new Response(dashboard, { headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
  }

  return tlJson({ error: 'Not found' }, 404);
}

// ── CREATE COMPANY PROFILE ──────────────────────────────────────
async function handleTlCreateCompany(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { name, reg_number, tax_number, vat_number, csd_maaa, bee_level,
          cidb_grade, cidb_number, industries, provinces, years_experience,
          annual_turnover, employees, phone, email, address, client_name, free_credits } = body;

  if (!name || !phone || !email) return tlJson({ error: 'name, phone and email required' }, 400);

  const normalisedPhone = (phone || '').replace(/\D/g, '');
  const normalisedEmail = (email || '').trim().toLowerCase();

  // ── Duplicate prevention — one company per phone/email/reg_number ──────
  const existing = await env.TL_DB.prepare(
    `SELECT id, name FROM tl_companies WHERE phone=? OR LOWER(email)=? ${reg_number ? 'OR reg_number=?' : ''} LIMIT 1`
  ).bind(...(reg_number ? [normalisedPhone, normalisedEmail, reg_number] : [normalisedPhone, normalisedEmail])).first();

  if (existing) {
    return tlJson({ error: 'An account already exists for this phone, email or registration number.', existing_company_id: existing.id }, 409);
  }

  // ── Complete-profile gate — R100 free balance, prevents freebie farming ──
  const hasCompleteProfile = !!(reg_number && industries?.length && provinces?.length);
  const startingBalance = (free_credits && hasCompleteProfile) ? 100 : 0;

  const id = crypto.randomUUID();
  await env.TL_DB.prepare(`
    INSERT INTO tl_companies (id, name, reg_number, tax_number, vat_number, csd_maaa,
      bee_level, cidb_grade, cidb_number, industries, provinces, years_experience,
      annual_turnover, employees, phone, email, address, client_name, balance, credits)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
  `).bind(id, name, reg_number||null, tax_number||null, vat_number||null, csd_maaa||null,
    bee_level||null, cidb_grade||null, cidb_number||null,
    JSON.stringify(industries||[]), JSON.stringify(provinces||[]),
    years_experience||0, annual_turnover||0, employees||0,
    normalisedPhone, normalisedEmail, address||null, client_name||null, startingBalance
  ).run();

  const message = free_credits && !hasCompleteProfile
    ? 'Account created. Add your registration number and at least one industry + province to unlock R100 free balance.'
    : null;

  return tlJson({ success: true, company_id: id, balance: startingBalance, message });
}

// ── GET COMPANY PROFILE ──────────────────────────────────────────
async function handleTlGetCompany(url, env, tlJson) {
  const id = url.searchParams.get('id');
  if (!id) return tlJson({ error: 'id required' }, 400);
  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);
  return tlJson(company);
}

// ── UPDATE COMPANY PROFILE ────────────────────────────────────────
// Distinct from create — no duplicate-prevention check (it's the SAME
// company being edited), and balance/credits are never touched here.
async function handleTlUpdateCompany(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id, name, reg_number, tax_number, vat_number, csd_maaa, bee_level,
          cidb_grade, cidb_number, industries, provinces, years_experience,
          annual_turnover, employees, phone, email, address, client_name } = body;

  if (!company_id) return tlJson({ error: 'company_id required' }, 400);

  const existing = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!existing) return tlJson({ error: 'Company not found' }, 404);

  const normalisedPhone = phone ? phone.replace(/\D/g, '') : existing.phone;
  const normalisedEmail = email ? email.trim().toLowerCase() : existing.email;

  // If phone or email is changing, make sure it doesn't collide with a DIFFERENT company
  if (normalisedPhone !== existing.phone || normalisedEmail !== existing.email) {
    const conflict = await env.TL_DB.prepare(
      'SELECT id FROM tl_companies WHERE (phone=? OR LOWER(email)=?) AND id != ? LIMIT 1'
    ).bind(normalisedPhone, normalisedEmail, company_id).first();
    if (conflict) return tlJson({ error: 'That phone or email is already used by a different account.' }, 409);
  }

  await env.TL_DB.prepare(`
    UPDATE tl_companies SET
      name=?, reg_number=?, tax_number=?, vat_number=?, csd_maaa=?, bee_level=?,
      cidb_grade=?, cidb_number=?, industries=?, provinces=?, years_experience=?,
      annual_turnover=?, employees=?, phone=?, email=?, address=?, client_name=?,
      updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).bind(
    name ?? existing.name, reg_number ?? existing.reg_number, tax_number ?? existing.tax_number,
    vat_number ?? existing.vat_number, csd_maaa ?? existing.csd_maaa, bee_level ?? existing.bee_level,
    cidb_grade ?? existing.cidb_grade, cidb_number ?? existing.cidb_number,
    industries ? JSON.stringify(industries) : existing.industries,
    provinces ? JSON.stringify(provinces) : existing.provinces,
    years_experience ?? existing.years_experience, annual_turnover ?? existing.annual_turnover,
    employees ?? existing.employees, normalisedPhone, normalisedEmail,
    address ?? existing.address, client_name ?? existing.client_name, company_id
  ).run();

  return tlJson({ success: true, company_id });
}

// ── GET BALANCE ──────────────────────────────────────────────────
async function handleTlGetBalance(url, env, tlJson) {
  const company_id = url.searchParams.get('company_id');
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);
  const company = await env.TL_DB.prepare('SELECT balance FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);
  return tlJson({ balance: company.balance || 0 });
}

// ── SPEND HELPER — draws down balance, returns shortfall to charge via PayFast ──
async function spendFromBalance(env, company_id, amount) {
  const company = await env.TL_DB.prepare('SELECT balance FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  const balance = company?.balance || 0;
  const fromBalance = Math.min(balance, amount);
  const shortfall = amount - fromBalance;
  if (fromBalance > 0) {
    await env.TL_DB.prepare('UPDATE tl_companies SET balance=balance-? WHERE id=?').bind(fromBalance, company_id).run();
    await env.TL_DB.prepare(`INSERT INTO tl_credits (id, company_id, amount, type) VALUES (?,?,?,'used')`)
      .bind(crypto.randomUUID(), company_id, -fromBalance).run();
  }
  return { fromBalance, shortfall };
}

// ── ANALYSE ENDPOINT (pasted text — Go/No-Go tier only) ──────────
async function handleTlAnalyse(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id, doc_text, tender_ref } = body;
  if (!company_id || !doc_text) return tlJson({ error: 'company_id and doc_text required' }, 400);

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  const price = TIER_PRICES.gonogo;
  if ((company.balance || 0) < price) {
    const shortfall = price - (company.balance || 0);
    return tlJson({ error: `Insufficient balance. This costs R${price} — you have R${company.balance||0}. Top up R${shortfall} to continue.`, shortfall }, 402);
  }

  const id = crypto.randomUUID();
  // Store the pasted text in R2 so the queue consumer can read it the same way
  // as PDF-based submissions — keeps queue messages small and the read path uniform.
  const docKey = `submissions/${company_id}/${id}/pasted-text.txt`;
  await env.TL_DOCS.put(docKey, doc_text);

  await env.TL_DB.prepare(`INSERT INTO tl_submissions (id, company_id, tender_ref, doc_r2_key, status, tier, amount_paid) VALUES (?,?,?,?,'queued','gonogo',0)`)
    .bind(id, company_id, tender_ref||null, docKey).run();

  await env.BUILD_QUEUE.send({
    type: 'tl_analyse',
    submissionId: id,
    companyId: company_id,
    tier: 'gonogo',
    chargeAmount: price,
  });

  return tlJson({ submission_id: id, status: 'queued' });
}

// ── PDF UPLOAD ENDPOINT (native Claude PDF — Go/No-Go tier) ──────
// Helper — convert an ArrayBuffer to base64 in chunks (avoids call-stack overflow on large files)
function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// ── DOCUMENT VAULT — subscription check ───────────────────────────────────
// Returns true only if the company has a row with status='active' AND
// current_period_end is still in the future. No row, or an expired/
// cancelled/past_due status, correctly returns false — fails closed.
export async function checkVaultSubscription(env, company_id) {
  const sub = await env.TL_DB.prepare(
    `SELECT status, current_period_end FROM tl_vault_subscriptions WHERE company_id=? LIMIT 1`
  ).bind(company_id).first();
  if (!sub) return false;
  if (sub.status !== 'active') return false;
  if (!sub.current_period_end) return false;
  return new Date(sub.current_period_end) > new Date();
}

// ── REFERENCE GATE CHECK — confirms multi-document uploads belong to ONE tender ──
// Cheap, fast Claude call: does the given reference appear in each document?
// Returns { passed: bool, mismatched: [{filename, reason}] }
async function checkReferenceGate(pdfDocs, tender_ref, env) {
  if (pdfDocs.length <= 1 || !tender_ref) {
    return { passed: true, mismatched: [] }; // gate only applies to multi-doc submissions
  }

  const prompt = `You are checking whether a set of PDF documents all belong to the same tender, identified by reference "${tender_ref}".

For EACH document attached (in the order given), answer:
- Does the reference "${tender_ref}" appear anywhere in this document? (yes/no)
- If no, does the document contain a DIFFERENT tender/RFQ reference number? If so, what is it?
- If no reference appears at all, does this look like a standard supporting annexure (drawing, photo, spreadsheet export, generic form) where an absent reference is normal and not a concern?

Return ONLY this JSON, one entry per document in the same order they were attached:
{
  "documents": [
    { "filename_guess": "string — your best guess at what this document is, e.g. 'Main RFQ', 'SBD4 form', 'BOQ annexure'", "reference_found": true | false, "different_reference_found": "string or null — only if a DIFFERENT tender reference was found", "likely_annexure": true | false, "concern_level": "NONE" | "LOW" | "HIGH" }
  ]
}

concern_level guide:
- NONE: reference found, or no reference but clearly a normal supporting annexure
- LOW: no reference found and unclear what the document is — minor concern, allow with a soft warning
- HIGH: a DIFFERENT tender reference was found — this strongly suggests the wrong document was included

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
    console.warn('Reference gate check failed, allowing through:', e.message);
    return { passed: true, mismatched: [] }; // fail open — don't block submissions on our own check failing
  }
}

async function handleTlUpload(request, env, tlJson) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return tlJson({ error: 'multipart/form-data required' }, 400);
  }

  const form = await request.formData();
  const company_id = form.get('company_id');
  const tender_ref  = form.get('tender_ref') || null;
  const overrideGate = form.get('override_gate') === 'true';

  // Support both 'files' (multi) and legacy 'file' (single) field names
  let files = form.getAll('files');
  if (!files.length) {
    const single = form.get('file');
    if (single) files = [single];
  }

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

  const price = TIER_PRICES.gonogo * files.length;
  if ((company.balance || 0) < price) {
    const shortfall = price - (company.balance || 0);
    return tlJson({ error: `This costs R${price} (${files.length} document${files.length>1?'s':''} × R20) — you have R${company.balance||0}. Top up R${shortfall} to continue.`, shortfall }, 402);
  }

  // Read all files into base64 once — reused for both gate check and the queued analysis
  const pdfDocs = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    pdfDocs.push({ base64: arrayBufferToBase64(buf), filename: f.name, buffer: buf });
  }

  // ── Reference gate check — fast, runs synchronously before queueing ──
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

  // ── Gate passed — store documents in R2 (fast), create a QUEUED submission, hand off the actual analysis ──
  const id = crypto.randomUUID();
  const docKeys = [];
  for (let i = 0; i < pdfDocs.length; i++) {
    const docKey = `submissions/${company_id}/${id}/doc-${i}-${pdfDocs[i].filename.replace(/[^a-zA-Z0-9.\-]/g, '_')}`;
    await env.TL_DOCS.put(docKey, pdfDocs[i].buffer, { httpMetadata: { contentType: 'application/pdf' } });
    docKeys.push(docKey);
  }

  await env.TL_DB.prepare(`
    INSERT INTO tl_submissions (id, company_id, tender_ref, doc_r2_key, doc_r2_keys, status, tier, amount_paid)
    VALUES (?,?,?,?,?,'queued','gonogo',0)
  `).bind(id, company_id, tender_ref, docKeys[0], JSON.stringify(docKeys)).run();

  // Analysis runs in the background queue consumer — NOT in this HTTP request.
  // This is the fix for large/slow documents hitting Cloudflare's synchronous
  // execution time limit. The queue consumer has a much more generous allowance
  // and charging still only happens there once a real verdict is confirmed.
  await env.BUILD_QUEUE.send({
    type: 'tl_analyse',
    submissionId: id,
    companyId: company_id,
    tier: 'gonogo',
    chargeAmount: price,
  });

  return tlJson({ success: true, submission_id: id, status: 'queued', document_count: files.length });
}

// ── UPGRADE ENDPOINT — re-run an existing submission at a richer tier ──
// Charges (tier_price - amount_already_paid) on THIS submission only.
async function handleTlUpgrade(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { submission_id, tier } = body;
  if (!submission_id || !tier) return tlJson({ error: 'submission_id and tier required' }, 400);
  if (!TIER_PRICES[tier]) return tlJson({ error: 'tier must be pricing or bidpack' }, 400);

  const sub = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(submission_id).first();
  if (!sub) return tlJson({ error: 'Submission not found' }, 404);

  const tierOrder = ['gonogo', 'pricing', 'bidpack'];
  if (tierOrder.indexOf(tier) <= tierOrder.indexOf(sub.tier || 'gonogo')) {
    return tlJson({ error: `This submission is already at ${sub.tier} tier or higher` }, 400);
  }

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(sub.company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  const targetPrice = TIER_PRICES[tier];
  const alreadyPaid = sub.amount_paid || 0;
  const owed = Math.max(0, targetPrice - alreadyPaid);

  if ((company.balance || 0) < owed) {
    const shortfall = owed - (company.balance || 0);
    return tlJson({
      error: `Upgrading to ${tier} costs R${owed} (R${targetPrice} total, R${alreadyPaid} already paid on this tender). You have R${company.balance||0}. Top up R${shortfall} to continue.`,
      shortfall, owed, target_price: targetPrice, already_paid: alreadyPaid,
    }, 402);
  }

  await env.TL_DB.prepare(`UPDATE tl_submissions SET status='queued' WHERE id=?`).bind(submission_id).run();

  // Document re-fetch from R2 and the actual analysis now happen in the queue
  // consumer — see processTlQueueMessage. This keeps the upgrade request itself
  // fast and avoids the synchronous execution time limit that bit large documents.
  await env.BUILD_QUEUE.send({
    type: 'tl_analyse',
    submissionId: submission_id,
    companyId: sub.company_id,
    tier,
    chargeAmount: owed,
    isUpgrade: true,
    previousTier: sub.tier || 'gonogo',
  });

  return tlJson({ success: true, submission_id, status: 'queued' });
}

// ── ADD DOCUMENTS — attach more PDFs to an EXISTING submission, at ANY tier ──
// R20 per document regardless of tier, charged immediately (separate from tier upgrade
// pricing). Runs the same reference gate check as initial upload. Re-runs analysis at
// the submission's CURRENT tier — does not force a tier upgrade just because documents
// were added; client must call /tl/upgrade separately for that.
async function handleTlAddDocuments(request, env, tlJson) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return tlJson({ error: 'multipart/form-data required' }, 400);
  }

  const form = await request.formData();
  const submission_id = form.get('submission_id');
  const overrideGate   = form.get('override_gate') === 'true';
  const files          = form.getAll('files');

  if (!submission_id || !files.length) return tlJson({ error: 'submission_id and at least one file required' }, 400);

  for (const f of files) {
    if (f.type !== 'application/pdf') return tlJson({ error: `"${f.name}" is not a PDF. Only PDF files are supported.` }, 400);
    if (f.size > 32 * 1024 * 1024) return tlJson({ error: `"${f.name}" is over 32MB.` }, 400);
  }

  const sub = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(submission_id).first();
  if (!sub) return tlJson({ error: 'Submission not found' }, 404);

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(sub.company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  const addPrice = TIER_PRICES.gonogo * files.length; // R20 per new document, regardless of submission's current tier
  if ((company.balance || 0) < addPrice) {
    const shortfall = addPrice - (company.balance || 0);
    return tlJson({ error: `Adding ${files.length} document${files.length>1?'s':''} costs R${addPrice} — you have R${company.balance||0}. Top up R${shortfall} to continue.`, shortfall }, 402);
  }

  // Read existing docs from R2 (needed for the gate check — new docs must match the SAME tender)
  let existingKeys = [];
  try { existingKeys = sub.doc_r2_keys ? JSON.parse(sub.doc_r2_keys) : (sub.doc_r2_key ? [sub.doc_r2_key] : []); }
  catch(e) { existingKeys = sub.doc_r2_key ? [sub.doc_r2_key] : []; }

  // Read new files into base64
  const newDocs = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    newDocs.push({ base64: arrayBufferToBase64(buf), filename: f.name, buffer: buf });
  }

  // ── Reference gate check on the NEW documents only ──
  if (!overrideGate && sub.tender_ref) {
    const gateResult = await checkReferenceGate(newDocs, sub.tender_ref, env);
    if (!gateResult.passed) {
      return tlJson({
        error: 'New documents do not appear to match this submission\'s tender reference.',
        gate_failed: true,
        mismatched_files: gateResult.mismatched.map(m => m.filename),
        gate_message: gateResult.mismatched.map(m => `"${m.filename}" — ${m.reason}`).join('; '),
      }, 409);
    }
  }

  // ── Gate passed — write the new docs to R2, queue the analysis, charge only on success (inside queue consumer) ──
  const newKeys = [];
  for (let i = 0; i < newDocs.length; i++) {
    const docKey = `submissions/${sub.company_id}/${submission_id}/doc-extra-${Date.now()}-${i}-${newDocs[i].filename.replace(/[^a-zA-Z0-9.\-]/g, '_')}`;
    await env.TL_DOCS.put(docKey, newDocs[i].buffer, { httpMetadata: { contentType: 'application/pdf' } });
    newKeys.push(docKey);
  }

  const allKeys = [...existingKeys, ...newKeys];

  await env.TL_DB.prepare(`UPDATE tl_submissions SET doc_r2_keys=?, status='queued' WHERE id=?`)
    .bind(JSON.stringify(allKeys), submission_id).run();

  await env.BUILD_QUEUE.send({
    type: 'tl_analyse',
    submissionId: submission_id,
    companyId: sub.company_id,
    tier: sub.tier || 'gonogo',
    chargeAmount: addPrice,
    isAddDocuments: true,
    previousAmountPaid: sub.amount_paid || 0,
    rollbackDocKeys: existingKeys, // if analysis fails, revert doc_r2_keys to this
  });

  return tlJson({ success: true, submission_id, status: 'queued', documents_added: files.length });
}

// ── ANALYSIS PIPELINE ────────────────────────────────────────────
// tier: 'gonogo' | 'pricing' | 'bidpack' — controls how much of the prompt/schema is unlocked
async function runTlAnalysis(submission_id, company, doc_text, env, pdfDocs, tier) {
  // pdfDocs: array of { base64, filename } OR null. Kept as array internally;
  // single-PDF callers pass a 1-element array for consistency.
  try {
    // ── Pull VERIFIED compliance documents — these override self-reported profile fields ──
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
        return `${label}: EXPIRED${expiredNote} — uploaded certificate is no longer valid. This requirement should be treated as UNMET until renewed.`;
      }
      return `${label}: ${selfReportedValue || 'Not specified'} — SELF-REPORTED, NOT VERIFIED (no certificate uploaded). Treat with appropriate caution in eligibility assessment.`;
    }

    const companyContext = `
Company: ${company.name}
Industries: ${company.industries}
Provinces: ${company.provinces}
Years experience: ${company.years_experience}
Annual turnover: R${(company.annual_turnover||0).toLocaleString()}
Employees: ${company.employees}
${complianceLine('cidb', 'CIDB Grade', company.cidb_grade)}
${complianceLine('bee', 'B-BBEE Level', company.bee_level ? `Level ${company.bee_level}` : null)}
${complianceLine('csd', 'CSD Registration', company.csd_maaa ? 'Registered' : null)}
${complianceLine('tax', 'Tax Clearance', null)}
${complianceLine('coida', 'COIDA Letter of Good Standing', null)}
${complianceLine('pli', 'Public Liability Insurance', null)}

IMPORTANT: Lines marked VERIFIED come from an actual uploaded certificate that was read and confirmed — treat these as fact. Lines marked SELF-REPORTED or NOT VERIFIED have not been confirmed by any document — apply principle 4 (mark status as UNKNOWN, don't assume compliance) for these specifically. Lines marked EXPIRED should be treated as a current compliance gap, not a future risk.
`;

    // Fetch OCDS competitive intelligence — only worth the call for pricing/bidpack tiers
    // (gonogo gets a lightweight summary instruction instead, to keep that tier cheap and fast)
    let ocdsContext = '';
    if (tier !== 'gonogo') {
      const submission = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(submission_id).first();
      if (submission?.province || submission?.category) {
        try {
          const today = new Date();
          const lastYear = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate()).toISOString().split('T')[0];
          const todayStr = today.toISOString().split('T')[0];
          const ocdsRes = await fetch(
            `https://ocds-api.etenders.gov.za/api/OCDSReleases?dateFrom=${lastYear}&dateTo=${todayStr}&limit=100`,
            { headers: { 'Accept': 'application/json' } }
          );
          if (ocdsRes.ok) {
            const ocdsData = await ocdsRes.json();
            const relevant = (ocdsData.releases || [])
              .filter(r => r.awards?.length && r.awards[0]?.value?.amount > 0)
              .slice(0, 10)
              .map(r => `- ${r.tender?.title}: R${r.awards[0]?.value?.amount?.toLocaleString()} awarded to ${r.awards[0]?.title} (${r.tender?.province})`)
              .join('\n');
            if (relevant) ocdsContext = `\nRecent similar awards:\n${relevant}`;
          }
        } catch(e) { /* OCDS optional */ }
      }
    }

    const promptHeader = `You are a South African tender bid intelligence analyst working for TenderLogix. Your single most important job is CREDIBILITY, not sales. Clients return and refer others to us because our verdicts are honest, not because every verdict is positive.

NON-NEGOTIABLE PRINCIPLES:
1. NO ARTIFICIAL OPTIMISM. If a company has no realistic chance — say NO_GO plainly and explain exactly why. Do not soften a clear NO_GO into a CONDITIONAL_GO to seem more helpful.
2. NO ARTIFICIAL PESSIMISM either. If the company is well-positioned, say GO with confidence — don't manufacture risk flags to seem thorough.
3. WHEN GENUINELY CLOSE (40-60% likely), say so explicitly as CONDITIONAL_GO, and your job shifts to identifying what would tip the odds — concrete, specific, actionable moves available before the closing date. Vague advice like "improve your B-BBEE score" is not acceptable; say exactly what level is needed and roughly how that's achieved.
4. MISSING PROFILE DATA IS NOT A GUESS. If the company profile is missing CIDB grade, B-BBEE level, or CSD status, mark that requirement's status as "UNKNOWN" — never assume they qualify, and never assume they don't. State clearly that they should update their profile or confirm this directly for an accurate verdict.
5. EVERY NO_GO INCLUDES A PATH FORWARD WHERE ONE EXISTS. If the disqualifying factor is fixable in time for a FUTURE tender (e.g. CIDB registration, B-BBEE certificate, accumulating required experience), say so. This is what builds trust even when we're delivering bad news today.
6. BOQ CONFIDENCE FLAGS MUST MEAN SOMETHING SPECIFIC:
   - HIGH confidence: cost is a standard labour/statutory rate (DPSA scale, NMWA minimum, COIDA %) or a recent comparable OCDS award value was found
   - MEDIUM confidence: cost is derived from general industry benchmarks (AECOM/ASAQS) without a directly comparable recent award
   - LOW confidence: cost depends on supplier-specific or specialist trade pricing (e.g. specific brand of flooring, imported equipment) that genuinely cannot be estimated without a direct quote — flag this honestly rather than inventing a number with false precision
7. IF THE DOCUMENT IS ILLEGIBLE, INCOMPLETE, OR NOT A TENDER DOCUMENT, say so directly in verdict_summary instead of producing a confident-sounding report from insufficient information. Use verdict "NO_GO" with a clear explanation in this case.

COMPANY PROFILE:
${companyContext}

RECENT MARKET DATA (National Treasury OCDS):${ocdsContext || ' Not available for this category'}
`;

    // ── Tiered schema — gonogo is deliberately lean, pricing/bidpack unlock more ──
    const baseSchema = `{
  "tender_title": "string — the actual title/name of this tender as stated in the document, e.g. 'Knysna Hospital Comprehensive Cleaning Services'. If genuinely not stated anywhere, use a short factual description of what's being procured instead, e.g. 'Cleaning services tender'. Never leave this generic like 'Tender Document'.",
  "tender_reference": "string or null — the official tender/RFQ/RFB reference number if stated in the document, e.g. 'RFQ-1022-2025'. Null if not found.",
  "verdict": "GO" | "NO_GO" | "CONDITIONAL_GO",
  "verdict_summary": "2-3 sentence summary of the recommendation",
  "eligibility": [
    { "requirement": "string", "detail": "string", "status": "MET" | "UNMET" | "UNKNOWN", "notes": "string" }
  ],
  "compliance_checklist": [
    { "item": "string", "risk_level": "HIGH" | "MEDIUM" | "LOW", "notes": "string" }
  ],
  "competitive_landscape_summary": "ONE short sentence only — e.g. 'Moderate competition expected, 3-5 typical bidders in this category and province.' Do NOT include specific award values or named competitors here — that level of detail is reserved for the Pricing Pack upgrade.",
  "risk_flags": [
    { "flag": "string", "severity": "HIGH" | "MEDIUM" | "LOW", "mitigation": "string" }
  ],
  "edge_headline_tip": "ONE single most important action the company could take to improve their odds — a teaser, not the full list. Null if verdict is a clean GO with nothing to add.",
  "future_readiness": "string or null — if this is a NO_GO, what should the company do NOW so they qualify for similar tenders in future. Null if not applicable.",
  "upsell_note": "A brief, honest one-line note on what the Pricing Pack (R750) would add for this specific tender — e.g. full priced BOQ with X line items, named competitor awards, complete action list. This is ALWAYS useful regardless of the verdict — even on a NO_GO, the priced BOQ and competitive landscape are valuable standalone market intelligence (e.g. for a related entity that may qualify, for future capacity planning, or simply to understand category economics). Never frame this as conditional on winnability — frame it purely as 'what this unlocks', not 'why you'd need it'."
}`;

    const pricingSchemaAddition = `

When tier is 'pricing' or 'bidpack', ALSO include these additional fields in the JSON (in addition to everything above):
  "boq": [ { "line_item": "string", "unit": "string", "quantity": number, "unit_rate": number, "total": number, "confidence": "HIGH" | "MEDIUM" | "LOW", "source": "string" } ],
  "boq_totals": { "subtotal": number, "margin_30pct": number, "recommended_bid": number, "conservative_bid": number, "aggressive_bid": number },
  "competitive_landscape": "Full paragraph — named comparable awards from OCDS data where available, typical bidder profile, what wins on price vs B-BBEE preference points.",
  "edge_recommendations": [ { "action": "string", "impact": "string", "timeframe": "string" } ],
  "pricing_disclaimer": "All pricing is indicative, based on AECOM 2025 benchmarks, ASAQS norms, Stats SA P01511 indices and DPSA salary scales. A 30% contractor margin has been applied. Verify all line items with your suppliers before submission."`;

    const bidpackSchemaAddition = `

When tier is 'bidpack', ALSO include:
  "submission_document": "A formatted, submission-ready cover letter and compliance summary in plain text/markdown, written in the company's voice, referencing their specific eligibility status and the tender requirements. This should read like a professional document ready to attach to the bid."`;

    let schemaForTier = baseSchema;
    if (tier === 'pricing' || tier === 'bidpack') schemaForTier = baseSchema.replace('}', '') + pricingSchemaAddition + '\n}';
    if (tier === 'bidpack') schemaForTier = schemaForTier.replace(/\n}$/, '') + bidpackSchemaAddition + '\n}';

    const tierInstruction = tier === 'gonogo'
      ? '\nTHIS IS A GO/NO-GO TIER ANALYSIS (R20). Do NOT calculate or include any BOQ pricing, line items, or detailed competitive landscape — those are reserved for the Pricing Pack upgrade. Give ONE headline edge tip only, not a full list. Use the upsell_note field to honestly describe what upgrading would unlock for THIS tender.\n'
      : tier === 'pricing'
      ? '\nTHIS IS A PRICING PACK TIER ANALYSIS (R750). Include the full priced BOQ, full competitive landscape with named comparable awards where data exists, and the complete edge_recommendations list.\n'
      : '\nTHIS IS A FULL BID PACK TIER ANALYSIS (R2,500). Include everything from the Pricing Pack tier PLUS a formatted, submission-ready document.\n';

    const promptFooter = `
${tierInstruction}
Produce a JSON report with this exact structure:
${schemaForTier}

Return ONLY valid JSON. No markdown fencing. No explanation outside the JSON.`;

    const hasPdfs = Array.isArray(pdfDocs) && pdfDocs.length > 0;
    const docListLabel = hasPdfs
      ? `\nTENDER DOCUMENTS: ${pdfDocs.length} file(s) attached below — ${pdfDocs.map(d => d.filename).join(', ')}. Treat them as ONE combined tender pack for this analysis.\n`
      : `\nTENDER DOCUMENT:\n${(doc_text||'').slice(0, 50000)}\n`;

    const fullPrompt = promptHeader + docListLabel + promptFooter;

    const userContent = hasPdfs
      ? [
          ...pdfDocs.map(d => ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: d.base64 } })),
          { type: 'text', text: fullPrompt },
        ]
      : fullPrompt;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: tier === 'gonogo' ? 3072 : 6144, // raised after a real truncation: stop_reason='max_tokens' on a complex multi-disqualifier NO_GO that legitimately needed more room than 2048 allowed
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('TL analysis — Anthropic API error:', aiRes.status, 'submission:', submission_id, 'tier:', tier, 'response:', errBody.slice(0,500));
      await env.TL_DB.prepare(`UPDATE tl_submissions SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(submission_id).run();
      return { success: false, reason: `Anthropic API returned ${aiRes.status}` };
    }

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '';
    const stopReason = aiData.stop_reason;

    if (!rawText) {
      console.error('TL analysis — empty response text. submission:', submission_id, 'tier:', tier, 'stop_reason:', stopReason, 'full response:', JSON.stringify(aiData).slice(0,500));
      await env.TL_DB.prepare(`UPDATE tl_submissions SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(submission_id).run();
      return { success: false, reason: 'Empty response from analysis engine' };
    }

    let report;
    try {
      report = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      console.error('TL analysis — JSON parse failed. submission:', submission_id, 'tier:', tier, 'stop_reason:', stopReason, 'raw text (first 800 chars):', rawText.slice(0,800));
      await env.TL_DB.prepare(`UPDATE tl_submissions SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(submission_id).run();
      const reason = stopReason === 'max_tokens'
        ? 'The analysis was unusually detailed and exceeded the response size limit before completing. Please try again — this is a rare edge case we are tuning for.'
        : 'Could not parse analysis result';
      return { success: false, reason };
    }

    // A real report must have a verdict — anything else (empty object, missing field)
    // means the analysis did not genuinely complete, regardless of HTTP success.
    if (!report.verdict || !['GO','NO_GO','CONDITIONAL_GO'].includes(report.verdict)) {
      console.error('TL analysis — report missing valid verdict. submission:', submission_id, 'tier:', tier, 'stop_reason:', stopReason, 'parsed report:', JSON.stringify(report).slice(0,500));
      await env.TL_DB.prepare(`UPDATE tl_submissions SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(submission_id).run();
      return { success: false, reason: 'Analysis did not produce a valid verdict' };
    }

    const reportKey = `submissions/${submission_id}/report-${tier}.json`;
    await env.TL_DOCS.put(reportKey, JSON.stringify(report));

    // Only fill tender_ref from Claude's extraction if the client didn't already
    // provide one — never overwrite a reference the client explicitly typed in.
    const existingSub = await env.TL_DB.prepare('SELECT tender_ref FROM tl_submissions WHERE id=? LIMIT 1').bind(submission_id).first();
    const finalTenderRef = existingSub?.tender_ref || report.tender_reference || null;

    await env.TL_DB.prepare(`
      UPDATE tl_submissions SET status='complete', verdict=?, report_r2_key=?, report_json=?, tender_title=?, tender_ref=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(report.verdict, reportKey, JSON.stringify(report), report.tender_title || null, finalTenderRef, submission_id).run();

    return { success: true };

  } catch(e) {
    console.error('TL analysis error:', e.message, 'submission:', submission_id, 'tier:', tier);
    await env.TL_DB.prepare(`UPDATE tl_submissions SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(submission_id).run();
    return { success: false, reason: e.message };
  }
}

// ── GET SUBMISSION ───────────────────────────────────────────────
async function handleTlGetSubmission(url, env, tlJson) {
  const id = url.searchParams.get('id');
  if (!id) return tlJson({ error: 'id required' }, 400);
  const sub = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(id).first();
  if (!sub) return tlJson({ error: 'Submission not found' }, 404);
  if (sub.report_json) sub.report = JSON.parse(sub.report_json);
  return tlJson(sub);
}

// ── LIST SUBMISSIONS ─────────────────────────────────────────────
async function handleTlListSubmissions(url, env, tlJson) {
  const company_id = url.searchParams.get('company_id');
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);
  const subs = await env.TL_DB.prepare(
    'SELECT id, tender_ref, tender_title, status, verdict, tier, amount_paid, created_at FROM tl_submissions WHERE company_id=? ORDER BY created_at DESC LIMIT 20'
  ).bind(company_id).all();
  return tlJson({ submissions: subs.results || [] });
}

// ── PAYFAST WEBHOOK ──────────────────────────────────────────────
// Tops up account balance in rand. No fixed packages — pay exactly what's needed.
// ── Document Vault — subscribe. Uses the same buildPayFastLink helper
// already proven in production for Website Hub's R699/R999 monthly
// subscriptions (launch-worker) — correct sandbox/live credential
// switching via isTestMode(env), no need to hand-roll signature logic.
async function handleVaultSubscribe(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id } = body;
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  const returnUrl = `https://tenderlogix.co.za/dashboard-v2/${company_id}?vault=active`;
  const cancelUrl = `https://tenderlogix.co.za/dashboard-v2/${company_id}`;
  const notifyUrl = 'https://tenderlogix.co.za/tl/payfast-webhook';

  const url = buildPayFastLink(99, 'TenderLogix Document Vault', company_id, env, {
    returnUrl,
    cancelUrl,
    notifyUrl,
    customStr2: 'vault_subscription',
    itemDesc: `${company.name} — Document Vault monthly subscription`,
    subscription: true,
    frequency: 3, // monthly
    cycles: 0,    // infinite — runs until cancelled
    recurringAmount: 99,
  });

  return tlJson({ success: true, checkout_url: url, sandbox: isTestMode(env) });
}

async function handleTlPayfast(request, env, tlJson) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  const status = params.get('payment_status');
  const company_id = params.get('custom_str1');
  const purpose = params.get('custom_str2'); // 'balance_topup' | 'vault_subscription'
  const amount = Math.round(parseFloat(params.get('amount_gross') || '0'));
  const token = params.get('token'); // present on subscription ITNs

  if (status !== 'COMPLETE' || !company_id) return tlJson({ ok: true });

  if (purpose === 'vault_subscription') {
    // Subscription ITN — activate or renew the Document Vault. PayFast sends
    // an ITN on the initial subscription AND on every recurring charge, so
    // this same branch correctly handles both setup and monthly renewals.
    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const existing = await env.TL_DB.prepare('SELECT id FROM tl_vault_subscriptions WHERE company_id=? LIMIT 1').bind(company_id).first();
    if (existing) {
      await env.TL_DB.prepare(`
        UPDATE tl_vault_subscriptions SET status='active', current_period_end=?, payfast_token=COALESCE(?, payfast_token), updated_at=CURRENT_TIMESTAMP WHERE company_id=?
      `).bind(periodEnd.toISOString(), token || null, company_id).run();
    } else {
      await env.TL_DB.prepare(`
        INSERT INTO tl_vault_subscriptions (id, company_id, status, current_period_end, payfast_token)
        VALUES (?,?,'active',?,?)
      `).bind(crypto.randomUUID(), company_id, periodEnd.toISOString(), token || null).run();
    }
    return tlJson({ ok: true });
  }

  // Default — balance top-up (existing behaviour, untouched)
  if (amount <= 0) return tlJson({ ok: true });
  await env.TL_DB.prepare('UPDATE tl_companies SET balance=balance+? WHERE id=?').bind(amount, company_id).run();
  await env.TL_DB.prepare(`INSERT INTO tl_credits (id, company_id, amount, type, payfast_id) VALUES (?,?,?,'purchase',?)`)
    .bind(crypto.randomUUID(), company_id, amount, params.get('pf_payment_id')||null).run();

  return tlJson({ ok: true });
}

// ── COMPLIANCE DOCUMENT SYSTEM ───────────────────────────────────────────
// Self-extending: the first time an industry is encountered with no existing
// requirements mapping, we ask Claude what's typically required and persist
// the answer permanently — every future company in that industry then gets
// a free, instant DB read instead of a repeat Claude call.

// Normalise an industry string for consistent table lookups
function normaliseIndustry(industry) {
  return (industry || '').trim().toLowerCase();
}

// ── Ensure requirements exist for a given industry — triggers Claude suggestion if new ──
async function ensureIndustryRequirements(industry, env) {
  const norm = normaliseIndustry(industry);
  if (!norm) return;

  const existing = await env.TL_DB.prepare(
    'SELECT COUNT(*) as cnt FROM tl_industry_doc_requirements WHERE industry=?'
  ).bind(norm).first();
  if ((existing?.cnt || 0) > 0) return; // already have requirements for this industry

  // First time seeing this industry — ask Claude what's typically required,
  // beyond the universal set (CIDB/B-BBEE/Tax/COIDA/CSD/PLI).
  try {
    const universalTypes = await env.TL_DB.prepare('SELECT id, name FROM tl_doc_types WHERE is_universal=1').all();
    const universalList = (universalTypes.results || []).map(t => t.name).join(', ');

    const prompt = `For a South African company operating in the industry "${industry}", what compliance documents, registrations, or licences are commonly required for government tender eligibility — BEYOND the universal set every bidder typically needs (${universalList})?

Examples of industry-specific requirements: cleaning companies often need Bargaining Council membership; security companies need PSIRA registration; electrical contractors need ECASA/ECB registration; transport companies need an operating licence.

Return ONLY this JSON:
{
  "requirements": [
    { "id": "short_lowercase_slug", "name": "Display Name", "description": "one sentence explaining what it is and why it matters", "has_expiry": true, "confidence": "high" | "medium" | "low" }
  ]
}

If this industry genuinely has no additional requirements beyond the universal set, return { "requirements": [] }. Return ONLY valid JSON, no markdown, no explanation.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
    });

    if (!aiRes.ok) {
      const errBody = await aiRes.text();
      console.error('Industry requirement suggestion — Anthropic API error:', aiRes.status, 'industry:', industry, 'response:', errBody.slice(0,300));
      return; // don't write anything — will retry next time since no rows were inserted
    }

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '{}';
    let result;
    try {
      result = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(parseErr) {
      console.error('Industry requirement suggestion — JSON parse failed:', parseErr.message, 'industry:', industry, 'raw text:', rawText.slice(0,300));
      return;
    }

    if (!result.requirements || result.requirements.length === 0) {
      // Claude confirmed there's nothing extra for this industry — write a marker
      // row so we don't re-run this Claude call on every single dashboard load.
      // Uses a reserved doc_type_id 'none' which is never rendered as a real card.
      await env.TL_DB.prepare(`
        INSERT OR IGNORE INTO tl_doc_types (id, name, description, is_universal, has_expiry)
        VALUES ('none', 'No additional requirement', 'Internal marker — not a real document type', 0, 0)
      `).run();
      await env.TL_DB.prepare(`
        INSERT INTO tl_industry_doc_requirements (id, industry, doc_type_id, source, confidence)
        VALUES (?,?,?,'claude','high')
      `).bind(crypto.randomUUID(), norm, 'none').run();
      console.log('Industry requirement suggestion — confirmed no extra requirements for:', industry);
      return;
    }

    for (const req of result.requirements) {
      // Insert the doc type if it doesn't already exist (it might, if another
      // industry already suggested the same requirement e.g. two trades both need PSIRA)
      await env.TL_DB.prepare(`
        INSERT OR IGNORE INTO tl_doc_types (id, name, description, is_universal, has_expiry)
        VALUES (?,?,?,0,?)
      `).bind(req.id, req.name, req.description || null, req.has_expiry ? 1 : 0).run();

      await env.TL_DB.prepare(`
        INSERT INTO tl_industry_doc_requirements (id, industry, doc_type_id, source, confidence)
        VALUES (?,?,?,'claude',?)
      `).bind(crypto.randomUUID(), norm, req.id, req.confidence || 'medium').run();
    }
    console.log('Industry requirement suggestion — added', result.requirements.length, 'requirement(s) for:', industry);
  } catch(e) {
    console.error('Industry requirement suggestion failed:', e.message, 'industry:', industry);
    // Fail silently to the user — the company just won't see industry-specific
    // requirements until this succeeds on a later attempt (e.g. next profile view).
    // No rows written, so it will correctly retry next time rather than getting
    // stuck thinking this industry has been "checked" when it errored out.
  }
}

// ── GET — compliance requirements + status for a company's dashboard strip ──
async function handleTlComplianceRequirements(url, env, tlJson) {
  const company_id = url.searchParams.get('company_id');
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  let industries = [];
  try { industries = JSON.parse(company.industries || '[]'); } catch(e) {}

  // Ensure requirements exist for every industry this company has — fires
  // the Claude suggestion call for any genuinely new industry, no-ops otherwise.
  for (const ind of industries) {
    await ensureIndustryRequirements(ind, env);
  }

  // Universal doc types + industry-specific ones for this company's industries, deduped
  const normIndustries = industries.map(normaliseIndustry);
  const placeholders = normIndustries.map(() => '?').join(',');

  const requiredTypes = normIndustries.length
    ? await env.TL_DB.prepare(`
        SELECT DISTINCT dt.* FROM tl_doc_types dt
        WHERE dt.id != 'none'
        AND (dt.is_universal=1
        OR dt.id IN (SELECT doc_type_id FROM tl_industry_doc_requirements WHERE industry IN (${placeholders})))
      `).bind(...normIndustries).all()
    : await env.TL_DB.prepare("SELECT * FROM tl_doc_types WHERE is_universal=1 AND id != 'none'").all();

  // Left-join against what's actually uploaded for this company
  const uploaded = await env.TL_DB.prepare(
    'SELECT * FROM tl_compliance_documents WHERE company_id=?'
  ).bind(company_id).all();
  const uploadedByType = {};
  (uploaded.results || []).forEach(d => { uploadedByType[d.doc_type_id] = d; });

  const strip = (requiredTypes.results || []).map(dt => {
    const doc = uploadedByType[dt.id];
    let redReason = null;
    let cleanNotes = doc?.extraction_notes || null;
    if (cleanNotes && cleanNotes.startsWith('[wrong_document]')) {
      redReason = 'wrong_document';
      cleanNotes = cleanNotes.replace('[wrong_document] ', '');
    } else if (cleanNotes && cleanNotes.startsWith('[expired]')) {
      redReason = 'expired';
      cleanNotes = cleanNotes.replace('[expired] ', '');
    }
    return {
      doc_type_id: dt.id,
      name: dt.name,
      description: dt.description,
      has_expiry: !!dt.has_expiry,
      is_universal: !!dt.is_universal,
      status: doc ? doc.status : 'missing',
      red_reason: redReason,
      extracted_value: doc?.extracted_value || null,
      expiry_date: doc?.expiry_date || null,
      uploaded_at: doc?.uploaded_at || null,
      extraction_notes: cleanNotes,
    };
  });

  return tlJson({ company_id, requirements: strip });
}

// ── POST — upload + verify a compliance certificate ──────────────────────
async function handleTlComplianceUpload(request, env, tlJson) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return tlJson({ error: 'multipart/form-data required' }, 400);
  }

  const form = await request.formData();
  const company_id  = form.get('company_id');
  const doc_type_id = form.get('doc_type_id');
  const file         = form.get('file');

  if (!company_id || !doc_type_id || !file) return tlJson({ error: 'company_id, doc_type_id and file required' }, 400);
  if (file.type !== 'application/pdf' && !file.type.startsWith('image/')) {
    return tlJson({ error: 'Only PDF or image files are supported' }, 400);
  }
  if (file.size > 20 * 1024 * 1024) return tlJson({ error: 'File must be under 20MB' }, 400);

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  // ── Document Vault gate — R99/month. Compliance upload/storage/retrieval
  // is entirely behind this subscription. Go/No-Go/Pricing/Bid Pack verdicts
  // remain fully functional and honest without it (self-reported data,
  // clearly marked as such) — this gate is specifically about custody and
  // verification of real certificates, not about degrading core analysis.
  const hasVaultAccess = await checkVaultSubscription(env, company_id);
  if (!hasVaultAccess) {
    return tlJson({
      error: 'Document Vault is a R99/month feature — upload, verify, and securely store your compliance certificates, with instant retrieval and expiry alerts. Subscribe to unlock.',
      vault_required: true,
    }, 402);
  }

  const docType = await env.TL_DB.prepare('SELECT * FROM tl_doc_types WHERE id=? LIMIT 1').bind(doc_type_id).first();
  if (!docType) return tlJson({ error: 'Unknown document type' }, 404);

  const buf = await file.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);
  const isPdf = file.type === 'application/pdf';

  // Tenant-namespaced R2 path — not guessable/enumerable across companies
  const r2Key = `compliance/${company_id}/${doc_type_id}-${Date.now()}.${isPdf ? 'pdf' : 'jpg'}`;
  await env.TL_DOCS.put(r2Key, buf, { httpMetadata: { contentType: file.type } });

  // ── Claude reads the actual certificate — extraction, not trust ──
  const prompt = `You are verifying a South African compliance certificate. The document type expected is: "${docType.name}" (${docType.description || ''}).

Read the attached document and extract:
1. Does this document genuinely appear to be a "${docType.name}" certificate/registration? (yes/no — if it's clearly the wrong document type, say so)
2. The company/entity name on the certificate (to help confirm it matches "${company.name}")
3. The grade, level, or status shown (e.g. "Grade 3GB", "Level 2", "Active", "Registered")
4. The expiry or validity end date, if one is printed on the document (format YYYY-MM-DD). If the document has no expiry concept, return null.
5. Any concerns — illegible sections, name mismatch, document looks altered, anything that should be flagged for human review

Return ONLY this JSON:
{
  "is_correct_doc_type": true | false,
  "entity_name_on_document": "string or null",
  "name_matches_company": true | false | "uncertain",
  "extracted_value": "string — the grade/level/status found",
  "expiry_date": "YYYY-MM-DD or null",
  "confidence": "high" | "medium" | "low",
  "notes": "string or null — any concerns worth flagging"
}

Return ONLY valid JSON, no markdown, no explanation.`;

  const userContent = [
    { type: 'document', source: { type: 'base64', media_type: file.type, data: base64 } },
    { type: 'text', text: prompt },
  ];

  let extraction;
  let rawAiResponseForDebug = null;
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1024, messages: [{ role: 'user', content: userContent }] }),
    });
    const aiData = await aiRes.json();
    rawAiResponseForDebug = aiData;

    if (!aiRes.ok) {
      // Anthropic API itself returned an error (e.g. unsupported media_type like image/heic,
      // file too large for the API, auth issue) — this is NOT Claude making a judgment call,
      // this is the request never reaching Claude's actual analysis at all.
      console.error('TL compliance upload — Anthropic API error:', aiRes.status, 'company:', company_id, 'doc_type:', doc_type_id, 'file_type:', file.type, 'file_name:', file.name, 'response:', JSON.stringify(aiData));
      throw new Error(`Anthropic API returned ${aiRes.status}: ${JSON.stringify(aiData).slice(0,200)}`);
    }

    const rawText = aiData.content?.[0]?.text || '{}';
    extraction = JSON.parse(rawText.replace(/```json|```/g, '').trim());
  } catch(e) {
    console.error('TL compliance upload — extraction failed:', e.message, 'company:', company_id, 'doc_type:', doc_type_id, 'file_type:', file.type, 'file_name:', file.name, 'raw response snippet:', JSON.stringify(rawAiResponseForDebug)?.slice(0,500));

    // IMPORTANT: a failed extraction must be treated with AT LEAST as much caution as a
    // confirmed-wrong document, not less. Explicitly false (not null) so the status logic
    // below correctly routes this to red, not a default amber.
    extraction = { is_correct_doc_type: false, extracted_value: null, expiry_date: null, confidence: 'low', notes: 'We could not verify this document automatically — please re-upload, or try a clearer photo/PDF. If this keeps happening, contact support.' };
  }

  // ── Compute status from extracted expiry date ──
  let status = 'pending';
  let redReason = null; // 'wrong_document' | 'expired' | null — only meaningful when status='red'
  if (extraction.is_correct_doc_type === false) {
    status = 'red';
    redReason = 'wrong_document';
  } else if (docType.has_expiry && extraction.expiry_date) {
    const expiry = new Date(extraction.expiry_date);
    const today = new Date();
    const daysUntilExpiry = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
    if (daysUntilExpiry < 0) { status = 'red'; redReason = 'expired'; }
    else if (daysUntilExpiry <= 60) status = 'amber';
    else status = 'green';
  } else if (!docType.has_expiry && extraction.extracted_value) {
    status = 'green'; // binary type, something was extracted — treat as confirmed
  } else {
    status = 'amber'; // uploaded but couldn't confirm details — needs review, not a hard fail
  }

  const id = crypto.randomUUID();
  // Replace any existing document of this type for this company (re-upload on renewal)
  await env.TL_DB.prepare('DELETE FROM tl_compliance_documents WHERE company_id=? AND doc_type_id=?')
    .bind(company_id, doc_type_id).run();

  // Store red_reason inside extraction_notes as a structured prefix if notes are empty,
  // so it survives without needing a schema migration for a new column.
  const storedNotes = redReason
    ? `[${redReason}] ${extraction.notes || (redReason === 'wrong_document' ? 'This does not appear to be the correct document type.' : 'This certificate has expired.')}`
    : (extraction.notes || null);

  await env.TL_DB.prepare(`
    INSERT INTO tl_compliance_documents (id, company_id, doc_type_id, r2_key, extracted_value, expiry_date, status, extraction_confidence, extraction_notes, verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
  `).bind(id, company_id, doc_type_id, r2Key, extraction.extracted_value || null, extraction.expiry_date || null, status, extraction.confidence || 'low', storedNotes).run();

  return tlJson({
    success: true,
    doc_type_id,
    status,
    red_reason: redReason,
    extracted_value: extraction.extracted_value || null,
    expiry_date: extraction.expiry_date || null,
    is_correct_doc_type: extraction.is_correct_doc_type,
    name_matches_company: extraction.name_matches_company,
    notes: extraction.notes || null,
  });
}

// ── POST — client flags a missing document type for their industry ───────
async function handleTlComplianceFlagMissing(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id, name, description } = body;
  if (!company_id || !name) return tlJson({ error: 'company_id and name required' }, 400);

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);

  let industries = [];
  try { industries = JSON.parse(company.industries || '[]'); } catch(e) {}

  const docTypeId = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);

  await env.TL_DB.prepare(`
    INSERT OR IGNORE INTO tl_doc_types (id, name, description, is_universal, has_expiry)
    VALUES (?,?,?,0,1)
  `).bind(docTypeId, name, description || null).run();

  for (const ind of industries) {
    await env.TL_DB.prepare(`
      INSERT INTO tl_industry_doc_requirements (id, industry, doc_type_id, source, confidence)
      VALUES (?,?,?,'user','medium')
    `).bind(crypto.randomUUID(), normaliseIndustry(ind), docTypeId).run();
  }

  return tlJson({ success: true, doc_type_id: docTypeId });
}

// ── DOWNLOAD/VIEW a stored compliance certificate ─────────────────────────
// Gated behind Vault — same custody principle as upload. Serves the real
// file straight from R2. company_id is required as a basic ownership check
// (matches the doc's actual company_id), not just the doc id alone.
async function handleTlComplianceDocumentDownload(url, env) {
  const docId = url.searchParams.get('id');
  const docTypeId = url.searchParams.get('doc_type_id');
  const companyId = url.searchParams.get('company_id');
  if ((!docId && !docTypeId) || !companyId) {
    return new Response(JSON.stringify({ error: 'company_id and either id or doc_type_id required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const hasVaultAccess = await checkVaultSubscription(env, companyId);
  if (!hasVaultAccess) {
    return new Response(JSON.stringify({ error: 'Document Vault subscription required', vault_required: true }), { status: 402, headers: { 'Content-Type': 'application/json' } });
  }

  // Lookup by either the document's own row id, or by doc_type_id (simpler
  // for the frontend, which only knows the type — there's at most one
  // current document per type per company, so this is unambiguous).
  const doc = docId
    ? await env.TL_DB.prepare('SELECT * FROM tl_compliance_documents WHERE id=? AND company_id=? LIMIT 1').bind(docId, companyId).first()
    : await env.TL_DB.prepare('SELECT * FROM tl_compliance_documents WHERE doc_type_id=? AND company_id=? LIMIT 1').bind(docTypeId, companyId).first();
  if (!doc || !doc.r2_key) {
    return new Response(JSON.stringify({ error: 'Document not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const obj = await env.TL_DOCS.get(doc.r2_key);
  if (!obj) {
    return new Response(JSON.stringify({ error: 'File not found in storage' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  const contentType = obj.httpMetadata?.contentType || 'application/octet-stream';
  return new Response(obj.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${doc.doc_type_id}.${contentType.includes('pdf') ? 'pdf' : 'jpg'}"`,
    },
  });
}

// ── QUEUE CONSUMER ENTRY POINT ───────────────────────────────────────────
// Called from the main Worker's queue() handler for messages of type 'tl_analyse'.
// This is where the actual Claude analysis runs, OUTSIDE the original HTTP
// request's execution-time limit — the fix for large/slow documents that
// were hitting Cloudflare's synchronous time ceiling when processed inline.
//
// Money only moves here, AFTER runTlAnalysis confirms a genuine, valid verdict.
// This preserves the financial-integrity guarantee from the original fix,
// just relocated to where the analysis itself now actually happens.
export async function processTlQueueMessage(msg, env) {
  const { submissionId, companyId, tier, chargeAmount, isUpgrade, previousTier, isAddDocuments, previousAmountPaid, rollbackDocKeys } = msg;

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(companyId).first();
  if (!company) {
    console.error('TL queue — company not found:', companyId, 'submission:', submissionId);
    await env.TL_DB.prepare(`UPDATE tl_submissions SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(submissionId).run();
    return;
  }

  const sub = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(submissionId).first();
  if (!sub) {
    console.error('TL queue — submission not found:', submissionId);
    return;
  }

  // ── Read the document(s) from R2 — uniform path for text-paste, single PDF, and multi-PDF ──
  let doc_text = null, pdfDocs = null;
  let docKeys = [];
  try { docKeys = sub.doc_r2_keys ? JSON.parse(sub.doc_r2_keys) : (sub.doc_r2_key ? [sub.doc_r2_key] : []); }
  catch(e) { docKeys = sub.doc_r2_key ? [sub.doc_r2_key] : []; }

  if (docKeys.length) {
    const isPdf = docKeys[0].endsWith('.pdf') || docKeys[0].includes('/doc-');
    if (isPdf) {
      pdfDocs = [];
      for (const key of docKeys) {
        const obj = await env.TL_DOCS.get(key);
        if (obj) {
          const buf = await obj.arrayBuffer();
          pdfDocs.push({ base64: arrayBufferToBase64(buf), filename: key.split('/').pop() });
        }
      }
    } else {
      const obj = await env.TL_DOCS.get(docKeys[0]);
      if (obj) doc_text = await obj.text();
    }
  }

  await env.TL_DB.prepare(`UPDATE tl_submissions SET status='processing' WHERE id=?`).bind(submissionId).run();

  const result = await runTlAnalysis(submissionId, company, doc_text, env, pdfDocs, tier);

  if (!result.success) {
    console.error('TL queue — analysis failed for submission:', submissionId, 'reason:', result.reason);

    if (isUpgrade) {
      // Restore previous tier so the client keeps their last good result.
      await env.TL_DB.prepare(`UPDATE tl_submissions SET status='complete', tier=? WHERE id=?`).bind(previousTier || 'gonogo', submissionId).run();
    } else if (isAddDocuments) {
      // Roll back doc_r2_keys to pre-add state — new files stay in R2 (harmless, unreferenced).
      await env.TL_DB.prepare(`UPDATE tl_submissions SET doc_r2_keys=?, status='complete' WHERE id=?`)
        .bind(JSON.stringify(rollbackDocKeys || []), submissionId).run();
    }
    // For a fresh initial submission, runTlAnalysis already set status='failed' — nothing more to do.
    // No charge happens in any failure case — balance is untouched by construction.
    return;
  }

  // ── Analysis genuinely succeeded — NOW charge ──
  const { shortfall } = await spendFromBalance(env, companyId, chargeAmount);
  if (shortfall > 0) {
    console.error('TL queue — balance changed during analysis, undercharged. submission:', submissionId, 'chargeAmount:', chargeAmount, 'shortfall:', shortfall);
  }

  if (isUpgrade) {
    await env.TL_DB.prepare(`UPDATE tl_submissions SET tier=?, amount_paid=? WHERE id=?`).bind(tier, TIER_PRICES[tier], submissionId).run();
  } else if (isAddDocuments) {
    const newAmountPaid = (previousAmountPaid || 0) + chargeAmount;
    await env.TL_DB.prepare(`UPDATE tl_submissions SET amount_paid=? WHERE id=?`).bind(newAmountPaid, submissionId).run();
  } else {
    await env.TL_DB.prepare(`UPDATE tl_submissions SET amount_paid=? WHERE id=?`).bind(chargeAmount, submissionId).run();
  }
}
