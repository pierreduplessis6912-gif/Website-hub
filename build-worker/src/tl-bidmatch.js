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

// ── Main BidMatch run — call from cron ─────────────────────────────────────
export async function runBidMatch(env, dateFrom, dateTo) {
  const runId = crypto.randomUUID();
  let tendersChecked = 0;
  let alertsSent = 0;

  try {
    // Pull today's (or specified range) tender notices
    const url = `${OCDS_BASE}?PageNumber=1&PageSize=200&dateFrom=${dateFrom}&dateTo=${dateTo}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { success: false, error: `OCDS API error ${res.status}` };
    const data = await res.json();
    const releases = data.releases || [];

    // Only consider active/new tenders (not already closed/awarded)
    const activeTenders = releases.filter(r => {
      const status = r.tender?.status;
      return status === 'active' || status === 'planning';
    });

    if (activeTenders.length === 0) {
      return { success: true, tendersChecked: 0, alertsSent: 0, message: 'No active tenders in range' };
    }

    // Get all companies with industries + provinces set, plus their phone
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

        // Check if already alerted — dedup
        const alertKey = `bidmatch:${company.id}:${ocid}`;
        const alreadyAlerted = await env.SITES.get(alertKey).catch(() => null);
        if (alreadyAlerted) continue;

        // Send WhatsApp alert
        if (company.phone) {
          const closingDate = tender.tenderPeriod?.endDate
            ? new Date(tender.tenderPeriod.endDate).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' })
            : 'Not specified';
          const briefingNote = tender.briefingSession?.compulsory
            ? `\n⚠️ Compulsory briefing: ${tender.briefingSession.date ? new Date(tender.briefingSession.date).toLocaleDateString('en-ZA') : 'See tender doc'}`
            : '';

          const alertMsg = `🎯 *New tender match*\n\n*${tender.title}*\n${tender.category || ''} — ${tender.province || 'National'}\n\nBuyer: ${release.buyer?.name || 'N/A'}\nCloses: ${closingDate}${briefingNote}\n\nCheck if you should bid → https://tenderlogix.co.za/login`;

          try {
            const { sendWhatsApp } = await import('./shared-services.js');
            await sendWhatsApp(company.phone, alertMsg, env);
            alertsSent++;
            // Mark as alerted — 60 day TTL (tenders close within that window typically)
            await env.SITES.put(alertKey, '1', { expirationTtl: 60 * 24 * 60 * 60 }).catch(() => {});
          } catch(e) {
            console.warn('[BidMatch] Alert send failed for', company.name, e.message);
          }
        }
      }
    }

    return { success: true, tendersChecked, alertsSent, runId };

  } catch(e) {
    console.error('[BidMatch] Failed:', e.message);
    return { success: false, error: e.message, tendersChecked, alertsSent };
  }
}
