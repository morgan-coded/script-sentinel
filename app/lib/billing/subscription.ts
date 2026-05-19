/**
 * Slice 7 — Subscription billing wrapper for Drift Monitor
 * recurring SKUs. Mirrors `charge.server.ts` (one-time audit charges) but
 * targets the recurring catalog entries:
 *   - REGRESSION_SUITE_DISCOUNT — Drift Monitor, $149/mo, 14-day trial
 *   - REGRESSION_SUITE_ALL      — legacy all-rules suite, $299/mo, 14-day trial
 *
 * The Slice 1 catalog already declares both tiers; this module is the only
 * place the regression code talks to `billing.request` / `billing.check` for
 * recurring purchases. Tested by passing a stub `BillingApi` so we don't
 * stand up the full shopifyApp() instance.
 */
import { BILLING_PRODUCTS } from "./products";

export type SubscriptionPlanKey =
  | "REGRESSION_SUITE_DISCOUNT"
  | "REGRESSION_SUITE_ALL";

export const SUBSCRIPTION_PLAN_KEYS: ReadonlyArray<SubscriptionPlanKey> = Object.freeze([
  "REGRESSION_SUITE_DISCOUNT",
  "REGRESSION_SUITE_ALL",
] as const);

export const PUBLIC_SUBSCRIPTION_PLAN_KEYS: ReadonlyArray<SubscriptionPlanKey> = Object.freeze([
  "REGRESSION_SUITE_DISCOUNT",
] as const);

export function isSubscriptionPlanKey(
  value: string | null | undefined,
): value is SubscriptionPlanKey {
  return (
    value === "REGRESSION_SUITE_DISCOUNT" || value === "REGRESSION_SUITE_ALL"
  );
}

/**
 * Minimal admin-billing surface we depend on. Mirrors the
 * @shopify/shopify-app-remix shape but kept narrow so this module can be
 * mocked in tests without standing up the full shopifyApp() instance. The
 * `appSubscriptions` array surfaces recurring purchases; `oneTimePurchases`
 * is the audit catalog (and is irrelevant here but kept on the interface so
 * the same `BillingApi` can be shared with `charge.server.ts` callers).
 */
export interface SubscriptionBillingApi {
  check(options?: {
    plans?: ReadonlyArray<string>;
    isTest?: boolean;
  }): Promise<{
    hasActivePayment: boolean;
    appSubscriptions?: Array<{ id: string; name: string; status: string }>;
  }>;
  request(options: {
    plan: SubscriptionPlanKey;
    isTest?: boolean;
    returnUrl?: string;
  }): Promise<never>;
}

export interface ActiveSubscription {
  plan: SubscriptionPlanKey;
  shopifyChargeGid: string;
  status: string;
}

/**
 * Look up an active recurring subscription. Shopify's
 * `appSubscriptions.status` enum: PENDING, ACTIVE, CANCELLED, EXPIRED, FROZEN,
 * DECLINED. We only treat ACTIVE as "merchant has a paid subscription right
 * now" — FROZEN means the merchant is past due, which still gates them out.
 */
export async function findActiveSubscription(
  billing: SubscriptionBillingApi,
  options: { isTest?: boolean } = {},
): Promise<ActiveSubscription | null> {
  const result = await billing.check({
    plans: SUBSCRIPTION_PLAN_KEYS,
    isTest: options.isTest,
  });
  for (const sub of result.appSubscriptions ?? []) {
    if (sub.status !== "ACTIVE") continue;
    if (!isSubscriptionPlanKey(sub.name)) continue;
    return { plan: sub.name, shopifyChargeGid: sub.id, status: sub.status };
  }
  return null;
}

/**
 * Initiate a recurring subscription. Library `billing.request` throws a
 * Response (303 redirect to Shopify confirmation URL) on success — the
 * calling action lets it propagate. Defends against typos by rejecting
 * non-recurring plan keys.
 */
export async function startSubscription(
  billing: SubscriptionBillingApi,
  options: {
    plan: SubscriptionPlanKey;
    returnUrl: string;
    isTest?: boolean;
  },
): Promise<never> {
  const product = BILLING_PRODUCTS[options.plan];
  if (!product || product.kind !== "recurring") {
    throw new Error(
      `startSubscription called with non-recurring plan key: ${options.plan}`,
    );
  }
  return billing.request({
    plan: options.plan,
    isTest: options.isTest ?? false,
    returnUrl: options.returnUrl,
  });
}

/**
 * Cron-context active-subscription lookup. The cron handler uses
 * `unauthenticated.admin(shop)` to get an admin GraphQL client that has no
 * `billing` namespace (that lives only on request-authenticated contexts).
 * So we query `currentAppInstallation.activeSubscriptions` directly — same
 * data Shopify's `billing.check` reads — and apply the same status +
 * plan-name filters as `findActiveSubscription`.
 */
export interface AdminGraphqlClient {
  graphql(query: string): Promise<{ json(): Promise<unknown> }>;
}

const ACTIVE_SUBSCRIPTIONS_QUERY = /* GraphQL */ `
  query SentinelActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions { id name status }
    }
  }
`;

export async function fetchActiveSubscription(
  admin: AdminGraphqlClient,
): Promise<ActiveSubscription | null> {
  const response = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
  const body = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: Array<{ id: string; name: string; status: string }>;
      };
    };
  };
  const subs = body.data?.currentAppInstallation?.activeSubscriptions ?? [];
  for (const sub of subs) {
    if (sub.status !== "ACTIVE") continue;
    if (!isSubscriptionPlanKey(sub.name)) continue;
    return { plan: sub.name, shopifyChargeGid: sub.id, status: sub.status };
  }
  return null;
}

/**
 * Subscription gating decision for the regression dashboard.
 *
 * Free tier (no active subscription): only the most recent RegressionRun is
 * visible. History older than 7 days is gated.
 *
 * Subscribed tier: full unrestricted history.
 *
 * Pure function so the dashboard loader can call it directly with whatever
 * runs it pulled from Prisma.
 */
export interface RegressionRunForGating {
  startedAt: Date;
}

export function gateRegressionHistory<T extends RegressionRunForGating>(
  runs: ReadonlyArray<T>,
  options: { hasActiveSubscription: boolean; now?: Date },
): T[] {
  if (options.hasActiveSubscription) return [...runs];
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  // Free users see runs in the last 7 days. If none exist in that window,
  // fall back to just the most recent run so the dashboard has something to
  // show post-audit.
  const recent = runs.filter((r) => r.startedAt.getTime() >= cutoff);
  if (recent.length > 0) return recent;
  return runs.length > 0 ? [runs[0]] : [];
}
