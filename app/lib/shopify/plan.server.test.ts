import { describe, expect, it, vi } from "vitest";
import {
  evaluatePlan,
  fetchShopPlan,
  type AdminGraphqlClient,
} from "./plan.server";

describe("evaluatePlan", () => {
  it("treats shopifyPlus=true as Plus", () => {
    const result = evaluatePlan({
      shopifyPlus: true,
      partnerDevelopment: false,
      publicDisplayName: "Plus",
    });
    expect(result.isPlus).toBe(true);
    expect(result.isDevelopment).toBe(false);
    expect(result.shopifyPlus).toBe(true);
  });

  it("treats Partner-created development stores as Plus (so devs can test) but flags isDevelopment", () => {
    const result = evaluatePlan({
      shopifyPlus: false,
      partnerDevelopment: true,
      publicDisplayName: "Development",
    });
    expect(result.isPlus).toBe(true);
    expect(result.isDevelopment).toBe(true);
  });

  it("blocks non-Plus shops (basic / advanced / starter)", () => {
    for (const name of ["Basic", "Advanced", "Starter", "Grow", "Lite"]) {
      const result = evaluatePlan({
        shopifyPlus: false,
        partnerDevelopment: false,
        publicDisplayName: name,
      });
      expect(result.isPlus, `plan ${name} should be blocked`).toBe(false);
    }
  });

  it("fails closed when both booleans are missing/null (defensive default)", () => {
    expect(evaluatePlan({}).isPlus).toBe(false);
    expect(
      evaluatePlan({
        shopifyPlus: null,
        partnerDevelopment: null,
      }).isPlus,
    ).toBe(false);
  });

  it("does NOT gate on publicDisplayName string (display-only)", () => {
    // Even if display name says "Plus" string, the boolean is the contract.
    const result = evaluatePlan({
      shopifyPlus: false,
      partnerDevelopment: false,
      publicDisplayName: "Plus",
    });
    expect(result.isPlus).toBe(false);
  });
});

describe("fetchShopPlan", () => {
  function mockAdmin(payload: unknown): AdminGraphqlClient {
    return {
      graphql: vi.fn().mockResolvedValue({
        json: () => Promise.resolve(payload),
      }),
    };
  }

  it("returns the snapshot for a Plus shop", async () => {
    const admin = mockAdmin({
      data: {
        shop: {
          myshopifyDomain: "acme.myshopify.com",
          name: "Acme",
          plan: {
            shopifyPlus: true,
            partnerDevelopment: false,
            publicDisplayName: "Plus",
          },
        },
      },
    });
    const result = await fetchShopPlan(admin);
    expect(result.isPlus).toBe(true);
    expect(result.myshopifyDomain).toBe("acme.myshopify.com");
    expect(result.shopName).toBe("Acme");
  });

  it("throws on GraphQL errors so the caller can 5xx instead of silently blocking", async () => {
    const admin = mockAdmin({
      errors: [{ message: "permission denied" }],
    });
    await expect(fetchShopPlan(admin)).rejects.toThrow(/permission denied/);
  });

  it("fails closed (non-Plus) when the shop has no plan field", async () => {
    const admin = mockAdmin({ data: { shop: null } });
    const result = await fetchShopPlan(admin);
    expect(result.isPlus).toBe(false);
    expect(result.myshopifyDomain).toBeNull();
  });
});
