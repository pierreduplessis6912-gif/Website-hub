// ============================================================
// PHOTO DATABASE — SA-specific Unsplash query system
// Replaces Claude-generated unsplash_query in pre-build pipeline
//
// Usage:
//   const query = getHeroPhotoQuery(businessName, freeText);
//   // Returns a validated Unsplash query string
//
// Design principles:
//   - Query for the VISUAL not the name
//   - SA context lives in the INFERENCE not the query
//   - Multiple queries per industry for variation across builds
//   - No "south africa" in queries — Unsplash coverage too thin
//   - Residential scale for trades — never industrial/commercial
//   - Aspirational but achievable for ekasi/informal sector
// ============================================================

// ── QUERY POOLS ───────────────────────────────────────────────
// 8-10 validated queries per industry
// Selected randomly per build — fresh photo every time
// Oriented toward portrait/square for mobile full-bleed hero

const PHOTO_DB = {

  // ── TRADES (RESIDENTIAL SCALE) ──────────────────────────────
  plumbing: [
    'plumber fixing sink home close up hands',
    'plumber pipe repair residential bathroom',
    'plumber tools wrench home repair',
    'water pipe repair close up hands',
    'plumber under sink home repair natural light',
    'residential plumbing repair professional',
    'plumber working home bathroom natural',
    'pipe fitting close up hands tools',
  ],

  electrical: [
    'electrician wiring home residential close',
    'electrician distribution board home',
    'electrician hands cable residential',
    'electrical wiring repair close up',
    'electrician working home natural light',
    'residential electrical repair professional',
    'electrician tools hands working',
    'circuit breaker home electrical close',
  ],

  aircon: [
    'split unit air conditioner installation wall',
    'air conditioning unit home wall mounted',
    'hvac technician split unit residential',
    'air conditioner remote control home',
    'split air conditioner clean white wall',
    'air conditioning installation home close',
    'technician air conditioner unit wall',
    'split unit aircon modern home',
  ],

  handyman: [
    'handyman tools belt home repair',
    'handyman fixing door home residential',
    'maintenance man home repair natural light',
    'handyman drill home improvement',
    'home repair tools natural light',
    'handyman working home close up',
    'maintenance repair home professional',
    'handyman painting wall home close',
  ],

  carpentry: [
    'carpenter wood workshop hands close',
    'carpenter measuring cutting wood',
    'woodwork hands tools natural light',
    'carpenter fitting door frame home',
    'wood cabinet custom build close',
    'carpenter tools bench workshop warm',
    'joinery woodwork hands detail',
    'carpenter sanding wood natural light',
  ],

  painting: [
    'painter roller wall white clean',
    'house painter brush close up wall',
    'painting wall home fresh white',
    'painter professional home interior',
    'paint brush roller home renovation',
    'wall painting close up smooth',
    'house painter natural light interior',
    'painting home walls professional clean',
  ],

  roofing: [
    'roof tiles roofing professional close',
    'roofer working roof residential',
    'roof repair tiles close up sky',
    'roofing contractor residential home',
    'roof installation tiles professional',
    'roofer close up working tiles',
    'residential roof repair natural light',
    'roof tile pattern close up warm',
  ],

  waterproofing: [
    'waterproofing roof membrane close up',
    'waterproof coating surface professional',
    'waterproofing application close hands',
    'roof waterproof treatment professional',
    'damp proofing wall close up',
    'waterproofing membrane application',
    'professional waterproofing surface close',
    'wall waterproof coating application',
  ],

  pest_control: [
    'pest control spray professional uniform',
    'exterminator professional uniform home',
    'pest control technician home residential',
    'pest control professional protective gear',
    'fumigation professional home service',
    'pest control equipment professional',
    'exterminator spraying home close',
    'pest control professional service home',
  ],

  appliance_repair: [
    'appliance repair technician home close',
    'washing machine repair technician',
    'appliance technician tools home repair',
    'fridge repair close up technician',
    'home appliance repair professional',
    'technician fixing appliance home',
    'washing machine repair close hands',
    'appliance service technician tools',
  ],

  // ── FLOORING (SA-SPECIFIC — NO TILE NO HARDWOOD NO EPOXY) ───
  flooring: [
    'carpet installation close up hands',
    'carpet rolls warehouse warm light',
    'laminate floor installation click close',
    'vinyl floor plank installation close',
    'carpet texture warm bedroom floor',
    'laminate flooring installation professional',
    'vinyl plank floor modern interior',
    'carpet fitting professional close hands',
    'laminate floor sample warm wood look',
    'sheet vinyl floor clean commercial',
  ],

  // ── BEAUTY & WELLNESS ────────────────────────────────────────
  hair_salon: [
    'hair stylist scissors close bokeh warm',
    'hair salon styling mirror warm light',
    'hairdresser cutting hair close up',
    'hair colour salon professional warm',
    'stylist hands hair natural light bokeh',
    'hair salon interior warm lighting',
    'hairdresser blow dry styling close',
    'hair cut close up scissors professional',
  ],

  barber: [
    'barber fade close up clippers',
    'barber shop interior warm light',
    'barber cutting hair close clippers',
    'barbershop mirror chair warm',
    'barber fade haircut close professional',
    'barber tools clippers comb close',
    'barber shop interior bokeh warm',
    'men haircut barber close professional',
  ],

  nails: [
    'nail technician manicure close up',
    'nail art close up hands beautiful',
    'manicure nail polish hands close',
    'nail salon hands close up art',
    'gel nails close up hands professional',
    'nail technician working close hands',
    'manicure hands close beautiful nails',
    'nail polish application close up',
  ],

  spa: [
    'massage therapy hands back close',
    'spa candles stones relaxing warm',
    'massage table warm light relaxing',
    'spa treatment hands close warm',
    'wellness massage professional close',
    'spa interior candles warm calm',
    'massage therapy professional warm',
    'relaxing spa treatment close warm',
  ],

  lashes: [
    'eyelash extension close up professional',
    'lash technician applying extensions close',
    'eyelash extension beautiful close up',
    'lash extensions eye close up',
    'beauty technician lashes close',
    'eyelash extension application close',
    'beautiful lashes close up bokeh',
    'lash extension professional close eye',
  ],

  makeup: [
    'makeup artist applying makeup close',
    'makeup brush face close up professional',
    'makeup application professional close',
    'beauty makeup artist close warm',
    'makeup brushes professional close up',
    'makeup artist working close natural',
    'bridal makeup application close',
    'makeup tools professional close up',
  ],

  // ── FOOD & HOSPITALITY ───────────────────────────────────────
  restaurant: [
    'restaurant food plated warm close',
    'restaurant table setting warm light',
    'plated meal restaurant warm bokeh',
    'restaurant interior warm evening',
    'food close up warm restaurant',
    'restaurant dish close up beautiful',
    'dining table warm light food',
    'restaurant meal close warm bokeh',
  ],

  catering: [
    'catering food trays close up warm',
    'plated catering food close professional',
    'catering dishes food close warm',
    'food trays catering professional warm',
    'catering spread food close up',
    'buffet catering food warm close',
    'catering professional food presentation',
    'catering dishes warm food close',
  ],

  bakery: [
    'bakery bread fresh warm close',
    'cake baking close up warm light',
    'fresh bread bakery warm morning',
    'pastry close up bakery warm',
    'baking hands bread dough warm',
    'cake decoration close up professional',
    'fresh pastry bakery morning warm',
    'bread loaves warm bakery close',
  ],

  cafe: [
    'coffee cup latte art close warm',
    'cafe interior warm light cozy',
    'barista coffee making close warm',
    'coffee latte art cup close',
    'cafe table coffee warm morning',
    'coffee cup close up warm bokeh',
    'barista hands coffee machine close',
    'coffee shop warm interior cozy',
  ],

  street_food: [
    'street food vendor warm smoke cooking',
    'food stall cooking warm light',
    'grilled food vendor smoke warm',
    'street food cooking close warm',
    'food vendor hands cooking warm',
    'informal food stall warm cooking',
    'street vendor food smoke natural',
    'food cooking close up flame warm',
  ],

  chicken_shop: [
    'grilled chicken close up flame warm',
    'rotisserie chicken close warm light',
    'grilled chicken pieces close up',
    'flame grilled chicken close warm',
    'chicken grilling close smoke warm',
    'grilled chicken pieces warm close',
    'roasted chicken close up warm',
    'chicken grill flame close warm',
  ],

  shisa_nyama: [
    'braai meat grilling close up flame',
    'barbecue meat close up warm smoke',
    'grilling meat braai smoke warm',
    'meat on grill close flame warm',
    'bbq grill meat close smoke',
    'braai fire meat close up warm',
    'grilled meat smoke close warm',
    'outdoor grill meat flame close',
  ],

  bottle_store: [
    'liquor store bottles shelf warm',
    'wine bottles shelf close up',
    'spirits bottles store shelf warm',
    'alcohol bottles shelf store close',
    'liquor shelf bottles warm light',
    'beer bottles cold store close',
    'wine spirits bottles shelf warm',
    'bottle store shelf close up warm',
  ],

  // ── AUTOMOTIVE ───────────────────────────────────────────────
  mechanic: [
    'mechanic car engine close up hands',
    'car repair mechanic workshop close',
    'mechanic working under car close',
    'auto repair hands engine close',
    'mechanic tools workshop car close',
    'car service mechanic close hands',
    'auto workshop mechanic natural light',
    'mechanic diagnostic car close hands',
  ],

  panel_beater: [
    'panel beating car repair close up',
    'car body repair sanding close',
    'auto body repair professional close',
    'car panel repair professional workshop',
    'body shop car repair close',
    'auto body sanding professional close',
    'car dent repair close professional',
    'panel beating workshop close up',
  ],

  tyres: [
    'tyre fitting close up professional',
    'car tyre change workshop close',
    'tyre shop fitting professional',
    'tyre change car workshop close',
    'wheel tyre fitting professional close',
    'tyre fitment workshop professional',
    'car wheel tyre change close',
    'tyre shop workshop close up',
  ],

  carwash: [
    'car wash hands chamois close up',
    'car washing soap suds close',
    'hand car wash close up clean',
    'car wash wipe down close professional',
    'washing car hands close soapy',
    'car detailing close up professional',
    'car wash clean shine close',
    'hand wash car close up water',
  ],

  bakkie_hire: [
    'pickup truck bakkie side profile clean',
    'truck hire transport professional',
    'pickup truck loading close up',
    'delivery truck professional clean',
    'truck transport hire professional',
    'pickup truck professional clean side',
    'transport truck hire close',
    'bakkie truck professional clean',
  ],

  // ── CONSTRUCTION & RENOVATION ────────────────────────────────
  construction: [
    'construction worker residential building',
    'builder laying bricks close up',
    'construction residential home build',
    'builder hands bricks mortar close',
    'home construction worker natural',
    'residential building construction close',
    'builder construction residential warm',
    'bricklaying close up hands mortar',
  ],

  renovation: [
    'home renovation interior modern clean',
    'renovation interior before after clean',
    'home improvement renovation close',
    'interior renovation modern clean',
    'renovation work home interior close',
    'home makeover interior modern',
    'renovation interior clean modern warm',
    'home renovation professional interior',
  ],

  plastering: [
    'plastering wall smooth close hands',
    'plaster wall application close up',
    'wall plastering professional close',
    'plasterer smooth wall close hands',
    'wall plaster application professional',
    'plastering hands close up wall',
    'smooth plaster wall professional',
    'plasterer working wall close up',
  ],

  welding: [
    'welder sparks metal work close',
    'welding sparks close up professional',
    'metal welding close spark warm',
    'welder mask sparks close work',
    'welding professional metal close',
    'sparks welding close up metal',
    'steel welding professional close',
    'welding work metal sparks close',
  ],

  // ── CLEANING ─────────────────────────────────────────────────
  cleaning: [
    'professional cleaner uniform cleaning',
    'cleaning service professional mop floor',
    'cleaner professional uniform indoor',
    'cleaning professional service indoor',
    'mop floor cleaning professional',
    'cleaning staff uniform professional',
    'professional cleaning service indoor',
    'cleaner spray clean professional',
  ],

  laundry: [
    'laundry clean folded clothes warm',
    'laundry service clean white clothes',
    'folded laundry clean warm light',
    'laundry professional clean service',
    'clean clothes folded warm light',
    'laundry service professional clean',
    'washing clean clothes folded warm',
    'laundry clean professional service',
  ],

  // ── HEALTH & MEDICAL ─────────────────────────────────────────
  medical: [
    'doctor consultation professional warm',
    'medical professional stethoscope close',
    'doctor patient consultation warm',
    'clinic professional medical warm',
    'healthcare professional consultation',
    'doctor stethoscope professional close',
    'medical consultation warm professional',
    'clinic interior clean professional',
  ],

  pharmacy: [
    'pharmacy shelves medicine professional',
    'pharmacist professional close counter',
    'pharmacy medicine shelves clean',
    'pharmacist counter professional warm',
    'pharmacy professional service close',
    'medicine pharmacy shelves professional',
    'pharmacy counter professional clean',
    'pharmacist helping customer close',
  ],

  physio: [
    'physiotherapy treatment hands close',
    'physio massage therapy professional',
    'physiotherapy exercise professional',
    'physio treatment hands patient close',
    'rehabilitation therapy professional warm',
    'physiotherapist hands treatment close',
    'physio professional treatment warm',
    'therapy hands close professional',
  ],

  // ── DENTAL ───────────────────────────────────────────────────
  dental: [
    'dentist dental chair professional clean',
    'dental treatment professional close',
    'dentist professional clean clinic',
    'dental clinic professional clean warm',
    'dentist smiling patient professional',
    'dental professional treatment close',
    'teeth smile beautiful close up',
    'dental care professional clean close',
  ],

  // ── FITNESS ──────────────────────────────────────────────────
  gym: [
    'gym weights training professional',
    'fitness gym training equipment',
    'workout gym weights close up',
    'fitness training gym professional',
    'gym equipment weights professional',
    'training fitness gym close',
    'gym workout professional equipment',
    'fitness weights gym warm light',
  ],

  personal_trainer: [
    'personal trainer training client',
    'fitness coach training professional',
    'personal trainer outdoor fitness',
    'fitness coach client training close',
    'personal training professional outdoor',
    'trainer coaching fitness close',
    'personal trainer fitness professional',
    'fitness coaching outdoor professional',
  ],

  yoga: [
    'yoga pose studio calm light',
    'yoga meditation calm natural light',
    'yoga studio peaceful natural',
    'yoga pose calm warm light',
    'yoga practice calm studio',
    'meditation yoga peaceful light',
    'yoga class calm professional',
    'yoga pose natural light calm',
  ],

  // ── EVENTS ───────────────────────────────────────────────────
  events: [
    'event marquee tent tables chairs setup',
    'event setup tables chairs outdoor',
    'marquee tent event outdoor warm',
    'event tables chairs setup outdoor',
    'outdoor event setup marquee warm',
    'event decor tables chairs professional',
    'marquee event setup professional',
    'outdoor event tent setup warm',
  ],

  wedding: [
    'wedding reception tables elegant warm',
    'wedding decor flowers elegant close',
    'wedding table setting elegant warm',
    'wedding ceremony outdoor elegant',
    'wedding flowers decor close warm',
    'wedding reception elegant warm light',
    'wedding table flowers close elegant',
    'wedding decor elegant warm beautiful',
  ],

  photography: [
    'photographer camera outdoor natural light',
    'photography camera bokeh natural',
    'photographer shooting outdoor natural',
    'camera lens close up bokeh',
    'photographer professional natural light',
    'photography natural light bokeh close',
    'photographer camera professional outdoor',
    'camera photography natural bokeh',
  ],

  dj: [
    'dj mixer decks close up lights',
    'dj console mixing music close',
    'dj equipment music lights close',
    'mixer dj hands music close',
    'dj setup equipment music lights',
    'dj decks music professional close',
    'dj mixing console close lights',
    'music dj professional setup close',
  ],

  // ── EDUCATION ────────────────────────────────────────────────
  tutoring: [
    'tutor student home table books warm',
    'tutoring home kitchen table natural',
    'student books studying home warm',
    'tutor helping student home close',
    'home tutoring books study warm',
    'student studying books home natural',
    'tutoring one on one home warm',
    'books study table home warm light',
  ],

  // ── PROPERTY ─────────────────────────────────────────────────
  property: [
    'house property exterior modern clean',
    'real estate house exterior clean',
    'property home exterior modern',
    'house exterior clean modern warm',
    'property estate home professional',
    'real estate home exterior warm',
    'house modern exterior clean light',
    'property home exterior professional',
  ],

  // ── LEGAL & FINANCIAL ────────────────────────────────────────
  legal: [
    'lawyer desk professional office',
    'legal books desk professional',
    'attorney professional office close',
    'law books desk professional warm',
    'legal professional desk office',
    'lawyer professional office books',
    'legal desk professional close warm',
    'attorney office professional books',
  ],

  accounting: [
    'accountant desk calculator professional',
    'tax accounting desk professional',
    'financial professional desk close',
    'accounting books calculator desk',
    'tax professional desk warm close',
    'accountant professional desk papers',
    'financial desk calculator professional',
    'accounting professional close warm',
  ],

  crypto: [
    'laptop trading charts professional',
    'crypto trading phone laptop modern',
    'financial charts laptop professional',
    'trading setup laptop screens modern',
    'laptop charts trading professional',
    'digital finance laptop modern clean',
    'trading charts professional laptop',
    'laptop financial professional modern',
  ],

  // ── TECH & DIGITAL (EKASI RISING) ────────────────────────────
  it_support: [
    'laptop repair technician close up',
    'computer repair professional close',
    'it technician laptop repair',
    'computer technician professional close',
    'laptop repair hands close technical',
    'it professional laptop repair close',
    'technician computer repair close',
    'laptop open repair professional close',
  ],

  social_media: [
    'social media phone content creation',
    'content creator phone filming modern',
    'social media professional phone laptop',
    'content creation phone professional',
    'social media management laptop phone',
    'digital marketing professional laptop',
    'content creator modern professional',
    'phone laptop content professional',
  ],

  ai_consulting: [
    'laptop modern technology professional',
    'technology consulting professional modern',
    'digital professional laptop modern clean',
    'tech consulting laptop professional',
    'modern technology professional laptop',
    'digital consultant professional laptop',
    'technology modern professional clean',
    'laptop professional modern technology',
  ],

  graphic_design: [
    'graphic designer laptop creative close',
    'design work laptop creative professional',
    'graphic design creative laptop close',
    'designer working laptop creative',
    'creative design professional laptop',
    'graphic design work close professional',
    'designer laptop creative professional',
    'design professional creative laptop',
  ],

  cctv: [
    'cctv camera installation professional',
    'security camera installation close',
    'cctv installation professional close',
    'security camera wall close professional',
    'surveillance camera professional close',
    'cctv security professional installation',
    'camera security installation close',
    'security cctv professional install',
  ],

  // ── SECURITY ─────────────────────────────────────────────────
  security: [
    'security guard patrol professional uniform',
    'security officer professional uniform',
    'security guard professional patrol car',
    'security patrol professional car uniform',
    'armed response security professional',
    'security officer uniform professional',
    'patrol security professional car',
    'security guard professional close uniform',
  ],

  // ── RETAIL (INFORMAL) ────────────────────────────────────────
  spaza: [
    'small store shelves informal market',
    'corner store shelves products warm',
    'informal shop shelves products warm',
    'small grocery store shelves close',
    'neighbourhood store shelves warm',
    'local shop products shelves warm',
    'small store products shelves close',
    'informal retail store shelves warm',
  ],

  hardware: [
    'hardware store tools shelves professional',
    'building materials store professional',
    'hardware tools shelf close warm',
    'building supplies store professional',
    'hardware shelves tools professional',
    'tools hardware store close warm',
    'building materials hardware close',
    'hardware professional store tools',
  ],

  // ── TRANSPORT & LOGISTICS ────────────────────────────────────
  transport: [
    'delivery van professional driver',
    'logistics transport van professional',
    'delivery professional van close',
    'transport professional driver van',
    'logistics van delivery professional',
    'courier van professional delivery',
    'transport delivery professional close',
    'driver professional van delivery',
  ],

  kombi: [
    'minibus taxi transport professional',
    'minibus van transport professional',
    'kombi transport professional clean',
    'minibus hire professional transport',
    'van transport hire professional',
    'minibus professional transport clean',
    'hire transport van professional',
    'minibus clean professional transport',
  ],

  // ── CHILDCARE ────────────────────────────────────────────────
  childcare: [
    'childcare teacher children warm close',
    'daycare children playing warm',
    'teacher children close warm light',
    'childcare warm children playing',
    'creche children happy warm',
    'teacher child close warm natural',
    'childcare professional warm children',
    'children learning warm close',
  ],

  // ── FUNERAL SERVICES ─────────────────────────────────────────
  funeral: [
    'funeral flowers peaceful close warm',
    'memorial flowers peaceful warm',
    'funeral service flowers close',
    'peaceful memorial flowers warm',
    'funeral flowers close up warm',
    'memorial service flowers peaceful',
    'flowers memorial close peaceful',
    'funeral professional service flowers',
  ],

  // ── SIGNAGE & PRINT ──────────────────────────────────────────
  signage: [
    'signage printing professional banner',
    'banner printing professional close',
    'printing professional signage close',
    'vinyl printing professional sign',
    'signage professional print close',
    'banner sign printing professional',
    'print professional signage close',
    'branding print professional close',
  ],

  // ── FALLBACK ─────────────────────────────────────────────────
  // Clean, aspirational, professional — works for anything
  optometrist: [
    'optometrist eye exam professional clinic',
    'optical store glasses frames professional',
    'eye care professional optometry clinic',
    'optician glasses professional modern',
    'vision care eye test professional',
    'optical glasses frames retail clean',
  ],
  vet: [
    'veterinarian dog cat professional clinic',
    'vet animal clinic professional care',
    'veterinary practice professional pet care',
    'animal doctor professional clinic warm',
    'vet professional dog examination',
  ],
  driving_school: [
    'driving lesson instructor car professional',
    'driving school car lesson road',
    'driving instructor professional car lesson',
    'learner driver lesson professional road',
  ],
  tattoo: [
    'tattoo artist professional studio work',
    'tattoo studio professional artist close',
    'tattoo work professional artist detail',
    'body art tattoo professional studio',
  ],
  furniture: [
    'furniture store interior design modern',
    'furniture showroom modern professional',
    'furniture workshop craftsman wood professional',
    'modern furniture design interior professional',
  ],
  tiling: [
    'tile installation professional bathroom floor',
    'tiler professional tile floor work',
    'bathroom tile installation professional',
    'floor tile professional installation work',
  ],
  glazier: [
    'glass installation professional window',
    'glazier professional glass window work',
    'glass window professional installation',
  ],
  general: [
    'small business storefront south africa',
    'local business interior warm professional',
    'small business owner working confident',
    'south africa small business professional',
    'local shop interior professional warm',
    'business premises exterior professional',
    'small business professional interior',
    'local business professional warm light',
  ],

  beauty_salon: [
    'beauty salon interior elegant warm professional',
    'hair salon mirror styling chair warm light',
    'beauty salon styling station professional warm',
    'salon interior elegant clean professional',
    'hair beauty salon warm professional interior',
    'styling salon professional mirror warm',
    'beauty salon professional clean warm light',
    'unisex salon interior professional warm',
  ],
  florist: [
    'florist shop flowers beautiful colourful',
    'flower bouquet fresh colourful close',
    'florist arranging flowers beautiful',
    'fresh flowers bouquet colourful shop',
    'flower shop beautiful arrangement close',
    'florist flowers colourful fresh bright',
    'bouquet flowers beautiful fresh close',
    'floral arrangement beautiful colourful',
  ],
  landscaping: [
    'landscaping garden beautiful green',
    'garden landscaping professional green',
    'landscape garden design beautiful',
    'garden design professional beautiful green',
    'landscaping professional garden outdoor',
  ],
  garden: [
    'beautiful garden green outdoor',
    'garden green plants outdoor natural',
    'garden outdoor green plants beautiful',
    'green garden outdoor plants natural',
    'garden design outdoor green natural',
  ],
  nursery: [
    'plant nursery green plants professional',
    'garden nursery plants green natural',
    'nursery plants green professional',
    'plant nursery green natural outdoor',
  ],
  car_wash: [
    'car wash clean professional shiny',
    'vehicle detailing professional clean',
    'car detailing professional clean shiny',
    'auto detailing professional vehicle clean',
    'car wash professional clean exterior',
  ],
  physiotherapy: [
    'physiotherapy treatment professional clinic',
    'physio treatment professional close',
    'physiotherapy clinic professional warm',
    'physical therapy professional treatment',
    'physio professional treatment warm',
  ],
  building: [
    'construction building professional site',
    'builder professional construction site',
    'building construction professional',
    'construction site professional builder',
    'building professional construction work',
  ],

  // ── NEW INDUSTRIES ────────────────────────────────────────────
  butchery: [
    'butcher shop fresh meat display',
    'butcher cutting meat professional',
    'fresh meat butcher counter close',
    'butcher shop display beef close',
    'meat cutting professional butcher',
    'fresh cuts butcher shop display',
  ],
  pizza: [
    'wood fired pizza professional oven',
    'pizza restaurant fresh ingredients close',
    'pizza making dough professional',
    'wood fired pizza close up hot',
    'artisan pizza restaurant professional',
  ],
  sushi: [
    'sushi chef professional close up',
    'fresh sushi rolls close professional',
    'sushi restaurant professional chef',
    'japanese food sushi close fresh',
    'sushi platter fresh professional',
  ],
  pub: [
    'bar counter professional warm light',
    'pub interior warm inviting counter',
    'bar taps close warm interior',
    'tavern interior warm social',
    'bar counter warm drinks close',
  ],
  guest_house: [
    'bed and breakfast room clean bright',
    'guesthouse room inviting clean bright',
    'boutique hotel room clean bright',
    'guesthouse interior clean welcoming',
    'bed breakfast room bright inviting',
  ],
  lodge: [
    'african lodge luxury interior warm',
    'bush lodge room warm natural',
    'lodge outdoor nature deck warm',
    'luxury lodge south africa nature',
    'game lodge interior warm natural',
  ],
  home_industry: [
    'home baking kitchen professional warm',
    'homemade baked goods close warm',
    'home kitchen baking professional',
    'artisan food home kitchen warm',
    'home industry food production warm',
  ],
  deli: [
    'deli counter fresh food close',
    'delicatessen display professional fresh',
    'charcuterie board professional close',
    'deli food fresh display close',
    'artisan deli counter professional',
  ],
  farm_stall: [
    'farm stall fresh produce display',
    'farm fresh vegetables display colourful',
    'farm stall rustic fresh produce',
    'fresh farm produce display rustic',
    'farm market fresh vegetables warm',
  ],
  ice_cream: [
    'ice cream shop colourful close',
    'ice cream scoops close colourful',
    'dessert shop ice cream bright',
    'ice cream cone close bright',
    'gelato display colourful close professional',
  ],
  juice_bar: [
    'fresh juice bar colourful counter',
    'smoothie bowl fresh colourful close',
    'juice bar fresh fruit colourful',
    'healthy smoothie fresh colourful',
    'juice bar counter fresh bright',
  ],
  skincare: [
    'skincare treatment professional close',
    'facial treatment spa professional close',
    'skincare products professional clean',
    'beauty treatment professional close warm',
    'skin clinic professional treatment',
  ],
  waxing: [
    'beauty salon treatment professional warm',
    'waxing treatment professional close',
    'beauty treatment spa professional',
    'salon treatment professional warm',
  ],
  beauty_salon: [
    'beauty salon interior professional warm',
    'beauty treatment professional close',
    'salon chair professional warm interior',
    'beauty salon professional clean warm',
  ],
  chiropractor: [
    'chiropractic treatment professional close',
    'physiotherapy treatment professional',
    'spinal treatment professional clinic',
    'wellness treatment professional close',
  ],
  nutrition: [
    'nutritionist consultation professional',
    'healthy food nutrition professional',
    'dietitian consultation professional warm',
    'nutrition healthy food colourful',
  ],
  mental_health: [
    'counselling session professional warm',
    'therapy room professional warm calm',
    'psychologist consultation professional',
    'mental wellness professional calm warm',
  ],
  martial_arts: [
    'karate training professional studio',
    'martial arts training action',
    'boxing training professional gym',
    'martial arts studio professional',
  ],
  swimming_lessons: [
    'swimming pool lesson professional',
    'swimming coach pool professional',
    'swim lesson child pool professional',
    'pool swimming lesson professional',
  ],
  health_shop: [
    'health food store clean bright',
    'health shop supplements professional',
    'natural health store bright clean',
    'wellness products health store',
  ],
  clothing: [
    'clothing boutique interior clean bright',
    'fashion boutique professional display',
    'clothing store interior bright clean',
    'fashion display boutique professional',
  ],
  shoes: [
    'shoe store display professional clean',
    'shoes display boutique professional',
    'footwear store professional clean',
    'shoe shop display bright clean',
  ],
  electronics: [
    'electronics store professional clean',
    'phone repair shop professional',
    'electronics display clean bright',
    'tech store professional clean',
  ],
  car_parts: [
    'auto parts store professional clean',
    'car parts display professional',
    'spare parts mechanical professional',
    'automotive parts store professional',
  ],
  pet_shop: [
    'pet shop animals warm interior',
    'pet store cute animals display',
    'pet shop interior warm bright',
    'animals pet store professional warm',
  ],
  toys: [
    'toy store bright colourful interior',
    'toys display bright colourful clean',
    'toy shop bright happy interior',
    'children toys display bright colourful',
  ],
  books: [
    'bookstore interior warm shelves',
    'books library warm shelves interior',
    'bookshop warm inviting interior',
    'books shelves warm interior',
  ],
  clothing_boutique: [
    'boutique clothing interior bright',
    'fashion boutique display professional',
  ],
  towing: [
    'tow truck professional road',
    'vehicle recovery tow truck professional',
    'towing service truck professional',
    'tow truck vehicle recovery professional',
  ],
  car_rental: [
    'car rental fleet professional clean',
    'car hire professional clean fleet',
    'vehicle rental professional clean',
    'rental cars professional fleet clean',
  ],
  venue: [
    'function venue professional elegant',
    'event venue elegant professional interior',
    'function hall professional elegant',
    'venue interior professional elegant bright',
  ],
  party_hire: [
    'event hire tent professional setup',
    'party setup professional elegant',
    'event decor professional beautiful setup',
    'party hire professional setup',
  ],
  band: [
    'live band performing professional stage',
    'musician performing professional stage',
    'band live performance professional',
    'music performance professional stage',
  ],
  videography: [
    'videographer filming professional camera',
    'video production professional filming',
    'filmmaker professional camera close',
    'videography professional filming',
  ],
  courier: [
    'courier delivery professional van',
    'delivery driver professional uniform',
    'parcel delivery professional fast',
    'courier professional delivery uniform',
  ],
  moving: [
    'moving furniture professional truck',
    'removals team professional truck',
    'house moving professional team',
    'removal truck professional team',
  ],
  taxi: [
    'taxi cab professional clean urban',
    'metered taxi professional urban',
    'ride hailing professional car urban',
  ],
  solar: [
    'solar panels installation professional roof',
    'solar installation professional clean',
    'solar panels roof professional',
    'solar energy installation professional',
  ],
  locksmith: [
    'locksmith working lock professional',
    'lock repair professional close',
    'locksmith professional tools door',
    'lock installation professional close',
  ],
  gates: [
    'gate installation professional clean',
    'electric gate professional installation',
    'security gate professional modern',
    'automatic gate professional installation',
  ],
  demolition: [
    'construction demolition professional',
    'building construction site professional',
    'demolition professional site',
    'construction site professional workers',
  ],
  pool_service: [
    'swimming pool cleaning professional',
    'pool maintenance professional clean blue',
    'pool service professional maintenance',
    'pool cleaning professional blue water',
  ],
  pool_building: [
    'swimming pool construction professional',
    'new pool installation professional',
    'pool building professional construction',
    'luxury pool professional construction',
  ],
  curtains: [
    'curtain fitting professional interior',
    'blinds installation professional interior',
    'interior curtains professional warm',
    'window treatments professional interior',
  ],
  alterations: [
    'seamstress sewing professional close',
    'clothing alterations professional sewing',
    'tailor sewing professional close',
    'alterations professional sewing close',
  ],
  shoe_repair: [
    'shoe repair professional cobbler close',
    'cobbler working shoe professional',
    'shoe repair workshop professional',
    'footwear repair professional close',
  ],
  beekeeping: [
    'beekeeper hive professional natural',
    'honeybee hive professional natural',
    'beekeeper professional honey natural',
    'honey extraction professional natural',
  ],
  fishing: [
    'fishing bait tackle professional',
    'fishing store bait professional',
    'angling fishing professional natural',
    'fishing tackle professional close',
  ],
  home_care: [
    'home care nurse professional warm',
    'nursing care professional home warm',
    'home healthcare professional warm',
    'elderly care professional home warm',
  ],
  after_school: [
    'children learning classroom bright',
    'after school kids learning warm',
    'education children classroom bright',
    'kids learning after school warm',
  ],
  coding_school: [
    'coding class professional laptop',
    'programming students professional',
    'tech education coding professional',
    'coding students laptop professional',
  ],
  drone: [
    'drone aerial photography professional',
    'drone flying professional aerial',
    'aerial drone photography professional',
    'drone operator professional aerial',
  ],
  printing: [
    'print shop printing professional close',
    'printing press professional close',
    'print production professional',
    'large format printing professional',
  ],
  software: [
    'software developer professional laptop',
    'app development professional coding',
    'software development professional clean',
    'developer coding professional laptop',
  ],
  hr: [
    'recruitment interview professional',
    'hr professional meeting warm',
    'hiring recruitment professional',
    'human resources professional meeting',
  ],
  consulting: [
    'business consulting professional meeting',
    'consultant professional meeting warm',
    'consulting meeting professional',
    'business advisor professional meeting',
  ],
  mortgage: [
    'property bond professional consultation',
    'home loan professional consultation',
    'mortgage consultant professional warm',
    'bond originator professional consultation',
  ],
  financial_advisor: [
    'financial advisor professional consultation',
    'wealth management professional meeting',
    'financial planning professional warm',
    'insurance advisor professional meeting',
  ],
  tax: [
    'tax consultant professional meeting',
    'tax office professional clean',
    'accountant tax professional meeting',
    'tax advisor professional consultation',
  ],
  gp: [
    'doctor consultation professional warm',
    'gp doctor professional clinic',
    'medical consultation doctor warm',
    'doctor office professional clean warm',
  ],
  specialist: [
    'medical specialist professional clinic',
    'specialist doctor professional warm',
    'medical professional consultation warm',
  ],
  hearing: [
    'audiologist professional hearing test',
    'hearing aid professional consultation',
    'hearing clinic professional warm',
  ],
  nukery: [
    'plant nursery green professional',
    'garden nursery plants professional',
    'nursery plants green natural',
    'plant nursery professional natural green',
  ],
  farming: [
    'farm south africa natural outdoor',
    'smallholding farming natural outdoor',
    'farm produce natural outdoor',
    'farm south africa outdoor natural',
  ],
};


// ── SA INFERENCE ENGINE ───────────────────────────────────────
// Takes business name + free text and returns industry key
// SA-specific vocabulary baked in
// Handles misspellings, colloquialisms, and informal terms

function inferIndustry(businessName, freeText) {
  const combined = `${businessName || ''} ${freeText || ''}`.toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // ── SA-SPECIFIC TERMS FIRST (highest priority) ───────────────
  if (/botel|bottle store|liquor|bottle shop|off.?licence/.test(combined))   return 'bottle_store';
  if (/spaza|tuck.?shop|tuckshop/.test(combined))                             return 'spaza';
  if (/shisa.?nyama|shisanyama/.test(combined))                               return 'shisa_nyama';
  if (/kota|quarter loaf/.test(combined))                                     return 'street_food';
  if (/braai(?!\s*chicken)/.test(combined))                                   return 'shisa_nyama';
  if (/bakkie.?hire|bakkie.?rental/.test(combined))                           return 'bakkie_hire';
  if (/kombi|minibus|minibus.?taxi/.test(combined))                           return 'kombi';
  if (/panel.?beat|panelbeat/.test(combined))                                 return 'panel_beater';
  if (/ekasi|township|informal/.test(combined))                               return 'general';

  // ── TRADES (RESIDENTIAL) ─────────────────────────────────────
  if (/plumb|plummer|plumer/.test(combined))                                  return 'plumbing';
  if (/electr|electrician|electrican|electritian|wiring/.test(combined))     return 'electrical';
  if (/aircon|air.?con|hvac|split.?unit|air.?condition/.test(combined))      return 'aircon';
  if (/handyman|hand.?man|maintenan|maintanance|jack.?of.?all/.test(combined)) return 'handyman';
  if (/carpent|carpender|joiner|cabinet/.test(combined))                     return 'carpentry';
  if (/paint(?!er photo|ing photo)/.test(combined))                          return 'painting';
  if (/roof(?!ing photo)/.test(combined))                                    return 'roofing';
  if (/waterproof|damp.?proof/.test(combined))                               return 'waterproofing';
  if (/pest|extermina|fumigat/.test(combined))                               return 'pest_control';
  if (/appliance|fridge|washing.?machine|geyser/.test(combined))            return 'appliance_repair';
  if (/weld/.test(combined))                                                  return 'welding';
  if (/plaster/.test(combined))                                               return 'plastering';
  if (/build|construct|renovat|contractor/.test(combined))                   return 'construction';

  // ── FLOORING (SA-SPECIFIC) ────────────────────────────────────
  if (/floor|carpet|laminate|vinyl|lino/.test(combined))                     return 'flooring';

  // ── BEAUTY & WELLNESS ────────────────────────────────────────
  if (/lash|brow/.test(combined))                                             return 'lashes';
  if (/nail|manicure|pedicure/.test(combined))                               return 'nails';
  if (/barber|unisex|mens.?hair/.test(combined))                             return 'barber';
  if (/hair|salon|stylist|hairdress/.test(combined))                         return 'hair_salon';
  if (/spa|massag|wellness/.test(combined))                                  return 'spa';
  if (/makeup|make.?up|beauty(?! salon)/.test(combined))                     return 'makeup';

  // ── FOOD & HOSPITALITY ────────────────────────────────────────
  if (/chicken|flame.?grill|rotisser/.test(combined))                        return 'chicken_shop';
  if (/bakery|bak(?:e|ing)|cake|pastry/.test(combined))                      return 'bakery';
  if (/cafe|coffee|barista/.test(combined))                                   return 'cafe';
  if (/cater|catering/.test(combined))                                        return 'catering';
  if (/resturant|restaurant|restarant|dining|eatery/.test(combined))        return 'restaurant';
  if (/street.?food|food.?stall|vendor/.test(combined))                      return 'street_food';

  // ── AUTOMOTIVE ───────────────────────────────────────────────
  if (/car.?wash|carwash|valet|detailing/.test(combined))                    return 'carwash';
  if (/tyre|tire|wheel/.test(combined))                                       return 'tyres';
  if (/mechanic|motor|auto(?! body)|service.?centre/.test(combined))        return 'mechanic';
  if (/auto.?body|body.?shop|smash.?repair/.test(combined))                  return 'panel_beater';

  // ── CLEANING ─────────────────────────────────────────────────
  if (/laundry/.test(combined))                                               return 'laundry';
  if (/clean|maid|domestic|housekeep/.test(combined))                        return 'cleaning';

  // ── HEALTH ───────────────────────────────────────────────────
  if (/dent|teeth|smile/.test(combined))                                      return 'dental';
  if (/phys(?:io|ical therapy)/.test(combined))                              return 'physio';
  if (/pharmac|chemist|dispensary/.test(combined))                           return 'pharmacy';
  if (/doctor|clinic|medical|health(?! coach)|gp\b/.test(combined))        return 'medical';

  // ── FITNESS ──────────────────────────────────────────────────
  if (/yoga|pilates/.test(combined))                                          return 'yoga';
  if (/personal.?train|fitness.?coach|pt\b/.test(combined))                 return 'personal_trainer';
  if (/gym|fitness/.test(combined))                                           return 'gym';

  // ── EVENTS ───────────────────────────────────────────────────
  if (/dj\b|sound.?system|music.?hire/.test(combined))                       return 'dj';
  if (/photo(?:graph)/.test(combined))                                        return 'photography';
  if (/wedding/.test(combined))                                               return 'wedding';
  if (/event|marquee|tent.?hire|chair.?hire|function/.test(combined))       return 'events';

  // ── EDUCATION ────────────────────────────────────────────────
  if (/tutor|teach|school|educat|college|training/.test(combined))          return 'tutoring';

  // ── PROPERTY ─────────────────────────────────────────────────
  if (/property|estate.?agent|realt|rental/.test(combined))                 return 'property';

  // ── LEGAL & FINANCIAL ────────────────────────────────────────
  if (/crypto|bitcoin|trading|forex|invest/.test(combined))                 return 'crypto';
  if (/account|tax|bookkeep|financ(?!ial advisor)/.test(combined))          return 'accounting';
  if (/legal|law|attorney|advocate|lawyer/.test(combined))                  return 'legal';

  // ── TECH & DIGITAL ───────────────────────────────────────────
  if (/cctv|surveillance|camera.?install/.test(combined))                   return 'cctv';
  if (/social.?media|content.?creat|instagram|tiktok/.test(combined))       return 'social_media';
  if (/ai\b|artificial.?intel|automation/.test(combined))                   return 'ai_consulting';
  if (/graphic.?design|design(?!er photo)|branding|logo/.test(combined))   return 'graphic_design';
  if (/print|signage|banner|vinyl.?wrap/.test(combined))                    return 'signage';
  if (/it\b|tech.?support|computer|laptop.?repair|network/.test(combined)) return 'it_support';
  if (/web.?design|website/.test(combined))                                  return 'ai_consulting';

  // ── SECURITY ─────────────────────────────────────────────────
  if (/secur|guard|patrol|armed.?response/.test(combined))                  return 'security';

  // ── RETAIL ───────────────────────────────────────────────────
  if (/hardware|builder.?supply/.test(combined))                             return 'hardware';
  if (/transport|logistic|courier|deliver/.test(combined))                  return 'transport';

  // ── CHILDCARE ────────────────────────────────────────────────
  if (/crech|daycare|after.?school|childcare/.test(combined))               return 'childcare';

  // ── FUNERAL ──────────────────────────────────────────────────
  if (/funeral|burial|tombstone|memorial/.test(combined))                   return 'funeral';

  // ── GENERAL FALLBACK ─────────────────────────────────────────
  return 'general';
}

// ── MAIN EXPORT ───────────────────────────────────────────────

/**
 * getHeroPhotoQuery
 *
 * @param {string} businessName  e.g. "Zululand Flooring"
 * @param {string} freeText      e.g. "we do laminate and vinyl floors"
 * @returns {string} Validated Unsplash query — fresh variation each call
 */
export function getHeroPhotoQuery(businessName, freeText) {
  const industry = inferIndustry(businessName, freeText);
  const pool     = PHOTO_DB[industry] || PHOTO_DB.general;
  const query    = pool[Math.floor(Math.random() * pool.length)];
  return query;
}

/**
 * getIndustryKey — exposed for design-db alignment and logging
 *
 * @param {string} businessName
 * @param {string} freeText
 * @returns {string} industry key e.g. "flooring", "barber", "crypto"
 */
export function getIndustryKey(businessName, freeText) {
  return inferIndustry(businessName, freeText);
}

/**
 * getHeroPhotoQueryByKey — direct lookup using pre-computed industry key
 * Bypasses text inference. Use when industryKey is already known.
 */
export function getHeroPhotoQueryByKey(industryKey) {
  const pool = PHOTO_DB[industryKey] || PHOTO_DB.general;
  return pool[Math.floor(Math.random() * pool.length)];
}
