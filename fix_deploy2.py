import re

with open('.github/workflows/deploy.yml', 'r') as f:
    content = f.read()

# 1. pulse-worker secrets
old_pulse = """      - name: Deploy wh-pulse
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: pulse-worker"""

new_pulse = """      - name: Deploy wh-pulse
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: pulse-worker
          secrets: |
            RESEND_API_KEY
            WH_PHONE
            ADMIN_KEY
            EVOLUTION_API_URL
            EVOLUTION_API_KEY
            EVOLUTION_INSTANCE
        env:
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          WH_PHONE: ${{ secrets.WH_PHONE }}
          ADMIN_KEY: ${{ secrets.ADMIN_KEY }}
          EVOLUTION_API_URL: ${{ secrets.EVOLUTION_API_URL }}
          EVOLUTION_API_KEY: ${{ secrets.EVOLUTION_API_KEY }}
          EVOLUTION_INSTANCE: ${{ secrets.EVOLUTION_INSTANCE }}"""

# 2. reactivate-worker secrets
old_reactivate = """      - name: Deploy wh-reactivate
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: reactivate-worker"""

new_reactivate = """      - name: Deploy wh-reactivate
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: reactivate-worker
          secrets: |
            WH_PHONE
            ADMIN_KEY
            EVOLUTION_API_URL
            EVOLUTION_API_KEY
            EVOLUTION_INSTANCE
        env:
          WH_PHONE: ${{ secrets.WH_PHONE }}
          ADMIN_KEY: ${{ secrets.ADMIN_KEY }}
          EVOLUTION_API_URL: ${{ secrets.EVOLUTION_API_URL }}
          EVOLUTION_API_KEY: ${{ secrets.EVOLUTION_API_KEY }}
          EVOLUTION_INSTANCE: ${{ secrets.EVOLUTION_INSTANCE }}"""

changes = 0
for old, new in [(old_pulse, new_pulse), (old_reactivate, new_reactivate)]:
    if old in content:
        content = content.replace(old, new)
        changes += 1
    else:
        print(f"Pattern not found: {old[:60]}")

with open('.github/workflows/deploy.yml', 'w') as f:
    f.write(content)

print(f"Done — {changes}/2 changes applied")
