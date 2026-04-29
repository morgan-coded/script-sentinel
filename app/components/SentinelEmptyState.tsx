import { BlockStack, Card, Text } from "@shopify/polaris";
import type { ReactNode } from "react";

/**
 * Slice 7 — minimal Polaris-aligned empty state. The Shopify Polaris
 * `EmptyState` requires an image asset, which we'd rather not ship as a
 * binary in the bundle. This wrapper renders the same visual idea
 * (heading + supporting copy + optional action) using the components we
 * already use everywhere else, so empty states feel like the rest of the
 * app and don't require new build artifacts.
 */
export interface SentinelEmptyStateProps {
  heading: string;
  body?: ReactNode;
  /** Optional action: rendered after the body. Pass a Polaris Button or Link. */
  action?: ReactNode;
}

export function SentinelEmptyState({
  heading,
  body,
  action,
}: SentinelEmptyStateProps) {
  return (
    <Card>
      <BlockStack gap="200" align="center">
        <Text as="h3" variant="headingMd" alignment="center">
          {heading}
        </Text>
        {body ? (
          <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
            {body}
          </Text>
        ) : null}
        {action ? <div style={{ marginTop: 4 }}>{action}</div> : null}
      </BlockStack>
    </Card>
  );
}
