with open('.github/workflows/deploy.yml', 'r') as f:
    content = f.read()

old = """          secrets: |
            ANTHROPIC_KEY
            UNSPLASH_ACCESS_KEY
            WH_PHONE
            EVOLUTION_API_URL
            EVOLUTION_API_KEY
            EVOLUTION_INSTANCE
            ADMIN_KEY
            GOOGLE_CLIENT_ID
            GOOGLE_CLIENT_SECRET
            GOOGLE_REFRESH_TOKEN
        env:
          ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
          UNSPLASH_ACCESS_KEY: ${{ secrets.UNSPLASH_ACCESS_KEY }}"""

new = """          secrets: |
            ANTHROPIC_KEY
            UNSPLASH_ACCESS_KEY
            WH_PHONE
            EVOLUTION_API_URL
            EVOLUTION_API_KEY
            EVOLUTION_INSTANCE
            ADMIN_KEY
            GOOGLE_CLIENT_ID
            GOOGLE_CLIENT_SECRET
            GOOGLE_REFRESH_TOKEN
        env:
          ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
          UNSPLASH_ACCESS_KEY: ${{ secrets.UNSPLASH_ACCESS_KEY }}
          WH_PHONE: ${{ secrets.WH_PHONE }}
          EVOLUTION_API_URL: ${{ secrets.EVOLUTION_API_URL }}
          EVOLUTION_API_KEY: ${{ secrets.EVOLUTION_API_KEY }}
          EVOLUTION_INSTANCE: ${{ secrets.EVOLUTION_INSTANCE }}
          ADMIN_KEY: ${{ secrets.ADMIN_KEY }}
          GOOGLE_CLIENT_ID: ${{ secrets.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET: ${{ secrets.GOOGLE_CLIENT_SECRET }}
          GOOGLE_REFRESH_TOKEN: ${{ secrets.GOOGLE_REFRESH_TOKEN }}"""

if old in content:
    content = content.replace(old, new)
    with open('.github/workflows/deploy.yml', 'w') as f:
        f.write(content)
    print("Done — build-worker env block fixed")
else:
    print("Pattern not found")
