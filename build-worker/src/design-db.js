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


// ============================================================
// PERSONALITY PROFILE SYSTEM
// 13 categories → layout genome → renderer driver
// industry → personality → composition intelligence
// ============================================================

// ── INDUSTRY → PERSONALITY MAPPING ───────────────────────────
export const INDUSTRY_PERSONALITY = {

  // ── TRADE & CONSTRUCTION ──────────────────────────────────────
  plumbing:'trade_authority', plumber:'trade_authority',
  electrical:'trade_authority', electrician:'trade_authority',
  aircon:'trade_authority', hvac:'trade_authority', air_conditioning:'trade_authority',
  handyman:'trade_authority', general_contractor:'trade_authority',
  carpentry:'trade_authority', joinery:'trade_authority', woodwork:'trade_authority',
  roofing:'trade_authority', roof_repair:'trade_authority',
  waterproofing:'trade_authority', damp_proofing:'trade_authority',
  welding:'trade_authority', fabrication:'trade_authority', steel:'trade_authority',
  plastering:'trade_authority', screeding:'trade_authority',
  appliance_repair:'trade_authority', small_appliances:'trade_authority',
  pest_control:'trade_authority', fumigation:'trade_authority',
  signage:'trade_authority', branding:'trade_authority',
  cctv:'trade_authority', alarm:'trade_authority', electric_fence:'trade_authority',
  tiling:'trade_authority', paving:'trade_authority', bricklaying:'trade_authority',
  glazier:'trade_authority', glass:'trade_authority', aluminium:'trade_authority',
  pool_service:'trade_authority', pool_cleaning:'trade_authority',
  solar:'trade_authority', solar_installation:'trade_authority',
  gates:'trade_authority', fencing:'trade_authority', garage_doors:'trade_authority',
  painting_contractor:'trade_authority',
  building:'trade_authority', construction:'trade_authority', builder:'trade_authority',
  demolition:'trade_authority', excavation:'trade_authority',
  fire_protection:'trade_authority', sprinklers:'trade_authority',
  locksmith:'trade_authority', locksmith_services:'trade_authority',
  bathroom_renovation:'trade_authority', kitchen_renovation:'trade_authority',

  // ── TRANSFORMATION ───────────────────────────────────────────
  flooring:'transformation', carpet:'transformation', vinyl:'transformation', laminate:'transformation',
  renovation:'transformation', interior_design:'transformation', decor:'transformation',
  panel_beater:'transformation', auto_body:'transformation', smash_repair:'transformation',
  landscaping:'transformation', garden:'transformation', garden_services:'transformation',
  florist:'transformation', flowers:'transformation',
  painting:'transformation', spray_painting:'transformation',
  nursery:'transformation', plant_nursery:'transformation',
  curtains:'transformation', blinds:'transformation', upholstery:'transformation',
  pool_building:'transformation', pool_renovation:'transformation',

  // ── PERSONAL CARE ────────────────────────────────────────────
  hair_salon:'personal_care', hairdresser:'personal_care', hair:'personal_care',
  barber:'personal_care', barbershop:'personal_care',
  nails:'personal_care', nail_salon:'personal_care', manicure:'personal_care',
  spa:'personal_care', massage:'personal_care', beauty_salon:'personal_care',
  lashes:'personal_care', lash_studio:'personal_care', eyebrows:'personal_care',
  makeup:'personal_care', makeup_artist:'personal_care', bridal_makeup:'personal_care',
  tattoo:'personal_care', piercing:'personal_care', tattoo_studio:'personal_care',
  waxing:'personal_care', threading:'personal_care',
  skincare:'personal_care', aesthetics:'personal_care', skin_clinic:'personal_care',

  // ── WELLNESS & FITNESS ────────────────────────────────────────
  gym:'wellness', fitness:'wellness', crossfit:'wellness',
  personal_trainer:'wellness', fitness_coach:'wellness',
  yoga:'wellness', pilates:'wellness', dance:'wellness',
  physiotherapy:'wellness', physio:'wellness', biokinetics:'wellness',
  chiropractor:'wellness', sports_therapy:'wellness',
  nutrition:'wellness', dietitian:'wellness',
  mental_health:'wellness', counselling:'wellness', psychology:'wellness',
  occupational_therapy:'wellness', speech_therapy:'wellness',

  // ── HOSPITALITY & FOOD ────────────────────────────────────────
  restaurant:'hospitality', diner:'hospitality', bistro:'hospitality',
  cafe:'hospitality', coffee_shop:'hospitality', coffee:'hospitality',
  bakery:'hospitality', cake_shop:'hospitality', patisserie:'hospitality',
  catering:'hospitality', corporate_catering:'hospitality',
  street_food:'hospitality', food_truck:'hospitality',
  chicken_shop:'hospitality', fast_food:'hospitality', takeaway:'hospitality',
  shisa_nyama:'hospitality', braai:'hospitality', butchery:'hospitality',
  pizza:'hospitality', sushi:'hospitality',
  pub:'hospitality', bar:'hospitality', tavern:'hospitality', shebeen:'hospitality',
  guest_house:'hospitality', bed_and_breakfast:'hospitality', airbnb:'hospitality',
  lodge:'hospitality', guesthouse:'hospitality',
  home_industry:'hospitality', home_baking:'hospitality',
  meal_prep:'hospitality', meal_delivery:'hospitality',
  butcher:'hospitality', deli:'hospitality', charcuterie:'hospitality',
  farm_stall:'hospitality', farm_produce:'hospitality',
  ice_cream:'hospitality', dessert:'hospitality',
  juice_bar:'hospitality', smoothie:'hospitality',

  // ── COMMUNITY & LOCAL SERVICES ────────────────────────────────
  childcare:'community_local', creche:'community_local', daycare:'community_local',
  tutoring:'community_local', extra_lessons:'community_local', maths_tutor:'community_local',
  cleaning:'community_local', domestic:'community_local', home_cleaning:'community_local',
  laundry:'community_local', dry_cleaning:'community_local',
  driving_school:'community_local', driving_lessons:'community_local',
  funeral:'memorial_legacy', funeral_parlour:'memorial_legacy', tombstone:'memorial_legacy',
  church:'community_local', community_centre:'community_local',
  charity:'community_local', ngo:'community_local',
  alterations:'community_local', seamstress:'community_local', tailoring:'community_local',
  shoe_repair:'community_local', cobbler:'community_local',
  key_cutting:'community_local',

  // ── PROFESSIONAL & FINANCIAL ──────────────────────────────────
  legal:'professional_trust', attorney:'professional_trust', lawyer:'professional_trust',
  accounting:'professional_trust', accountant:'professional_trust', bookkeeping:'professional_trust',
  tax:'professional_trust', tax_consultant:'professional_trust',
  property:'professional_trust', estate_agent:'professional_trust', real_estate:'professional_trust',
  financial_advisor:'professional_trust', insurance:'professional_trust',
  mortgage:'professional_trust', bond_originator:'professional_trust',
  crypto:'professional_trust', investment:'professional_trust',
  ai_consulting:'professional_trust', consulting:'professional_trust',
  hr:'professional_trust', recruitment:'professional_trust',
  translation:'professional_trust', interpreter:'professional_trust',

  // ── TECHNICAL & DIGITAL ───────────────────────────────────────
  it_support:'technical_expertise', tech_support:'technical_expertise',
  social_media:'technical_expertise', digital_marketing:'technical_expertise',
  graphic_design:'technical_expertise', web_design:'technical_expertise',
  software:'technical_expertise', app_development:'technical_expertise',
  security:'technical_expertise', security_company:'technical_expertise',
  data_recovery:'technical_expertise', computer_repair:'technical_expertise',
  photography:'event_creative', videography:'event_creative',
  drone:'technical_expertise', drone_services:'technical_expertise',
  printing:'technical_expertise', print_shop:'technical_expertise',

  // ── RETAIL ───────────────────────────────────────────────────
  spaza:'retail_utility', tuck_shop:'retail_utility',
  hardware:'retail_utility', hardware_store:'retail_utility',
  bottle_store:'retail_utility', liquor_store:'retail_utility',
  clothing:'retail_utility', fashion:'retail_utility', boutique:'retail_utility',
  shoes:'retail_utility', footwear:'retail_utility',
  furniture:'retail_utility', furniture_store:'retail_utility',
  bedding:'retail_utility', linen:'retail_utility',
  electronics:'retail_utility', cellphone:'retail_utility', phone_repair:'retail_utility',
  tyres:'retail_utility', tyre_shop:'retail_utility', wheels:'retail_utility',
  car_parts:'retail_utility', auto_parts:'retail_utility',
  pet_shop:'retail_utility', pet_store:'retail_utility',
  pharmacy:'medical_trust', chemist:'medical_trust',
  health_shop:'wellness', health_food:'wellness',
  toys:'retail_utility', baby_shop:'retail_utility',
  books:'retail_utility', stationery:'retail_utility',
  garden_centre:'transformation', nursery_garden:'transformation',
  spare_parts:'retail_utility', spares:'retail_utility',

  // ── AUTOMOTIVE ───────────────────────────────────────────────
  mechanic:'trade_authority', auto_repair:'trade_authority', car_service:'trade_authority',
  car_wash:'transformation', detailing:'transformation', car_detailing:'transformation',
  panel_beating:'transformation',
  car_rental:'mobility', vehicle_hire:'mobility',
  towing:'mobility', recovery:'mobility',
  truck_repair:'trade_authority', diesel_mechanic:'trade_authority',

  // ── EVENTS & CREATIVE ─────────────────────────────────────────
  wedding:'event_creative', wedding_planner:'event_creative',
  events:'event_creative', event_planning:'event_creative', event_hire:'event_creative',
  dj:'event_creative', sound:'event_creative', entertainment:'event_creative',
  decor_hire:'event_creative', tent_hire:'event_creative',
  caricature:'event_creative', artist:'event_creative',
  band:'event_creative', musician:'event_creative',
  venue:'event_creative', function_venue:'event_creative',
  party_hire:'event_creative', jumping_castle:'event_creative',
  face_painting:'event_creative', magic:'event_creative',

  // ── TRANSPORT & LOGISTICS ─────────────────────────────────────
  transport:'mobility', kombi:'mobility', minibus:'mobility',
  bakkie_hire:'mobility', truck_hire:'mobility',
  courier:'mobility', delivery:'mobility', last_mile:'mobility',
  taxi:'mobility', metered_taxi:'mobility', e_hailing:'mobility',
  moving:'mobility', relocation:'mobility', removals:'mobility',
  freight:'mobility', logistics:'mobility',

  // ── MEDICAL & HEALTH ──────────────────────────────────────────
  medical:'medical_trust', gp:'medical_trust', doctor:'medical_trust',
  dental:'medical_trust', dentist:'medical_trust', orthodontist:'medical_trust',
  optometrist:'medical_trust', optical:'medical_trust', eye_care:'medical_trust',
  vet:'medical_trust', veterinarian:'medical_trust', animal_clinic:'medical_trust',
  specialist:'medical_trust', surgeon:'medical_trust',
  home_care:'medical_trust', nursing:'medical_trust',
  hearing:'medical_trust', audiologist:'medical_trust',

  // ── EDUCATION ────────────────────────────────────────────────
  school:'community_local', after_school:'community_local',
  music_lessons:'community_local', art_lessons:'community_local',
  martial_arts:'wellness', karate:'wellness', boxing:'wellness',
  swimming_lessons:'wellness', swim_school:'wellness',
  coding_school:'technical_expertise', stem:'technical_expertise',

  // ── AGRICULTURE & OUTDOOR ─────────────────────────────────────
  farming:'community_local', smallholding:'community_local',
  beekeeping:'community_local', honey:'community_local',
  fishing:'community_local', bait:'community_local',
  hunting:'community_local', game:'community_local',

  // ── DEFAULT ───────────────────────────────────────────────────
  general:'trade_authority',
};

// ── PERSONALITY GENOME LIBRARY ────────────────────────────────
// Each category defines the full composition intelligence
// Hero archetypes, opening strategies, spacing, typography, density
export const PERSONALITY_GENOMES = {

  trade_authority: {
    label: 'Trade Authority',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['proof_first','local_hero'],
    typography_mode: 'bold_statement',
    spacing_rhythm: 'compact',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 55,
    typography_id: 7,
    trust_signals: true,
    image_treatment: { bg_position:'center 30%', hero_height:'90svh', scrim:'heavy_bottom' },
  },

  transformation: {
    label: 'Transformation',
    hero_layouts: ['cinematic_left','trade_authority'],
    opening_strategies: ['before_after','proof_first'],
    typography_mode: 'bold_statement',
    spacing_rhythm: 'airy',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'medium',
    surface_style: 'matte_dark',
    cta_style: 'visual_proof',
    section_flow: 'story_first',
    palette_row: 51,
    typography_id: 7,
    trust_signals: true,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'cinematic' },
  },

  personal_care: {
    label: 'Personal Care',
    hero_layouts: ['cinematic_left','quiet_premium'],
    opening_strategies: ['emotional_story','local_hero'],
    typography_mode: 'classic_elegant',
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'soft',
    surface_style: 'warm_dark',
    cta_style: 'inviting',
    section_flow: 'story_first',
    palette_row: 32,
    typography_id: 1,
    trust_signals: false,
    image_treatment: { bg_position:'center top', hero_height:'100svh', scrim:'soft_bottom' },
  },

  wellness: {
    label: 'Wellness',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['emotional_story','manifesto'],
    typography_mode: 'bold_statement',
    spacing_rhythm: 'airy',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'matte_dark',
    cta_style: 'motivational',
    section_flow: 'emotion_first',
    palette_row: 35,
    typography_id: 7,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'95svh', scrim:'heavy_bottom' },
  },

  hospitality: {
    label: 'Hospitality',
    hero_layouts: ['cinematic_left','quiet_premium'],
    opening_strategies: ['emotional_story','direct_offer'],
    typography_mode: 'retro_warm',
    spacing_rhythm: 'airy',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'warm',
    surface_style: 'warm_dark',
    cta_style: 'appetite',
    section_flow: 'emotion_first',
    palette_row: 34,
    typography_id: 10,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'warm_bottom' },
  },

  community_local: {
    label: 'Community Local',
    hero_layouts: ['cinematic_left','trade_authority'],
    opening_strategies: ['local_hero','emotional_story'],
    typography_mode: 'modern_professional',
    spacing_rhythm: 'airy',
    card_density: 'medium',
    alignment_bias: 'left',
    visual_energy: 'soft',
    surface_style: 'warm_dark',
    cta_style: 'friendly',
    section_flow: 'story_first',
    palette_row: 31,
    typography_id: 2,
    trust_signals: false,
    image_treatment: { bg_position:'center top', hero_height:'90svh', scrim:'soft_bottom' },
  },

  professional_trust: {
    label: 'Professional Trust',
    hero_layouts: ['quiet_premium','trade_authority'],
    opening_strategies: ['proof_first','local_hero'],
    typography_mode: 'luxury_serif',
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'restrained',
    surface_style: 'deep_dark',
    cta_style: 'minimal',
    section_flow: 'proof_first',
    palette_row: 40,
    typography_id: 12,
    trust_signals: true,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'minimal' },
  },

  technical_expertise: {
    label: 'Technical Expertise',
    hero_layouts: ['trade_authority','cinematic_left'],
    opening_strategies: ['proof_first','direct_offer'],
    typography_mode: 'geometric_modern',
    spacing_rhythm: 'compact',
    card_density: 'medium',
    alignment_bias: 'left',
    visual_energy: 'medium',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 5,
    typography_id: 11,
    trust_signals: true,
    image_treatment: { bg_position:'center', hero_height:'88svh', scrim:'heavy_bottom' },
  },

  retail_utility: {
    label: 'Retail Utility',
    hero_layouts: ['cinematic_left','trade_authority'],
    opening_strategies: ['direct_offer','local_hero'],
    typography_mode: 'modern_professional',
    spacing_rhythm: 'compact',
    card_density: 'medium',
    alignment_bias: 'left',
    visual_energy: 'medium',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 31,
    typography_id: 2,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'80svh', scrim:'heavy_bottom' },
  },

  event_creative: {
    label: 'Event & Creative',
    hero_layouts: ['cinematic_left','quiet_premium'],
    opening_strategies: ['emotional_story','manifesto'],
    typography_mode: 'fashion_forward',
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'deep_dark',
    cta_style: 'experiential',
    section_flow: 'emotion_first',
    palette_row: 39,
    typography_id: 18,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'cinematic' },
  },

  mobility: {
    label: 'Mobility',
    hero_layouts: ['cinematic_left','trade_authority'],
    opening_strategies: ['direct_offer','local_hero'],
    typography_mode: 'bold_statement',
    spacing_rhythm: 'compact',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'high',
    surface_style: 'matte_dark',
    cta_style: 'direct',
    section_flow: 'service_first',
    palette_row: 52,
    typography_id: 7,
    trust_signals: true,
    image_treatment: { bg_position:'center 40%', hero_height:'88svh', scrim:'heavy_bottom' },
  },

  medical_trust: {
    label: 'Medical Trust',
    hero_layouts: ['quiet_premium','trade_authority'],
    opening_strategies: ['proof_first','emotional_story'],
    typography_mode: 'wellness_calm',
    spacing_rhythm: 'dramatic',
    card_density: 'low',
    alignment_bias: 'left',
    visual_energy: 'restrained',
    surface_style: 'clean_dark',
    cta_style: 'reassuring',
    section_flow: 'proof_first',
    palette_row: 58,
    typography_id: 8,
    trust_signals: true,
    image_treatment: { bg_position:'center top', hero_height:'100svh', scrim:'minimal' },
  },

  memorial_legacy: {
    label: 'Memorial & Legacy',
    hero_layouts: ['quiet_premium','cinematic_left'],
    opening_strategies: ['emotional_story','local_hero'],
    typography_mode: 'editorial_classic',
    spacing_rhythm: 'dramatic',
    card_density: 'very_low',
    alignment_bias: 'left',
    visual_energy: 'restrained',
    surface_style: 'deep_dark',
    cta_style: 'minimal',
    section_flow: 'story_first',
    palette_row: 5,
    typography_id: 4,
    trust_signals: false,
    image_treatment: { bg_position:'center', hero_height:'100svh', scrim:'minimal' },
  },
};


// ── SPACING RHYTHM DEFINITIONS ────────────────────────────────
export const SPACING_RHYTHMS = {
  compact:  { section: '48px 24px', gap: '16px', heroMin: '85svh' },
  airy:     { section: '72px 24px', gap: '24px', heroMin: '100svh' },
  dramatic: { section: '96px 24px', gap: '32px', heroMin: '100svh' },
};

// ── SECTION FLOW DEFINITIONS ──────────────────────────────────
export const SECTION_FLOWS = {
  service_first:  ['hero','services','about','why_us','testimonial','contact'],
  story_first:    ['hero','about','services','why_us','testimonial','contact'],
  emotion_first:  ['hero','testimonial','about','services','why_us','contact'],
  proof_first:    ['hero','why_us','testimonial','services','about','contact'],
};

// ── PERSONALITY RESOLUTION ────────────────────────────────────
export function getPersonality(industryKey) {
  const category = INDUSTRY_PERSONALITY[industryKey] || 'trade_authority';
  const genome   = PERSONALITY_GENOMES[category] || PERSONALITY_GENOMES['trade_authority'];
  return { category, ...genome };
}

// ── TYPOGRAPHY BY ID ──────────────────────────────────────────
export function getTypographyById(id) {
  return TYPOGRAPHY_DB.find(t => t.id === id) || TYPOGRAPHY_DB[1];
}


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
 * getDesignBrief — personality-driven design system
 * Routes industry → personality category → genome → palette + typography
 *
 * @param {string} industry  e.g. "flooring", "hair_salon", "plumbing"
 * @param {string} vibe      optional override (legacy support)
 * @returns {object} Complete design brief for build pipeline
 */
export function getDesignBrief(industry, vibe) {
  // Resolve personality from industry key
  const industryKey = normaliseIndustryKey(industry);
  const personality = getPersonality(industryKey);

  // Get palette from personality's preferred row
  const palette     = PALETTE_DB[personality.palette_row] || PALETTE_DB[0];

  // Get typography from personality's preferred id
  const typo        = getTypographyById(personality.typography_id);
  const landing     = getLandingPattern();

  return {
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
    typography: {
      heading:    typo.heading,
      body:       typo.body,
      name:       typo.name,
      cssImport:  typo.import,
    },
    // Full personality genome — drives renderer
    personality,
    landing,
    uxRules: UX_RULES,
    unsplashQuery: buildUnsplashQuery(industry, vibe, palette),
    _source:       `personality:${personality.category} palette:${personality.palette_row}`,
    industryKey,
  };
}

// ── INDUSTRY KEY NORMALISER ───────────────────────────────────
// Converts free-text industry to a normalised key
function normaliseIndustryKey(industry) {
  if (!industry) return 'general';
  const k = industry.toLowerCase().replace(/[^a-z\s_]/g, '').trim();

  // ── TRADES & CONSTRUCTION ──────────────────────────────────────
  if (/plumb/.test(k))                              return 'plumbing';
  if (/electr/.test(k))                             return 'electrical';
  if (/aircon|hvac|air.con/.test(k))                return 'aircon';
  if (/handyman/.test(k))                           return 'handyman';
  if (/carpent|joinery|woodwork/.test(k))           return 'carpentry';
  if (/roof/.test(k))                               return 'roofing';
  if (/waterproof|damp.proof/.test(k))              return 'waterproofing';
  if (/pest|exterminat|fumig/.test(k))              return 'pest_control';
  if (/appliance|whitegood/.test(k))                return 'appliance_repair';
  if (/weld|fabricat/.test(k))                      return 'welding';
  if (/plaster|screed/.test(k))                     return 'plastering';
  if (/signage/.test(k))                            return 'signage';
  if (/cctv|alarm|electric.fence/.test(k))          return 'cctv';
  if (/pool.build|pool.renov/.test(k))              return 'pool_building';
  if (/pool.service|pool.clean/.test(k))            return 'pool_service';
  if (/solar/.test(k))                              return 'solar';
  if (/lock.?smith/.test(k))                        return 'locksmith';
  if (/fencing|garage.door/.test(k))                return 'gates';
  if (/tiler|tiling|paving|brick/.test(k))          return 'tiling';
  if (/glazier/.test(k))                            return 'glazier';
  if (/bathroom.renov|kitchen.renov/.test(k))       return 'renovation';
  if (/demolit|excavat/.test(k))                    return 'demolition';
  if (/fire.protect|sprinkler/.test(k))             return 'fire_protection';
  if (/construct|builder/.test(k))                  return 'building';

  // ── TRANSFORMATION ─────────────────────────────────────────────
  if (/floor|carpet|vinyl|laminate/.test(k))        return 'flooring';
  if (/interior.design|home.decor/.test(k))         return 'renovation';
  if (/renovat/.test(k))                            return 'renovation';
  if (/panel.?beat|panelbeat|auto.body|smash/.test(k)) return 'panel_beater';
  if (/landscap/.test(k))                           return 'landscaping';
  if (/garden.service/.test(k))                     return 'landscaping';
  if (/plant.nursery|garden.centre/.test(k))        return 'nursery';
  if (/florist|flower/.test(k))                     return 'florist';
  if (/curtain|blind|upholster/.test(k))            return 'curtains';
  if (/car.?wash|carwash|detailing/.test(k))        return 'car_wash';
  if (/paint/.test(k))                              return 'painting';

  // ── PERSONAL CARE ──────────────────────────────────────────────
  if (/hair.salon|hairdress/.test(k))               return 'hair_salon';
  if (/barber/.test(k))                             return 'barber';
  if (/nail|manicure|pedicure/.test(k))             return 'nails';
  if (/massage/.test(k))                            return 'spa';
  if (/\bspa\b/.test(k))                          return 'spa';
  if (/lash|eyebrow/.test(k))                       return 'lashes';
  if (/makeup|make.up|cosmetic/.test(k))            return 'makeup';
  if (/tattoo|piercing/.test(k))                    return 'tattoo';
  if (/waxing|threading/.test(k))                   return 'waxing';
  if (/skincare|aestheti/.test(k))                  return 'skincare';
  if (/beauty.salon/.test(k))                       return 'beauty_salon';

  // ── WELLNESS & FITNESS ─────────────────────────────────────────
  if (/gym|fitness|crossfit/.test(k))               return 'gym';
  if (/personal.train/.test(k))                     return 'personal_trainer';
  if (/yoga|pilates|dance/.test(k))                 return 'yoga';
  if (/physio|biokinet/.test(k))                    return 'physiotherapy';
  if (/chiro/.test(k))                              return 'chiropractor';
  if (/nutrition|dietitian/.test(k))                return 'nutrition';
  if (/counsel|psycholog|mental.health/.test(k))    return 'mental_health';
  if (/martial.art|karate|boxing/.test(k))          return 'martial_arts';
  if (/swim.school|swimming/.test(k))               return 'swimming_lessons';
  if (/health.shop|health.food/.test(k))            return 'health_shop';

  // ── HOSPITALITY & FOOD ─────────────────────────────────────────
  if (/restaurant|diner|bistro/.test(k))            return 'restaurant';
  if (/cafe|coffee.shop/.test(k))                   return 'cafe';
  if (/baker|cake.shop|patisser/.test(k))           return 'bakery';
  if (/cater/.test(k))                              return 'catering';
  if (/street.food|food.truck/.test(k))             return 'street_food';
  if (/chicken|fast.food|takeaway/.test(k))         return 'chicken_shop';
  if (/shisa|nyama|braai/.test(k))                  return 'shisa_nyama';
  if (/butch/.test(k))                              return 'butchery';
  if (/pizza/.test(k))                              return 'pizza';
  if (/sushi/.test(k))                              return 'sushi';
  if (/tavern|shebeen/.test(k))                     return 'pub';
  if (/guest.house|guesthouse|bed.and.breakfast|\bbnb\b/.test(k)) return 'guest_house';
  if (/lodge/.test(k))                              return 'lodge';
  if (/home.indust|home.bak/.test(k))               return 'home_industry';
  if (/deli|charcuter/.test(k))                     return 'deli';
  if (/farm.stall|farm.produc/.test(k))             return 'farm_stall';
  if (/ice.cream|dessert/.test(k))                  return 'ice_cream';
  if (/juice.bar|smoothie/.test(k))                 return 'juice_bar';

  // ── COMMUNITY & LOCAL ──────────────────────────────────────────
  if (/childcare|creche|daycare/.test(k))           return 'childcare';
  if (/tutor|extra.lesson|maths/.test(k))           return 'tutoring';
  if (/clean|maid|domestic/.test(k))                return 'cleaning';
  if (/laundry|dry.clean/.test(k))                  return 'laundry';
  if (/driving.school|driving.lesson/.test(k))      return 'driving_school';
  if (/funeral|tombstone/.test(k))                  return 'funeral';
  if (/alteration|seamstress|tailor/.test(k))       return 'alterations';
  if (/shoe.repair|cobbler/.test(k))                return 'shoe_repair';
  if (/garden(?!.service|.centre)/.test(k))         return 'garden';
  if (/nursery/.test(k))                            return 'nursery';
  if (/beekeep|honey/.test(k))                      return 'beekeeping';

  // ── PROFESSIONAL & FINANCIAL ───────────────────────────────────
  if (/legal|law|attorney|advocate/.test(k))        return 'legal';
  if (/account|bookkeep/.test(k))                   return 'accounting';
  if (/tax.consult/.test(k))                        return 'tax';
  if (/property|estate.agent|realtor/.test(k))      return 'property';
  if (/financial.advis|wealth|insur/.test(k))       return 'financial_advisor';
  if (/bond.origin|mortgage/.test(k))               return 'mortgage';
  if (/crypto|blockchain|invest/.test(k))           return 'crypto';
  if (/recruit|\bhr\b|human.resourc/.test(k))     return 'hr';
  if (/consult/.test(k))                            return 'consulting';

  // ── TECHNICAL & DIGITAL ────────────────────────────────────────
  if (/it.support|tech.support|computer.repair/.test(k)) return 'it_support';
  if (/social.media|digital.market/.test(k))        return 'social_media';
  if (/graphic|web.design|web.dev/.test(k))         return 'graphic_design';
  if (/securi/.test(k))                             return 'security';
  if (/software|app.dev/.test(k))                   return 'software';
  if (/drone/.test(k))                              return 'drone';
  if (/print/.test(k))                              return 'printing';

  // ── RETAIL ─────────────────────────────────────────────────────
  if (/spaza|tuck.shop/.test(k))                    return 'spaza';
  if (/hardware/.test(k))                           return 'hardware';
  if (/bottle.store|liquor/.test(k))                return 'bottle_store';
  if (/clothing|fashion|boutique/.test(k))          return 'clothing';
  if (/\bshoes\b|footwear/.test(k))               return 'shoes';
  if (/furniture/.test(k))                          return 'furniture';
  if (/bedding|linen/.test(k))                      return 'bedding';
  if (/electron|cellphone|phone.repair/.test(k))    return 'electronics';
  if (/tyre|tire/.test(k))                          return 'tyres';
  if (/car.parts|auto.parts|spare.parts|spares/.test(k)) return 'car_parts';
  if (/pet.shop|pet.store/.test(k))                 return 'pet_shop';
  if (/pharm|chemist/.test(k))                      return 'pharmacy';
  if (/toys|baby.shop/.test(k))                     return 'toys';
  if (/books|stationery/.test(k))                   return 'books';

  // ── AUTOMOTIVE ─────────────────────────────────────────────────
  if (/mechanic|auto.repair|car.service/.test(k))   return 'mechanic';
  if (/towing|recovery/.test(k))                    return 'towing';
  if (/car.rental|vehicle.hire/.test(k))            return 'car_rental';

  // ── EVENTS & CREATIVE ──────────────────────────────────────────
  if (/wedding/.test(k))                            return 'wedding';
  if (/photo/.test(k))                              return 'photography';
  if (/videograph/.test(k))                         return 'videography';
  if (/\bdj\b|disc.jockey/.test(k))               return 'dj';
  if (/function.venue|event.venue/.test(k))         return 'venue';
  if (/event/.test(k))                              return 'events';
  if (/party.hire|jumping.castle/.test(k))          return 'party_hire';
  if (/musician|band/.test(k))                      return 'band';

  // ── TRANSPORT & LOGISTICS ──────────────────────────────────────
  if (/courier|deliver/.test(k))                    return 'courier';
  if (/transport|logistics|freight/.test(k))        return 'transport';
  if (/kombi|minibus/.test(k))                      return 'kombi';
  if (/bakkie.hire/.test(k))                        return 'bakkie_hire';
  if (/moving|remov|reloc/.test(k))                 return 'moving';
  if (/metered.taxi/.test(k))                       return 'taxi';

  // ── MEDICAL & HEALTH ───────────────────────────────────────────
  if (/\bgp\b|general.pract/.test(k))             return 'gp';
  if (/medical|doctor|clinic/.test(k))              return 'medical';
  if (/dental|dentist|orthodont/.test(k))           return 'dental';
  if (/optom|optical|eye.care|eyewear/.test(k))     return 'optometrist';
  if (/vet(?:erinarian)?|animal.clinic/.test(k))    return 'vet';
  if (/home.care|nursing/.test(k))                  return 'home_care';
  if (/hearing|audiolog/.test(k))                   return 'hearing';

  // ── EDUCATION ──────────────────────────────────────────────────
  if (/after.school/.test(k))                       return 'after_school';
  if (/coding.school|stem/.test(k))                 return 'coding_school';

  // ── AGRICULTURE ────────────────────────────────────────────────
  if (/beekeep|honey/.test(k))                      return 'beekeeping';
  if (/fishing|bait/.test(k))                       return 'fishing';

  return 'general';
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
 * primaryColour (optional) — hex from Claude's palette decision or logo extraction
 * accentColour (optional)  — hex for CTAs and highlights from Claude's decision
 */
export function buildCssVariables(palette, typography, primaryColour = null, accentColour = null) {
  // Claude's chosen colours override primary/accent only
  // All other colours come from the palette naturally — light or dark as designed
  const primary = primaryColour || palette.primary;
  const accent  = accentColour  || primaryColour || palette.accent;

  return `<style id="wh-design-system">
${typography.cssImport}
:root {
  --primary:      ${primary};
  --on-primary:   ${palette.onPrimary};
  --accent:       ${accent};
  --bg:           ${palette.bg};
  --surface:      ${palette.muted};
  --card:         ${palette.card};
  --card-solid:   ${palette.muted};
  --fg:           ${palette.fg};
  --muted-fg:     ${palette.mutedFg};
  --border:       ${palette.border};
  --label-color:  ${palette.mutedFg};
  --font-heading: '${typography.heading}', serif;
  --font-body:    '${typography.body}', sans-serif;
}
</style>`;
}

/**
 * tintDark — mixes a hex colour into near-black at low opacity
 * Creates distinct dark backgrounds with subtle brand personality
 * intensity 0.07 = subtle, 0.14 = noticeable
 */
function tintDark(hex, intensity) {
  try {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const base = 8; // near-black base
    const tr = Math.round(base + (r - base) * intensity);
    const tg = Math.round(base + (g - base) * intensity);
    const tb = Math.round(base + (b - base) * intensity);
    return `#${tr.toString(16).padStart(2,'0')}${tg.toString(16).padStart(2,'0')}${tb.toString(16).padStart(2,'0')}`;
  } catch {
    return '#0a0a0a';
  }
}
