import { describe, expect, it } from "vitest";
import { computeSignature, extractFromOrder } from "./extractor";
import type { RawOrder } from "../shopify/orders";

/**
 * Sample anonymized orders shaped exactly like the 2026-04 GraphQL response
 * we'd get from `orders { edges { node { ... } } }`. None of these are real
 * customer data — they're hand-crafted to exercise the extractor.
 */

function makeOrder(overrides: Partial<RawOrder> = {}): RawOrder {
  return {
    id: "gid://shopify/Order/100",
    name: "#1001",
    processedAt: "2026-04-15T10:00:00Z",
    presentmentCurrencyCode: "USD",
    currencyCode: "USD",
    paymentGatewayNames: ["shopify_payments"],
    customer: { id: "gid://shopify/Customer/1", tags: ["vip"] },
    shippingAddress: { countryCode: "US", zip: "94110" },
    lineItems: {
      edges: [
        {
          node: {
            id: "gid://shopify/LineItem/1",
            title: "Snowboard",
            quantity: 1,
            sku: "SNOW-001",
            variant: { id: "gid://shopify/ProductVariant/100", sku: "SNOW-001", price: "120.00" },
            product: { id: "gid://shopify/Product/200" },
            originalTotalSet: { presentmentMoney: { amount: "120.00", currencyCode: "USD" } },
            discountedTotalSet: { presentmentMoney: { amount: "108.00", currencyCode: "USD" } },
          },
        },
      ],
    },
    shippingLines: {
      edges: [
        {
          node: {
            code: "STANDARD",
            title: "Standard shipping",
            originalPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
          },
        },
      ],
    },
    discountApplications: {
      edges: [
        {
          node: {
            __typename: "DiscountCodeApplication",
            allocationMethod: "ACROSS",
            targetType: "LINE_ITEM",
            targetSelection: "ALL",
            value: { __typename: "MoneyV2", amount: "12.00", currencyCode: "USD" },
            code: "SAVE10",
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("extractFromOrder", () => {
  it("pulls the canonical line-item, address, currency, discount and shipping data", () => {
    const fixture = extractFromOrder(makeOrder())!;
    expect(fixture).not.toBeNull();
    expect(fixture.lineItems).toHaveLength(1);
    expect(fixture.lineItems[0]).toMatchObject({
      variantId: "gid://shopify/ProductVariant/100",
      productId: "gid://shopify/Product/200",
      sku: "SNOW-001",
      quantity: 1,
      unitPrice: 120,
      title: "Snowboard",
    });
    expect(fixture.shippingCountryCode).toBe("US");
    expect(fixture.shippingPostalPrefix).toBe("941");
    expect(fixture.presentmentCurrency).toBe("USD");
    expect(fixture.customerTags).toEqual(["vip"]);
    expect(fixture.discountSignature).toContain("DiscountCodeApplication:SAVE10");
    expect(fixture.baseline.shippingRateCode).toBe("STANDARD");
    expect(fixture.baseline.shippingRateAmount).toBe(10);
    expect(fixture.baseline.totalDiscountAmount).toBe(12);
    expect(fixture.baseline.paymentGatewayNames).toEqual(["shopify_payments"]);
    expect(fixture.cartTotal).toBe(118); // 108 (line discounted) + 10 (shipping)
  });

  it("returns null for orders with zero line items (no cart, nothing to test)", () => {
    expect(extractFromOrder(makeOrder({ lineItems: { edges: [] } }))).toBeNull();
    expect(extractFromOrder(makeOrder({ lineItems: null }))).toBeNull();
  });

  it("strips PII from customer tags (emails, phones, names)", () => {
    const fixture = extractFromOrder(
      makeOrder({
        customer: {
          id: "x",
          tags: ["VIP", "jane.doe@example.com", "+1 415 555 0142", "John Smith", "wholesale"],
        },
      }),
    )!;
    expect(fixture.customerTags).toEqual(["vip", "wholesale"]);
    // Defense-in-depth: the JSON snapshot of customer tags must not contain
    // any PII-shaped text.
    const json = JSON.stringify(fixture);
    expect(json).not.toContain("jane.doe");
    expect(json).not.toContain("415");
    expect(json).not.toContain("John Smith");
  });

  it("never serializes the customer's full address — only countryCode + postal-prefix", () => {
    const fixture = extractFromOrder(
      makeOrder({
        // Cast through unknown to inject extra PII-shaped fields the
        // scrubber must drop. Runtime is what we assert.
        shippingAddress: {
          countryCode: "GB",
          zip: "BT12 5AA",
          name: "Jane Doe",
          phone: "+44 20 7946 0958",
          address1: "12 Pretend Lane",
        } as unknown as RawOrder["shippingAddress"],
      }),
    )!;
    expect(fixture.shippingCountryCode).toBe("GB");
    expect(fixture.shippingPostalPrefix).toBe("BT1");
    const json = JSON.stringify(fixture);
    expect(json).not.toContain("Jane");
    expect(json).not.toContain("Pretend");
    expect(json).not.toContain("7946");
  });

  it("derives the market signature from currency + country (no Order.market in 2026-04)", () => {
    const fixture = extractFromOrder(
      makeOrder({
        presentmentCurrencyCode: "EUR",
        shippingAddress: { countryCode: "DE", zip: "10115" },
      }),
    )!;
    expect(fixture.marketSignature).toBe("EUR/DE");
  });

  it("captures multiple discount applications — code + script", () => {
    const fixture = extractFromOrder(
      makeOrder({
        discountApplications: {
          edges: [
            {
              node: {
                __typename: "DiscountCodeApplication",
                allocationMethod: "ACROSS",
                targetType: "LINE_ITEM",
                targetSelection: "ALL",
                value: { __typename: "MoneyV2", amount: "5.00", currencyCode: "USD" },
                code: "WELCOME",
              },
            },
            {
              node: {
                __typename: "ScriptDiscountApplication",
                allocationMethod: "EACH",
                targetType: "LINE_ITEM",
                targetSelection: "ENTITLED",
                value: { __typename: "PricingPercentageValue", percentage: 5 },
                title: "Loyalty boost",
              },
            },
          ],
        },
      }),
    )!;
    expect(fixture.baseline.discountApplications).toHaveLength(2);
    expect(fixture.baseline.discountApplications[0]).toMatchObject({
      type: "DiscountCodeApplication",
      code: "WELCOME",
      amount: 5,
    });
    expect(fixture.baseline.discountApplications[1]).toMatchObject({
      type: "ScriptDiscountApplication",
      percentage: 5,
      amount: null,
    });
    expect(fixture.discountSignature).toContain("DiscountCodeApplication:WELCOME");
    expect(fixture.discountSignature).toContain("ScriptDiscountApplication:");
  });

  it("falls back to USD when neither presentmentCurrencyCode nor currencyCode is set", () => {
    const fixture = extractFromOrder(
      makeOrder({
        presentmentCurrencyCode: null as unknown as string,
        currencyCode: null as unknown as string,
      }),
    )!;
    expect(fixture.presentmentCurrency).toBe("USD");
  });

  it("handles missing shipping address (digital orders)", () => {
    const fixture = extractFromOrder(makeOrder({ shippingAddress: null }))!;
    expect(fixture.shippingCountryCode).toBeNull();
    expect(fixture.shippingPostalPrefix).toBeNull();
  });

  it("preserves quantity diversity in quantitySamples", () => {
    const fixture = extractFromOrder(
      makeOrder({
        lineItems: {
          edges: [
            {
              node: {
                id: "gid://shopify/LineItem/1",
                title: "T-shirt",
                quantity: 3,
                variant: { id: "gid://shopify/ProductVariant/V1", price: "20.00" },
                product: { id: "gid://shopify/Product/P1" },
                originalTotalSet: { presentmentMoney: { amount: "60.00", currencyCode: "USD" } },
                discountedTotalSet: { presentmentMoney: { amount: "60.00", currencyCode: "USD" } },
              },
            },
            {
              node: {
                id: "gid://shopify/LineItem/2",
                title: "Hat",
                quantity: 2,
                variant: { id: "gid://shopify/ProductVariant/V2", price: "15.00" },
                product: { id: "gid://shopify/Product/P2" },
                originalTotalSet: { presentmentMoney: { amount: "30.00", currencyCode: "USD" } },
                discountedTotalSet: { presentmentMoney: { amount: "30.00", currencyCode: "USD" } },
              },
            },
          ],
        },
      }),
    )!;
    expect(fixture.quantitySamples).toEqual([5]); // 3 + 2 totalled at extraction time
  });

  it("rejects orders with malformed id (defensive)", () => {
    expect(extractFromOrder({ id: undefined as unknown as string } as RawOrder)).toBeNull();
  });

  it("derives baseline.totalDiscountAmount from line totals so PERCENTAGE discounts aren't reported as zero", () => {
    // 10% off scenario: line original $100, discounted $90. The discount
    // application carries no MoneyV2 amount — only `percentage: 10`. The
    // pre-fix implementation summed only MoneyV2 values and would report
    // totalDiscountAmount=0; the fix derives $10 from line totals.
    const fixture = extractFromOrder(
      makeOrder({
        lineItems: {
          edges: [
            {
              node: {
                id: "li-pct",
                title: "Percent line",
                quantity: 1,
                variant: { id: "gid://shopify/ProductVariant/PCT", price: "100.00" },
                product: { id: "gid://shopify/Product/PCT" },
                originalTotalSet: { presentmentMoney: { amount: "100.00", currencyCode: "USD" } },
                discountedTotalSet: { presentmentMoney: { amount: "90.00", currencyCode: "USD" } },
              },
            },
          ],
        },
        discountApplications: {
          edges: [
            {
              node: {
                __typename: "AutomaticDiscountApplication",
                allocationMethod: "EACH",
                targetType: "LINE_ITEM",
                targetSelection: "ALL",
                value: { __typename: "PricingPercentageValue", percentage: 10 },
                title: "Spring 10",
              },
            },
          ],
        },
      }),
    )!;
    expect(fixture.baseline.totalDiscountAmount).toBeCloseTo(10, 2);
    expect(fixture.baseline.discountApplications[0]).toMatchObject({
      percentage: 10,
      amount: null,
    });
  });

  it("keeps mixed carts distinct: a cart with one deleted-variant line does NOT collide with a same-variant-only cart", () => {
    const sharedVariant = "gid://shopify/ProductVariant/SHARED";
    const sharedProduct = "gid://shopify/Product/P1";
    const live = extractFromOrder(
      makeOrder({
        lineItems: {
          edges: [
            {
              node: {
                id: "li-1",
                title: "Live",
                quantity: 1,
                variant: { id: sharedVariant, price: "10.00" },
                product: { id: sharedProduct },
                originalTotalSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
                discountedTotalSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
              },
            },
          ],
        },
      }),
    )!;
    const mixed = extractFromOrder(
      makeOrder({
        lineItems: {
          edges: [
            {
              node: {
                id: "li-1",
                title: "Live",
                quantity: 1,
                variant: { id: sharedVariant, price: "10.00" },
                product: { id: sharedProduct },
                originalTotalSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
                discountedTotalSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
              },
            },
            {
              node: {
                id: "li-2",
                title: "Deleted variant fallback",
                quantity: 1,
                // variant = null simulates a hard-deleted variant; productId
                // remains so we can still distinguish this line from "no
                // second line at all".
                variant: null,
                product: { id: "gid://shopify/Product/P2" },
                originalTotalSet: { presentmentMoney: { amount: "5.00", currencyCode: "USD" } },
                discountedTotalSet: { presentmentMoney: { amount: "5.00", currencyCode: "USD" } },
              },
            },
          ],
        },
      }),
    )!;
    expect(live.signature).not.toBe(mixed.signature);
  });

  it("redacts PII-shaped discount codes before they hit the snapshot or signature", () => {
    const fixture = extractFromOrder(
      makeOrder({
        discountApplications: {
          edges: [
            {
              node: {
                __typename: "DiscountCodeApplication",
                allocationMethod: "ACROSS",
                targetType: "LINE_ITEM",
                targetSelection: "ALL",
                value: { __typename: "MoneyV2", amount: "5.00", currencyCode: "USD" },
                code: "john.doe@example.com",
              },
            },
          ],
        },
      }),
    )!;
    expect(fixture.baseline.discountApplications[0].code).toBe("[redacted]");
    expect(fixture.discountSignature).not.toContain("john.doe");
    expect(fixture.discountSignature).not.toContain("@example.com");
    expect(fixture.discountSignature).toContain("[redacted]");
  });
});

describe("computeSignature", () => {
  it("produces the same hex digest for equivalent inputs (order-independent)", () => {
    const a = computeSignature({
      variantIds: ["v1", "v2"],
      productFallbackIds: [],
      customerTagSignature: "vip,wholesale",
      shippingCountryCode: "US",
      shippingPostalPrefix: "941",
      presentmentCurrency: "USD",
      discountSignature: "X|Y",
    });
    const b = computeSignature({
      variantIds: ["v2", "v1"], // different array order — sorted internally
      productFallbackIds: [],
      customerTagSignature: "vip,wholesale",
      shippingCountryCode: "US",
      shippingPostalPrefix: "941",
      presentmentCurrency: "USD",
      discountSignature: "X|Y",
    });
    expect(a).toBe(b);
  });

  it("differs when the discount signature differs", () => {
    const base = {
      variantIds: ["v1"],
      productFallbackIds: [],
      customerTagSignature: "",
      shippingCountryCode: "US" as const,
      shippingPostalPrefix: "941" as const,
      presentmentCurrency: "USD",
    };
    const a = computeSignature({ ...base, discountSignature: "X" });
    const b = computeSignature({ ...base, discountSignature: "Y" });
    expect(a).not.toBe(b);
  });

  it("differs when customer tags differ (B2B vs DTC)", () => {
    const base = {
      variantIds: ["v1"],
      productFallbackIds: [],
      shippingCountryCode: "US" as const,
      shippingPostalPrefix: "941" as const,
      presentmentCurrency: "USD",
      discountSignature: "",
    };
    const a = computeSignature({ ...base, customerTagSignature: "vip" });
    const b = computeSignature({ ...base, customerTagSignature: "wholesale" });
    expect(a).not.toBe(b);
  });
});
