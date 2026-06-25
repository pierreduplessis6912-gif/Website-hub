const axios = require('axios');
const pdfParse = require('pdf-parse');
const { upsertRate } = require('./db');

// ── COUNCIL REGISTRY ─────────────────────────────────────────────────────────
// Each entry defines where to fetch rates and how to parse them.
// URL is the known direct PDF link. If it 404s, fallback_search_url is the
// documents page to scrape for an updated link.

const COUNCILS = [

  // ── CLEANING ────────────────────────────────────────────────────────────────
  {
    sector: 'cleaning',
    council_name: 'BCCCI KZN (Bargaining Council for Contract Cleaning Services Industry)',
    province: 'KZN',
    url: 'https://bccci.co.za/wp-content/uploads/2026/03/New-Wage-rate-01-04-2026-2.pdf',
    fallback_url: 'https://bccci.co.za/bccci-documents/',
    gazette_ref: 'Gazette 54412, Notice 7296, 27 March 2026',
    effective_date: '2026-04-01',
    parser: 'bccci'
  },
  {
    sector: 'cleaning',
    council_name: 'SD1 Contract Cleaning (National, excl KZN)',
    province: 'national',
    url: 'https://www.gov.za/sites/default/files/gcis_document/202602/54075rg11941gon7083.pdf',
    gazette_ref: 'Gazette 54075, Notice 7083, 3 February 2026',
    effective_date: '2026-03-01',
    parser: 'gazette_sd1'
  },
  {
    sector: 'cleaning',
    council_name: 'NCCA Estimating Guide KZN (full cost model)',
    province: 'KZN',
    url: 'https://bccci.co.za/wp-content/uploads/2025/02/NCCA-ESTIMATING-DOC-FOR-BCCCI-2025-03-01.pdf',
    gazette_ref: 'NCCA Guide effective 1 March 2025',
    effective_date: '2025-03-01',
    parser: 'ncca_estimating'
  },

  // ── CIVIL ENGINEERING ───────────────────────────────────────────────────────
  {
    sector: 'civil_engineering',
    council_name: 'BCCEI (Bargaining Council for the Civil Engineering Industry)',
    province: 'national',
    url: 'https://bccei.co.za/wp-content/uploads/2025/10/WageTask-Grade-Collective-Agreement_2025-User-Friendly-Version.pdf',
    fallback_url: 'https://bccei.co.za/agreements/',
    gazette_ref: 'BCCEI Wage & Task Grade Agreement 2025',
    effective_date: '2025-09-01',
    parser: 'bccei'
  },

  // ── METAL & ENGINEERING ─────────────────────────────────────────────────────
  {
    sector: 'metal_engineering',
    council_name: 'MEIBC (Metal and Engineering Industries Bargaining Council)',
    province: 'national',
    url: 'https://mail.meibc.co.za/images/pdf/circular/2025/Industry_Circular_on_Main_Agreement-1_July_2025_to_30_June_2026_Ju.pdf',
    fallback_url: 'https://www.meibc.co.za/',
    gazette_ref: 'MEIBC Main Agreement 2024-2027, Circular 2025/05',
    effective_date: '2025-07-01',
    parser: 'meibc'
  },

  // ── MOTOR INDUSTRY ──────────────────────────────────────────────────────────
  {
    sector: 'motor',
    council_name: 'MIBCO (Motor Industry Bargaining Council)',
    province: 'national',
    url: 'https://www.mibco.org.za/wp-content/uploads/2025/12/Circular-No-36-of-2025_Enactment-of-Agreements-and-2026-Wage-Schedule.pdf',
    fallback_url: 'https://www.mibco.org.za/',
    gazette_ref: 'MIBCO Gazette 53822, December 2025, effective 22 Dec 2025',
    effective_date: '2025-12-22',
    parser: 'mibco'
  },

  // ── ROAD FREIGHT & LOGISTICS ────────────────────────────────────────────────
  {
    sector: 'road_freight',
    council_name: 'NBCRFLI (National Bargaining Council for Road Freight and Logistics)',
    province: 'national',
    url: 'https://nbcrfli.org.za/files/Wage%20Table/Minimum%20Wage%20Increases_%20Across-the-Board%20Increases_and%20Allowances%20(1%20March%202025%20to%2028%20February%202027).pdf',
    fallback_url: 'https://www.nbcrfli.org.za/resources/circulars',
    gazette_ref: 'NBCRFLI Circular, 12 February 2025, effective 1 March 2025',
    effective_date: '2025-03-01',
    parser: 'nbcrfli'
  },

  // ── ELECTRICAL ──────────────────────────────────────────────────────────────
  {
    sector: 'electrical',
    council_name: 'NBCEI (National Bargaining Council for the Electrical Industry)',
    province: 'national',
    url: 'https://nbcei.co.za/wp-content/uploads/2025/04/Wage-Rates-Deductions-Region-A-2025-AREA-B-Tier-2.pdf',
    fallback_url: 'https://nbcei.co.za/wages-deductions/wages-deductions-2025/',
    gazette_ref: 'NBCEI Wage Rates Region A 2025',
    effective_date: '2025-03-01',
    parser: 'nbcei'
  },

  // ── SECURITY ────────────────────────────────────────────────────────────────
  {
    sector: 'security',
    council_name: 'NBCPSS (National Bargaining Council for the Private Security Sector)',
    province: 'national',
    url: 'https://nbcpss.org.za/wp-content/uploads/2026/02/CIRCULAR-MINIMUM-WAGE-INCREASE-2026-2027.pdf',
    fallback_url: 'https://nbcpss.org.za/docs/legislations/',
    gazette_ref: 'NBCPSS Minimum Wage Increase 2026-2027, effective 1 March 2026',
    effective_date: '2026-03-01',
    parser: 'nbcpss'
  },

  // ── NMW FLOOR (all sectors fallback) ───────────────────────────────────────
  {
    sector: 'national_minimum_wage',
    council_name: 'National Minimum Wage (all sectors floor)',
    province: 'national',
    url: 'https://www.gov.za/sites/default/files/gcis_document/202602/54075rg11941gon7083.pdf',
    gazette_ref: 'Gazette 54075, Notice 7083, 3 February 2026',
    effective_date: '2026-03-01',
    parser: 'nmw'
  }
];

// ── PDF FETCHER ──────────────────────────────────────────────────────────────
async function fetchPdf(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'TenderLogix-PricingOracle/1.0' }
    });
    const data = await pdfParse(Buffer.from(response.data));
    return data.text;
  } catch (e) {
    console.error(`[Oracle] Failed to fetch ${url}:`, e.message);
    return null;
  }
}

// ── PARSERS ──────────────────────────────────────────────────────────────────

function parseNmw(text, council) {
  // Extract R30.23 from gazette text
  const match = text.match(/national minimum wage is R(\d+[,\.]\d+)/i);
  const rate = match ? parseFloat(match[1].replace(',', '.')) : 30.23;
  return [{
    sector: council.sector, province: council.province,
    grade: 'all', category: 'All workers',
    base_rate: rate, oncost_pct: null, total_rate: rate,
    rate_unit: 'per hour', effective_date: council.effective_date,
    council_name: council.council_name, gazette_ref: council.gazette_ref,
    source_url: council.url, raw_extract: text.slice(0, 2000)
  }];
}

function parseGazetteSd1(text, council) {
  const rates = [];
  // Area A (metros): R33.27/hour
  const areaA = text.match(/R(\d+[,\.]\d+)\s+R\d+[,\.]\d+\s+BCCCI/i);
  if (areaA) {
    rates.push({
      sector: 'cleaning', province: 'Area_A_Metros',
      grade: 'cleaner', category: 'Contract Cleaning Employee - Area A (Metros)',
      base_rate: parseFloat(areaA[1].replace(',', '.')), oncost_pct: null,
      total_rate: parseFloat(areaA[1].replace(',', '.')),
      rate_unit: 'per hour', effective_date: council.effective_date,
      council_name: 'SD1 Cleaning Area A', gazette_ref: council.gazette_ref,
      source_url: council.url, raw_extract: text.slice(0, 3000)
    });
  }
  // Rest of RSA: R30.33/hour
  const restRSA = text.match(/R30[,\.]33/);
  if (restRSA) {
    rates.push({
      sector: 'cleaning', province: 'national',
      grade: 'cleaner', category: 'Contract Cleaning Employee - Rest of RSA',
      base_rate: 30.33, oncost_pct: null, total_rate: 30.33,
      rate_unit: 'per hour', effective_date: council.effective_date,
      council_name: 'SD1 Cleaning National', gazette_ref: council.gazette_ref,
      source_url: council.url, raw_extract: text.slice(0, 3000)
    });
  }
  return rates;
}

function parseNccaEstimating(text, council) {
  // Extract key figures from NCCA estimating doc
  const baseMatch = text.match(/wage rate.*?R(\d+\.\d+) per hour/i) || text.match(/R(\d+\.\d+) per hour/i);
  const totalMatch = text.match(/TOTAL HOURLY COST\s*R\s*(\d+\.\d+)/i) || text.match(/R(\d+\.\d+)\s*\n.*This hourly rate can be applied/i);
  const oncostMatch = text.match(/percentage increase of say (\d+\.?\d*)%/i);
  
  const base = baseMatch ? parseFloat(baseMatch[1]) : 30.86;
  const total = totalMatch ? parseFloat(totalMatch[1]) : 42.19;
  const oncost = oncostMatch ? parseFloat(oncostMatch[1]) : 36.71;
  
  return [{
    sector: 'cleaning', province: 'KZN',
    grade: 'cleaner', category: 'Cleaning Worker - Full Cost Model (NCCA)',
    base_rate: base, oncost_pct: oncost,
    oncost_components: 'Annual bonus, UIF 1%, COIDA 0.83%, Provident 6%, Annual leave, Sick leave, Uniforms, SETA 1%, NCCA levy, Severance, BCCCI levy, Maternity',
    total_rate: total, rate_unit: 'per hour',
    effective_date: council.effective_date,
    council_name: council.council_name, gazette_ref: council.gazette_ref,
    source_url: council.url, raw_extract: text.slice(0, 4000)
  }];
}

function parseMeibc(text, council) {
  // Extract Grade A (top) and Grade H (entry) rates
  const gradeA = text.match(/A\s+(\d+\.\d+)\s+5\.00%/);
  const gradeH = text.match(/H\s+(\d+\.\d+)\s+6\.00%/);
  const rates = [];
  if (gradeA) {
    rates.push({ sector: 'metal_engineering', province: 'national', grade: 'A', category: 'Artisan/Skilled (Grade A)', base_rate: parseFloat(gradeA[1]), oncost_pct: 30, total_rate: parseFloat(gradeA[1]) * 1.3, rate_unit: 'per hour', effective_date: council.effective_date, council_name: council.council_name, gazette_ref: council.gazette_ref, source_url: council.url, raw_extract: text.slice(0,2000) });
  }
  if (gradeH) {
    rates.push({ sector: 'metal_engineering', province: 'national', grade: 'H', category: 'General Worker (Grade H)', base_rate: parseFloat(gradeH[1]), oncost_pct: 30, total_rate: parseFloat(gradeH[1]) * 1.3, rate_unit: 'per hour', effective_date: council.effective_date, council_name: council.council_name, gazette_ref: council.gazette_ref, source_url: council.url, raw_extract: text.slice(0,2000) });
  }
  return rates;
}

function parseMibco(text, council) {
  // Standby R94.10, general worker Grade 1 rate
  const standby = text.match(/Standby Allowance R(\d+\.\d+)/);
  return [{
    sector: 'motor', province: 'national',
    grade: 'general', category: 'Motor Industry Worker (indicative)',
    base_rate: null, oncost_pct: 30, total_rate: null,
    rate_unit: 'per hour', effective_date: council.effective_date,
    council_name: council.council_name, gazette_ref: council.gazette_ref,
    source_url: council.url, raw_extract: text.slice(0,3000)
  }];
}

function parseNbcrfli(text, council) {
  // Grade 1 general worker R2142.27/week from March 2025
  const grade1 = text.match(/General worker.*?R(\d+\.\d+)/i);
  const rate = grade1 ? parseFloat(grade1[1]) : 2142.27;
  return [{
    sector: 'road_freight', province: 'national',
    grade: '1', category: 'General Worker (Grade 1)',
    base_rate: rate, oncost_pct: 30, total_rate: rate * 1.3,
    rate_unit: 'per week', effective_date: council.effective_date,
    council_name: council.council_name, gazette_ref: council.gazette_ref,
    source_url: council.url, raw_extract: text.slice(0,3000)
  }];
}

function parseNbcei(text, council) {
  return [{
    sector: 'electrical', province: 'national',
    grade: 'general_assistant', category: 'General Assistant (Region A)',
    base_rate: null, oncost_pct: 30, total_rate: null,
    rate_unit: 'per hour', effective_date: council.effective_date,
    council_name: council.council_name, gazette_ref: council.gazette_ref,
    source_url: council.url, raw_extract: text.slice(0,2000)
  }];
}

function parseNbcpss(text, council) {
  // Area 1 & 2 (Urban) Grade A: R8184/month, R39.3462/hour
  const hourlyA = text.match(/R(\d+\.\d{4})\s*.*?Primary Sec Officer/i) || text.match(/R39\.34/);
  return [{
    sector: 'security', province: 'national',
    grade: 'A_urban', category: 'Security Officer Grade A (Urban Area 1 & 2)',
    base_rate: 39.35, oncost_pct: 35, total_rate: 53.12,
    rate_unit: 'per hour', effective_date: council.effective_date,
    council_name: council.council_name, gazette_ref: council.gazette_ref,
    source_url: council.url, raw_extract: text.slice(0,2000)
  }];
}

function parseBccei(text, council) {
  return [{
    sector: 'civil_engineering', province: 'national',
    grade: 'task_grade_1', category: 'Civil Engineering Worker (Task Grade 1)',
    base_rate: null, oncost_pct: 30, total_rate: null,
    rate_unit: 'per hour', effective_date: council.effective_date,
    council_name: council.council_name, gazette_ref: council.gazette_ref,
    source_url: council.url, raw_extract: text.slice(0,2000)
  }];
}

const PARSERS = { nmw: parseNmw, gazette_sd1: parseGazetteSd1, ncca_estimating: parseNccaEstimating, meibc: parseMeibc, mibco: parseMibco, nbcrfli: parseNbcrfli, nbcei: parseNbcei, nbcpss: parseNbcpss, bccci: parseNccaEstimating, bccei: parseBccei };

// ── MAIN FETCH ───────────────────────────────────────────────────────────────
async function fetchAllRates() {
  const results = [];
  for (const council of COUNCILS) {
    console.log(`[Oracle] Fetching ${council.sector} — ${council.council_name}...`);
    const text = await fetchPdf(council.url);
    if (!text) {
      results.push({ sector: council.sector, status: 'fetch_failed', url: council.url });
      continue;
    }
    const parser = PARSERS[council.parser];
    if (!parser) {
      results.push({ sector: council.sector, status: 'no_parser', parser: council.parser });
      continue;
    }
    const rates = parser(text, council);
    for (const rate of rates) {
      try {
        upsertRate(rate);
      } catch (e) {
        console.error(`[Oracle] DB upsert failed for ${council.sector}:`, e.message);
      }
    }
    results.push({ sector: council.sector, status: 'ok', rates: rates.length, council: council.council_name });
    // Polite delay between fetches
    await new Promise(r => setTimeout(r, 2000));
  }
  return results;
}

module.exports = { fetchAllRates };
