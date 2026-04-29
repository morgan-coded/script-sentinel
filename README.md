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

**What this slice deliberately does NOT include**

- Functions output capture (Slice 5).
- Diff engine (Slice 6).
- Nightly regression cron, drift alerts (Slice 7).
- Multi-customization expansion (Slice 8).
- GDPR mandatory webhooks, App Store onboarding (Slice 9). The TOML keeps these
  webhook stubs commented out so we don't ship empty handlers.

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
