# Public GitHub Publication Checklist

Use this before making the repository public.

## Secret safety

- [ ] `git status --short` reviewed.
- [ ] `.env` and `.env.*` are ignored and not tracked.
- [ ] `.shopify/` and `.shopify.lock` are ignored and not tracked.
- [ ] `.vscode/`, `.cursor/`, and other local editor/tooling files are ignored and not tracked.
- [ ] No real `DATABASE_URL`, Shopify API secret, billing secret, token, private key, or store access token appears in tracked files.
- [ ] Fixtures and screenshots contain no real merchant/customer data.
- [ ] Public docs avoid private GitHub links, private deployment URLs, and internal repo names.

Suggested scan:

```bash
git ls-files -co --exclude-standard \
  | grep -Ev '(^node_modules/|^build/|^dist/|\\.png$|\\.jpg$|\\.jpeg$|\\.gif$|\\.pdf$)' \
  | xargs grep -nE 'sk_live_|shpat_|shpss_|ghp_|xox[baprs]-|AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|DATABASE_URL=|SHOPIFY_API_SECRET|STRIPE_SECRET_KEY|SECRET_KEY|PASSWORD='
```

Review every hit. Local development examples are okay only when they are obvious placeholders.

## Portfolio polish

- [ ] README opens with a clear product sentence.
- [ ] `docs/github-portfolio.md` explains the business problem, architecture, and proof points.
- [ ] Any tracked screenshots are public-safe.
- [ ] README first screen reads as a portfolio project, not an internal build log.
- [ ] Privacy/GDPR routes are documented.
- [ ] License posture is intentional: proprietary/source-available unless changed.

## GitHub settings

- [ ] Repo description: `Shopify Plus Scripts-to-Functions migration-risk app.`
- [ ] Topics: `shopify`, `shopify-plus`, `shopify-functions`, `shopify-scripts`, `remix`, `prisma`, `postgresql`, `typescript`.
- [ ] Do not enable public issues if Morgan does not want support requests.
- [ ] Do not expose private deployment variables in GitHub Actions.

## Upwork-safe positioning

Use this repo as proof for:

- Shopify embedded app builds.
- Shopify Plus migration and platform-constraint work.
- Billing/paywall implementation.
- PDF/report generation.
- Privacy-safe data processing.
- App review hardening.

Do not claim revenue, merchant adoption, or client outcomes unless Morgan can prove them.
