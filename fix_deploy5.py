with open('.github/workflows/deploy.yml', 'r') as f:
    content = f.read()

old_sec = """            CF_API_TOKEN
        env:
          PAYFAST_MERCHANT_KEY: ${{ secrets.PAYFAST_MERCHANT_KEY }}"""

new_sec = """            CF_API_TOKEN
            RESEND_API_KEY
            GOOGLE_CLIENT_ID
            GOOGLE_CLIENT_SECRET
            GOOGLE_REFRESH_TOKEN
        env:
          PAYFAST_MERCHANT_KEY: ${{ secrets.PAYFAST_MERCHANT_KEY }}"""

old_env = """          ADMIN_KEY: ${{ secrets.ADMIN_KEY }}

  deploy-pulse:"""

new_env = """          ADMIN_KEY: ${{ secrets.ADMIN_KEY }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}

  deploy-pulse:"""

changes = 0
for old, new in [(old_sec, new_sec), (old_env, new_env)]:
    if old in content:
        content = content.replace(old, new)
        changes += 1
    else:
        print(f'Not found: {repr(old[:80])}')

with open('.github/workflows/deploy.yml', 'w') as f:
    f.write(content)
print(f'Done — {changes}/2 changes applied')
