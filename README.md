# Script Sentinel

Read-only Shopify Plus migration-risk app for merchants moving from legacy Shopify Scripts to Shopify Functions before the June 30, 2026 Scripts shutdown.

Script Sentinel does not create discounts, modify Scripts, deploy Functions, or change checkout behavior. It helps a merchant and developer understand migration risk before touching production.

## Project Snapshot

Script Sentinel is a production-shaped Shopify Plus app built around a narrow migration workflow:

- Embedded Shopify admin app built with Remix, TypeScript, Prisma, PostgreSQL, Polaris, and App Bridge.
- Plus-only access gate and Shopify Managed Billing for one-time audit and recurring regression-suite products.
- Merchant-paste intake for legacy Scripts, because Shopify does not expose a public legacy Scripts API.
- Deterministic Ruby-source classifier for discount, shipping, payment, market-pricing, B2B, and other script categories.
- Privacy-scrubbed order-fixture generation from recent Shopify order data.
- Migration-risk audit report flow with server-rendered PDF output.
- Regression/parity surfaces for comparing expected legacy behavior with observed Shopify Functions behavior.
- GDPR webhooks, privacy route, health route, and review-safe direct routes.

This repo is intended as a work sample for Shopify Plus app builds, platform-constraint handling, privacy-safe data processing, billing flows, and report generation.

## Portfolio Quick Read

If you are reviewing this as a work sample, start with [`docs/github-portfolio.md`](docs/github-portfolio.md). It summarizes the business problem, architecture, proof points, and public-safe Upwork/job-application positioning.

## Product Surface

The app is organized around the migration sequence a Shopify Plus merchant would actually follow:

1. Confirm the shop is Plus and eligible for Scripts migration work.
2. Paste legacy Script source into the app.
3. Classify the script without executing merchant Ruby code.
4. Generate privacy-scrubbed cart fixtures from recent order data.
5. Produce a migration-risk audit report.
6. Capture Shopify Functions output for comparison.
7. Run regression/parity checks and surface drift alerts.

The launch posture is deliberately conservative: Script Sentinel tells merchants what to inspect and test. It does not promise automatic conversion, legal/compliance approval, or guaranteed migration success.

## Architecture

```text
Shopify OAuth / embedded admin
  -> Plus gate and billing state
  -> Script intake and deterministic classification
  -> Privacy scrubber and fixture store
  -> Risk scorer and PDF report renderer
  -> Function-output capture
  -> Drift comparison and regression alerts
```

**Stack:** Remix, TypeScript, Prisma, PostgreSQL, Shopify App Bridge, Polaris, Shopify Managed Billing, Vitest.

## Project Structure

```text
app/
  lib/
    audit/          Risk scoring and report data
    billing/        Managed Billing products and charge helpers
    classifier/     Deterministic Shopify Script classification
    fixtures/       Order fixture extraction, PII scrub, deduplication
    functions/      Function discovery and output capture
    pdf/            Audit report rendering
    regression/     Drift comparison and recurring checks
  routes/           Embedded app routes, OAuth, webhooks, privacy, health

prisma/
  schema.prisma     Sessions, shops, charges, scripts, fixtures, reports,
                    function outputs, drift runs, and alerts

docs/
  github-portfolio.md
```

## Privacy And Safety Model

- The app uses read-only Shopify scopes: `read_orders`, `read_products`, `read_discounts`, `read_locations`, and `read_shipping`.
- Legacy Script source is treated as untrusted text and never evaluated.
- Order fixtures drop customer names, emails, phones, and full addresses before persistence.
- The product avoids `read_all_orders`; the launch fixture window uses the standard recent-order access model.
- GDPR webhooks are implemented for app uninstall, customer data request/redact, and shop redact.
- No automatic Script-to-Function conversion is attempted.

## Good Files To Review

- `app/lib/classifier/`
- `app/lib/fixtures/`
- `app/lib/audit/`
- `app/lib/pdf/`
- `app/lib/regression/`
- `app/routes/app.*`
- `app/routes/webhooks.*`
- `prisma/schema.prisma`
- `docs/github-portfolio.md`

## Local Setup

You need:

- Node `>=20.19 <22 || >=22.12`
- PostgreSQL
- Shopify CLI for embedded-app development against a dev store

```bash
npm install
npx prisma generate
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/script_sentinel_dev?schema=public"
npx prisma migrate dev
npm run typecheck
npm test
```

To bring the embedded app up against a Shopify Plus development store:

```bash
npm run config:link
npm run dev
```

The Shopify CLI prints an install URL. Open it in a Plus dev store and approve the read-only OAuth scopes.

## Verification

```bash
npm run typecheck
npm test
```

Some persistence-backed tests require `DATABASE_URL` to point at a reachable PostgreSQL database. The CI workflow provisions Postgres for those checks.

## Constraints

- Plus-only.
- Read-only Shopify scopes only.
- No checkout, discount, Script, or Function writes.
- No Script-to-Function auto-conversion.
- No discount-builder UI.
- Shopify only.
- Conservative PII handling for order-derived fixtures.
