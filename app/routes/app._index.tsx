import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRouteError } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  Link as PolarisLink,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-remix/server";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { NON_PLUS_GATE_MESSAGE } from "../lib/shopify/plan-copy";
import {
  getLatestCharge,
  upsertShopFromPlan,
} from "../lib/shopify/shop.server";
import { BILLING_PRODUCTS, formatPrice } from "../lib/billing/products";
import { listScripts } from "../lib/shopify/scripts";
import { listFixtures } from "../lib/fixtures/store.server";
import {
  countAllFunctionOutputs,
  listDiscoveredFunctions,
} from "../lib/functions/store.server";
import {
  getActivePurchase,
  getLatestDriftRun,
} from "../lib/audit/store.server";
import { SentinelEmptyState } from "../components/SentinelEmptyState";
import {
  driftCountsLine,
  fmtDay,
} from "../lib/ui/polish-helpers";

/**
 * Dashboard.
 *
 * The dashboard is a six-step progress stepper that
 * mirrors the merchant's actual workflow: install → inventory scripts →
 * generate fixtures → buy + run audit → discover Functions → capture
 * outputs → run drift. Every step shows its own status (pending / done /
 * needs attention) computed from real database state — no fabricated
 * progress signals.
 *
 * Plus-gate is enforced before any data load so non-Plus shops get the
 * dedicated gate page rather than empty cards.
 */

type StepStatus = "todo" | "done" | "blocked";

type StepView = {
  number: number;
  title: string;
  description: string;
  status: StepStatus;
  /** Optional one-line state hint like "5 scripts inventoried". */
  stateHint?: string;
  /** Where the primary CTA points. */
  href: string;
  ctaLabel: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  const shop = await upsertShopFromPlan(session.shop, plan);
  if (!plan.isPlus) {
    return {
      isPlus: false as const,
      shopName: shop.shopName ?? plan.shopName ?? session.shop,
      shopDomain: session.shop,
      planDisplayName: plan.publicDisplayName,
    };
  }

  // Pull state from every prior slice so the stepper renders honest progress.
  const [
    charge,
    scripts,
    fixtures,
    functions,
    capturedOutputs,
    activePurchase,
    latestDrift,
  ] = await Promise.all([
    getLatestCharge(session.shop),
    listScripts(session.shop),
    listFixtures(session.shop),
    listDiscoveredFunctions(session.shop),
    countAllFunctionOutputs(session.shop),
    getActivePurchase(session.shop),
    getLatestDriftRun(session.shop),
  ]);

  return {
    isPlus: true as const,
    isDevelopment: plan.isDevelopment,
    shopDomain: session.shop,
    shopName: shop.shopName ?? plan.shopName ?? session.shop,
    planDisplayName: plan.publicDisplayName,
    counts: {
      scripts: scripts.length,
      activeScripts: scripts.filter((s) => s.isActive).length,
      fixtures: fixtures.length,
      functions: functions.filter((f) => !f.uninstalledAt).length,
      capturedOutputs,
    },
    auditProduct: {
      key: BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.key,
      displayName: BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.displayName,
      priceLabel: formatPrice(BILLING_PRODUCTS.MIGRATION_RISK_AUDIT),
      description: BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.description,
    },
    activePurchase: activePurchase
      ? {
          plan: activePurchase.planKey,
          activatedAt: activePurchase.activatedAt?.toISOString() ?? null,
          expiresAt: activePurchase.expiresAt?.toISOString() ?? null,
        }
      : null,
    latestCharge: charge
      ? {
          planKey: charge.planKey,
          status: charge.status,
          amount: charge.amount,
          currencyCode: charge.currencyCode,
          createdAt: charge.createdAt.toISOString(),
        }
      : null,
    drift: latestDrift
      ? {
          runId: latestDrift.run.id,
          startedAt: latestDrift.run.startedAt.toISOString(),
          status: latestDrift.run.status,
          fixturesExamined: latestDrift.run.fixturesExamined,
          critical: latestDrift.run.criticalCount,
          warning: latestDrift.run.warningCount,
          info: latestDrift.run.infoCount,
          match: latestDrift.run.matchCount,
          missing: latestDrift.run.missingCount,
        }
      : null,
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();

  if (!data.isPlus) {
    return <NonPlusGate planDisplayName={data.planDisplayName} />;
  }

  const steps: StepView[] = [
    {
      number: 1,
      title: "Inventory your Scripts",
      description:
        "Paste each Shopify Script's Ruby source. We classify it (discount, shipping, payment, market, B2B) so the audit targets real risks.",
      status: data.counts.scripts > 0 ? "done" : "todo",
      stateHint:
        data.counts.scripts > 0
          ? `${data.counts.scripts} script${data.counts.scripts === 1 ? "" : "s"} inventoried · ${data.counts.activeScripts} active`
          : undefined,
      href: "/app/scripts",
      ctaLabel: data.counts.scripts > 0 ? "Open script inventory" : "Add your first script",
    },
    {
      number: 2,
      title: "Generate cart fixtures",
      description:
        "Pull the last 60 days of orders and build a deduped library of representative carts. PII is stripped; optional name, email, phone, and address fields are not requested.",
      status: data.counts.fixtures > 0 ? "done" : "todo",
      stateHint:
        data.counts.fixtures > 0
          ? `${data.counts.fixtures} fixture${data.counts.fixtures === 1 ? "" : "s"} stored`
          : undefined,
      href: "/app/fixtures",
      ctaLabel: data.counts.fixtures > 0 ? "Open fixture library" : "Generate fixtures",
    },
    {
      number: 3,
      title: "Buy + run the migration audit",
      description: data.auditProduct.description,
      status: data.activePurchase ? "done" : "todo",
      stateHint: data.activePurchase
        ? `Active purchase · valid until ${fmtDay(data.activePurchase.expiresAt)}`
        : undefined,
      href: "/app/audit",
      ctaLabel: data.activePurchase
        ? "Open audit + download PDF"
        : `Run migration audit — ${data.auditProduct.priceLabel}`,
    },
    {
      number: 4,
      title: "Discover deployed Functions",
      description:
        "Once you've migrated a Script to a Shopify Function, we read it via the Admin API. No test-invocation surface exists in 2026-04, so we observe real production outputs instead.",
      status: data.counts.functions > 0 ? "done" : "todo",
      stateHint:
        data.counts.functions > 0
          ? `${data.counts.functions} Function${data.counts.functions === 1 ? "" : "s"} discovered`
          : undefined,
      href: "/app/functions",
      ctaLabel:
        data.counts.functions > 0 ? "Open Functions" : "Discover Functions",
    },
    {
      number: 5,
      title: "Capture Function outputs",
      description:
        "Pull recent post-deployment orders and persist the discount, shipping, and payment outcomes that fired during checkout. Step 6 diffs them against your fixture baselines.",
      status:
        data.counts.functions > 0 && data.counts.capturedOutputs > 0
          ? "done"
          : "todo",
      href: "/app/functions",
      ctaLabel: "Capture outputs",
    },
    {
      number: 6,
      title: "Run drift alerts",
      description:
        "Compare Script-era baselines against captured Function outputs. Per-fixture severity (critical / warning / info) surfaces regressions before customers find them.",
      status: data.drift ? "done" : "todo",
      stateHint: data.drift
        ? driftCountsLine(data.drift)
        : undefined,
      href: "/app/drift",
      ctaLabel: data.drift ? "Open drift alerts" : "Run drift",
    },
  ];

  const onboardingDone = steps.every((s) => s.status === "done");

  return (
    <Page>
      <TitleBar title="Script Sentinel" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingLg">
                    {data.shopName}
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone="success">Shopify Plus</Badge>
                    {data.isDevelopment ? <Badge tone="info">Development store</Badge> : null}
                    {data.planDisplayName ? (
                      <Text as="span" variant="bodySm" tone="subdued">
                        Plan: {data.planDisplayName}
                      </Text>
                    ) : null}
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    {data.shopDomain}
                  </Text>
                </BlockStack>

                {onboardingDone ? (
                  <Box>
                    <Badge tone="success">All steps complete</Badge>
                    <Box paddingBlockStart="200">
                      <Text as="p" variant="bodyMd">
                        You're set up end-to-end. Re-run drift periodically as
                        you ship Function changes; re-runs are free for the life
                        of your audit purchase.
                      </Text>
                    </Box>
                  </Box>
                ) : (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Six steps from install to a Migration Risk PDF. Work
                    top-down — each step shows its own progress in real time.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Box paddingBlockStart="500">
              <BlockStack gap="200">
                {steps.map((step) => (
                  <StepCard key={step.number} step={step} />
                ))}
              </BlockStack>
            </Box>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Recent activity
                  </Text>
                  {data.drift ? (
                    <BlockStack gap="100">
                      <Text as="span" variant="bodyMd" fontWeight="semibold">
                        Latest drift run
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {data.drift.startedAt.slice(0, 10)} ·{" "}
                        {data.drift.fixturesExamined} fixtures examined
                      </Text>
                      <InlineStack gap="100">
                        <Badge tone="critical">{`${data.drift.critical} critical`}</Badge>
                        <Badge tone="warning">{`${data.drift.warning} warning`}</Badge>
                        <Badge tone="info">{`${data.drift.info} info`}</Badge>
                      </InlineStack>
                      <Box paddingBlockStart="200">
                        <Button url="/app/drift" variant="plain">
                          View drift alerts
                        </Button>
                      </Box>
                    </BlockStack>
                  ) : (
                    <SentinelEmptyState
                      heading="No drift runs yet"
                      body="Drift alerts surface here once you've discovered Functions and run the diff engine."
                    />
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Audit purchase
                  </Text>
                  {data.activePurchase ? (
                    <BlockStack gap="100">
                      <Text as="span" variant="bodyMd">
                        {data.activePurchase.plan}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        Activated {fmtDay(data.activePurchase.activatedAt)} ·
                        valid until {fmtDay(data.activePurchase.expiresAt)}
                      </Text>
                      <Button url="/app/audit" variant="plain">
                        Open audit
                      </Button>
                    </BlockStack>
                  ) : data.latestCharge ? (
                    <BlockStack gap="100">
                      <Text as="span" variant="bodyMd">
                        {data.latestCharge.planKey}
                      </Text>
                      <InlineStack gap="200">
                        <Badge>{data.latestCharge.status}</Badge>
                        <Text as="span" variant="bodySm" tone="subdued">
                          ${data.latestCharge.amount} {data.latestCharge.currencyCode}
                        </Text>
                      </InlineStack>
                    </BlockStack>
                  ) : (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      No charges yet. The audit purchase appears here once
                      payment is initiated through Shopify Managed Billing.
                    </Text>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Build status
                  </Text>
                  <List>
                    <List.Item>App shell + Managed Billing</List.Item>
                    <List.Item>Script discovery (paste-based)</List.Item>
                    <List.Item>Cart fixture generation</List.Item>
                    <List.Item>Migration Risk Audit PDF</List.Item>
                    <List.Item>Functions output capture</List.Item>
                    <List.Item>Diff engine + drift alerts</List.Item>
                    <List.Item>Pre-launch UX polish</List.Item>
                    <List.Item>Drift Monitor ($149/mo)</List.Item>
                  </List>
                  <Text as="p" variant="bodySm" tone="subdued">
                    App Store launch surfaces include GDPR webhooks, privacy
                    links, and listing-ready support routes.
                  </Text>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function StepCard({ step }: { step: StepView }) {
  const tone =
    step.status === "done" ? "success" : step.status === "blocked" ? "critical" : "info";
  const label =
    step.status === "done" ? "Done" : step.status === "blocked" ? "Blocked" : "To do";
  return (
    <Card>
      <InlineStack gap="300" blockAlign="start" align="space-between" wrap={false}>
        <InlineStack gap="200" blockAlign="start" wrap={false}>
          <Box minWidth="32px">
            <Text as="span" variant="headingMd" tone="subdued">
              {step.number}.
            </Text>
          </Box>
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center">
              <Text as="h3" variant="headingMd">
                {step.title}
              </Text>
              <Badge tone={tone}>{label}</Badge>
            </InlineStack>
            <Text as="p" variant="bodyMd" tone="subdued">
              {step.description}
            </Text>
            {step.stateHint ? (
              <Text as="p" variant="bodySm" tone="subdued">
                {step.stateHint}
              </Text>
            ) : null}
          </BlockStack>
        </InlineStack>
        <Box minWidth="200px">
          <InlineStack align="end">
            <Button
              url={step.href}
              variant={step.status === "done" ? "secondary" : "primary"}
            >
              {step.ctaLabel}
            </Button>
          </InlineStack>
        </Box>
      </InlineStack>
    </Card>
  );
}

function NonPlusGate({ planDisplayName }: { planDisplayName: string | null }) {
  return (
    <Page>
      <TitleBar title="Script Sentinel" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingLg">
                Shopify Plus required
              </Text>
              <Text as="p" variant="bodyMd">
                {NON_PLUS_GATE_MESSAGE}
              </Text>
              {planDisplayName ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  Detected plan: {planDisplayName}
                </Text>
              ) : null}
              <Text as="p" variant="bodyMd">
                If you believe this is a mistake — for example, you upgraded to
                Plus very recently — uninstall and reinstall Script Sentinel so
                the plan check refreshes. To upgrade your store to Plus, contact{" "}
                <PolarisLink
                  url="https://www.shopify.com/plus/contact-sales"
                  target="_blank"
                  removeUnderline
                >
                  Shopify Plus sales
                </PolarisLink>
                .
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

/**
 * Friendly route-level error boundary. Without this, a thrown
 * error in the loader would render Remix's default white screen. Now we
 * surface a calm message + a link back to the dashboard.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  return boundary.error(error);
}
