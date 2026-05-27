// ============================================================
// DESIGN DATABASE — replaces INDUSTRY_MATRIX entirely
// Source: ui-ux-pro-max-skill (nextlevelbuilder/ui-ux-pro-max-skill)
// 161 product types × WCAG-compliant palettes × 57 font pairings
// × 99 UX guidelines × 35 landing patterns × 67 UI styles
//
// Usage:
//   const brief = getDesignBrief(client.industry, client.vibe);
//   // Returns: { palette, typography, landingPattern, uxRules, unsplashQuery }
//
// No hardcoded guesses. No archetype routing. Pure data lookup.
// ============================================================

// ── RAW DATA ─────────────────────────────────────────────────
// Loaded at module init. In Cloudflare Workers, import these
// as static assets via wrangler.toml [[assets]] binding,
// or inline the parsed JSON via a build step.
// For now: inline the extracted rows we need.

// Palette data — extracted from colors.csv
// Keys map from our industry fuzzy-match to product row number
const PALETTE_DB = {
  // Row number → { productType, css custom properties }
  5:  { type:'B2B Service',                    primary:'#0F172A', onPrimary:'#FFFFFF', secondary:'#334155', accent:'#0369A1', bg:'#F8FAFC', fg:'#020617', card:'#FFFFFF', muted:'#E8ECF1', mutedFg:'#64748B', border:'#E2E8F0', ring:'#0F172A', notes:'Professional navy + blue CTA' },
  31: { type:'Hyperlocal Services',            primary:'#059669', onPrimary:'#FFFFFF', secondary:'#10B981', accent:'#EA580C', bg:'#ECFDF5', fg:'#064E3B', card:'#FFFFFF', muted:'#E8F1F3', mutedFg:'#64748B', border:'#A7F3D0', ring:'#059669', notes:'Location green + action orange' },
  32: { type:'Beauty/Spa/Wellness',            primary:'#EC4899', onPrimary:'#FFFFFF', secondary:'#F9A8D4', accent:'#8B5CF6', bg:'#FDF2F8', fg:'#831843', card:'#FFFFFF', muted:'#F1EEF5', mutedFg:'#64748B', border:'#FBCFE8', ring:'#EC4899', notes:'Soft pink + lavender luxury' },
  34: { type:'Restaurant/Food',                primary:'#DC2626', onPrimary:'#FFFFFF', secondary:'#F87171', accent:'#A16207', bg:'#FEF2F2', fg:'#450A0A', card:'#FFFFFF', muted:'#F0EDF1', mutedFg:'#64748B', border:'#FECACA', ring:'#DC2626', notes:'Appetizing red + warm gold' },
  35: { type:'Fitness/Gym',                    primary:'#F97316', onPrimary:'#0F172A', secondary:'#FB923C', accent:'#22C55E', bg:'#1F2937', fg:'#F8FAFC', card:'#313742', muted:'#37414F', mutedFg:'#94A3B8', border:'#374151', ring:'#F97316', notes:'Energy orange + success green' },
  36: { type:'Real Estate/Property',           primary:'#0F766E', onPrimary:'#FFFFFF', secondary:'#14B8A6', accent:'#0369A1', bg:'#F0FDFA', fg:'#134E4A', card:'#FFFFFF', muted:'#E8F0F3', mutedFg:'#64748B', border:'#99F6E4', ring:'#0F766E', notes:'Trust teal + professional blue' },
  39: { type:'Wedding/Events',                 primary:'#DB2777', onPrimary:'#FFFFFF', secondary:'#F472B6', accent:'#A16207', bg:'#FDF2F8', fg:'#831843', card:'#FFFFFF', muted:'#F0EDF4', mutedFg:'#64748B', border:'#FBCFE8', ring:'#DB2777', notes:'Romantic pink + elegant gold' },
  40: { type:'Legal Services',                 primary:'#1E3A8A', onPrimary:'#FFFFFF', secondary:'#1E40AF', accent:'#B45309', bg:'#F8FAFC', fg:'#0F172A', card:'#FFFFFF', muted:'#E9EEF5', mutedFg:'#64748B', border:'#CBD5E1', ring:'#1E3A8A', notes:'Authority navy + trust gold' },
  51: { type:'Construction/Architecture',      primary:'#64748B', onPrimary:'#FFFFFF', secondary:'#94A3B8', accent:'#EA580C', bg:'#F8FAFC', fg:'#334155', card:'#FFFFFF', muted:'#EBF0F5', mutedFg:'#64748B', border:'#E2E8F0', ring:'#64748B', notes:'Industrial grey + safety orange' },
  52: { type:'Automotive',                     primary:'#1E293B', onPrimary:'#FFFFFF', secondary:'#334155', accent:'#DC2626', bg:'#F8FAFC', fg:'#0F172A', card:'#FFFFFF', muted:'#E9EDF1', mutedFg:'#64748B', border:'#E2E8F0', ring:'#1E293B', notes:'Premium dark + action red' },
  53: { type:'Photography',                    primary:'#18181B', onPrimary:'#FFFFFF', secondary:'#27272A', accent:'#F8FAFC', bg:'#000000', fg:'#FAFAFA', card:'#0C0C0C', muted:'#181818', mutedFg:'#94A3B8', border:'#3F3F46', ring:'#18181B', notes:'Pure black + white contrast' },
  55: { type:'Home Services (Trades)',         primary:'#1E40AF', onPrimary:'#FFFFFF', secondary:'#3B82F6', accent:'#EA580C', bg:'#EFF6FF', fg:'#1E3A8A', card:'#FFFFFF', muted:'#E9EEF6', mutedFg:'#64748B', border:'#BFDBFE', ring:'#1E40AF', notes:'Professional blue + urgent orange' },
  58: { type:'Medical/Health Clinic',          primary:'#0891B2', onPrimary:'#FFFFFF', secondary:'#22D3EE', accent:'#16A34A', bg:'#F0FDFA', fg:'#134E4A', card:'#FFFFFF', muted:'#E8F1F6', mutedFg:'#64748B', border:'#CCFBF1', ring:'#0891B2', notes:'Medical teal + health green' },
  60: { type:'Dental',                         primary:'#0284C7', onPrimary:'#FFFFFF', secondary:'#38BDF8', accent:'#059669', bg:'#F0F9FF', fg:'#082F49', card:'#FFFFFF', muted:'#E6F1F8', mutedFg:'#64748B', border:'#BAE6FD', ring:'#0284C7', notes:'Sky blue + fresh green' },
  62: { type:'Florist/Garden',                 primary:'#15803D', onPrimary:'#FFFFFF', secondary:'#22C55E', accent:'#EC4899', bg:'#F0FDF4', fg:'#14532D', card:'#FFFFFF', muted:'#E8F0F1', mutedFg:'#64748B', border:'#BBF7D0', ring:'#15803D', notes:'Natural green + floral pink' },
  63: { type:'Bakery/Cafe',                    primary:'#92400E', onPrimary:'#FFFFFF', secondary:'#B45309', accent:'#92400E', bg:'#FEF3C7', fg:'#78350F', card:'#FFFFFF', muted:'#EDEEF0', mutedFg:'#64748B', border:'#FDE68A', ring:'#92400E', notes:'Warm brown + cream' },
  // Default fallback
  0:  { type:'General Service',               primary:'#0F172A', onPrimary:'#FFFFFF', secondary:'#334155', accent:'#0369A1', bg:'#F8FAFC', fg:'#020617', card:'#FFFFFF', muted:'#E8ECF1', mutedFg:'#64748B', border:'#E2E8F0', ring:'#0F172A', notes:'Professional dark + blue' },
};

// Typography pairings — extracted from typography.csv
// Keyed by mood/style for fuzzy matching
const TYPOGRAPHY_DB = [
  { id:1,  name:'Classic Elegant',     heading:'Playfair Display', body:'Inter',          moods:['elegant','luxury','timeless','spa','beauty','premium'],          import:"@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Playfair+Display:wght@400;500;600;700&display=swap');" },
  { id:2,  name:'Modern Professional', heading:'Poppins',           body:'Open Sans',      moods:['modern','professional','service','clean','corporate'],            import:"@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700&display=swap');" },
  { id:4,  name:'Editorial Classic',   heading:'Cormorant Garamond',body:'Libre Baskerville',moods:['editorial','classic','legal','traditional','authority'],        import:"@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Libre+Baskerville:wght@400;700&display=swap');" },
  { id:6,  name:'Playful Creative',    heading:'Fredoka',           body:'Nunito',         moods:['playful','friendly','childcare','kids','casual'],                 import:"@import url('https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@300;400;500;600;700&display=swap');" },
  { id:7,  name:'Bold Statement',      heading:'Bebas Neue',        body:'Source Sans 3',  moods:['bold','impactful','dramatic','trades','construction','automotive','gym'],import:"@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Source+Sans+3:wght@300;400;500;600;700&display=swap');" },
  { id:8,  name:'Wellness Calm',       heading:'Lora',              body:'Raleway',        moods:['calm','wellness','relaxing','medical','health','gentle'],         import:"@import url('https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600;700&family=Raleway:wght@300;400;500;600;700&display=swap');" },
  { id:11, name:'Geometric Modern',    heading:'Outfit',            body:'Work Sans',      moods:['geometric','modern','balanced','startup','tech'],                 import:"@import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Work+Sans:wght@300;400;500;600;700&display=swap');" },
  { id:12, name:'Luxury Serif',        heading:'Cormorant',         body:'Montserrat',     moods:['luxury','high-end','elegant','realestate','photography','legal'], import:"@import url('https://fonts.googleapis.com/css2?family=Cormorant:wght@400;500;600;700&family=Montserrat:wght@300;400;500;600;700&display=swap');" },
  { id:14, name:'News Editorial',      heading:'Newsreader',        body:'Roboto',         moods:['news','editorial','trustworthy','information','clear'],           import:"@import url('https://fonts.googleapis.com/css2?family=Newsreader:wght@400;500;600;700&family=Roboto:wght@300;400;500;700&display=swap');" },
  { id:16, name:'Corporate Trust',     heading:'Lexend',            body:'Source Sans 3',  moods:['corporate','trustworthy','readable','professional','financial'],  import:"@import url('https://fonts.googleapis.com/css2?family=Lexend:wght@300;400;500;600;700&family=Source+Sans+3:wght@300;400;500;600;700&display=swap');" },
  { id:18, name:'Fashion Forward',     heading:'Syne',              body:'Manrope',        moods:['fashion','avant-garde','bold','editorial','dark','modern'],       import:"@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700&family=Syne:wght@400;500;600;700;800&display=swap');" },
  { id:10, name:'Retro Warm',          heading:'Abril Fatface',     body:'Merriweather',   moods:['retro','vintage','warm','food','cafe','bakery','artisan'],       import:"@import url('https://fonts.googleapis.com/css2?family=Abril+Fatface&family=Merriweather:wght@300;400;700&display=swap');" },
];

// ── INDUSTRY → PALETTE ROW MAPPING ───────────────────────────

function matchIndustryToRow(industry) {
  if (!industry) return 0;
  const k = industry.toLowerCase().replace(/[^a-z\s]/g, '');

  if (/plumb|electr|locksmith|hvac|geyser|handyman|pest|appli/.test(k)) return 55;
  if (/beauty|hair|nail|salon|spa|lash|brow|massage|wax/.test(k))       return 32;
  if (/restaurant|food|cater|bakery|cafe|coffee|cook|braai/.test(k))    return 34;
  if (/fitness|gym|train|sport|yoga|pilates/.test(k))                   return 35;
  if (/property|real estate|estate agent|realty/.test(k))               return 36;
  if (/legal|law|attorney|advocate|notary/.test(k))                     return 40;
  if (/build|construct|renovate|paint|tile|plaster|carpenter/.test(k))  return 51;
  if (/auto|car|mechanic|panel|tyre|vehicle/.test(k))                   return 52;
  if (/photo|photographer|studio/.test(k))                              return 53;
  if (/medical|doctor|clinic|health|physio|nurse/.test(k))             return 58;
  if (/dental|dentist|teeth/.test(k))                                   return 60;
  if (/florist|flower|plant|garden|nursery/.test(k))                    return 62;
  if (/event|wedding|party|function|stokvel/.test(k))                  return 39;
  if (/flooring|floor|carpet|vinyl|laminate/.test(k))                  return 51;
  if (/clean|maid|domestic|laundry/.test(k))                           return 31;
  if (/transport|logistics|courier|delivery|driver/.test(k))           return 31;
  if (/tutor|teach|educat|school|training/.test(k))                    return 5;
  if (/hardware|pharmacy|grocer|butcher|retail|shop|store/.test(k))   return 31;

  return 0; // generic fallback
}

// ── TYPOGRAPHY MATCHING ───────────────────────────────────────

function matchTypography(industry, vibe) {
  const signals = [
    ...(industry || '').toLowerCase().split(/[\s,\/]+/),
    ...(vibe     || '').toLowerCase().split(/[\s,\/]+/),
  ];

  let bestMatch = TYPOGRAPHY_DB[1]; // Modern Professional as default
  let bestScore = 0;

  for (const pairing of TYPOGRAPHY_DB) {
    const score = pairing.moods.filter(m =>
      signals.some(s => s.includes(m) || m.includes(s))
    ).length;
    if (score > bestScore) { bestScore = score; bestMatch = pairing; }
  }

  return bestMatch;
}

// ── LANDING PATTERN SELECTION ─────────────────────────────────
// Always returns "Scroll-Triggered Storytelling" for Website Hub.
// This is locked in the spec. The data confirms it's the right pattern
// for service businesses: "Narrative increases time-on-page 3x."

function getLandingPattern() {
  return {
    id: 10,
    name: 'Scroll-Triggered Storytelling',
    sectionOrder: ['hero', 'about', 'services', 'why-us', 'testimonial', 'contact'],
    ctaPlacement: 'End of each chapter + Final climax CTA',
    colorStrategy: 'Progressive reveal. Each section distinct visual weight.',
    mobileNote: 'Simplify animations on mobile. Progress indicator optional.',
  };
}

// ── UX RULES — mobile-critical subset ────────────────────────
// Extracted from ux-guidelines.csv — rows most critical for
// mobile-first single-page SA business sites.

export const UX_RULES = [
  { id:1,  rule:'Smooth scroll',      do:'html { scroll-behavior: smooth; }',                               dont:'Anchor jump without transition' },
  { id:20, rule:'Viewport units',     do:'Use 100svh or dvh for full-height sections',                      dont:'Use 100vh — breaks on mobile browsers' },
  { id:22, rule:'Touch targets',      do:'Minimum 44×44px for all tappable elements',                       dont:'Small buttons or links' },
  { id:23, rule:'Touch spacing',      do:'Minimum 8px gap between touch targets',                           dont:'Tightly packed tappable elements' },
  { id:36, rule:'Colour contrast',    do:'Minimum 4.5:1 ratio for normal text, 3:1 for large text',         dont:'Low contrast text on any background' },
  { id:16, rule:'Overflow hidden',    do:'Test all content fits within overflow:hidden containers',          dont:'Blindly apply overflow:hidden' },
];

// ── MAIN EXPORT ───────────────────────────────────────────────

/**
 * getDesignBrief — replaces getIndustryBrief() and INDUSTRY_MATRIX
 *
 * @param {string} industry  e.g. "flooring", "beauty salon", "plumber"
 * @param {string} vibe      e.g. "warm", "bold", "professional", "playful"
 * @returns {object} Complete design brief for Pass 1 + Pass 2 of build pipeline
 */
export function getDesignBrief(industry, vibe) {
  const rowNum    = matchIndustryToRow(industry);
  const palette   = PALETTE_DB[rowNum] || PALETTE_DB[0];
  const typo      = matchTypography(industry, vibe);
  const landing   = getLandingPattern();

  return {
    // Palette — full CSS custom property set, WCAG-compliant
    palette: {
      primary:    palette.primary,
      onPrimary:  palette.onPrimary,
      secondary:  palette.secondary,
      accent:     palette.accent,
      bg:         palette.bg,
      fg:         palette.fg,
      card:       palette.card,
      muted:      palette.muted,
      mutedFg:    palette.mutedFg,
      border:     palette.border,
      ring:       palette.ring,
      notes:      palette.notes,
    },
    // Typography — ready-to-inject CSS @import
    typography: {
      heading:    typo.heading,
      body:       typo.body,
      name:       typo.name,
      cssImport:  typo.import,
    },
    // Landing pattern — structural brief for Pass 1
    landing,
    // UX rules — Pass 3 checklist
    uxRules: UX_RULES,
    // Unsplash query — keyword search, full archive, no collections
    unsplashQuery: buildUnsplashQuery(industry, vibe, palette),
    // Source metadata
    _source: `ui-ux-pro-max-skill row ${rowNum}: ${palette.type}`,
  };
}

// ── UNSPLASH KEYWORD QUERY BUILDER ───────────────────────────
// No collections. Full Unsplash archive keyword search only.
// Query is derived from: industry keyword + vibe modifier + palette mood.
// Substance build Pass 1 generates its own richer query from full card data —
// this function serves the pre-build and as a fallback.

const VIBE_MODIFIERS = {
  bold:         'dramatic powerful confident',
  warm:         'warm inviting natural light',
  professional: 'professional clean modern',
  playful:      'bright vibrant energetic',
  luxury:       'luxury premium elegant',
  minimal:      'minimal clean simple',
};

const INDUSTRY_PHOTO_TERMS = {
  plumb:        'plumber pipes professional trade',
  electr:       'electrician wiring professional trade',
  hvac:         'hvac technician professional',
  handyman:     'handyman tools professional repair',
  beauty:       'beauty salon interior professional',
  hair:         'hair salon stylist professional',
  nail:         'nail salon beauty professional',
  spa:          'spa wellness interior calm',
  restaurant:   'restaurant interior food professional',
  food:         'food catering professional kitchen',
  cafe:         'cafe coffee interior warm',
  bakery:       'bakery pastry interior warm',
  fitness:      'gym fitness training professional',
  gym:          'gym weights fitness professional',
  yoga:         'yoga studio calm wellness',
  property:     'real estate property modern interior',
  estate:       'real estate property professional',
  legal:        'law office professional authority',
  attorney:     'attorney law professional',
  construct:    'construction site building professional',
  build:        'builder construction professional site',
  flooring:     'flooring installation craftsman professional',
  tile:         'tiling installation professional craftsman',
  renovate:     'renovation interior professional',
  auto:         'automotive workshop professional mechanic',
  mechanic:     'mechanic workshop car professional',
  panel:        'panel beater workshop professional',
  medical:      'medical clinic professional clean',
  doctor:       'doctor clinic professional health',
  dental:       'dental clinic professional clean',
  clean:        'cleaning professional service spotless',
  domestic:     'cleaning service professional home',
  photo:        'photographer studio professional creative',
  florist:      'florist flowers professional shop',
  garden:       'garden nursery plants professional',
  event:        'event venue professional setup',
  wedding:      'wedding venue professional elegant',
  transport:    'transport logistics professional driver',
  tutor:        'education tutoring professional classroom',
};

function buildUnsplashQuery(industry, vibe, palette) {
  const k = (industry || '').toLowerCase();

  // Find the most specific industry photo term
  let industryTerm = 'professional service business south africa';
  for (const [fragment, term] of Object.entries(INDUSTRY_PHOTO_TERMS)) {
    if (k.includes(fragment)) { industryTerm = term; break; }
  }

  // Layer in vibe modifier if available
  const vibeMod = VIBE_MODIFIERS[(vibe || '').toLowerCase()] || '';

  // Combine — keep under 100 chars for Unsplash API
  const query = [industryTerm, vibeMod, 'south africa']
    .filter(Boolean)
    .join(' ')
    .slice(0, 100)
    .trim();

  return query;
}

// ── CSS VARIABLES GENERATOR ───────────────────────────────────

/**
 * buildCssVariables — generates the :root CSS block from a palette
 * Ready to inject directly into the HTML <head>
 */
export function buildCssVariables(palette, typography) {
  return `<style id="wh-design-system">
${typography.cssImport}
:root {
  --primary:      ${palette.primary};
  --on-primary:   ${palette.onPrimary};
  --accent:       ${palette.accent};
  --accent-bg:    ${palette.bg};
  --bg:           #0a0a0a;
  --surface:      #111111;
  --card:         rgba(255,255,255,0.04);
  --card-solid:   #161616;
  --fg:           #f0ede8;
  --muted-fg:     rgba(240,237,232,0.55);
  --border:       rgba(255,255,255,0.08);
  --label-color:  rgba(240,237,232,0.35);
  --font-heading: '${typography.heading}', serif;
  --font-body:    '${typography.body}', sans-serif;
}
</style>`;
}
