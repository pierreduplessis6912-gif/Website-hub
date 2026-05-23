import os, sys

BASE       = os.path.expanduser('~/Website-hub')
INDEX_PATH = f'{BASE}/pulse-worker/src/index.js'

js = open(INDEX_PATH).read()

# ============================================================
# PATCH 1 — Remove noisy cron_run logEvent from runDailyCron
# It fires every 5 min now — 288 rows/day of pure noise
# ============================================================

OLD_CRON_RUN = """  await logEvent(env, 'pulse', 'cron_run', 'success', { metadata: { date: today, phase: 'started' } });"""
NEW_CRON_RUN = """  // cron_run log removed — Cloudflare dashboard shows all executions natively"""

if '// cron_run log removed' in js:
    print('INDEX: cron_run log already removed — skipping')
elif OLD_CRON_RUN in js:
    js = js.replace(OLD_CRON_RUN, NEW_CRON_RUN, 1)
    print('INDEX: cron_run noisy log removed')
else:
    print('INDEX ERROR: could not find cron_run logEvent — NOT FOUND')
    sys.exit(1)

# ============================================================
# PATCH 2 — Remove noisy cron_complete logEvent from runDailyCron
# ============================================================

OLD_CRON_COMPLETE = """  const elapsedMs = Date.now() - startTs;
  await logEvent(env, 'pulse', 'cron_complete', 'success', {
    metadata: { date: today, elapsedMs, results },
  });"""

NEW_CRON_COMPLETE = """  const elapsedMs = Date.now() - startTs;
  // cron_complete log removed — noise at */5 frequency
  // Only log if a sequence actually errored (already logged inside the loop above)
  void elapsedMs;"""

if '// cron_complete log removed' in js:
    print('INDEX: cron_complete log already removed — skipping')
elif OLD_CRON_COMPLETE in js:
    js = js.replace(OLD_CRON_COMPLETE, NEW_CRON_COMPLETE, 1)
    print('INDEX: cron_complete noisy log removed')
else:
    print('INDEX WARNING: could not find cron_complete logEvent — may already be patched, continuing')

# ============================================================
# PATCH 3 — Replace autonomy_sweep_complete logEvent with
# conditional — only log when failures > 0
# AND add intake events query to sweep
# ============================================================

OLD_SWEEP_LOG = """  // ── 4. Log sweep summary ──
  await logEvent(env, 'pulse', 'autonomy_sweep_complete', 'success', {
    metadata: { failures: failures.length, timestamp: now },
  });

  return failures;
}"""

NEW_SWEEP_LOG = """  // ── 4. Query D1 for recent intake failures (client-side reporter events) ──
  try {
    const intakeResult = await env.DB.prepare(
      `SELECT id, event_type, metadata, created_at FROM events
       WHERE worker = 'intake'
       AND status = 'failure'
       AND datetime(created_at) > datetime('now', '-10 minutes')
       LIMIT 20`
    ).all().catch(() => ({ results: [] }));

    for (const row of intakeResult?.results || []) {
      let meta = {};
      try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch {}
      failures.push({
        signature: `intake:${row.event_type}:${row.id}`,
        worker:    'intake',
        type:      row.event_type,
        context:   { ...meta, d1_event_id: row.id, created_at: row.created_at },
        timestamp: now,
      });
    }
  } catch (err) {
    console.warn('Intake events query failed (non-fatal):', err?.message);
  }

  // ── 5. Log sweep summary — only if something found ──
  if (failures.length > 0) {
    await logEvent(env, 'pulse', 'autonomy_sweep_complete', 'failure', {
      metadata: { failures: failures.length, timestamp: now },
    });
  }
  // Clean sweep = silent. Cloudflare dashboard shows execution history natively.

  return failures;
}"""

if 'Query D1 for recent intake failures' in js:
    print('INDEX: intake query already present — skipping sweep patch')
elif OLD_SWEEP_LOG in js:
    js = js.replace(OLD_SWEEP_LOG, NEW_SWEEP_LOG, 1)
    print('INDEX: intake events query added to sweep')
    print('INDEX: sweep log now conditional — silent on clean cycles')
else:
    print('INDEX ERROR: could not find sweep log block — NOT FOUND')
    sys.exit(1)

open(INDEX_PATH, 'w').write(js)
print('INDEX: written OK\n')

# ============================================================
# PATCH 4 — Verify
# ============================================================

js_v = open(INDEX_PATH).read()

checks = [
    ('// cron_run log removed',                    'cron_run noise removed'),
    ("worker = 'intake'",                          'intake events query present'),
    ("datetime('now', '-10 minutes')",             'intake query time window present'),
    ('failures.length > 0',                        'conditional sweep log present'),
    ('Clean sweep = silent',                        'silent clean sweep comment present'),
    ('intake:${row.event_type}',                   'intake failure signature format present'),
]

print('── Verification ──')
all_ok = True
for needle, label in checks:
    found = needle in js_v
    status = '✓' if found else '✗'
    if not found: all_ok = False
    print(f'  {status} {label}')

print()
if all_ok:
    print('✓ All checks passed. Ready to commit.')
    print()
    print('Run:')
    print('  git add -A')
    print('  git commit -m "feat: sweep queries D1 intake events + remove noisy cron logs (PR #14)"')
    print('  gh pr create --title "PR #14: Sweep reads intake events + silent clean cycles" --body "runAutonomySweep now queries D1 for intake worker failures in last 10 min. button_gate_failed and card_navigation_failed now visible to Claude. Removed cron_run/cron_complete/sweep_complete D1 logs on clean cycles — Cloudflare dashboard handles execution history. D1 only written when something meaningful happens."')
    print('  gh pr merge --squash')
else:
    print('✗ One or more checks failed. Review above.')
    sys.exit(1)
