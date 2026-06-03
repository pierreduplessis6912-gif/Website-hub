with open('.github/workflows/deploy.yml', 'r') as f:
    content = f.read()

# Fix the broken wrangler-action line in launch-worker
old = """        uses: cloudflare/wrangler-action@v3
          \n        with:"""

new = """        uses: cloudflare/wrangler-action@v3
        with:"""

if old in content:
    content = content.replace(old, new)
    print("Fixed broken YAML")
else:
    # Try alternate broken format
    old2 = "uses: cloudflare/wrangler-action@v3\n          \n        with:"
    if old2 in content:
        content = content.replace(old2, "uses: cloudflare/wrangler-action@v3\n        with:")
        print("Fixed alternate broken YAML")
    else:
        print("Pattern not found — showing deploy-launch section:")
        idx = content.find('deploy-launch:')
        print(repr(content[idx:idx+400]))

with open('.github/workflows/deploy.yml', 'w') as f:
    f.write(content)
