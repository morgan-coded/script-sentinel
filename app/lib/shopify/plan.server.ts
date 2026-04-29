/**
 * Plus-plan detection.
 *
 * Architectural commitment: Script Sentinel only serves Shopify Plus merchants
 * (Shopify Scripts only run on Plus). The dashboard, billing flow, and audit
 * paywall must all gate behind this check.
 *
 * Canonical signal (verified against Shopify Admin GraphQL 2025-01+):
 *   query { shop { plan { shopifyPlus partnerDevelopment publicDisplayName } } }
 *
 *   - `plan.shopifyPlus: Boolean!` — the canonical Plus signal. Source of truth.
 *   - `plan.partnerDevelopment: Boolean!` — true for Partner-created dev stores
 *     that simulate Plus. Treated as Plus for the purposes of the gate so we can
 *     still develop/test, but flagged as "development" so we don't bill.
 *   - `plan.publicDisplayName: String!` — for display only. Do NOT gate on this
 *     string (`displayName` is deprecated; `publicDisplayName` values are not
 *     stable contract).
 *
 * https://shopify.dev/docs/api/admin-graphql/latest/objects/ShopPlan
 */

export interface ShopPlanSnapshot {
  /** Raw `plan.shopifyPlus` boolean from the Admin API. */
  shopifyPlus: boolean;
  /** Raw `plan.partnerDevelopment` boolean from the Admin API. */
  partnerDevelopment: boolean;
  /** Raw `plan.publicDisplayName` for display. May be null on very old API versions. */
  publicDisplayName: string | null;
  /** Effective gate decision derived from the booleans above. */
  isPlus: boolean;
  /** True when this is a partner-created development store simulating Plus. */
  isDevelopment: boolean;
}

const PLAN_QUERY = `#graphql
  query ShopSentinelPlan {
    shop {
      myshopifyDomain
      name
      plan {
        shopifyPlus
        partnerDevelopment
        publicDisplayName
      }
    }
  }
`;

/**
 * Minimal admin client surface we depend on, defined inline so this module can be
 * tested without importing the full @shopify/shopify-api types.
 */
export interface AdminGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

interface PlanQueryResponse {
  data?: {
    shop?: {
      myshopifyDomain?: string | null;
      name?: string | null;
      plan?: {
        shopifyPlus?: boolean | null;
        partnerDevelopment?: boolean | null;
        publicDisplayName?: string | null;
      } | null;
    } | null;
  } | null;
  errors?: Array<{ message: string }>;
}

/**
 * Apply the gate rule to a raw Admin API plan payload. Pure function — no I/O —
 * so the rule itself is unit-testable independently from any Shopify client.
 */
export function evaluatePlan(plan: {
  shopifyPlus?: boolean | null;
  partnerDevelopment?: boolean | null;
  publicDisplayName?: string | null;
}): ShopPlanSnapshot {
  const shopifyPlus = plan.shopifyPlus === true;
  const partnerDevelopment = plan.partnerDevelopment === true;
  // Partner-created development stores can simulate Plus for testing. We allow
  // them through the gate but mark them as development so billing/onboarding can
  // skip live charges where appropriate.
  const isDevelopment = partnerDevelopment;
  return {
    shopifyPlus,
    partnerDevelopment,
    publicDisplayName: plan.publicDisplayName ?? null,
    isPlus: shopifyPlus || isDevelopment,
    isDevelopment,
  };
}

/**
 * Fetch the shop's plan via the Admin GraphQL API and apply the gate rule.
 * Throws on transport / GraphQL errors so callers can return a 5xx instead of
 * silently treating an unreachable shop as non-Plus.
 */
export async function fetchShopPlan(
  admin: AdminGraphqlClient,
): Promise<ShopPlanSnapshot & { myshopifyDomain: string | null; shopName: string | null }> {
  const response = await admin.graphql(PLAN_QUERY);
  const body = (await response.json()) as PlanQueryResponse;

  if (body.errors && body.errors.length > 0) {
    throw new Error(
      `Failed to read shop plan: ${body.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const shop = body.data?.shop ?? null;
  const plan = shop?.plan ?? null;

  if (!plan) {
    // No plan returned. Default to non-Plus to fail closed; the gate will block.
    return {
      ...evaluatePlan({}),
      myshopifyDomain: shop?.myshopifyDomain ?? null,
      shopName: shop?.name ?? null,
    };
  }

  return {
    ...evaluatePlan(plan),
    myshopifyDomain: shop?.myshopifyDomain ?? null,
    shopName: shop?.name ?? null,
  };
}

// Gate copy lives in `./plan-copy.ts` because it is rendered by a React component
// in the non-Plus fallback. Server-only modules cannot be imported from the
// client bundle.
export { NON_PLUS_GATE_MESSAGE } from "./plan-copy";
