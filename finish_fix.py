import os

path = os.path.expanduser('~/Website-hub/pulse-worker/src/index.js')
c = open(path).read()

# FIX: Add variable declarations before "let decision = null;"
old_decision = "  let decision = null;"
new_decision = """  let decision = null;
  let claudeRawResponse = '';
  let claudeStatusCode = 0;"""

if old_decision in c and "claudeRawResponse" not in c:
    c = c.replace(old_decision, new_decision, 1)
    print("FIXED: Added claudeRawResponse and claudeStatusCode declarations")
else:
    print("Decision declaration not found or already fixed")

# FIX: Replace unsafe "const apiData = await apiRes.json();" with safe parsing
old_json = "    const apiData = await apiRes.json();"
new_json = """    claudeStatusCode = apiRes.status;
    const rawText = await apiRes.text();
    claudeRawResponse = rawText.slice(0, 2000);
    
    if (!apiRes.ok) {
      throw new Error(`Claude API returned HTTP ${claudeStatusCode}: ${rawText.slice(0, 500)}`);
    }
    
    const apiData = JSON.parse(rawText);"""

if old_json in c:
    c = c.replace(old_json, new_json, 1)
    print("FIXED: Added safe JSON parsing with HTTP status check")
else:
    print("WARNING: 'const apiData = await apiRes.json();' not found")

open(path, 'w').write(c)
print("Done. File written.")
