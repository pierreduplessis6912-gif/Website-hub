import os

path = os.path.expanduser('~/Website-hub/pulse-worker/src/index.js')
c = open(path).read()

# Step 1: Remove ANY lines containing "let claudeRawResponse" or "let claudeStatusCode"
# that are NOT at the correct location (before "let decision = null;")
lines = c.split('\n')
clean_lines = []
for line in lines:
    stripped = line.strip()
    if stripped == "let claudeRawResponse = '';" or stripped == "let claudeStatusCode = 0;":
        # Skip these lines wherever they appear (we'll add them in the right place)
        continue
    clean_lines.append(line)

c = '\n'.join(clean_lines)

# Step 2: Add the declarations right BEFORE "let decision = null;"
old = "  let decision = null;"
new = "  let claudeRawResponse = '';\n  let claudeStatusCode = 0;\n  let decision = null;"

if old in c:
    c = c.replace(old, new, 1)
    print("FIXED: Added declarations before 'let decision = null;'")
else:
    print("ERROR: Could not find 'let decision = null;'")
    # Try to find it with different indentation
    if "let decision = null;" in c:
        print("Found with different indentation, attempting fix...")
        c = c.replace("let decision = null;", "let claudeRawResponse = '';\n  let claudeStatusCode = 0;\n  let decision = null;", 1)
        print("FIXED with adjusted indentation")
    else:
        print("CRITICAL: 'let decision = null;' not found anywhere!")

open(path, 'w').write(c)
print("Done.")
