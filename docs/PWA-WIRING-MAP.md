# Website Hub PWA — Wiring Map

Single source of truth for the consolidated customer-facing PWA. Drop this in `/docs/PWA-WIRING-MAP.md` in the repo and refer back to it during implementation.

**File this replaces:** `intake-experience.html` and `preview-manage-new.html` collapse into one PWA HTML. `start-v2.html` and `admin-dashboard-v8.html` remain separate.

---

## 1. Architecture

```
PUBLIC ENTRY
  ▼
┌─────────────────────────────────────────────────────────┐
│ /start                 → start-v2.html (3 fields)        │
│  /manage/{token}      → PWA                              │
│  /experience/{slug}   → PWA (outbound landing)           │
│  /admin               → admin-dashboard-v8.html          │
└─────────────────────────────────────────────────────────┘

THE PWA, IN ORDER:
  ▼
┌─────────────────────────────────────────────────────────┐
│ 1. screen-init       (inbound only — preview build loop) │
│ 2. screen-experience (iframe + cards drawer + tickets)   │
│ 3. screen-confirm    (payment summary)                   │
│ 4. screen-processing (post-PayFast redirect)             │
│ 5. screen-dashboard  (post-go-live, 5 tabs)              │
└─────────────────────────────────────────────────────────┘
```

### Core principles (locked)

- **Two builds always.** Preview build first (full 3-pass), production build after cards (full 3-pass). Quality over token cost.
- **Live iframe preview** behind cards drawer. Customer can collapse drawer, scroll the real site, tap CTAs.
- **No "AI" language anywhere.** "Website Hub is preparing / building / refining."
- **Price tickets persistent at bottom** of screen-experience and screen-confirm. Tap to expand details.
- **`/intake-preview` is cosmetic only.** Updates `[data-live]` DOM elements. Never substitutes for builds.
- **Palette / font / tagline are surgical patches**, not rebuilds (`/patch-preview`).
- **Industry inferred from business name** by Claude during preview build for inbound. Card 1's industry pick overrides on production build.
- **Single HTML blob in KV** under `app:pwa`. URL + token determines starting screen.

---

## 2. URL Routing

Wire these in `build-worker/src/index.js` → `servePreview()`:

| URL | KV key | Serves | Notes |
|---|---|---|---|
| `/start` | `app:start-v2` | start-v2.html | Lead capture, separate file |
| `/manage/{token}` | `app:pwa` | PWA | Reads client status from D1, picks screen |
| `/experience/{slug}` | `app:pwa` | PWA | Outbound entry, jumps to screen-experience |
| `/build/{token}` | `app:pwa` | PWA | Alias for `/manage/{token}` |
| `/verify/{token}` | `app:pwa` | PWA | Post-payment, jumps to screen-processing |
| `/admin` | `app:admin` | admin-dashboard-v8.html | New route, gated by admin key cookie |
| `/{slug}/...` | `preview:{slug}:{page}` | Generated site | Existing — no change |

### PWA bootstrap logic (runs on every load)

```js
// In PWA <script> on DOMContentLoaded
const path  = location.pathname;
const slug  = (path.match(/\/experience\/([^/]+)/) || [])[1];
const token = (path.match(/\/(manage|build|verify)\/([^/]+)/) || [])[2];

if (token && path.startsWith('/verify/')) {
  initScreen('processing', { token });
} else if (token) {
  const status = await fetchClientStatus(token); // GET /client-status?token=
  if (status === 'live')                   initScreen('dashboard',  { token });
  else if (status === 'paid_pending')      initScreen('processing', { token });
  else if (status === 'preview_ready')     initScreen('experience', { token });
  else                                     initScreen('init',       { token });
} else if (slug) {
  initScreen('experience', { slug });
} else {
  location.href = '/start';
}
```

---

## 3. State Machine

```
[ start-v2 submitted ]
        │ POST /intake → returns { slug, manage_token }
        │ redirect to /manage/{manage_token}
        ▼
   screen-init                       (inbound only)
        │ polls /build-status every 2s
        │ when status === 'preview_ready':
        ▼
   screen-experience  ◄──────────────────────────────┐
        │                                              │
        │ iframe loads /{slug}/raw/?page=index         │
        │ cards drawer overlays                        │
        │ each card advance → /intake-preview          │
        │ palette/font/tagline → /patch-preview        │
        │ photo upload → /upload-assets                │
        │                                              │
        │ after last card → /trigger-rebuild           │
        │                       loop on /build-status  │
        │                       reload iframe          │
        │                                              │
        │ "Continue to checkout" → screen-confirm      │
        ▼                                              │
   screen-confirm                                      │
        │ "Pay" → POST /go-live-link → PayFast         │
        │                                              │
        │ User completes PayFast → redirect            │
        ▼                                              │
   screen-processing                                   │
        │ polls /client-status until status === 'live' │
        ▼                                              │
   screen-dashboard                                    │
        │ loads /manage-panel                          │
        │ tabs: home, site, email, revisions, account  │
        └──────────────────────────────────────────────┘
```

Outbound entry skips screen-init (preview build already done by cron). Lands directly at screen-experience via `/experience/{slug}`.

---

## 4. screen-init

**When:** Only inbound. Immediately after `/intake` submission. While preview build is running.

**Goal:** Hold the customer for 30–60s while preview build completes. Branded, calm, no AI mention.

### Markup outline

```html
<div class="screen" id="screen-init">
  <div class="init-logo">Website Hub</div>
  <div class="init-rings">
    <div class="ring r1"></div>
    <div class="ring r2"></div>
    <div class="ring r3"></div>
  </div>
  <div class="init-status" id="initStatus">Preparing your space</div>
  <div class="init-sub" id="initSub">Setting up your domain and laying the foundations</div>
</div>
```

### Status messages (rotate every 4s while polling)

```js
const initMessages = [
  { status: 'Preparing your space',           sub: 'Setting up your domain and laying the foundations' },
  { status: 'Drafting your story',            sub: 'Pulling together a starting point for your business' },
  { status: 'Designing your layout',          sub: 'Picking a look that fits' },
  { status: 'Almost ready',                   sub: 'Running a quick quality check' },
];
```

### Endpoint binding

| Element | Endpoint | Action |
|---|---|---|
| (polling loop) | `GET /build-status?token={manage_token}` | Every 2s, check `status` field |

**Response shape:**
```json
{ "status": "building" | "preview_ready" | "failed", "slug": "...", "lastUpdated": "..." }
```

**Transition:**
- `status: 'preview_ready'` → fade to `screen-experience`
- `status: 'failed'` → show retry button + WhatsApp support link
- Timeout after 120s → show "Taking longer than usual" + retry/support

### Fallback

If 3 consecutive polls fail (network error), show: *"Connection lost. Tap to retry."* Don't auto-retry — let customer trigger.

---

## 5. screen-experience

**When:** Always. This is the main screen.

**Goal:** Customer sees a real built website immediately, fills cards to refine it, sees changes update live, picks plan when ready.

### Three layers (back to front)

1. **iframe** — full-bleed, real built site, fully interactive
2. **cards drawer** — bottom sheet, swipeable up/down, contains the 6–8 cards
3. **price ticket strip** — fixed at bottom edge, always visible, tap to expand

### Markup outline

```html
<div class="screen" id="screen-experience">
  <!-- LAYER 1: iframe -->
  <iframe id="siteFrame" src="" allowtransparency="true"></iframe>

  <!-- LAYER 2: cards drawer -->
  <div id="cardsDrawer" class="drawer collapsed">
    <div class="drawer-handle"></div>
    <div class="drawer-header">
      <div class="card-counter" id="cardCounter">Step 2 of 6</div>
      <button class="drawer-toggle" id="drawerToggle">⌄</button>
    </div>
    <div class="drawer-body">
      <div class="card" data-card="industry"> ... </div>
      <div class="card" data-card="area"> ... </div>
      <div class="card" data-card="vibe"> ... </div>
      <div class="card" data-card="services"> ... </div>
      <div class="card" data-card="differentiators"> ... </div>
      <div class="card" data-card="visuals"> ... </div>
    </div>
    <div class="drawer-footer">
      <button class="card-prev" id="cardPrev">Back</button>
      <button class="card-next" id="cardNext">Next</button>
    </div>
  </div>

  <!-- LAYER 3: price tickets -->
  <div id="priceTickets" class="tickets">
    <div class="ticket" data-plan="express">  Express R699 </div>
    <div class="ticket" data-plan="standard"> Standard R999 </div>
    <div class="ticket" data-plan="premium">  Premium R1499 </div>
    <button class="checkout-btn" id="checkoutBtn" disabled>Continue to checkout →</button>
  </div>

  <!-- Patch loading overlay -->
  <div id="patchOverlay" class="patch-overlay"></div>
</div>
```

### iframe behavior

- Initial load: `iframe.src = '/' + slug + '/raw/?page=index'`
- Behind cards, fully scrollable, taps work normally
- After patch/rebuild: soft reload via `iframe.src = iframe.src` (cache-busted with timestamp param)
- `loading="eager"` — we want it fast since the customer is staring at it

### Cards drawer behavior

- **Collapsed state**: shows handle + header strip at bottom (~80px tall)
- **Expanded state**: shows current card filling ~60% of viewport
- Swipe up from handle → expand. Swipe down → collapse. Tap toggle → switch.
- iframe remains interactive when drawer is collapsed.
- Next/Back buttons advance cards. After last card, Next becomes "Build my site" → triggers production rebuild.

### Cards (6 for inbound, 7 for outbound)

| # | data-card | Title | Inputs | Pre-fill source |
|---|---|---|---|---|
| 0 | basics | (outbound only) Confirm your details | business_name, client_name, phone, email | scrape (business+phone), customer enters name+email |
| 1 | industry | What do you do? | industry (tile grid: plumber, electrician, salon, etc.) | inbound: Claude-inferred; outbound: scrape |
| 2 | area | Where do you work? | area, target_audience | outbound: scrape (area); audience always asked |
| 3 | vibe | What's the feel? | vibe (4 options: bold / warm / professional / playful) | none |
| 4 | services | What do you sell? | services (chips), primary_cta | none |
| 5 | differentiators | What sets you apart? | differentiator_1..3, testimonial_seed | none |
| 6 | visuals | Logo and photos | logo, photos[], social_handles | none |

Cards 1–6 are the inbound flow. Card 0 prepends for outbound.

### Endpoint bindings

#### A. Initial load
```
GET /preview-meta?slug={slug}
```
**Response:**
```json
{
  "businessName": "Zululand Flooring",
  "industry": "flooring",
  "area": "KZN North Coast",
  "phone": "+27...",
  "archetype": "results",
  "taglines": ["...", "...", "..."],           // 3 Claude-generated options
  "heroPhotoUrls": ["...", "...", "..."],      // 3 Unsplash matches
  "palette": "ocean",                           // initial pick from preview build
  "font": "modern",
  "package": "standard",
  "brandBrief": { "voice": "...", "differentiator": "..." }
}
```

**On load:**
- Populate cards with pre-fill data
- Render tagline options, photo options
- Pre-select current palette/font ticket

**Fallback:** If 404, show "We couldn't find your space — tap to start over" → redirect to `/start`.

#### B. Card advance (any card 1–6, after change)
```
POST /intake-preview
{
  "slug": "zululand-flooring",
  "token": "...",                              // optional, for auth
  "card": 3,                                   // current card number
  "biz": "Zululand Flooring",
  "industry": "flooring",
  "area": "KZN North Coast",
  "vibe": "warm",
  "services": "tile installation, vinyl, laminate",
  "differentiators": "...",
  "audience": "homeowners + builders"
}
```
**Response:**
```json
{
  "success": true,
  "archetype": "results",
  "preview": {
    "headline": "Floors That Last in KZN",
    "headline_line2": "Built by Zululand pros",
    "tagline": "Real floors. Real warranties.",
    "hero_copy": "Serving the North Coast since 2012...",
    "cta": "WhatsApp for a Quote",
    "vibe_words": ["confident","local","skilled","reliable"],
    "services_preview": ["Tile install","Vinyl planks","Laminate","Underlay","Repairs","Maintenance"]
  }
}
```

**On response:**
- Update `[data-live="headline"]` inside iframe (postMessage to iframe, or query selector if same origin)
- Flash `[data-live="..."]` with brief animation
- **Do NOT reload iframe.** This is cosmetic only.

**Fallback:** Fire-and-forget. If call fails, just don't update — keep what was there. Don't show error to user.

#### C. Palette / Font / Tagline pick
```
POST /patch-preview
{
  "slug": "zululand-flooring",
  "token": "...",
  "patch": {
    "palette": "ember",
    "font": "modern",
    "tagline": "Floors that last."
  }
}
```
**Response:**
```json
{ "success": true, "patchedAt": "2026-05-25T..." }
```

**On response:**
- Show patch overlay (small spinner, 0.5s)
- Reload iframe with cache-bust: `iframe.src = baseUrl + '?t=' + Date.now()`

**Fallback:** Toast: "Couldn't save that change — tap to retry."

#### D. Photo / logo upload
```
POST /upload-assets
Content-Type: multipart/form-data
Fields: slug, token, type=logo|photo|gallery, file
```
**Response:**
```json
{
  "success": true,
  "url": "https://wh-assets.../zululand-flooring/logo.png",
  "type": "logo"
}
```

**On response:**
- Show thumbnail in card 6
- Stage for inclusion in production rebuild (don't trigger rebuild yet)

**Fallback:** Toast with specific reason if HTTP 413 (too big) or 415 (wrong type), generic otherwise.

#### E. Production rebuild (after last card)
```
POST /trigger-rebuild
{
  "slug": "zululand-flooring",
  "token": "...",
  "cards": { ...all card data combined... },
  "assets": { "logo": "...", "photos": ["...","..."] },
  "palette": "ember",
  "font": "modern",
  "tagline": "Floors that last."
}
```
**Response:** `{ "success": true, "rebuildId": "..." }`

**On response:**
- Show drawer-level "Building your final site..." with ring loader
- Poll `GET /build-status?token={token}` every 2s
- When `status === 'preview_ready'`: reload iframe, expand checkout button

**Fallback:** Show retry button.

#### F. Checkout
- "Continue to checkout" button enables when:
  - All required cards complete
  - A plan ticket is selected
  - Production rebuild succeeded
- On click → transition to `screen-confirm`, passing selected plan.

### Price tickets — interaction

```html
<div class="ticket" data-plan="standard" onclick="selectPlan('standard')">
  <div class="plan-name">Standard</div>
  <div class="plan-price">R999<small>/mo</small></div>
</div>
```

Selected: `.ticket.selected` (CSS outline + checkmark).

Tap when already selected → expand a popover with features list (pulled from `PLAN_FEATURES` constant). Tap outside → collapse.

---

## 6. screen-confirm

**When:** After customer clicks "Continue to checkout" from screen-experience.

**Goal:** Final summary, promo code entry, "Pay" button.

### Markup outline

```html
<div class="screen" id="screen-confirm">
  <button class="back-btn" onclick="transitionTo('experience')">← Back to my site</button>
  <h1>You're almost live</h1>

  <div class="summary-card">
    <div class="summary-row"><span>Plan</span><strong id="confirmPlan">Standard</strong></div>
    <div class="summary-row"><span>Build fee</span><strong id="confirmBuildFee">R0</strong></div>
    <div class="summary-row"><span>Domain</span><strong id="confirmDomain">zululand-flooring.co.za</strong></div>
    <div class="summary-row"><span>Email</span><strong id="confirmEmail">1 account</strong></div>
    <div class="summary-row"><span>First month</span><strong id="confirmPrice">R999</strong></div>
  </div>

  <div class="promo-row">
    <input id="promoInput" placeholder="Promo code">
    <button onclick="applyPromo()">Apply</button>
    <div id="promoStatus"></div>
  </div>

  <button class="pay-btn" id="payBtn" onclick="processPayment()">
    <span class="btn-text">Pay R999 — Go Live</span>
  </button>

  <p class="legal">Secure payment via PayFast. R0 setup fee. Cancel anytime.</p>
</div>
```

### Endpoint bindings

#### A. On screen load
- Pull state from `selectedPlan` (set on screen-experience)
- No new fetch needed; data is already in memory

#### B. Apply promo
- Local check only (`LAUNCH50`, etc.)
- If valid → flag `promoApplied`, update price display

#### C. Pay button
```
POST /go-live-link  (launch-worker)
{
  "token": "...",          // manage_token
  "slug": "...",
  "plan": "standard",
  "retainer": 999,          // or 0 if promo applied
  "choices": {              // from screen-experience picks
    "palette": "ember",
    "font": "modern",
    "tagline": "...",
    "logo": "...",
    "photo": "..."
  }
}
```
**Response:**
```json
{ "success": true, "redirectUrl": "https://www.payfast.co.za/eng/process?..." }
```

**On response:**
- `window.location.href = response.redirectUrl`

**Fallback:** Re-enable button, show: "Couldn't reach payments — tap to retry."

---

## 7. screen-processing

**When:** Customer returns from PayFast (URL: `/verify/{token}` or `/manage/{token}` with `?payment=success`).

**Goal:** Wait for webhook to confirm, then transition to dashboard.

### Markup outline

```html
<div class="screen" id="screen-processing">
  <div class="processing-rings">...</div>
  <div class="processing-status" id="processingStatus">Confirming your payment</div>
  <div class="processing-sub" id="processingSub">This usually takes a few seconds</div>
</div>
```

### Endpoint binding

```
GET /client-status?token={token}
```
Poll every 2s for up to 60s.

**Response:**
```json
{ "status": "paid_pending" | "live" | "failed", "domain": "..." }
```

**Transitions:**
- `live` → screen-dashboard
- `failed` → "Payment failed" + retry → back to screen-confirm
- 60s timeout → "Still confirming. We'll send you a WhatsApp when ready." + close button

---

## 8. screen-dashboard

**When:** After go-live. Default screen for `/manage/{token}` once `client.status === 'live'`.

**Goal:** Customer self-service — see site, traffic, edit, manage email, request revisions, refer friends, upgrade.

### Tabs (5)

| Tab | id | Purpose |
|---|---|---|
| Home | tab-home | Stats overview, quick actions, upgrade cards |
| Site | tab-site | Live URL, traffic charts, top pages |
| Email | tab-email | Email accounts, send-photos-by-email instructions |
| Revisions | tab-revisions | Allowance, request revision form, history |
| Account | tab-account | Referral link + stats, plan info, cancel |

### Single data load on dashboard entry

```
GET /manage-panel?token={token}
```
**Response (full):**
```json
{
  "clientId": "uuid",
  "businessName": "Zululand Flooring",
  "slug": "zululand-flooring",
  "domain": "zululand-flooring.co.za",
  "liveUrl": "https://zululand-flooring.co.za",
  "package": "standard",
  "status": "live",
  "retainer": 999,
  "nextInvoiceDate": "2026-06-25",
  "daysUntilInvoice": 31,
  "pages": ["index","services","about","contact"],
  "revisions": { "used": 0, "limit": 2, "paidCost": 199 },
  "email":     { "included": 1, "addonAvailable": true, "addonCost": 200 },
  "gallery":   null,
  "referral":  { "enabled": true, "link": "https://websitehub.co.za?ref=zululand-flooring", "sent": 3, "conversions": 1, "rewardMonths": 1 },
  "analytics": { "enabled": true, "slug": "zululand-flooring" },
  "upgradeOffers": [
    { "to": "premium", "delta": 500 }
  ]
}
```

**Fallback:** If 404 (invalid token), redirect to `/start`. If 5xx, show "Couldn't load dashboard — tap to retry."

### Tab: home (`tab-home`)

| Element | Binds to | Fallback |
|---|---|---|
| `heroPkgBadge` | `package` | Default "Standard" |
| `statGrid` `.visits` | `analytics.enabled ? fetched : '—'` (from `/analytics?slug=`) | "—" if `analytics === null` |
| `statGrid` `.wa-taps` | analytics endpoint | "—" |
| `statGrid` `.referrals` | `referral.conversions` | Lock icon + "Upgrade" if `referral === null` |
| `quickRow` email tile | `email.included > 0` | Lock + "+R300/mo from Standard" |
| `quickRow` revisions tile | `revisions.limit` | `revisions.limit === null ? 'Unlimited' : revisions.limit + ' free/month'` |
| `quickRow` gallery tile | `gallery !== null` | Lock + "Upgrade to Premium" |
| `quickRow` referrals tile | `referral !== null` | Lock + "You're missing income here" |
| `upgradeRow` | `upgradeOffers` array | Hide section if array is empty |

### Tab: site (`tab-site`)

| Element | Binds to | Fallback |
|---|---|---|
| Live URL display | `liveUrl` | — |
| "Open my site" button | opens `liveUrl` in new tab | — |
| Traffic chart | GET `/analytics?slug={slug}&range=7d` (only if `analytics !== null`) | Lock card if disabled |
| Top pages list | same endpoint | same |
| "Edit my site" button | switches to tab-revisions | — |

**Endpoint:**
```
GET /analytics?slug={slug}&range=7d
```
**Response:**
```json
{
  "totals": { "visits": 247, "uniqueVisitors": 198, "waTaps": 38, "avgSession": 95 },
  "byDay": [
    { "date": "2026-05-19", "visits": 31, "waTaps": 5 },
    ...
  ],
  "topPages": [
    { "path": "/", "visits": 142 },
    { "path": "/services", "visits": 67 }
  ]
}
```

### Tab: email (`tab-email`)

| Element | Binds to | Fallback |
|---|---|---|
| Primary inbox card | `email.included > 0 ? show address : show upsell` | Upsell to Standard |
| Secondary inbox card | `email.included === 2 ? show : show addon-or-upgrade` | Hidden for Express |
| Send-photos info card | static "send photos to updates@websitehub.co.za" | always shown |

### Tab: revisions (`tab-revisions`)

| Element | Binds to | Fallback |
|---|---|---|
| Allowance counter | `revisions.used` / `revisions.limit` | "Unlimited" if `limit === null` |
| Request revision form | POST `/submit-revision` (patch-worker) | — |
| Recent revisions list | GET `/revisions?token={token}` (TBD — new endpoint) | "No revisions yet" |

**Submit revision endpoint:**
```
POST /submit-revision  (patch-worker)
{
  "token": "...",
  "message": "Change the hero headline to ...",
  "type": "free" | "paid"
}
```
Returns `{ success: true, revisionId, status: 'queued' }`. If allowance exhausted → returns `{ success: false, paymentRequired: true, redirectUrl: "..." }`.

### Tab: account (`tab-account`)

| Element | Binds to | Fallback |
|---|---|---|
| Referral block | `referral` (entire object) | Hide if null, show upsell card |
| Referral link copy | `referral.link` | — |
| Sent / Conversions / Reward months | `referral.sent`, `.conversions`, `.rewardMonths` | 0 / 0 / 0 |
| Current plan card | `package`, `retainer`, `nextInvoiceDate` | — |
| Upgrade button | `upgradeOffers[0]` | Hide if empty |
| Cancel button | POST `/cancel-site` (reactivate-worker) | Triggers cancellation confirmation flow |

---

## 9. Endpoint Reference (single page)

### Existing — already deployed

| Method | URL | Worker | Purpose |
|---|---|---|---|
| POST | `/intake` | build | Create client + queue preview build |
| POST | `/intake-preview` | build | Cosmetic Claude call (600 tok) |
| GET | `/preview-meta?slug=` | build | Load brand brief + assets for screen-experience |
| GET | `/build-status?token=` | build | Poll build state |
| GET | `/analytics?slug=&range=` | build | Tier-gated analytics |
| GET | `/manage-panel?token=` | patch | Full dashboard payload |
| POST | `/patch-preview` | patch | Surgical palette/font/tagline updates |
| POST | `/upload-assets` | patch | Logo/photo upload |
| POST | `/submit-revision` | patch | Revision request |
| POST | `/go-live-link` | launch | PayFast redirect URL generator |
| POST | `/cancel-site` | reactivate | Cancel flow |
| GET | `/client-status?token=` | build | Lightweight status check (TBD if exists or needs adding) |

### New endpoints needed

| Method | URL | Worker | Purpose | Priority |
|---|---|---|---|---|
| POST | `/trigger-rebuild` | build | Production build after cards complete | **High** |
| GET | `/revisions?token=` | patch | List recent revisions for dashboard tab | Medium |
| GET | `/og-image?slug=` | build | Generated OG card image for WhatsApp opt-in | Medium |

### Backend tickets (separate work, not part of this map)

1. **Outbound flow flip** — `build-worker` cron must build preview BEFORE sending WhatsApp opt-in (currently reversed). Send OG card link.
2. **`/trigger-rebuild` endpoint** — accepts existing slug, runs full 3-pass build, overwrites preview KV.
3. **OG image generation** — Cloudflare Browser Rendering API or static OG template populated from brand brief.
4. **`/client-status` endpoint** — if not present, add a lightweight version that returns `{status, domain}` only (don't re-use heavy `/manage-panel`).

---

## 10. Data shapes — payloads we send

### Final intake payload (from start-v2 to `/intake`)

```json
{
  "business_name": "Zululand Flooring",
  "client_name": "Pierre",
  "phone": "+27...",
  "email": "pierre@...",
  "package": "standard",
  "cf-turnstile-response": "..."
}
```

### Card data accumulated in PWA state

```json
{
  "industry": "flooring",
  "area": "KZN North Coast",
  "target_audience": "homeowners + small builders",
  "vibe": "warm",
  "services": ["tile install","vinyl","laminate"],
  "primary_cta": "Get a Free Quote",
  "differentiator_1": "15 years on the coast",
  "differentiator_2": "Free site visits",
  "differentiator_3": "Manufacturer-backed warranties",
  "testimonial_seed": "Quote-worthy line from a real customer",
  "logo": "https://wh-assets.../logo.png",
  "photos": ["https://wh-assets.../1.jpg","..."],
  "social_handles": { "instagram": "@zululandflooring", "facebook": "" }
}
```

### Rebuild trigger payload

```json
{
  "slug": "zululand-flooring",
  "token": "...",
  "cards": { ...the object above... },
  "tweaks": {
    "palette": "ember",
    "font": "modern",
    "tagline": "Floors that last."
  }
}
```

---

## 11. Brand language rules

Search the PWA HTML for these strings and replace if found:

| Banned | Use instead |
|---|---|
| "AI is..." | "Website Hub is..." |
| "Our AI" | "Our system" |
| "Generated by AI" | "Crafted for you" |
| "Powered by Claude" | "Built by Website Hub" |
| "GPT" / "Claude" / "ML" | (delete or replace) |

This is brand positioning, not technical accuracy. Customers don't need to know what's under the hood.

---

## 12. Build & deploy

### Bootstrapping the PWA to KV

```bash
# Use Node.js (NOT curl -d @file — schematic Layer 14 Prime Rule)
node -e "
  const https=require('https'),fs=require('fs');
  const data=fs.readFileSync('./pwa.html');
  console.log('Sending:',data.length,'bytes');
  const req=https.request({
    hostname:'preview.websitehub.co.za',
    path:'/bootstrap-pwa',
    method:'POST',
    headers:{
      'Content-Type':'text/html',
      'x-admin-key':'ADMIN_KEY_CLAUDEROX',
      'Content-Length':data.length
    }
  },res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>console.log(b));});
  req.write(data);req.end();
"

# Verify (mandatory)
curl -s "https://preview.websitehub.co.za/manage/TEST" | tail -c 30
# Must end with: ...</script></body></html>
```

### Routes to add in build-worker/src/index.js

```js
if (path === '/bootstrap-pwa')         return handleBootstrapPwa(request, env);
// Update servePreview() to serve 'app:pwa' for /manage/, /experience/, /build/, /verify/
```

### Routes to add in build-worker for new endpoints

```js
if (path === '/trigger-rebuild')       return handleTriggerRebuild(request, env);
if (path === '/client-status')         return handleClientStatus(request, url, env);
if (path === '/og-image')              return handleOgImage(request, url, env);
```

---

## 13. Implementation order

Recommended build order — each stage is shippable:

1. **Skeleton PWA** with all 5 screens, no real data, manual transitions (1 evening)
2. **Wire screen-init** to `/build-status` polling (1 hour)
3. **Wire screen-experience iframe** to `/preview-meta` initial load (1 hour)
4. **Cards drawer UX** — swipe, expand, collapse, advance (2-3 hours)
5. **Card-advance `/intake-preview` calls** + `[data-live]` updates (1 hour)
6. **Palette/font/tagline `/patch-preview` wiring** (1 hour)
7. **Asset upload to `/upload-assets`** (1 hour)
8. **Production rebuild trigger** + post-build iframe reload (1 hour, after backend `/trigger-rebuild` lands)
9. **Wire screen-confirm `/go-live-link`** (30 min)
10. **Wire screen-processing `/client-status` polling** (30 min)
11. **Wire screen-dashboard `/manage-panel`** + 5 tabs (3-4 hours)
12. **Brand-language sweep** (15 min)
13. **Bootstrap to KV, wire routes, smoke test** (1 hour)

Total: roughly 15-20 hours of focused work, shippable in 3-4 sessions.

---

## 14. Out of scope for this map

- `start-v2.html` — already deployed, no change
- `admin-dashboard-v8.html` — separate file, needs `/admin` route + bootstrap (but not part of customer flow)
- Outbound cron rewrite (PR C) — separate ticket
- OG card generation — separate ticket
- Zoho email reseller provisioning — blocked on approval

---

**Last updated:** 2026-05-25. Drop questions or amendments in the repo issue tracker. When implementing, link the commit to the relevant section number above.
