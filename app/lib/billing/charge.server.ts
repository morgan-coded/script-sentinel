/**
 * Audit-charge wrapper around @shopify/shopify-app-remix `billing.request` /
 * `billing.check`.
 *
 * The catalog (`./products.ts`) defines two one-time SKUs:
 *   - MIGRATION_RISK_AUDIT — $99 launch audit, single Script family
 *   - MULTI_SCRIPT_AUDIT   — $299 launch audit, all Script families
 *
 * The audit route uses this module to:
 *   1. Check whether an active one-time purchase already exists for the shop
 *      (so a merchant who paid yesterday doesn't get charged again).
 *   2. Initiate a new one-time charge if not.
 *
 * `billing.request` throws a Response that REDIRECTS the merchant to
 * Shopify's confirmation URL. After approval Shopify returns to the
 * `returnUrl` we pass in, where the route detects the active purchase via
 * `billing.check` and proceeds to PDF generation.
 *
 * No write scopes are touched; Managed Billing handles charge creation in
 * Shopify's own infrastructure.
 */

import { BILLING_PRODUCTS } from "./products";

export type AuditPlanKey = "MIGRATION_RISK_AUDIT" | "MULTI_SCRIPT_AUDIT";

export const AUDIT_PLAN_KEYS: ReadonlyArray<AuditPlanKey> = Object.freeze([
  "MIGRATION_RISK_AUDIT",
  "MULTI_SCRIPT_AUDIT",
] as const);

export function isAuditPlanKey(value: string | null | undefined): value is AuditPlanKey {
  return value === "MIGRATION_RISK_AUDIT" || value === "MULTI_SCRIPT_AUDIT";
}

/** Map an audit plan key to the human-readable scope label used in the PDF. */
export function scopeForPlan(plan: AuditPlanKey): "single" | "multi" {
  return plan === "MIGRATION_RISK_AUDIT" ? "single" : "multi";
}

/**
 * Minimal admin-billing surface we depend on. Mirrors the
 * @shopify/shopify-app-remix shape but kept narrow so this module can be
 * mocked in tests without standing up the full shopifyApp() instance.
 *
 * `request` is typed as `Promise<never>` because the real implementation
 * throws a Response (redirect). Callers `await` it inside an action and let
 * the Response propagate. The narrowing-to-never matches the library types.
 */
export interface BillingApi {
  check(options?: {
    plans?: ReadonlyArray<AuditPlanKey>;
    isTest?: boolean;
  }): Promise<{
    hasActivePayment: boolean;
    oneTimePurchases: Array<{
      id: string;
      name: string;
      test: boolean;
      status: string;
    }>;
    appSubscriptions?: Array<{ id: string; name: string; status: string }>;
  }>;
  request(options: {
    plan: AuditPlanKey;
    isTest?: boolean;
    returnUrl?: string;
  }): Promise<never>;
}

export interface ActiveAuditPurchase {
  plan: AuditPlanKey;
  shopifyChargeGid: string;
  test: boolean;
}

/**
 * Look up an active one-time audit purchase. Returns the first ACTIVE/ACCEPTED
 * one-time matching either audit plan, or null if none.
 *
 * Shopify's `oneTimePurchases.status` enum: PENDING, ACCEPTED, ACTIVE,
 * DECLINED, EXPIRED. We only treat ACTIVE/ACCEPTED as "merchant has paid".
 */
export async function findActiveAuditPurchase(
  billing: BillingApi,
  options: { isTest?: boolean } = {},
): Promise<ActiveAuditPurchase | null> {
  const result = await billing.check({
    plans: AUDIT_PLAN_KEYS,
    isTest: options.isTest,
  });
  for (const purchase of result.oneTimePurchases ?? []) {
    if (purchase.status !== "ACTIVE" && purchase.status !== "ACCEPTED") continue;
    if (!isAuditPlanKey(purchase.name)) continue;
    return {
      plan: purchase.name,
      shopifyChargeGid: purchase.id,
      test: purchase.test,
    };
  }
  return null;
}

/**
 * Initiate a one-time audit charge. The library's `billing.request` throws a
 * Response (303 redirect) on success — the calling action should let it
 * propagate to the merchant.
 *
 * Throws an Error if the plan key isn't an audit SKU. Defends against typos
 * and prevents accidentally charging the recurring tiers as one-time.
 */
export async function startAuditCharge(
  billing: BillingApi,
  options: {
    plan: AuditPlanKey;
    returnUrl: string;
    isTest?: boolean;
  },
): Promise<never> {
  const product = BILLING_PRODUCTS[options.plan];
  if (!product || product.kind !== "one_time") {
    throw new Error(
      `startAuditCharge called with non-audit plan key: ${options.plan}`,
    );
  }
  return billing.request({
    plan: options.plan,
    isTest: options.isTest ?? false,
    returnUrl: options.returnUrl,
  });
}
