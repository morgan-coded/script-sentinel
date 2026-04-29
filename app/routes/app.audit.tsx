import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  EmptyState,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { upsertShopFromPlan } from "../lib/shopify/shop.server";
import { BILLING_PRODUCTS, formatPrice } from "../lib/billing/products";
import {
  AUDIT_PLAN_KEYS,
  findActiveAuditPurchase,
  isAuditPlanKey,
  scopeForPlan,
  startAuditCharge,
  type AuditPlanKey,
  type BillingApi,
} from "../lib/billing/charge.server";
import {
  buildAuditSnapshot,
  type AuditSnapshot,
  type ScorerFixture,
  type ScorerScript,
} from "../lib/audit/risk-scorer";
import {
  getActivePurchase,
  recordActivePurchase,
  saveAuditReport,
} from "../lib/audit/store.server";
import { listScripts } from "../lib/shopify/scripts";
import { listFixtures } from "../lib/fixtures/store.server";
import { runDriftAndPersist } from "../lib/audit/diff-runner.server";
import { NON_PLUS_GATE_MESSAGE } from "../lib/shopify/plan-copy";

/**
 * Slice 4 — Migration Risk Audit. The $199 / $499 cash-gate route.
 *
 * Flow:
 *   1. Loader checks Plus + active purchase. If no purchase, render paywall.
 *   2. Paywall action calls Shopify Managed Billing → throws redirect to
 *      Shopify's confirmation URL.
 *   3. Shopify returns merchant to /app/audit. Loader detects the active
 *      purchase via billing.check, persists it, renders the "Generate" UI.
 *   4. Generate action assembles Scripts + Fixtures, runs the risk scorer,
 *      saves the snapshot, and redirects to /app/audit.
 *   5. Download action renders the persisted snapshot to PDF on demand.
 */

const APP_AUDIT_PATH = "/app/audit";

type AuditView =
  | { state: "non-plus"; planDisplayName: string | null }
  | {
      state: "paywall";
      products: Array<{
        key: AuditPlanKey;
        displayName: string;
        priceLabel: string;
        description: string;
      }>;
      scriptCount: number;
      fixtureCount: number;
    }
  | {
      state: "ready";
      activePlan: AuditPlanKey;
      scriptCount: number;
      fixtureCount: number;
      reports: Array<{
        id: string;
        scope: "single" | "multi";
        scriptCount: number;
        fixtureCount: number;
        highRiskCount: number;
        generatedAt: string;
        filename: string;
      }>;
    };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  await upsertShopFromPlan(session.shop, plan);

  if (!plan.isPlus) {
    return {
      view: {
        state: "non-plus" as const,
        planDisplayName: plan.publicDisplayName,
      },
    };
  }

  const isTest = plan.isDevelopment;
  const purchase = await findActiveAuditPurchase(billing as unknown as BillingApi, { isTest });

  if (purchase) {
    // Mirror Shopify's purchase state into our cache so the dashboard /
    // download paths don't need a billing round-trip.
    const recorded = await recordActivePurchase(session.shop, {
      plan: purchase.plan,
      shopifyChargeGid: purchase.shopifyChargeGid,
      isTest: purchase.test,
    });
    void recorded; // Kept for the side effect; id not needed in the loader.

    // Strict 12-month paid-access window: only surface reports whose parent
    // AuditPurchase is still ACTIVE and inside its expiresAt window. Reports
    // tied to refunded, expired, or otherwise non-active purchases are
    // filtered out at the database boundary so the UI never offers a
    // Download button the action would 403 against.
    const now = new Date();
    const [scripts, fixtures, reports] = await Promise.all([
      listScripts(session.shop),
      listFixtures(session.shop),
      db.auditReport.findMany({
        where: {
          shopDomain: session.shop,
          purchase: {
            status: "active",
            expiresAt: { gt: now },
          },
        },
        orderBy: { generatedAt: "desc" },
      }),
    ]);
    return {
      view: {
        state: "ready" as const,
        activePlan: purchase.plan,
        scriptCount: scripts.length,
        fixtureCount: fixtures.length,
        reports: reports.map((r) => ({
          id: r.id,
          scope: (r.scope === "multi" ? "multi" : "single") as "single" | "multi",
          scriptCount: r.scriptCount,
          fixtureCount: r.fixtureCount,
          highRiskCount: r.highRiskCount,
          generatedAt: r.generatedAt.toISOString(),
          filename: r.filename,
        })),
      },
    };
  }

  const [scripts, fixtures] = await Promise.all([
    listScripts(session.shop),
    listFixtures(session.shop),
  ]);
  return {
    view: {
      state: "paywall" as const,
      products: AUDIT_PLAN_KEYS.map((key) => ({
        key,
        displayName: BILLING_PRODUCTS[key].displayName,
        priceLabel: formatPrice(BILLING_PRODUCTS[key]),
        description: BILLING_PRODUCTS[key].description,
      })),
      scriptCount: scripts.length,
      fixtureCount: fixtures.length,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  if (!plan.isPlus) {
    throw new Response("Plus required", { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "purchase") {
    const planKeyRaw = String(formData.get("plan") ?? "");
    if (!isAuditPlanKey(planKeyRaw)) {
      return { error: "Pick a valid audit plan." };
    }
    const url = new URL(request.url);
    const returnUrl = `${url.origin}${APP_AUDIT_PATH}`;
    // billing.request throws a Response (303 redirect to Shopify confirmation
    // URL) on success. Our type cast keeps the shopify-app-remix ergonomics
    // local while routing through our charge wrapper.
    return startAuditCharge(billing as unknown as BillingApi, {
      plan: planKeyRaw,
      returnUrl,
      isTest: plan.isDevelopment,
    });
  }

  if (intent === "generate") {
    const purchase = await findActiveAuditPurchase(billing as unknown as BillingApi, {
      isTest: plan.isDevelopment,
    });
    if (!purchase) {
      throw new Response("No active audit purchase", { status: 402 });
    }
    const recorded = await recordActivePurchase(session.shop, {
      plan: purchase.plan,
      shopifyChargeGid: purchase.shopifyChargeGid,
      isTest: purchase.test,
    });
    const cached = await getActivePurchase(session.shop);
    const purchaseId = recorded.id ?? cached?.id;
    if (!purchaseId) {
      throw new Response("Purchase record missing", { status: 500 });
    }
    const [scriptRows, fixtureRows] = await Promise.all([
      listScripts(session.shop),
      listFixtures(session.shop),
    ]);
    const scripts: ScorerScript[] = scriptRows.map((s) => ({
      id: s.id,
      title: s.title,
      scriptType: s.scriptType,
      source: s.source,
      isActive: s.isActive,
      classification: {
        autoCategory: s.classification.autoCategory,
        autoConfidence: s.classification.autoConfidence,
        autoSignals: s.classification.autoSignals,
        overrideCategory: s.classification.overrideCategory,
      },
    }));
    const fixtures: ScorerFixture[] = fixtureRows.map((f) => ({
      id: f.id,
      signature: f.signature,
      presentmentCurrency: f.presentmentCurrency,
      shippingCountryCode: f.shippingCountryCode,
      customerTags: f.customerTags,
      marketSignature: f.marketSignature,
      observationCount: f.observationCount,
      cartTotal: f.cartTotal,
      baseline: f.baseline
        ? {
            totalDiscountAmount: f.baseline.totalDiscountAmount,
            discountApplications: (f.baseline.discountApplications as Array<{
              type?: string;
              code?: string | null;
            }>) ?? [],
            shippingRateCode: f.baseline.shippingRateCode,
            shippingRateAmount: f.baseline.shippingRateAmount,
            paymentGatewayNames: f.baseline.paymentGatewayNames,
          }
        : null,
    }));
    // Slice 6 — run the diff engine BEFORE building the snapshot so the PDF
    // includes the Drift Alerts section. Failures here don't block the
    // audit (the merchant has already paid); we just attach a null `drift`
    // and surface the error in the route response. Diff itself is pure;
    // the persistence layer marks the run failed if it throws.
    const driftAt = new Date().toISOString();
    let driftSummary: Parameters<typeof buildAuditSnapshot>[0]["drift"] = undefined;
    try {
      const outcome = await runDriftAndPersist(session.shop);
      driftSummary = {
        generatedAt: driftAt,
        examined: outcome.diff.stats.fixturesExamined,
        matched: outcome.diff.stats.match,
        missing: outcome.diff.stats.missing,
        drift: outcome.diff.stats.drift,
        critical: outcome.diff.stats.critical,
        warning: outcome.diff.stats.warning,
        info: outcome.diff.stats.info,
        alerts: outcome.diff.results,
        missingSignatures: outcome.diff.missingSignatures,
      };
    } catch (err) {
      // Swallow — the snapshot still gets a `drift: null` and the merchant
      // can re-run from /app/drift afterward.
      driftSummary = undefined;
      console.warn("Drift run failed during audit generate:", err);
    }
    const snapshot = buildAuditSnapshot({
      shopName: plan.shopName ?? session.shop,
      shopDomain: session.shop,
      planDisplayName: plan.publicDisplayName,
      scripts,
      fixtures,
      scope: scopeForPlan(purchase.plan),
      generatedAt: new Date().toISOString(),
      drift: driftSummary,
    });
    await saveAuditReport({ shopDomain: session.shop, purchaseId, snapshot });
    return { ok: true as const };
  }

  if (intent === "download") {
    const reportId = String(formData.get("reportId") ?? "");
    // Strict access gate: load the report WITH its parent AuditPurchase and
    // refuse the download unless the purchase is still ACTIVE and inside
    // its 12-month re-download window. The report row alone isn't enough —
    // we retain rows indefinitely for record-keeping but only honour
    // downloads while the purchase is in good standing.
    const reportRow = await db.auditReport.findFirst({
      where: { id: reportId, shopDomain: session.shop },
      include: { purchase: true },
    });
    if (!reportRow) {
      throw new Response("Report not found", { status: 404 });
    }
    const purchase = reportRow.purchase;
    if (
      !purchase ||
      purchase.status !== "active" ||
      !purchase.expiresAt ||
      purchase.expiresAt < new Date()
    ) {
      throw new Response(
        "This audit report has expired or is no longer active. Please purchase a new audit to generate a fresh report.",
        { status: 403 },
      );
    }
    let snapshot: AuditSnapshot;
    try {
      snapshot = JSON.parse(reportRow.snapshot) as AuditSnapshot;
    } catch {
      throw new Response("Audit snapshot corrupted; cannot render.", {
        status: 500,
      });
    }
    // Lazy-import the renderer so the @react-pdf/renderer chunk only enters
    // the SSR bundle when a download is actually requested. Keeps the rest
    // of the app snappy.
    const { renderAuditReport } = await import("../lib/pdf/render.server");
    const pdf = await renderAuditReport(snapshot);
    // Buffer is not directly assignable to BodyInit on some Node typings;
    // a Uint8Array view is universally accepted by `new Response()`.
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${reportRow.filename}"`,
        "Cache-Control": "private, max-age=0, must-revalidate",
      },
    });
  }

  return { error: "Unknown intent." };
};

export default function Audit() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const view = data.view;

  if (view.state === "non-plus") {
    return (
      <Page>
        <TitleBar title="Migration Risk Audit" />
        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingLg">
              Shopify Plus required
            </Text>
            <Text as="p" variant="bodyMd">
              {NON_PLUS_GATE_MESSAGE}
            </Text>
          </BlockStack>
        </Card>
      </Page>
    );
  }

  if (view.state === "paywall") {
    return (
      <Page>
        <TitleBar title="Migration Risk Audit" />
        <BlockStack gap="500">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Pick your audit
              </Text>
              <Text as="p" variant="bodyMd">
                The audit combines your inventoried Scripts ({view.scriptCount}) and
                cart fixtures ({view.fixtureCount}) into a Migration Risk PDF —
                graded by risk band, with an ordered migration checklist and the
                top open questions for your developer or agency.
              </Text>
              <BlockStack gap="200">
                {view.products.map((product) => (
                  <Card key={product.key}>
                    <BlockStack gap="200">
                      <InlineStack gap="200" blockAlign="center" align="space-between">
                        <Text as="h3" variant="headingMd">
                          {product.displayName}
                        </Text>
                        <Badge tone="info">{product.priceLabel}</Badge>
                      </InlineStack>
                      <Text as="p" variant="bodyMd" tone="subdued">
                        {product.description}
                      </Text>
                      <Form method="post">
                        <input type="hidden" name="intent" value="purchase" />
                        <input type="hidden" name="plan" value={product.key} />
                        <Button submit variant="primary" loading={submitting}>
                          Buy {product.priceLabel} via Shopify
                        </Button>
                      </Form>
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
              <Text as="p" variant="bodySm" tone="subdued">
                Charges are billed through Shopify Managed Billing — the audit is
                paid-only because the deliverable PDF IS the product. No subscription, no trial.
              </Text>
            </BlockStack>
          </Card>
        </BlockStack>
      </Page>
    );
  }

  // view.state === "ready"
  return (
    <Page>
      <TitleBar title="Migration Risk Audit" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center" align="space-between">
                <Text as="h2" variant="headingMd">
                  {BILLING_PRODUCTS[view.activePlan].displayName} active
                </Text>
                <Badge tone="success">Paid</Badge>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                Source data: {view.scriptCount} scripts · {view.fixtureCount} fixtures.
                Re-runs are free for 12 months — the deliverable freezes the data at
                generation time so you can re-download identical PDFs.
              </Text>
              <InlineStack gap="200">
                <Form method="post">
                  <input type="hidden" name="intent" value="generate" />
                  <Button submit variant="primary" loading={submitting}>
                    Generate audit
                  </Button>
                </Form>
              </InlineStack>
            </BlockStack>
          </Card>

          <Box paddingBlockStart="500">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Reports
                </Text>
                {view.reports.length === 0 ? (
                  <EmptyState heading="No reports yet" image="">
                    <p>Click "Generate audit" to produce your first Migration Risk PDF.</p>
                  </EmptyState>
                ) : (
                  <BlockStack gap="200">
                    {view.reports.map((report) => (
                      <Card key={report.id}>
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center" align="space-between">
                            <Text as="span" variant="bodyMd">
                              {report.filename}
                            </Text>
                            <InlineStack gap="200" blockAlign="center">
                              <Badge tone="info">{report.scope === "multi" ? "All families" : "Single family"}</Badge>
                              <Form method="post">
                                <input type="hidden" name="intent" value="download" />
                                <input type="hidden" name="reportId" value={report.id} />
                                <Button submit loading={submitting}>
                                  Download PDF
                                </Button>
                              </Form>
                            </InlineStack>
                          </InlineStack>
                          <Text as="span" variant="bodySm" tone="subdued">
                            Generated {report.generatedAt.slice(0, 10)} · {report.scriptCount}{" "}
                            scripts · {report.fixtureCount} fixtures · {report.highRiskCount} high
                            risk
                          </Text>
                        </BlockStack>
                      </Card>
                    ))}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
