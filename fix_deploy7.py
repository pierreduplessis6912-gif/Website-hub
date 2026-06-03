with open('.github/workflows/deploy.yml', 'r') as f:
    content = f.read()

# Pin wrangler version to avoid 4.96 bug
old = "uses: cloudflare/wrangler-action@v3"
new = "uses: cloudflare/wrangler-action@v3\n          wranglerVersion: '3.99.0'"

# Only replace the first occurrence (build-worker) - actually replace all
count = content.count(old)
content = content.replace(old, new)

with open('.github/workflows/deploy.yml', 'w') as f:
    f.write(content)
print(f"Done — pinned wrangler in {count} workers")
