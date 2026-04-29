# Script Sentinel

Plus-only, read-only regression/parity testing app for Shopify merchants migrating from
Shopify Scripts to Shopify Functions before the **June 30, 2026** Scripts shutdown
(editing already blocked since 2026-04-15).

The product is read-only against production. It never creates discounts, modifies
Scripts, deploys Functions, or changes checkout behavior. See
`SCRIPT-SENTINEL-README.pdf` for the full product narrative and
`SCRIPT-SENTINEL-ROADMAP.pdf` for the 10-slice build plan.

## Slice 1 status — App shell + Managed Billing

**What works in this slice**

- Embedded Shopify app shell (Remix + TypeScript + Polaris + App Bridge v4),
  scaffolded from the official Shopify Remix template.
- OAuth/install flow at `/auth/*`. The standard `auth.$.tsx` + `auth/login` routes
  ship from the template unchanged.
- Embedded dashboard at `/app` showing the shop name, Plus status, current billing
  state (cached `Charge` row, if any), and a "Run migration audit" CTA pointing at
  the Slice 4 paywall (currently disabled — Slice 4 wires the actual paywall).
- Plus-plan detection + non-Plus gate. Verified canonically off
  `Shop.plan.shopifyPlus` (Boolean!) — never the deprecated `displayName` string.
  Partner-created development stores (`partnerDevelopment: true`) pass the gate so
  developers can install on dev stores.
- Non-Plus gate copy:
  > "Script Sentinel is for Shopify Plus merchants. Shopify Scripts only run on Plus stores."
- Shopify Managed Billing config for the four catalog SKUs, centralised in
  `app/lib/billing/products.ts`:
  | Plan key | Price | Type |
  |---|---|---|
  | `MIGRATION_RISK_AUDIT` | `$199` | one-time |
  | `MULTI_SCRIPT_AUDIT` | `$499` | one-time |
  | `REGRESSION_SUITE_DISCOUNT` | `$149/mo` | recurring |
  | `REGRESSION_SUITE_ALL` | `$299/mo` | recurring |
- Uninstall webhook (`app/uninstalled`) verifies HMAC via `authenticate.webhook`,
  deletes the OAuth `Session`, marks the `Shop` row uninstalled, and cancels active
  cached `Charge` rows.
- Prisma schema with `Session` (template-owned), `Shop`, and `Charge` tables. Stays
  on SQLite for local dev to match the template default; field types are
  Postgres-compatible (single-line provider switch when we deploy).
- Vitest tests for plan detection (`app/lib/shopify/plan.server.test.ts`),
  billing config + catalog (`app/lib/billing/products.test.ts`), and the
  uninstall-webhook handler contract (`app/routes/webhooks.app.uninstalled.test.ts`).

**Scopes (read-only)**

`shopify.app.toml` declares only:

```
read_orders, read_products, read_discounts, read_locations, read_shipping
```

Two scope notes worth keeping in the file rather than buried in code:

- `read_checkouts` is **not** a real Admin API access scope as of API 2026-04. The
  abandoned-checkout fields live under `read_orders`, so we drop the bogus name.
- Script-discovery (the legacy Scripts admin object) does not have a public
  `read_scripts` scope. Slice 2 verifies whether Admin-API discovery is exposed at
  all during the deprecation window and falls back to a merchant-paste workflow
  if not. `read_script_tags` is an unrelated storefront API — intentionally not
  enabled.

## Slice 2 status — Script discovery + classification

**What works in this slice**

- **Verified Shopify API surface (2026-04):** the legacy Script Editor scripts
  are NOT exposed via Admin GraphQL or REST in 2026-04. There is no `Script`
  object, no `/scripts.json` endpoint, and no `read_scripts` scope. Shopify's
  only documented migration discovery surface is the in-admin Customizations
  report. Confirmed against `shopify.dev/docs/api/admin-graphql/2026-04`,
  `shopify.dev/docs/api/admin-rest/2026-04`, and the official Scripts
  deprecation changelog. Slice 2 therefore ships **merchant-paste as the
  primary intake** — no scope changes from Slice 1.
- Embedded `Scripts` route at `/app/scripts` with two tabs (Active /
  Archived), a paste form, and an inventory listing. Each list item shows
  the title, type (line item / shipping / payment / unknown), automatic
  classification badge, and an "Updated" date. Low-confidence
  auto-classifications surface a "Needs review" pill.
- Script detail route at `/app/scripts/:id` rendering the Ruby source as
  plain text inside a `<pre>` tag (React's text-content escaping handles
  any embedded HTML — never `dangerouslySetInnerHTML`). The detail view
  also exposes the auto-classification signals, a manual override
  (`Discount Logic` / `Shipping Rule` / `Payment Customization` /
  `Market Pricing` / `B2B Logic` / `Other`), an optional override reason,
  and archive/unarchive/delete actions.
- Heuristic classifier in `app/lib/classifier/script-classifier.ts`:
  pure function, 6 categories, weighted regex bundles, deterministic. Pure
  text inspection — never evaluates Ruby. The roadmap's "≥80% accuracy on a
  hand-curated test set of ≥20 representative scripts" is enforced by a
  hard-fail test against a 22-sample corpus (`script-samples.ts`).
- Manual reclassification overrides persist in `ScriptClassification` and
  survive subsequent auto-classifier reruns. Override + reason + timestamp
  all roundtrip via Prisma.
- Persistence test (`test/scripts.persistence.test.ts`) exercises the real
  schema end-to-end: paste → classify → list → override → archive → delete
  with cascade.
- Same Plus-only gate from Slice 1 is enforced on every load AND every
  action in the scripts routes — no forged form-post can drop data on a
  non-Plus shop.
- Nav link + dashboard "Step 1 — Inventory your scripts" CTA wired.

**Scopes (unchanged)**

`read_orders, read_products, read_discounts, read_locations, read_shipping`.
No new scopes were needed because Shopify exposes no script-discovery API.

## Slice 3 status — Cart fixture generation

**What works in this slice**

- **Verified 2026-04 Order API shape**: orders connection, cursor pagination,
  query-string filter (`processed_at:>=YYYY-MM-DD`), MoneyBag `*Set` shape on
  line items, `shippingLines` is a connection, `Order.market` does NOT exist
  (we derive market from `presentmentCurrencyCode` + `shippingAddress.countryCode`).
  Cited inline in `app/lib/shopify/orders.ts`.
- **Order history window — 60 days, not 90.** `read_orders` exposes only the
  last 60 days; the documented `read_all_orders` scope (which would lift the
  window to 90+ days) requires Shopify Partner approval. Slice 3 ships at 60
  days as a graceful fallback. Lifting to 90 days is a config flip plus a
  scope addition once Partner review approves it.
- Read-only paginated orders client in `app/lib/shopify/orders.ts` with
  cursor-based forward iteration, query-cost-aware backoff (sleeps when
  `extensions.cost.throttleStatus.currentlyAvailable` drops below 200), and a
  hard `MAX_ORDERS_PER_RUN = 5000` ceiling.
- PII scrubber in `app/lib/fixtures/pii.ts`: drops names, emails, phones, and
  full addresses; keeps only ISO-2 country code and the **first 3 characters
  of the postal code**. Customer tags pass through a normaliser that lowercases,
  collapses punctuation, and rejects PII-shaped tags.
- Extractor (`extractor.ts`) and dedup (`dedup.ts`) modules — pure, no I/O —
  turning `Order` rows into `(CartFixture, FixtureBaseline)` pairs and
  collapsing same-composition + same-tags + same-country + same-discount
  orders into a single fixture row. Quantity diversity is preserved via
  `quantitySamples`.
- Idempotent persistence (`store.server.ts`): re-running "Generate fixtures"
  merges new orders into existing rows by SHA-256 signature; observation
  counts and quantity samples accumulate, the freshest order wins the
  baseline. No duplicate rows ever.
- Embedded `Cart fixtures` route at `/app/fixtures` with a Generate action,
  a Clear action (with confirm), and a card listing per fixture: product mix,
  market badges, observation count, captured discount/shipping/payment
  baseline.
- Plus-only gate enforced on every loader and action.
- Nav link + dashboard "Step 2 — Generate cart fixtures" CTA wired.
- Tests: 96 total across 10 files. PII scrubber 18, orders client 7,
  extractor 13, dedup 10, fixtures persistence 5 (incl. PII tripwire that
  serialises every persisted row and asserts no PII-shaped substring slipped
  through).

**Scopes (unchanged)**

`read_orders, read_products, read_discounts, read_locations, read_shipping`.
**No new scopes added.** Specifically, `read_all_orders` was NOT added — that
scope requires Partner review and is a separate workstream gated on submitting
the app for App Store approval.

**Privacy notes for App Store review (Slice 9)**

- We never persist customer names, emails, phones, or full addresses.
- Stored fields per fixture: ISO-2 country code; first 3 characters of postal
  code, uppercased; merchant-controlled customer tags after a normaliser drops
  any PII-shaped tags; line items (variant id / product id / sku / title /
  qty / unit price); discount code values; aggregate cart totals.
- The persistence test asserts no PII slips through, on every persisted row,
  every run.

## Slice 4 status — Migration Risk Audit (the $199 / $499 cash gate)

**What works in this slice**

- `/app/audit` route with three states driven off the merchant's
  Managed-Billing purchase status: **non-Plus gate** → **paywall** (two SKUs:
  `MIGRATION_RISK_AUDIT` $199 single-family, `MULTI_SCRIPT_AUDIT` $499
  all-families) → **ready** (Generate / Download). Plus-only gate enforced
  on every loader and action.
- Charge wrapper in `app/lib/billing/charge.server.ts` — narrow surface
  around `billing.request` / `billing.check` that:
    - Refuses to call `request()` with non-audit plan keys (typo guard).
    - Treats only `ACTIVE` / `ACCEPTED` Shopify purchase statuses as "paid"
      (`PENDING` / `DECLINED` filtered out).
    - Carries `isTest` through, so partner-development stores can run the
      flow end-to-end with fake charges.
- Risk scorer in `app/lib/audit/risk-scorer.ts` — pure, deterministic
  function from `(scripts, fixtures) → AuditSnapshot`. Grades each script
  high / medium / low / unknown using the classifier output + source
  pattern hits + complexity score + fixture context. Conservative on
  unknowns: low-confidence classifications and fixture-empty shops fall back
  to `unknown` rather than producing false-confident "low" gradings.
- React-PDF deliverable in `app/lib/pdf/audit-report.tsx` covering all five
  required sections: executive summary, per-script breakdown, fixture-by-
  fixture risk table, ranked migration checklist, open questions for the
  merchant/developer. Greyscale-readable risk badges. Server-rendered to a
  `Buffer` on demand.
- Prisma `AuditPurchase` + `AuditReport` (additive, migration
  `slice4_audit_report`). The structured `AuditSnapshot` is the source of
  truth — PDFs are re-rendered on every download for the 12-month
  re-download window (no fragile binary blobs in SQLite).
- Tests: 130 total across 13 files. Risk scorer 15 (golden-cases for each
  category + grading edge cases). PDF 5 (JSX-tree snapshot, section
  ordering, header content, XSS/HTML-escape contract, empty state). Charge
  flow 9 (acts only on ACTIVE/ACCEPTED, refuses non-audit SKUs, propagates
  `billing.request` redirect).
- Dashboard CTA promoted from disabled placeholder to live `Run migration
  audit` button. Nav link added.

**Scopes (unchanged)**

`read_orders, read_products, read_discounts, read_locations, read_shipping`.
Managed Billing is a separate plane — no scope changes for the audit charge.

## Slice 5 status — Functions output capture

**What works in this slice**

- **Verified 2026-04 Functions API surface**: the `shopifyFunctions`
  connection EXISTS for discovery (id, title, apiType, apiVersion,
  app.title), but Shopify exposes **no Admin API test-invocation surface**
  in 2026-04. The only execution path is the local CLI
  (`shopify app function run`), which a hosted app cannot reach. Per the
  roadmap's "Technical reality check", Slice 5 falls back to live
  observation of post-deployment orders.
- Discovery via `app/lib/shopify/functions.ts`: paginated query with
  per-Function category mapping (`discounts → discount`,
  `delivery_customization → shipping`, `payment_customization → payment`,
  `cart_transform → other`, etc.). Order matters — `shipping_discounts`
  is a SHIPPING-family apiType in 2026-04 and is correctly classified.
  Typed `FunctionsAccessDeniedError` so the route can surface the exact
  remediation if scope review is needed.
- Capture runner in `app/lib/functions/store.server.ts`: pulls the last 14
  days of orders via the existing Slice 3 client, runs the same
  `extractFromOrder` + signature, and persists a `FunctionOutput` row per
  source order. Idempotent: keyed on
  `(shopDomain, fixtureSignature, sourceOrderGid)` so re-runs never
  duplicate. Per-row attribution is heuristic by outcome shape (discount
  delta → discount Function; else shipping → shipping Function; else
  payment → payment Function; else null).
- Embedded `/app/functions` route: Discover button, Capture button (last
  14 days), installed/removed Function lists with per-row capture counts,
  and a capture-run history. Plus-only gate enforced on every loader and
  action. Nav link added.
- Additive Prisma models: `DiscoveredFunction`, `CaptureRun`,
  `FunctionOutput` (migration `slice5_functions_capture`). Cascade delete
  from `Shop`. Soft-delete semantics on `DiscoveredFunction` — when a
  Function disappears from discovery we set `uninstalledAt` rather than
  deleting the row, so historical attributions stay readable.
- Tests: 146 total across 15 files (was 130). Functions client 9 (apiType
  mapping including the `shipping_discounts` ordering edge case, paginated
  cursor, access-denied handling, schema-drift defense, empty result).
  Persistence round-trip 7 (upsert + uninstall lifecycle, attribution map,
  per-order persistence + idempotent re-run, empty-shop graceful fallback,
  cross-shop scoping).

**Scopes (unchanged)**

`read_orders, read_products, read_discounts, read_locations, read_shipping`.
The `shopifyFunctions` query was attempted under existing read scopes; if
production install reveals a scope rejection, the route surfaces a clear
`FunctionsAccessDeniedError` for follow-up rather than a blank list.

**Honest limitation**

Without a Shopify-side test-invocation API, we cannot generate Function
output for arbitrary "what-if" cart inputs. We only observe what *actually
fired* in the merchant's recent production orders. Slice 6 will diff these
observed outputs against the Slice 3 `FixtureBaseline` (Script-era) rows by
matching `fixtureSignature`. If a fixture has a baseline but no captured
Function output, the diff will surface that as "untested in production —
needs a synthetic order before cutover."

## Slice 6 status — Diff engine + drift alerts

**What works in this slice**

- **Pure diff engine** in `app/lib/audit/diff-engine.ts`. Joins
  `FixtureBaseline` (Slice 3 Script-era) to `FunctionOutput` (Slice 5
  Function-era) by `fixtureSignature`. Per-category severity rules
  (discount, shipping, payment, totals); fixture-level grade is the
  highest per-category severity. Deterministic — same input always yields
  byte-identical output. Sorted critical → warning → info.
- **Severity thresholds** (from the diff-engine module header):
  - Discount: >$1 absolute AND >10% relative → critical; >$0.50 + >5% →
    warning; smaller delta → info; exact → no drift.
  - Shipping: rate disappeared in output → critical; amount delta >$1 →
    critical; rename only → warning; new rate appeared → info; equal → no drift.
  - Payment: gateway disappeared → critical; gateway appeared → info;
    same set → no drift.
  - Cart total: >5% + >$1 → warning; smaller delta → info; equal → no drift.
- **Match and untested-in-production** counts surface in DiffStats but are
  NOT alerts. The "missing" list (fixtures with a baseline but no
  captured Function output) lands in the PDF as an explainer line.
- **Additive Prisma models**: `DriftRun` + `DriftResult` (migration
  `slice6_diff_engine`). Cascade from `Shop`. Counts denormalised onto
  `DriftRun` for fast list rendering.
- **`/app/drift` route**: Plus-only gate, "Run diff" button, latest run
  with per-fixture cards (severity badge, categories, message,
  recommendation, baseline vs output side-by-side), historical runs list.
- **Audit integration**: the audit-generate action runs the diff before
  saving the snapshot, so the merchant's PDF includes a Drift Alerts
  section (between Fixtures and Migration Checklist). If the diff fails,
  the audit still succeeds with `drift: null` and the route surfaces a
  clear re-run path on `/app/drift`.
- **Tests** (176 total, was 146): diff engine 23 (golden cases for every
  severity threshold + multi-category resolution + missing-output
  fallback + determinism), drift persistence 5 (DriftRun lifecycle, sort
  order, latest run lookup), PDF snapshot refreshed and 2 new sections
  asserted.

**Scopes (unchanged)**

`read_orders, read_products, read_discounts, read_locations, read_shipping`.
The diff engine touches no Shopify endpoints — it operates entirely on
locally-stored Slice 3 + Slice 5 data.

## Slice 7 status — Pre-launch UX polish

> **Framing note.** Two slices were both labelled "Slice 7" during the
> build. The first is **pre-launch productization polish** of Slices 1–6
> (this section). The second is the roadmap's actual Slice 7 — the
> Continuous Regression Suite ($149/mo recurring product) — which has now
> also shipped on the `slice-7-regression-suite` branch (subscription
> gating, cron handler, drift-alert email rendering, regression
> dashboard). See the "Slice 7 — Continuous Regression Suite" section
> below for what landed and the deliberate scope reductions.

**What works in this slice**

- **Six-step dashboard stepper** at `/app` showing real progress across
  Slices 2–6: scripts inventoried · fixtures generated · audit purchased ·
  Functions discovered · outputs captured · drift run. Each step pulls
  honest state from Prisma; per-step status badge, primary CTA, and a
  one-line state hint.
- **Recent-activity panel** on the dashboard surfaces the latest drift
  run with critical/warning/info badge counts and the latest audit
  purchase with its 12-month re-download window.
- **Toasts on the audit, Functions, and drift routes** via App Bridge
  (audit generate, Functions discover/capture, drift run). Errors
  surface as `isError: true` toasts so the merchant always knows whether
  the click did something. Paste-script and fixture-generate routes
  still rely on Polaris banners and were not updated in this slice.
- **Per-route error boundaries** — `/app/audit`, `/app/functions`,
  `/app/drift` now export their own `ErrorBoundary` so a thrown
  Response in a loader/action surfaces an embedded-app-aware error UI
  instead of Remix's default white-screen.
- **Friendly `FunctionsAccessDeniedError` banner** — when Shopify
  rejects the `shopifyFunctions` discovery query on scope grounds, the
  Functions route now renders a Polaris `Banner` with a clear next step
  (re-install / contact support), rather than burying the error in a
  toast.
- **Reusable empty-state component** (`app/components/SentinelEmptyState.tsx`)
  + shared polish helpers (`app/lib/ui/polish-helpers.tsx`) for severity
  badges, count-line formatters, and date/money rendering. Centralises
  drift-severity → Polaris-tone mapping and risk-grade pill colours.
- **PDF polish**: executive summary now leads with an honest one-line
  risk profile (`X high-risk · Y medium · Z low · W needs review`), no
  fabricated 0-100 score. Footer updated to `Generated by Script
  Sentinel · <shop> · <date> · valid for re-download for 12 months`.
- **Tests**: 188 total across 18 files (was 176 before Slice 7). 12 new
  polish-helper UI contract tests cover severity-tone mapping,
  risk-grade tone, count-line formatters, and the SentinelEmptyState
  component. PDF snapshot refreshed; section ordering and Drift Alerts
  assertions still pass.

**What this slice deliberately does NOT include**

- **Continuous regression cron** ($149/mo recurring product) — covered
  in the separate Slice 7 — Continuous Regression Suite section below;
  not part of this polish slice.
- **App Store submission readiness** — the README mentions screenshots
  + demo script in case you draft listing copy now, but we still need
  the GDPR mandatory webhooks (`customers/data_request`,
  `customers/redact`, `shop/redact`), the Built-for-Shopify Lighthouse
  pass, and the App Store listing assets. That's roadmap Slice 9.
- **No new dependencies, no new scopes, no breaking changes.**

## Slice 7 status — Continuous Regression Suite ($149/mo)

The roadmap's actual Slice 7 — the recurring product. Lives on the
`slice-7-regression-suite` branch.

**What works in this slice**

- **Subscription billing** via Shopify Managed Billing for the existing
  `REGRESSION_SUITE_DISCOUNT` ($149/mo) and `REGRESSION_SUITE_ALL`
  ($299/mo) catalog entries. New `app/lib/billing/subscription.ts`
  wraps `billing.request` / `billing.check` for the recurring SKUs and
  exposes a `gateRegressionHistory` helper for free-tier history gating
  on the dashboard.
- **Cron handler** at `GET /api/cron/regression`, authenticated by an
  `Authorization: Bearer ${CRON_SECRET}` header. Per-shop subscription
  check via `unauthenticated.admin(shop)` so unsubscribed shops are
  skipped, then re-runs the Slice 6 diff and persists a
  `RegressionRun` + any new `DriftAlert` rows.
- **Drift-alert email template** rendered to inline-styled HTML via
  `renderToStaticMarkup` (no React Email dependency added). The cron
  renders the email and logs it; actual delivery is wired by the
  deployer's mail provider.
- **Regression dashboard** at `/app/regression` with paywall cards for
  the recurring SKUs, subscription-gated history (free users see only
  the most recent run / 7-day window), manual "Run regression now"
  trigger that's also gated behind an active subscription.
- **Tests**: 32 new across 4 files (221 total, was 189 after polish).
  Includes the load-bearing invariant: a critical drift that stays
  critical across two runs does NOT re-emit a DriftAlert.

**What this slice deliberately does NOT include**

- **Real email delivery.** The cron renders the email and persists the
  alert rows; wiring a sender (Resend / SES / SendGrid) is a deployer
  choice and was kept out of this slice.
- **Capture refresh from cron.** The diff itself runs against persisted
  capture data and is the load-bearing recurring value; recapturing
  Function outputs from a cron context needs offline-token admin
  clients and was deferred.
- **Weekly fixture refresh.** Mentioned in the roadmap; tracked as a
  separate cron with the same secret pattern, not landed here.

### Suggested App Store listing copy (draft, not yet submitted)

These are seeds for when Slice 9 actually goes live. The product is not
yet App-Store-ready (GDPR webhooks + listing review pending), so don't
publish these as-is.

- **Screenshot 1** — Dashboard with the six-step stepper showing all
  steps complete and the recent-activity panel with a "0 critical"
  drift summary. Headline: *"Six steps from install to a Migration Risk
  PDF."*
- **Screenshot 2** — Scripts page with three pasted Shopify Scripts and
  classifier badges (Discount Logic, Shipping Rule, B2B Logic).
  Headline: *"Paste your Ruby Scripts. We classify them in 30 seconds."*
- **Screenshot 3** — Fixtures page with 47 deduped representative carts
  showing market badges (USD/US, EUR/DE) and observation counts.
  Headline: *"60 days of orders, deduped into representative cart
  fixtures. PII stripped at storage."*
- **Screenshot 4** — Audit PDF first page (shop name + executive
  summary + top risks). Headline: *"Migration Risk Audit · $199. Your
  developer reads it; your migration de-risks itself."*
- **Screenshot 5** — Drift alerts page with three alert cards
  (critical/warning/info) showing baseline-vs-output side-by-side.
  Headline: *"Drift detected before customers find it."*

**60-second demo script (rough draft):**
*"This is Script Sentinel for Shopify Plus. (clicks dashboard) Six steps:
inventory your Scripts, generate fixtures from order history,
buy + run an audit, discover deployed Functions, capture outputs, run
drift. (clicks Scripts) Pastes a Ruby Script — classifier sees `customer.tags.include?` and grades it B2B. (clicks Fixtures) 60 days of
orders deduped into 47 fixtures, no PII. (clicks Audit) $199, paid via
Shopify Managed Billing. (clicks Drift) Function output captured for
12 of 47 fixtures — one critical drift on the BFCM SAVE10 code. (closes
PDF) Done. Read-only the whole way through."*

## Local setup

You need:

- Node `>=20.19 <22 || >=22.12` (matches the template's `engines`)
- A Shopify Partners account
- The Shopify CLI (`npm install -g @shopify/cli @shopify/theme`) — required for
  `npm run dev`, OAuth tunneling, and `shopify app deploy`. Not needed for
  `npm test` / `npm run typecheck`.
- A Plus development store in your Partner organization (request via Partners
  → Stores → Add development store → Plus). Without one you can't install the app
  end-to-end, but you can still run all unit/static checks below.

```bash
npm install
npx prisma generate
npx prisma migrate dev --name init    # creates dev.sqlite
npm run typecheck                     # type-check the whole app
npm test                              # vitest run
```

To bring the embedded app up against a real Plus dev store:

```bash
npm run config:link                   # creates / links a Partners app
npm run dev                           # `shopify app dev` opens an admin install URL
```

The CLI prints an install URL — open it in the dev store and approve the OAuth scopes.
On install you should land on `/app`, see the dashboard with a green "Shopify Plus"
badge, and a disabled "Run migration audit" button. Installing on a non-Plus store
should render the gate copy instead.

### What still requires Shopify Partner / dev-store setup

- **End-to-end OAuth install verification** (Plus and non-Plus). Needs a Partners
  app + at least one Plus dev store, plus a non-Plus dev store (Basic / Starter)
  to confirm the gate.
- **Live billing flow** ($199 one-time charge, $149/mo subscription). Managed
  Billing requires a real Shopify charge confirmation in a dev store; the test
  harness only verifies the static config shape.
- **Webhook delivery** — the uninstall handler is unit-tested, but verifying real
  HMAC signing requires uninstalling the app from the dev store admin and
  watching the webhook log.

These are documented blockers; everything they verify has been simulated by tests
where practical. Run `npm test` for the verifiable surface; run `npm run dev` for
the parts that need Shopify-issued credentials.

## Constraints (non-negotiable)

- **Plus-only.** Non-Plus shops hit the gate copy and stop.
- **Read-only forever.** No `write_*` scopes anywhere. Any feature request that
  requires writing to checkout / discounts / Scripts / Functions is out of scope.
- **No Script-to-Function auto-conversion.** We tell merchants what to test, not
  how to convert.
- **No discount-builder UI.**
- **Shopify only.**
- **Conservative PII.** Slice 3 strips customer names / emails / phones /
  addresses from fixtures. Slice 1 doesn't store any PII.
