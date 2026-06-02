with open('.github/workflows/deploy.yml', 'r') as f:
    content = f.read()

old = """            CF_API_TOKEN
        env:
          PAYFAST_MERCHANT_ID: ${{ secrets.PAYFAST_MERCHANT_ID }}"""

new = """            CF_API_TOKEN
            RESEND_API_KEY
            GOOGLE_CLIENT_ID
            GOOGLE_CLIENT_SECRET
            GOOGLE_REFRESH_TOKEN
        env:
          PAYFAST_MERCHANT_ID: ${{ secrets.PAYFAST_MERCHANT_ID }}"""

old_env = """          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}"""
new_env = """          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}"""

changes = 0
for o, n in [(old, new), (old_env, new_env)]:
    if o in content:
        content = content.replace(o, n)
        changes += 1
    else:
        print(f'Not found: {o[:60]}')

with open('.github/workflows/deploy.yml', 'w') as f:
    f.write(content)
print(f'Done — {changes}/2 changes applied')
