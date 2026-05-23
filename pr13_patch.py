import os, sys

BASE        = os.path.expanduser('~/Website-hub')
INTAKE_PATH = f'{BASE}/intake-experience.html'

html = open(INTAKE_PATH).read()

# Replace the broken watchButtonGate with one that matches actual markup
# Button is id="next-1", class="next-btn" — enabled by adding class "enabled"
# Disabled = lacks "enabled" class. Not using disabled attribute.

OLD_WATCH = """      // Button-gate detector
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
      }"""

NEW_WATCH = """      // Button-gate detector
      // Card 1 button is id="next-1" class="next-btn"
      // Enabled state = has class "enabled". Disabled = no "enabled" class.
      function watchButtonGate() {
        var fields = document.querySelectorAll('#card-1 input, #card-1 select, #card-1 textarea');
        var btn    = document.getElementById('next-1');
        if (!fields.length || !btn) return;

        var timer = null;

        function checkGate() {
          clearTimeout(timer);
          timer = setTimeout(function() {
            var anyFilled = false;
            fields.forEach(function(f) { if (f.value && f.value.trim()) anyFilled = true; });
            // Disabled = does NOT have "enabled" class
            var isDisabled = !btn.classList.contains('enabled');
            if (anyFilled && isDisabled) {
              reportError('button_gate_failed', 'card1_next1_missing_enabled_class_after_fill', 1);
            }
          }, 3000);
        }

        fields.forEach(function(f) {
          f.addEventListener('input', checkGate);
          f.addEventListener('change', checkGate);
        });
      }"""

if NEW_WATCH.strip()[:50] in html:
    print('INTAKE: watcher already fixed — skipping')
elif OLD_WATCH in html:
    html = html.replace(OLD_WATCH, NEW_WATCH, 1)
    print('INTAKE: button-gate watcher fixed — now targets #next-1 + enabled class')
else:
    print('INTAKE ERROR: could not find old watcher — NOT FOUND')
    sys.exit(1)

open(INTAKE_PATH, 'w').write(html)
print('INTAKE: written OK\n')

# Verify
html_v = open(INTAKE_PATH).read()
checks = [
    ("getElementById('next-1')",                    'watcher targets #next-1'),
    ("classList.contains('enabled')",               'watcher checks enabled class'),
    ('card1_next1_missing_enabled_class_after_fill','correct error context string'),
]

print('── Verification ──')
all_ok = True
for needle, label in checks:
    found = needle in html_v
    status = '✓' if found else '✗'
    if not found: all_ok = False
    print(f'  {status} {label}')

print()
if all_ok:
    print('✓ All checks passed. Ready to commit.')
    print()
    print('Run:')
    print('  git add -A')
    print('  git commit -m "fix: button-gate watcher selector — targets #next-1 + enabled class (PR #13)"')
    print('  gh pr create --title "PR #13: Fix button-gate watcher selector" --body "Watcher was checking btn.disabled but intake uses enabled CSS class. Now correctly detects #next-1 missing enabled class after fields filled."')
    print('  gh pr merge --squash')
    print()
    print('Then re-bootstrap intake to KV:')
    print('  curl -s -X POST "https://preview.websitehub.co.za/bootstrap-intake" -H "x-admin-key: ADMIN_KEY_CLAUDEROX" -H "Content-Type: text/html" -d @/data/data/com.termux/files/home/Website-hub/intake-experience.html')
else:
    print('✗ One or more checks failed.')
    sys.exit(1)
