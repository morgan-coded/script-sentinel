import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
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
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { fetchShopPlan } from "../lib/shopify/plan.server";
import { NON_PLUS_GATE_MESSAGE } from "../lib/shopify/plan-copy";
import {
  getLatestCharge,
  upsertShopFromPlan,
} from "../lib/shopify/shop.server";
import {
  BILLING_PRODUCTS,
  formatPrice,
} from "../lib/billing/products";

/**
 * Slice 1 dashboard — placeholder.
 *
 * Shows shop name, Plus status, current billing/action state, and a CTA to run
 * a migration audit. The audit paywall is wired in Slice 4; this CTA only
 * surfaces the future destination so the dashboard isn't empty.
 *
 * Architectural rule: this route runs the Plus gate on every load. If the shop
 * is not Plus, render the gate copy and stop. We do NOT redirect, because the
 * embedded App Bridge frame should still resolve a valid HTML response.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const plan = await fetchShopPlan(admin);
  const shop = await upsertShopFromPlan(session.shop, plan);
  const charge = plan.isPlus ? await getLatestCharge(session.shop) : null;

  return {
    shopDomain: session.shop,
    shopName: shop.shopName ?? plan.shopName ?? session.shop,
    isPlus: plan.isPlus,
    isDevelopment: plan.isDevelopment,
    planDisplayName: plan.publicDisplayName,
    latestCharge: charge
      ? {
          planKey: charge.planKey,
          status: charge.status,
          amount: charge.amount,
          currencyCode: charge.currencyCode,
          createdAt: charge.createdAt.toISOString(),
        }
      : null,
    auditProduct: {
      key: BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.key,
      displayName: BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.displayName,
      priceLabel: formatPrice(BILLING_PRODUCTS.MIGRATION_RISK_AUDIT),
      description: BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.description,
    },
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();

  if (!data.isPlus) {
    return <NonPlusGate planDisplayName={data.planDisplayName} />;
  }

  return (
    <Page>
      <TitleBar title="Script Sentinel" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
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

                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Migration audit
                  </Text>
                  <Text as="p" variant="bodyMd">
                    {data.auditProduct.description}
                  </Text>
                  <InlineStack gap="200" blockAlign="center">
                    <Button variant="primary" url="/app/audit" disabled>
                      Run migration audit — {data.auditProduct.priceLabel}
                    </Button>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Slice 4 wires the audit paywall and PDF generation.
                    </Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="500">
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Current billing state
                  </Text>
                  {data.latestCharge ? (
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
                      No charges yet. The audit purchase or subscription will appear here once
                      payment is initiated through Shopify Managed Billing.
                    </Text>
                  )}
                </BlockStack>
              </Card>

              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingMd">
                    Slice 1 status
                  </Text>
                  <List>
                    <List.Item>Embedded app shell installed</List.Item>
                    <List.Item>Plus plan detected and gated</List.Item>
                    <List.Item>Managed Billing catalog wired (4 SKUs)</List.Item>
                    <List.Item>Uninstall webhook clears session + marks shop</List.Item>
                  </List>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Script discovery, fixtures, audit PDF, and diff engine ship in Slices 2–6.
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
              <Box>
                <Text as="p" variant="bodyMd">
                  {NON_PLUS_GATE_MESSAGE}
                </Text>
              </Box>
              {planDisplayName ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  Detected plan: {planDisplayName}
                </Text>
              ) : null}
              <Box>
                <Text as="p" variant="bodyMd">
                  If you believe this is a mistake — for example, you upgraded to Plus very
                  recently — uninstall and reinstall Script Sentinel so the plan check
                  refreshes.
                </Text>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
