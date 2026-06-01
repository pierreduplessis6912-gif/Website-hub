import re

with open('.github/workflows/deploy.yml', 'r') as f:
    content = f.read()

old = """      - name: Deploy wh-launch
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: launch-worker"""

new = """      - name: Deploy wh-launch
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: launch-worker
          secrets: |
            PAYFAST_MERCHANT_KEY
            PAYFAST_PASSPHRASE
            PAYFAST_SANDBOX_MERCHANT_ID
            PAYFAST_SANDBOX_MERCHANT_KEY
            ANTHROPIC_KEY
            WH_PHONE
            ADMIN_KEY
            CF_API_TOKEN
        env:
          PAYFAST_MERCHANT_KEY: ${{ secrets.PAYFAST_MERCHANT_KEY }}
          PAYFAST_PASSPHRASE: ${{ secrets.PAYFAST_PASSPHRASE }}
          PAYFAST_SANDBOX_MERCHANT_ID: ${{ secrets.PAYFAST_SANDBOX_MERCHANT_ID }}
          PAYFAST_SANDBOX_MERCHANT_KEY: ${{ secrets.PAYFAST_SANDBOX_MERCHANT_KEY }}
          ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
          WH_PHONE: ${{ secrets.WH_PHONE }}
          ADMIN_KEY: ${{ secrets.ADMIN_KEY }}
          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}"""

if old in content:
    content = content.replace(old, new)
    with open('.github/workflows/deploy.yml', 'w') as f:
        f.write(content)
    print("✅ Done — deploy.yml updated")
else:
    print("❌ Pattern not found — deploy.yml may have different formatting")
