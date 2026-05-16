import { describe, expect, it } from "vitest";
import { extractFixtures, mergeFixtures } from "./dedup";
import type { RawOrder } from "../shopify/orders";

function order(
  id: string,
  overrides: {
    variantId?: string;
    productId?: string;
    quantity?: number;
    code?: string | null;
    country?: string;
    tags?: string[];
    processedAt?: string;
    currency?: string;
  } = {},
): RawOrder {
  const variantId = overrides.variantId ?? "gid://shopify/ProductVariant/V1";
  const productId = overrides.productId ?? "gid://shopify/Product/P1";
  return {
    id,
    name: id,
    processedAt: overrides.processedAt ?? "2026-04-15T10:00:00Z",
    presentmentCurrencyCode: overrides.currency ?? "USD",
    customer: { id: "c", tags: overrides.tags ?? [] },
    shippingAddress: { countryCode: overrides.country ?? "US", zip: "94110" },
    paymentGatewayNames: ["shopify_payments"],
    lineItems: {
      edges: [
        {
          node: {
            id: "li1",
            title: "Item",
            quantity: overrides.quantity ?? 1,
            variant: { id: variantId, price: "100.00" },
            product: { id: productId },
            originalTotalSet: { presentmentMoney: { amount: "100.00", currencyCode: "USD" } },
            discountedTotalSet: { presentmentMoney: { amount: "100.00", currencyCode: "USD" } },
          },
        },
      ],
    },
    shippingLines: { edges: [] },
    discountApplications:
      overrides.code === undefined
        ? { edges: [] }
        : overrides.code === null
          ? { edges: [] }
          : {
              edges: [
                {
                  node: {
                    __typename: "DiscountCodeApplication",
                    allocationMethod: "ACROSS",
                    targetType: "LINE_ITEM",
                    targetSelection: "ALL",
                    value: { __typename: "MoneyV2", amount: "5.00", currencyCode: "USD" },
                    code: overrides.code,
                  },
                },
              ],
            },
  };
}

describe("extractFixtures (dedup)", () => {
  it("collapses orders with identical composition + tags + country + discount into one fixture", () => {
    const result = extractFixtures([
      order("o1", { quantity: 1 }),
      order("o2", { quantity: 1 }),
      order("o3", { quantity: 1 }),
    ]);
    expect(result.fixtures).toHaveLength(1);
    expect(result.fixtures[0].observationCount).toBe(3);
    expect(result.stats).toEqual({
      ordersConsidered: 3,
      ordersDropped: 0,
      fixturesEmitted: 1,
    });
  });

  it("preserves quantity diversity across collapsed orders", () => {
    const result = extractFixtures([
      order("o1", { quantity: 1 }),
      order("o2", { quantity: 2 }),
      order("o3", { quantity: 5 }),
      order("o4", { quantity: 1 }),
    ]);
    expect(result.fixtures).toHaveLength(1);
    expect(result.fixtures[0].quantitySamples).toEqual([1, 2, 5]);
    expect(result.fixtures[0].observationCount).toBe(4);
  });

  it("splits when the discount code differs (Script + manual code)", () => {
    const result = extractFixtures([
      order("o1", { code: null }),
      order("o2", { code: "SAVE10" }),
      order("o3", { code: "SAVE10" }),
      order("o4", { code: "BFCM" }),
    ]);
    expect(result.fixtures).toHaveLength(3); // null, SAVE10, BFCM
    const counts = result.fixtures.map((f) => f.observationCount).sort();
    expect(counts).toEqual([1, 1, 2]);
  });

  it("splits when shipping country differs (market-pricing)", () => {
    const result = extractFixtures([
      order("o1", { country: "US" }),
      order("o2", { country: "GB" }),
      order("o3", { country: "US" }),
    ]);
    expect(result.fixtures).toHaveLength(2);
  });

  it("splits when customer tags differ (B2B vs DTC)", () => {
    const result = extractFixtures([
      order("o1", { tags: ["wholesale"] }),
      order("o2", { tags: [] }),
      order("o3", { tags: ["wholesale"] }),
    ]);
    expect(result.fixtures).toHaveLength(2);
  });

  it("baseline tracks the freshest order; first/lastObservedAt span the merged set", () => {
    const result = extractFixtures([
      order("old", { quantity: 1, processedAt: "2026-03-01T10:00:00Z" }),
      order("new", { quantity: 2, processedAt: "2026-04-20T10:00:00Z" }),
      order("middle", { quantity: 1, processedAt: "2026-04-01T10:00:00Z" }),
    ]);
    expect(result.fixtures).toHaveLength(1);
    const f = result.fixtures[0];
    expect(f.firstObservedAt.toISOString()).toBe("2026-03-01T10:00:00.000Z");
    expect(f.lastObservedAt.toISOString()).toBe("2026-04-20T10:00:00.000Z");
    expect(f.observationCount).toBe(3);
    // Baseline captured at the freshest order's processedAt.
    expect(f.baseline.capturedAt.toISOString()).toBe("2026-04-20T10:00:00.000Z");
  });

  it("returns an empty list for an empty input", () => {
    expect(extractFixtures([]).fixtures).toEqual([]);
  });

  it("counts orders that fail extraction in stats.ordersDropped", () => {
    // An order with no line items is dropped — nothing to test against.
    const empty = order("empty");
    empty.lineItems = { edges: [] };
    const result = extractFixtures([order("ok"), empty]);
    expect(result.stats.ordersDropped).toBe(1);
    expect(result.stats.fixturesEmitted).toBe(1);
  });
});

describe("mergeFixtures", () => {
  it("throws when called with mismatched signatures (programmer error guard)", () => {
    const a = extractFixtures([order("a", { tags: ["vip"] })]).fixtures[0];
    const b = extractFixtures([order("b", { tags: ["wholesale"] })]).fixtures[0];
    expect(() => mergeFixtures(a, b)).toThrow(/different signatures/);
  });

  it("is order-independent for accumulator fields (count, qty samples, first/last)", () => {
    const a = extractFixtures([
      order("o1", { quantity: 1, processedAt: "2026-03-01T00:00:00Z" }),
    ]).fixtures[0];
    const b = extractFixtures([
      order("o2", { quantity: 5, processedAt: "2026-04-01T00:00:00Z" }),
    ]).fixtures[0];
    const ab = mergeFixtures(a, b);
    const ba = mergeFixtures(b, a);
    expect(ab.observationCount).toBe(ba.observationCount);
    expect(ab.quantitySamples).toEqual(ba.quantitySamples);
    expect(ab.firstObservedAt.toISOString()).toBe(ba.firstObservedAt.toISOString());
    expect(ab.lastObservedAt.toISOString()).toBe(ba.lastObservedAt.toISOString());
  });
});
