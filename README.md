# Website Hub

**Automated website-as-a-service for South African small businesses.**
Built entirely from an Android phone. Runs while you sleep.

> "Your website. Live in 2 minutes."

---

## Live

| URL | What |
|-----|------|
| websitehub.co.za | Landing page |
| preview.websitehub.co.za | Platform (build, preview, manage) |
| preview.websitehub.co.za/admin | Admin dashboard |
| *.websitehub.co.za | Live client sites |

---

## The Product

Website Hub builds and hosts professional websites for SA small businesses. No agency. No meetings. No waiting a week.

**How it works:**
1. We find a business (outbound) or they find us (inbound)
2. We build their site automatically in ~2 minutes using Claude AI
3. They get a WhatsApp with an OG card — their actual site, built for them
4. They tap Go Live, pay via PayFast, site is live instantly
5. Everything after that is automated — invoicing, reminders, support forwarding

---

## Packages

| Plan | Build Fee | Monthly | Domain |
|------|-----------|---------|--------|
| Hub | R7,000 | R699/mo | yourbusiness.websitehub.co.za |
| Hub Pro | R7,000 | R999/mo | yourbusiness.co.za |
| Promo (LAUNCH2026) | R0 | R599/mo | yourbusiness.websitehub.co.za |

Monthly subscription. Cancel anytime. No contracts.

---

## Architecture

6 Cloudflare Workers on one zone:

```
wh-build      — public entry point, builds, admin, incoming WhatsApp
wh-launch     — PayFast, go-live, email provisioning, manage panel API
wh-patch      — revisions
wh-pulse      — daily cron: dunning, follow-ups, referral vesting
wh-reactivate — reactivations
wh-sites      — serves live client sites from KV by hostname
```

**Stack:** Cloudflare Workers · D1 · KV · R2 · Queues · Evolution API (WhatsApp) · PayFast · Anthropic Claude

---

## Brand

| | |
|-|-|
| Background | #0e0c09 |
| Accent | #00f0ff |
| Display | Syne |
| Body | DM Sans |
| Mono | DM Mono |

---

## Referral Programme

Available to promo clients only. Refer 10 businesses that go live → get Hub Pro upgrade (own .co.za domain) free. See `/referral-terms`.

---

## Legal & Compliance

- POPIA registered — Information Regulator of South Africa — Reg. No. 2026-024548
- Monthly subscription disclosure on all pricing surfaces
- Self-serve cancellation via manage panel
- All legal pages: /privacy · /terms · /cancellation · /aup · /dpa · /referral-terms

---

## For AI Sessions

Full technical context (workers, routes, KV schema, D1 schema, secrets, known issues, useful commands) lives in:

```
docs/CONTEXT.md
```

Read that first. Every session. Before touching any file.

---

## Goal

R1,000,000 ARR by December 25, 2026.
