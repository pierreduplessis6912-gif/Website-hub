with open('.github/workflows/deploy.yml', 'r') as f:
    content = f.read()

# Add Google secrets to build-worker
old_bw = """          ADMIN_KEY: ${{ secrets.ADMIN_KEY }}

  deploy-patch:"""

new_bw = """          ADMIN_KEY: ${{ secrets.ADMIN_KEY }}
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}

  deploy-patch:"""

old_bw_sec = """            ADMIN_KEY
        env:
          ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}"""

new_bw_sec = """            ADMIN_KEY
            GOOGLE_CLIENT_ID
            GOOGLE_CLIENT_SECRET
            GOOGLE_REFRESH_TOKEN
        env:
          ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}"""

# Add Google secrets to launch-worker
old_lw = """          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}"""

new_lw = """          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
          RESEND_API_KEY: ${{ secrets.RESEND_API_KEY }}
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}"""

old_lw_sec = """            CF_API_TOKEN
            RESEND_API_KEY
        env:"""

new_lw_sec = """            CF_API_TOKEN
            RESEND_API_KEY
            GOOGLE_CLIENT_ID
            GOOGLE_CLIENT_SECRET
            GOOGLE_REFRESH_TOKEN
        env:"""

changes = 0
for old, new in [(old_bw, new_bw), (old_bw_sec, new_bw_sec), (old_lw, new_lw), (old_lw_sec, new_lw_sec)]:
    if old in content:
        content = content.replace(old, new)
        changes += 1
    else:
        print(f"Pattern not found: {old[:60]}")

with open('.github/workflows/deploy.yml', 'w') as f:
    f.write(content)

print(f"Done — {changes}/4 changes applied")
