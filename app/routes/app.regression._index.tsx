import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "@remix-run/react";
import { useEffect } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-remix/server";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { upsertShopFromPlan } from "../lib/shopify/shop.server";
import { NON_PLUS_GATE_MESSAGE } from "../lib/shopify/plan-copy";
import { BILLING_PRODUCTS, formatPrice } from "../lib/billing/products";
import {
  findActiveSubscription,
  gateRegressionHistory,
  isSubscriptionPlanKey,
  startSubscription,
  SUBSCRIPTION_PLAN_KEYS,
  type SubscriptionBillingApi,
  type SubscriptionPlanKey,
} from "../lib/billing/subscription";
import {
  listAlertsForRun,
  listRegressionRuns,
} from "../lib/regression/store.server";
import { listDriftResultsForRun } from "../lib/audit/store.server";
import { runRegressionForShop } from "../lib/regression/runner.server";
import { SentinelEmptyState } from "../components/SentinelEmptyState";

const APP_REGRESSION_PATH = "/app/regression";

type RunRow = {
  id: string;
  trigger: "cron" | "manual";
  status: string;
  startedAt: string;
  finishedAt: string | null;
  fixturesExamined: number;
  driftCount: number;
  criticalCount: number;
  warningCount: number;
  newCriticalCount: number;
  newWarningCount: number;
};

type AlertRow = {
  id: string;
  fixtureSignature: string;
  severity: "critical" | "warning";
  previousSeverity: "critical" | "warning" | "info" | "none";
  summary: string;
  createdAt: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session, billing } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  await upsertShopFromPlan(session.shop, plan);

  if (!plan.isPlus) {
    return {
      isPlus: false as const,
      planDisplayName: plan.publicDisplayName,
    };
  }

  const subscription = await findActiveSubscription(
    billing as unknown as SubscriptionBillingApi,
    { isTest: plan.isDevelopment },
  );
  const allRuns = await listRegressionRuns(session.shop, { limit: 60 });
  const visibleRuns = gateRegressionHistory(allRuns, {
    hasActiveSubscription: subscription !== null,
  });
  const latestRun = visibleRuns[0] ?? null;
  const latestAlerts = latestRun
    ? await listAlertsForRun(session.shop, latestRun.id)
    : [];

  // Segment breakdown for the latest run. Pulls DriftResult rows
  // for the latest DriftRun and slices by `categories` membership. Only one
  // query (latest run); trend rows stay denormalised.
  let latestSegments = { b2bCritical: 0, b2bWarning: 0, marketCritical: 0, marketWarning: 0 };
  if (latestRun?.driftRunId) {
    const results = await listDriftResultsForRun(session.shop, latestRun.driftRunId);
    for (const r of results) {
      if (r.severity !== "critical" && r.severity !== "warning") continue;
      const isCritical = r.severity === "critical";
      if (r.categories.includes("b2b")) {
        if (isCritical) latestSegments.b2bCritical++;
        else latestSegments.b2bWarning++;
      }
      if (r.categories.includes("market")) {
        if (isCritical) latestSegments.marketCritical++;
        else latestSegments.marketWarning++;
      }
    }
  }

  return {
    isPlus: true as const,
    planDisplayName: plan.publicDisplayName,
    subscription: subscription
      ? {
          plan: subscription.plan,
          displayName: BILLING_PRODUCTS[subscription.plan].displayName,
          priceLabel: formatPrice(BILLING_PRODUCTS[subscription.plan]),
        }
      : null,
    products: SUBSCRIPTION_PLAN_KEYS.map((key) => ({
      key,
      displayName: BILLING_PRODUCTS[key].displayName,
      priceLabel: formatPrice(BILLING_PRODUCTS[key]),
      description: BILLING_PRODUCTS[key].description,
      trialDays: BILLING_PRODUCTS[key].trialDays,
    })),
    runs: visibleRuns.map(
      (r): RunRow => ({
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        fixturesExamined: r.fixturesExamined,
        driftCount: r.driftCount,
        criticalCount: r.criticalCount,
        warningCount: r.warningCount,
        newCriticalCount: r.newCriticalCount,
        newWarningCount: r.newWarningCount,
      }),
    ),
    totalRunCount: allRuns.length,
    visibleRunCount: visibleRuns.length,
    latestAlerts: latestAlerts.map(
      (a): AlertRow => ({
        id: a.id,
        fixtureSignature: a.fixtureSignature,
        severity: a.severity,
        previousSeverity: a.previousSeverity,
        summary: a.summary,
        createdAt: a.createdAt.toISOString(),
      }),
    ),
    latestSegments,
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

  if (intent === "subscribe") {
    const planKeyRaw = String(formData.get("plan") ?? "");
    if (!isSubscriptionPlanKey(planKeyRaw)) {
      return { error: "Pick a valid subscription plan." };
    }
    const url = new URL(request.url);
    return startSubscription(billing as unknown as SubscriptionBillingApi, {
      plan: planKeyRaw as SubscriptionPlanKey,
      returnUrl: `${url.origin}${APP_REGRESSION_PATH}`,
      isTest: plan.isDevelopment,
    });
  }

  if (intent === "run-now") {
    // Review-response: gate on-demand runs behind an active
    // subscription so the recurring product's value isn't reachable from
    // the free tier. Free users can still see the most-recent existing
    // run via the loader; they just can't trigger fresh ones.
    const subscription = await findActiveSubscription(
      billing as unknown as SubscriptionBillingApi,
      { isTest: plan.isDevelopment },
    );
    if (!subscription) {
      return {
        error:
          "Subscribe to the Regression Suite to run regressions on demand.",
      };
    }
    try {
      const outcome = await runRegressionForShop(session.shop, "manual");
      return {
        ok: true as const,
        summary: {
          newCritical: outcome.stats.newCritical,
          newWarning: outcome.stats.newWarning,
          drift: outcome.stats.drift,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Regression run failed: ${message}` };
    }
  }

  return { error: "Unknown intent." };
};

export default function RegressionIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const shopify = useAppBridge();

  useEffect(() => {
    if (!actionData) return;
    if ("ok" in actionData && actionData.ok === true) {
      const s = actionData.summary;
      const newAlerts = (s.newCritical ?? 0) + (s.newWarning ?? 0);
      shopify.toast.show(
        newAlerts > 0
          ? `Regression run complete — ${newAlerts} new alert${newAlerts === 1 ? "" : "s"}.`
          : "Regression run complete — no new alerts.",
      );
    } else if ("error" in actionData && actionData.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  if (!data.isPlus) {
    return (
      <Page>
        <TitleBar title="Regression Suite" />
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

  const { subscription, runs, latestAlerts, totalRunCount, visibleRunCount, latestSegments } = data;
  const gated = !subscription && totalRunCount > visibleRunCount;
  const latestRun = runs[0] ?? null;

  return (
    <Page>
      <TitleBar title="Regression Suite" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center" align="space-between">
                <Text as="h2" variant="headingMd">
                  Continuous regression
                </Text>
                {subscription ? (
                  <Badge tone="success">{`Subscribed · ${subscription.priceLabel}`}</Badge>
                ) : (
                  <Badge tone="attention">No subscription</Badge>
                )}
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                After cutover, Script Sentinel continues to diff your captured
                Function outputs against the fixture baselines. Subscribe to
                see full trend history and receive email alerts whenever a
                fixture's severity escalates.
              </Text>
              <InlineStack gap="200">
                <Form method="post">
                  <input type="hidden" name="intent" value="run-now" />
                  <Button submit variant="primary" loading={submitting}>
                    Run regression now
                  </Button>
                </Form>
              </InlineStack>
            </BlockStack>
          </Card>

          {!subscription ? (
            <Box paddingBlockStart="500">
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    Subscribe to the Regression Suite
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Free users see the most recent regression snapshot only;
                    history older than 7 days is gated. Subscribe for full
                    history, email drift alerts, and BFCM peace of mind.
                  </Text>
                  <BlockStack gap="200">
                    {data.products.map((product) => (
                      <Card key={product.key}>
                        <BlockStack gap="200">
                          <InlineStack gap="200" blockAlign="center" align="space-between">
                            <Text as="h4" variant="headingSm">
                              {product.displayName}
                            </Text>
                            <Badge tone="info">{product.priceLabel}</Badge>
                          </InlineStack>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {product.description}
                            {product.trialDays > 0
                              ? ` ${product.trialDays}-day trial.`
                              : ""}
                          </Text>
                          <Form method="post">
                            <input type="hidden" name="intent" value="subscribe" />
                            <input type="hidden" name="plan" value={product.key} />
                            <Button submit loading={submitting}>
                              Subscribe via Shopify
                            </Button>
                          </Form>
                        </BlockStack>
                      </Card>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            </Box>
          ) : null}

          <Box paddingBlockStart="500">
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="200" blockAlign="center" align="space-between">
                  <Text as="h3" variant="headingMd">
                    Regression trend
                  </Text>
                  {gated ? (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {`Showing ${visibleRunCount} of ${totalRunCount} runs · subscribe to unlock full history`}
                    </Text>
                  ) : null}
                </InlineStack>
                {runs.length === 0 ? (
                  <SentinelEmptyState
                    heading="No regression runs yet"
                    body="Click Run regression now to compute drift against your latest captured outputs, or wait for tonight's cron run."
                  />
                ) : (
                  <BlockStack gap="200">
                    {latestSegments &&
                    latestSegments.b2bCritical +
                      latestSegments.b2bWarning +
                      latestSegments.marketCritical +
                      latestSegments.marketWarning >
                      0 ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Latest run segment breakdown — B2B drift:{" "}
                        {latestSegments.b2bCritical} critical ·{" "}
                        {latestSegments.b2bWarning} warning. Market drift:{" "}
                        {latestSegments.marketCritical} critical ·{" "}
                        {latestSegments.marketWarning} warning.
                      </Text>
                    ) : null}
                    <List type="bullet">
                      {runs.map((r) => (
                        <List.Item key={r.id}>
                          <strong>{r.startedAt.slice(0, 10)}</strong> ·{" "}
                          {r.trigger} · {r.fixturesExamined} fixtures ·{" "}
                          {r.criticalCount} critical · {r.warningCount} warning ·{" "}
                          <em>
                            {r.newCriticalCount + r.newWarningCount} new alert
                            {r.newCriticalCount + r.newWarningCount === 1 ? "" : "s"}
                          </em>
                        </List.Item>
                      ))}
                    </List>
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Box>

          {latestRun && latestAlerts.length > 0 ? (
            <Box paddingBlockStart="500">
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {`New alerts on ${latestRun.startedAt.slice(0, 10)}`}
                  </Text>
                  <BlockStack gap="200">
                    {latestAlerts.map((a) => (
                      <Card key={a.id}>
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone={a.severity === "critical" ? "critical" : "warning"}>
                              {a.severity}
                            </Badge>
                            <Text as="span" variant="bodySm" tone="subdued">
                              was {a.previousSeverity}
                            </Text>
                          </InlineStack>
                          <Text as="p" variant="bodyMd">
                            {a.summary}
                          </Text>
                          <Text as="span" variant="bodySm" tone="subdued">
                            fixture {a.fixtureSignature.slice(0, 12)}…
                          </Text>
                        </BlockStack>
                      </Card>
                    ))}
                  </BlockStack>
                </BlockStack>
              </Card>
            </Box>
          ) : null}
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
