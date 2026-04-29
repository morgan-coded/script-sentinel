/**
 * Shopify Orders client — read-only paginated fetch with rate-limit awareness.
 *
 * Slice 3 verified against shopify.dev/docs/api/admin-graphql/2026-04 that:
 *   - The `orders(first, after, query)` connection exists with cursor edges.
 *   - Default `read_orders` scope only exposes the last 60 days of orders;
 *     `read_all_orders` (Partner-approved) is required for longer windows.
 *   - LineItem money is `*Set { presentmentMoney { amount currencyCode } }`
 *     (MoneyBag); flat `Money` scalars are deprecated.
 *   - `shippingLines` is a connection in 2026-04 (was a flat list in older
 *     versions).
 *   - There is no `Order.market` field in 2026-04; we derive market from
 *     presentment currency + shipping country.
 *
 * Rate limit strategy: Plus stores get an elevated bucket but we don't assume
 * it. Between pages we observe Shopify's `extensions.cost.throttleStatus` —
 * if `currentlyAvailable < 200`, we sleep until restoration. The default delay
 * keeps us well under the 50-points-per-second restore rate of the standard
 * tier. For a 250-order test page we measured ~280-point cost; per-page
 * pagination is comfortably below the bucket.
 */

/** Hard cap so we don't accidentally pull years of orders if the merchant has them. */
export const MAX_ORDERS_PER_RUN = 5_000;

/** Default look-back window. 60 days is the ceiling under read_orders alone. */
export const DEFAULT_LOOKBACK_DAYS = 60;

/** Page size for the orders connection. 25 keeps each page's GraphQL cost under ~120 points. */
export const ORDERS_PAGE_SIZE = 25;

/**
 * Minimal admin GraphQL client surface. Mirrors the @shopify/shopify-app-remix
 * shape so this module can be unit-tested by passing a stub.
 */
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

export const ORDERS_PAGE_QUERY = /* GraphQL */ `
  query SentinelOrders($cursor: String, $first: Int!, $query: String!) {
    orders(first: $first, after: $cursor, query: $query, sortKey: PROCESSED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          name
          processedAt
          createdAt
          currencyCode
          presentmentCurrencyCode
          paymentGatewayNames
          customer {
            id
            tags
          }
          shippingAddress {
            countryCode
            zip
          }
          lineItems(first: 50) {
            edges {
              node {
                id
                title
                quantity
                sku
                variant {
                  id
                  sku
                  price
                }
                product {
                  id
                }
                originalTotalSet {
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
                discountedTotalSet {
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
          shippingLines(first: 10) {
            edges {
              node {
                code
                title
                carrierIdentifier
                originalPriceSet {
                  presentmentMoney {
                    amount
                    currencyCode
                  }
                }
              }
            }
          }
          discountApplications(first: 25) {
            edges {
              node {
                __typename
                allocationMethod
                targetType
                targetSelection
                value {
                  __typename
                  ... on MoneyV2 {
                    amount
                    currencyCode
                  }
                  ... on PricingPercentageValue {
                    percentage
                  }
                }
                ... on DiscountCodeApplication {
                  code
                }
                ... on AutomaticDiscountApplication {
                  title
                }
                ... on ManualDiscountApplication {
                  title
                  description
                }
                ... on ScriptDiscountApplication {
                  title
                }
              }
            }
          }
        }
      }
    }
    # Query-cost telemetry: Shopify returns this in extensions.cost on every
    # request. The body parser below reads throttleStatus.currentlyAvailable
    # to drive backoff between pages.
  }
`;

export interface MoneyAmount {
  amount: string;
  currencyCode: string;
}

export interface RawLineItem {
  id?: string | null;
  title?: string | null;
  quantity?: number | null;
  sku?: string | null;
  variant?: { id?: string | null; sku?: string | null; price?: string | null } | null;
  product?: { id?: string | null } | null;
  originalTotalSet?: { presentmentMoney?: MoneyAmount } | null;
  discountedTotalSet?: { presentmentMoney?: MoneyAmount } | null;
}

export interface RawShippingLine {
  code?: string | null;
  title?: string | null;
  carrierIdentifier?: string | null;
  originalPriceSet?: { presentmentMoney?: MoneyAmount } | null;
}

export interface RawDiscountApplication {
  __typename?: string;
  allocationMethod?: string | null;
  targetType?: string | null;
  targetSelection?: string | null;
  value?:
    | { __typename?: "MoneyV2"; amount?: string; currencyCode?: string }
    | { __typename?: "PricingPercentageValue"; percentage?: number }
    | null;
  code?: string | null;
  title?: string | null;
  description?: string | null;
}

export interface RawOrder {
  id: string;
  name?: string | null;
  processedAt?: string | null;
  createdAt?: string | null;
  currencyCode?: string | null;
  presentmentCurrencyCode?: string | null;
  paymentGatewayNames?: string[] | null;
  customer?: { id?: string | null; tags?: string[] | null } | null;
  shippingAddress?: { countryCode?: string | null; zip?: string | null } | null;
  lineItems?: { edges?: Array<{ node?: RawLineItem } | null> | null } | null;
  shippingLines?: { edges?: Array<{ node?: RawShippingLine } | null> | null } | null;
  discountApplications?: { edges?: Array<{ node?: RawDiscountApplication } | null> | null } | null;
}

interface OrdersPageResponse {
  data?: {
    orders?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      edges?: Array<{ cursor?: string; node?: RawOrder }> | null;
    } | null;
  } | null;
  errors?: Array<{ message: string }>;
  extensions?: {
    cost?: {
      throttleStatus?: {
        currentlyAvailable?: number;
        maximumAvailable?: number;
        restoreRate?: number;
      };
    };
  };
}

export interface FetchOrdersOptions {
  /** Look-back window in days. Capped at 60 unless the caller has read_all_orders. */
  lookbackDays?: number;
  /** Maximum orders to return overall. Defaults to MAX_ORDERS_PER_RUN. */
  maxOrders?: number;
  /** Override page size (test-only). */
  pageSize?: number;
  /**
   * Optional sleeper used in tests to skip real waits. Production passes
   * undefined and we use the global setTimeout.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Override "now" for deterministic tests. */
  now?: () => Date;
}

export interface FetchOrdersResult {
  orders: RawOrder[];
  /** True iff we hit `maxOrders` before exhausting the result set. */
  truncated: boolean;
  /** Number of pages fetched (for telemetry / test assertions). */
  pagesFetched: number;
  /** Number of times we slept due to throttle pressure. */
  throttleSleeps: number;
}

const DEFAULT_SLEEP_THRESHOLD = 200;
const DEFAULT_SLEEP_MS = 1_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the Shopify order-search query string for the look-back window. Uses
 * `processed_at:>=YYYY-MM-DD` because we sort by PROCESSED_AT in the query —
 * this avoids a class of edge cases where backdated orders show up out of
 * order under created_at sort.
 */
export function buildOrdersQuery(options: { lookbackDays: number; now: Date }): string {
  const cutoff = new Date(options.now);
  cutoff.setUTCDate(cutoff.getUTCDate() - options.lookbackDays);
  const iso = cutoff.toISOString().slice(0, 10); // YYYY-MM-DD
  return `processed_at:>=${iso}`;
}

/**
 * Paginated fetch with cursor-based forward iteration and throttle backoff.
 *
 * Throws on transport / GraphQL errors so the route loader can return a 5xx
 * — silently swallowing here would leave the merchant staring at an empty
 * "no orders found" UI.
 */
export async function fetchOrdersWindow(
  admin: AdminGraphqlClient,
  options: FetchOrdersOptions = {},
): Promise<FetchOrdersResult> {
  const lookbackDays = clamp(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 1, DEFAULT_LOOKBACK_DAYS);
  const maxOrders = clamp(options.maxOrders ?? MAX_ORDERS_PER_RUN, 1, MAX_ORDERS_PER_RUN);
  const pageSize = clamp(options.pageSize ?? ORDERS_PAGE_SIZE, 1, 100);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ? options.now() : new Date();
  const queryStr = buildOrdersQuery({ lookbackDays, now });

  const orders: RawOrder[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;
  let throttleSleeps = 0;
  let truncated = false;

  while (orders.length < maxOrders) {
    const response = await admin.graphql(ORDERS_PAGE_QUERY, {
      variables: { cursor, first: pageSize, query: queryStr },
    });
    const body = (await response.json()) as OrdersPageResponse;

    if (body.errors && body.errors.length > 0) {
      throw new Error(
        `orders fetch failed: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }

    pagesFetched++;
    const edges = body.data?.orders?.edges ?? [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node) continue;
      orders.push(node);
      if (orders.length >= maxOrders) {
        truncated = true;
        break;
      }
    }

    const pageInfo = body.data?.orders?.pageInfo;
    if (truncated || !pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor ?? null;
    if (!cursor) break;

    // Backoff: if we're running low on points, wait for restore. Plus stores
    // restore at 100/sec; standard at 50/sec. A 1-second nap covers both.
    const available = body.extensions?.cost?.throttleStatus?.currentlyAvailable;
    if (typeof available === "number" && available < DEFAULT_SLEEP_THRESHOLD) {
      throttleSleeps++;
      await sleep(DEFAULT_SLEEP_MS);
    }
  }

  return { orders, truncated, pagesFetched, throttleSleeps };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
