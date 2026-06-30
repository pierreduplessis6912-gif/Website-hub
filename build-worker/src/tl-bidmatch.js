// ── BIDMATCH ──────────────────────────────────────────────────────────────
// Watches new OCDS tender notices and matches them against registered
// company profiles (industries + provinces). Sends WhatsApp alerts for
// matches not yet alerted. Free top-of-funnel — drives Go/No-Go purchases.

const OCDS_BASE = 'https://ocds-api.etenders.gov.za/api/OCDSReleases';

// Keyword map: company industry text -> OCDS category match patterns
const INDUSTRY_CATEGORY_MAP = {
  'cleaning services': ['cleaning', 'functional', 'building services'],
  'security': ['security', 'guarding'],
  'construction': ['construction', 'works', 'building', 'civil'],
  'engineering': ['engineering', 'professional', 'consulting'],
  'it': ['computer', 'software', 'information technology', 'programming'],
  'catering': ['food', 'beverage', 'catering'],
  'transport': ['transport', 'logistics', 'freight'],
  'supply': ['supplies', 'goods', 'equipment'],
  'facilities management': ['facilities', 'maintenance', 'building services'],
  'hr': ['employment', 'labour', 'recruitment'],
  'electrical': ['electrical', 'electrical engineering'],
  'plumbing': ['plumbing', 'mechanical'],
  'landscaping': ['landscaping', 'gardening', 'horticulture'],
  'legal': ['legal', 'law'],
  'accounting': ['accounting', 'audit', 'financial'],
  'medical': ['medical', 'health', 'pharmaceutical'],
};

const PROVINCE_ALIASES = {
  'GP': 'gauteng', 'KZN': 'kwazulu-natal', 'WC': 'western cape', 'EC': 'eastern cape',
  'LP': 'limpopo', 'MP': 'mpumalanga', 'NW': 'north west', 'FS': 'free state', 'NC': 'northern cape'
};

// ── Confidence scoring — returns 0-100, or null if no match at all ────────
function scoreMatch(company, release) {
  const tender = release.tender || {};
  const category = (tender.category || '').toLowerCase();
  const province = (tender.province || '').toLowerCase();
  if (!category) return null;

  let industryScore = 0;
  let bestIndustryMatch = null;
  for (const industry of company.industries) {
    const industryLower = industry.toLowerCase();
    // Exact phrase match — strongest signal
    if (category === industryLower) { industryScore = 40; bestIndustryMatch = industry; break; }
    if (category.includes(industryLower) || industryLower.includes(category)) {
      industryScore = Math.max(industryScore, 30);
      bestIndustryMatch = industry;
      continue;
    }
    // Keyword map match — weaker signal
    for (const [key, patterns] of Object.entries(INDUSTRY_CATEGORY_MAP)) {
      if (industryLower.includes(key) && patterns.some(p => category.includes(p))) {
        industryScore = Math.max(industryScore, 20);
        bestIndustryMatch = bestIndustryMatch || industry;
      }
    }
  }
  if (industryScore === 0) return null; // no industry relevance at all — exclude

  let provinceScore = 0;
  if (!province) {
    provinceScore = 15; // national/unspecified — neutral, still relevant
  } else if (company.provinces.length) {
    const exactMatch = company.provinces.some(p => {
      const expanded = PROVINCE_ALIASES[p] || p.toLowerCase();
      return province === expanded;
    });
    const looseMatch = company.provinces.some(p => {
      const expanded = PROVINCE_ALIASES[p] || p.toLowerCase();
      return province.includes(expanded) || expanded.includes(province);
    });
    if (exactMatch) provinceScore = 30;
    else if (looseMatch) provinceScore = 20;
    else return null; // wrong province entirely — exclude
  } else {
    return null; // company has no provinces set, tender has a specific province — can't confirm relevance
  }

  // Closing date proximity — sweet spot 10-30 days gives full marks
  let timingScore = 10;
  if (tender.tenderPeriod?.endDate) {
    const daysLeft = Math.round((new Date(tender.tenderPeriod.endDate) - new Date()) / (1000*60*60*24));
    if (daysLeft < 3) timingScore = 0;        // too soon to realistically prepare
    else if (daysLeft <= 9) timingScore = 5;
    else if (daysLeft <= 30) timingScore = 20; // sweet spot
    else timingScore = 12;                     // far out, still useful but less urgent
  }

  const total = Math.min(100, industryScore + provinceScore + timingScore);
  return { score: total, matchedIndustry: bestIndustryMatch };
}

// ── Main BidMatch run — pulls + matches + STORES (no WhatsApp send yet) ──
// Stores matches in tl_bidmatch_results for dashboard display. WhatsApp
// alerting is deferred until matching quality is validated against real
// companies.
export async function runBidMatch(env, dateFrom, dateTo) {
  const runId = crypto.randomUUID();
  let tendersChecked = 0;
  let matchesStored = 0;

  try {
    const url = `${OCDS_BASE}?PageNumber=1&PageSize=200&dateFrom=${dateFrom}&dateTo=${dateTo}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { success: false, error: `OCDS API error ${res.status}` };
    const data = await res.json();
    const releases = data.releases || [];

    const activeTenders = releases.filter(r => {
      const status = r.tender?.status;
      return status === 'active' || status === 'planning';
    });

    if (activeTenders.length === 0) {
      return { success: true, tendersChecked: 0, matchesStored: 0, message: 'No active tenders in range' };
    }

    const companies = await env.TL_DB.prepare(`
      SELECT id, name, phone, industries, provinces FROM tl_companies
      WHERE industries IS NOT NULL AND industries != '[]'
        AND provinces IS NOT NULL AND provinces != '[]'
    `).all();

    const companyList = (companies.results || []).map(c => ({
      ...c,
      industries: JSON.parse(c.industries || '[]'),
      provinces: JSON.parse(c.provinces || '[]'),
    }));

    for (const release of activeTenders) {
      tendersChecked++;
      const tender = release.tender || {};
      const ocid = release.ocid;
      if (!ocid || !tender.title) continue;

      for (const company of companyList) {
        const match = scoreMatch(company, release);
        if (!match || match.score < 50) continue; // only store meaningful matches

        const matchId = `${company.id}-${ocid}`;
        const closingDate = tender.tenderPeriod?.endDate || null;
        const briefingDate = tender.briefingSession?.date || null;

        await env.TL_DB.prepare(`
          INSERT INTO tl_bidmatch_results
            (id, company_id, ocid, tender_title, category, province, buyer_name,
             closing_date, briefing_compulsory, briefing_date, document_url, detail_url,
             confidence_score, matched_industry, matched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO UPDATE SET confidence_score=excluded.confidence_score
        `).bind(
          matchId, company.id, ocid, tender.title, tender.category || null,
          tender.province || null, release.buyer?.name || null,
          closingDate, tender.briefingSession?.compulsory ? 1 : 0, briefingDate,
          tender.documents?.[0]?.url || null,
          `https://www.etenders.gov.za/Home/opportunities?id=${ocid}`,
          match.score, match.matchedIndustry
        ).run().then(r => { if (r.meta?.changes) matchesStored++; }).catch(e =>
          console.warn('[BidMatch] store failed:', e.message)
        );
      }
    }

    return { success: true, tendersChecked, matchesStored, runId };

  } catch(e) {
    console.error('[BidMatch] Failed:', e.message);
    return { success: false, error: e.message, tendersChecked, matchesStored };
  }
}

// ── Get matches for a company's dashboard — top 5 by confidence ───────────
export async function getCompanyMatches(env, companyId, limit = 5) {
  const results = await env.TL_DB.prepare(`
    SELECT * FROM tl_bidmatch_results
    WHERE company_id=? AND (closing_date IS NULL OR closing_date > datetime('now'))
    ORDER BY confidence_score DESC, matched_at DESC LIMIT ?
  `).bind(companyId, limit).all();
  return results.results || [];
}

