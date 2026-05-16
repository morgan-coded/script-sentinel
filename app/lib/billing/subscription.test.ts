import { describe, expect, it, vi } from "vitest";
import {
  findActiveSubscription,
  gateRegressionHistory,
  isSubscriptionPlanKey,
  startSubscription,
  SUBSCRIPTION_PLAN_KEYS,
  type SubscriptionBillingApi,
} from "./subscription";

function makeBilling(
  overrides: Partial<SubscriptionBillingApi> = {},
): SubscriptionBillingApi {
  return {
    check: vi.fn(async () => ({ hasActivePayment: false, appSubscriptions: [] })),
    request: vi.fn(async () => {
      throw new Response(null, { status: 303 });
    }),
    ...overrides,
  };
}

describe("SUBSCRIPTION_PLAN_KEYS", () => {
  it("includes only the two recurring suites (never one-time audit SKUs)", () => {
    expect([...SUBSCRIPTION_PLAN_KEYS].sort()).toEqual([
      "REGRESSION_SUITE_ALL",
      "REGRESSION_SUITE_DISCOUNT",
    ]);
  });
});

describe("isSubscriptionPlanKey", () => {
  it("accepts only the two recurring keys", () => {
    expect(isSubscriptionPlanKey("REGRESSION_SUITE_DISCOUNT")).toBe(true);
    expect(isSubscriptionPlanKey("REGRESSION_SUITE_ALL")).toBe(true);
    expect(isSubscriptionPlanKey("MIGRATION_RISK_AUDIT")).toBe(false);
    expect(isSubscriptionPlanKey(null)).toBe(false);
    expect(isSubscriptionPlanKey("")).toBe(false);
  });
});

describe("findActiveSubscription", () => {
  it("returns null when the shop has no recurring purchases", async () => {
    const billing = makeBilling();
    expect(await findActiveSubscription(billing)).toBeNull();
    expect(billing.check).toHaveBeenCalledWith({
      plans: SUBSCRIPTION_PLAN_KEYS,
      isTest: undefined,
    });
  });

  it("returns the ACTIVE subscription when one exists", async () => {
    const billing = makeBilling({
      check: vi.fn(async () => ({
        hasActivePayment: true,
        appSubscriptions: [
          {
            id: "gid://shopify/AppSubscription/123",
            name: "REGRESSION_SUITE_DISCOUNT",
            status: "ACTIVE",
          },
        ],
      })),
    });
    expect(await findActiveSubscription(billing)).toEqual({
      plan: "REGRESSION_SUITE_DISCOUNT",
      shopifyChargeGid: "gid://shopify/AppSubscription/123",
      status: "ACTIVE",
    });
  });

  it("ignores FROZEN, CANCELLED, and PENDING subscriptions (only ACTIVE counts)", async () => {
    const billing = makeBilling({
      check: vi.fn(async () => ({
        hasActivePayment: false,
        appSubscriptions: [
          {
            id: "gid://shopify/AppSubscription/1",
            name: "REGRESSION_SUITE_DISCOUNT",
            status: "FROZEN",
          },
          {
            id: "gid://shopify/AppSubscription/2",
            name: "REGRESSION_SUITE_ALL",
            status: "CANCELLED",
          },
          {
            id: "gid://shopify/AppSubscription/3",
            name: "REGRESSION_SUITE_ALL",
            status: "PENDING",
          },
        ],
      })),
    });
    expect(await findActiveSubscription(billing)).toBeNull();
  });

  it("ignores subscriptions whose name isn't a recurring SKU (defensive)", async () => {
    const billing = makeBilling({
      check: vi.fn(async () => ({
        hasActivePayment: true,
        appSubscriptions: [
          {
            id: "gid://shopify/AppSubscription/x",
            name: "MIGRATION_RISK_AUDIT", // one-time, not a subscription
            status: "ACTIVE",
          },
        ],
      })),
    });
    expect(await findActiveSubscription(billing)).toBeNull();
  });
});

describe("startSubscription", () => {
  it("calls billing.request with the right plan + return URL and lets the redirect propagate", async () => {
    const billing = makeBilling();
    await expect(
      startSubscription(billing, {
        plan: "REGRESSION_SUITE_DISCOUNT",
        returnUrl: "https://app.example/app/regression",
        isTest: true,
      }),
    ).rejects.toBeInstanceOf(Response);
    expect(billing.request).toHaveBeenCalledWith({
      plan: "REGRESSION_SUITE_DISCOUNT",
      returnUrl: "https://app.example/app/regression",
      isTest: true,
    });
  });

  it("rejects callers that try to charge a non-recurring plan (typo guard)", async () => {
    const billing = makeBilling();
    await expect(
      startSubscription(billing, {
        // @ts-expect-error - intentional misuse for the runtime guard
        plan: "MIGRATION_RISK_AUDIT",
        returnUrl: "https://app.example/app/regression",
      }),
    ).rejects.toThrow(/non-recurring plan/);
    expect(billing.request).not.toHaveBeenCalled();
  });
});

describe("gateRegressionHistory", () => {
  const now = new Date("2026-04-29T12:00:00Z");
  const day = (offset: number) => ({
    startedAt: new Date(now.getTime() - offset * 24 * 60 * 60 * 1000),
  });

  it("returns ALL runs for subscribed merchants regardless of age", () => {
    const runs = [day(0), day(3), day(10), day(60)];
    expect(
      gateRegressionHistory(runs, { hasActiveSubscription: true, now }),
    ).toEqual(runs);
  });

  it("hides runs older than 7 days for free merchants", () => {
    const runs = [day(0), day(3), day(10), day(60)];
    const visible = gateRegressionHistory(runs, {
      hasActiveSubscription: false,
      now,
    });
    expect(visible).toHaveLength(2);
    expect(visible.map((r) => r.startedAt)).toEqual([
      runs[0].startedAt,
      runs[1].startedAt,
    ]);
  });

  it("falls back to the most recent run when no run is inside the 7-day window", () => {
    const runs = [day(15), day(30), day(60)];
    const visible = gateRegressionHistory(runs, {
      hasActiveSubscription: false,
      now,
    });
    expect(visible).toEqual([runs[0]]);
  });

  it("returns [] when there are no runs at all (empty post-install state)", () => {
    expect(
      gateRegressionHistory([], { hasActiveSubscription: false, now }),
    ).toEqual([]);
    expect(
      gateRegressionHistory([], { hasActiveSubscription: true, now }),
    ).toEqual([]);
  });
});
