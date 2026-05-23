import os, sys, re

BASE         = os.path.expanduser('~/Website-hub')
BUILD_PATH   = f'{BASE}/build-worker/src/index.js'
INTAKE_PATH  = f'{BASE}/intake-experience.html'

# ============================================================
# PATCH 1 — build-worker/src/index.js
# Add /log-error route + handler
# ============================================================

js = open(BUILD_PATH).read()

# 1a. Wire route — insert after /referral-stats line
OLD_ROUTE = "if (path === '/referral-stats')"
NEW_ROUTE = """if (path === '/referral-stats')"""  # same — used as anchor

INSERT_AFTER = "st, url, env);"  # last chars of the referral-stats line

# Find the referral-stats block and insert after it
OLD_ROUTE_BLOCK = "    if (path === '/referral-stats')      return handleReferralStats(reque\nst, url, env);"
NEW_ROUTE_BLOCK = "    if (path === '/referral-stats')      return handleReferralStats(reque\nst, url, env);\n    if (path === '/log-error')             return handleLogError(request, env);"

# Try exact match first, fall back to safer pattern
if "path === '/log-error'" in js:
    print('BUILD: /log-error route already present — skipping')
elif OLD_ROUTE_BLOCK in js:
    js = js.replace(OLD_ROUTE_BLOCK, NEW_ROUTE_BLOCK, 1)
    print('BUILD: /log-error route added')
else:
    # Fallback — find referral-stats line and append after it
    pattern = r"(if \(path === '/referral-stats'\)[^\n]*\n[^\n]*)"
    match = re.search(pattern, js)
    if match:
        old = match.group(0)
        new = old + "\n    if (path === '/log-error')             return handleLogError(request, env);"
        js = js.replace(old, new, 1)
        print('BUILD: /log-error route added (fallback pattern)')
    else:
        print('BUILD ERROR: could not find referral-stats route — NOT FOUND')
        sys.exit(1)

# 1b. Add handler function — insert before final // ===... comment block
HANDLER = """
// ============================================================
// ROUTE: /log-error — client-side error reporter
// Intake SPA posts here when JS failures occur.
// Surfaces silent browser errors to D1 so autonomy sweep can find them.
// ============================================================

async function handleLogError(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let body;
  try { body = await request.json(); } catch { return jsonResponse({ error: 'Invalid JSON' }, 400); }

  const { error_type, context, card, url: pageUrl } = body;
  if (!error_type) return jsonResponse({ error: 'error_type required' }, 400);

  // Write to D1 events so autonomy sweep picks it up
  try {
    await logEvent(env, 'intake', error_type, 'failure', {
      metadata: {
        context:  context  || null,
        card:     card     || null,
        url:      pageUrl  || null,
        source:   'client_side_reporter',
      },
    });
  } catch (err) {
    // Non-fatal — don't break the client
    console.warn('logEvent failed in handleLogError:', err?.message);
  }

  return jsonResponse({ ok: true });
}

"""

# Find the last // ============ block (end of file marker)
END_MARKER = '// ============================================================\n// ROUTE: /health'

if 'handleLogError' in js:
    print('BUILD: handleLogError already present — skipping handler patch')
elif END_MARKER in js:
    js = js.replace(END_MARKER, HANDLER + END_MARKER, 1)
    print('BUILD: handleLogError function added')
else:
    # Append before end of file
    js = js + HANDLER
    print('BUILD: handleLogError appended to EOF')

open(BUILD_PATH, 'w').write(js)
print('BUILD: written OK\n')

# ============================================================
# PATCH 2 — intake-experience.html
# Add client-side error reporter snippet
# Targets the button-gate failure specifically
# ============================================================

html = open(INTAKE_PATH).read()

REPORTER_SCRIPT = """
  <!-- Autonomy error reporter — surfaces JS failures to D1 -->
  <script>
    (function() {
      const LOG_URL = 'https://preview.websitehub.co.za/log-error';

      function reportError(error_type, context, card) {
        fetch(LOG_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error_type: error_type,
            context:    context,
            card:       card,
            url:        window.location.href,
          }),
        }).catch(function() {}); // never block the UI
      }

      // Button-gate detector
      // Fires if card 1 button is still disabled 3 seconds after any input field changes
      function watchButtonGate() {
        var fields   = document.querySelectorAll('#card-1 input, #card-1 select, #card-1 textarea');
        var btn      = document.querySelector('#card-1 .next-btn, #card-1 button[type="button"], #card-1 .btn-next');
        if (!fields.length) return;

        var timer = null;

        function checkGate() {
          clearTimeout(timer);
          timer = setTimeout(function() {
            // If any field has a value but button is still disabled — report it
            var anyFilled = false;
            fields.forEach(function(f) { if (f.value && f.value.trim()) anyFilled = true; });
            if (anyFilled && btn && (btn.disabled || btn.classList.contains('disabled'))) {
              reportError('button_gate_failed', 'card1_button_disabled_after_fill', 1);
            }
          }, 3000);
        }

        fields.forEach(function(f) {
          f.addEventListener('input', checkGate);
          f.addEventListener('change', checkGate);
        });
      }

      // Card navigation detector
      // Fires if card 1 exits but card 2 never becomes visible after 4 seconds
      function watchCardNavigation() {
        var card1 = document.getElementById('card-1');
        var card2 = document.getElementById('card-2');
        if (!card1 || !card2) return;

        var observer = new MutationObserver(function() {
          var c1Hidden = card1.classList.contains('hidden') || card1.style.display === 'none';
          if (c1Hidden) {
            setTimeout(function() {
              var c2Visible = !card2.classList.contains('hidden') && card2.style.display !== 'none';
              if (!c2Visible) {
                reportError('card_navigation_failed', 'card2_never_rendered_after_card1_exit', 1);
              }
            }, 4000);
          }
        });

        observer.observe(card1, { attributes: true, attributeFilter: ['class', 'style'] });
      }

      // Init on DOM ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          watchButtonGate();
          watchCardNavigation();
        });
      } else {
        watchButtonGate();
        watchCardNavigation();
      }
    })();
  </script>
"""

if 'Autonomy error reporter' in html:
    print('INTAKE: reporter already present — skipping')
elif '</body>' in html:
    html = html.replace('</body>', REPORTER_SCRIPT + '\n</body>', 1)
    print('INTAKE: error reporter injected before </body>')
elif '</html>' in html:
    html = html.replace('</html>', REPORTER_SCRIPT + '\n</html>', 1)
    print('INTAKE: error reporter injected before </html>')
else:
    html = html + REPORTER_SCRIPT
    print('INTAKE: error reporter appended to EOF')

open(INTAKE_PATH, 'w').write(html)
print('INTAKE: written OK\n')

# ============================================================
# PATCH 3 — Verify
# ============================================================

js_v   = open(BUILD_PATH).read()
html_v = open(INTAKE_PATH).read()

checks = [
    (js_v,   "path === '/log-error'",    'build-worker: /log-error route present'),
    (js_v,   'handleLogError',           'build-worker: handleLogError function present'),
    (js_v,   'client_side_reporter',     'build-worker: source tag present'),
    (html_v, 'Autonomy error reporter',  'intake.html: reporter script present'),
    (html_v, 'button_gate_failed',       'intake.html: button-gate watcher present'),
    (html_v, 'card_navigation_failed',   'intake.html: card navigation watcher present'),
    (html_v, 'log-error',               'intake.html: LOG_URL present'),
]

print('── Verification ──')
all_ok = True
for content, needle, label in checks:
    found = needle in content
    status = '✓' if found else '✗'
    if not found: all_ok = False
    print(f'  {status} {label}')

print()
if all_ok:
    print('✓ All checks passed. Ready to commit.')
    print()
    print('Next steps:')
    print('  1. git add -A')
    print('  2. git commit -m "feat: client-side error reporter + /log-error endpoint (PR #12)"')
    print('  3. gh pr create --title "PR #12: Client error reporter — surface JS failures to autonomy sweep" --body "Adds /log-error to build-worker. Injects button-gate + card-nav watchers into intake HTML. Silent browser failures now visible to D1 and Claude."')
    print('  4. gh pr merge --squash')
    print('  5. Bootstrap intake HTML to KV after merge:')
    print('     curl -s -X POST "https://preview.websitehub.co.za/bootstrap-intake" -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: text/html" -d @/data/data/com.termux/files/home/Website-hub/intake-experience.html')
else:
    print('✗ One or more checks failed. Review above.')
    sys.exit(1)
