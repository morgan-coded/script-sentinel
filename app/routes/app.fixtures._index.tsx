import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import {
  Banner,
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
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { upsertShopFromPlan } from "../lib/shopify/shop.server";
import {
  DEFAULT_LOOKBACK_DAYS,
  fetchOrdersWindow,
  OrdersAccessDeniedError,
} from "../lib/shopify/orders";
import { extractFixtures } from "../lib/fixtures/dedup";
import {
  countFixtures,
  deleteAllFixtures,
  listFixtures,
  upsertFixtures,
  type StoredFixture,
} from "../lib/fixtures/store.server";
import { NON_PLUS_GATE_MESSAGE } from "../lib/shopify/plan-copy";

/**
 * Slice 3 — Cart Fixture Generation from Order History.
 *
 * Read-only against Shopify. We pull orders via the Admin API (`read_orders`),
 * scrub PII before persistence, dedup into representative fixtures, and store
 * a captured baseline of the historical discount/shipping/payment outcome.
 *
 * Verified against 2026-04 docs: `read_orders` only exposes the **last 60
 * days** of orders. Longer history requires `read_all_orders`, which needs
 * Shopify Partner approval. Slice 3 ships at 60 days as a graceful fallback,
 * documented in the README.
 */

type FixtureView = {
  id: string;
  signature: string;
  lineItems: Array<{
    title?: string;
    quantity?: number;
    sku?: string | null;
    unitPrice?: number;
  }>;
  customerTags: string[];
  shippingCountryCode: string | null;
  shippingPostalPrefix: string | null;
  presentmentCurrency: string;
  marketSignature: string;
  observationCount: number;
  quantitySamples: number[];
  cartTotal: number;
  firstObservedAt: string;
  lastObservedAt: string;
  baseline: {
    totalDiscountAmount: number;
    discountCodes: string[];
    shippingRateCode: string | null;
    shippingRateTitle: string | null;
    shippingRateAmount: number | null;
    paymentGatewayNames: string[];
    capturedAt: string;
  } | null;
};

function toView(stored: StoredFixture): FixtureView {
  const codes = (stored.baseline?.discountApplications ?? [])
    .map((d) => {
      const obj = d as { code?: string | null; type?: string };
      return obj?.code ?? obj?.type ?? null;
    })
    .filter((s): s is string => Boolean(s));
  return {
    id: stored.id,
    signature: stored.signature,
    lineItems: (stored.lineItems as FixtureView["lineItems"]).slice(0, 6),
    customerTags: stored.customerTags,
    shippingCountryCode: stored.shippingCountryCode,
    shippingPostalPrefix: stored.shippingPostalPrefix,
    presentmentCurrency: stored.presentmentCurrency,
    marketSignature: stored.marketSignature,
    observationCount: stored.observationCount,
    quantitySamples: stored.quantitySamples,
    cartTotal: stored.cartTotal,
    firstObservedAt: stored.firstObservedAt.toISOString(),
    lastObservedAt: stored.lastObservedAt.toISOString(),
    baseline: stored.baseline
      ? {
          totalDiscountAmount: stored.baseline.totalDiscountAmount,
          discountCodes: codes,
          shippingRateCode: stored.baseline.shippingRateCode,
          shippingRateTitle: stored.baseline.shippingRateTitle,
          shippingRateAmount: stored.baseline.shippingRateAmount,
          paymentGatewayNames: stored.baseline.paymentGatewayNames,
          capturedAt: stored.baseline.capturedAt.toISOString(),
        }
      : null,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  await upsertShopFromPlan(session.shop, plan);

  if (!plan.isPlus) {
    return {
      isPlus: false as const,
      planDisplayName: plan.publicDisplayName,
      fixtures: [] as FixtureView[],
      total: 0,
      lookbackDays: DEFAULT_LOOKBACK_DAYS,
    };
  }

  const stored = await listFixtures(session.shop);
  return {
    isPlus: true as const,
    planDisplayName: plan.publicDisplayName,
    fixtures: stored.slice(0, 100).map(toView),
    total: await countFixtures(session.shop),
    lookbackDays: DEFAULT_LOOKBACK_DAYS,
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

  if (intent === "generate") {
    const start = Date.now();
    let fetched: Awaited<ReturnType<typeof fetchOrdersWindow>>;
    try {
      fetched = await fetchOrdersWindow(admin, { lookbackDays: DEFAULT_LOOKBACK_DAYS });
    } catch (err) {
      if (err instanceof OrdersAccessDeniedError) {
        return {
          error:
            "Shopify blocked order access because this app is not yet approved for protected Order data. Complete Protected customer data approval in the Shopify Partner Dashboard, then reinstall or retry fixtures.",
        };
      }
      throw err;
    }
    const { orders, pagesFetched, throttleSleeps, truncated } = fetched;
    const { fixtures, stats } = extractFixtures(orders);
    const persisted = await upsertFixtures(session.shop, fixtures);
    return {
      ok: true as const,
      summary: {
        ordersFetched: orders.length,
        ordersDropped: stats.ordersDropped,
        fixturesProduced: fixtures.length,
        rowsCreated: persisted.created,
        rowsMerged: persisted.merged,
        pagesFetched,
        throttleSleeps,
        truncated,
        elapsedMs: Date.now() - start,
      },
    };
  }

  if (intent === "clear") {
    const removed = await deleteAllFixtures(session.shop);
    return { ok: true as const, summary: { removed } };
  }

  return { error: "Unknown intent." };
};

export default function FixturesIndex() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const shopify = useAppBridge();
  const actionError =
    actionData && "error" in actionData && typeof actionData.error === "string"
      ? actionData.error
      : null;

  useEffect(() => {
    if (!actionData) return;
    if ("ok" in actionData && actionData.ok === true) {
      if (
        "fixturesProduced" in actionData.summary &&
        typeof actionData.summary.fixturesProduced === "number"
      ) {
        const produced = actionData.summary.fixturesProduced;
        shopify.toast.show(
          `Fixture generation complete — ${produced} fixture${produced === 1 ? "" : "s"} produced.`,
        );
      } else {
        shopify.toast.show("Fixtures cleared.");
      }
    } else if (actionError) {
      shopify.toast.show(actionError, { isError: true });
    }
  }, [actionData, actionError, shopify]);

  if (!data.isPlus) {
    return (
      <Page>
        <TitleBar title="Cart fixtures" />
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

  const empty = data.fixtures.length === 0;

  return (
    <Page>
      <TitleBar title="Cart fixtures" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                {actionError ? (
                  <Banner title="Order access needs approval" tone="warning">
                    <p>{actionError}</p>
                  </Banner>
                ) : null}
                <Text as="h2" variant="headingMd">
                  Generate fixtures from order history
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Pulls your store's last {data.lookbackDays} days of orders,
                  strips customer PII, deduplicates by cart composition, and
                  stores a captured baseline of the discount, shipping rate
                  and payment method that applied. Re-run any time — the
                  fixture library merges new orders into existing rows.
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  PII handling: we never persist names, emails, phones, or
                  addresses. The launch configuration does not request
                  optional address fields from Shopify. Customer tags that look
                  like emails, phones, or person names are dropped before write.
                </Text>
                <InlineStack gap="200">
                  <Form method="post" replace>
                    <input type="hidden" name="intent" value="generate" />
                    <Button submit variant="primary" loading={submitting}>
                      Generate fixtures
                    </Button>
                  </Form>
                  <Form
                    method="post"
                    replace
                    onSubmit={(e) => {
                      if (
                        !window.confirm(
                          "Delete every cart fixture for this shop? You can re-generate from order history afterward.",
                        )
                      ) {
                        e.preventDefault();
                      }
                    }}
                  >
                    <input type="hidden" name="intent" value="clear" />
                    <Button submit tone="critical" variant="tertiary" loading={submitting}>
                      Clear fixtures
                    </Button>
                  </Form>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  Total stored: {data.total}
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section>
            {empty ? (
              <Card>
                <EmptyState
                  heading="No fixtures yet"
                  image=""
                  action={{ content: "Generate fixtures", url: "?", external: false }}
                >
                  <p>
                    Click "Generate fixtures" above to pull recent orders from
                    your store and build a representative cart-fixture library
                    for the audit.
                  </p>
                </EmptyState>
              </Card>
            ) : (
              <BlockStack gap="200">
                {data.fixtures.map((fixture) => (
                  <FixtureCard key={fixture.id} fixture={fixture} />
                ))}
                {data.total > data.fixtures.length ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Showing newest {data.fixtures.length} of {data.total} fixtures.
                  </Text>
                ) : null}
              </BlockStack>
            )}
          </Layout.Section>
        </Layout>
      </BlockStack>
    </Page>
  );
}

function FixtureCard({ fixture }: { fixture: FixtureView }) {
  const productList = fixture.lineItems
    .map((li) => `${li.quantity ?? 1}× ${li.title ?? "(untitled)"}`)
    .join(", ");
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack gap="200" blockAlign="center" align="space-between">
          <InlineStack gap="200" blockAlign="center">
            <Badge tone="info">{fixture.presentmentCurrency}</Badge>
            {fixture.shippingCountryCode ? (
              <Badge>{fixture.shippingCountryCode}</Badge>
            ) : null}
            {fixture.customerTags.map((tag) => (
              <Badge key={tag} tone="info">
                {tag}
              </Badge>
            ))}
          </InlineStack>
          <Text as="span" variant="bodySm" tone="subdued">
            {fixture.observationCount} order{fixture.observationCount === 1 ? "" : "s"}
            {fixture.quantitySamples.length > 0
              ? ` · qty ${fixture.quantitySamples.join("/")}`
              : ""}
          </Text>
        </InlineStack>
        <Text as="p" variant="bodyMd">
          {productList || "(no line items)"}
        </Text>
        {fixture.baseline ? (
          <BlockStack gap="100">
            <Text as="span" variant="bodySm" tone="subdued">
              Baseline · cart {formatMoney(fixture.cartTotal, fixture.presentmentCurrency)}
              {fixture.baseline.totalDiscountAmount > 0
                ? ` · discount −${formatMoney(fixture.baseline.totalDiscountAmount, fixture.presentmentCurrency)}`
                : ""}
              {fixture.baseline.shippingRateAmount !== null
                ? ` · ${fixture.baseline.shippingRateTitle ?? fixture.baseline.shippingRateCode ?? "shipping"} ${formatMoney(fixture.baseline.shippingRateAmount, fixture.presentmentCurrency)}`
                : ""}
              {fixture.baseline.paymentGatewayNames.length > 0
                ? ` · paid via ${fixture.baseline.paymentGatewayNames.join(", ")}`
                : ""}
            </Text>
            {fixture.baseline.discountCodes.length > 0 ? (
              <InlineStack gap="100">
                {fixture.baseline.discountCodes.map((code) => (
                  <Badge key={code} tone="success">
                    {code}
                  </Badge>
                ))}
              </InlineStack>
            ) : null}
          </BlockStack>
        ) : (
          <Text as="span" variant="bodySm" tone="subdued">
            No baseline captured.
          </Text>
        )}
        <Box>
          <Text as="span" variant="bodySm" tone="subdued">
            First seen {fixture.firstObservedAt.slice(0, 10)} · last seen{" "}
            {fixture.lastObservedAt.slice(0, 10)}
            {fixture.shippingPostalPrefix ? ` · postal ${fixture.shippingPostalPrefix}…` : ""}
          </Text>
        </Box>
      </BlockStack>
    </Card>
  );
}

function formatMoney(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}
