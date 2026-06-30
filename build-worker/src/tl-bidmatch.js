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

function matchesIndustry(companyIndustries, tenderCategory) {
  if (!tenderCategory) return false;
  const catLower = tenderCategory.toLowerCase();
  for (const industry of companyIndustries) {
    const industryLower = industry.toLowerCase();
    // Direct substring match
    if (catLower.includes(industryLower) || industryLower.includes(catLower)) return true;
    // Keyword map match
    for (const [key, patterns] of Object.entries(INDUSTRY_CATEGORY_MAP)) {
      if (industryLower.includes(key)) {
        if (patterns.some(p => catLower.includes(p))) return true;
      }
    }
  }
  return false;
}

function matchesProvince(companyProvinces, tenderProvince) {
  if (!tenderProvince) return true; // national/unspecified tenders match everyone
  if (!companyProvinces.length) return false;
  const PROVINCE_ALIASES = {
    'GP': 'gauteng', 'KZN': 'kwazulu-natal', 'WC': 'western cape', 'EC': 'eastern cape',
    'LP': 'limpopo', 'MP': 'mpumalanga', 'NW': 'north west', 'FS': 'free state', 'NC': 'northern cape'
  };
  const tenderProvLower = tenderProvince.toLowerCase();
  return companyProvinces.some(p => {
    const expanded = PROVINCE_ALIASES[p] || p.toLowerCase();
    return tenderProvLower.includes(expanded) || expanded.includes(tenderProvLower);
  });
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
        const industryMatch = matchesIndustry(company.industries, tender.category);
        const provinceMatch = matchesProvince(company.provinces, tender.province);
        if (!industryMatch || !provinceMatch) continue;

        const matchId = `${company.id}-${ocid}`;
        const closingDate = tender.tenderPeriod?.endDate || null;
        const briefingDate = tender.briefingSession?.date || null;

        await env.TL_DB.prepare(`
          INSERT INTO tl_bidmatch_results
            (id, company_id, ocid, tender_title, category, province, buyer_name,
             closing_date, briefing_compulsory, briefing_date, document_url, detail_url, matched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(id) DO NOTHING
        `).bind(
          matchId, company.id, ocid, tender.title, tender.category || null,
          tender.province || null, release.buyer?.name || null,
          closingDate, tender.briefingSession?.compulsory ? 1 : 0, briefingDate,
          tender.documents?.[0]?.url || null,
          `https://www.etenders.gov.za/Home/opportunities?id=${ocid}`
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

// ── Get matches for a company's dashboard ──────────────────────────────────
export async function getCompanyMatches(env, companyId, limit = 20) {
  const results = await env.TL_DB.prepare(`
    SELECT * FROM tl_bidmatch_results
    WHERE company_id=? AND closing_date > datetime('now')
    ORDER BY matched_at DESC LIMIT ?
  `).bind(companyId, limit).all();
  return results.results || [];
}
