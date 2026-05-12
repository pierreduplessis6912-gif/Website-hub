# Website Hub — Deployment Guide
## 3-Worker Partial Deploy (Build + Patch + Launch)
### pulse-worker and reactivate-worker → Saturday

---

## FOLDER STRUCTURE

After setup, your folder should look like this:

```
website-hub/
├── deploy.sh
├── README.md
├── build-worker/
│   ├── wrangler.toml
│   └── src/
│       ├── index.js          ← paste build-worker.js content here
│       └── shared-services.js ← paste shared-services.js content here
├── patch-worker/
│   ├── wrangler.toml
│   └── src/
│       ├── index.js          ← paste patch-worker.js content here
│       └── shared-services.js ← same shared-services.js copy
└── launch-worker/
    ├── wrangler.toml
    └── src/
        ├── index.js          ← paste launch-worker.js content here
        └── shared-services.js ← same shared-services.js copy
```

---

## STEP 1 — Create the src folders

```bash
mkdir -p build-worker/src
mkdir -p patch-worker/src
mkdir -p launch-worker/src
```

Then copy your files:
- `build-worker.js`  → `build-worker/src/index.js`
- `patch-worker.js`  → `patch-worker/src/index.js`
- `launch-worker.js` → `launch-worker/src/index.js`
- `shared-services.js` → copy into ALL THREE `src/` folders

---

## STEP 2 — Fill in wrangler.toml placeholders

In each `wrangler.toml`, replace:

| Placeholder         | Where to find it |
|---------------------|------------------|
| `<KV_NAMESPACE_ID>` | Cloudflare dashboard → Workers & Pages → KV → your namespace → copy the ID |
| `<R2_BUCKET_NAME>`  | Cloudflare dashboard → R2 → your bucket name (e.g. `wh-assets`) |

All three workers share the SAME KV namespace ID.
Only `build-worker` and `patch-worker` need R2 — `launch-worker` has no R2 binding.

---

## STEP 3 — Create the queue (if it doesn't exist yet)

```bash
npx wrangler queues create wh-build-queue
```

If it already exists, skip this.

---

## STEP 4 — Authenticate wrangler

```bash
npx wrangler login
```

This opens a browser window — log in with your Cloudflare account.

---

## STEP 5 — Set secrets

Run these once. Replace the values with your real credentials.

### wh-build secrets
```bash
npx wrangler secret put ANTHROPIC_KEY         --name wh-build
npx wrangler secret put AIRTABLE_TOKEN        --name wh-build
npx wrangler secret put AIRTABLE_BASE_ID      --name wh-build
npx wrangler secret put AIRTABLE_TABLE_ID     --name wh-build
npx wrangler secret put META_WA_TOKEN         --name wh-build
npx wrangler secret put META_PHONE_NUMBER_ID  --name wh-build
npx wrangler secret put WH_PHONE              --name wh-build
npx wrangler secret put ADMIN_KEY             --name wh-build
npx wrangler secret put UNSPLASH_ACCESS_KEY   --name wh-build
npx wrangler secret put GOOGLE_PLACES_API_KEY --name wh-build
npx wrangler secret put REGISTERDOMAIN_API_KEY --name wh-build
npx wrangler secret put PAYFAST_MERCHANT_ID   --name wh-build
npx wrangler secret put PAYFAST_SANDBOX_MERCHANT_ID --name wh-build
```

### wh-patch secrets
```bash
npx wrangler secret put ANTHROPIC_KEY         --name wh-patch
npx wrangler secret put AIRTABLE_TOKEN        --name wh-patch
npx wrangler secret put AIRTABLE_BASE_ID      --name wh-patch
npx wrangler secret put AIRTABLE_TABLE_ID     --name wh-patch
npx wrangler secret put META_WA_TOKEN         --name wh-patch
npx wrangler secret put META_PHONE_NUMBER_ID  --name wh-patch
npx wrangler secret put WH_PHONE              --name wh-patch
npx wrangler secret put ADMIN_KEY             --name wh-patch
npx wrangler secret put PAYFAST_MERCHANT_ID   --name wh-patch
npx wrangler secret put PAYFAST_SANDBOX_MERCHANT_ID --name wh-patch
```

### wh-launch secrets
```bash
npx wrangler secret put PAYFAST_MERCHANT_ID          --name wh-launch
npx wrangler secret put PAYFAST_MERCHANT_KEY         --name wh-launch
npx wrangler secret put PAYFAST_SANDBOX_MERCHANT_ID  --name wh-launch
npx wrangler secret put PAYFAST_SANDBOX_MERCHANT_KEY --name wh-launch
npx wrangler secret put CF_ACCOUNT_ID                --name wh-launch
npx wrangler secret put CF_API_TOKEN                 --name wh-launch
npx wrangler secret put CF_ZONE_ID                   --name wh-launch
npx wrangler secret put AIRTABLE_TOKEN               --name wh-launch
npx wrangler secret put AIRTABLE_BASE_ID             --name wh-launch
npx wrangler secret put AIRTABLE_TABLE_ID            --name wh-launch
npx wrangler secret put META_WA_TOKEN                --name wh-launch
npx wrangler secret put META_PHONE_NUMBER_ID         --name wh-launch
npx wrangler secret put WH_PHONE                     --name wh-launch
npx wrangler secret put ADMIN_KEY                    --name wh-launch
npx wrangler secret put ANTHROPIC_KEY                --name wh-launch
npx wrangler secret put ZOHO_CLIENT_ID               --name wh-launch
npx wrangler secret put ZOHO_CLIENT_SECRET           --name wh-launch
npx wrangler secret put ZOHO_REFRESH_TOKEN           --name wh-launch
npx wrangler secret put ZOHO_ORG_ID                  --name wh-launch
npx wrangler secret put REGISTERDOMAIN_API_KEY       --name wh-launch
```

(Zoho mail + Google OAuth secrets can wait until you're ready to test those features)

---

## STEP 6 — Deploy

```bash
bash deploy.sh all
```

Or deploy one at a time:
```bash
bash deploy.sh patch
bash deploy.sh launch
bash deploy.sh build
```

---

## STEP 7 — Bootstrap the SPA

After build-worker is deployed, push `preview-manage.html` into KV:

```bash
curl -X POST https://wh-build.pierreduplessis6912.workers.dev/bootstrap-preview-app \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -H "Content-Type: text/html" \
  --data-binary @preview-manage.html
```

---

## STEP 8 — Delete the stale Claude model cache

In Cloudflare dashboard → Workers & Pages → KV → your namespace → find and delete key:
```
system:claude_model
```

---

## STEP 9 — Run the grep checks (from battle plan)

```bash
grep -n "WH_CSS_INJECT" build-worker/src/index.js
grep -n "buildRenderSystemPrompt" build-worker/src/index.js   # must return 0
grep -n "TEST_MODE" build-worker/src/index.js
grep -n "5000" build-worker/src/index.js

grep -n "isDeposit" launch-worker/src/index.js                # must return 0
grep -n "tier.retainer" launch-worker/src/index.js
grep -n "panel.*choices\|choices.*palette" launch-worker/src/index.js

grep -n "WORKER2.*patch-preview\|patch-preview.*WORKER2" preview-manage.html
grep -n "699\|999\|1499" preview-manage.html
```

---

## WORKER URLs (for reference)

| Worker       | URL |
|--------------|-----|
| wh-build     | https://wh-build.pierreduplessis6912.workers.dev |
| wh-patch     | https://wh-patch.pierreduplessis6912.workers.dev |
| wh-launch    | https://wh-launch.pierreduplessis6912.workers.dev |

---

## TEST SEQUENCE (battle plan steps 8–16)

1. Submit a test lead via Formspree webhook → verify build fires
2. Check KV for `preview:{slug}:index`
3. Open `https://preview.websitehub.co.za/{slug}` — verify site renders
4. Open manage SPA — verify it loads with correct tier
5. PayFast sandbox → go-live flow → verify `live:{hostname}:{page}` KV keys written
6. Verify panel choices applied to live site
7. Verify Zoho invoice logged to KV (test mode): look for `test_log:zoho:invoice:*`
8. Verify domain registration logged to KV: look for `test_log:domain:*`

---

*Last updated: May 11 2026*
