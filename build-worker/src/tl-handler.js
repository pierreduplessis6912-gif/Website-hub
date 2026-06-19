// ── TENDER LOGIX HANDLER ─────────────────────────────────────
// Routes all tenderlogix.co.za requests
//
// PRICING MODEL — per submission, ceiling R2,500:
//   gonogo  — R20   — verdict, eligibility, compliance, risks, future readiness, ONE edge tip
//   pricing — R750  — adds full priced BOQ, full competitive landscape, full edge recommendations
//   bidpack — R2500 — adds formatted submission document
// Each tier upgrade charges (tier_price - amount_paid) on that SAME submission.
// Balance is rand sitting on the account, drawn down first; PayFast covers the shortfall.

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

  if (path === '/tl/submission'  && method === 'GET')  return handleTlGetSubmission(url, env, tlJson);
  if (path === '/tl/submissions' && method === 'GET')  return handleTlListSubmissions(url, env, tlJson);

  if (path === '/tl/analyse' && method === 'POST') return handleTlAnalyse(request, env, tlJson);
  if (path === '/tl/upload'  && method === 'POST') return handleTlUpload(request, env, tlJson);
  if (path === '/tl/upgrade' && method === 'POST') return handleTlUpgrade(request, env, tlJson);

  if (path === '/tl/balance' && method === 'GET')  return handleTlGetBalance(url, env, tlJson);
  if (path === '/tl/payfast-webhook' && method === 'POST') return handleTlPayfast(request, env, tlJson);

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
  const { fromBalance, shortfall } = await spendFromBalance(env, company_id, price);
  if (shortfall > 0) {
    return tlJson({ error: `Insufficient balance. This costs R${price} — you have R${company.balance||0}. Top up R${shortfall} to continue.`, shortfall }, 402);
  }

  const id = crypto.randomUUID();
  await env.TL_DB.prepare(`INSERT INTO tl_submissions (id, company_id, tender_ref, status, tier, amount_paid) VALUES (?,?,?,'processing','gonogo',?)`)
    .bind(id, company_id, tender_ref||null, price).run();

  await runTlAnalysis(id, company, doc_text, env, null, 'gonogo');

  const sub = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(id).first();
  if (sub?.report_json) sub.report = JSON.parse(sub.report_json);

  return tlJson({ submission_id: id, ...sub });
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
      headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
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
  // Check balance WITHOUT spending yet — gate check must pass first, and we don't want
  // to charge for a submission we end up blocking.
  if ((company.balance || 0) < price) {
    const shortfall = price - (company.balance || 0);
    return tlJson({ error: `This costs R${price} (${files.length} document${files.length>1?'s':''} × R20) — you have R${company.balance||0}. Top up R${shortfall} to continue.`, shortfall }, 402);
  }

  // Read all files into base64 once — reused for both gate check and analysis
  const pdfDocs = [];
  for (const f of files) {
    const buf = await f.arrayBuffer();
    pdfDocs.push({ base64: arrayBufferToBase64(buf), filename: f.name, buffer: buf });
  }

  // ── Reference gate check — only runs for multi-document submissions ──
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

  // ── Gate passed (or overridden) — now charge and proceed ──
  const { shortfall } = await spendFromBalance(env, company_id, price);
  if (shortfall > 0) {
    return tlJson({ error: `Insufficient balance. This costs R${price} — you have R${company.balance||0}. Top up R${shortfall} to continue.`, shortfall }, 402);
  }

  const id = crypto.randomUUID();
  const docKeys = [];
  for (let i = 0; i < pdfDocs.length; i++) {
    const docKey = `submissions/${company_id}/${id}/doc-${i}-${pdfDocs[i].filename.replace(/[^a-zA-Z0-9.\-]/g, '_')}`;
    await env.TL_DOCS.put(docKey, pdfDocs[i].buffer, { httpMetadata: { contentType: 'application/pdf' } });
    docKeys.push(docKey);
  }

  await env.TL_DB.prepare(`
    INSERT INTO tl_submissions (id, company_id, tender_ref, doc_r2_key, doc_r2_keys, status, tier, amount_paid)
    VALUES (?,?,?,?,?,'processing','gonogo',?)
  `).bind(id, company_id, tender_ref, docKeys[0], JSON.stringify(docKeys), price).run();

  await runTlAnalysis(id, company, null, env, pdfDocs.map(d => ({ base64: d.base64, filename: d.filename })), 'gonogo');

  const sub = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(id).first();
  if (sub?.report_json) sub.report = JSON.parse(sub.report_json);

  return tlJson({ success: true, submission_id: id, document_count: files.length, ...sub });
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

  const { shortfall } = await spendFromBalance(env, sub.company_id, owed);
  if (shortfall > 0) {
    return tlJson({
      error: `Upgrading to ${tier} costs R${owed} (R${targetPrice} total, R${alreadyPaid} already paid on this tender). You have R${company.balance||0}. Top up R${shortfall} to continue.`,
      shortfall, owed, target_price: targetPrice, already_paid: alreadyPaid,
    }, 402);
  }

  await env.TL_DB.prepare(`UPDATE tl_submissions SET tier=?, amount_paid=?, status='processing' WHERE id=?`)
    .bind(tier, targetPrice, submission_id).run();

  // Re-run analysis with the richer prompt, reusing the original document(s)
  let doc_text = null, pdfDocs = null;
  let docKeys = [];
  try { docKeys = sub.doc_r2_keys ? JSON.parse(sub.doc_r2_keys) : (sub.doc_r2_key ? [sub.doc_r2_key] : []); }
  catch(e) { docKeys = sub.doc_r2_key ? [sub.doc_r2_key] : []; }

  if (docKeys.length) {
    const isPdf = docKeys[0].includes('.pdf') || docKeys[0].includes('/doc-');
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

  await runTlAnalysis(submission_id, company, doc_text, env, pdfDocs, tier);

  const updated = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(submission_id).first();
  if (updated?.report_json) updated.report = JSON.parse(updated.report_json);

  return tlJson({ success: true, submission_id, ...updated });
}

// ── ANALYSIS PIPELINE ────────────────────────────────────────────
// tier: 'gonogo' | 'pricing' | 'bidpack' — controls how much of the prompt/schema is unlocked
async function runTlAnalysis(submission_id, company, doc_text, env, pdfDocs, tier) {
  // pdfDocs: array of { base64, filename } OR null. Kept as array internally;
  // single-PDF callers pass a 1-element array for consistency.
  try {
    const companyContext = `
Company: ${company.name}
Industries: ${company.industries}
Provinces: ${company.provinces}
Years experience: ${company.years_experience}
Annual turnover: R${(company.annual_turnover||0).toLocaleString()}
Employees: ${company.employees}
CIDB Grade: ${company.cidb_grade || 'Not specified'}
B-BBEE Level: ${company.bee_level || 'Not specified'}
CSD MAAA: ${company.csd_maaa ? 'Registered' : 'Not confirmed'}
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
  "upsell_note": "A brief, honest one-line note on what the Pricing Pack (R750) would add for this specific tender — e.g. full priced BOQ with X line items, named competitor awards, complete action list. Null if verdict is NO_GO with no realistic path forward."
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
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: tier === 'gonogo' ? 2048 : 4096,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '{}';

    let report;
    try {
      report = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      report = { verdict: 'ERROR', verdict_summary: 'Analysis failed — please retry', raw: rawText };
    }

    const reportKey = `submissions/${submission_id}/report-${tier}.json`;
    await env.TL_DOCS.put(reportKey, JSON.stringify(report));

    await env.TL_DB.prepare(`
      UPDATE tl_submissions SET status='complete', verdict=?, report_r2_key=?, report_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?
    `).bind(report.verdict || 'ERROR', reportKey, JSON.stringify(report), submission_id).run();

  } catch(e) {
    console.error('TL analysis error:', e.message);
    await env.TL_DB.prepare(`UPDATE tl_submissions SET status='failed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(submission_id).run();
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
async function handleTlPayfast(request, env, tlJson) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  const status = params.get('payment_status');
  const company_id = params.get('custom_str1');
  const amount = Math.round(parseFloat(params.get('amount_gross') || '0'));

  if (status !== 'COMPLETE' || !company_id || amount <= 0) return tlJson({ ok: true });

  await env.TL_DB.prepare('UPDATE tl_companies SET balance=balance+? WHERE id=?').bind(amount, company_id).run();
  await env.TL_DB.prepare(`INSERT INTO tl_credits (id, company_id, amount, type, payfast_id) VALUES (?,?,?,'purchase',?)`)
    .bind(crypto.randomUUID(), company_id, amount, params.get('pf_payment_id')||null).run();

  return tlJson({ ok: true });
}
