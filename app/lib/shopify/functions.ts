/**
 * Shopify Functions discovery client.
 *
 * Verified against shopify.dev/docs/api/admin-graphql/2026-04 that:
 *   - The top-level `shopifyFunctions` connection EXISTS in 2026-04.
 *   - The `ShopifyFunction` object exposes id, title, apiType, apiVersion,
 *     app { title }, handle, description.
 *   - No Admin API test-invocation surface exists. The only execution
 *     mechanism is the local CLI `shopify app function run`, which a hosted
 *     app cannot reach. Per the roadmap, we fall back to live observation
 *     of post-deployment orders (see app/lib/audit/capture-runner.server.ts).
 *
 * This module is read-only. It only queries; it never invokes a Function.
 */

export interface RawShopifyFunction {
  id: string;
  title: string;
  apiType: string;
  apiVersion?: string | null;
  handle?: string | null;
  description?: string | null;
  app?: { title?: string | null } | null;
}

export const FUNCTIONS_DISCOVERY_QUERY = /* GraphQL */ `
  query SentinelFunctions($cursor: String, $first: Int!) {
    shopifyFunctions(first: $first, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          title
          apiType
          apiVersion
          handle
          description
          app {
            title
          }
        }
      }
    }
  }
`;

export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

interface DiscoveryPageResponse {
  data?: {
    shopifyFunctions?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      edges?: Array<{ cursor?: string; node?: RawShopifyFunction } | null> | null;
    } | null;
  } | null;
  errors?: Array<{ message: string }>;
}

/**
 * Map a raw `apiType` string to the closest matching ScriptClassification
 * category. Defensive: unknown apiTypes return "other" so the UI surfaces a
 * "needs review" prompt rather than silently dropping the Function.
 *
 * Common 2026-04 apiType values:
 *   - "discounts"               → discount
 *   - "delivery_customization"  → shipping
 *   - "payment_customization"   → payment
 *   - "cart_transform"          → other (cart-shape mutations don't map cleanly)
 */
export type FunctionCategory =
  | "discount"
  | "shipping"
  | "payment"
  | "market_pricing"
  | "b2b"
  | "other";

export function categorizeApiType(apiType: string | null | undefined): FunctionCategory {
  if (!apiType) return "other";
  const t = apiType.toLowerCase();
  // Order matters: `shipping_discounts` is a SHIPPING-family apiType in
  // 2026-04 (it discounts shipping rates), so the shipping check must run
  // before the discount check.
  if (t.includes("delivery") || t.includes("shipping")) return "shipping";
  if (t.includes("payment")) return "payment";
  if (t.includes("market") || t.includes("currency")) return "market_pricing";
  if (t.includes("b2b") || t.includes("wholesale")) return "b2b";
  if (t.includes("discount")) return "discount";
  return "other";
}

export interface FetchFunctionsOptions {
  pageSize?: number;
  /** Hard cap on how many Functions to pull. Plus stores rarely top 50. */
  maxFunctions?: number;
}

export interface FetchFunctionsResult {
  functions: RawShopifyFunction[];
  truncated: boolean;
  pagesFetched: number;
}

/**
 * Paginated discovery of all installed Shopify Functions for the current
 * shop. Throws on transport / GraphQL errors so the route loader returns a
 * 5xx — silently swallowing errors here would leave the merchant staring at
 * an empty list with no way to tell whether Functions are missing or simply
 * unreachable.
 *
 * Throws a typed `FunctionsAccessDeniedError` when the API responds with an
 * access-denied error so the route can surface the exact remediation
 * (granted scopes vs. required scopes).
 */
export class FunctionsAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FunctionsAccessDeniedError";
  }
}

export async function fetchAllFunctions(
  admin: AdminGraphqlClient,
  options: FetchFunctionsOptions = {},
): Promise<FetchFunctionsResult> {
  const pageSize = clamp(options.pageSize ?? 50, 1, 100);
  const max = Math.max(1, options.maxFunctions ?? 500);
  const out: RawShopifyFunction[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let truncated = false;

  while (out.length < max) {
    const response = await admin.graphql(FUNCTIONS_DISCOVERY_QUERY, {
      variables: { cursor, first: pageSize },
    });
    const body = (await response.json()) as DiscoveryPageResponse;

    if (body.errors && body.errors.length > 0) {
      const message = body.errors.map((e) => e.message).join("; ");
      if (/access denied|not authorized|requires.*scope/i.test(message)) {
        throw new FunctionsAccessDeniedError(message);
      }
      throw new Error(`shopifyFunctions query failed: ${message}`);
    }

    pages++;
    const edges = body.data?.shopifyFunctions?.edges ?? [];
    for (const edge of edges) {
      const node = edge?.node;
      if (!node || typeof node.id !== "string") continue;
      out.push(node);
      if (out.length >= max) {
        truncated = true;
        break;
      }
    }
    const pageInfo = body.data?.shopifyFunctions?.pageInfo;
    if (truncated || !pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor ?? null;
    if (!cursor) break;
  }

  return { functions: out, truncated, pagesFetched: pages };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
