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
import { SentinelEmptyState } from "../components/SentinelEmptyState";
import { authenticate } from "../shopify.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { upsertShopFromPlan } from "../lib/shopify/shop.server";
import {
  getLatestDriftRun,
  listDriftRuns,
} from "../lib/audit/store.server";
import { runDriftAndPersist } from "../lib/audit/diff-runner.server";
import { NON_PLUS_GATE_MESSAGE } from "../lib/shopify/plan-copy";
import type { DriftSeverity } from "../lib/audit/diff-engine";

/**
 * Slice 6 — Drift alerts route.
 *
 * Plus-only gate enforced on every loader and action. "Run diff" recomputes
 * against the shop's current FixtureBaseline + FunctionOutput rows. No
 * external Shopify calls are made by this route — all data is already
 * captured locally by Slices 3 and 5.
 */

type DriftView = {
  isPlus: boolean;
  planDisplayName: string | null;
  latest: {
    runId: string;
    startedAt: string;
    finishedAt: string | null;
    status: string;
    fixturesExamined: number;
    matchCount: number;
    missingCount: number;
    driftCount: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    errorMessage: string | null;
    alerts: Array<{
      id: string;
      fixtureSignature: string;
      severity: string;
      categories: string[];
      message: string;
      recommendation: string;
      baseline: {
        totalDiscount: number;
        shippingCode: string | null;
        shippingAmount: number | null;
        paymentGateways: string[];
        cartTotal: number;
        presentmentCurrency: string;
      };
      output: {
        totalDiscount: number;
        shippingCode: string | null;
        shippingAmount: number | null;
        paymentGateways: string[];
        cartTotal: number;
        presentmentCurrency: string;
      };
    }>;
  } | null;
  history: Array<{
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    fixturesExamined: number;
    driftCount: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    matchCount: number;
    missingCount: number;
    errorMessage: string | null;
  }>;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  await upsertShopFromPlan(session.shop, plan);

  if (!plan.isPlus) {
    const view: DriftView = {
      isPlus: false,
      planDisplayName: plan.publicDisplayName,
      latest: null,
      history: [],
    };
    return { view };
  }

  const latest = await getLatestDriftRun(session.shop);
  const history = await listDriftRuns(session.shop);

  const view: DriftView = {
    isPlus: true,
    planDisplayName: plan.publicDisplayName,
    latest: latest
      ? {
          runId: latest.run.id,
          startedAt: latest.run.startedAt.toISOString(),
          finishedAt: latest.run.finishedAt?.toISOString() ?? null,
          status: latest.run.status,
          fixturesExamined: latest.run.fixturesExamined,
          matchCount: latest.run.matchCount,
          missingCount: latest.run.missingCount,
          driftCount: latest.run.driftCount,
          criticalCount: latest.run.criticalCount,
          warningCount: latest.run.warningCount,
          infoCount: latest.run.infoCount,
          errorMessage: latest.run.errorMessage,
          alerts: latest.results.map((r) => ({
            id: r.id,
            fixtureSignature: r.fixtureSignature,
            severity: r.severity,
            categories: r.categories,
            message: r.message,
            recommendation: r.recommendation,
            baseline: r.baseline,
            output: r.output,
          })),
        }
      : null,
    history: history.map((h) => ({
      id: h.id,
      status: h.status,
      startedAt: h.startedAt.toISOString(),
      finishedAt: h.finishedAt?.toISOString() ?? null,
      fixturesExamined: h.fixturesExamined,
      driftCount: h.driftCount,
      criticalCount: h.criticalCount,
      warningCount: h.warningCount,
      infoCount: h.infoCount,
      matchCount: h.matchCount,
      missingCount: h.missingCount,
      errorMessage: h.errorMessage,
    })),
  };
  return { view };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  if (!plan.isPlus) {
    throw new Response("Plus required", { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "run-diff") {
    try {
      const outcome = await runDriftAndPersist(session.shop);
      return {
        ok: true as const,
        summary: {
          runId: outcome.driftRunId,
          fixturesExamined: outcome.diff.stats.fixturesExamined,
          drift: outcome.diff.stats.drift,
          critical: outcome.diff.stats.critical,
          warning: outcome.diff.stats.warning,
          info: outcome.diff.stats.info,
          missing: outcome.diff.stats.missing,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: `Run failed: ${message}` };
    }
  }

  return { error: "Unknown intent." };
};

export default function DriftIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const shopify = useAppBridge();

  useEffect(() => {
    if (!actionData) return;
    if ("ok" in actionData && actionData.ok === true) {
      const s = actionData.summary;
      shopify.toast.show(
        `Drift run complete — ${s.fixturesExamined} fixtures examined, ${s.drift} drift detected.`,
      );
    } else if ("error" in actionData && actionData.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  if (!data.view.isPlus) {
    return (
      <Page>
        <TitleBar title="Drift alerts" />
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

  const latest = data.view.latest;
  const history = data.view.history;

  return (
    <Page>
      <TitleBar title="Drift alerts" />
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Run the diff engine
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Joins your Slice 3 fixture baselines (Script-era) to your
                Slice 5 captured Function outputs (Function-era) by fixture
                signature. Severity per category — discount, shipping,
                payment, totals — bubbles up to a fixture-level grade. Match
                and "untested in production" counts surface in stats but
                aren't alerts.
              </Text>
              <InlineStack gap="200">
                <Form method="post" replace>
                  <input type="hidden" name="intent" value="run-diff" />
                  <Button submit variant="primary" loading={submitting}>
                    Run diff
                  </Button>
                </Form>
                <Button url="/app/audit" variant="plain">
                  View in audit
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>

          <Box paddingBlockStart="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Latest run
                </Text>
                {!latest ? (
                  <SentinelEmptyState
                    heading="No runs yet"
                    body='Click "Run diff" above. The first run takes a couple of seconds for typical shops.'
                  />
                ) : (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {`Started ${latest.startedAt.slice(0, 19).replace("T", " ")} · status ${latest.status}`}
                    </Text>
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone="critical">{`${latest.criticalCount} critical`}</Badge>
                      <Badge tone="warning">{`${latest.warningCount} warning`}</Badge>
                      <Badge tone="info">{`${latest.infoCount} info`}</Badge>
                      <Badge tone="success">{`${latest.matchCount} match`}</Badge>
                      <Badge>{`${latest.missingCount} untested`}</Badge>
                    </InlineStack>
                    {latest.errorMessage ? (
                      <Text as="p" variant="bodySm" tone="critical">
                        Error: {latest.errorMessage}
                      </Text>
                    ) : null}
                    {latest.alerts.length === 0 ? (
                      <Text as="p" variant="bodyMd" tone="subdued">
                        {latest.fixturesExamined === 0
                          ? "No fixtures available to diff yet. Generate cart fixtures and capture Function outputs first."
                          : "Every captured Function output matches its Script-era baseline."}
                      </Text>
                    ) : (
                      <BlockStack gap="200">
                        {latest.alerts.map((alert) => (
                          <Card key={alert.id}>
                            <BlockStack gap="100">
                              <InlineStack gap="200" blockAlign="center" align="space-between">
                                <Text as="span" variant="bodyMd" fontWeight="semibold">
                                  Fixture {alert.fixtureSignature.slice(0, 12)}…
                                </Text>
                                <Badge tone={severityTone(alert.severity as DriftSeverity)}>
                                  {alert.severity.toUpperCase()}
                                </Badge>
                              </InlineStack>
                              <Text as="span" variant="bodySm" tone="subdued">
                                Categories: {alert.categories.join(", ")}
                              </Text>
                              <Text as="p" variant="bodySm">
                                {alert.message}
                              </Text>
                              <Text as="p" variant="bodySm" tone="subdued">
                                {alert.recommendation}
                              </Text>
                              <InlineStack gap="200" wrap>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  Baseline · discount {alert.baseline.totalDiscount.toFixed(2)} {alert.baseline.presentmentCurrency}
                                  {alert.baseline.shippingCode
                                    ? ` · ${alert.baseline.shippingCode} ${(alert.baseline.shippingAmount ?? 0).toFixed(2)}`
                                    : ""}
                                </Text>
                                <Text as="span" variant="bodySm" tone="subdued">
                                  Output · discount {alert.output.totalDiscount.toFixed(2)} {alert.output.presentmentCurrency}
                                  {alert.output.shippingCode
                                    ? ` · ${alert.output.shippingCode} ${(alert.output.shippingAmount ?? 0).toFixed(2)}`
                                    : ""}
                                </Text>
                              </InlineStack>
                            </BlockStack>
                          </Card>
                        ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </Box>

          {history.length > 1 ? (
            <Box paddingBlockStart="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Run history
                  </Text>
                  <List type="bullet">
                    {history.slice(1).map((h) => (
                      <List.Item key={h.id}>
                        <strong>{h.status.toUpperCase()}</strong> ·{" "}
                        {h.startedAt.slice(0, 19).replace("T", " ")} · {h.fixturesExamined} examined ·{" "}
                        {h.criticalCount} critical · {h.warningCount} warning · {h.infoCount} info ·{" "}
                        {h.matchCount} match · {h.missingCount} untested
                        {h.errorMessage ? ` · error: ${h.errorMessage}` : ""}
                      </List.Item>
                    ))}
                  </List>
                </BlockStack>
              </Card>
            </Box>
          ) : null}
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function severityTone(
  severity: DriftSeverity,
): "critical" | "warning" | "info" | undefined {
  switch (severity) {
    case "critical":
      return "critical";
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

/**
 * Slice 7 — friendly route-level error boundary.
 */
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
