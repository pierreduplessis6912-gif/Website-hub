# Website Hub — Roadmap & Brainstorm

## 🔥 Immediate (next session)

### WhatsApp slow-drip pipeline
- Decouple scrape from send
- Cron fires every hour → picks 5-10 pending prospects → builds and sends
- Never blast manually again — just seed the prospects table
- Protects WhatsApp account from Meta restrictions
- Status: **planned**

### Preview iframe fix
- Intake → preview page showing landing page instead of built site
- Relative path issue `/site/slug/` on wrong domain
- Status: **needs investigation**

### Viral referral loop ("Get 5 friends, site is free")
- Show counter on manage page: "3 of 5 friends signed up"
- Auto-waive subscription when 5 referrals convert
- Share button on preview page with pre-written WhatsApp message
- Status: **planned**

---

## 🧱 Partner Portal

### Partner blast
- Separate blast tab for CIPC agents, business consultants, accountants
- Send partner invite WhatsApp (not a site build)
- Status: **built — tab in blast dashboard**

### Partner dashboard (`websitehub.co.za/partner/SLUG`)
- Simple intake form — partner submits client details, fires build pipeline
- Leads feed: pending → building → preview_ready → live → paid
- Credits display: R100 per conversion
- Cash out button → notifies Pierre via WhatsApp
- Status: **planned**

### Partner management in God Mode
- Create partner account (name, phone, slug, commission rate)
- View all partners and stats
- Suspend/activate partner
- Daily submission limit per partner
- Phone dedup across partners
- Status: **planned**

### D1 schema needed
- `partners` table: id, name, phone, slug, status, balance, total_earned, bank_details, created_at
- Status: **planned**

---

## 📊 Command Centre / Admin Dashboard

Replace Termux curl commands with a proper web UI:
- Clients table — sortable, filterable, click to edit (like Airtable)
- Live build feed
- Prospects management
- Config toggles
- D1 as editable spreadsheet
- Status: **planned**

---

## 💰 Pricing & Conversion

### Promo on referral link
- `websitehub.co.za/r/SLUG` already redirects to `/start?promo=CODE` ✅
- start.html reads promo from URL and shows discounted pricing ✅
- Status: **working**

### Upgrade flow fix
- `handleUpgradePayment` uses old package names (expressToStandard etc)
- Needs updating to `hub` / `hub_pro`
- Status: **planned**

---

## 🔧 Technical Debt

### Mass rebuild all outbound preview_ready clients
- Domain fix deployed — all existing sites need rebuild to show correct domain
- Command: silent rebuild all `source='outbound' AND status='preview_ready'`
- Status: **pending**

### Emergency archetype
- No sites built with it yet in the wild
- Overlay too dark — fixed ✅
- Duplicate floating button — fixed ✅
- Status: **monitor**

### Mobile nav
- Hamburger or visible nav links on all archetypes for mobile
- Status: **planned**

---

## 🌍 Lead Sources

### CIPC scraper
- CIPC API at `developer.cipc.co.za` — OAuth2, company registrations
- Data has company names but not always phone numbers
- Pipeline: CIPC → Google Places cross-reference → phone → blast
- Status: **exploring**

### Low review filter
- Businesses with 0-5 reviews = likely new = higher intent
- Add `maxReviews` filter to blast scraper
- Status: **planned**

### Slow-drip from prospect pool
- See WhatsApp slow-drip pipeline above
- Status: **planned**

---

## 🏦 Distribution Channels

### Nedbank SME partnership
- Business Ignite 2026 competition open
- 500+ Nedbank small business bankers in 200+ locations
- New SME loans announced — every borrower needs a website
- Target: 100 paying customers first, then approach
- Status: **future**

### Agency / White-label
- Per-site pricing: R200/month per active client site
- Each agency gets own Evolution WhatsApp instance
- Agency portal with their own branding
- Target: telecoms, ISPs, banks — not web designers
- Status: **future (after 100 customers)**

### Sell the machine
- Realistic valuation today: R150k-R300k
- With 20 paying customers: R500k-R1M+
- Target buyer: digital agency, hosting company, telco
- Status: **future (after 20 customers)**

---

## 💡 Product Ideas

### WhatsApp Business setup service
- Thousands of SA businesses don't have it configured
- R299 once-off, automated
- Status: **idea**

### Google Business Profile optimisation
- Claim, complete, add photos
- R199 once-off + R99/month maintenance
- Status: **idea**

### Tender document pack
- New PTY needs CSD registration, tax clearance, B-BBEE
- Automate the document pack
- R999 once-off
- Status: **idea**

