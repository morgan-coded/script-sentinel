import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "@remix-run/react";
import {
  Badge,
  Banner,
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
import { useEffect, useState } from "react";
import { SentinelEmptyState } from "../components/SentinelEmptyState";
import { authenticate } from "../shopify.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { upsertShopFromPlan } from "../lib/shopify/shop.server";
import {
  fetchAllFunctions,
  FunctionsAccessDeniedError,
} from "../lib/shopify/functions";
import {
  buildCategoryAttributionMap,
  countFunctionOutputs,
  finishCaptureRun,
  listCaptureRuns,
  listDiscoveredFunctions,
  persistFunctionOutputsFromOrders,
  startCaptureRun,
  upsertDiscoveredFunctions,
} from "../lib/functions/store.server";
import {
  fetchOrdersWindow,
  OrdersAccessDeniedError,
} from "../lib/shopify/orders";
import { NON_PLUS_GATE_MESSAGE } from "../lib/shopify/plan-copy";

/**
 * Functions output capture.
 *
 * Two actions on this route:
 *   1. **Discover** — query `shopifyFunctions` and upsert DiscoveredFunction
 *      rows. Shopify's Admin API exposes Function metadata (id, title,
 *      apiType, app) but NOT a test-invocation endpoint, so this is
 *      observation-only.
 *   2. **Capture** — pull recent orders (default last 14 days) and persist
 *      the observed per-fixture discount/shipping/payment outcomes as
 *      FunctionOutput rows. Per the roadmap's "Technical reality check",
 *      this is the live-observation fallback for the missing test-invocation
 *      API. The diff engine compares these outputs against the
 *      FixtureBaseline rows.
 *
 * Plus-only gate enforced on every loader and action.
 */

const CAPTURE_DEFAULT_WINDOW_DAYS = 14;

type FunctionRow = {
  id: string;
  externalId: string;
  title: string;
  apiType: string;
  apiVersion: string | null;
  appTitle: string | null;
  category: string;
  uninstalled: boolean;
  outputsCaptured: number;
};

type RunRow = {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  windowFromAt: string;
  windowToAt: string;
  ordersExamined: number;
  outputsCaptured: number;
  errorMessage: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  await upsertShopFromPlan(session.shop, plan);

  if (!plan.isPlus) {
    return {
      isPlus: false as const,
      planDisplayName: plan.publicDisplayName,
      functions: [] as FunctionRow[],
      runs: [] as RunRow[],
    };
  }

  const stored = await listDiscoveredFunctions(session.shop);
  const runs = await listCaptureRuns(session.shop);
  const counts = await Promise.all(
    stored.map((f) => countFunctionOutputs(session.shop, f.id)),
  );
  return {
    isPlus: true as const,
    planDisplayName: plan.publicDisplayName,
    functions: stored.map((f, i): FunctionRow => ({
      id: f.id,
      externalId: f.externalId,
      title: f.title,
      apiType: f.apiType,
      apiVersion: f.apiVersion,
      appTitle: f.appTitle,
      category: f.category,
      uninstalled: f.uninstalledAt !== null,
      outputsCaptured: counts[i] ?? 0,
    })),
    runs: runs.map((r): RunRow => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      windowFromAt: r.windowFromAt.toISOString(),
      windowToAt: r.windowToAt.toISOString(),
      ordersExamined: r.ordersExamined,
      outputsCaptured: r.outputsCaptured,
      errorMessage: r.errorMessage,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  if (!plan.isPlus) {
    throw new Response("Plus required", { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "discover") {
    try {
      const { functions } = await fetchAllFunctions(admin);
      const result = await upsertDiscoveredFunctions(session.shop, functions);
      return { ok: true as const, summary: { ...result, total: functions.length } };
    } catch (err) {
      if (err instanceof FunctionsAccessDeniedError) {
        return {
          error:
            "Shopify rejected the Functions discovery query on access-scope grounds. Re-install the app or contact support so we can extend the requested scopes.",
        };
      }
      throw err;
    }
  }

  if (intent === "capture") {
    const now = new Date();
    const windowFrom = new Date(now);
    windowFrom.setUTCDate(windowFrom.getUTCDate() - CAPTURE_DEFAULT_WINDOW_DAYS);

    // Snapshot the active Functions before fetching orders so attribution
    // is consistent across the run.
    const functions = await listDiscoveredFunctions(session.shop);
    const attribution = buildCategoryAttributionMap(functions);

    const run = await startCaptureRun(session.shop, {
      from: windowFrom,
      to: now,
    });
    try {
      const { orders } = await fetchOrdersWindow(admin, {
        lookbackDays: CAPTURE_DEFAULT_WINDOW_DAYS,
      });
      const summary = await persistFunctionOutputsFromOrders(
        session.shop,
        run.id,
        orders,
        attribution,
      );
      await finishCaptureRun(run.id, {
        status: "completed",
        ordersExamined: summary.ordersConsidered,
        outputsCaptured: summary.outputsCaptured,
      });
      return {
        ok: true as const,
        summary: {
          runId: run.id,
          ordersExamined: summary.ordersConsidered,
          outputsCaptured: summary.outputsCaptured,
          functionsConsidered: functions.filter((f) => !f.uninstalledAt).length,
          attributable: attribution.size,
        },
      };
    } catch (err) {
      const message =
        err instanceof OrdersAccessDeniedError
          ? "Shopify blocked order access because this app is not yet approved for protected Order data. Complete Protected customer data approval in the Shopify Partner Dashboard, then reinstall or retry capture."
          : err instanceof Error
            ? err.message
            : String(err);
      await finishCaptureRun(run.id, {
        status: "failed",
        ordersExamined: 0,
        outputsCaptured: 0,
        errorMessage: message,
      });
      return { error: `Capture failed: ${message}` };
    }
  }

  return { error: "Unknown intent." };
};

export default function FunctionsIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const shopify = useAppBridge();

  // Toast on action success/failure. Discovery and capture
  // both produce summary objects with counts; we surface a one-line
  // confirmation rather than making the merchant scan diff stats.
  useEffect(() => {
    if (!actionData) return;
    if ("ok" in actionData && actionData.ok === true) {
      const summary = actionData.summary as Record<string, number | undefined>;
      if (typeof summary.total === "number") {
        shopify.toast.show(
          `Discovered ${summary.total} Function${summary.total === 1 ? "" : "s"}.`,
        );
      } else {
        const outputs = summary.outputsCaptured ?? 0;
        shopify.toast.show(
          `Capture complete — ${outputs} output${outputs === 1 ? "" : "s"} captured.`,
        );
      }
    } else if ("error" in actionData && actionData.error) {
      shopify.toast.show(actionData.error, { isError: true });
    }
  }, [actionData, shopify]);

  // Surface an access-denied explainer banner above the action
  // bar when the most recent discover attempt was rejected on scope grounds.
  // Friendlier than burying the error in a toast.
  const actionError =
    actionData && "error" in actionData && typeof actionData.error === "string"
      ? actionData.error
      : null;
  const accessDenied =
    actionError !== null &&
    /scope|protected order|protected customer|order access/i.test(actionError);

  if (!data.isPlus) {
    return (
      <Page>
        <TitleBar title="Functions capture" />
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

  const installed = data.functions.filter((f) => !f.uninstalled);
  const removed = data.functions.filter((f) => f.uninstalled);

  return (
    <Page>
      <TitleBar title="Functions capture" />
      <Layout>
        <Layout.Section>
          {accessDenied ? (
            <Box paddingBlockEnd="400">
              <Banner
                title="Additional Shopify approval required"
                tone="warning"
              >
                <p>
                  {actionError}
                </p>
              </Banner>
            </Box>
          ) : null}
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Deployed Shopify Functions
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Shopify's 2026-04 Admin API exposes Function discovery but no
                test-invocation surface. Per the roadmap's Technical reality
                check, the app falls back to live observation: we pull the
                last {CAPTURE_DEFAULT_WINDOW_DAYS} days of orders and capture
                the discount/shipping/payment outcomes that fired during
                checkout. The drift engine diffs these against your fixture
                baselines.
              </Text>
              <InlineStack gap="200">
                <Form method="post" replace>
                  <input type="hidden" name="intent" value="discover" />
                  <Button submit variant="primary" loading={submitting}>
                    Discover Functions
                  </Button>
                </Form>
                <Form method="post" replace>
                  <input type="hidden" name="intent" value="capture" />
                  <Button submit loading={submitting}>
                    {`Capture outputs (last ${CAPTURE_DEFAULT_WINDOW_DAYS} days)`}
                  </Button>
                </Form>
              </InlineStack>
            </BlockStack>
          </Card>

          <Box paddingBlockStart="500">
            <Card>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  Installed Functions ({installed.length})
                </Text>
                {installed.length === 0 ? (
                  <SentinelEmptyState
                    heading="No Functions discovered yet"
                    body={
                      <>
                        Click <strong>Discover Functions</strong> to query
                        Shopify for the Functions deployed on your store. If you
                        haven't deployed any Function replacements for your
                        Scripts yet, this list will stay empty.
                      </>
                    }
                  />
                ) : (
                  <BlockStack gap="200">
                    {installed.map((fn) => (
                      <FunctionRowCard key={fn.id} fn={fn} />
                    ))}
                  </BlockStack>
                )}
                {removed.length > 0 ? (
                  <Box paddingBlockStart="300">
                    <Text as="h3" variant="headingMd">
                      Removed Functions ({removed.length})
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Shopify no longer reports these Functions. Historical
                      capture rows attributed to them remain readable.
                    </Text>
                    <BlockStack gap="200">
                      {removed.map((fn) => (
                        <FunctionRowCard key={fn.id} fn={fn} />
                      ))}
                    </BlockStack>
                  </Box>
                ) : null}
              </BlockStack>
            </Card>
          </Box>

          <Box paddingBlockStart="500">
            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingMd">
                  Capture runs
                </Text>
                {data.runs.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No capture runs yet. Click "Capture outputs" above to start
                    your first one.
                  </Text>
                ) : (
                  <List type="bullet">
                    {data.runs.map((r) => (
                      <List.Item key={r.id}>
                        <strong>{r.status.toUpperCase()}</strong> ·{" "}
                        {r.startedAt.slice(0, 10)} → {(r.finishedAt ?? "").slice(0, 10) || "..."}{" "}
                        · {r.ordersExamined} orders examined · {r.outputsCaptured} outputs
                        captured
                        {r.errorMessage ? ` · error: ${r.errorMessage}` : ""}
                      </List.Item>
                    ))}
                  </List>
                )}
              </BlockStack>
            </Card>
          </Box>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function FunctionRowCard({ fn }: { fn: FunctionRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center" align="space-between">
          <BlockStack gap="050">
            <Text as="span" variant="bodyMd" fontWeight="semibold">
              {fn.title}
            </Text>
            <InlineStack gap="200" blockAlign="center">
              <Badge tone={badgeToneFor(fn.category)}>
                {categoryLabel(fn.category)}
              </Badge>
              <Text as="span" variant="bodySm" tone="subdued">
                {fn.apiType}
                {fn.appTitle ? ` · ${fn.appTitle}` : ""}
                {fn.apiVersion ? ` · API ${fn.apiVersion}` : ""}
              </Text>
            </InlineStack>
          </BlockStack>
          <InlineStack gap="200" blockAlign="center">
            <Badge tone={fn.outputsCaptured > 0 ? "success" : undefined}>
              {`${fn.outputsCaptured} captured`}
            </Badge>
            <Button
              variant="plain"
              onClick={() => setExpanded((v) => !v)}
              accessibilityLabel="Toggle details"
            >
              {expanded ? "Hide details" : "Details"}
            </Button>
          </InlineStack>
        </InlineStack>
        {expanded ? (
          <Box paddingBlockStart="200">
            <Text as="p" variant="bodySm" tone="subdued">
              External ID: {fn.externalId}
            </Text>
          </Box>
        ) : null}
      </BlockStack>
    </Card>
  );
}

function categoryLabel(category: string): string {
  switch (category) {
    case "discount":
      return "Discount";
    case "shipping":
      return "Shipping";
    case "payment":
      return "Payment";
    case "market_pricing":
      return "Market pricing";
    case "b2b":
      return "B2B";
    default:
      return "Other";
  }
}

function badgeToneFor(
  category: string,
): "success" | "info" | "warning" | "attention" | undefined {
  switch (category) {
    case "discount":
      return "success";
    case "shipping":
      return "info";
    case "payment":
      return "attention";
    case "market_pricing":
      return "info";
    case "b2b":
      return "info";
    default:
      return "warning";
  }
}

/**
 * Friendly route-level error boundary.
 */
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
