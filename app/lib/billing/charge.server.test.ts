import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_PLAN_KEYS,
  findActiveAuditPurchase,
  isAuditPlanKey,
  scopeForPlan,
  startAuditCharge,
  type BillingApi,
} from "./charge.server";

function makeBilling(overrides: Partial<BillingApi> = {}): BillingApi {
  return {
    check: vi.fn(async () => ({ hasActivePayment: false, oneTimePurchases: [] })),
    request: vi.fn(async () => {
      throw new Response(null, { status: 303 });
    }),
    ...overrides,
  };
}

describe("AUDIT_PLAN_KEYS", () => {
  it("only includes the two one-time audit SKUs (never the recurring suites)", () => {
    expect([...AUDIT_PLAN_KEYS].sort()).toEqual([
      "MIGRATION_RISK_AUDIT",
      "MULTI_SCRIPT_AUDIT",
    ]);
  });
});

describe("isAuditPlanKey", () => {
  it("accepts only the two audit keys", () => {
    expect(isAuditPlanKey("MIGRATION_RISK_AUDIT")).toBe(true);
    expect(isAuditPlanKey("MULTI_SCRIPT_AUDIT")).toBe(true);
    expect(isAuditPlanKey("REGRESSION_SUITE_DISCOUNT")).toBe(false);
    expect(isAuditPlanKey(null)).toBe(false);
    expect(isAuditPlanKey(undefined)).toBe(false);
    expect(isAuditPlanKey("")).toBe(false);
  });
});

describe("scopeForPlan", () => {
  it("maps single-family audit to single, multi to multi", () => {
    expect(scopeForPlan("MIGRATION_RISK_AUDIT")).toBe("single");
    expect(scopeForPlan("MULTI_SCRIPT_AUDIT")).toBe("multi");
  });
});

describe("findActiveAuditPurchase", () => {
  it("returns null when the shop has no purchases", async () => {
    const billing = makeBilling();
    expect(await findActiveAuditPurchase(billing)).toBeNull();
    expect(billing.check).toHaveBeenCalledWith({
      plans: AUDIT_PLAN_KEYS,
      isTest: undefined,
    });
  });

  it("returns the active audit when one exists", async () => {
    const billing = makeBilling({
      check: vi.fn(async () => ({
        hasActivePayment: true,
        oneTimePurchases: [
          {
            id: "gid://shopify/AppPurchaseOneTime/123",
            name: "MIGRATION_RISK_AUDIT",
            test: false,
            status: "ACTIVE",
          },
        ],
      })),
    });
    const result = await findActiveAuditPurchase(billing);
    expect(result).toEqual({
      plan: "MIGRATION_RISK_AUDIT",
      shopifyChargeGid: "gid://shopify/AppPurchaseOneTime/123",
      test: false,
    });
  });

  it("ignores PENDING and DECLINED purchases — only ACTIVE/ACCEPTED count", async () => {
    const billing = makeBilling({
      check: vi.fn(async () => ({
        hasActivePayment: false,
        oneTimePurchases: [
          {
            id: "gid://shopify/AppPurchaseOneTime/1",
            name: "MIGRATION_RISK_AUDIT",
            test: false,
            status: "PENDING",
          },
          {
            id: "gid://shopify/AppPurchaseOneTime/2",
            name: "MULTI_SCRIPT_AUDIT",
            test: false,
            status: "DECLINED",
          },
        ],
      })),
    });
    expect(await findActiveAuditPurchase(billing)).toBeNull();
  });

  it("ignores purchases whose name isn't an audit plan key (defensive)", async () => {
    const billing = makeBilling({
      check: vi.fn(async () => ({
        hasActivePayment: true,
        oneTimePurchases: [
          {
            id: "gid://shopify/AppPurchaseOneTime/x",
            name: "REGRESSION_SUITE_ALL", // recurring, not an audit
            test: false,
            status: "ACTIVE",
          },
        ],
      })),
    });
    expect(await findActiveAuditPurchase(billing)).toBeNull();
  });

  it("passes isTest through to billing.check (Plus dev stores need test mode)", async () => {
    const billing = makeBilling();
    await findActiveAuditPurchase(billing, { isTest: true });
    expect(billing.check).toHaveBeenCalledWith({
      plans: AUDIT_PLAN_KEYS,
      isTest: true,
    });
  });
});

describe("startAuditCharge", () => {
  it("calls billing.request with the right plan + return URL and lets the redirect Response propagate", async () => {
    const billing = makeBilling();
    await expect(
      startAuditCharge(billing, {
        plan: "MIGRATION_RISK_AUDIT",
        returnUrl: "https://app.example/app/audit",
        isTest: true,
      }),
    ).rejects.toBeInstanceOf(Response);
    expect(billing.request).toHaveBeenCalledWith({
      plan: "MIGRATION_RISK_AUDIT",
      returnUrl: "https://app.example/app/audit",
      isTest: true,
    });
  });

  it("rejects callers that try to charge a non-audit plan (typo guard)", async () => {
    const billing = makeBilling();
    await expect(
      startAuditCharge(billing, {
        // @ts-expect-error - intentional misuse for the runtime guard test
        plan: "REGRESSION_SUITE_DISCOUNT",
        returnUrl: "https://app.example/app/audit",
      }),
    ).rejects.toThrow(/non-audit plan/);
    expect(billing.request).not.toHaveBeenCalled();
  });

  it("defaults isTest to false when not supplied (production live charge)", async () => {
    const billing = makeBilling();
    await expect(
      startAuditCharge(billing, {
        plan: "MULTI_SCRIPT_AUDIT",
        returnUrl: "https://app.example/app/audit",
      }),
    ).rejects.toBeInstanceOf(Response);
    expect(billing.request).toHaveBeenCalledWith(
      expect.objectContaining({ isTest: false }),
    );
  });
});
