import os, sys

BASE = os.path.expanduser('~/Website-hub')
INDEX_PATH = f'{BASE}/pulse-worker/src/index.js'
TOML_PATH  = f'{BASE}/pulse-worker/wrangler.toml'

# ============================================================
# PATCH 1 — wrangler.toml
# Add ANTHROPIC_KEY to [vars] and update cron
# ============================================================

toml = open(TOML_PATH).read()

# 1a. Add ANTHROPIC_KEY after RESEND_API_KEY line
OLD_TOML_VARS = 'RESEND_API_KEY = ""'
NEW_TOML_VARS = 'RESEND_API_KEY = ""\nANTHROPIC_KEY = ""'

if 'ANTHROPIC_KEY' in toml:
    print('TOML: ANTHROPIC_KEY already present — skipping vars patch')
elif OLD_TOML_VARS in toml:
    toml = toml.replace(OLD_TOML_VARS, NEW_TOML_VARS, 1)
    print('TOML: ANTHROPIC_KEY added')
else:
    print('TOML ERROR: could not find RESEND_API_KEY line — NOT FOUND, safe to retry')
    sys.exit(1)

# 1b. Replace daily cron trigger
OLD_CRON = '"0 6 * * *"'
NEW_CRON = '"*/5 * * * *"'

if NEW_CRON in toml:
    print('TOML: cron already */5 — skipping cron patch')
elif OLD_CRON in toml:
    toml = toml.replace(OLD_CRON, NEW_CRON, 1)
    print('TOML: cron updated to */5 * * * *')
else:
    print('TOML ERROR: could not find "0 6 * * *" — NOT FOUND, safe to retry')
    sys.exit(1)

open(TOML_PATH, 'w').write(toml)
print('TOML: written OK\n')

# ============================================================
# PATCH 2 — index.js
# Add autonomy layer functions + wire into runDailyCron
# ============================================================

js = open(INDEX_PATH).read()

# 2a. Wire runAutonomySweep into runDailyCron
# Insert right after the opening logEvent call in runDailyCron
OLD_WIRE = "  await logEvent(env, 'pulse', 'cron_run', 'success', { metadata: { date: today, phase: 'started' } });"
NEW_WIRE = """  await logEvent(env, 'pulse', 'cron_run', 'success', { metadata: { date: today, phase: 'started' } });

  // ── Autonomy layer: sweep first, repair if needed ──
  try {
    const failures = await runAutonomySweep(env);
    if (failures.length > 0) {
      await Promise.all(failures.map(f => decideRepair(env, f)));
    }
  } catch (err) {
    console.warn('Autonomy sweep error (non-fatal):', err?.message || err);
    await logEvent(env, 'pulse', 'autonomy_sweep_error', 'failure', {
      metadata: { error: err.message },
    });
  }"""

if 'runAutonomySweep' in js:
    print('INDEX: autonomy wire already present — skipping wire patch')
elif OLD_WIRE in js:
    js = js.replace(OLD_WIRE, NEW_WIRE, 1)
    print('INDEX: autonomy sweep wired into runDailyCron')
else:
    print('INDEX ERROR: could not find cron_run logEvent line — NOT FOUND, safe to retry')
    sys.exit(1)

# 2b. Fix scheduled handler to route */5 correctly
# The current handler checks cronExpr.includes('/15') for queue drain
# */5 must NOT fall into that branch — it should hit runDailyCron
# Current logic: if includes('/15') OR (hour >= 9 && hour < 12) → drain queue
# We tighten: only drain if cronExpr is exactly the queue drain pattern
OLD_SCHEDULED = "    if (cronExpr.includes('/15') || (hour >= 9 && hour < 12)) {"
NEW_SCHEDULED = "    if (cronExpr.includes('/15')) {"

if NEW_SCHEDULED in js:
    print('INDEX: scheduled handler already tightened — skipping')
elif OLD_SCHEDULED in js:
    js = js.replace(OLD_SCHEDULED, NEW_SCHEDULED, 1)
    print('INDEX: scheduled handler tightened — */5 routes to runDailyCron correctly')
else:
    print('INDEX ERROR: could not find scheduled handler condition — NOT FOUND, safe to retry')
    sys.exit(1)

# 2c. Append autonomy layer functions before final comment
AUTONOMY_BLOCK = """
// ============================================================
// AUTONOMY LAYER — sweep, repair, budget, snapshot
// ============================================================

// Worker health endpoints to probe on every sweep
const SWEEP_TARGETS = [
  { name: 'build-worker',      url: 'https://preview.websitehub.co.za/health' },
  { name: 'pulse-worker',      url: 'https://wh-pulse.pierreduplessis6912.workers.dev/health' },
  { name: 'launch-worker',     url: 'https://wh-launch.pierreduplessis6912.workers.dev/health' },
  { name: 'patch-worker',      url: 'https://wh-patch.pierreduplessis6912.workers.dev/health' },
  { name: 'reactivate-worker', url: 'https://wh-reactivate.pierreduplessis6912.workers.dev/health' },
];

// Critical KV keys that must exist and have minimum byte sizes
const KV_INTEGRITY_CHECKS = [
  { key: 'app:intake-experience', minBytes: 60000 },
  { key: 'app:preview-manage',    minBytes: 60000 },
  { key: 'autonomy:enabled',      minBytes: 1     },
];

async function runAutonomySweep(env) {
  const failures = [];
  const now = new Date().toISOString();

  // ── 1. Worker health probes ──
  await Promise.all(SWEEP_TARGETS.map(async target => {
    try {
      const res = await fetch(target.url, {
        method: 'GET',
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        failures.push({
          signature: `health:${target.name}:http-${res.status}`,
          worker:    target.name,
          type:      'health_check_failed',
          context:   { url: target.url, status: res.status, body: body.slice(0, 200) },
          timestamp: now,
        });
        await logEvent(env, 'pulse', 'sweep_health_fail', 'failure', {
          metadata: { target: target.name, status: res.status },
        });
        return;
      }
      const data = await res.json().catch(() => null);
      if (data?.d1 && data.d1 !== 'ok') {
        failures.push({
          signature: `health:${target.name}:d1-${data.d1}`,
          worker:    target.name,
          type:      'd1_health_degraded',
          context:   { url: target.url, d1: data.d1 },
          timestamp: now,
        });
      }
    } catch (err) {
      failures.push({
        signature: `health:${target.name}:unreachable`,
        worker:    target.name,
        type:      'worker_unreachable',
        context:   { url: target.url, error: err.message },
        timestamp: now,
      });
      await logEvent(env, 'pulse', 'sweep_unreachable', 'failure', {
        metadata: { target: target.name, error: err.message },
      });
    }
  }));

  // ── 2. KV integrity checks ──
  await Promise.all(KV_INTEGRITY_CHECKS.map(async check => {
    try {
      const val = await env.SITES.get(check.key, { type: 'text' });
      if (!val) {
        failures.push({
          signature: `kv:missing:${check.key.replace(/:/g, '-')}`,
          worker:    'kv',
          type:      'kv_key_missing',
          context:   { key: check.key },
          timestamp: now,
        });
      } else if (val.length < check.minBytes) {
        failures.push({
          signature: `kv:undersized:${check.key.replace(/:/g, '-')}`,
          worker:    'kv',
          type:      'kv_key_undersized',
          context:   { key: check.key, actualBytes: val.length, minBytes: check.minBytes },
          timestamp: now,
        });
      }
    } catch (err) {
      console.warn(`KV integrity check failed for ${check.key}:`, err?.message);
    }
  }));

  // ── 3. D1 coherence — stuck builds ──
  try {
    const stuckResult = await env.DB.prepare(
      `SELECT id, slug, business_name, updated_at FROM clients
       WHERE status = 'building'
       AND datetime(updated_at) < datetime('now', '-30 minutes')
       LIMIT 10`
    ).all().catch(() => ({ results: [] }));

    for (const client of stuckResult?.results || []) {
      failures.push({
        signature: `build:stuck:${client.id}`,
        worker:    'build-worker',
        type:      'build_stuck',
        context:   { clientId: client.id, slug: client.slug, business: client.business_name, updatedAt: client.updated_at },
        timestamp: now,
      });
    }
  } catch (err) {
    console.warn('D1 coherence check failed:', err?.message);
  }

  // ── 4. Log sweep summary ──
  await logEvent(env, 'pulse', 'autonomy_sweep_complete', 'success', {
    metadata: { failures: failures.length, timestamp: now },
  });

  return failures;
}

// ============================================================

async function decideRepair(env, failure) {
  // ── 0. Check kill switch ──
  const enabled = await env.SITES.get('autonomy:enabled').catch(() => 'true');
  if (enabled === 'false') {
    console.log('Autonomy disabled via KV — skipping repair for:', failure.signature);
    return;
  }

  // ── 1. Check daily budget ──
  const todayKey   = `autonomy:budget:${new Date().toISOString().slice(0, 10)}`;
  const budgetRaw  = await env.SITES.get(todayKey).catch(() => null);
  const budget     = budgetRaw ? JSON.parse(budgetRaw) : { limit: 50, spent: 0 };

  if (budget.spent >= budget.limit) {
    await logEvent(env, 'pulse', 'autonomy_budget_exceeded', 'warning', {
      metadata: { signature: failure.signature, spent: budget.spent, limit: budget.limit },
    });
    await sendWhatsApp(env.WH_PHONE,
      `⚠️ Autonomy daily budget hit (${budget.spent}/${budget.limit} calls). Unresolved: ${failure.signature}`,
      env, { skipTestRedirect: true }
    ).catch(() => {});
    return;
  }

  // ── 2. Check incident attempt limit ──
  const attemptKey = `autonomy:incident:${failure.signature}:attempts`;
  const attempts   = parseInt(await env.SITES.get(attemptKey).catch(() => '0') || '0');

  if (attempts >= 3) {
    await logEvent(env, 'pulse', 'autonomy_max_attempts', 'warning', {
      metadata: { signature: failure.signature, attempts },
    });
    await sendWhatsApp(env.WH_PHONE,
      `🔁 3 repair attempts failed for: ${failure.signature}\\nNeeds manual review.`,
      env, { skipTestRedirect: true }
    ).catch(() => {});
    return;
  }

  // ── 3. Snapshot state before acting ──
  const snapshotKey = `autonomy:snapshot:${Date.now()}`;
  await env.SITES.put(snapshotKey, JSON.stringify({
    failure,
    timestamp:   new Date().toISOString(),
    attempts_before: attempts,
  }), { expirationTtl: 60 * 60 * 24 * 7 }).catch(() => {});

  // ── 4. Get whitelist ──
  const whitelistRaw = await env.SITES.get('autonomy:actions:allowed').catch(() => null);
  const whitelist    = whitelistRaw
    ? whitelistRaw.split('\\n').map(s => s.trim()).filter(Boolean)
    : ['notify_pierre_whatsapp'];

  // ── 5. Pull prior reasoning from R2 (last 5 files for this error type) ──
  let priorReasoning = [];
  try {
    const prefix  = `reasoning/${failure.worker}/${failure.type}/`;
    const listed  = await env.ASSETS.list({ prefix, limit: 10 }).catch(() => ({ objects: [] }));
    const keys    = (listed.objects || []).map(o => o.key).slice(-5);
    const fetched = await Promise.all(keys.map(k =>
      env.ASSETS.get(k).then(o => o?.text()).catch(() => null)
    ));
    priorReasoning = fetched.filter(Boolean).map(r => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.warn('R2 prior reasoning fetch failed (non-fatal):', err?.message);
  }

  // ── 6. Call Claude ──
  let decision = null;
  try {
    const prompt = `You are the autonomous repair agent for Website Hub, a Cloudflare Workers platform serving small business websites in South Africa.

A health sweep has detected a failure. Your job is to reason about it, propose one action from the whitelist, and explain your confidence.

FAILURE:
${JSON.stringify(failure, null, 2)}

PRIOR REASONING FOR THIS ERROR TYPE (${priorReasoning.length} files):
${priorReasoning.length > 0 ? JSON.stringify(priorReasoning, null, 2) : 'None — this is a new failure type.'}

ALLOWED ACTIONS (whitelist):
${whitelist.join('\\n')}

Respond ONLY with a JSON object. No preamble. No markdown. Example:
{
  "hypothesis": "why this failure is happening",
  "action": "one_action_from_whitelist",
  "reasoning": "why this action addresses the hypothesis",
  "confidence": "high|medium|low|escalate",
  "validation_criterion": "how to know if the fix worked on next sweep",
  "escalate_reason": "only if confidence=escalate, why"
}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages:   [{ role: 'user', content: prompt }],
      }),
    });

    const apiData = await apiRes.json();
    const text    = apiData?.content?.[0]?.text || '';
    const clean   = text.replace(/```json|```/g, '').trim();
    decision      = JSON.parse(clean);
  } catch (err) {
    console.warn('Claude API call failed:', err?.message);
    await logEvent(env, 'pulse', 'autonomy_claude_error', 'failure', {
      metadata: { signature: failure.signature, error: err.message },
    });
    return;
  }

  // ── 7. Increment budget spend ──
  budget.spent += 1;
  await env.SITES.put(todayKey, JSON.stringify(budget), {
    expirationTtl: 60 * 60 * 48,
  }).catch(() => {});

  // ── 8. Increment incident attempts ──
  await env.SITES.put(attemptKey, String(attempts + 1), {
    expirationTtl: 60 * 60 * 24 * 7,
  }).catch(() => {});

  // ── 9. Validate action against whitelist ──
  if (!whitelist.includes(decision.action) || decision.confidence === 'escalate') {
    await logEvent(env, 'pulse', 'autonomy_escalate', 'warning', {
      metadata: { signature: failure.signature, action: decision.action, reason: decision.escalate_reason, confidence: decision.confidence },
    });
    await sendWhatsApp(env.WH_PHONE,
      `🧠 Autonomy escalation\\nFailure: ${failure.signature}\\nHypothesis: ${decision.hypothesis}\\nReason: ${decision.escalate_reason || decision.reasoning}`,
      env, { skipTestRedirect: true }
    ).catch(() => {});
    await writeR2Reasoning(env, failure, decision, { outcome: 'escalated' });
    return;
  }

  // ── 10. Execute action ──
  const outcome = await executeAutonomyAction(env, failure, decision);

  // ── 11. Write reasoning to R2 ──
  await writeR2Reasoning(env, failure, decision, outcome);

  // ── 12. Log to D1 ──
  await logEvent(env, 'pulse', 'autonomy_repair_complete', outcome.success ? 'success' : 'failure', {
    metadata: {
      signature:         failure.signature,
      action:            decision.action,
      confidence:        decision.confidence,
      outcome:           outcome.outcome,
      validation:        decision.validation_criterion,
    },
  });
}

// ============================================================

async function executeAutonomyAction(env, failure, decision) {
  const action = decision.action;

  try {
    if (action === 'notify_pierre_whatsapp') {
      await sendWhatsApp(env.WH_PHONE,
        `🔧 Autonomy notice\\nFailure: ${failure.signature}\\nHypothesis: ${decision.hypothesis}\\nAction: notify only (no auto-fix available)\\nConfidence: ${decision.confidence}`,
        env, { skipTestRedirect: true }
      );
      return { success: true, outcome: 'pierre_notified' };
    }

    if (action === 'requeue_build') {
      const clientId = failure.context?.clientId;
      if (!clientId) return { success: false, outcome: 'no_client_id' };
      const buildUrl = env.WORKER_URL_BUILD || 'https://preview.websitehub.co.za';
      const res = await fetch(`${buildUrl}/update-status`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': env.ADMIN_KEY },
        body:    JSON.stringify({ clientId, status: 'pending' }),
      });
      return { success: res.ok, outcome: res.ok ? 'build_requeued' : `requeue_failed_${res.status}` };
    }

    if (action === 'invalidate_kv_cache') {
      const key = failure.context?.key;
      if (!key) return { success: false, outcome: 'no_key_specified' };
      // Safety: never invalidate app: keys — only cache keys
      if (key.startsWith('app:') || key.startsWith('template:')) {
        return { success: false, outcome: 'invalidate_blocked_protected_key' };
      }
      await env.SITES.delete(key);
      return { success: true, outcome: `kv_invalidated:${key}` };
    }

    if (action === 'bootstrap_emergency_template') {
      const buildUrl = env.WORKER_URL_BUILD || 'https://preview.websitehub.co.za';
      const res = await fetch(`${buildUrl}/bootstrap-templates`, {
        method:  'POST',
        headers: { 'x-admin-key': env.ADMIN_KEY },
      });
      return { success: res.ok, outcome: res.ok ? 'emergency_templates_bootstrapped' : `bootstrap_failed_${res.status}` };
    }

    if (action === 'fallback_to_cached_template' || action === 'degrade_to_generic_voice' || action === 'retry_with_fence_strip') {
      // These require build-worker cooperation — log intent and notify
      await logEvent(env, 'pulse', 'autonomy_action_intent', 'success', {
        metadata: { action, failure: failure.signature },
      });
      return { success: true, outcome: `${action}_logged_for_next_build` };
    }

    return { success: false, outcome: `unknown_action:${action}` };

  } catch (err) {
    return { success: false, outcome: `execution_error:${err.message}` };
  }
}

// ============================================================

async function writeR2Reasoning(env, failure, decision, outcome) {
  try {
    const key  = `reasoning/${failure.worker}/${failure.type}/${Date.now()}.json`;
    const data = JSON.stringify({
      version:             1,
      failure_signature:   failure.signature,
      failure_context:     failure.context,
      timestamp:           new Date().toISOString(),
      hypothesis:          decision.hypothesis,
      action:              decision.action,
      reasoning:           decision.reasoning,
      confidence:          decision.confidence,
      validation_criterion: decision.validation_criterion,
      outcome,
    }, null, 2);

    await env.ASSETS.put(key, data, {
      httpMetadata: { contentType: 'application/json' },
    });
  } catch (err) {
    console.warn('R2 reasoning write failed (non-fatal):', err?.message);
  }
}

// ============================================================
// End of autonomy layer
// ============================================================
"""

END_MARKER = '// ============================================================\n// End of pulse-worker.js\n// ============================================================'

if 'AUTONOMY LAYER' in js:
    print('INDEX: autonomy block already present — skipping append')
elif END_MARKER in js:
    js = js.replace(END_MARKER, AUTONOMY_BLOCK + '\n' + END_MARKER, 1)
    print('INDEX: autonomy block appended')
else:
    js = js + '\n' + AUTONOMY_BLOCK
    print('INDEX: autonomy block appended (end marker not found — appended to EOF)')

open(INDEX_PATH, 'w').write(js)
print('INDEX: written OK\n')

# ============================================================
# PATCH 3 — Verify critical strings present
# ============================================================

js_verify   = open(INDEX_PATH).read()
toml_verify = open(TOML_PATH).read()

checks = [
    (js_verify,   'runAutonomySweep',       'index.js: runAutonomySweep present'),
    (js_verify,   'decideRepair',           'index.js: decideRepair present'),
    (js_verify,   'writeR2Reasoning',       'index.js: writeR2Reasoning present'),
    (js_verify,   'autonomy:enabled',       'index.js: kill switch check present'),
    (js_verify,   'autonomy:budget:',       'index.js: budget check present'),
    (js_verify,   '*/5 * * * *',            'index.js: cron */5 NOT in index (expected — lives in toml)'),
    (toml_verify, 'ANTHROPIC_KEY',          'wrangler.toml: ANTHROPIC_KEY present'),
    (toml_verify, '*/5 * * * *',            'wrangler.toml: cron */5 present'),
]

print('── Verification ──')
all_ok = True
for content, needle, label in checks:
    found = needle in content
    # Special case: cron in index.js should NOT be there
    if label.startswith('index.js: cron'):
        status = '✓' if not found else '✗'
        if found: all_ok = False
    else:
        status = '✓' if found else '✗'
        if not found: all_ok = False
    print(f'  {status} {label}')

print()
if all_ok:
    print('✓ All checks passed. Ready to commit.')
else:
    print('✗ One or more checks failed. Do not commit — review above.')
    sys.exit(1)
