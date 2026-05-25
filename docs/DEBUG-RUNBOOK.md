# Website Hub — Debug Runbook
_Quick reference for diagnosing issues from Termux. All commands run from `~/Website-hub`._

---

## 1. Check deploy status

```bash
# Last deploy result
gh run list --limit 1

# Watch a deploy in progress
gh run watch

# See why a specific deploy failed
gh run view --log-failed | tail -80

# All recent deploys
gh run list --limit 10
```

---

## 2. Test any Worker endpoint

### GET endpoint
```bash
curl -s "https://preview.websitehub.co.za/ENDPOINT?param=value"
```

### POST endpoint (JSON)
```bash
curl -s -X POST "https://preview.websitehub.co.za/ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{"key":"value"}'
```

### POST with admin key
```bash
curl -s -X POST "https://preview.websitehub.co.za/ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  -d '{"key":"value"}'
```

### See HTTP status code
```bash
curl -s -w "\nHTTP %{http_code}\n" "https://preview.websitehub.co.za/ENDPOINT"
```

### Verbose (headers + body)
```bash
curl -sv "https://preview.websitehub.co.za/ENDPOINT" 2>&1 | head -50
```

---

## 3. Common endpoint tests

### System health
```bash
curl -s "https://preview.websitehub.co.za/health"
```

### Domain check
```bash
curl -s "https://preview.websitehub.co.za/domain-check?name=mybusiness"
```

### Intake (full inbound lead)
```bash
curl -s -X POST "https://preview.websitehub.co.za/intake" \
  -H "Content-Type: application/json" \
  -d '{
    "business_name": "Test Co",
    "client_name": "Pierre",
    "phone": "+27721234567",
    "email": "test@test.com",
    "industry": "plumber",
    "domain_requested": "test-co-debug.co.za",
    "slug_requested": "test-co-debug",
    "package": "standard",
    "retainer": 0,
    "source": "website"
  }'
```

### Build status (replace TOKEN)
```bash
curl -s "https://preview.websitehub.co.za/build-status?token=TOKEN"
```

### Manage panel (replace TOKEN)
```bash
curl -s "https://preview.websitehub.co.za/manage-panel?token=TOKEN" | python3 -m json.tool
```

### Analytics
```bash
curl -s "https://preview.websitehub.co.za/analytics?slug=SLUG&range=7d"
```

---

## 4. Cloudflare error codes

| Code | Meaning | Fix |
|---|---|---|
| **1101** | Worker threw unhandled JS exception | Add try/catch — see §5 below |
| **1102** | Worker exceeded CPU time limit | Optimise or split the route |
| **1003** | Invalid host | Check custom domain/route config |
| **522** | Connection timed out | Worker hung — check async/await |
| **404** | Route not found (from worker) | Check route handler in index.js |

---

## 5. Expose actual errors from a Worker (debug wrapper)

When a route returns 1101, temporarily wrap it to get the real error:

```js
// Before (opaque)
if (path === '/intake') return handleIntake(request, env, ctx);

// After (debug)
if (path === '/intake') {
  try {
    return await handleIntake(request, env, ctx);
  } catch(e) {
    return Response.json({ error: e.message, where: e.stack?.split('\n')[1] }, { status: 500 });
  }
}
```

Deploy, test with curl, read the `error` and `where` fields. Remove the wrapper once fixed.

---

## 6. Bootstrap HTML to KV

**Always use Node.js — never `curl -d @file` (truncates on Termux).**

```bash
# Generic bootstrap command
node -e "
const https=require('https'),fs=require('fs');
const data=fs.readFileSync('FILENAME.html');
const req=https.request({
  hostname:'preview.websitehub.co.za',
  path:'/bootstrap-ENDPOINT',
  method:'POST',
  headers:{
    'Content-Type':'text/html',
    'x-admin-key':'ADMIN_KEY_CLAUDEROX',
    'Content-Length':data.length
  }
},res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>console.log(b));});
req.write(data);req.end();
"
```

### Bootstrap endpoints

| File | Endpoint | KV key |
|---|---|---|
| `start-v2.html` | `/bootstrap-start` | `app:start-v2` |
| `websitehub-pwa.html` | `/bootstrap-pwa` | `app:pwa` |
| `intake-experience.html` | `/bootstrap-intake` | `app:intake-experience` |
| `admin-dashboard-v8.html` | `/bootstrap-admin` | `app:admin` (TBD) |

### Verify bootstrap worked
```bash
# Check file size is right
curl -s -X POST "https://preview.websitehub.co.za/bootstrap-ENDPOINT" \
  -H "x-admin-key: ADMIN_KEY_CLAUDEROX" \
  --data-binary @FILENAME.html \
  -H "Content-Type: text/html"
# Should return: {"ok":true,"key":"app:...","size":NNNN}
```

---

## 7. Check KV contents

```bash
cd build-worker

# List all keys
npx wrangler kv key list --binding=SITES --remote

# Get a specific key
npx wrangler kv key get --binding=SITES --remote "app:pwa"
npx wrangler kv key get --binding=SITES --remote "app:start-v2"

# Check a built site page
npx wrangler kv key get --binding=SITES --remote "preview:SLUG:index"

# Check config flags
npx wrangler kv key get --binding=SITES --remote "config:outbound"
npx wrangler kv key get --binding=SITES --remote "flag:OUTBOUND_ENABLED"
```

---

## 8. Query D1 directly

```bash
cd build-worker

# List all clients
npx wrangler d1 execute website-hub-db --remote \
  --command "SELECT id, business_name, slug, status, created_at FROM clients ORDER BY created_at DESC LIMIT 10;"

# Find a specific client
npx wrangler d1 execute website-hub-db --remote \
  --command "SELECT * FROM clients WHERE slug='SLUG';"

# Check recent events
npx wrangler d1 execute website-hub-db --remote \
  --command "SELECT worker, event_type, status, created_at FROM events ORDER BY created_at DESC LIMIT 20;"

# Check build queue backlog
npx wrangler d1 execute website-hub-db --remote \
  --command "SELECT slug, status, updated_at FROM clients WHERE status IN ('queued','building') ORDER BY updated_at DESC;"

# Export full schema
npx wrangler d1 export website-hub-db --remote --no-data --output=schema-snapshot.sql
```

---

## 9. Secrets — check what's set

```bash
# Names only (values are write-only)
cd build-worker && npx wrangler secret list
cd launch-worker && npx wrangler secret list
```

---

## 10. JS syntax check before pushing

Always validate as ES module (`.mjs` extension matters):

```bash
cp build-worker/src/index.js ~/check.mjs && node --check ~/check.mjs && echo OK
rm ~/check.mjs
```

---

## 11. Run the full sync report

Compares local repo, KV, D1, and GitHub Actions status in one pass:

```bash
bash sync-from-cloudflare.sh
# Report lands in ./cf-sync-report/
```

---

## 12. Shared-services divergence check

All 5 workers have their own copy of `shared-services.js`. Check if they've drifted:

```bash
md5sum */src/shared-services.js
# All 5 hashes should match. If build-worker differs, it has the newest version.
# To sync: cp build-worker/src/shared-services.js patch-worker/src/
#           cp build-worker/src/shared-services.js launch-worker/src/
#           cp build-worker/src/shared-services.js pulse-worker/src/
#           cp build-worker/src/shared-services.js reactivate-worker/src/
```

---

## 13. Common fixes

### Domain check returns wrong result / error
```bash
curl -s "https://preview.websitehub.co.za/domain-check?name=test"
# If error: check /check-domain vs /domain-check routing in build-worker/src/index.js
```

### Deploy fails with "already declared" / "unexpected end of file"
```bash
cp build-worker/src/index.js ~/check.mjs && node --check ~/check.mjs
# Fix the syntax error, then push
```

### Build not triggering after intake
```bash
# Check queue has messages
npx wrangler queues consumer list wh-build-queue
# Check client status
npx wrangler d1 execute website-hub-db --remote \
  --command "SELECT slug, status FROM clients ORDER BY created_at DESC LIMIT 5;"
```

### KV HTML not updating after bootstrap
```bash
# Hard refresh on phone: hold reload button → "Hard Reload"
# Or test with curl to bypass browser cache:
curl -s "https://preview.websitehub.co.za/start" | tail -5
```

---

_Last updated: 2026-05-25_
