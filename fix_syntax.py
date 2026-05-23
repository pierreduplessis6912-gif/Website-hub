import os, re

path = os.path.expanduser('~/Website-hub/pulse-worker/src/index.js')
c = open(path).read()

# Step 1: Remove any "let claudeRawResponse" or "let claudeStatusCode" 
# lines that appear inside the JSON body (wrong place)
# These were inserted by sed inside the body: JSON.stringify({...}) block
c = re.sub(r'\s+let claudeRawResponse = \'\';\s*\n?', '\n', c)
c = re.sub(r'\s+let claudeStatusCode = 0;\s*\n?', '\n', c)

# Step 2: Find "let decision = null;" and add declarations BEFORE it
# But only if they're not already there in the right place
if "let claudeRawResponse" not in c:
    old = "  let decision = null;"
    new = "  let claudeRawResponse = '';\n  let claudeStatusCode = 0;\n  let decision = null;"
    if old in c:
        c = c.replace(old, new, 1)
        print("FIXED: Added variable declarations in correct location")
    else:
        print("WARNING: Could not find 'let decision = null;'")
else:
    print("Variable declarations already present")

open(path, 'w').write(c)
print("Done. File written.")
