// ── TENDER LOGIX HANDLER ─────────────────────────────────────
// Routes all tenderlogix.co.za requests

export async function handleTenderLogix(request, env) {
  const url    = new URL(request.url);
  const path   = url.pathname;
  const method = request.method;

  // ── CORS ──
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

  // Health check
  if (path === '/health') return tlJson({ status: 'ok', service: 'tenderlogix' });

  // ── Company Profile ──────────────────────────────────────────
  if (path === '/tl/company' && method === 'POST') {
    return handleTlCreateCompany(request, env, tlJson);
  }
  if (path === '/tl/company' && method === 'GET') {
    return handleTlGetCompany(url, env, tlJson);
  }

  // ── Submissions ──────────────────────────────────────────────
  if (path === '/tl/submit' && method === 'POST') {
    return handleTlSubmit(request, env, tlJson);
  }
  if (path === '/tl/submission' && method === 'GET') {
    return handleTlGetSubmission(url, env, tlJson);
  }
  if (path === '/tl/submissions' && method === 'GET') {
    return handleTlListSubmissions(url, env, tlJson);
  }

  // ── Analysis pipeline ────────────────────────────────────────
  if (path === '/tl/analyse' && method === 'POST') {
    return handleTlAnalyse(request, env, tlJson);
  }

  // ── Credits ─────────────────────────────────────────────────
  if (path === '/tl/credits' && method === 'GET') {
    return handleTlGetCredits(url, env, tlJson);
  }
  if (path === '/tl/payfast-webhook' && method === 'POST') {
    return handleTlPayfast(request, env, tlJson);
  }

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

  // ── Complete-profile gate for free credits — prevents freebie farming ──
  const hasCompleteProfile = !!(reg_number && industries?.length && provinces?.length);
  const startingCredits = (free_credits && hasCompleteProfile) ? 3 : 0;

  const id = crypto.randomUUID();
  await env.TL_DB.prepare(`
    INSERT INTO tl_companies (id, name, reg_number, tax_number, vat_number, csd_maaa,
      bee_level, cidb_grade, cidb_number, industries, provinces, years_experience,
      annual_turnover, employees, phone, email, address, client_name, credits)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(id, name, reg_number||null, tax_number||null, vat_number||null, csd_maaa||null,
    bee_level||null, cidb_grade||null, cidb_number||null,
    JSON.stringify(industries||[]), JSON.stringify(provinces||[]),
    years_experience||0, annual_turnover||0, employees||0,
    normalisedPhone, normalisedEmail, address||null, client_name||null, startingCredits
  ).run();

  const message = free_credits && !hasCompleteProfile
    ? 'Account created. Add your registration number and at least one industry + province to unlock 3 free analyses.'
    : null;

  return tlJson({ success: true, company_id: id, credits: startingCredits, message });
}

// ── GET COMPANY PROFILE ──────────────────────────────────────────
async function handleTlGetCompany(url, env, tlJson) {
  const id = url.searchParams.get('id');
  if (!id) return tlJson({ error: 'id required' }, 400);
  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);
  return tlJson(company);
}

// ── SUBMIT TENDER DOCUMENT ───────────────────────────────────────
async function handleTlSubmit(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id, tender_ref, tender_title, department, province, category, doc_text } = body;

  if (!company_id || !doc_text) return tlJson({ error: 'company_id and doc_text required' }, 400);

  // Check credits
  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);
  if ((company.credits || 0) < 1) return tlJson({ error: 'Insufficient credits. Please top up.' }, 402);

  const id = crypto.randomUUID();

  // Store doc in R2
  const docKey = `submissions/${company_id}/${id}/tender.txt`;
  await env.TL_DOCS.put(docKey, doc_text);

  // Create submission record
  await env.TL_DB.prepare(`
    INSERT INTO tl_submissions (id, company_id, tender_ref, tender_title, department, province, category, doc_r2_key, status, credits_used)
    VALUES (?,?,?,?,?,?,?,?,'processing',1)
  `).bind(id, company_id, tender_ref||null, tender_title||null, department||null,
    province||null, category||null, docKey
  ).run();

  // Deduct credit
  await env.TL_DB.prepare('UPDATE tl_companies SET credits=credits-1 WHERE id=?').bind(company_id).run();
  await env.TL_DB.prepare(`INSERT INTO tl_credits (id, company_id, amount, type, submission_id) VALUES (?,?,?,'used',?)`)
    .bind(crypto.randomUUID(), company_id, -1, id).run();

  // Run analysis in background
  const ctx = { waitUntil: (p) => p }; // placeholder — real ctx passed from main handler
  runTlAnalysis(id, company, doc_text, env).catch(e => console.error('TL analysis failed:', e.message));

  return tlJson({ success: true, submission_id: id, status: 'processing' });
}

// ── ANALYSIS PIPELINE ────────────────────────────────────────────
async function runTlAnalysis(submission_id, company, doc_text, env) {
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

    // Fetch OCDS competitive intelligence for this category/province
    const submission = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(submission_id).first();
    let ocdsContext = '';
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

    // Run Claude analysis
    const prompt = `You are a South African tender bid intelligence analyst. Analyse this tender document and produce a structured bid intelligence report.

COMPANY PROFILE:
${companyContext}

RECENT MARKET DATA (National Treasury OCDS):${ocdsContext || ' Not available for this category'}

TENDER DOCUMENT:
${doc_text.slice(0, 50000)}

Produce a JSON report with this exact structure:
{
  "verdict": "GO" | "NO_GO" | "CONDITIONAL_GO",
  "verdict_summary": "2-3 sentence summary of the recommendation",
  "eligibility": [
    { "requirement": "string", "detail": "string", "status": "MET" | "UNMET" | "UNKNOWN", "notes": "string" }
  ],
  "compliance_checklist": [
    { "item": "string", "risk_level": "HIGH" | "MEDIUM" | "LOW", "notes": "string" }
  ],
  "boq": [
    { "line_item": "string", "unit": "string", "quantity": number, "unit_rate": number, "total": number, "confidence": "HIGH" | "MEDIUM" | "LOW", "source": "string" }
  ],
  "boq_totals": {
    "subtotal": number,
    "margin_30pct": number,
    "recommended_bid": number,
    "conservative_bid": number,
    "aggressive_bid": number
  },
  "competitive_landscape": "paragraph describing competition",
  "risk_flags": [
    { "flag": "string", "severity": "HIGH" | "MEDIUM" | "LOW", "mitigation": "string" }
  ],
  "pricing_disclaimer": "All pricing is indicative, based on AECOM 2025 benchmarks, ASAQS norms, Stats SA P01511 indices and DPSA salary scales. A 30% contractor margin has been applied. Verify all line items with your suppliers before submission."
}

Return ONLY valid JSON. No markdown. No explanation.`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    const rawText = aiData.content?.[0]?.text || '{}';

    // Parse JSON
    let report;
    try {
      report = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch(e) {
      report = { verdict: 'ERROR', verdict_summary: 'Analysis failed — please retry', raw: rawText };
    }

    // Store report in R2
    const reportKey = `submissions/${submission_id}/report.json`;
    await env.TL_DOCS.put(reportKey, JSON.stringify(report));

    // Update submission
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
    'SELECT id, tender_ref, tender_title, status, verdict, created_at FROM tl_submissions WHERE company_id=? ORDER BY created_at DESC LIMIT 20'
  ).bind(company_id).all();
  return tlJson({ submissions: subs.results || [] });
}

// ── GET CREDITS ──────────────────────────────────────────────────
async function handleTlGetCredits(url, env, tlJson) {
  const company_id = url.searchParams.get('company_id');
  if (!company_id) return tlJson({ error: 'company_id required' }, 400);
  const company = await env.TL_DB.prepare('SELECT credits FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);
  return tlJson({ credits: company.credits || 0 });
}

// ── PAYFAST WEBHOOK ──────────────────────────────────────────────
async function handleTlPayfast(request, env, tlJson) {
  const text = await request.text();
  const params = new URLSearchParams(text);
  const status = params.get('payment_status');
  const company_id = params.get('custom_str1');
  const amount = parseFloat(params.get('amount_gross') || '0');

  if (status !== 'COMPLETE' || !company_id) return tlJson({ ok: true });

  // R199 = 10 credits, R499 = 30 credits, R999 = 75 credits
  let credits = 0;
  if (amount >= 999) credits = 75;
  else if (amount >= 499) credits = 30;
  else if (amount >= 199) credits = 10;

  if (credits > 0) {
    await env.TL_DB.prepare('UPDATE tl_companies SET credits=credits+? WHERE id=?').bind(credits, company_id).run();
    await env.TL_DB.prepare(`INSERT INTO tl_credits (id, company_id, amount, type, payfast_id) VALUES (?,?,?,'purchase',?)`)
      .bind(crypto.randomUUID(), company_id, credits, params.get('pf_payment_id')||null).run();
  }

  return tlJson({ ok: true });
}

// ── ANALYSE ENDPOINT (direct text submission) ────────────────────
async function handleTlAnalyse(request, env, tlJson) {
  const body = await request.json().catch(() => ({}));
  const { company_id, doc_text, tender_ref } = body;
  if (!company_id || !doc_text) return tlJson({ error: 'company_id and doc_text required' }, 400);

  const company = await env.TL_DB.prepare('SELECT * FROM tl_companies WHERE id=? LIMIT 1').bind(company_id).first();
  if (!company) return tlJson({ error: 'Company not found' }, 404);
  if ((company.credits || 0) < 1) return tlJson({ error: 'Insufficient credits' }, 402);

  const id = crypto.randomUUID();
  await env.TL_DB.prepare(`INSERT INTO tl_submissions (id, company_id, tender_ref, status, credits_used) VALUES (?,?,?,'processing',1)`)
    .bind(id, company_id, tender_ref||null).run();
  await env.TL_DB.prepare('UPDATE tl_companies SET credits=credits-1 WHERE id=?').bind(company_id).run();

  // Run analysis — wait for result on this endpoint
  await runTlAnalysis(id, company, doc_text, env);

  const sub = await env.TL_DB.prepare('SELECT * FROM tl_submissions WHERE id=? LIMIT 1').bind(id).first();
  if (sub?.report_json) sub.report = JSON.parse(sub.report_json);

  return tlJson({ submission_id: id, ...sub });
}
