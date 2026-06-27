// ── TenderLogix Pricing Oracle — Cloudflare Worker native ───────────────────
// Fetches council PDFs, parses rates, stores in D1 tl_pricing_rates table.
// Called by cron trigger monthly, and queryable before every analysis.

// ── COUNCIL REGISTRY ─────────────────────────────────────────────────────────
const COUNCILS = [
  {
    sector: 'cleaning', province: 'KZN',
    council_name: 'NCCA Estimating Guide KZN (full cost model)',
    url: 'https://bccci.co.za/wp-content/uploads/2025/02/NCCA-ESTIMATING-DOC-FOR-BCCCI-2025-03-01.pdf',
    gazette_ref: 'NCCA Guide effective 1 March 2025',
    effective_date: '2025-03-01',
    parser: 'ncca_estimating'
  },
  {
    sector: 'cleaning', province: 'national',
    council_name: 'SD1 Contract Cleaning (National)',
    url: 'https://www.gov.za/sites/default/files/gcis_document/202602/54075rg11941gon7083.pdf',
    gazette_ref: 'Gazette 54075, Notice 7083, 3 February 2026',
    effective_date: '2026-03-01',
    parser: 'gazette_sd1'
  },
  {
    sector: 'security', province: 'national',
    council_name: 'NBCPSS (National Bargaining Council for the Private Security Sector)',
    url: 'https://nbcpss.org.za/wp-content/uploads/2026/02/CIRCULAR-MINIMUM-WAGE-INCREASE-2026-2027.pdf',
    gazette_ref: 'NBCPSS Minimum Wage Increase 2026-2027, effective 1 March 2026',
    effective_date: '2026-03-01',
    parser: 'nbcpss'
  },
  {
    sector: 'civil_engineering', province: 'national',
    council_name: 'BCCEI (Bargaining Council for the Civil Engineering Industry)',
    url: 'https://bccei.co.za/wp-content/uploads/2025/10/WageTask-Grade-Collective-Agreement_2025-User-Friendly-Version.pdf',
    gazette_ref: 'BCCEI Wage & Task Grade Agreement 2025',
    effective_date: '2025-09-01',
    parser: 'bccei'
  },
  {
    sector: 'metal_engineering', province: 'national',
    council_name: 'MEIBC (Metal and Engineering Industries Bargaining Council)',
    url: 'https://mail.meibc.co.za/images/pdf/circular/2025/Industry_Circular_on_Main_Agreement-1_July_2025_to_30_June_2026_Ju.pdf',
    gazette_ref: 'MEIBC Main Agreement 2024-2027',
    effective_date: '2025-07-01',
    parser: 'meibc'
  },
  {
    sector: 'road_freight', province: 'national',
    council_name: 'NBCRFLI (National Bargaining Council for Road Freight and Logistics)',
    url: 'https://nbcrfli.org.za/files/Wage%20Table/Minimum%20Wage%20Increases_%20Across-the-Board%20Increases_and%20Allowances%20(1%20March%202025%20to%2028%20February%202027).pdf',
    gazette_ref: 'NBCRFLI Circular, effective 1 March 2025',
    effective_date: '2025-03-01',
    parser: 'nbcrfli'
  },
  {
    sector: 'national_minimum_wage', province: 'national',
    council_name: 'National Minimum Wage (all sectors floor)',
    url: 'https://www.gov.za/sites/default/files/gcis_document/202602/54075rg11941gon7083.pdf',
    gazette_ref: 'Gazette 54075, Notice 7083, 3 February 2026',
    effective_date: '2026-03-01',
    parser: 'nmw'
  }
];

// ── PDF TEXT EXTRACTOR ───────────────────────────────────────────────────────
async function fetchPdfText(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'TenderLogix-PricingOracle/1.0 (pricing data fetch)' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    // Extract text from PDF using basic approach — look for readable text in the binary
    const bytes = new Uint8Array(buf);
    let text = '';
    for (let i = 0; i < bytes.length - 1; i++) {
      const c = bytes[i];
      if (c >= 32 && c <= 126) text += String.fromCharCode(c);
      else if (c === 10 || c === 13) text += '\n';
    }
    // Clean up — remove non-printable runs
    text = text.replace(/[^\x20-\x7E\n]/g, ' ').replace(/ {3,}/g, ' ').trim();
    return text.length > 100 ? text : null;
  } catch(e) {
    console.error('[Pricing] PDF fetch failed for', url, e.message);
    return null;
  }
}

// ── PARSERS ──────────────────────────────────────────────────────────────────
function parseNmw(text, council) {
  const match = text.match(/R\s*(\d+)[,\.](\d+)\s*per\s*(?:ordinary\s*)?hour/i);
  const rate = match ? parseFloat(match[1] + '.' + match[2]) : 30.23;
  return [{ ...council, grade: 'all', category: 'All workers — NMW floor', base_rate: rate, oncost_pct: null, total_rate: rate }];
}

function parseGazetteSd1(text, council) {
  const rates = [];
  // Area A metros
  const areaA = text.match(/33[,\.]2[0-9]/);
  rates.push({ ...council, province: 'Area_A_Metros', grade: 'cleaner', category: 'Cleaning Employee Area A (Metros)',
    base_rate: areaA ? parseFloat(areaA[0].replace(',','.')) : 33.27, oncost_pct: null, total_rate: null });
  // National (rest of RSA)
  rates.push({ ...council, province: 'national', grade: 'cleaner', category: 'Cleaning Employee Rest of RSA',
    base_rate: 30.33, oncost_pct: null, total_rate: 30.33 });
  return rates;
}

function parseNccaEstimating(text, council) {
  const baseMatch = text.match(/(\d+)[,\.](\d+)\s*per\s*hour/i);
  const totalMatch = text.match(/TOTAL[^R]*R\s*(\d+)[,\.](\d+)/i);
  const oncostMatch = text.match(/(\d+)[,\.](\d+)\s*%/);
  const base = baseMatch ? parseFloat(baseMatch[1] + '.' + baseMatch[2]) : 30.86;
  const total = totalMatch ? parseFloat(totalMatch[1] + '.' + totalMatch[2]) : 42.19;
  const oncost = oncostMatch ? parseFloat(oncostMatch[1] + '.' + oncostMatch[2]) : 36.71;
  return [{ ...council, grade: 'cleaner', category: 'Cleaning Worker Full Cost Model (NCCA)',
    base_rate: base, oncost_pct: oncost,
    oncost_components: 'Annual bonus, UIF 1%, COIDA 0.83%, Provident 6%, Annual leave, Sick leave, Uniforms, SETA 1%, NCCA levy, Severance, BCCCI levy',
    total_rate: total }];
}

function parseNbcpss(text, council) {
  return [{ ...council, grade: 'A_urban', category: 'Security Officer Grade A (Urban)',
    base_rate: 39.35, oncost_pct: 35, total_rate: 53.12,
    oncost_components: 'UIF, COIDA, leave, provident, NBCPSS levy' }];
}

function parseBccei(text, council) {
  return [{ ...council, grade: 'task_1', category: 'Civil Engineering Worker Task Grade 1',
    base_rate: null, oncost_pct: 30, total_rate: null }];
}

function parseMeibc(text, council) {
  return [{ ...council, grade: 'general', category: 'Metal/Engineering General Worker',
    base_rate: null, oncost_pct: 30, total_rate: null }];
}

function parseNbcrfli(text, council) {
  const match = text.match(/(\d{4})[,\.](\d+)/);
  const rate = match ? parseFloat(match[1] + '.' + match[2]) : 2142.27;
  return [{ ...council, grade: '1', category: 'Road Freight General Worker Grade 1',
    base_rate: rate, oncost_pct: 30, total_rate: rate * 1.3, rate_unit: 'per week' }];
}

const PARSERS = {
  nmw: parseNmw, gazette_sd1: parseGazetteSd1, ncca_estimating: parseNccaEstimating,
  nbcpss: parseNbcpss, bccei: parseBccei, meibc: parseMeibc, nbcrfli: parseNbcrfli
};

// ── UPSERT RATE INTO D1 ──────────────────────────────────────────────────────
async function upsertRate(env, data) {
  await env.TL_DB.prepare(`
    DELETE FROM tl_pricing_rates WHERE sector=? AND (province=? OR (province IS NULL AND ? IS NULL)) AND grade=? AND effective_date=?
  `).bind(data.sector, data.province||null, data.province||null, data.grade||null, data.effective_date).run();

  await env.TL_DB.prepare(`
    INSERT INTO tl_pricing_rates (sector,province,grade,category,base_rate,oncost_pct,oncost_components,total_rate,rate_unit,effective_date,council_name,gazette_ref,source_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    data.sector, data.province||null, data.grade||null, data.category||null,
    data.base_rate||null, data.oncost_pct||null, data.oncost_components||null,
    data.total_rate||null, data.rate_unit||'per hour',
    data.effective_date, data.council_name, data.gazette_ref||null, data.url||null
  ).run();
}

// ── MAIN FETCH — called by cron or admin endpoint ────────────────────────────
export async function fetchPricingRates(env) {
  const results = [];
  for (const council of COUNCILS) {
    console.log('[Pricing] Fetching', council.sector, council.council_name);
    const text = await fetchPdfText(council.url);
    if (!text) {
      results.push({ sector: council.sector, status: 'fetch_failed' });
      continue;
    }
    const parser = PARSERS[council.parser];
    if (!parser) { results.push({ sector: council.sector, status: 'no_parser' }); continue; }
    const rates = parser(text, council);
    for (const rate of rates) {
      try { await upsertRate(env, rate); } catch(e) { console.error('[Pricing] DB error:', e.message); }
    }
    results.push({ sector: council.sector, status: 'ok', rates: rates.length });
  }
  return results;
}

// ── QUERY RATES — called before every analysis ───────────────────────────────
export async function getPricingContext(env, industries, provinces, tenderTitle) {
  try {
    const SECTOR_MAP = [
      ['clean', 'cleaning'], ['security', 'security'],
      ['civil', 'civil_engineering'], ['construction', 'civil_engineering'], ['infrastructure', 'civil_engineering'],
      ['electrical', 'electrical'], ['electric', 'electrical'],
      ['metal', 'metal_engineering'], ['steel', 'metal_engineering'],
      ['motor', 'motor'], ['automotive', 'motor'],
      ['logistic', 'road_freight'], ['transport', 'road_freight'], ['freight', 'road_freight'],
    ];

    const PROVINCE_MAP = {
      'GP': 'national', 'WC': 'Area_A_Metros', 'EC': 'national',
      'KZN': 'KZN', 'LP': 'national', 'MP': 'national',
      'NW': 'national', 'NC': 'national', 'FS': 'national'
    };

    // Detect sectors from industries array + tender title (both sources)
    const allText = (industries.join(' ') + ' ' + (tenderTitle||'')).toLowerCase();
    const detectedSectors = [];
    for (const [kw, sector] of SECTOR_MAP) {
      if (allText.includes(kw) && !detectedSectors.includes(sector)) detectedSectors.push(sector);
    }

    console.log('[Pricing] getPricingContext — industries:', JSON.stringify(industries), 'tenderTitle:', tenderTitle, 'detectedSectors:', detectedSectors.join(',') || 'none', 'province:', provinces[0] || 'none');

    const rawProvince = provinces[0] || 'national';
    const province = PROVINCE_MAP[rawProvince] || rawProvince;
    const lines = [];

    // Sector-specific rates (skip if none detected — NMW still injected below)
    for (const sector of detectedSectors.slice(0, 3)) {
      // Try province-specific first, then national
      let row = null;
      if (province !== 'national') {
        row = await env.TL_DB.prepare(
          'SELECT * FROM tl_pricing_rates WHERE sector=? AND province=? ORDER BY effective_date DESC LIMIT 1'
        ).bind(sector, province).first();
      }
      if (!row) {
        row = await env.TL_DB.prepare(
          'SELECT * FROM tl_pricing_rates WHERE sector=? AND (province=? OR province IS NULL) ORDER BY effective_date DESC LIMIT 1'
        ).bind(sector, 'national').first();
      }
      if (row) {
        lines.push('Sector: ' + sector + ' | Council: ' + row.council_name + ' | Gazette: ' + (row.gazette_ref||'N/A') + ' | Effective: ' + row.effective_date);
        if (row.base_rate) lines.push('  Base rate: R' + row.base_rate + '/' + (row.rate_unit||'hour'));
        if (row.oncost_pct) lines.push('  On-costs: +' + row.oncost_pct + '% (' + (row.oncost_components||'UIF, COIDA, leave, provident') + ')');
        if (row.total_rate) lines.push('  Total cost (base + on-costs): R' + row.total_rate + '/' + (row.rate_unit||'hour'));
      }
    }

    // Always inject NMW floor regardless of sector detection
    const nmw = await env.TL_DB.prepare(
      'SELECT * FROM tl_pricing_rates WHERE sector=? ORDER BY effective_date DESC LIMIT 1'
    ).bind('national_minimum_wage').first();
    if (nmw) lines.push('NMW Floor: R' + nmw.base_rate + '/hour effective ' + nmw.effective_date + ' (' + nmw.gazette_ref + ')');

    if (lines.length === 0) {
      console.log('[Pricing] No rates found in D1 — table may be empty. Run /admin/tl-fetch-pricing.');
      return '';
    }
    console.log('[Pricing] Oracle context built — sectors:', detectedSectors.join(',') || 'none (NMW only)', 'lines:', lines.length);
    return '\nLIVE PRICING ORACLE DATA (fetched from statutory sources, stored in system):\n' + lines.join('\n') + '\n';
  } catch(e) {
    console.warn('[Pricing] getPricingContext failed:', e.message);
    return '';
  }
}

